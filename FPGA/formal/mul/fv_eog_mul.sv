// fv_eog_mul.sv — formal harness for eog_mul (spec/modules/eog_mul.md, spec v2). Verify role, task T1.mul.fv.
//
// Written from the spec's parameter/port tables only; it does not look inside rtl/eog_mul.sv.
// eog_mul has no reset and no handshake, so eog_fv_init / eog_fv_axis / eog_fv_stage do not apply.
//
// Top fv_eog_mul checks every sign combination selected by SMASK (bit s <-> A_SIGNED = s[1], B_SIGNED = s[0])
// and, when P1_ON = 1, every LAT in 0..LMAX, all fed from the same free operands a, b; a2, b2 are a second,
// independent pair of free operands for the P2 miter. Each (sign combination, LAT) check is its own module
// instance (Yosys does not scope assertion labels by generate block), so a failing property is reported with its
// instance path, e.g. `g_s[2].g_on.g_p1.g_lat[1].u_p1 ... P1` (g_s index = {A_SIGNED, B_SIGNED}, g_lat = LAT).
//
// Reference product (spec: "signed product of a and b (as typed by the parameters), sign-extended"): extend each
// operand to PW = AW+BW bits (sign- or zero-extension per A_SIGNED / B_SIGNED) and multiply modulo 2^PW. For every
// sign combination the exact product fits in PW bits (two's complement when either operand is signed, unsigned
// when both are unsigned), so this is the exact product.
//
// Properties (labels are the spec IDs):
//   P1  p == a*b of exactly LAT cycles earlier, every cycle once LAT cycles have elapsed (no reset, so the
//       first LAT outputs are don't-care). Operands change freely every cycle, so a design with any other
//       latency, or one whose registered output still leaks the current operands, fails.
//   P2  LAT = 0: p is a pure function of (a, b). Two LAT = 0 instances with independent operand histories
//       (and independent initial states) must agree whenever their current operands agree.
//   A1  (not a spec ID; documents that formal/common/eog_mul_abstract.sv is a sound abstraction of the real
//       multiplier) an operand that was 0 LAT cycles earlier gives p == 0. Implied by P1; kept as its own label.
// Cover (per sign combination and LAT): C_max the largest-magnitude product reaches p; C_neg a negative product
// reaches p (when an operand is signed).

`default_nettype none

// ---------------------------------------------------------------------------------------------------------------
// Reference product of the current operands, modulo 2^(AW+BW).
module fv_mul_ref #(
    parameter integer AW = 6, parameter integer BW = 8, parameter integer AS = 1, parameter integer BS = 0
) (
    input  logic [AW-1:0]    a,
    input  logic [BW-1:0]    b,
    output logic [AW+BW-1:0] p
);
    logic [AW+BW-1:0] xa, xb;
    assign xa = (AS != 0) ? {{BW{a[AW-1]}}, a} : {{BW{1'b0}}, a};
    assign xb = (BS != 0) ? {{AW{b[BW-1]}}, b} : {{AW{1'b0}}, b};
    assign p  = xa * xb;
endmodule

// ---------------------------------------------------------------------------------------------------------------
// P1 + A1 + covers for one (A_SIGNED, B_SIGNED, LAT).
module fv_mul_p1 #(
    parameter integer AW = 6, parameter integer BW = 8, parameter integer AS = 1, parameter integer BS = 0,
    parameter integer LAT = 2
) (
    input logic          clk,
    input logic [7:0]    f_cyc,   // cycles since the start of the trace (saturating above the largest LAT)
    input logic [AW-1:0] a,
    input logic [BW-1:0] b
);
    localparam integer PW = AW + BW;

    logic [PW-1:0] p, f_exp;
    eog_mul #(.AW(AW), .BW(BW), .A_SIGNED(AS), .B_SIGNED(BS), .LAT(LAT)) dut (.clk(clk), .a(a), .b(b), .p(p));
    fv_mul_ref #(.AW(AW), .BW(BW), .AS(AS), .BS(BS)) u_ref (.a(a), .b(b), .p(f_exp));

    // want = reference product of the operands LAT cycles ago; want_zero = an operand was 0 LAT cycles ago
    logic [PW-1:0] want;
    logic          want_zero;
    generate
        if (LAT == 0) begin : g_comb
            assign want      = f_exp;
            assign want_zero = (a == '0) || (b == '0);
        end else begin : g_dl
            // shift registers, newest in the low slice; the assignment drops the oldest slice (truncation)
            logic [LAT*PW-1:0] exp_q;
            logic [LAT-1:0]    zero_q;
            logic [(LAT+1)*PW-1:0] exp_n;
            logic [LAT:0]          zero_n;
            assign exp_n  = {exp_q, f_exp};
            assign zero_n = {zero_q, (a == '0) || (b == '0)};
            always_ff @(posedge clk) begin
                exp_q  <= exp_n[LAT*PW-1:0];
                zero_q <= zero_n[LAT-1:0];
            end
            assign want      = exp_q[(LAT-1)*PW +: PW];
            assign want_zero = zero_q[LAT-1];
        end
    endgenerate

    // largest-magnitude product for this sign combination (cover target): min*min, min*max, max*min, max*max
    localparam [AW-1:0] A_EXT  = (AS != 0) ? {1'b1, {(AW-1){1'b0}}} : {AW{1'b1}};
    localparam [BW-1:0] B_EXT  = (BS != 0) ? {1'b1, {(BW-1){1'b0}}} : {BW{1'b1}};
    localparam [PW-1:0] XA_EXT = (AS != 0) ? {{BW{1'b1}}, A_EXT} : {{BW{1'b0}}, A_EXT};
    localparam [PW-1:0] XB_EXT = (BS != 0) ? {{AW{1'b1}}, B_EXT} : {{AW{1'b0}}, B_EXT};
    localparam [PW-1:0] P_EXT  = XA_EXT * XB_EXT;

    always_comb begin
        if (f_cyc >= LAT) begin
            P1: assert (p == want);
            if (want_zero)
                A1: assert (p == '0);
            C_max: cover (p == P_EXT);
            if (AS != 0 || BS != 0)
                C_neg: cover (p[PW-1]);
        end
    end
endmodule

// ---------------------------------------------------------------------------------------------------------------
// P2 for one (A_SIGNED, B_SIGNED): LAT = 0 miter over two independent operand histories.
module fv_mul_p2 #(
    parameter integer AW = 6, parameter integer BW = 8, parameter integer AS = 1, parameter integer BS = 0
) (
    input logic          clk,
    input logic [AW-1:0] a,
    input logic [BW-1:0] b,
    input logic [AW-1:0] a2,
    input logic [BW-1:0] b2
);
    logic [AW+BW-1:0] p_a, p_b;
    eog_mul #(.AW(AW), .BW(BW), .A_SIGNED(AS), .B_SIGNED(BS), .LAT(0)) u_a (.clk(clk), .a(a),  .b(b),  .p(p_a));
    eog_mul #(.AW(AW), .BW(BW), .A_SIGNED(AS), .B_SIGNED(BS), .LAT(0)) u_b (.clk(clk), .a(a2), .b(b2), .p(p_b));

    always_comb
        if (a == a2 && b == b2)
            P2: assert (p_a == p_b);
endmodule

// ---------------------------------------------------------------------------------------------------------------
module fv_eog_mul #(
    parameter integer AW    = 6,
    parameter integer BW    = 8,
    parameter integer SMASK = 15,  // sign combinations to check, bit s = {A_SIGNED, B_SIGNED}
    parameter integer P1_ON = 1,   // 0: P2 only (used at the design widths, where P1 is checked in simulation)
    parameter integer LMAX  = 2    // P1 checks LAT = 0 .. LMAX
) (
    input logic          clk,
    input logic [AW-1:0] a,
    input logic [BW-1:0] b,
    input logic [AW-1:0] a2,
    input logic [BW-1:0] b2
);
    // Cycles since the start of the trace, saturating at LMAX + 1 (no reset: the DUT's pipeline starts arbitrary).
    logic [7:0] f_cyc;
    initial f_cyc = 8'd0;
    always_ff @(posedge clk)
        if (f_cyc <= LMAX) f_cyc <= f_cyc + 8'd1;

    genvar s, l;
    generate
        for (s = 0; s < 4; s = s + 1) begin : g_s
            if (((SMASK >> s) & 1) != 0) begin : g_on
                fv_mul_p2 #(.AW(AW), .BW(BW), .AS((s >> 1) & 1), .BS(s & 1))
                    u_p2 (.clk(clk), .a(a), .b(b), .a2(a2), .b2(b2));
                if (P1_ON != 0) begin : g_p1
                    for (l = 0; l <= LMAX; l = l + 1) begin : g_lat
                        fv_mul_p1 #(.AW(AW), .BW(BW), .AS((s >> 1) & 1), .BS(s & 1), .LAT(l))
                            u_p1 (.clk(clk), .f_cyc(f_cyc), .a(a), .b(b));
                    end
                end
            end
        end
    endgenerate
endmodule

`default_nettype wire
