// tb_eog_div.sv — self-checking simulation of eog_div at the design widths (Verify role, task T1.div.fv).
//
// Written from spec/modules/eog_div.md (spec v2). `bash scripts/sim.sh div`.
//
// Reference: q = d == 0 ? all ones : floor(n / d); r = d == 0 ? n[DW-1:0] : n % d; out_valid / q / r / tag_out
// exactly LAT = NW + 1 cycles after the matching in_valid (an in_valid during reset is not a division, and a
// reset kills everything in flight). The check runs every cycle, including cycles with no output due
// (out_valid must then be 0), so lost, duplicated, early, late or invented outputs all fail.
//
// eog_div has no ready (always accepts), so there is no back-pressure to randomize; II = 1 is exercised by the
// back-to-back phases. No golden vectors exist for helpers (model/README.md defines per-stage buses only), so this
// testbench computes the reference itself.
//
// Phases (fixed seed): reset; corners back to back (d = 0, d = 1, n < d, n = d, n = max, d = max, powers of two,
// n = k*d + d - 1); random with random gaps; back-to-back every cycle; reset in the middle of a burst; drain.
// Prints exactly one final line: `PASS: <n> divisions ...` or `FAIL: ...`.

`timescale 1ns/1ps
`default_nettype none

module tb_eog_div;
    localparam integer NW  = 48;
    localparam integer DW  = 32;
    localparam integer TW  = 4;
    localparam integer LAT = NW + 1;   // spec: LAT = NW + 1

    localparam integer N_RANDOM = 20000;   // random phase, with gaps
    localparam integer N_B2B    = 5000;    // back-to-back phase

    logic          clk = 1'b0;
    logic          rst_n = 1'b0;
    logic          in_valid = 1'b0;
    logic [NW-1:0] n = '0;
    logic [DW-1:0] d = '0;
    logic [TW-1:0] tag_in = '0;
    logic          out_valid;
    logic [NW-1:0] q;
    logic [DW-1:0] r;
    logic [TW-1:0] tag_out;

    eog_div #(.NW(NW), .DW(DW), .TW(TW)) dut (
        .clk(clk), .rst_n(rst_n), .in_valid(in_valid), .n(n), .d(d), .tag_in(tag_in),
        .out_valid(out_valid), .q(q), .r(r), .tag_out(tag_out));

    always #5 clk = ~clk;

    // ---------------------------------------------------------------------------------------------------------
    // Reference pipeline: index 0 = newest. Updated on posedge with the same sampling as the DUT.
    logic          rv [0:LAT-1];
    logic [NW-1:0] rq [0:LAT-1];
    logic [DW-1:0] rr [0:LAT-1];
    logic [TW-1:0] rt [0:LAT-1];
    logic [NW-1:0] rn [0:LAT-1];
    logic [DW-1:0] rd [0:LAT-1];

    integer i;
    initial for (i = 0; i < LAT; i = i + 1) rv[i] = 1'b0;

    integer n_in = 0;       // divisions accepted (in_valid && rst_n at a posedge)
    integer n_killed = 0;   // accepted but flushed by a reset before completing
    integer n_out = 0;      // outputs checked
    integer n_dzero = 0;    // outputs checked with d == 0
    integer n_b2b = 0;      // outputs on consecutive cycles
    integer cyc = 0;
    logic   failed = 1'b0;
    logic   prev_ov = 1'b0;

    always @(posedge clk) begin
        cyc <= cyc + 1;
        if (!rst_n) begin
            for (i = 0; i < LAT - 1; i = i + 1) if (rv[i]) n_killed = n_killed + 1;
        end
        for (i = LAT - 1; i > 0; i = i - 1) begin
            rv[i] <= rv[i-1] & rst_n;
            rq[i] <= rq[i-1];
            rr[i] <= rr[i-1];
            rt[i] <= rt[i-1];
            rn[i] <= rn[i-1];
            rd[i] <= rd[i-1];
        end
        rv[0] <= in_valid & rst_n;
        rq[0] <= (d == '0) ? {NW{1'b1}} : n / NW'(d);
        rr[0] <= (d == '0) ? n[DW-1:0] : DW'(n % NW'(d));
        rt[0] <= tag_in;
        rn[0] <= n;
        rd[0] <= d;
        if (in_valid && rst_n) n_in = n_in + 1;
    end

    // Check on the falling edge (DUT outputs are stable between posedges).
    always @(negedge clk) begin
        if (!failed && cyc > 0) begin
            if (out_valid !== rv[LAT-1]) begin
                $display("FAIL: cycle %0d out_valid expected %0b got %b (output %0d)", cyc, rv[LAT-1], out_valid,
                         n_out);
                failed = 1'b1;
            end else if (rv[LAT-1]) begin
                if (q !== rq[LAT-1]) begin
                    $display("FAIL: output %0d (cycle %0d) q expected 0x%012h got 0x%012h (n=0x%012h d=0x%08h)",
                             n_out, cyc, rq[LAT-1], q, rn[LAT-1], rd[LAT-1]);
                    failed = 1'b1;
                end else if (r !== rr[LAT-1]) begin
                    $display("FAIL: output %0d (cycle %0d) r expected 0x%08h got 0x%08h (n=0x%012h d=0x%08h)",
                             n_out, cyc, rr[LAT-1], r, rn[LAT-1], rd[LAT-1]);
                    failed = 1'b1;
                end else if (tag_out !== rt[LAT-1]) begin
                    $display("FAIL: output %0d (cycle %0d) tag_out expected 0x%0h got 0x%0h", n_out, cyc,
                             rt[LAT-1], tag_out);
                    failed = 1'b1;
                end else begin
                    n_out = n_out + 1;
                    if (rd[LAT-1] == '0) n_dzero = n_dzero + 1;
                    if (prev_ov) n_b2b = n_b2b + 1;
                end
            end
            prev_ov = (out_valid === 1'b1);
        end
    end

    // ---------------------------------------------------------------------------------------------------------
    // Stimulus (changes on the falling edge, after the check)
    integer seed = 32'h0D1F_2026;
    integer k;

    function automatic logic [63:0] rnd64();
        rnd64 = {$random(seed), $random(seed)};
    endfunction

    task automatic drive(input logic v, input logic [NW-1:0] nn, input logic [DW-1:0] dd);
        @(negedge clk);
        #1;
        in_valid = v;
        n        = nn;
        d        = dd;
        tag_in   = TW'($random(seed));
    endtask

    task automatic idle();
        // random garbage on the data inputs while in_valid = 0 (must not matter)
        drive(1'b0, NW'(rnd64()), DW'(rnd64()));
    endtask

    // random operands with a mix of shapes
    task automatic rnd_operands(output logic [NW-1:0] nn, output logic [DW-1:0] dd);
        logic [63:0] a, b;
        integer sh, kind;
        a    = rnd64();
        b    = rnd64();
        kind = $unsigned($random(seed)) % 8;
        sh   = $unsigned($random(seed)) % DW;
        case (kind)
            0: begin nn = NW'(a); dd = DW'(b); end                              // full width
            1: begin nn = NW'(a); dd = DW'(b) >> sh; end                         // short d
            2: begin nn = NW'(a) >> ($unsigned($random(seed)) % NW); dd = DW'(b); end // short n (often n < d)
            3: begin nn = NW'(a); dd = DW'(b[3:0]); end                         // tiny d, incl. 0 and 1
            4: begin nn = {NW{1'b1}}; dd = DW'(b) >> sh; end                     // n = max
            5: begin dd = DW'(b) >> sh; nn = NW'(dd) * NW'(a[15:0]) + NW'(dd) - 1; end // remainder d - 1
            6: begin dd = DW'(b) >> sh; nn = NW'(dd); end                       // n = d
            default: begin nn = NW'(a[DW-1:0]); dd = DW'(b); end                // n and d same scale
        endcase
    endtask

    logic [NW-1:0] tn;
    logic [DW-1:0] td;

    initial begin
        // reset with in_valid toggling (must not start divisions)
        rst_n = 1'b0;
        for (k = 0; k < 4; k = k + 1) drive(k[0], NW'(rnd64()), DW'(rnd64()));
        @(negedge clk); #1; rst_n = 1'b1; in_valid = 1'b0;

        // corners, back to back
        drive(1, '0, '0);
        drive(1, {NW{1'b1}}, '0);
        drive(1, NW'(48'h1234_5678_9ABC), '0);
        drive(1, NW'(48'hFFFF_0000_1234), '0);          // d = 0, low DW bits of n nonzero
        drive(1, {NW{1'b1}}, DW'(1));
        drive(1, NW'(48'h8000_0000_0001), DW'(1));
        drive(1, '0, DW'(1));
        drive(1, '0, {DW{1'b1}});
        drive(1, NW'(5), DW'(7));                       // n < d
        drive(1, NW'(32'hFFFF_FFFE), {DW{1'b1}});       // n < d, both large
        drive(1, NW'(32'hFFFF_FFFF), {DW{1'b1}});       // n = d
        drive(1, {NW{1'b1}}, {DW{1'b1}});
        drive(1, {NW{1'b1}}, DW'(2));
        drive(1, {NW{1'b1}}, DW'(3));
        drive(1, {NW{1'b1}}, DW'(32'h8000_0000));
        drive(1, NW'(48'h7FFF_FFFF_FFFF), DW'(32'h8000_0000));
        for (k = 0; k < DW; k = k + 1) drive(1, {NW{1'b1}}, DW'(1) << k);   // powers of two
        for (k = 0; k < NW; k = k + 1) drive(1, NW'(1) << k, DW'(3));
        drive(1, NW'(48'h0000_FFFF_FFFE) * NW'(1000) + NW'(48'h0000_FFFF_FFFD), DW'(32'hFFFF_FFFE)); // r = d - 1
        idle();

        // random with random gaps
        for (k = 0; k < N_RANDOM; k = k + 1) begin
            if (($unsigned($random(seed)) % 10) < 3) idle();
            else begin rnd_operands(tn, td); drive(1, tn, td); end
        end

        // back to back, every cycle
        for (k = 0; k < N_B2B; k = k + 1) begin rnd_operands(tn, td); drive(1, tn, td); end

        // reset in the middle of a burst: everything in flight is flushed, out_valid 0 for LAT cycles after
        for (k = 0; k < LAT / 2; k = k + 1) begin rnd_operands(tn, td); drive(1, tn, td); end
        @(negedge clk); #1; rst_n = 1'b0;
        for (k = 0; k < 2; k = k + 1) begin rnd_operands(tn, td); drive(1, tn, td); end
        @(negedge clk); #1; rst_n = 1'b1;
        for (k = 0; k < 2 * LAT; k = k + 1) begin
            if (($unsigned($random(seed)) % 10) < 5) idle();
            else begin rnd_operands(tn, td); drive(1, tn, td); end
        end

        // drain
        drive(0, '0, '0);
        for (k = 0; k < LAT + 4; k = k + 1) idle();
        @(negedge clk); #2;

        if (failed) begin
            // the FAIL line was already printed
        end else if (n_out + n_killed != n_in) begin
            $display("FAIL: %0d divisions accepted, %0d flushed by reset, %0d output", n_in, n_killed, n_out);
        end else if (n_dzero == 0 || n_b2b == 0 || n_killed == 0) begin
            $display("FAIL: coverage hole (d == 0 outputs %0d, back-to-back %0d, flushed %0d)", n_dzero, n_b2b,
                     n_killed);
        end else begin
            $display("PASS: %0d divisions (NW=%0d DW=%0d LAT=%0d; %0d with d == 0, %0d back-to-back, %0d flushed by reset)",
                     n_out, NW, DW, LAT, n_dzero, n_b2b, n_killed);
        end
        $finish;
    end

    // safety net
    initial begin
        #100_000_000;
        $display("FAIL: timeout");
        $finish;
    end
endmodule

`default_nettype wire
