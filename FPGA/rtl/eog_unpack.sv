// eog_unpack -- 64-bit AXI-Stream beats -> 48 B DATA records on bus U (REC_NO, IN_LAST, FRAME_ERR, REC).
// Spec v2: spec/modules/eog_unpack.md, conventions.md sections 1, 2, 4 and 6.
//
// Micro-architecture (two record buffers, no combinational ready):
//   * Assembly buffer `asm` (6 x 64-bit slots) collects the beats of the current record; slot j = beat j.
//     Slots not yet written are always 0, so a record cut short by an early s_last has its missing bytes = 0.
//   * Output register `od` presents a finished record on bus U.
//   * The beat that completes a record (beat 5, or an earlier beat with s_last) is merged with `asm` and goes
//     straight into `od` in the same cycle if `od` is free or transferring (`!ov || out_ready`). Otherwise the
//     finished record parks in `asm` (`afull = 1`) and moves to `od` the cycle the old output transfers.
//   * s_ready = !afull (a register). With out_ready = 1 the park never happens, so a beat is accepted every
//     cycle (6 cycles per full record, 1 cycle per 1-beat framing-error record) and a record is out_valid the
//     cycle after its last beat.
//   * REC_NO = `nxt_no`, assigned when a record enters `od` (records enter `od` in completion order) and
//     incremented by 1 (mod 2^32) for each one.
//
// Ports use non-ANSI declarations so their widths can use the EOG_* constants of the included header.

module eog_unpack (
    clk, rst_n,
    s_valid, s_ready, s_data, s_last,
    out_valid, out_ready, out_data
);
    /* verilator lint_off UNUSEDPARAM */
    // Common parameter set (conventions 6); this stage has no per-facility state and uses none of them.
    parameter integer N_FAC  = 32;
    parameter integer N_WELL = 8;
    parameter integer II     = 16;
    `include "eog_defs.svh"
    /* verilator lint_on UNUSEDPARAM */

    input  logic                 clk;
    input  logic                 rst_n;
    input  logic                 s_valid;
    output logic                 s_ready;
    input  logic [63:0]          s_data;
    input  logic                 s_last;
    output logic                 out_valid;
    input  logic                 out_ready;
    output logic [EOG_BU_W-1:0]  out_data;

    localparam integer NBEAT = EOG_D_BITS / 64;                // 6 beats per record
    localparam logic [2:0] LASTB = 3'(NBEAT - 1);              // index of the last beat (5)

    // ------------------------------------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------------------------------------
    logic [EOG_D_BITS-1:0] asm;      // assembly buffer / parked finished record
    logic [2:0]            cnt;      // beats held in asm (0..5 while assembling, 1..6 while parked)
    logic                  afull;    // asm holds a finished record waiting for od
    logic                  a_last;   // IN_LAST of the parked record
    logic                  a_ferr;   // FRAME_ERR of the parked record
    logic                  ov;       // od valid
    logic [EOG_BU_W-1:0]   od;       // output register (bus U)
    logic [31:0]           nxt_no;   // REC_NO of the next record to enter od

    assign s_ready   = !afull;
    assign out_valid = ov;
    assign out_data  = od;

    // ------------------------------------------------------------------------------------------------------
    // Combinational
    // ------------------------------------------------------------------------------------------------------
    logic                  acc;      // a beat transfers this cycle
    logic                  done;     // ... and it completes a record
    logic                  o_free;   // od can be loaded this cycle
    logic                  load;     // od loads a record this cycle
    logic [EOG_D_BITS-1:0] rec_c;    // asm with the current beat merged into slot cnt
    logic                  ferr_c;   // the completing beat is early
    logic [EOG_D_BITS-1:0] src_rec;  // record loaded into od
    logic                  src_last;
    logic                  src_ferr;
    logic [EOG_BU_W-1:0]   nd;       // next od

    assign acc    = s_valid && s_ready;
    assign done   = acc && (cnt == LASTB || s_last);
    assign o_free = !ov || out_ready;
    assign load   = o_free && (afull || done);
    assign ferr_c = (cnt != LASTB);

    always_comb begin
        rec_c = asm;
        for (int j = 0; j < NBEAT; j++) begin
            if (cnt == 3'(j)) rec_c[64*j +: 64] = s_data;
        end
    end

    assign src_rec  = afull ? asm    : rec_c;
    assign src_last = afull ? a_last : s_last;
    assign src_ferr = afull ? a_ferr : ferr_c;

    always_comb begin
        nd = '0;
        nd[EOG_BU_REC_NO    +: EOG_BU_REC_NO_W]    = nxt_no;
        nd[EOG_BU_IN_LAST   +: EOG_BU_IN_LAST_W]   = src_last;
        nd[EOG_BU_FRAME_ERR +: EOG_BU_FRAME_ERR_W] = src_ferr;
        nd[EOG_BU_REC       +: EOG_BU_REC_W]       = src_rec;
    end

    // ------------------------------------------------------------------------------------------------------
    // Sequential
    // ------------------------------------------------------------------------------------------------------
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            asm    <= '0;
            cnt    <= 3'd0;
            afull  <= 1'b0;
            a_last <= 1'b0;
            a_ferr <= 1'b0;
            ov     <= 1'b0;
            od     <= '0;
            nxt_no <= 32'd0;
        end else begin
            if (ov && out_ready) ov <= 1'b0;
            if (load) begin
                ov     <= 1'b1;
                od     <= nd;
                nxt_no <= nxt_no + 32'd1;
            end

            if (afull) begin
                // parked record leaves when od frees (no beat is accepted while afull)
                if (o_free) begin
                    afull <= 1'b0;
                    asm   <= '0;
                    cnt   <= 3'd0;
                end
            end else if (acc) begin
                if (done) begin
                    if (o_free) begin
                        asm <= '0;
                        cnt <= 3'd0;
                    end else begin
                        afull  <= 1'b1;
                        asm    <= rec_c;
                        cnt    <= cnt + 3'd1;
                        a_last <= s_last;
                        a_ferr <= ferr_c;
                    end
                end else begin
                    asm <= rec_c;
                    cnt <= cnt + 3'd1;
                end
            end
        end
    end

`ifdef FORMAL
    // ------------------------------------------------------------------------------------------------------
    // Internal invariants (help k-induction; about this module's own state only)
    // ------------------------------------------------------------------------------------------------------
    always_comb begin
        if (rst_n) begin
            // beat count in range; assembling holds 0..5 beats, a parked record 1..6
            if (afull) assert (cnt >= 3'd1 && cnt <= 3'(NBEAT));
            else       assert (cnt <= LASTB);
            // a record parks only behind a presented one
            if (afull) assert (ov);
            // a parked record is early iff it has fewer than 6 beats; early implies IN_LAST
            if (afull) assert (a_ferr == (cnt != 3'(NBEAT)));
            if (afull && a_ferr) assert (a_last);
            // the presented record: FRAME_ERR implies IN_LAST
            if (ov && od[EOG_BU_FRAME_ERR]) assert (od[EOG_BU_IN_LAST]);
            if (!ov) assert (!afull);
        end
    end

    // slots not yet written are zero
    genvar fj;
    generate
        for (fj = 0; fj < NBEAT; fj = fj + 1) begin : g_fv_slot
            always_comb begin
                if (rst_n && (3'(fj) >= cnt)) assert (asm[64*fj +: 64] == 64'd0);
            end
        end
    endgenerate
`endif

endmodule
