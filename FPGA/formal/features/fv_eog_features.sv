// fv_eog_features.sv -- formal harness for eog_features (task T1.features.fv, Verify role).
//
// Written from spec/modules/eog_features.md, spec/numerics.md §4 and spec/conventions.md §2-§7 (spec v2), not from
// the RTL. Only the DUT's ports are used (including the formal-only f_inflight / f_oldest_recno of conventions §7);
// there are no hierarchical references.
//
// Property labels map to the spec's "Required properties" list:
//   F1_feat0, F1_drop   F1  INVALID/DROPPED -> FEAT0_11 = 0; DROPPED -> RULES4 = 0, PUMP_RUN = 0
//   F2_ch7, F2_ch8      F2  channels 7 / 8 are exactly 16384 / 0 per PUMP_ST (VALID/HELD; 0 otherwise, F1)
//   F3_ch11             F3  channel 11 = 0 when PREV_OK = 0
//   F4_ch               F4  every multiplied channel c in {0..6, 9, 10, 11} that is computed (VALID/HELD; channel 11
//                           only with PREV_OK) equals sat16((x_c*M_c + 2^16) >>> 17) bit for bit (12-bit vector of
//                           per-channel results, one assert: see "Yosys notes")
//   F4_sat                  REASON[FEAT_SAT] = incoming FEAT_SAT | (some computed channel's unsaturated value is
//                           outside [-32768, 32767])
//   F4_zero                 (prove task only, abstract multiplier) a computed channel whose multiplier M_c is 0, or
//                           whose operand x_c is a single field equal to 0 (channels 0, 1, 2, 4, 9), is 0
//   (F4 range)              "every channel lies in [-32768, 32767]" holds for any 16-bit two's complement field;
//                           F4_ch is what gives it content.
//   F5_pf, F5_si,       F5  rule bits 0..3 exactly per numerics.md §4: computed for VALID/HELD/INVALID from fields
//   F5_sd, F5_wl            whose FLD_OK / WELLS_OK bit is set (else 0), DROPPED -> 0, SHUT_IN needs n_wells >= 1
//   F6_gain             F6  REASON only gains bits
//   B_hdr               conventions §3 header pass-through (REC_NO, IN_LAST, FAC_RAW, FAC, TS, STATUS, SINCE_RESET,
//                       HIST_RESET unchanged)
//   B_reason            module spec "Behavior": the only bit features may add is FEAT_SAT, and only for VALID/HELD
//   B_run, B_copy       PUMP_RUN = (PUMP_ST == 1) for VALID/HELD else 0; INFLOW, LEVEL copied from bus V
//   u_in.ax_*           input handshake assumptions, conventions §2 (formal/common eog_fv_axis, ASSUME = 1)
//   u_out.ax_*          output handshake, conventions §2: valid 0 after reset, valid/data held until the transfer
//   u_stage.st_*        stage contract, conventions §3/§7 (formal/common eog_fv_stage): one in -> one out, in order
//                       (REC_NO), nothing lost or invented, f_inflight / f_oldest_recno match, at most MAXF records
//                       held, II <= 16 (st_ii), latency <= 128 (st_lat)
//   H_shadow            harness invariant (true by construction; helps k-induction): the in-flight shadow records
//                       meet the A_* input assumptions
//
// Which multiplier is linked (selected by the .sby task):
//   FV_ABSTRACT_MUL  formal/common/eog_mul_abstract.sv (product unconstrained except 0 for a 0 operand): every
//                    property except F4_ch / F4_sat, plus F4_zero. Task `prove`.
//   FV_CONCAT_MUL    formal/features/eog_mul_concat.sv (cheap injective stand-in P(a, b), see that file): F4_ch and
//                    F4_sat against the same reference with x*M replaced by P(x, M), unbounded. Task `prove_f4`.
//   neither          rtl/eog_mul.sv (the real multiplier): F4_ch / F4_sat with the real product x*M. Tasks `bmc`,
//                    `cover`.
//
// Environment assumptions (the upstream eog_validate's contract, numerics.md §3 / eog_validate.md), labelled A_*:
//   A_status  STATUS is one of 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (2 is never produced; conventions §3).
//   A_fac     a non-DROPPED record's FAC is a configured slot (< N_FAC)                  (numerics §3 step 2)
//   A_ok      a VALID/HELD record has every facility field and every configured well OK
//             (FLD_OK = 7'h7F, WELLS_OK = 1): a lost field makes the record INVALID       (numerics §3 steps 5, 6)
//   A_wells   a non-DROPPED record has WELL_ACT[i] = 0 and WELL_WATER[i] = 0 for i >= n_wells   (numerics §3 step 9)
//             This makes "popcount(WELL_ACT)", "sum of WELL_WATER[i]" and "WELL_ACT == 0" independent of whether
//             a design looks at all 8 slots or only the configured ones.
// Not assumed (so F1 / F5 / B_* are checked against arbitrary garbage): the values, FLD_OK, WELLS_OK, PUMP_ST,
// wells, PREV_* and REASON of INVALID / DROPPED records, and REASON of every record (an incoming FEAT_SAT is kept).
//
// CONFIG rows are per-slot constants ($anyconst) as conventions §5 says; a cfg_fac outside the configured slots
// reads an unconstrained ($anyseq) row (only DROPPED records can carry such a FAC). GLOBAL is a constant.
//
// Reading of the spec where it leaves room (no spec question needed; noted for the lead):
//   - B_copy: for DROPPED records the harness accepts INFLOW / LEVEL either copied or 0. eog_validate sends DROPPED
//     records with all values 0 (numerics §3 step 9), so "copied" (module spec) and "every field a later stage
//     produces is 0" (conventions §3) agree on every input the pipeline can produce.
//   - n_wells = min(CFG.N_WELLS, N_WELL) (TASKS.md spec question 14); the harness keeps N_WELL = 8.
//
// Yosys notes: per-channel / per-well checks are folded into vectors with one labelled assert / assume each
// (labelled asserts inside for-loops can duplicate cell names in Yosys 0.70).

module fv_eog_features (
    input logic clk
);
    `include "eog_defs.svh"

    // ---- shrunk instance ----------------------------------------------------------------------------------
    localparam integer N_FAC = 2;
    localparam integer RW    = 8;     // low REC_NO bits compared by the stage checker
    localparam integer MAXF  = 2;     // records the stage may hold (accepted, output not yet transferred): 1, 2 or 4.
                                      // The spec bounds only II and latency; 2 allows a design with an output
                                      // register next to the record being computed.
    localparam integer VW    = EOG_BV_W;
    localparam integer FW    = EOG_BF_W;
    localparam integer CW    = EOG_CFG_BITS;

    // ---- free inputs ---------------------------------------------------------------------------------------
    logic          rst_n, in_valid, out_ready;
    logic [VW-1:0] in_data;
    assign rst_n     = $anyseq;
    assign in_valid  = $anyseq;
    assign out_ready = $anyseq;
    assign in_data   = $anyseq;

    logic [N_FAC*CW-1:0]   f_rows;   // CONFIG rows of slots 0..N_FAC-1
    logic [CW-1:0]         f_row_x;  // what an unconfigured slot reads
    logic [EOG_G_BITS-1:0] glb;
    assign f_rows  = $anyconst;
    assign f_row_x = $anyseq;
    assign glb     = $anyconst;

    // ---- DUT -----------------------------------------------------------------------------------------------
    logic          in_ready, out_valid;
    logic [FW-1:0] out_data;
    logic [4:0]    cfg_fac;
    logic [CW-1:0] cfg_row;
    logic [7:0]    dut_inflight;
    logic [31:0]   dut_oldest;

    assign cfg_row = (cfg_fac < N_FAC) ? f_rows[cfg_fac * CW +: CW] : f_row_x;

    eog_features #(.N_FAC(N_FAC)) dut (
        .clk(clk), .rst_n(rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data),
        .cfg_fac(cfg_fac), .cfg_row(cfg_row), .glb(glb),
        .f_inflight(dut_inflight), .f_oldest_recno(dut_oldest));

    // ---- shared checkers -----------------------------------------------------------------------------------
    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    eog_fv_axis #(.W(VW), .ASSUME(1)) u_in (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(in_valid), .ready(in_ready), .data(in_data));
    eog_fv_axis #(.W(FW), .ASSUME(0)) u_out (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(out_valid), .ready(out_ready), .data(out_data));

    logic [RW-1:0] f_in_cnt, f_out_cnt;
    logic [7:0]    f_in_flight;
    eog_fv_stage #(.RW(RW), .MAX_INFLIGHT(MAXF), .II_MAX(EOG_II_MAX), .LAT_MAX(128), .SWEEP(0)) u_stage (
        .clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .in_valid(in_valid), .in_ready(in_ready), .in_recno(in_data[EOG_BV_REC_NO +: RW]),
        .out_valid(out_valid), .out_ready(out_ready), .out_recno(out_data[EOG_BF_REC_NO +: RW]),
        .excl(1'b0), .dut_inflight(dut_inflight), .dut_oldest(dut_oldest),
        .f_in_cnt(f_in_cnt), .f_out_cnt(f_out_cnt), .f_in_flight(f_in_flight));

    // ---- input assumptions (upstream contract) -------------------------------------------------------------
    logic [2:0]    i_st;
    logic [4:0]    i_fac;
    logic [CW-1:0] i_row;
    logic [7:0]    i_nw;
    assign i_st  = in_data[EOG_BV_STATUS +: EOG_BV_STATUS_W];
    assign i_fac = in_data[EOG_BV_FAC +: EOG_BV_FAC_W];
    assign i_row = (i_fac < N_FAC) ? f_rows[i_fac * CW +: CW] : f_row_x;
    assign i_nw  = (i_row[EOG_CFG_N_WELLS +: 8] > 8'd8) ? 8'd8 : i_row[EOG_CFG_N_WELLS +: 8];

    logic [7:0] i_wbad;   // well slot i >= n_wells with WELL_ACT or WELL_WATER nonzero
    always_comb
        for (int i = 0; i < 8; i++)
            i_wbad[i] = (i_nw <= i) && (in_data[EOG_BV_WELL_ACT + i] || in_data[EOG_BV_WELL_WATER + 16*i +: 16] != 16'd0);

    always_comb begin
        if (rst_n && in_valid) begin
            A_status: assume (i_st == EOG_ST_VALID || i_st == EOG_ST_HELD || i_st == EOG_ST_INVALID
                              || i_st == EOG_ST_DROPPED);
            if (i_st != EOG_ST_DROPPED) begin
                A_fac:   assume (i_fac < N_FAC);
                A_wells: assume (i_wbad == 8'd0);
            end
            if (i_st == EOG_ST_VALID || i_st == EOG_ST_HELD) begin
                A_ok: assume (in_data[EOG_BV_FLD_OK +: EOG_BV_FLD_OK_W] == 7'h7F && in_data[EOG_BV_WELLS_OK]);
            end
        end
    end

    // ---- shadow of the accepted records (port-only) ---------------------------------------------------------
    // Slot (acceptance number mod MAXF) holds that record. The stage checker asserts at most MAXF in flight and
    // outputs in acceptance order, so slot (f_out_cnt mod MAXF) is the record the current output belongs to.
    localparam logic [1:0] SLOT_MASK = 2'(MAXF - 1);
    logic [MAXF*VW-1:0] f_sh;
    logic [1:0]         f_wi, f_ri;
    assign f_wi = f_in_cnt[1:0]  & SLOT_MASK;
    assign f_ri = f_out_cnt[1:0] & SLOT_MASK;
    always_ff @(posedge clk) if (rst_n && in_valid && in_ready) f_sh[f_wi * VW +: VW] <= in_data;

    // The record the current output must belong to (a same-cycle pass-through is allowed by the checker).
    logic [VW-1:0] e;
    assign e = (f_in_flight == 8'd0) ? in_data : f_sh[f_ri * VW +: VW];

    // H_shadow (harness invariant, true by construction: slots are written from in_data, which meets the A_*
    // assumptions): every in-flight slot holds a record that meets them. Without it k-induction may start from a
    // held record with, e.g., STATUS = 5 or a non-DROPPED FAC >= N_FAC, which the upstream never sends.
    logic [MAXF-1:0] h_bad;
    logic [VW-1:0]   s_r;
    logic [2:0]      s_st;
    logic [4:0]      s_fac;
    logic [7:0]      s_nw;
    logic [1:0]      s_age;
    logic            s_wbad;
    always_comb begin
        h_bad = '0; s_r = '0; s_st = '0; s_fac = '0; s_nw = '0; s_age = '0; s_wbad = 1'b0;
        for (int s = 0; s < MAXF; s++) begin
            s_r    = f_sh[s*VW +: VW];
            s_age  = (2'(s) - f_out_cnt[1:0]) & SLOT_MASK;     // position in the in-flight queue (0 = oldest)
            s_st   = s_r[EOG_BV_STATUS +: EOG_BV_STATUS_W];
            s_fac  = s_r[EOG_BV_FAC +: EOG_BV_FAC_W];
            s_nw   = (s_fac < N_FAC) ? f_rows[s_fac * CW + EOG_CFG_N_WELLS +: 8] : 8'd0;
            s_nw   = (s_nw > 8'd8) ? 8'd8 : s_nw;
            s_wbad = 1'b0;
            for (int i = 0; i < 8; i++)
                if (s_nw <= i && (s_r[EOG_BV_WELL_ACT + i] || s_r[EOG_BV_WELL_WATER + 16*i +: 16] != 16'd0))
                    s_wbad = 1'b1;
            if ({6'd0, s_age} < f_in_flight)
                h_bad[s] = !(s_st == EOG_ST_VALID || s_st == EOG_ST_HELD || s_st == EOG_ST_INVALID
                             || s_st == EOG_ST_DROPPED)
                           || (s_st != EOG_ST_DROPPED && (s_fac >= N_FAC || s_wbad))
                           || ((s_st == EOG_ST_VALID || s_st == EOG_ST_HELD)
                               && !(s_r[EOG_BV_FLD_OK +: EOG_BV_FLD_OK_W] == 7'h7F && s_r[EOG_BV_WELLS_OK]));
        end
    end
    always_comb if (f_past_valid && rst_n) H_shadow: assert (h_bad == '0);

    // ---- reference: expected bus F for record e (numerics.md §4) --------------------------------------------
    logic [2:0]    e_st;
    logic          e_vh, e_dr;
    logic [4:0]    e_fac;
    logic [CW-1:0] e_row;
    logic [7:0]    e_nw;
    logic [1:0]    e_pst;
    logic [6:0]    e_fok;
    logic [7:0]    e_act;
    logic [15:0]   e_reason;
    assign e_st     = e[EOG_BV_STATUS +: EOG_BV_STATUS_W];
    assign e_vh     = (e_st == EOG_ST_VALID) || (e_st == EOG_ST_HELD);
    assign e_dr     = (e_st == EOG_ST_DROPPED);
    assign e_fac    = e[EOG_BV_FAC +: EOG_BV_FAC_W];
    assign e_row    = (e_fac < N_FAC) ? f_rows[e_fac * CW +: CW] : '0;   // only DROPPED records reach '0
    assign e_nw     = (e_row[EOG_CFG_N_WELLS +: 8] > 8'd8) ? 8'd8 : e_row[EOG_CFG_N_WELLS +: 8];
    assign e_pst    = e[EOG_BV_PUMP_ST +: EOG_BV_PUMP_ST_W];
    assign e_fok    = e[EOG_BV_FLD_OK +: EOG_BV_FLD_OK_W];
    assign e_act    = e[EOG_BV_WELL_ACT +: EOG_BV_WELL_ACT_W];
    assign e_reason = e[EOG_BV_REASON +: EOG_BV_REASON_W];

    // signed readings, sign-extended to 20 bits (the multiplier's a width)
    logic signed [19:0] v_inflow, v_level, v_pf, v_rf, v_dis, v_pipe, v_prev, v_p0;
    assign v_inflow = $signed(e[EOG_BV_INFLOW +: 16]);
    assign v_level  = $signed(e[EOG_BV_LEVEL +: 16]);
    assign v_pf     = $signed(e[EOG_BV_PUMP_FLOW +: 16]);
    assign v_rf     = $signed(e[EOG_BV_RECV_FLOW +: 16]);
    assign v_dis    = $signed(e[EOG_BV_DIS_PSI +: 16]);
    assign v_pipe   = $signed(e[EOG_BV_PIPE_PSI +: 16]);
    assign v_prev   = $signed(e[EOG_BV_PREV_LEVEL +: 16]);
    assign v_p0     = $signed(e_row[EOG_CFG_P0 +: 16]);

    logic        [19:0] v_pop;
    logic signed [19:0] v_wsum;
    always_comb begin
        v_pop  = '0;
        v_wsum = '0;
        for (int i = 0; i < 8; i++) begin
            v_pop  = v_pop + {19'd0, e_act[i]};
            v_wsum = v_wsum + $signed(e[EOG_BV_WELL_WATER + 16*i +: 16]);
        end
    end

    // operand x_c (20-bit signed) and multiplier M_c (32-bit unsigned) of each multiplied channel; 7 and 8 unused
    logic [12*20-1:0] f_x;
    logic [12*32-1:0] f_m;
    always_comb begin
        f_x = '0;
        f_m = '0;
        f_x[ 0*20 +: 20] = v_inflow;          f_m[ 0*32 +: 32] = e_row[EOG_CFG_M_INV_B +: 32];
        f_x[ 1*20 +: 20] = v_pf;              f_m[ 1*32 +: 32] = e_row[EOG_CFG_M_INV_Q +: 32];
        f_x[ 2*20 +: 20] = v_rf;              f_m[ 2*32 +: 32] = e_row[EOG_CFG_M_INV_Q +: 32];
        f_x[ 3*20 +: 20] = v_pf - v_rf;       f_m[ 3*32 +: 32] = e_row[EOG_CFG_M_INV_Q +: 32];
        f_x[ 4*20 +: 20] = v_level;           f_m[ 4*32 +: 32] = EOG_K_LEVEL;
        f_x[ 5*20 +: 20] = v_dis - v_p0;      f_m[ 5*32 +: 32] = EOG_K_DIS;
        f_x[ 6*20 +: 20] = v_pipe - v_p0;     f_m[ 6*32 +: 32] = EOG_K_PIPE;
        f_x[ 9*20 +: 20] = v_pop;             f_m[ 9*32 +: 32] = e_row[EOG_CFG_M_INV_W +: 32];
        f_x[10*20 +: 20] = v_wsum;            f_m[10*32 +: 32] = e_row[EOG_CFG_M_INV_B +: 32];
        f_x[11*20 +: 20] = v_level - v_prev;  f_m[11*32 +: 32] = e_row[EOG_CFG_M_NET +: 32];
    end

    // channels computed with feat() for this record: VALID/HELD, all multiplied channels (not 7, 8); channel 11 only
    // with PREV_OK. Bit c = channel c.
    localparam logic [11:0] F_MULCH = 12'b0110_0111_1111;   // channels 0-6, 9, 10 (11 added below)
    logic [11:0] f_used;
    assign f_used = e_vh ? (F_MULCH | {e[EOG_BV_PREV_OK], 11'd0}) : 12'd0;

    // channels whose operand x is a single field (0, 1, 2, 4) or the popcount (9): x == 0 gives a 0 product however
    // a design arranges the multiply. For the others F4_zero uses only M == 0 (a design may legally compute, e.g.,
    // (PUMP_FLOW - RECV_FLOW)*M as PUMP_FLOW*M - RECV_FLOW*M).
    localparam logic [11:0] F_RAWX = 12'b0010_0001_0111;

    // ---- output fields ------------------------------------------------------------------------------------
    logic [15:0]  o_reason;
    logic [191:0] o_feat;
    logic [3:0]   o_rules;
    assign o_reason = out_data[EOG_BF_REASON +: EOG_BF_REASON_W];
    assign o_feat   = out_data[EOG_BF_FEAT0_11 +: EOG_BF_FEAT0_11_W];
    assign o_rules  = out_data[EOG_BF_RULES4 +: EOG_BF_RULES4_W];

    // ---- F4 reference: feat(x, M) = sat16((x*M + 2^16) >>> 17) ----------------------------------------------
`ifdef FV_ABSTRACT_MUL
    // F4_zero: a computed channel with M_c == 0, or with a single-field / popcount x_c == 0, is 0.
    logic [11:0] f4_ok;
    always_comb
        for (int c = 0; c < 12; c++)
            f4_ok[c] = !(f_used[c] && (f_m[c*32 +: 32] == 32'd0 || (F_RAWX[c] && f_x[c*20 +: 20] == 20'd0)))
                       || o_feat[c*16 +: 16] == 16'd0;
`else
    // Product: the real x*M (signed 53-bit; |x| <= 2^19, M < 2^32), or with FV_CONCAT_MUL the stand-in P(x, M) of
    // formal/features/eog_mul_concat.sv (the same function the linked eog_mul computes). Written inline (no
    // function) to keep Yosys' function handling out of the reference.
    logic [12*16-1:0]   f_val;    // expected channel value
    logic [11:0]        f_satc;   // channel's unsaturated value outside [-32768, 32767]
    logic [19:0]        t_x;      // loop temporaries
    logic [31:0]        t_m;
    logic [51:0]        t_pc;
    logic signed [52:0] t_prod, t_rnd;
    logic signed [35:0] t_q;
    always_comb begin
        t_x = '0; t_m = '0; t_pc = '0; t_prod = '0; t_rnd = '0; t_q = '0;
        for (int c = 0; c < 12; c++) begin
            t_x = f_x[c*20 +: 20];
            t_m = f_m[c*32 +: 32];
`ifdef FV_CONCAT_MUL
            if (t_x == 20'd0 || t_m == 32'd0) t_pc = 52'd0;
            else if (!t_x[19])                t_pc = {t_x - 20'd1, t_m};
            else                              t_pc = -{~t_x, t_m};
            t_prod = $signed({t_pc[51], t_pc});
`else
            t_prod = $signed({{33{t_x[19]}}, t_x}) * $signed({21'd0, t_m});
`endif
            t_rnd = t_prod + 53'sd65536;
            t_q   = $signed(t_rnd[52:17]);                            // >>> 17
            f_satc[c]         = (t_q > 36'sd32767) || (t_q < -36'sd32768);
            f_val[c*16 +: 16] = (t_q > 36'sd32767) ? 16'h7FFF : (t_q < -36'sd32768) ? 16'h8000 : t_q[15:0];
        end
    end

    logic [11:0] f4_ok;
    always_comb
        for (int c = 0; c < 12; c++)
            f4_ok[c] = !f_used[c] || o_feat[c*16 +: 16] == f_val[c*16 +: 16];
`endif

    // ---- rule bits 0..3 (numerics.md §4) --------------------------------------------------------------------
    logic [15:0] e_swm, e_shut, e_warn;
    assign e_swm  = glb[EOG_G_SHUTIN_WATER_MAX +: 16];
    assign e_shut = e_row[EOG_CFG_SHUT_LVL +: 16];
    assign e_warn = e_row[EOG_CFG_WARN_LVL +: 16];
    logic [7:0] e_wle;   // slot i is not configured, or its water <= SHUTIN_WATER_MAX (s16 vs u16, integer compare)
    always_comb
        for (int i = 0; i < 8; i++)
            e_wle[i] = (e_nw <= i)
                       || $signed({e[EOG_BV_WELL_WATER + 16*i + 15], e[EOG_BV_WELL_WATER + 16*i +: 16]})
                          <= $signed({1'b0, e_swm});
    logic signed [16:0] e_lvl17;
    assign e_lvl17 = $signed({e[EOG_BV_LEVEL + 15], e[EOG_BV_LEVEL +: 16]});
    logic [3:0] e_rules;
    assign e_rules[EOG_RULE_PUMP_FAULT]   = !e_dr && e_fok[2] && e_pst == 2'd2;
    assign e_rules[EOG_RULE_SHUT_IN]      = !e_dr && e[EOG_BV_WELLS_OK] && e_nw >= 8'd1 && e_act == 8'd0
                                            && e_wle == 8'hFF;
    assign e_rules[EOG_RULE_LVL_SHUTDOWN] = !e_dr && e_fok[1] && e_lvl17 >= $signed({1'b0, e_shut});
    assign e_rules[EOG_RULE_LVL_WARNING]  = !e_dr && e_fok[1] && e_lvl17 >= $signed({1'b0, e_warn});

    // ---- assertions ---------------------------------------------------------------------------------------
    localparam logic [15:0] SAT_BIT = 16'd1 << EOG_R_FEAT_SAT;

    logic copy_ok;
    assign copy_ok = (out_data[EOG_BF_INFLOW +: 16] == e[EOG_BV_INFLOW +: 16]
                      && out_data[EOG_BF_LEVEL +: 16] == e[EOG_BV_LEVEL +: 16])
                     || (e_dr && out_data[EOG_BF_INFLOW +: 16] == 16'd0 && out_data[EOG_BF_LEVEL +: 16] == 16'd0);

    always_comb begin
        if (f_past_valid && rst_n && out_valid) begin
            // header pass-through (conventions §3); the header occupies the same bits on bus V and bus F
            B_hdr: assert (out_data[EOG_BF_REC_NO +: EOG_BF_REASON] == e[EOG_BV_REC_NO +: EOG_BV_REASON]
                           && out_data[EOG_BF_SINCE_RESET +: EOG_BF_SINCE_RESET_W]
                              == e[EOG_BV_SINCE_RESET +: EOG_BV_SINCE_RESET_W]
                           && out_data[EOG_BF_HIST_RESET] == e[EOG_BV_HIST_RESET]);
            F6_gain:  assert ((o_reason & e_reason) == e_reason);
            B_reason: assert ((o_reason & ~SAT_BIT) == (e_reason & ~SAT_BIT) && (e_vh || o_reason == e_reason));

            if (!e_vh) begin
                F1_feat0: assert (o_feat == 192'd0);
            end
            if (e_dr) begin
                F1_drop: assert (o_rules == 4'd0 && !out_data[EOG_BF_PUMP_RUN]);
            end
            F2_ch7: assert (o_feat[7*16 +: 16] == ((e_vh && e_pst == 2'd1) ? 16'd16384 : 16'd0));
            F2_ch8: assert (o_feat[8*16 +: 16] == ((e_vh && e_pst == 2'd2) ? 16'd16384 : 16'd0));
            if (!e[EOG_BV_PREV_OK]) begin
                F3_ch11: assert (o_feat[11*16 +: 16] == 16'd0);
            end

            F5_pf: assert (o_rules[EOG_RULE_PUMP_FAULT]   == e_rules[EOG_RULE_PUMP_FAULT]);
            F5_si: assert (o_rules[EOG_RULE_SHUT_IN]      == e_rules[EOG_RULE_SHUT_IN]);
            F5_sd: assert (o_rules[EOG_RULE_LVL_SHUTDOWN] == e_rules[EOG_RULE_LVL_SHUTDOWN]);
            F5_wl: assert (o_rules[EOG_RULE_LVL_WARNING]  == e_rules[EOG_RULE_LVL_WARNING]);

            B_run:  assert (out_data[EOG_BF_PUMP_RUN] == (e_vh && e_pst == 2'd1));
            B_copy: assert (copy_ok);

`ifdef FV_ABSTRACT_MUL
            F4_zero: assert (f4_ok == 12'hFFF);
`else
            F4_ch:  assert (f4_ok == 12'hFFF);
            F4_sat: assert (o_reason[EOG_R_FEAT_SAT] == (e_reason[EOG_R_FEAT_SAT] || (f_satc & f_used) != 12'd0));
`endif
        end
    end

    // ---- cover goals (spec: a saturated channel; SHUT_IN set; channel 11 nonzero) ---------------------------
    always_comb begin
        if (f_past_valid && rst_n) begin
            C_sat:    cover (out_valid && out_ready && o_reason[EOG_R_FEAT_SAT] && !e_reason[EOG_R_FEAT_SAT]);
            C_shutin: cover (out_valid && out_ready && o_rules[EOG_RULE_SHUT_IN]);
            C_ch11:   cover (out_valid && out_ready && o_feat[11*16 +: 16] != 16'd0);
            C_two:    cover (out_valid && out_ready && f_out_cnt == 8'd1);                 // second record leaves
            C_bp:     cover (out_valid && !out_ready && in_valid && f_in_flight != 8'd0);  // back-pressure held
        end
    end
endmodule
