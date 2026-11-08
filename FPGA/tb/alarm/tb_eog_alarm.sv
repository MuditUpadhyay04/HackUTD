// tb_eog_alarm.sv — self-checking simulation of eog_alarm against the golden vectors (Verify role, T1.alarm.fv).
//
// Written from spec/modules/eog_alarm.md, numerics.md §9, conventions.md (spec v4) and TASKS.md answers #1, #3-#11;
// `bash scripts/sim.sh alarm`. The bus A / ALERT expectations come entirely from the vectors (model/, spec v4 golden
// vectors are generated with HB_TIMEOUT_MS = 0, so SOURCE bit 2 is 0); the bench's own checks are model-free. Vectors: tb/vectors/alarm_<case>.{in,out}.hex (bus L in, bus A out), .al.txt (ALERTs
// in push order with record index and cause), .cfg.hex (line 0 = GLOBAL), .events.txt (hb / hb_expire / ack between
// records). The case list comes from tb/vectors/INDEX.txt ("case <name> ..." lines); a case runs when its
// alarm_<case>.in.hex exists (the *_week files are git-ignored: regenerate with model/gen_vectors.py).
//
// Each case runs three times from reset (fixed seed):
//   mode 0  random in_valid gaps, random out_ready (70 %), short BTN0 glitches (never long enough to acknowledge)
//   mode 1  in_valid and out_ready held 1 between events: checks II <= 16 and latency <= 128
//   mode 2  like mode 0 plus al_full random (25 %): every ALERT is pushed (al_valid, data checked) or dropped
//           (al_drop, counted, never retried: TASKS #5), so the expected stream is consumed one entry per pulse
// Checked every cycle: bus A bit for bit in order (field named on mismatch), ALERT stream bit for bit in order,
// out handshake (valid/data held until ready), al_valid / al_drop exclusive and consistent with al_full, nothing
// extra or missing at the end. At every quiet point (before each event and at the end, modes 0 and 1): the
// Pmods against the latch state implied by the ALERT stream (RAISED sets, ACKED clears), autonomous against the
// heartbeat state. LEDs: colours per the spec table (current or previous cycle), duty <= 25 % (+ slack) per
// channel over a 1024-cycle window, ld0 red only within 1001 ms of a fault record (status not VALID/HELD,
// TASKS #10), green/blue not within 998 ms of one. Once at the end: the `ledovr` raw override.
//
// Events (model/eog_ref.py semantics: they happen between records, after the previous record and its ALERTs):
//   hb         drain, then hb_pulse; while "fresh" the bench repeats hb_pulse every max(1, (T-1)*CYC/2) cycles so
//              ms_since_hb never reaches T = HB_TIMEOUT_MS (the model's abstraction of a live server)
//   hb_expire  drain, stop the heartbeats, wait until ms_since_hb >= T (checks autonomous = (T != 0))
//   ack        drain, then alternately a 1-cycle ack_srv or a BTN0 press of (DEB_MS+1)*CYC_PER_MS + 4 cycles;
//              then 2*N_FAC + 24 cycles for the ACKED sweep
// Prints exactly one final line: `PASS: ...` or `FAIL: ...`.

`timescale 1ns/1ps
`default_nettype none

module tb_eog_alarm;
`include "eog_defs.svh"
    localparam integer N_FAC  = 32;
    localparam integer CYC    = 4;                     // CYC_PER_MS (shrunk so hb_expire waits stay short)
    localparam integer DEB    = 3;                     // DEB_MS
    localparam integer MAXR   = 32768;
    localparam integer MAXA   = 8192;
    localparam integer MAXE   = 1024;
    localparam integer GLITCH = (DEB - 1) * CYC;       // longest glitch: < (DEB_MS-1)*CYC_PER_MS + 1 cycles
    localparam integer PRESS  = (DEB + 1) * CYC + 4;   // a real press (and the low time around it)
    localparam integer SETTLE = 2 * N_FAC + 24;        // after an ack: apply + sweep (<= 2*N_FAC) + slack
    localparam integer LEDW   = 1024;                  // LED duty window

    // ---------------------------------------------------------------------------------------------------------
    // DUT
    logic         clk = 1'b0;
    logic         rst_n = 1'b0;
    logic         in_valid = 1'b0;
    logic         in_ready;
    logic [254:0] in_data = '0;
    logic         out_valid;
    logic         out_ready = 1'b0;
    logic [242:0] out_data;
    logic [255:0] glb = '0;
    logic         hb_pulse = 1'b0, ack_srv = 1'b0, btn0 = 1'b0;
    logic         al_valid, al_drop;
    logic [127:0] al_data;
    logic         al_full = 1'b0;
    logic         autonomous;
    logic [15:0]  ms_since_hb;
    logic [31:0]  ledovr = '0;
    logic [2:0]   ld0, ld1;
    logic [7:0]   pmod_ja, pmod_jb;

    eog_alarm #(.N_FAC(N_FAC), .CYC_PER_MS(CYC), .DEB_MS(DEB)) dut (
        .clk(clk), .rst_n(rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data),
        .glb(glb), .hb_pulse(hb_pulse), .ack_srv(ack_srv), .btn0(btn0),
        .al_valid(al_valid), .al_data(al_data), .al_full(al_full), .al_drop(al_drop),
        .autonomous(autonomous), .ms_since_hb(ms_since_hb), .ledovr(ledovr),
        .ld0(ld0), .ld1(ld1), .pmod_ja(pmod_ja), .pmod_jb(pmod_jb));

    always #5 clk = ~clk;

    // ---------------------------------------------------------------------------------------------------------
    // Vectors of the current case
    reg [254:0] vin  [0:MAXR-1];
    reg [242:0] vout [0:MAXR-1];
    reg [511:0] vcfg [0:32];
    reg [127:0] eal  [0:MAXA-1];
    integer     eal_idx [0:MAXA-1];
    integer     ev_idx  [0:MAXE-1];
    integer     ev_kind [0:MAXE-1];   // 0 hb, 1 hb_expire, 2 ack, 3 other (ignored)
    integer     n_rec, n_al, n_ev;

    string case_name, mode_name;
    integer mode;
    integer seed = 32'h0A1A_2026;
    integer cyc = 0;
    logic   running = 1'b0;           // monitors active (between reset release and the end of a case)

    // totals
    integer t_rec = 0, t_al = 0, t_drop = 0, t_ack = 0, t_btn = 0, t_glitch = 0, t_cases = 0, t_quiet = 0;
    string  ran = "";

    task automatic fail(input string msg);
        $display("FAIL: case %0s mode %0d cycle %0d: %0s", case_name, mode, cyc, msg);
        $finish;
    endtask

    function automatic integer rnd(input integer n);   // 0..n-1
        rnd = ($random(seed) & 32'h7FFF_FFFF) % n;
    endfunction

    // ---------------------------------------------------------------------------------------------------------
    // State tracked by the monitors (sampled at negedge: inputs change 1 ns after posedge, outputs at posedge,
    // so a negedge sample is the value seen by the next posedge)
    integer out_cnt, acc_cnt, al_seen, al_drops;
    logic [N_FAC-1:0] ns_l, es_l;     // latch state implied by the ALERT stream
    logic   hb_fresh;                 // model: a heartbeat is live
    logic   hb_now;                   // request one hb_pulse
    integer hb_cnt;
    logic [15:0] hb_T;
    integer last_btn_hi;
    integer ii_wait, lat_wait;
    logic   chk_ii;                   // mode 1 between events
    integer fault_acc, fault_out, fault_pend, fault_any;
    logic   p_out_valid, p_out_ready, p_auto, p_ovr;
    logic [242:0] p_out_data;
    logic [7:0]   p_ja;
    integer led_ring [0:LEDW-1];
    integer led_on [0:5];
    integer led_ptr;
    logic   led_chk;

    function automatic [2:0] ld1_mask(input logic [1:0] ja);
        ld1_mask = ja[0] ? 3'b100 : ja[1] ? 3'b110 : 3'b000;
    endfunction

    function automatic [4:0] worst_of(input logic [N_FAC-1:0] ns, input logic [N_FAC-1:0] es);
        integer f;
        worst_of = 5'd0;
        for (f = N_FAC - 1; f >= 0; f = f - 1) if (ns[f]) worst_of = f[4:0];
        if (es != '0) for (f = N_FAC - 1; f >= 0; f = f - 1) if (es[f]) worst_of = f[4:0];
    endfunction

    // bus A field compare
    task automatic chk_field(input string name, input [242:0] exp, input [242:0] got, input integer lsb,
                             input integer w);
        reg [63:0] e, g;
        integer b;
        e = '0; g = '0;
        for (b = 0; b < w; b = b + 1) begin e[b] = exp[lsb + b]; g[b] = got[lsb + b]; end
        if (e !== g) fail($sformatf("record %0d bus A field %0s expected %0h got %0h", out_cnt, name, e, g));
    endtask

    task automatic chk_busa(input [242:0] exp, input [242:0] got);
        chk_field("REC_NO", exp, got, EOG_BA_REC_NO, EOG_BA_REC_NO_W);
        chk_field("IN_LAST", exp, got, EOG_BA_IN_LAST, EOG_BA_IN_LAST_W);
        chk_field("FAC_RAW", exp, got, EOG_BA_FAC_RAW, EOG_BA_FAC_RAW_W);
        chk_field("FAC", exp, got, EOG_BA_FAC, EOG_BA_FAC_W);
        chk_field("TS", exp, got, EOG_BA_TS, EOG_BA_TS_W);
        chk_field("STATUS", exp, got, EOG_BA_STATUS, EOG_BA_STATUS_W);
        chk_field("REASON", exp, got, EOG_BA_REASON, EOG_BA_REASON_W);
        chk_field("SINCE_RESET", exp, got, EOG_BA_SINCE_RESET, EOG_BA_SINCE_RESET_W);
        chk_field("HIST_RESET", exp, got, EOG_BA_HIST_RESET, EOG_BA_HIST_RESET_W);
        chk_field("RULES", exp, got, EOG_BA_RULES, EOG_BA_RULES_W);
        chk_field("CD", exp, got, EOG_BA_CD, EOG_BA_CD_W);
        chk_field("LOGITS", exp, got, EOG_BA_LOGITS, EOG_BA_LOGITS_W);
        chk_field("WVER", exp, got, EOG_BA_WVER, EOG_BA_WVER_W);
        chk_field("CLASSES", exp, got, EOG_BA_CLASSES, EOG_BA_CLASSES_W);
        if (exp !== got) fail($sformatf("record %0d bus A expected %0h got %0h", out_cnt, exp, got));
    endtask

    task automatic chk_alert(input [127:0] exp, input [127:0] got);
        string nm;
        integer lsb, w, b;
        reg [31:0] e, g;
        integer fi;
        for (fi = 0; fi < 8; fi = fi + 1) begin
            case (fi)
                0: begin nm = "FAC_ID";    lsb = EOG_AL_FAC_ID;    w = EOG_AL_FAC_ID_W;    end
                1: begin nm = "KIND";      lsb = EOG_AL_KIND;      w = EOG_AL_KIND_W;      end
                2: begin nm = "SOURCE";    lsb = EOG_AL_SOURCE;    w = EOG_AL_SOURCE_W;    end
                3: begin nm = "TS";        lsb = EOG_AL_TS;        w = EOG_AL_TS_W;        end
                4: begin nm = "RESULT_NO"; lsb = EOG_AL_RESULT_NO; w = EOG_AL_RESULT_NO_W; end
                5: begin nm = "RULES";     lsb = EOG_AL_RULES;     w = EOG_AL_RULES_W;     end
                6: begin nm = "CLASSES";   lsb = EOG_AL_CLASSES;   w = EOG_AL_CLASSES_W;   end
                default: begin nm = "CD_P10"; lsb = EOG_AL_CD_P10; w = EOG_AL_CD_P10_W; end
            endcase
            e = '0; g = '0;
            for (b = 0; b < w; b = b + 1) begin e[b] = exp[lsb + b]; g[b] = got[lsb + b]; end
            if (e !== g)
                fail($sformatf("ALERT %0d (record/event index %0d) field %0s expected %0h got %0h (expected %032h got %032h)",
                               al_seen, eal_idx[al_seen], nm, e, g, exp, got));
        end
    endtask

    // ---------------------------------------------------------------------------------------------------------
    // Monitors
    integer k;
    always @(negedge clk) begin
        cyc = cyc + 1;
        if (running && rst_n) begin
            // out handshake (conventions §2)
            if (p_out_valid && !p_out_ready) begin
                if (!out_valid) fail("out_valid dropped before the transfer");
                if (out_data !== p_out_data) fail("out_data changed while out_valid && !out_ready");
            end
            // bus A
            if (out_valid && out_ready) begin
                if (out_cnt >= acc_cnt) fail("output without an accepted input");
                chk_busa(vout[out_cnt], out_data);
                if (out_data[EOG_BA_STATUS +: 3] != EOG_ST_VALID && out_data[EOG_BA_STATUS +: 3] != EOG_ST_HELD) begin
                    fault_out = cyc; fault_pend = fault_pend - 1;
                end
                out_cnt = out_cnt + 1;
            end
            // ALERTs
            if (al_valid && al_drop) fail("al_valid and al_drop in the same cycle");
            if (al_valid && al_full) fail("al_valid while al_full");
            if (al_drop && !al_full) fail("al_drop while not al_full");
            if (al_valid || al_drop) begin
                if (al_seen >= n_al) fail($sformatf("unexpected ALERT %032h (only %0d expected)", al_data, n_al));
                if (al_valid) begin
                    chk_alert(eal[al_seen], al_data);
                    case (al_data[EOG_AL_KIND +: 8])
                        EOG_AK_NS_RAISED: ns_l[al_data[4:0]] = 1'b1;
                        EOG_AK_ES_RAISED: es_l[al_data[4:0]] = 1'b1;
                        EOG_AK_ACKED: if (al_data[EOG_AL_SOURCE + 4]) es_l[al_data[4:0]] = 1'b0;
                                      else ns_l[al_data[4:0]] = 1'b0;
                        default: ;
                    endcase
                end else al_drops = al_drops + 1;
                al_seen = al_seen + 1;
            end
            // accept
            if (in_valid && in_ready) begin
                if (autonomous !== (!hb_fresh && hb_T != 16'd0))
                    fail($sformatf("autonomous = %0b at record %0d, expected %0b", autonomous, acc_cnt,
                                   !hb_fresh && hb_T != 16'd0));
                if (in_data[EOG_BL_STATUS +: 3] != EOG_ST_VALID && in_data[EOG_BL_STATUS +: 3] != EOG_ST_HELD) begin
                    fault_acc = cyc; fault_any = 1; fault_pend = fault_pend + 1;
                end
                acc_cnt = acc_cnt + 1;
            end
            // II / latency (mode 1)
            if (chk_ii && in_valid && !in_ready && out_ready) begin
                ii_wait = ii_wait + 1;
                if (ii_wait >= EOG_II_MAX) fail("II > 16: no accept for 16 cycles with in_valid = out_ready = 1");
            end else ii_wait = 0;
            if (acc_cnt > out_cnt && !out_valid && out_ready) begin
                lat_wait = lat_wait + 1;
                if (lat_wait >= 128) fail("latency > 128 cycles");
            end else lat_wait = 0;
            // LEDs (spec table, TASKS #9, #10)
            if (led_chk && ledovr == 32'd0 && !p_ovr) begin
                if (!(ld1 == 3'b000 || ld1 == ld1_mask(pmod_ja[1:0]) || ld1 == ld1_mask(p_ja[1:0])))
                    fail($sformatf("ld1 = %03b with pmod_ja[1:0] = %02b", ld1, pmod_ja[1:0]));
                case (ld0)
                    3'b000: ;
                    3'b001: if (!(autonomous || p_auto)) fail("ld0 blue while not autonomous");
                    3'b010: if (!(!autonomous || !p_auto)) fail("ld0 green while autonomous");
                    3'b100: if (!(fault_any && (fault_pend > 0 || cyc - fault_out <= 1001 * CYC + 8)))
                                fail("ld0 red with no INVALID/DROPPED record in the last 1000 ms");
                    default: fail($sformatf("ld0 = %03b is not off/red/green/blue", ld0));
                endcase
                if ((ld0 == 3'b001 || ld0 == 3'b010) && fault_any && fault_pend == 0 && cyc - fault_out > 4
                    && cyc - fault_acc < 998 * CYC)
                    fail("ld0 green/blue within 1000 ms of an INVALID/DROPPED record");
                for (k = 0; k < 6; k = k + 1) begin
                    led_on[k] = led_on[k] + (k < 3 ? ld0[k] : ld1[k-3]) - ((led_ring[led_ptr] >> k) & 1);
                    if (led_on[k] > LEDW / 4 + 16) fail($sformatf("LED channel %0d duty above 25 %%", k));
                end
                led_ring[led_ptr] = {ld1, ld0};
                led_ptr = (led_ptr + 1) % LEDW;
                if (pmod_ja[2] !== autonomous && pmod_ja[2] !== p_auto) fail("pmod_ja[2] != autonomous");
                if (pmod_ja[7:4] != 4'd0 || pmod_jb[7:6] != 2'd0) fail("pmod reserved bits set");
                if (pmod_jb[5] !== (pmod_ja[0] | pmod_ja[1])) fail("pmod_jb[5] != any latch");
            end
        end
        p_out_valid = out_valid; p_out_ready = out_ready; p_out_data = out_data;
        p_auto = autonomous; p_ja = pmod_ja; p_ovr = ledovr[31];
    end

    // ---------------------------------------------------------------------------------------------------------
    // Input drivers that run every cycle (1 ns after posedge)
    integer hb_period;
    always @(posedge clk) begin
        #1;
        out_ready = (mode == 1) ? 1'b1 : (rnd(100) < 70);
        al_full   = (mode == 2) ? (rnd(100) < 25) : 1'b0;
        hb_pulse  = 1'b0;
        if (hb_now) begin hb_pulse = 1'b1; hb_now = 1'b0; hb_cnt = 0; end
        else if (running && hb_fresh && hb_T != 16'd0) begin
            hb_cnt = hb_cnt + 1;
            if (hb_cnt >= hb_period) begin hb_pulse = 1'b1; hb_cnt = 0; end
        end
        if (btn0) last_btn_hi = cyc;
    end

    task automatic step;          // to 1 ns after the next posedge
        @(posedge clk); #1;
    endtask

    // ---------------------------------------------------------------------------------------------------------
    // Case flow
    integer al_lt_ptr;            // number of expected ALERTs with index < the current record index

    task automatic drain(input integer upto);
        integer t0, le;
        while (al_lt_ptr < n_al && eal_idx[al_lt_ptr] < upto) al_lt_ptr = al_lt_ptr + 1;
        t0 = cyc;
        while (!(out_cnt == upto && acc_cnt == upto && al_seen >= al_lt_ptr)) begin
            step;
            if (cyc - t0 > 5000)
                fail($sformatf("timeout draining: %0d/%0d records out, %0d/%0d ALERTs", out_cnt, upto, al_seen,
                               al_lt_ptr));
        end
        repeat (4) step;
        le = al_lt_ptr;           // ACKED of earlier acks at this same index may already be out
        while (le < n_al && eal_idx[le] <= upto) le = le + 1;
        if (al_seen < al_lt_ptr || al_seen > le)
            fail($sformatf("%0d ALERTs pushed before record %0d, expected %0d..%0d", al_seen, upto, al_lt_ptr, le));
        quiet_check;
    endtask

    task automatic quiet_check;   // Pmods vs the latch state implied by the ALERT stream (no drops)
        if (mode == 2 || ledovr != 32'd0) return;
        t_quiet = t_quiet + 1;
        if (pmod_ja[1:0] !== {ns_l != '0, es_l != '0})
            fail($sformatf("pmod_ja[1:0] = %02b, ALERT stream implies %02b", pmod_ja[1:0], {ns_l != '0, es_l != '0}));
        if (pmod_jb[4:0] !== worst_of(ns_l, es_l))
            fail($sformatf("pmod_jb worst = %0d, expected %0d", pmod_jb[4:0], worst_of(ns_l, es_l)));
        if (autonomous !== (!hb_fresh && hb_T != 16'd0)) fail("autonomous != heartbeat state");
    endtask

    integer ack_no;
    task automatic do_event(input integer kind, input integer at);
        integer t0;
        drain(at);
        chk_ii = 1'b0;
        case (kind)
            0: begin                                  // hb
                hb_fresh = 1'b1; hb_now = 1'b1;
                repeat (3) step;
                if (ms_since_hb > 16'd1) fail($sformatf("ms_since_hb = %0d after hb_pulse", ms_since_hb));
            end
            1: begin                                  // hb_expire
                hb_fresh = 1'b0;
                step; step;
                t0 = cyc;
                while (ms_since_hb < hb_T) begin
                    step;
                    if (cyc - t0 > (hb_T + 3) * CYC + 20) fail("ms_since_hb does not reach HB_TIMEOUT_MS");
                end
                step;
                if (autonomous !== (hb_T != 16'd0)) fail("autonomous not set after HB_TIMEOUT_MS");
            end
            2: begin                                  // ack: ack_srv / BTN0 alternately
                if (ack_no % 2 == 0) begin
                    ack_srv = 1'b1; step; ack_srv = 1'b0;
                end else begin
                    while (cyc - last_btn_hi < PRESS) step;
                    btn0 = 1'b1; repeat (PRESS) step; btn0 = 1'b0;
                    repeat (PRESS) step;
                    t_btn = t_btn + 1;
                end
                repeat (SETTLE) step;
                ack_no = ack_no + 1;
                t_ack = t_ack + 1;
            end
            default: ;
        endcase
        chk_ii = (mode == 1);
    endtask

    task automatic run_case;
        integer i, ei, g, t0;
        // reset
        running = 1'b0;
        in_valid = 1'b0; ack_srv = 1'b0; btn0 = 1'b0; ledovr = '0;
        glb = vcfg[0][255:0];
        hb_T = glb[EOG_G_HB_TIMEOUT_MS +: 16];
        hb_period = (hb_T <= 16'd1) ? 1 : ((hb_T - 1) * CYC) / 2;
        hb_fresh = 1'b0; hb_now = 1'b0; hb_cnt = 0;
        out_cnt = 0; acc_cnt = 0; al_seen = 0; al_drops = 0; al_lt_ptr = 0;
        ns_l = '0; es_l = '0; ii_wait = 0; lat_wait = 0; chk_ii = 1'b0; ack_no = 0;
        fault_acc = 0; fault_out = 0; fault_pend = 0; fault_any = 0;
        for (i = 0; i < LEDW; i = i + 1) led_ring[i] = 0;
        for (i = 0; i < 6; i = i + 1) led_on[i] = 0;
        led_ptr = 0; led_chk = 1'b0;
        rst_n = 1'b0;
        repeat (4) step;
        rst_n = 1'b1;
        step;
        if (ms_since_hb !== 16'hFFFF) fail($sformatf("ms_since_hb = %0h after reset, expected ffff", ms_since_hb));
        if (out_valid !== 1'b0 || al_valid !== 1'b0 || al_drop !== 1'b0) fail("valid output after reset");
        running = 1'b1;
        repeat (2) step;
        led_chk = 1'b1;
        chk_ii = (mode == 1);
        ei = 0;
        for (i = 0; i <= n_rec; i = i + 1) begin
            while (ei < n_ev && ev_idx[ei] == i) begin
                do_event(ev_kind[ei], i);
                ei = ei + 1;
            end
            if (i == n_rec) break;
            if (mode != 1) begin
                if (rnd(30) == 0 && cyc - last_btn_hi > PRESS + 2) begin   // glitch: must not acknowledge
                    g = 1 + rnd(GLITCH);
                    btn0 = 1'b1; repeat (g) step; btn0 = 1'b0;
                    t_glitch = t_glitch + 1;
                end
                if (rnd(4) == 0) repeat (1 + rnd(3)) step;
            end
            in_data = vin[i];
            in_valid = 1'b1;
            t0 = cyc;
            @(negedge clk);
            while (!in_ready) begin
                @(negedge clk);
                if (cyc - t0 > 5000) fail($sformatf("record %0d never accepted", i));
            end
            @(posedge clk); #1;
            in_valid = 1'b0;
            in_data = '0;
        end
        drain(n_rec);
        repeat (SETTLE) step;
        if (out_cnt != n_rec) fail($sformatf("%0d records out, expected %0d", out_cnt, n_rec));
        if (al_seen != n_al) fail($sformatf("%0d ALERTs pushed/dropped, expected %0d", al_seen, n_al));
        t_rec = t_rec + n_rec;
        t_al = t_al + n_al;
        t_drop = t_drop + al_drops;
        running = 1'b0;
        led_chk = 1'b0;
    endtask

    task automatic ledovr_test;   // TASKS #9: raw values, no PWM
        ledovr = {1'b1, 7'd0, 8'hA5, 8'h3C, 2'b00, 3'b101, 3'b011};
        repeat (3) step;
        if ({pmod_jb, pmod_ja, ld1, ld0} !== {8'hA5, 8'h3C, 3'b101, 3'b011})
            fail($sformatf("ledovr: got ld0 %03b ld1 %03b ja %02h jb %02h", ld0, ld1, pmod_ja, pmod_jb));
        ledovr = {1'b1, 7'd0, 8'h5A, 8'hC3, 2'b00, 3'b010, 3'b100};
        repeat (3) step;
        if ({pmod_jb, pmod_ja, ld1, ld0} !== {8'h5A, 8'hC3, 3'b010, 3'b100})
            fail($sformatf("ledovr: got ld0 %03b ld1 %03b ja %02h jb %02h", ld0, ld1, pmod_ja, pmod_jb));
        ledovr = '0;
        repeat (3) step;
    endtask

    // ---------------------------------------------------------------------------------------------------------
    // Loading
    function automatic integer count_lines(input string fname);
        integer fd, n, r;
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
        string base, fname;
        integer fd, r, idx, num;
        reg [8*16-1:0] kind;
        reg [8*16-1:0] cause;
        reg [8*160-1:0] hexs;
        reg [127:0] al;
        ok = 0;
        base = {"tb/vectors/alarm_", nm};
        n_rec = count_lines({base, ".in.hex"});
        if (n_rec < 0) return;
        if (n_rec > MAXR) begin $display("FAIL: case %0s has %0d records > MAXR", nm, n_rec); $finish; end
        if (count_lines({base, ".out.hex"}) != n_rec) begin
            $display("FAIL: case %0s: .in.hex and .out.hex line counts differ", nm); $finish;
        end
        $readmemh({base, ".in.hex"}, vin, 0, n_rec - 1);
        $readmemh({base, ".out.hex"}, vout, 0, n_rec - 1);
        $readmemh({base, ".cfg.hex"}, vcfg);
        // ALERTs (push order): "<index> <rec|ack> <hex>"
        n_al = 0;
        fd = $fopen({base, ".al.txt"}, "r");
        if (fd == 0) begin $display("FAIL: case %0s: no .al.txt", nm); $finish; end
        while (!$feof(fd)) begin
            r = $fscanf(fd, "%d %s %h\n", idx, cause, al);
            if (r == 3) begin
                if (n_al >= MAXA) begin $display("FAIL: case %0s: too many ALERTs", nm); $finish; end
                eal[n_al] = al; eal_idx[n_al] = idx; n_al = n_al + 1;
            end else if (r > 0) begin $display("FAIL: case %0s: bad .al.txt line", nm); $finish; end
            else break;
        end
        $fclose(fd);
        // events: "<index> <kind> <n> <hex>"
        n_ev = 0;
        fd = $fopen({base, ".events.txt"}, "r");
        if (fd != 0) begin
            while (!$feof(fd)) begin
                r = $fscanf(fd, "%d %s %d %s\n", idx, kind, num, hexs);
                if (r == 4) begin
                    if (n_ev >= MAXE) begin $display("FAIL: case %0s: too many events", nm); $finish; end
                    ev_idx[n_ev] = idx;
                    ev_kind[n_ev] = (kind == "hb") ? 0 : (kind == "hb_expire") ? 1 : (kind == "ack") ? 2 : 3;
                    n_ev = n_ev + 1;
                end else break;
            end
            $fclose(fd);
        end
        ok = 1;
    endtask

    // ---------------------------------------------------------------------------------------------------------
    initial begin : main
        integer fd, r, ok, nc, did_ovr;
        reg [8*1024-1:0] line;
        string nm;
        string names [0:63];
        mode = 0;
        case_name = "-";
        last_btn_hi = 0;
        did_ovr = 0;
        // case list from INDEX.txt
        nc = 0;
        fd = $fopen("tb/vectors/INDEX.txt", "r");
        if (fd == 0) begin $display("FAIL: no tb/vectors/INDEX.txt"); $finish; end
        while (!$feof(fd)) begin
            r = $fgets(line, fd);
            if (r > 0) begin
                r = $sscanf(line, "case %s", nm);
                if (r == 1 && nc < 64) begin names[nc] = nm; nc = nc + 1; end
            end
        end
        $fclose(fd);
        repeat (2) step;
        for (int ci = 0; ci < nc; ci = ci + 1) begin
            case_name = names[ci];
            load_case(names[ci], ok);
            if (!ok) begin
                $display("case %0s: skipped (no tb/vectors/alarm_%0s.in.hex)", names[ci], names[ci]);
                continue;
            end
            for (mode = 0; mode < 3; mode = mode + 1) begin
                run_case;
                if (!did_ovr) begin ledovr_test; did_ovr = 1; end
            end
            $display("case %0s: %0d records, %0d ALERTs, %0d events x 3 modes ok", names[ci], n_rec, n_al, n_ev);
            ran = {ran, " ", names[ci]};
            t_cases = t_cases + 1;
        end
        if (t_cases == 0) begin $display("FAIL: no alarm vectors found"); $finish; end
        $display("PASS: %0d records, %0d ALERTs (%0d dropped in mode 2), %0d acks (%0d by BTN0), %0d BTN0 glitches, %0d quiet-point Pmod checks; %0d cases x 3 modes:%0s",
                 t_rec, t_al, t_drop, t_ack, t_btn, t_glitch, t_quiet, t_cases, ran);
        $finish;
    end
endmodule
