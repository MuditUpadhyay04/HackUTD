// fv_eog_features.sv -- formal harness for eog_features (task T1.features.fv, Verify role).
//
// Written from spec/modules/eog_features.md, spec/numerics.md §4 and spec/conventions.md §2-§7 (spec v2), not from
// the RTL. Only the DUT's ports are used (including the formal-only f_inflight / f_oldest_recno of conventions §7);
// there are no hierarchical references.
//
// Property labels map to the spec's "Required properties" list:
//   F1_feat0, F1_drop          F1  INVALID/DROPPED -> FEAT0_11 = 0; DROPPED -> RULES4 = 0, PUMP_RUN = 0
//   F2_ch7, F2_ch8             F2  channels 7/8 are exactly 16384/0 per PUMP_ST
//   F3_ch11                    F3  channel 11 = 0 when PREV_OK = 0
//   F4_ch, F4_sat              F4  every channel = sat16((x*M + 2^16) >>> 17) and FEAT_SAT iff some VALID/HELD
//                                  channel's unsaturated value is outside [-32768, 32767]   (bmc, real multiplier)
//   F4_zero                    F4  corollary that holds for any multiplier with 0*M = x*0 = 0: a multiplied channel
//                                  whose multiplier M is 0, or whose operand x is a single raw field equal to 0,
//                                  is 0                                         (prove, abstract multiplier)
//   (F4 range)                     "every channel lies in [-32768, 32767]" is true of any 16-bit two's complement
//                                  field; F4_ch is what gives it content.
//   F5_pf, F5_si, F5_sd, F5_wl F5  rule bits 0..3 exactly per numerics.md §4 (inputs not OK -> 0; DROPPED -> 0;
//                                  SHUT_IN needs n_wells >= 1)
//   F6_gain                    F6  REASON only gains bits
//   B_hdr                      conventions §3 header pass-through (REC_NO, IN_LAST, FAC_RAW, FAC, TS, STATUS,
//                              SINCE_RESET, HIST_RESET unchanged)
//   B_reason                   module spec "Behavior": the only bit features may add is FEAT_SAT, and only for
//                              VALID/HELD
//   B_run, B_copy              PUMP_RUN = (PUMP_ST == 1) for VALID/HELD else 0; INFLOW, LEVEL copied from bus V
//   u_in.*, u_out.*            handshake, conventions §2 (formal/common eog_fv_axis)
//   u_stage.st_*               stage contract, conventions §3/§7: one in -> one out, in order (REC_NO), nothing
//                              lost or invented, in-flight bound, II <= 16, latency <= 128 (formal/common eog_fv_stage)
//
// Defines:
//   FV_ABSTRACT_MUL  set by the `prove` task (formal/common/eog_mul_abstract.sv is linked instead of the real
//                    multiplier): F4_ch / F4_sat are compiled out, F4_zero is checked instead.
//
// Environment assumptions (the upstream eog_validate's contract, spec/numerics.md §3 / eog_validate.md); each is
// labelled A_*:
//   A_status  STATUS is one of 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED (2 is never produced).
//   A_fac     a non-DROPPED record's FAC is a configured slot (< N_FAC).            (V2)
//   A_ok      a VALID/HELD record has every facility field and every configured well OK
//             (FLD_OK = 7'h7F, WELLS_OK = 1).                                         (V8)
//   A_wells   a non-DROPPED record has WELL_ACT[i] = 0 and WELL_WATER[i] = 0 for i >= n_wells.   (V11)
//             This makes "popcount(WELL_ACT)", "sum of WELL_WATER[i]" and "WELL_ACT == 0" independent of whether
//             an implementation sums all 8 slots or only the configured ones.
//   A_sat     incoming REASON[FEAT_SAT] = 0 (only eog_features sets it, numerics.md §6), so F4_sat can be "iff".
// Not assumed (so F1/F5 are checked against arbitrary garbage): the values, FLD_OK, PUMP_ST, wells of
// INVALID/DROPPED records.
//
// CONFIG rows are per-slot constants ($anyconst) as conventions §5 says; a cfg_fac outside the configured
// slots reads an unconstrained ($anyseq) row. GLOBAL is a constant.

module fv_eog_features (
    input logic clk
);
    `include "eog_defs.svh"

    // ---- shrunk instance ----------------------------------------------------------------------------------
    localparam integer N_FAC = 2;
    localparam integer RW    = 8;     // low REC_NO bits compared by the stage checker
    localparam integer MAXF  = 2;     // records the stage may hold (accepted, output not yet transferred): 1 or 2
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

    logic [N_FAC*CW-1:0] f_rows;   // CONFIG rows of slots 0..N_FAC-1
    logic [CW-1:0]       f_row_x;  // what an unconfigured slot reads
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

    always_comb begin
        if (rst_n && in_valid) begin
            A_status: assume (i_st == EOG_ST_VALID || i_st == EOG_ST_HELD || i_st == EOG_ST_INVALID
                              || i_st == EOG_ST_DROPPED);
            A_sat:    assume (!in_data[EOG_BV_REASON + EOG_R_FEAT_SAT]);
            if (i_st != EOG_ST_DROPPED) begin
                A_fac: assume (i_fac < N_FAC);
            end
            if (i_st == EOG_ST_VALID || i_st == EOG_ST_HELD) begin
                A_ok: assume (in_data[EOG_BV_FLD_OK +: EOG_BV_FLD_OK_W] == 7'h7F && in_data[EOG_BV_WELLS_OK]);
            end
        end
    end
    genvar gw;
    generate
        for (gw = 0; gw < 8; gw = gw + 1) begin : g_awells
            always_comb if (rst_n && in_valid && i_st != EOG_ST_DROPPED && i_nw <= gw) begin
                A_wells: assume (!in_data[EOG_BV_WELL_ACT + gw] && in_data[EOG_BV_WELL_WATER + 16*gw +: 16] == 16'd0);
            end
        end
    endgenerate

    // ---- shadow of the accepted records (port-only) ---------------------------------------------------------
    // Slot k holds the record whose acceptance number has low bit k (MAXF = 2) -- the stage checker guarantees at
    // most MAXF in flight, in order, so slot f_out_cnt[0] is the oldest.
    logic [MAXF*VW-1:0] f_sh;
    logic               f_wi, f_ri;
    assign f_wi = (MAXF > 1) ? f_in_cnt[0]  : 1'b0;
    assign f_ri = (MAXF > 1) ? f_out_cnt[0] : 1'b0;
    always_ff @(posedge clk) if (rst_n && in_valid && in_ready) f_sh[f_wi * VW +: VW] <= in_data;

    // The record the current output must belong to (a same-cycle pass-through is allowed by the checker).
    logic [VW-1:0] e;
    assign e = (f_in_flight == 8'd0) ? in_data : f_sh[f_ri * VW +: VW];

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
    assign e_row    = (e_fac < N_FAC) ? f_rows[e_fac * CW +: CW] : '0;
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

    // which channels are computed with feat() for this record (VALID/HELD; channel 11 only with PREV_OK)
    logic [11:0] f_used;
    assign f_used = e_vh ? {e[EOG_BV_PREV_OK], 11'b111_0011_1111} : 12'd0;

    // channels whose operand x is a single raw field (0, 1, 2, 4, 9): x == 0 gives a 0 product however the
    // design arranges the multiply; for the others only M == 0 is used in F4_zero (a design may legally compute
    // e.g. (PUMP_FLOW - RECV_FLOW)*M as PUMP_FLOW*M - RECV_FLOW*M).
    localparam logic [11:0] F_RAWX = 12'b0010_0001_0111;

`ifndef FV_ABSTRACT_MUL
    // feat(x, M) = sat16((x*M + 2^16) >>> 17); x*M is signed 53-bit (|x| <= 2^19, M < 2^32)
    logic [12*16-1:0] f_val;
    logic [11:0]      f_satc;
    genvar gc;
    generate
        for (gc = 0; gc < 12; gc = gc + 1) begin : g_ref
            logic signed [52:0] prod, rnd;
            logic signed [35:0] q;
            assign prod = $signed(f_x[gc*20 +: 20]) * $signed({1'b0, f_m[gc*32 +: 32]});
            assign rnd  = prod + 53'sd65536;
            assign q    = rnd >>> 17;
            assign f_satc[gc] = (q > 36'sd32767) || (q < -36'sd32768);
            assign f_val[gc*16 +: 16] = (q > 36'sd32767) ? 16'h7FFF : (q < -36'sd32768) ? 16'h8000 : q[15:0];
        end
    endgenerate
`endif

    // rule bits 0..3
    logic [15:0] e_swm, e_shut, e_warn;
    assign e_swm  = glb[EOG_G_SHUTIN_WATER_MAX +: 16];
    assign e_shut = e_row[EOG_CFG_SHUT_LVL +: 16];
    assign e_warn = e_row[EOG_CFG_WARN_LVL +: 16];
    logic e_water_le;   // every configured slot (i < n_wells) has water <= SHUTIN_WATER_MAX (integer compare)
    always_comb begin
        e_water_le = 1'b1;
        for (int i = 0; i < 8; i++)
            if (i < e_nw && $signed({e[EOG_BV_WELL_WATER + 16*i + 15], e[EOG_BV_WELL_WATER + 16*i +: 16]})
                            > $signed({1'b0, e_swm}))
                e_water_le = 1'b0;
    end
    logic [3:0] e_rules;
    assign e_rules[EOG_RULE_PUMP_FAULT]   = !e_dr && e_fok[2] && e_pst == 2'd2;
    assign e_rules[EOG_RULE_SHUT_IN]      = !e_dr && e[EOG_BV_WELLS_OK] && e_nw >= 8'd1 && e_act == 8'd0
                                            && e_water_le;
    assign e_rules[EOG_RULE_LVL_SHUTDOWN] = !e_dr && e_fok[1]
                                            && $signed({e[EOG_BV_LEVEL + 15], e[EOG_BV_LEVEL +: 16]})
                                               >= $signed({1'b0, e_shut});
    assign e_rules[EOG_RULE_LVL_WARNING]  = !e_dr && e_fok[1]
                                            && $signed({e[EOG_BV_LEVEL + 15], e[EOG_BV_LEVEL +: 16]})
                                               >= $signed({1'b0, e_warn});

    // ---- output fields ------------------------------------------------------------------------------------
    logic [15:0]  o_reason;
    logic [191:0] o_feat;
    logic [3:0]   o_rules;
    assign o_reason = out_data[EOG_BF_REASON +: EOG_BF_REASON_W];
    assign o_feat   = out_data[EOG_BF_FEAT0_11 +: EOG_BF_FEAT0_11_W];
    assign o_rules  = out_data[EOG_BF_RULES4 +: EOG_BF_RULES4_W];

    localparam logic [15:0] SAT_BIT = 16'd1 << EOG_R_FEAT_SAT;

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
            B_copy: assert (out_data[EOG_BF_INFLOW +: 16] == e[EOG_BV_INFLOW +: 16]
                            && out_data[EOG_BF_LEVEL +: 16] == e[EOG_BV_LEVEL +: 16]);

`ifndef FV_ABSTRACT_MUL
            F4_sat: assert (o_reason[EOG_R_FEAT_SAT] == |(f_satc & f_used));
`endif
        end
    end

    genvar gk;
    generate
        for (gk = 0; gk < 12; gk = gk + 1) begin : g_ch
            if (gk != 7 && gk != 8) begin : g_mul
                always_comb if (f_past_valid && rst_n && out_valid && f_used[gk]) begin
`ifdef FV_ABSTRACT_MUL
                    if (f_m[gk*32 +: 32] == 32'd0 || (F_RAWX[gk] && f_x[gk*20 +: 20] == 20'd0))
                        F4_zero: assert (o_feat[gk*16 +: 16] == 16'd0);
`else
                    F4_ch: assert (o_feat[gk*16 +: 16] == f_val[gk*16 +: 16]);
`endif
                end
            end
        end
    endgenerate

    // ---- cover goals (spec: a saturated channel; SHUT_IN set; channel 11 nonzero) ---------------------------
    always_comb begin
        if (f_past_valid && rst_n) begin
            C_sat:    cover (out_valid && out_ready && o_reason[EOG_R_FEAT_SAT]);
            C_shutin: cover (out_valid && out_ready && o_rules[EOG_RULE_SHUT_IN]);
            C_ch11:   cover (out_valid && out_ready && o_feat[11*16 +: 16] != 16'd0);
            C_two:    cover (out_valid && out_ready && f_out_cnt == 8'd1);   // second record leaves
            C_bp:     cover (out_valid && !out_ready && f_in_flight == 8'd1 && in_valid);  // back-pressure held
        end
    end
endmodule
