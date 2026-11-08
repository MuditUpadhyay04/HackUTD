// fv_selftest.sv — proves the shared checkers against a tiny known-good stage (formal/common/common.sby).
// If this passes, a failing module proof is about the module, not about eog_fv_props.sv.
//
// selftest_stage: one record at a time; accepts, waits DELAY cycles "computing" (through eog_mul, so the
// abstract multiplier is exercised), presents the record with data = {recno, a*b}, holds it until out_ready.

module selftest_stage #(
    parameter integer DELAY = 3
) (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        in_valid,
    output logic        in_ready,
    input  logic [15:0] in_data,      // [15:8] recno, [7:4] a, [3:0] b
    output logic        out_valid,
    input  logic        out_ready,
    output logic [15:0] out_data      // [15:8] recno, [7:0] a*b
);
    localparam logic [1:0] S_IDLE = 2'd0, S_BUSY = 2'd1, S_OUT = 2'd2;
    logic [1:0]  st;
    logic [3:0]  cnt;
    logic [15:0] hold;
    logic [7:0]  p;

    eog_mul #(.AW(4), .BW(4), .A_SIGNED(0), .B_SIGNED(0), .LAT(0)) u_mul (
        .clk(clk), .a(hold[7:4]), .b(hold[3:0]), .p(p));

    assign in_ready  = (st == S_IDLE);
    assign out_valid = (st == S_OUT);

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            st  <= S_IDLE;
            cnt <= '0;
        end else begin
            case (st)
                S_IDLE: if (in_valid) begin
                    hold <= in_data;
                    cnt  <= DELAY[3:0];
                    st   <= S_BUSY;
                end
                S_BUSY: if (cnt == 0) begin
                    out_data <= {hold[15:8], p};
                    st       <= S_OUT;
                end else cnt <= cnt - 1'b1;
                S_OUT: if (out_ready) st <= S_IDLE;
                default: st <= S_IDLE;
            endcase
        end
    end

`ifdef FORMAL
    // internal invariant to help induction (the pattern RTL authors may follow)
    always_comb if (rst_n && st == S_BUSY) assert (cnt <= DELAY[3:0]);
    always_comb assert (st != 2'd3);
`endif
endmodule

module fv_selftest (
    input logic        clk,        // top-level inputs are free: the solver drives them
    input logic        rst_n,
    input logic        in_valid,
    input logic [15:0] in_data,
    input logic        out_ready
);
    logic in_ready, out_valid;
    logic [15:0] out_data;

    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    selftest_stage #(.DELAY(3)) dut (.*);

    eog_fv_axis #(.W(16), .ASSUME(1)) u_in  (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(in_valid), .ready(in_ready), .data(in_data));
    eog_fv_axis #(.W(16), .ASSUME(0)) u_out (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(out_valid), .ready(out_ready), .data(out_data));

    logic [7:0] f_in_cnt, f_out_cnt, f_in_flight;
    eog_fv_stage #(.RW(8), .MAX_INFLIGHT(1), .II_MAX(16), .LAT_MAX(8), .SWEEP(0)) u_stage (
        .clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .in_valid(in_valid), .in_ready(in_ready), .in_recno(in_data[15:8]),
        .out_valid(out_valid), .out_ready(out_ready), .out_recno(out_data[15:8]),
        .excl(1'b0), .f_in_cnt(f_in_cnt), .f_out_cnt(f_out_cnt), .f_in_flight(f_in_flight));

    // Port-only shadow (harnesses must not use hierarchical references): the last accepted input.
    logic [15:0] f_last_in;
    always_ff @(posedge clk) if (in_valid && in_ready) f_last_in <= in_data;

    // Abstract multiplier: zero operand -> zero product (prove); real product (bmc only)
    always_comb if (f_past_valid && rst_n && out_valid) begin
        sf_rec: assert (out_data[15:8] == f_last_in[15:8]);
        if (f_last_in[7:4] == 0 || f_last_in[3:0] == 0) sf_zero: assert (out_data[7:0] == 0);
`ifndef FORMAL_ABSTRACT_MUL
        sf_mul: assert (out_data[7:0] == f_last_in[7:4] * f_last_in[3:0]);
`endif
    end

    always_ff @(posedge clk) if (f_past_valid && rst_n) begin
        sc_two: cover (f_out_cnt == 8'd2);
    end
endmodule
