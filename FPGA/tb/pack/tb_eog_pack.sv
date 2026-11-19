// tb_eog_pack.sv -- golden-vector simulation of eog_pack (Verify role, task T1.pack.fv).
//   bash scripts/sim.sh pack
//
// Written from spec/modules/eog_pack.md, conventions.md §2 (spec v4) and tb/README.md; the RTL internals are not
// read. The DUT runs at its default parameters (BATCH = 45, as the vectors).
//
// Cases: every `case <name>` line of tb/vectors/INDEX.txt whose pack_<name>.in.hex, .out.hex and .last.hex exist
// (pack_week / pack_g1 are git-ignored: generate them with `python model/gen_vectors.py`, see model/README.md).
//   pack_<name>.in.hex    bus A (EOG_BA_W bits) per record
//   pack_<name>.out.hex   RESULT (256 bits) per record; beat j = bits [64j+63:64j]
//   pack_<name>.last.hex  m_last on that record's beat 3 (BATCH = 45, counted from reset)
// Each case runs four times. Before each run the DUT gets a few random records with random back-pressure and is
// then reset for 2 cycles mid-stream, so every run also checks that reset clears a partial record and the batch
// count.
//   run 0  random in_valid gaps (random garbage on in_data while in_valid = 0), random m_ready with occasional
//          long stalls;
//   run 1  full rate: in_valid = 1 while records remain, m_ready = 1: checks "sustains one beat per cycle"
//          (in_valid = m_ready = 1 in the 3 previous cycles -> m_valid = 1) and II <= 16;
//   run 2  in_valid = 1 while records remain, heavy random back-pressure;
//   run 3  batching: as run 0, but IN_LAST is cleared on all but ~1 in 64 records (RESULT does not carry it), and
//          the expected m_last is the spec rule computed here (IN_LAST || BATCH-th result since the last m_last,
//          counted from reset). The vectors' .last.hex is also checked against the same rule. (No committed
//          vector reaches the BATCH = 45 path: every case sets IN_LAST at least every 45 records.)
// Checked every cycle in every run (sampled just before each rising edge):
//   - m_valid = 0 and tap_valid = 0 in the cycle after reset; m_valid / m_data / m_last held while
//     m_valid && !m_ready (K1);
//   - every beat equals the next 64 bits of the expected RESULT (4 beats per record, in order; !==, so X fails)
//     and m_last = 0 on beats 0-2, = .last.hex on beat 3 (K2, K3);
//   - no beat without an accepted record whose last beat has not transferred; nothing extra at the end;
//   - tap_valid once per record, in its last-beat transfer cycle or the cycle after, with tap_status =
//     STATUS[2:0] and tap_reason = REASON[15:0] of the expected RESULT (K4);
//   - stall == m_valid && !m_ready.
//
// Output: one informational line per case (`ran case ...` / `skipped case ...`), then exactly one final line,
// `PASS: <n> records ...` or `FAIL: case <c> run <r> record <i> beat <j> field <F> expected .. got ..`.

`timescale 1ns/1ps
`default_nettype none

module tb_eog_pack;
    `include "eog_defs.svh"

    localparam integer AW    = EOG_BA_W;
    localparam integer MAXR  = 32768;    // records per case (week / g1 = 30240)
    localparam integer STALL = 2000;     // cycles without any transfer while work remains -> FAIL

    logic          clk = 1'b0;
    logic          rst_n = 1'b0;
    logic          in_valid = 1'b0;
    logic          in_ready;
    logic [AW-1:0] in_data = '0;
    logic          m_valid;
    logic          m_ready = 1'b0;
    logic [63:0]   m_data;
    logic          m_last;
    logic          tap_valid;
    logic [2:0]    tap_status;
    logic [15:0]   tap_reason;
    logic          stall;

    eog_pack dut (
        .clk(clk), .rst_n(rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .m_valid(m_valid), .m_ready(m_ready), .m_data(m_data), .m_last(m_last),
        .tap_valid(tap_valid), .tap_status(tap_status), .tap_reason(tap_reason), .stall(stall));

    always #5 clk = ~clk;

    // ---- vectors of the current case -----------------------------------------------------------------------
    logic [AW-1:0] vin   [0:MAXR-1];
    logic [255:0]  vout  [0:MAXR-1];
    logic          vlast [0:MAXR-1];
    logic          klast [0:MAXR-1];     // run 3: IN_LAST driven
    logic          elast [0:MAXR-1];     // run 3: expected m_last
    integer        n_rec;

    // ---- monitor state ---------------------------------------------------------------------------------------
    logic   running = 1'b0;
    integer mode = 0;
    string  cname = "";
    integer cyc = 0;
    integer ri = 0;            // records accepted in this run
    integer n_done = 0;        // records whose 4 beats transferred
    integer tb_beat = 0;       // beats of record n_done already transferred
    integer n_tap = 0;
    logic   failed = 1'b0;
    logic   fired_in = 1'b0;   // the record on in_data was accepted at the last rising edge
    logic   prev_rst = 1'b0, prev_hold = 1'b0;
    logic [64:0] prev_out;
    logic   h1 = 1'b0, h2 = 1'b0, h3 = 1'b0;   // in_valid && m_ready (rst_n) in the 1st/2nd/3rd previous cycle
    logic   pend = 1'b0;       // a record's last beat transferred last cycle without a tap
    integer pend_rec = 0;
    integer ii_wait = 0;
    integer last_prog = 0;
    integer first_acc_cyc = 0, last_beat_cyc = 0;

    // statistics over all cases and runs
    integer total = 0, total_last = 0, total_beats = 0, n_hold = 0, n_irdy_low = 0, n_cases = 0;
    integer total_batch = 0;   // run 3: m_last from the BATCH count alone
    integer max_extra1 = 0, max_ii1 = 0, n_tap_late = 0, n_tap_same = 0;

    // ---- messages --------------------------------------------------------------------------------------------
    task automatic fail_msg(input string m);
        if (!failed) $display("FAIL: case %s run %0d: %s", cname, mode, m);
        failed = 1'b1;
    endtask

    function automatic string rfield(input integer b);
        if      (b < EOG_RES_STATUS)      rfield = "FAC_ID";
        else if (b < EOG_RES_SINCE_RESET) rfield = "STATUS";
        else if (b < EOG_RES_TS)          rfield = "SINCE_RESET";
        else if (b < EOG_RES_REASON)      rfield = "TS";
        else if (b < EOG_RES_LOGITS)      rfield = "REASON";
        else if (b < EOG_RES_RULES)       rfield = "LOGITS";
        else if (b < EOG_RES_WVER)        rfield = "RULES";
        else if (b < EOG_RES_CD_P10)      rfield = "WVER";
        else if (b < EOG_RES_CD_P50)      rfield = "CD_P10";
        else if (b < EOG_RES_CD_P90)      rfield = "CD_P50";
        else if (b < EOG_RES_RESULT_NO)   rfield = "CD_P90";
        else                              rfield = "RESULT_NO";
    endfunction

    task automatic report_beat(input integer i, input integer j, input logic [63:0] e, input logic [63:0] g);
        integer k, b;
        logic [63:0] d;
        d = e ^ g;
        b = 0;
        for (k = 63; k >= 0; k = k - 1) if (d[k] !== 1'b0) b = k;
        if (!failed)
            $display("FAIL: case %s run %0d record %0d beat %0d field %s (RESULT bit %0d) expected 0x%016h got 0x%016h",
                     cname, mode, i, j, rfield(64 * j + b), 64 * j + b, e, g);
        failed = 1'b1;
    endtask

    task automatic check_tap(input integer i);
        logic [2:0]  es;
        logic [15:0] er;
        if (i >= n_rec) begin
            fail_msg($sformatf("tap for record %0d (case has %0d)", i, n_rec));
            return;
        end
        es = vout[i][EOG_RES_STATUS +: 3];
        er = vout[i][EOG_RES_REASON +: 16];
        if (tap_status !== es || tap_reason !== er)
            fail_msg($sformatf("record %0d tap_status/tap_reason expected %0d/0x%04h got %0d/0x%04h", i, es, er,
                               tap_status, tap_reason));
        n_tap = n_tap + 1;
    endtask

    // ---- monitor (samples just before each rising edge: DUT registers update in the NBA region) --------------
    always @(posedge clk) begin
        logic in_fire, m_fire, l3fire, exp_last;
        logic [63:0] eb;
        cyc = cyc + 1;
        in_fire  = rst_n && in_valid && (in_ready === 1'b1);
        m_fire   = rst_n && (m_valid === 1'b1) && m_ready;
        l3fire   = m_fire && tb_beat == 3;
        fired_in = in_fire;
        if (running && !failed) begin
            if (prev_rst == 1'b0 && rst_n && (m_valid !== 1'b0 || tap_valid !== 1'b0))
                fail_msg($sformatf("m_valid = %b, tap_valid = %b in the cycle after reset", m_valid, tap_valid));
            if (rst_n) begin
                if (in_ready !== 1'b0 && in_ready !== 1'b1) fail_msg("in_ready is X/Z");
                if (m_valid !== 1'b0 && m_valid !== 1'b1) fail_msg("m_valid is X/Z");
                if (tap_valid !== 1'b0 && tap_valid !== 1'b1) fail_msg("tap_valid is X/Z");
                if (stall !== (m_valid && !m_ready)) fail_msg($sformatf("stall = %b with m_valid = %b, m_ready = %b",
                                                                         stall, m_valid, m_ready));
                if (prev_hold && m_valid !== 1'b1)
                    fail_msg($sformatf("m_valid dropped before the transfer (record %0d beat %0d)", n_done, tb_beat));
                else if (prev_hold && {m_last, m_data} !== prev_out)
                    fail_msg($sformatf("m_data/m_last changed while m_valid && !m_ready (record %0d beat %0d)",
                                       n_done, tb_beat));
                if (m_valid === 1'b1 && !m_ready) n_hold = n_hold + 1;
                if (in_valid && in_ready !== 1'b1) n_irdy_low = n_irdy_low + 1;

                if (in_fire) begin
                    if (ri >= n_rec) fail_msg("record accepted beyond the end of the case");
                    if (ri == 0) first_acc_cyc = cyc;
                    ri = ri + 1;
                    last_prog = cyc;
                end
                // no beat without a record in flight
                if (m_valid === 1'b1 && n_done >= ri)
                    fail_msg($sformatf("m_valid with no record in flight (%0d accepted, %0d out)", ri, n_done));

                // K4 tap: in the last-beat transfer cycle or the next one, exactly once
                if (tap_valid === 1'b1) begin
                    if (l3fire) begin
                        check_tap(n_done);
                        n_tap_same = n_tap_same + 1;
                    end else if (pend) begin
                        check_tap(pend_rec);
                        n_tap_late = n_tap_late + 1;
                    end else fail_msg($sformatf("tap_valid without a record's last beat (%0d records out)", n_done));
                end else if (pend) fail_msg($sformatf("no tap for record %0d", pend_rec));
                pend     = l3fire && tap_valid !== 1'b1;
                pend_rec = n_done;

                // full rate: one beat per cycle sustained, II <= 16
                if (mode == 1) begin
                    if (h1 && h2 && h3 && m_valid !== 1'b1)
                        fail_msg("m_valid = 0 after 3 cycles of in_valid = m_ready = 1 (one beat per cycle)");
                    if (in_valid && m_ready && !in_fire) ii_wait = ii_wait + 1; else ii_wait = 0;
                    if (ii_wait > max_ii1) max_ii1 = ii_wait;
                    if (ii_wait >= EOG_II_MAX) fail_msg("no record accepted in 16 cycles with in_valid = m_ready = 1");
                end

                if (m_fire && !failed) begin
                    if (n_done >= n_rec) fail_msg($sformatf("extra beat (case has %0d records)", n_rec));
                    else begin
                        eb = vout[n_done][64 * tb_beat +: 64];
                        exp_last = (tb_beat == 3) ? ((mode == 3) ? elast[n_done] : vlast[n_done]) : 1'b0;
                        if (m_data !== eb) report_beat(n_done, tb_beat, eb, m_data);
                        else if (m_last !== exp_last)
                            fail_msg($sformatf("record %0d beat %0d m_last expected %0d got %b", n_done, tb_beat,
                                               exp_last, m_last));
                    end
                    total_beats = total_beats + 1;
                    last_prog = cyc;
                    if (tb_beat == 3) begin
                        if (!failed) begin
                            total = total + 1;
                            if (m_last) total_last = total_last + 1;
                            if (m_last && mode == 3 && !klast[n_done]) total_batch = total_batch + 1;
                        end
                        n_done = n_done + 1;
                        tb_beat = 0;
                        last_beat_cyc = cyc;
                    end else tb_beat = tb_beat + 1;
                end
                if (cyc - last_prog > STALL && (ri < n_rec || n_done < ri))
                    fail_msg($sformatf("no progress for %0d cycles (%0d/%0d records in, %0d out)", STALL, ri, n_rec,
                                       n_done));
            end
        end
        h3        = h2;
        h2        = h1;
        h1        = rst_n && in_valid && m_ready;
        prev_rst  = rst_n;
        prev_hold = rst_n && (m_valid === 1'b1) && !m_ready;
        prev_out  = {m_last, m_data};
        if (!rst_n) pend = 1'b0;
    end

    // ---- stimulus (changes on the falling edge) --------------------------------------------------------------
    integer seed = 32'h0E06_2026;
    integer stall_n = 0;

    function automatic integer urand(input integer n);
        urand = $unsigned($random(seed)) % n;
    endfunction

    task automatic garbage_in();
        integer k;
        for (k = 0; k < AW; k = k + 32) in_data[k +: 32] = $random(seed);
    endtask

    task automatic drive_cycle();
        logic want;
        @(negedge clk);
        if (in_valid && !fired_in) begin
            // hold (conventions §2): unchanged until accepted
        end else begin
            want = (mode == 0 || mode == 3) ? (urand(10) < 6) : 1'b1;
            if (want && ri < n_rec) begin
                in_valid = 1'b1;
                in_data  = vin[ri];
                if (mode == 3) in_data[EOG_BA_IN_LAST] = klast[ri];
            end else begin
                in_valid = 1'b0;
                garbage_in();
            end
        end
        case (mode)
            0, 3: begin
                if (stall_n > 0) begin m_ready = 1'b0; stall_n = stall_n - 1; end
                else if (urand(64) == 0) begin m_ready = 1'b0; stall_n = 5 + urand(36); end
                else m_ready = urand(10) < 7;
            end
            1: m_ready = 1'b1;
            default: begin
                if (stall_n > 0) begin m_ready = 1'b0; stall_n = stall_n - 1; end
                else if (urand(16) == 0) begin m_ready = 1'b0; stall_n = 2 + urand(29); end
                else m_ready = urand(2);
            end
        endcase
    endtask

    // random records before the reset (must be forgotten by the reset: partial record, batch count)
    task automatic pre_garbage();
        integer k, nc;
        nc = 4 + urand(40);
        for (k = 0; k < nc; k = k + 1) begin
            @(negedge clk);
            if (!(in_valid && in_ready !== 1'b1)) begin
                in_valid = urand(4) != 0;
                garbage_in();
                in_data[EOG_BA_IN_LAST] = 1'b0;
            end
            m_ready = urand(4) != 0;
        end
    endtask

    task automatic run_case(input integer md);
        integer k;
        mode = md;
        ri = 0; n_done = 0; tb_beat = 0; n_tap = 0; stall_n = 0; ii_wait = 0;
        running = 1'b0;
        rst_n = 1'b1;
        pre_garbage();
        rst_n = 1'b0;
        @(negedge clk);
        in_valid = 1'b0;
        garbage_in();
        m_ready = urand(2);
        @(negedge clk);
        running    = 1'b1;
        last_prog  = cyc;
        rst_n      = 1'b1;
        in_valid   = 1'b0;     // conventions: valid is 0 in the cycle after reset
        m_ready    = (md == 1) ? 1'b1 : urand(2);
        while (!failed && (ri < n_rec || n_done < n_rec)) begin
            drive_cycle();
            if (cyc - last_prog > STALL + 10) fail_msg("timeout");
        end
        // drain: nothing more may come out; a late tap may still arrive
        for (k = 0; k < 8 && !failed; k = k + 1) begin
            @(negedge clk);
            in_valid = 1'b0;
            garbage_in();
            m_ready = 1'b1;
        end
        @(negedge clk);
        if (!failed && n_done != n_rec) fail_msg($sformatf("%0d of %0d records output", n_done, n_rec));
        if (!failed && n_tap != n_rec) fail_msg($sformatf("%0d taps for %0d records", n_tap, n_rec));
        if (!failed && md == 1 && n_rec > 0 && last_beat_cyc - first_acc_cyc + 1 - 4 * n_rec > max_extra1)
            max_extra1 = last_beat_cyc - first_acc_cyc + 1 - 4 * n_rec;
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

    string  line, w1, w2, base, ran, skipped;
    integer fd, r, ni, no, nl, md, bc, q;

    initial begin
        ran = "";
        skipped = "";
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
                base  = {"tb/vectors/pack_", w2};
                ni = count_lines({base, ".in.hex"});
                no = count_lines({base, ".out.hex"});
                nl = count_lines({base, ".last.hex"});
                if (ni < 0 || no < 0 || nl < 0) begin
                    $display("skipped case %s: %s.{in,out,last}.hex missing (generate with model/gen_vectors.py)",
                             w2, base);
                    skipped = {skipped, " ", w2};
                end else if (ni != no || ni != nl) begin
                    $display("FAIL: case %s: %0d inputs, %0d results, %0d m_last lines", w2, ni, no, nl);
                    failed = 1'b1;
                end else if (ni > MAXR) begin
                    $display("FAIL: case %s too large for the bench (%0d records)", w2, ni);
                    failed = 1'b1;
                end else begin
                    n_rec = ni;
                    if (ni > 0) begin
                        $readmemh({base, ".in.hex"}, vin, 0, ni - 1);
                        $readmemh({base, ".out.hex"}, vout, 0, ni - 1);
                        $readmemh({base, ".last.hex"}, vlast, 0, ni - 1);
                    end
                    // the vectors' m_last against the spec rule (BATCH = 45 from reset); run 3's stimulus
                    bc = 0;
                    for (q = 0; q < ni && !failed; q = q + 1) begin
                        bc = bc + 1;
                        if (vlast[q] !== (vin[q][EOG_BA_IN_LAST] || bc == 45)) begin
                            $display("FAIL: case %s record %0d: .last.hex %b disagrees with the spec rule", w2, q,
                                     vlast[q]);
                            failed = 1'b1;
                        end
                        if (vlast[q]) bc = 0;
                    end
                    bc = 0;
                    for (q = 0; q < ni; q = q + 1) begin
                        klast[q] = vin[q][EOG_BA_IN_LAST] && urand(64) == 0;
                        bc = bc + 1;
                        elast[q] = klast[q] || bc == 45;
                        if (elast[q]) bc = 0;
                    end
                    for (md = 0; md < 4 && !failed; md = md + 1) run_case(md);
                    if (!failed) begin
                        $display("ran case %s: %0d records, 4 runs", w2, ni);
                        ran = {ran, " ", w2};
                        n_cases = n_cases + 1;
                    end
                end
            end
        end
        $fclose(fd);
        if (!failed && n_cases == 0) begin
            $display("FAIL: no case ran (no tb/vectors/pack_*.hex)");
            failed = 1'b1;
        end
        if (!failed && (n_hold == 0 || total_last == 0 || n_irdy_low == 0 || total_batch == 0)) begin
            $display("FAIL: coverage hole (held beats %0d, m_last records %0d, BATCH m_last %0d, in_ready-low cycles %0d)",
                     n_hold, total_last, total_batch, n_irdy_low);
            failed = 1'b1;
        end
        if (!failed)
            $display("PASS: %0d records (%0d with m_last, %0d of them from the BATCH count), %0d beats, %0d cases x 4 runs:%s; skipped:%s; full rate: %0d cycles beyond 4/record, max II wait %0d; taps same-cycle %0d / next-cycle %0d; %0d held beats, %0d in_ready-low cycles",
                     total, total_last, total_batch, total_beats, n_cases, ran, (skipped == "") ? " none" : skipped, max_extra1,
                     max_ii1, n_tap_same, n_tap_late, n_hold, n_irdy_low);
        $finish;
    end
endmodule

`default_nettype wire
