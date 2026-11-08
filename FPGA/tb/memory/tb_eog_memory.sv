// tb_eog_memory.sv — bit-exact replay of the golden vectors for eog_memory (Verify role, task T1.memory.fv).
//   bash scripts/sim.sh memory          (runs from FPGA/, so vector paths are tb/vectors/...)
//
// Written from spec/modules/eog_memory.md, spec/numerics.md §5 and spec/conventions.md (spec v4); the expected
// outputs come from model/eog_ref.py (byte-for-byte equal to Mudit's features_int.py) through model/gen_vectors.py,
// including Mudit's golden sets g0, g1, g2, g0v0, g2v0. eog_memory reads no CONFIG, weights or mid-stream events,
// so a case is just memory_<case>.in.hex (bus F) and memory_<case>.out.hex (bus M).
//
// Cases: every `memory_<case>.in.hex` listed in tb/vectors/INDEX.txt. A case whose two files are missing is
// skipped with a NOTE (memory_week.* and memory_g1.* are git-ignored: `python model/gen_vectors.py` with $EOG_DATA
// and $EOG_ML set makes them).
// Every case starts from reset (the model runs each case from a fresh Engine), and runs three passes:
//   abort   random gaps / back-pressure for a few records, then rst_n while records are in flight (the next
//           pass must still match from record 0: reset clears every slot and anything in flight)
//   random  the whole case with random in_valid gaps and out_ready back-pressure (fixed seed; the gap/ready
//           probabilities change every 8..200 cycles, from always to rarely)
//   full    the whole case with in_valid and out_ready held at 1; also checks II <= 16 (conventions §3, not
//           counted during the first N_FAC + 8 cycles after reset, conventions §1) and latency <= 128
// Every pass checks: out_valid = 0 after reset; out_data equals the expected bus bit for bit (!==, so X fails)
// whenever out_valid = 1; outputs leave in order, one per input, none invented, none lost (a pass ends only when
// every input has been accepted and every output has transferred, then 8 idle cycles must show no extra output);
// once out_valid = 1 it stays 1 with out_data unchanged until out_ready (conventions §2).
//
// Output: per-case lines (`case ...`, `NOTE: ...`), then exactly one final line:
//   `PASS: <n> records ...` or `FAIL: case <c> pass <p> record <k> (REC_NO ..): <field> expected .. got ..`.

`timescale 1ns/1ps
`default_nettype none

module tb_eog_memory;
`include "eog_defs.svh"

    localparam integer MAXREC  = 65536;
    localparam integer SWEEP   = EOG_N_FAC + 8;   // conventions §1: in_ready may be 0 this long after reset
    localparam integer II_MAX  = EOG_II_MAX;      // conventions §3
    localparam integer LAT_MAX = 128;             // conventions §3
    localparam integer STUCK   = 4096;            // cycles without any transfer while work is pending -> hang
    localparam string  VDIR    = "tb/vectors/";

    localparam integer P_ABORT = 0, P_RANDOM = 1, P_FULL = 2;

    logic clk = 1'b0;
    always #5 clk = ~clk;

    logic                rst_n     = 1'b0;
    logic                in_valid  = 1'b0;
    logic                in_ready;
    logic [EOG_BF_W-1:0] in_data   = '0;
    logic                out_valid;
    logic                out_ready = 1'b0;
    logic [EOG_BM_W-1:0] out_data;

    // default parameters: N_FAC = 32 like the vectors
    eog_memory dut (
        .clk(clk), .rst_n(rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data));

    logic [EOG_BF_W-1:0] vin  [0:MAXREC-1];
    logic [EOG_BM_W-1:0] vout [0:MAXREC-1];
    integer              acc_cyc [0:MAXREC-1];

    integer seed;
    string  cur_case;
    string  cur_pass;

    // pass statistics
    integer st_max_ii, st_max_lat, st_bp_cycles, st_gap_cycles, st_first_acc;

    // ---------------------------------------------------------------------------------------------------------
    // Failure report (field names from eog_defs.svh offsets)
    function automatic string hx(input logic [31:0] v, input integer w);
        hx = $sformatf("0x%0h", v & ((w >= 32) ? 32'hFFFF_FFFF : ((32'd1 << w) - 1)));
    endfunction

    function automatic string field_diff(input logic [EOG_BM_W-1:0] e, input logic [EOG_BM_W-1:0] g);
        string s;
        s = "";
        if (e[EOG_BM_REC_NO +: 32] !== g[EOG_BM_REC_NO +: 32])
            s = $sformatf("REC_NO expected 0x%h got 0x%h", e[EOG_BM_REC_NO +: 32], g[EOG_BM_REC_NO +: 32]);
        else if (e[EOG_BM_IN_LAST] !== g[EOG_BM_IN_LAST])
            s = $sformatf("IN_LAST expected %b got %b", e[EOG_BM_IN_LAST], g[EOG_BM_IN_LAST]);
        else if (e[EOG_BM_FAC_RAW +: 16] !== g[EOG_BM_FAC_RAW +: 16])
            s = $sformatf("FAC_RAW expected 0x%h got 0x%h", e[EOG_BM_FAC_RAW +: 16], g[EOG_BM_FAC_RAW +: 16]);
        else if (e[EOG_BM_FAC +: 5] !== g[EOG_BM_FAC +: 5])
            s = $sformatf("FAC expected %0d got %0d", e[EOG_BM_FAC +: 5], g[EOG_BM_FAC +: 5]);
        else if (e[EOG_BM_TS +: 32] !== g[EOG_BM_TS +: 32])
            s = $sformatf("TS expected 0x%h got 0x%h", e[EOG_BM_TS +: 32], g[EOG_BM_TS +: 32]);
        else if (e[EOG_BM_STATUS +: 3] !== g[EOG_BM_STATUS +: 3])
            s = $sformatf("STATUS expected %0d got %0d", e[EOG_BM_STATUS +: 3], g[EOG_BM_STATUS +: 3]);
        else if (e[EOG_BM_REASON +: 16] !== g[EOG_BM_REASON +: 16])
            s = $sformatf("REASON expected 0x%h got 0x%h", e[EOG_BM_REASON +: 16], g[EOG_BM_REASON +: 16]);
        else if (e[EOG_BM_SINCE_RESET +: 8] !== g[EOG_BM_SINCE_RESET +: 8])
            s = $sformatf("SINCE_RESET expected %0d got %0d", e[EOG_BM_SINCE_RESET +: 8],
                          g[EOG_BM_SINCE_RESET +: 8]);
        else if (e[EOG_BM_HIST_RESET] !== g[EOG_BM_HIST_RESET])
            s = $sformatf("HIST_RESET expected %b got %b", e[EOG_BM_HIST_RESET], g[EOG_BM_HIST_RESET]);
        else begin
            for (int i = 0; i < 31; i++)
                if (s == "" && e[EOG_BM_FEAT + 16*i +: 16] !== g[EOG_BM_FEAT + 16*i +: 16])
                    s = $sformatf("FEAT[%0d] expected 0x%h (%0d) got 0x%h (%0d)", i,
                                  e[EOG_BM_FEAT + 16*i +: 16], $signed(e[EOG_BM_FEAT + 16*i +: 16]),
                                  g[EOG_BM_FEAT + 16*i +: 16], $signed(g[EOG_BM_FEAT + 16*i +: 16]));
            if (s != "") ;
            else if (e[EOG_BM_RULES4 +: 4] !== g[EOG_BM_RULES4 +: 4])
                s = $sformatf("RULES4 expected 0x%h got 0x%h", e[EOG_BM_RULES4 +: 4], g[EOG_BM_RULES4 +: 4]);
            else if (e[EOG_BM_INFLOW +: 16] !== g[EOG_BM_INFLOW +: 16])
                s = $sformatf("INFLOW expected 0x%h got 0x%h", e[EOG_BM_INFLOW +: 16], g[EOG_BM_INFLOW +: 16]);
            else if (e[EOG_BM_LEVEL +: 16] !== g[EOG_BM_LEVEL +: 16])
                s = $sformatf("LEVEL expected 0x%h got 0x%h", e[EOG_BM_LEVEL +: 16], g[EOG_BM_LEVEL +: 16]);
            else
                s = "unnamed bits differ";
        end
        field_diff = s;
    endfunction

    function automatic string in_ctx(input logic [EOG_BF_W-1:0] d);
        in_ctx = $sformatf("input: STATUS %0d FAC %0d HIST_RESET %b PUMP_RUN %b SINCE_RESET %0d",
                           d[EOG_BF_STATUS +: 3], d[EOG_BF_FAC +: 5], d[EOG_BF_HIST_RESET], d[EOG_BF_PUMP_RUN],
                           d[EOG_BF_SINCE_RESET +: 8]);
    endfunction

    task automatic fail(input string msg);
        $display("FAIL: case %s pass %s: %s", cur_case, cur_pass, msg);
        $finish;
    endtask

    // ---------------------------------------------------------------------------------------------------------
    // Reset: rst_n = 0 for `cycles` cycles with in_valid = 0 (the upstream drops valid on reset, conventions §1).
    task automatic do_reset(input integer cycles);
        @(negedge clk);
        rst_n     = 1'b0;
        in_valid  = 1'b0;
        out_ready = $random(seed);
        for (int k = 0; k < cycles; k++) begin
            @(negedge clk);
            out_ready = $random(seed);
            #1;
            if (out_valid !== 1'b0) fail($sformatf("out_valid = %b during reset", out_valid));
        end
        rst_n = 1'b1;   // takes effect at the next posedge; first checked cycle below sees post-reset state
    endtask

    // ---------------------------------------------------------------------------------------------------------
    // One pass over records 0..n-1 (P_ABORT: stops after n_stop accepted records, records left in flight).
    task automatic run_pass(input integer n, input integer mode, input integer n_stop);
        integer ni;          // records accepted
        integer no;          // outputs transferred
        integer cyc;         // cycles since reset release
        integer stall;       // in_valid && !in_ready && out_ready cycles in a row (after the sweep)
        integer quiet;       // cycles without any transfer
        integer last_acc;
        integer prof_left, p_v, p_r;
        integer extra;
        logic   in_fire, out_fire, prev_hold;
        logic [EOG_BM_W-1:0] prev_od;
        string  fd;

        ni = 0; no = 0; cyc = 0; stall = 0; quiet = 0; last_acc = -1; prof_left = 0; p_v = 100; p_r = 100;
        in_fire = 1'b0; prev_hold = 1'b0; prev_od = '0;
        extra = 0;
        st_max_ii = 0; st_max_lat = 0; st_bp_cycles = 0; st_gap_cycles = 0; st_first_acc = -1;

        while (1) begin
            @(negedge clk);
            // ---- drive (stimulus changes on the falling edge) ----
            if (mode != P_FULL && prof_left == 0) begin
                case ($unsigned($random(seed)) % 6)
                    0: begin p_v = 100; p_r = 100; end
                    1: begin p_v = 80;  p_r = 60;  end
                    2: begin p_v = 40;  p_r = 90;  end
                    3: begin p_v = 95;  p_r = 25;  end
                    4: begin p_v = 15;  p_r = 50;  end
                    default: begin p_v = 60; p_r = 5; end
                endcase
                prof_left = 8 + $unsigned($random(seed)) % 193;
            end
            if (prof_left > 0) prof_left = prof_left - 1;

            if (!(in_valid && !in_fire)) begin        // previous offer taken (or none): choose a new one
                if (ni < n && !(mode == P_ABORT && ni >= n_stop) &&
                    (mode == P_FULL || ($unsigned($random(seed)) % 100) < p_v)) begin
                    in_valid = 1'b1;
                    in_data  = vin[ni];
                end else begin
                    in_valid = 1'b0;
                    in_data  = {$random(seed), $random(seed), $random(seed), $random(seed), $random(seed),
                                $random(seed), $random(seed), $random(seed), $random(seed), $random(seed),
                                $random(seed)};   // garbage while invalid (must not matter)
                end
            end
            out_ready = (mode == P_FULL) ? 1'b1 : (($unsigned($random(seed)) % 100) < p_r);
            #1;

            // ---- evaluate this cycle's transfers (sampled at the next rising edge) ----
            in_fire  = in_valid && in_ready;
            out_fire = out_valid && out_ready;

            if (in_ready === 1'bx || out_valid === 1'bx || in_ready === 1'bz || out_valid === 1'bz)
                fail($sformatf("cycle %0d: in_ready = %b, out_valid = %b", cyc, in_ready, out_valid));
            if (cyc == 0 && out_valid)
                fail("out_valid = 1 in the first cycle after reset");

            // handshake rule (conventions §2): held output stays valid and unchanged
            if (prev_hold) begin
                if (!out_valid)
                    fail($sformatf("record %0d: out_valid dropped before the transfer", no));
                else if (out_data !== prev_od)
                    fail($sformatf("record %0d: out_data changed while out_valid && !out_ready (%s)", no,
                                   field_diff(prev_od, out_data)));
            end

            if (in_fire) begin
                acc_cyc[ni] = cyc;
                if (last_acc >= 0 && cyc - last_acc > st_max_ii) st_max_ii = cyc - last_acc;
                if (st_first_acc < 0) st_first_acc = cyc;
                last_acc = cyc;
                ni = ni + 1;
            end

            if (out_valid) begin
                if (no >= ni)
                    fail($sformatf("cycle %0d: out_valid with no record in flight (%0d accepted, %0d output; REC_NO 0x%h)",
                                   cyc, ni, no, out_data[EOG_BM_REC_NO +: 32]));
                if (out_data !== vout[no])
                    fail($sformatf("record %0d (REC_NO 0x%h): %s [%s]", no, vout[no][EOG_BM_REC_NO +: 32],
                                   field_diff(vout[no], out_data), in_ctx(vin[no])));
                if (mode == P_FULL) begin
                    if (cyc - acc_cyc[no] > st_max_lat) st_max_lat = cyc - acc_cyc[no];
                    if (cyc - acc_cyc[no] > LAT_MAX)
                        fail($sformatf("record %0d: latency %0d cycles > %0d", no, cyc - acc_cyc[no], LAT_MAX));
                end
            end

            if (out_valid && !out_ready) st_bp_cycles = st_bp_cycles + 1;
            if (!in_valid && ni < n) st_gap_cycles = st_gap_cycles + 1;

            // II (conventions §3): with in_valid = 1 and out_ready = 1, an accept at least every II_MAX cycles
            if (mode == P_FULL) begin
                if (in_valid && !in_ready && out_ready && cyc >= SWEEP) stall = stall + 1;
                else stall = 0;
                if (stall >= II_MAX)
                    fail($sformatf("record %0d: in_ready = 0 for %0d cycles with in_valid = out_ready = 1 (II_MAX %0d)",
                                   ni, stall, II_MAX));
            end

            prev_hold = out_valid && !out_ready;
            prev_od   = out_data;
            if (out_fire) no = no + 1;

            if (in_fire || out_fire) quiet = 0;
            else quiet = quiet + 1;
            if (quiet > STUCK)
                fail($sformatf("hang: no transfer for %0d cycles (%0d of %0d accepted, %0d output)",
                               STUCK, ni, n, no));
            cyc = cyc + 1;

            // ---- end of pass ----
            if (mode == P_ABORT && ni >= n_stop) begin
                if (extra == 0) extra = 1 + $unsigned($random(seed)) % 4;   // leave records in flight
                else if (extra == 1) break;
                else extra = extra - 1;
            end
            if (mode != P_ABORT && no >= n && ni >= n) break;
        end

        if (mode != P_ABORT) begin
            // nothing more may come out
            @(negedge clk);
            in_valid = 1'b0;
            for (int k = 0; k < 8; k++) begin
                out_ready = 1'b1;
                #1;
                if (out_valid !== 1'b0)
                    fail($sformatf("extra output after all %0d records (REC_NO 0x%h)", n,
                                   out_data[EOG_BM_REC_NO +: 32]));
                @(negedge clk);
            end
        end
    endtask

    // ---------------------------------------------------------------------------------------------------------
    // Vector files
    function automatic integer count_lines(input string path);
        integer fh, r, cnt;
        string  line;
        cnt = 0;
        fh = $fopen(path, "r");
        if (fh == 0) begin
            count_lines = -1;
        end else begin
            while (!$feof(fh)) begin
                r = $fgets(line, fh);
                if (r > 0 && line.len() > 1) cnt = cnt + 1;
            end
            $fclose(fh);
            count_lines = cnt;
        end
    endfunction

    // input-side statistics of a case: status mix, resets, running records, longest non-running stretch
    integer cs_valid, cs_held, cs_inv, cs_drop, cs_hr, cs_invhr, cs_run, cs_oob, cs_nsr64, cs_since64, cs_max_nsr;
    task automatic case_stats(input integer n);
        integer nsr [0:31];
        logic [2:0] st;
        logic [4:0] f;
        cs_valid = 0; cs_held = 0; cs_inv = 0; cs_drop = 0; cs_hr = 0; cs_invhr = 0; cs_run = 0; cs_oob = 0;
        cs_nsr64 = 0; cs_since64 = 0; cs_max_nsr = 0;
        for (int s = 0; s < 32; s++) nsr[s] = 0;
        for (int k = 0; k < n; k++) begin
            st = vin[k][EOG_BF_STATUS +: 3];
            f  = vin[k][EOG_BF_FAC +: 5];
            case (st)
                EOG_ST_VALID:   cs_valid = cs_valid + 1;
                EOG_ST_HELD:    cs_held  = cs_held + 1;
                EOG_ST_INVALID: cs_inv   = cs_inv + 1;
                default:        cs_drop  = cs_drop + 1;
            endcase
            // v4: HIST_RESET on any non-DROPPED record clears the slot (also INVALID, TASKS #44)
            if (st != EOG_ST_DROPPED && vin[k][EOG_BF_HIST_RESET]) begin
                cs_hr = cs_hr + 1;
                if (!(st == EOG_ST_VALID || st == EOG_ST_HELD)) cs_invhr = cs_invhr + 1;
                nsr[f] = 0;
            end
            if (st == EOG_ST_VALID || st == EOG_ST_HELD) begin
                if (f >= EOG_N_FAC) cs_oob = cs_oob + 1;
                if (vin[k][EOG_BF_PUMP_RUN]) begin cs_run = cs_run + 1; nsr[f] = 0; end
                else nsr[f] = nsr[f] + 1;
                if (nsr[f] > cs_max_nsr) cs_max_nsr = nsr[f];
                if (vout[k][EOG_BM_FEAT + 16*28 +: 16] == 16'd16384) cs_nsr64 = cs_nsr64 + 1;
                if (vout[k][EOG_BM_FEAT + 16*30 +: 16] == 16'd16384) cs_since64 = cs_since64 + 1;
            end
        end
    endtask

    // ---------------------------------------------------------------------------------------------------------
    string  names [$];
    integer total, ncases, nskip;

    initial begin : main
        integer fh, r, nl, n, n_in, n_out, ci;
        string  line, tok, cs, f_in, f_out, skipped;

        seed  = 32'h4D45_4D30;   // "MEM0"
        total = 0; ncases = 0; nskip = 0; skipped = "";

        // case list: every memory_<case>.in.hex in INDEX.txt
        fh = $fopen({VDIR, "INDEX.txt"}, "r");
        if (fh == 0) begin
            $display("FAIL: cannot open %sINDEX.txt (run from FPGA/: bash scripts/sim.sh memory)", VDIR);
            $finish;
        end
        while (!$feof(fh)) begin
            r = $fgets(line, fh);
            if (r <= 0) break;
            r = $sscanf(line, "%s %d", tok, nl);
            if (r == 2 && tok.len() > 14 && tok.substr(0, 6) == "memory_" &&
                tok.substr(tok.len() - 7, tok.len() - 1) == ".in.hex")
                names.push_back(tok.substr(7, tok.len() - 8));
        end
        $fclose(fh);

        rst_n = 1'b0;
        repeat (2) @(negedge clk);

        for (ci = 0; ci < names.size(); ci++) begin
            cs       = names[ci];
            cur_case = cs;
            cur_pass = "load";
            f_in     = {VDIR, "memory_", cs, ".in.hex"};
            f_out    = {VDIR, "memory_", cs, ".out.hex"};
            n_in     = count_lines(f_in);
            n_out    = count_lines(f_out);
            if (n_in < 0 || n_out < 0) begin
                $display("NOTE: skipping case %s: %s%s missing (regenerate: python model/gen_vectors.py)", cs,
                         (n_in < 0) ? f_in : f_out, (n_in < 0 && n_out < 0) ? " and .out.hex" : "");
                nskip   = nskip + 1;
                skipped = {skipped, " ", cs};
                continue;
            end
            if (n_in != n_out) fail($sformatf("%0d input lines but %0d output lines", n_in, n_out));
            if (n_in == 0 || n_in > MAXREC) fail($sformatf("%0d records (1..%0d supported)", n_in, MAXREC));
            n = n_in;
            $readmemh(f_in, vin, 0, n - 1);
            $readmemh(f_out, vout, 0, n - 1);
            for (int k = 0; k < n; k++)
                if ((^vin[k]) === 1'bx || (^vout[k]) === 1'bx)
                    fail($sformatf("vector line %0d has X/Z after $readmemh", k));
            case_stats(n);

            cur_pass = "abort";
            do_reset(3);
            run_pass(n, P_ABORT, 1 + $unsigned($random(seed)) % ((n < 24) ? n : 24));

            cur_pass = "random";
            do_reset(2);
            run_pass(n, P_RANDOM, 0);

            cur_pass = "full";
            do_reset(1);
            run_pass(n, P_FULL, 0);

            $display("case %-8s %6d records OK (abort/random/full) | VALID %0d HELD %0d INVALID %0d DROPPED %0d, HIST_RESET %0d (on INVALID %0d), running %0d, FAC>=N_FAC %0d | longest non-running run %0d, FEAT28=16384 x%0d, FEAT30=16384 x%0d | full pass: first accept at cycle %0d, max II %0d, max latency %0d",
                     cs, n, cs_valid, cs_held, cs_inv, cs_drop, cs_hr, cs_invhr, cs_run, cs_oob, cs_max_nsr, cs_nsr64,
                     cs_since64, st_first_acc, st_max_ii, st_max_lat);
            total  = total + n;
            ncases = ncases + 1;
        end

        if (ncases == 0) begin
            $display("FAIL: no memory_* vector case found (INDEX lists %0d, %0d skipped)", names.size(), nskip);
        end else begin
            $display("PASS: %0d records (%0d cases x 3 passes: abort, random gaps/back-pressure, full rate with II <= %0d and latency <= %0d)%s",
                     total, ncases, II_MAX, LAT_MAX,
                     (nskip == 0) ? "" : $sformatf("; skipped %0d case(s) with missing files:%s", nskip, skipped));
        end
        $finish;
    end

    // safety net
    initial begin
        #2_000_000_000;
        $display("FAIL: global timeout");
        $finish;
    end
endmodule

`default_nettype wire
