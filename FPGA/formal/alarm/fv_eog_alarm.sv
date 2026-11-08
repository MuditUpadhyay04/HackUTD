// fv_eog_alarm.sv — formal harness for eog_alarm (Verify role, task T1.alarm.fv).
//
// Written from spec/modules/eog_alarm.md, spec/numerics.md §9, spec/conventions.md (spec v2, FROZEN) and the lead's
// answers in TASKS.md "Spec questions" #1, #3-#11, using the module's port table only; the RTL internals are not
// read. Run with `bash scripts/formal.sh alarm` (formal/alarm/eog_alarm.sby; task split and depths are there).
//
// Port-level only (no hierarchical references). The stage contract uses the v2 observation ports f_inflight /
// f_oldest_recno (conventions §7) through formal/common/eog_fv_stage.
//
// Sections, selected by a define per sby task:
//   (always)     stage contract, ALERT handshake, A3/A4 at the output, A6 heartbeat, A7 Pmod/LED relations that
//                hold between output ports (no hidden state needed). These are the k-induction (`prove`) set.
//   FV_MODEL     a reference model of numerics §9 for N_FAC slots (counters, latches, conditions), updated
//                atomically when a record is accepted (or an ack is requested), predicts: bus A for every record
//                (CLASSES, copied fields), the exact ALERT sequence (one expected-ALERT queue, popped by every
//                al_valid/al_drop), and the latch state shown on the Pmods once the stage is quiet. bmc from reset:
//                the model's state is not tied to the DUT's (port-only), so it is not inductive.
//                Environment for determinism: acknowledges come from ack_srv only (btn0 = 0) and only while the
//                stage is quiet (no record in flight, no expected ALERT outstanding, no in_valid), and in_valid
//                stays 0 until the ack's ACKED sweep is complete (+ ACK_G cycles). Why: the spec does not fix the
//                order between an ack and a record that is in flight, and the order changes the outcome.
//   FV_A8        debounce: every btn0 high level is shorter than A8_L cycles, ack_srv = 0 -> never an ACKED ALERT
//                and never a latch bit falling on the Pmods.
//
// Property IDs (spec "Required properties"): labels start with the ID.
//   stage  u_in.ax_*, u_out.ax_* (handshake), u_stage.st_* (one in / one out / in order / f_inflight link /
//          II <= II_MAX except while `excl` / latency <= LAT_MAX), AL_hs* (ALERT push/drop handshake)
//   A1     A1_es_kind (an ES_RAISED push matches an expected ES_RAISED: the model raises it only on a VALID/HELD
//          record of f whose leak counter reached K), A1_rise (|es_latch on the Pmod rises only when the model's
//          es_latch is set), A7_m_* (exact latch state when quiet)
//   A2     A2_fall (a latch bit on the Pmods falls only inside an acknowledge window), ACKED entries in the
//          expected queue = latch & ~cond at the ack (A5_seq), A7_m_* (exact latch state when quiet)
//   A3     A3_cls (CLASSES = class_active of the model's counters), A3_hit (a set CLASSES bit implies this
//          record's LOGIT[k] >= THR[k]), A3_inv (INVALID / non-updating records: CLASSES = 0)
//   A4     A4_drop (DROPPED: CLASSES = 0); DROPPED records do not touch the model, so the queue / latch checks
//          also fail if the DUT changes state or raises an ALERT on one
//   A5     A5_seq / A5_auto (each push equals the next expected ALERT; SOURCE bit 2 = autonomous at some cycle
//          while that record or ack was being processed), A5_ghost (no push/drop without an expected ALERT),
//          A5_live (expected ALERTs are pushed or dropped within AL_LAT cycles), A5_ovf (queue bound)
//   A6     A6_auto, A6_rst, A6_hb, A6_step, A6_period, A6_late
//   A7     A7_ovr, A7_ja*, A7_jb*, A7_ld0*, A7_ld1, A7_hbt (+ A7_m_* against the model when quiet)
//   A8     A8_ack, A8_fall
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

    // GLOBAL CONFIG: constant (conventions §5)
    (* anyconst *) logic [255:0] glb;

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
    logic [7:0]  g_k;
    logic [15:0] g_hbt;
    logic signed [15:0] g_gap;
    assign g_k   = (glb[EOG_G_PERSIST_K +: 8] == 8'd0) ? 8'd1 : glb[EOG_G_PERSIST_K +: 8];   // K = max(PERSIST_K, 1)
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
    // (INVALID resets the counters, DROPPED / codes 2, 5-7 / FAC >= N_FAC change nothing: TASKS #1, #10), and a
    // set CLASSES bit needs this record's own hit (cnt[k] = 0 on a miss).
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
        assign o_hit[gk] = $signed(out_data[EOG_BA_LOGITS + 16*gk +: 16]) >= $signed(glb[EOG_G_LOGIT_THR + 16*gk +: 16]);
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
        if (a_kind == EOG_AK_NS_RAISED)
            AL_fmt_nsr: assert (a_src[4] == 1'b0 && a_src[0] == (a_rules[3:0] != 4'd0) && a_src[1] == (a_cls != 8'd0)
                                && a_src[1:0] != 2'd0);
        if (a_kind == EOG_AK_ES_RAISED)
            AL_fmt_esr: assert (a_src[4] && a_src[1:0] == 2'b11 && a_cls[0]);
        if (a_kind == EOG_AK_CLEARED)
            AL_fmt_clr: assert (a_src[1:0] == 2'd0);
        if (a_kind == EOG_AK_ACKED)
            AL_fmt_ack: assert ((a_src & 8'hEF) == 8'd0 && al_data[EOG_AL_TS +: 32] == 32'd0
                                && al_data[EOG_AL_RESULT_NO +: 32] == 32'd0 && a_rules == 8'd0 && a_cls == 8'd0
                                && al_data[EOG_AL_CD_P10 +: 16] == 16'hFFFF);
    end
`endif

`ifdef FV_MODEL
    // =========================================================================================================
    // Reference model (numerics §9), N_FAC slots, updated at in_fire / at the ack request.
    localparam integer QD = 8;          // expected-ALERT queue depth
    localparam integer EW = 130;        // [127:0] ALERT (SOURCE bit 2 masked), [128] bit 2 may be 0, [129] may be 1
    localparam integer NC = (2 * N_FAC > 4) ? 2 * N_FAC : 4;   // candidates per cycle (4 per record, 2N per ack)
    localparam integer OW = 243;
    localparam integer ACK_G = 3;       // an ack request must take effect within ACK_G cycles (spec: "in one cycle")

    logic [N_FAC*32-1:0] m_cnt;         // cnt[f][k], 4 x u8 per slot
    logic [N_FAC*8-1:0]  m_leak;
    logic [N_FAC-1:0]    m_nsl, m_esl, m_nsc, m_esc;

    // record fields
    logic [31:0] i_recno, i_ts;
    logic [4:0]  i_fac, i_rul;
    logic [2:0]  i_st;
    logic [15:0] i_p10;
    logic signed [15:0] i_ch3;
    assign i_recno = in_data[EOG_BL_REC_NO +: 32];
    assign i_ts    = in_data[EOG_BL_TS +: 32];
    assign i_fac   = in_data[EOG_BL_FAC +: 5];
    assign i_rul   = in_data[EOG_BL_RULES +: 5];
    assign i_st    = in_data[EOG_BL_STATUS +: 3];
    assign i_p10   = in_data[EOG_BL_CD +: 16];
    assign i_ch3   = in_data[EOG_BL_CH3 +: 16];

    logic        m_vh, m_upd, m_gap, m_lh, m_nsc_new, m_esc_new, m_onl, m_oel, m_onc, m_oec;
    logic [3:0]  m_hit, m_ca;
    logic [31:0] m_oc, m_ncnt;
    logic [7:0]  m_ol, m_nleak;
    integer f, k, c, i, ca_i, cq, fu, fw;   // one loop variable per always block (Yosys)
    always_comb begin
        m_oc = '0; m_ol = '0; m_onl = 1'b0; m_oel = 1'b0; m_onc = 1'b0; m_oec = 1'b0;
        for (f = 0; f < N_FAC; f = f + 1) if (i_fac == f) begin
            m_oc = m_cnt[f*32 +: 32]; m_ol = m_leak[f*8 +: 8];
            m_onl = m_nsl[f]; m_oel = m_esl[f]; m_onc = m_nsc[f]; m_oec = m_esc[f];
        end
        m_vh  = (i_st == EOG_ST_VALID) || (i_st == EOG_ST_HELD);
        m_upd = (m_vh || i_st == EOG_ST_INVALID) && (i_fac < N_FAC);       // TASKS #1, #10
        m_gap = (i_ch3 >= g_gap);
        for (k = 0; k < 4; k = k + 1) begin
            m_hit[k] = $signed(in_data[EOG_BL_LOGITS + 16*k +: 16]) >= $signed(glb[EOG_G_LOGIT_THR + 16*k +: 16]);
            m_ncnt[8*k +: 8] = !(m_vh && m_hit[k]) ? 8'd0 : (m_oc[8*k +: 8] == 8'hFF) ? 8'hFF : m_oc[8*k +: 8] + 8'd1;
            m_ca[k] = m_upd && m_vh && (m_ncnt[8*k +: 8] >= g_k);
        end
        m_lh = m_hit[0] && m_gap;
        m_nleak = !(m_vh && m_lh) ? 8'd0 : (m_ol == 8'hFF) ? 8'hFF : m_ol + 8'd1;
        m_esc_new = m_upd && m_vh && (m_nleak >= g_k);
        m_nsc_new = m_upd && ((i_rul[3:0] != 4'd0) || (m_ca != 4'd0));
    end

    // ALERT candidates. SOURCE bit 2 is left 0 here; [129:128] say which values are acceptable.
    logic [1:0] a_now;      // {may be 1, may be 0} from autonomous now and one cycle ago
    assign a_now = {autonomous || p_auto, !autonomous || !p_auto};
    function automatic logic [127:0] mk_al(input logic [4:0] fac, input logic [7:0] kind, input logic [7:0] src,
                                           input logic [31:0] ts, input logic [31:0] rno, input logic [7:0] rules,
                                           input logic [7:0] cls, input logic [15:0] p10);
        mk_al = {p10, cls, rules, rno, ts, src, kind, 11'd0, fac};
    endfunction

    logic [NC*EW-1:0] cand;
    logic [NC-1:0]    cv;
    logic [N_FAC-1:0] clr_ns, clr_es;
    assign clr_ns = m_nsl & ~m_nsc;
    assign clr_es = m_esl & ~m_esc;
    logic m_ack;            // an acknowledge the model applies this cycle (environment: ack_srv only when quiet)
    assign m_ack = rst_n && ack_srv;
    logic m_rec;
    assign m_rec = rst_n && in_fire;

    always_comb begin
        cand = '0; cv = '0; ca_i = 0;
        if (m_ack) begin
            // ACKED sweep: lowest slot first, NS before ES (TASKS #3); RULES/CLASSES/SOURCE bit 2 = 0 (TASKS #4)
            for (ca_i = 0; ca_i < 2 * N_FAC; ca_i = ca_i + 1) begin
                cv[ca_i] = (ca_i % 2 == 0) ? clr_ns[ca_i / 2] : clr_es[ca_i / 2];
                cand[ca_i*EW +: EW] = {2'b01, mk_al(5'(ca_i / 2), EOG_AK_ACKED, {3'd0, 1'(ca_i % 2), 4'd0}, 32'd0, 32'd0,
                                                 8'd0, 8'd0, 16'hFFFF)};
            end
        end else if (m_rec && m_upd) begin
            // per record: NS_RAISED, ES_RAISED, CLEARED(NS), CLEARED(ES) (TASKS #3)
            cv[0] = m_nsc_new && !m_onl;
            cv[1] = m_esc_new && !m_oel;
            cv[2] = m_onc && !m_nsc_new && m_onl;
            cv[3] = m_oec && !m_esc_new && m_oel;
            cand[0*EW +: EW] = {a_now, mk_al(i_fac, EOG_AK_NS_RAISED, {6'd0, m_ca != 4'd0, i_rul[3:0] != 4'd0},
                                             i_ts, i_recno, {3'd0, i_rul}, {4'd0, m_ca}, i_p10)};
            cand[1*EW +: EW] = {a_now, mk_al(i_fac, EOG_AK_ES_RAISED, {3'd0, 1'b1, 2'd0, m_ca[0], m_gap},
                                             i_ts, i_recno, {3'd0, i_rul}, {4'd0, m_ca}, i_p10)};
            cand[2*EW +: EW] = {a_now, mk_al(i_fac, EOG_AK_CLEARED, 8'd0,
                                             i_ts, i_recno, {3'd0, i_rul}, {4'd0, m_ca}, i_p10)};
            cand[3*EW +: EW] = {a_now, mk_al(i_fac, EOG_AK_CLEARED, 8'h10,
                                             i_ts, i_recno, {3'd0, i_rul}, {4'd0, m_ca}, i_p10)};
        end
    end

    // expected-ALERT queue (entry 0 = head)
    logic [QD*EW-1:0] q, q_sh, q_n;
    logic [4:0]       q_cnt, q_base, q_cnt_n;
    logic [(NC+1)*5-1:0] pre;        // pre[5c +: 5] = number of candidates before c
    logic             q_pop;
    assign q_pop = (al_valid || al_drop) && (q_cnt != 5'd0);
    always_comb begin
        pre = '0;
        for (cq = 0; cq < NC; cq = cq + 1) pre[(cq+1)*5 +: 5] = pre[cq*5 +: 5] + {4'd0, cv[cq]};
        q_sh   = q_pop ? (q >> EW) : q;
        q_base = q_cnt - {4'd0, q_pop};
        q_n    = q_sh;
        for (i = 0; i < QD; i = i + 1) begin
            // record ALERTs not yet pushed: remember the autonomous values seen while they wait
            if (i < q_base && q_sh[i*EW + EOG_AL_KIND +: 8] != EOG_AK_ACKED) begin
                q_n[i*EW + 128] = q_sh[i*EW + 128] || !autonomous;
                q_n[i*EW + 129] = q_sh[i*EW + 129] || autonomous;
            end
            for (cq = 0; cq < NC; cq = cq + 1)
                if (cv[cq] && i == q_base + pre[cq*5 +: 5]) q_n[i*EW +: EW] = cand[cq*EW +: EW];
        end
        q_cnt_n = q_base + pre[NC*5 +: 5];
    end

    // expected bus A FIFO (MAX_INFLIGHT = 2), entry 0 = head
    logic [2*OW-1:0] o_q;
    logic [1:0]      o_cnt;
    logic [OW-1:0]   o_new, o_head;
    assign o_new  = {m_ca, in_data[254:130], in_data[113:0]};
    assign o_head = (o_cnt == 2'd0) ? o_new : o_q[0 +: OW];

    // ack window and quiet detection
    logic       ack_busy;
    logic [2:0] ack_age;
    logic       quiet_now;
    logic [2:0] quiet_run;  // consecutive quiet cycles before this one (saturating)
    assign quiet_now = (f_in_flight == 8'd0) && (q_cnt == 5'd0) && !ack_busy && !p_ack;

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            m_cnt <= '0; m_leak <= '0; m_nsl <= '0; m_esl <= '0; m_nsc <= '0; m_esc <= '0;
            q <= '0; q_cnt <= '0; o_q <= '0; o_cnt <= '0;
            ack_busy <= 1'b0; ack_age <= '0; quiet_run <= '0;
        end else begin
            if (m_ack) begin
                m_nsl <= m_nsl & m_nsc;
                m_esl <= m_esl & m_esc;
            end else if (m_rec && m_upd) begin
                for (fu = 0; fu < N_FAC; fu = fu + 1) if (i_fac == fu) begin
                    m_cnt[fu*32 +: 32] <= m_ncnt;
                    m_leak[fu*8 +: 8]  <= m_nleak;
                    m_nsl[fu] <= m_nsl[fu] | m_nsc_new;
                    m_esl[fu] <= m_esl[fu] | m_esc_new;
                    m_nsc[fu] <= m_nsc_new;
                    m_esc[fu] <= m_esc_new;
                end
            end
            q     <= q_n;
            q_cnt <= q_cnt_n;
            // bus A FIFO
            case ({in_fire, out_fire})
                2'b10: begin o_q[o_cnt[0]*OW +: OW] <= o_new; o_cnt <= o_cnt + 2'd1; end
                2'b01: begin o_q <= o_q >> OW; o_cnt <= o_cnt - 2'd1; end
                2'b11: if (o_cnt != 2'd0) begin
                           o_q <= (o_q >> OW);
                           o_q[(o_cnt[0] ^ 1'b1)*OW +: OW] <= o_new;
                       end
                default: ;
            endcase
            if (ack_srv) begin ack_busy <= 1'b1; ack_age <= '0; end
            else if (ack_busy) begin
                if (ack_age != 3'd7) ack_age <= ack_age + 3'd1;
                if (ack_age >= ACK_G[2:0] && q_cnt == 5'd0) ack_busy <= 1'b0;
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

    // ---- checks ----
    logic [127:0] h_al;
    logic [1:0]   h_ok;
    logic         h_rec;    // head is a record ALERT (SOURCE bit 2 may also equal autonomous of this cycle)
    assign h_al  = q[0 +: 128];
    assign h_ok  = q[128 +: 2];
    assign h_rec = h_al[EOG_AL_KIND +: 8] != EOG_AK_ACKED;
    localparam logic [127:0] M_SRC2 = 128'd1 << (EOG_AL_SOURCE + 2);

    always_comb if (f_past_valid && rst_n) begin
        A5_ghost: assert (!(al_valid || al_drop) || q_cnt != 5'd0);
        A5_ovf:   assert (q_cnt_n <= QD);
        if (al_valid && q_cnt != 5'd0) begin
            A5_seq:  assert ((al_data & ~M_SRC2) == h_al);
            A5_auto: assert (al_data[EOG_AL_SOURCE + 2] ? (h_ok[1] || (h_rec && autonomous))
                                                        : (h_ok[0] || (h_rec && !autonomous)));
            if (al_data[EOG_AL_KIND +: 8] == EOG_AK_ES_RAISED)
                A1_es_kind: assert (h_al[EOG_AL_KIND +: 8] == EOG_AK_ES_RAISED && h_al[EOG_AL_FAC_ID +: 16] == a_fac);
        end
        if (out_valid && (o_cnt != 2'd0 || in_fire)) begin
            BA_copy: assert (out_data[238:0] == o_head[238:0]);
            A3_cls:  assert (out_data[EOG_BA_CLASSES +: 4] == o_head[EOG_BA_CLASSES +: 4]);
        end
    end

    // A5 liveness: an expected ALERT does not wait more than AL_LAT cycles (counted while out_ready = 1).
    logic [4:0] q_wait;
    always_ff @(posedge clk) begin
        if (!rst_n || q_cnt == 5'd0 || q_pop || !out_ready) q_wait <= '0;
        else if (q_wait != 5'h1F) q_wait <= q_wait + 5'd1;
    end
    always_comb if (f_past_valid && rst_n) A5_live: assert (q_wait < AL_LAT);

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
            // A1: |es_latch rises only when the model's es_latch is set; A2: a latch bit falls only in an ack window
            if (pmod_ja[0] && !p_ja[0]) A1_rise: assert (m_esl != '0);
            if ((p_ja[0] && !pmod_ja[0]) || (p_ja[1] && !pmod_ja[1])) A2_fall: assert (ack_busy);
        end
    end
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
