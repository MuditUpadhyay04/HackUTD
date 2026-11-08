// fv_eog_head.sv -- formal harness for eog_head (spec/modules/eog_head.md, numerics.md section 8; spec v3).
// Verify role, task T1.head.fv. Written from the spec's port table only: the harness uses the DUT's ports and its
// formal observation ports (conventions section 7), never an internal signal.
//
// Property map (labels in sby logs; the "Required properties" list of the module spec):
//
//   stage contract  u_in.ax_* (assumed), u_out.ax_* (handshake, conventions section 2), u_stage.st_order /
//                   st_no_ghost / st_inflight / st_cnt / st_link_n / st_link_r / st_ii / st_lat
//                   (one in, one out, in order via REC_NO; II <= 16; latency <= LAT_MAX)
//   HDR             header pass-through: REC_NO, IN_LAST, FAC_RAW, FAC, TS, STATUS, SINCE_RESET, HIST_RESET copied;
//                   REASON = in.REASON | (NO_MODEL if VALID/HELD and the accept-time active_ver = 0)
//   CPY             CH3 = FEAT[3], RULES and CD copied
//   WV              WVER = active_ver in the accept cycle (0 for DROPPED, conventions section 3)
//   H1              logits are computed from the bank active in the accept cycle: the harness snapshots its shadow
//                   of that bank's words at the accept of an anyconst record and predicts the logits from the
//                   snapshot (labels H1H6_logit / H1H5_logit, bmc tasks); with H2_bnd/H2_prio no swap can fall
//                   inside a record, and H3 (below) keeps the active bank unchanged by writes
//   H2_once         active_bank toggles only on a pending request (or one in that cycle): at most one swap per
//                   swap_req, requests while pending coalesce
//   H2_pend         swap_pending is 1 exactly from swap_req until the swap (registered, or also combinationally
//                   in the swap_req cycle)
//   H2_fall         swap_pending falls only in the cycle active_bank toggles
//   H2_bnd          a swap happens only with no record in flight (between an output transfer and the next accept)
//   H2_prio         no record is accepted while a swap is pending ("at the next record boundary")
//   H2_live         a pending swap happens within SWAP_MAX cycles once no record is in flight
//   H3_ver          active_ver always equals the VER the harness shadow holds for the active bank: writes never
//                   modify the active bank's word 68; a swap makes the written bank's VER active
//   RB              wb_rdata, 1 cycle after wb_raddr, equals the harness shadow of the inactive bank (also catches a
//                   write that modified the active bank, once that bank is inactive again: H3 for every word)
//   RST             after a hard reset (wb_rst_n = 0) active_ver = 0 (both banks' word 68 reads 0), active_bank = 0,
//                   swap_pending = 0 (via H2_pend)
//   SRST_bank/_ver  a soft reset (rst_n = 0, wb_rst_n = 1) leaves active_bank and active_ver unchanged, and a pending
//                   swap stays pending (H2_pend) without executing; the shadow ignores rst_n, so RB/H3_ver check
//                   that every bank word survives it, readback included (spec v3)
//   WIGN            (in RB/H3_ver) writes while rst_n = 0 or wb_rst_n = 0 are ignored: the shadow does not take them
//   H4_zero         active_ver = 0 at accept, or STATUS INVALID/DROPPED -> LOGITS = 0
//   H4_nm           NO_MODEL set iff VALID/HELD and active_ver = 0 at accept
//   H6 (H1H6_logit) FEAT = 0 (acc = B): LOGIT = sat16((B + 2^(S_OUT-1)) >>> S_OUT) for every S_OUT 0..31, any B
//   H5 (H1H5_logit) real multipliers: LOGIT = sat16((sum W*FEAT + B + rnd) >>> S_OUT) with a 64-bit harness sum
//                   (the accumulator is observable only through the logits; S_OUT up to 31 exposes its high bits)
//   covers          C_swap (a swap between two records, both with a model), C_sat (a saturated logit), C_sat5 (a
//                   saturated logit predicted from nonzero features), C_nomodel, C_coalesce (a request while
//                   pending, then one swap), C_rb (a readback checked), C_srst (a record with a model after a soft
//                   reset)
//
// Parameters (set per task in eog_head.sby):
//   N_FEAT        features used by the DUT (bus C still carries 31; the weight image layout is unchanged:
//                 word 16k + j holds W[k][2j], W[k][2j+1])
//   MUL_REAL      1 when the task reads rtl/eog_mul.sv (enables H1H5_logit), 0 with the abstract multiplier
//   SH            weight-bank shadow: 0 = only word 68's VER, with wb_raddr assumed to be 68 so both banks' VER are
//                 observed every cycle (inductive; prove); 1 = {anyconst word A, B[0..3], word 68};
//                 2 = {anyconst word A, every word used at N_FEAT}
//   FSET / WSET   assumed operand sets for the real-multiplier tasks: 0 free; 1 (features only) 0, 32767 or
//                 +-2^j; 2 {0, 1, -1, 32767, -32768}. They keep multiplier equivalence tractable for SAT.
//   MAX_INFLIGHT  records the DUT may hold (the spec does not bound it; 4 leaves room for a pipelined head)
//   LAT_MAX       st_lat bound (spec: 128)
//   SWAP_MAX      H2_live bound (the spec says "next record boundary" without a number; 16 = II_MAX)
//   II_EXCL_SWAP  1 excludes cycles with a pending swap from st_ii (the spec does not; default 0 = strict)
//   WR            1: writes and reads only touch shadowed words (bmc run time)
//
// Input assumptions (upstream contract, eog_countdown -> eog_head; eog_regs -> weight port):
//   STATUS in {VALID, HELD, INVALID, DROPPED}; REASON[NO_MODEL] = 0 (only the head sets it). FEAT, RULES and CD are
//   free for every status (CH3/RULES/CD are copies; logits must be 0 for INVALID/DROPPED whatever FEAT holds).
//   wb_we: wb_addr <= 68; word 68 bits [31:16] and [7:5] written 0; a weight half with index >= N_FEAT written 0
//   (the W[k][31] padding at N_FEAT = 31); at reduced N_FEAT only words the DUT uses are written. Writes during
//   either reset are allowed (and must be ignored). No swap_req while rst_n = 0.
//   Resets (spec v3): wb_rst_n = 0 in the first cycle and wb_rst_n = 0 -> rst_n = 0 (a hard reset resets both);
//   rst_n alone (soft reset) is free.

module fv_eog_head #(
    parameter integer N_FEAT       = 31,
    parameter integer MUL_REAL     = 0,
    parameter integer SH           = 0,
    parameter integer FSET         = 0,
    parameter integer WSET         = 0,
    parameter integer WR           = 0,
    parameter integer MAX_INFLIGHT = 4,
    parameter integer LAT_MAX      = 128,
    parameter integer SWAP_MAX     = 16,
    parameter integer II_EXCL_SWAP = 0
) (
    input logic         clk,          // top-level inputs are free: the solver drives them
    input logic         rst_n,
    input logic         wb_rst_n,     // spec v3: weight-store (hard) reset
    input logic         in_valid,
    input logic [662:0] in_data,      // EOG_BC_W
    input logic         out_ready,
    input logic         wb_we,
    input logic [6:0]   wb_addr,
    input logic [31:0]  wb_wdata,
    input logic [6:0]   wb_raddr,
    input logic         swap_req
);
    `include "eog_defs.svh"

    localparam integer NWPC = (N_FEAT + 1) / 2;                       // weight words per class used at N_FEAT
    localparam integer NSH  = (SH == 0) ? 1 : (SH == 1) ? 6 : (1 + 4 * NWPC + 5);
    localparam integer SB   = (SH == 2) ? (1 + 4 * NWPC) : 1;          // shadow slot of B[0] (SH >= 1)
    localparam integer SM   = (SH == 0) ? 0 : (SB + 4);                // shadow slot of word 68

    // ------------------------------------------------------------------------------------------------- DUT
    logic         in_ready, out_valid;
    logic [254:0] out_data;
    logic [31:0]  wb_rdata;
    logic         swap_pending, active_bank;
    logic [7:0]   active_ver;
    logic [7:0]   dut_inflight;
    logic [31:0]  dut_oldest;

    eog_head #(.II(16), .N_FEAT(N_FEAT), .N_CLS(4)) dut (
        .clk(clk), .rst_n(rst_n), .wb_rst_n(wb_rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data),
        .wb_we(wb_we), .wb_addr(wb_addr), .wb_wdata(wb_wdata), .wb_raddr(wb_raddr), .wb_rdata(wb_rdata),
        .swap_req(swap_req), .swap_pending(swap_pending), .active_bank(active_bank), .active_ver(active_ver),
        .f_inflight(dut_inflight), .f_oldest_recno(dut_oldest));

    // ------------------------------------------------------------------------------------- shared checkers
    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    eog_fv_axis #(.W(EOG_BC_W), .ASSUME(1)) u_in (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(in_valid), .ready(in_ready), .data(in_data));
    eog_fv_axis #(.W(EOG_BL_W), .ASSUME(0)) u_out (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(out_valid), .ready(out_ready), .data(out_data));

    logic       f_pend;       // harness model: a swap was requested and has not happened yet
    logic       f_excl;
    logic [7:0] f_in_cnt, f_out_cnt, f_in_flight;
    assign f_excl = (II_EXCL_SWAP != 0) && (f_pend || swap_pending);

    eog_fv_stage #(.RW(8), .MAX_INFLIGHT(MAX_INFLIGHT), .II_MAX(16), .LAT_MAX(LAT_MAX), .SWEEP(0)) u_stage (
        .clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .in_valid(in_valid), .in_ready(in_ready), .in_recno(in_data[EOG_BC_REC_NO +: 8]),
        .out_valid(out_valid), .out_ready(out_ready), .out_recno(out_data[EOG_BL_REC_NO +: 8]),
        .excl(f_excl), .dut_inflight(dut_inflight), .dut_oldest(dut_oldest),
        .f_in_cnt(f_in_cnt), .f_out_cnt(f_out_cnt), .f_in_flight(f_in_flight));

    logic in_fire, out_fire;
    assign in_fire  = in_valid && in_ready;
    assign out_fire = out_valid && out_ready;

    // ---------------------------------------------------------------------------------------------- helpers
    function automatic logic is_vh(input logic [2:0] st);
        is_vh = (st == EOG_ST_VALID) || (st == EOG_ST_HELD);
    endfunction

    // 0, 32767 or +-2^j (j = 0..15): a product with it is a shift (and a subtract), cheap for SAT
    function automatic logic p2ish(input logic [15:0] x);
        logic [16:0] m;
        m = x[15] ? (17'd0 - {1'b1, x}) : {1'b0, x};
        p2ish = (x == 16'h7FFF) || ((m & (m - 17'd1)) == 17'd0);
    endfunction

    function automatic logic small5(input logic [15:0] x);
        small5 = (x == 16'h0000) || (x == 16'h0001) || (x == 16'hFFFF) || (x == 16'h7FFF) || (x == 16'h8000);
    endfunction

    function automatic logic opnd_ok(input integer set, input logic [15:0] x);
        opnd_ok = (set == 1) ? p2ish(x) : (set == 2) ? small5(x) : 1'b1;
    endfunction

    // numerics.md section 8: sat16((acc + (S_OUT > 0 ? 2^(S_OUT-1) : 0)) >>> S_OUT)
    function automatic logic [15:0] logit_of(input logic signed [63:0] acc, input logic [4:0] s);
        logic signed [63:0] r;
        r = acc + ((s == 5'd0) ? 64'sd0 : (64'sd1 <<< (s - 5'd1)));
        r = r >>> s;
        if (r > 64'sd32767)       logit_of = 16'h7FFF;
        else if (r < -64'sd32768) logit_of = 16'h8000;
        else                      logit_of = r[15:0];
    endfunction

    // ------------------------------------------------------------------------------------ input assumptions
    logic [2:0]  i_status;
    logic [30:0] i_fset_ok;
    assign i_status = in_data[EOG_BC_STATUS +: EOG_BC_STATUS_W];

    always_comb begin
        i_fset_ok = '1;
        for (int i = 0; i < N_FEAT; i++)
            i_fset_ok[i] = opnd_ok(FSET, in_data[EOG_BC_FEAT + 16 * i +: 16]);
    end

    always_comb begin
        if (in_valid) begin
            a_status: assume (is_vh(i_status) || i_status == EOG_ST_INVALID || i_status == EOG_ST_DROPPED);
            a_nm:     assume (!in_data[EOG_BC_REASON + EOG_R_NO_MODEL]);
            a_fset:   assume (&i_fset_ok);
        end
    end

    // weight port
    logic [15:0] w_lo, w_hi;
    logic [6:0]  w_i0, w_i1;     // feature index of the low / high half of a weight word
    assign w_lo = wb_wdata[15:0];
    assign w_hi = wb_wdata[31:16];
    assign w_i0 = {2'b00, wb_addr[3:0], 1'b0};
    assign w_i1 = {2'b00, wb_addr[3:0], 1'b1};

    always_comb begin
        if (!f_past_valid) a_hard0: assume (!wb_rst_n);
        if (!wb_rst_n)     a_hard:  assume (!rst_n);
        if (!rst_n)        a_rreq:  assume (!swap_req);
        if (wb_we) begin
            a_wb_addr: assume (wb_addr <= 7'd68);
            if (wb_addr == 7'd68) a_wb_meta: assume (wb_wdata[31:16] == 16'd0 && wb_wdata[7:5] == 3'd0);
            if (wb_addr < 7'd64) begin
                a_wb_used: assume (32'(wb_addr[3:0]) < NWPC);
                a_wb_pad:  assume ((32'(w_i0) < N_FEAT || w_lo == 16'd0) && (32'(w_i1) < N_FEAT || w_hi == 16'd0));
                a_wset:    assume (opnd_ok(WSET, w_lo) && opnd_ok(WSET, w_hi));
            end
        end
        if (SH == 0) a_rb68: assume (wb_raddr == 7'd68);
    end

    // ------------------------------------------------------------------------------- previous-cycle values
    logic       p_rst, p_wbrst, p_bank, p_req_or, p_swap_pending;
    logic [7:0] p_ver;
    initial begin
        p_rst    = 1'b0;
        p_wbrst  = 1'b0;
        p_req_or = 1'b0;
    end
    always_ff @(posedge clk) begin
        p_rst          <= rst_n;
        p_wbrst        <= wb_rst_n;
        p_bank         <= active_bank;
        p_ver          <= active_ver;
        p_swap_pending <= swap_pending;
        p_req_or       <= wb_rst_n && (f_pend || swap_req);     // only a hard reset clears a pending swap
    end

    // a swap = active_bank toggling at a clock edge outside a hard reset
    logic f_toggle;
    assign f_toggle = f_past_valid && p_wbrst && (active_bank != p_bank);
    assign f_pend   = p_req_or && !f_toggle;

    // ------------------------------------------------------------------------------------------------- H2
    logic [7:0] f_swait;          // cycles a pending swap has waited with no record in flight
    initial f_swait = '0;
    always_ff @(posedge clk) begin
        if (!rst_n || !f_pend || f_in_flight != 8'd0) f_swait <= '0;
        else if (f_swait != 8'hFF)                     f_swait <= f_swait + 1'b1;
    end

    always_comb begin
        if (f_past_valid) begin
            H2_pend: assert ((swap_pending == f_pend) || (swap_req && swap_pending));
            if (p_wbrst) begin
                if (f_toggle) begin
                    H2_once: assert (p_req_or);
                    H2_bnd:  assert (f_in_flight == 8'd0);
                end
                if (p_swap_pending && !swap_pending)
                    H2_fall: assert (f_toggle);
                if (!p_rst) begin
                    SRST_bank: assert (active_bank == p_bank);
                    SRST_ver:  assert (active_ver == p_ver);
                end
            end else begin
                RST: assert (active_ver == 8'd0 && active_bank == 1'b0);
            end
        end
        if (f_past_valid && rst_n) begin
            H2_prio: assert (!(in_fire && f_pend));
            H2_live: assert (f_swait < SWAP_MAX);
        end
    end

    // ------------------------------------------------------------------------------ weight-bank shadow
    // Slot j shadows word sh_addr(j) of both banks: value and "known" (written since power-up; word 68 is known 0
    // after every hard reset; rst_n alone leaves the shadow alone). A write goes to the bank inactive in the write
    // cycle (eog_head.md "Behavior"); writes while either reset is 0 are ignored.
    (* anyconst *) logic [6:0] f_a;
    always_comb begin
        a_fa: assume (f_a <= 7'd68 && (f_a >= 7'd64 || 32'(f_a[3:0]) < NWPC));
    end

    function automatic logic [6:0] sh_addr(input integer j, input logic [6:0] a);
        if (SH == 0)      sh_addr = 7'd68;
        else if (j == 0)  sh_addr = a;
        else if (j < SB)  sh_addr = 7'(16 * ((j - 1) / NWPC) + (j - 1) % NWPC);
        else              sh_addr = 7'(64 + (j - SB));
    endfunction

    logic [NSH*32-1:0] sh_v0, sh_v1;
    logic [NSH-1:0]    sh_k0, sh_k1;
    initial begin
        sh_k0 = '0;
        sh_k1 = '0;
    end
    always_ff @(posedge clk) begin
        for (int j = 0; j < NSH; j++) begin
            if (!wb_rst_n) begin
                if (sh_addr(j, f_a) == 7'd68) begin
                    sh_v0[j*32 +: 32] <= 32'd0;
                    sh_v1[j*32 +: 32] <= 32'd0;
                    sh_k0[j]          <= 1'b1;
                    sh_k1[j]          <= 1'b1;
                end
            end else if (rst_n && wb_we && wb_addr == sh_addr(j, f_a)) begin
                if (active_bank) begin
                    sh_v0[j*32 +: 32] <= wb_wdata;
                    sh_k0[j]          <= 1'b1;
                end else begin
                    sh_v1[j*32 +: 32] <= wb_wdata;
                    sh_k1[j]          <= 1'b1;
                end
            end
        end
    end

    // WR = 1: writes and reads only touch shadowed words (bmc speed: the solver need not track a RAM written at
    // arbitrary addresses; an aliasing write from one shadowed word into another is still caught)
    logic wa_ok, ra_ok;
    always_comb begin
        wa_ok = 1'b0;
        ra_ok = 1'b0;
        for (int j = 0; j < NSH; j++) begin
            if (sh_addr(j, f_a) == wb_addr)  wa_ok = 1'b1;
            if (sh_addr(j, f_a) == wb_raddr) ra_ok = 1'b1;
        end
        if (WR != 0 && SH != 0) begin
            if (wb_we) a_wr: assume (wa_ok);
            a_rr: assume (ra_ok);
        end
    end

    // H3_ver: active_ver = VER (word 68 [15:8]) of the active bank's shadow
    logic [31:0] sh_meta_act;
    logic        sh_meta_act_k;
    assign sh_meta_act   = active_bank ? sh_v1[SM*32 +: 32] : sh_v0[SM*32 +: 32];
    assign sh_meta_act_k = active_bank ? sh_k1[SM] : sh_k0[SM];
    always_comb if (f_past_valid && sh_meta_act_k) H3_ver: assert (active_ver == sh_meta_act[15:8]);

    // RB: readback of the inactive bank, 1 cycle after wb_raddr (not across a swap, not for a word written in the
    // read cycle: read-during-write is unspecified; not for a read during a hard reset). Reads during a soft reset
    // are checked (rst_n only flushes the record in flight). SH = 0 compares VER only (S_OUT of the active bank is
    // not observable every cycle, so it is not inductive).
    localparam logic [31:0] RB_MASK = (SH == 0) ? 32'h0000_FF00 : 32'hFFFF_FFFF;
    logic        rb_hit, p_rb_chk;
    logic [31:0] rb_exp, p_rb_exp;
    always_comb begin
        rb_hit = 1'b0;
        rb_exp = '0;
        for (int j = 0; j < NSH; j++) begin
            if (sh_addr(j, f_a) == wb_raddr && (active_bank ? sh_k0[j] : sh_k1[j])) begin
                rb_hit = 1'b1;
                rb_exp = active_bank ? sh_v0[j*32 +: 32] : sh_v1[j*32 +: 32];
            end
        end
    end
    initial p_rb_chk = 1'b0;
    always_ff @(posedge clk) begin
        p_rb_chk <= wb_rst_n && rb_hit && !(rst_n && wb_we && wb_addr == wb_raddr);
        p_rb_exp <= rb_exp;
    end
    always_comb if (f_past_valid && p_rb_chk && active_bank == p_bank) RB: assert ((wb_rdata & RB_MASK) == (p_rb_exp & RB_MASK));

    // ------------------------------------------------------------------------- tracked record (anyconst)
    (* anyconst *) logic [7:0] f_k;
    logic                f_tv;
    logic [662:0]        f_td;
    logic [7:0]          f_tver;
    logic [NSH*32-1:0]   f_snap_v;
    logic [NSH-1:0]      f_snap_k;
    initial f_tv = 1'b0;
    always_ff @(posedge clk) begin
        if (!rst_n) f_tv <= 1'b0;
        else if (in_fire && in_data[EOG_BC_REC_NO +: 8] == f_k) begin
            f_tv     <= 1'b1;
            f_td     <= in_data;
            f_tver   <= active_ver;
            f_snap_v <= active_bank ? sh_v1 : sh_v0;
            f_snap_k <= active_bank ? sh_k1 : sh_k0;
        end
    end

    // expected output fields
    logic [2:0]  t_status;
    logic        t_vh, t_drop, t_nm;
    logic [15:0] t_reason;
    assign t_status = f_td[EOG_BC_STATUS +: EOG_BC_STATUS_W];
    assign t_vh     = is_vh(t_status);
    assign t_drop   = (t_status == EOG_ST_DROPPED);
    assign t_nm     = t_vh && (f_tver == 8'd0);
    assign t_reason = f_td[EOG_BC_REASON +: EOG_BC_REASON_W] | (t_nm ? 16'(1 << EOG_R_NO_MODEL) : 16'd0);

    logic [113:0] e_hdr, o_hdr;
    assign e_hdr = {f_td[EOG_BC_HIST_RESET], f_td[EOG_BC_SINCE_RESET +: 8], t_reason, t_status,
                    f_td[EOG_BC_TS +: 32], f_td[EOG_BC_FAC +: 5], f_td[EOG_BC_FAC_RAW +: 16],
                    f_td[EOG_BC_IN_LAST], f_td[EOG_BC_REC_NO +: 32]};
    assign o_hdr = {out_data[EOG_BL_HIST_RESET], out_data[EOG_BL_SINCE_RESET +: 8],
                    out_data[EOG_BL_REASON +: EOG_BL_REASON_W], out_data[EOG_BL_STATUS +: EOG_BL_STATUS_W],
                    out_data[EOG_BL_TS +: 32], out_data[EOG_BL_FAC +: 5], out_data[EOG_BL_FAC_RAW +: 16],
                    out_data[EOG_BL_IN_LAST], out_data[EOG_BL_REC_NO +: 32]};

    logic        o_track;
    logic [63:0] o_logits;
    assign o_track  = f_past_valid && rst_n && out_valid && f_tv && out_data[EOG_BL_REC_NO +: 8] == f_k;
    assign o_logits = out_data[EOG_BL_LOGITS +: EOG_BL_LOGITS_W];

    always_comb begin
        if (o_track) begin
            HDR: assert (o_hdr == e_hdr);
            CPY: assert (out_data[EOG_BL_CH3 +: 16] == f_td[EOG_BC_FEAT + 16 * 3 +: 16]
                         && out_data[EOG_BL_RULES +: EOG_BL_RULES_W] == f_td[EOG_BC_RULES +: EOG_BC_RULES_W]
                         && out_data[EOG_BL_CD +: EOG_BL_CD_W] == f_td[EOG_BC_CD +: EOG_BC_CD_W]);
            WV:  assert (out_data[EOG_BL_WVER +: 8] == (t_drop ? 8'd0 : f_tver));
            if (f_tver == 8'd0 || !t_vh)
                H4_zero: assert (o_logits == 64'd0);
            H4_nm: assert (out_data[EOG_BL_REASON + EOG_R_NO_MODEL] == t_nm);
        end
    end

    // ------------------------------------------------------------- logit prediction from the snapshot (H1/H5/H6)
    generate
        if (SH != 0) begin : g_pred
            logic               feat_zero;
            logic [3:0]         pr_ok, pr_bad;
            logic [63:0]        pr_want;           // expected logits, class k at [16k +: 16]
            logic signed [63:0] c_acc;
            logic signed [31:0] c_p;
            logic signed [15:0] c_w, c_f;
            logic [31:0]        c_word;
            logic               c_wk;
            logic [31:0]        meta;

            assign meta = f_snap_v[SM*32 +: 32];

            always_comb begin
                feat_zero = 1'b1;
                for (int i = 0; i < N_FEAT; i++)
                    if (f_td[EOG_BC_FEAT + 16 * i +: 16] != 16'd0) feat_zero = 1'b0;
            end

            always_comb begin
                pr_ok   = '0;
                pr_bad  = '0;
                pr_want = '0;
                c_acc   = '0;
                c_p     = '0;
                c_w     = '0;
                c_f     = '0;
                c_word  = '0;
                c_wk    = 1'b0;
                for (int k = 0; k < 4; k++) begin
                    c_word = f_snap_v[(SB + k)*32 +: 32];
                    c_acc  = {{32{c_word[31]}}, c_word};
                    c_wk  = 1'b1;
                    if (SH == 2) begin
                        for (int i = 0; i < N_FEAT; i++) begin
                            c_word = f_snap_v[(1 + k * NWPC + i / 2)*32 +: 32];
                            c_w    = (i % 2 == 1) ? c_word[31:16] : c_word[15:0];
                            c_f    = f_td[EOG_BC_FEAT + 16 * i +: 16];
                            c_p    = c_w * c_f;
                            c_acc  = c_acc + {{32{c_p[31]}}, c_p};
                            c_wk   = c_wk && f_snap_k[1 + k * NWPC + i / 2];
                        end
                    end
                    pr_want[16*k +: 16] = logit_of(c_acc, meta[4:0]);
                    pr_ok[k] = t_vh && f_snap_k[SM] && meta[15:8] != 8'd0 && f_snap_k[SB + k]
                               && (feat_zero || (SH == 2 && MUL_REAL != 0 && c_wk));
                    pr_bad[k] = pr_ok[k] && (o_logits[16*k +: 16] != pr_want[16*k +: 16]);
                end
            end

            always_comb begin
                if (o_track) begin
                    if (feat_zero)  H1H6_logit: assert (pr_bad == 4'd0);
                    if (!feat_zero) H1H5_logit: assert (pr_bad == 4'd0);
                end
            end

            always_ff @(posedge clk) if (f_past_valid && rst_n) begin
                C_sat5: cover (o_track && out_ready && pr_ok != 4'd0 && !feat_zero
                              && (o_logits[15:0] == 16'h7FFF || o_logits[15:0] == 16'h8000));
            end
        end
    endgenerate

    // ------------------------------------------------------------------------------------------------ covers
    logic [7:0] c_last_wver;
    logic       c_nout, c_coal, c_srst;
    initial begin
        c_nout = 1'b0;
        c_coal = 1'b0;
        c_srst = 1'b0;
    end
    always_ff @(posedge clk) begin
        if (!wb_rst_n)                         c_srst <= 1'b0;
        else if (!rst_n && active_ver != 8'd0) c_srst <= 1'b1;
        if (!rst_n) begin
            c_nout <= 1'b0;
            c_coal <= 1'b0;
        end else begin
            if (out_fire) begin
                c_nout      <= 1'b1;
                c_last_wver <= out_data[EOG_BL_WVER +: 8];
            end
            if (swap_req && f_pend) c_coal <= 1'b1;
            else if (f_toggle)      c_coal <= 1'b0;
        end
    end
    always_ff @(posedge clk) if (f_past_valid && rst_n) begin
        C_swap:     cover (out_fire && c_nout && out_data[EOG_BL_WVER +: 8] != c_last_wver
                           && out_data[EOG_BL_WVER +: 8] != 8'd0 && c_last_wver != 8'd0);
        C_sat:      cover (o_track && out_ready && t_vh && f_tver != 8'd0
                           && (o_logits[15:0] == 16'h7FFF || o_logits[15:0] == 16'h8000));
        C_nomodel:  cover (out_fire && out_data[EOG_BL_REASON + EOG_R_NO_MODEL]);
        C_coalesce: cover (f_toggle && c_coal);
        C_rb:       cover (p_rb_chk && active_bank == p_bank && wb_rdata != 32'd0);
        C_srst:     cover (out_fire && c_srst && out_data[EOG_BL_WVER +: 8] != 8'd0);
    end
endmodule
