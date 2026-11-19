// eog_features.sv -- the 12 feature channels and rule bits 0-3 (spec v4: modules/eog_features.md,
// numerics.md section 4 = Mudit's features_int.py S2, conventions section 7 formal observation ports).
//
// Bus V in, bus F out. Stateless, one record at a time:
//   S_IDLE  in_ready = 1; an accepted record is captured into in_r (cfg_fac = its FAC from the next cycle on,
//           so cfg_row is the record's CONFIG row for the whole of S_CALC)
//   S_CALC  NMUL + MUL_LAT cycles (cnt = 0 .. C_LAST). One shared eog_mul (20 x 32, signed x unsigned, LAT 2)
//           takes one channel's operands per cycle (cnt = 0 .. NMUL-1); each product is rounded and saturated
//           MUL_LAT cycles later and shifted into res_r / sat_r. The last cycle also registers the rule bits.
//   S_OUT   out_valid = 1 until out_ready; out_data is built from registers only (stable while held)
// Latency 13 cycles (accept -> out_valid), II 14 cycles with out_ready = 1.
//
// Multiplied channels, in issue order j = 0..9:  ch 0..6, 9, 10, 11  (ch 7 / 8 come from PUMP_ST directly)
//   feat(x, M) = sat16((x * M + 2^16) >>> 17), x signed (<= 20 bits), M unsigned 32 bits.
// Output gating (numerics.md section 4, v4): channels, FEAT_SAT, RULES4 and PUMP_RUN only for VALID/HELD; every
// other status (INVALID, DROPPED, and the never-produced codes 2, 5-7) gets 0. Channel 11 (and its FEAT_SAT
// contribution) only when PREV_OK.
//
// Rules (VALID/HELD): PUMP_FAULT = PUMP_ST == 2; SHUT_IN = every configured slot i < n_wells has status 0
// (WELL_ACT[i] = 0) and water exactly 0, with n_wells = min(CFG.N_WELLS, N_WELL) (TASKS.md question 14); an empty
// set of slots (n_wells = 0) gives SHUT_IN = 1, as features_int.py's all() over range(0); LVL_SHUTDOWN / LVL_WARNING
// = LEVEL (s16) >= SHUT_LVL / WARN_LVL (u16, zero-extended). FLD_OK / WELLS_OK are not used (v4: a VALID/HELD record
// has every field OK or held).
// popcount(WELL_ACT) and the WELL_WATER sum cover the whole bus field (slots >= n_wells are 0 from eog_validate).
// N_FAC is unused: the stage keeps no per-facility state, so a FAC >= N_FAC record is processed like any other.

module eog_features #(
    /* verilator lint_off UNUSEDPARAM */
    parameter integer N_FAC  = 32,   // stateless stage: kept for the uniform interface (TASKS.md question 11)
    /* verilator lint_on UNUSEDPARAM */
    parameter integer N_WELL = 8,
    /* verilator lint_off UNUSEDPARAM */
    parameter integer II     = 16    // achieved II is 14 (see header)
    /* verilator lint_on UNUSEDPARAM */
) (
    input  logic                clk,
    input  logic                rst_n,
    input  logic                in_valid,
    output logic                in_ready,
    input  logic [373-1:0]      in_data,      // bus V (EOG_BV_W)
    output logic                out_valid,
    input  logic                out_ready,
    output logic [343-1:0]      out_data,     // bus F (EOG_BF_W)
    output logic [4:0]          cfg_fac,      // slot whose CONFIG row is read (= FAC of the held record)
    input  logic [511:0]        cfg_row       // EOG_CFG_BITS, combinational from eog_regs
`ifdef FORMAL
    , output logic [7:0]        f_inflight      // records accepted on in_* whose output has not yet transferred
    , output logic [31:0]       f_oldest_recno  // REC_NO of the oldest such record; don't-care when f_inflight == 0
`endif
);
    `include "eog_defs.svh"

    // ---------------------------------------------------------------------------------------------------
    // sizes
    localparam integer AW       = 20;                      // eog_mul a: signed operand x
    localparam integer BW       = 32;                      // eog_mul b: unsigned multiplier M
    localparam integer PW       = AW + BW;                 // product width (52)
    localparam integer MUL_LAT  = 2;                       // eog_mul latency
    localparam integer NMUL     = 10;                      // multiplied channels
    localparam integer CNT_LAST = NMUL - 1 + MUL_LAT;      // last S_CALC cycle (11)
    localparam integer CW       = $clog2(CNT_LAST + 1);    // cnt width (4)
    localparam integer NSEL     = 1 << CW;                 // operand table entries (padded with zeros)
    localparam integer YW       = PW + 1 - EOG_FEAT_SHIFT; // rounded, shifted product width (36)
    localparam integer NW       = (N_WELL < EOG_N_WELL) ? N_WELL : EOG_N_WELL;   // well slots SHUT_IN may check

    localparam logic [CW-1:0] C_LAT  = CW'(MUL_LAT);
    localparam logic [CW-1:0] C_LAST = CW'(CNT_LAST);

    localparam logic [15:0] ONE16 = 16'(EOG_ONE);
    localparam logic [PW:0] RND   = {{(PW + 1 - EOG_FEAT_SHIFT){1'b0}}, 1'b1, {(EOG_FEAT_SHIFT - 1){1'b0}}};  // 2^(S-1)

    localparam logic [1:0] S_IDLE = 2'd0, S_CALC = 2'd1, S_OUT = 2'd2;

    // ---------------------------------------------------------------------------------------------------
    // control and registers
    logic [1:0]           st;
    logic [CW-1:0]        cnt;
    logic [EOG_BV_W-1:0]  in_r;        // the held record (bus V)
    logic [16*NMUL-1:0]   res_r;       // saturated product of issue slot j at [16j +: 16]
    logic [NMUL-1:0]      sat_r;       // issue slot j saturated
    logic [3:0]           rules_r;     // rule bits 0-3 (before the VALID/HELD gate)

    assign in_ready  = (st == S_IDLE);
    assign out_valid = (st == S_OUT);

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            st  <= S_IDLE;
            cnt <= '0;
        end else begin
            case (st)
                S_IDLE: if (in_valid) begin
                    st  <= S_CALC;
                    cnt <= '0;
                end
                S_CALC: begin
                    if (cnt == C_LAST) st <= S_OUT;
                    cnt <= cnt + 1'b1;
                end
                S_OUT: if (out_ready) st <= S_IDLE;
                default: st <= S_IDLE;
            endcase
        end
    end

    // ---------------------------------------------------------------------------------------------------
    // fields of the held record
    logic [EOG_BV_STATUS_W-1:0]  r_status;
    logic [15:0]                 r_inflow, r_level, r_pflow, r_rflow, r_dis, r_pipe, r_prev_level;
    logic [EOG_BV_PUMP_ST_W-1:0] r_pump_st;
    logic [EOG_BV_WELL_ACT_W-1:0] r_well_act;
    logic                        r_prev_ok;

    assign r_status     = in_r[EOG_BV_STATUS +: EOG_BV_STATUS_W];
    assign r_inflow     = in_r[EOG_BV_INFLOW +: EOG_BV_INFLOW_W];
    assign r_level      = in_r[EOG_BV_LEVEL +: EOG_BV_LEVEL_W];
    assign r_pflow      = in_r[EOG_BV_PUMP_FLOW +: EOG_BV_PUMP_FLOW_W];
    assign r_rflow      = in_r[EOG_BV_RECV_FLOW +: EOG_BV_RECV_FLOW_W];
    assign r_dis        = in_r[EOG_BV_DIS_PSI +: EOG_BV_DIS_PSI_W];
    assign r_pipe       = in_r[EOG_BV_PIPE_PSI +: EOG_BV_PIPE_PSI_W];
    assign r_prev_level = in_r[EOG_BV_PREV_LEVEL +: EOG_BV_PREV_LEVEL_W];
    assign r_pump_st    = in_r[EOG_BV_PUMP_ST +: EOG_BV_PUMP_ST_W];
    assign r_well_act   = in_r[EOG_BV_WELL_ACT +: EOG_BV_WELL_ACT_W];
    assign r_prev_ok    = in_r[EOG_BV_PREV_OK];

    logic r_vh;
    assign r_vh = (r_status == EOG_ST_VALID) || (r_status == EOG_ST_HELD);

    assign cfg_fac = in_r[EOG_BV_FAC +: EOG_BV_FAC_W];

    // CONFIG row fields of the held record's slot
    logic [31:0] c_m_inv_b, c_m_inv_q, c_m_inv_w, c_m_net;
    logic [15:0] c_p0, c_shut, c_warn;
    logic [7:0]  c_n_wells;
    assign c_m_inv_b = cfg_row[EOG_CFG_M_INV_B +: EOG_CFG_M_INV_B_W];
    assign c_m_inv_q = cfg_row[EOG_CFG_M_INV_Q +: EOG_CFG_M_INV_Q_W];
    assign c_m_inv_w = cfg_row[EOG_CFG_M_INV_W +: EOG_CFG_M_INV_W_W];
    assign c_m_net   = cfg_row[EOG_CFG_M_NET +: EOG_CFG_M_NET_W];
    assign c_p0      = cfg_row[EOG_CFG_P0 +: EOG_CFG_P0_W];
    assign c_shut    = cfg_row[EOG_CFG_SHUT_LVL +: EOG_CFG_SHUT_LVL_W];
    assign c_warn    = cfg_row[EOG_CFG_WARN_LVL +: EOG_CFG_WARN_LVL_W];
    assign c_n_wells = cfg_row[EOG_CFG_N_WELLS +: EOG_CFG_N_WELLS_W];

    // ---------------------------------------------------------------------------------------------------
    // multiplier operands (x sign-extended to AW bits)
    logic [16:0] d_flow, d_dis, d_pipe, d_level;     // s17 differences
    assign d_flow  = {r_pflow[15], r_pflow} - {r_rflow[15], r_rflow};
    assign d_dis   = {r_dis[15], r_dis}     - {c_p0[15], c_p0};
    assign d_pipe  = {r_pipe[15], r_pipe}   - {c_p0[15], c_p0};
    assign d_level = {r_level[15], r_level} - {r_prev_level[15], r_prev_level};

    logic [3:0]    n_act;                            // popcount(WELL_ACT), 0..8
    logic [AW-1:0] w_sum;                            // sum of the 8 WELL_WATER slots (s19, sign-extended)
    always_comb begin
        n_act = '0;
        w_sum = '0;
        for (int i = 0; i < EOG_N_WELL; i++) begin
            n_act = n_act + {3'd0, r_well_act[i]};
            w_sum = w_sum + {{(AW-16){in_r[EOG_BV_WELL_WATER + 16*i + 15]}}, in_r[EOG_BV_WELL_WATER + 16*i +: 16]};
        end
    end

    logic [NSEL*AW-1:0] xs;                          // operand x of issue slot j at [AW*j +: AW]
    logic [NSEL*BW-1:0] ms;                          // operand M of issue slot j at [BW*j +: BW]
    assign xs = {{((NSEL-NMUL)*AW){1'b0}},
                 {{(AW-17){d_level[16]}}, d_level},    // j 9: ch 11 tank_net_flow_norm
                 w_sum,                                // j 8: ch 10 well_water_norm
                 {{(AW-4){1'b0}}, n_act},              // j 7: ch 9  wells_active_fraction
                 {{(AW-17){d_pipe[16]}}, d_pipe},      // j 6: ch 6  pipeline_offset_norm
                 {{(AW-17){d_dis[16]}}, d_dis},        // j 5: ch 5  discharge_offset_norm
                 {{(AW-16){r_level[15]}}, r_level},    // j 4: ch 4  tank_fraction
                 {{(AW-17){d_flow[16]}}, d_flow},      // j 3: ch 3  flow_gap_norm
                 {{(AW-16){r_rflow[15]}}, r_rflow},    // j 2: ch 2  receive_flow_norm
                 {{(AW-16){r_pflow[15]}}, r_pflow},    // j 1: ch 1  pump_flow_norm
                 {{(AW-16){r_inflow[15]}}, r_inflow}}; // j 0: ch 0  inflow_norm
    assign ms = {{((NSEL-NMUL)*BW){1'b0}},
                 c_m_net, c_m_inv_b, c_m_inv_w, EOG_K_PIPE, EOG_K_DIS, EOG_K_LEVEL,
                 c_m_inv_q, c_m_inv_q, c_m_inv_q, c_m_inv_b};

    logic [AW-1:0] mul_a;
    logic [BW-1:0] mul_b;
    logic [PW-1:0] mul_p;
    assign mul_a = xs[AW*cnt +: AW];
    assign mul_b = ms[BW*cnt +: BW];

    eog_mul #(.AW(AW), .BW(BW), .A_SIGNED(1), .B_SIGNED(0), .LAT(MUL_LAT)) u_mul (
        .clk(clk), .a(mul_a), .b(mul_b), .p(mul_p));

    // round, shift, saturate: y = (p + 2^(S-1)) >>> S on PW+1 bits (no overflow for any PW-bit p)
    logic [PW:0]   p_rnd;
    logic [YW-1:0] y;
    logic          y_sat;
    logic [15:0]   y_val;
    assign p_rnd = {mul_p[PW-1], mul_p} + RND;
    assign y     = p_rnd[PW:EOG_FEAT_SHIFT];
    assign y_sat = !((&y[YW-1:15]) || !(|y[YW-1:15]));     // y outside [-32768, 32767]
    assign y_val = y_sat ? (y[YW-1] ? 16'h8000 : 16'h7FFF) : y[15:0];

    // ---------------------------------------------------------------------------------------------------
    // rule bits 0-3 (numerics.md section 4), from the held record and its CONFIG row (output-gated to VALID/HELD)
    logic [EOG_N_WELL-1:0] w_cfg, w_off;
    logic [3:0]            rules_c;
    always_comb begin
        for (int i = 0; i < EOG_N_WELL; i++) begin
            // slot i is configured iff i < min(CFG.N_WELLS, N_WELL)
            w_cfg[i] = (i < NW) && (c_n_wells > 8'(i));
            // slot i is shut in: status 0 and water exactly 0
            w_off[i] = !r_well_act[i] && (in_r[EOG_BV_WELL_WATER + 16*i +: 16] == 16'd0);
        end
        rules_c = '0;
        rules_c[EOG_RULE_PUMP_FAULT]   = (r_pump_st == 2'd2);
        rules_c[EOG_RULE_SHUT_IN]      = &(~w_cfg | w_off);
        rules_c[EOG_RULE_LVL_SHUTDOWN] = $signed({r_level[15], r_level}) >= $signed({1'b0, c_shut});
        rules_c[EOG_RULE_LVL_WARNING]  = $signed({r_level[15], r_level}) >= $signed({1'b0, c_warn});
    end

    // ---------------------------------------------------------------------------------------------------
    // datapath registers (no reset needed: every field is rewritten for each record before S_OUT)
    always_ff @(posedge clk) begin
        if (in_ready && in_valid) in_r <= in_data;
        if (st == S_CALC && cnt >= C_LAT) begin
            res_r <= {y_val, res_r[16*NMUL-1:16]};
            sat_r <= {y_sat, sat_r[NMUL-1:1]};
        end
        if (st == S_CALC && cnt == C_LAST) rules_r <= rules_c;
    end

    // ---------------------------------------------------------------------------------------------------
    // output bus F (from registers only)
    logic [16*12-1:0] feat;
    logic             sat_any;
    logic [15:0]      reason_add;
    always_comb begin
        feat = '0;
        if (r_vh) begin
            for (int c = 0; c < 7; c++) feat[16*c +: 16] = res_r[16*c +: 16];
            feat[16*7 +: 16]  = (r_pump_st == 2'd1) ? ONE16 : 16'd0;
            feat[16*8 +: 16]  = (r_pump_st == 2'd2) ? ONE16 : 16'd0;
            feat[16*9 +: 16]  = res_r[16*7 +: 16];
            feat[16*10 +: 16] = res_r[16*8 +: 16];
            feat[16*11 +: 16] = r_prev_ok ? res_r[16*9 +: 16] : 16'd0;
        end
        sat_any    = r_vh && ((|sat_r[NMUL-2:0]) || (r_prev_ok && sat_r[NMUL-1]));
        reason_add = '0;
        reason_add[EOG_R_FEAT_SAT] = sat_any;
    end

    always_comb begin
        out_data = '0;
        out_data[EOG_BF_REC_NO +: EOG_BF_REC_NO_W]           = in_r[EOG_BV_REC_NO +: EOG_BV_REC_NO_W];
        out_data[EOG_BF_IN_LAST +: EOG_BF_IN_LAST_W]         = in_r[EOG_BV_IN_LAST +: EOG_BV_IN_LAST_W];
        out_data[EOG_BF_FAC_RAW +: EOG_BF_FAC_RAW_W]         = in_r[EOG_BV_FAC_RAW +: EOG_BV_FAC_RAW_W];
        out_data[EOG_BF_FAC +: EOG_BF_FAC_W]                 = in_r[EOG_BV_FAC +: EOG_BV_FAC_W];
        out_data[EOG_BF_TS +: EOG_BF_TS_W]                   = in_r[EOG_BV_TS +: EOG_BV_TS_W];
        out_data[EOG_BF_STATUS +: EOG_BF_STATUS_W]           = r_status;
        out_data[EOG_BF_REASON +: EOG_BF_REASON_W]           = in_r[EOG_BV_REASON +: EOG_BV_REASON_W] | reason_add;
        out_data[EOG_BF_SINCE_RESET +: EOG_BF_SINCE_RESET_W] = in_r[EOG_BV_SINCE_RESET +: EOG_BV_SINCE_RESET_W];
        out_data[EOG_BF_HIST_RESET +: EOG_BF_HIST_RESET_W]   = in_r[EOG_BV_HIST_RESET +: EOG_BV_HIST_RESET_W];
        out_data[EOG_BF_FEAT0_11 +: EOG_BF_FEAT0_11_W]       = feat;
        out_data[EOG_BF_RULES4 +: EOG_BF_RULES4_W]           = r_vh ? rules_r : 4'd0;
        out_data[EOG_BF_INFLOW +: EOG_BF_INFLOW_W]           = r_inflow;
        out_data[EOG_BF_LEVEL +: EOG_BF_LEVEL_W]             = r_level;
        out_data[EOG_BF_PUMP_RUN]                            = r_vh && (r_pump_st == 2'd1);
    end

    // CONFIG fields, FLD_OK and WELLS_OK (not used in v4) and the rounding bits the shift drops
    logic unused_ok;
    assign unused_ok = ^{cfg_row, in_r[EOG_BV_FLD_OK +: EOG_BV_FLD_OK_W], in_r[EOG_BV_WELLS_OK],
                         p_rnd[EOG_FEAT_SHIFT-1:0]};

    // ---------------------------------------------------------------------------------------------------
`ifdef FORMAL
    // conventions section 7 observation ports
    assign f_inflight     = (st == S_IDLE) ? 8'd0 : 8'd1;
    assign f_oldest_recno = in_r[EOG_BV_REC_NO +: EOG_BV_REC_NO_W];

    // internal invariants (help k-induction); register state is arbitrary while rst_n = 0
    always_comb if (rst_n) begin
        fi_state: assert (st == S_IDLE || st == S_CALC || st == S_OUT);
        if (st == S_CALC) fi_cnt: assert (cnt <= C_LAST);
    end
`endif
endmodule
