// tb_axi_mul.v — directed + random self-checking testbench (Icarus / Vivado xsim)
//   iverilog -g2012 -o sim tb/tb_axi_mul.v rtl/axi_mul.v && vvp sim
`timescale 1ns/1ps
`default_nettype none

module tb_axi_mul;
    reg clk = 0, rstn = 0;
    always #5 clk = ~clk;   // 100 MHz, same as FCLK_CLK0 in the block design

    reg  [4:0]  awaddr = 0, araddr = 0;
    reg         awvalid = 0, wvalid = 0, bready = 0, arvalid = 0, rready = 0;
    reg  [31:0] wdata = 0;
    reg  [3:0]  wstrb = 0;
    wire        awready, wready, bvalid, arready, rvalid;
    wire [1:0]  bresp, rresp;
    wire [31:0] rdata;

    axi_mul dut (
        .s_axi_aclk(clk), .s_axi_aresetn(rstn),
        .s_axi_awaddr(awaddr), .s_axi_awprot(3'b000), .s_axi_awvalid(awvalid), .s_axi_awready(awready),
        .s_axi_wdata(wdata), .s_axi_wstrb(wstrb), .s_axi_wvalid(wvalid), .s_axi_wready(wready),
        .s_axi_bresp(bresp), .s_axi_bvalid(bvalid), .s_axi_bready(bready),
        .s_axi_araddr(araddr), .s_axi_arprot(3'b000), .s_axi_arvalid(arvalid), .s_axi_arready(arready),
        .s_axi_rdata(rdata), .s_axi_rresp(rresp), .s_axi_rvalid(rvalid), .s_axi_rready(rready)
    );

    integer errors = 0, checks = 0;

    task axi_write(input [4:0] addr, input [31:0] data, input [3:0] strb);
        begin
            @(posedge clk); #1;
            awaddr = addr; wdata = data; wstrb = strb; awvalid = 1; wvalid = 1; bready = 1;
            @(posedge clk); while (!(awready && awvalid)) @(posedge clk);
            #1 awvalid = 0; wvalid = 0;
            while (!bvalid) @(posedge clk);
            if (bresp !== 2'b00) begin $display("ERROR: BRESP=%b", bresp); errors = errors + 1; end
            @(posedge clk); #1 bready = 0;
        end
    endtask

    task axi_read(input [4:0] addr, output [31:0] data);
        begin
            @(posedge clk); #1;
            araddr = addr; arvalid = 1; rready = 1;
            @(posedge clk); while (!(arready && arvalid)) @(posedge clk);
            #1 arvalid = 0;
            while (!rvalid) @(posedge clk);
            data = rdata;
            @(posedge clk); #1 rready = 0;
        end
    endtask

    task mul_check(input signed [31:0] a, input signed [31:0] b);
        reg [31:0] st, lo, hi;
        reg signed [63:0] got, exp;
        integer polls;
        begin
            axi_write(5'h08, a, 4'hF);
            axi_write(5'h0C, b, 4'hF);
            axi_write(5'h00, 32'h1, 4'hF);
            polls = 0;
            axi_read(5'h04, st);
            while (!st[0] && polls < 20) begin axi_read(5'h04, st); polls = polls + 1; end
            axi_read(5'h10, lo);
            axi_read(5'h14, hi);
            got = {hi, lo};
            exp = a * b;
            checks = checks + 1;
            if (!st[0] || got !== exp) begin
                errors = errors + 1;
                $display("FAIL a=%0d b=%0d got=%0d exp=%0d done=%b", a, b, got, exp, st[0]);
            end
        end
    endtask

    reg [31:0] r;
    integer i;
    reg signed [31:0] ra, rb;

    initial begin
        if ($test$plusargs("vcd")) begin $dumpfile("tb_axi_mul.vcd"); $dumpvars(0, tb_axi_mul); end
        repeat (5) @(posedge clk);
        #1 rstn = 1;

        // ID register
        axi_read(5'h18, r);
        checks = checks + 1;
        if (r !== 32'h4D554C31) begin errors = errors + 1; $display("FAIL ID=%h", r); end

        // Edge cases
        mul_check(0, 0);
        mul_check(1, 1);
        mul_check(-1, 1);
        mul_check(-1, -1);
        mul_check(32'sh7FFFFFFF, 32'sh7FFFFFFF);
        mul_check(32'sh80000000, 32'sh80000000);   // (-2^31)^2 = 2^62
        mul_check(32'sh80000000, 32'sh7FFFFFFF);
        mul_check(32'sh80000000, -1);
        mul_check(123456, 789);
        mul_check(-46341, 46341);

        // Byte-strobe write: only update byte 1 of A
        axi_write(5'h08, 32'h11223344, 4'hF);
        axi_write(5'h08, 32'hAABBCCDD, 4'b0010);
        axi_read(5'h08, r);
        checks = checks + 1;
        if (r !== 32'h1122CC44) begin errors = errors + 1; $display("FAIL WSTRB A=%h", r); end

        // Random
        for (i = 0; i < 2000; i = i + 1) begin
            ra = $random; rb = $random;
            mul_check(ra, rb);
        end

        // Completed-op counter should equal number of mul_check calls
        axi_read(5'h1C, r);
        checks = checks + 1;
        if (r !== 32'd2010) begin errors = errors + 1; $display("FAIL COUNT=%0d", r); end

        if (errors == 0) $display("PASS: %0d checks, 0 errors", checks);
        else             $display("FAIL: %0d checks, %0d errors", checks, errors);
        $finish;
    end

    initial begin
        #5_000_000;
        $display("FAIL: timeout");
        $finish;
    end
endmodule

`default_nettype wire
