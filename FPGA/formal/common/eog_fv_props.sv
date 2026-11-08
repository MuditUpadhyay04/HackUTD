// eog_fv_props.sv — shared formal checkers (Lead, task T0.3). Formal only: list this file in a .sby [files]
// section and `read_verilog -formal -sv` it; never put it in a tb/*/files.f.
//
// They are modules, not macros, so a harness can instantiate one per link without name clashes. Yosys checks
// assert/assume/cover statements inside submodules, and their property names show up in the sby log
// with the instance path (e.g. `u_in.ax_hold`), which maps reports back to the checklist.
//
//   eog_fv_init   first-cycle reset assumption + f_past_valid
//   eog_fv_axis   handshake rules of conventions §2 on one link; ASSUME=1 for an input link, 0 for an output
//   eog_fv_stage  stage contract of conventions §3: one in -> one out, in order (REC_NO), in-flight bound,
//                 II <= II_MAX and latency <= LAT_MAX under the conditions the spec states
//
// Rules 3 and 4 of conventions §2 (no combinational valid<->ready paths) are structural; Verilator lint
// (UNOPTFLAT) and the top-level integration catch loops. They are not expressible as immediate assertions.

// ---------------------------------------------------------------------------------------------------------
// eog_fv_init: assume rst_n = 0 in the first cycle; f_past_valid = 1 from the second cycle on.
module eog_fv_init (
    input  logic clk,
    input  logic rst_n,
    output logic f_past_valid
);
    initial f_past_valid = 1'b0;
    always_ff @(posedge clk) f_past_valid <= 1'b1;
    always_comb if (!f_past_valid) assume (!rst_n);
endmodule

// ---------------------------------------------------------------------------------------------------------
// eog_fv_axis: valid/ready rules on one link.
//   ASSUME = 1: the link is an input of the DUT (assume the upstream follows the rules).
//   ASSUME = 0: the link is an output of the DUT (assert the DUT follows them).
// Checked: (R0) valid is 0 in the cycle after a reset cycle; (R2) once valid is 1 it stays 1, with data
// unchanged, until the transfer.
module eog_fv_axis #(
    parameter integer W      = 1,
    parameter integer ASSUME = 0
) (
    input  logic         clk,
    input  logic         rst_n,
    input  logic         f_past_valid,
    input  logic         valid,
    input  logic         ready,
    input  logic [W-1:0] data
);
    generate
        if (ASSUME != 0) begin : g_assume
            always_ff @(posedge clk) begin
                if (f_past_valid && !$past(rst_n))
                    ax_reset: assume (!valid);
                if (f_past_valid && $past(rst_n) && $past(valid) && !$past(ready)) begin
                    ax_hold:  assume (valid);
                    ax_data:  assume (data == $past(data));
                end
            end
        end else begin : g_assert
            always_ff @(posedge clk) begin
                if (f_past_valid && !$past(rst_n))
                    ax_reset: assert (!valid);
                if (f_past_valid && $past(rst_n) && $past(valid) && !$past(ready)) begin
                    ax_hold:  assert (valid);
                    ax_data:  assert (data == $past(data));
                end
            end
        end
    endgenerate
endmodule

// ---------------------------------------------------------------------------------------------------------
// eog_fv_stage: the stage contract, using REC_NO.
//
// The checker *assumes* the input REC_NO is a counter (0, 1, 2, ... of accepted inputs since reset) and
// *asserts* that every output carries the REC_NO of the oldest input not yet output. Together with
// `in_flight` never going negative that is "one in, one out, in order, nothing invented, nothing lost".
// (Loss shows up as in_flight growing past MAX_INFLIGHT, or as a liveness failure below.)
//
//   MAX_INFLIGHT  records a stage may hold (accepted, output not yet transferred). 1-record-at-a-time
//                 stages: 1. Asserted, and it keeps induction finite.
//   II_MAX        with in_valid = 1 and out_ready = 1 on every cycle of a window, the stage accepts an
//                 input at least once every II_MAX cycles. Not checked during the first SWEEP cycles after
//                 reset (RAM-clearing sweep, conventions §1) or while `excl` = 1 (e.g. eog_alarm's
//                 acknowledge sweep). II_MAX = 0 disables the check.
//   LAT_MAX       with out_ready = 1 on every cycle, the oldest in-flight record shows out_valid within
//                 LAT_MAX cycles of becoming the oldest. LAT_MAX = 0 disables the check.
//   RW            width of REC_NO compared (32 in the spec; a harness may compare fewer low bits to keep
//                 the counters small, e.g. 8 — wrap-around is consistent on both sides).
//
//   dut_inflight / dut_oldest  the DUT's formal observation ports (spec conventions �7): records held, and
//                 the REC_NO of the oldest one. Asserted equal to the checker's own view (st_link_*).
//
// Outputs f_in_cnt / f_out_cnt (low RW bits) and f_in_flight so a harness can build per-record shadows.
module eog_fv_stage #(
    parameter integer RW           = 32,
    parameter integer MAX_INFLIGHT = 1,
    parameter integer II_MAX       = 16,
    parameter integer LAT_MAX      = 128,
    parameter integer SWEEP        = 0
) (
    input  logic          clk,
    input  logic          rst_n,
    input  logic          f_past_valid,
    input  logic          in_valid,
    input  logic          in_ready,
    input  logic [RW-1:0] in_recno,
    input  logic          out_valid,
    input  logic          out_ready,
    input  logic [RW-1:0] out_recno,
    input  logic          excl,
    input  logic [7:0]    dut_inflight,   // the DUT's formal observation ports (conventions �7)
    input  logic [31:0]   dut_oldest,
    output logic [RW-1:0] f_in_cnt,
    output logic [RW-1:0] f_out_cnt,
    output logic [7:0]    f_in_flight
);
    logic in_fire, out_fire;
    assign in_fire  = in_valid && in_ready;
    assign out_fire = out_valid && out_ready;

    initial begin
        f_in_cnt    = '0;
        f_out_cnt   = '0;
        f_in_flight = '0;
    end

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            f_in_cnt    <= '0;
            f_out_cnt   <= '0;
            f_in_flight <= '0;
        end else begin
            if (in_fire)  f_in_cnt  <= f_in_cnt + 1'b1;
            if (out_fire) f_out_cnt <= f_out_cnt + 1'b1;
            f_in_flight <= f_in_flight + {7'd0, in_fire} - {7'd0, out_fire};
        end
    end

    logic [RW-1:0] f_diff;
    assign f_diff = f_in_cnt - f_out_cnt;

    // Input REC_NO is the acceptance counter.
    always_comb if (rst_n && in_valid) st_recno_in: assume (in_recno == f_in_cnt);

    // Outputs: in order, nothing invented. A same-cycle pass-through (in_fire with in_flight = 0) is allowed.
    always_comb begin
        if (f_past_valid && rst_n && out_valid) begin
            st_order:    assert (out_recno == f_out_cnt);
            st_no_ghost: assert (f_in_flight != 0 || in_fire);
        end
        if (f_past_valid && rst_n) begin
            st_inflight: assert (f_in_flight <= MAX_INFLIGHT);
            // checker-internal consistency (keeps k-induction from starting in impossible counter states)
            st_cnt:      assert (f_diff == {{(RW-8){1'b0}}, f_in_flight});
            // link the checker to the DUT's own count (conventions �7): makes "nothing lost" inductive
            st_link_n:   assert (dut_inflight == f_in_flight);
            if (f_in_flight != 0)
                st_link_r: assert (dut_oldest[RW-1:0] == f_out_cnt);
        end
    end

    // Cycles since reset, saturating (for the sweep exclusion).
    localparam integer SW = (SWEEP < 1) ? 1 : $clog2(SWEEP + 2);
    logic [SW-1:0] since_rst;
    initial since_rst = '0;
    always_ff @(posedge clk) begin
        if (!rst_n)                    since_rst <= '0;
        else if (since_rst != {SW{1'b1}}) since_rst <= since_rst + 1'b1;
    end
    logic swept;
    assign swept = (SWEEP == 0) || (since_rst >= SWEEP);

    // II: consecutive cycles with in_valid && out_ready && !in_ready.
    generate
        if (II_MAX > 0) begin : g_ii
            logic [7:0] ii_wait;
            initial ii_wait = '0;
            always_ff @(posedge clk) begin
                if (!rst_n || in_fire || !in_valid || !out_ready || excl || !swept) ii_wait <= '0;
                else if (ii_wait != 8'hFF)                                          ii_wait <= ii_wait + 1'b1;
            end
            always_comb if (f_past_valid && rst_n) st_ii: assert (ii_wait < II_MAX);
        end
    endgenerate

    // Latency: cycles the oldest in-flight record has waited (out_ready held 1) without out_valid.
    generate
        if (LAT_MAX > 0) begin : g_lat
            logic [7:0] lat_wait;
            initial lat_wait = '0;
            always_ff @(posedge clk) begin
                if (!rst_n || f_in_flight == 0 || out_valid || !out_ready || excl) lat_wait <= '0;
                else if (lat_wait != 8'hFF)                                         lat_wait <= lat_wait + 1'b1;
            end
            always_comb if (f_past_valid && rst_n) st_lat: assert (lat_wait < LAT_MAX);
        end
    endgenerate
endmodule
