// eog_mul_concat.sv -- formal-only stand-in for eog_mul, used by the `prove_f4` task of eog_features.sby
// (task T1.features.fv). Same module name, parameters and ports as rtl/eog_mul.sv; list this file INSTEAD of
// rtl/eog_mul.sv. Never compile it into simulation or synthesis.
//
// Why: F4 (every channel = sat16((x*M + 2^16) >>> 17), FEAT_SAT iff a channel saturates) needs the product's
// value, but proving a 20x32 multiplier equal to a harness-side reference multiplier is out of reach for SAT
// (T1.mul.fv: a 16x16 equivalence at depth 1 did not finish in 300 s). eog_mul itself is proven separately
// (formal/mul) and simulated against 736k products (tb/mul). So F4 is split:
//
//     eog_features(real eog_mul) = post(eog_mul(pre(record)))
//     formal/mul proves  eog_mul = a*b;      prove_f4 proves  post(P(pre(r))) = ref(P(x_c, M_c))  for all r
//
// where P is this module's cheap, multiplier-like stand-in for a*b and the harness reference uses the same P.
// P agrees with a*b wherever a*b has a property a design could rely on:
//   - P(a, b) = 0 iff a = 0 or b = 0;  P(1, b) = b;  P(-1, b) = -b  (exact product for |a| <= 1);
//   - P(-a, b) = -P(a, b), sign(P) = sign(a) for b != 0;  |P| < 2^51 (fits the 52-bit product, as a*b does).
// and it is injective on a, b != 0, so a wrong operand (wrong field, wrong multiplier, truncated difference) shows up
// as a different output. Its image covers every value in [-(2^32-1), 2^32-1] (|a| = 1: all rounding cases and
// both saturation boundaries) and, for |a| >= 2, every low 32-bit pattern of a saturating product.
//
//   P(a, b) = 0                 if a == 0 or b == 0
//           = {a - 1, b}        if a > 0          ((a-1)*2^32 + b, as a 52-bit value)
//           = -{~a, b}          if a < 0          (-(|a|-1)*2^32 - b; ~a = |a| - 1)
//
// The proof is sound for a design that forms each multiplied channel's product with one eog_mul call on
// a = x_c (signed 20-bit) and b = M_c (unsigned 32-bit), the shape numerics.md §4 / D3 prescribe ("signed 20-bit x
// unsigned 32-bit"). A design that splits a channel over several calls (e.g. PUMP_FLOW*M - RECV_FLOW*M) would fail
// prove_f4 although correct; F4 then rests on simulation (tb/features, bit-exact on every golden record).
//
// Product timing is exactly eog_mul's: valid LAT cycles after a / b (LAT = 0: combinational).

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

    // The stand-in is defined for the configuration eog_features.md prescribes (AW = 20, BW = 32, A signed,
    // B unsigned). Any other instance gets an unconstrained product, and the harness's F4 then fails: a features
    // design using another configuration disagrees with the spec.
    localparam bit SPEC_CFG = (AW == 20) && (BW == 32) && (A_SIGNED != 0) && (B_SIGNED == 0);

    logic [PW-1:0] any_p;
    assign any_p = $anyseq;

    logic [PW-1:0] pc;
    always_comb begin
        if (!SPEC_CFG) pc = any_p;
        else if (a == '0 || b == '0) pc = '0;
        else if (!a[AW-1]) pc = {a - 1'b1, b};
        else pc = -{~a, b};
    end

    generate
        if (LAT <= 0) begin : g_comb
            assign p = pc;
        end else begin : g_pipe
            logic [LAT*PW-1:0] sr;
            always_ff @(posedge clk) begin
                sr[PW-1:0] <= pc;
                for (int i = 1; i < LAT; i++) sr[i*PW +: PW] <= sr[(i-1)*PW +: PW];
            end
            assign p = sr[(LAT-1)*PW +: PW];
        end
    endgenerate
endmodule
