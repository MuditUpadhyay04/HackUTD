// tb_eog_head.sv -- simulation of eog_head against the golden vectors (Verify role, task T1.head.fv).
//
// Written from spec/modules/eog_head.md + numerics.md section 8 (spec v4: D11 weight window, D12 debug capture;
// rulings #23 NO_MODEL, #25 DROPPED WVER = 0) and tb/README.md. `bash scripts/sim.sh head`.
//
// Cases: every `case <name>` line of <vecdir>/INDEX.txt whose <vecdir>/head_<name>.in.hex exists (the git-ignored
// *_week files only when generated). <vecdir> = tb/vectors, or +vecdir=<path>. Per case, from model/gen_vectors.py:
//   head_<c>.in.hex / .out.hex   bus C in, bus L expected, one record per line, in order
//   head_<c>.wts.hex             71-word window image active at the start (the model writes it into the inactive
//                                bank and swaps)
//   head_<c>.wts<k>.hex          image of event "wts k"
//   head_<c>.events.txt          "<record index> <kind> <arg> <hex>": before record <index> is accepted,
//                                `wts k` writes image k into the inactive bank, `swap` pulses swap_req
// Each case runs twice from a hard reset (wb_rst_n tied to rst_n): mode 0 with random in_valid gaps, random garbage
// on in_data while invalid, random out_ready back-pressure and random gaps between weight writes; mode 1 with
// in_valid presented back to back and out_ready held 1, which also checks II <= 16 (no 16 consecutive cycles with
// in_valid = 1 and in_ready = 0) and latency <= 128 (accept to first out_valid). Each run ends with a soft reset
// (rst_n = 0 for 2 cycles, wb_rst_n = 1) after which active_bank, active_ver, swap_pending and the inactive bank's
// readback must be unchanged (spec v3).
//
// Weight port checks: after every hard reset active_bank = 0, active_ver = 0, swap_pending = 0 and the inactive
// bank's word 70 reads 0; every image written is read back word by word (all 71 words) with the data exactly 1 cycle
// after wb_raddr; a swap request is followed by swap_pending = 1 until active_bank toggles and 0 in the toggle cycle
// (back-to-back swaps wait for swap_pending = 0, #17); after the swap active_ver is word 70 [7:0] of the new bank and
// the now-inactive bank (the old active one) reads back unchanged. A swap requested while the previous record is
// still in flight must wait for it (that record's expected WVER/LOGITS are the old bank's).
//
// Debug capture (D12): dbg_fac = the FAC of record 0 (mode 0) or record 1 (mode 1). Every output transfer of a
// VALID/HELD record with that FAC must have been preceded (or accompanied) by exactly one dbg_valid pulse with its
// REC_NO, its 31 input features and its output logits; no pulse for any other record.
//
// Every output transfer is compared with the next .out.hex line on all EOG_BL_W bits; the handshake rules
// (out_valid held, out_data stable until the transfer) are checked every cycle. Prints exactly one final line:
// `PASS: <n> records ...` or `FAIL: <case, mode, record, field, expected, got>`.

`timescale 1ns/1ps

module tb_eog_head;
    `include "eog_defs.svh"

    localparam integer MAXREC = 65536;   // records per case (week: 30240)
    localparam integer MAXEV  = 4096;
    localparam integer NW     = EOG_WIN_WORDS;
    localparam integer W_VER  = 70;      // window word holding VER [7:0]

    logic                clk = 1'b0;
    logic                rst_n = 1'b0;
    logic                wb_rst_n = 1'b0;
    logic                in_valid = 1'b0;
    logic [EOG_BC_W-1:0] in_data = '0;
    logic                in_ready;
    logic                out_valid;
    logic                out_ready = 1'b0;
    logic [EOG_BL_W-1:0] out_data;
    logic                wb_we = 1'b0;
    logic [6:0]          wb_addr = '0;
    logic [31:0]         wb_wdata = '0;
    logic [6:0]          wb_raddr = '0;
    logic [31:0]         wb_rdata;
    logic                swap_req = 1'b0;
    logic                swap_pending, active_bank;
    logic [7:0]          active_ver;
    logic [4:0]          dbg_fac = '0;
    logic                dbg_valid;
    logic [495:0]        dbg_feat;
    logic [63:0]         dbg_logits;
    logic [31:0]         dbg_rec_no;

    eog_head #(.II(EOG_II_MAX), .N_FEAT(EOG_N_FEAT), .N_CLS(EOG_N_CLS)) dut (
        .clk(clk), .rst_n(rst_n), .wb_rst_n(wb_rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data),
        .wb_we(wb_we), .wb_addr(wb_addr), .wb_wdata(wb_wdata), .wb_raddr(wb_raddr), .wb_rdata(wb_rdata),
        .swap_req(swap_req), .swap_pending(swap_pending), .active_bank(active_bank), .active_ver(active_ver),
        .dbg_fac(dbg_fac), .dbg_valid(dbg_valid), .dbg_feat(dbg_feat), .dbg_logits(dbg_logits),
        .dbg_rec_no(dbg_rec_no));

    always #5 clk = ~clk;

    // ------------------------------------------------------------------------------------------- bookkeeping
    integer      seed = 32'h4EAD_2026;
    integer      cyc = 0;
    integer      mode = 0;              // 0 random gaps/back-pressure, 1 full rate
    reg [8*32-1:0]  cname;              // current case name
    reg [8*200-1:0] vecdir;
    integer      fd_out = 0;
    integer      n_out = 0;             // outputs checked in the current case
    integer      n_acc = 0;             // records accepted in the current case
    integer      n_tot = 0;             // outputs checked, all cases and modes
    integer      n_dbg = 0;             // debug captures checked, all cases and modes
    integer      acc_cyc [0:MAXREC-1];
    logic [495:0] in_feat [0:63];       // input FEAT of record i at [i % 64]
    integer      ii_wait = 0, ii_max = 0, lat_max = 0;
    logic        lat_done = 1'b0;
    logic        running = 1'b0;        // checker active (between a case's reset and its drain)

    always @(posedge clk) cyc <= cyc + 1;

    task automatic fail(input [8*200-1:0] msg);
        $display("FAIL: case %0s mode %0d: %0s", cname, mode, msg);
        $finish;
    endtask

    // field names for mismatch messages (bus L, eog_defs.svh offsets)
    task automatic cmp_field(input [8*12-1:0] fname, input integer lsb, input integer w,
                             input [EOG_BL_W-1:0] exp, input [EOG_BL_W-1:0] got, inout logic bad);
        logic [63:0] e, g;
        e = (exp >> lsb) & ((64'd1 << w) - 64'd1);
        g = (got >> lsb) & ((64'd1 << w) - 64'd1);
        if (!bad && e !== g) begin
            bad = 1'b1;
            $display("FAIL: case %0s mode %0d: record %0d field %0s expected 0x%0h got 0x%0h", cname, mode, n_out,
                     fname, e, g);
            $finish;
        end
    endtask

    // ---------------------------------------------------------------------------------- debug-capture FIFO
    localparam integer DQ = 8;
    logic [31:0]  dq_rec [0:DQ-1];
    logic [495:0] dq_feat [0:DQ-1];
    logic [63:0]  dq_log [0:DQ-1];
    integer       dq_n = 0;

    // ---------------------------------------------------------------------------------- output checker
    logic [EOG_BL_W-1:0] exp_l;
    logic                prev_ov = 1'b0, prev_or = 1'b0;
    logic [EOG_BL_W-1:0] prev_od;
    integer              r, q;
    logic                bad, qual;
    logic [2:0]          e_st;

    always @(posedge clk) begin
        if (running && rst_n) begin
            if (out_valid !== 1'b0 && out_valid !== 1'b1) fail("out_valid is X");
            if (in_ready !== 1'b0 && in_ready !== 1'b1) fail("in_ready is X");
            if (dbg_valid !== 1'b0 && dbg_valid !== 1'b1) fail("dbg_valid is X");
            // debug pulses queue up until their record's output transfer
            if (dbg_valid) begin
                if (dq_n >= DQ) fail("more than 8 debug captures ahead of the outputs");
                dq_rec[dq_n]  = dbg_rec_no;
                dq_feat[dq_n] = dbg_feat;
                dq_log[dq_n]  = dbg_logits;
                dq_n = dq_n + 1;
            end
            // conventions section 2: valid held, data stable until the transfer
            if (prev_ov && !prev_or) begin
                if (!out_valid) fail("out_valid dropped before the transfer");
                if (out_data !== prev_od) fail("out_data changed while out_valid && !out_ready");
            end
            // latency (mode 1, out_ready always 1): accept to the first out_valid of that record
            if (out_valid && !lat_done) begin
                if (n_out >= n_acc) fail("out_valid with no record in flight");
                if (cyc - acc_cyc[n_out] > lat_max) lat_max = cyc - acc_cyc[n_out];
                if (mode == 1 && cyc - acc_cyc[n_out] > 128) fail("latency above 128 cycles");
                lat_done = 1'b1;
            end
            if (out_valid && out_ready) begin
                r = $fscanf(fd_out, "%h\n", exp_l);
                if (r != 1) fail("more outputs than expected records");
                bad = 1'b0;
                cmp_field("REC_NO",      EOG_BL_REC_NO,      EOG_BL_REC_NO_W,      exp_l, out_data, bad);
                cmp_field("IN_LAST",     EOG_BL_IN_LAST,     EOG_BL_IN_LAST_W,     exp_l, out_data, bad);
                cmp_field("FAC_RAW",     EOG_BL_FAC_RAW,     EOG_BL_FAC_RAW_W,     exp_l, out_data, bad);
                cmp_field("FAC",         EOG_BL_FAC,         EOG_BL_FAC_W,         exp_l, out_data, bad);
                cmp_field("TS",          EOG_BL_TS,          EOG_BL_TS_W,          exp_l, out_data, bad);
                cmp_field("STATUS",      EOG_BL_STATUS,      EOG_BL_STATUS_W,      exp_l, out_data, bad);
                cmp_field("REASON",      EOG_BL_REASON,      EOG_BL_REASON_W,      exp_l, out_data, bad);
                cmp_field("SINCE_RESET", EOG_BL_SINCE_RESET, EOG_BL_SINCE_RESET_W, exp_l, out_data, bad);
                cmp_field("HIST_RESET",  EOG_BL_HIST_RESET,  EOG_BL_HIST_RESET_W,  exp_l, out_data, bad);
                cmp_field("CH3",         EOG_BL_CH3,         EOG_BL_CH3_W,         exp_l, out_data, bad);
                cmp_field("RULES",       EOG_BL_RULES,       EOG_BL_RULES_W,       exp_l, out_data, bad);
                cmp_field("CD",          EOG_BL_CD,          EOG_BL_CD_W,          exp_l, out_data, bad);
                cmp_field("LOGIT0",      EOG_BL_LOGITS,      16,                   exp_l, out_data, bad);
                cmp_field("LOGIT1",      EOG_BL_LOGITS + 16, 16,                   exp_l, out_data, bad);
                cmp_field("LOGIT2",      EOG_BL_LOGITS + 32, 16,                   exp_l, out_data, bad);
                cmp_field("LOGIT3",      EOG_BL_LOGITS + 48, 16,                   exp_l, out_data, bad);
                cmp_field("WVER",        EOG_BL_WVER,        EOG_BL_WVER_W,        exp_l, out_data, bad);
                if (out_data !== exp_l) fail("bus L differs (X bits?)");
                // debug capture of this record
                e_st = exp_l[EOG_BL_STATUS +: 3];
                qual = (e_st == EOG_ST_VALID || e_st == EOG_ST_HELD) && exp_l[EOG_BL_FAC +: 5] == dbg_fac;
                if (qual) begin
                    if (dq_n == 0 || dq_rec[0] !== exp_l[EOG_BL_REC_NO +: 32])
                        fail("no dbg_valid capture for a VALID/HELD record of the DBG facility");
                    if (dq_feat[0] !== in_feat[n_out % 64]) fail("dbg_feat differs from the record's features");
                    if (dq_log[0] !== exp_l[EOG_BL_LOGITS +: 64]) fail("dbg_logits differs from the record's logits");
                    for (q = 1; q < DQ; q = q + 1) begin
                        dq_rec[q-1]  = dq_rec[q];
                        dq_feat[q-1] = dq_feat[q];
                        dq_log[q-1]  = dq_log[q];
                    end
                    dq_n  = dq_n - 1;
                    n_dbg = n_dbg + 1;
                end else if (dq_n != 0 && dq_rec[0] === exp_l[EOG_BL_REC_NO +: 32]) begin
                    fail("dbg_valid capture for a record that is not VALID/HELD of the DBG facility");
                end
                n_out    = n_out + 1;
                n_tot    = n_tot + 1;
                lat_done = 1'b0;
            end
            // II (mode 1: in_valid back to back, out_ready = 1)
            if (in_valid && in_ready) begin
                acc_cyc[n_acc] = cyc;
                n_acc   = n_acc + 1;
                ii_wait = 0;
            end else if (in_valid && out_ready) begin
                ii_wait = ii_wait + 1;
                if (ii_wait > ii_max) ii_max = ii_wait;
                if (mode == 1 && ii_wait >= EOG_II_MAX) fail("16 cycles with in_valid = 1, out_ready = 1, no accept");
            end else ii_wait = 0;
        end
        prev_ov = (out_valid === 1'b1) && rst_n;
        prev_or = out_ready;
        prev_od = out_data;
    end

    // back-pressure
    always @(negedge clk) begin
        if (mode == 1) out_ready = 1'b1;
        else           out_ready = ($unsigned($random(seed)) % 100) < (((cyc / 512) % 4 == 3) ? 15 : 65);
    end

    // ------------------------------------------------------------------------------------- weight port
    logic [31:0] img_buf [0:NW-1];
    logic [31:0] bank_w  [0:2*NW-1];    // tb's view of both banks: bank b word w at [NW*b + w]
    logic        bank_k  [0:2*NW-1];    // known (written since the last hard reset; word 70 known 0 after it)
    integer      n_img = 0, n_swap = 0;

    task automatic gap();
        integer g;
        if (mode == 0) begin
            g = $unsigned($random(seed)) % 4;
            repeat (g) @(negedge clk);
        end
    endtask

    // write img_buf into the inactive bank, then read the whole bank back
    task automatic load_image();
        integer w, b;
        b = active_bank ? 0 : 1;
        for (w = 0; w < NW; w = w + 1) begin
            if (img_buf[w] === 32'bx) fail("weight image file has fewer than 71 words");
            @(negedge clk);
            wb_we    = 1'b1;
            wb_addr  = w[6:0];
            wb_wdata = img_buf[w];
            @(negedge clk);
            wb_we    = 1'b0;
            wb_addr  = 7'($random(seed));
            wb_wdata = $random(seed);
            if (active_bank !== (b == 0)) fail("active_bank changed during a weight write");
            bank_w[NW*b + w] = img_buf[w];
            bank_k[NW*b + w] = 1'b1;
            gap();
        end
        n_img = n_img + 1;
        readback();
    endtask

    // read back every known word of the inactive bank; data 1 cycle after the address
    task automatic readback();
        integer a, b;
        b = active_bank ? 0 : 1;
        @(negedge clk);
        wb_raddr = 7'd0;
        for (a = 1; a <= NW; a = a + 1) begin
            @(negedge clk);
            wb_raddr = (a < NW) ? a[6:0] : 7'($random(seed));
            #1;
            if (active_bank !== (b == 0)) fail("active_bank changed during a readback");
            if (bank_k[NW*b + a - 1] && wb_rdata !== bank_w[NW*b + a - 1]) begin
                $display("FAIL: case %0s mode %0d: readback bank %0d word %0d expected 0x%08h got 0x%08h", cname, mode,
                         b, a - 1, bank_w[NW*b + a - 1], wb_rdata);
                $finish;
            end
        end
    endtask

    task automatic do_swap();
        logic   old;
        integer t;
        old = active_bank;
        if (swap_pending !== 1'b0) fail("swap_pending is not 0 before a swap request");
        @(negedge clk);
        swap_req = 1'b1;
        @(negedge clk);
        swap_req = 1'b0;
        t = 0;
        while (active_bank === old) begin
            if (swap_pending !== 1'b1) fail("swap_pending is not 1 while a swap waits");
            @(negedge clk);
            t = t + 1;
            if (t > 20000) fail("swap never happened");
        end
        if (swap_pending !== 1'b0) fail("swap_pending is not 0 in the cycle active_bank toggles");
        if (active_ver !== bank_w[NW*active_bank + W_VER][7:0]) begin
            $display("FAIL: case %0s mode %0d: active_ver after swap expected 0x%02h got 0x%02h", cname, mode,
                     bank_w[NW*active_bank + W_VER][7:0], active_ver);
            $finish;
        end
        n_swap = n_swap + 1;
        readback();                     // the old active bank must be unchanged
    endtask

    // ------------------------------------------------------------------------------------------ one case
    integer ev_idx [0:MAXEV-1];
    reg [8*12-1:0] ev_kind [0:MAXEV-1];
    integer ev_arg [0:MAXEV-1];
    integer n_ev;

    function automatic [8*240-1:0] vpath(input [8*32-1:0] c, input [8*16-1:0] sfx);
        reg [8*240-1:0] s;
        $sformat(s, "%0s/head_%0s%0s", vecdir, c, sfx);
        vpath = s;
    endfunction

    task automatic run_case(input integer m, output integer nrec);
        integer fd_in, fd_ev, i, e, rr, w;
        logic [EOG_BC_W-1:0] din;
        reg [8*120-1:0] fn;
        reg [8*12-1:0] kind;
        integer idx, arg;
        reg [8*80-1:0] hx;
        logic   sb_bank, sb_pend;
        logic [7:0] sb_ver;

        mode = m;
        n_img = 0;
        n_swap = 0;
        ii_max = 0;
        lat_max = 0;
        dq_n = 0;
        // events
        n_ev = 0;
        fd_ev = $fopen(vpath(cname, ".events.txt"), "r");
        if (fd_ev != 0) begin
            while (!$feof(fd_ev)) begin
                rr = $fscanf(fd_ev, "%d %s %d %s\n", idx, kind, arg, hx);
                if (rr == 4) begin
                    ev_idx[n_ev] = idx;
                    ev_kind[n_ev] = kind;
                    ev_arg[n_ev] = arg;
                    n_ev = n_ev + 1;
                end
            end
            $fclose(fd_ev);
        end
        // debug facility: FAC of record 0 (mode 0) or record 1 (mode 1, when it exists)
        fd_in = $fopen(vpath(cname, ".in.hex"), "r");
        if (fd_in == 0) fail("cannot open the .in.hex file");
        for (i = 0; i <= m; i = i + 1) begin
            rr = $fscanf(fd_in, "%h\n", din);
            if (rr == 1) dbg_fac = din[EOG_BC_FAC +: 5];
        end
        $fclose(fd_in);
        fd_in  = $fopen(vpath(cname, ".in.hex"), "r");
        fd_out = $fopen(vpath(cname, ".out.hex"), "r");
        if (fd_in == 0 || fd_out == 0) fail("cannot open the vector files");

        // hard reset (wb_rst_n tied to rst_n): in-flight state cleared, both banks' VER reads 0, active_bank = 0
        @(negedge clk);
        rst_n = 1'b0;
        wb_rst_n = 1'b0;
        in_valid = 1'b0;
        swap_req = 1'b0;
        wb_we = 1'b0;
        repeat (3) @(negedge clk);
        rst_n = 1'b1;
        wb_rst_n = 1'b1;
        running = 1'b1;
        n_out = 0;
        n_acc = 0;
        lat_done = 1'b0;
        ii_wait = 0;
        for (w = 0; w < 2 * NW; w = w + 1) bank_k[w] = 1'b0;
        bank_w[W_VER] = 32'd0;
        bank_w[NW + W_VER] = 32'd0;
        bank_k[W_VER] = 1'b1;
        bank_k[NW + W_VER] = 1'b1;
        #1;
        if (active_bank !== 1'b0) fail("active_bank is not 0 after a hard reset");
        if (active_ver !== 8'd0) fail("active_ver is not 0 after a hard reset");
        if (swap_pending !== 1'b0) fail("swap_pending is not 0 after a hard reset");
        if (out_valid !== 1'b0) fail("out_valid is not 0 after reset");
        readback();

        // the case's starting image becomes active (model: write the inactive bank + swap)
        for (w = 0; w < NW; w = w + 1) img_buf[w] = 32'bx;
        $readmemh(vpath(cname, ".wts.hex"), img_buf);
        load_image();
        do_swap();

        i = 0;
        e = 0;
        while (1) begin
            // events scheduled before record i
            while (e < n_ev && ev_idx[e] <= i) begin
                if (ev_kind[e] == "wts") begin
                    $sformat(fn, ".wts%0d.hex", ev_arg[e]);
                    for (w = 0; w < NW; w = w + 1) img_buf[w] = 32'bx;
                    $readmemh(vpath(cname, fn[8*16-1:0]), img_buf);
                    load_image();
                end else if (ev_kind[e] == "swap") begin
                    do_swap();
                end
                e = e + 1;
            end
            rr = $fscanf(fd_in, "%h\n", din);
            if (rr != 1) break;
            in_feat[i % 64] = din[EOG_BC_FEAT +: 496];
            // present record i (we are at a falling edge: in mode 1 it follows the previous accept directly)
            if (mode == 0) begin
                while (($unsigned($random(seed)) % 4) == 0) begin
                    in_valid = 1'b0;
                    in_data = {$random(seed), $random(seed), $random(seed), $random(seed), $random(seed),
                               $random(seed), $random(seed), $random(seed)};
                    @(negedge clk);
                end
            end
            in_valid = 1'b1;
            in_data = din;
            @(posedge clk);
            while (in_ready !== 1'b1) @(posedge clk);
            @(negedge clk);
            in_valid = 1'b0;
            i = i + 1;
        end
        // drain
        w = 0;
        while (n_out < i) begin
            @(negedge clk);
            w = w + 1;
            if (w > 20000) fail("outputs missing at the end of the case");
        end
        repeat (4) @(negedge clk);
        rr = $fscanf(fd_out, "%h\n", exp_l);
        if (rr == 1) fail("fewer records in .in.hex than in .out.hex");
        if (dq_n != 0) fail("dbg_valid capture with no matching record");
        // soft reset: the weight store, active bank, VER and a pending swap survive (spec v3)
        sb_bank = active_bank;
        sb_ver  = active_ver;
        sb_pend = swap_pending;
        @(negedge clk);
        rst_n = 1'b0;
        repeat (2) @(negedge clk);
        rst_n = 1'b1;
        #1;
        if (active_bank !== sb_bank) fail("soft reset changed active_bank");
        if (active_ver !== sb_ver) fail("soft reset changed active_ver");
        if (swap_pending !== sb_pend) fail("soft reset changed swap_pending");
        readback();
        running = 1'b0;
        $fclose(fd_in);
        $fclose(fd_out);
        nrec = i;
        $display("head tb: case %0s mode %0d: %0d records, %0d weight images, %0d swaps, dbg_fac %0d, max II wait %0d, max latency %0d",
                 cname, m, i, n_img, n_swap, dbg_fac, ii_max, lat_max);
    endtask

    // ---------------------------------------------------------------------------------------------- main
    reg [8*400-1:0] ran;
    integer fd_idx, rr2, nrec, ncase, fdt;
    reg [8*256-1:0] line;
    reg [8*32-1:0]  nm;
    reg [8*240-1:0] idxf;

    initial begin
        ran = "";
        ncase = 0;
        if (!$value$plusargs("vecdir=%s", vecdir)) vecdir = "tb/vectors";
        repeat (2) @(negedge clk);
        $sformat(idxf, "%0s/INDEX.txt", vecdir);
        fd_idx = $fopen(idxf, "r");
        if (fd_idx == 0) begin
            $display("FAIL: cannot open %0s (run from FPGA/)", idxf);
            $finish;
        end
        while (!$feof(fd_idx)) begin
            line = "";
            rr2 = $fgets(line, fd_idx);
            nm = "";
            if (rr2 > 0 && $sscanf(line, "case %s", nm) == 1) begin
                cname = nm;
                fdt = $fopen(vpath(cname, ".in.hex"), "r");
                if (fdt != 0) begin
                    $fclose(fdt);
                    run_case(0, nrec);
                    run_case(1, nrec);
                    ncase = ncase + 1;
                    if (ncase == 1) $sformat(ran, "%0s", cname);
                    else            $sformat(ran, "%0s %0s", ran, cname);
                end else begin
                    $display("head tb: case %0s skipped (no head_%0s.in.hex)", cname, cname);
                end
            end
        end
        $fclose(fd_idx);
        if (ncase == 0) begin
            $display("FAIL: no head_* vectors found in %0s", vecdir);
            $finish;
        end
        $display("PASS: %0d records, %0d debug captures (%0d cases x 2 modes: %0s)", n_tot, n_dbg, ncase, ran);
        $finish;
    end

    // watchdog
    initial begin
        #2_000_000_000;
        $display("FAIL: global timeout");
        $finish;
    end
endmodule
