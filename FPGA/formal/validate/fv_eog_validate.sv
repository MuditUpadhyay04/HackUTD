// fv_eog_validate.sv — formal harness for eog_validate (Verify role, task T1.validate.fv), spec v4.
//
// Written from spec/modules/eog_validate.md, spec/numerics.md §3 (spec v4, FROZEN; normative reference Mudit's
// ml/hutd_ml/features_int.py `Engine.process` / `_fields` with the v4 changes of numerics.md §11),
// spec/conventions.md and the lead's answers in TASKS.md "Spec questions". The RTL internals are not read: the
// DUT is seen through its spec ports and the two formal-only observation ports of conventions §7 (f_inflight,
// f_oldest_recno). Run: `bash scripts/formal.sh validate` (formal/validate/eog_validate.sby).
//
// Spec answers this harness follows (TASKS.md "Spec questions"; features_int.py @ d1ba779 decides where it can):
//   #23  reason bits 11 FIELD_ABSENT (a required field's present bit is clear) and 14 FIELD_LOST (some required
//        field has no value to use: INVALID) are restored, with features_int.py's rules (ml/README.md).
//   #24  a slot's first record (no last_ts: after power-up/soft reset or a fac_touch) is a new history:
//        HIST_RESET = 1, reason bit 2.
//   #25 / #39  every DROPPED record has SINCE_RESET = 0, and its values, FLD_OK, WELLS_OK, PREV_* are 0.
//   #35  d = TS - last_ts is the exact 33-bit signed difference.
//   #38  PUMP_INCONS / WELL_INCONS only on VALID/HELD.
//   #37 (proposed; [Q3] at the properties that use it) INVALID records: each value is the observed-OK value,
//        else 0 (held values are not output); FLD_OK[j] / WELLS_OK = observed OK. VALID/HELD: FLD_OK = 7'h7F,
//        WELLS_OK = 1. features_int.py returns no per-field values for INVALID records (stages = None), so the
//        T0.2b vectors decide; the module spec says "for INVALID: the OK value where available, else 0".
//   #40 (proposed; [Q6]) PREV_LEVEL / PREV_OK on INVALID records are not checked.
//   #13 (PREV_LEVEL = 0 when PREV_OK = 0) and #14 (n_wells = min(CFG.N_WELLS, N_WELL)) still hold.
//   features_int.py also clamps HOLD_MAX to 2.
//   #70  R7 option C replaces numerics §3 step 5: hold_run = (any field held) ? min(hold_run + 1, 3) : 0; if
//        hold_run > hold every held field becomes missing (INVALID, FIELD_LOST, no FIELD_HELD), with NO history
//        reset: no HIST_RESET, last_valid kept, hold_run not cleared, SINCE_RESET not incremented, PREV kept.
//        History resets come only from time gaps (missing > hold), the first record and fac_touch.
//   #71 (proposed, treated as spec) a hold-limit record: INVALID, FIELD_LOST, HIST_RESET = 0, FIELD_HELD = 0,
//        current SINCE_RESET, PREV unchanged; every following record with a held candidate is INVALID too until
//        a record with none, a time-gap reset or a touch; OK fields still update last_valid (V6_ovf, V6_held,
//        V7, V8, V9_prev, HV).
//
// Sizes: N_FAC = 2, N_WELL = 2 (so 7 + 2*2 = 11 fields per slot). CONFIG rows are per-slot anyconst
// (conventions §5: an enabled row never changes; formal keeps every row constant, row rewrites are covered by
// the simulation vectors), GLOBAL is anyconst, `cfg_row` for cfg_fac >= N_FAC is free every cycle.
// `fac_touch` and `rst_n` (after the first cycle) are free every cycle. hold = min(G.HOLD_MAX, 2).
//
// Three kinds of checks:
//   1. Stage contract (conventions §2-§3, §7): eog_fv_axis on both links, eog_fv_stage (REC_NO order, nothing
//      lost or invented, <= 2 in flight, II <= 16, latency <= 128, RAM sweep of up to N_FAC + 8 cycles allowed).
//   2. Per-record properties: the output of a record against that record's own input (captured in a 2-entry
//      shadow FIFO when accepted), the constant CONFIG row and GLOBAL. They need no per-slot history, so they are
//      k-inductive (task `prove`, every handshake schedule, full data widths).
//   3. History properties (`bmc` tasks; -DFV_NO_HIST removes them): they relate a record to earlier records of
//      its slot. The DUT keeps that history in per-slot RAM that a port-only harness cannot see, so no harness
//      shadow of it is k-inductive (induction can start with shadow != DUT RAM and keep the slot idle for k
//      steps); they are checked by BMC from reset instead. All of them watch ONE anyconst slot (f_slot) through
//      a shadow built from the DUT's own outputs in output order (= acceptance order) plus the inputs, so each
//      check relates a record to the slot's earlier, already-checked outputs. REF / V12 compare every output bit
//      of f_slot's records with fv_validate_ref (below, an independent reading of numerics.md §3) applied to the
//      record and that shadow state; the state depends only on f_slot's own records, touches and resets, so
//      equality with the other slot's records interleaved is V12 (slot independence).
//      Speed-ups for BMC (each documented where defined; none is used by `prove`): FV_FAST (in_valid and
//      out_ready held 1, no mid-run reset: the schedule-dependent properties are all in `prove`), FV_NO_REC
//      (per-record properties already proven), FV_NARROW (4-bit data values, 12-bit TS window), FV_NO_REF.
//
// Property map (spec/modules/eog_validate.md "Required properties"; label = assertion name):
//   stage contract  u_in.*, u_out.ax_*, u_stage.st_*                                      prove
//   V1  FRAMING      V1, V1_only                                                           prove
//   V2  UNKNOWN_FAC  V2, V2_only                                                           prove
//   V3  DUP / OOO    V3_rsn, V3_only (record); V3_dup, V3_ooo, V3_acc (time)                prove; bmc
//   V4  DROPPED      V4 (no HIST_RESET, SINCE_RESET 0 #25, payload 0 #39)                   prove
//   V5  gap          V5_gap, V5_300, V5_new, V5_first (first record = new history, #24)     bmc
//   V6  hold bound   V6_ovf (#70: INVALID, no reset), V6_held, V6_run                        bmc
//   V7  INVALID      V7_rec, V7_fok (record); V7 (missing = neither OK nor held)            prove; bmc
//   V8  SINCE_RESET  V8                                                                    bmc
//   V9  PREV         V9_new, V9_prev (+ PRV0 per record, TASKS #13)                         bmc; prove
//   V10 wells        V10                                                                   prove
//   V11 last_ts      V11 (drop decision uses the last non-DROPPED TS)                       bmc
//   V12 independence V12 (= REF on f_slot's records)                                        bmc
//   extra            HDR ST RSN STS HELD_rsn VAL_obs VAL_inv0 HR HLD0 GAP INC_* CAUSE LOST   prove
//                    HV (held value = last OK value), REF_* (every output bit)              bmc
//
// Ordering of fac_touch (lead clarification): a touch of slot f in the cycle a slot-f record is accepted, or
// while it is held, applies to f's next record. In general a touch in cycle t applies to the records accepted
// after cycle t.
//
// Input assumptions (all tasks): the handshake rules of the input link and the low 8 REC_NO bits counting
// accepted records (eog_fv_stage). Nothing else is assumed about record contents (TS, FAC_ID, PRESENT, values,
// reserved fields, FRAME_ERR, IN_LAST, upper REC_NO bits) unless FV_NARROW / FV_FAST are defined (bmc only).

`default_nettype none

// =============================================================================================================
// fv_validate_ref: reference of numerics.md §3 (v4) for one record (combinational). Inputs: bus U, the record's
// CONFIG row, GLOBAL, and the pre-record state of the record's slot. Outputs: bus V, `upd` (record is not
// DROPPED, so the slot state takes the n_* values), and the record-only decode (d_*) used by the per-record
// properties. Field index k: 0..6 facility fields in PRESENT-bit order (0 inflow, 1 level, 2 pump status,
// 3 pump flow, 4 discharge, 5 receive flow, 6 pipeline; LO/HI index = k); 7..7+N_WELL-1 well status i;
// 7+N_WELL.. well water i. Slot state: has_ts, last_ts, since, hold_run, prev_level/prev_ok, per field
// last_valid value + has bit (s_pend is an alias of !has_ts, kept for the stub; tie it to 0). Reset and a touch
// clear has_ts; the slot's next non-DROPPED record is then its "first" record: a history reset, flagged (#24),
// which clears the rest of the state lazily (no DROPPED record can observe the difference).
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
    input  logic [1:0]         s_hold_run,
    input  logic [15:0]        s_prev_level,
    input  logic               s_prev_ok,
    input  logic [NFLD*16-1:0] s_fval,
    input  logic [NFLD-1:0]    s_fhas,
    output logic [372:0]       v,            // bus V (EOG_BV_W)
    output logic               upd,
    output logic               n_has_ts,
    output logic               n_pend,
    output logic [31:0]        n_last_ts,
    output logic [7:0]         n_since,
    output logic [1:0]         n_hold_run,
    output logic [15:0]        n_prev_level,
    output logic               n_prev_ok,
    output logic [NFLD*16-1:0] n_fval,
    output logic [NFLD-1:0]    n_fhas,
    output logic               d_framing,    // step 1 condition
    output logic               d_unknown,    // step 2 condition (FAC_ID >= N_FAC or FLAGS[0] = 0)
    output logic [NFLD-1:0]    d_req,        // field required (facility fields; wells i < n_wells)
    output logic [NFLD-1:0]    d_present,
    output logic [NFLD-1:0]    d_legal,      // enum legal (1 for readings)
    output logic [NFLD-1:0]    d_inr,        // within LO/HI (1 for well status)
    output logic [NFLD-1:0]    d_obs,        // OK: present, legal, in range
    output logic [NFLD*16-1:0] d_raw,        // raw value (pump status zero-extended from u8, well status 2 bits)
    output logic [3:0]         d_n_wells,    // min(CFG.N_WELLS, N_WELL)  (TASKS #14)
    output logic [1:0]         d_hold        // min(G.HOLD_MAX, 2)
);
`include "eog_defs.svh"
    localparam integer R_FIELD_ABSENT = 11;  // restored by TASKS #23 (not in the v4 eog_defs.svh)
    localparam integer R_FIELD_LOST   = 14;

    logic [383:0]       r;
    logic [15:0]        fac_raw;
    logic [31:0]        ts;
    logic signed [32:0] dts;                 // #35: exact difference
    logic [7:0]         nwc, hm;
    logic               tchk, dup, ooo, t_norm, t_gap, t_rst, clr1, drop;
    logic [15:0]        drop_rsn;

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
    assign dts    = $signed({1'b0, ts}) - $signed({1'b0, s_last_ts});
    assign dup    = tchk & (dts == 33'sd0);
    assign ooo    = tchk & ~dup & (dts < 33'sd300);
    assign t_norm = tchk & (dts == 33'sd300);
    assign t_gap  = tchk & (((dts == 33'sd600) & (d_hold >= 2'd1)) | ((dts == 33'sd900) & (d_hold >= 2'd2)));
    assign t_rst  = tchk & ~dup & ~ooo & ~t_norm & ~t_gap;       // missing steps > hold, or not a multiple
    assign clr1   = t_rst | s_pend | ~s_has_ts;                  // history cleared before the fields
                                                                   // (#24: also on the first record)
    assign drop   = d_framing | d_unknown | dup | ooo;
    assign upd    = ~drop;
    always_comb begin
        drop_rsn = '0;
        if (d_framing)      drop_rsn[EOG_R_FRAMING]      = 1'b1;
        else if (d_unknown) drop_rsn[EOG_R_UNKNOWN_FAC]  = 1'b1;
        else if (dup)       drop_rsn[EOG_R_DUPLICATE]    = 1'b1;
        else if (ooo)       drop_rsn[EOG_R_OUT_OF_ORDER] = 1'b1;
    end

    // 4: fields
    logic [NFLD-1:0] f_cand;          // not OK but has a last_valid value (held unless the hold run overflows)
    genvar k;
    generate
        for (k = 0; k < NFLD; k = k + 1) begin : g_f
            // KIND 0 reading (s16, LO/HI[k]), 1 pump status (u8, legal 0..2, LO/HI[2]), 2 well status (2 bits,
            // legal 0..1), 3 well water (s16, WELL_LO/WELL_HI)
            localparam integer KIND = (k == 2) ? 1 : (k < 7) ? 0 : (k < 7 + N_WELL) ? 2 : 3;
            localparam integer WI   = (k < 7) ? 0 : (k < 7 + N_WELL) ? k - 7 : k - 7 - N_WELL;
            localparam integer PB   = (k < 7) ? k : (k < 7 + N_WELL) ? 8 + WI : 16 + WI;
            localparam integer OFF  = (k == 0) ? EOG_D_INFLOW : (k == 1) ? EOG_D_LEVEL : (k == 2) ? EOG_D_PUMP_ST :
                                      (k == 3) ? EOG_D_PUMP_FLOW : (k == 4) ? EOG_D_DIS_PSI :
                                      (k == 5) ? EOG_D_RECV_FLOW : (k == 6) ? EOG_D_PIPE_PSI :
                                      (k < 7 + N_WELL) ? EOG_D_WELL_ST + 2 * WI : EOG_D_WELL_WATER + 16 * WI;
            localparam integer LH   = (k < 7) ? k : 0;           // v4: LO/HI index = present bit
            logic [15:0]        raw;
            logic signed [15:0] lo, hi;
            assign raw = (KIND == 1) ? {8'd0, r[OFF +: 8]} : (KIND == 2) ? {14'd0, r[OFF +: 2]} : r[OFF +: 16];
            assign lo  = (KIND == 3) ? row[EOG_CFG_WELL_LO +: 16] : row[EOG_CFG_LO + 16 * LH +: 16];
            assign hi  = (KIND == 3) ? row[EOG_CFG_WELL_HI +: 16] : row[EOG_CFG_HI + 16 * LH +: 16];
            assign d_raw[16*k +: 16] = raw;
            assign d_present[k] = r[EOG_D_PRESENT + PB];
            assign d_legal[k]   = (KIND == 1) ? (raw <= 16'd2) : (KIND == 2) ? (raw <= 16'd1) : 1'b1;
            assign d_inr[k]     = (KIND == 2) ? 1'b1 : (($signed(raw) >= lo) && ($signed(raw) <= hi));
            assign d_obs[k]     = d_present[k] & d_legal[k] & d_inr[k];
            assign d_req[k]     = (k < 7) ? 1'b1 : (4'(WI) < d_n_wells);
            assign f_cand[k]    = d_req[k] & ~d_obs[k] & s_fhas[k] & ~clr1;
        end
    endgenerate

    // 5 (#70, R7 option C): hold run saturating at 3; overflow -> every held field becomes missing (INVALID),
    // no history reset (last_valid and the run are kept)
    logic [2:0]       hr_next;
    logic             ovf, hist, invalid, held_any, absent_any, enum_any, range_any, pinc, winc;
    logic [NFLD-1:0]  f_held, f_miss;
    logic [2:0]       status;
    logic [7:0]       since_o, well_act;
    logic [127:0]     well_water;
    logic [NFLD*16-1:0] f_out;     // value on bus V per field
    logic [6:0]       fld_ok;
    logic             wells_ok, prev_ok_o;
    logic [15:0]      prev_level_o;
    integer           i;
    always_comb begin
        hr_next  = (|f_cand) ? ((clr1 ? 3'd0 : {1'b0, s_hold_run}) + 3'd1) : 3'd0;
        if (hr_next > 3'd3) hr_next = 3'd3;
        ovf      = (hr_next > {1'b0, d_hold});
        hist     = clr1;
        f_held   = ovf ? '0 : f_cand;
        f_miss   = d_req & ~d_obs & ~f_held;
        invalid  = |f_miss;                                       // 7
        held_any = |f_held;
        absent_any = |(d_req & ~d_present);
        enum_any  = |(d_req & d_present & ~d_legal);
        range_any = |(d_req & d_present & d_legal & ~d_inr);
        status   = invalid ? EOG_ST_INVALID : (held_any | t_gap) ? EOG_ST_HELD : EOG_ST_VALID;   // 8
        since_o  = hist ? 8'd0 : s_since;                         // 10: value before this record
        prev_ok_o    = ~hist & s_prev_ok;
        prev_level_o = prev_ok_o ? s_prev_level : 16'd0;          // TASKS #13
        // values: VALID/HELD -> OK value or last_valid; INVALID -> OK value else 0 [Q3]; not required -> 0
        for (i = 0; i < NFLD; i = i + 1)
            f_out[16*i +: 16] = (d_req[i] & d_obs[i]) ? d_raw[16*i +: 16] :
                                (d_req[i] & f_held[i] & ~invalid) ? s_fval[16*i +: 16] : 16'd0;
        fld_ok   = invalid ? d_obs[6:0] : 7'h7F;                  // [Q3]
        wells_ok = 1'b1;
        well_act = '0;
        well_water = '0;
        winc = 1'b0;
        for (i = 0; i < N_WELL; i = i + 1) begin
            if (invalid) wells_ok = wells_ok & (~d_req[7 + i] | (d_obs[7 + i] & d_obs[7 + N_WELL + i]));
            well_act[i] = d_req[7 + i] & (f_out[16*(7 + i) +: 16] == 16'd1);
            well_water[16*i +: 16] = f_out[16*(7 + N_WELL + i) +: 16];
            winc = winc | (d_req[7 + i] & (f_out[16*(7 + i) +: 16] != 16'd1) &
                           ($signed(f_out[16*(7 + N_WELL + i) +: 16]) > 16'sd0));
        end
        // 9: consistency flags, VALID/HELD only (#38)
        pinc = ~invalid & (f_out[32 +: 2] != 2'd1) & ($signed(f_out[48 +: 16]) > 16'sd0);
        winc = ~invalid & winc;
    end

    // outputs
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
            // every DROPPED record: SINCE_RESET 0 (#25), all values 0 (#39)
        end else begin
            v[EOG_BV_STATUS +: EOG_BV_STATUS_W] = status;
            v[EOG_BV_REASON + EOG_R_FIELD_HELD]   = held_any;
            v[EOG_BV_REASON + EOG_R_GAP_HELD]     = t_gap;
            v[EOG_BV_REASON + EOG_R_HIST_RESET]   = hist;
            v[EOG_BV_REASON + EOG_R_OUT_OF_RANGE] = range_any;
            v[EOG_BV_REASON + EOG_R_ILLEGAL_ENUM] = enum_any;
            v[EOG_BV_REASON + EOG_R_PUMP_INCONS]  = pinc;
            v[EOG_BV_REASON + EOG_R_WELL_INCONS]  = winc;
            v[EOG_BV_REASON + R_FIELD_ABSENT]     = absent_any;
            v[EOG_BV_REASON + R_FIELD_LOST]       = invalid;
            v[EOG_BV_SINCE_RESET +: EOG_BV_SINCE_RESET_W] = since_o;
            v[EOG_BV_HIST_RESET]                  = hist;
            v[EOG_BV_INFLOW +: 16]                = f_out[16*0 +: 16];
            v[EOG_BV_LEVEL +: 16]                 = f_out[16*1 +: 16];
            v[EOG_BV_PUMP_ST +: 2]                = f_out[16*2 +: 2];
            v[EOG_BV_PUMP_FLOW +: 16]             = f_out[16*3 +: 16];
            v[EOG_BV_DIS_PSI +: 16]               = f_out[16*4 +: 16];
            v[EOG_BV_RECV_FLOW +: 16]             = f_out[16*5 +: 16];
            v[EOG_BV_PIPE_PSI +: 16]              = f_out[16*6 +: 16];
            v[EOG_BV_WELL_ACT +: EOG_BV_WELL_ACT_W]     = well_act;
            v[EOG_BV_WELL_WATER +: EOG_BV_WELL_WATER_W] = well_water;
            v[EOG_BV_FLD_OK +: EOG_BV_FLD_OK_W]         = fld_ok;
            v[EOG_BV_WELLS_OK]                          = wells_ok;
            v[EOG_BV_PREV_LEVEL +: EOG_BV_PREV_LEVEL_W] = prev_level_o;
            v[EOG_BV_PREV_OK]                           = prev_ok_o;
        end
    end

    // state update (applies only when upd = 1): last_ts on every non-DROPPED record, last_valid for every OK
    // field (also on INVALID), since + 1 and prev_level only on VALID/HELD
    assign n_has_ts     = 1'b1;
    assign n_pend       = 1'b0;
    assign n_last_ts    = ts;
    assign n_since      = invalid ? since_o : (since_o == 8'd255) ? 8'd255 : since_o + 8'd1;
    assign n_hold_run   = hr_next[1:0];
    assign n_prev_level = invalid ? s_prev_level : f_out[16*1 +: 16];
    assign n_prev_ok    = invalid ? prev_ok_o : 1'b1;
    assign n_fhas       = (hist ? '0 : s_fhas) | (d_req & d_obs);
    generate
        for (k = 0; k < NFLD; k = k + 1) begin : g_n
            assign n_fval[16*k +: 16] = (d_req[k] & d_obs[k]) ? d_raw[16*k +: 16] : s_fval[16*k +: 16];
        end
    endgenerate
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
    localparam integer R_FIELD_ABSENT = 11;  // restored by TASKS #23 (not in the v4 eog_defs.svh)
    localparam integer R_FIELD_LOST   = 14;

    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

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
    // bmc only: data narrowing. The history properties are about flags, counters and time deltas, not data
    // width; the full widths are covered by the per-record properties in `prove` and by simulation. Readings,
    // well water and every LO/HI limit are sign-extended 4-bit values (-8..7), pump status < 8, and TS moves in a
    // 12-bit window (TS[31:12] constant), so 300/600/900 deltas, duplicates, partial steps and out-of-order all
    // remain possible.
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
    // q_t*: a touch of f_slot is ordered just before this record (it happened after the previous record was
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

    // CONFIG row of the record's slot (an unknown FAC_ID >= N_FAC never uses it)
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
        .s_has_ts(1'b0), .s_pend(1'b0), .s_last_ts(32'd0), .s_since(8'd0), .s_hold_run(2'd0),
        .s_prev_level(16'd0), .s_prev_ok(1'b0), .s_fval('0), .s_fhas('0),
        .v(), .upd(), .n_has_ts(), .n_pend(), .n_last_ts(), .n_since(), .n_hold_run(), .n_prev_level(),
        .n_prev_ok(), .n_fval(), .n_fhas(),
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

    logic chk, drop, nd, inv, vh;
    assign chk  = f_past_valid && rst_n && out_valid;
    assign drop = (o_st == EOG_ST_DROPPED);
    assign nd   = chk && !drop;
    assign inv  = (o_st == EOG_ST_INVALID);
    assign vh   = (o_st == EOG_ST_VALID) || (o_st == EOG_ST_HELD);

`ifndef FV_NO_REC
    // =========================================================================================================
    // 2. Per-record properties (prove; bmc tasks skip them with -DFV_NO_REC)
    // Field-level facts of the record, folded into vectors (one assertion each, no labels inside loops).
    logic [NFLD-1:0] p_obs_val;     // OK -> value carried unchanged (every non-DROPPED record)
    logic [NFLD-1:0] p_inv0;        // INVALID, required, not OK -> value 0 [Q3]
    logic            req_nobs, well_nobs, absent_x, enum_x, range_x, winc_vh;
    logic [7:0]      p_v10;         // well slot i >= n_wells: WELL_ACT[i] = 0, WELL_WATER[i] = 0
    integer          j;
    always_comb begin
        for (j = 0; j < NFLD; j = j + 1) begin
            p_obs_val[j] = !(d_req[j] && d_obs[j]) || (o_fv[16*j +: 16] == d_rv[16*j +: 16]);
            p_inv0[j]    = !(d_req[j] && !d_obs[j] && inv) || (o_fv[16*j +: 16] == 16'd0);
        end
        for (j = 0; j < 8; j = j + 1)
            p_v10[j] = (j < d_n_wells && j < N_WELL) || (!o_wact[j] && o_wwat[16*j +: 16] == 16'd0);
        req_nobs  = |(d_req & ~d_obs);
        well_nobs = |(d_req[NFLD-1:7] & ~d_obs[NFLD-1:7]);
        absent_x  = |(d_req & ~d_present);
        enum_x    = |(d_req & d_present & ~d_legal);
        range_x   = |(d_req & d_present & d_legal & ~d_inr);
        winc_vh   = 1'b0;   // a configured slot whose (usable) values show status 0 and water > 0
        for (j = 0; j < N_WELL; j = j + 1)
            winc_vh = winc_vh | (d_req[7 + j] & !o_wact[j] & ($signed(o_wwat[16*j +: 16]) > 16'sd0));
    end

    always_comb begin
        if (chk) begin
            // HDR: header pass-through (conventions §3; FAC = FAC_ID[4:0] also when DROPPED)
            HDR:   assert (o_recno == c_x[EOG_BU_REC_NO +: 32] && o_last == c_x[EOG_BU_IN_LAST] &&
                           o_facraw == c_x[EOG_BU_REC + EOG_D_FAC_ID +: 16] &&
                           o_fac == c_x[EOG_BU_REC + EOG_D_FAC_ID +: 5] &&
                           o_ts == c_x[EOG_BU_REC + EOG_D_TS +: 32]);
            // ST: STATUS is one of the RESULT codes 0, 1, 3, 4 (2 is never produced)
            ST:    assert (o_st == EOG_ST_VALID || o_st == EOG_ST_HELD || o_st == EOG_ST_INVALID || drop);
            // RSN: validate never sets FEAT_SAT (5) or NO_MODEL (13, eog_head); bit 15 is never used
            RSN:   assert (!o_rsn[EOG_R_FEAT_SAT] && !o_rsn[13] && !o_rsn[15]);
            // V1: FRAME_ERR or a nonzero reserved field -> DROPPED, exactly FRAMING, SINCE_RESET 0
            if (d_framing) V1: assert (drop && o_rsn == (16'd1 << EOG_R_FRAMING) && o_since == 8'd0);
            else           V1_only: assert (!o_rsn[EOG_R_FRAMING]);
            // V2: FAC_ID >= N_FAC or slot disabled -> DROPPED, exactly UNKNOWN_FAC, SINCE_RESET 0 (after framing)
            if (!d_framing && d_unknown)
                V2: assert (drop && o_rsn == (16'd1 << EOG_R_UNKNOWN_FAC) && o_since == 8'd0);
            else
                V2_only: assert (!o_rsn[EOG_R_UNKNOWN_FAC]);
            // V3 (record part): any other DROPPED record carries exactly DUPLICATE or OUT_OF_ORDER, and those two
            // bits appear only on DROPPED records
            if (drop && !d_framing && !d_unknown)
                V3_rsn: assert (o_rsn == (16'd1 << EOG_R_DUPLICATE) || o_rsn == (16'd1 << EOG_R_OUT_OF_ORDER));
            if (!drop)
                V3_only: assert (!o_rsn[EOG_R_DUPLICATE] && !o_rsn[EOG_R_OUT_OF_ORDER]);
            // V4: DROPPED never has HIST_RESET; SINCE_RESET 0 (#25); value fields, FLD_OK, WELLS_OK, PREV_* 0 (#39)
            if (drop) V4: assert (!o_hr && o_since == 8'd0 && o_payload == '0);
            // PRV0: PREV_OK = 0 -> PREV_LEVEL = 0 (TASKS #13)
            PRV0:  assert (o_pok || o_plev == 16'd0);
            // V10: WELL_ACT[i] = 0 and WELL_WATER[i] = 0 for i >= n_wells (n_wells = min(N_WELLS, N_WELL), #14)
            V10:   assert (&p_v10);
        end
        if (nd) begin
            // HR: the HIST_RESET bit equals reason bit 2; a reset record (time gap, first record, touch; #70: never
            // a hold overflow) has SINCE_RESET 0, PREV_OK 0, no GAP_HELD, and holds nothing (the cleared history
            // has no last_valid), so it is INVALID iff some required field is not OK
            HR:       assert (o_hr == o_rsn[EOG_R_HIST_RESET]);
            if (o_hr) HR_new: assert (o_since == 8'd0 && !o_pok && !o_rsn[EOG_R_FIELD_HELD] &&
                                      inv == req_nobs && !o_rsn[EOG_R_GAP_HELD]);
            // STS: status from the reason bits (steps 7-8): not INVALID -> HELD iff FIELD_HELD or GAP_HELD
            if (!inv) STS: assert ((o_st == EOG_ST_HELD) == (o_rsn[EOG_R_FIELD_HELD] || o_rsn[EOG_R_GAP_HELD]));
            // V7 (record part): INVALID needs a required field that is not OK
            if (inv) V7_rec: assert (req_nobs);
            // V7_fok: VALID/HELD -> every value usable (FLD_OK = 7F, WELLS_OK = 1); INVALID -> FLD_OK / WELLS_OK
            // say which fields are OK [Q3]
            if (inv) V7_fok: assert (o_fok == d_obs[6:0] && o_wok == !well_nobs);
            else     V7_fok_vh: assert (o_fok == 7'h7F && o_wok);
            // HELD_rsn: on VALID/HELD every required field that is not OK is held -> FIELD_HELD; FIELD_HELD needs
            // a required field that is not OK
            if (!inv && req_nobs) HELD_rsn: assert (o_rsn[EOG_R_FIELD_HELD]);
            if (o_rsn[EOG_R_FIELD_HELD]) HELD_any: assert (req_nobs);
            // VAL_obs: an OK field's value is carried unchanged (VALID, HELD and INVALID)
            VAL_obs:  assert (&p_obs_val);
            // VAL_inv0: INVALID -> a required field that is not OK reads 0 [Q3]
            VAL_inv0: assert (&p_inv0);
            // CAUSE: FIELD_ABSENT iff a required field's present bit is clear (#23); ILLEGAL_ENUM iff a required
            // present field has an illegal enum (pump status not 0-2, well status not 0-1); OUT_OF_RANGE iff a
            // required present legal field is outside LO/HI[j] (pump status: LO[2]/HI[2]) or WELL_LO/WELL_HI
            CAUSE: assert (o_rsn[R_FIELD_ABSENT] == absent_x && o_rsn[EOG_R_ILLEGAL_ENUM] == enum_x &&
                           o_rsn[EOG_R_OUT_OF_RANGE] == range_x);
            // LOST: FIELD_LOST iff INVALID (#23: some required field had no value to use)
            LOST:  assert (o_rsn[R_FIELD_LOST] == inv);
            // GAP: GAP_HELD is never VALID
            if (o_rsn[EOG_R_GAP_HELD]) GAP: assert (o_st != EOG_ST_VALID);
            // HLD0: hold = min(HOLD_MAX, 2) = 0 -> nothing is held (any held field overflows the run)
            if (d_hold == 2'd0) HLD0: assert (!o_rsn[EOG_R_FIELD_HELD] && !o_rsn[EOG_R_GAP_HELD]);
            // INC (#38): VALID/HELD: PUMP_INCONS = PUMP_ST != 1 & PUMP_FLOW > 0; WELL_INCONS = a configured slot
            // with status 0 and water > 0. INVALID: neither.
            if (vh) INC_p: assert (o_rsn[EOG_R_PUMP_INCONS] ==
                                   (o_pst != 2'd1 && $signed(out_data[EOG_BV_PUMP_FLOW +: 16]) > 16'sd0));
            if (vh) INC_w: assert (o_rsn[EOG_R_WELL_INCONS] == winc_vh);
            if (inv) INC_inv: assert (!o_rsn[EOG_R_PUMP_INCONS] && !o_rsn[EOG_R_WELL_INCONS]);
        end
    end
`endif

`ifndef FV_NO_HIST
    // =========================================================================================================
    // 3a. History properties of the tracked slot f_slot, from an output-derived shadow (bmc).
    // sh_*: the slot state the spec gives f_slot after the records output so far (output order == accept order)
    // and the touches ordered before them; p_* adds the touch ordered just before the record at the output.
    logic               sh_has_ts, sh_pok;
    logic [31:0]        sh_last_ts;
    logic [7:0]         sh_since;
    logic [1:0]         sh_hrun;           // the spec's hold_run (0..3)
    logic [15:0]        sh_plev, sh_val;
    logic [NFLD-1:0]    sh_has;            // field has a last_valid value
    logic               p_has_ts, p_tchk, mine, known;
    logic signed [32:0] p_d;
    assign p_has_ts = sh_has_ts && !c_tch;   // a touch clears last_ts: the next record is a slot's "first"
    assign p_tchk   = p_has_ts;
    assign p_d      = $signed({1'b0, o_ts}) - $signed({1'b0, sh_last_ts});   // #35
    assign mine     = (c_id == {11'd0, f_slot});
    assign known    = mine && !d_framing && !d_unknown;      // a record of f_slot that passes steps 1-2

    // Expected time outcome and hold-run outcome of the record from the shadow (numerics §3 steps 3-5)
    logic            e_dup, e_ooo, e_300, e_gap, e_trst, e_clr, e_ovf;
    logic [NFLD-1:0] e_has, e_cand, e_miss;
    logic [2:0]      e_hrun;
    assign e_dup  = p_tchk && p_d == 33'sd0;
    assign e_ooo  = p_tchk && p_d != 33'sd0 && p_d < 33'sd300;
    assign e_300  = p_tchk && p_d == 33'sd300;
    assign e_gap  = p_tchk && ((p_d == 33'sd600 && d_hold >= 2'd1) || (p_d == 33'sd900 && d_hold >= 2'd2));
    assign e_trst = p_tchk && p_d > 33'sd300 && !e_gap;
    assign e_clr  = e_trst || !p_has_ts;                      // history cleared before the fields (#24)
    assign e_has  = e_clr ? '0 : sh_has;
    assign e_cand = d_req & ~d_obs & e_has;
    assign e_hrun = !(|e_cand) ? 3'd0 : (!e_clr && sh_hrun == 2'd3) ? 3'd3 :
                    ((e_clr ? 3'd0 : {1'b0, sh_hrun}) + 3'd1);         // #70: saturates at 3
    assign e_ovf  = e_hrun > {1'b0, d_hold};
    assign e_miss = d_req & ~d_obs & ~(e_ovf ? '0 : e_cand);
    // the DUT's own run of records in a row with FIELD_HELD (reset by a record without it or a HIST_RESET)
    logic [2:0]      o_run;
    logic [1:0]      sh_orun;
    assign o_run  = (o_hr || !o_rsn[EOG_R_FIELD_HELD]) ? 3'd0 : ({1'b0, sh_orun} + 3'd1);

    // V6 / HV shadow for field f_fld: its last OK value
    logic        t_obs, t_req;
    logic [15:0] t_oval, t_view;
    assign t_obs  = d_obs[f_fld];
    assign t_req  = d_req[f_fld];
    assign t_oval = o_fv[16*f_fld +: 16];
    assign t_view = (f_fld == 5'd2) ? {14'd0, sh_val[1:0]} :
                    (f_fld >= 5'd7 && f_fld < 5'(7 + N_WELL)) ? {15'd0, sh_val == 16'd1} : sh_val;

    always_ff @(posedge clk) begin
        if (!rst_n) begin                    // reset: no last_ts, state clear
            sh_has_ts <= 1'b0;
            sh_pok    <= 1'b0;
            sh_since  <= 8'd0;
            sh_hrun   <= 2'd0;
            sh_orun   <= 2'd0;
            sh_has    <= '0;
        end else if (out_fire) begin
            if (c_tch) sh_has_ts <= 1'b0;    // touch ordered before this record
            if (mine && !drop) begin
                sh_has_ts  <= 1'b1;
                sh_last_ts <= o_ts;
                sh_since   <= inv ? o_since : (o_since == 8'd255) ? 8'd255 : o_since + 8'd1;
                sh_hrun    <= e_hrun[1:0];
                sh_orun    <= o_run[1:0];
                if (!inv) begin
                    sh_pok  <= 1'b1;
                    sh_plev <= out_data[EOG_BV_LEVEL +: 16];
                end else if (o_hr) begin
                    sh_pok  <= 1'b0;
                end
                sh_has <= (o_hr ? '0 : sh_has) | (d_req & d_obs);
                if (t_req && t_obs) sh_val <= d_raw[16*f_fld +: 16];
            end
        end
    end

    always_comb begin
        if (chk && known) begin
            // V3: TS == last_ts -> DROPPED DUPLICATE; TS - last_ts < 300 (signed #35: negative or a partial step)
            // -> DROPPED OUT_OF_ORDER (SINCE_RESET 0, #25: V4); only when the slot has a last_ts (none after reset
            // or a CONFIG touch); otherwise the record is not dropped
            if (e_dup)      V3_dup: assert (drop && o_rsn == (16'd1 << EOG_R_DUPLICATE));
            else if (e_ooo) V3_ooo: assert (drop && o_rsn == (16'd1 << EOG_R_OUT_OF_ORDER));
            else            V3_acc: assert (!drop);
            // V11: the drop decision uses the TS of the slot's last non-DROPPED record (sh_last_ts advances on
            // VALID/HELD/INVALID only)
            V11: assert (drop == (p_tchk && p_d < 33'sd300));
        end
        if (chk && known && !drop) begin
            // V5: d == 300 -> no time reset; d in {600, 900} within the hold limit -> GAP_HELD, no time reset;
            // any other d > 300 -> HIST_RESET (#70: a hold overflow never resets)
            if (e_300)       V5_300:   assert (!o_rsn[EOG_R_GAP_HELD] && !o_hr);
            else if (e_gap)  V5_gap:   assert (o_rsn[EOG_R_GAP_HELD] && !o_hr && o_st != EOG_ST_VALID);
            else if (e_trst) V5_new:   assert (o_hr && !o_rsn[EOG_R_GAP_HELD]);
            // a slot's first record (no last_ts: after reset or a CONFIG touch) is a new history (#24)
            else             V5_first: assert (o_hr && !o_rsn[EOG_R_GAP_HELD]);
            // V6 (#70): a record whose hold run (records in a row with a held candidate, saturating at 3) exceeds
            // hold is INVALID with FIELD_LOST, holds nothing and is NOT a history reset; otherwise a field is held
            // exactly when some required field is not OK but has a last_valid value; and the DUT's run of
            // records with FIELD_HELD never exceeds hold
            if (e_ovf) V6_ovf: assert (!o_hr && inv && o_rsn[R_FIELD_LOST] && !o_rsn[EOG_R_FIELD_HELD]);
            else       V6_held: assert (o_rsn[EOG_R_FIELD_HELD] == (|e_cand));
            V6_run: assert (o_run <= {1'b0, d_hold});
            // V7: INVALID iff some required field is neither OK nor held (after step 5)
            V7: assert (inv == (|e_miss));
            // V8: SINCE_RESET = 0 on a HIST_RESET record, else the slot's count of VALID/HELD records since its
            // last reset (+1 after each VALID/HELD, saturating; unchanged after INVALID)
            V8: assert (o_since == (o_hr ? 8'd0 : sh_since));
            // V9: on VALID/HELD records PREV_OK = 0 right after a reset; otherwise PREV_LEVEL = the LEVEL of the
            // slot's previous VALID/HELD record [Q6: INVALID records not checked]
            if (vh && o_hr)       V9_new:  assert (!o_pok);
            else if (vh)          V9_prev: assert (o_pok == sh_pok && (!sh_pok || o_plev == sh_plev));
            // HV: a held field (VALID/HELD, not OK) carries its last OK value
            if (vh && t_req && !t_obs) HV: assert (t_oval == t_view);
        end
    end

`ifndef FV_NO_REF
    // =========================================================================================================
    // 3b. REF / V12: every output bit of slot f_slot's records against fv_validate_ref applied to the record and
    // the shadow state above (has_ts, last_ts, since, hold_run, prev from the DUT's outputs; per-field
    // last_valid from the reference's own update, below). Up to the first wrong output this state is exactly the
    // spec's, so the first divergence of the DUT from numerics.md §3 on slot f_slot fails REF. It depends only on
    // f_slot's own records, touches and resets, so equality with the other slot's records interleaved is V12.
    // PREV_LEVEL / PREV_OK are not compared on INVALID records [Q6].
    logic [NFLD*16-1:0] dv_fval, e_fval;
    logic [372:0]       e_v, mask;
    fv_validate_ref #(.N_FAC(N_FAC), .N_WELL(N_WELL)) u_ref (
        .u(c_x), .row(c_row), .glb(f_glb),
        .s_has_ts(p_has_ts), .s_pend(1'b0), .s_last_ts(sh_last_ts), .s_since(sh_since), .s_hold_run(sh_hrun),
        .s_prev_level(sh_plev), .s_prev_ok(sh_pok), .s_fval(dv_fval), .s_fhas(sh_has),
        .v(e_v), .upd(), .n_has_ts(), .n_pend(), .n_last_ts(), .n_since(), .n_hold_run(), .n_prev_level(),
        .n_prev_ok(), .n_fval(e_fval), .n_fhas(),
        .d_framing(), .d_unknown(), .d_req(), .d_present(), .d_legal(), .d_inr(), .d_obs(), .d_raw(),
        .d_n_wells(), .d_hold());

    always_ff @(posedge clk) if (out_fire && mine && !drop) dv_fval <= e_fval;

    always_comb begin
        mask = '1;
        if (inv) mask[372:EOG_BV_PREV_LEVEL] = '0;
    end

    always_comb begin
        if (chk && mine) begin
            REF_hdr:    assert (out_data[EOG_BV_STATUS - 1:0] == e_v[EOG_BV_STATUS - 1:0]);
            REF_status: assert (o_st == e_v[EOG_BV_STATUS +: 3]);
            REF_reason: assert (o_rsn == e_v[EOG_BV_REASON +: 16]);
            REF_since:  assert (out_data[EOG_BV_INFLOW - 1:EOG_BV_SINCE_RESET] ==
                                e_v[EOG_BV_INFLOW - 1:EOG_BV_SINCE_RESET]);
            REF_values: assert ((o_payload & mask[372:EOG_BV_INFLOW]) == (e_v[372:EOG_BV_INFLOW] & mask[372:EOG_BV_INFLOW]));
            V12:        assert ((out_data & mask) == (e_v & mask));
        end
    end
`endif
`endif

    // =========================================================================================================
    // Covers (spec "Cover" list + vacuity checks for the history properties)
    always_comb begin
        if (chk) begin
            C_held:     cover (o_st == EOG_ST_HELD && o_rsn[EOG_R_FIELD_HELD]);
            C_gap:      cover (o_rsn[EOG_R_GAP_HELD] && o_st == EOG_ST_HELD);
            C_invalid:  cover (inv);
            C_hr_inv:   cover (inv && o_hr);
            C_framing:  cover (drop && o_rsn[EOG_R_FRAMING]);
            C_unknown:  cover (drop && o_rsn[EOG_R_UNKNOWN_FAC]);
            C_dup:      cover (drop && o_rsn[EOG_R_DUPLICATE]);
            C_ooo:      cover (drop && o_rsn[EOG_R_OUT_OF_ORDER]);
            C_winc:     cover (!drop && o_rsn[EOG_R_WELL_INCONS]);
            C_pinc:     cover (!drop && o_rsn[EOG_R_PUMP_INCONS]);
`ifndef FV_NO_HIST
            C_ovf:      cover (known && !drop && e_ovf);                       // a hold overflow (#70)
            C_ovf2:     cover (known && !drop && e_ovf && {1'b0, sh_hrun} > {1'b0, d_hold});   // two in a row
            C_ovf_sat:  cover (known && !drop && e_ovf && sh_hrun == 2'd3);    // run saturated at 3
            C_ovf_val:  cover (known && vh && {1'b0, sh_hrun} > {1'b0, d_hold});   // VALID/HELD right after one
            C_ovf_gap:  cover (known && !drop && e_ovf && e_gap);
            C_held2:    cover (known && !drop && o_rsn[EOG_R_FIELD_HELD] && e_hrun == 3'd2);
            C_inv_hold: cover (known && inv && o_rsn[EOG_R_FIELD_HELD]);       // held and missing fields together
            C_touch:    cover (known && !drop && c_tch && sh_has_ts && o_hr);   // a CONFIG touch flags the next record
            C_trst:     cover (known && !drop && e_trst);
            C_ooo_part: cover (known && drop && p_d > 33'sd0 && p_d < 33'sd300);   // a partial step
            C_since2:   cover (known && !drop && o_since == 8'd2);
            C_prev:     cover (known && vh && o_pok);
            C_dup_since:cover (known && drop && o_rsn[EOG_R_DUPLICATE] && sh_since != 8'd0);   // #25 bites
            C_absent:   cover (known && vh && o_rsn[R_FIELD_ABSENT]);
`endif
        end
    end
endmodule

`default_nettype wire
