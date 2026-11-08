// tb_eog_features.sv -- golden-vector simulation of eog_features (Verify role, task T1.features.fv).
//   bash scripts/sim.sh features
//
// Written from spec/modules/eog_features.md, numerics.md §4 and conventions.md §2-§3 (spec v4) and tb/README.md.
// The DUT runs at its default parameters (N_FAC = 32, N_WELL = 8, II = 16).
//
// Cases: every `case <name>` line of tb/vectors/INDEX.txt whose features_<name>.in.hex exists (the per-module
// *_week files are git-ignored: generate them with `python model/gen_vectors.py`, see model/README.md). Each case
// uses features_<name>.{in,out,cfg}.hex and features_<name>.events.txt:
//   cfg.hex    line 0 = GLOBAL (unused: v4 eog_features has no glb input), lines 1..32 = CONFIG rows of slots 0..31
//              (cfg_row = row[cfg_fac], combinational)
//   events     `<i> cfg <slot> <row hex>`: the row changes before record i. The bench stops feeding, waits until every
//              earlier record has left the DUT, rewrites the row, then continues (a row only changes while its slot
//              is disabled, i.e. not between a record's accept and its output; conventions §5).
// Each case runs twice from a 2-cycle reset (fixed seed):
//   run 0  random in_valid gaps (and garbage on in_data while in_valid = 0), random out_ready back-pressure with
//          occasional long stalls;
//   run 1  in_valid = 1 whenever a record is pending and out_ready = 1: checks II <= 16 (never 16 consecutive
//          cycles with in_valid = out_ready = 1 and no accept) and latency <= 128 (accept to first out_valid).
// Every transfer is compared bit for bit (!==, so X fails) with the next expected bus-F word; also checked every
// cycle: out_valid = 0 right after reset, out_valid / out_data held while out_valid && !out_ready, no output
// without an accepted record, nothing left over at the end of a case.
//
// Output: one informational line per case (`ran case ...` / `skipped case ...`), then exactly one final line,
// `PASS: <n> records ...` or `FAIL: <case> run <r> record <i> field <F> expected .. got ..`.

`timescale 1ns/1ps
`default_nettype none

module tb_eog_features;
    `include "eog_defs.svh"

    localparam integer VW     = EOG_BV_W;
    localparam integer FW     = EOG_BF_W;
    localparam integer MAXN   = 32768;   // records per case (week = 30240)
    localparam integer MAXEV  = 256;
    localparam integer II_MAX = EOG_II_MAX;
    localparam integer LATMAX = 128;
    localparam integer STALL  = 20000;   // cycles without progress -> FAIL (timeout)

    logic          clk = 1'b0;
    logic          rst_n = 1'b0;
    logic          in_valid = 1'b0;
    logic          in_ready;
    logic [VW-1:0] in_data = '0;
    logic          out_valid;
    logic          out_ready = 1'b0;
    logic [FW-1:0] out_data;
    logic [4:0]    cfg_fac;
    logic [511:0]  cfg_row;

    logic [511:0] rows [0:31];
    assign cfg_row = rows[cfg_fac];

    eog_features dut (
        .clk(clk), .rst_n(rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data),
        .cfg_fac(cfg_fac), .cfg_row(cfg_row));

    always #5 clk = ~clk;

    // ---- vectors of the current case -----------------------------------------------------------------------
    logic [VW-1:0]  vin  [0:MAXN-1];
    logic [FW-1:0]  vout [0:MAXN-1];
    logic [511:0]   vcfg [0:32];
    integer         ev_idx  [0:MAXEV-1];
    integer         ev_slot [0:MAXEV-1];
    logic [511:0]   ev_row  [0:MAXEV-1];
    integer         n_rec, n_ev;

    // ---- monitor state ---------------------------------------------------------------------------------------
    logic   running = 1'b0;   // a case is in progress (checks active)
    integer mode = 0;         // 0 random, 1 full rate
    string  cname = "";
    integer cyc = 0;
    integer n_acc = 0;        // records accepted in this run
    integer n_out = 0;        // records output (and checked) in this run
    integer acc_cyc [0:MAXN-1];
    logic   failed = 1'b0;
    integer total = 0;        // transfers checked over all cases and runs
    integer max_ii = 0, max_lat = 0;
    integer ii_wait = 0;
    logic   seen_valid = 1'b0;   // out_valid already seen for record n_out (latency measured)
    logic   prev_rst = 1'b1, prev_hold = 1'b0;
    logic [FW-1:0] prev_out;
    integer last_prog = 0;    // cycle of the last accept or output

    task automatic report_mismatch(input integer i, input logic [FW-1:0] exp, input logic [FW-1:0] got);
        string f;
        logic [FW-1:0] d;
        integer lsb, w, c;
        d = exp ^ got;
        f = "?"; lsb = 0; w = FW;
        if (d[EOG_BF_REC_NO +: EOG_BF_REC_NO_W] !== '0) begin f = "REC_NO"; lsb = EOG_BF_REC_NO; w = EOG_BF_REC_NO_W; end
        else if (d[EOG_BF_IN_LAST] !== 1'b0) begin f = "IN_LAST"; lsb = EOG_BF_IN_LAST; w = 1; end
        else if (d[EOG_BF_FAC_RAW +: EOG_BF_FAC_RAW_W] !== '0) begin f = "FAC_RAW"; lsb = EOG_BF_FAC_RAW; w = EOG_BF_FAC_RAW_W; end
        else if (d[EOG_BF_FAC +: EOG_BF_FAC_W] !== '0) begin f = "FAC"; lsb = EOG_BF_FAC; w = EOG_BF_FAC_W; end
        else if (d[EOG_BF_TS +: EOG_BF_TS_W] !== '0) begin f = "TS"; lsb = EOG_BF_TS; w = EOG_BF_TS_W; end
        else if (d[EOG_BF_STATUS +: EOG_BF_STATUS_W] !== '0) begin f = "STATUS"; lsb = EOG_BF_STATUS; w = EOG_BF_STATUS_W; end
        else if (d[EOG_BF_REASON +: EOG_BF_REASON_W] !== '0) begin f = "REASON"; lsb = EOG_BF_REASON; w = EOG_BF_REASON_W; end
        else if (d[EOG_BF_SINCE_RESET +: EOG_BF_SINCE_RESET_W] !== '0) begin f = "SINCE_RESET"; lsb = EOG_BF_SINCE_RESET; w = EOG_BF_SINCE_RESET_W; end
        else if (d[EOG_BF_HIST_RESET] !== 1'b0) begin f = "HIST_RESET"; lsb = EOG_BF_HIST_RESET; w = 1; end
        else if (d[EOG_BF_FEAT0_11 +: EOG_BF_FEAT0_11_W] !== '0) begin
            for (c = 11; c >= 0; c = c - 1)
                if (d[EOG_BF_FEAT0_11 + 16*c +: 16] !== 16'd0) begin
                    f = $sformatf("FEAT0_11[ch %0d]", c); lsb = EOG_BF_FEAT0_11 + 16*c; w = 16;
                end
        end
        else if (d[EOG_BF_RULES4 +: EOG_BF_RULES4_W] !== '0) begin f = "RULES4"; lsb = EOG_BF_RULES4; w = EOG_BF_RULES4_W; end
        else if (d[EOG_BF_INFLOW +: EOG_BF_INFLOW_W] !== '0) begin f = "INFLOW"; lsb = EOG_BF_INFLOW; w = EOG_BF_INFLOW_W; end
        else if (d[EOG_BF_LEVEL +: EOG_BF_LEVEL_W] !== '0) begin f = "LEVEL"; lsb = EOG_BF_LEVEL; w = EOG_BF_LEVEL_W; end
        else if (d[EOG_BF_PUMP_RUN] !== 1'b0) begin f = "PUMP_RUN"; lsb = EOG_BF_PUMP_RUN; w = 1; end
        $display("FAIL: case %s run %0d record %0d (REC_NO %0d) field %s expected 0x%0h got 0x%0h (bus F expected %h got %h)",
                 cname, mode, i, exp[EOG_BF_REC_NO +: 32], f, (exp >> lsb) & ((343'd1 << w) - 1),
                 (got >> lsb) & ((343'd1 << w) - 1), exp, got);
    endtask

    task automatic fail_msg(input string m);
        if (!failed) $display("FAIL: case %s run %0d: %s", cname, mode, m);
        failed = 1'b1;
    endtask

    // ---- monitor (samples just before each rising edge: DUT registers update in the NBA region) --------------
    always @(posedge clk) begin
        cyc = cyc + 1;
        if (running && !failed) begin
            if (prev_rst && out_valid !== 1'b0)
                fail_msg($sformatf("out_valid = %b in the cycle after reset", out_valid));
            if (rst_n) begin
                if (prev_hold && out_valid !== 1'b1)
                    fail_msg($sformatf("out_valid dropped before the transfer (record %0d)", n_out));
                else if (prev_hold && out_data !== prev_out)
                    fail_msg($sformatf("out_data changed while out_valid && !out_ready (record %0d)", n_out));
                if (in_valid && in_ready === 1'b1) begin
                    if (n_acc < MAXN) acc_cyc[n_acc] = cyc;
                    n_acc = n_acc + 1;
                    last_prog = cyc;
                end
                if (out_valid === 1'b1 && !seen_valid) begin
                    seen_valid = 1'b1;
                    if (n_out < n_acc) begin
                        if (mode == 1 && cyc - acc_cyc[n_out] > max_lat) max_lat = cyc - acc_cyc[n_out];
                        if (mode == 1 && cyc - acc_cyc[n_out] > LATMAX)
                            fail_msg($sformatf("record %0d: latency %0d > %0d cycles", n_out, cyc - acc_cyc[n_out], LATMAX));
                    end
                end
                if (out_valid === 1'b1 && out_ready) begin
                    if (n_out >= n_acc) fail_msg($sformatf("output %0d without an accepted record", n_out));
                    else if (n_out >= n_rec) fail_msg($sformatf("extra output %0d (case has %0d records)", n_out, n_rec));
                    else if (out_data !== vout[n_out]) begin
                        report_mismatch(n_out, vout[n_out], out_data);
                        failed = 1'b1;
                    end
                    n_out = n_out + 1;
                    total = total + 1;
                    seen_valid = 1'b0;
                    last_prog = cyc;
                end else if (out_valid !== 1'b0 && out_valid !== 1'b1) begin
                    fail_msg("out_valid is X/Z");
                end
                // II: consecutive cycles with in_valid = out_ready = 1 and no accept (full-rate run)
                if (mode == 1) begin
                    if (in_valid && out_ready && in_ready !== 1'b1) begin
                        ii_wait = ii_wait + 1;
                        if (ii_wait > max_ii) max_ii = ii_wait;
                        if (ii_wait >= II_MAX) fail_msg($sformatf("no accept for %0d cycles with in_valid = out_ready = 1", ii_wait));
                    end else ii_wait = 0;
                end
                prev_hold = (out_valid === 1'b1) && !out_ready;
                prev_out  = out_data;
            end else begin
                prev_hold = 1'b0;
            end
            prev_rst = !rst_n;
        end
    end

    // ---- stimulus --------------------------------------------------------------------------------------------
    integer seed = 32'h0FEA_2026;
    integer stall_left = 0;

    function automatic logic [VW-1:0] garbage();
        logic [VW-1:0] g;
        for (int k = 0; k < (VW + 31) / 32; k++) g[k*32 +: 32] = $random(seed);
        return g;
    endfunction

    // out_ready for the next cycle
    always @(negedge clk) begin
        if (mode == 1) out_ready <= 1'b1;
        else if (stall_left > 0) begin
            stall_left = stall_left - 1;
            out_ready <= 1'b0;
        end else if (($unsigned($random(seed)) % 200) == 0) begin
            stall_left = 5 + $unsigned($random(seed)) % 40;    // long back-pressure
            out_ready <= 1'b0;
        end else out_ready <= (($unsigned($random(seed)) % 10) >= 3);
    end

    integer fd, r, i, n_lines;
    string  line, w1, w2, path, kind;

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

    // returns 1 if the case ran (vectors present)
    task automatic load_case(input string nm, output integer ok);
        integer nc, ne, f, idx, slot, rr;
        string  base, k;
        logic [511:0] row;
        ok   = 0;
        base = {"tb/vectors/features_", nm};
        n_rec = count_lines({base, ".in.hex"});
        if (n_rec < 0) return;
        nc = count_lines({base, ".out.hex"});
        if (nc != n_rec) begin
            $display("FAIL: case %s: %0d input records but %0d expected outputs", nm, n_rec, nc);
            failed = 1'b1;
            return;
        end
        if (n_rec > MAXN) begin
            $display("FAIL: case %s: %0d records > MAXN = %0d", nm, n_rec, MAXN);
            failed = 1'b1;
            return;
        end
        if (count_lines({base, ".cfg.hex"}) != 33) begin
            $display("FAIL: case %s: cfg.hex missing or not 33 lines", nm);
            failed = 1'b1;
            return;
        end
        $readmemh({base, ".in.hex"}, vin, 0, n_rec - 1);
        $readmemh({base, ".out.hex"}, vout, 0, n_rec - 1);
        $readmemh({base, ".cfg.hex"}, vcfg, 0, 32);
        n_ev = 0;
        f = $fopen({base, ".events.txt"}, "r");
        if (f != 0) begin
            while (!$feof(f)) begin
                rr = $fscanf(f, "%d %s %d %h\n", idx, k, slot, row);
                if (rr == 4) begin
                    if (k != "cfg") begin
                        $display("FAIL: case %s: unexpected event '%s' for eog_features", nm, k);
                        failed = 1'b1;
                    end else if (n_ev < MAXEV) begin
                        ev_idx[n_ev] = idx; ev_slot[n_ev] = slot; ev_row[n_ev] = row;
                        n_ev = n_ev + 1;
                    end
                end else if (rr > 0) begin
                    $display("FAIL: case %s: malformed events line", nm);
                    failed = 1'b1;
                end else break;
            end
            $fclose(f);
        end
        ok = 1;
    endtask

    // one run of the loaded case
    task automatic run(input integer md);
        integer idx, ev, t0;
        logic   fired;
        mode = md;
        // configuration at the start of the case
        for (int s = 0; s < 32; s++) rows[s] = vcfg[s + 1];
        // reset (2 cycles, as eog_top's soft reset)
        @(negedge clk);
        rst_n = 1'b0; in_valid = 1'b0; in_data = garbage();
        n_acc = 0; n_out = 0; ii_wait = 0; seen_valid = 1'b0; stall_left = 0;
        running = 1'b1;
        @(negedge clk);
        @(negedge clk);
        rst_n = 1'b1;
        last_prog = cyc;
        idx = 0;
        ev = 0;
        while ((idx < n_rec || n_out < n_rec) && !failed) begin
            // the record presented in this cycle (if any) is accepted at the next rising edge
            if (!in_valid && idx < n_rec) begin
                if (ev < n_ev && ev_idx[ev] <= idx) begin
                    // CONFIG change before record idx: drain first
                    in_data = garbage();
                    if (n_out == idx) begin
                        while (ev < n_ev && ev_idx[ev] <= idx) begin
                            rows[ev_slot[ev]] = ev_row[ev];
                            ev = ev + 1;
                        end
                    end
                end else if (md == 0 && ($unsigned($random(seed)) % 10) < 3) begin
                    in_data = garbage();
                end else begin
                    in_valid = 1'b1;
                    in_data  = vin[idx];
                end
            end
            @(posedge clk);
            fired = in_valid && (in_ready === 1'b1);
            @(negedge clk);
            if (fired) begin
                idx = idx + 1;
                in_valid = 1'b0;
                in_data = garbage();
            end
            if (cyc - last_prog > STALL) fail_msg($sformatf("timeout: no progress for %0d cycles (accepted %0d, output %0d of %0d)",
                                                            STALL, n_acc, n_out, n_rec));
        end
        // a few idle cycles: nothing else may come out
        in_valid = 1'b0;
        for (t0 = 0; t0 < 40 && !failed; t0++) @(negedge clk);
        if (!failed && (n_out != n_rec || n_acc != n_rec))
            fail_msg($sformatf("accepted %0d, output %0d, expected %0d", n_acc, n_out, n_rec));
        running = 1'b0;
    endtask

    integer ok, n_cases;
    string  ran;

    initial begin
        n_cases = 0;
        ran = "";
        for (int s = 0; s < 32; s++) rows[s] = '0;
        fd = $fopen("tb/vectors/INDEX.txt", "r");
        if (fd == 0) begin
            $display("FAIL: tb/vectors/INDEX.txt not found (run from FPGA/)");
            $finish;
        end
        while (!failed && $fgets(line, fd) > 0) begin
            r = $sscanf(line, "%s %s", w1, w2);
            if (r == 2 && w1 == "case") begin
                load_case(w2, ok);
                if (failed) break;
                if (!ok) begin
                    $display("skipped case %s (no tb/vectors/features_%s.in.hex)", w2, w2);
                end else begin
                    cname = w2;
                    run(0);
                    if (!failed) run(1);
                    if (!failed) begin
                        $display("ran case %-8s %6d records, %0d CONFIG events; random gaps/back-pressure and full rate (max II wait %0d, max latency %0d)",
                                 w2, n_rec, n_ev, max_ii, max_lat);
                        n_cases = n_cases + 1;
                        if (ran.len() > 0) ran = {ran, " "};
                        ran = {ran, w2};
                    end
                end
            end
        end
        $fclose(fd);
        if (!failed) begin
            if (n_cases == 0) $display("FAIL: no features_* vectors found");
            else $display("PASS: %0d records (%0d cases x 2 runs: %s; max accept wait %0d < %0d, max latency %0d <= %0d cycles)",
                          total, n_cases, ran, max_ii, II_MAX, max_lat, LATMAX);
        end
        $finish;
    end
endmodule

`default_nettype wire
