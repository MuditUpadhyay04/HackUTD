// eog_pack -- bus A -> 32 B RESULT records as 4 x 64-bit AXI-Stream beats, m_last batching, STATS taps.
// Spec v4: spec/modules/eog_pack.md, numerics.md (RESULT layout), conventions.md sections 1-4, 6, 7.
//
// Micro-architecture (one record at a time, no extra buffer):
//   * `rec` holds the RESULT mapping (256 bits) of the accepted record; `busy` = a record is held; `cnt` = index of
//     the beat on m_data (m_data = rec[64*cnt +: 64]). `rec` does not change while busy.
//   * in_ready = !busy || (beat 3 transfers this cycle). So with m_ready = 1 a new record is accepted in the
//     cycle the previous record's last beat leaves: one beat per cycle sustained, II = 4, and a record's beat 0
//     is on m_data the cycle after it is accepted (latency 1). in_ready depends combinationally on m_ready (a
//     different link), never on in_valid.
//   * m_last is decided at acceptance: IN_LAST, or this is the BATCH-th result since the last m_last. `bcnt`
//     counts results accepted since the last m_last (0..BATCH-1).
//   * tap_valid is a combinational 1-cycle pulse in the cycle beat 3 transfers; tap_status / tap_reason are the
//     held record's STATUS / REASON (low 3 / 16 bits of the RESULT fields).
//   * The mapping is pure: FAC_ID = FAC_RAW, STATUS/REASON/RULES zero-extended, SINCE_RESET, TS, LOGITS, WVER,
//     CD_P10/P50/P90 = CD[15:0]/[31:16]/[47:32], RESULT_NO = REC_NO. (TASKS #25 -- DROPPED results carry
//     SINCE_RESET = 0 and WVER = 0 -- is produced upstream: eog_validate zeroes SINCE_RESET, eog_head WVER.)
//
// Ports use non-ANSI declarations so their widths can use the EOG_* constants of the included header.

module eog_pack (
    clk, rst_n,
    in_valid, in_ready, in_data,
    m_valid, m_ready, m_data, m_last,
    tap_valid, tap_status, tap_reason,
    stall
`ifdef FORMAL
    , f_inflight, f_oldest_recno
`endif
);
    /* verilator lint_off UNUSEDPARAM */
    // Common parameter set (conventions 6); this stage has no per-facility state and uses none of them.
    parameter integer N_FAC  = 32;
    parameter integer N_WELL = 8;
    parameter integer II     = 16;
    /* verilator lint_on UNUSEDPARAM */
    parameter integer BATCH  = 45;     // results per RESULT packet (m_last every BATCH results)
    `include "eog_defs.svh"

    input  logic                 clk;
    input  logic                 rst_n;
    input  logic                 in_valid;
    output logic                 in_ready;
    input  logic [EOG_BA_W-1:0]  in_data;
    output logic                 m_valid;
    input  logic                 m_ready;
    output logic [63:0]          m_data;
    output logic                 m_last;
    output logic                 tap_valid;
    output logic [2:0]           tap_status;
    output logic [15:0]          tap_reason;
    output logic                 stall;
`ifdef FORMAL
    output logic [7:0]           f_inflight;
    output logic [31:0]          f_oldest_recno;
`endif

    localparam integer BW = (BATCH > 1) ? $clog2(BATCH) : 1;   // bcnt width (holds 0..BATCH-1)
    localparam logic [BW-1:0] BMAX = BW'(BATCH - 1);

    // ------------------------------------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------------------------------------
    logic                   busy;    // a record is held / m_valid
    logic [1:0]             cnt;     // beat on m_data
    logic [EOG_RES_BITS-1:0] rec;    // RESULT of the held record
    logic                   rlast;   // m_last of the held record (on beat 3)
    logic [BW-1:0]          bcnt;    // results accepted since the last m_last

    // ------------------------------------------------------------------------------------------------------
    // Combinational
    // ------------------------------------------------------------------------------------------------------
    logic beat;      // a beat transfers
    logic fin;       // beat 3 transfers (record done)
    logic acc;       // a record is accepted
    logic in_last;   // IN_LAST of the incoming record
    logic nlast;     // m_last decision for the incoming record
    logic [EOG_RES_BITS-1:0] nrec;

    assign beat     = busy && m_ready;
    assign fin      = beat && (cnt == 2'd3);
    assign in_ready = !busy || fin;
    assign acc      = in_valid && in_ready;
    assign in_last  = in_data[EOG_BA_IN_LAST];
    assign nlast    = in_last || (bcnt == BMAX);

    always_comb begin
        nrec = '0;
        nrec[EOG_RES_FAC_ID      +: EOG_RES_FAC_ID_W]      = in_data[EOG_BA_FAC_RAW +: EOG_BA_FAC_RAW_W];
        nrec[EOG_RES_STATUS      +: EOG_BA_STATUS_W]       = in_data[EOG_BA_STATUS +: EOG_BA_STATUS_W];
        nrec[EOG_RES_SINCE_RESET +: EOG_RES_SINCE_RESET_W] = in_data[EOG_BA_SINCE_RESET +: EOG_BA_SINCE_RESET_W];
        nrec[EOG_RES_TS          +: EOG_RES_TS_W]          = in_data[EOG_BA_TS +: EOG_BA_TS_W];
        nrec[EOG_RES_REASON      +: EOG_BA_REASON_W]       = in_data[EOG_BA_REASON +: EOG_BA_REASON_W];
        nrec[EOG_RES_LOGITS      +: EOG_RES_LOGITS_W]      = in_data[EOG_BA_LOGITS +: EOG_BA_LOGITS_W];
        nrec[EOG_RES_RULES       +: EOG_BA_RULES_W]        = in_data[EOG_BA_RULES +: EOG_BA_RULES_W];
        nrec[EOG_RES_WVER        +: EOG_RES_WVER_W]        = in_data[EOG_BA_WVER +: EOG_BA_WVER_W];
        nrec[EOG_RES_CD_P10      +: EOG_RES_CD_P10_W]      = in_data[EOG_BA_CD +: 16];
        nrec[EOG_RES_CD_P50      +: EOG_RES_CD_P50_W]      = in_data[EOG_BA_CD + 16 +: 16];
        nrec[EOG_RES_CD_P90      +: EOG_RES_CD_P90_W]      = in_data[EOG_BA_CD + 32 +: 16];
        nrec[EOG_RES_RESULT_NO   +: EOG_RES_RESULT_NO_W]   = in_data[EOG_BA_REC_NO +: EOG_BA_REC_NO_W];
    end

    // Unused bus A fields: FAC (flat slot), HIST_RESET, CLASSES (consumed by eog_alarm).
    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_ok;
    assign unused_ok = &{1'b0, in_data[EOG_BA_FAC +: EOG_BA_FAC_W], in_data[EOG_BA_HIST_RESET],
                         in_data[EOG_BA_CLASSES +: EOG_BA_CLASSES_W]};
    /* verilator lint_on UNUSEDSIGNAL */

    // ------------------------------------------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------------------------------------------
    assign m_valid    = busy;
    assign m_data     = rec[64*cnt +: 64];
    assign m_last     = busy && (cnt == 2'd3) && rlast;
    assign tap_valid  = fin;
    assign tap_status = rec[EOG_RES_STATUS +: 3];
    assign tap_reason = rec[EOG_RES_REASON +: 16];
    assign stall      = busy && !m_ready;

    // ------------------------------------------------------------------------------------------------------
    // Sequential
    // ------------------------------------------------------------------------------------------------------
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            busy  <= 1'b0;
            cnt   <= 2'd0;
            rec   <= '0;
            rlast <= 1'b0;
            bcnt  <= '0;
        end else begin
            if (beat) cnt <= cnt + 2'd1;         // wraps 3 -> 0 on the last beat
            if (fin)  busy <= 1'b0;
            if (acc) begin
                busy  <= 1'b1;
                rec   <= nrec;
                rlast <= nlast;
                bcnt  <= nlast ? '0 : bcnt + 1'b1;
            end
        end
    end

`ifdef FORMAL
    assign f_inflight     = busy ? 8'd1 : 8'd0;
    assign f_oldest_recno = rec[EOG_RES_RESULT_NO +: EOG_RES_RESULT_NO_W];

    // ------------------------------------------------------------------------------------------------------
    // Internal invariants (help k-induction; about this module's own state only)
    // ------------------------------------------------------------------------------------------------------
    always_comb begin
        if (rst_n) begin
            if (!busy) assert (cnt == 2'd0);
            assert (bcnt <= BMAX);
            // a held record whose m_last is not set was not the BATCH-th: bcnt counts it
            if (busy && !rlast) assert (bcnt != '0 || BATCH == 1);
            // RESULT padding bits are zero (zero-extended fields)
            assert (rec[EOG_RES_STATUS + 3 +: EOG_RES_STATUS_W - 3] == '0);
            assert (rec[EOG_RES_REASON + 16 +: EOG_RES_REASON_W - 16] == '0);
            assert (rec[EOG_RES_RULES + 5 +: EOG_RES_RULES_W - 5] == '0);
        end
    end
`endif

endmodule
