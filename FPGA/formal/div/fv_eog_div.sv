// fv_eog_div.sv — formal harness for eog_div (Verify role, task T1.div.fv).
//
// Written from spec/modules/eog_div.md (spec v2, FROZEN) and its port table only; the RTL internals are not read.
// Run with `bash scripts/formal.sh div` (formal/div/eog_div.sby).
//
// eog_div has no in_ready (every in_valid is accepted) and no REC_NO, so the shared eog_fv_axis/eog_fv_stage
// checkers do not apply; the stage-contract equivalents are below:
//   - one in, one out, in order: P1 (out_valid is in_valid delayed by exactly LAT) + P4 (tag_out is tag_in
//     delayed by exactly LAT) together say every accepted division produces exactly one output, LAT cycles later,
//     in acceptance order, and nothing is invented.
//   - II <= 16: trivially II = 1 (always accepts).
//   - latency <= 128: LAT = NW + 1 = 49 at the design widths (NW = 48); P1 pins the exact latency.
//
// Shadow model: a LAT-deep shift register of {in_valid & rst_n, n, d, tag_in} built in the harness. The valid
// chain is ANDed with rst_n at every step, so an in_valid in a reset cycle is not a division and a reset kills
// everything in flight; "after reset: 0 for the first LAT cycles" (P1) follows.
//
// LAT: the spec fixes LAT = NW + 1 and says an RTL with a different latency must export `localparam LAT` *and*
// raise a spec question. The harness computes NW + 1 from the spec rather than reading dut.LAT (hierarchical
// references are banned by FPGA/AGENTS.md coding rules and not portable in Yosys); if the spec changes the latency,
// change F_LAT here.

`default_nettype none

module fv_eog_div #(
    parameter integer NW = 8,
    parameter integer DW = 5,
    parameter integer TW = 2
) (
    input  logic          clk,
    input  logic          rst_n,
    input  logic          in_valid,
    input  logic [NW-1:0] n,
    input  logic [DW-1:0] d,
    input  logic [TW-1:0] tag_in
);
    localparam integer F_LAT = NW + 1;    // spec: LAT = NW + 1

    // ---------------------------------------------------------------------------------------------------------
    // DUT
    logic          out_valid;
    logic [NW-1:0] q;
    logic [DW-1:0] r;
    logic [TW-1:0] tag_out;

    eog_div #(.NW(NW), .DW(DW), .TW(TW)) dut (
        .clk      (clk),
        .rst_n    (rst_n),
        .in_valid (in_valid),
        .n        (n),
        .d        (d),
        .tag_in   (tag_in),
        .out_valid(out_valid),
        .q        (q),
        .r        (r),
        .tag_out  (tag_out)
    );

    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    // ---------------------------------------------------------------------------------------------------------
    // Shadow pipeline (packed, stage 0 = newest)
    logic [F_LAT-1:0]    sh_v;
    logic [F_LAT*NW-1:0] sh_n;
    logic [F_LAT*DW-1:0] sh_d;
    logic [F_LAT*TW-1:0] sh_t;

    initial sh_v = '0;
    always_ff @(posedge clk) begin
        sh_v <= {sh_v[F_LAT-2:0] & {(F_LAT-1){rst_n}}, in_valid & rst_n};
        sh_n <= {sh_n[(F_LAT-1)*NW-1:0], n};
        sh_d <= {sh_d[(F_LAT-1)*DW-1:0], d};
        sh_t <= {sh_t[(F_LAT-1)*TW-1:0], tag_in};
    end

    logic          e_v;      // a division accepted exactly LAT cycles ago, no reset since
    logic [NW-1:0] e_n;
    logic [DW-1:0] e_d;
    logic [TW-1:0] e_t;
    assign e_v = sh_v[F_LAT-1];
    assign e_n = sh_n[F_LAT*NW-1 -: NW];
    assign e_d = sh_d[F_LAT*DW-1 -: DW];
    assign e_t = sh_t[F_LAT*TW-1 -: TW];

    // Arithmetic at NW + DW + 1 bits (no wrap: q*d + r < 2^(NW+DW) for any q, d, r of these widths)
    localparam integer XW = NW + DW + 1;
    logic [XW-1:0] f_q, f_r, f_d, f_n, f_qd_r;
    assign f_q    = XW'(q);
    assign f_r    = XW'(r);
    assign f_d    = XW'(e_d);
    assign f_n    = XW'(e_n);
    assign f_qd_r = f_q * f_d + f_r;

    // ---------------------------------------------------------------------------------------------------------
    // Required properties (spec/modules/eog_div.md)
    always_comb begin
        if (f_past_valid) begin
            // P1: out_valid is in_valid delayed by exactly LAT; 0 for the first LAT cycles after reset.
            P1: assert (out_valid == e_v);

            if (e_v) begin
                // P4: tag_out is tag_in delayed by LAT.
                P4: assert (tag_out == e_t);

                if (e_d != '0) begin
                    // P2: for d != 0, q*d + r == n and r < d (unique: q = floor(n/d), r = n mod d).
                    P2_eq: assert (f_qd_r == f_n);
                    P2_lt: assert (r < e_d);
                end else begin
                    // P3: d == 0 -> q all ones.
                    P3: assert (q == '1);
                    // P3_r (port table, row `r`): d == 0 -> r = n truncated to DW (zero-extended if DW > NW).
                    P3_r: assert (f_r == (f_n & ((XW'(1) << DW) - XW'(1))));
                end
            end
        end
    end

    // ---------------------------------------------------------------------------------------------------------
    // Cover goals
    logic f_prev_ov, f_prev_ev;
    initial begin
        f_prev_ov = 1'b0;
        f_prev_ev = 1'b0;
    end
    always_ff @(posedge clk) begin
        f_prev_ov <= out_valid;
        f_prev_ev <= e_v;
    end

    always_comb begin
        if (f_past_valid) begin
            // C1 (spec): two back-to-back divisions complete on consecutive cycles.
            C1_b2b:   cover (out_valid && e_v && f_prev_ov && f_prev_ev);
            // Extra reachability (not in the spec's cover list; sanity that P2/P3 are not vacuous)
            C2_dzero: cover (out_valid && e_v && e_d == '0);
            C3_max:   cover (out_valid && e_v && e_d == DW'(1) && e_n == '1);
            C4_nltd:  cover (out_valid && e_v && e_d != '0 && XW'(e_n) < XW'(e_d) && e_n != '0);
            C5_rem:   cover (out_valid && e_v && e_d > DW'(1) && r == e_d - DW'(1));
        end
    end

endmodule

`default_nettype wire
