// fv_eog_unpack.sv — formal harness for eog_unpack (Verify role, task T1.unpack.fv).
//
// Written from spec/modules/eog_unpack.md and spec/conventions.md (spec v2, FROZEN) and the port list only; the RTL
// internals are not read. Run with `bash scripts/formal.sh unpack` (formal/unpack/eog_unpack.sby).
//
// eog_unpack takes 64-bit beats, not records, so it has no conventions §7 observation ports and eog_fv_stage does
// not apply. The harness keeps its own shadow of the beat stream, built from the ports only:
//   f_beat      beats accepted into the record being filled (0..5)
//   f_formed    records completed (last beat accepted) since reset = the number of the record being filled
//   f_out_cnt   records transferred on bus U since reset
//   f_cnt/f_e*  the records completed but not yet transferred, oldest first (at most 2, see B_hold), each with
//               its beat count, s_last of its last beat and its P5 bookkeeping
// A record that completes in the same cycle it is presented (combinational pass-through) is allowed: the "head"
// below is the oldest pending record, or the one completing this cycle.
//
// Property map (labels in the sby log):
//   P1   u_out.ax_reset / ax_hold / ax_data (eog_fv_axis on bus U) + P1_ghost (no output without a completed,
//        not yet transferred record)
//   P2   P2_recno: every presented record carries REC_NO == records already transferred (32 bits, wraps), so
//        consecutive outputs differ by exactly 1 and the first after reset is 0
//   P3   P3_byte: one arbitrary beat (anyconst record number f_trk_rec, beat position f_trk_j, value f_trk_val)
//        lands at REC[64j+63:64j] of that record; if the record ended before beat j, that slot is 0
//   P4   P4_fe, P4_last: FRAME_ERR = 1 iff the record ended (s_last) before its 6th beat; IN_LAST = s_last of its
//        last beat. With P1_ghost, P2, P3 and P5 this pins the grouping: a record ends after exactly 6 beats or
//        at an earlier s_last, never elsewhere.
//   P5   P5_lat0 / P5_lat1: with out_ready = 1 in its last-beat cycle and the 2 cycles after, a record is out_valid
//        by the 2nd cycle after its last beat. P5_rdy: with out_ready = 1 in two consecutive cycles, s_ready is
//        not 0 in both.
//   B_hold  (Behavior bullet 4) at most 2 records held: completed-not-transferred + a partial one <= 2
//   B_rate  (Behavior bullet 4) "accept a beat every cycle while out_ready = 1": out_ready = 1 in the current
//           and the two previous cycles (no reset) -> s_ready = 1. (Back-pressure recovery may cost one cycle; P5_rdy
//           bounds it.)
//   Stage contract: handshake = P1 (+ u_in assumptions); one-in-one-out-in-order = P1_ghost + P2 + P5_lat;
//   II <= 16 and latency <= 128 are implied by P5 (II = 1 sustained, latency <= 2).
//   H_*  harness-internal consistency (true by construction; they only keep k-induction away from impossible
//        shadow states).
//   Covers: C1_b2b (spec: two full records back to back, i.e. 12 beats on 12 consecutive cycles, both output),
//   C2_fe_good (spec: a framing error followed by a good record), C3_full, C4_short (sanity).
//
// Parameters: N_FAC, N_WELL and II are unused by eog_unpack (spec); they are set small anyway.
//   FAIR = 1 (the `prove` task only) adds an environment fairness envelope: s_valid is never 0 for more than GS
//   consecutive cycles and out_ready never 0 for more than GR consecutive cycles. Port-only k-induction needs it:
//   the DUT's beat position, partial record and REC_NO counter are invisible until a record leaves, so with
//   unbounded idle the induction step can start from a state where they disagree with the shadow. Under the
//   envelope every window of `depth` cycles contains enough completed and transferred records to pin them. The
//   `bmc` task has no envelope (any stall pattern, from reset) and covers what the envelope leaves out.

`default_nettype none

module fv_eog_unpack #(
    parameter integer FAIR = 0,
    parameter integer GS   = 1,
    parameter integer GR   = 2
) (
    input  logic        clk,        // top-level inputs are free: the solver drives them
    input  logic        rst_n,
    input  logic        s_valid,
    input  logic [63:0] s_data,
    input  logic        s_last,
    input  logic        out_ready,
    input  logic        trk_go      // P3: picks the tracked record (free, like an anyconst record number)
);
    `include "eog_defs.svh"

    localparam integer UW = EOG_BU_W;

    // ---------------------------------------------------------------------------------------------------------
    // DUT
    logic          s_ready;
    logic          out_valid;
    logic [UW-1:0] out_data;

    eog_unpack #(.N_FAC(2), .N_WELL(2), .II(16)) dut (
        .clk      (clk),
        .rst_n    (rst_n),
        .s_valid  (s_valid),
        .s_ready  (s_ready),
        .s_data   (s_data),
        .s_last   (s_last),
        .out_valid(out_valid),
        .out_ready(out_ready),
        .out_data (out_data)
    );

    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    // Conventions §2 on both links: assumed on the beat input, asserted on bus U (P1).
    eog_fv_axis #(.W(65), .ASSUME(1)) u_in (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(s_valid), .ready(s_ready), .data({s_last, s_data}));
    eog_fv_axis #(.W(UW), .ASSUME(0)) u_out (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(out_valid), .ready(out_ready), .data(out_data));

    // Bus U fields
    logic [31:0]  o_recno;
    logic         o_last, o_fe;
    logic [383:0] o_rec;
    assign o_recno = out_data[EOG_BU_REC_NO +: EOG_BU_REC_NO_W];
    assign o_last  = out_data[EOG_BU_IN_LAST];
    assign o_fe    = out_data[EOG_BU_FRAME_ERR];
    assign o_rec   = out_data[EOG_BU_REC +: EOG_BU_REC_W];

    logic in_fire, out_fire;
    assign in_fire  = rst_n && s_valid && s_ready;
    assign out_fire = rst_n && out_valid && out_ready;

    // ---------------------------------------------------------------------------------------------------------
    // Shadow of the beat stream
    logic [2:0]  f_beat;      // beats of the record being filled
    logic [31:0] f_out_cnt;   // records transferred since reset
    logic        done;        // this cycle's beat completes a record
    logic [2:0]  c_nb;        // beat count of the completing record
    assign done = in_fire && (s_last || f_beat >= 3'd5);
    assign c_nb = f_beat + 3'd1;

    // Back-to-back run for C1: consecutive accept cycles with no early-ended record in between (saturating).
    logic [3:0] f_run;
    logic       c_b2b;
    assign c_b2b = (c_nb == 3'd6) && (f_run >= 4'd11);

    // P3 tracking: the record whose first beat is accepted while trk_go = 1 (once per reset) is the tracked
    // record; its beat at position f_trk_j (anyconst) is captured in f_tval.
    (* anyconst *) logic [2:0] f_trk_j;
    logic        f_tused;     // a record has been picked since reset
    logic        f_tp;        // the record being filled is the tracked one
    logic [63:0] f_tval;      // captured beat f_trk_j of the tracked record
    logic        t_start, t_cur, t_cap;
    logic [63:0] t_val;
    assign t_start = in_fire && f_beat == 3'd0 && trk_go && !f_tused;
    assign t_cur   = f_tp || t_start;
    assign t_cap   = in_fire && t_cur && f_beat == f_trk_j;
    assign t_val   = t_cap ? s_data : f_tval;

    // Pending records, oldest first. Entry layout (EW bits):
    //   [2:0] nb    beats received (1..6)          [3] last  s_last of its last beat
    //   [4]   b2b   C1 bookkeeping                 [6:5] age cycles since its last beat (1..3, saturating)
    //   [7]   rok   out_ready was 1 in every cycle from its last beat on (P5)
    //   [8]   trk   the tracked record (P3)
    localparam integer EW = 9;
    logic [1:0]    f_cnt;     // 0..2 legal; 3 = overflow (B_hold fails)
    logic [EW-1:0] f_e0, f_e1;
    logic [EW-1:0] cn;        // the completing record as an entry
    assign cn = {t_cur, out_ready, 2'd1, c_b2b, s_last, c_nb};

    function automatic logic [EW-1:0] f_aged(input logic [EW-1:0] e, input logic rdy);
        f_aged = {e[8], e[7] & rdy, (e[6:5] == 2'd3) ? 2'd3 : e[6:5] + 2'd1, e[4:0]};
    endfunction

    // Queue after this cycle's push (aged), before this cycle's pop.
    logic [EW-1:0] l0, l1, l2;
    logic [1:0]    l_n;
    always_comb begin
        l0 = '0;
        l1 = '0;
        l2 = '0;
        case (f_cnt)
            2'd0: begin
                l0  = cn;
                l_n = {1'b0, done};
            end
            2'd1: begin
                l0  = f_aged(f_e0, out_ready);
                l1  = cn;
                l_n = 2'd1 + {1'b0, done};
            end
            default: begin
                l0  = f_aged(f_e0, out_ready);
                l1  = f_aged(f_e1, out_ready);
                l2  = cn;
                l_n = 2'd2 + {1'b0, done};
            end
        endcase
    end

    // Head of the queue: the oldest pending record, or the one completing this cycle (pass-through).
    logic          h_v;
    logic [EW-1:0] h_e;
    assign h_v = (f_cnt != 2'd0) || done;
    assign h_e = (f_cnt != 2'd0) ? f_e0 : cn;

    // Previous transferred record (C2)
    logic f_have_prev, f_prev_fe;

    initial begin
        f_beat      = '0;
        f_out_cnt   = '0;
        f_tused     = 1'b0;
        f_tp        = 1'b0;
        f_cnt       = '0;
        f_run       = '0;
        f_have_prev = 1'b0;
    end

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            f_beat      <= '0;
            f_out_cnt   <= '0;
            f_tused     <= 1'b0;
            f_tp        <= 1'b0;
            f_cnt       <= '0;
            f_e0        <= '0;
            f_e1        <= '0;
            f_run       <= '0;
            f_have_prev <= 1'b0;
            f_prev_fe   <= 1'b0;
        end else begin
            if (in_fire) begin
                f_beat <= done ? 3'd0 : f_beat + 3'd1;
                f_tp   <= t_cur && !done;
            end
            if (t_start) f_tused <= 1'b1;
            if (t_cap)   f_tval  <= s_data;
            if (out_fire) begin
                f_out_cnt   <= f_out_cnt + 32'd1;
                f_have_prev <= 1'b1;
                f_prev_fe   <= (h_e[2:0] != 3'd6);
            end
            if (!in_fire || (done && c_nb != 3'd6)) f_run <= '0;
            else if (f_run != 4'd15)                f_run <= f_run + 4'd1;
            if (out_fire && l_n != 2'd0) begin
                f_e0  <= l1;
                f_e1  <= l2;
                f_cnt <= l_n - 2'd1;
            end else begin
                f_e0  <= l0;
                f_e1  <= l1;
                f_cnt <= l_n;
            end
        end
    end

    // ---------------------------------------------------------------------------------------------------------
    // P3: slot f_trk_j of bus U's REC
    always_comb assume (f_trk_j <= 3'd5);

    logic [63:0] o_slot;
    always_comb begin
        case (f_trk_j)
            3'd0:    o_slot = o_rec[63:0];
            3'd1:    o_slot = o_rec[127:64];
            3'd2:    o_slot = o_rec[191:128];
            3'd3:    o_slot = o_rec[255:192];
            3'd4:    o_slot = o_rec[319:256];
            default: o_slot = o_rec[383:320];
        endcase
    end

    // ---------------------------------------------------------------------------------------------------------
    // History for P5_rdy / B_rate
    logic p_rst, pp_rst, p_ordy, pp_ordy, p_srdy;
    initial begin
        p_rst  = 1'b0;
        pp_rst = 1'b0;
    end
    always_ff @(posedge clk) begin
        p_rst   <= rst_n;
        pp_rst  <= p_rst;
        p_ordy  <= out_ready;
        pp_ordy <= p_ordy;
        p_srdy  <= s_ready;
    end

    // ---------------------------------------------------------------------------------------------------------
    // Required properties (spec/modules/eog_unpack.md)
    always_comb begin
        if (f_past_valid && rst_n) begin
            if (out_valid) begin
                // P1: no output without input
                P1_ghost: assert (h_v);
                // P2: REC_NO = number of records already transferred (first 0, +1 each, wraps at 2^32)
                P2_recno: assert (o_recno == f_out_cnt);
                // P4: FRAME_ERR iff fewer than 6 beats; IN_LAST = s_last of the record's last beat
                P4_fe:    assert (o_fe == (h_e[2:0] != 3'd6));
                P4_last:  assert (o_last == h_e[3]);
                // P3: the tracked beat at its offset of its record; slots not received are 0
                if (h_e[8])
                    P3_byte: assert (o_slot == ((f_trk_j < h_e[2:0]) ? t_val : 64'd0));
            end

            // P5 latency: a record whose last beat was accepted with out_ready = 1 then and since is out_valid by the
            // 2nd cycle after (and, with out_ready = 1, transfers then).
            if (f_cnt != 2'd0 && f_e0[7] && f_e0[6:5] >= 2'd2) begin
                P5_lat0: assert (f_e0[6:5] == 2'd2 && (out_valid || !out_ready));
            end
            if (f_cnt >= 2'd2 && f_e1[7] && f_e1[6:5] >= 2'd2) begin
                P5_lat1: assert (f_e1[6:5] == 2'd2 && !out_ready);
            end

            // P5 ready: with out_ready = 1 in two consecutive cycles, s_ready is not low in both.
            if (p_rst && p_ordy && out_ready && !p_srdy)
                P5_rdy: assert (s_ready);

            // Behavior bullet 4: sustained one beat per cycle while out_ready = 1.
            if (p_rst && pp_rst && pp_ordy && p_ordy && out_ready)
                B_rate: assert (s_ready);

            // Behavior bullet 4: at most one record presented + one more (complete or partial) in a second buffer.
            B_hold: assert ({1'b0, f_cnt} + {2'd0, f_beat != 3'd0} <= 3'd2);
        end

        // Harness-internal consistency (true by construction)
        if (f_past_valid) begin
            H_beat:  assert (f_beat <= 3'd5);
            H_trk:   assert ({1'b0, f_tp} + {1'b0, f_cnt != 2'd0 && f_e0[8]} + {1'b0, f_cnt >= 2'd2 && f_e1[8]} <= 2'd1
                             && (!f_tp || (f_tused && f_beat != 3'd0))
                             && (!(f_cnt != 2'd0 && f_e0[8]) || f_tused) && (!(f_cnt >= 2'd2 && f_e1[8]) || f_tused));
            H_run:   assert (f_run <= 4'd15);
            if (f_cnt != 2'd0)
                H_e0: assert (f_e0[2:0] >= 3'd1 && f_e0[2:0] <= 3'd6 && (f_e0[2:0] == 3'd6 || f_e0[3])
                              && f_e0[6:5] != 2'd0 && (!f_e0[4] || f_e0[2:0] == 3'd6));
            if (f_cnt >= 2'd2)
                H_e1: assert (f_e1[2:0] >= 3'd1 && f_e1[2:0] <= 3'd6 && (f_e1[2:0] == 3'd6 || f_e1[3])
                              && f_e1[6:5] != 2'd0 && (!f_e1[4] || f_e1[2:0] == 3'd6)
                              && (f_e1[6:5] < f_e0[6:5] || f_e0[6:5] == 2'd3) && (!f_e0[7] || f_e1[7]));
        end
    end

    // ---------------------------------------------------------------------------------------------------------
    // Environment fairness envelope (prove only, see header)
    generate
        if (FAIR != 0) begin : g_fair
            logic [3:0] sv_idle, or_idle;
            initial begin
                sv_idle = '0;
                or_idle = '0;
            end
            always_ff @(posedge clk) begin
                if (!rst_n || s_valid)       sv_idle <= '0;
                else if (sv_idle != 4'd15)   sv_idle <= sv_idle + 4'd1;
                if (!rst_n || out_ready)     or_idle <= '0;
                else if (or_idle != 4'd15)   or_idle <= or_idle + 4'd1;
            end
            always_comb begin
                if (sv_idle >= GS[3:0]) assume (s_valid);
                if (or_idle >= GR[3:0]) assume (out_ready);
            end
        end
    endgenerate

    // ---------------------------------------------------------------------------------------------------------
    // Cover goals
    always_comb begin
        if (f_past_valid && rst_n) begin
            // spec: two full records back to back (12 beats on 12 consecutive cycles), the second one output
            C1_b2b:     cover (out_fire && h_e[4]);
            // spec: one framing error followed by a good record
            C2_fe_good: cover (out_fire && h_e[2:0] == 3'd6 && f_have_prev && f_prev_fe);
            // sanity: input back-pressure while a record waits; a 1-beat record (s_last on beat 0) output
            C3_full:    cover (!s_ready && s_valid && out_valid && !out_ready);
            C4_short:   cover (out_fire && h_e[2:0] == 3'd1);
        end
    end

endmodule

`default_nettype wire
