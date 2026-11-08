// eog_regs -- AXI4-Lite slave: ID/VERSION/CTRL/STATUS/GLOBAL, CONFIG table, DATA push window, RESULT and ALERT
// FIFOs, STATS, LEDOVR, DBGSEL/DBG, and the weight window to eog_head.
// Spec v4: spec/regmap.md, spec/modules/eog_regs.md, conventions.md sections 1, 5 and 6.
//
// Micro-architecture
//   * One AXI transaction at a time (a single FSM serves both channels; reads and writes alternate priority
//     when both are waiting). READY is registered, as in axi_mul.v: the FSM raises AWREADY+WREADY (or ARREADY)
//     for one cycle after it sees the valid(s), the handshake happens in that cycle, and READY drops.
//       write: IDLE -> W_ACC (handshake) -> W_EXEC (-> W_RMW for a partial-strobe weight write) -> B_WAIT
//       read : IDLE -> R_ACC (handshake) -> R_ADDR (sync reads, wb_raddr) -> R_DATA (rdata captured, pop)
//              -> R_WAIT
//     BVALID == (state B_WAIT), RVALID == (state R_WAIT); responses are always OKAY.
//   * After a hard reset the FSM first sweeps the CONFIG table to 0 (N_FAC cycles, all 16 word RAMs in
//     parallel); AXI is not served during the sweep. Soft reset does not touch CONFIG.
//   * CONFIG table: 16 word RAMs (one per 32-bit word of the 64 B row), N_FAC deep, written one word at a time
//     (byte strobes merged in W_EXEC from the RAM's own read port), five asynchronous read ports in all
//     (cfg_row_v/f/c, AXI/merge read, FLAGS check on word 0). LUTRAM.
//   * FAC_ID (row bits [15:0]) always reads back as the slot number, on AXI and on cfg_row_*.
//   * DATA window: 12-word write buffer; a full-strobe write to word 11 (with src_dma = 0) copies the buffer plus
//     that word into a 384-bit send shift register and sends 6 beats (d_last on beat 6). A push while the send
//     register is busy is dropped and counted (STATS 12).
//   * RESULT FIFO: RES_DEPTH records x 4 beats x 64 bits, synchronous read (BRAM-friendly). A record counts
//     only after its 4th beat; r_ready = (complete records < RES_DEPTH), so the tail slot is always free for
//     the partial record. r_last is ignored (pack's m_last is a batch marker, not a record marker).
//   * ALERT FIFO: AL_DEPTH x 128 bits, synchronous read; al_full = (count == AL_DEPTH).
//   * Weight window: wb_raddr = the latched AXI word address; wb_rdata is used one cycle later. Full-strobe
//     writes go straight out on wb_we; partial strobes read-modify-write (W_EXEC reads, W_RMW writes).
//   * Soft reset: CTRL.soft_reset -> soft_rst high for exactly 2 cycles. It clears STATS, both FIFOs and the
//     DATA send state. CTRL, GLOBAL, LEDOVR, DBGSEL, DBG, CONFIG and the weights survive it.
//
// Ports use non-ANSI declarations so their widths can use the EOG_* constants of the included header.

module eog_regs (
    clk, rst_n,
    s_axi_awaddr, s_axi_awvalid, s_axi_awready,
    s_axi_wdata, s_axi_wstrb, s_axi_wvalid, s_axi_wready,
    s_axi_bresp, s_axi_bvalid, s_axi_bready,
    s_axi_araddr, s_axi_arvalid, s_axi_arready,
    s_axi_rdata, s_axi_rresp, s_axi_rvalid, s_axi_rready,
    stream_en, src_dma, soft_rst, hb_pulse, swap_req, ack_srv, glb, ledovr,
    cfg_fac_v, cfg_fac_f, cfg_fac_c, cfg_row_v, cfg_row_f, cfg_row_c, fac_touch,
    wb_we, wb_addr, wb_wdata, wb_raddr, wb_rdata,
    dbg_fac, dbg_valid, dbg_feat, dbg_logits, dbg_rec_no,
    autonomous, swap_pending, active_bank, active_ver, ms_since_hb,
    d_valid, d_ready, d_data, d_last,
    r_valid, r_ready, r_data, r_last,
    al_valid, al_data, al_full, al_drop,
    tap_valid, tap_status, tap_reason, stall
);
    parameter integer N_FAC      = 32;      // CONFIG slots (<= 32: 5-bit facility ids)
    parameter integer N_WELL     = 8;       // reported in VERSION[23:16] only
    parameter integer RES_DEPTH  = 64;      // RESULT FIFO depth, records
    parameter integer AL_DEPTH   = 64;      // ALERT FIFO depth, alerts
    parameter integer CYC_PER_MS = 100000;  // clk cycles per ms (STATS 15 uptime); formal may shrink it
    `include "eog_defs.svh"

    input  logic          clk;
    input  logic          rst_n;
    // AXI4-Lite slave
    input  logic [15:0]   s_axi_awaddr;
    input  logic          s_axi_awvalid;
    output logic          s_axi_awready;
    input  logic [31:0]   s_axi_wdata;
    input  logic [3:0]    s_axi_wstrb;
    input  logic          s_axi_wvalid;
    output logic          s_axi_wready;
    output logic [1:0]    s_axi_bresp;
    output logic          s_axi_bvalid;
    input  logic          s_axi_bready;
    input  logic [15:0]   s_axi_araddr;
    input  logic          s_axi_arvalid;
    output logic          s_axi_arready;
    output logic [31:0]   s_axi_rdata;
    output logic [1:0]    s_axi_rresp;
    output logic          s_axi_rvalid;
    input  logic          s_axi_rready;
    // control
    output logic          stream_en;
    output logic          src_dma;
    output logic          soft_rst;
    output logic          hb_pulse;
    output logic          swap_req;
    output logic          ack_srv;
    output logic [EOG_G_BITS-1:0]   glb;
    output logic [31:0]   ledovr;
    // CONFIG
    input  logic [4:0]    cfg_fac_v;
    input  logic [4:0]    cfg_fac_f;
    input  logic [4:0]    cfg_fac_c;
    output logic [EOG_CFG_BITS-1:0] cfg_row_v;
    output logic [EOG_CFG_BITS-1:0] cfg_row_f;
    output logic [EOG_CFG_BITS-1:0] cfg_row_c;
    output logic [N_FAC-1:0]        fac_touch;
    // weights
    output logic          wb_we;
    output logic [6:0]    wb_addr;
    output logic [31:0]   wb_wdata;
    output logic [6:0]    wb_raddr;
    input  logic [31:0]   wb_rdata;
    // debug
    output logic [4:0]    dbg_fac;
    input  logic          dbg_valid;
    input  logic [EOG_N_FEAT*16-1:0] dbg_feat;
    input  logic [EOG_N_CLS*16-1:0]  dbg_logits;
    input  logic [31:0]   dbg_rec_no;
    // status in
    input  logic          autonomous;
    input  logic          swap_pending;
    input  logic          active_bank;
    input  logic [7:0]    active_ver;
    input  logic [15:0]   ms_since_hb;
    // DATA window -> engine
    output logic          d_valid;
    input  logic          d_ready;
    output logic [63:0]   d_data;
    output logic          d_last;
    // RESULT FIFO <- eog_pack
    input  logic          r_valid;
    output logic          r_ready;
    input  logic [63:0]   r_data;
    input  logic          r_last;
    // ALERT FIFO <- eog_alarm
    input  logic          al_valid;
    input  logic [EOG_AL_BITS-1:0] al_data;
    output logic          al_full;
    input  logic          al_drop;
    // STATS taps
    input  logic          tap_valid;
    input  logic [2:0]    tap_status;
    input  logic [15:0]   tap_reason;
    input  logic          stall;

    // ------------------------------------------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------------------------------------------
    localparam logic [31:0] ID_VALUE = 32'h3147_4F45;   // "EOG1"
    localparam integer CFG_WORDS = EOG_CFG_BITS / 32;   // 16
    localparam integer DATA_WORDS = EOG_D_BITS / 32;    // 12
    localparam integer NBEAT = EOG_D_BITS / 64;         // 6
    localparam integer RES_BEATS = EOG_RES_BITS / 64;   // 4
    localparam integer DBG_WORDS = 20;
    localparam integer FW = 5;                          // facility index width
    localparam integer RPW = (RES_DEPTH > 1) ? $clog2(RES_DEPTH) : 1;
    localparam integer RCW = $clog2(RES_DEPTH + 1);
    localparam integer APW = (AL_DEPTH > 1) ? $clog2(AL_DEPTH) : 1;
    localparam integer ACW = $clog2(AL_DEPTH + 1);
    localparam integer MSW = (CYC_PER_MS > 1) ? $clog2(CYC_PER_MS) : 1;

    // FSM states
    localparam logic [3:0] S_SWEEP = 4'd0, S_IDLE = 4'd1, S_WACC = 4'd2, S_WEXEC = 4'd3, S_WRMW = 4'd4,
                           S_BWAIT = 4'd5, S_RACC = 4'd6, S_RADDR = 4'd7, S_RDATA = 4'd8, S_RWAIT = 4'd9;

    // ------------------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------------------
    function automatic logic [31:0] merge(input logic [31:0] old, input logic [31:0] nw, input logic [3:0] strb);
        logic [31:0] r;
        r = old;
        for (int b = 0; b < 4; b++)
            if (strb[b]) r[8*b +: 8] = nw[8*b +: 8];
        return r;
    endfunction

    function automatic logic [31:0] sat_inc(input logic [31:0] x, input logic inc);
        return (inc && !(&x)) ? x + 32'd1 : x;
    endfunction

    // ------------------------------------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------------------------------------
    logic [3:0]  st;
    logic        rd_prio;           // 1: a waiting read goes before a waiting write
    logic [15:0] a_q;               // latched AXI address
    logic [31:0] d_q;               // latched write data
    logic [3:0]  s_q;               // latched write strobes
    logic [FW-1:0] sw_idx;          // CONFIG sweep slot

    logic [1:0]  soft_cnt;          // soft-reset pulse length counter
    logic        stats_clr;         // 1-cycle internal pulse from CTRL.stats_clear
    logic        clr;               // FIFO / STATS / DATA-send clear (soft reset or hard reset)

    logic [EOG_G_BITS-1:0] glb_q;
    logic [4:0]  dbgsel;

    // DATA window
    logic [31:0] wbuf [0:DATA_WORDS-1];
    logic [EOG_D_BITS-1:0] sbuf;    // send shift register, beat 0 in [63:0]
    logic        d_busy;
    logic [2:0]  d_beat;

    // RESULT FIFO
    logic [63:0]   res_mem [0:RES_DEPTH*RES_BEATS-1];
    logic [RPW-1:0] res_head, res_tail;
    logic [RCW-1:0] res_cnt;
    logic [1:0]    res_beat;
    logic [63:0]   res_rd;          // registered RAM read
    logic          res_ne_q;        // FIFO non-empty when the read was issued

    // ALERT FIFO
    logic [EOG_AL_BITS-1:0] al_mem [0:AL_DEPTH-1];
    logic [APW-1:0] al_head, al_tail;
    logic [ACW-1:0] al_cnt;
    logic [EOG_AL_BITS-1:0] al_rd;
    logic          al_ne_q;

    // STATS (word 14 is live, its slot here stays 0)
    logic [16*32-1:0] stats_q;
    logic [MSW-1:0]   ms_div;

    // DBG capture
    logic [EOG_N_FEAT*16-1:0] dbg_feat_q;
    logic [EOG_N_CLS*16-1:0]  dbg_log_q;
    logic [31:0] dbg_no_q;
    logic [31:0] dbg_cnt_q;

    // ------------------------------------------------------------------------------------------------------
    // Address decode of the latched address
    // ------------------------------------------------------------------------------------------------------
    wire        al_ok    = (a_q[1:0] == 2'b00);
    wire        is_id    = al_ok && a_q == 16'h0000;
    wire        is_ver   = al_ok && a_q == 16'h0004;
    wire        is_ctrl  = al_ok && a_q == 16'h0008;
    wire        is_stat  = al_ok && a_q == 16'h000C;
    wire        is_glb   = al_ok && a_q >= 16'h0010 && a_q <= 16'h002C;
    wire        is_alert = al_ok && a_q[15:4] == 12'h004;                     // 0x0040-0x004C
    wire        is_led   = al_ok && a_q == 16'h0060;
    wire        is_dsel  = al_ok && a_q == 16'h0064;
    wire        is_stats = al_ok && a_q[15:6] == 10'h004;                     // 0x0100-0x013C
    wire        is_data  = al_ok && a_q >= 16'h0200 && a_q <= 16'h022C;
    wire        is_res   = al_ok && a_q[15:5] == 11'h018;                     // 0x0300-0x031C
    wire        is_dbg   = al_ok && a_q >= 16'h0400 && a_q <= 16'h044C;
    wire        is_cfg   = al_ok && a_q[15:11] == 5'b00010 && (32'(a_q[10:6]) < N_FAC);   // 0x1000 + 64 f
    wire        is_wt    = al_ok && a_q >= 16'h4000 && a_q <= 16'h4118;

    wire [2:0]    glb_i  = 3'(a_q[4:2] - 3'd4);                               // (a - 0x10) / 4
    wire [1:0]    al_i   = a_q[3:2];
    wire [3:0]    st_i   = a_q[5:2];
    wire [3:0]    dw_i   = a_q[5:2];                                          // DATA word (0..11)
    wire [4:0]    dbg_i  = a_q[6:2];                                          // DBG word (0..19)
    wire [FW-1:0] cf_f   = a_q[10:6];
    wire [3:0]    cf_i   = a_q[5:2];
    wire [6:0]    wt_i   = a_q[8:2];

    // ------------------------------------------------------------------------------------------------------
    // CONFIG table
    // ------------------------------------------------------------------------------------------------------
    function automatic logic [FW-1:0] fac_idx(input logic [FW-1:0] f);
        return (32'(f) < N_FAC) ? f : '0;
    endfunction

    wire [FW-1:0] rv_i = fac_idx(cfg_fac_v);
    wire [FW-1:0] rf_i = fac_idx(cfg_fac_f);
    wire [FW-1:0] rc_i = fac_idx(cfg_fac_c);
    wire [FW-1:0] ra_i = fac_idx(cf_f);

    logic [EOG_CFG_BITS-1:0] row_v, row_f, row_c, row_a;   // raw RAM reads
    logic [CFG_WORDS-1:0]    cfg_we;
    logic [FW-1:0]           cfg_wa;
    logic [31:0]             cfg_wd;

    genvar gi;
    generate
        for (gi = 0; gi < CFG_WORDS; gi++) begin : g_cfg
            logic [31:0] mem [0:N_FAC-1];
            always_ff @(posedge clk)
                if (cfg_we[gi]) mem[cfg_wa] <= cfg_wd;
            assign row_v[32*gi +: 32] = mem[rv_i];
            assign row_f[32*gi +: 32] = mem[rf_i];
            assign row_c[32*gi +: 32] = mem[rc_i];
            assign row_a[32*gi +: 32] = mem[ra_i];
        end
    endgenerate

    // FAC_ID reads as the slot; an out-of-range facility reads an all-zero row
    always_comb begin
        cfg_row_v = (32'(cfg_fac_v) < N_FAC) ? {row_v[EOG_CFG_BITS-1:16], 11'd0, cfg_fac_v} : '0;
        cfg_row_f = (32'(cfg_fac_f) < N_FAC) ? {row_f[EOG_CFG_BITS-1:16], 11'd0, cfg_fac_f} : '0;
        cfg_row_c = (32'(cfg_fac_c) < N_FAC) ? {row_c[EOG_CFG_BITS-1:16], 11'd0, cfg_fac_c} : '0;
    end

    wire [31:0] cf_old    = row_a[32*cf_i +: 32];            // the addressed word (merge source, readback)
    wire        cf_en     = row_a[EOG_CFG_FLAGS];            // FLAGS[0] of the addressed slot
    wire        cf_accept = !cf_en || (cf_i == 4'd0 && s_q[3] && !d_q[EOG_CFG_FLAGS]);
    wire        cf_wr     = (st == S_WEXEC) && is_cfg && cf_accept;

    always_comb begin
        for (int i = 0; i < CFG_WORDS; i++)
            cfg_we[i] = (st == S_SWEEP) || (cf_wr && cf_i == 4'(i));
        cfg_wa = (st == S_SWEEP) ? sw_idx : cf_f;
        cfg_wd = (st == S_SWEEP) ? 32'd0 : merge(cf_old, d_q, s_q);
    end

    // ------------------------------------------------------------------------------------------------------
    // Weight window
    // ------------------------------------------------------------------------------------------------------
    assign wb_raddr = wt_i;
    assign wb_addr  = wt_i;
    assign wb_we    = ((st == S_WEXEC) && is_wt && s_q == 4'hF) || (st == S_WRMW);
    assign wb_wdata = (st == S_WRMW) ? merge(wb_rdata, d_q, s_q) : d_q;

    // ------------------------------------------------------------------------------------------------------
    // AXI FSM
    // ------------------------------------------------------------------------------------------------------
    wire want_w = s_axi_awvalid && s_axi_wvalid;
    wire want_r = s_axi_arvalid;
    wire w_fire = s_axi_awready && s_axi_awvalid && s_axi_wvalid;
    wire r_fire = s_axi_arready && s_axi_arvalid;

    assign s_axi_bresp  = 2'b00;
    assign s_axi_rresp  = 2'b00;
    assign s_axi_bvalid = (st == S_BWAIT);
    assign s_axi_rvalid = (st == S_RWAIT);
    assign s_axi_wready = s_axi_awready;

    // control-register side effects of a write (W_EXEC)
    wire wx        = (st == S_WEXEC);
    wire ctrl_wr   = wx && is_ctrl && s_q[0];
    wire glb_wr    = wx && is_glb && !stream_en;
    wire data_wr   = wx && is_data && s_q == 4'hF;
    wire push_req  = data_wr && dw_i == 4'd11 && !src_dma;
    wire push_ok   = push_req && !d_busy;
    wire push_ovr  = push_req && d_busy;
    wire res_pop   = (st == S_RDATA) && is_res && a_q[4:2] == 3'd7 && res_ne_q;
    wire al_pop    = (st == S_RDATA) && is_alert && a_q[3:2] == 2'd3 && al_ne_q;

    // read-data mux (valid in R_DATA)
    logic [31:0] rmux;
    logic [EOG_G_BITS-1:0] glb_rd;
    logic [16*32-1:0] stats_rd;
    logic [DBG_WORDS*32-1:0] dbg_rd;
    always_comb begin
        glb_rd = glb_q;
        glb_rd[EOG_G_S +: 8]       = 8'(EOG_FEAT_SHIFT);
        glb_rd[EOG_G_CD_LOG2 +: 8] = 8'(EOG_CD_LOG2);
        stats_rd = stats_q;
        stats_rd[14*32 +: 32] = {16'd0, ms_since_hb};
        dbg_rd = {dbg_cnt_q, dbg_no_q, dbg_log_q, 16'd0, dbg_feat_q};

        rmux = 32'd0;
        if (is_id)    rmux = ID_VALUE;
        if (is_ver)   rmux = {8'd0, 8'(N_WELL), 8'(N_FAC), 8'(EOG_SPEC_VERSION)};
        if (is_ctrl)  rmux = {26'd0, src_dma, 4'd0, stream_en};
        if (is_stat)  rmux = {active_ver,
                              (32'(al_cnt) > 255) ? 8'd255 : 8'(al_cnt),
                              (32'(res_cnt) > 255) ? 8'd255 : 8'(res_cnt),
                              2'd0, d_busy, (al_cnt != '0), (res_cnt != '0),
                              active_bank, swap_pending, autonomous};
        if (is_glb)   rmux = glb_rd[32*glb_i +: 32];
        if (is_alert) rmux = al_ne_q ? al_rd[32*al_i +: 32] : 32'd0;
        if (is_led)   rmux = ledovr;
        if (is_dsel)  rmux = {27'd0, dbgsel};
        if (is_stats) rmux = stats_rd[32*st_i +: 32];
        if (is_res)   rmux = res_ne_q ? (a_q[2] ? res_rd[63:32] : res_rd[31:0]) : 32'd0;
        if (is_dbg)   rmux = dbg_rd[32*dbg_i +: 32];
        if (is_cfg)   rmux = (cf_i == 4'd0) ? {cf_old[31:16], 11'd0, cf_f} : cf_old;
        if (is_wt)    rmux = wb_rdata;
    end

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            st            <= S_SWEEP;
            sw_idx        <= '0;
            rd_prio       <= 1'b0;
            s_axi_awready <= 1'b0;
            s_axi_arready <= 1'b0;
            s_axi_rdata   <= 32'd0;
            a_q           <= 16'd0;
            d_q           <= 32'd0;
            s_q           <= 4'd0;
        end else begin
            case (st)
                S_SWEEP: begin
                    sw_idx <= sw_idx + 1'b1;
                    if (32'(sw_idx) == N_FAC - 1) st <= S_IDLE;
                end
                S_IDLE: begin
                    if (want_w && (!want_r || !rd_prio)) begin
                        s_axi_awready <= 1'b1;
                        st            <= S_WACC;
                    end else if (want_r) begin
                        s_axi_arready <= 1'b1;
                        st            <= S_RACC;
                    end
                end
                S_WACC: if (w_fire) begin           // AXI: valids stay up until the handshake
                    s_axi_awready <= 1'b0;
                    a_q           <= s_axi_awaddr;
                    d_q           <= s_axi_wdata;
                    s_q           <= s_axi_wstrb;
                    rd_prio       <= 1'b1;
                    st            <= S_WEXEC;
                end
                S_WEXEC: st <= (is_wt && s_q != 4'hF && s_q != 4'h0) ? S_WRMW : S_BWAIT;
                S_WRMW:  st <= S_BWAIT;
                S_BWAIT: if (s_axi_bready) st <= S_IDLE;
                S_RACC: if (r_fire) begin
                    s_axi_arready <= 1'b0;
                    a_q           <= s_axi_araddr;
                    rd_prio       <= 1'b0;
                    st            <= S_RADDR;
                end
                S_RADDR: st <= S_RDATA;
                S_RDATA: begin
                    s_axi_rdata <= rmux;
                    st          <= S_RWAIT;
                end
                S_RWAIT: if (s_axi_rready) st <= S_IDLE;
                default: st <= S_IDLE;
            endcase
        end
    end

    // ------------------------------------------------------------------------------------------------------
    // CTRL, GLOBAL, LEDOVR, DBGSEL, pulses
    // ------------------------------------------------------------------------------------------------------
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            stream_en <= 1'b0;
            src_dma   <= 1'b0;
            soft_cnt  <= 2'd0;
            hb_pulse  <= 1'b0;
            swap_req  <= 1'b0;
            ack_srv   <= 1'b0;
            stats_clr <= 1'b0;
            glb_q     <= '0;
            ledovr    <= 32'd0;
            dbgsel    <= 5'd0;
            fac_touch <= '0;
        end else begin
            hb_pulse  <= ctrl_wr && d_q[2];
            swap_req  <= ctrl_wr && d_q[3];
            ack_srv   <= ctrl_wr && d_q[4];
            stats_clr <= ctrl_wr && d_q[6];
            if (ctrl_wr) begin
                stream_en <= d_q[0];
                src_dma   <= d_q[5];
            end
            if (ctrl_wr && d_q[1])     soft_cnt <= 2'd2;
            else if (soft_cnt != 2'd0) soft_cnt <= soft_cnt - 2'd1;
            if (glb_wr)                glb_q[32*glb_i +: 32] <= merge(glb_q[32*glb_i +: 32], d_q, s_q);
            if (wx && is_led)          ledovr <= merge(ledovr, d_q, s_q);
            if (wx && is_dsel && s_q[0]) dbgsel <= d_q[4:0];
            fac_touch <= '0;
            if (cf_wr) fac_touch[cf_f] <= 1'b1;
        end
    end

    assign soft_rst = (soft_cnt != 2'd0);
    assign clr      = !rst_n || soft_rst;
    assign dbg_fac  = dbgsel;

    always_comb begin
        glb = glb_q;
        glb[EOG_G_S +: 8]       = 8'(EOG_FEAT_SHIFT);
        glb[EOG_G_CD_LOG2 +: 8] = 8'(EOG_CD_LOG2);
    end

    // ------------------------------------------------------------------------------------------------------
    // DATA window
    // ------------------------------------------------------------------------------------------------------
    always_ff @(posedge clk)
        if (data_wr) wbuf[dw_i] <= d_q;

    logic [EOG_D_BITS-1:0] wbuf_rec;
    always_comb begin
        for (int i = 0; i < DATA_WORDS - 1; i++) wbuf_rec[32*i +: 32] = wbuf[i];
        wbuf_rec[EOG_D_BITS-32 +: 32] = d_q;                  // word 11 = the pushing write
    end

    always_ff @(posedge clk) begin
        if (clr) begin
            d_busy <= 1'b0;
            d_beat <= 3'd0;
        end else if (push_ok) begin
            d_busy <= 1'b1;
            d_beat <= 3'd0;
        end else if (d_valid && d_ready) begin
            d_beat <= d_beat + 3'd1;
            if (d_beat == 3'(NBEAT - 1)) d_busy <= 1'b0;
        end
    end

    always_ff @(posedge clk)
        if (push_ok)                sbuf <= wbuf_rec;
        else if (d_valid && d_ready) sbuf <= {64'd0, sbuf[EOG_D_BITS-1:64]};

    assign d_valid = d_busy;
    assign d_data  = sbuf[63:0];
    assign d_last  = d_busy && d_beat == 3'(NBEAT - 1);

    // ------------------------------------------------------------------------------------------------------
    // RESULT FIFO
    // ------------------------------------------------------------------------------------------------------
    assign r_ready = (32'(res_cnt) < RES_DEPTH);
    wire res_push  = r_valid && r_ready;
    wire res_done  = res_push && res_beat == 2'(RES_BEATS - 1);

    always_ff @(posedge clk)
        if (res_push) res_mem[{res_tail, res_beat}] <= r_data;

    always_ff @(posedge clk)
        if (st == S_RADDR) res_rd <= res_mem[{res_head, a_q[4:3]}];

    always_ff @(posedge clk) begin
        if (clr) begin
            res_head <= '0;
            res_tail <= '0;
            res_cnt  <= '0;
            res_beat <= 2'd0;
            res_ne_q <= 1'b0;
        end else begin
            if (st == S_RADDR) res_ne_q <= (res_cnt != '0);
            if (res_push) res_beat <= res_beat + 2'd1;
            if (res_done) res_tail <= (32'(res_tail) == RES_DEPTH - 1) ? '0 : res_tail + 1'b1;
            if (res_pop)  res_head <= (32'(res_head) == RES_DEPTH - 1) ? '0 : res_head + 1'b1;
            if (res_done && !res_pop)      res_cnt <= res_cnt + 1'b1;
            else if (res_pop && !res_done) res_cnt <= res_cnt - 1'b1;
        end
    end

    // ------------------------------------------------------------------------------------------------------
    // ALERT FIFO
    // ------------------------------------------------------------------------------------------------------
    assign al_full = (32'(al_cnt) == AL_DEPTH);
    wire al_push   = al_valid && !al_full;

    always_ff @(posedge clk)
        if (al_push) al_mem[al_tail] <= al_data;

    always_ff @(posedge clk)
        if (st == S_RADDR) al_rd <= al_mem[al_head];

    always_ff @(posedge clk) begin
        if (clr) begin
            al_head <= '0;
            al_tail <= '0;
            al_cnt  <= '0;
            al_ne_q <= 1'b0;
        end else begin
            if (st == S_RADDR) al_ne_q <= (al_cnt != '0);
            if (al_push) al_tail <= (32'(al_tail) == AL_DEPTH - 1) ? '0 : al_tail + 1'b1;
            if (al_pop)  al_head <= (32'(al_head) == AL_DEPTH - 1) ? '0 : al_head + 1'b1;
            if (al_push && !al_pop)      al_cnt <= al_cnt + 1'b1;
            else if (al_pop && !al_push) al_cnt <= al_cnt - 1'b1;
        end
    end

    // ------------------------------------------------------------------------------------------------------
    // STATS
    // ------------------------------------------------------------------------------------------------------
    wire t_drop = tap_valid && tap_status == EOG_ST_DROPPED;
    wire ms_tick = (32'(ms_div) == CYC_PER_MS - 1);
    logic [15:0] inc;
    always_comb begin
        inc     = '0;
        inc[0]  = d_valid && d_ready && d_last;                         // records in (DATA window)
        inc[1]  = tap_valid;
        inc[2]  = tap_valid && tap_status == EOG_ST_VALID;
        inc[3]  = tap_valid && tap_status == EOG_ST_HELD;
        inc[4]  = tap_valid && tap_status == EOG_ST_INVALID;
        inc[5]  = t_drop && tap_reason[EOG_R_DUPLICATE];
        inc[6]  = t_drop && tap_reason[EOG_R_OUT_OF_ORDER];
        inc[7]  = t_drop && tap_reason[EOG_R_UNKNOWN_FAC];
        inc[8]  = t_drop && tap_reason[EOG_R_FRAMING];
        inc[9]  = tap_valid && tap_reason[EOG_R_HIST_RESET];
        inc[10] = al_push;
        inc[11] = al_drop || (al_valid && al_full);
        inc[12] = push_ovr;
        inc[13] = stall;
        inc[15] = ms_tick;
    end

    always_ff @(posedge clk) begin
        if (clr || stats_clr) begin
            stats_q <= '0;
            ms_div  <= '0;
        end else begin
            ms_div <= ms_tick ? '0 : ms_div + 1'b1;
            for (int i = 0; i < 16; i++)
                stats_q[32*i +: 32] <= (i == 14) ? 32'd0 : sat_inc(stats_q[32*i +: 32], inc[i]);
        end
    end

    // ------------------------------------------------------------------------------------------------------
    // DBG capture
    // ------------------------------------------------------------------------------------------------------
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            dbg_feat_q <= '0;
            dbg_log_q  <= '0;
            dbg_no_q   <= 32'd0;
            dbg_cnt_q  <= 32'd0;
        end else if (dbg_valid) begin
            dbg_feat_q <= dbg_feat;
            dbg_log_q  <= dbg_logits;
            dbg_no_q   <= dbg_rec_no;
            dbg_cnt_q  <= dbg_cnt_q + 32'd1;
        end
    end

    // Unused: r_last (records are counted by beats), most reason bits, the low address bits, the stored FAC_ID
    // bytes of the row reads (FAC_ID reads as the slot)
    wire _unused = &{1'b0, r_last, tap_reason, a_q[1:0], row_v[15:0], row_f[15:0], row_c[15:0]};

`ifdef FORMAL
    // Internal invariants (k-induction helpers), all under rst_n.
    always @(*) if (rst_n) begin
        assert (st <= S_RWAIT);
        assert (32'(res_cnt) <= RES_DEPTH);
        assert (32'(al_cnt) <= AL_DEPTH);
        assert (32'(res_head) < RES_DEPTH && 32'(res_tail) < RES_DEPTH);
        assert (32'(al_head) < AL_DEPTH && 32'(al_tail) < AL_DEPTH);
        assert (32'(res_tail) == (32'(res_head) + 32'(res_cnt)) % RES_DEPTH);
        assert (32'(al_tail) == (32'(al_head) + 32'(al_cnt)) % AL_DEPTH);
        if (32'(res_cnt) == RES_DEPTH) assert (res_beat == 2'd0);
        assert (d_beat <= 3'(NBEAT - 1));
        if (!d_busy) assert (d_beat == 3'd0);
        assert (soft_cnt <= 2'd2);
        assert (32'(ms_div) < CYC_PER_MS);
        assert (s_axi_awready == (st == S_WACC));
        assert (s_axi_arready == (st == S_RACC));
        if (st == S_SWEEP) assert (32'(sw_idx) < N_FAC);
    end
`endif

endmodule
