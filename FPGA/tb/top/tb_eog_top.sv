// tb_eog_top -- system testbench for eog_top (spec/modules/eog_top.md, regmap.md), Integration role (T2.top).
//
// Drives eog_top only through its external ports, exactly as the ARM / AXI DMA would:
//   1. hard reset; check ID and VERSION
//   2. GLOBAL (0x0010..0x002C) and the 32 CONFIG rows (words 1..15, then word 0 with FLAGS) from top_<case>.cfg.hex
//   3. the 71-word weight image (0x4000..0x4118) from top_<case>.wts.hex, read back, CTRL.swap_req, poll
//      STATUS.swap_pending = 0, check STATUS[31:24] = the image's version
//   4. CTRL.stream_en (+ src_dma in DMA mode)
//   5. per record of top_<case>.in.hex:
//        window mode: write DATA words 0..10, poll STATUS until data_busy = 0, write word 11 (push); pop every
//                     RESULT (0x0300..0x031C, the 0x031C read pops) and ALERT (0x0040..0x004C) STATUS reports
//        DMA mode   : 6 beats on s_axis (random gaps, tlast every 10th record and on the last); a collector takes
//                     4-beat RESULTs from m_axis under random tready back-pressure; ALERTs popped over AXI-Lite
//      Events of top_<case>.events.txt are applied before their record index after draining the pipeline:
//        hb -> CTRL.heartbeat, ack -> CTRL.server_ack (window mode) or a debounced BTN0 press (DMA mode),
//        swap -> CTRL.swap_req + poll swap_pending, wts k -> top_<case>.wts<k>.hex into the inactive bank,
//        cfg/touch -> disable (word 0 with FLAGS[0] = 0), rewrite, re-enable, hb_expire -> stop heartbeats and
//        wait for STATUS.autonomous
//   6. every RESULT is compared bit for bit with top_<case>.out.hex, every ALERT with top_<case>.al.hex (in push
//      order); STATS 0 (records in) and STATS 1 (results out) must equal the record count, STATS 12 (overruns) 0
//   7. eog_top.md T2 checks on every cycle: m_axis_tvalid = 0 in window mode; in DMA mode the RESULT FIFO count
//      (STATUS[15:8]) stays 0
//   8. window-mode cases without mid-stream weight/CONFIG events run a second pass after CTRL.soft_reset (no new
//      CONFIG, GLOBAL or weights): the results must be identical, which checks that soft reset keeps CONFIG, GLOBAL
//      and the weight banks (eog_head.wb_rst_n = hard reset only)
//
// Plusargs: +CASE=<name> runs one case (window mode, or DMA mode with +DMA=1); +LONG adds week and g1 to the
// default list. Default list (scripts/sim.sh top): g0 g2 g0v0 g2v0 g0v3 g2v3 in window mode, then g0 g2 in DMA mode.
// Prints per-case lines ("case ... ok" / "case ... MISMATCH"), then exactly one PASS: or FAIL: line.

`timescale 1ns/1ps

module tb_eog_top;
    localparam integer N_FAC = 32;
    localparam integer CYC   = 1000;        // CYC_PER_MS (shrunk: heartbeat timeouts and BTN0 debounce stay short)
    localparam integer DEB   = 2;           // DEB_MS
    localparam integer MAXR  = 32768;       // records per case
    localparam integer MAXA  = 1024;        // alerts per case
    localparam integer MAXE  = 1024;        // events per case
    localparam [31:0]  A_CTRL = 32'h0008, A_STATUS = 32'h000C, A_GLB = 32'h0010, A_ALERT = 32'h0040,
                       A_STATS = 32'h0100, A_DATA = 32'h0200, A_RES = 32'h0300, A_CFG = 32'h1000,
                       A_WTS = 32'h4000;

    logic clk = 1'b0;
    always #5 clk = ~clk;                   // 100 MHz
    logic rst_n = 1'b0;

    // AXI-Lite master
    logic [15:0] awaddr = 0, araddr = 0;
    logic        awvalid = 0, wvalid = 0, arvalid = 0;
    logic [31:0] wdata = 0;
    logic [3:0]  wstrb = 0;
    logic        awready, wready, bvalid, arready, rvalid;
    logic [1:0]  bresp, rresp;
    logic [31:0] rdata;
    // AXI-Stream
    logic [63:0] s_tdata = 0;
    logic        s_tvalid = 0, s_tlast = 0, s_tready;
    logic [63:0] m_tdata;
    logic        m_tvalid, m_tlast;
    logic        m_tready = 0;
    logic        btn0 = 0;
    logic [2:0]  ld0, ld1;
    logic [7:0]  pmod_ja, pmod_jb;

    eog_top #(.N_FAC(N_FAC), .CYC_PER_MS(CYC), .DEB_MS(DEB)) dut (
        .clk(clk), .rst_n(rst_n),
        .s_axi_awaddr(awaddr), .s_axi_awvalid(awvalid), .s_axi_awready(awready),
        .s_axi_wdata(wdata), .s_axi_wstrb(wstrb), .s_axi_wvalid(wvalid), .s_axi_wready(wready),
        .s_axi_bresp(bresp), .s_axi_bvalid(bvalid), .s_axi_bready(1'b1),
        .s_axi_araddr(araddr), .s_axi_arvalid(arvalid), .s_axi_arready(arready),
        .s_axi_rdata(rdata), .s_axi_rresp(rresp), .s_axi_rvalid(rvalid), .s_axi_rready(1'b1),
        .s_axis_tdata(s_tdata), .s_axis_tvalid(s_tvalid), .s_axis_tready(s_tready), .s_axis_tlast(s_tlast),
        .m_axis_tdata(m_tdata), .m_axis_tvalid(m_tvalid), .m_axis_tready(m_tready), .m_axis_tlast(m_tlast),
        .btn0(btn0), .ld0(ld0), .ld1(ld1), .pmod_ja(pmod_ja), .pmod_jb(pmod_jb)
    );

    // ------------------------------------------------------------------------------------------ case data
    logic [383:0] vin  [0:MAXR-1];
    logic [255:0] vout [0:MAXR-1];
    logic [511:0] vcfg [0:32];
    logic [31:0]  vwts [0:70];
    logic [31:0]  vimg [0:70];
    logic [127:0] eal  [0:MAXA-1];
    integer       ev_idx [0:MAXE-1];
    integer       ev_kind[0:MAXE-1];      // 0 hb 1 hb_expire 2 ack 3 swap 4 wts 5 cfg 6 touch
    integer       ev_arg [0:MAXE-1];
    logic [511:0] ev_row [0:MAXE-1];
    integer       n_rec, n_al, n_ev;
    string        base;

    // ------------------------------------------------------------------------------------------ state
    integer cyc = 0;
    always @(posedge clk) cyc <= cyc + 1;
    integer got, mism, al_got, al_mism, errs;
    integer dma_mode = 0;       // 1 while a DMA-mode case runs
    integer running  = 0;       // 1 while records stream (for the T2 checks)
    integer seed     = 1;
    integer hb_T     = 0;       // GLOBAL HB_TIMEOUT_MS
    integer fresh    = 0;       // keep the heartbeat alive
    integer last_hb  = 0;
    integer n_ack    = 0;
    logic [31:0] ctrl_base = 0; // stream_en | src_dma
    string  cname;

    function automatic integer rnd(input integer n);
        rnd = $unsigned($random(seed)) % n;
    endfunction

    task automatic err(input string s);
        if (errs < 20) $display("  ERROR %s (cycle %0d)", s, cyc);
        errs = errs + 1;
    endtask

    // ------------------------------------------------------------------------------------------ AXI-Lite master
    // Signals change 1 ns after a rising edge; handshakes are judged at the falling edge before the next rising edge.
    task automatic axi_wr(input [15:0] a, input [31:0] d);
        logic hs_a, hs_w;
        @(posedge clk); #1;
        awaddr = a; wdata = d; wstrb = 4'hF; awvalid = 1; wvalid = 1;
        while (awvalid || wvalid) begin
            @(negedge clk);
            hs_a = awvalid & awready; hs_w = wvalid & wready;
            @(posedge clk); #1;
            if (hs_a) awvalid = 0;
            if (hs_w) wvalid = 0;
        end
        hs_a = 0;
        while (!hs_a) begin @(negedge clk); hs_a = bvalid; @(posedge clk); #1; end
        if (bresp !== 2'b00) err($sformatf("BRESP %0d at %04h", bresp, a));
    endtask

    task automatic axi_rd(input [15:0] a, output [31:0] d);
        logic hs;
        @(posedge clk); #1;
        araddr = a; arvalid = 1;
        while (arvalid) begin
            @(negedge clk); hs = arready;
            @(posedge clk); #1;
            if (hs) arvalid = 0;
        end
        hs = 0;
        while (!hs) begin @(negedge clk); hs = rvalid; d = rdata; @(posedge clk); #1; end
        if (rresp !== 2'b00) err($sformatf("RRESP %0d at %04h", rresp, a));
    endtask

    // ------------------------------------------------------------------------------------------ RESULT check
    task automatic check_result(input logic [255:0] r);
        logic [255:0] e;
        if (got >= n_rec) begin
            err($sformatf("extra RESULT %064h", r));
            mism = mism + 1;
        end else begin
            e = vout[got];
            if (r !== e) begin
                mism = mism + 1;
                if (mism <= 5) begin
                    $display("  MISMATCH record %0d:", got);
                    $display("    expected %064h", e);
                    $display("    got      %064h", r);
                    if (r[15:0]    !== e[15:0])    $display("    FAC_ID      exp %h got %h", e[15:0], r[15:0]);
                    if (r[23:16]   !== e[23:16])   $display("    STATUS      exp %h got %h", e[23:16], r[23:16]);
                    if (r[31:24]   !== e[31:24])   $display("    SINCE_RESET exp %h got %h", e[31:24], r[31:24]);
                    if (r[63:32]   !== e[63:32])   $display("    TS          exp %h got %h", e[63:32], r[63:32]);
                    if (r[95:64]   !== e[95:64])   $display("    REASON      exp %h got %h", e[95:64], r[95:64]);
                    if (r[159:96]  !== e[159:96])  $display("    LOGITS      exp %h got %h", e[159:96], r[159:96]);
                    if (r[167:160] !== e[167:160]) $display("    RULES       exp %h got %h", e[167:160], r[167:160]);
                    if (r[175:168] !== e[175:168]) $display("    WVER        exp %h got %h", e[175:168], r[175:168]);
                    if (r[223:176] !== e[223:176]) $display("    CD          exp %h got %h", e[223:176], r[223:176]);
                    if (r[255:224] !== e[255:224]) $display("    RESULT_NO   exp %h got %h", e[255:224], r[255:224]);
                end
            end
        end
        got = got + 1;
    endtask

    task automatic check_alert(input logic [127:0] a);
        if (al_got >= n_al) begin
            al_mism = al_mism + 1;
            if (al_mism <= 5) $display("  ALERT MISMATCH: unexpected alert %032h (expected %0d)", a, n_al);
        end else if (a !== eal[al_got]) begin
            al_mism = al_mism + 1;
            if (al_mism <= 5) $display("  ALERT MISMATCH %0d: expected %032h got %032h", al_got, eal[al_got], a);
        end
        al_got = al_got + 1;
    endtask

    task automatic pop_result;
        logic [255:0] r;
        logic [31:0]  w;
        integer j;
        for (j = 0; j < 8; j = j + 1) begin
            axi_rd(A_RES + 4 * j, w);
            r[32*j +: 32] = w;
        end
        check_result(r);
    endtask

    task automatic pop_alert;
        logic [127:0] a;
        logic [31:0]  w;
        integer j;
        for (j = 0; j < 4; j = j + 1) begin
            axi_rd(A_ALERT + 4 * j, w);
            a[32*j +: 32] = w;
        end
        check_alert(a);
    endtask

    // read STATUS, pop what it reports; returns STATUS
    task automatic service(output logic [31:0] st);
        integer k;
        axi_rd(A_STATUS, st);
        if (!dma_mode) for (k = 0; k < st[15:8]; k = k + 1) pop_result;
        for (k = 0; k < st[23:16]; k = k + 1) pop_alert;
    endtask

    // m_axis collector (DMA mode): random tready, 4 beats per RESULT
    logic [255:0] m_acc;
    integer       m_beat = 0;
    always @(posedge clk) begin
        if (m_tvalid && m_tready) begin
            m_acc[64*m_beat +: 64] = m_tdata;
            if (m_beat == 3) begin
                m_beat = 0;
                check_result(m_acc);
            end else m_beat = m_beat + 1;
        end
    end
    always @(posedge clk) begin
        #1 m_tready = dma_mode ? (rnd(4) != 0) : 1'b0;
    end

    // T2 checks (eog_top.md): nothing on m_axis in window mode; nothing in the RESULT FIFO in DMA mode
    always @(negedge clk) begin
        if (rst_n && !dma_mode && m_tvalid) err("m_axis_tvalid = 1 while src_dma = 0");
        if (rst_n && dma_mode && running && dut.u_regs.r_valid) err("RESULT FIFO push while src_dma = 1");
    end

    // ------------------------------------------------------------------------------------------ helpers
    task automatic heartbeat;
        axi_wr(A_CTRL, ctrl_base | 32'h4);
        last_hb = cyc;
    endtask

    task automatic keep_alive;
        if (fresh && hb_T != 0 && (cyc - last_hb) > (hb_T * CYC) / 2) heartbeat;
    endtask

    task automatic drain(input integer target);
        logic [31:0] st;
        integer t0;
        t0 = cyc;
        while (got < target) begin
            keep_alive;
            if (dma_mode) begin @(posedge clk); if ((cyc - t0) % 64 == 0) service(st); end
            else service(st);
            if (cyc - t0 > 200000) begin
                err($sformatf("drain timeout: %0d of %0d results", got, target));
                got = target;
            end
        end
    endtask

    task automatic write_row(input integer slot, input logic [511:0] row);
        integer j;
        for (j = 1; j < 16; j = j + 1) axi_wr(A_CFG + 64 * slot + 4 * j, row[32*j +: 32]);
        axi_wr(A_CFG + 64 * slot, row[31:0]);
    endtask

    task automatic load_image(input integer k);
        integer j;
        logic [31:0] w;
        for (j = 0; j < 71; j = j + 1) axi_wr(A_WTS + 4 * j, vimg[j]);
        for (j = 0; j < 71; j = j + 1) begin
            axi_rd(A_WTS + 4 * j, w);
            if (w !== vimg[j]) err($sformatf("weight readback (image %0d) word %0d: %08h, expected %08h",
                                             k, j, w, vimg[j]));
        end
    endtask

    task automatic do_swap;
        logic [31:0] st;
        integer t0;
        axi_wr(A_CTRL, ctrl_base | 32'h8);
        t0 = cyc;
        st = 32'h2;
        while (st[1]) begin
            axi_rd(A_STATUS, st);
            if (cyc - t0 > 10000) begin err("swap_pending stuck"); st = 0; end
        end
    endtask

    task automatic do_ack;
        integer t;
        n_ack = n_ack + 1;
        if (dma_mode && n_ack % 2 == 0) begin
            // BTN0 press: hold past the debounce, then release (also past the debounce)
            btn0 = 1;
            for (t = 0; t < (DEB + 1) * CYC + 8; t = t + 1) @(posedge clk);
            btn0 = 0;
            for (t = 0; t < (DEB + 1) * CYC + 8; t = t + 1) @(posedge clk);
        end else axi_wr(A_CTRL, ctrl_base | 32'h10);
    endtask

    task automatic do_event(input integer e);
        logic [31:0] st, w0;
        integer t0;
        string fn;
        case (ev_kind[e])
            0: begin fresh = 1; heartbeat; end
            1: begin
                fresh = 0;
                t0 = cyc;
                st = 0;
                if (hb_T != 0) while (!st[0]) begin
                    axi_rd(A_STATUS, st);
                    if (cyc - t0 > (hb_T + 3) * CYC + 1000) begin err("autonomous never set"); st = 1; end
                end
            end
            2: do_ack;
            3: do_swap;
            4: begin
                fn = $sformatf("%s.wts%0d.hex", base, ev_arg[e]);
                $readmemh(fn, vimg);
                load_image(ev_arg[e]);
            end
            5, 6: begin
                // ARM procedure (TASKS #69): disable the slot (word 0 with FLAGS[0] = 0), rewrite, re-enable
                axi_rd(A_CFG + 64 * ev_arg[e], w0);
                if (w0[24]) axi_wr(A_CFG + 64 * ev_arg[e], w0 & ~32'h0100_0000);
                if (ev_kind[e] == 5) write_row(ev_arg[e], ev_row[e]);
                else axi_wr(A_CFG + 64 * ev_arg[e], w0);
            end
            default: err("unknown event");
        endcase
    endtask

    // ------------------------------------------------------------------------------------------ case loading
    function automatic integer count_lines(input string fname);
        integer fd, r, n;
        reg [8*1024-1:0] line;
        n = 0;
        fd = $fopen(fname, "r");
        if (fd == 0) return -1;
        while (!$feof(fd)) begin
            r = $fgets(line, fd);
            if (r > 1) n = n + 1;
        end
        $fclose(fd);
        return n;
    endfunction

    task automatic load_case(input string nm, output integer ok);
        integer fd, r, idx, num;
        string kind, cause;
        logic [511:0] hx;
        logic [127:0] al;
        ok = 0;
        base = {"tb/vectors/top_", nm};
        n_rec = count_lines({base, ".in.hex"});
        if (n_rec <= 0 || n_rec > MAXR) begin $display("  no or bad %s.in.hex", base); return; end
        if (count_lines({base, ".out.hex"}) != n_rec) begin $display("  %s: in/out line counts differ", base); return; end
        $readmemh({base, ".in.hex"}, vin, 0, n_rec - 1);
        $readmemh({base, ".out.hex"}, vout, 0, n_rec - 1);
        $readmemh({base, ".cfg.hex"}, vcfg);
        $readmemh({base, ".wts.hex"}, vwts);
        n_al = 0;
        fd = $fopen({base, ".al.txt"}, "r");
        if (fd != 0) begin
            while (!$feof(fd)) begin
                r = $fscanf(fd, "%d %s %h\n", idx, cause, al);
                if (r == 3 && n_al < MAXA) begin eal[n_al] = al; n_al = n_al + 1; end
                else break;
            end
            $fclose(fd);
        end
        n_ev = 0;
        fd = $fopen({base, ".events.txt"}, "r");
        if (fd != 0) begin
            while (!$feof(fd)) begin
                r = $fscanf(fd, "%d %s %d %h\n", idx, kind, num, hx);
                if (r == 4 && n_ev < MAXE) begin
                    ev_idx[n_ev] = idx; ev_arg[n_ev] = num; ev_row[n_ev] = hx;
                    ev_kind[n_ev] = (kind == "hb") ? 0 : (kind == "hb_expire") ? 1 : (kind == "ack") ? 2 :
                                    (kind == "swap") ? 3 : (kind == "wts") ? 4 : (kind == "cfg") ? 5 :
                                    (kind == "touch") ? 6 : 7;
                    n_ev = n_ev + 1;
                end else break;
            end
            $fclose(fd);
        end
        ok = 1;
    endtask

    // ------------------------------------------------------------------------------------------ one case
    integer total_rec = 0, total_cases = 0, bad_cases = 0;

    task automatic hard_reset;
        integer t;
        rst_n = 0;
        dma_mode = 0; running = 0;
        s_tvalid = 0; s_tlast = 0; btn0 = 0;
        awvalid = 0; wvalid = 0; arvalid = 0;
        for (t = 0; t < 8; t = t + 1) @(posedge clk);
        #1 rst_n = 1;
    endtask

    task automatic send_beats(input integer i);
        integer b;
        logic hs;
        for (b = 0; b < 6; b = b + 1) begin
            @(posedge clk); #1;
            while (rnd(5) == 0) begin s_tvalid = 0; @(posedge clk); #1; end
            s_tdata = vin[i][64*b +: 64];
            s_tlast = (b == 5) && ((i % 10) == 9 || i == n_rec - 1);
            s_tvalid = 1;
            hs = 0;
            while (!hs) begin
                @(negedge clk); hs = s_tready;
                if (!hs) @(posedge clk);
            end
        end
        @(posedge clk); #1 s_tvalid = 0; s_tlast = 0;
    endtask

    // run the stream part of a case (configuration already done)
    task automatic stream(input integer pass);
        integer i, e, j, t0;
        logic [31:0] st, w;
        got = 0; mism = 0; al_got = 0; al_mism = 0;
        e = 0;
        running = 1;
        for (i = 0; i < n_rec; i = i + 1) begin
            if (e < n_ev && ev_idx[e] == i) begin
                drain(i);
                while (e < n_ev && ev_idx[e] == i) begin do_event(e); e = e + 1; end
            end
            keep_alive;
            if (dma_mode) begin
                send_beats(i);
                if (i % 16 == 15) service(st);
            end else begin
                for (j = 0; j < 11; j = j + 1) axi_wr(A_DATA + 4 * j, vin[i][32*j +: 32]);
                service(st);
                t0 = cyc;
                while (st[5]) begin
                    service(st);
                    if (cyc - t0 > 100000) begin err("data_busy stuck"); st = 0; end
                end
                axi_wr(A_DATA + 4 * 11, vin[i][383:352]);
            end
        end
        drain(n_rec);
        while (e < n_ev) begin do_event(e); e = e + 1; end   // trailing events (e.g. a final ack)
        for (j = 0; j < 400; j = j + 1) @(posedge clk);
        service(st);
        service(st);
        running = 0;
        if (al_got != n_al) begin
            al_mism = al_mism + 1;
            $display("  ALERT count %0d, expected %0d", al_got, n_al);
        end
        if (got != n_rec) $display("  RESULT count %0d, expected %0d", got, n_rec);
        if (dma_mode && st[15:8] != 0) err("RESULT FIFO not empty after a DMA-mode run");
        axi_rd(A_STATS + 0, w);  if (w != n_rec) err($sformatf("STATS 0 (records in) = %0d, expected %0d", w, n_rec));
        axi_rd(A_STATS + 4, w);  if (w != n_rec) err($sformatf("STATS 1 (results out) = %0d, expected %0d", w, n_rec));
        axi_rd(A_STATS + 48, w); if (w != 0)     err($sformatf("STATS 12 (DATA overruns) = %0d", w));
        axi_rd(A_STATS + 44, w); if (w != 0)     err($sformatf("STATS 11 (alerts dropped) = %0d", w));
        $display("case %-6s %-6s pass %0d: %0d records, %0d RESULTs, %0d mismatches; %0d/%0d ALERTs, %0d alert mismatches; %0d other errors -> %s",
                 cname, dma_mode ? "dma" : "window", pass, n_rec, got, mism, al_got, n_al, al_mism, errs,
                 (mism == 0 && al_mism == 0 && got == n_rec && errs == 0) ? "ok" : "MISMATCH");
        total_rec = total_rec + n_rec;
        total_cases = total_cases + 1;
        if (!(mism == 0 && al_mism == 0 && got == n_rec && errs == 0)) bad_cases = bad_cases + 1;
    endtask

    task automatic run_case(input string nm, input integer dma);
        integer ok, s, j, has_cfg_ev;
        logic [31:0] w;
        cname = nm;
        errs = 0;
        load_case(nm, ok);
        if (!ok) begin
            $display("case %-6s: vectors missing -> MISMATCH", nm);
            bad_cases = bad_cases + 1; total_cases = total_cases + 1;
            return;
        end
        seed = 7 + n_rec;
        hard_reset;
        n_ack = 0; fresh = 0;
        ctrl_base = 0;
        axi_rd(16'h0000, w); if (w != 32'h31474F45) err($sformatf("ID = %08h", w));
        axi_rd(16'h0004, w); if (w[7:0] != 8'd4 || w[15:8] != N_FAC || w[23:16] != 8) err($sformatf("VERSION = %08h", w));
        // GLOBAL, then CONFIG rows (words 1..15, then word 0 with FLAGS)
        for (j = 0; j < 8; j = j + 1) axi_wr(A_GLB + 4 * j, vcfg[0][32*j +: 32]);
        hb_T = vcfg[0][63:48];
        for (s = 0; s < N_FAC; s = s + 1) if (vcfg[1 + s] != 0) write_row(s, vcfg[1 + s]);
        for (j = 0; j < 8; j = j + 1) begin
            axi_rd(A_GLB + 4 * j, w);
            if (w !== vcfg[0][32*j +: 32]) err($sformatf("GLOBAL word %0d reads %08h, expected %08h", j, w, vcfg[0][32*j +: 32]));
        end
        // weights: inactive bank, read back, swap
        for (j = 0; j < 71; j = j + 1) vimg[j] = vwts[j];
        load_image(0);
        do_swap;
        axi_rd(A_STATUS, w);
        if (w[31:24] !== vwts[70][7:0]) err($sformatf("active version %0d, expected %0d", w[31:24], vwts[70][7:0]));
        // stream
        dma_mode = dma;
        ctrl_base = dma ? 32'h21 : 32'h01;
        axi_wr(A_CTRL, ctrl_base);
        stream(1);
        // soft-reset re-run (window mode, no mid-stream weight/CONFIG events)
        has_cfg_ev = 0;
        for (j = 0; j < n_ev; j = j + 1) if (ev_kind[j] >= 3) has_cfg_ev = 1;
        if (!dma && !has_cfg_ev && n_rec <= 1000) begin
            axi_wr(A_CTRL, ctrl_base | 32'h2);
            for (j = 0; j < 2 * N_FAC + 40; j = j + 1) @(posedge clk);
            axi_rd(A_STATUS, w);
            if (w[31:24] !== vwts[70][7:0]) err("soft reset changed the active weights version");
            fresh = 0; n_ack = 0;
            stream(2);
        end
    endtask

    // ------------------------------------------------------------------------------------------ main
    initial begin : main
        string nm;
        integer dma;
        hard_reset;
        if ($value$plusargs("CASE=%s", nm)) begin
            if (!$value$plusargs("DMA=%d", dma)) dma = 0;
            run_case(nm, dma);
        end else begin
            run_case("g0", 0);
            run_case("g2", 0);
            run_case("g0v0", 0);
            run_case("g2v0", 0);
            run_case("g0v3", 0);
            run_case("g2v3", 0);
            run_case("g0", 1);
            run_case("g2", 1);
            if ($test$plusargs("LONG")) begin
                run_case("week", 0);
                run_case("g1", 0);
            end
        end
        if (bad_cases == 0) $display("PASS: %0d records in %0d case runs", total_rec, total_cases);
        else $display("FAIL: %0d of %0d case runs mismatched", bad_cases, total_cases);
        $finish;
    end
endmodule
