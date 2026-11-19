// eog_div -- the engine's only divider (spec/modules/eog_div.md, spec v1).
//
// Unsigned restoring division, fully pipelined: one division accepted every cycle, no back-pressure,
// fixed latency LAT = NW + 1 (one input register + one register per quotient bit).
//
//   q = floor(n / d), r = n - q*d             for d != 0
//   q = all ones,     r = n truncated to DW   for d == 0
//
// The d == 0 case needs no special logic: every step compares against 0, so every quotient bit is 1, and the
// partial remainder just collects the last DW numerator bits.
//
// Stage s (0..NW) holds: valid, d, partial remainder (DW bits), a combined numerator/quotient shift register
// (NW bits: the NW-s numerator bits still to consume in the top, the s quotient bits produced so far in the
// bottom) and the tag. Stage 0 is the input register; stage s+1 = step(stage s); outputs come from stage NW.
// Only the valid bits are reset; payload registers run free (they are only read when valid).

module eog_div #(
    parameter integer NW = 48,   // numerator width (>= 1)
    parameter integer DW = 32,   // denominator width (>= 1)
    parameter integer TW = 4     // tag width (>= 1)
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
    // Waiver: eog_defs.svh is the shared constant table; this helper uses none of it, but conventions section 6 requires
    // the include in every module.
    /* verilator lint_off UNUSEDPARAM */
    `include "eog_defs.svh"
    /* verilator lint_on UNUSEDPARAM */

    // Waiver: LAT is exported for callers and harnesses (spec: "export it as localparam LAT"); not used here.
    /* verilator lint_off UNUSEDPARAM */
    localparam integer LAT = NW + 1;
    /* verilator lint_on UNUSEDPARAM */
    localparam integer NS  = NW + 1;   // number of register stages (0..NW)

    // Flat per-stage registers: stage s lives at [s*W +: W]. d is not needed in the last stage.
    logic [NS-1:0]    v_s;
    logic [NW*DW-1:0] d_s;
    logic [NS*DW-1:0] rem_s;
    logic [NS*NW-1:0] nq_s;
    logic [NS*TW-1:0] tag_s;

    // ---- stage 0: input register ----
    always_ff @(posedge clk) begin
        if (!rst_n) v_s[0] <= 1'b0;
        else        v_s[0] <= in_valid;
        d_s[0 +: DW]   <= d;
        rem_s[0 +: DW] <= '0;
        nq_s[0 +: NW]  <= n;
        tag_s[0 +: TW] <= tag_in;
    end

    // ---- stages 1..NW: one restoring step each ----
    genvar s;
    generate
        for (s = 0; s < NW; s = s + 1) begin : g_step
            logic [DW-1:0] d_c, rem_c;
            logic [NW-1:0] nq_c, nq_n;
            logic [DW:0]   t;      // {remainder, next numerator bit}
            logic [DW-1:0] t_sub;  // t - d, only used when t >= d (then it is < d, so DW bits suffice)
            logic          ge;     // t >= d  -> quotient bit 1

            assign d_c   = d_s[s*DW +: DW];
            assign rem_c = rem_s[s*DW +: DW];
            assign nq_c  = nq_s[s*NW +: NW];
            assign t     = {rem_c, nq_c[NW-1]};
            assign t_sub = t[DW-1:0] - d_c;
            assign ge    = (t >= {1'b0, d_c});
            always_comb begin
                nq_n    = nq_c << 1;   // consume the top numerator bit ...
                nq_n[0] = ge;          // ... and shift in the new quotient bit
            end

            always_ff @(posedge clk) begin
                if (!rst_n) v_s[s+1] <= 1'b0;
                else        v_s[s+1] <= v_s[s];
                rem_s[(s+1)*DW +: DW] <= ge ? t_sub : t[DW-1:0];
                nq_s[(s+1)*NW +: NW]  <= nq_n;
                tag_s[(s+1)*TW +: TW] <= tag_s[s*TW +: TW];
            end
            if (s + 1 < NW) begin : g_d
                always_ff @(posedge clk) d_s[(s+1)*DW +: DW] <= d_c;
            end
        end
    endgenerate

    // ---- outputs: stage NW ----
    assign out_valid = v_s[NW];
    assign q         = nq_s[NW*NW +: NW];
    assign r         = rem_s[NW*DW +: DW];
    assign tag_out   = tag_s[NW*TW +: TW];

`ifdef FORMAL
    // Internal invariants (help k-induction; about this module's own state only).
    // f_rst_seen: a reset cycle has happened, so every valid stage was loaded from a real input.
    logic f_rst_seen;
    initial f_rst_seen = 1'b0;
    always @(posedge clk) if (!rst_n) f_rst_seen <= 1'b1;  // plain always: it also has an initial value

    genvar fs;
    generate
        for (fs = 0; fs < NW; fs = fs + 1) begin : g_fv  // stage NW (the outputs) is the harness's job
            localparam logic [NW-1:0] FQMASK = {NW{1'b1}} >> (NW - fs);  // low fs bits = quotient so far
            logic [DW-1:0] fd, frem;
            logic [NW-1:0] fnq;
            assign fd   = d_s[fs*DW +: DW];
            assign frem = rem_s[fs*DW +: DW];
            assign fnq  = nq_s[fs*NW +: NW];
            always_comb begin
                if (f_rst_seen && v_s[fs]) begin
                    // d != 0: the partial remainder is always below the divisor.
                    if (fd != '0) assert (frem < fd);
                    // d == 0: every quotient bit produced so far is 1.
                    if (fd == '0) assert ((fnq & FQMASK) == FQMASK);
                end
            end
        end
    endgenerate
`endif
endmodule
