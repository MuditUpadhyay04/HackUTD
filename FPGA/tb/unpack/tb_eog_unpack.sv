// tb_eog_unpack.sv -- golden-vector simulation of eog_unpack (Verify role, task T1.unpack.fv).
//   bash scripts/sim.sh unpack
//
// Written from spec/modules/eog_unpack.md and conventions.md §2 (spec v2) and tb/README.md. The DUT runs at its
// default parameters (N_FAC, N_WELL and II are unused by eog_unpack).
//
// Cases: every `case <name>` line of tb/vectors/INDEX.txt whose unpack_<name>.in.hex and .out.hex exist (the
// per-module *_week files are git-ignored: generate them with `python model/gen_vectors.py`, see model/README.md).
//   unpack_<name>.in.hex   one beat per line, {s_last, s_data[63:0]}
//   unpack_<name>.out.hex  bus U (EOG_BU_W bits) per emitted record, in order
// Each case runs three times. Before each run the DUT gets a few random beats (a partial record, sometimes a
// complete one) and then a 2-cycle reset, so every run also checks that reset clears the partial record and REC_NO.
//   run 0  random s_valid gaps (random garbage on s_data / s_last while s_valid = 0), random out_ready with
//          occasional long stalls;
//   run 1  full rate: s_valid = 1 while beats remain, out_ready = 1: every beat accepted on consecutive cycles and
//          every record out_valid within 2 cycles of its last beat (spec "Behavior" bullet 4, P5);
//   run 2  s_valid = 1 while beats remain, heavy random back-pressure (fills the DUT's buffers).
// Checked every cycle in every run (sampled just before each rising edge):
//   - out_valid = 0 in the cycle after reset; out_valid / out_data held while out_valid && !out_ready (§2);
//   - every bus-U transfer equals the next .out.hex line bit for bit (!==, so X fails);
//   - no out_valid without a completed, not yet transferred record (record ends are computed here from the beat
//     stream: 6 beats or an earlier s_last), nothing extra at the end of a case;
//   - P5: a record whose last beat was accepted with out_ready = 1 then and in the next 2 cycles is out_valid by
//     the 2nd cycle; with out_ready = 1 in two consecutive cycles s_ready is not 0 in both; with out_ready = 1 in
//     three consecutive cycles s_ready = 1 (one beat per cycle sustained).
//
// Output: one informational line per case (`ran case ...` / `skipped case ...`), then exactly one final line,
// `PASS: <n> records ...` or `FAIL: case <c> run <r> record <i> field <F> expected .. got ..`.

`timescale 1ns/1ps
`default_nettype none

module tb_eog_unpack;
    `include "eog_defs.svh"

    localparam integer UW    = EOG_BU_W;
    localparam integer MAXB  = 196608;   // beats per case (week = 181440)
    localparam integer MAXR  = 32768;    // records per case (week = 30240)
    localparam integer STALL = 2000;     // cycles without any transfer while work remains -> FAIL

    logic          clk = 1'b0;
    logic          rst_n = 1'b0;
    logic          s_valid = 1'b0;
    logic          s_ready;
    logic [63:0]   s_data = '0;
    logic          s_last = 1'b0;
    logic          out_valid;
    logic          out_ready = 1'b0;
    logic [UW-1:0] out_data;

    eog_unpack dut (
        .clk(clk), .rst_n(rst_n),
        .s_valid(s_valid), .s_ready(s_ready), .s_data(s_data), .s_last(s_last),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data));

    always #5 clk = ~clk;

    // ---- vectors of the current case -----------------------------------------------------------------------
    logic [64:0]   vin  [0:MAXB-1];
    logic [UW-1:0] vout [0:MAXR-1];
    integer        n_beat, n_rec;

    // ---- monitor state ---------------------------------------------------------------------------------------
    logic   running = 1'b0;   // checks active
    integer mode = 0;
    string  cname = "";
    integer cyc = 0;
    integer bi = 0;           // beats accepted in this run
    integer tb_beat = 0;      // beats of the record being filled (shadow)
    integer n_formed = 0;     // records completed by the beat stream
    integer n_out = 0;        // records transferred (and checked)
    integer done_cyc [0:MAXR-1];
    logic   failed = 1'b0;
    logic   fired_in = 1'b0;  // the beat on s_data was accepted at the last rising edge
    logic   prev_rst = 1'b0, pprev_rst = 1'b0, prev_hold = 1'b0;
    logic   prev_ordy = 1'b0, pprev_ordy = 1'b0, prev_srdy = 1'b1;
    logic [UW-1:0] prev_out;
    integer last_ordy0 = 0;   // last cycle with out_ready = 0
    integer last_prog = 0;    // last cycle with a transfer
    integer first_beat_cyc = 0, last_out_cyc = 0;

    // statistics over all cases and runs
    integer total = 0, total_fe = 0, total_beats = 0, n_srdy_low = 0, n_hold = 0, max_lat1 = 0, n_cases = 0;
    integer max_extra1 = 0;   // run 1: cycles beyond one per beat

    // ---- messages --------------------------------------------------------------------------------------------
    task automatic fail_msg(input string m);
        if (!failed) $display("FAIL: case %s run %0d: %s", cname, mode, m);
        failed = 1'b1;
    endtask

    function automatic string dfield(input integer bit_i);
        if      (bit_i < EOG_D_RSV0)       dfield = "FAC_ID";
        else if (bit_i < EOG_D_TS)         dfield = "RSV0";
        else if (bit_i < EOG_D_PRESENT)    dfield = "TS";
        else if (bit_i < EOG_D_INFLOW)     dfield = "PRESENT";
        else if (bit_i < EOG_D_LEVEL)      dfield = "INFLOW";
        else if (bit_i < EOG_D_PUMP_FLOW)  dfield = "LEVEL";
        else if (bit_i < EOG_D_RECV_FLOW)  dfield = "PUMP_FLOW";
        else if (bit_i < EOG_D_DIS_PSI)    dfield = "RECV_FLOW";
        else if (bit_i < EOG_D_PIPE_PSI)   dfield = "DIS_PSI";
        else if (bit_i < EOG_D_PUMP_ST)    dfield = "PIPE_PSI";
        else if (bit_i < EOG_D_RSV1)       dfield = "PUMP_ST";
        else if (bit_i < EOG_D_WELL_ST)    dfield = "RSV1";
        else if (bit_i < EOG_D_WELL_WATER) dfield = "WELL_ST";
        else if (bit_i < EOG_D_RSV2)       dfield = "WELL_WATER";
        else                               dfield = "RSV2";
    endfunction

    task automatic report_mismatch(input integer i, input logic [UW-1:0] exp, input logic [UW-1:0] got);
        logic [UW-1:0] d;
        integer k, j;
        string f;
        logic [63:0] e, g;
        d = exp ^ got;
        if (d[EOG_BU_REC_NO +: EOG_BU_REC_NO_W] !== '0) begin
            f = "REC_NO";
            e = 64'(exp[EOG_BU_REC_NO +: EOG_BU_REC_NO_W]); g = 64'(got[EOG_BU_REC_NO +: EOG_BU_REC_NO_W]);
        end else if (d[EOG_BU_IN_LAST] !== 1'b0) begin
            f = "IN_LAST"; e = 64'(exp[EOG_BU_IN_LAST]); g = 64'(got[EOG_BU_IN_LAST]);
        end else if (d[EOG_BU_FRAME_ERR] !== 1'b0) begin
            f = "FRAME_ERR"; e = 64'(exp[EOG_BU_FRAME_ERR]); g = 64'(got[EOG_BU_FRAME_ERR]);
        end else begin
            k = -1;
            for (j = EOG_BU_REC_W / 8 - 1; j >= 0; j = j - 1)
                if (d[EOG_BU_REC + 8*j +: 8] !== 8'd0) k = j;
            if (k < 0) k = 0;
            f = $sformatf("REC byte %0d (beat %0d, %s)", k, k / 8, dfield(8*k));
            e = 64'(exp[EOG_BU_REC + 64*(k/8) +: 64]); g = 64'(got[EOG_BU_REC + 64*(k/8) +: 64]);
        end
        if (!failed)
            $display("FAIL: case %s run %0d record %0d field %s expected 0x%0h got 0x%0h (bus U expected %h got %h)",
                     cname, mode, i, f, e, g, exp, got);
        failed = 1'b1;
    endtask

    // ---- monitor (samples just before each rising edge: DUT registers update in the NBA region) --------------
    always @(posedge clk) begin
        logic in_fire, out_fire, dn;
        integer m;
        cyc = cyc + 1;
        in_fire  = rst_n && s_valid && (s_ready === 1'b1);
        out_fire = rst_n && (out_valid === 1'b1) && out_ready;
        fired_in = in_fire;
        if (running && !failed) begin
            if (prev_rst == 1'b0 && rst_n && out_valid !== 1'b0)
                fail_msg($sformatf("out_valid = %b in the cycle after reset", out_valid));
            if (rst_n) begin
                if (s_ready !== 1'b0 && s_ready !== 1'b1) fail_msg("s_ready is X/Z");
                if (out_valid !== 1'b0 && out_valid !== 1'b1) fail_msg("out_valid is X/Z");
                if (prev_hold && out_valid !== 1'b1)
                    fail_msg($sformatf("out_valid dropped before the transfer (record %0d)", n_out));
                else if (prev_hold && out_data !== prev_out)
                    fail_msg($sformatf("out_data changed while out_valid && !out_ready (record %0d)", n_out));
                if (!out_ready) last_ordy0 = cyc;
                if (s_ready !== 1'b1) n_srdy_low = n_srdy_low + 1;
                if (out_valid === 1'b1 && !out_ready) n_hold = n_hold + 1;

                // beat stream: record ends after 6 beats or at an earlier s_last
                if (in_fire) begin
                    if (bi >= n_beat) fail_msg("beat accepted beyond the end of the case");
                    if (bi == 0) first_beat_cyc = cyc;
                    bi = bi + 1;
                    dn = s_last || tb_beat == 5;
                    if (dn) begin
                        if (n_formed < MAXR) done_cyc[n_formed] = cyc;
                        n_formed = n_formed + 1;
                        tb_beat = 0;
                    end else tb_beat = tb_beat + 1;
                    last_prog = cyc;
                end

                // P5 ready: s_ready not low in two consecutive cycles with out_ready = 1 in both
                if (prev_rst && prev_ordy && out_ready && prev_srdy !== 1'b1 && s_ready !== 1'b1)
                    fail_msg("s_ready low in two consecutive cycles with out_ready = 1 (P5)");
                // sustained rate: out_ready = 1 in this and the two previous cycles -> s_ready = 1
                if (prev_rst && pprev_rst && pprev_ordy && prev_ordy && out_ready && s_ready !== 1'b1)
                    fail_msg("s_ready = 0 after 3 cycles of out_ready = 1 (one beat per cycle sustained)");

                // no output without a completed, not yet transferred record
                if (out_valid === 1'b1 && n_out >= n_formed)
                    fail_msg($sformatf("out_valid with no completed record pending (%0d completed, %0d out)",
                                       n_formed, n_out));
                // P5 latency for the two oldest pending records
                for (m = n_out; m < n_out + 2 && m < n_formed; m = m + 1) begin
                    if (m < MAXR && last_ordy0 < done_cyc[m] && cyc - done_cyc[m] >= 2) begin
                        if (!(m == n_out && out_valid === 1'b1 && cyc - done_cyc[m] == 2))
                            fail_msg($sformatf("record %0d not out_valid 2 cycles after its last beat with out_ready = 1 (P5)", m));
                    end
                end
                if (mode == 1 && out_valid === 1'b1 && n_out < n_formed && n_out < MAXR
                    && cyc - done_cyc[n_out] > max_lat1)
                    max_lat1 = cyc - done_cyc[n_out];

                if (out_fire && !failed) begin
                    if (n_out >= n_rec) fail_msg($sformatf("extra output %0d (case has %0d records)", n_out, n_rec));
                    else if (out_data !== vout[n_out]) report_mismatch(n_out, vout[n_out], out_data);
                    else begin
                        total = total + 1;
                        if (out_data[EOG_BU_FRAME_ERR]) total_fe = total_fe + 1;
                    end
                    n_out = n_out + 1;
                    last_prog = cyc;
                    last_out_cyc = cyc;
                end
                if (cyc - last_prog > STALL && (bi < n_beat || n_out < n_formed))
                    fail_msg($sformatf("no progress for %0d cycles (%0d/%0d beats, %0d/%0d records out)", STALL, bi,
                                       n_beat, n_out, n_rec));
            end
        end
        pprev_rst  = prev_rst;
        prev_rst   = rst_n;
        pprev_ordy = prev_ordy;
        prev_ordy  = out_ready;
        prev_srdy  = s_ready;
        prev_hold  = rst_n && (out_valid === 1'b1) && !out_ready;
        prev_out   = out_data;
    end

    // ---- stimulus (changes on the falling edge) --------------------------------------------------------------
    integer seed = 32'h0E06_2026;
    integer stall = 0;

    function automatic integer urand(input integer n);
        urand = $unsigned($random(seed)) % n;
    endfunction

    task automatic garbage_in();
        s_data = {$random(seed), $random(seed)};
        s_last = $random(seed);
    endtask

    // one cycle of the driver: hold an unaccepted beat, else maybe present the next one
    task automatic drive_cycle();
        logic want;
        @(negedge clk);
        if (s_valid && !fired_in) begin
            // hold (conventions §2): unchanged until accepted
        end else begin
            case (mode)
                0:       want = urand(10) < 7;
                default: want = 1'b1;
            endcase
            if (want && bi < n_beat) begin
                s_valid = 1'b1;
                {s_last, s_data} = vin[bi];
            end else begin
                s_valid = 1'b0;
                garbage_in();
            end
        end
        case (mode)
            0: begin
                if (stall > 0) begin out_ready = 1'b0; stall = stall - 1; end
                else if (urand(64) == 0) begin out_ready = 1'b0; stall = 5 + urand(36); end
                else out_ready = urand(10) < 7;
            end
            1: out_ready = 1'b1;
            default: begin
                if (stall > 0) begin out_ready = 1'b0; stall = stall - 1; end
                else if (urand(16) == 0) begin out_ready = 1'b0; stall = 2 + urand(29); end
                else out_ready = urand(2);
            end
        endcase
    endtask

    // random beats before the reset (must be forgotten by the reset)
    task automatic pre_garbage();
        integer k, nb;
        nb = 1 + urand(9);
        for (k = 0; k < nb; k = k + 1) begin
            @(negedge clk);
            s_valid   = urand(4) != 0;
            garbage_in();
            s_last    = urand(8) == 0;
            out_ready = urand(2);
        end
        @(negedge clk);
        s_valid   = 1'b0;
        garbage_in();
    endtask

    task automatic run_case(input integer md);
        integer k;
        mode = md;
        bi = 0; tb_beat = 0; n_formed = 0; n_out = 0; stall = 0;
        // DUT state before the reset is arbitrary: random beats, then a 2-cycle reset
        running = 1'b0;
        rst_n = 1'b1;
        pre_garbage();
        rst_n = 1'b0;
        out_ready = urand(2);
        @(negedge clk);
        @(negedge clk);
        running   = 1'b1;
        last_prog = cyc;
        last_ordy0 = cyc;
        rst_n     = 1'b1;
        s_valid   = 1'b0;     // conventions: valid is 0 in the cycle after reset
        out_ready = (md == 1) ? 1'b1 : urand(2);
        while (!failed && (bi < n_beat || n_out < n_formed || n_formed < n_rec)) begin
            drive_cycle();
            if (cyc - last_prog > STALL + 10) begin
                fail_msg("timeout");
            end
        end
        // drain: nothing more may come out
        for (k = 0; k < 8 && !failed; k = k + 1) begin
            @(negedge clk);
            s_valid = 1'b0;
            garbage_in();
            out_ready = 1'b1;
        end
        @(negedge clk);
        if (!failed && n_formed != n_rec)
            fail_msg($sformatf("vector mismatch: the beat stream ends %0d records, out.hex has %0d", n_formed, n_rec));
        if (!failed && n_out != n_rec)
            fail_msg($sformatf("%0d of %0d records output", n_out, n_rec));
        if (!failed && md == 1 && n_rec > 0 && last_out_cyc - first_beat_cyc - n_beat > max_extra1)
            max_extra1 = last_out_cyc - first_beat_cyc - n_beat;
        running = 1'b0;
    endtask

    // ---- case list -------------------------------------------------------------------------------------------
    function automatic integer count_lines(input string p);
        integer f, k;
        string  l;
        f = $fopen(p, "r");
        if (f == 0) return -1;
        k = 0;
        while ($fgets(l, f) > 0) if (l.len() > 1) k = k + 1;
        $fclose(f);
        return k;
    endfunction

    string  line, w1, w2, base, ran;
    integer fd, r, ni, no, md;

    initial begin
        ran = "";
        fd = $fopen("tb/vectors/INDEX.txt", "r");
        if (fd == 0) begin
            $display("FAIL: tb/vectors/INDEX.txt not found (run from FPGA/)");
            $finish;
        end
        while (!failed && $fgets(line, fd) > 0) begin
            w1 = ""; w2 = "";
            r = $sscanf(line, "%s %s", w1, w2);
            if (r == 2 && w1 == "case") begin
                cname = w2;
                base  = {"tb/vectors/unpack_", w2};
                ni = count_lines({base, ".in.hex"});
                no = count_lines({base, ".out.hex"});
                if (ni < 0 || no < 0) begin
                    $display("skipped case %s: %s.in.hex or .out.hex missing (generate with model/gen_vectors.py)",
                             w2, base);
                end else if (ni > MAXB || no > MAXR) begin
                    $display("FAIL: case %s too large for the bench (%0d beats, %0d records)", w2, ni, no);
                    failed = 1'b1;
                end else begin
                    n_beat = ni;
                    n_rec  = no;
                    if (ni > 0) $readmemh({base, ".in.hex"}, vin, 0, ni - 1);
                    if (no > 0) $readmemh({base, ".out.hex"}, vout, 0, no - 1);
                    for (md = 0; md < 3 && !failed; md = md + 1) run_case(md);
                    if (!failed) begin
                        $display("ran case %s: %0d beats, %0d records, 3 runs", w2, ni, no);
                        ran = {ran, " ", w2};
                        n_cases = n_cases + 1;
                        total_beats = total_beats + 3 * ni;
                    end
                end
            end
        end
        $fclose(fd);
        if (!failed && n_cases == 0) begin
            $display("FAIL: no case ran (no tb/vectors/unpack_*.hex)");
            failed = 1'b1;
        end
        if (!failed && (n_srdy_low == 0 || n_hold == 0 || total_fe == 0)) begin
            $display("FAIL: coverage hole (s_ready-low cycles %0d, held outputs %0d, FRAME_ERR records %0d)",
                     n_srdy_low, n_hold, total_fe);
            failed = 1'b1;
        end
        if (!failed)
            $display("PASS: %0d records (%0d with FRAME_ERR), %0d beats, %0d cases x 3 runs:%s; full rate: max latency %0d cycles, %0d cycles beyond 1/beat; %0d s_ready-low cycles, %0d held outputs",
                     total, total_fe, total_beats, n_cases, ran, max_lat1, max_extra1, n_srdy_low, n_hold);
        $finish;
    end
endmodule

`default_nettype wire
