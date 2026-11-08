// eog_mul_unit.sv -- formal-only stand-in for rtl/eog_mul.sv used by eog_head's bmc_unit task (Verify role,
// task T1.head.fv). Same name, parameters and ports as eog_mul.
//
// The product is EXACT whenever one operand is 0, 1 or -1 (-1 only for a signed operand): p = 0, the other operand
// sign-extended, or its negation. Any other operand pair gives an unconstrained product ($anyseq), as in
// formal/common/eog_mul_abstract.sv. So this is a sound over-approximation of eog_mul (every behaviour of the real
// multiplier is one of its behaviours), and with the harness's features restricted to {0, 1, -1} (FSET 5) every
// product the head's logits depend on is exact: the solver checks the head's operand wiring, sign handling,
// accumulation width and output rounding without bit-blasting a multiplier (the real-multiplier bmc did not finish
// a single nonzero-product step in 10 minutes). The multiplier's own values are proven by T1.mul (formal/mul) and
// exercised on real data by tb/head.
//
// Yosys-only (uses $anyseq); never compile it into simulation or synthesis.

module eog_mul #(
    parameter integer AW       = 20,
    parameter integer BW       = 32,
    parameter integer A_SIGNED = 1,
    parameter integer B_SIGNED = 0,
    parameter integer LAT      = 2
) (
    input  logic                 clk,
    input  logic [AW-1:0]        a,
    input  logic [BW-1:0]        b,
    output logic [AW+BW-1:0]     p
);
    localparam integer PW = AW + BW;

    logic [PW-1:0] a_x, b_x;     // operands extended to the product width per their signedness
    assign a_x = (A_SIGNED != 0) ? {{BW{a[AW-1]}}, a} : {{BW{1'b0}}, a};
    assign b_x = (B_SIGNED != 0) ? {{AW{b[BW-1]}}, b} : {{AW{1'b0}}, b};

    logic          a_m1, b_m1;   // operand is -1 (signed operands only)
    assign a_m1 = (A_SIGNED != 0) && (a == {AW{1'b1}});
    assign b_m1 = (B_SIGNED != 0) && (b == {BW{1'b1}});

    logic          known_now;
    logic [PW-1:0] exact_now;
    always_comb begin
        known_now = 1'b1;
        if (a == '0 || b == '0)       exact_now = '0;
        else if (b == {{(BW-1){1'b0}}, 1'b1}) exact_now = a_x;
        else if (a == {{(AW-1){1'b0}}, 1'b1}) exact_now = b_x;
        else if (b_m1)                exact_now = '0 - a_x;
        else if (a_m1)                exact_now = '0 - b_x;
        else begin
            known_now = 1'b0;
            exact_now = '0;
        end
    end

    logic [PW-1:0] any_p;
    assign any_p = $anyseq;

    generate
        if (LAT == 0) begin : g_comb
            assign p = known_now ? exact_now : any_p;
        end else begin : g_pipe
            logic [LAT-1:0]    k_d;
            logic [LAT*PW-1:0] e_d;
            always_ff @(posedge clk) begin
                k_d[0]      <= known_now;
                e_d[0 +: PW] <= exact_now;
                for (int i = 1; i < LAT; i++) begin
                    k_d[i]          <= k_d[i-1];
                    e_d[i*PW +: PW] <= e_d[(i-1)*PW +: PW];
                end
            end
            assign p = k_d[LAT-1] ? e_d[(LAT-1)*PW +: PW] : any_p;
        end
    endgenerate
endmodule
