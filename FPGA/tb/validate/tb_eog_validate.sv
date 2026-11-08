// tb_eog_validate.sv — bit-exact simulation of eog_validate against the model's golden vectors (Verify role,
// task T1.validate.fv). `bash scripts/sim.sh validate` (run from FPGA/, file list tb/validate/files.f).
//
// Written from spec/modules/eog_validate.md, numerics.md §3 (spec v2) and tb/README.md; the expected outputs are
// model/eog_ref.py's (FPGA/tb/vectors/validate_<case>.out.hex), so this testbench has no reference of its own.
//
// Cases: every "case <name>" line of tb/vectors/INDEX.txt. A case runs when validate_<name>.in.hex, .out.hex and
// <name>.cfg.hex exist; otherwise it is skipped with a note (the *_week files are git-ignored: generate them with
// `python model/gen_vectors.py`). Files per case:
//   validate_<case>.cfg.hex     line 0 GLOBAL (256 bits), lines 1..32 CONFIG rows of slots 0..31 (512 bits)
//   validate_<case>.in.hex      bus U per record (EOG_BU_W bits), .out.hex bus V per record (EOG_BV_W bits)
//   validate_<case>.events.txt  "<record index> <kind> <slot> <hex row>": `touch` pulses fac_touch[slot]; `cfg`
//                               rewrites the slot's CONFIG row then pulses fac_touch[slot] (eog_regs does both on
//                               a row write). Both happen after record index-1 was accepted and before record
//                               index is offered. Other kinds do not concern eog_validate and are ignored.
//
// Each case runs twice from reset:
//   mode 0  random in_valid gaps (0-3 idle cycles, garbage data while idle) and random out_ready back-pressure
//           (fixed seed). A `touch` event is pulsed either in the cycle the previous record is accepted or in an
//           idle cycle after it, with or without draining first, so it often lands while the previous record is
//           in flight (lead clarification: a fac_touch[f] in the cycle a slot-f record is accepted, or while it
//           is held, applies to f's next record). `cfg` events are applied after draining (the row of a record
//           in flight never changes).
//   mode 1  in_valid and out_ready held 1 (except event cycles); every `touch` rides on the previous record's
//           accept cycle; checks II <= 16 accepted-record spacing.
// Every output transfer is compared bit for bit with the next expected line; also checked: out_valid = 0 after
// reset, out_data stable while out_valid && !out_ready, no output without a pending record, latency <= 128
// cycles (out_valid within 128 cycles while a record is pending), and the output count at the end.
// Prints exactly one final line: `PASS: <n> records ...` or `FAIL: <first mismatch: case, record, field,
// expected, got>`.

`timescale 1ns/1ps
`default_nettype none

module tb_eog_validate;
`include "eog_defs.svh"
    localparam integer N_FAC  = 32;
    localparam integer N_WELL = 8;
    localparam integer MAXREC = 32768;
    localparam integer MAXEV  = 1024;
    localparam integer MAXCASE = 64;

    logic                 clk = 1'b0;
    logic                 rst_n = 1'b0;
    logic                 in_valid = 1'b0;
    logic                 in_ready;
    logic [EOG_BU_W-1:0]  in_data = '0;
    logic                 out_valid;
    logic                 out_ready = 1'b0;
    logic [EOG_BV_W-1:0]  out_data;
    logic [4:0]           cfg_fac;
    logic [511:0]         cfg_row;
    logic [255:0]         glb = '0;
    logic [N_FAC-1:0]     fac_touch;
    logic [N_FAC-1:0]     touch_pulse = '0;   // a 1-cycle pulse in an idle cycle
    logic [N_FAC-1:0]     touch_acc = '0;     // pulsed in the cycle the current record is accepted
    logic [511:0]         rows [0:N_FAC-1];

    assign cfg_row   = rows[cfg_fac];
    assign fac_touch = touch_pulse | (touch_acc & {N_FAC{in_valid && in_ready}});

    eog_validate #(.N_FAC(N_FAC), .N_WELL(N_WELL), .II(16)) dut (
        .clk(clk), .rst_n(rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data),
        .cfg_fac(cfg_fac), .cfg_row(cfg_row), .glb(glb), .fac_touch(fac_touch));

    always #5 clk = ~clk;

    // ---------------------------------------------------------------------------------------------------------
    // Vectors of the current case
    logic [EOG_BU_W-1:0] vin  [0:MAXREC-1];
    logic [EOG_BV_W-1:0] vout [0:MAXREC-1];
    logic [511:0]        vcfg [0:N_FAC];
    integer              n_rec;
    integer              n_ev;
    integer              ev_idx  [0:MAXEV-1];
    integer              ev_kind [0:MAXEV-1];    // 0 touch, 1 cfg, 2 ignored
    integer              ev_slot [0:MAXEV-1];
    logic [511:0]        ev_row  [0:MAXEV-1];
    logic                ev_done [0:MAXEV-1];

    string  case_name [0:MAXCASE-1];
    integer n_case;
    string  cur_case;
    integer cur_mode;

    // ---------------------------------------------------------------------------------------------------------
    // Output checker (posedge sampling)
    integer n_acc = 0;          // records accepted since the last reset
    integer n_out = 0;          // outputs compared since the last reset
    integer total = 0;          // outputs compared over all cases and modes
    logic   failed = 1'b0;
    logic   checking = 1'b0;    // 0 while in reset
    logic   prev_stall = 1'b0;
    logic [EOG_BV_W-1:0] prev_data;
    integer lat_wait = 0, ii_wait = 0, max_ii = 0, max_lat = 0;
    logic   ii_on = 1'b0;       // mode 1 window: in_valid and out_ready held 1

    function automatic string fld_name(input logic [EOG_BV_W-1:0] a, input logic [EOG_BV_W-1:0] b);
        logic [EOG_BV_W-1:0] d;
        d = a ^ b;
        if      (|d[EOG_BV_REC_NO +: EOG_BV_REC_NO_W])           fld_name = "REC_NO";
        else if (|d[EOG_BV_IN_LAST +: EOG_BV_IN_LAST_W])         fld_name = "IN_LAST";
        else if (|d[EOG_BV_FAC_RAW +: EOG_BV_FAC_RAW_W])         fld_name = "FAC_RAW";
        else if (|d[EOG_BV_FAC +: EOG_BV_FAC_W])                 fld_name = "FAC";
        else if (|d[EOG_BV_TS +: EOG_BV_TS_W])                   fld_name = "TS";
        else if (|d[EOG_BV_STATUS +: EOG_BV_STATUS_W])           fld_name = "STATUS";
        else if (|d[EOG_BV_REASON +: EOG_BV_REASON_W])           fld_name = "REASON";
        else if (|d[EOG_BV_SINCE_RESET +: EOG_BV_SINCE_RESET_W]) fld_name = "SINCE_RESET";
        else if (|d[EOG_BV_HIST_RESET +: EOG_BV_HIST_RESET_W])   fld_name = "HIST_RESET";
        else if (|d[EOG_BV_INFLOW +: EOG_BV_INFLOW_W])           fld_name = "INFLOW";
        else if (|d[EOG_BV_LEVEL +: EOG_BV_LEVEL_W])             fld_name = "LEVEL";
        else if (|d[EOG_BV_PUMP_FLOW +: EOG_BV_PUMP_FLOW_W])     fld_name = "PUMP_FLOW";
        else if (|d[EOG_BV_RECV_FLOW +: EOG_BV_RECV_FLOW_W])     fld_name = "RECV_FLOW";
        else if (|d[EOG_BV_DIS_PSI +: EOG_BV_DIS_PSI_W])         fld_name = "DIS_PSI";
        else if (|d[EOG_BV_PIPE_PSI +: EOG_BV_PIPE_PSI_W])       fld_name = "PIPE_PSI";
        else if (|d[EOG_BV_PUMP_ST +: EOG_BV_PUMP_ST_W])         fld_name = "PUMP_ST";
        else if (|d[EOG_BV_WELL_ACT +: EOG_BV_WELL_ACT_W])       fld_name = "WELL_ACT";
        else if (|d[EOG_BV_WELL_WATER +: EOG_BV_WELL_WATER_W])   fld_name = "WELL_WATER";
        else if (|d[EOG_BV_FLD_OK +: EOG_BV_FLD_OK_W])           fld_name = "FLD_OK";
        else if (|d[EOG_BV_WELLS_OK +: EOG_BV_WELLS_OK_W])       fld_name = "WELLS_OK";
        else if (|d[EOG_BV_PREV_LEVEL +: EOG_BV_PREV_LEVEL_W])   fld_name = "PREV_LEVEL";
        else if (|d[EOG_BV_PREV_OK +: EOG_BV_PREV_OK_W])         fld_name = "PREV_OK";
        else                                                     fld_name = "(x/z bits)";
    endfunction

    task automatic fail(input string msg);
        if (!failed) begin
            $display("FAIL: case %s mode %0d: %s", cur_case, cur_mode, msg);
            failed = 1'b1;
        end
    endtask

    always @(posedge clk) begin
        if (checking && !failed) begin
            if (in_valid && in_ready) n_acc = n_acc + 1;
            if (out_valid === 1'b1) begin
                if (prev_stall && out_data !== prev_data)
                    fail($sformatf("out_data changed while out_valid && !out_ready (record %0d, field %s)",
                                   n_out, fld_name(prev_data, out_data)));
                if (out_ready) begin
                    if (n_out >= n_acc)
                        fail($sformatf("output %0d without a pending record", n_out));
                    else if (n_out >= n_rec)
                        fail($sformatf("more outputs than records (%0d)", n_rec));
                    else if (out_data !== vout[n_out])
                        fail($sformatf("record %0d field %s: expected %h got %h (bus V)", n_out,
                                       fld_name(vout[n_out], out_data), vout[n_out], out_data));
                    n_out = n_out + 1;
                    total = total + 1;
                end
            end else if (out_valid !== 1'b0) begin
                fail($sformatf("out_valid is %b", out_valid));
            end else if (prev_stall) begin
                fail($sformatf("out_valid dropped before the transfer of record %0d", n_out));
            end
            prev_stall = (out_valid === 1'b1) && !out_ready;
            prev_data  = out_data;
            // latency: a pending record must show out_valid within 128 cycles
            if (n_acc > n_out && out_valid !== 1'b1) lat_wait = lat_wait + 1; else lat_wait = 0;
            if (lat_wait > max_lat) max_lat = lat_wait;
            if (lat_wait >= 128) fail($sformatf("latency: record %0d not presented within 128 cycles", n_out));
            // II (mode 1 windows only): consecutive cycles with in_valid && out_ready && !in_ready
            if (ii_on && in_valid && out_ready && !in_ready) ii_wait = ii_wait + 1; else ii_wait = 0;
            if (ii_wait > max_ii) max_ii = ii_wait;
            if (ii_wait >= 16) fail($sformatf("II: no accept for 16 cycles before record %0d", n_acc));
        end
    end

    // out_valid must be 0 in the cycle after a reset cycle
    logic rst_q = 1'b0;
    always @(posedge clk) begin
        if (rst_q === 1'b0 && rst_n && !failed && checking && out_valid !== 1'b0)
            fail("out_valid not 0 right after reset");
        rst_q <= rst_n;
    end

    // ---------------------------------------------------------------------------------------------------------
    // Stimulus helpers (inputs change after the falling edge)
    integer seed = 32'h7A11_DA7E;

    function automatic logic [EOG_BU_W-1:0] garbage();
        logic [EOG_BU_W-1:0] g;
        integer q;
        for (q = 0; q < EOG_BU_W; q = q + 32) g[q +: 32] = $random(seed);
        garbage = g;
    endfunction

    // random out_ready: mode 0 ~70 % ready, mode 1 always
    always @(negedge clk) begin
        #1;
        if (cur_mode == 1) out_ready = 1'b1;
        else               out_ready = (($unsigned($random(seed)) % 10) < 7);
    end

    task automatic idle_cycle();
        @(negedge clk); #2;
        in_valid  = 1'b0;
        in_data   = garbage();
        touch_acc = '0;
    endtask

    task automatic drain();
        integer w;
        w = 0;
        while (n_out < n_acc && w < 10000) begin idle_cycle(); w = w + 1; end
        if (n_out < n_acc) fail($sformatf("drain: %0d records still pending", n_acc - n_out));
    endtask

    task automatic pulse_touch(input integer slot);
        @(negedge clk); #2;
        in_valid    = 1'b0;
        in_data     = garbage();
        touch_acc   = '0;
        touch_pulse = '0;
        touch_pulse[slot] = 1'b1;
        @(negedge clk); #2;
        touch_pulse = '0;
    endtask

    // offer one record and wait until it is accepted; `tacc` slots are touched in the accept cycle (spec: such a
    // touch applies to the slot's next record, i.e. it is ordered after this record, as the model's event is)
    task automatic send(input logic [EOG_BU_W-1:0] d, input logic [N_FAC-1:0] tacc);
        @(negedge clk); #2;
        in_valid  = 1'b1;
        in_data   = d;
        touch_acc = tacc;
        @(posedge clk);
        while (!(in_ready === 1'b1) && !failed) @(posedge clk);
        // returns at the accept edge; the next idle_cycle / send / pulse_touch replaces in_data and touch_acc
    endtask

    // ---------------------------------------------------------------------------------------------------------
    // File loading
    function automatic integer count_lines(input string fn);
        integer fd, n, r;
        string line;
        n = 0;
        fd = $fopen(fn, "r");
        if (fd == 0) return -1;
        while (!$feof(fd)) begin
            r = $fgets(line, fd);
            if (r > 1) n = n + 1;           // a hex line plus its newline
        end
        $fclose(fd);
        return n;
    endfunction

    task automatic load_events(input string fn);
        integer fd, r, idx, slot;
        string kind;
        logic [511:0] row;
        n_ev = 0;
        fd = $fopen(fn, "r");
        if (fd == 0) return;                 // no events file: no events
        while (!$feof(fd)) begin
            r = $fscanf(fd, "%d %s %d %h\n", idx, kind, slot, row);
            if (r == 4 && n_ev < MAXEV) begin
                ev_idx[n_ev]  = idx;
                ev_slot[n_ev] = slot;
                ev_row[n_ev]  = row;
                ev_kind[n_ev] = (kind == "touch") ? 0 : (kind == "cfg") ? 1 : 2;
                n_ev = n_ev + 1;
            end
        end
        $fclose(fd);
    endtask

    task automatic load_cases();
        integer fd, r;
        string line, nm;
        n_case = 0;
        fd = $fopen("tb/vectors/INDEX.txt", "r");
        if (fd == 0) return;
        while (!$feof(fd)) begin
            r = $fgets(line, fd);
            if (r > 0 && n_case < MAXCASE) begin
                r = $sscanf(line, "case %s", nm);
                if (r == 1) begin case_name[n_case] = nm; n_case = n_case + 1; end
            end
        end
        $fclose(fd);
    endtask

    // ---------------------------------------------------------------------------------------------------------
    // One case, one mode
    task automatic run_case(input integer mode);
        integer i, e, k, q;
        logic [N_FAC-1:0] tacc;
        cur_mode = mode;
        // reset with the case's CONFIG (rows and GLOBAL do not change across a reset)
        checking  = 1'b0;
        @(negedge clk); #2;
        rst_n     = 1'b0;
        in_valid  = 1'b0;
        touch_pulse = '0;
        touch_acc   = '0;
        for (k = 0; k < n_ev; k = k + 1) ev_done[k] = 1'b0;
        glb = vcfg[0][255:0];
        for (k = 0; k < N_FAC; k = k + 1) rows[k] = vcfg[k + 1];
        repeat (3) idle_cycle();
        n_acc = 0; n_out = 0; lat_wait = 0; ii_wait = 0; prev_stall = 1'b0;
        checking = 1'b1;
        @(negedge clk); #2;
        rst_n = 1'b1;
        e = 0;
        for (i = 0; i < n_rec && !failed; i = i + 1) begin
            ii_on = 1'b0;
            while (e < n_ev && ev_idx[e] <= i) begin
                if (ev_idx[e] == i && !ev_done[e]) begin
                    if (ev_kind[e] == 1) begin
                        drain();
                        rows[ev_slot[e]] = ev_row[e];
                        pulse_touch(ev_slot[e]);
                    end else if (ev_kind[e] == 0) begin
                        if (mode == 0 && ($unsigned($random(seed)) % 2)) drain();
                        pulse_touch(ev_slot[e]);
                    end
                end
                e = e + 1;
            end
            // `touch` events due before record i+1: in mode 1 (and half the time in mode 0) pulse them in the
            // cycle record i is accepted
            tacc = '0;
            for (q = e; q < n_ev && ev_idx[q] <= i + 1; q = q + 1)
                if (ev_idx[q] == i + 1 && ev_kind[q] == 0 && (mode == 1 || ($unsigned($random(seed)) % 2))) begin
                    tacc[ev_slot[q]] = 1'b1;
                    ev_done[q] = 1'b1;
                end
            if (mode == 0) begin
                k = $unsigned($random(seed)) % 8;
                if (k >= 4) k = 0;             // half the records back to back
                repeat (k) idle_cycle();
            end else begin
                ii_on = 1'b1;
            end
            send(vin[i], tacc);
        end
        ii_on = 1'b0;
        drain();
        idle_cycle();
        if (!failed && n_out != n_rec)
            fail($sformatf("%0d records, %0d outputs", n_rec, n_out));
    endtask

    // ---------------------------------------------------------------------------------------------------------
    integer c, nl_in, nl_out, nl_cfg, n_ran;
    string  ran, skipped, f_in, f_out, f_cfg, f_ev;
    initial begin
        cur_case = "(none)";
        cur_mode = 0;
        n_rec = 0;
        n_ran = 0;
        ran = "";
        skipped = "";
        for (c = 0; c < N_FAC; c = c + 1) rows[c] = '0;
        load_cases();
        if (n_case == 0) begin
            $display("FAIL: no cases found in tb/vectors/INDEX.txt (run from FPGA/)");
            $finish;
        end
        for (c = 0; c < n_case && !failed; c = c + 1) begin
            cur_case = case_name[c];
            f_in  = $sformatf("tb/vectors/validate_%s.in.hex", cur_case);
            f_out = $sformatf("tb/vectors/validate_%s.out.hex", cur_case);
            f_cfg = $sformatf("tb/vectors/validate_%s.cfg.hex", cur_case);
            f_ev  = $sformatf("tb/vectors/validate_%s.events.txt", cur_case);
            nl_in  = count_lines(f_in);
            nl_out = count_lines(f_out);
            nl_cfg = count_lines(f_cfg);
            if (nl_in < 0 || nl_out < 0 || nl_cfg < 0) begin
                $display("note: case %s skipped (no validate_%s.{in,out,cfg}.hex; run model/gen_vectors.py)",
                         cur_case, cur_case);
                skipped = {skipped, " ", cur_case};
                continue;
            end
            if (nl_in != nl_out || nl_cfg != N_FAC + 1 || nl_in > MAXREC) begin
                $display("FAIL: case %s: %0d input lines, %0d output lines, %0d cfg lines", cur_case, nl_in,
                         nl_out, nl_cfg);
                failed = 1'b1;
                break;
            end
            n_rec = nl_in;
            if (n_rec > 0) begin
                $readmemh(f_in, vin, 0, n_rec - 1);
                $readmemh(f_out, vout, 0, n_rec - 1);
            end
            $readmemh(f_cfg, vcfg, 0, N_FAC);
            load_events(f_ev);
            run_case(0);
            if (!failed) run_case(1);
            if (!failed) begin
                $display("case %-8s %6d records, %3d events: random gaps/back-pressure and full rate ok", cur_case,
                         n_rec, n_ev);
                ran = {ran, " ", cur_case};
                n_ran = n_ran + 1;
            end
        end
        if (!failed && n_ran == 0) begin
            $display("FAIL: no case had its vector files");
            failed = 1'b1;
        end
        if (!failed)
            $display("PASS: %0d records (%0d cases x 2 schedules: ran%s; skipped:%s; max II %0d, max latency %0d cycles)",
                     total, n_ran, ran, (skipped == "") ? " none" : skipped, max_ii + 1, max_lat);
        $finish;
    end

    // safety net
    initial begin
        #2_000_000_000;
        $display("FAIL: timeout");
        $finish;
    end
endmodule

`default_nettype wire
