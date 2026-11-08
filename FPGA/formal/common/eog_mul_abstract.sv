// eog_mul_abstract — formal-only stand-in for rtl/eog_mul.sv (spec/modules/eog_mul.md, "Abstract model").
//
// Same name, parameters and ports as eog_mul. The product is unconstrained ($anyseq) except that it is 0
// whenever either operand was 0, LAT cycles earlier (LAT = 0: same cycle). A module's `prove` task lists this
// file instead of rtl/eog_mul.sv, so k-induction never bit-blasts a multiplier. Properties that depend on the
// product's value belong in `bmc` with the real eog_mul.
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
    logic zero_now;
    assign zero_now = (a == '0) || (b == '0);

    logic [AW+BW-1:0] any_p;
    assign any_p = $anyseq;

    generate
        if (LAT == 0) begin : g_comb
            assign p = zero_now ? '0 : any_p;
        end else if (LAT == 1) begin : g_one
            logic zero_d;
            always_ff @(posedge clk) zero_d <= zero_now;
            assign p = zero_d ? '0 : any_p;
        end else begin : g_pipe
            logic [LAT-1:0] zero_d;
            always_ff @(posedge clk) zero_d <= {zero_d[LAT-2:0], zero_now};
            assign p = zero_d[LAT-1] ? '0 : any_p;
        end
    endgenerate

    // A_SIGNED / B_SIGNED only change the meaning of the (unconstrained) product.
    logic unused_ok;
    assign unused_ok = (A_SIGNED != 0) ^ (B_SIGNED != 0);
endmodule
