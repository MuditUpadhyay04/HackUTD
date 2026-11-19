// eog_div_abstract.sv — formal-only stand-in for rtl/eog_div.sv, used by the eog_countdown `prove`, `bmc` and
// `cover` tasks (Verify role, task T1.countdown.fv). Yosys-only ($anyseq); never in simulation or synthesis.
//
// Same module name, parameters and ports as eog_div (spec/modules/eog_div.md). It keeps exactly the parts of the
// divider contract that the countdown's control depends on, and frees the arithmetic:
//   P1  out_valid = in_valid delayed by LAT = NW + 1 (a reset cycle kills everything in flight)
//   P4  tag_out   = tag_in   delayed by LAT
//   P3  d == 0 -> q all ones
//   q for d != 0 and r: unconstrained ($anyseq, may change every cycle)
// Every behavior of the real divider is a behavior of this model (P1, P3, P4 are its proven properties,
// formal/div), so a property proven with it holds with the real one. Properties that depend on quotient values
// (C4, C6) run against rtl/eog_div.sv in the `bmc_arith` task instead.

`default_nettype none

module eog_div #(
    parameter integer NW = 48,
    parameter integer DW = 32,
    parameter integer TW = 4
) (
    input  logic          clk,
    input  logic          rst_n,
    input  logic          in_valid,
    input  logic [NW-1:0] n,
    input  logic [DW-1:0] d,
    input  logic [TW-1:0] tag_in,
    output logic          out_valid,
    output logic [NW-1:0] q,
    output logic [DW-1:0] r,
    output logic [TW-1:0] tag_out
);
    localparam integer LAT = NW + 1;   // spec: LAT = NW + 1

    logic [LAT-1:0]    sv;   // valid chain, [0] = newest
    logic [LAT-1:0]    sz;   // d == 0 chain
    logic [LAT*TW-1:0] st;   // tag chain

    always_ff @(posedge clk) begin
        sv <= {sv[LAT-2:0] & {(LAT-1){rst_n}}, in_valid & rst_n};
        sz <= {sz[LAT-2:0], (d == '0)};
        st <= {st[(LAT-1)*TW-1:0], tag_in};
    end

    logic [NW-1:0] any_q;
    logic [DW-1:0] any_r;
    assign any_q = $anyseq;
    assign any_r = $anyseq;

    assign out_valid = sv[LAT-1];
    assign tag_out   = st[LAT*TW-1 -: TW];
    assign q         = sz[LAT-1] ? {NW{1'b1}} : any_q;
    assign r         = any_r;

    // n only matters to the real divider
    logic unused_n;
    assign unused_n = ^n;
endmodule

`default_nettype wire
