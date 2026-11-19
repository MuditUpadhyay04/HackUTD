// tb_eog_mul.sv — self-checking testbench for eog_mul (spec/modules/eog_mul.md, spec v2). Verify role, T1.mul.fv.
//   bash scripts/sim.sh mul
//
// eog_mul has no handshake (no valid gaps / back-pressure to randomize) and no golden vectors: the expected
// product is computed here from the spec ("signed product of a and b as typed by the parameters, sign-extended,
// valid LAT cycles after a/b were presented"): sign- or zero-extend each operand to AW+BW bits and multiply
// modulo 2^(AW+BW), which is the exact product for every sign combination.
//
// 36 configurations, each its own DUT + checker, all running in lockstep with a fixed seed:
//   widths  6x8 (exhaustive), 20x32 (feature multiplier), 16x16 (head multiplier)
//   x A_SIGNED/B_SIGNED in {0,1}x{0,1}  x  LAT in {0,1,2}
// Per configuration: 9x9 corner operand pairs (0, 1, 2, -2 / all-but-lsb, all ones (-1 / max unsigned),
// signed min, signed max, 0101.., 1010..), then all 2^14 operand pairs when AW+BW <= 14, then random operands
// (1/4 corner, 1/4 small signed -8..7, 1/2 uniform) until the end. Operands change every cycle.
// Check point: 1 time unit after the operands change (negedge); p must equal the product of the operands
// presented exactly LAT cycles earlier (LAT = 0: the current ones), compared with !== so X/Z fails.
// The first LAT check points after time 0 are skipped (no reset; the pipeline is unknown).
//
// Output: exactly one final line, `PASS: <n> products checked ...` or `FAIL: <config> cycle .. a .. b .. exp .. got ..`.

`default_nettype none

module tb_mul_chk #(
    parameter integer AW  = 6,
    parameter integer BW  = 8,
    parameter integer AS  = 1,
    parameter integer BS  = 0,
    parameter integer LAT = 2,
    parameter integer ID  = 0
) (
    input  logic        clk,
    input  logic        report,   // top asks this checker to print its first mismatch
    output logic        err,      // sticky: a mismatch was seen
    output logic        cov_ok,   // the corner (and exhaustive, if applicable) phases completed
    output logic [31:0] n_chk
);
    localparam integer PW    = AW + BW;
    localparam integer NCOR  = 9;
    localparam integer EXH   = (PW <= 14) ? (1 << PW) : 0;

    logic [AW-1:0] a;
    logic [BW-1:0] b;
    logic [PW-1:0] p;

    eog_mul #(.AW(AW), .BW(BW), .A_SIGNED(AS), .B_SIGNED(BS), .LAT(LAT)) dut (.clk(clk), .a(a), .b(b), .p(p));

    function automatic [PW-1:0] ref_mul(input logic [AW-1:0] x, input logic [BW-1:0] y);
        logic [PW-1:0] xx, yy;
        xx = (AS != 0) ? {{BW{x[AW-1]}}, x} : {{BW{1'b0}}, x};
        yy = (BS != 0) ? {{AW{y[BW-1]}}, y} : {{AW{1'b0}}, y};
        ref_mul = xx * yy;
    endfunction

    function automatic [AW-1:0] a_corner(input integer i);
        case (i)
            0: a_corner = '0;
            1: a_corner = 1;
            2: a_corner = 2;
            3: a_corner = ~(AW'(1));               // -2 / all but the lsb
            4: a_corner = '1;                      // -1 / max unsigned
            5: a_corner = {1'b1, {(AW-1){1'b0}}};  // signed min
            6: a_corner = {1'b0, {(AW-1){1'b1}}};  // signed max
            7: a_corner = AW'(32'h5555_5555);
            default: a_corner = AW'(32'hAAAA_AAAA);
        endcase
    endfunction

    function automatic [BW-1:0] b_corner(input integer i);
        case (i)
            0: b_corner = '0;
            1: b_corner = 1;
            2: b_corner = 2;
            3: b_corner = ~(BW'(1));
            4: b_corner = '1;
            5: b_corner = {1'b1, {(BW-1){1'b0}}};
            6: b_corner = {1'b0, {(BW-1){1'b1}}};
            7: b_corner = BW'(32'h5555_5555);
            default: b_corner = BW'(32'hAAAA_AAAA);
        endcase
    endfunction

    integer        seed;
    integer        k;                 // operand set index (cycle)
    logic [PW-1:0] hist [0:LAT];      // hist[i] = expected product of the operands i cycles ago
    // first mismatch
    integer        e_k;
    logic [AW-1:0] e_a;
    logic [BW-1:0] e_b;
    logic [PW-1:0] e_exp, e_got;
    logic [AW-1:0] a_h [0:LAT];
    logic [BW-1:0] b_h [0:LAT];

    initial begin
        seed   = 32'h5EED_0000 + ID * 7919;
        k      = 0;
        err    = 1'b0;
        cov_ok = (NCOR * NCOR + EXH == 0);
        n_chk  = 0;
        a      = '0;
        b      = '0;
    end

    task automatic pick_operands(input integer idx);
        integer r, m;
        if (idx < NCOR * NCOR) begin
            a = a_corner(idx / NCOR);
            b = b_corner(idx % NCOR);
        end else if (idx < NCOR * NCOR + EXH) begin
            m = idx - NCOR * NCOR;
            a = AW'(m);
            b = BW'(m >> AW);
        end else begin
            r = $random(seed);
            case (r[1:0])
                2'd0:    a = a_corner($unsigned($random(seed)) % NCOR);
                2'd1:    a = {{(AW-4){r[7]}}, r[7:4]};
                default: a = AW'($random(seed));
            endcase
            case (r[3:2])
                2'd0:    b = b_corner($unsigned($random(seed)) % NCOR);
                2'd1:    b = {{(BW-4){r[11]}}, r[11:8]};
                default: b = BW'($random(seed));
            endcase
        end
        if (idx == NCOR * NCOR + EXH) cov_ok = 1'b1;
    endtask

    always @(negedge clk) begin : drive_check
        integer i;
        pick_operands(k);
        for (i = LAT; i > 0; i = i - 1) begin
            hist[i] = hist[i-1];
            a_h[i]  = a_h[i-1];
            b_h[i]  = b_h[i-1];
        end
        hist[0] = ref_mul(a, b);
        a_h[0]  = a;
        b_h[0]  = b;
        #1;
        if (k >= LAT) begin
            n_chk = n_chk + 1;
            if (p !== hist[LAT] && !err) begin
                err   = 1'b1;
                e_k   = k;
                e_a   = a_h[LAT];
                e_b   = b_h[LAT];
                e_exp = hist[LAT];
                e_got = p;
            end
        end
        k = k + 1;
    end

    always @(posedge report)
        $display("FAIL: AW=%0d BW=%0d A_SIGNED=%0d B_SIGNED=%0d LAT=%0d cycle %0d: a=0x%h b=0x%h p expected 0x%h got 0x%h",
                 AW, BW, AS, BS, LAT, e_k, e_a, e_b, e_exp, e_got);
endmodule

// ---------------------------------------------------------------------------------------------------------------
module tb_eog_mul;
    localparam integer NCFG = 36;             // 3 width pairs x 4 sign combinations x 3 latencies
    localparam integer NCYC = 81 + 16384 + 4000;

    logic clk = 1'b0;
    always #5 clk = ~clk;

    logic [NCFG-1:0]    err_bus, cov_bus, report_bus;
    logic [NCFG*32-1:0] cnt_bus;

    genvar w, s, l;
    generate
        for (w = 0; w < 3; w = w + 1) begin : g_w
            for (s = 0; s < 4; s = s + 1) begin : g_s
                for (l = 0; l < 3; l = l + 1) begin : g_l
                    localparam integer IDX = w * 12 + s * 3 + l;
                    tb_mul_chk #(
                        .AW ((w == 0) ? 6 : (w == 1) ? 20 : 16),
                        .BW ((w == 0) ? 8 : (w == 1) ? 32 : 16),
                        .AS ((s >> 1) & 1), .BS (s & 1), .LAT (l), .ID (IDX)
                    ) u_chk (
                        .clk(clk), .report(report_bus[IDX]), .err(err_bus[IDX]), .cov_ok(cov_bus[IDX]),
                        .n_chk(cnt_bus[IDX*32 +: 32])
                    );
                end
            end
        end
    endgenerate

    integer cyc, i, total;
    initial begin
        report_bus = '0;
        for (cyc = 0; cyc < NCYC; cyc = cyc + 1) begin
            @(negedge clk);
            #2;
            if (|err_bus) begin
                for (i = NCFG - 1; i >= 0; i = i - 1)
                    if (err_bus[i]) begin report_bus = '0; report_bus[i] = 1'b1; end
                #1 $finish;
            end
        end
        total = 0;
        for (i = 0; i < NCFG; i = i + 1) begin
            total = total + cnt_bus[i*32 +: 32];
            if (cnt_bus[i*32 +: 32] == 0 || !cov_bus[i]) begin
                $display("FAIL: configuration %0d did not complete its corner/exhaustive phases (%0d checks)",
                         i, cnt_bus[i*32 +: 32]);
                $finish;
            end
        end
        $display("PASS: %0d products checked (%0d configurations: 6x8 exhaustive, 20x32, 16x16; all A_SIGNED/B_SIGNED; LAT 0,1,2)",
                 total, NCFG);
        $finish;
    end
endmodule

`default_nettype wire
