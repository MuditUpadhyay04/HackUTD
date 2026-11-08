// eog_validate -- framing, facility, time and field checks; hold/reset. Decides every record's STATUS.
// Spec v2: spec/modules/eog_validate.md, spec/numerics.md section 3 (steps 1-9), conventions.md section 7.
//
// Micro-architecture (one record at a time):
//   * The whole decision is combinational in the accept cycle: cfg_fac = FAC_ID[4:0] reads the CONFIG row
//     (conventions 5), the per-slot state is read asynchronously (32-deep arrays -> LUTRAM), and the result is
//     registered into the output buffer together with the per-slot state update.
//   * in_ready = !out_valid, so latency = 1 cycle and II = 2 cycles with out_ready = 1.
//   * No reset sweep: `pending` (one flop per slot, set by reset and by fac_touch) forces a new history on the
//     slot's next accepted record, and a new history never reads the RAM contents, so the arrays need no reset.
//   * A fac_touch in the accept cycle of a record of that slot (or later) applies to the slot's next record.
//
// Field index k (0 .. NF-1) used for the uniform hold logic:
//   0..6            facility fields in DATA PRESENT bit order: 0 inflow, 1 level, 2 pump status, 3 pump flow,
//                   4 discharge psi, 5 receive flow, 6 pipeline psi   (FLD_OK bit k = field k)
//   7+i             well status, slot i (i < N_WELL)
//   7+N_WELL+i      well water,  slot i
// A field is required iff k < 7 or its well slot i < n_wells = min(CFG.N_WELLS, N_WELL).
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
    logic [N_FAC-1:0]  pending;                 // next accepted record of the slot starts a new history
    logic [31:0]       ts_mem   [0:N_FAC-1];    // last_ts
    logic [7:0]        sr_mem   [0:N_FAC-1];    // since_reset of the last accepted record
    logic [15:0]       pl_mem   [0:N_FAC-1];    // LEVEL output of the last accepted record (PREV_LEVEL)
    logic [16*NF-1:0]  val_mem  [0:N_FAC-1];    // per field: last value
    logic [NF-1:0]     has_mem  [0:N_FAC-1];    // per field: has a last value
    logic [2*NF-1:0]   miss_mem [0:N_FAC-1];    // per field: consecutive holds (0..2)

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
    assign rec    = in_data[EOG_BU_REC +: EOG_BU_REC_W];
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
    // Steps 1-4: framing, facility, time, new history
    // ------------------------------------------------------------------------------------------------------
    logic framing, unknown, pend, t_dup, t_ooo, t_step, gap_ok;
    logic d_dup, d_ooo, drop, gap_held, new_hist;
    logic [31:0] last_ts, dts;

    assign framing = in_data[EOG_BU_FRAME_ERR]
                   | (|rec[EOG_D_RSV0 +: EOG_D_RSV0_W])
                   | (|rec[EOG_D_RSV1 +: EOG_D_RSV1_W])
                   | (|rec[EOG_D_RSV2 +: EOG_D_RSV2_W]);
    assign unknown = ~fac_in_range | ~cfg_row[EOG_CFG_FLAGS];

    assign pend    = pending[idx];
    assign last_ts = ts_mem[idx];
    assign dts     = ts - last_ts;
    assign t_dup   = (ts == last_ts);
    assign t_ooo   = (ts < last_ts);
    assign t_step  = (dts == 32'd300);
    assign gap_ok  = ((dts == 32'd600) && (hold >= 2'd1)) || ((dts == 32'd900) && (hold >= 2'd2));

    assign d_dup    = ~framing & ~unknown & ~pend & t_dup;
    assign d_ooo    = ~framing & ~unknown & ~pend & ~t_dup & t_ooo;
    assign drop     = framing | unknown | d_dup | d_ooo;
    assign gap_held = ~pend & gap_ok;
    assign new_hist = pend | (~t_step & ~gap_ok);

    // ------------------------------------------------------------------------------------------------------
    // Step 5: fields
    // ------------------------------------------------------------------------------------------------------
    logic [16*NF-1:0] raw;      // observed value (enums zero-extended)
    logic [NF-1:0]    pres;     // PRESENT bit
    logic [NF-1:0]    legal;    // enum legal / within limits
    logic [NF-1:0]    is_enum;
    logic [NF-1:0]    req;      // required

    logic [16*NF-1:0] rd_val;
    logic [NF-1:0]    rd_has;
    logic [2*NF-1:0]  rd_miss;
    assign rd_val  = val_mem[idx];
    assign rd_has  = has_mem[idx];
    assign rd_miss = miss_mem[idx];

    // Facility fields 0..6. LO/HI index j: 0 inflow, 1 level, 2 pump flow, 3 receive flow, 4 discharge, 5 pipe.
    function automatic logic in_lim(input logic [15:0] v, input logic [15:0] lo, input logic [15:0] hi);
        in_lim = ($signed(v) >= $signed(lo)) && ($signed(v) <= $signed(hi));
    endfunction

    /* verilator lint_off UNUSEDSIGNAL */
    logic [EOG_CFG_LO_W-1:0] lo_v, hi_v;   // LO/HI index 6 is unused (eog_defs.svh)
    /* verilator lint_on UNUSEDSIGNAL */
    assign lo_v = cfg_row[EOG_CFG_LO +: EOG_CFG_LO_W];
    assign hi_v = cfg_row[EOG_CFG_HI +: EOG_CFG_HI_W];

    assign raw[16*0 +: 16] = rec[EOG_D_INFLOW    +: EOG_D_INFLOW_W];
    assign raw[16*1 +: 16] = rec[EOG_D_LEVEL     +: EOG_D_LEVEL_W];
    assign raw[16*2 +: 16] = {8'd0, rec[EOG_D_PUMP_ST +: EOG_D_PUMP_ST_W]};
    assign raw[16*3 +: 16] = rec[EOG_D_PUMP_FLOW +: EOG_D_PUMP_FLOW_W];
    assign raw[16*4 +: 16] = rec[EOG_D_DIS_PSI   +: EOG_D_DIS_PSI_W];
    assign raw[16*5 +: 16] = rec[EOG_D_RECV_FLOW +: EOG_D_RECV_FLOW_W];
    assign raw[16*6 +: 16] = rec[EOG_D_PIPE_PSI  +: EOG_D_PIPE_PSI_W];

    assign legal[0] = in_lim(raw[16*0 +: 16], lo_v[16*0 +: 16], hi_v[16*0 +: 16]);
    assign legal[1] = in_lim(raw[16*1 +: 16], lo_v[16*1 +: 16], hi_v[16*1 +: 16]);
    assign legal[2] = (raw[16*2 +: 16] <= 16'd2);
    assign legal[3] = in_lim(raw[16*3 +: 16], lo_v[16*2 +: 16], hi_v[16*2 +: 16]);
    assign legal[4] = in_lim(raw[16*4 +: 16], lo_v[16*4 +: 16], hi_v[16*4 +: 16]);
    assign legal[5] = in_lim(raw[16*5 +: 16], lo_v[16*3 +: 16], hi_v[16*3 +: 16]);
    assign legal[6] = in_lim(raw[16*6 +: 16], lo_v[16*5 +: 16], hi_v[16*5 +: 16]);

    assign pres[6:0]    = present[6:0];
    assign is_enum[6:0] = 7'b0000100;
    assign req[6:0]     = 7'b1111111;

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
            assign pres[KS]    = present[8 + gi];
            assign pres[KW]    = present[16 + gi];
            assign legal[KS]   = (raw[16*KS +: 16] <= 16'd1);
            assign legal[KW]   = in_lim(raw[16*KW +: 16], w_lo, w_hi);
            assign is_enum[KS] = 1'b1;
            assign is_enum[KW] = 1'b0;
            assign req[KS]     = (GI4 < n_wells);
            assign req[KW]     = (GI4 < n_wells);
        end
    endgenerate

    // Uniform hold logic
    logic [NF-1:0]    obs, held, lost, fok, r_abs, r_enum, r_rng;
    logic [16*NF-1:0] used;     // value carried out (observed / held / 0); also the new last value
    logic [2*NF-1:0]  nmiss;    // new miss counter

    genvar gk;
    generate
        for (gk = 0; gk < NF; gk = gk + 1) begin : g_fld
            logic       has_e;
            logic [1:0] miss_e;
            assign has_e  = rd_has[gk] & ~new_hist;
            assign miss_e = new_hist ? 2'd0 : rd_miss[2*gk +: 2];
            assign obs[gk]  = pres[gk] & legal[gk];
            assign held[gk] = req[gk] & ~obs[gk] & has_e & (miss_e < hold);
            assign lost[gk] = req[gk] & ~obs[gk] & ~held[gk];
            assign fok[gk]  = req[gk] & (obs[gk] | held[gk]);
            assign used[16*gk +: 16] = ~req[gk] ? 16'd0 :
                                       obs[gk]  ? raw[16*gk +: 16] :
                                       held[gk] ? rd_val[16*gk +: 16] : 16'd0;
            assign nmiss[2*gk +: 2] = held[gk] ? (miss_e + 2'd1) : 2'd0;
            assign r_abs[gk]  = req[gk] & ~pres[gk];
            assign r_enum[gk] = req[gk] & pres[gk] & ~legal[gk] & is_enum[gk];
            assign r_rng[gk]  = req[gk] & pres[gk] & ~legal[gk] & ~is_enum[gk];
        end
    endgenerate

    // ------------------------------------------------------------------------------------------------------
    // Steps 6-9: status, consistency flags, outputs
    // ------------------------------------------------------------------------------------------------------
    logic [2:0]  status;
    logic        st_invalid;
    assign st_invalid = |lost;
    assign status = drop        ? EOG_ST_DROPPED :
                    st_invalid  ? EOG_ST_INVALID :
                    ((|held) | gap_held) ? EOG_ST_HELD : EOG_ST_VALID;

    // Consistency flags use the carried values and only fields that are OK after hold.
    logic pump_incons;
    logic [N_WELL-1:0] well_inc;
    logic [7:0] well_act;
    logic [127:0] well_water;
    logic wells_ok;
    assign pump_incons = fok[2] & fok[3] & (used[16*2 +: 16] != 16'd1) & ($signed(used[16*3 +: 16]) > 16'sd0);

    generate
        for (gi = 0; gi < 8; gi = gi + 1) begin : g_well_out
            if (gi < N_WELL) begin : g_on
                localparam integer KS = 7 + gi;
                localparam integer KW = 7 + N_WELL + gi;
                assign well_inc[gi] = fok[KS] & fok[KW] & (used[16*KS +: 16] == 16'd0)
                                    & ($signed(used[16*KW +: 16]) > 16'sd0);
                assign well_act[gi] = (used[16*KS +: 16] == 16'd1);   // 0 unless required and OK
                assign well_water[16*gi +: 16] = used[16*KW +: 16];  // 0 unless required and OK
            end else begin : g_off
                assign well_act[gi] = 1'b0;
                assign well_water[16*gi +: 16] = 16'd0;
            end
        end
    endgenerate
    assign wells_ok = &(fok[NF-1:7] | ~req[NF-1:7]);

    logic [7:0] since;
    assign since = new_hist ? 8'd0 : ((sr_mem[idx] == 8'hFF) ? 8'hFF : (sr_mem[idx] + 8'd1));

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
            reason[EOG_R_HIST_RESET]   = new_hist;
            reason[EOG_R_OUT_OF_RANGE] = |r_rng;
            reason[EOG_R_ILLEGAL_ENUM] = |r_enum;
            reason[EOG_R_PUMP_INCONS]  = pump_incons;
            reason[EOG_R_WELL_INCONS]  = |well_inc;
            reason[EOG_R_FIELD_ABSENT] = |r_abs;
            reason[EOG_R_FIELD_LOST]   = st_invalid;
        end
    end

    // Next output bus. Bus V fields tile all EOG_BV_W bits; everything after REASON is 0 for DROPPED.
    logic [EOG_BV_W-1:0] nd;
    logic [15:0] prev_level;
    assign prev_level = pl_mem[idx];
    assign nd[EOG_BV_REC_NO  +: EOG_BV_REC_NO_W]  = in_data[EOG_BU_REC_NO +: EOG_BU_REC_NO_W];
    assign nd[EOG_BV_IN_LAST]                     = in_data[EOG_BU_IN_LAST];
    assign nd[EOG_BV_FAC_RAW +: EOG_BV_FAC_RAW_W] = fac_id;
    assign nd[EOG_BV_FAC     +: EOG_BV_FAC_W]     = fac_id[4:0];
    assign nd[EOG_BV_TS      +: EOG_BV_TS_W]      = ts;
    assign nd[EOG_BV_STATUS  +: EOG_BV_STATUS_W]  = status;
    assign nd[EOG_BV_REASON  +: EOG_BV_REASON_W]  = reason;
    assign nd[EOG_BV_SINCE_RESET +: EOG_BV_SINCE_RESET_W] = drop ? 8'd0  : since;
    assign nd[EOG_BV_HIST_RESET]                          = ~drop & new_hist;
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
    assign nd[EOG_BV_PREV_LEVEL +: EOG_BV_PREV_LEVEL_W]   = (drop | new_hist) ? 16'd0 : prev_level;
    assign nd[EOG_BV_PREV_OK]                             = ~drop & ~new_hist;

    // ------------------------------------------------------------------------------------------------------
    // Registers
    // ------------------------------------------------------------------------------------------------------
    logic acc, commit;
    assign acc    = in_valid & ~ov;
    assign commit = acc & ~drop & rst_n;

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            ov      <= 1'b0;
            pending <= '1;
        end else begin
            if (ov && out_ready) ov <= 1'b0;
            if (acc)             ov <= 1'b1;
            pending <= pending | fac_touch;
            if (commit) pending[idx] <= st_invalid | fac_touch[idx];
        end
    end

    always_ff @(posedge clk) begin
        if (acc) od <= nd;
    end

    // Per-slot state: one write port, async read (LUTRAM). Written only for non-DROPPED records.
    always_ff @(posedge clk) begin
        if (commit) begin
            ts_mem[idx]   <= ts;
            sr_mem[idx]   <= since;
            pl_mem[idx]   <= used[16*1 +: 16];
            val_mem[idx]  <= used;
            has_mem[idx]  <= fok;
            miss_mem[idx] <= nmiss;
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
    assign f_ost = od[EOG_BV_STATUS +: EOG_BV_STATUS_W];
    assign f_oi  = od[EOG_BV_FAC +: FW];

    // Per-slot field state (meaningful only once the slot has no pending reset; the arrays are not reset):
    // counters bounded, no counter without a value, stored enums legal.
    genvar fs, fk;
    generate
        for (fs = 0; fs < N_FAC; fs = fs + 1) begin : g_fv_slot
            for (fk = 0; fk < NF; fk = fk + 1) begin : g_fv_fld
                always_comb begin
                    if (rst_n && !pending[fs]) begin
                        assert (miss_mem[fs][2*fk +: 2] <= 2'd2);
                        if (!has_mem[fs][fk]) assert (miss_mem[fs][2*fk +: 2] == 2'd0);
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
                fi_drop_sr: assert (od[EOG_BV_SINCE_RESET +: EOG_BV_SINCE_RESET_W] == 8'd0);
                fi_drop_hr: assert (!od[EOG_BV_HIST_RESET]);
            end else begin
                fi_inrange: assert (od[EOG_BV_FAC_RAW +: EOG_BV_FAC_RAW_W] < NFAC16);
                fi_hr_sr:   assert (od[EOG_BV_HIST_RESET] == (od[EOG_BV_SINCE_RESET +: EOG_BV_SINCE_RESET_W] == 8'd0));
                fi_prevok:  assert (od[EOG_BV_PREV_OK] == !od[EOG_BV_HIST_RESET]);
                fi_ts:      assert (ts_mem[f_oi] == od[EOG_BV_TS +: EOG_BV_TS_W]);
                fi_sr:      assert (sr_mem[f_oi] == od[EOG_BV_SINCE_RESET +: EOG_BV_SINCE_RESET_W]);
                fi_pl:      assert (pl_mem[f_oi] == od[EOG_BV_LEVEL +: EOG_BV_LEVEL_W]);
                fi_has:     assert (has_mem[f_oi][6:0] == od[EOG_BV_FLD_OK +: EOG_BV_FLD_OK_W]);
                fi_v0:      assert (val_mem[f_oi][16*0 +: 16] == od[EOG_BV_INFLOW    +: 16]);
                fi_v1:      assert (val_mem[f_oi][16*1 +: 16] == od[EOG_BV_LEVEL     +: 16]);
                fi_v2:      assert (val_mem[f_oi][16*2 +: 16] == {14'd0, od[EOG_BV_PUMP_ST +: 2]});
                fi_v3:      assert (val_mem[f_oi][16*3 +: 16] == od[EOG_BV_PUMP_FLOW +: 16]);
                fi_v4:      assert (val_mem[f_oi][16*4 +: 16] == od[EOG_BV_DIS_PSI   +: 16]);
                fi_v5:      assert (val_mem[f_oi][16*5 +: 16] == od[EOG_BV_RECV_FLOW +: 16]);
                fi_v6:      assert (val_mem[f_oi][16*6 +: 16] == od[EOG_BV_PIPE_PSI  +: 16]);
                if (f_ost == EOG_ST_INVALID) fi_pend: assert (pending[f_oi]);
            end
        end
    end

    generate
        for (gi = 0; gi < N_WELL; gi = gi + 1) begin : g_fv_well
            always_comb begin
                if (rst_n && ov && f_ost != EOG_ST_DROPPED) begin
                    assert (val_mem[f_oi][16*(7+gi) +: 16] == {15'd0, od[EOG_BV_WELL_ACT + gi]});
                    assert (val_mem[f_oi][16*(7+N_WELL+gi) +: 16] == od[EOG_BV_WELL_WATER + 16*gi +: 16]);
                end
            end
        end
    endgenerate
`endif
endmodule
