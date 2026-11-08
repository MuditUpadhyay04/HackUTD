// axi_mul.v — AXI4-Lite signed 32x32 -> 64 multiplier peripheral
//
// Register map (byte offsets, 32-bit words):
//   0x00 CTRL    W   bit0 = START (write 1; ignored while BUSY)
//   0x04 STATUS  R   bit0 = DONE (sticky until next START), bit1 = BUSY
//   0x08 A       RW  operand A (signed 32-bit)
//   0x0C B       RW  operand B (signed 32-bit)
//   0x10 P_LO    R   product[31:0]
//   0x14 P_HI    R   product[63:32]
//   0x18 ID      R   0x4D554C31 ("MUL1")
//   0x1C COUNT   R   number of completed multiplies (wraps)
//
// Datapath: 3-stage pipeline (operand regs -> multiply reg -> product reg),
// shaped so Vivado maps it onto DSP48E1s with AREG/MREG/PREG.
// Latency START->DONE = 3 clocks. One operation in flight at a time.
//
// Formal properties live under `ifdef FORMAL` (see formal/axi_mul.sby).

`default_nettype none

module axi_mul #(
    parameter integer C_S_AXI_ADDR_WIDTH = 5
)(
    (* X_INTERFACE_INFO = "xilinx.com:signal:clock:1.0 s_axi_aclk CLK" *)
    (* X_INTERFACE_PARAMETER = "ASSOCIATED_BUSIF s_axi, ASSOCIATED_RESET s_axi_aresetn" *)
    input  wire                          s_axi_aclk,
    (* X_INTERFACE_INFO = "xilinx.com:signal:reset:1.0 s_axi_aresetn RST" *)
    (* X_INTERFACE_PARAMETER = "POLARITY ACTIVE_LOW" *)
    input  wire                          s_axi_aresetn,

    input  wire [C_S_AXI_ADDR_WIDTH-1:0] s_axi_awaddr,
    input  wire [2:0]                    s_axi_awprot,
    input  wire                          s_axi_awvalid,
    output reg                           s_axi_awready,

    input  wire [31:0]                   s_axi_wdata,
    input  wire [3:0]                    s_axi_wstrb,
    input  wire                          s_axi_wvalid,
    output reg                           s_axi_wready,

    output wire [1:0]                    s_axi_bresp,
    output reg                           s_axi_bvalid,
    input  wire                          s_axi_bready,

    input  wire [C_S_AXI_ADDR_WIDTH-1:0] s_axi_araddr,
    input  wire [2:0]                    s_axi_arprot,
    input  wire                          s_axi_arvalid,
    output reg                           s_axi_arready,

    output reg  [31:0]                   s_axi_rdata,
    output wire [1:0]                    s_axi_rresp,
    output reg                           s_axi_rvalid,
    input  wire                          s_axi_rready
);

    localparam [2:0] R_CTRL = 3'd0, R_STATUS = 3'd1, R_A = 3'd2, R_B = 3'd3,
                     R_PLO  = 3'd4, R_PHI    = 3'd5, R_ID = 3'd6, R_COUNT = 3'd7;
    localparam [31:0] ID_VALUE = 32'h4D55_4C31;

    wire clk  = s_axi_aclk;
    wire rstn = s_axi_aresetn;

    assign s_axi_bresp = 2'b00;  // OKAY
    assign s_axi_rresp = 2'b00;  // OKAY

    // ------------------------------------------------------------------
    // Write channel: accept AW and W together, one outstanding write.
    // ------------------------------------------------------------------
    wire wr_fire = s_axi_awready && s_axi_awvalid;   // W handshakes in the same cycle

    always @(posedge clk) begin
        if (!rstn) begin
            s_axi_awready <= 1'b0;
            s_axi_wready  <= 1'b0;
            s_axi_bvalid  <= 1'b0;
        end else begin
            if (!s_axi_awready && !s_axi_bvalid && s_axi_awvalid && s_axi_wvalid) begin
                s_axi_awready <= 1'b1;
                s_axi_wready  <= 1'b1;
            end else begin
                s_axi_awready <= 1'b0;
                s_axi_wready  <= 1'b0;
            end

            if (wr_fire)
                s_axi_bvalid <= 1'b1;
            else if (s_axi_bready)
                s_axi_bvalid <= 1'b0;
        end
    end

    wire [2:0] wr_idx = s_axi_awaddr[4:2];

    // ------------------------------------------------------------------
    // Registers + multiply pipeline
    // ------------------------------------------------------------------
    reg  [31:0] reg_a, reg_b;
    reg  [31:0] op_count;
    reg         done;
    reg  [1:0]  vld;                 // vld[0]: stage-1 operands valid, vld[1]: stage-2 product valid
    wire        busy = |vld;

    wire start = wr_fire && (wr_idx == R_CTRL) && s_axi_wstrb[0] && s_axi_wdata[0] && !busy;

    reg signed [31:0] s1_a, s1_b;
    reg signed [63:0] s2_p, s3_p;

    // The multiplier itself. Under FORMAL_ABSTRACT_MUL (k-induction task) it is
    // replaced by an uninterpreted function: an arbitrary but *consistent*
    // mapping from (a,b) to p. That lets the proof cover all control and data
    // movement for every operand pair without bit-blasting a 32x32 multiplier.
`ifdef FORMAL_ABSTRACT_MUL
    (* anyseq *) wire signed [63:0] mul_p;
`else
    wire signed [63:0] mul_p = s1_a * s1_b;
`endif

    always @(posedge clk) begin
        if (!rstn) begin
            reg_a <= 32'd0;
            reg_b <= 32'd0;
        end else if (wr_fire) begin
            if (wr_idx == R_A) begin
                if (s_axi_wstrb[0]) reg_a[ 7: 0] <= s_axi_wdata[ 7: 0];
                if (s_axi_wstrb[1]) reg_a[15: 8] <= s_axi_wdata[15: 8];
                if (s_axi_wstrb[2]) reg_a[23:16] <= s_axi_wdata[23:16];
                if (s_axi_wstrb[3]) reg_a[31:24] <= s_axi_wdata[31:24];
            end
            if (wr_idx == R_B) begin
                if (s_axi_wstrb[0]) reg_b[ 7: 0] <= s_axi_wdata[ 7: 0];
                if (s_axi_wstrb[1]) reg_b[15: 8] <= s_axi_wdata[15: 8];
                if (s_axi_wstrb[2]) reg_b[23:16] <= s_axi_wdata[23:16];
                if (s_axi_wstrb[3]) reg_b[31:24] <= s_axi_wdata[31:24];
            end
        end
    end

    // Control (reset)
    always @(posedge clk) begin
        if (!rstn) begin
            vld      <= 2'b00;
            done     <= 1'b0;
            op_count <= 32'd0;
        end else begin
            vld <= {vld[0], start};
            if (start)
                done <= 1'b0;
            else if (vld[1]) begin
                done     <= 1'b1;
                op_count <= op_count + 32'd1;
            end
        end
    end

    // Datapath (no reset -> clean DSP48 inference)
    always @(posedge clk) begin
        if (start) begin
            s1_a <= reg_a;
            s1_b <= reg_b;
        end
        if (vld[0]) s2_p <= mul_p;
        if (vld[1]) s3_p <= s2_p;
    end

    // ------------------------------------------------------------------
    // Read channel
    // ------------------------------------------------------------------
    wire [2:0] rd_idx = s_axi_araddr[4:2];
    reg  [31:0] rd_mux;

    always @* begin
        case (rd_idx)
            R_CTRL:   rd_mux = 32'd0;
            R_STATUS: rd_mux = {30'd0, busy, done};
            R_A:      rd_mux = reg_a;
            R_B:      rd_mux = reg_b;
            R_PLO:    rd_mux = s3_p[31:0];
            R_PHI:    rd_mux = s3_p[63:32];
            R_ID:     rd_mux = ID_VALUE;
            default:  rd_mux = op_count;    // R_COUNT
        endcase
    end

    always @(posedge clk) begin
        if (!rstn) begin
            s_axi_arready <= 1'b0;
            s_axi_rvalid  <= 1'b0;
            s_axi_rdata   <= 32'd0;
        end else begin
            s_axi_arready <= (!s_axi_arready && !s_axi_rvalid && s_axi_arvalid);

            if (s_axi_arready && s_axi_arvalid) begin
                s_axi_rvalid <= 1'b1;
                s_axi_rdata  <= rd_mux;
            end else if (s_axi_rready)
                s_axi_rvalid <= 1'b0;
        end
    end

    // Unused inputs (keep lint quiet)
    wire _unused = &{1'b0, s_axi_awprot, s_axi_arprot, s_axi_awaddr[1:0], s_axi_araddr[1:0]};

`ifdef FORMAL
    // ==================================================================
    // Formal properties. Run with: sby -f formal/axi_mul.sby
    // ==================================================================
    reg f_past_valid = 1'b0;
    always @(posedge clk) f_past_valid <= 1'b1;

    // Start in reset
    always @* if (!f_past_valid) assume(!rstn);

    // ---- Master (environment) assumptions: AXI4-Lite handshake rules ----
    always @(posedge clk) if (f_past_valid && $past(rstn) && rstn) begin
        if ($past(s_axi_awvalid && !s_axi_awready))
            assume(s_axi_awvalid && s_axi_awaddr == $past(s_axi_awaddr));
        if ($past(s_axi_wvalid && !s_axi_wready))
            assume(s_axi_wvalid && s_axi_wdata == $past(s_axi_wdata)
                                && s_axi_wstrb == $past(s_axi_wstrb));
        if ($past(s_axi_arvalid && !s_axi_arready))
            assume(s_axi_arvalid && s_axi_araddr == $past(s_axi_araddr));
    end
    // VALIDs low while in reset
    always @* if (!rstn) assume(!s_axi_awvalid && !s_axi_wvalid && !s_axi_arvalid);

    // ---- Slave guarantees ----
    // Outputs quiet the cycle after reset
    always @(posedge clk) if (f_past_valid && !$past(rstn)) begin
        assert(!s_axi_bvalid);
        assert(!s_axi_rvalid);
        assert(!s_axi_awready && !s_axi_wready && !s_axi_arready);
    end

    // AW and W are always accepted together
    always @* if (f_past_valid) assert(s_axi_awready == s_axi_wready);

    // B / R held until accepted; RDATA stable while waiting
    always @(posedge clk) if (f_past_valid && $past(rstn) && rstn) begin
        if ($past(s_axi_bvalid && !s_axi_bready)) assert(s_axi_bvalid);
        if ($past(s_axi_rvalid && !s_axi_rready)) begin
            assert(s_axi_rvalid);
            assert(s_axi_rdata == $past(s_axi_rdata));
        end
    end

    // Outstanding-transaction bookkeeping: never more than one, and no
    // response without a request.
    reg [1:0] f_wr_out, f_rd_out;
    always @(posedge clk) begin
        if (!rstn) begin
            f_wr_out <= 0;
            f_rd_out <= 0;
        end else begin
            f_wr_out <= f_wr_out + (wr_fire ? 2'd1 : 2'd0)
                                 - ((s_axi_bvalid && s_axi_bready) ? 2'd1 : 2'd0);
            f_rd_out <= f_rd_out + ((s_axi_arvalid && s_axi_arready) ? 2'd1 : 2'd0)
                                 - ((s_axi_rvalid && s_axi_rready) ? 2'd1 : 2'd0);
        end
    end
    always @* if (rstn) begin
        assert(f_wr_out <= 1);
        assert(f_rd_out <= 1);
        if (s_axi_bvalid)  assert(f_wr_out == 1);
        if (s_axi_rvalid)  assert(f_rd_out == 1);
        if (s_axi_awready) assert(f_wr_out == 0);
        if (s_axi_arready) assert(f_rd_out == 0);
        if (f_wr_out == 1) assert(s_axi_bvalid);
        if (f_rd_out == 1) assert(s_axi_rvalid);
    end

    // ---- Functional: the product equals the operands latched at START ----
    reg signed [31:0] f_a, f_b;
    reg               f_started;
`ifdef FORMAL_ABSTRACT_MUL
    (* anyconst *) reg signed [31:0] fa0, fb0;
    (* anyconst *) reg signed [63:0] fp0;
`endif
`ifdef FORMAL_ABSTRACT_MUL
    always @* if (s1_a == fa0 && s1_b == fb0) assume(mul_p == fp0);
`endif
    always @(posedge clk) begin
        if (!rstn) f_started <= 1'b0;
        else if (start) begin
            f_started <= 1'b1;
            f_a <= reg_a;
            f_b <= reg_b;
        end
    end

    always @* if (rstn) begin
        assert(vld != 2'b11);                   // one op in flight
        assert(!(done && busy));                // DONE and BUSY exclusive
        if (busy || done) assert(f_started);
        if (f_started) begin
            assert(s1_a == f_a);
            assert(s1_b == f_b);
        end
`ifdef FORMAL_ABSTRACT_MUL
        // Uninterpreted-function check: pick one arbitrary operand pair
        // (fa0,fb0) and its image fp0. Whenever the multiplier sees that pair
        // it must produce fp0; prove the peripheral then reports exactly fp0.
        if (vld[1] && s1_a == fa0 && s1_b == fb0) assert(s2_p == fp0);
        if (done   && s1_a == fa0 && s1_b == fb0) assert(s3_p == fp0);
`else
        // Headline property against the real multiplier (bounded; bmc task).
        if (done) assert(s3_p == f_a * f_b);
`endif
    end

    // Latency: DONE exactly 3 cycles after an accepted START
    always @(posedge clk)
        if (f_past_valid && $past(f_past_valid) && $past(f_past_valid, 3)
            && $past(rstn, 3) && $past(rstn, 2) && $past(rstn) && rstn
            && $past(start, 3))
            assert(done);

    // ---- Cover: reach a completed multiply and read back P_HI ----
    always @(posedge clk) if (rstn) begin
        cover(done && s_axi_rvalid && s_axi_rready);
    end
`endif

endmodule

`default_nettype wire
