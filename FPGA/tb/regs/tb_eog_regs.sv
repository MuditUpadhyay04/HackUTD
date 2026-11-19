// tb_eog_regs.sv -- simulation testbench for eog_regs (Verify role, task T1.regs.fv).
//
// Written from spec/modules/eog_regs.md, spec/regmap.md and the lead's rulings #59-#66 (ports only, RTL not read).
// Run: bash scripts/sim.sh regs. Prints exactly one final line: "PASS: <n> checks" or "FAIL: <first mismatch>".
//
// 1. Vectors: tb/vectors/regs_basic.{in,out}.hex (model class Regs) replayed over AXI-Lite twice: pass 0 with
//    random AW/W/B/AR/R delays (fixed seed), pass 1 (after a hard reset) with no delays. Every read is compared;
//    every write must pulse fac_touch exactly for the touched slot ([37], slot [36:32]) and nothing else.
// 2. Directed (pass 0, N_FAC = 32, RES_DEPTH = AL_DEPTH = 64, CYC_PER_MS = 10):
//    G7  W1P: heartbeat / swap_req / server_ack give one 1-cycle pulse per write, none without WSTRB[0];
//        soft_reset gives a 2-cycle soft_rst; W1P bits read back 0; stats_clear clears STATS.
//    G6  DATA push: 6 beats = the 12 words, d_last on the 6th, random d_ready; push while busy dropped and counted
//        (STATS 12), data_busy in STATUS; words rewritten while busy do not disturb the in-flight record (#65);
//        push with src_dma = 1 ignored and not counted; partial-strobe push ignored; STATS 0 counts pushes (#59).
//    G5  RESULT FIFO: 66 random records (r_last random, ignored), r_ready drops at 64 complete records, STATUS count
//        and result_avail, drained in order through 0x0300-0x031C (pop on 0x031C only), empty reads 0.
//        ALERT FIFO: 64 alerts, al_full, al_valid while full and al_drop counted (STATS 10/11, #60), drained in
//        order through 0x0040-0x004C, empty reads 0.
//    STATS 1-9 and 13 from the taps, 14 = ms_since_hb, 15 uptime (CYC_PER_MS, cleared by stats_clear, #61);
//    STATUS input bits; DBG window capture (#64: survives soft reset); weights: wb_we/wb_addr/wb_wdata per write
//    (partial strobes merge with wb_rdata, #62) and readback through wb_raddr/wb_rdata (1-cycle head model);
//    glb / ledovr / dbg_fac / stream_en / src_dma ports; soft reset keeps CONFIG and GLOBAL.
`timescale 1ns/1ps
`default_nettype none

module tb_eog_regs;
    localparam integer NF = 32, RD = 64, AD = 64, CPM = 10;

    logic clk = 0, rst_n = 0;
    always #5 clk = ~clk;

    logic [15:0] awaddr = 0, araddr = 0;
    logic        awvalid = 0, wvalid = 0, bready = 0, arvalid = 0, rready = 0;
    logic [31:0] wdata = 0;
    logic [3:0]  wstrb = 0;
    logic        awready, wready, bvalid, arready, rvalid;
    logic [1:0]  bresp, rresp;
    logic [31:0] rdata;
    logic        stream_en, src_dma, soft_rst, hb_pulse, swap_req, ack_srv;
    logic [255:0] glb;
    logic [31:0] ledovr;
    logic [4:0]  cfg_fac_v = 0, cfg_fac_f = 0, cfg_fac_c = 0;
    logic [511:0] cfg_row_v, cfg_row_f, cfg_row_c;
    logic [NF-1:0] fac_touch;
    logic        wb_we;
    logic [6:0]  wb_addr, wb_raddr;
    logic [31:0] wb_wdata, wb_rdata = 0;
    logic [4:0]  dbg_fac;
    logic        dbg_valid = 0;
    logic [495:0] dbg_feat = 0;
    logic [63:0] dbg_logits = 0;
    logic [31:0] dbg_rec_no = 0;
    logic        autonomous = 0, swap_pending = 0, active_bank = 0;
    logic [7:0]  active_ver = 0;
    logic [15:0] ms_since_hb = 0;
    logic        d_valid, d_last, d_ready = 0;
    logic [63:0] d_data;
    logic        r_valid = 0, r_ready, r_last = 0;
    logic [63:0] r_data = 0;
    logic        al_valid = 0, al_full, al_drop = 0;
    logic [127:0] al_data = 0;
    logic        tap_valid = 0, stall = 0, rec_in = 0;
    logic [2:0]  tap_status = 0;
    logic [15:0] tap_reason = 0;

    eog_regs #(.N_FAC(NF), .RES_DEPTH(RD), .AL_DEPTH(AD), .CYC_PER_MS(CPM)) dut (
        .clk(clk), .rst_n(rst_n),
        .s_axi_awaddr(awaddr), .s_axi_awvalid(awvalid), .s_axi_awready(awready),
        .s_axi_wdata(wdata), .s_axi_wstrb(wstrb), .s_axi_wvalid(wvalid), .s_axi_wready(wready),
        .s_axi_bresp(bresp), .s_axi_bvalid(bvalid), .s_axi_bready(bready),
        .s_axi_araddr(araddr), .s_axi_arvalid(arvalid), .s_axi_arready(arready),
        .s_axi_rdata(rdata), .s_axi_rresp(rresp), .s_axi_rvalid(rvalid), .s_axi_rready(rready),
        .stream_en(stream_en), .src_dma(src_dma), .soft_rst(soft_rst), .hb_pulse(hb_pulse), .swap_req(swap_req),
        .ack_srv(ack_srv), .glb(glb), .ledovr(ledovr),
        .cfg_fac_v(cfg_fac_v), .cfg_fac_f(cfg_fac_f), .cfg_fac_c(cfg_fac_c),
        .cfg_row_v(cfg_row_v), .cfg_row_f(cfg_row_f), .cfg_row_c(cfg_row_c), .fac_touch(fac_touch),
        .wb_we(wb_we), .wb_addr(wb_addr), .wb_wdata(wb_wdata), .wb_raddr(wb_raddr), .wb_rdata(wb_rdata),
        .dbg_fac(dbg_fac), .dbg_valid(dbg_valid), .dbg_feat(dbg_feat), .dbg_logits(dbg_logits),
        .dbg_rec_no(dbg_rec_no),
        .autonomous(autonomous), .swap_pending(swap_pending), .active_bank(active_bank), .active_ver(active_ver),
        .ms_since_hb(ms_since_hb),
        .d_valid(d_valid), .d_ready(d_ready), .d_data(d_data), .d_last(d_last),
        .r_valid(r_valid), .r_ready(r_ready), .r_data(r_data), .r_last(r_last),
        .al_valid(al_valid), .al_data(al_data), .al_full(al_full), .al_drop(al_drop),
        .tap_valid(tap_valid), .tap_status(tap_status), .tap_reason(tap_reason), .stall(stall), .rec_in(rec_in)
    );

    // ------------------------------------------------------------------------------------------- bookkeeping
    integer n_chk = 0, n_err = 0;
    string  first_err = "";
    task automatic fail(input string m);
        if (n_err == 0) first_err = m;
        n_err++;
    endtask
    task automatic chk(input logic ok, input string m);
        n_chk++;
        if (!ok) fail(m);
    endtask

    integer seed = 32'h5EED_0123;
    logic   rnd_on = 1;
    function automatic integer dly();
        integer r;
        r = $random(seed);
        dly = rnd_on ? ((r & 3) == 0 ? (((r >> 4) & 7)) : 0) : 0;
    endfunction

    // pulse monitors (sampled at each edge: pre-edge values)
    integer touch_cnt [0:NF-1];
    integer hb_n = 0, sw_n = 0, ack_n = 0, sr_rise_n = 0, wb_n = 0;
    logic   hb_q = 0, sw_q = 0, ack_q = 0, sr_q = 0, sr_qq = 0;
    logic [6:0]  wb_last_a; logic [31:0] wb_last_d;
    initial for (int i = 0; i < NF; i++) touch_cnt[i] = 0;
    always @(posedge clk) if (rst_n) begin
        for (int i = 0; i < NF; i++) if (fac_touch[i]) touch_cnt[i] = touch_cnt[i] + 1;
        if (hb_pulse) hb_n = hb_n + 1;
        if (swap_req) sw_n = sw_n + 1;
        if (ack_srv) ack_n = ack_n + 1;
        if (soft_rst && !sr_q) sr_rise_n = sr_rise_n + 1;
        if (hb_pulse && hb_q) fail("G7: heartbeat pulse longer than 1 cycle");
        if (swap_req && sw_q) fail("G7: swap_req pulse longer than 1 cycle");
        if (ack_srv && ack_q) fail("G7: ack_srv pulse longer than 1 cycle");
        if (soft_rst && sr_q && sr_qq) fail("G7: soft_rst longer than 2 cycles");
        if (!soft_rst && sr_q && !sr_qq) fail("G7: soft_rst shorter than 2 cycles");
        if (wb_we) begin wb_n = wb_n + 1; wb_last_a = wb_addr; wb_last_d = wb_wdata; end
        if (bvalid && bresp != 2'b00) fail("G1: BRESP not OKAY");
        if (rvalid && rresp != 2'b00) fail("G1: RRESP not OKAY");
        hb_q <= hb_pulse; sw_q <= swap_req; ack_q <= ack_srv; sr_q <= soft_rst; sr_qq <= sr_q;
    end

    // head weight-window model: readback 1 cycle after wb_raddr
    logic [31:0] wmem [0:127];
    initial for (int i = 0; i < 128; i++) wmem[i] = 32'h0;
    always @(posedge clk) begin
        wb_rdata <= wmem[wb_raddr];
        if (wb_we) wmem[wb_addr] <= wb_wdata;
    end

    // AXI handshake / hold checks
    logic        b_wait = 0, r_wait = 0;
    logic [31:0] rdata_q;
    always @(posedge clk) if (rst_n) begin
        if (b_wait && !bvalid) fail("G1: BVALID dropped before BREADY");
        if (r_wait && (!rvalid || rdata != rdata_q)) fail("G1: RVALID/RDATA not held before RREADY");
        b_wait <= bvalid && !bready;
        r_wait <= rvalid && !rready;
        rdata_q <= rdata;
    end

    // ------------------------------------------------------------------------------------------- AXI master
    task automatic axi_wr(input [15:0] a, input [31:0] d, input [3:0] s);
        integer t;
        fork
            begin
                repeat (dly()) @(posedge clk);
                awaddr <= a; awvalid <= 1'b1;
                do @(posedge clk); while (!(awvalid && awready));
                awvalid <= 1'b0;
            end
            begin
                repeat (dly()) @(posedge clk);
                wdata <= d; wstrb <= s; wvalid <= 1'b1;
                do @(posedge clk); while (!(wvalid && wready));
                wvalid <= 1'b0;
            end
        join
        t = 0;
        repeat (dly()) @(posedge clk);
        bready <= 1'b1;
        do begin @(posedge clk); t++; end while (!(bvalid && bready) && t < 1000);
        bready <= 1'b0;
        if (t >= 1000) fail($sformatf("G1: no B response for write %h", a));
        @(posedge clk);   // let the monitors see the BVALID cycle
    endtask

    task automatic axi_rd(input [15:0] a, output [31:0] d);
        integer t;
        repeat (dly()) @(posedge clk);
        araddr <= a; arvalid <= 1'b1;
        do @(posedge clk); while (!(arvalid && arready));
        arvalid <= 1'b0;
        repeat (dly()) @(posedge clk);
        rready <= 1'b1;
        t = 0;
        do begin @(posedge clk); t++; end while (!(rvalid && rready) && t < 1000);
        d = rdata;
        rready <= 1'b0;
        if (t >= 1000) fail($sformatf("G1: no R response for read %h", a));
    endtask

    task automatic rd_chk(input [15:0] a, input [31:0] exp, input string what);
        logic [31:0] v;
        axi_rd(a, v);
        chk(v === exp, $sformatf("%s: read %h expected %h got %h", what, a, exp, v));
    endtask

    // write with pulse expectations (fac_touch slot or -1, heartbeat/swap/ack counts, soft_rst rises, wb_we count)
    task automatic wr_chk(input [15:0] a, input [31:0] d, input [3:0] s, input integer slot, input string what);
        integer tc0 [0:NF-1];
        integer hb0, sw0, ack0, sr0, wb0;
        logic   c0;
        for (int i = 0; i < NF; i++) tc0[i] = touch_cnt[i];
        hb0 = hb_n; sw0 = sw_n; ack0 = ack_n; sr0 = sr_rise_n; wb0 = wb_n;
        axi_wr(a, d, s);
        for (int i = 0; i < NF; i++)
            chk(touch_cnt[i] - tc0[i] == ((i == slot) ? 1 : 0),
                $sformatf("G4 %s: write %h data %h strb %h: fac_touch[%0d] pulsed %0d times", what, a, d, s, i,
                          touch_cnt[i] - tc0[i]));
        c0 = a == 16'h0008 && s[0];
        chk(hb_n - hb0 == ((c0 && d[2]) ? 1 : 0), $sformatf("G7 %s: write %h %h: %0d heartbeat pulses", what, a, d, hb_n - hb0));
        chk(sw_n - sw0 == ((c0 && d[3]) ? 1 : 0), $sformatf("G7 %s: write %h %h: %0d swap_req pulses", what, a, d, sw_n - sw0));
        chk(ack_n - ack0 == ((c0 && d[4]) ? 1 : 0), $sformatf("G7 %s: write %h %h: %0d ack_srv pulses", what, a, d, ack_n - ack0));
        repeat (2) @(posedge clk);   // soft_rst may still be high in the cycle after BVALID
        chk(sr_rise_n - sr0 == ((c0 && d[1]) ? 1 : 0), $sformatf("G7 %s: write %h %h: %0d soft_rst pulses", what, a, d, sr_rise_n - sr0));
        chk(wb_n - wb0 == ((a >= 16'h4000 && a <= 16'h4118 && s != 4'h0) ? 1 : 0),   // WSTRB = 0: no-op (#101)
           
            $sformatf("%s: write %h: %0d wb_we pulses", what, a, wb_n - wb0));
    endtask

    // ------------------------------------------------------------------------------------------- vectors
    logic [63:0] vin  [0:4095];
    logic [39:0] vout [0:4095];
    integer      n_vec;
    task automatic run_vectors(input integer pass);
        logic [31:0] v;
        for (int k = 0; k < n_vec; k++) begin
            if (vin[k][63:56] == 8'd1)
                wr_chk(vin[k][47:32], vin[k][31:0], vin[k][55:52], vout[k][37] ? vout[k][36:32] : -1,
                       $sformatf("vector %0d (pass %0d)", k, pass));
            else begin
                axi_rd(vin[k][47:32], v);
                chk(v === vout[k][31:0], $sformatf("vector %0d (pass %0d): read %h expected %h got %h", k, pass,
                                                   vin[k][47:32], vout[k][31:0], v));
            end
        end
    endtask

    // ------------------------------------------------------------------------------------------- DATA beats
    logic [64:0] beats [0:255];
    integer      n_beats = 0;
    logic        dv_q = 0; logic [64:0] dd_q;
    always @(posedge clk) if (rst_n) begin
        if (d_valid && d_ready) begin beats[n_beats] = {d_last, d_data}; n_beats = n_beats + 1; end
        if (dv_q && (!d_valid || {d_last, d_data} != dd_q)) fail("G6: d_valid/d_data not held until d_ready");
        dv_q <= d_valid && !d_ready; dd_q <= {d_last, d_data};
    end
    logic d_rand = 0;
    always @(posedge clk) if (d_rand) d_ready <= ($random(seed) & 1);

    task automatic push_rec(input logic [31:0] w [0:11]);
        for (int i = 0; i < 11; i++) axi_wr(16'h0200 + 4 * i, w[i], 4'hF);
        axi_wr(16'h022C, w[11], 4'hF);
    endtask
    task automatic chk_beats(input integer b0, input logic [31:0] w [0:11], input string what);
        for (int j = 0; j < 6; j++)
            chk(beats[b0 + j] === {(j == 5), w[2 * j + 1], w[2 * j]},
                $sformatf("G6 %s: beat %0d expected %h got %h", what, j, {(j == 5), w[2 * j + 1], w[2 * j]}, beats[b0 + j]));
    endtask

    // ------------------------------------------------------------------------------------------- RESULT source
    logic [255:0] rrec [0:127];
    integer       r_sent = 0, r_tosend = 0;
    initial forever begin
        @(posedge clk);
        if (r_sent < r_tosend && !r_valid) begin
            if (($random(seed) & 3) != 0) begin
                // send one record, 4 beats
                for (int b = 0; b < 4; b++) begin
                    r_valid <= 1'b1; r_data <= rrec[r_sent][64 * b +: 64]; r_last <= (b == 3) && ($random(seed) & 1);
                    do @(posedge clk); while (!(r_valid && r_ready));
                    r_valid <= 1'b0;
                    if (($random(seed) & 3) == 0) @(posedge clk);
                end
                r_sent = r_sent + 1;
            end
        end
    end

    task automatic wait_cycles(input integer n);
        repeat (n) @(posedge clk);
    endtask

    // ------------------------------------------------------------------------------------------- main
    logic [31:0] v, w12 [0:11], w12b [0:11], cfgsave, glbsave;
    integer      b0, nr, cnt;
    initial begin
        $readmemh("tb/vectors/regs_basic.in.hex", vin);
        $readmemh("tb/vectors/regs_basic.out.hex", vout);
        n_vec = 0;
        while (n_vec < 4096 && vin[n_vec] !== 64'bx) n_vec++;
        if (n_vec == 0) begin $display("FAIL: no vectors loaded"); $finish; end

        // ================================================================ pass 0
        rst_n = 0; repeat (5) @(posedge clk); rst_n <= 1;
        @(posedge clk);
        chk(!stream_en && !src_dma && ledovr == 0 && dbg_fac == 0, "reset: CTRL/LEDOVR/DBGSEL outputs not 0");
        chk(glb[7:0] == 8'd17 && glb[23:16] == 8'd4, "G3: glb bytes 0/2 not 17/4 after reset");
        rnd_on = 1;
        run_vectors(0);
        chk(glb[7:0] == 8'd17 && glb[23:16] == 8'd4, "G3: glb bytes 0/2 not 17/4");
        for (int i = 1; i < 8; i++) begin
            axi_rd(16'h0010 + 4 * i, v);
            chk(glb[32 * i +: 32] == v, $sformatf("G3: glb word %0d %h != readback %h", i, glb[32 * i +: 32], v));
        end
        // CONFIG read ports vs AXI readback (slot 17)
        cfg_fac_v <= 5'd17; cfg_fac_f <= 5'd17; cfg_fac_c <= 5'd1; @(posedge clk);
        for (int i = 1; i < 16; i++) begin
            axi_rd(16'h1000 + 64 * 17 + 4 * i, v);
            chk(cfg_row_v[32 * i +: 32] == v && cfg_row_f[32 * i +: 32] == v,
                $sformatf("CONFIG port: slot 17 word %0d row %h readback %h", i, cfg_row_v[32 * i +: 32], v));
        end
        axi_rd(16'h1000 + 64 * 1 + 60, v);
        chk(cfg_row_c[511:480] == v, "CONFIG port c: slot 1 word 15");

        // ---- G7 W1P
        wr_chk(16'h0008, 32'h0000_0004, 4'hF, -1, "heartbeat");
        wr_chk(16'h0008, 32'h0000_0008, 4'hF, -1, "swap_req");
        wr_chk(16'h0008, 32'h0000_0010, 4'hF, -1, "server_ack");
        wr_chk(16'h0008, 32'h0000_001D, 4'hF, -1, "all W1P + stream_en");
        chk(stream_en && !src_dma, "CTRL: stream_en port");
        rd_chk(16'h0008, 32'h1, "G7 W1P bits read 0");
        wr_chk(16'h0008, 32'h0000_001C, 4'hE, -1, "W1P without WSTRB[0]");
        rd_chk(16'h0008, 32'h1, "CTRL unchanged without WSTRB[0]");
        wr_chk(16'h0008, 32'h0000_0020, 4'hF, -1, "src_dma");
        chk(!stream_en && src_dma, "CTRL: src_dma port");
        rd_chk(16'h0008, 32'h20, "CTRL src_dma readback");
        wr_chk(16'h0008, 32'h0, 4'hF, -1, "CTRL 0");
        // LEDOVR / DBGSEL ports
        wr_chk(16'h0060, 32'h8012_3456, 4'hF, -1, "LEDOVR");
        chk(ledovr == 32'h8012_3456, "LEDOVR port");
        wr_chk(16'h0064, 32'hFFFF_FFE5, 4'hF, -1, "DBGSEL");
        chk(dbg_fac == 5'h05, "DBGSEL port");
        rd_chk(16'h0064, 32'h5, "DBGSEL readback [4:0]");

        // ---- STATUS inputs
        autonomous <= 1; swap_pending <= 0; active_bank <= 1; active_ver <= 8'hA5; @(posedge clk);
        axi_rd(16'h000C, v);
        chk(v[2:0] == 3'b101 && v[31:24] == 8'hA5, $sformatf("STATUS inputs: got %h", v));
        autonomous <= 0; swap_pending <= 1; active_bank <= 0; active_ver <= 8'h3C; @(posedge clk);
        axi_rd(16'h000C, v);
        chk(v[2:0] == 3'b010 && v[31:24] == 8'h3C, $sformatf("STATUS inputs: got %h", v));
        chk(v[5:3] == 3'b000 && v[23:8] == 16'h0, $sformatf("STATUS idle: got %h", v));

        // ---- STATS from taps (#59-#61)
        wr_chk(16'h0008, 32'h40, 4'hF, -1, "stats_clear");
        for (int i = 0; i < 14; i++) rd_chk(16'h0100 + 4 * i, 32'h0, $sformatf("STATS %0d after stats_clear", i));
        begin
            logic [18:0] taps [0:9];
            taps[0] = {3'd0, 16'h0000}; taps[1] = {3'd0, 16'h0004}; taps[2] = {3'd0, 16'h0001};
            taps[3] = {3'd1, 16'h0002}; taps[4] = {3'd1, 16'h0000}; taps[5] = {3'd3, 16'h0008 >> 0};
            taps[6] = {3'd4, 16'h0100}; taps[7] = {3'd4, 16'h0200}; taps[8] = {3'd4, 16'h0400};
            taps[9] = {3'd4, 16'h1000};
            for (int i = 0; i < 10; i++) begin
                tap_valid <= 1; {tap_status, tap_reason} <= taps[i]; @(posedge clk);
                tap_valid <= 0; repeat (i & 1) @(posedge clk);
            end
            stall <= 1; repeat (7) @(posedge clk); stall <= 0;
            ms_since_hb <= 16'd1234; @(posedge clk);
        end
        rd_chk(16'h0104, 10, "STATS 1 results out");
        rd_chk(16'h0108, 3, "STATS 2 VALID");
        rd_chk(16'h010C, 2, "STATS 3 HELD");
        rd_chk(16'h0110, 1, "STATS 4 INVALID");
        rd_chk(16'h0114, 1, "STATS 5 duplicate");
        rd_chk(16'h0118, 1, "STATS 6 out of order");
        rd_chk(16'h011C, 1, "STATS 7 unknown facility");
        rd_chk(16'h0120, 1, "STATS 8 framing");
        rd_chk(16'h0124, 1, "STATS 9 history resets");
        rd_chk(16'h0134, 7, "STATS 13 stall cycles");
        rd_chk(16'h0138, 1234, "STATS 14 ms since heartbeat");
        wr_chk(16'h0008, 32'h40, 4'hF, -1, "stats_clear");
        wait_cycles(100);
        axi_rd(16'h013C, v);
        chk(v >= 9 && v <= 13, $sformatf("STATS 15 uptime: ~100 cycles / CYC_PER_MS %0d after stats_clear, got %0d", CPM, v));

        // ---- G6 DATA push
        wr_chk(16'h0008, 32'h40, 4'hF, -1, "stats_clear");
        for (int i = 0; i < 12; i++) w12[i] = $random(seed);
        d_rand = 1;
        b0 = n_beats;
        push_rec(w12);
        cnt = 0; while (n_beats < b0 + 6 && cnt < 500) begin @(posedge clk); cnt++; end
        wait_cycles(10);
        chk(n_beats == b0 + 6, $sformatf("G6: %0d beats after one push (expected 6)", n_beats - b0));
        chk_beats(b0, w12, "push 1");
        // overrun: hold d_ready low
        d_rand = 0; d_ready <= 0;
        for (int i = 0; i < 12; i++) w12[i] = $random(seed);
        b0 = n_beats;
        push_rec(w12);
        axi_rd(16'h000C, v); chk(v[5] == 1'b1, "G6: data_busy not set while beats pending");
        for (int i = 0; i < 12; i++) w12b[i] = $random(seed);
        push_rec(w12b);                                      // dropped, counted (words 0-10 rewritten, #65)
        axi_wr(16'h022C, 32'hDEAD_BEEF, 4'h7);               // partial strobe: ignored
        rd_chk(16'h0130, 1, "G6: STATS 12 overrun count");
        d_rand = 1;
        cnt = 0; while (n_beats < b0 + 6 && cnt < 500) begin @(posedge clk); cnt++; end
        wait_cycles(20);
        chk(n_beats == b0 + 6, $sformatf("G6: %0d beats after push + dropped push (expected 6)", n_beats - b0));
        chk_beats(b0, w12, "push 2 (overrun in flight)");
        axi_rd(16'h000C, v); chk(v[5] == 1'b0, "G6: data_busy still set after 6 beats");
        // next push uses the words as now written (words 0-10 from w12b, word 11 new)
        w12b[11] = 32'h0BAD_CAFE;
        b0 = n_beats;
        axi_wr(16'h022C, w12b[11], 4'hF);
        cnt = 0; while (n_beats < b0 + 6 && cnt < 500) begin @(posedge clk); cnt++; end
        wait_cycles(10);
        chk_beats(b0, w12b, "push 3 (words rewritten while busy)");
        // src_dma = 1: push ignored, not counted
        wr_chk(16'h0008, 32'h20, 4'hF, -1, "src_dma");
        b0 = n_beats;
        axi_wr(16'h022C, 32'h1, 4'hF);
        wait_cycles(20);
        chk(n_beats == b0 && !d_valid, "G6: push with src_dma = 1 produced beats");
        wr_chk(16'h0008, 32'h0, 4'hF, -1, "CTRL 0");
        rd_chk(16'h0130, 1, "G6: overrun count after src_dma push");
        rd_chk(16'h0100, 0, "STATS 0: DATA pushes alone do not count (#59)");
        for (int i = 0; i < 5; i++) begin rec_in <= 1; @(posedge clk); rec_in <= 0; repeat (i) @(posedge clk); end
        @(posedge clk);
        rd_chk(16'h0100, 5, "STATS 0 records in = rec_in pulses (#59)");
        wr_chk(16'h0008, 32'h40, 4'hF, -1, "stats_clear");
        rd_chk(16'h0130, 0, "G7: stats_clear clears STATS 12");
        d_rand = 0; d_ready <= 1;

        // ---- G5 RESULT FIFO
        rd_chk(16'h0300, 0, "G5: empty RESULT reads 0");
        rd_chk(16'h031C, 0, "G5: empty RESULT pop reads 0");
        nr = RD + 2;
        for (int k = 0; k < nr; k++)
            for (int j = 0; j < 8; j++) rrec[k][32 * j +: 32] = $random(seed);
        r_tosend = nr;
        cnt = 0;
        while (cnt < 3000 && !(r_sent == RD && r_valid && !r_ready)) begin @(posedge clk); cnt++; end
        wait_cycles(20);
        chk(r_valid && !r_ready, "G5: r_ready not 0 with RES_DEPTH complete records");
        axi_rd(16'h000C, v);
        chk(v[15:8] == RD && v[3], $sformatf("G5: STATUS result count %0d avail %0d (expected %0d, 1)", v[15:8], v[3], RD));
        for (int k = 0; k < nr; k++) begin
            cnt = 0;
            do begin axi_rd(16'h000C, v); cnt++; end while (!v[3] && cnt < 200);
            for (int j = 0; j < 7; j++)
                rd_chk(16'h0300 + 4 * j, rrec[k][32 * j +: 32], $sformatf("G5: RESULT record %0d word %0d", k, j));
            if (k < 2) rd_chk(16'h0300, rrec[k][31:0], $sformatf("G5: record %0d popped by a read of words 0-6", k));
            rd_chk(16'h031C, rrec[k][255:224], $sformatf("G5: RESULT record %0d word 7 (pop)", k));
        end
        wait_cycles(5);
        axi_rd(16'h000C, v);
        chk(v[15:8] == 0 && !v[3], $sformatf("G5: RESULT not empty after drain (%h)", v));
        rd_chk(16'h0304, 0, "G5: drained RESULT reads 0");

        // ---- G5 ALERT FIFO + STATS 10/11 (#60)
        wr_chk(16'h0008, 32'h40, 4'hF, -1, "stats_clear");
        rd_chk(16'h0040, 0, "G5: empty ALERT reads 0");
        for (int k = 0; k < AD; k++) begin
            chk(!al_full, $sformatf("G5: al_full with %0d alerts", k));
            for (int j = 0; j < 4; j++) rrec[k][32 * j +: 32] = $random(seed);
            al_valid <= 1; al_data <= rrec[k][127:0]; @(posedge clk); al_valid <= 0;
            repeat ($random(seed) & 1) @(posedge clk);
        end
        @(posedge clk);
        chk(al_full, "G5: al_full not set with AL_DEPTH alerts");
        al_valid <= 1; al_data <= ~128'h0; @(posedge clk); al_valid <= 0;     // while full: dropped, counted
        al_drop <= 1; @(posedge clk); al_drop <= 0; @(posedge clk);
        axi_rd(16'h000C, v);
        chk(v[23:16] == AD && v[4], $sformatf("G5: STATUS alert count %0d avail %0d", v[23:16], v[4]));
        rd_chk(16'h0128, AD, "STATS 10 alerts raised");
        rd_chk(16'h012C, 2, "STATS 11 alerts dropped");
        for (int k = 0; k < AD; k++)
            for (int j = 0; j < 4; j++)
                rd_chk(16'h0040 + 4 * j, rrec[k][32 * j +: 32], $sformatf("G5: ALERT %0d word %0d", k, j));
        axi_rd(16'h000C, v);
        chk(v[23:16] == 0 && !v[4] && !al_full, $sformatf("G5: ALERT not empty after drain (%h)", v));
        rd_chk(16'h004C, 0, "G5: drained ALERT reads 0");

        // ---- DBG window (#64)
        rd_chk(16'h044C, 0, "DBG capture count 0 after hard reset");
        for (int i = 0; i < 16; i++) dbg_feat[32 * i +: 32] <= (i == 15) ? $random(seed) & 32'hFFFF : $random(seed);
        dbg_logits <= {$random(seed), $random(seed)}; dbg_rec_no <= $random(seed);
        @(posedge clk); dbg_valid <= 1; @(posedge clk); dbg_valid <= 0; @(posedge clk);
        for (int i = 0; i < 16; i++) rd_chk(16'h0400 + 4 * i, (i == 15) ? {16'h0, dbg_feat[495:480]} : dbg_feat[32 * i +: 32],
                                            $sformatf("DBG word %0d", i));
        rd_chk(16'h0440, dbg_logits[31:0], "DBG word 16");
        rd_chk(16'h0444, dbg_logits[63:32], "DBG word 17");
        rd_chk(16'h0448, dbg_rec_no, "DBG word 18");
        rd_chk(16'h044C, 1, "DBG word 19 capture count");

        // ---- weights
        for (int i = 0; i < 71; i++) begin
            v = $random(seed);
            wr_chk(16'h4000 + 4 * i, v, 4'hF, -1, "weight write");
            chk(wb_last_a == i && wb_last_d == v, $sformatf("weights: word %0d wb_addr %0d wb_wdata %h", i, wb_last_a, wb_last_d));
        end
        for (int i = 0; i < 71; i += 7) rd_chk(16'h4000 + 4 * i, wmem[i], $sformatf("weights: readback word %0d", i));
        cfgsave = wmem[5];
        wr_chk(16'h4014, 32'hAABBCCDD, 4'h5, -1, "weight partial write");
        chk(wb_last_a == 5 && wb_last_d == {cfgsave[31:24], 8'hBB, cfgsave[15:8], 8'hDD},
            $sformatf("weights: partial strobe RMW (#62) gave %h", wb_last_d));
        rd_chk(16'h4014, wmem[5], "weights: readback after partial write");
        wr_chk(16'h411C, 32'h1, 4'hF, -1, "write past the weight window");
        wr_chk(16'h4018, 32'h12345678, 4'h0, -1, "weight write with WSTRB = 0 (#101: no wb_we)");
        rd_chk(16'h4018, wmem[6], "weights: WSTRB = 0 write changed nothing");   // expects no wb_we (unmapped)

        // ---- soft reset keeps CONFIG, GLOBAL, DBG; clears STATS
        axi_rd(16'h1000 + 64 * 17 + 8, cfgsave);
        axi_rd(16'h0014, glbsave);
        wr_chk(16'h0008, 32'h0000_0002, 4'hF, -1, "soft_reset");
        rd_chk(16'h1000 + 64 * 17 + 8, cfgsave, "soft reset keeps CONFIG");
        rd_chk(16'h0014, glbsave, "soft reset keeps GLOBAL");
        rd_chk(16'h044C, 1, "soft reset keeps DBG (#64)");
        rd_chk(16'h0104, 0, "soft reset clears STATS");
        rd_chk(16'h0008, 32'h0, "CTRL after soft reset");

        // ================================================================ pass 1: hard reset, no delays
        rst_n <= 0; repeat (3) @(posedge clk); rst_n <= 1;
        rnd_on = 0;
        run_vectors(1);

        if (n_err == 0) $display("PASS: %0d checks (%0d vectors x 2 passes + directed G5/G6/G7/STATS/DBG/weights)", n_chk, n_vec);
        else $display("FAIL: %s (%0d failing checks of %0d)", first_err, n_err, n_chk);
        $finish;
    end

    initial begin
        #20_000_000;
        $display("FAIL: timeout (%0d checks, %0d failing%s%s)", n_chk, n_err, n_err ? ": " : "", first_err);
        $finish;
    end
endmodule

`default_nettype wire
