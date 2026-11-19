// mul_real.sv — a reference `eog_mul` used only by the checker self-test (common.sby bmc/cover), so the
// self-test does not depend on rtl/eog_mul.sv (task T1.mul.rtl). Combinational/pipelined product.
module eog_mul #(
    parameter integer AW = 20, parameter integer BW = 32,
    parameter integer A_SIGNED = 1, parameter integer B_SIGNED = 0, parameter integer LAT = 2
) (
    input  logic              clk,
    input  logic [AW-1:0]     a,
    input  logic [BW-1:0]     b,
    output logic [AW+BW-1:0]  p
);
    logic signed [AW:0] sa;
    logic signed [BW:0] sb;
    assign sa = A_SIGNED ? {a[AW-1], a} : {1'b0, a};
    assign sb = B_SIGNED ? {b[BW-1], b} : {1'b0, b};
    logic signed [AW+BW+1:0] full;
    assign full = sa * sb;
    generate
        if (LAT == 0) begin : g0
            assign p = full[AW+BW-1:0];
        end else begin : gp
            logic [AW+BW-1:0] d [0:LAT-1];
            always_ff @(posedge clk) begin
                d[0] <= full[AW+BW-1:0];
                for (int i = 1; i < LAT; i++) d[i] <= d[i-1];
            end
            assign p = d[LAT-1];
        end
    endgenerate
endmodule
