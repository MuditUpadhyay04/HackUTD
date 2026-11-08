// fv_eog_countdown.sv — formal harness for eog_countdown (Verify role, task T1.countdown.fv).
//   bash scripts/formal.sh countdown        (formal/countdown/eog_countdown.sby; task split and depths are there)
//
// Written from spec/modules/eog_countdown.md, spec/numerics.md §7, spec/conventions.md §1-§3 and §7 (spec v2,
// FROZEN) and the lead's answers in FPGA/TASKS.md; only the DUT's port list (spec port table) is used.
//
// DUT ports: clk, rst_n, in_valid/in_ready/in_data (bus M, 646 b), out_valid/out_ready/out_data (bus C, 663 b),
// cfg_fac[4:0] -> cfg_row[511:0] (combinational CONFIG row, modelled as one anyconst row per slot), and the
// formal-only observation ports f_inflight[7:0] / f_oldest_recno[31:0] (conventions §7).
//
// ---- What is checked (labels; the .sby says which task checks which) ----
// Stage contract (conventions §2-§3, formal/common checkers):
//   u_in.*                 (assume) the upstream follows the handshake; u_stage.st_recno_in (assume) REC_NO counts
//   u_out.ax_reset/ax_hold/ax_data  output handshake
//   u_stage.st_order/st_no_ghost/st_inflight (<= 8)/st_cnt/st_link_n/st_link_r  one in, one out, in order
//   u_stage.st_ii          II <= 16 with in_valid = out_ready = 1, after the N_FAC + 8 reset sweep
//   u_stage.st_lat         latency <= 128 with out_ready = 1
//   f_trk                  harness invariant: the tracked record is in flight exactly when the counters say so
// Per record (the record whose REC_NO low bits are the anyconst f_k, i.e. every record):
//   H_hdr, H_feat, H_rules  header copied, FEAT copied, RULES[3:0] = RULES4 ("Behavior")
//   C1_cd, C1_nf           INVALID/DROPPED -> CD = 3 x 0xFFFF, NOT_FILLING = 0
//   C1x_cd, C1x_nf         VALID/HELD with FAC >= N_FAC: treated like INVALID (TASKS.md spec answer 1: an
//                          out-of-range FAC never touches state; the model gives 3 x 0xFFFF, NOT_FILLING = 0)
//   C2_cd, C2_nf           VALID/HELD, LEVEL >= SHUT_LVL (signed, SHUT_LVL zero-extended) -> CD = 0, NF = 0
//   C3_nfcd                NOT_FILLING = 1 -> all three 0xFFFF (sum == 0 means every divisor is 0)
//   C5_qpos                INFLOW > 0 -> NOT_FILLING = 0 (the pushed value is in the ring, so sum > 0)
//   C5_qzero               INFLOW <= 0 -> p90 = 0xFFFF (the pushed 0 is in the ring, so min = 0)
//   C5_hr                  HIST_RESET -> NOT_FILLING = (INFLOW <= 0) (ring = {q}, n = 1)
//   (history, shadow ring of every slot; bmc from reset)
//   C3_sum0                NOT_FILLING == (sum of the shadow ring after the push == 0)
//   C5_min0                min of the shadow ring == 0 -> p90 = 0xFFFF
//   (real arithmetic, rtl/eog_mul.sv + rtl/eog_div.sv; bmc_arith)
//   C6_p10, C6_p50, C6_p90 each value equals div() of numerics §7 on the shadow ring's n/sum/max/min
//   C4_order               all three finite (< 0xFFFF) -> p10 <= p50 <= p90
// C5 (ring) and C7 (slot independence) are carried by the shadow: it keeps the last n values of max(INFLOW, 0)
// per slot exactly as numerics §7 says (HIST_RESET clears before the push, n saturates at CD_N, only VALID/HELD
// in-range records push), and C3_sum0 / C5_min0 / C6_* compare every record with its own slot's shadow while
// records of the other slot, INVALID, DROPPED and FAC >= N_FAC records interleave freely. A ring that keeps a
// value too long, drops one too early, miscounts n, lets another slot or a non-pushing record change it, or is
// not cleared by HIST_RESET makes NOT_FILLING (always) or a quotient (bmc_arith) disagree. C1's "no state change"
// is checked the same way (the shadow ignores those records).
//
// ---- Assumptions on the environment ----
//   - handshake + REC_NO counter (above); first cycle in reset (eog_fv_init)
//   - STATUS of an input is one of 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (conventions §3: 2 is never produced)
//   - CONFIG rows of slots 0..N_FAC-1 are constants (anyconst; conventions §5); rows of slots >= N_FAC are free
//     every cycle (the DUT must not use them)
//   - FV_ARITH only: K_CD < 2^A_KB, SHUT_LVL < 2^A_SB, LEVEL and INFLOW sign-extended from A_LB / A_IB bits
//     (structural, so the multipliers and dividers shrink; see the .sby). K_CD < 2^24 is the ingest contract
//     (numerics §10, "numerator <= 48 bits" in §7).
// Nothing else about the input is assumed: HIST_RESET, FAC, LEVEL, INFLOW, FEAT, ... are free for every status.
//
// Defines: FV_PROVE (record-local properties only; no shadow), FV_ARITH (real arithmetic + C4/C6),
//          FV_COVER (cover goals).

`default_nettype none

module fv_eog_countdown #(
    parameter integer N_FAC   = 2,
    parameter integer CD_N    = 4,
    parameter integer II      = 16,    // DUT parameter (64: one record at a time, used by `prove`)
    parameter integer II_CHK  = 16,    // eog_fv_stage II_MAX  (0 = not checked)
    parameter integer LAT_CHK = 128,   // eog_fv_stage LAT_MAX (0 = not checked)
    parameter integer RW      = 8,     // REC_NO low bits compared by eog_fv_stage
    parameter integer A_KB    = 14,    // FV_ARITH: K_CD < 2^A_KB
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

    localparam integer QW = 15;                           // ring entries: max(INFLOW, 0), u15
    localparam integer NB = $clog2(CD_N + 1);             // n = 0..CD_N
    localparam integer PB = $clog2(CD_N + 2);             // pushes since HIST_RESET, saturating at CD_N + 1
    localparam integer HW = EOG_BM_RULES4;                // header + FEAT, same offsets on bus M and bus C (610)
    localparam logic [15:0] NONE = 16'hFFFF;              // EOG_CD_NONE

    localparam logic [1:0] K_NONE = 2'd0;                 // INVALID / DROPPED
    localparam logic [1:0] K_OOB  = 2'd1;                 // VALID/HELD with FAC >= N_FAC (TASKS.md answer 1)
    localparam logic [1:0] K_TRIP = 2'd2;                 // VALID/HELD, LEVEL >= SHUT_LVL
    localparam logic [1:0] K_COMP = 2'd3;                 // VALID/HELD, LEVEL <  SHUT_LVL

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
    // CONFIG rows: one constant row per slot 0..N_FAC-1 (conventions §5); free for slots >= N_FAC
    (* anyconst *) logic [N_FAC*512-1:0] f_rows_any;
    logic [N_FAC*512-1:0] f_rows;
    always_comb begin
        f_rows = f_rows_any;
`ifdef FV_ARITH
        for (int s = 0; s < N_FAC; s++) begin
            f_rows[s*512 + EOG_CFG_K_CD + A_KB +: (32 - A_KB)]         = '0;
            f_rows[s*512 + EOG_CFG_SHUT_LVL + A_SB +: (16 - A_SB)] = '0;
        end
`endif
    end

    // (constant-index loops instead of variable part-selects: no $shiftx, no x bits, small AIG)
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

    eog_countdown #(.N_FAC(N_FAC), .II(II), .CD_N(CD_N)) dut (
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
    // Input record decode (numerics §7)
    logic [2:0]    i_st;
    logic [4:0]    i_fac;
    logic          i_hr;
    logic [15:0]   i_inflow, i_level, i_shut;
    logic [31:0]   i_k;
    logic [511:0]  i_row;
    logic          i_vh, i_upd, i_trip;
    logic [QW-1:0] i_q;
    logic [16:0]   i_dl;
    logic [1:0]    i_kind;

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
    assign i_k      = i_row[EOG_CFG_K_CD +: 32];
    assign i_vh     = (i_st == EOG_ST_VALID) || (i_st == EOG_ST_HELD);
    assign i_upd    = i_vh && (i_fac < N_FAC);                         // pushes into slot i_fac
    assign i_trip   = $signed({i_level[15], i_level}) >= $signed({1'b0, i_shut});
    assign i_q      = i_inflow[15] ? '0 : i_inflow[14:0];             // max(INFLOW, 0)
    assign i_dl     = {1'b0, i_shut} - {i_level[15], i_level};        // Δ (u17 when not tripped)
    assign i_kind   = !i_vh ? K_NONE : !i_upd ? K_OOB : i_trip ? K_TRIP : K_COMP;

    always_comb if (in_valid)
        a_status: assume (i_st == EOG_ST_VALID || i_st == EOG_ST_HELD || i_st == EOG_ST_INVALID ||
                          i_st == EOG_ST_DROPPED);

    // ---------------------------------------------------------------------------------------------------------
    // Shadow ring of every slot (not in FV_PROVE: history is not port-inductive). Slot s, age i (0 = newest) at
    // sh_ring[(s*CD_N + i)*QW +: QW]; entries i >= n are don't-care.
`ifndef FV_PROVE
    logic [N_FAC*CD_N*QW-1:0] sh_ring;
    logic [N_FAC*NB-1:0]      sh_n;
    logic [N_FAC*PB-1:0]      sh_push;

    logic [CD_N*QW-1:0] o_ring, x_ring;
    logic [NB-1:0]      o_n, x_n;
    logic [PB-1:0]      o_p, x_p;
    logic [18:0]        x_sum;
    logic [QW-1:0]      x_max, x_min, x_e;
    logic               x_evnz;      // the push dropped a nonzero oldest value (cover only)
    always_comb begin
        o_ring = '0;
        o_n    = '0;
        o_p    = '0;
        for (int s = 0; s < N_FAC; s++) if (i_fac == s) begin
            o_ring = sh_ring[s*CD_N*QW +: CD_N*QW];
            o_n    = sh_n[s*NB +: NB];
            o_p    = sh_push[s*PB +: PB];
        end
        x_ring = {o_ring[(CD_N-1)*QW-1:0], i_q};
        if (i_hr)                         x_n = NB'(1);
        else if (o_n >= NB'(CD_N))        x_n = NB'(CD_N);
        else                              x_n = o_n + 1'b1;
        if (i_hr)                         x_p = PB'(1);
        else if (o_p >= PB'(CD_N + 1))    x_p = PB'(CD_N + 1);
        else                              x_p = o_p + 1'b1;
        x_evnz = !i_hr && (o_n >= NB'(CD_N)) && (o_ring[(CD_N-1)*QW +: QW] != '0);
        x_sum  = '0;
        x_max  = '0;
        x_min  = '1;
        for (int i = 0; i < CD_N; i++) begin
            x_e = x_ring[i*QW +: QW];
            if (i < x_n) begin
                x_sum = x_sum + {4'd0, x_e};
                if (x_e > x_max) x_max = x_e;
                if (x_e < x_min) x_min = x_e;
            end
        end
    end

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            sh_n    <= '0;   // reset clears every slot (conventions §1)
            sh_push <= '0;
        end else if (in_fire && i_upd) begin
            for (int s = 0; s < N_FAC; s++) if (i_fac == s) begin
                sh_ring[s*CD_N*QW +: CD_N*QW] <= x_ring;
                sh_n[s*NB +: NB]              <= x_n;
                sh_push[s*PB +: PB]           <= x_p;
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
    logic          trk_q0;           // INFLOW <= 0
    always_ff @(posedge clk) begin
        if (!rst_n) trk_v <= 1'b0;
        else begin
            if (out_fire && f_out_cnt == f_k) trk_v <= 1'b0;
            if (in_fire && f_in_cnt == f_k)   trk_v <= 1'b1;
        end
        if (in_fire && f_in_cnt == f_k) begin
            trk_in   <= in_data;
            trk_kind <= i_kind;
            trk_q0   <= (i_q == '0);
        end
    end

`ifndef FV_PROVE
    logic          trk_sum0, trk_min0, trk_wrap, trk_evnz;
    logic [18:0]   trk_sum;
    logic [QW-1:0] trk_max, trk_min;
    always_ff @(posedge clk) if (in_fire && f_in_cnt == f_k) begin
        trk_sum0 <= (x_sum == '0);
        trk_min0 <= (x_min == '0);
        trk_wrap <= (x_p == PB'(CD_N + 1));   // CD_N + 1 pushes since HIST_RESET: the oldest was dropped
        trk_evnz <= x_evnz;
        trk_sum  <= x_sum;
        trk_max  <= x_max;
        trk_min  <= x_min;
    end
`endif

`ifdef FV_ARITH
    // numerators (numerics §7): K·Δ and K·Δ·n, exact (K < 2^A_KB here, so they fit 48 bits as the spec says)
    logic [51:0] i_a10, i_a50, trk_a10, trk_a50;
    assign i_a10 = {20'd0, i_k} * {35'd0, i_dl};
    assign i_a50 = i_a10 * {{(52 - NB){1'b0}}, x_n};
    always_ff @(posedge clk) if (in_fire && f_in_cnt == f_k) begin
        trk_a10 <= i_a10;
        trk_a50 <= i_a50;
    end

    // div(a, b) = b == 0 ? 0xFFFF : min(floor(a / b), 0xFFFF), checked as a relation on the DUT's value p
    function automatic logic div_ok(input logic [15:0] p, input logic [51:0] a, input logic [18:0] x);
        logic [51:0] b, pb;
        b  = {25'd0, x, 8'd0};                       // x · 256
        pb = {36'd0, p} * b;
        if (b == '0)          div_ok = (p == NONE);
        else if (p == NONE)   div_ok = (a >= pb);    // floor(a / b) >= 0xFFFF
        else                  div_ok = (pb <= a) && (a < pb + b);
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
        H_hdr:   assert (out_data[EOG_BC_FEAT-1:0] == trk_in[EOG_BM_FEAT-1:0]);
        H_feat:  assert (out_data[EOG_BC_FEAT +: EOG_BC_FEAT_W] == trk_in[EOG_BM_FEAT +: EOG_BM_FEAT_W]);
        H_rules: assert (out_data[EOG_BC_RULES +: 4] == trk_in[EOG_BM_RULES4 +: 4]);

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
            C2_nf:  assert (!o_nf);
        end
        if (trk_kind == K_COMP) begin
            if (o_nf)   C3_nfcd:  assert (o_p10 == NONE && o_p50 == NONE && o_p90 == NONE);
            if (!trk_q0) C5_qpos:  assert (!o_nf);
            if (trk_q0)  C5_qzero: assert (o_p90 == NONE);
            if (trk_in[EOG_BM_HIST_RESET]) C5_hr: assert (o_nf == trk_q0);
`ifndef FV_PROVE
            C3_sum0: assert (o_nf == trk_sum0);
            if (trk_min0) C5_min0: assert (o_p90 == NONE);
`endif
`ifdef FV_ARITH
            C6_p10: assert (div_ok(o_p10, trk_a10, {4'd0, trk_max}));
            C6_p50: assert (div_ok(o_p50, trk_a50, trk_sum));
            C6_p90: assert (div_ok(o_p90, trk_a10, {4'd0, trk_min}));
            if (o_p10 != NONE && o_p50 != NONE && o_p90 != NONE)
                C4_order: assert (o_p10 <= o_p50 && o_p50 <= o_p90);
`endif
        end
    end

    // ---------------------------------------------------------------------------------------------------------
    // Cover goals (spec: each branch, a full ring wrapping; plus the record kinds and back-pressure)
`ifdef FV_COVER
    always_comb if (f_past_valid && rst_n) begin
        cv_trip:    cover (chk && trk_kind == K_TRIP);
        cv_nf:      cover (chk && trk_kind == K_COMP && o_nf);
        cv_fin:     cover (chk && trk_kind == K_COMP && o_p10 != NONE && o_p50 != NONE && o_p90 != NONE);
        cv_mix:     cover (chk && trk_kind == K_COMP && o_p10 != NONE && o_p90 == NONE);
        cv_wrap:    cover (chk && trk_kind == K_COMP && trk_wrap);
        cv_wrap_nf: cover (chk && trk_kind == K_COMP && trk_wrap && trk_evnz && o_nf);
        cv_inv:     cover (chk && trk_kind == K_NONE && trk_in[EOG_BM_STATUS +: 3] == EOG_ST_INVALID);
        cv_drop:    cover (chk && trk_kind == K_NONE && trk_in[EOG_BM_STATUS +: 3] == EOG_ST_DROPPED);
        cv_oob:     cover (chk && trk_kind == K_OOB);
        cv_bp:      cover (out_valid && !out_ready && f_in_flight >= 8'd2);
    end
`endif
endmodule

`default_nettype wire
