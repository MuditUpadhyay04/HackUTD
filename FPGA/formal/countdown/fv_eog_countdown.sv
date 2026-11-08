// fv_eog_countdown.sv — formal harness for eog_countdown (Verify role, task T1.countdown.fv).
//   bash scripts/formal.sh countdown        (formal/countdown/eog_countdown.sby; task split and depths are there)
//
// Written from spec v4 (FROZEN): spec/modules/eog_countdown.md, spec/numerics.md §1 (D1, D2, D4, D6) and §7,
// spec/conventions.md §1-§3 and §7, the lead's answers in FPGA/TASKS.md, and, where the spec defers to it, Mudit's
// ml/hutd_ml/features_int.py (`review_r1r2` countdown: Engine._countdown and the ring update in process()).
// Only the DUT's port list (spec port table) is used; no RTL internals.
//
// DUT: eog_countdown #(N_FAC, II, CD_LOG2): clk, rst_n, in_valid/in_ready/in_data (bus M, 646 b),
// out_valid/out_ready/out_data (bus C, 663 b), cfg_fac[4:0] -> cfg_row[511:0] (combinational CONFIG row), and the
// formal-only observation ports f_inflight[7:0] / f_oldest_recno[31:0] (conventions §7).
//
// ---- Reference semantics (numerics §7, v4) ----
// Per slot: a ring of 2^CD_LOG2 signed INFLOW values and a "has ring" bit (0 after reset). For an accepted record
// of slot f < N_FAC: a non-DROPPED HIST_RESET record first clears has[f]; then a VALID/HELD record either fills the
// whole ring with its INFLOW (has[f] = 0) or shifts its INFLOW in, and sets has[f]. sum = ring sum,
// mean = sum >>> CD_LOG2, max/min over the ring (signed). Output, VALID/HELD:
//   NOT_FILLING = (mean <= 0) always; LEVEL >= SHUT_LVL (signed, SHUT_LVL zero-extended) -> CD = 0;
//   else Δ = SHUT_LVL - LEVEL, K = K_CD: p10 = m(max), p50 = m(mean), p90 = m(min),
//   m(q) = q <= 0 ? 0xFFFF : min((K·Δ) // (q << 8), 0xFFFF).
// INVALID/DROPPED: CD = 3 x 0xFFFF, NOT_FILLING = 0, no ring change (INVALID may clear via HIST_RESET).
// FAC >= N_FAC (TASKS.md answer 1): never touches state; a VALID/HELD one is output like INVALID (model).
//
// ---- Checks (labels) ----
// Stage contract (formal/common checkers):
//   u_out.ax_reset/ax_hold/ax_data   output handshake (conventions §2)
//   u_stage.st_order/st_no_ghost/st_inflight (<= 8)/st_cnt/st_link_n/st_link_r   one in, one out, in order
//   u_stage.st_ii                    II <= 16 with in_valid = out_ready = 1, after the N_FAC + 8 reset sweep
//   u_stage.st_lat                   latency <= 128 with out_ready = 1
//   f_trk                            harness invariant: the tracked record is in flight exactly when expected
// Per record (the record whose REC_NO low bits equal the anyconst f_k, i.e. every record):
//   H_hdr, H_feat, H_rules   header and FEAT copied, RULES[3:0] = RULES4 (module spec "Behavior")
//   C1_cd, C1_nf             INVALID/DROPPED -> CD = 3 x 0xFFFF, NOT_FILLING = 0
//   C1x_cd, C1x_nf           VALID/HELD with FAC >= N_FAC: same as INVALID (TASKS.md spec answer 1, model)
//   C2_cd                    LEVEL >= SHUT_LVL -> CD = 0 (all three)
//   C2_hr                    ... and on a HIST_RESET record (ring filled with INFLOW): NOT_FILLING = (INFLOW <= 0)
//   C3_hr                    HIST_RESET, below shutdown: NOT_FILLING = (INFLOW <= 0); INFLOW <= 0 -> all 0xFFFF
//   C5_nf                    below shutdown, NOT_FILLING (mean <= 0, so min <= 0) -> p50 = p90 = 0xFFFF
//   C5_q                     below shutdown, INFLOW <= 0 (it is in the ring, so min <= 0) -> p90 = 0xFFFF
//   (history: shadow ring of every slot, bmc from reset)
//   C4_nf                    NOT_FILLING == (shadow mean <= 0), tripped or not (C2's NOT_FILLING clause too)
//   C5_m10, C5_m50, C5_m90   below shutdown: shadow max / mean / min <= 0 -> that value is 0xFFFF
//   (real arithmetic, rtl/eog_mul.sv + rtl/eog_div.sv, bmc_arith)
//   C6_p10, C6_p50, C6_p90   each value equals m(q) on the shadow's max / mean / min
//   C5_ord                   below shutdown, all three finite (< 0xFFFF) -> p10 <= p50 <= p90
//   C3_eq                    a fill (first VALID/HELD after reset or HIST_RESET), below shutdown: p10 = p50 = p90
// C3 (fill) and C4 (ring = last 2^CD_LOG2 VALID/HELD INFLOW values after the fill) are the shadow itself; the DUT's
// ring is compared through NOT_FILLING (mean, always) and the quotients (bmc_arith: max, mean, min). C7 (slot
// independence) and C1's "no ring change": the shadow is per slot and only VALID/HELD in-range records push, only
// non-DROPPED HIST_RESET records clear; every record is checked against its own slot while records of the other
// slot, INVALID, DROPPED and FAC >= N_FAC records interleave freely.
//
// ---- Assumptions on the environment ----
//   - handshake + REC_NO counter (u_in, u_stage.st_recno_in); first cycle in reset (eog_fv_init)
//   - a_status: STATUS is 0 VALID, 1 HELD, 3 INVALID or 4 DROPPED (conventions §3: 2 is never produced)
//   - a_hrdrop: HIST_RESET = 0 on DROPPED records (conventions §3 v4: "never on DROPPED")
//   - CONFIG rows of slots 0..N_FAC-1 are constants (anyconst; conventions §5) with K_CD < 2^24 (numerics §7 and
//     §10: the ingest refuses larger; the spec's multiplier is 24 x 17); rows of slots >= N_FAC are free every cycle
//   - FV_ARITH only: K_CD < 2^A_KB, SHUT_LVL < 2^A_SB, LEVEL and INFLOW sign-extended from A_LB / A_IB bits
//     (structural, so multipliers and dividers shrink; see the .sby)
// Nothing else about the input is assumed (FAC, HIST_RESET on VALID/HELD/INVALID, LEVEL, INFLOW, FEAT are free).
//
// Defines: FV_PROVE (record-local checks + pass-through; no shadow), FV_ARITH (real arithmetic, C6/C5_ord/C3_eq),
//          FV_COVER (cover goals). The history tasks leave out the pass-through checks (H_*), which `prove` covers,
//          so the FEAT datapath falls out of the cone of influence.

`default_nettype none

module fv_eog_countdown #(
    parameter integer N_FAC   = 2,
    parameter integer CD_LOG2 = 2,     // ring depth 2^CD_LOG2 (spec: formal may set 2; RTL default 4)
    parameter integer II      = 16,    // DUT parameter (64: one record at a time, used by `prove`)
    parameter integer II_CHK  = 16,    // eog_fv_stage II_MAX  (0 = not checked)
    parameter integer LAT_CHK = 128,   // eog_fv_stage LAT_MAX (0 = not checked)
    parameter integer RW      = 8,     // REC_NO low bits compared by eog_fv_stage
    parameter integer A_KB    = 15,    // FV_ARITH: K_CD < 2^A_KB
    parameter integer A_SB    = 10,    // FV_ARITH: SHUT_LVL < 2^A_SB
    parameter integer A_LB    = 11,    // FV_ARITH: LEVEL in [-2^(A_LB-1), 2^(A_LB-1))
    parameter integer A_IB    = 5      // FV_ARITH: INFLOW in [-2^(A_IB-1), 2^(A_IB-1))
) (
    input  logic         clk,          // top-level inputs are free: the solver drives them
    input  logic         rst_n,
    input  logic         in_valid,
    input  logic [645:0] in_bus,       // becomes in_data (bus M); narrowed in FV_ARITH
    input  logic         out_ready
);
    `include "eog_defs.svh"

    localparam integer CD_N = 1 << CD_LOG2;              // ring entries
    localparam integer SW   = 16 + CD_LOG2;              // ring sum width (signed)
    localparam integer PB   = CD_LOG2 + 1;               // pushes since the fill, saturating at CD_N
    localparam integer HW   = EOG_BM_RULES4;             // header + FEAT, same offsets on bus M and bus C (610)
    localparam logic [15:0] NONE = 16'hFFFF;             // EOG_CD_NONE

    localparam logic [1:0] K_NONE = 2'd0;                // INVALID / DROPPED
    localparam logic [1:0] K_OOB  = 2'd1;                // VALID/HELD with FAC >= N_FAC (TASKS.md answer 1)
    localparam logic [1:0] K_TRIP = 2'd2;                // VALID/HELD, LEVEL >= SHUT_LVL
    localparam logic [1:0] K_COMP = 2'd3;                // VALID/HELD, LEVEL <  SHUT_LVL

    // ---------------------------------------------------------------------------------------------------------
    // Input bus
    logic [645:0] in_data;
`ifdef FV_ARITH
    assign in_data = {{(16 - A_LB){in_bus[EOG_BM_LEVEL + A_LB - 1]}}, in_bus[EOG_BM_LEVEL +: A_LB],
                      {(16 - A_IB){in_bus[EOG_BM_INFLOW + A_IB - 1]}}, in_bus[EOG_BM_INFLOW +: A_IB],
                      in_bus[EOG_BM_INFLOW - 1:0]};
`else
    assign in_data = in_bus;
`endif

    // ---------------------------------------------------------------------------------------------------------
    // CONFIG rows: one constant row per slot 0..N_FAC-1 (conventions §5), K_CD < 2^24; free for slots >= N_FAC.
    // (Constant-index loops instead of variable part-selects: no $shiftx, no x bits, small AIG.)
    (* anyconst *) logic [N_FAC*512-1:0] f_rows_any;
    logic [N_FAC*512-1:0] f_rows;
    always_comb begin
        f_rows = f_rows_any;
        for (int s = 0; s < N_FAC; s++) begin
            f_rows[s*512 + EOG_CFG_K_CD + 24 +: 8] = '0;
`ifdef FV_ARITH
            f_rows[s*512 + EOG_CFG_K_CD + A_KB +: (24 - A_KB)]     = '0;
            f_rows[s*512 + EOG_CFG_SHUT_LVL + A_SB +: (16 - A_SB)] = '0;
`endif
        end
    end

    logic [4:0]   cfg_fac;
    logic [511:0] cfg_row;
    logic [511:0] f_row_oob;
    assign f_row_oob = $anyseq;
    always_comb begin
        cfg_row = f_row_oob;
        for (int s = 0; s < N_FAC; s++) if (cfg_fac == s) cfg_row = f_rows[s*512 +: 512];
    end

    // ---------------------------------------------------------------------------------------------------------
    // DUT
    logic         in_ready, out_valid;
    logic [662:0] out_data;
    logic [7:0]   dut_inflight;
    logic [31:0]  dut_oldest;

    eog_countdown #(.N_FAC(N_FAC), .II(II), .CD_LOG2(CD_LOG2)) dut (
        .clk           (clk),
        .rst_n         (rst_n),
        .in_valid      (in_valid),
        .in_ready      (in_ready),
        .in_data       (in_data),
        .out_valid     (out_valid),
        .out_ready     (out_ready),
        .out_data      (out_data),
        .cfg_fac       (cfg_fac),
        .cfg_row       (cfg_row),
        .f_inflight    (dut_inflight),
        .f_oldest_recno(dut_oldest)
    );

    // ---------------------------------------------------------------------------------------------------------
    // Shared checkers: reset, handshake on both links, stage contract
    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    eog_fv_axis #(.W(646), .ASSUME(1)) u_in (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(in_valid), .ready(in_ready), .data(in_data));
    eog_fv_axis #(.W(663), .ASSUME(0)) u_out (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(out_valid), .ready(out_ready), .data(out_data));

    logic [RW-1:0] f_in_cnt, f_out_cnt;
    logic [7:0]    f_in_flight;
    eog_fv_stage #(.RW(RW), .MAX_INFLIGHT(8), .II_MAX(II_CHK), .LAT_MAX(LAT_CHK), .SWEEP(N_FAC + 8)) u_stage (
        .clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .in_valid(in_valid), .in_ready(in_ready), .in_recno(in_data[EOG_BM_REC_NO +: RW]),
        .out_valid(out_valid), .out_ready(out_ready), .out_recno(out_data[EOG_BC_REC_NO +: RW]),
        .excl(1'b0), .dut_inflight(dut_inflight), .dut_oldest(dut_oldest),
        .f_in_cnt(f_in_cnt), .f_out_cnt(f_out_cnt), .f_in_flight(f_in_flight));

    logic in_fire, out_fire;
    assign in_fire  = in_valid && in_ready;
    assign out_fire = out_valid && out_ready;

    // ---------------------------------------------------------------------------------------------------------
    // Input record decode
    logic [2:0]         i_st;
    logic [4:0]         i_fac;
    logic               i_hr;
    logic signed [15:0] i_inflow, i_level;
    logic [15:0]        i_shut;
    logic [23:0]        i_k;
    logic [511:0]       i_row;
    logic               i_vh, i_in, i_upd, i_clr, i_trip;
    logic [16:0]        i_dl;
    logic [1:0]         i_kind;

    assign i_st     = in_data[EOG_BM_STATUS +: 3];
    assign i_fac    = in_data[EOG_BM_FAC +: 5];
    assign i_hr     = in_data[EOG_BM_HIST_RESET];
    assign i_inflow = in_data[EOG_BM_INFLOW +: 16];
    assign i_level  = in_data[EOG_BM_LEVEL +: 16];
    always_comb begin
        i_row = '0;
        for (int s = 0; s < N_FAC; s++) if (i_fac == s) i_row = f_rows[s*512 +: 512];
    end
    assign i_shut   = i_row[EOG_CFG_SHUT_LVL +: 16];
    assign i_k      = i_row[EOG_CFG_K_CD +: 24];
    assign i_vh     = (i_st == EOG_ST_VALID) || (i_st == EOG_ST_HELD);
    assign i_in     = (i_fac < N_FAC);
    assign i_upd    = i_vh && i_in;                                     // pushes into slot i_fac
    assign i_clr    = i_hr && (i_st != EOG_ST_DROPPED) && i_in;         // clears has[i_fac] first
    assign i_trip   = $signed({i_level[15], i_level}) >= $signed({1'b0, i_shut});
    assign i_dl     = {1'b0, i_shut} - {i_level[15], i_level};          // Δ (1..98303 when not tripped)
    assign i_kind   = !i_vh ? K_NONE : !i_in ? K_OOB : i_trip ? K_TRIP : K_COMP;

    always_comb if (in_valid) begin
        a_status: assume (i_st == EOG_ST_VALID || i_st == EOG_ST_HELD || i_st == EOG_ST_INVALID ||
                          i_st == EOG_ST_DROPPED);
        a_hrdrop: assume (!(i_st == EOG_ST_DROPPED && i_hr));
    end

    // ---------------------------------------------------------------------------------------------------------
    // Shadow ring of every slot (not in FV_PROVE: history is not port-inductive). Slot s, entry i (0 = newest) at
    // sh_ring[(s*CD_N + i)*16 +: 16].
`ifndef FV_PROVE
    logic [N_FAC*CD_N*16-1:0] sh_ring;
    logic [N_FAC-1:0]         sh_has;
    logic [N_FAC*PB-1:0]      sh_push;

    logic [CD_N*16-1:0]        o_ring, x_ring;
    logic                      o_has, x_fill;
    logic [PB-1:0]             o_p, x_p;
    logic signed [SW-1:0]      x_sum;
    logic signed [15:0]        x_mean, x_max, x_min, x_e;
    always_comb begin
        o_ring = '0;
        o_has  = 1'b0;
        o_p    = '0;
        for (int s = 0; s < N_FAC; s++) if (i_fac == s) begin
            o_ring = sh_ring[s*CD_N*16 +: CD_N*16];
            o_has  = sh_has[s];
            o_p    = sh_push[s*PB +: PB];
        end
        x_fill = !o_has || i_hr;                       // a non-DROPPED HIST_RESET clears first (DROPPED: no HR)
        if (x_fill) x_ring = {CD_N{i_inflow}};
        else        x_ring = {o_ring[(CD_N-1)*16-1:0], i_inflow};
        if (x_fill)                  x_p = '0;
        else if (o_p >= PB'(CD_N))   x_p = PB'(CD_N);
        else                         x_p = o_p + 1'b1;
        x_sum = '0;
        x_max = 16'sh8000;
        x_min = 16'sh7FFF;
        for (int i = 0; i < CD_N; i++) begin
            x_e   = x_ring[i*16 +: 16];
            x_sum = x_sum + SW'(x_e);
            if (x_e > x_max) x_max = x_e;
            if (x_e < x_min) x_min = x_e;
        end
        x_mean = 16'(x_sum >>> CD_LOG2);
    end

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            sh_has  <= '0;   // reset clears every slot (conventions §1)
            sh_push <= '0;
        end else if (in_fire) begin
            for (int s = 0; s < N_FAC; s++) if (i_fac == s) begin
                if (i_clr) sh_has[s] <= 1'b0;
                if (i_upd) begin
                    sh_ring[s*CD_N*16 +: CD_N*16] <= x_ring;
                    sh_has[s]                     <= 1'b1;
                    sh_push[s*PB +: PB]           <= x_p;
                end
            end
        end
    end
`endif

    // ---------------------------------------------------------------------------------------------------------
    // Tracked record: the one whose REC_NO low bits equal the anyconst f_k (so: every record)
    (* anyconst *) logic [RW-1:0] f_k;

    logic          trk_v;            // accepted, output not yet transferred
    logic [645:0]  trk_in;
    logic [1:0]    trk_kind;
    logic          trk_qle0;         // INFLOW <= 0
    always_ff @(posedge clk) begin
        if (!rst_n) trk_v <= 1'b0;
        else begin
            if (out_fire && f_out_cnt == f_k) trk_v <= 1'b0;
            if (in_fire && f_in_cnt == f_k)   trk_v <= 1'b1;
        end
        if (in_fire && f_in_cnt == f_k) begin
            trk_in   <= in_data;
            trk_kind <= i_kind;
            trk_qle0 <= (i_inflow <= 0);
        end
    end

`ifndef FV_PROVE
    logic               trk_fill, trk_wrap, trk_had;
    logic signed [15:0] trk_max, trk_mean, trk_min;
    always_ff @(posedge clk) if (in_fire && f_in_cnt == f_k) begin
        trk_fill <= x_fill;
        trk_had  <= o_has;                        // the slot had a ring (cover: re-fill by HIST_RESET)
        trk_wrap <= !x_fill && (x_p == PB'(CD_N)); // CD_N pushes since the fill: every prefilled value is gone
        trk_max  <= x_max;
        trk_mean <= x_mean;
        trk_min  <= x_min;
    end
`endif

`ifdef FV_ARITH
    // numerator K·Δ (24 x 17 bits, numerics §7), exact
    logic [47:0] i_a, trk_a;
    assign i_a = {24'd0, i_k} * {31'd0, i_dl};
    always_ff @(posedge clk) if (in_fire && f_in_cnt == f_k) trk_a <= i_a;

    // m(q) = q <= 0 ? 0xFFFF : min(a // (q << 8), 0xFFFF), checked as a relation on the DUT's value p
    function automatic logic m_ok(input logic [15:0] p, input logic [47:0] a, input logic signed [15:0] q);
        logic [47:0] b, pb;
        b  = {17'd0, q[14:0], 8'd0};                 // q << 8 (q > 0)
        pb = {32'd0, p} * b;
        if (q <= 0)           m_ok = (p == NONE);
        else if (p == NONE)   m_ok = (a >= pb);      // a // b >= 0xFFFF
        else                  m_ok = (pb <= a) && (a < pb + b);
    endfunction
`endif

    // harness invariant: trk_v <-> record f_k is in flight (f_out_cnt <= f_k < f_in_cnt, mod 2^RW)
    logic [RW-1:0] f_kd;
    assign f_kd = f_k - f_out_cnt;
    always_comb if (f_past_valid && rst_n)
        f_trk: assert (trk_v == (f_kd < {{(RW-8){1'b0}}, f_in_flight}));

    // ---------------------------------------------------------------------------------------------------------
    // Output of the tracked record
    logic        chk;
    logic [15:0] o_p10, o_p50, o_p90;
    logic        o_nf;
    assign chk   = f_past_valid && rst_n && out_valid && trk_v && (f_out_cnt == f_k);
    assign o_p10 = out_data[EOG_BC_CD      +: 16];
    assign o_p50 = out_data[EOG_BC_CD + 16 +: 16];
    assign o_p90 = out_data[EOG_BC_CD + 32 +: 16];
    assign o_nf  = out_data[EOG_BC_RULES + EOG_RULE_NOT_FILLING];

    always_comb if (chk) begin
`ifdef FV_PROVE
        H_hdr:   assert (out_data[EOG_BC_FEAT-1:0] == trk_in[EOG_BM_FEAT-1:0]);
        H_feat:  assert (out_data[EOG_BC_FEAT +: EOG_BC_FEAT_W] == trk_in[EOG_BM_FEAT +: EOG_BM_FEAT_W]);
        H_rules: assert (out_data[EOG_BC_RULES +: 4] == trk_in[EOG_BM_RULES4 +: 4]);
`endif
        if (trk_kind == K_NONE) begin
            C1_cd:  assert (out_data[EOG_BC_CD +: 48] == {NONE, NONE, NONE});
            C1_nf:  assert (!o_nf);
        end
        if (trk_kind == K_OOB) begin
            C1x_cd: assert (out_data[EOG_BC_CD +: 48] == {NONE, NONE, NONE});
            C1x_nf: assert (!o_nf);
        end
        if (trk_kind == K_TRIP) begin
            C2_cd:  assert (out_data[EOG_BC_CD +: 48] == 48'd0);
            if (trk_in[EOG_BM_HIST_RESET]) C2_hr: assert (o_nf == trk_qle0);
        end
        if (trk_kind == K_COMP) begin
            if (trk_in[EOG_BM_HIST_RESET]) begin
                C3_hr: assert (o_nf == trk_qle0 &&
                               (!trk_qle0 || (o_p10 == NONE && o_p50 == NONE && o_p90 == NONE)));
            end
            if (o_nf)     C5_nf: assert (o_p50 == NONE && o_p90 == NONE);
            if (trk_qle0) C5_q:  assert (o_p90 == NONE);
        end
`ifndef FV_PROVE
        if (trk_kind == K_TRIP || trk_kind == K_COMP) begin
            C4_nf: assert (o_nf == (trk_mean <= 0));
        end
        if (trk_kind == K_COMP) begin
            if (trk_max <= 0)  C5_m10: assert (o_p10 == NONE);
            if (trk_mean <= 0) C5_m50: assert (o_p50 == NONE);
            if (trk_min <= 0)  C5_m90: assert (o_p90 == NONE);
        end
`endif
`ifdef FV_ARITH
        if (trk_kind == K_COMP) begin
            C6_p10: assert (m_ok(o_p10, trk_a, trk_max));
            C6_p50: assert (m_ok(o_p50, trk_a, trk_mean));
            C6_p90: assert (m_ok(o_p90, trk_a, trk_min));
            if (o_p10 != NONE && o_p50 != NONE && o_p90 != NONE)
                C5_ord: assert (o_p10 <= o_p50 && o_p50 <= o_p90);
            if (trk_fill)
                C3_eq: assert (o_p10 == o_p50 && o_p50 == o_p90);
        end
`endif
    end

    // ---------------------------------------------------------------------------------------------------------
    // Cover goals (spec: tripped, not filling, finite, a ring that has wrapped; plus fills and record kinds)
`ifdef FV_COVER
    always_comb if (f_past_valid && rst_n) begin
        cv_trip:   cover (chk && trk_kind == K_TRIP);
        cv_nf:     cover (chk && trk_kind == K_COMP && o_nf);
        cv_fin:    cover (chk && trk_kind == K_COMP && o_p10 != NONE && o_p50 != NONE && o_p90 != NONE);
        cv_mix:    cover (chk && trk_kind == K_COMP && !o_nf && o_p10 != NONE && o_p90 == NONE);
        cv_wrap:   cover (chk && trk_kind == K_COMP && trk_wrap);
        cv_refill: cover (chk && trk_kind == K_COMP && trk_fill && trk_had);
        cv_inv:    cover (chk && trk_kind == K_NONE && trk_in[EOG_BM_STATUS +: 3] == EOG_ST_INVALID);
        cv_drop:   cover (chk && trk_kind == K_NONE && trk_in[EOG_BM_STATUS +: 3] == EOG_ST_DROPPED);
        cv_oob:    cover (chk && trk_kind == K_OOB);
        cv_bp:     cover (out_valid && !out_ready && f_in_flight >= 8'd2);
    end
`endif
endmodule

`default_nettype wire
