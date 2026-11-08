// eog_mul -- the engine's only multiplier (spec/modules/eog_mul.md, spec v1).
//
// p = a * b, with a / b two's complement when A_SIGNED / B_SIGNED is nonzero, unsigned otherwise. The product is
// exact in AW+BW bits for every signedness combination, so p is the full product (sign-extended when either
// operand is signed). p is valid exactly LAT cycles after a / b were presented:
//
//   LAT = 0   combinational
//   LAT = 1   multiply, then one output register
//   LAT >= 2  input registers (DSP48E1 A/B regs), multiply, then LAT-1 output registers (M/P regs and beyond)
//
// No reset and no handshake: a pure pipeline. Callers keep their own valid bits alongside.
// LAT must be >= 0.

module eog_mul #(
    parameter integer AW       = 20,
    parameter integer BW       = 32,
    parameter integer A_SIGNED = 1,
    parameter integer B_SIGNED = 0,
    parameter integer LAT      = 2
) (
    input  logic              clk,
    input  logic [AW-1:0]     a,
    input  logic [BW-1:0]     b,
    output logic [AW+BW-1:0]  p
);
    // Waiver: eog_defs.svh is the shared constant table for every module; this one uses none of it.
    /* verilator lint_off UNUSEDPARAM */
    `include "eog_defs.svh"
    /* verilator lint_on UNUSEDPARAM */

    localparam integer PW = AW + BW;

    // Operands as presented to the multiplier: the raw inputs (LAT <= 1) or their registered copies (LAT >= 2).
    logic [AW-1:0] ma;
    logic [BW-1:0] mb;

    // One extra bit per operand makes both signed, so a single signed multiply covers all four signedness cases.
    logic signed [AW:0] sa;
    logic signed [BW:0] sb;
    assign sa = (A_SIGNED != 0) ? $signed({ma[AW-1], ma}) : $signed({1'b0, ma});
    assign sb = (B_SIGNED != 0) ? $signed({mb[BW-1], mb}) : $signed({1'b0, mb});

    // The true product needs at most PW bits (signed results: |a*b| <= 2^(PW-2) for s x s, < 2^(PW-1) for s x u;
    // u x u: < 2^PW), so the product of the operands sign-extended to PW bits, taken modulo 2^PW, is exact.
    logic signed [PW-1:0] sa_x;
    logic signed [PW-1:0] sb_x;
    assign sa_x = PW'(sa);
    assign sb_x = PW'(sb);

    logic [PW-1:0] prod;
    assign prod = sa_x * sb_x;

    generate
        if (LAT <= 0) begin : g_comb
            assign ma = a;
            assign mb = b;
            assign p  = prod;
            // clk is a port of every instance but unused when combinational.
            logic unused_clk;
            assign unused_clk = clk;
        end else if (LAT == 1) begin : g_lat1
            logic [PW-1:0] p_q;
            assign ma = a;
            assign mb = b;
            always_ff @(posedge clk) p_q <= prod;
            assign p = p_q;
        end else begin : g_pipe
            logic [AW-1:0] a_q;
            logic [BW-1:0] b_q;
            always_ff @(posedge clk) begin
                a_q <= a;
                b_q <= b;
            end
            assign ma = a_q;
            assign mb = b_q;

            // LAT-1 product registers, flattened: stage i is p_sr[i*PW +: PW]; stage 0 takes the product,
            // stage LAT-2 drives p.
            logic [(LAT-1)*PW-1:0] p_sr;
            always_ff @(posedge clk) begin
                p_sr[PW-1:0] <= prod;
                for (int i = 1; i < LAT - 1; i++) p_sr[i*PW +: PW] <= p_sr[(i-1)*PW +: PW];
            end
            assign p = p_sr[(LAT-2)*PW +: PW];
        end
    endgenerate
endmodule
