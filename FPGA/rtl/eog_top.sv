// eog_top -- the EOG engine top level (spec v4: spec/modules/eog_top.md, conventions.md, regmap.md).
//
// Block-design view (Zynq-7020, Eclypse Z7):
//   * s_axi_*  AXI4-Lite slave, 16-bit byte address, 32-bit data, on M_AXI_GP0 at base 0x43C1_0000 (64 KB).
//              axi_mul stays at 0x43C0_0000. Register map: spec/regmap.md.
//   * clk      FCLK_CLK0, 100 MHz.   rst_n  proc_sys_reset peripheral_aresetn (synchronous, active low).
//   * s_axis_* DATA records from AXI DMA MM2S (64-bit beats, 6 per 48 B record, tlast at a packet end).
//   * m_axis_* RESULT records to AXI DMA S2MM (64-bit beats, 4 per 32 B record, tlast per eog_pack batching).
//              Both AXI-Stream ports are used only when CTRL.src_dma = 1; leave them unconnected (tie
//              s_axis_tvalid = 0, m_axis_tready = 0) for the v1 AXI-Lite-only design.
//   * btn0     BTN0 (raw, active high; synchronized and debounced in eog_alarm).
//   * ld0, ld1 RGB LEDs LD0/LD1 ([0] = R, [1] = G, [2] = B as driven by eog_alarm).
//   * pmod_ja, pmod_jb  Pmod JA / JB outputs.
//
// Structure: eog_regs + the eight stages in series
//   eog_unpack -> eog_validate -> eog_features -> eog_memory -> eog_countdown -> eog_head -> eog_alarm -> eog_pack
// plus eog_head's weight/debug ports to eog_regs.
//   * Input mux : src_dma ? s_axis_* : eog_regs DATA window -> eog_unpack; the unselected source sees ready = 0,
//                 and both see ready = 0 while stream_en = 0.
//   * Output demux: src_dma ? m_axis_* : eog_regs RESULT FIFO; the unselected sink sees valid = 0.
//   * eog_regs.rec_in = eog_unpack out_valid && out_ready (ruling #59).
//   * Engine reset = rst_n & ~soft_rst. eog_regs and eog_head.wb_rst_n get the raw (hard) rst_n, so a soft reset
//     keeps CONFIG, GLOBAL and both weight banks (conventions section 1, spec v3).
//   * Changing src_dma with records in flight is not supported (the ARM changes it only with stream_en = 0 and
//     the pipeline drained).

module eog_top #(
    parameter integer N_FAC      = 32,      // facility slots (<= 32)
    parameter integer N_WELL     = 8,       // well slots per facility (<= 8)
    parameter integer II         = 16,      // stage initiation-interval budget
    parameter integer CD_LOG2    = 4,       // countdown ring depth log2 (fixed by numerics)
    parameter integer N_FEAT     = 31,      // head: features used
    parameter integer N_CLS      = 4,       // head: classes used
    parameter integer CYC_PER_MS = 100000,  // clk cycles per ms (heartbeat, debounce, LED blink, uptime)
    parameter integer DEB_MS     = 10,      // BTN0 debounce
    parameter integer RES_DEPTH  = 64,      // RESULT FIFO depth (records)
    parameter integer AL_DEPTH   = 64,      // ALERT FIFO depth (alerts)
    parameter integer BATCH      = 45       // results per m_axis packet (m_last every BATCH results)
) (
    input  logic         clk,
    input  logic         rst_n,
    // AXI4-Lite slave (eog_regs)
    input  logic [15:0]  s_axi_awaddr,
    input  logic         s_axi_awvalid,
    output logic         s_axi_awready,
    input  logic [31:0]  s_axi_wdata,
    input  logic [3:0]   s_axi_wstrb,
    input  logic         s_axi_wvalid,
    output logic         s_axi_wready,
    output logic [1:0]   s_axi_bresp,
    output logic         s_axi_bvalid,
    input  logic         s_axi_bready,
    input  logic [15:0]  s_axi_araddr,
    input  logic         s_axi_arvalid,
    output logic         s_axi_arready,
    output logic [31:0]  s_axi_rdata,
    output logic [1:0]   s_axi_rresp,
    output logic         s_axi_rvalid,
    input  logic         s_axi_rready,
    // AXI-Stream DATA in (DMA MM2S)
    input  logic [63:0]  s_axis_tdata,
    input  logic         s_axis_tvalid,
    output logic         s_axis_tready,
    input  logic         s_axis_tlast,
    // AXI-Stream RESULT out (DMA S2MM)
    output logic [63:0]  m_axis_tdata,
    output logic         m_axis_tvalid,
    input  logic         m_axis_tready,
    output logic         m_axis_tlast,
    // board I/O
    input  logic         btn0,
    output logic [2:0]   ld0,
    output logic [2:0]   ld1,
    output logic [7:0]   pmod_ja,
    output logic [7:0]   pmod_jb
);
    `include "eog_defs.svh"

    // ------------------------------------------------------------------ eog_regs <-> engine signals
    logic                     stream_en, src_dma, soft_rst, hb_pulse, swap_req, ack_srv;
    logic [EOG_G_BITS-1:0]    glb;
    logic [31:0]              ledovr;
    logic [4:0]               cfg_fac_v, cfg_fac_f, cfg_fac_c;
    logic [EOG_CFG_BITS-1:0]  cfg_row_v, cfg_row_f, cfg_row_c;
    logic [N_FAC-1:0]         fac_touch;
    logic                     wb_we;
    logic [6:0]               wb_addr, wb_raddr;
    logic [31:0]              wb_wdata, wb_rdata;
    logic [4:0]               dbg_fac;
    logic                     dbg_valid;
    logic [EOG_BC_FEAT_W-1:0] dbg_feat;
    logic [EOG_BL_LOGITS_W-1:0] dbg_logits;
    logic [31:0]              dbg_rec_no;
    logic                     autonomous, swap_pending, active_bank;
    logic [7:0]               active_ver;
    logic [15:0]              ms_since_hb;
    logic                     d_valid, d_ready, d_last;
    logic [63:0]              d_data;
    logic                     r_valid, r_ready;
    logic                     al_valid, al_full, al_drop;
    logic [EOG_AL_BITS-1:0]   al_data;
    logic                     tap_valid, stall, rec_in;
    logic [2:0]               tap_status;
    logic [15:0]              tap_reason;

    // engine reset: hard reset or the 2-cycle soft-reset pulse from eog_regs
    logic eng_rst_n;
    assign eng_rst_n = rst_n & ~soft_rst;

    // ------------------------------------------------------------------ input mux -> eog_unpack
    logic        u_s_valid, u_s_ready, u_s_last;
    logic [63:0] u_s_data;
    assign u_s_valid     = stream_en & (src_dma ? s_axis_tvalid : d_valid);
    assign u_s_data      = src_dma ? s_axis_tdata : d_data;
    assign u_s_last      = src_dma ? s_axis_tlast : d_last;
    assign s_axis_tready = stream_en &  src_dma & u_s_ready;
    assign d_ready       = stream_en & ~src_dma & u_s_ready;

    // ------------------------------------------------------------------ inter-stage links
    logic                  u_valid, u_ready;  logic [EOG_BU_W-1:0] u_data;
    logic                  v_valid, v_ready;  logic [EOG_BV_W-1:0] v_data;
    logic                  f_valid, f_ready;  logic [EOG_BF_W-1:0] f_data;
    logic                  m_valid, m_ready;  logic [EOG_BM_W-1:0] m_data;
    logic                  c_valid, c_ready;  logic [EOG_BC_W-1:0] c_data;
    logic                  l_valid, l_ready;  logic [EOG_BL_W-1:0] l_data;
    logic                  a_valid, a_ready;  logic [EOG_BA_W-1:0] a_data;
    logic                  p_valid, p_ready, p_last;
    logic [63:0]           p_data;

    assign rec_in = u_valid & u_ready;    // ruling #59: STATS 0 counts records from either source

    // ------------------------------------------------------------------ output demux <- eog_pack
    assign r_valid       = ~src_dma & p_valid;
    assign m_axis_tvalid =  src_dma & p_valid;
    assign m_axis_tdata  = p_data;
    assign m_axis_tlast  = p_last;
    assign p_ready       = src_dma ? m_axis_tready : r_ready;

`ifdef FORMAL
    // formal observation ports of the stages (conventions section 7), read by a top-level harness (bind)
    /* verilator lint_off UNUSEDSIGNAL */
    logic [7:0]  f_inflight_v, f_inflight_f, f_inflight_m, f_inflight_c, f_inflight_l, f_inflight_a, f_inflight_p;
    logic [31:0] f_oldest_v,   f_oldest_f,   f_oldest_m,   f_oldest_c,   f_oldest_l,   f_oldest_a,   f_oldest_p;
    /* verilator lint_on UNUSEDSIGNAL */
`endif

    // ------------------------------------------------------------------ eog_regs (hard reset only)
    eog_regs #(
        .N_FAC(N_FAC), .N_WELL(N_WELL), .RES_DEPTH(RES_DEPTH), .AL_DEPTH(AL_DEPTH), .CYC_PER_MS(CYC_PER_MS)
    ) u_regs (
        .clk(clk), .rst_n(rst_n),
        .s_axi_awaddr(s_axi_awaddr), .s_axi_awvalid(s_axi_awvalid), .s_axi_awready(s_axi_awready),
        .s_axi_wdata(s_axi_wdata), .s_axi_wstrb(s_axi_wstrb), .s_axi_wvalid(s_axi_wvalid),
        .s_axi_wready(s_axi_wready),
        .s_axi_bresp(s_axi_bresp), .s_axi_bvalid(s_axi_bvalid), .s_axi_bready(s_axi_bready),
        .s_axi_araddr(s_axi_araddr), .s_axi_arvalid(s_axi_arvalid), .s_axi_arready(s_axi_arready),
        .s_axi_rdata(s_axi_rdata), .s_axi_rresp(s_axi_rresp), .s_axi_rvalid(s_axi_rvalid),
        .s_axi_rready(s_axi_rready),
        .stream_en(stream_en), .src_dma(src_dma), .soft_rst(soft_rst), .hb_pulse(hb_pulse),
        .swap_req(swap_req), .ack_srv(ack_srv), .glb(glb), .ledovr(ledovr),
        .cfg_fac_v(cfg_fac_v), .cfg_fac_f(cfg_fac_f), .cfg_fac_c(cfg_fac_c),
        .cfg_row_v(cfg_row_v), .cfg_row_f(cfg_row_f), .cfg_row_c(cfg_row_c), .fac_touch(fac_touch),
        .wb_we(wb_we), .wb_addr(wb_addr), .wb_wdata(wb_wdata), .wb_raddr(wb_raddr), .wb_rdata(wb_rdata),
        .dbg_fac(dbg_fac), .dbg_valid(dbg_valid), .dbg_feat(dbg_feat), .dbg_logits(dbg_logits),
        .dbg_rec_no(dbg_rec_no),
        .autonomous(autonomous), .swap_pending(swap_pending), .active_bank(active_bank),
        .active_ver(active_ver), .ms_since_hb(ms_since_hb),
        .d_valid(d_valid), .d_ready(d_ready), .d_data(d_data), .d_last(d_last),
        .r_valid(r_valid), .r_ready(r_ready), .r_data(p_data), .r_last(p_last),
        .al_valid(al_valid), .al_data(al_data), .al_full(al_full), .al_drop(al_drop),
        .tap_valid(tap_valid), .tap_status(tap_status), .tap_reason(tap_reason), .stall(stall),
        .rec_in(rec_in)
    );

    // ------------------------------------------------------------------ pipeline
    eog_unpack #(.N_FAC(N_FAC), .N_WELL(N_WELL), .II(II)) u_unpack (
        .clk(clk), .rst_n(eng_rst_n),
        .s_valid(u_s_valid), .s_ready(u_s_ready), .s_data(u_s_data), .s_last(u_s_last),
        .out_valid(u_valid), .out_ready(u_ready), .out_data(u_data)
    );

    eog_validate #(.N_FAC(N_FAC), .N_WELL(N_WELL), .II(II)) u_validate (
        .clk(clk), .rst_n(eng_rst_n),
        .in_valid(u_valid), .in_ready(u_ready), .in_data(u_data),
        .out_valid(v_valid), .out_ready(v_ready), .out_data(v_data),
        .cfg_fac(cfg_fac_v), .cfg_row(cfg_row_v), .glb(glb), .fac_touch(fac_touch)
`ifdef FORMAL
        , .f_inflight(f_inflight_v), .f_oldest_recno(f_oldest_v)
`endif
    );

    eog_features #(.N_FAC(N_FAC), .N_WELL(N_WELL), .II(II)) u_features (
        .clk(clk), .rst_n(eng_rst_n),
        .in_valid(v_valid), .in_ready(v_ready), .in_data(v_data),
        .out_valid(f_valid), .out_ready(f_ready), .out_data(f_data),
        .cfg_fac(cfg_fac_f), .cfg_row(cfg_row_f)
`ifdef FORMAL
        , .f_inflight(f_inflight_f), .f_oldest_recno(f_oldest_f)
`endif
    );

    eog_memory #(.N_FAC(N_FAC), .II(II)) u_memory (
        .clk(clk), .rst_n(eng_rst_n),
        .in_valid(f_valid), .in_ready(f_ready), .in_data(f_data),
        .out_valid(m_valid), .out_ready(m_ready), .out_data(m_data)
`ifdef FORMAL
        , .f_inflight(f_inflight_m), .f_oldest_recno(f_oldest_m)
`endif
    );

    eog_countdown #(.N_FAC(N_FAC), .II(II), .CD_LOG2(CD_LOG2)) u_countdown (
        .clk(clk), .rst_n(eng_rst_n),
        .in_valid(m_valid), .in_ready(m_ready), .in_data(m_data),
        .out_valid(c_valid), .out_ready(c_ready), .out_data(c_data),
        .cfg_fac(cfg_fac_c), .cfg_row(cfg_row_c)
`ifdef FORMAL
        , .f_inflight(f_inflight_c), .f_oldest_recno(f_oldest_c)
`endif
    );

    eog_head #(.N_FAC(N_FAC), .N_WELL(N_WELL), .II(II), .N_FEAT(N_FEAT), .N_CLS(N_CLS)) u_head (
        .clk(clk), .rst_n(eng_rst_n), .wb_rst_n(rst_n),
        .in_valid(c_valid), .in_ready(c_ready), .in_data(c_data),
        .out_valid(l_valid), .out_ready(l_ready), .out_data(l_data),
        .wb_we(wb_we), .wb_addr(wb_addr), .wb_wdata(wb_wdata), .wb_raddr(wb_raddr), .wb_rdata(wb_rdata),
        .swap_req(swap_req), .swap_pending(swap_pending), .active_bank(active_bank), .active_ver(active_ver),
        .dbg_fac(dbg_fac), .dbg_valid(dbg_valid), .dbg_feat(dbg_feat), .dbg_logits(dbg_logits),
        .dbg_rec_no(dbg_rec_no)
`ifdef FORMAL
        , .f_inflight(f_inflight_l), .f_oldest_recno(f_oldest_l)
`endif
    );

    eog_alarm #(.N_FAC(N_FAC), .II(II), .CYC_PER_MS(CYC_PER_MS), .DEB_MS(DEB_MS)) u_alarm (
        .clk(clk), .rst_n(eng_rst_n),
        .in_valid(l_valid), .in_ready(l_ready), .in_data(l_data),
        .out_valid(a_valid), .out_ready(a_ready), .out_data(a_data),
        .glb(glb), .hb_pulse(hb_pulse), .ack_srv(ack_srv), .btn0(btn0),
        .al_valid(al_valid), .al_data(al_data), .al_full(al_full), .al_drop(al_drop),
        .autonomous(autonomous), .ms_since_hb(ms_since_hb), .ledovr(ledovr),
        .ld0(ld0), .ld1(ld1), .pmod_ja(pmod_ja), .pmod_jb(pmod_jb)
`ifdef FORMAL
        , .f_inflight(f_inflight_a), .f_oldest_recno(f_oldest_a)
`endif
    );

    eog_pack #(.N_FAC(N_FAC), .N_WELL(N_WELL), .II(II), .BATCH(BATCH)) u_pack (
        .clk(clk), .rst_n(eng_rst_n),
        .in_valid(a_valid), .in_ready(a_ready), .in_data(a_data),
        .m_valid(p_valid), .m_ready(p_ready), .m_data(p_data), .m_last(p_last),
        .tap_valid(tap_valid), .tap_status(tap_status), .tap_reason(tap_reason), .stall(stall)
`ifdef FORMAL
        , .f_inflight(f_inflight_p), .f_oldest_recno(f_oldest_p)
`endif
    );

endmodule
