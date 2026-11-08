// tb_eog_countdown.sv — bit-exact replay of the golden vectors for eog_countdown (Verify role, task T1.countdown.fv).
//   bash scripts/sim.sh countdown          (runs from FPGA/, so vector paths are tb/vectors/...)
//
// Written from spec/modules/eog_countdown.md, spec/numerics.md §7 and spec/conventions.md (spec v4: prefilled
// 16-entry ring of signed INFLOW, mean = sum >>> 4, NOT_FILLING = mean <= 0, m(q) = q <= 0 ? 0xFFFF :
// min((K·Δ) // (q << 8), 0xFFFF)); the expected outputs come from model/eog_ref.py through model/gen_vectors.py
// (spec v4 vectors: task T0.2b; vectors generated for spec v1/v2 do not match a v4 DUT). The DUT runs at its default
// parameters (N_FAC = 32, II = 16, CD_LOG2 = 4), like the model.
//
// Files per case (tb/vectors/, listed in INDEX.txt):
//   countdown_<case>.in.hex      bus M per record (646 bits)
//   countdown_<case>.out.hex     expected bus C per record (663 bits)
//   countdown_<case>.cfg.hex     line 0 GLOBAL (unused here), lines 1..32 the CONFIG rows of slots 0..31 at start
//   countdown_<case>.events.txt  mid-stream events `<record index> cfg <slot> <row hex>`: the row of <slot> is
//                                replaced before record <index> is offered. The model applies events between
//                                records; the spec lets a stage read cfg_row at any time during a record, so the
//                                bench first waits until every earlier record has left the stage (drain), then
//                                swaps the row, then offers the record. (A `cfg` event is a CONFIG write, which
//                                also makes eog_validate start a new history; that already shows up as HIST_RESET
//                                in the input bus, so the countdown needs nothing else.) Other event kinds are not
//                                countdown events and are ignored with a NOTE.
// cfg_row = row[cfg_fac], combinational (conventions §5).
//
// Cases: every `countdown_<case>.in.hex` in INDEX.txt. A case whose in/out/cfg files are missing is skipped with a
// NOTE (countdown_week.* is git-ignored: `python model/gen_vectors.py` with EOG_DATA set makes it). `onsets` is the
// R1 check (p50 tracks the practice trips at all 13 pump-fault onsets, not 0xFFFF). Every case starts from reset
// with the case's initial CONFIG rows and runs three passes:
//   abort   random gaps / back-pressure for a few records, then rst_n while records are in flight (the next pass
//           must still match from record 0: reset clears every slot and everything in flight)
//   random  the whole case with random in_valid gaps and out_ready back-pressure (fixed seed; the gap/ready
//           probabilities change every 8..200 cycles, from always to rarely)
//   full    the whole case with in_valid and out_ready held at 1 (except while draining for an event); also
//           checks II <= 16 (conventions §3; not counted in the first N_FAC + 8 cycles after reset,
//           conventions §1) and latency <= 128
// Every pass checks: out_valid = 0 during and right after reset; out_data equals the expected bus bit for bit
// (!==, so X fails) whenever out_valid = 1; outputs leave in order, one per input, none invented, none lost (a
// pass ends only when every input was accepted and every output transferred, then 8 idle cycles must show no
// extra output); once out_valid = 1 it stays 1 with out_data unchanged until out_ready (conventions §2).
//
// Output: one `case ...` line per case run (or `NOTE: skipping ...`), then exactly one final line:
//   `PASS: <n> records ...` or `FAIL: case <c> pass <p>: record <k> (REC_NO ..): <field> expected .. got ..`.

`timescale 1ns/1ps
`default_nettype none

module tb_eog_countdown;
`include "eog_defs.svh"

    localparam integer MAXREC  = 32768;
    localparam integer MAXEV   = 4096;
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
    logic [EOG_BM_W-1:0] in_data   = '0;
    logic                out_valid;
    logic                out_ready = 1'b0;
    logic [EOG_BC_W-1:0] out_data;
    logic [4:0]          cfg_fac;
    logic [511:0]        cfg_row;

    logic [511:0] rows [0:31];                  // CONFIG table as eog_regs would hold it
    assign cfg_row = rows[cfg_fac];

    eog_countdown dut (
        .clk(clk), .rst_n(rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data),
        .cfg_fac(cfg_fac), .cfg_row(cfg_row));

    logic [EOG_BM_W-1:0] vin  [0:MAXREC-1];
    logic [EOG_BC_W-1:0] vout [0:MAXREC-1];
    logic [511:0]        vcfg [0:32];
    integer              acc_cyc [0:MAXREC-1];

    integer       n_ev;
    integer       ev_idx  [0:MAXEV-1];
    integer       ev_slot [0:MAXEV-1];
    logic [511:0] ev_row  [0:MAXEV-1];

    integer seed;
    string  cur_case;
    string  cur_pass;

    // pass statistics
    integer st_max_ii, st_max_lat, st_bp_cycles, st_gap_cycles, st_first_acc, st_ev;

    // ---------------------------------------------------------------------------------------------------------
    // Failure report (field names from eog_defs.svh offsets)
    function automatic string field_diff(input logic [EOG_BC_W-1:0] e, input logic [EOG_BC_W-1:0] g);
        string s;
        s = "";
        if (e[EOG_BC_REC_NO +: 32] !== g[EOG_BC_REC_NO +: 32])
            s = $sformatf("REC_NO expected 0x%h got 0x%h", e[EOG_BC_REC_NO +: 32], g[EOG_BC_REC_NO +: 32]);
        else if (e[EOG_BC_IN_LAST] !== g[EOG_BC_IN_LAST])
            s = $sformatf("IN_LAST expected %b got %b", e[EOG_BC_IN_LAST], g[EOG_BC_IN_LAST]);
        else if (e[EOG_BC_FAC_RAW +: 16] !== g[EOG_BC_FAC_RAW +: 16])
            s = $sformatf("FAC_RAW expected 0x%h got 0x%h", e[EOG_BC_FAC_RAW +: 16], g[EOG_BC_FAC_RAW +: 16]);
        else if (e[EOG_BC_FAC +: 5] !== g[EOG_BC_FAC +: 5])
            s = $sformatf("FAC expected %0d got %0d", e[EOG_BC_FAC +: 5], g[EOG_BC_FAC +: 5]);
        else if (e[EOG_BC_TS +: 32] !== g[EOG_BC_TS +: 32])
            s = $sformatf("TS expected 0x%h got 0x%h", e[EOG_BC_TS +: 32], g[EOG_BC_TS +: 32]);
        else if (e[EOG_BC_STATUS +: 3] !== g[EOG_BC_STATUS +: 3])
            s = $sformatf("STATUS expected %0d got %0d", e[EOG_BC_STATUS +: 3], g[EOG_BC_STATUS +: 3]);
        else if (e[EOG_BC_REASON +: 16] !== g[EOG_BC_REASON +: 16])
            s = $sformatf("REASON expected 0x%h got 0x%h", e[EOG_BC_REASON +: 16], g[EOG_BC_REASON +: 16]);
        else if (e[EOG_BC_SINCE_RESET +: 8] !== g[EOG_BC_SINCE_RESET +: 8])
            s = $sformatf("SINCE_RESET expected %0d got %0d", e[EOG_BC_SINCE_RESET +: 8],
                          g[EOG_BC_SINCE_RESET +: 8]);
        else if (e[EOG_BC_HIST_RESET] !== g[EOG_BC_HIST_RESET])
            s = $sformatf("HIST_RESET expected %b got %b", e[EOG_BC_HIST_RESET], g[EOG_BC_HIST_RESET]);
        else begin
            for (int i = 0; i < EOG_N_FEAT; i++)
                if (s == "" && e[EOG_BC_FEAT + 16*i +: 16] !== g[EOG_BC_FEAT + 16*i +: 16])
                    s = $sformatf("FEAT[%0d] expected 0x%h got 0x%h", i, e[EOG_BC_FEAT + 16*i +: 16],
                                  g[EOG_BC_FEAT + 16*i +: 16]);
            if (s != "") ;
            else if (e[EOG_BC_RULES +: 4] !== g[EOG_BC_RULES +: 4])
                s = $sformatf("RULES[3:0] expected 0x%h got 0x%h", e[EOG_BC_RULES +: 4], g[EOG_BC_RULES +: 4]);
            else if (e[EOG_BC_RULES + EOG_RULE_NOT_FILLING] !== g[EOG_BC_RULES + EOG_RULE_NOT_FILLING])
                s = $sformatf("RULES.NOT_FILLING expected %b got %b", e[EOG_BC_RULES + EOG_RULE_NOT_FILLING],
                              g[EOG_BC_RULES + EOG_RULE_NOT_FILLING]);
            else if (e[EOG_BC_CD +: 16] !== g[EOG_BC_CD +: 16])
                s = $sformatf("CD.p10 expected 0x%h (%0d) got 0x%h (%0d)", e[EOG_BC_CD +: 16], e[EOG_BC_CD +: 16],
                              g[EOG_BC_CD +: 16], g[EOG_BC_CD +: 16]);
            else if (e[EOG_BC_CD + 16 +: 16] !== g[EOG_BC_CD + 16 +: 16])
                s = $sformatf("CD.p50 expected 0x%h (%0d) got 0x%h (%0d)", e[EOG_BC_CD + 16 +: 16],
                              e[EOG_BC_CD + 16 +: 16], g[EOG_BC_CD + 16 +: 16], g[EOG_BC_CD + 16 +: 16]);
            else if (e[EOG_BC_CD + 32 +: 16] !== g[EOG_BC_CD + 32 +: 16])
                s = $sformatf("CD.p90 expected 0x%h (%0d) got 0x%h (%0d)", e[EOG_BC_CD + 32 +: 16],
                              e[EOG_BC_CD + 32 +: 16], g[EOG_BC_CD + 32 +: 16], g[EOG_BC_CD + 32 +: 16]);
            else
                s = "unnamed bits differ";
        end
        field_diff = s;
    endfunction

    function automatic string in_ctx(input logic [EOG_BM_W-1:0] d);
        logic [4:0] f;
        f = d[EOG_BM_FAC +: 5];
        in_ctx = $sformatf("input: STATUS %0d FAC %0d HIST_RESET %b INFLOW %0d LEVEL %0d; row: SHUT_LVL %0d K_CD %0d",
                           d[EOG_BM_STATUS +: 3], f, d[EOG_BM_HIST_RESET], $signed(d[EOG_BM_INFLOW +: 16]),
                           $signed(d[EOG_BM_LEVEL +: 16]), rows[f][EOG_CFG_SHUT_LVL +: 16],
                           rows[f][EOG_CFG_K_CD +: 32]);
    endfunction

    task automatic fail(input string msg);
        $display("FAIL: case %s pass %s: %s", cur_case, cur_pass, msg);
        $finish;
    endtask

    // ---------------------------------------------------------------------------------------------------------
    // Reset: rst_n = 0 for `cycles` cycles with in_valid = 0; CONFIG rows back to the case's initial table.
    task automatic do_reset(input integer cycles);
        @(negedge clk);
        rst_n     = 1'b0;
        in_valid  = 1'b0;
        out_ready = $random(seed);
        for (int s = 0; s < 32; s++) rows[s] = vcfg[1 + s];
        for (int k = 0; k < cycles; k++) begin
            @(negedge clk);
            out_ready = $random(seed);
            #1;
            if (out_valid !== 1'b0) fail($sformatf("out_valid = %b during reset", out_valid));
        end
        rst_n = 1'b1;
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
        integer ep;          // next event
        logic   in_fire, out_fire, prev_hold, ev_wait;
        logic [EOG_BC_W-1:0] prev_od;

        ni = 0; no = 0; cyc = 0; stall = 0; quiet = 0; last_acc = -1; prof_left = 0; p_v = 100; p_r = 100;
        in_fire = 1'b0; prev_hold = 1'b0; prev_od = '0; extra = 0; ep = 0;
        st_max_ii = 0; st_max_lat = 0; st_bp_cycles = 0; st_gap_cycles = 0; st_first_acc = -1; st_ev = 0;

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
                // CONFIG events for record ni: drain everything before it, then swap the row(s)
                while (ep < n_ev && ev_idx[ep] < ni) ep = ep + 1;   // (only if an index repeats; never expected)
                ev_wait = (ep < n_ev) && (ev_idx[ep] == ni) && (ni < n);
                if (ev_wait && no == ni) begin
                    while (ep < n_ev && ev_idx[ep] == ni) begin
                        rows[ev_slot[ep]] = ev_row[ep];
                        ep    = ep + 1;
                        st_ev = st_ev + 1;
                    end
                    ev_wait = 1'b0;
                end
                if (ni < n && !ev_wait && !(mode == P_ABORT && ni >= n_stop) &&
                    (mode == P_FULL || ($unsigned($random(seed)) % 100) < p_v)) begin
                    in_valid = 1'b1;
                    in_data  = vin[ni];
                end else begin
                    in_valid = 1'b0;
                    for (int w = 0; w < EOG_BM_W; w += 32) in_data[w +: 32] = $random(seed);  // garbage
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
                                   cyc, ni, no, out_data[EOG_BC_REC_NO +: 32]));
                if (out_data !== vout[no])
                    fail($sformatf("record %0d (REC_NO 0x%h): %s [%s]", no, vout[no][EOG_BC_REC_NO +: 32],
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
                if (extra == 0) extra = 1 + $unsigned($random(seed)) % 40;   // leave records in flight
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
                                   out_data[EOG_BC_REC_NO +: 32]));
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

    // events file: `<record index> cfg <slot> <row hex>`; returns -1 if missing
    function automatic integer load_events(input string path);
        integer fh, r, idx, slot, cnt;
        string  line, kind;
        logic [511:0] row;
        cnt = 0;
        fh = $fopen(path, "r");
        if (fh == 0) begin
            load_events = -1;
        end else begin
            while (!$feof(fh)) begin
                r = $fgets(line, fh);
                if (r <= 1) continue;
                row = '0;
                r = $sscanf(line, "%d %s %d %h", idx, kind, slot, row);
                if (r < 2) continue;
                if (kind != "cfg") begin
                    $display("NOTE: case %s: event '%s' at record %0d is not a countdown event, ignored", cur_case,
                             kind, idx);
                    continue;
                end
                if (r != 4 || slot < 0 || slot > 31) begin
                    $display("FAIL: case %s: bad event line: %s", cur_case, line);
                    $finish;
                end
                if (cnt >= MAXEV) begin
                    $display("FAIL: case %s: more than %0d events", cur_case, MAXEV);
                    $finish;
                end
                if (cnt > 0 && idx < ev_idx[cnt-1]) begin
                    $display("FAIL: case %s: events not in record order", cur_case);
                    $finish;
                end
                ev_idx[cnt]  = idx;
                ev_slot[cnt] = slot;
                ev_row[cnt]  = row;
                cnt = cnt + 1;
            end
            $fclose(fh);
            load_events = cnt;
        end
    endfunction

    // expected-output statistics of a case (branches of numerics §7)
    integer cs_vh, cs_none, cs_hr, cs_trip, cs_nf, cs_fin, cs_mix, cs_p50fin;
    task automatic case_stats(input integer n);
        logic [2:0]  st;
        logic [15:0] p10, p50, p90;
        logic        nf;
        cs_vh = 0; cs_none = 0; cs_hr = 0; cs_trip = 0; cs_nf = 0; cs_fin = 0; cs_mix = 0; cs_p50fin = 0;
        for (int k = 0; k < n; k++) begin
            st  = vin[k][EOG_BM_STATUS +: 3];
            p10 = vout[k][EOG_BC_CD +: 16];
            p50 = vout[k][EOG_BC_CD + 16 +: 16];
            p90 = vout[k][EOG_BC_CD + 32 +: 16];
            nf  = vout[k][EOG_BC_RULES + EOG_RULE_NOT_FILLING];
            if (st == EOG_ST_VALID || st == EOG_ST_HELD) begin
                cs_vh = cs_vh + 1;
                if (vin[k][EOG_BM_HIST_RESET]) cs_hr = cs_hr + 1;
                if (p10 == 0 && p50 == 0 && p90 == 0) cs_trip = cs_trip + 1;
                else if (nf) cs_nf = cs_nf + 1;
                else if (p10 != 16'hFFFF && p50 != 16'hFFFF && p90 != 16'hFFFF) cs_fin = cs_fin + 1;
                else cs_mix = cs_mix + 1;
                if (p50 != 16'hFFFF) cs_p50fin = cs_p50fin + 1;
            end else cs_none = cs_none + 1;
        end
    endtask

    // ---------------------------------------------------------------------------------------------------------
    string  names [$];
    integer total, ncases, nskip;

    initial begin : main
        integer fh, r, nl, n, n_in, n_out, n_cfg, ci;
        string  line, tok, cs, f_in, f_out, f_cfg, f_ev, skipped, ran;

        seed  = 32'h4344_3031;   // "CD01"
        total = 0; ncases = 0; nskip = 0; skipped = ""; ran = "";

        // case list: every countdown_<case>.in.hex in INDEX.txt
        fh = $fopen({VDIR, "INDEX.txt"}, "r");
        if (fh == 0) begin
            $display("FAIL: cannot open %sINDEX.txt (run from FPGA/: bash scripts/sim.sh countdown)", VDIR);
            $finish;
        end
        while (!$feof(fh)) begin
            r = $fgets(line, fh);
            if (r <= 0) break;
            r = $sscanf(line, "%s %d", tok, nl);
            if (r == 2 && tok.len() > 17 && tok.substr(0, 9) == "countdown_" &&
                tok.substr(tok.len() - 7, tok.len() - 1) == ".in.hex")
                names.push_back(tok.substr(10, tok.len() - 8));
        end
        $fclose(fh);

        rst_n = 1'b0;
        for (int s = 0; s < 32; s++) rows[s] = '0;
        repeat (2) @(negedge clk);

        for (ci = 0; ci < names.size(); ci++) begin
            cs       = names[ci];
            cur_case = cs;
            cur_pass = "load";
            f_in     = {VDIR, "countdown_", cs, ".in.hex"};
            f_out    = {VDIR, "countdown_", cs, ".out.hex"};
            f_cfg    = {VDIR, "countdown_", cs, ".cfg.hex"};
            f_ev     = {VDIR, "countdown_", cs, ".events.txt"};
            n_in     = count_lines(f_in);
            n_out    = count_lines(f_out);
            n_cfg    = count_lines(f_cfg);
            if (n_in < 0 || n_out < 0 || n_cfg < 0) begin
                $display("NOTE: skipping case %s: %s missing (regenerate: python model/gen_vectors.py)", cs,
                         (n_in < 0) ? f_in : (n_out < 0) ? f_out : f_cfg);
                nskip   = nskip + 1;
                skipped = {skipped, " ", cs};
                continue;
            end
            if (n_in != n_out) fail($sformatf("%0d input lines but %0d output lines", n_in, n_out));
            if (n_in == 0 || n_in > MAXREC) fail($sformatf("%0d records (1..%0d supported)", n_in, MAXREC));
            if (n_cfg != 33) fail($sformatf("%s has %0d lines, expected 33", f_cfg, n_cfg));
            n = n_in;
            $readmemh(f_in, vin, 0, n - 1);
            $readmemh(f_out, vout, 0, n - 1);
            $readmemh(f_cfg, vcfg, 0, 32);
            for (int k = 0; k < n; k++)
                if ((^vin[k]) === 1'bx || (^vout[k]) === 1'bx)
                    fail($sformatf("vector line %0d has X/Z after $readmemh", k));
            for (int s = 0; s < 33; s++)
                if ((^vcfg[s]) === 1'bx) fail($sformatf("cfg line %0d has X/Z after $readmemh", s));
            n_ev = load_events(f_ev);
            if (n_ev < 0) begin
                $display("NOTE: case %s: no %s, running without mid-stream events", cs, f_ev);
                n_ev = 0;
            end
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

            $display("case %-8s %6d records OK (abort/random/full) | %0d cfg events | VALID/HELD %0d (HIST_RESET %0d): tripped %0d, not filling %0d, finite %0d, partly 0xFFFF %0d, p50 finite %0d; INVALID/DROPPED %0d | full pass: first accept at cycle %0d, max II %0d, max latency %0d",
                     cs, n, st_ev, cs_vh, cs_hr, cs_trip, cs_nf, cs_fin, cs_mix, cs_p50fin, cs_none, st_first_acc,
                     st_max_ii, st_max_lat);
            total  = total + n;
            ncases = ncases + 1;
            ran    = {ran, " ", cs};
        end

        if (ncases == 0) begin
            $display("FAIL: no countdown_* vector case found (INDEX lists %0d, %0d skipped)", names.size(), nskip);
        end else begin
            $display("PASS: %0d records (%0d cases x 3 passes: abort, random gaps/back-pressure, full rate with II <= %0d and latency <= %0d); cases:%s%s",
                     total, ncases, II_MAX, LAT_MAX, ran,
                     (nskip == 0) ? "" : $sformatf("; skipped %0d case(s) with missing files:%s", nskip, skipped));
        end
        $finish;
    end

    // safety net
    initial begin
        #4_000_000_000;
        $display("FAIL: global timeout");
        $finish;
    end
endmodule

`default_nettype wire
