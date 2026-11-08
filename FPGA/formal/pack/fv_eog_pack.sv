// fv_eog_pack.sv -- formal harness for eog_pack (Verify role, task T1.pack.fv).
//
// Written from spec/modules/eog_pack.md, spec/conventions.md, spec/numerics.md and rtl/eog_defs.svh (spec v4) and
// the spec's port table only; the RTL internals are not read. Run with `bash scripts/formal.sh pack`
// (formal/pack/eog_pack.sby).
//
// eog_pack is a conventions §7 record stage on its input (bus A, f_inflight / f_oldest_recno) and emits beats on
// m_*. The harness keeps a port-only shadow of the beat stream:
//   f_beat     beats of the current output record already transferred (0..3); a record = 4 beats
//   l3         m_valid while f_beat == 3: the record's last beat is presented. This is the "output" of the record
//              for eog_fv_stage (out_valid = l3, out_ready = m_ready, out_recno = RESULT_NO low bits = beat 3
//              bits [39:32]), so one-in-one-out-in-order, the in-flight link and II / latency are checked per
//              record, with f_inflight counting records whose last beat has not transferred (conventions §7).
//   q_last*    IN_LAST of the in-flight records, indexed by the checker's in/out counters (K3)
//   f_bcnt     results since the last m_last, computed from the spec rule (not from the DUT's m_last)
//   f_t*       the tracked record (K2): the record accepted while the free input trk_go = 1 (first time after
//              reset); the solver may pick any record, like an anyconst record number, but the record identity
//              stays out of the arithmetic (pattern of formal/unpack).
//
// Property map (labels in the sby log):
//   K1   u_out.ax_reset / ax_hold / ax_data: eog_fv_axis (ASSUME = 0) on {m_last, m_data} with m_valid / m_ready.
//   K2   K2_data: every beat of the tracked record equals RESULT[64j+63:64j] of the RESULT mapping of its bus-A
//        input (j = f_beat), i.e. the 4 beats reassemble to that RESULT. K2_ghost: no beat without an accepted
//        record whose last beat has not transferred. Exactly 4 beats per record, in order: u_stage.st_order
//        (beat 3 of the n-th record carries RESULT_NO = n; a record with 3 or 5 beats shifts the next record's
//        beat 3 onto another field) + K2_data + u_stage.st_no_ghost / st_link_n / st_link_r / st_inflight.
//   K3   K3_beat: m_last = 0 on beats 0-2. K3_last: on beat 3, m_last == IN_LAST || (results since the last
//        m_last, this one included) == BATCH.
//   K4   K4_ghost / K4_due / K4_val: tap_valid fires exactly once per record, in the cycle its last beat
//        transfers or the cycle after (see "harness choice" below), with tap_status = STATUS[2:0] and
//        tap_reason = REASON[15:0] of that record (taken from its beats 0 and 1, which K2 ties to the input).
//   B_stall  stall == m_valid && !m_ready (port table).
//   B_rate   "sustains one beat per cycle": in_valid = 1 and m_ready = 1 in each of the 3 previous cycles (no reset)
//            -> m_valid = 1 (one bubble allowed when a stream starts or back-pressure releases; same reading as
//            ruling #27 for unpack).
//   Stage contract (conventions §3, eog_fv_stage u_stage): st_recno_in (assume), st_order, st_no_ghost,
//   st_inflight (<= 2 records held, harness choice), st_cnt, st_link_n, st_link_r, st_ii (II <= 16 with
//   in_valid = m_ready = 1), st_lat (with m_ready = 1 the oldest record's last beat is presented within 128).
//   Header pass-through is part of K2 (FAC_ID = FAC_RAW, TS, SINCE_RESET, STATUS, REASON, RESULT_NO = REC_NO).
//   H_*  harness-internal consistency (true by construction).
//   Covers: C1_batch (spec: a batch of BATCH = 3 results ending in m_last, none with IN_LAST), C2_inlast (an
//   early m_last from IN_LAST), C3_b2b (two records' 8 beats on 8 consecutive cycles), C4_stall (back-pressure
//   mid-record), C5_tap (a tap of a DROPPED record with reason bit FRAMING).
//
// Environment: conventions §2 on bus A (u_in, assumed), first-cycle reset, REC_NO = acceptance counter (low 8 bits,
// st_recno_in), and A_drop: a DROPPED record (STATUS = 4) arrives with SINCE_RESET = 0 and WVER = 0 (ruling #25 /
// #39: upstream guarantees it; pack may pass them through or force them, both pass). in_data, m_ready, rst_n and
// trk_go are otherwise free in every cycle.
//
// Harness choices (spec silent; reported to the lead as spec questions): at most 2 records held (accepted, last
// beat not transferred); tap_valid in the last-beat transfer cycle or one cycle later, never both.

`default_nettype none

module fv_eog_pack (
    input  logic         clk,        // top-level inputs are free: the solver drives them
    input  logic         rst_n,
    input  logic         in_valid,
    input  logic [242:0] in_data,
    input  logic         m_ready,
    input  logic         trk_go      // K2: picks the tracked record
);
    `include "eog_defs.svh"

    localparam integer AW    = EOG_BA_W;
    localparam integer BATCH = 3;      // spec cover: BATCH = 3 in formal
    localparam integer RW    = 8;      // REC_NO bits compared by eog_fv_stage

    // ---------------------------------------------------------------------------------------------------------
    // DUT
    logic        in_ready, m_valid, m_last, tap_valid, stall;
    logic [63:0] m_data;
    logic [2:0]  tap_status;
    logic [15:0] tap_reason;
    logic [7:0]  dut_inflight;
    logic [31:0] dut_oldest;

    eog_pack #(.BATCH(BATCH)) dut (
        .clk           (clk),
        .rst_n         (rst_n),
        .in_valid      (in_valid),
        .in_ready      (in_ready),
        .in_data       (in_data),
        .m_valid       (m_valid),
        .m_ready       (m_ready),
        .m_data        (m_data),
        .m_last        (m_last),
        .tap_valid     (tap_valid),
        .tap_status    (tap_status),
        .tap_reason    (tap_reason),
        .stall         (stall),
        .f_inflight    (dut_inflight),
        .f_oldest_recno(dut_oldest)
    );

    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    // Conventions §2: assumed on bus A, asserted on the beat output (K1).
    eog_fv_axis #(.W(AW), .ASSUME(1)) u_in (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(in_valid), .ready(in_ready), .data(in_data));
    eog_fv_axis #(.W(65), .ASSUME(0)) u_out (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(m_valid), .ready(m_ready), .data({m_last, m_data}));

    // Ruling #25 / #39: DROPPED records arrive with SINCE_RESET = 0 and WVER = 0.
    always_comb if (in_valid && in_data[EOG_BA_STATUS +: EOG_BA_STATUS_W] == EOG_ST_DROPPED) begin
        A_drop: assume (in_data[EOG_BA_SINCE_RESET +: EOG_BA_SINCE_RESET_W] == '0
                        && in_data[EOG_BA_WVER +: EOG_BA_WVER_W] == '0);
    end

    // ---------------------------------------------------------------------------------------------------------
    // RESULT mapping (eog_pack.md "Behavior", numerics/eog_defs EOG_RES_*)
    function automatic logic [255:0] res_of(input logic [AW-1:0] a);
        logic [255:0] r;
        r = '0;
        r[EOG_RES_FAC_ID      +: EOG_RES_FAC_ID_W]      = a[EOG_BA_FAC_RAW +: EOG_BA_FAC_RAW_W];
        r[EOG_RES_STATUS      +: EOG_RES_STATUS_W]      = {5'd0, a[EOG_BA_STATUS +: EOG_BA_STATUS_W]};
        r[EOG_RES_SINCE_RESET +: EOG_RES_SINCE_RESET_W] = a[EOG_BA_SINCE_RESET +: EOG_BA_SINCE_RESET_W];
        r[EOG_RES_TS          +: EOG_RES_TS_W]          = a[EOG_BA_TS +: EOG_BA_TS_W];
        r[EOG_RES_REASON      +: EOG_RES_REASON_W]      = {16'd0, a[EOG_BA_REASON +: EOG_BA_REASON_W]};
        r[EOG_RES_LOGITS      +: EOG_RES_LOGITS_W]      = a[EOG_BA_LOGITS +: EOG_BA_LOGITS_W];
        r[EOG_RES_RULES       +: EOG_RES_RULES_W]       = {3'd0, a[EOG_BA_RULES +: EOG_BA_RULES_W]};
        r[EOG_RES_WVER        +: EOG_RES_WVER_W]        = a[EOG_BA_WVER +: EOG_BA_WVER_W];
        r[EOG_RES_CD_P10      +: EOG_RES_CD_P10_W]      = a[EOG_BA_CD      +: 16];
        r[EOG_RES_CD_P50      +: EOG_RES_CD_P50_W]      = a[EOG_BA_CD + 16 +: 16];
        r[EOG_RES_CD_P90      +: EOG_RES_CD_P90_W]      = a[EOG_BA_CD + 32 +: 16];
        r[EOG_RES_RESULT_NO   +: EOG_RES_RESULT_NO_W]   = a[EOG_BA_REC_NO +: EOG_BA_REC_NO_W];
        res_of = r;
    endfunction

    // ---------------------------------------------------------------------------------------------------------
    // Beat shadow + stage checker
    logic in_fire, m_fire, l3, l3fire;
    logic [1:0] f_beat;
    assign in_fire = rst_n && in_valid && in_ready;
    assign m_fire  = rst_n && m_valid && m_ready;
    assign l3      = m_valid && f_beat == 2'd3;
    assign l3fire  = m_fire && f_beat == 2'd3;

    logic [RW-1:0] f_in_cnt, f_out_cnt;
    logic [7:0]    f_in_flight;
    eog_fv_stage #(.RW(RW), .MAX_INFLIGHT(2), .II_MAX(EOG_II_MAX), .LAT_MAX(128), .SWEEP(0)) u_stage (
        .clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .in_valid(in_valid), .in_ready(in_ready), .in_recno(in_data[EOG_BA_REC_NO +: RW]),
        .out_valid(l3), .out_ready(m_ready), .out_recno(m_data[EOG_RES_RESULT_NO - 192 +: RW]),
        .excl(1'b0), .dut_inflight(dut_inflight), .dut_oldest(dut_oldest),
        .f_in_cnt(f_in_cnt), .f_out_cnt(f_out_cnt), .f_in_flight(f_in_flight));

    // IN_LAST of the in-flight records (<= 2 held, 4 slots)
    logic q_last0, q_last1, q_last2, q_last3, h_last;
    always_comb begin
        case (f_out_cnt[1:0])
            2'd0:    h_last = q_last0;
            2'd1:    h_last = q_last1;
            2'd2:    h_last = q_last2;
            default: h_last = q_last3;
        endcase
    end

    // K3: results since the last m_last (spec rule), and this record's expected m_last
    logic [7:0] f_bcnt;
    logic       e_last;
    assign e_last = h_last || (f_bcnt == BATCH - 1);

    // K2: tracked record
    logic          f_tused, f_tsel;
    logic [RW-1:0] f_tno;
    logic [AW-1:0] f_tdat;
    logic          t_start, t_cur;
    logic [255:0]  t_res;
    logic [63:0]   t_beat;
    assign t_start = in_fire && trk_go && !f_tused;
    assign t_cur   = (f_tsel && f_out_cnt == f_tno) || (t_start && f_in_flight == 8'd0);
    assign t_res   = res_of(f_tsel ? f_tdat : in_data);
    always_comb begin
        case (f_beat)
            2'd0:    t_beat = t_res[63:0];
            2'd1:    t_beat = t_res[127:64];
            2'd2:    t_beat = t_res[191:128];
            default: t_beat = t_res[255:192];
        endcase
    end

    // K4: STATUS / REASON of the current output record, from its beats 0 and 1
    logic [2:0]  f_st, p_st, c_st;
    logic [15:0] f_rs, p_rs, c_rs;
    logic        p_v;             // a record's last beat transferred last cycle without a tap
    assign c_st = (f_beat == 2'd0) ? m_data[EOG_RES_STATUS +: 3] : f_st;
    assign c_rs = (f_beat == 2'd1) ? m_data[EOG_RES_REASON - 64 +: 16] : f_rs;

    // B_rate history; C3 run of consecutive beat transfers
    logic h1, h2, h3;
    logic [3:0] f_run;

    initial begin
        f_beat  = '0;
        f_bcnt  = '0;
        f_tused = 1'b0;
        f_tsel  = 1'b0;
        p_v     = 1'b0;
        h1      = 1'b0;
        h2      = 1'b0;
        h3      = 1'b0;
        f_run   = '0;
    end

    always_ff @(posedge clk) begin
        h1 <= rst_n && in_valid && m_ready;
        h2 <= h1;
        h3 <= h2;
        if (!rst_n) begin
            f_beat  <= '0;
            f_bcnt  <= '0;
            f_tused <= 1'b0;
            f_tsel  <= 1'b0;
            p_v     <= 1'b0;
            f_run   <= '0;
        end else begin
            if (in_fire) begin
                case (f_in_cnt[1:0])
                    2'd0:    q_last0 <= in_data[EOG_BA_IN_LAST];
                    2'd1:    q_last1 <= in_data[EOG_BA_IN_LAST];
                    2'd2:    q_last2 <= in_data[EOG_BA_IN_LAST];
                    default: q_last3 <= in_data[EOG_BA_IN_LAST];
                endcase
            end
            if (m_fire) begin
                f_beat <= f_beat + 2'd1;
                f_st   <= c_st;
                f_rs   <= c_rs;
            end
            if (l3fire) f_bcnt <= e_last ? 8'd0 : f_bcnt + 8'd1;
            if (t_start) begin
                f_tused <= 1'b1;
                f_tsel  <= 1'b1;
                f_tno   <= f_in_cnt;
                f_tdat  <= in_data;
            end
            if (l3fire && t_cur) f_tsel <= 1'b0;
            p_v  <= l3fire && !tap_valid;
            p_st <= c_st;
            p_rs <= c_rs;
            if (!m_fire)              f_run <= '0;
            else if (f_run != 4'd15)  f_run <= f_run + 4'd1;
        end
    end

    // ---------------------------------------------------------------------------------------------------------
    // Required properties (spec/modules/eog_pack.md)
    always_comb begin
        if (f_past_valid && rst_n) begin
            if (m_valid) begin
                // K2: no beat without a record in flight (or accepted this cycle)
                K2_ghost: assert (f_in_flight != 8'd0 || in_fire);
                // K2: the tracked record's beats reassemble to its RESULT
                if (t_cur)
                    K2_data: assert (m_data == t_beat);
                // K3: m_last only on beat 3, and there exactly per the batching rule
                if (f_beat != 2'd3)
                    K3_beat: assert (!m_last);
                else
                    K3_last: assert (m_last == e_last);
            end

            // K4: one tap per record, at its last-beat transfer or the cycle after, with its status / reason
            if (tap_valid) begin
                K4_ghost: assert (l3fire || p_v);
                K4_val:   assert (p_v ? (tap_status == p_st && tap_reason == p_rs)
                                      : (tap_status == c_st && tap_reason == c_rs));
            end
            if (p_v)
                K4_due: assert (tap_valid);

            // Port table: stall = m_valid && !m_ready
            B_stall: assert (stall == (m_valid && !m_ready));

            // Behavior: sustains one beat per cycle
            if (h1 && h2 && h3)
                B_rate: assert (m_valid);
        end

        // Harness-internal consistency
        if (f_past_valid) begin
            H_bcnt: assert (f_bcnt < BATCH);
            H_trk:  assert (!f_tsel || f_tused);
            H_pv:   assert (!p_v || f_beat == 2'd0);
        end
    end

    // ---------------------------------------------------------------------------------------------------------
    // Cover goals
    always_comb begin
        if (f_past_valid && rst_n) begin
            C1_batch:    cover (l3fire && m_last && !h_last && f_bcnt == BATCH - 1);
            C2_inlast:   cover (l3fire && m_last && h_last && f_bcnt == 8'd1);
            C3_b2b:      cover (l3fire && f_run >= 4'd7);
            C4_stall:    cover (m_valid && !m_ready && f_beat == 2'd1 && in_valid && !in_ready);
            C5_tap:      cover (tap_valid && tap_status == EOG_ST_DROPPED && tap_reason[EOG_R_FRAMING]);
        end
    end

endmodule

`default_nettype wire
