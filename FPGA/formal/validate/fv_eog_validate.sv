// fv_eog_validate.sv — formal harness for eog_validate (Verify role, task T1.validate.fv).
//
// Written from spec/modules/eog_validate.md, spec/numerics.md §3 (spec v2, FROZEN), spec/conventions.md and the
// lead's answers in TASKS.md "Spec questions" #12-#14 plus the T1.validate.fv clarifications (quoted at the
// properties that use them). The RTL internals are not read: the DUT is seen through its spec ports and the two
// formal-only observation ports of conventions §7 (f_inflight, f_oldest_recno). Run: `bash scripts/formal.sh
// validate` (formal/validate/eog_validate.sby).
//
// Sizes: N_FAC = 2, N_WELL = 2 (so 7 + 2*2 = 11 tracked fields per slot). CONFIG rows are per-slot anyconst
// (conventions §5: an enabled row never changes; formal keeps every row constant, row rewrites are covered by
// the simulation vectors), GLOBAL is anyconst, `cfg_row` for cfg_fac >= N_FAC is free every cycle.
// `fac_touch` and `rst_n` (after the first cycle) are free every cycle.
//
// Three kinds of checks:
//   1. Stage contract (conventions §2-§3, §7): eog_fv_axis on both links, eog_fv_stage (REC_NO order, nothing
//      lost or invented, <= 2 in flight, II <= 16, latency <= 128, RAM sweep of up to N_FAC + 8 cycles allowed).
//   2. Per-record properties: the output of a record against that record's own input (captured in a 2-entry
//      shadow FIFO when accepted), the constant CONFIG row and GLOBAL. They need no per-slot history, so they are
//      k-inductive (task `prove`, every handshake schedule, full data widths): HDR ST RSN V1 V2 V3_rsn V3_only
//      V4 PRV0 V11 V8_* V11_w0 HR HR_new HR_cont HLD0 INC_*.
//   3. History properties (`bmc` tasks; -DFV_NO_HIST removes them): they relate a record to earlier records of
//      its slot. The DUT keeps that history in per-slot RAM that a port-only harness cannot see, so no harness
//      shadow of it is k-inductive (induction can start with shadow != DUT RAM and keep the slot idle for k
//      steps); they are checked by BMC from reset instead. All of them watch ONE anyconst slot (f_slot) and are
//      built from the DUT's own outputs in output order (= acceptance order), so each check relates a record to
//      the slot's earlier, already-checked outputs:
//      - V3 (time part) V5 V7 V9 V10 V12: shadow of the slot's has_ts / pending / last_ts / SINCE_RESET / LEVEL.
//      - V6: one anyconst field (f_fld): run of records without an observed OK value, last observed value.
//      - REF / V13: fv_validate_ref (below, an independent reading of numerics.md §3; the testbench checks it is
//        bit-exact with model/eog_ref.py through the throwaway stub) applied to the record and that shadow
//        state; every output bit of the slot's records must match. The state depends only on the slot's own
//        records, touches and resets, so equality with the other slot's records interleaved is V13.
//      Speed-ups for BMC (each documented where defined; none is used by `prove`): FV_FAST (in_valid and
//      out_ready held 1, no mid-run reset: the schedule-dependent properties are all in `prove`), FV_NO_REC
//      (per-record properties already proven), FV_NARROW (4-bit data values, 12-bit TS window), FV_NO_REF.
//
// Ordering of fac_touch (lead clarification): a touch of slot f in the cycle a slot-f record is accepted, or
// while it is held, applies to f's next record. In general a touch in cycle t applies to the records accepted
// after cycle t. Reset sets pending/has_ts of every slot.
//
// Input assumptions (all tasks): the handshake rules of the input link and the low 8 REC_NO bits counting
// accepted records (eog_fv_stage). Nothing else is assumed about record contents (TS, FAC_ID, PRESENT, values,
// reserved fields, FRAME_ERR, IN_LAST, upper REC_NO bits) unless FV_NARROW / FV_FAST are defined (bmc only).

`default_nettype none

// =============================================================================================================
// fv_validate_ref: reference of numerics.md §3 for one record (combinational). Inputs: bus U, the record's
// CONFIG row, GLOBAL, and the pre-record state of the record's slot. Outputs: bus V, `upd` (record is not
// DROPPED, so the slot state takes the n_* values), and the record-only decode (d_*) used by the per-record
// properties. Field index k: 0..6 facility fields in PRESENT-bit order (0 inflow, 1 level, 2 pump status,
// 3 pump flow, 4 discharge, 5 receive flow, 6 pipeline psi); 7..7+N_WELL-1 well status i; 7+N_WELL.. well water i.
// Per-field state: last value (16), has-value bit, 2-bit miss counter.
// ---- BEGIN fv_validate_ref ----
module fv_validate_ref #(
    parameter integer N_FAC  = 2,
    parameter integer N_WELL = 2,
    parameter integer NFLD   = 7 + 2 * N_WELL
) (
    input  logic [417:0]       u,            // bus U (EOG_BU_W)
    input  logic [511:0]       row,          // CONFIG row of slot FAC_ID[4:0]
    input  logic [255:0]       glb,          // GLOBAL
    input  logic               s_has_ts,
    input  logic               s_pend,
    input  logic [31:0]        s_last_ts,
    input  logic [7:0]         s_since,
    input  logic [15:0]        s_prev_level,
    input  logic               s_prev_ok,
    input  logic [NFLD*16-1:0] s_fval,
    input  logic [NFLD-1:0]    s_fhas,
    input  logic [NFLD*2-1:0]  s_fmiss,
    output logic [372:0]       v,            // bus V (EOG_BV_W)
    output logic               upd,
    output logic               n_has_ts,
    output logic               n_pend,
    output logic [31:0]        n_last_ts,
    output logic [7:0]         n_since,
    output logic [15:0]        n_prev_level,
    output logic               n_prev_ok,
    output logic [NFLD*16-1:0] n_fval,
    output logic [NFLD-1:0]    n_fhas,
    output logic [NFLD*2-1:0]  n_fmiss,
    output logic               d_framing,    // step 1 condition
    output logic               d_unknown,    // step 2 condition (FAC_ID >= N_FAC or FLAGS[0] = 0)
    output logic [NFLD-1:0]    d_req,        // field required (facility fields; wells i < n_wells)
    output logic [NFLD-1:0]    d_present,
    output logic [NFLD-1:0]    d_legal,      // enum legal (1 for readings)
    output logic [NFLD-1:0]    d_inr,        // within LO/HI (1 for enums)
    output logic [NFLD-1:0]    d_obs,        // observed OK
    output logic [NFLD*16-1:0] d_raw,        // raw value (pump status zero-extended from u8, well status from 2 bits)
    output logic [3:0]         d_n_wells,    // min(CFG.N_WELLS, N_WELL)  (TASKS #14)
    output logic [1:0]         d_hold        // min(G.HOLD_MAX, 2)
);
`include "eog_defs.svh"

    logic [383:0] r;
    logic [15:0]  fac_raw;
    logic [31:0]  ts, dts;
    logic [7:0]   nwc, hm;
    logic         tchk, dup, ooo, t_norm, t_gap, nh, drop;
    logic [15:0]  drop_rsn;

    assign r       = u[EOG_BU_REC +: EOG_BU_REC_W];
    assign fac_raw = r[EOG_D_FAC_ID +: 16];
    assign ts      = r[EOG_D_TS +: 32];
    assign nwc     = row[EOG_CFG_N_WELLS +: 8];
    assign hm      = glb[EOG_G_HOLD_MAX +: 8];
    assign d_n_wells = (nwc > N_WELL) ? 4'(N_WELL) : nwc[3:0];
    assign d_hold    = (hm >= 8'd2) ? 2'd2 : hm[1:0];

    // 1-3: framing, facility, time
    assign d_framing = u[EOG_BU_FRAME_ERR] | (|r[EOG_D_RSV0 +: EOG_D_RSV0_W]) | (|r[EOG_D_RSV1 +: EOG_D_RSV1_W]) |
                       (|r[EOG_D_RSV2 +: EOG_D_RSV2_W]);
    assign d_unknown = (fac_raw >= 16'(N_FAC)) | ~row[EOG_CFG_FLAGS];
    assign tchk   = s_has_ts & ~s_pend;
    assign dup    = tchk & (ts == s_last_ts);
    assign ooo    = tchk & (ts < s_last_ts);
    assign dts    = ts - s_last_ts;
    assign t_norm = tchk & (dts == 32'd300);
    assign t_gap  = tchk & (((dts == 32'd600) & (d_hold >= 2'd1)) | ((dts == 32'd900) & (d_hold >= 2'd2)));
    assign nh     = ~(t_norm | t_gap);                        // 4: new history
    assign drop   = d_framing | d_unknown | dup | ooo;
    assign upd    = ~drop;
    always_comb begin
        drop_rsn = '0;
        if (d_framing)      drop_rsn[EOG_R_FRAMING]      = 1'b1;
        else if (d_unknown) drop_rsn[EOG_R_UNKNOWN_FAC]  = 1'b1;
        else if (dup)       drop_rsn[EOG_R_DUPLICATE]    = 1'b1;
        else if (ooo)       drop_rsn[EOG_R_OUT_OF_ORDER] = 1'b1;
    end

    // 5: fields
    logic [NFLD-1:0]    f_held, f_lost, f_ok;
    logic [NFLD*16-1:0] f_out;     // carried value (observed or held), 0 if lost or not required
    genvar k;
    generate
        for (k = 0; k < NFLD; k = k + 1) begin : g_f
            // KIND 0 reading (s16, LO/HI), 1 pump status (u8, legal 0..2), 2 well status (2 bits, legal 0..1),
            // 3 well water (s16, WELL_LO/WELL_HI)
            localparam integer KIND = (k == 2) ? 1 : (k < 7) ? 0 : (k < 7 + N_WELL) ? 2 : 3;
            localparam integer WI   = (k < 7) ? 0 : (k < 7 + N_WELL) ? k - 7 : k - 7 - N_WELL;
            localparam integer PB   = (k < 7) ? k : (k < 7 + N_WELL) ? 8 + WI : 16 + WI;
            localparam integer OFF  = (k == 0) ? EOG_D_INFLOW : (k == 1) ? EOG_D_LEVEL : (k == 2) ? EOG_D_PUMP_ST :
                                      (k == 3) ? EOG_D_PUMP_FLOW : (k == 4) ? EOG_D_DIS_PSI :
                                      (k == 5) ? EOG_D_RECV_FLOW : (k == 6) ? EOG_D_PIPE_PSI :
                                      (k < 7 + N_WELL) ? EOG_D_WELL_ST + 2 * WI : EOG_D_WELL_WATER + 16 * WI;
            // CONFIG LO/HI index: 0 inflow, 1 level, 2 pump flow, 3 receive flow, 4 discharge, 5 pipeline psi
            localparam integer LH   = (k == 0) ? 0 : (k == 1) ? 1 : (k == 3) ? 2 : (k == 4) ? 4 : (k == 5) ? 3 :
                                      (k == 6) ? 5 : 0;
            logic [15:0]        raw;
            logic signed [15:0] lo, hi;
            logic               hasp;
            logic [1:0]         missp;
            assign raw = (KIND == 1) ? {8'd0, r[OFF +: 8]} : (KIND == 2) ? {14'd0, r[OFF +: 2]} : r[OFF +: 16];
            assign lo  = (KIND == 3) ? row[EOG_CFG_WELL_LO +: 16] : row[EOG_CFG_LO + 16 * LH +: 16];
            assign hi  = (KIND == 3) ? row[EOG_CFG_WELL_HI +: 16] : row[EOG_CFG_HI + 16 * LH +: 16];
            assign d_raw[16*k +: 16] = raw;
            assign d_present[k] = r[EOG_D_PRESENT + PB];
            assign d_legal[k]   = (KIND == 1) ? (raw <= 16'd2) : (KIND == 2) ? (raw <= 16'd1) : 1'b1;
            assign d_inr[k]     = (KIND == 0 || KIND == 3) ? (($signed(raw) >= lo) && ($signed(raw) <= hi)) : 1'b1;
            assign d_obs[k]     = d_present[k] & d_legal[k] & d_inr[k];
            assign d_req[k]     = (k < 7) ? 1'b1 : (4'(WI) < d_n_wells);
            // a new history clears every held value and miss counter before the fields are processed
            assign hasp  = s_fhas[k] & ~nh;
            assign missp = nh ? 2'd0 : s_fmiss[2*k +: 2];
            assign f_held[k] = d_req[k] & ~d_obs[k] & hasp & (missp < d_hold);
            assign f_lost[k] = d_req[k] & ~d_obs[k] & ~f_held[k];
            assign f_ok[k]   = d_req[k] & ~f_lost[k];
            assign f_out[16*k +: 16] = ~d_req[k] ? 16'd0 : d_obs[k] ? raw : f_held[k] ? s_fval[16*k +: 16] : 16'd0;
            assign n_fval[16*k +: 16] = (d_req[k] & d_obs[k]) ? raw : s_fval[16*k +: 16];
            assign n_fhas[k]          = (d_req[k] & d_obs[k]) | hasp;
            assign n_fmiss[2*k +: 2]  = (d_req[k] & d_obs[k]) ? 2'd0 : f_held[k] ? missp + 2'd1 : missp;
        end
    endgenerate

    // 6: status; 8: consistency flags (TASKS #12: on carried values, only when the inputs are OK)
    logic         held_any, lost_any, absent_any, enum_any, range_any, pinc, winc, wells_ok;
    logic [2:0]   status;
    logic [7:0]   since_o, well_act;
    logic [127:0] well_water;
    logic         prev_ok_o;
    logic [15:0]  prev_level_o;
    integer       i;
    always_comb begin
        held_any   = |f_held;
        lost_any   = |f_lost;
        absent_any = |(d_req & ~d_present);
        enum_any   = |(d_req & d_present & ~d_legal);
        range_any  = |(d_req & d_present & d_legal & ~d_inr);
        status     = lost_any ? EOG_ST_INVALID : (held_any | t_gap) ? EOG_ST_HELD : EOG_ST_VALID;
        since_o    = nh ? 8'd0 : (s_since == 8'd255) ? 8'd255 : s_since + 8'd1;
        prev_ok_o  = ~nh & s_prev_ok;
        prev_level_o = prev_ok_o ? s_prev_level : 16'd0;       // TASKS #13
        pinc = f_ok[2] & f_ok[3] & (f_out[32 +: 2] != 2'd1) & ($signed(f_out[48 +: 16]) > 16'sd0);
        winc = 1'b0;
        wells_ok = 1'b1;                                        // 1 when n_wells = 0
        well_act = '0;
        well_water = '0;
        for (i = 0; i < N_WELL; i = i + 1) begin
            winc = winc | (f_ok[7 + i] & f_ok[7 + N_WELL + i] & (f_out[16*(7 + i) +: 16] != 16'd1) &
                           ($signed(f_out[16*(7 + N_WELL + i) +: 16]) > 16'sd0));
            wells_ok = wells_ok & ~f_lost[7 + i] & ~f_lost[7 + N_WELL + i];
            well_act[i] = d_req[7 + i] & (f_out[16*(7 + i) +: 16] == 16'd1);
            well_water[16*i +: 16] = f_out[16*(7 + N_WELL + i) +: 16];
        end
    end

    // 9: outputs
    always_comb begin
        v = '0;
        v[EOG_BV_REC_NO +: EOG_BV_REC_NO_W]   = u[EOG_BU_REC_NO +: EOG_BU_REC_NO_W];
        v[EOG_BV_IN_LAST]                     = u[EOG_BU_IN_LAST];
        v[EOG_BV_FAC_RAW +: EOG_BV_FAC_RAW_W] = fac_raw;
        v[EOG_BV_FAC +: EOG_BV_FAC_W]         = fac_raw[4:0];
        v[EOG_BV_TS +: EOG_BV_TS_W]           = ts;
        if (drop) begin
            v[EOG_BV_STATUS +: EOG_BV_STATUS_W] = EOG_ST_DROPPED;
            v[EOG_BV_REASON +: EOG_BV_REASON_W] = drop_rsn;
        end else begin
            v[EOG_BV_STATUS +: EOG_BV_STATUS_W] = status;
            v[EOG_BV_REASON + EOG_R_FIELD_HELD]   = held_any;
            v[EOG_BV_REASON + EOG_R_GAP_HELD]     = t_gap;
            v[EOG_BV_REASON + EOG_R_HIST_RESET]   = nh;
            v[EOG_BV_REASON + EOG_R_OUT_OF_RANGE] = range_any;
            v[EOG_BV_REASON + EOG_R_ILLEGAL_ENUM] = enum_any;
            v[EOG_BV_REASON + EOG_R_PUMP_INCONS]  = pinc;
            v[EOG_BV_REASON + EOG_R_WELL_INCONS]  = winc;
            v[EOG_BV_REASON + EOG_R_FIELD_ABSENT] = absent_any;
            v[EOG_BV_REASON + EOG_R_FIELD_LOST]   = lost_any;
            v[EOG_BV_SINCE_RESET +: EOG_BV_SINCE_RESET_W] = since_o;
            v[EOG_BV_HIST_RESET]                  = nh;
            v[EOG_BV_INFLOW +: 16]                = f_out[16*0 +: 16];
            v[EOG_BV_LEVEL +: 16]                 = f_out[16*1 +: 16];
            v[EOG_BV_PUMP_ST +: 2]                = f_out[16*2 +: 2];
            v[EOG_BV_PUMP_FLOW +: 16]             = f_out[16*3 +: 16];
            v[EOG_BV_DIS_PSI +: 16]               = f_out[16*4 +: 16];
            v[EOG_BV_RECV_FLOW +: 16]             = f_out[16*5 +: 16];
            v[EOG_BV_PIPE_PSI +: 16]              = f_out[16*6 +: 16];
            v[EOG_BV_WELL_ACT +: EOG_BV_WELL_ACT_W]     = well_act;
            v[EOG_BV_WELL_WATER +: EOG_BV_WELL_WATER_W] = well_water;
            v[EOG_BV_FLD_OK +: EOG_BV_FLD_OK_W]         = f_ok[6:0];
            v[EOG_BV_WELLS_OK]                          = wells_ok;
            v[EOG_BV_PREV_LEVEL +: EOG_BV_PREV_LEVEL_W] = prev_level_o;
            v[EOG_BV_PREV_OK]                           = prev_ok_o;
        end
    end

    // 7: state update (applies only when upd = 1)
    assign n_has_ts     = 1'b1;
    assign n_last_ts    = ts;
    assign n_since      = since_o;
    assign n_pend       = lost_any;                                  // INVALID: next record starts a new history
    assign n_prev_level = lost_any ? s_prev_level : f_out[16*1 +: 16];
    assign n_prev_ok    = lost_any ? prev_ok_o : 1'b1;
endmodule
// ---- END fv_validate_ref ----

// =============================================================================================================
module fv_eog_validate #(
    parameter integer N_FAC  = 2,
    parameter integer N_WELL = 2
) (
    input  logic               clk,          // top-level inputs are free: the solver drives them
    input  logic               rst_n,
    input  logic               in_valid,
    input  logic [417:0]       in_data,
    input  logic               out_ready,
    input  logic [N_FAC-1:0]   fac_touch,
    input  logic [511:0]       cfg_row_oob   // what eog_regs returns for cfg_fac >= N_FAC: anything
);
`include "eog_defs.svh"
    localparam integer NFLD = 7 + 2 * N_WELL;
    localparam integer RW   = 8;             // REC_NO bits compared by eog_fv_stage

    // ---------------------------------------------------------------------------------------------------------
    // Configuration: per-slot CONFIG rows and GLOBAL are constant (anyconst); one tracked slot and field.
    (* anyconst *) logic [255:0]         f_glb;
    (* anyconst *) logic [N_FAC*512-1:0] f_rows;
    (* anyconst *) logic [4:0]           f_slot;
    (* anyconst *) logic [4:0]           f_fld;
    always_comb begin
        assume (f_slot < N_FAC);
        assume (f_fld < NFLD);
    end

`ifdef FV_NARROW
    // bmc only: data narrowing. The history properties are about counters, flags and time deltas, not data width;
    // the full widths are covered by the per-record properties in `prove` and by simulation. Readings, well water
    // and every LO/HI limit are sign-extended 4-bit values (-8..7), pump status < 8, and TS moves in a 12-bit
    // window (TS[31:12] constant), so 300/600/900 deltas, duplicates and out-of-order all remain possible.
    (* anyconst *) logic [19:0] f_tshi;
    logic [15:0] nw_in, nw_row;
    integer nq;
    always_comb begin
        for (nq = 0; nq < 16; nq = nq + 1) begin
            nw_in[nq]  = 1'b1;
            nw_row[nq] = 1'b1;
        end
        for (nq = 0; nq < 6; nq = nq + 1)     // INFLOW..PIPE_PSI (16-bit fields at 96..191)
            nw_in[nq] = in_data[EOG_BU_REC + EOG_D_INFLOW + 16 * nq + 3 +: 13] ==
                        {13{in_data[EOG_BU_REC + EOG_D_INFLOW + 16 * nq + 3]}};
        for (nq = 0; nq < N_WELL; nq = nq + 1)
            nw_in[6 + nq] = in_data[EOG_BU_REC + EOG_D_WELL_WATER + 16 * nq + 3 +: 13] ==
                            {13{in_data[EOG_BU_REC + EOG_D_WELL_WATER + 16 * nq + 3]}};
        nw_in[15] = (in_data[EOG_BU_REC + EOG_D_PUMP_ST + 3 +: 5] == 5'd0) &&
                    (in_data[EOG_BU_REC + EOG_D_TS + 12 +: 20] == f_tshi);
        for (nq = 0; nq < N_FAC * 16; nq = nq + 1)   // LO[0..6], HI[0..6], WELL_LO, WELL_HI of every slot
            nw_row[nq % 16] = nw_row[nq % 16] &&
                (f_rows[512 * (nq / 16) + EOG_CFG_LO + 16 * (nq % 16) + 3 +: 13] ==
                 {13{f_rows[512 * (nq / 16) + EOG_CFG_LO + 16 * (nq % 16) + 3]}});
        if (in_valid) assume (&nw_in);
        assume (&nw_row);
    end
`endif
`ifdef FV_FAST
    // bmc only: full-throughput schedule (in_valid and out_ready held 1, no reset after the first cycle). The
    // history properties do not depend on the handshake schedule; the stage contract and the per-record
    // properties are proven for every schedule in `prove`.
    logic f_rst_q;
    always_ff @(posedge clk) f_rst_q <= rst_n;
    always_comb if (f_past_valid) assume (rst_n && out_ready && (in_valid || !f_rst_q));
`endif

    // ---------------------------------------------------------------------------------------------------------
    // DUT
    logic         in_ready, out_valid;
    logic [372:0] out_data;
    logic [4:0]   cfg_fac;
    logic [511:0] cfg_row;
    logic [7:0]   dut_inflight;
    logic [31:0]  dut_oldest;

    assign cfg_row = (cfg_fac < N_FAC) ? f_rows[cfg_fac * 512 +: 512] : cfg_row_oob;

    eog_validate #(.N_FAC(N_FAC), .N_WELL(N_WELL), .II(16)) dut (
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
        .glb           (f_glb),
        .fac_touch     (fac_touch),
        .f_inflight    (dut_inflight),
        .f_oldest_recno(dut_oldest)
    );

    // ---------------------------------------------------------------------------------------------------------
    // Stage contract (conventions §2, §3, §7)
    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    eog_fv_axis #(.W(418), .ASSUME(1)) u_in  (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(in_valid), .ready(in_ready), .data(in_data));
    eog_fv_axis #(.W(373), .ASSUME(0)) u_out (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(out_valid), .ready(out_ready), .data(out_data));

    logic [RW-1:0] f_in_cnt, f_out_cnt;
    logic [7:0]    f_in_flight;
    // MAX_INFLIGHT 2: the spec allows overlap (with a hazard check); the harness FIFOs below hold 2 records.
    // SWEEP N_FAC + 8: conventions §1 allows a RAM-clearing sweep after reset.
    eog_fv_stage #(.RW(RW), .MAX_INFLIGHT(2), .II_MAX(16), .LAT_MAX(128), .SWEEP(N_FAC + 8)) u_stage (
        .clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .in_valid(in_valid), .in_ready(in_ready), .in_recno(in_data[EOG_BU_REC_NO +: RW]),
        .out_valid(out_valid), .out_ready(out_ready), .out_recno(out_data[EOG_BV_REC_NO +: RW]),
        .excl(1'b0), .dut_inflight(dut_inflight), .dut_oldest(dut_oldest),
        .f_in_cnt(f_in_cnt), .f_out_cnt(f_out_cnt), .f_in_flight(f_in_flight));

    logic in_fire, out_fire;
    assign in_fire  = in_valid && in_ready && rst_n;
    assign out_fire = out_valid && out_ready && rst_n;

    // ---------------------------------------------------------------------------------------------------------
    // Shadow FIFO of accepted records (2 entries, indexed by the low bit of the accept / output counters).
    // q_tch: a touch of f_slot is ordered just before this record (it happened after the previous record was
    // accepted, including the previous record's accept cycle, and before this record's accept cycle).
    logic [417:0] q_x0, q_x1;
    logic         q_t0, q_t1;
    logic         t_acc;                     // touches of f_slot not yet attached to a record
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            t_acc <= 1'b0;
        end else if (in_fire) begin
            if (f_in_cnt[0]) begin q_x1 <= in_data; q_t1 <= t_acc; end
            else             begin q_x0 <= in_data; q_t0 <= t_acc; end
            t_acc <= fac_touch[f_slot];      // a touch in the accept cycle applies to the next record
        end else begin
            t_acc <= t_acc | fac_touch[f_slot];
        end
    end

    // The record now at the output: the oldest in flight, or the one passing through this cycle.
    logic [417:0] c_x;
    logic         c_tch;
    assign c_x   = (f_in_flight == 8'd0) ? in_data : (f_out_cnt[0] ? q_x1 : q_x0);
    assign c_tch = (f_in_flight == 8'd0) ? t_acc   : (f_out_cnt[0] ? q_t1 : q_t0);

    // CONFIG row of a record's slot (an unknown FAC_ID >= N_FAC never uses it)
    logic [15:0]  c_id;
    logic [511:0] c_row;
    assign c_id  = c_x[EOG_BU_REC + EOG_D_FAC_ID +: 16];
    assign c_row = (c_id < N_FAC) ? f_rows[c_id[4:0] * 512 +: 512] : 512'd0;

    // Record-only decode of c_x (state inputs tied off; only d_* is used).
    logic               d_framing, d_unknown;
    logic [NFLD-1:0]    d_req, d_present, d_legal, d_inr, d_obs;
    logic [NFLD*16-1:0] d_raw;
    logic [3:0]         d_n_wells;
    logic [1:0]         d_hold;
    fv_validate_ref #(.N_FAC(N_FAC), .N_WELL(N_WELL)) u_dec (
        .u(c_x), .row(c_row), .glb(f_glb),
        .s_has_ts(1'b0), .s_pend(1'b1), .s_last_ts(32'd0), .s_since(8'd0), .s_prev_level(16'd0),
        .s_prev_ok(1'b0), .s_fval('0), .s_fhas('0), .s_fmiss('0),
        .v(), .upd(), .n_has_ts(), .n_pend(), .n_last_ts(), .n_since(), .n_prev_level(), .n_prev_ok(),
        .n_fval(), .n_fhas(), .n_fmiss(),
        .d_framing(d_framing), .d_unknown(d_unknown), .d_req(d_req), .d_present(d_present), .d_legal(d_legal),
        .d_inr(d_inr), .d_obs(d_obs), .d_raw(d_raw), .d_n_wells(d_n_wells), .d_hold(d_hold));

    // ---------------------------------------------------------------------------------------------------------
    // Output fields
    logic [31:0]  o_recno, o_ts;
    logic         o_last, o_hr, o_pok, o_wok;
    logic [15:0]  o_facraw, o_rsn, o_plev;
    logic [4:0]   o_fac;
    logic [2:0]   o_st;
    logic [7:0]   o_since, o_wact;
    logic [6:0]   o_fok;
    logic [1:0]   o_pst;
    logic [127:0] o_wwat;
    logic [258:0] o_payload;                 // everything after the header (bits 114..372)
    assign o_recno  = out_data[EOG_BV_REC_NO +: 32];
    assign o_last   = out_data[EOG_BV_IN_LAST];
    assign o_facraw = out_data[EOG_BV_FAC_RAW +: 16];
    assign o_fac    = out_data[EOG_BV_FAC +: 5];
    assign o_ts     = out_data[EOG_BV_TS +: 32];
    assign o_st     = out_data[EOG_BV_STATUS +: 3];
    assign o_rsn    = out_data[EOG_BV_REASON +: 16];
    assign o_since  = out_data[EOG_BV_SINCE_RESET +: 8];
    assign o_hr     = out_data[EOG_BV_HIST_RESET];
    assign o_pst    = out_data[EOG_BV_PUMP_ST +: 2];
    assign o_wact   = out_data[EOG_BV_WELL_ACT +: 8];
    assign o_wwat   = out_data[EOG_BV_WELL_WATER +: 128];
    assign o_fok    = out_data[EOG_BV_FLD_OK +: 7];
    assign o_wok    = out_data[EOG_BV_WELLS_OK];
    assign o_plev   = out_data[EOG_BV_PREV_LEVEL +: 16];
    assign o_pok    = out_data[EOG_BV_PREV_OK];
    assign o_payload = out_data[372:EOG_BV_INFLOW];

    // Per-field output view, in field-index order: the value as carried on bus V (pump status 2 bits, well
    // status as its WELL_ACT bit), and the raw input value in the same view.
    logic [NFLD*16-1:0] o_fv, d_rv;
    assign o_fv[16*0 +: 16] = out_data[EOG_BV_INFLOW +: 16];
    assign o_fv[16*1 +: 16] = out_data[EOG_BV_LEVEL +: 16];
    assign o_fv[16*2 +: 16] = {14'd0, o_pst};
    assign o_fv[16*3 +: 16] = out_data[EOG_BV_PUMP_FLOW +: 16];
    assign o_fv[16*4 +: 16] = out_data[EOG_BV_DIS_PSI +: 16];
    assign o_fv[16*5 +: 16] = out_data[EOG_BV_RECV_FLOW +: 16];
    assign o_fv[16*6 +: 16] = out_data[EOG_BV_PIPE_PSI +: 16];
    genvar w;
    generate
        for (w = 0; w < 7; w = w + 1) begin : g_rv
            assign d_rv[16*w +: 16] = (w == 2) ? {14'd0, d_raw[16*w +: 2]} : d_raw[16*w +: 16];
        end
        for (w = 0; w < N_WELL; w = w + 1) begin : g_wv
            assign o_fv[16*(7 + w) +: 16]          = {15'd0, o_wact[w]};
            assign o_fv[16*(7 + N_WELL + w) +: 16] = o_wwat[16*w +: 16];
            assign d_rv[16*(7 + w) +: 16]          = {15'd0, d_raw[16*(7 + w) +: 16] == 16'd1};
            assign d_rv[16*(7 + N_WELL + w) +: 16] = d_raw[16*(7 + N_WELL + w) +: 16];
        end
    endgenerate

    // =========================================================================================================
    // 2. Per-record properties (prove + bmc)
    logic chk, drop, nd;
    assign chk  = f_past_valid && rst_n && out_valid;
    assign drop = (o_st == EOG_ST_DROPPED);
    assign nd   = chk && !drop;

    // Field-level facts of the record, folded into vectors (one assertion each, no labels inside loops).
    logic [NFLD-1:0] p_obs_val;     // observed OK -> carried value == input value
    logic [NFLD-1:0] p_hr_lost;     // HIST_RESET and not observed OK -> lost (value 0)
    logic [6:0]      p_lost0;       // facility field lost (FLD_OK = 0) -> value 0
    logic [6:0]      p_heldrsn;     // facility field carried but not observed -> FIELD_HELD
    logic            req_nobs, held_vis, well_nobs, absent_x, enum_x, range_x, winc_need, winc_poss;
    logic [7:0]      p_v11;         // well slot i >= n_wells: WELL_ACT[i] = 0, WELL_WATER[i] = 0
    integer          j;
    always_comb begin
        for (j = 0; j < NFLD; j = j + 1) begin
            p_obs_val[j] = !(d_req[j] && d_obs[j]) || (o_fv[16*j +: 16] == d_rv[16*j +: 16]);
            p_hr_lost[j] = !(d_req[j] && !d_obs[j] && o_hr) || (o_fv[16*j +: 16] == 16'd0);
        end
        for (j = 0; j < 7; j = j + 1) begin
            p_lost0[j]   = o_fok[j] || (o_fv[16*j +: 16] == 16'd0);
            p_heldrsn[j] = !(o_fok[j] && !d_obs[j]) || (o_rsn[EOG_R_FIELD_HELD] && !o_hr);
        end
        for (j = 0; j < 8; j = j + 1)
            p_v11[j] = (j < d_n_wells && j < N_WELL) || (!o_wact[j] && o_wwat[16*j +: 16] == 16'd0);
        req_nobs  = |(d_req & ~d_obs);
        absent_x  = |(d_req & ~d_present);
        enum_x    = |(d_req & d_present & ~d_legal);
        range_x   = |(d_req & d_present & d_legal & ~d_inr);
        held_vis  = |(~d_obs[6:0] & o_fok);
        well_nobs = |(d_req[NFLD-1:7] & ~d_obs[NFLD-1:7]);
        winc_need = 1'b0;   // a configured slot with status and water both observed OK, status 0, water > 0
        winc_poss = 1'b0;   // a configured slot whose carried values show status 0 and water > 0
        for (j = 0; j < N_WELL; j = j + 1) begin
            winc_need = winc_need | (d_req[7 + j] & d_obs[7 + j] & d_obs[7 + N_WELL + j] &
                                     (d_raw[16*(7 + j) +: 16] == 16'd0) &
                                     ($signed(d_raw[16*(7 + N_WELL + j) +: 16]) > 16'sd0));
            winc_poss = winc_poss | (d_req[7 + j] & !o_wact[j] & ($signed(o_wwat[16*j +: 16]) > 16'sd0));
        end
    end

`ifndef FV_NO_REC
    always_comb begin
        if (chk) begin
            // HDR: header pass-through (conventions §3; numerics §3 step 9: FAC = FAC_ID[4:0] also when DROPPED)
            HDR:   assert (o_recno == c_x[EOG_BU_REC_NO +: 32] && o_last == c_x[EOG_BU_IN_LAST] &&
                           o_facraw == c_x[EOG_BU_REC + EOG_D_FAC_ID +: 16] &&
                           o_fac == c_x[EOG_BU_REC + EOG_D_FAC_ID +: 5] &&
                           o_ts == c_x[EOG_BU_REC + EOG_D_TS +: 32]);
            // ST: STATUS is one of the RESULT codes 0, 1, 3, 4 (2 is never produced)
            ST:    assert (o_st == EOG_ST_VALID || o_st == EOG_ST_HELD || o_st == EOG_ST_INVALID ||
                           o_st == EOG_ST_DROPPED);
            // RSN: validate never sets FEAT_SAT (5), NO_MODEL (13) or bit 15
            RSN:   assert (!o_rsn[EOG_R_FEAT_SAT] && !o_rsn[EOG_R_NO_MODEL] && !o_rsn[15]);
            // V1: FRAME_ERR or a nonzero reserved field -> DROPPED with exactly FRAMING; FRAMING only then
            if (d_framing) V1: assert (drop && o_rsn == (16'd1 << EOG_R_FRAMING));
            else           V1_only: assert (!o_rsn[EOG_R_FRAMING]);
            // V2: FAC_ID >= N_FAC or slot disabled -> DROPPED with exactly UNKNOWN_FAC (framing has priority)
            if (!d_framing && d_unknown) V2: assert (drop && o_rsn == (16'd1 << EOG_R_UNKNOWN_FAC));
            else                         V2_only: assert (!o_rsn[EOG_R_UNKNOWN_FAC]);
            // V3 (record part): any other DROPPED record carries exactly DUPLICATE or OUT_OF_ORDER, and those two
            // bits appear only on DROPPED records
            if (drop && !d_framing && !d_unknown)
                V3_rsn: assert (o_rsn == (16'd1 << EOG_R_DUPLICATE) || o_rsn == (16'd1 << EOG_R_OUT_OF_ORDER));
            if (!drop)
                V3_only: assert (!o_rsn[EOG_R_DUPLICATE] && !o_rsn[EOG_R_OUT_OF_ORDER]);
            // V4: DROPPED -> HIST_RESET = 0, SINCE_RESET = 0 and every value field 0 (step 9)
            if (drop) V4: assert (!o_hr && o_since == 8'd0 && o_payload == '0);
            // PRV0: PREV_OK = 0 -> PREV_LEVEL = 0 (TASKS #13)
            PRV0:  assert (o_pok || o_plev == 16'd0);
            // V11: WELL_ACT[i] = 0 and WELL_WATER[i] = 0 for i >= n_wells (n_wells = min(N_WELLS, N_WELL), TASKS #14)
            V11:   assert (&p_v11);
        end
        if (nd) begin
            // V8: STATUS == INVALID iff some required field is lost; FLD_OK / WELLS_OK match
            V8_inv:   assert ((o_st == EOG_ST_INVALID) == o_rsn[EOG_R_FIELD_LOST]);
            V8_ok:    assert (o_rsn[EOG_R_FIELD_LOST] == (o_fok != 7'h7F || !o_wok));
            V8_held:  assert ((o_st == EOG_ST_HELD) ==
                              (!o_rsn[EOG_R_FIELD_LOST] && (o_rsn[EOG_R_FIELD_HELD] || o_rsn[EOG_R_GAP_HELD])));
            V8_obs:   assert (&p_obs_val);                 // observed OK -> value carried unchanged, FLD_OK = 1
            V8_obsok: assert ((d_obs[6:0] & ~o_fok) == 7'd0);
            V8_lost0: assert (&p_lost0);                    // lost -> value 0
            V8_held2: assert (&p_heldrsn);                  // carried without observation -> FIELD_HELD
            // each required field not observed OK is held or lost; FIELD_HELD needs a field it could hold
            V8_hl:    assert ((o_rsn[EOG_R_FIELD_HELD] || o_rsn[EOG_R_FIELD_LOST]) == req_nobs);
            V8_hv:    assert (!o_rsn[EOG_R_FIELD_HELD] || held_vis || (well_nobs && !o_hr));
            V8_wok:   assert (!(o_wok && well_nobs) || (o_rsn[EOG_R_FIELD_HELD] && !o_hr));
            V8_wok1:  assert (well_nobs || o_wok);         // every configured well field observed OK -> WELLS_OK
            // per-field cause bits (lead: exactly one of absent > enum > range per field), OR-ed over fields
            V8_rsn:   assert (o_rsn[EOG_R_FIELD_ABSENT] == absent_x && o_rsn[EOG_R_ILLEGAL_ENUM] == enum_x &&
                              o_rsn[EOG_R_OUT_OF_RANGE] == range_x);
            // V11 (n_wells = 0): WELLS_OK = 1 (lead clarification)
            if (d_n_wells == 4'd0) V11_w0: assert (o_wok);
            // HR: HIST_RESET bit == reason bit; a new history has SINCE_RESET 0, PREV_OK 0, nothing held, and every
            // required field that is not observed OK is lost; otherwise SINCE_RESET >= 1
            HR:       assert (o_hr == o_rsn[EOG_R_HIST_RESET]);
            if (o_hr) HR_new: assert (o_since == 8'd0 && !o_pok && !o_rsn[EOG_R_GAP_HELD] &&
                                      !o_rsn[EOG_R_FIELD_HELD] && &p_hr_lost && o_fok == d_obs[6:0] &&
                                      o_wok == !well_nobs);
            else      HR_cont: assert (o_since != 8'd0);
            // HLD0: hold = min(HOLD_MAX, 2) = 0 -> nothing is ever held (no FIELD_HELD, no GAP_HELD)
            if (d_hold == 2'd0) HLD0: assert (!o_rsn[EOG_R_FIELD_HELD] && !o_rsn[EOG_R_GAP_HELD]);
            // INC (TASKS #12): PUMP_INCONS = FLD_OK[PUMP_ST] & FLD_OK[PUMP_FLOW] & PUMP_ST != 1 & PUMP_FLOW > 0;
            // WELL_INCONS = some configured slot with status and water OK, status 0, water > 0
            INC_p:    assert (o_rsn[EOG_R_PUMP_INCONS] == (o_fok[2] && o_fok[3] && o_pst != 2'd1 &&
                              $signed(out_data[EOG_BV_PUMP_FLOW +: 16]) > 16'sd0));
            INC_w:    assert ((!winc_need || o_rsn[EOG_R_WELL_INCONS]) && (!o_rsn[EOG_R_WELL_INCONS] || winc_poss));
            if (o_wok) INC_wok: assert (o_rsn[EOG_R_WELL_INCONS] == winc_poss);
        end
    end
`endif

`ifndef FV_NO_HIST
    // =========================================================================================================
    // 3a. History properties of the tracked slot f_slot, from an output-derived shadow (bmc).
    // sh_*: the state the spec says slot f_slot has after the records output so far (output order == accept
    // order) and the touches ordered before them; p_* adds the touch ordered just before the record at the output.
    logic        sh_has_ts, sh_pend, sh_inv, sh_seen;
    logic [31:0] sh_last_ts;
    logic [7:0]  sh_since;
    logic [15:0] sh_level, sh_val;
    logic [2:0]  sh_run;
    logic        p_has_ts, p_pend, p_tchk, mine, known;
    logic [31:0] p_dts;
    assign p_has_ts = sh_has_ts && !c_tch;
    assign p_pend   = sh_pend || c_tch;
    assign p_tchk   = p_has_ts && !p_pend;
    assign p_dts    = o_ts - sh_last_ts;
    assign mine     = (c_x[EOG_BU_REC + EOG_D_FAC_ID +: 16] == {11'd0, f_slot});
    assign known    = mine && !d_framing && !d_unknown;      // a record of f_slot that passes steps 1-2

    // V6 shadow for field f_fld of f_slot: run = consecutive records (in this history) without an observed OK
    // value, seen = an observed OK value in this history, val = that value.
    logic        t_obs, t_req, t_carry;
    logic [2:0]  t_run;
    logic [15:0] t_oval, t_view;
    assign t_obs   = d_obs[f_fld];
    assign t_req   = d_req[f_fld];
    assign t_run   = t_obs ? 3'd0 : (o_hr || sh_run == 3'd7) ? (o_hr ? 3'd1 : 3'd7) : sh_run + 3'd1;
    assign t_carry = !o_hr && sh_seen && (t_run <= {1'b0, d_hold});
    assign t_oval  = o_fv[16*f_fld +: 16];
    assign t_view  = (f_fld == 5'd2) ? {14'd0, sh_val[1:0]} :
                     (f_fld >= 5'd7 && f_fld < 5'(7 + N_WELL)) ? {15'd0, sh_val == 16'd1} : sh_val;

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            sh_has_ts <= 1'b0;
            sh_pend   <= 1'b1;
            sh_inv    <= 1'b0;
            sh_seen   <= 1'b0;
            sh_run    <= 3'd0;
        end else if (out_fire) begin
            if (c_tch) begin
                sh_has_ts <= 1'b0;
                sh_pend   <= 1'b1;
                sh_inv    <= 1'b0;
            end
            if (mine && !drop) begin
                sh_has_ts  <= 1'b1;
                sh_last_ts <= o_ts;
                sh_pend    <= (o_st == EOG_ST_INVALID);
                sh_inv     <= (o_st == EOG_ST_INVALID);
                sh_since   <= o_since;
                sh_level   <= out_data[EOG_BV_LEVEL +: 16];
                if (t_req) begin
                    sh_run  <= t_run;
                    sh_seen <= t_obs || (!o_hr && sh_seen);
                    if (t_obs) sh_val <= d_raw[16*f_fld +: 16];
                end else if (o_hr) begin
                    sh_run  <= 3'd0;
                    sh_seen <= 1'b0;
                end
            end
        end
    end

    always_comb begin
        if (chk && known) begin
            // V3: duplicate TS -> DROPPED DUPLICATE; older TS -> DROPPED OUT_OF_ORDER (only when the slot has a
            // previous timestamp and no pending reset); otherwise the record is not dropped
            if (p_tchk && o_ts == sh_last_ts)     V3_dup: assert (drop && o_rsn == (16'd1 << EOG_R_DUPLICATE));
            else if (p_tchk && o_ts < sh_last_ts) V3_ooo: assert (drop && o_rsn == (16'd1 << EOG_R_OUT_OF_ORDER));
            else                                  V3_acc: assert (!drop);
            // V5: no previous timestamp or a pending reset (after reset, fac_touch or INVALID) -> new history
            if (!p_tchk) V5: assert (!drop && o_hr && o_since == 8'd0);
            // V7: TS - last_ts == 300 -> continue; 600 / 900 within the hold limit -> GAP_HELD, status >= HELD,
            // same history; any other difference -> HIST_RESET
            if (p_tchk && o_ts > sh_last_ts) begin
                if (p_dts == 32'd300)
                    V7_300: assert (!o_hr && !o_rsn[EOG_R_GAP_HELD]);
                else if ((p_dts == 32'd600 && d_hold >= 2'd1) || (p_dts == 32'd900 && d_hold >= 2'd2))
                    V7_gap: assert (!o_hr && o_rsn[EOG_R_GAP_HELD] && (o_st == EOG_ST_HELD || o_st == EOG_ST_INVALID));
                else
                    V7_new: assert (o_hr && !o_rsn[EOG_R_GAP_HELD]);
            end
            // V9: after an INVALID record, the slot's next non-DROPPED record starts a new history
            if (sh_inv) V9: assert (!drop && o_hr);
        end
        if (chk && mine && !drop) begin
            // V10: SINCE_RESET of consecutive accepted records of the slot increases by 1 (saturating) unless
            // HIST_RESET
            if (!o_hr && p_tchk)
                V10: assert (o_since == ((sh_since == 8'd255) ? 8'd255 : sh_since + 8'd1));
            // V12: PREV_OK = 0 on HIST_RESET; otherwise PREV_LEVEL is the LEVEL of the slot's previous VALID/HELD
            // record (in one history every earlier non-DROPPED record is VALID/HELD: INVALID forces a new one)
            if (o_hr)          V12_new:  assert (!o_pok);
            else if (p_tchk)   V12_prev: assert (o_pok && o_plev == sh_level);
            // V6: field f_fld is carried (held) on at most min(HOLD_MAX, 2) consecutive records after its last
            // observed OK value in this history, with that value; after that (or with no value) it is lost
            if (t_req && !t_obs) begin
                if (t_carry) V6_held: assert (t_oval == t_view && (f_fld >= 5'd7 || o_fok[f_fld]));
                else         V6_lost: assert (t_oval == 16'd0 && (f_fld >= 5'd7 ? !o_wok : !o_fok[f_fld]));
            end
        end
    end

`ifndef FV_NO_REF
    // =========================================================================================================
    // 3b. REF / V13: every output bit of slot f_slot's records against fv_validate_ref applied to the record and
    // the slot state the spec gives it. That state is rebuilt from the slot's previous outputs (has_ts, pend,
    // last_ts, since, prev_level: the sh_* shadow above, from the DUT's TS / STATUS / SINCE_RESET / LEVEL) and
    // from the reference's own per-field update (last value, has-value, miss counter), with touches and reset
    // ordered as above. prev_ok is 1: a record that continues a history follows a VALID/HELD record of it (an
    // INVALID one forces a new history), and a new history ignores it. Up to the first wrong output this state
    // is exactly the spec's, so the first divergence of the DUT from numerics.md §3 on slot f_slot fails REF.
    // It depends only on f_slot's own records, touches and resets, so equality while the other slot's records
    // are interleaved is V13 (slot independence; f_slot is anyconst, so this covers every slot).
    logic [NFLD*16-1:0] dv_fval;
    logic [NFLD-1:0]    dv_fhas;
    logic [NFLD*2-1:0]  dv_fmiss;

    logic [372:0]       e_v;
    logic [NFLD*16-1:0] e_fval;
    logic [NFLD-1:0]    e_fhas;
    logic [NFLD*2-1:0]  e_fmiss;
    fv_validate_ref #(.N_FAC(N_FAC), .N_WELL(N_WELL)) u_ref (
        .u(c_x), .row(c_row), .glb(f_glb),
        .s_has_ts(p_has_ts), .s_pend(p_pend), .s_last_ts(sh_last_ts), .s_since(sh_since),
        .s_prev_level(sh_level), .s_prev_ok(1'b1), .s_fval(dv_fval), .s_fhas(dv_fhas), .s_fmiss(dv_fmiss),
        .v(e_v), .upd(), .n_has_ts(), .n_pend(), .n_last_ts(), .n_since(), .n_prev_level(), .n_prev_ok(),
        .n_fval(e_fval), .n_fhas(e_fhas), .n_fmiss(e_fmiss),
        .d_framing(), .d_unknown(), .d_req(), .d_present(), .d_legal(), .d_inr(), .d_obs(), .d_raw(),
        .d_n_wells(), .d_hold());

    // (a new history clears the per-field state inside the reference, so it needs no reset here)
    always_ff @(posedge clk) begin
        if (out_fire && mine && !drop) begin
            dv_fval  <= e_fval;
            dv_fhas  <= e_fhas;
            dv_fmiss <= e_fmiss;
        end
    end

    always_comb begin
        if (chk && mine) begin
            REF_hdr:    assert (out_data[EOG_BV_STATUS - 1:0] == e_v[EOG_BV_STATUS - 1:0]);
            REF_status: assert (o_st == e_v[EOG_BV_STATUS +: 3]);
            REF_reason: assert (o_rsn == e_v[EOG_BV_REASON +: 16]);
            REF_since:  assert (out_data[EOG_BV_INFLOW - 1:EOG_BV_SINCE_RESET] ==
                                e_v[EOG_BV_INFLOW - 1:EOG_BV_SINCE_RESET]);
            REF_values: assert (o_payload == e_v[372:EOG_BV_INFLOW]);
            V13:        assert (out_data == e_v);
        end
    end
`endif
`endif

    // =========================================================================================================
    // Covers (spec "Cover" list + vacuity checks for the history properties)
    always_comb begin
        if (chk) begin
            C_held:     cover (o_st == EOG_ST_HELD && o_rsn[EOG_R_FIELD_HELD]);
            C_gap:      cover (o_rsn[EOG_R_GAP_HELD]);
            C_framing:  cover (drop && o_rsn[EOG_R_FRAMING]);
            C_unknown:  cover (drop && o_rsn[EOG_R_UNKNOWN_FAC]);
            C_dup:      cover (drop && o_rsn[EOG_R_DUPLICATE]);
            C_ooo:      cover (drop && o_rsn[EOG_R_OUT_OF_ORDER]);
            C_invalid:  cover (o_st == EOG_ST_INVALID);
            C_winc:     cover (!drop && o_rsn[EOG_R_WELL_INCONS]);
            C_pinc:     cover (!drop && o_rsn[EOG_R_PUMP_INCONS]);
`ifndef FV_NO_HIST
            C_inv_new:  cover (mine && !drop && sh_inv && o_hr);          // an INVALID followed by a new history
            C_touch:    cover (mine && !drop && c_tch && sh_has_ts && !sh_pend && p_dts == 32'd300 && o_hr);
            C_held2:    cover (mine && !drop && t_req && !t_obs && t_carry && t_run == 3'd2);
            C_lost_run: cover (mine && !drop && t_req && !t_obs && sh_seen && !o_hr && t_run > {1'b0, d_hold});
            C_since2:   cover (mine && !drop && o_since == 8'd2);
            C_prev:     cover (mine && !drop && o_pok);
`endif
        end
    end
endmodule

`default_nettype wire
