// fv_eog_alarm.sv — formal harness for eog_alarm (Verify role, task T1.alarm.fv).
//
// Written from spec/modules/eog_alarm.md, spec/numerics.md §1 (D7, D8, D10) and §9, spec/conventions.md (spec v4)
// and the lead's answers in TASKS.md "Spec questions" #1, #3-#11 (re-checked against v4), using the module's port
// table only; the RTL internals are not read. Run with `bash scripts/formal.sh alarm` (formal/alarm/eog_alarm.sby; task split and depths are there).
//
// Port-level only (no hierarchical references). The stage contract uses the v2 observation ports f_inflight /
// f_oldest_recno (conventions §7) through formal/common/eog_fv_stage.
//
// Sections, selected by a define per sby task:
//   (always)     stage contract, ALERT handshake, A3/A4 at the output, A6 heartbeat, A7 Pmod/LED relations that
//                hold between output ports (no hidden state needed). These are the k-induction (`prove`) set.
//   FV_MODEL     a reference model of numerics §9 for N_FAC slots (counters, latches, conditions), updated
//                atomically when a record is accepted (or an ack is requested), predicts: bus A for every record
//                (CLASSES, copied fields), the exact ALERT sequence (per open record the ALERT flags still owed, per
//                ack the latch bits it cleared; every al_valid/al_drop takes the oldest one), and the latch state
//                shown on the Pmods once the stage is quiet. bmc from reset: the model's state is not tied to the
//                DUT's (port-only), so it is not inductive.
//                Environment for determinism: acknowledges come from ack_srv only (btn0 = 0) and only while the
//                stage is quiet (no record in flight, no expected ALERT outstanding, no in_valid), and in_valid
//                stays 0 until the ack's ACKED sweep is complete (+ ACK_G cycles). Why: the spec does not fix the
//                order between an ack and a record that is in flight, and the order changes the outcome.
//   FV_TIE       (with FV_MODEL) copied-only fields of bus L are functions of the REC_NO byte; FV_HITS: LOGIT[k] in
//                {THR[k], THR[k] + 1}, CH3 in {GAP_THR, GAP_THR + 1}. Solver load only (see the assumptions).
//   FV_NO_A5 / FV_ONLY_A5  split the model checks over two bmc tasks (the ALERT-sequence checks are the costly ones).
//   FV_KMAX      bound PERSIST_K and PERSIST_K4[k] (solver load).
//   FV_A8        debounce: every btn0 high level is shorter than A8_L cycles, ack_srv = 0 -> never an ACKED ALERT
//                and never a latch bit falling on the Pmods.
//
// Property IDs (spec "Required properties"): labels start with the ID.
//   stage  u_in.ax_*, u_out.ax_* (handshake), u_stage.st_* (one in / one out / in order / f_inflight link /
//          II <= II_MAX except while `excl` / latency <= LAT_MAX), AL_hs* (ALERT push/drop handshake)
//   A1     A1_es_kind (an ES_RAISED push matches an expected ES_RAISED: the model raises it only on a VALID/HELD
//          record of f whose leak counter reached K[0]), A1_rise (|es_latch on the Pmod rises only when the model's
//          es_latch is set), A7_m_* (exact latch state when quiet)
//   A2     A2_fall (a latch bit on the Pmods falls only inside an acknowledge window), the expected ACKED are
//          latch & ~cond at the ack (A5_seq), A7_m_* (exact latch state when quiet)
//   A3     A3_cls (CLASSES = class_active of the model's counters), A3_hit (a set CLASSES bit implies this
//          record's LOGIT[k] > THR[k], strict), A3_inv (INVALID / non-updating records: CLASSES = 0)
//   A4     A4_drop (DROPPED: CLASSES = 0); DROPPED records do not touch the model and INVALID records only clear
//          its counters, so the ALERT / latch checks also fail if the DUT changes conditions, latches or raises an
//          ALERT on one
//   A5     A5_seq / A5_auto (each push equals the next expected ALERT; SOURCE bit 2 = autonomous at some cycle
//          while that record or ack was being processed), A5_ghost (no push/drop without an expected ALERT),
//          A5_live (expected ALERTs are pushed or dropped within AL_LAT cycles), A5_open (at most two records
//          accepted and not finished: output and ALERTs)
//   A6     A6_auto, A6_rst, A6_hb, A6_step, A6_period, A6_late
//   A7     A7_ovr, A7_ja*, A7_jb*, A7_ld0*, A7_ld1, A7_hbt (+ A7_m_* against the model when quiet)
//   A8     A8_ack, A8_fall
//   A9     per-class K (K[k] = PERSIST_K4[k] if nonzero, else max(PERSIST_K, 1)): the model uses it for A3_cls,
//          A1 and A5; GLOBAL is free, so a DUT using one K for all classes fails A3_cls / A5_seq
//   BA     BA_copy (bus A header, RULES, CD, LOGITS, WVER copied)
//
// Timing tolerance (the spec gives no cycle-exact timing for these outputs): the Pmod/LED outputs may show the
// state of the current or the previous cycle (combinational or one output register); hb_toggle may flip one or
// two cycles after hb_pulse. ms_since_hb, autonomous and the ALERT/bus-A handshakes are checked cycle-exact.

`default_nettype none

module fv_eog_alarm #(
    parameter integer N_FAC   = 2,
    parameter integer CYC     = 2,    // CYC_PER_MS
    parameter integer DEB     = 2,    // DEB_MS
    parameter integer II_MAX  = 16,   // conventions §3
    parameter integer LAT_MAX = 12,   // documented latency 1 (+ ALERTs + one ack sweep) with margin; spec bound 128
    parameter integer AL_LAT  = 12    // an expected ALERT is pushed/dropped within this many cycles (out_ready = 1)
) (
    input  logic         clk,
    input  logic         rst_n,
    input  logic         in_valid,
    input  logic [254:0] in_data,
    input  logic         out_ready,
    input  logic         hb_pulse,
    input  logic         ack_srv,
    input  logic         btn0,
    input  logic         al_full,
    input  logic [31:0]  ledovr
);
`include "eog_defs.svh"

    // GLOBAL CONFIG: constant (conventions §5). FV_KMIN / FV_KMAX bound PERSIST_K per task (see the .sby).
    (* anyconst *) logic [255:0] glb;
`ifdef FV_KMAX
    always_comb FV_kmax: assume (glb[EOG_G_PERSIST_K +: 8] <= `FV_KMAX && glb[EOG_G_PERSIST_K4 +: 8] <= `FV_KMAX
                                 && glb[EOG_G_PERSIST_K4 + 8 +: 8] <= `FV_KMAX && glb[EOG_G_PERSIST_K4 + 16 +: 8] <= `FV_KMAX
                                 && glb[EOG_G_PERSIST_K4 + 24 +: 8] <= `FV_KMAX);
`endif

    // ---------------------------------------------------------------------------------------------------------
    // DUT
    logic         in_ready, out_valid, al_valid, al_drop, autonomous;
    logic [242:0] out_data;
    logic [127:0] al_data;
    logic [15:0]  ms_since_hb;
    logic [2:0]   ld0, ld1;
    logic [7:0]   pmod_ja, pmod_jb;
    logic [7:0]   dut_inflight;
    logic [31:0]  dut_oldest;

    eog_alarm #(.N_FAC(N_FAC), .CYC_PER_MS(CYC), .DEB_MS(DEB)) dut (
        .clk(clk), .rst_n(rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data),
        .glb(glb), .hb_pulse(hb_pulse), .ack_srv(ack_srv), .btn0(btn0),
        .al_valid(al_valid), .al_data(al_data), .al_full(al_full), .al_drop(al_drop),
        .autonomous(autonomous), .ms_since_hb(ms_since_hb), .ledovr(ledovr),
        .ld0(ld0), .ld1(ld1), .pmod_ja(pmod_ja), .pmod_jb(pmod_jb),
        .f_inflight(dut_inflight), .f_oldest_recno(dut_oldest));

    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    eog_fv_axis #(.W(255), .ASSUME(1)) u_in (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(in_valid), .ready(in_ready), .data(in_data));
    eog_fv_axis #(.W(243), .ASSUME(0)) u_out (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(out_valid), .ready(out_ready), .data(out_data));

    logic in_fire, out_fire;
    assign in_fire  = in_valid && in_ready;
    assign out_fire = out_valid && out_ready;

    // ---------------------------------------------------------------------------------------------------------
    // History of inputs/outputs (explicit registers; guarded by f_past_valid / p_rst where used)
    logic        p_rst, pp_rst, p_hb, pp_hb, p_auto, p_ack, pp_ack;
    logic [15:0] p_ms;
    logic [7:0]  p_ja, p_jb;
    logic [31:0] p_ovr_v;
    logic        pp_ovr;
    always_ff @(posedge clk) begin
        p_rst   <= rst_n;     pp_rst <= p_rst;
        p_hb    <= hb_pulse;  pp_hb  <= p_hb;
        p_auto  <= autonomous;
        p_ack   <= ack_srv;   pp_ack <= p_ack;
        p_ms    <= ms_since_hb;
        p_ja    <= pmod_ja;   p_jb   <= pmod_jb;
        p_ovr_v <= ledovr;    pp_ovr <= p_ovr_v[31];
    end

    // ---------------------------------------------------------------------------------------------------------
    // Stage contract. excl (II and latency checks off, conventions §3 "except during an acknowledge sweep"):
    // while an acknowledge can be in progress. A sweep is invisible at the ports when it clears nothing, and a
    // BTN0 press is acted on inside the DUT, so the window is: ack_srv or btn0 high, and the ACK_W cycles after
    // either (apply cycle + sweep of <= 2*N_FAC cycles + synchronizer/edge latency), plus every cycle with an
    // ACKED push or drop.
    localparam integer ACK_W = 2 * N_FAC + 6;
    logic al_is_acked;
    assign al_is_acked = (al_valid || al_drop) && (al_data[EOG_AL_KIND +: 8] == EOG_AK_ACKED);
    logic [7:0] ack_win;
    always_ff @(posedge clk) ack_win <= (ack_srv || btn0) ? 8'(ACK_W) : (ack_win != 8'd0) ? ack_win - 8'd1 : 8'd0;
    logic excl;
    assign excl = ack_srv || btn0 || (f_past_valid && ack_win != 8'd0) || al_is_acked;

    logic [7:0] f_in_cnt, f_out_cnt, f_in_flight;
    eog_fv_stage #(.RW(8), .MAX_INFLIGHT(2), .II_MAX(II_MAX), .LAT_MAX(LAT_MAX), .SWEEP(N_FAC + 8)) u_stage (
        .clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .in_valid(in_valid), .in_ready(in_ready), .in_recno(in_data[EOG_BL_REC_NO +: 8]),
        .out_valid(out_valid), .out_ready(out_ready), .out_recno(out_data[EOG_BA_REC_NO +: 8]),
        .excl(excl), .dut_inflight(dut_inflight), .dut_oldest(dut_oldest),
        .f_in_cnt(f_in_cnt), .f_out_cnt(f_out_cnt), .f_in_flight(f_in_flight));

    // ---------------------------------------------------------------------------------------------------------
    // GLOBAL fields
    logic [7:0]  g_k;       // max(PERSIST_K, 1)
    logic [31:0] g_k4;      // K[k] = PERSIST_K4[k] != 0 ? PERSIST_K4[k] : max(PERSIST_K, 1)   (A9, D10)
    logic [15:0] g_hbt;
    logic signed [15:0] g_gap;
    assign g_k   = (glb[EOG_G_PERSIST_K +: 8] == 8'd0) ? 8'd1 : glb[EOG_G_PERSIST_K +: 8];
    genvar gq;
    generate for (gq = 0; gq < 4; gq = gq + 1) begin : g_kk
        assign g_k4[8*gq +: 8] = (glb[EOG_G_PERSIST_K4 + 8*gq +: 8] != 8'd0) ? glb[EOG_G_PERSIST_K4 + 8*gq +: 8] : g_k;
    end endgenerate
    assign g_hbt = glb[EOG_G_HB_TIMEOUT_MS +: 16];
    assign g_gap = glb[EOG_G_GAP_THR +: 16];                                                   // signed (TASKS #7)

    // ---------------------------------------------------------------------------------------------------------
    // ALERT push/drop handshake (TASKS #5): exclusive, a push never into a full FIFO, a drop only when full,
    // nothing in the cycle after a reset cycle.
    always_comb if (f_past_valid && rst_n) begin
        AL_hs_excl:  assert (!(al_valid && al_drop));
        AL_hs_full:  assert (!(al_valid && al_full));
        AL_hs_drop:  assert (!al_drop || al_full);
    end
    always_ff @(posedge clk) if (f_past_valid && !p_rst) AL_hs_rst: assert (!al_valid && !al_drop);

    // ---------------------------------------------------------------------------------------------------------
    // A3 / A4 at the output (no model needed): CLASSES is 0 for any record that does not update a slot
    // (INVALID clears the counters, DROPPED / codes 2, 5-7 / FAC >= N_FAC change nothing: TASKS #1, #10), and a
    // set CLASSES bit needs this record's own hit, LOGIT[k] > THR[k] (cnt[k] = 0 on a miss).
    logic [2:0] o_st;
    logic [4:0] o_fac;
    logic [3:0] o_cls, o_hit;
    logic       o_vh;
    assign o_st  = out_data[EOG_BA_STATUS +: 3];
    assign o_fac = out_data[EOG_BA_FAC +: 5];
    assign o_cls = out_data[EOG_BA_CLASSES +: 4];
    assign o_vh  = (o_st == EOG_ST_VALID || o_st == EOG_ST_HELD) && (o_fac < N_FAC);
    genvar gk;
    generate for (gk = 0; gk < 4; gk = gk + 1) begin : g_ohit
        assign o_hit[gk] = $signed(out_data[EOG_BA_LOGITS + 16*gk +: 16]) > $signed(glb[EOG_G_LOGIT_THR + 16*gk +: 16]);
    end endgenerate
    always_comb if (f_past_valid && rst_n && out_valid) begin
        A4_drop: assert (o_st != EOG_ST_DROPPED || o_cls == 4'd0);
        A3_inv:  assert (o_vh || o_cls == 4'd0);
        A3_hit:  assert ((o_cls & ~o_hit) == 4'd0);
    end

    // ---------------------------------------------------------------------------------------------------------
    // A6 heartbeat
    //   A6_auto   autonomous == (HB_TIMEOUT_MS != 0 && ms_since_hb >= HB_TIMEOUT_MS), same cycle
    //   A6_rst    65535 in the cycle after a reset cycle
    //   A6_hb     0 in the cycle after an hb_pulse
    //   A6_step   otherwise unchanged or +1 (never past 65535)
    //   A6_period two increments with no hb/reset in between are exactly CYC cycles apart
    //   A6_late   while not saturated, the next increment comes at most CYC cycles after the previous one or after
    //             the clear (a prescaler that restarts on hb_pulse and a free-running ms tick both pass)
    always_comb if (f_past_valid)
        A6_auto: assert (autonomous == ((g_hbt != 16'd0) && (ms_since_hb >= g_hbt)));

    logic ms_inc, ms_clr;
    assign ms_clr = f_past_valid && (!p_rst || p_hb);
    assign ms_inc = f_past_valid && !ms_clr && (p_ms != 16'hFFFF) && (ms_since_hb == p_ms + 16'd1);
    logic [3:0] ms_gap;     // cycles since the last increment / clear (saturating)
    logic       ms_sync;    // the last event was an increment
    always_ff @(posedge clk) begin
        if (ms_inc)                 begin ms_gap <= 4'd1; ms_sync <= 1'b1; end
        else if (ms_clr)            begin ms_gap <= 4'd1; ms_sync <= 1'b0; end
        else if (ms_gap != 4'hF)          ms_gap <= ms_gap + 4'd1;
    end
    always_comb if (f_past_valid) begin
        if (!p_rst) A6_rst: assert (ms_since_hb == 16'hFFFF);
        else if (p_hb) A6_hb: assert (ms_since_hb == 16'd0);
        else begin
            A6_step: assert (ms_since_hb == p_ms || (p_ms != 16'hFFFF && ms_since_hb == p_ms + 16'd1));
            if (ms_inc && ms_sync) A6_period: assert (ms_gap == CYC[3:0]);
            if (!ms_inc && ms_since_hb != 16'hFFFF) A6_late: assert (ms_gap < CYC[3:0]);
        end
    end

    // ---------------------------------------------------------------------------------------------------------
    // A7 Pmod / LED mapping between output ports (spec table + TASKS #9: 25 % PWM, `ledovr` raw without PWM).
    // Allowed: an output may show the current or the previous cycle's value of what it mirrors.
    logic ovr_on2, ovr_off2, ovr_off3;
    assign ovr_on2  = f_past_valid && p_rst && ledovr[31] && (ledovr == p_ovr_v);
    assign ovr_off2 = f_past_valid && p_rst && pp_rst && !ledovr[31] && !p_ovr_v[31];
    assign ovr_off3 = ovr_off2 && !pp_ovr;

    function automatic logic [2:0] ld1_mask(input logic [1:0] ja);   // ja = {|ns_latch, |es_latch}
        ld1_mask = ja[0] ? 3'b100 : ja[1] ? 3'b110 : 3'b000;
    endfunction

    logic ld1_ok, ld0_ok;
    assign ld1_ok = (ld1 == 3'b000) || (ld1 == ld1_mask(pmod_ja[1:0])) || (ld1 == ld1_mask(p_ja[1:0]));
    assign ld0_ok = (ld0 == 3'b000) || (ld0 == 3'b100) || (ld0 == 3'b001 && (autonomous || p_auto))
                 || (ld0 == 3'b010 && (!autonomous || !p_auto));

    always_comb begin
        if (ovr_on2) begin
            A7_ovr: assert ({pmod_jb, pmod_ja, ld1, ld0} == {ledovr[23:16], ledovr[15:8], ledovr[5:3], ledovr[2:0]});
        end
        if (ovr_off2) begin
            A7_ja_zero:  assert (pmod_ja[7:4] == 4'd0);
            A7_jb_zero:  assert (pmod_jb[7:6] == 2'd0);
            A7_ja_auto:  assert (pmod_ja[2] == autonomous || pmod_ja[2] == p_auto);
            A7_jb_any:   assert (pmod_jb[5] == (pmod_ja[0] || pmod_ja[1]));
            A7_jb_worst: assert ((pmod_jb[5] || pmod_jb[4:0] == 5'd0) && pmod_jb[4:0] < N_FAC);
            A7_ld1:      assert (ld1_ok);
            A7_ld0:      assert (ld0_ok);
        end
        if (ovr_off3)
            A7_hbt: assert ((pmod_ja[3] != p_ja[3]) == p_hb || (pmod_ja[3] != p_ja[3]) == pp_hb);
    end

`ifndef FV_PROVE
    // ---------------------------------------------------------------------------------------------------------
    // ALERT format (bmc only: an RTL holding a not-yet-pushed ALERT in a register is not constrained by these
    // ports in an arbitrary induction start state). Field rules from numerics §9 + TASKS #3, #4, #6.
    logic [7:0] a_kind, a_src, a_rules, a_cls;
    logic [15:0] a_fac;
    assign a_fac   = al_data[EOG_AL_FAC_ID +: 16];
    assign a_kind  = al_data[EOG_AL_KIND +: 8];
    assign a_src   = al_data[EOG_AL_SOURCE +: 8];
    assign a_rules = al_data[EOG_AL_RULES +: 8];
    assign a_cls   = al_data[EOG_AL_CLASSES +: 8];
    always_comb if (f_past_valid && rst_n && al_valid) begin
        AL_fmt_kind: assert (a_kind >= EOG_AK_NS_RAISED && a_kind <= EOG_AK_ACKED);
        AL_fmt_fac:  assert (a_fac < N_FAC);
        AL_fmt_rsv:  assert (a_src[7:5] == 3'd0 && a_src[3] == 1'b0 && a_rules[7:5] == 3'd0 && a_cls[7:4] == 4'd0);
        // record ALERTs: SOURCE bit 0 = RULES[3:0] != 0, bit 1 = class_active != 0 (numerics §9, features_int.py)
        if (a_kind != EOG_AK_ACKED)
            AL_fmt_src: assert (a_src[0] == (a_rules[3:0] != 4'd0) && a_src[1] == (a_cls != 8'd0));
        if (a_kind == EOG_AK_NS_RAISED)
            AL_fmt_nsr: assert (a_src[4] == 1'b0 && a_src[1:0] != 2'd0);
        if (a_kind == EOG_AK_ES_RAISED)
            AL_fmt_esr: assert (a_src[4] && a_cls[0]);
        if (a_kind == EOG_AK_ACKED)    // SOURCE bit 2: 0 (TASKS #4) or autonomous (v4 SOURCE table): spec question
            AL_fmt_ack: assert ((a_src & 8'hEB) == 8'd0 && al_data[EOG_AL_TS +: 32] == 32'd0
                                && al_data[EOG_AL_RESULT_NO +: 32] == 32'd0 && a_rules == 8'd0 && a_cls == 8'd0
                                && al_data[EOG_AL_CD_P10 +: 16] == 16'hFFFF);
    end
`endif

`ifdef FV_MODEL
    // =========================================================================================================
    // Reference model (numerics §9), N_FAC slots, updated at in_fire / at the ack request.
    localparam integer ACK_G = 3;       // an ack request must take effect within ACK_G cycles (spec: "in one cycle")

    logic [N_FAC*32-1:0] m_cnt;         // cnt[f][k], 4 x u8 per slot
    logic [N_FAC*8-1:0]  m_leak;
    logic [N_FAC-1:0]    m_nsl, m_esl, m_nsc, m_esc;

    // record fields
    logic [31:0] i_recno, i_ts;
    logic [4:0]  i_fac, i_rul;
    logic [2:0]  i_st;
    logic        i_hr;
    logic [15:0] i_p10;
    logic signed [15:0] i_ch3;
    assign i_recno = in_data[EOG_BL_REC_NO +: 32];
    assign i_ts    = in_data[EOG_BL_TS +: 32];
    assign i_fac   = in_data[EOG_BL_FAC +: 5];
    assign i_rul   = in_data[EOG_BL_RULES +: 5];
    assign i_st    = in_data[EOG_BL_STATUS +: 3];
    assign i_p10   = in_data[EOG_BL_CD +: 16];
    assign i_ch3   = in_data[EOG_BL_CH3 +: 16];
    assign i_hr    = in_data[EOG_BL_HIST_RESET];

    logic        m_vh, m_upd, m_gap, m_lh, m_nsc_new, m_esc_new, m_onl, m_oel, m_onc, m_oec, m_clr;
    logic [3:0]  m_hit, m_ca;
    logic [31:0] m_oc, m_ncnt;
    logic [7:0]  m_ol, m_nleak;
    integer f, k, fu, fw;   // one loop variable per always block (Yosys)
    always_comb begin
        m_oc = '0; m_ol = '0; m_onl = 1'b0; m_oel = 1'b0; m_onc = 1'b0; m_oec = 1'b0;
        for (f = 0; f < N_FAC; f = f + 1) if (i_fac == f) begin
            m_oc = m_cnt[f*32 +: 32]; m_ol = m_leak[f*8 +: 8];
            m_onl = m_nsl[f]; m_oel = m_esl[f]; m_onc = m_nsc[f]; m_oec = m_esc[f];
        end
        m_vh  = (i_st == EOG_ST_VALID) || (i_st == EOG_ST_HELD);
        m_upd = (m_vh || i_st == EOG_ST_INVALID) && (i_fac < N_FAC);       // TASKS #1, #10
        m_clr = i_hr || i_st == EOG_ST_INVALID;     // counters cleared before the update (D7)
        if (m_clr) begin m_oc = '0; m_ol = '0; end
        m_gap = (i_ch3 > g_gap);                    // strict (D7)
        for (k = 0; k < 4; k = k + 1) begin
            m_hit[k] = $signed(in_data[EOG_BL_LOGITS + 16*k +: 16]) > $signed(glb[EOG_G_LOGIT_THR + 16*k +: 16]);
            m_ncnt[8*k +: 8] = !(m_vh && m_hit[k]) ? 8'd0 : (m_oc[8*k +: 8] == 8'hFF) ? 8'hFF : m_oc[8*k +: 8] + 8'd1;
            m_ca[k] = m_upd && m_vh && (m_ncnt[8*k +: 8] >= g_k4[8*k +: 8]);
        end
        m_lh = m_hit[0] && m_gap;
        m_nleak = !(m_vh && m_lh) ? 8'd0 : (m_ol == 8'hFF) ? 8'hFF : m_ol + 8'd1;
        // VALID/HELD only: INVALID clears the counters and leaves conditions and latches alone (D7, A4)
        m_esc_new = m_upd && m_vh && (m_nleak >= g_k4[7:0]);
        m_nsc_new = m_upd && m_vh && ((i_rul[3:0] != 4'd0) || (m_ca != 4'd0));
    end

    // ---- expected ALERTs and bus A ----
    // Record slots indexed by REC_NO bit 0: the accepted bus L word, the model's class_active, the record's
    // ALERT flags (NS_RAISED, ES_RAISED, CLEARED(NS), CLEARED(ES): TASKS #3 order) not yet pushed, and the
    // autonomous values seen since the record was accepted ({may be 1, may be 0}). At most two records are open
    // (accepted and not yet output, or with ALERTs not yet pushed); A5_open checks it. An ack fills ak_ns/ak_es
    // (latch & ~cond); ACKED are expected lowest slot first, NS before ES (TASKS #3) with RULES = CLASSES = 0,
    // SOURCE = {type, 4'b0}, TS = RESULT_NO = 0, CD_P10 = 0xFFFF (TASKS #4). No ALERT is reordered across an ack:
    // the environment only acks while quiet and holds in_valid = 0 until the ACKED are out.
    function automatic logic [127:0] mk_al(input logic [4:0] fac, input logic [7:0] kind, input logic [7:0] src,
                                           input logic [31:0] ts, input logic [31:0] rno, input logic [7:0] rules,
                                           input logic [7:0] cls, input logic [15:0] p10);
        mk_al = {p10, cls, rules, rno, ts, src, kind, 11'd0, fac};
    endfunction

    logic [2*255-1:0] rs_rec;
    logic [7:0]       rs_ca, rs_fl;     // 4 bits per slot
    logic [3:0]       rs_ok;            // 2 bits per slot
    logic [N_FAC-1:0] ak_ns, ak_es;
    logic             ak_ok1;           // autonomous was 1 at some cycle since the ack request (or one before)
    logic [N_FAC-1:0] clr_ns, clr_es;
    assign clr_ns = m_nsl & ~m_nsc;
    assign clr_es = m_esl & ~m_esc;
    logic m_ack;            // an acknowledge the model applies this cycle (environment: ack_srv only when quiet)
    assign m_ack = rst_n && ack_srv;
    logic m_rec;
    assign m_rec = rst_n && in_fire;
    logic [3:0] m_fl;       // this record's ALERTs
    assign m_fl = !(m_upd && m_vh) ? 4'd0 : {m_oec && !m_esc_new && m_oel, m_onc && !m_nsc_new && m_onl,
                                            m_esc_new && !m_oel, m_nsc_new && !m_onl};
    logic       i_slot;
    assign i_slot = in_data[EOG_BL_REC_NO];

    // next expected ALERT
    logic         ak_any, open0, open1, cur;
    logic [4:0]   ak_f;
    logic         ak_t;
    logic [3:0]   cur_fl;
    logic [1:0]   cur_j;
    logic [254:0] cur_rec;
    logic [3:0]   cur_ca;
    logic [7:0]   cur_src, cur_kind;
    logic [127:0] exp_al;
    logic [1:0]   exp_ok;
    logic         pend;
    always_comb begin
        ak_any = (ak_ns | ak_es) != '0;
        ak_f = 5'd0; ak_t = 1'b0;
        for (fw = N_FAC - 1; fw >= 0; fw = fw - 1) begin
            if (ak_es[fw]) begin ak_f = 5'(fw); ak_t = 1'b1; end
            if (ak_ns[fw]) begin ak_f = 5'(fw); ak_t = 1'b0; end
        end
        open0 = rs_fl[3:0] != 4'd0;
        open1 = rs_fl[7:4] != 4'd0;
        cur = (open0 && open1) ? (rs_rec[0 +: 8] + 8'd1 == rs_rec[255 +: 8] ? 1'b0 : 1'b1) : !open0;
        cur_rec = cur ? rs_rec[255 +: 255] : rs_rec[0 +: 255];
        cur_fl  = cur ? rs_fl[7:4] : rs_fl[3:0];
        cur_ca  = cur ? rs_ca[7:4] : rs_ca[3:0];
        cur_j   = cur_fl[0] ? 2'd0 : cur_fl[1] ? 2'd1 : cur_fl[2] ? 2'd2 : 2'd3;
        // SOURCE: bit 0 RULES[3:0] != 0, bit 1 class_active != 0, bit 2 autonomous (checked by A5_auto), bit 4
        // latch type (numerics §9; the same bits on every record ALERT, as features_int.py)
        cur_src = {3'd0, cur_j[0], 2'd0, cur_ca != 4'd0, cur_rec[EOG_BL_RULES +: 4] != 4'd0};
        case (cur_j)
            2'd0:    cur_kind = EOG_AK_NS_RAISED;
            2'd1:    cur_kind = EOG_AK_ES_RAISED;
            default: cur_kind = EOG_AK_CLEARED;
        endcase
        pend = ak_any || open0 || open1;
        if (ak_any) begin
            exp_al = mk_al(ak_f, EOG_AK_ACKED, {3'd0, ak_t, 4'd0}, 32'd0, 32'd0, 8'd0, 8'd0, 16'hFFFF);
            // SOURCE bit 2 of ACKED: 0 (TASKS #4, v1) or autonomous during the ack (v4's general SOURCE definition):
            // both accepted until the spec question is answered
            exp_ok = {ak_ok1 || autonomous, 1'b1};
        end else begin
            exp_al = mk_al(cur_rec[EOG_BL_FAC +: 5], cur_kind, cur_src, cur_rec[EOG_BL_TS +: 32],
                           cur_rec[EOG_BL_REC_NO +: 32], {3'd0, cur_rec[EOG_BL_RULES +: 5]}, {4'd0, cur_ca},
                           cur_rec[EOG_BL_CD +: 16]);
            exp_ok = (cur ? rs_ok[3:2] : rs_ok[1:0]) | {autonomous, !autonomous};
        end
    end
    logic al_pop;
    assign al_pop = (al_valid || al_drop) && pend;

    // expected bus A for the record at the output
    logic [242:0] o_exp;
    logic         o_slot;
    assign o_slot = out_data[EOG_BA_REC_NO];
    assign o_exp  = (f_in_flight == 8'd0) ? {m_ca, in_data[254:130], in_data[113:0]}      // same-cycle pass-through
                  : o_slot ? {rs_ca[7:4], rs_rec[255 + 130 +: 125], rs_rec[255 +: 114]}
                           : {rs_ca[3:0], rs_rec[130 +: 125], rs_rec[0 +: 114]};

    // ack window and quiet detection
    logic       ack_busy;
    logic [2:0] ack_age;
    logic       quiet_now;
    logic [2:0] quiet_run;  // consecutive quiet cycles before this one (saturating)
    assign quiet_now = (f_in_flight == 8'd0) && !pend && !ack_busy && !p_ack;

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            m_cnt <= '0; m_leak <= '0; m_nsl <= '0; m_esl <= '0; m_nsc <= '0; m_esc <= '0;
            rs_fl <= '0; ak_ns <= '0; ak_es <= '0; ak_ok1 <= 1'b0;
            ack_busy <= 1'b0; ack_age <= '0; quiet_run <= '0;
        end else begin
            // the oldest pending ALERT leaves on every push or drop
            if (al_pop) begin
                if (ak_any) begin
                    if (ak_t) ak_es[ak_f] <= 1'b0; else ak_ns[ak_f] <= 1'b0;
                end else if (cur) rs_fl[4 + cur_j] <= 1'b0;
                else rs_fl[cur_j] <= 1'b0;
            end
            // autonomous values seen while a record's ALERTs wait
            rs_ok <= rs_ok | {autonomous, !autonomous, autonomous, !autonomous};
            ak_ok1 <= ak_ok1 || autonomous;
            if (m_ack) begin
                m_nsl <= m_nsl & m_nsc;
                m_esl <= m_esl & m_esc;
                ak_ns <= clr_ns;
                ak_es <= clr_es;
                ak_ok1 <= autonomous || p_auto;
            end else if (m_rec) begin
                if (m_upd) for (fu = 0; fu < N_FAC; fu = fu + 1) if (i_fac == fu) begin
                    m_cnt[fu*32 +: 32] <= m_ncnt;
                    m_leak[fu*8 +: 8]  <= m_nleak;
                    if (m_vh) begin     // INVALID: counters only (D7)
                        m_nsl[fu] <= m_nsl[fu] | m_nsc_new;
                        m_esl[fu] <= m_esl[fu] | m_esc_new;
                        m_nsc[fu] <= m_nsc_new;
                        m_esc[fu] <= m_esc_new;
                    end
                end
                if (i_slot) begin
                    rs_rec[255 +: 255] <= in_data; rs_ca[7:4] <= m_ca; rs_fl[7:4] <= m_fl;
                    rs_ok[3:2] <= {autonomous || p_auto, !autonomous || !p_auto};
                end else begin
                    rs_rec[0 +: 255] <= in_data; rs_ca[3:0] <= m_ca; rs_fl[3:0] <= m_fl;
                    rs_ok[1:0] <= {autonomous || p_auto, !autonomous || !p_auto};
                end
            end
            if (ack_srv) begin ack_busy <= 1'b1; ack_age <= '0; end
            else if (ack_busy) begin
                if (ack_age != 3'd7) ack_age <= ack_age + 3'd1;
                if (ack_age >= ACK_G[2:0] && !ak_any) ack_busy <= 1'b0;
            end
            quiet_run <= !quiet_now ? 3'd0 : (quiet_run == 3'd7) ? 3'd7 : quiet_run + 3'd1;
        end
    end

    // Environment of the model task (see header)
    always_comb begin
        MD_btn: assume (!btn0);
        if (ack_srv) MD_ack: assume (quiet_now && quiet_run >= 3'd2 && !in_valid);
        if (ack_busy) MD_ack_hold: assume (!in_valid);
    end

`ifdef FV_TIE
    // Solver load: the fields bus A / the ALERTs only copy are tied to the record's REC_NO byte (r), so a copy of
    // the wrong record or a misplaced field is still caught, but the solver does not carry 200 free bits per
    // record. The copies themselves are checked bit for bit in simulation (tb/alarm).
    logic [7:0] r8;
    assign r8 = in_data[EOG_BL_REC_NO +: 8];
    always_comb if (in_valid) begin
        MD_tie_rec:  assume (in_data[EOG_BL_REC_NO + 8 +: 24] == {r8, ~r8, r8});
        MD_tie_last: assume (in_data[EOG_BL_IN_LAST] == r8[1]);
        MD_tie_raw:  assume (in_data[EOG_BL_FAC_RAW +: 16] == {r8, 3'd0, i_fac});
        MD_tie_ts:   assume (in_data[EOG_BL_TS +: 32] == {~r8, r8, ~r8, r8});
        MD_tie_rsn:  assume (in_data[EOG_BL_REASON +: 16] == {r8, ~r8});
        MD_tie_sr:   assume (in_data[EOG_BL_SINCE_RESET +: 8] == ~r8 && in_data[EOG_BL_HIST_RESET] == r8[2]);
        MD_tie_cd:   assume (in_data[EOG_BL_CD +: 48] == {r8, ~r8, ~r8, r8, r8, ~r8});
        MD_tie_wv:   assume (in_data[EOG_BL_WVER +: 8] == (r8 ^ 8'h5A));
    end
`endif
`ifdef FV_HITS
    // Solver load: each LOGIT[k] is THR[k] or THR[k] + 1 and CH3 is GAP_THR or GAP_THR + 1 (one free bit each), so
    // the solver chooses hits instead of 80 bits of compare inputs. The signed compares are checked by A3_hit
    // (prove) and in simulation.
    logic [3:0] hit_near;
    genvar gh;
    generate for (gh = 0; gh < 4; gh = gh + 1) begin : g_hits
        assign hit_near[gh] = (in_data[EOG_BL_LOGITS + 16*gh +: 16] == glb[EOG_G_LOGIT_THR + 16*gh +: 16])
                           || (in_data[EOG_BL_LOGITS + 16*gh +: 16] == glb[EOG_G_LOGIT_THR + 16*gh +: 16] + 16'd1);
    end endgenerate
    always_comb if (in_valid) begin
        MD_hit: assume (hit_near == 4'hF);
        MD_gap: assume (in_data[EOG_BL_CH3 +: 16] == g_gap || in_data[EOG_BL_CH3 +: 16] == g_gap + 16'sd1);
    end
`endif

    // ---- checks ----
    // FV_NO_A5 / FV_ONLY_A5 split these over two bmc tasks (the ALERT-sequence group is the costly one for the
    // solver: it pairs every push with an expectation over the whole trace).
    localparam logic [127:0] M_SRC2 = 128'd1 << (EOG_AL_SOURCE + 2);
`ifndef FV_NO_A5
    always_comb if (f_past_valid && rst_n) begin
        A5_ghost: assert (!(al_valid || al_drop) || pend);
        A5_open:  assert (!(m_rec && (i_slot ? open1 : open0)));   // at most two records open
        if (al_valid && pend) begin
            A5_seq:  assert ((al_data & ~M_SRC2) == exp_al);
            A5_auto: assert (al_data[EOG_AL_SOURCE + 2] ? exp_ok[1] : exp_ok[0]);
            if (al_data[EOG_AL_KIND +: 8] == EOG_AK_ES_RAISED)
                A1_es_kind: assert (exp_al[EOG_AL_KIND +: 8] == EOG_AK_ES_RAISED && exp_al[EOG_AL_FAC_ID +: 16] == a_fac);
        end
    end

    // A5 liveness: an expected ALERT does not wait more than AL_LAT cycles (counted while out_ready = 1).
    logic [4:0] q_wait;
    always_ff @(posedge clk) begin
        if (!rst_n || !pend || al_pop || !out_ready) q_wait <= '0;
        else if (q_wait != 5'h1F) q_wait <= q_wait + 5'd1;
    end
    always_comb if (f_past_valid && rst_n) A5_live: assert (q_wait < AL_LAT);
`endif

`ifndef FV_ONLY_A5
    always_comb if (f_past_valid && rst_n && out_valid && (f_in_flight != 8'd0 || in_fire)) begin
        BA_copy: assert (out_data[238:0] == o_exp[238:0]);
        A3_cls:  assert (out_data[EOG_BA_CLASSES +: 4] == o_exp[EOG_BA_CLASSES +: 4]);
    end

    // latch state on the Pmods vs the model
    logic [4:0] m_worst;
    always_comb begin
        m_worst = 5'd0;
        for (fw = N_FAC - 1; fw >= 0; fw = fw - 1) if (m_nsl[fw]) m_worst = 5'(fw);
        if (m_esl != '0) for (fw = N_FAC - 1; fw >= 0; fw = fw - 1) if (m_esl[fw]) m_worst = 5'(fw);
    end
    logic settled;
    assign settled = quiet_now && quiet_run >= 3'd3;
    always_comb if (f_past_valid && rst_n) begin
        if (ovr_off2 && settled) begin
            A7_m_ja: assert (pmod_ja[1:0] == {m_nsl != '0, m_esl != '0});
            A7_m_jb: assert (pmod_jb[4:0] == m_worst);
            A7_m_ld1: assert (ld1 == 3'b000 || ld1 == ld1_mask({m_nsl != '0, m_esl != '0}));
        end
        if (ovr_off3) begin
            // A1: |es_latch rises only when the model's es_latch is set. A2: |latch falls only inside an ack window
            // and only if the model's ack cleared every bit of that type (the model applies the ack first)
            if (pmod_ja[0] && !p_ja[0]) A1_rise: assert (m_esl != '0);
            if ((p_ja[0] && !pmod_ja[0]) || (p_ja[1] && !pmod_ja[1]))
                A2_fall: assert (ack_busy && (pmod_ja[0] || m_esl == '0) && (pmod_ja[1] || m_nsl == '0));
        end
    end
`endif
`endif

`ifdef FV_A8
    // =========================================================================================================
    // A8: every btn0 high level is shorter than A8_L cycles; ack_srv = 0. Then nothing acknowledges.
    // A8_L: DEB_MS ms measured on a free-running ms tick can be as short as (DEB_MS - 1) * CYC_PER_MS + 1 cycles
    // (same +-1 ms tolerance as the LED fault window, TASKS #9; spec question raised). FV_A8_STRICT: DEB_MS * CYC.
`ifdef FV_A8_STRICT
    localparam integer A8_L = DEB * CYC;
`else
    localparam integer A8_L = (DEB - 1) * CYC + 1;
`endif
    logic [7:0] b_run;      // btn0 high cycles before this one
    always_ff @(posedge clk) b_run <= !btn0 ? 8'd0 : (b_run == 8'hFF) ? 8'hFF : b_run + 8'd1;
    always_comb begin
        A8_env_btn: assume (!btn0 || b_run + 8'd1 < A8_L);
        A8_env_srv: assume (!ack_srv);
        A8_env_ovr: assume (!ledovr[31]);
        if (f_past_valid) A8_env_rst: assume (rst_n);
    end
    always_comb if (f_past_valid && rst_n) begin
        A8_ack: assert (!(al_valid && al_data[EOG_AL_KIND +: 8] == EOG_AK_ACKED));
        if (p_rst && pp_rst) A8_fall: assert (!(p_ja[0] && !pmod_ja[0]) && !(p_ja[1] && !pmod_ja[1]));
    end
`endif

    // ---------------------------------------------------------------------------------------------------------
    // Covers (spec): an E-STOP raise, a CLEARED, an ack sweep clearing 2 slots, autonomous entry and exit; plus an
    // acknowledge by BTN0 alone, an ALERT drop, and the stage passing two records.
    logic [1:0] cv_acked;   // slots 0/1 ACKED since the last accepted record
    logic       cv_srv;     // ack_srv seen since reset
    logic       cv_hb;      // hb_pulse seen since reset
    always_ff @(posedge clk) begin
        if (!rst_n) begin cv_acked <= '0; cv_srv <= 1'b0; cv_hb <= 1'b0; end
        else begin
            if (in_fire) cv_acked <= '0;
            else if (al_valid && al_data[EOG_AL_KIND +: 8] == EOG_AK_ACKED && al_data[EOG_AL_FAC_ID +: 16] < 16'd2)
                cv_acked[al_data[EOG_AL_FAC_ID]] <= 1'b1;
            if (ack_srv)  cv_srv <= 1'b1;
            if (hb_pulse) cv_hb  <= 1'b1;
        end
    end
    always_comb if (f_past_valid && rst_n) begin
        C_estop:    cover (al_valid && al_data[EOG_AL_KIND +: 8] == EOG_AK_ES_RAISED);
        C_cleared:  cover (al_valid && al_data[EOG_AL_KIND +: 8] == EOG_AK_CLEARED);
        C_ack2:     cover (al_valid && al_data[EOG_AL_KIND +: 8] == EOG_AK_ACKED && al_data[EOG_AL_FAC_ID +: 16] == 16'd1
                           && cv_acked[0]);
        C_auto_in:  cover (p_rst && cv_hb && !p_auto && autonomous);
        C_auto_out: cover (p_rst && p_auto && !autonomous);
        C_btn_ack:  cover (al_valid && al_data[EOG_AL_KIND +: 8] == EOG_AK_ACKED && !cv_srv);
        C_drop:     cover (al_drop);
        C_two:      cover (out_fire && f_out_cnt == 8'd1);
    end
endmodule
