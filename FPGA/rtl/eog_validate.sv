// eog_validate -- framing, facility, time and field checks; hold/reset. Decides every record's STATUS.
// Spec v4: spec/modules/eog_validate.md, spec/numerics.md section 3 (steps 1-10, D7, D9), conventions.md 3/6/7.
// Normative integer reference: Mudit's ml/hutd_ml/features_int.py Engine.process / _fields (S1) @ 8e67750, as
// adopted by Lucas's rulings (TASKS.md spec questions, which override the numerics.md v4 text):
//   #23 reason bits 11 FIELD_ABSENT and 14 FIELD_LOST are set again (bit 13 NO_MODEL belongs to eog_head);
//   #24 a facility's first record (no last_ts: after power-up, soft reset or a CONFIG write) is a new history,
//       HIST_RESET = 1 and reason bit 2;
//   #25 every DROPPED record has SINCE_RESET = 0;
//   #70 (R7 option C, replaces numerics 3 step 5): hold_run saturates at 3; hold_run > hold turns every held
//       field into a missing one (INVALID, FIELD_LOST) with NO history reset: last_valid and hold_run are kept.
//       History resets come only from a time gap (missing > hold), a CONFIG write or a slot's first record.
//
// Micro-architecture (one record at a time):
//   * The whole decision is combinational in the accept cycle: cfg_fac = FAC_ID[4:0] reads the CONFIG row
//     (conventions 5), the per-slot state is read asynchronously (32-deep arrays -> LUTRAM), and the result is
//     registered into the output buffer together with the per-slot state update.
//   * in_ready = !out_valid, so latency = 1 cycle and II = 2 cycles with out_ready = 1.
//   * No reset sweep. fresh[f] (one flip-flop per slot, set by reset and fac_touch[f]) = slot f has no last_ts;
//     its next non-DROPPED record starts a new history and never reads the slot's RAM, so the arrays need no reset.
//   * A fac_touch in the accept cycle of a record of that slot (or later) applies to the slot's next record.
//
// Field index k (0 .. NF-1) used for the uniform hold logic:
//   0..6            facility fields in DATA PRESENT bit order: 0 inflow, 1 level, 2 pump status, 3 pump flow,
//                   4 discharge psi, 5 receive flow, 6 pipeline psi. FLD_OK bit k = field k; CONFIG LO[k]/HI[k]
//                   bound field k (v4: LO/HI index = present-bit order, index 2 bounds the pump status).
//   7+i             well status, slot i (i < N_WELL)
//   7+N_WELL+i      well water,  slot i
// A field is required iff k < 7 or its well slot i < n_wells = min(CFG.N_WELLS, N_WELL).
//
// Per record (non-DROPPED):
//   clr      = fresh | time reset          (history reset: state seen as cleared before the field checks)
//   held0[k] = required, not OK, has a last_valid value (after clr)
//   hold_run = any held0 ? min(hold_run + 1, 3) : 0; hold_run > hold (ovf) -> held fields become missing
//   INVALID  = any missing field; every OK field still updates last_valid, hold_run and last_ts are stored,
//              SINCE_RESET is not incremented, PREV_LEVEL is kept.
//
// Ports use non-ANSI declarations so their widths can use the EOG_* constants of the included header.

module eog_validate (
    clk, rst_n,
    in_valid, in_ready, in_data,
    out_valid, out_ready, out_data,
    cfg_fac, cfg_row, glb, fac_touch
`ifdef FORMAL
    , f_inflight, f_oldest_recno          // formal observation ports (conventions 7), declared below
`endif
);
    /* verilator lint_off UNUSEDPARAM */
    // II is part of the common parameter set (conventions 6); this stage always runs at II = 2.
    parameter integer N_FAC  = 32;
    parameter integer N_WELL = 8;   // must be <= 8 (bus V carries 8 well slots)
    parameter integer II     = 16;
    `include "eog_defs.svh"
    /* verilator lint_on UNUSEDPARAM */

    input  logic                 clk;
    input  logic                 rst_n;
    input  logic                 in_valid;
    output logic                 in_ready;
    /* verilator lint_off UNUSEDSIGNAL */
    // Unused on purpose: PRESENT bits 7 and 24..31, well bits of slots >= N_WELL; most of the CONFIG row
    // (multipliers, levels, K_CD are for later stages); every GLOBAL field except HOLD_MAX.
    input  logic [EOG_BU_W-1:0]  in_data;
    input  logic [EOG_CFG_BITS-1:0] cfg_row;
    input  logic [EOG_G_BITS-1:0]   glb;
    /* verilator lint_on UNUSEDSIGNAL */
    output logic                 out_valid;
    input  logic                 out_ready;
    output logic [EOG_BV_W-1:0]  out_data;
    output logic [4:0]           cfg_fac;
    input  logic [N_FAC-1:0]     fac_touch;
`ifdef FORMAL
    output logic [7:0]           f_inflight;      // records accepted whose output has not transferred (0/1)
    output logic [31:0]          f_oldest_recno;  // REC_NO of that record (don't-care when f_inflight = 0)
`endif

    localparam integer NF = 7 + 2 * N_WELL;                    // fields with hold state
    localparam integer FW = (N_FAC > 1) ? $clog2(N_FAC) : 1;   // slot index width
    localparam logic [15:0] NFAC16 = N_FAC[15:0];
    localparam logic [3:0]  NWELL4 = N_WELL[3:0];

    // ------------------------------------------------------------------------------------------------------
    // Per-slot state
    // ------------------------------------------------------------------------------------------------------
    logic [N_FAC-1:0]  fresh;                   // no last_ts: next record is a new history (RAM contents unused)
    logic [31:0]       ts_mem   [0:N_FAC-1];    // last_ts
    logic [7:0]        sr_mem   [0:N_FAC-1];    // since_reset after the slot's last non-DROPPED record
    logic [1:0]        hr_mem   [0:N_FAC-1];    // hold_run (0 .. 3, saturating)
    logic [15:0]       pl_mem   [0:N_FAC-1];    // prev_level: LEVEL of the last VALID/HELD record
    logic              pok_mem  [0:N_FAC-1];    // prev_level exists
    logic [16*NF-1:0]  val_mem  [0:N_FAC-1];    // per field: last_valid value
    logic [NF-1:0]     has_mem  [0:N_FAC-1];    // per field: has a last_valid value

    // Output buffer
    logic                ov;
    logic [EOG_BV_W-1:0] od;
    assign out_valid = ov;
    assign out_data  = od;
    assign in_ready  = ~ov;

    // ------------------------------------------------------------------------------------------------------
    // Input record
    // ------------------------------------------------------------------------------------------------------
    /* verilator lint_off UNUSEDSIGNAL */
    logic [EOG_D_BITS-1:0] rec;     // well bits of slots >= N_WELL are unused when N_WELL < 8
    /* verilator lint_on UNUSEDSIGNAL */
    logic [15:0] fac_id;
    logic [31:0] ts;
    /* verilator lint_off UNUSEDSIGNAL */
    logic [31:0] present;           // bits 7 and 24..31 are not assigned to any field
    /* verilator lint_on UNUSEDSIGNAL */
    assign rec     = in_data[EOG_BU_REC +: EOG_BU_REC_W];
    assign fac_id  = rec[EOG_D_FAC_ID +: EOG_D_FAC_ID_W];
    assign ts      = rec[EOG_D_TS +: EOG_D_TS_W];
    assign present = rec[EOG_D_PRESENT +: EOG_D_PRESENT_W];
    assign cfg_fac = fac_id[4:0];

    logic fac_in_range;
    logic [FW-1:0] idx;
    assign fac_in_range = (fac_id < NFAC16);
    assign idx          = fac_in_range ? fac_id[FW-1:0] : '0;

    // CONFIG / GLOBAL
    logic [7:0] cfg_nw;
    logic [3:0] n_wells;            // min(CFG.N_WELLS, N_WELL)
    logic [7:0] g_hold;
    logic [1:0] hold;               // min(G.HOLD_MAX, 2)
    assign cfg_nw  = cfg_row[EOG_CFG_N_WELLS +: EOG_CFG_N_WELLS_W];
    assign n_wells = (cfg_nw >= {4'd0, NWELL4}) ? NWELL4 : cfg_nw[3:0];
    assign g_hold  = glb[EOG_G_HOLD_MAX +: EOG_G_HOLD_MAX_W];
    assign hold    = (g_hold >= 8'd2) ? 2'd2 : g_hold[1:0];

    // ------------------------------------------------------------------------------------------------------
    // Steps 1-3: framing, facility, time
    // ------------------------------------------------------------------------------------------------------
    logic framing, unknown, pre_drop, has_ts;
    logic t_dup, t_lt, t_step, gap_ok;
    logic d_dup, d_ooo, drop, gap_held, t_reset, clr;
    logic [31:0] last_ts;
    logic [32:0] d33;               // TS - last_ts, exact (33-bit two's complement; TS and last_ts are u32)

    assign framing = in_data[EOG_BU_FRAME_ERR]
                   | (|rec[EOG_D_RSV0 +: EOG_D_RSV0_W])
                   | (|rec[EOG_D_RSV1 +: EOG_D_RSV1_W])
                   | (|rec[EOG_D_RSV2 +: EOG_D_RSV2_W]);
    assign unknown  = ~fac_in_range | ~cfg_row[EOG_CFG_FLAGS];   // FLAGS[0] = slot enabled
    assign pre_drop = framing | unknown;

    assign has_ts  = ~fresh[idx];
    assign last_ts = ts_mem[idx];
    assign d33     = {1'b0, ts} - {1'b0, last_ts};
    assign t_dup   = (ts == last_ts);
    assign t_lt    = ($signed(d33) < 33'sd300);                  // negative or a partial step
    assign t_step  = (d33 == 33'd300);
    // missing = d/300 - 1 if d is a multiple of 300, else hold + 1; 1 <= missing <= hold -> GAP_HELD
    assign gap_ok  = ((d33 == 33'd600) && (hold >= 2'd1)) || ((d33 == 33'd900) && (hold >= 2'd2));

    assign d_dup    = ~pre_drop & has_ts & t_dup;
    assign d_ooo    = ~pre_drop & has_ts & ~t_dup & t_lt;
    assign drop     = pre_drop | d_dup | d_ooo;
    assign gap_held = has_ts & gap_ok;
    assign t_reset  = has_ts & ~t_step & ~gap_ok;                // missing > hold (d >= 300 when not dropped)
    assign clr      = ~has_ts | t_reset;                         // history reset at step 3 (first record: #24)

    // ------------------------------------------------------------------------------------------------------
    // Step 4: fields
    // ------------------------------------------------------------------------------------------------------
    logic [16*NF-1:0] raw;      // observed value (enums zero-extended)
    logic [NF-1:0]    pres;     // PRESENT bit
    logic [NF-1:0]    bad_enum; // illegal enum value
    logic [NF-1:0]    bad_rng;  // legal enum (or no enum) but outside its LO/HI bounds
    logic [NF-1:0]    req;      // required

    logic [16*NF-1:0] rd_val;
    logic [NF-1:0]    rd_has;
    assign rd_val = val_mem[idx];
    assign rd_has = has_mem[idx];

    function automatic logic in_lim(input logic [15:0] v, input logic [15:0] lo, input logic [15:0] hi);
        in_lim = ($signed(v) >= $signed(lo)) && ($signed(v) <= $signed(hi));
    endfunction

    logic [EOG_CFG_LO_W-1:0] lo_v, hi_v;    // 7 x s16, index = present bit
    assign lo_v = cfg_row[EOG_CFG_LO +: EOG_CFG_LO_W];
    assign hi_v = cfg_row[EOG_CFG_HI +: EOG_CFG_HI_W];

    assign raw[16*0 +: 16] = rec[EOG_D_INFLOW    +: EOG_D_INFLOW_W];
    assign raw[16*1 +: 16] = rec[EOG_D_LEVEL     +: EOG_D_LEVEL_W];
    assign raw[16*2 +: 16] = {8'd0, rec[EOG_D_PUMP_ST +: EOG_D_PUMP_ST_W]};
    assign raw[16*3 +: 16] = rec[EOG_D_PUMP_FLOW +: EOG_D_PUMP_FLOW_W];
    assign raw[16*4 +: 16] = rec[EOG_D_DIS_PSI   +: EOG_D_DIS_PSI_W];
    assign raw[16*5 +: 16] = rec[EOG_D_RECV_FLOW +: EOG_D_RECV_FLOW_W];
    assign raw[16*6 +: 16] = rec[EOG_D_PIPE_PSI  +: EOG_D_PIPE_PSI_W];

    genvar gj;
    generate
        for (gj = 0; gj < 7; gj = gj + 1) begin : g_fac_in
            if (gj == 2) begin : g_enum
                // pump status: enum {0,1,2} first (ILLEGAL_ENUM), then LO[2] <= v <= HI[2] (OUT_OF_RANGE)
                assign bad_enum[gj] = (raw[16*gj +: 16] > 16'd2);
                assign bad_rng[gj]  = ~bad_enum[gj] & ~in_lim(raw[16*gj +: 16], lo_v[16*gj +: 16], hi_v[16*gj +: 16]);
            end else begin : g_num
                assign bad_enum[gj] = 1'b0;
                assign bad_rng[gj]  = ~in_lim(raw[16*gj +: 16], lo_v[16*gj +: 16], hi_v[16*gj +: 16]);
            end
            assign pres[gj] = present[gj];
            assign req[gj]  = 1'b1;
        end
    endgenerate

    logic [15:0] w_lo, w_hi;
    assign w_lo = cfg_row[EOG_CFG_WELL_LO +: EOG_CFG_WELL_LO_W];
    assign w_hi = cfg_row[EOG_CFG_WELL_HI +: EOG_CFG_WELL_HI_W];

    genvar gi;
    generate
        for (gi = 0; gi < N_WELL; gi = gi + 1) begin : g_well_in
            localparam integer KS = 7 + gi;            // status field
            localparam integer KW = 7 + N_WELL + gi;   // water field
            localparam logic [3:0] GI4 = gi[3:0];
            assign raw[16*KS +: 16] = {14'd0, rec[EOG_D_WELL_ST + 2*gi +: 2]};
            assign raw[16*KW +: 16] = rec[EOG_D_WELL_WATER + 16*gi +: 16];
            assign pres[KS]     = present[8 + gi];
            assign pres[KW]     = present[16 + gi];
            assign bad_enum[KS] = (raw[16*KS +: 16] > 16'd1);
            assign bad_rng[KS]  = 1'b0;
            assign bad_enum[KW] = 1'b0;
            assign bad_rng[KW]  = ~in_lim(raw[16*KW +: 16], w_lo, w_hi);
            assign req[KS]      = (GI4 < n_wells);
            assign req[KW]      = (GI4 < n_wells);
        end
    endgenerate

    // ------------------------------------------------------------------------------------------------------
    // Steps 4-6: OK / held / missing, per-facility hold counter, hold limit (#70: INVALID, no reset)
    // ------------------------------------------------------------------------------------------------------
    logic [NF-1:0]    ok, has_e, held0, held, miss, fok, has_n, r_abs, r_enum, r_rng;
    logic [16*NF-1:0] used;     // value carried out (OK / held on VALID-HELD / 0)
    logic [16*NF-1:0] val_n;    // new last_valid values
    logic             any_held0, ovf, invalid, hist;
    logic [1:0]       hr_e, hr_n;

    genvar gk;
    generate
        for (gk = 0; gk < NF; gk = gk + 1) begin : g_fld
            assign ok[gk]     = req[gk] & pres[gk] & ~bad_enum[gk] & ~bad_rng[gk];
            assign has_e[gk]  = rd_has[gk] & ~clr;
            assign held0[gk]  = req[gk] & ~ok[gk] & has_e[gk];
            assign held[gk]   = held0[gk] & ~ovf;
            assign miss[gk]   = req[gk] & ~ok[gk] & ~held[gk];
            // FLD_OK / WELLS_OK: the bus carries a usable value (OK, or held on a VALID/HELD record)
            assign fok[gk]    = ok[gk] | (held[gk] & ~invalid);
            assign used[16*gk +: 16] = ok[gk]  ? raw[16*gk +: 16] :
                                       fok[gk] ? rd_val[16*gk +: 16] : 16'd0;
            assign has_n[gk]  = ok[gk] | (req[gk] & has_e[gk]);   // last_valid kept on a hold overflow
            assign val_n[16*gk +: 16] = ok[gk] ? raw[16*gk +: 16] : rd_val[16*gk +: 16];
            assign r_abs[gk]  = req[gk] & ~pres[gk];
            assign r_enum[gk] = req[gk] & pres[gk] & bad_enum[gk];
            assign r_rng[gk]  = req[gk] & pres[gk] & bad_rng[gk];
        end
    endgenerate

    assign any_held0 = |held0;
    assign hr_e      = clr ? 2'd0 : hr_mem[idx];
    assign hr_n      = ~any_held0 ? 2'd0 : ((hr_e == 2'd3) ? 2'd3 : (hr_e + 2'd1));   // min(hold_run + 1, 3)
    assign ovf       = (hr_n > hold);                             // implies any_held0 (hold >= 0)
    assign invalid   = |miss;
    assign hist      = clr;                                       // HIST_RESET / reason bit 2 (non-DROPPED)

    // ------------------------------------------------------------------------------------------------------
    // Steps 7-10: status, consistency flags, SINCE_RESET, outputs
    // ------------------------------------------------------------------------------------------------------
    logic [2:0]  status;
    assign status = drop    ? EOG_ST_DROPPED :
                    invalid ? EOG_ST_INVALID :
                    ((|held) | gap_held) ? EOG_ST_HELD : EOG_ST_VALID;

    // Consistency flags: VALID/HELD records only, on the carried (OK or held) values (features_int.py).
    logic pump_incons;
    logic [N_WELL-1:0] well_inc;
    logic [7:0] well_act;
    logic [127:0] well_water;
    logic wells_ok;
    assign pump_incons = ~invalid & (used[16*2 +: 16] != 16'd1) & ($signed(used[16*3 +: 16]) > 16'sd0);

    generate
        for (gi = 0; gi < 8; gi = gi + 1) begin : g_well_out
            if (gi < N_WELL) begin : g_on
                localparam integer KS = 7 + gi;
                localparam integer KW = 7 + N_WELL + gi;
                assign well_inc[gi] = ~invalid & req[KS] & (used[16*KS +: 16] == 16'd0)
                                    & ($signed(used[16*KW +: 16]) > 16'sd0);
                assign well_act[gi] = (used[16*KS +: 16] == 16'd1);   // 0 unless required and usable
                assign well_water[16*gi +: 16] = used[16*KW +: 16];  // 0 unless required and usable
            end else begin : g_off
                assign well_act[gi] = 1'b0;
                assign well_water[16*gi +: 16] = 16'd0;
            end
        end
    endgenerate
    assign wells_ok = &(fok[NF-1:7] | ~req[NF-1:7]);

    // SINCE_RESET: the slot's value before this record (after any reset in it); +1 after VALID/HELD.
    // Every DROPPED record carries 0 (spec question 25).
    logic [7:0] sr_e, sr_n;
    assign sr_e = hist ? 8'd0 : sr_mem[idx];
    assign sr_n = invalid ? sr_e : ((sr_e == 8'hFF) ? 8'hFF : (sr_e + 8'd1));

    // PREV_LEVEL / PREV_OK: previous VALID/HELD LEVEL since the last reset (PREV_LEVEL = 0 when PREV_OK = 0).
    logic p_ok;
    logic [15:0] prev_level;
    assign p_ok       = pok_mem[idx] & ~hist;
    assign prev_level = p_ok ? pl_mem[idx] : 16'd0;

    logic [15:0] reason;
    always_comb begin
        reason = 16'd0;
        if (framing)      reason[EOG_R_FRAMING]      = 1'b1;
        else if (unknown) reason[EOG_R_UNKNOWN_FAC]  = 1'b1;
        else if (d_dup)   reason[EOG_R_DUPLICATE]    = 1'b1;
        else if (d_ooo)   reason[EOG_R_OUT_OF_ORDER] = 1'b1;
        else begin
            reason[EOG_R_FIELD_HELD]   = |held;
            reason[EOG_R_GAP_HELD]     = gap_held;
            reason[EOG_R_HIST_RESET]   = hist;
            reason[EOG_R_OUT_OF_RANGE] = |r_rng;
            reason[EOG_R_ILLEGAL_ENUM] = |r_enum;
            reason[EOG_R_PUMP_INCONS]  = pump_incons;
            reason[EOG_R_WELL_INCONS]  = |well_inc;
            reason[EOG_R_FIELD_ABSENT] = |r_abs;
            reason[EOG_R_FIELD_LOST]   = invalid;
        end
    end

    // Next output bus. Bus V fields tile all EOG_BV_W bits; everything after SINCE_RESET is 0 for DROPPED.
    logic [EOG_BV_W-1:0] nd;
    assign nd[EOG_BV_REC_NO  +: EOG_BV_REC_NO_W]  = in_data[EOG_BU_REC_NO +: EOG_BU_REC_NO_W];
    assign nd[EOG_BV_IN_LAST]                     = in_data[EOG_BU_IN_LAST];
    assign nd[EOG_BV_FAC_RAW +: EOG_BV_FAC_RAW_W] = fac_id;
    assign nd[EOG_BV_FAC     +: EOG_BV_FAC_W]     = fac_id[4:0];
    assign nd[EOG_BV_TS      +: EOG_BV_TS_W]      = ts;
    assign nd[EOG_BV_STATUS  +: EOG_BV_STATUS_W]  = status;
    assign nd[EOG_BV_REASON  +: EOG_BV_REASON_W]  = reason;
    assign nd[EOG_BV_SINCE_RESET +: EOG_BV_SINCE_RESET_W] = drop ? 8'd0 : sr_e;
    assign nd[EOG_BV_HIST_RESET]                          = ~drop & hist;
    assign nd[EOG_BV_INFLOW     +: EOG_BV_INFLOW_W]       = drop ? 16'd0 : used[16*0 +: 16];
    assign nd[EOG_BV_LEVEL      +: EOG_BV_LEVEL_W]        = drop ? 16'd0 : used[16*1 +: 16];
    assign nd[EOG_BV_PUMP_ST    +: EOG_BV_PUMP_ST_W]      = drop ? 2'd0  : used[16*2 +: 2];
    assign nd[EOG_BV_PUMP_FLOW  +: EOG_BV_PUMP_FLOW_W]    = drop ? 16'd0 : used[16*3 +: 16];
    assign nd[EOG_BV_DIS_PSI    +: EOG_BV_DIS_PSI_W]      = drop ? 16'd0 : used[16*4 +: 16];
    assign nd[EOG_BV_RECV_FLOW  +: EOG_BV_RECV_FLOW_W]    = drop ? 16'd0 : used[16*5 +: 16];
    assign nd[EOG_BV_PIPE_PSI   +: EOG_BV_PIPE_PSI_W]     = drop ? 16'd0 : used[16*6 +: 16];
    assign nd[EOG_BV_WELL_ACT   +: EOG_BV_WELL_ACT_W]     = drop ? 8'd0  : well_act;
    assign nd[EOG_BV_WELL_WATER +: EOG_BV_WELL_WATER_W]   = drop ? 128'd0 : well_water;
    assign nd[EOG_BV_FLD_OK     +: EOG_BV_FLD_OK_W]       = drop ? 7'd0  : fok[6:0];
    assign nd[EOG_BV_WELLS_OK]                            = ~drop & wells_ok;
    assign nd[EOG_BV_PREV_LEVEL +: EOG_BV_PREV_LEVEL_W]   = drop ? 16'd0 : prev_level;
    assign nd[EOG_BV_PREV_OK]                             = ~drop & p_ok;

    // ------------------------------------------------------------------------------------------------------
    // Registers
    // ------------------------------------------------------------------------------------------------------
    logic acc, commit;
    assign acc    = in_valid & ~ov;
    assign commit = acc & ~drop & rst_n;

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            ov    <= 1'b0;
            fresh <= '1;
        end else begin
            if (ov && out_ready) ov <= 1'b0;
            if (acc)             ov <= 1'b1;
            fresh <= fresh | fac_touch;
            if (commit) fresh[idx] <= fac_touch[idx];
        end
    end

    always_ff @(posedge clk) begin
        if (acc) od <= nd;
    end

    // Per-slot state: one write port, async read (LUTRAM). Written only for non-DROPPED records.
    always_ff @(posedge clk) begin
        if (commit) begin
            ts_mem[idx]  <= ts;
            sr_mem[idx]  <= sr_n;
            hr_mem[idx]  <= hr_n;
            if (!invalid) pl_mem[idx] <= used[16*1 +: 16];   // INVALID keeps prev_level (p_ok says if valid)
            pok_mem[idx] <= ~invalid | p_ok;
            val_mem[idx] <= val_n;
            has_mem[idx] <= has_n;
        end
    end

`ifdef FORMAL
    // ------------------------------------------------------------------------------------------------------
    // Internal invariants (help k-induction; about this module's own state only)
    // ------------------------------------------------------------------------------------------------------
    // Observation ports: one record at a time, held in the output buffer from accept to transfer.
    assign f_inflight     = {7'd0, ov};
    assign f_oldest_recno = od[EOG_BV_REC_NO +: EOG_BV_REC_NO_W];

    logic [2:0]    f_ost;
    logic [FW-1:0] f_oi;
    logic [15:0]   f_orsn;
    logic [7:0]    f_osr;
    assign f_ost  = od[EOG_BV_STATUS +: EOG_BV_STATUS_W];
    assign f_oi   = od[EOG_BV_FAC +: FW];
    assign f_orsn = od[EOG_BV_REASON +: EOG_BV_REASON_W];
    assign f_osr  = od[EOG_BV_SINCE_RESET +: EOG_BV_SINCE_RESET_W];

    // Per-slot state (meaningful only once the slot is not fresh; the arrays are not reset):
    // stored enums legal. (No labels inside generate loops: Yosys names procedural assertions by label only,
    // so a label repeated per slot collides.)
    genvar fs, fk;
    generate
        for (fs = 0; fs < N_FAC; fs = fs + 1) begin : g_fv_slot
            for (fk = 0; fk < NF; fk = fk + 1) begin : g_fv_fld
                always_comb begin
                    if (rst_n && !fresh[fs] && has_mem[fs][fk]) begin
                        if (fk == 2)          assert (val_mem[fs][16*fk +: 16] <= 16'd2);
                        if (fk >= 7 && fk < 7 + N_WELL)
                                              assert (val_mem[fs][16*fk +: 16] <= 16'd1);
                    end
                end
            end
        end
    endgenerate

    // The record in the output buffer is consistent with the state it wrote.
    always_comb begin
        if (rst_n && ov) begin
            fi_st_code: assert (f_ost == EOG_ST_VALID || f_ost == EOG_ST_HELD ||
                                f_ost == EOG_ST_INVALID || f_ost == EOG_ST_DROPPED);
            fi_fac: assert (od[EOG_BV_FAC +: EOG_BV_FAC_W] == od[EOG_BV_FAC_RAW +: EOG_BV_FAC_W]);
            if (f_ost == EOG_ST_DROPPED) begin
                fi_drop_hr: assert (!od[EOG_BV_HIST_RESET]);
                fi_drop_pk: assert (!od[EOG_BV_PREV_OK]);
                fi_drop_sr: assert (f_osr == 8'd0);
            end else begin
                fi_inrange: assert (od[EOG_BV_FAC_RAW +: EOG_BV_FAC_RAW_W] < NFAC16);
                fi_lost:    assert (f_orsn[EOG_R_FIELD_LOST] == (f_ost == EOG_ST_INVALID));
                fi_hr_sr:   assert (!od[EOG_BV_HIST_RESET] || (f_osr == 8'd0));
                fi_hr_pk:   assert (!od[EOG_BV_HIST_RESET] || !od[EOG_BV_PREV_OK]);
                fi_ts:      assert (ts_mem[f_oi] == od[EOG_BV_TS +: EOG_BV_TS_W]);
                // hold_run after the record: 0 unless a field was held or lost to the hold limit (INVALID);
                // never above 2 after a VALID/HELD record (hold <= 2).
                fi_hrun0:   assert (f_orsn[EOG_R_FIELD_HELD] || (f_ost == EOG_ST_INVALID) || (hr_mem[f_oi] == 2'd0));
                fi_hrun1:   assert (!f_orsn[EOG_R_FIELD_HELD] || (hr_mem[f_oi] != 2'd0));
                fi_hrun2:   assert ((f_ost == EOG_ST_INVALID) || (hr_mem[f_oi] != 2'd3));
                if (!od[EOG_BV_PREV_OK]) fi_pl0: assert (od[EOG_BV_PREV_LEVEL +: 16] == 16'd0);
                if (f_ost == EOG_ST_INVALID) begin
                    fi_sr_inv:  assert (sr_mem[f_oi] == f_osr);
                    fi_pok_inv: assert (pok_mem[f_oi] == od[EOG_BV_PREV_OK]);
                    if (od[EOG_BV_PREV_OK])
                        fi_pl_inv: assert (pl_mem[f_oi] == od[EOG_BV_PREV_LEVEL +: 16]);
                end else begin
                    fi_sr:   assert (sr_mem[f_oi] == ((f_osr == 8'hFF) ? 8'hFF : (f_osr + 8'd1)));
                    fi_pok:  assert (pok_mem[f_oi]);
                    fi_pl:   assert (pl_mem[f_oi] == od[EOG_BV_LEVEL +: EOG_BV_LEVEL_W]);
                    fi_fok:  assert (od[EOG_BV_FLD_OK +: EOG_BV_FLD_OK_W] == 7'h7F);
                    fi_wok:  assert (od[EOG_BV_WELLS_OK]);
                    fi_has:  assert (has_mem[f_oi][6:0] == 7'h7F);
                end
                // Facility fields carried on the bus (FLD_OK) are the stored last_valid values.
                if (od[EOG_BV_FLD_OK + 0]) fi_v0: assert (has_mem[f_oi][0] && val_mem[f_oi][16*0 +: 16] == od[EOG_BV_INFLOW    +: 16]);
                if (od[EOG_BV_FLD_OK + 1]) fi_v1: assert (has_mem[f_oi][1] && val_mem[f_oi][16*1 +: 16] == od[EOG_BV_LEVEL     +: 16]);
                if (od[EOG_BV_FLD_OK + 2]) fi_v2: assert (has_mem[f_oi][2] && val_mem[f_oi][16*2 +: 16] == {14'd0, od[EOG_BV_PUMP_ST +: 2]});
                if (od[EOG_BV_FLD_OK + 3]) fi_v3: assert (has_mem[f_oi][3] && val_mem[f_oi][16*3 +: 16] == od[EOG_BV_PUMP_FLOW +: 16]);
                if (od[EOG_BV_FLD_OK + 4]) fi_v4: assert (has_mem[f_oi][4] && val_mem[f_oi][16*4 +: 16] == od[EOG_BV_DIS_PSI   +: 16]);
                if (od[EOG_BV_FLD_OK + 5]) fi_v5: assert (has_mem[f_oi][5] && val_mem[f_oi][16*5 +: 16] == od[EOG_BV_RECV_FLOW +: 16]);
                if (od[EOG_BV_FLD_OK + 6]) fi_v6: assert (has_mem[f_oi][6] && val_mem[f_oi][16*6 +: 16] == od[EOG_BV_PIPE_PSI  +: 16]);
            end
        end
    end
`endif
endmodule
