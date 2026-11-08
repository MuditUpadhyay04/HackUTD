// fv_eog_regs.sv -- formal harness for eog_regs (Verify role, task T1.regs.fv).
//
// Written from spec/modules/eog_regs.md, spec/regmap.md, spec/conventions.md (spec v4) and the lead's rulings
// #59-#66 in TASKS.md, against the spec's port table only; the RTL internals are not read.
// Run with `bash scripts/formal.sh regs` (formal/regs/eog_regs.sby).
//
// Proof size: N_FAC = 2, RES_DEPTH = 2, AL_DEPTH = 2 (all DUT parameters), N_WELL = 8, CYC_PER_MS = 4.
//
// ---- How a write is observed (implementation-independent) ----
// f_awo / f_wo / f_aro count accepted, not yet answered AW / W / AR transfers. A write's address, data and strobe are
// captured as they handshake (AW and W may come in either order). "H" is the cycle in which the second of the two
// handshakes happens: from then on the write is known. Its effect (register change, fac_touch, CTRL pulses, wb_we,
// DATA push) may happen anywhere in the window [H, first BVALID cycle] and must be visible from the first BVALID
// cycle on. Outputs that mirror a register may show the old or the new value strictly inside the window.
// A read's data may be sampled anywhere in [AR handshake, first RVALID cycle]; register reads are only checked
// when no write is in progress during that span.
//
// ---- Property map (labels in the sby log) ----
//   G1  AXI4-Lite slave (the axi_mul set, generalized to separate AW/W acceptance):
//       G1_rst (no B/R the cycle after reset), G1_bhold, G1_rhold, G1_rdata (held and stable until ready),
//       G1_bresp / G1_rresp (always OKAY, regmap: ignored writes answer OKAY), G1_awo / G1_wo / G1_aro (at most one
//       outstanding per channel), G1_bnoreq / G1_rnoreq (no response without a request: B needs both AW and W),
//       G1_awlive / G1_wlive / G1_blive / G1_arlive / G1_rlive (no deadlock: a pending request or an owed response
//       is served within LIVE cycles; LIVE = N_FAC + 8 to allow the post-reset CONFIG sweep, ruling #63; cycles in
//       which the master holds the other channel's response do not count, since the slave may serialize).
//       Master side: the axi_mul assumptions (VALID held with stable payload until READY, VALIDs low in reset),
//       plus word-aligned addresses.
//   G2  G2 (direct): while FLAGS[0] of slot f_slot is 1, cfg_row changes only right after a cycle in which the
//       current write is a word-0 write to that slot with WSTRB[3] = 1 and WDATA[24] = 0.
//       G2_row: cfg_row_v word 0 / word f_word (anyconst slot and word) equal a shadow built from the regmap rules
//       (WSTRB merge, enabled-slot protection); FAC_ID bits excluded. G2_port: the f/c read ports agree with v.
//       G2_rd: AXI readback of those words (FAC_ID reads as the slot). G2_zero: the table is 0 when AXI service
//       starts after a hard reset (ruling #63).
//   G3  G3 (direct): glb unchanged in any cycle after a cycle with stream_en = 1. G3_const: glb byte 0 = 17,
//       byte 2 = 4. G3_glb / G3_rd: GLOBAL word f_gw (anyconst) equals its shadow (writes ignored while
//       stream_en = 1) on the port and on readback.
//   G4  G4_cnt: fac_touch[f_slot] pulses exactly once per accepted write to slot f_slot, none for a rejected one.
//       G4_only: no fac_touch bit pulses outside the window of a CONFIG write to that slot.
//   G5  RESULT FIFO (4 beats per record, r_last ignored) and ALERT FIFO, each with one tracked entry picked by a
//       free input (res_pick / al_pick, like an anyconst entry number) and its position in the queue:
//       G5_rord / G5_aord: reading the head words while the tracked entry is the head returns its data (order
//       preserved, nothing lost or duplicated, pop only on the pop-address read). G5_r0 / G5_a0: empty reads 0.
//       G5_rovf: a record's first beat is accepted only with room for it (no overflow); G5_rrdy: r_ready is not
//       withheld more than 2 cycles while there is room. G5_afull: al_full == (count == AL_DEPTH).
//       G5_rcnt / G5_acnt / G5_ravail / G5_aavail: STATUS counts and *_avail bits. G5_runf / G5_aunf (harness
//       counts never underflow) are implied: a pop is only modeled when the model count is > 0.
//   G6  DATA push: G6_ghost (no beat without a pushed record), G6_last (d_last exactly on the 6th beat),
//       G6_data (beat j half h = DATA word 2j+h as written before the push; anyconst word f_dw, written words
//       0-10 may change while busy, ruling #65), G6_live (beats start within 4 cycles of the push's BVALID),
//       u_d.ax_* (handshake holds), G6_ovr (STATS word 12 = pushes while busy; cleared by stats_clear),
//       G6_busy (STATUS.data_busy).
//   G7  G7_hb / G7_sw / G7_ack / G7_sr: exactly one pulse (soft_rst: one rising edge) per CTRL write with that bit
//       (and WSTRB[0]), none at any other time; G7_w1 (heartbeat/swap/ack pulses last 1 cycle), G7_srw (soft_rst
//       lasts exactly 2 cycles); G7_rd: CTRL reads back {src_dma, stream_en} only (W1P bits read 0); stats_clear is
//       checked through G6_ovr.
//   Other regmap checks: R_id (ID, VERSION with N_WELL, #66), R_ctrl / R_led / R_dsel (stream_en, src_dma, ledovr,
//       dbg_fac follow CTRL / LEDOVR (32 bits) / DBGSEL ([4:0]); reset value 0 as in the model), R_rw (LEDOVR /
//       DBGSEL readback), R_wb (weight readback through wb_raddr/wb_rdata, 1-cycle latency), R_wbw (wb_we once per
//       weight write, word address and data; partial strobes merge with wb_rdata, ruling #62), R_unm (unmapped
//       addresses read 0), R_status (STATUS bits 0-2, 31:24).
//   Covers: C_main (the spec's: CONFIG row written, slot enabled, a DATA record pushed, a RESULT read back and
//       popped), plus C_ovr, C_rfull, C_afull, C_sr, C_wb.
//
// Soft reset: the spec does not say whether eog_regs' own FIFOs and DATA-push state are cleared by soft reset
// (conventions §1 says "FIFOs"); the G5/G6 checks stop after the first soft reset until the next hard reset
// (f_srx). G1-G4 and G7 keep running.

`default_nettype none

module fv_eog_regs (
    input  logic         clk,
    input  logic         rst_n,
    input  logic [15:0]  s_axi_awaddr,
    input  logic         s_axi_awvalid,
    input  logic [31:0]  s_axi_wdata,
    input  logic [3:0]   s_axi_wstrb,
    input  logic         s_axi_wvalid,
    input  logic         s_axi_bready,
    input  logic [15:0]  s_axi_araddr,
    input  logic         s_axi_arvalid,
    input  logic         s_axi_rready,
    input  logic [4:0]   cfg_fac_f,
    input  logic [4:0]   cfg_fac_c,
    input  logic         dbg_valid,
    input  logic [495:0] dbg_feat,
    input  logic [63:0]  dbg_logits,
    input  logic [31:0]  dbg_rec_no,
    input  logic [31:0]  wb_rdata,
    input  logic         autonomous,
    input  logic         swap_pending,
    input  logic         active_bank,
    input  logic [7:0]   active_ver,
    input  logic [15:0]  ms_since_hb,
    input  logic         d_ready,
    input  logic         r_valid,
    input  logic [63:0]  r_data,
    input  logic         r_last,
    input  logic         al_valid,
    input  logic [127:0] al_data,
    input  logic         al_drop,
    input  logic         tap_valid,
    input  logic [2:0]   tap_status,
    input  logic [15:0]  tap_reason,
    input  logic         stall,
    input  logic         res_pick,      // G5: picks the tracked RESULT beat (free, like an anyconst entry number)
    input  logic         al_pick        // G5: picks the tracked ALERT
);
    `include "eog_defs.svh"
    localparam logic [7:0] SV8 = EOG_SPEC_VERSION;

    localparam integer NF   = 2;        // N_FAC
    localparam integer RD   = 2;        // RES_DEPTH (records)
    localparam integer AD   = 2;        // AL_DEPTH
    localparam integer LIVE = NF + 8;   // G1 service bound (cycles)
    localparam logic [7:0] NF8 = NF;

    // ------------------------------------------------------------------------------------------------ DUT
    logic        s_axi_awready, s_axi_wready, s_axi_bvalid, s_axi_arready, s_axi_rvalid;
    logic [1:0]  s_axi_bresp, s_axi_rresp;
    logic [31:0] s_axi_rdata;
    logic        stream_en, src_dma, soft_rst, hb_pulse, swap_req, ack_srv;
    logic [255:0] glb;
    logic [31:0] ledovr;
    logic [511:0] cfg_row_v, cfg_row_f, cfg_row_c;
    logic [NF-1:0] fac_touch;
    logic        wb_we;
    logic [6:0]  wb_addr, wb_raddr;
    logic [31:0] wb_wdata;
    logic [4:0]  dbg_fac;
    logic        d_valid, d_last;
    logic [63:0] d_data;
    logic        r_ready, al_full;

    (* anyconst *) logic [4:0] f_slot;   // G2/G4 tracked CONFIG slot
    (* anyconst *) logic [3:0] f_word;   // G2 tracked CONFIG word
    (* anyconst *) logic [2:0] f_gw;     // G3 tracked GLOBAL word
    (* anyconst *) logic [3:0] f_dw;     // G6 tracked DATA word
    (* anyconst *) logic [1:0] f_rb;     // G5 tracked beat position in a RESULT record
    (* anyconst *) logic [1:0] f_aw;     // G5 tracked ALERT word
    (* anyconst *) logic [6:0] f_wa;     // R_wb tracked weight word
    (* anyconst *) logic [31:0] f_wv;    //      and its value in the head's window
    always_comb begin
        assume (f_slot < NF);
        assume (f_dw < 12);
        assume (f_wa < 71);
    end

    eog_regs #(.N_FAC(NF), .N_WELL(8), .RES_DEPTH(RD), .AL_DEPTH(AD), .CYC_PER_MS(4)) dut (
        .clk(clk), .rst_n(rst_n),
        .s_axi_awaddr(s_axi_awaddr), .s_axi_awvalid(s_axi_awvalid), .s_axi_awready(s_axi_awready),
        .s_axi_wdata(s_axi_wdata), .s_axi_wstrb(s_axi_wstrb), .s_axi_wvalid(s_axi_wvalid), .s_axi_wready(s_axi_wready),
        .s_axi_bresp(s_axi_bresp), .s_axi_bvalid(s_axi_bvalid), .s_axi_bready(s_axi_bready),
        .s_axi_araddr(s_axi_araddr), .s_axi_arvalid(s_axi_arvalid), .s_axi_arready(s_axi_arready),
        .s_axi_rdata(s_axi_rdata), .s_axi_rresp(s_axi_rresp), .s_axi_rvalid(s_axi_rvalid), .s_axi_rready(s_axi_rready),
        .stream_en(stream_en), .src_dma(src_dma), .soft_rst(soft_rst), .hb_pulse(hb_pulse), .swap_req(swap_req),
        .ack_srv(ack_srv), .glb(glb), .ledovr(ledovr),
        .cfg_fac_v(f_slot), .cfg_fac_f(cfg_fac_f), .cfg_fac_c(cfg_fac_c),
        .cfg_row_v(cfg_row_v), .cfg_row_f(cfg_row_f), .cfg_row_c(cfg_row_c), .fac_touch(fac_touch),
        .wb_we(wb_we), .wb_addr(wb_addr), .wb_wdata(wb_wdata), .wb_raddr(wb_raddr), .wb_rdata(wb_rdata),
        .dbg_fac(dbg_fac), .dbg_valid(dbg_valid), .dbg_feat(dbg_feat), .dbg_logits(dbg_logits),
        .dbg_rec_no(dbg_rec_no),
        .autonomous(autonomous), .swap_pending(swap_pending), .active_bank(active_bank), .active_ver(active_ver),
        .ms_since_hb(ms_since_hb),
        .d_valid(d_valid), .d_ready(d_ready), .d_data(d_data), .d_last(d_last),
        .r_valid(r_valid), .r_ready(r_ready), .r_data(r_data), .r_last(r_last),
        .al_valid(al_valid), .al_data(al_data), .al_full(al_full), .al_drop(al_drop),
        .tap_valid(tap_valid), .tap_status(tap_status), .tap_reason(tap_reason), .stall(stall)
    );

    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    function automatic [31:0] mrg(input [31:0] o, input [31:0] d, input [3:0] s);
        mrg = {s[3] ? d[31:24] : o[31:24], s[2] ? d[23:16] : o[23:16],
               s[1] ? d[15:8]  : o[15:8],  s[0] ? d[7:0]   : o[7:0]};
    endfunction
    function automatic [31:0] gforce(input [2:0] wi, input [31:0] w);   // GLOBAL bytes 0 (S) and 2 (CD_LOG2)
        gforce = (wi == 3'd0) ? {w[31:24], 8'd4, w[15:8], 8'd17} : w;
    endfunction
    function automatic logic unmapped(input [15:0] a);
        unmapped = !(a <= 16'h002C || (a >= 16'h0040 && a <= 16'h004C) || a == 16'h0060 || a == 16'h0064
                  || (a >= 16'h0100 && a <= 16'h013C) || (a >= 16'h0200 && a <= 16'h022C)
                  || (a >= 16'h0300 && a <= 16'h031C) || (a >= 16'h0400 && a <= 16'h044C)
                  || (a >= 16'h1000 && a < 16'h1000 + 64 * NF) || (a >= 16'h4000 && a <= 16'h4118));
    endfunction

    // ------------------------------------------------------------------------------------------------ AXI master
    always_comb begin
        assume (s_axi_awaddr[1:0] == 2'b00);
        assume (s_axi_araddr[1:0] == 2'b00);
        if (!rst_n) assume (!s_axi_awvalid && !s_axi_wvalid && !s_axi_arvalid);
    end
    always_ff @(posedge clk) if (f_past_valid && $past(rst_n) && rst_n) begin
        if ($past(s_axi_awvalid && !s_axi_awready)) assume (s_axi_awvalid && s_axi_awaddr == $past(s_axi_awaddr));
        if ($past(s_axi_wvalid && !s_axi_wready))
            assume (s_axi_wvalid && s_axi_wdata == $past(s_axi_wdata) && s_axi_wstrb == $past(s_axi_wstrb));
        if ($past(s_axi_arvalid && !s_axi_arready)) assume (s_axi_arvalid && s_axi_araddr == $past(s_axi_araddr));
    end

    wire aw_hs = s_axi_awvalid && s_axi_awready;
    wire w_hs  = s_axi_wvalid  && s_axi_wready;
    wire b_hs  = s_axi_bvalid  && s_axi_bready;
    wire ar_hs = s_axi_arvalid && s_axi_arready;
    wire r_hs  = s_axi_rvalid  && s_axi_rready;

    logic [1:0] f_awo, f_wo, f_aro;
    always_ff @(posedge clk)
        if (!rst_n) begin
            f_awo <= 2'd0; f_wo <= 2'd0; f_aro <= 2'd0;
        end else begin
            f_awo <= f_awo + {1'b0, aw_hs} - {1'b0, b_hs};
            f_wo  <= f_wo  + {1'b0, w_hs}  - {1'b0, b_hs};
            f_aro <= f_aro + {1'b0, ar_hs} - {1'b0, r_hs};
        end

    // ---- G1 slave rules
    always_ff @(posedge clk) if (f_past_valid) begin
        if (!$past(rst_n)) G1_rst: assert (!s_axi_bvalid && !s_axi_rvalid);
        if ($past(rst_n) && rst_n) begin
            if ($past(s_axi_bvalid && !s_axi_bready)) G1_bhold: assert (s_axi_bvalid);
            if ($past(s_axi_rvalid && !s_axi_rready)) begin
                G1_rhold: assert (s_axi_rvalid);
                G1_rdata: assert (s_axi_rdata == $past(s_axi_rdata));
            end
        end
    end
    always_comb if (rst_n) begin
        if (s_axi_bvalid) G1_bresp: assert (s_axi_bresp == 2'b00);
        if (s_axi_rvalid) G1_rresp: assert (s_axi_rresp == 2'b00);
        G1_awo: assert (f_awo <= 2'd1);
        G1_wo:  assert (f_wo  <= 2'd1);
        G1_aro: assert (f_aro <= 2'd1);
        if (s_axi_bvalid) G1_bnoreq: assert (f_awo == 2'd1 && f_wo == 2'd1);
        if (s_axi_rvalid) G1_rnoreq: assert (f_aro == 2'd1);
    end

    // ---- G1 liveness (bounded)
    // A slave may serialize reads and writes, so a request is not "owed" while the master itself holds the other
    // channel's response (BVALID && !BREADY or RVALID && !RREADY).
    wire bheld = s_axi_bvalid && !s_axi_bready;
    wire rheld = s_axi_rvalid && !s_axi_rready;
    wire ob_aw = s_axi_awvalid && f_awo == 2'd0 && (s_axi_wvalid || f_wo != 2'd0) && !aw_hs && !rheld;
    wire ob_w  = s_axi_wvalid  && f_wo  == 2'd0 && (s_axi_awvalid || f_awo != 2'd0) && !w_hs && !rheld;
    wire ob_b  = f_awo != 2'd0 && f_wo != 2'd0 && !s_axi_bvalid;
    wire ob_ar = s_axi_arvalid && f_aro == 2'd0 && !ar_hs && !bheld;
    wire ob_r  = f_aro != 2'd0 && !s_axi_rvalid;
    logic [4:0] c_aw, c_w, c_b, c_ar, c_r;
    always_ff @(posedge clk)
        if (!rst_n) begin
            c_aw <= 0; c_w <= 0; c_b <= 0; c_ar <= 0; c_r <= 0;
        end else begin
            c_aw <= ob_aw ? (c_aw == 5'd31 ? c_aw : c_aw + 5'd1) : 5'd0;
            c_w  <= ob_w  ? (c_w  == 5'd31 ? c_w  : c_w  + 5'd1) : 5'd0;
            c_b  <= ob_b  ? (c_b  == 5'd31 ? c_b  : c_b  + 5'd1) : 5'd0;
            c_ar <= ob_ar ? (c_ar == 5'd31 ? c_ar : c_ar + 5'd1) : 5'd0;
            c_r  <= ob_r  ? (c_r  == 5'd31 ? c_r  : c_r  + 5'd1) : 5'd0;
        end
    always_comb if (rst_n) begin
        G1_awlive: assert (c_aw < LIVE);
        G1_wlive:  assert (c_w  < LIVE);
        G1_blive:  assert (c_b  < LIVE);
        G1_arlive: assert (c_ar < LIVE);
        G1_rlive:  assert (c_r  < LIVE);
    end

    // ------------------------------------------------------------------------------------------------ write txn
    logic        f_haw, f_hw, f_hd, f_bs;
    logic [15:0] f_wa_q;
    logic [31:0] f_wd_q;
    logic [3:0]  f_ws_q;
    wire haw_n  = (f_haw && !b_hs) || aw_hs;
    wire hw_n   = (f_hw  && !b_hs) || w_hs;
    wire hd_old = f_hd && !b_hs;
    wire H      = rst_n && haw_n && hw_n && !hd_old;     // the write becomes known
    wire cur_v  = H || hd_old;                           // a known write not yet answered
    wire [15:0] c_a = aw_hs ? s_axi_awaddr : f_wa_q;
    wire [31:0] c_d = w_hs  ? s_axi_wdata  : f_wd_q;
    wire [3:0]  c_s = w_hs  ? s_axi_wstrb  : f_ws_q;
    wire bfirst = s_axi_bvalid && !f_bs;                 // first BVALID cycle of the current write
    wire win    = (H || f_hd) && !f_bs;                  // effect window [H, first BVALID]
    wire pend   = f_hd && !f_bs && !s_axi_bvalid;        // strictly inside the window (after H)
    wire wact   = f_awo != 2'd0 || f_wo != 2'd0 || aw_hs || w_hs;   // some write in progress

    always_ff @(posedge clk)
        if (!rst_n) begin
            f_haw <= 1'b0; f_hw <= 1'b0; f_hd <= 1'b0; f_bs <= 1'b0;
        end else begin
            f_haw <= haw_n; f_hw <= hw_n; f_hd <= cur_v;
            f_bs  <= (f_bs || s_axi_bvalid) && !b_hs;
            if (aw_hs) f_wa_q <= s_axi_awaddr;
            if (w_hs) begin f_wd_q <= s_axi_wdata; f_ws_q <= s_axi_wstrb; end
        end

    // decode of the current write
    wire       c_ctrl = c_a == 16'h0008;
    wire       c_glb  = c_a >= 16'h0010 && c_a <= 16'h002C;
    wire [3:0] c_gi4  = c_a[5:2] - 4'd4;
    wire       c_cfg  = c_a >= 16'h1000 && c_a < 16'h1000 + 64 * NF;
    wire [4:0] c_slot = c_a[10:6];
    wire [3:0] c_cw   = c_a[5:2];
    wire       c_wt   = c_a >= 16'h4000 && c_a <= 16'h4118;
    wire [6:0] c_wi   = c_a[8:2];
    wire       c_dat  = c_a >= 16'h0200 && c_a <= 16'h022C;
    wire [3:0] c_di   = c_a[5:2];
    wire       c_push = c_a == 16'h022C && c_s == 4'hF;

    // ------------------------------------------------------------------------------------------------ shadows
    // CTRL / LEDOVR / DBGSEL (reset 0, as the model)
    logic       f_sen, f_src, f_sen_o, f_src_o;
    logic [31:0] f_led, f_led_o;
    logic [4:0] f_dsel, f_dsel_o;
    always_ff @(posedge clk)
        if (!rst_n) begin
            f_sen <= 0; f_src <= 0; f_led <= 0; f_dsel <= 0;
            f_sen_o <= 0; f_src_o <= 0; f_led_o <= 0; f_dsel_o <= 0;
        end else if (H) begin
            f_sen_o <= f_sen; f_src_o <= f_src; f_led_o <= f_led; f_dsel_o <= f_dsel;
            if (c_ctrl && c_s[0]) begin f_sen <= c_d[0]; f_src <= c_d[5]; end
            if (c_a == 16'h0060) f_led <= mrg(f_led, c_d, c_s);
            if (c_a == 16'h0064 && c_s[0]) f_dsel <= c_d[4:0];
        end
    always_comb if (rst_n) begin
        R_ctrl: assert (pend ? ((stream_en == f_sen || stream_en == f_sen_o) && (src_dma == f_src || src_dma == f_src_o))
                             : (stream_en == f_sen && src_dma == f_src));
        R_led:  assert (pend ? (ledovr == f_led || ledovr == f_led_o) : ledovr == f_led);
        R_dsel: assert (pend ? (dbg_fac == f_dsel || dbg_fac == f_dsel_o) : dbg_fac == f_dsel);
    end

    // GLOBAL word f_gw (no reset value in the spec: synced from the port at the first cycle after reset)
    logic        f_gk;
    logic [31:0] f_gs, f_gs_o;
    wire  [31:0] g_port = glb[32 * f_gw +: 32];
    wire  [31:0] g_base = f_gk ? f_gs : g_port;
    wire         g_hit  = H && c_glb && c_gi4[2:0] == f_gw && !f_sen;
    always_ff @(posedge clk)
        if (!rst_n) f_gk <= 1'b0;
        else begin
            f_gk <= 1'b1;
            f_gs <= g_hit ? mrg(g_base, c_d, c_s) : g_base;
            if (H) f_gs_o <= g_base;
        end
    always_comb if (rst_n) begin
        G3_const: assert (glb[7:0] == 8'd17 && glb[23:16] == 8'd4);
        if (f_gk) G3_glb: assert (pend ? (g_port == gforce(f_gw, f_gs) || g_port == gforce(f_gw, f_gs_o))
                                       : g_port == gforce(f_gw, f_gs));
    end
    always_ff @(posedge clk)
        if (f_past_valid && $past(rst_n) && rst_n && $past(stream_en)) G3: assert (glb == $past(glb));

    // CONFIG slot f_slot: word 0 and word f_word. Zero after the hard-reset sweep (#63): the shadow starts when
    // AXI service starts (first READY after reset), and G2_zero checks the table is 0 then.
    logic        f_ck;
    logic [31:0] f_c0, f_cw, f_c0_o, f_cw_o;
    wire  [31:0] row0 = cfg_row_v[31:0];
    wire  [31:0] rowW = cfg_row_v[32 * f_word +: 32];
    wire         served = s_axi_awready || s_axi_wready || s_axi_arready;
    wire         c_load = !f_ck && served;
    wire  [31:0] c0b = f_ck ? f_c0 : row0;
    wire  [31:0] cwb = f_ck ? f_cw : rowW;
    wire         c_en  = c0b[24];
    wire         c_hitf = c_cfg && c_slot == f_slot;
    wire         c_acc  = c_hitf && (!c_en || (c_cw == 4'd0 && c_s[3] && !c_d[24]));
    always_ff @(posedge clk)
        if (!rst_n) f_ck <= 1'b0;
        else if (f_ck || c_load) begin
            f_ck <= 1'b1;
            f_c0 <= (H && c_acc && c_cw == 4'd0) ? mrg(c0b, c_d, c_s) : c0b;
            f_cw <= (H && c_acc && c_cw == f_word) ? mrg(cwb, c_d, c_s) : cwb;
            if (H) begin f_c0_o <= c0b; f_cw_o <= cwb; end
        end
    wire [31:0] fid_m = (f_word == 4'd0) ? 32'hFFFF0000 : 32'hFFFFFFFF;
    always_comb if (rst_n) begin
        if (c_load) G2_zero: assert (row0[31:16] == 16'd0 && (rowW & fid_m) == 32'd0);
        if (f_ck) begin
            G2_row: assert (pend ? ((row0[31:16] == f_c0[31:16] || row0[31:16] == f_c0_o[31:16])
                                    && ((rowW & fid_m) == (f_cw & fid_m) || (rowW & fid_m) == (f_cw_o & fid_m)))
                                 : (row0[31:16] == f_c0[31:16] && (rowW & fid_m) == (f_cw & fid_m)));
        end
        if (cfg_fac_f == f_slot) G2_port: assert (cfg_row_f == cfg_row_v);
        if (cfg_fac_c == f_slot) G2_port_c: assert (cfg_row_c == cfg_row_v);
    end
    always_ff @(posedge clk)
        if (f_past_valid && $past(rst_n) && rst_n && $past(f_ck) && $past(cfg_row_v[24]) && cfg_row_v != $past(cfg_row_v))
            G2: assert ($past(cur_v && c_cfg && c_slot == f_slot && c_cw == 4'd0 && c_s[3] && !c_d[24]));

    // ------------------------------------------------------------------------------------------------ pulses (G4, G7, R_wbw)
    logic e_tc, e_hb, e_sw, e_ack, e_sr, e_wt, e_cfg, e_cw0;
    logic [4:0]  e_slot;
    logic [6:0]  e_wi;
    logic [31:0] e_wd;
    logic        e_wdk, e_full;
    logic        f_srq;
    always_ff @(posedge clk) f_srq <= rst_n && soft_rst;
    wire sr_rise = soft_rst && !f_srq;
    always_ff @(posedge clk)
        if (H) begin
            e_tc  <= c_acc;
            e_cfg <= c_cfg; e_slot <= c_slot; e_cw0 <= c_cw == 4'd0;
            e_hb  <= c_ctrl && c_s[0] && c_d[2];
            e_sw  <= c_ctrl && c_s[0] && c_d[3];
            e_ack <= c_ctrl && c_s[0] && c_d[4];
            e_sr  <= c_ctrl && c_s[0] && c_d[1];
            e_wt  <= c_wt; e_wi <= c_wi;
            e_wd  <= (c_s == 4'hF) ? c_d : mrg(f_wv, c_d, c_s);
            e_wdk <= (c_s == 4'hF) || c_wi == f_wa;
            e_full <= c_s == 4'hF;
        end
    // Allowed in this cycle: the old write's window (through its first BVALID cycle) or a write becoming known now.
    // (Both at once only if the slave accepts a new AW/W in the cycle its B handshake completes.)
    wire oldw = f_hd && !f_bs;
    wire a_hb  = (oldw && e_hb)  || (H && c_ctrl && c_s[0] && c_d[2]);
    wire a_sw  = (oldw && e_sw)  || (H && c_ctrl && c_s[0] && c_d[3]);
    wire a_ack = (oldw && e_ack) || (H && c_ctrl && c_s[0] && c_d[4]);
    wire a_sr  = (oldw && e_sr)  || (H && c_ctrl && c_s[0] && c_d[1]);
    wire a_wbo = oldw && e_wt && wb_addr == e_wi && (!e_wdk || wb_wdata == e_wd);
    wire a_wbn = H && c_wt && wb_addr == c_wi
                 && (!((c_s == 4'hF) || c_wi == f_wa) || wb_wdata == ((c_s == 4'hF) ? c_d : mrg(f_wv, c_d, c_s)));
    wire [NF-1:0] one = {{(NF-1){1'b0}}, 1'b1};
    wire [NF-1:0] tc_ok = ((oldw && e_cfg && e_slot < NF) ? (one << e_slot) : '0)
                        | ((H && c_cfg && c_slot < NF) ? (one << c_slot) : '0);

    logic [1:0] n_tc, n_hb, n_sw, n_ack, n_sr, n_wb;
    wire [NF-1:0] tc_sh = fac_touch >> f_slot;
    wire p_tc = tc_sh[0];
    function automatic [1:0] inc(input [1:0] n, input logic p);
        inc = (p && n != 2'd3) ? n + 2'd1 : n;
    endfunction
    always_ff @(posedge clk)
        if (!rst_n) begin
            n_tc <= 0; n_hb <= 0; n_sw <= 0; n_ack <= 0; n_sr <= 0; n_wb <= 0;
        end else if (H) begin
            n_tc <= {1'b0, p_tc}; n_hb <= {1'b0, hb_pulse}; n_sw <= {1'b0, swap_req}; n_ack <= {1'b0, ack_srv};
            n_sr <= {1'b0, sr_rise}; n_wb <= {1'b0, wb_we};
        end else begin
            n_tc <= inc(n_tc, p_tc); n_hb <= inc(n_hb, hb_pulse); n_sw <= inc(n_sw, swap_req);
            n_ack <= inc(n_ack, ack_srv); n_sr <= inc(n_sr, sr_rise); n_wb <= inc(n_wb, wb_we);
        end
    always_comb if (rst_n) begin
        G4_only: assert ((fac_touch & ~tc_ok) == '0);
        if (hb_pulse) G7_hb_w:  assert (a_hb);
        if (swap_req) G7_sw_w:  assert (a_sw);
        if (ack_srv)  G7_ack_w: assert (a_ack);
        if (sr_rise)  G7_sr_w:  assert (a_sr);
        if (wb_we)    R_wbw_w:  assert (a_wbo || a_wbn);
        if (bfirst) begin
            G4_cnt: assert (inc(n_tc, p_tc) == {1'b0, e_tc});
            G7_hb:  assert (inc(n_hb, hb_pulse) == {1'b0, e_hb});
            G7_sw:  assert (inc(n_sw, swap_req) == {1'b0, e_sw});
            G7_ack: assert (inc(n_ack, ack_srv) == {1'b0, e_ack});
            G7_sr:  assert (inc(n_sr, sr_rise) == {1'b0, e_sr});
            R_wbw:  assert (inc(n_wb, wb_we) == {1'b0, e_wt});
        end
    end
    always_ff @(posedge clk) if (f_past_valid && $past(rst_n) && rst_n) begin
        G7_w1: assert (!($past(hb_pulse) && hb_pulse) && !($past(swap_req) && swap_req) && !($past(ack_srv) && ack_srv));
        if ($past(sr_rise)) G7_srw: assert (soft_rst);
        if ($past(soft_rst) && $past(f_srq)) G7_srw2: assert (!soft_rst);
    end

    // weight readback model: the head returns f_wv for word f_wa one cycle after wb_raddr (eog_head.md)
    always_ff @(posedge clk) if (f_past_valid && $past(wb_raddr) == f_wa) assume (wb_rdata == f_wv);

    // ------------------------------------------------------------------------------------------------ soft-reset gate
    logic f_srx;
    wire  g_off = f_srx || soft_rst || (H && c_ctrl && c_s[0] && c_d[1]);
    always_ff @(posedge clk) if (!rst_n) f_srx <= 1'b0; else if (g_off) f_srx <= 1'b1;

    // ------------------------------------------------------------------------------------------------ read txn
    logic f_rs;
    wire  rfirst = s_axi_rvalid && !f_rs;
    always_ff @(posedge clk)
        if (!rst_n) f_rs <= 1'b0; else f_rs <= (f_rs || s_axi_rvalid) && !r_hs;

    // ---- DATA push model (G6)
    logic [2:0]  f_dleft, f_db;
    logic        f_dk, f_dck;
    logic [31:0] f_dsh, f_dcap, f_ovr;
    wire  d_hs     = d_valid && d_ready;
    wire  push     = H && c_push && !f_src;
    wire  busy     = f_dleft != 3'd0;
    wire  push_acc = push && !busy;
    wire  push_ovr = push && busy;
    wire  sclr     = H && c_ctrl && c_s[0] && (c_d[6] || c_d[1]);   // stats_clear / soft reset
    logic        e_push;
    always_ff @(posedge clk) if (H) e_push <= c_push;
    // avoid the push/last-beat race inside a push's window (which beat the DUT sees as "busy" is not observable)
    always_comb if (rst_n && win && (H ? c_push : e_push)) assume (!d_ready);
    always_ff @(posedge clk)
        if (!rst_n) begin
            f_dleft <= 0; f_db <= 0; f_dk <= 0; f_ovr <= 0;
        end else begin
            if (H && c_dat && c_s == 4'hF && c_di == f_dw) begin f_dsh <= c_d; f_dk <= 1'b1; end
            if (push_acc) begin
                f_dleft <= 3'd6; f_db <= 3'd0;
                f_dcap  <= (f_dw == 4'd11) ? c_d : f_dsh;
                f_dck   <= (f_dw == 4'd11) || f_dk;
            end else if (d_hs && busy) begin
                f_dleft <= f_dleft - 3'd1; f_db <= f_db + 3'd1;
            end
            if (sclr) f_ovr <= 32'd0;
            else if (push_ovr && f_ovr != 32'hFFFFFFFF) f_ovr <= f_ovr + 32'd1;
        end
    logic [2:0] c_dw8;
    always_ff @(posedge clk)
        if (!rst_n) c_dw8 <= 0;
        else c_dw8 <= (busy && !d_valid && !win && !g_off) ? (c_dw8 == 3'd7 ? c_dw8 : c_dw8 + 3'd1) : 3'd0;
    eog_fv_axis #(.W(65), .ASSUME(0)) u_d (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid && !g_off),
        .valid(d_valid), .ready(d_ready), .data({d_last, d_data}));
    always_comb if (rst_n && !g_off) begin
        if (d_valid) begin
            G6_ghost: assert (busy);
            G6_last:  assert (d_last == (f_db == 3'd5));
            if (f_dck && f_db == {1'b0, f_dw[3:1]}) G6_data: assert (d_data[32 * f_dw[0] +: 32] == f_dcap);
        end
        G6_live: assert (c_dw8 < 3'd5);
    end

    // ---- RESULT FIFO model (G5)
    logic [1:0] f_rbt;                 // beats of the record being received
    logic [2:0] f_rM;                  // complete records, not counting a pop in progress
    logic       f_rpop, f_rpe;         // pop read in progress (non-empty) / pop read issued while empty
    logic       f_rtk, f_rtc;          // tracking a beat / its record is complete
    logic [2:0] f_rtp;                 // complete records ahead of the tracked one
    logic [63:0] f_rtd;
    wire  rr_hs   = r_valid && r_ready;
    wire  rdone   = rr_hs && f_rbt == 2'd3;
    wire  rpopnow = f_rpop && rfirst;
    wire  [2:0] rM = f_rM - {2'd0, rpopnow};          // count the DUT must show now (pops land by RVALID)
    wire  rpend   = f_rpop && !rfirst;                // DUT may already have popped (count rM or rM - 1)
    wire  rtk_now = f_rtk && !(rpopnow && f_rtp == 3'd0);
    wire  [2:0] rtp_now = f_rtp - {2'd0, rpopnow};
    wire  ar_rpop = ar_hs && s_axi_araddr == 16'h031C;
    always_comb if (rst_n && s_axi_arvalid && s_axi_araddr == 16'h031C && rM == 3'd0 && !f_rpop) assume (!r_valid);
    always_comb if (rst_n && f_rpe) assume (!r_valid);
    always_ff @(posedge clk)
        if (!rst_n) begin
            f_rbt <= 0; f_rM <= 0; f_rpop <= 0; f_rpe <= 0; f_rtk <= 0; f_rtc <= 0;
        end else begin
            if (rr_hs) f_rbt <= f_rbt + 2'd1;
            f_rM <= rM + {2'd0, rdone};
            if (rfirst) begin f_rpop <= 1'b0; f_rpe <= 1'b0; end
            if (ar_rpop) begin f_rpop <= rM != 3'd0; f_rpe <= rM == 3'd0; end
            // tracking
            if (rtk_now) begin
                f_rtp <= rtp_now;
                if (rdone && !f_rtc) f_rtc <= 1'b1;
            end else f_rtk <= 1'b0;
            if (!rtk_now && rr_hs && f_rbt == f_rb && res_pick) begin
                f_rtk <= 1'b1; f_rtd <= r_data; f_rtc <= f_rb == 2'd3; f_rtp <= rM;
            end
        end
    logic [2:0] c_rr;
    wire  rroom = f_rbt != 2'd0 || rM < RD;
    always_ff @(posedge clk)
        if (!rst_n) c_rr <= 0; else c_rr <= (r_valid && !r_ready && rroom && !g_off) ? c_rr + {2'd0, c_rr != 3'd7} : 3'd0;
    eog_fv_axis #(.W(65), .ASSUME(1)) u_r (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid && !g_off),
        .valid(r_valid), .ready(r_ready), .data({r_last, r_data}));
    always_comb if (rst_n && !g_off) begin
        if (rr_hs && f_rbt == 2'd0) G5_rovf: assert ((rpend ? rM - 3'd1 : rM) < RD || (rpend && rM == 3'd0));
        G5_rrdy: assert (c_rr < 3'd3);
        G5_rbound: assert (rM <= RD + (rpend ? 1 : 0));
    end

    // ---- ALERT FIFO model (G5); al_valid while al_full is a drop (#60), not a push
    logic [2:0] f_aM;
    logic       f_apop, f_ape, f_atk;
    logic [2:0] f_atp;
    logic [31:0] f_atd;
    wire  a_push  = al_valid && !al_full;
    wire  apopnow = f_apop && rfirst;
    wire  [2:0] aM = f_aM - {2'd0, apopnow};
    wire  apend   = f_apop && !rfirst;
    wire  atk_now = f_atk && !(apopnow && f_atp == 3'd0);
    wire  [2:0] atp_now = f_atp - {2'd0, apopnow};
    wire  ar_apop = ar_hs && s_axi_araddr == 16'h004C;
    always_comb if (rst_n && s_axi_arvalid && s_axi_araddr == 16'h004C && aM == 3'd0 && !f_apop) assume (!al_valid);
    always_comb if (rst_n && f_ape) assume (!al_valid);
    always_ff @(posedge clk)
        if (!rst_n) begin
            f_aM <= 0; f_apop <= 0; f_ape <= 0; f_atk <= 0;
        end else begin
            f_aM <= aM + {2'd0, a_push};
            if (rfirst) begin f_apop <= 1'b0; f_ape <= 1'b0; end
            if (ar_apop) begin f_apop <= aM != 3'd0; f_ape <= aM == 3'd0; end
            if (atk_now) f_atp <= atp_now; else f_atk <= 1'b0;
            if (!atk_now && a_push && al_pick) begin
                f_atk <= 1'b1; f_atd <= al_data[32 * f_aw +: 32]; f_atp <= aM;
            end
        end
    always_comb if (rst_n && !g_off) begin
        if (apend) G5_afull_p: assert (!al_full || aM == AD || aM == AD + 1);
        else       G5_afull:   assert (al_full == (aM == AD));
        G5_abound: assert (aM <= AD + (apend ? 1 : 0));
    end

    // ---- read checks
    // static expectation at the AR handshake
    logic [3:0]  x_cls;    // 0 none, 1 ID/VERSION, 2 CTRL, 3 GLOBAL, 4 LEDOVR/DBGSEL, 5 CONFIG, 6 weight,
                           // 7 STATS 12, 8 unmapped, 9 STATUS, 10 RESULT tracked, 11 RESULT empty,
                           // 12 ALERT tracked, 13 ALERT empty
    logic [31:0] x_val;
    wire  [15:0] ra = s_axi_araddr;
    always_comb begin
        x_cls = 4'd0; x_val = 32'd0;
        if (ra == 16'h0000) begin x_cls = 4'd1; x_val = 32'h31474F45; end
        else if (ra == 16'h0004) begin x_cls = 4'd1; x_val = {8'd0, 8'd8, NF8, SV8}; end
        else if (ra == 16'h0008) begin x_cls = 4'd2; x_val = {26'd0, f_src, 4'd0, f_sen}; end
        else if (ra == 16'h000C) x_cls = 4'd9;
        else if (ra == 16'h0010 + {11'd0, f_gw, 2'b00}) begin x_cls = f_gk ? 4'd3 : 4'd0; x_val = gforce(f_gw, f_gs); end
        else if (ra == 16'h0060) begin x_cls = 4'd4; x_val = f_led; end
        else if (ra == 16'h0064) begin x_cls = 4'd4; x_val = {27'd0, f_dsel}; end
        else if (ra == 16'h1000 + {5'd0, f_slot, 6'd0}) begin
            x_cls = f_ck ? 4'd5 : 4'd0; x_val = {f_c0[31:16], 11'd0, f_slot}; end
        else if (ra == 16'h1000 + {5'd0, f_slot, f_word, 2'b00}) begin x_cls = f_ck ? 4'd5 : 4'd0; x_val = f_cw; end
        else if (ra == 16'h4000 + {7'd0, f_wa, 2'b00}) begin x_cls = 4'd6; x_val = f_wv; end
        else if (ra == 16'h0130) begin x_cls = 4'd7; x_val = f_ovr; end
        else if (ra >= 16'h0300 && ra <= 16'h031C) begin
            if (rtk_now && f_rtc && rtp_now == 3'd0 && ra[4:3] == f_rb) begin
                x_cls = 4'd10; x_val = f_rtd[32 * ra[2] +: 32]; end
            else if (rM == 3'd0) x_cls = 4'd11;
        end
        else if (ra >= 16'h0040 && ra <= 16'h004C) begin
            if (atk_now && atp_now == 3'd0 && ra[3:2] == f_aw) begin x_cls = 4'd12; x_val = f_atd; end
            else if (aM == 3'd0) x_cls = 4'd13;
        end
        else if (unmapped(ra)) x_cls = 4'd8;
    end
    logic [3:0]  f_xc;
    logic [31:0] f_xv;
    logic        f_xw;          // write activity seen during the read
    logic        f_xe;          // FIFO stayed empty during the read
    logic        f_xg;          // soft-reset gate seen during the read
    logic [2:0]  f_crmin, f_camin;
    logic        f_xst, f_xbz;  // STATUS inputs / data_busy stable during the read
    logic [11:0] f_stq;
    logic        f_bzq;
    wire  [11:0] st_in = {active_ver, autonomous, swap_pending, active_bank, 1'b0};
    always_ff @(posedge clk) begin f_stq <= st_in; f_bzq <= busy; end
    always_ff @(posedge clk)
        if (!rst_n) f_xc <= 4'd0;
        else if (ar_hs) begin
            f_xc <= x_cls; f_xv <= x_val; f_xw <= wact; f_xg <= g_off;
            f_xe <= (x_cls == 4'd11) ? (rM == 0) : (aM == 0);
            f_crmin <= rM; f_camin <= aM;
            f_xst <= st_in == f_stq;
            f_xbz <= busy == f_bzq && !wact;
        end else begin
            f_xw <= f_xw || wact; f_xg <= f_xg || g_off;
            f_xe <= f_xe && ((f_xc == 4'd11) ? (rM == 0) : (aM == 0));
            f_xst <= f_xst && st_in == f_stq;
            f_xbz <= f_xbz && busy == f_bzq && !wact;
        end
    wire rq = rst_n && rfirst;
    wire [31:0] rd = s_axi_rdata;
    always_comb if (rq) begin
        if (f_xc == 4'd1) R_id: assert (rd == f_xv);
        if (!f_xw && !wact) begin
            if (f_xc == 4'd2) G7_rd: assert (rd == f_xv);
            if (f_xc == 4'd3) G3_rd: assert (rd == f_xv);
            if (f_xc == 4'd4) R_rw:  assert (rd == f_xv);
            if (f_xc == 4'd5) G2_rd: assert (rd == f_xv);
            if (f_xc == 4'd7 && !f_xg && !g_off) G6_ovr: assert (rd == f_xv);
        end
        if (f_xc == 4'd6) R_wb:  assert (rd == f_xv);
        if (f_xc == 4'd8) R_unm: assert (rd == 32'd0);
        if (!f_xg && !g_off) begin
            if (f_xc == 4'd10) G5_rord: assert (rd == f_xv);
            if (f_xc == 4'd11 && f_xe && rM == 0) G5_r0: assert (rd == 32'd0);
            if (f_xc == 4'd12) G5_aord: assert (rd == f_xv);
            if (f_xc == 4'd13 && f_xe && aM == 0) G5_a0: assert (rd == 32'd0);
            if (f_xc == 4'd9) begin
                G5_rcnt:   assert (rd[15:8] >= {5'd0, f_crmin} && rd[15:8] <= {5'd0, rM});
                G5_acnt:   assert (rd[23:16] >= {5'd0, f_camin} && rd[23:16] <= {5'd0, aM});
                G5_ravail: assert (rd[3] == (rd[15:8] != 8'd0));
                G5_aavail: assert (rd[4] == (rd[23:16] != 8'd0));
                if (f_xbz && busy == f_bzq) G6_busy: assert (rd[5] == busy);
            end
        end
        if (f_xc == 4'd9 && f_xst && st_in == f_stq)
            R_status: assert (rd[2:0] == {active_bank, swap_pending, autonomous} && rd[31:24] == active_ver);
    end

    // ------------------------------------------------------------------------------------------------ covers
    logic cv_cfg, cv_en, cv_push, cv_ovr;
    always_ff @(posedge clk)
        if (!rst_n) begin cv_cfg <= 0; cv_en <= 0; cv_push <= 0; cv_ovr <= 0; end
        else begin
            if (bfirst && e_tc && !e_cw0 && f_ck) cv_cfg <= 1'b1;                    // a row word written
            if (cv_cfg && bfirst && e_tc && e_cw0 && f_c0[24]) cv_en <= 1'b1;        // then the slot enabled
            if (cv_en && d_hs && d_last) cv_push <= 1'b1;
            if (push_ovr) cv_ovr <= 1'b1;
        end
    always_comb if (rst_n && !g_off) begin
        C_main:  cover (cv_push && rq && f_xc == 4'd10 && f_rpop);
        C_ovr:   cover (rq && f_xc == 4'd7 && f_ovr != 0 && !f_xw);
        C_rfull: cover (rM == RD && r_valid && !r_ready);
        C_afull: cover (al_full && al_valid);
        C_aord:  cover (rq && f_xc == 4'd12 && f_apop);
    end
    always_comb if (rst_n) begin
        C_sr: cover (soft_rst && f_srq);
        C_wb: cover (wb_we && oldw && e_wt && e_wi == f_wa && !e_full);   // partial-strobe RMW
        C_wbr: cover (rq && f_xc == 4'd6);
    end

    wire _unused = &{1'b0, ms_since_hb, tap_valid, tap_status, tap_reason, stall, al_drop, dbg_valid, dbg_feat,
                     dbg_logits, dbg_rec_no, cfg_row_c};
endmodule

`default_nettype wire
