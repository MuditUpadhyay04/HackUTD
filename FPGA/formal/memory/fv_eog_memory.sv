// fv_eog_memory.sv — formal harness for eog_memory (task T1.memory.fv, Verify role).
//
// Written from spec/modules/eog_memory.md, spec/numerics.md §5 and spec/conventions.md (spec v2) plus the lead's
// answers to TASKS.md spec questions 1-2. Only the DUT's port list (spec port table + conventions §7 observation
// ports) is used; no hierarchical references into the DUT.
//
// Instance: N_FAC = 2, II = 4. One anyconst slot `f_slot` (< N_FAC) and one anyconst gated channel `f_chan`
// (0..4) carry the shadow models. eog_memory has no multiplier, so no eog_mul file is read in any task.
//
// Defines (set per task in eog_memory.sby):
//   FV_PROVE  port-only properties (k-induction): stage contract, header/copy, M1 outputs, Q1, the port-only
//             parts of M2/M3/M4. Per-slot state can sit untouched for unbounded time and its low 8 EMA bits are
//             never visible at the ports, so value properties that depend on history cannot be inductive here.
//   FV_BMC    everything in FV_PROVE plus the history-dependent value properties from reset: M2 (min/max
//             tracker), M3/M4/M5 (exact shadow of slot f_slot), M1 "no state change" and M6 (the shadow sees
//             only VALID/HELD records of f_slot, so any influence of another slot or of an INVALID/DROPPED
//             record on f_slot's outputs is a mismatch).
//   FV_COVER  short cover goals.   FV_COVER64  the spec cover: a slot that ran, stopped 64+ records, ran again.
//
// Property labels: Hx header pass-through, Cx copies, M1..M6 per the module spec, Q1 = TASKS.md spec question 1,
// stage contract inside u_in/u_out (eog_fv_axis) and u_stage (eog_fv_stage).

`default_nettype none

module fv_eog_memory (
    input logic clk
);
`include "eog_defs.svh"

    localparam integer FV_N_FAC   = 2;
    localparam integer FV_II      = 4;
    localparam integer FV_SWEEP   = FV_N_FAC + 8;   // conventions §1: in_ready = 0 for up to N_FAC + 8 cycles
    localparam integer FV_INFL    = 2;              // records in flight allowed (conventions §3 permits overlap
                                                    // with a hazard check); the harness queue below has 2 entries
    localparam integer RW         = 8;              // REC_NO low bits compared by eog_fv_stage

    // ---------------------------------------------------------------------------------------------------------
    // Free inputs (the solver drives them)
    logic                rst_n, in_valid, out_ready;
    logic [EOG_BF_W-1:0] in_data;
    assign rst_n     = $anyseq;
    assign in_valid  = $anyseq;
    assign out_ready = $anyseq;
    assign in_data   = $anyseq;

    // anyconst slot and gated channel for the shadow models
    logic [4:0] f_slot;
    logic [2:0] f_chan;
    assign f_slot = $anyconst;
    assign f_chan = $anyconst;
    always_comb begin
        assume (f_slot < FV_N_FAC);
        assume (f_chan < 3'd5);
    end

    // ---------------------------------------------------------------------------------------------------------
    // DUT
    logic                in_ready, out_valid;
    logic [EOG_BM_W-1:0] out_data;
    logic [7:0]          dut_inflight;
    logic [31:0]         dut_oldest;

    eog_memory #(.N_FAC(FV_N_FAC), .II(FV_II)) dut (
        .clk(clk), .rst_n(rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data),
        .f_inflight(dut_inflight), .f_oldest_recno(dut_oldest));

    // ---------------------------------------------------------------------------------------------------------
    // Stage contract (conventions §2, §3) with the shared checkers
    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    eog_fv_axis #(.W(EOG_BF_W), .ASSUME(1)) u_in (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(in_valid), .ready(in_ready), .data(in_data));
    eog_fv_axis #(.W(EOG_BM_W), .ASSUME(0)) u_out (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(out_valid), .ready(out_ready), .data(out_data));

    logic [RW-1:0] f_in_cnt, f_out_cnt;
    logic [7:0]    f_in_flight;
    eog_fv_stage #(.RW(RW), .MAX_INFLIGHT(FV_INFL), .II_MAX(EOG_II_MAX), .LAT_MAX(128), .SWEEP(FV_SWEEP)) u_stage (
        .clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .in_valid(in_valid), .in_ready(in_ready), .in_recno(in_data[EOG_BF_REC_NO +: RW]),
        .out_valid(out_valid), .out_ready(out_ready), .out_recno(out_data[EOG_BM_REC_NO +: RW]),
        .excl(1'b0), .dut_inflight(dut_inflight), .dut_oldest(dut_oldest),
        .f_in_cnt(f_in_cnt), .f_out_cnt(f_out_cnt), .f_in_flight(f_in_flight));

    logic in_fire, out_fire;
    assign in_fire  = in_valid && in_ready;
    assign out_fire = out_valid && out_ready;

    // ---------------------------------------------------------------------------------------------------------
    // Input environment: eog_features never produces STATUS 2 or 5..7 (conventions §3). Everything else free:
    // FAC may be >= N_FAC (spec question 1), HIST_RESET may come with any status, features take any int16.
    logic [2:0] i_st;
    assign i_st = in_data[EOG_BF_STATUS +: EOG_BF_STATUS_W];
    always_comb if (in_valid)
        a_status: assume (i_st == EOG_ST_VALID || i_st == EOG_ST_HELD || i_st == EOG_ST_INVALID ||
                          i_st == EOG_ST_DROPPED);

    // ---------------------------------------------------------------------------------------------------------
    // Field helpers
    function automatic logic [15:0] fin(input logic [EOG_BF_W-1:0] d, input integer c);   // bus F FEAT0_11[c]
        fin = d[EOG_BF_FEAT0_11 + 16*c +: 16];
    endfunction
    function automatic logic [15:0] fout(input logic [EOG_BM_W-1:0] d, input integer i);  // bus M FEAT[i]
        fout = d[EOG_BM_FEAT + 16*i +: 16];
    endfunction
    function automatic integer gch(input integer i);   // gated channels g = (1, 2, 3, 5, 6)
        gch = (i < 3) ? i + 1 : i + 2;
    endfunction
    function automatic logic upd_rec(input logic [EOG_BF_W-1:0] d);   // updates state of a real slot
        upd_rec = (d[EOG_BF_STATUS +: 3] == EOG_ST_VALID || d[EOG_BF_STATUS +: 3] == EOG_ST_HELD) &&
                  (d[EOG_BF_FAC +: EOG_BF_FAC_W] < FV_N_FAC);
    endfunction
    // min(v, 64) << 8 for an 8-bit counter
    function automatic logic [15:0] cap64(input logic [7:0] v);
        cap64 = (v >= 8'd64) ? 16'd16384 : {2'b00, v[5:0], 8'h00};
    endfunction
    // s16 x  ->  x << 8 as s32
    function automatic logic [31:0] sh8(input logic [15:0] x);
        sh8 = {{8{x[15]}}, x, 8'h00};
    endfunction
    function automatic logic slt(input logic [15:0] a, input logic [15:0] b);   // signed a < b
        slt = $signed(a) < $signed(b);
    endfunction

    // ---------------------------------------------------------------------------------------------------------
    // Accepted-input queue (indexed by REC_NO order; FV_INFL = 2 entries), so each output is compared with the
    // input record it belongs to. A same-cycle pass-through (nothing in flight) compares with in_data.
    logic [EOG_BF_W-1:0] q_in0, q_in1;
    always_ff @(posedge clk) if (in_fire) begin
        if (f_in_cnt[0]) q_in1 <= in_data; else q_in0 <= in_data;
    end
    logic [EOG_BF_W-1:0] h;   // input record of the current output
    assign h = (f_in_flight == 8'd0) ? in_data : (f_out_cnt[0] ? q_in1 : q_in0);

    logic [2:0] h_st;
    logic       h_vh, h_bad, h_upd, h_hr, h_run;
    logic [4:0] h_fac;
    assign h_st  = h[EOG_BF_STATUS +: 3];
    assign h_fac = h[EOG_BF_FAC +: EOG_BF_FAC_W];
    assign h_vh  = (h_st == EOG_ST_VALID) || (h_st == EOG_ST_HELD);
    assign h_bad = (h_st == EOG_ST_INVALID) || (h_st == EOG_ST_DROPPED);
    assign h_upd = h_vh && (h_fac < FV_N_FAC);
    assign h_hr  = h[EOG_BF_HIST_RESET];
    assign h_run = h[EOG_BF_PUMP_RUN];

    logic chk;   // an output is presented and the properties apply
    assign chk = f_past_valid && rst_n && out_valid;

    // ---------------------------------------------------------------------------------------------------------
    // Port-only properties (all tasks)
    // per gated channel i: FEAT[12+i], FEAT[17+i], FEAT[22+i] equal x_g[i] (one assert per vector)
    logic [4:0] ok_last, ok_hr_f, ok_hr_s;
    always_comb begin
        for (int i = 0; i < 5; i++) begin
            ok_last[i] = (fout(out_data, 12 + i) == fin(h, gch(i)));
            ok_hr_f[i] = (fout(out_data, 17 + i) == fin(h, gch(i)));
            ok_hr_s[i] = (fout(out_data, 22 + i) == fin(h, gch(i)));
        end
    end

    always_comb if (chk) begin
        // Header pass-through (conventions §3; eog_memory sets no REASON bits: "Header copied")
        H_recno:  assert (out_data[EOG_BM_REC_NO +: EOG_BM_REC_NO_W]           == h[EOG_BF_REC_NO +: EOG_BF_REC_NO_W]);
        H_last:   assert (out_data[EOG_BM_IN_LAST +: EOG_BM_IN_LAST_W]         == h[EOG_BF_IN_LAST +: EOG_BF_IN_LAST_W]);
        H_facraw: assert (out_data[EOG_BM_FAC_RAW +: EOG_BM_FAC_RAW_W]         == h[EOG_BF_FAC_RAW +: EOG_BF_FAC_RAW_W]);
        H_fac:    assert (out_data[EOG_BM_FAC +: EOG_BM_FAC_W]                 == h[EOG_BF_FAC +: EOG_BF_FAC_W]);
        H_ts:     assert (out_data[EOG_BM_TS +: EOG_BM_TS_W]                   == h[EOG_BF_TS +: EOG_BF_TS_W]);
        H_status: assert (out_data[EOG_BM_STATUS +: EOG_BM_STATUS_W]           == h[EOG_BF_STATUS +: EOG_BF_STATUS_W]);
        H_reason: assert (out_data[EOG_BM_REASON +: EOG_BM_REASON_W]           == h[EOG_BF_REASON +: EOG_BF_REASON_W]);
        H_since:  assert (out_data[EOG_BM_SINCE_RESET +: EOG_BM_SINCE_RESET_W] == h[EOG_BF_SINCE_RESET +: EOG_BF_SINCE_RESET_W]);
        H_hr:     assert (out_data[EOG_BM_HIST_RESET +: EOG_BM_HIST_RESET_W]   == h[EOG_BF_HIST_RESET +: EOG_BF_HIST_RESET_W]);
        // Copies: FEAT[0..11] = FEAT0_11 (every status), RULES4, INFLOW, LEVEL
        C_feat:   assert (out_data[EOG_BM_FEAT +: EOG_BF_FEAT0_11_W]           == h[EOG_BF_FEAT0_11 +: EOG_BF_FEAT0_11_W]);
        C_rules:  assert (out_data[EOG_BM_RULES4 +: EOG_BM_RULES4_W]           == h[EOG_BF_RULES4 +: EOG_BF_RULES4_W]);
        C_inflow: assert (out_data[EOG_BM_INFLOW +: EOG_BM_INFLOW_W]           == h[EOG_BF_INFLOW +: EOG_BF_INFLOW_W]);
        C_level:  assert (out_data[EOG_BM_LEVEL +: EOG_BM_LEVEL_W]             == h[EOG_BF_LEVEL +: EOG_BF_LEVEL_W]);

        // M1 (output part): INVALID/DROPPED -> FEAT[12..30] = 0
        if (h_bad)
            M1_zero: assert (out_data[EOG_BM_FEAT + 16*12 +: 16*19] == '0);
        // Q1 (spec question 1): VALID/HELD with FAC >= N_FAC -> FEAT[12..30] = 0
        if (h_vh && h_fac >= FV_N_FAC)
            Q1_zero: assert (out_data[EOG_BM_FEAT + 16*12 +: 16*19] == '0);

        if (h_upd) begin
            // M4 (SINCE_RESET part): FEAT[30] = min(SINCE_RESET, 64) << 8
            M4_since: assert (fout(out_data, 30) == cap64(h[EOG_BF_SINCE_RESET +: 8]));
            // M4 (port-visible shape of FEAT[28] = min(nsr, 64) << 8)
            M4_shape: assert (out_data[EOG_BM_FEAT + 16*28 +: 8] == 8'h00 && fout(out_data, 28) <= 16'd16384);
            // FEAT[29] = has_run ? 16384 : 0
            M3_hasfmt: assert (fout(out_data, 29) == 16'd0 || fout(out_data, 29) == 16'd16384);
            if (h_run) begin
                // a running record: nsr = 0, has_run = 1, last_run[i] = x_g[i]
                M4_run0:  assert (fout(out_data, 28) == 16'd0);
                M3_has:   assert (fout(out_data, 29) == 16'd16384);
                M3_last:  assert (ok_last == 5'b11111);
            end else begin
                // a non-running record: nsr >= 1
                M4_norun: assert (fout(out_data, 28) >= 16'd256);
            end
            if (h_hr) begin
                // record that starts a new history: state cleared before the update
                // net_ema = (FEAT[11] << 8) >>> 3, so FEAT[27] = FEAT[11] >>> 3
                M3_hr_net: assert ($signed(fout(out_data, 27)) == ($signed(fin(h, 11)) >>> 3));
                if (h_run) begin
                    // M3 on the reset record itself: first running record after a reset
                    M3_hr_f: assert (ok_hr_f == 5'b11111);
                    M3_hr_s: assert (ok_hr_s == 5'b11111);
                end else begin
                    M3_hr_idle: assert (out_data[EOG_BM_FEAT + 16*12 +: 16*15] == '0 &&
                                        fout(out_data, 28) == 16'd256 && fout(out_data, 29) == 16'd0);
                end
            end
        end
    end

`ifdef FV_BMC
    // ---------------------------------------------------------------------------------------------------------
    // Shadow of slot f_slot (numerics.md §5, written from the spec), updated at acceptance in REC_NO order.
    logic [5*16-1:0] sh_last;
    logic [5*32-1:0] sh_ef, sh_es;
    logic [31:0]     sh_net;
    logic [7:0]      sh_nsr;
    logic            sh_has;
    // M2 trackers: min/max of the absorbed inputs of gated channel f_chan, and of net_ema's inputs
    logic [15:0]     tr_mn, tr_mx, tr_nmn, tr_nmx;

    logic in_f;   // accepted VALID/HELD record of slot f_slot
    assign in_f = in_fire && upd_rec(in_data) && (in_data[EOG_BF_FAC +: 5] == f_slot);

    logic [5*16-1:0] n_last;
    logic [5*32-1:0] n_ef, n_es;
    logic [31:0]     n_net;
    logic [7:0]      n_nsr;
    logic            n_has;
    logic            n_first;     // the record is the slot's first running record since the last reset
    logic [15:0]     n_mn, n_mx, n_nmn, n_nmx;
    logic [19*16-1:0] n_exp;      // expected FEAT[12..30] of the record being accepted (if it is in_f)

    always_comb begin : shadow_next
        logic signed [31:0] d, q;
        logic [31:0] xs, e;
        logic [15:0] x, x11, xj;
        logic        hr, run;
        hr  = in_data[EOG_BF_HIST_RESET];
        run = in_data[EOG_BF_PUMP_RUN];
        d = '0; q = '0; xs = '0; e = '0; x = '0; x11 = '0; xj = '0;   // no latches for the block temporaries
        n_last = sh_last; n_ef = sh_ef; n_es = sh_es; n_net = sh_net; n_nsr = sh_nsr; n_has = sh_has;
        n_mn = tr_mn; n_mx = tr_mx; n_nmn = tr_nmn; n_nmx = tr_nmx;
        if (hr) begin   // HIST_RESET clears the slot before the update
            n_last = '0; n_ef = '0; n_es = '0; n_net = '0; n_nsr = '0; n_has = 1'b0;
            n_mn = '0; n_mx = '0; n_nmn = '0; n_nmx = '0;
        end
        n_first = run && !n_has;
        if (run) begin
            for (int i = 0; i < 5; i++) begin
                x  = fin(in_data, gch(i));
                xs = sh8(x);
                if (!n_has) begin
                    n_ef[32*i +: 32] = xs;
                    n_es[32*i +: 32] = xs;
                end else begin
                    e = n_ef[32*i +: 32];
                    d = $signed(xs) - $signed(e);
                    q = d >>> EOG_EMA_FAST;
                    n_ef[32*i +: 32] = e + q;
                    e = n_es[32*i +: 32];
                    d = $signed(xs) - $signed(e);
                    q = d >>> EOG_EMA_SLOW;
                    n_es[32*i +: 32] = e + q;
                end
                n_last[16*i +: 16] = x;
            end
            xj = fin(in_data, gch(f_chan));
            if (!n_has) begin
                n_mn = xj; n_mx = xj;
            end else begin
                if (slt(xj, n_mn)) n_mn = xj;
                if (slt(n_mx, xj)) n_mx = xj;
            end
            n_has = 1'b1;
            n_nsr = 8'd0;
        end else begin
            n_nsr = (n_nsr == 8'd255) ? 8'd255 : n_nsr + 8'd1;
        end
        x11 = fin(in_data, 11);
        d = $signed(sh8(x11)) - $signed(n_net);
        q = d >>> EOG_EMA_FAST;
        n_net = n_net + q;
        if (slt(x11, n_nmn)) n_nmn = x11;     // net_ema's inputs include its initial 0 (spec question 2)
        if (slt(n_nmx, x11)) n_nmx = x11;

        for (int i = 0; i < 5; i++) begin
            n_exp[16*(0  + i) +: 16] = n_last[16*i +: 16];
            n_exp[16*(5  + i) +: 16] = n_ef[32*i + 8 +: 16];   // ema_f >>> 8
            n_exp[16*(10 + i) +: 16] = n_es[32*i + 8 +: 16];   // ema_s >>> 8
        end
        n_exp[16*15 +: 16] = n_net[8 +: 16];                     // net_ema >>> 8
        n_exp[16*16 +: 16] = cap64(n_nsr);
        n_exp[16*17 +: 16] = n_has ? 16'd16384 : 16'd0;
        n_exp[16*18 +: 16] = cap64(in_data[EOG_BF_SINCE_RESET +: 8]);
    end

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            sh_last <= '0; sh_ef <= '0; sh_es <= '0; sh_net <= '0; sh_nsr <= '0; sh_has <= 1'b0;
            tr_mn <= '0; tr_mx <= '0; tr_nmn <= '0; tr_nmx <= '0;
        end else if (in_f) begin
            sh_last <= n_last; sh_ef <= n_ef; sh_es <= n_es; sh_net <= n_net; sh_nsr <= n_nsr; sh_has <= n_has;
            tr_mn <= n_mn; tr_mx <= n_mx; tr_nmn <= n_nmn; tr_nmx <= n_nmx;
        end
    end

    // expected values and bounds travel with the record through the same 2-entry queue
    logic [19*16-1:0] q_exp0, q_exp1;
    logic [63:0]      q_bnd0, q_bnd1;
    logic             q_has0, q_has1, q_fst0, q_fst1;
    always_ff @(posedge clk) if (in_fire) begin
        if (f_in_cnt[0]) begin
            q_exp1 <= n_exp; q_bnd1 <= {n_mn, n_mx, n_nmn, n_nmx}; q_has1 <= n_has; q_fst1 <= n_first;
        end else begin
            q_exp0 <= n_exp; q_bnd0 <= {n_mn, n_mx, n_nmn, n_nmx}; q_has0 <= n_has; q_fst0 <= n_first;
        end
    end
    logic [19*16-1:0] h_exp;
    logic [63:0]      h_bnd;
    logic             h_has, h_first;
    assign h_exp   = (f_in_flight == 8'd0) ? n_exp : (f_out_cnt[0] ? q_exp1 : q_exp0);
    assign h_bnd   = (f_in_flight == 8'd0) ? {n_mn, n_mx, n_nmn, n_nmx} : (f_out_cnt[0] ? q_bnd1 : q_bnd0);
    assign h_has   = (f_in_flight == 8'd0) ? n_has : (f_out_cnt[0] ? q_has1 : q_has0);
    assign h_first = (f_in_flight == 8'd0) ? n_first : (f_out_cnt[0] ? q_fst1 : q_fst0);

    logic h_f;
    assign h_f = h_upd && (h_fac == f_slot);

    logic [4:0] ok5_last, ok5_ef, ok5_es;
    always_comb begin
        for (int i = 0; i < 5; i++) begin
            ok5_last[i] = (fout(out_data, 12 + i) == h_exp[16*(0  + i) +: 16]);
            ok5_ef[i]   = (fout(out_data, 17 + i) == h_exp[16*(5  + i) +: 16]);
            ok5_es[i]   = (fout(out_data, 22 + i) == h_exp[16*(10 + i) +: 16]);
        end
    end

    always_comb if (chk && h_f) begin
        // M2 (cleared state): no running record since the last reset -> FEAT[12..26] still 0
        if (!h_has)
            M2_norun: assert (out_data[EOG_BM_FEAT + 16*12 +: 16*15] == '0);
        // M3: first running record after a reset (rst_n or HIST_RESET), after any number of idle records:
        // FEAT[17+i] == FEAT[22+i] == FEAT[g_i] (ok_hr_* compare with x_g[i]) and FEAT[29] = 16384
        if (h_first)
            M3_first: assert (ok_hr_f == 5'b11111 && ok_hr_s == 5'b11111 && fout(out_data, 29) == 16'd16384);
        // M5: exact update equations of numerics.md §5 for slot f_slot. Because the shadow absorbs only the
        // VALID/HELD records of f_slot (anyconst, so every slot), these also prove M1 "no state change for any
        // slot" on INVALID/DROPPED/FAC >= N_FAC records and M6 slot independence.
        M5_last:  assert (ok5_last == 5'b11111);
        M5_emaf:  assert (ok5_ef   == 5'b11111);
        M5_emas:  assert (ok5_es   == 5'b11111);
        M5_net:   assert (fout(out_data, 27) == h_exp[16*15 +: 16]);
        M4_nsr:   assert (fout(out_data, 28) == h_exp[16*16 +: 16]);   // harness nsr counter
        M5_has:   assert (fout(out_data, 29) == h_exp[16*17 +: 16]);
        M5_since: assert (fout(out_data, 30) == h_exp[16*18 +: 16]);
        // M2: each average within the min/max of the inputs absorbed since the last reset
        if (h_has) begin
            M2_last: assert (!slt(fout(out_data, 12 + f_chan), h_bnd[48 +: 16]) &&
                             !slt(h_bnd[32 +: 16], fout(out_data, 12 + f_chan)));
            M2_emaf: assert (!slt(fout(out_data, 17 + f_chan), h_bnd[48 +: 16]) &&
                             !slt(h_bnd[32 +: 16], fout(out_data, 17 + f_chan)));
            M2_emas: assert (!slt(fout(out_data, 22 + f_chan), h_bnd[48 +: 16]) &&
                             !slt(h_bnd[32 +: 16], fout(out_data, 22 + f_chan)));
        end
        M2_net:   assert (!slt(fout(out_data, 27), h_bnd[16 +: 16]) && !slt(h_bnd[0 +: 16], fout(out_data, 27)));
    end
`endif

    // ---------------------------------------------------------------------------------------------------------
    // Cover (port-only)
    // last VALID/HELD output of each real slot: FEAT[28], FEAT[29]
    // (indexing by h_fac[0] assumes FV_N_FAC = 2)
    logic [15:0] c_prev28_0, c_prev28_1, c_prev29_0, c_prev29_1;
    logic [FV_N_FAC-1:0] c_seen;
    initial c_seen = '0;
    always_ff @(posedge clk) begin
        if (!rst_n) c_seen <= '0;
        else if (out_fire && h_upd) begin
            if (h_fac[0]) begin c_prev28_1 <= fout(out_data, 28); c_prev29_1 <= fout(out_data, 29); end
            else          begin c_prev28_0 <= fout(out_data, 28); c_prev29_0 <= fout(out_data, 29); end
            c_seen[h_fac[0]] <= 1'b1;
        end
    end
    logic [15:0] c_p28, c_p29;   // previous VALID/HELD output of the current output's slot
    assign c_p28 = h_fac[0] ? c_prev28_1 : c_prev28_0;
    assign c_p29 = h_fac[0] ? c_prev29_1 : c_prev29_0;

`ifdef FV_COVER
    logic c_bp;   // an output was held under back-pressure
    initial c_bp = 1'b0;
    always_ff @(posedge clk) if (!rst_n) c_bp <= 1'b0; else if (out_valid && !out_ready) c_bp <= 1'b1;
    always_ff @(posedge clk) if (f_past_valid && rst_n && out_fire) begin
        cv_first_run: cover (h_upd && h_hr && h_run);
        cv_ema:       cover (h_upd && !h_hr && h_run && c_seen[h_fac[0]] && c_p29 == 16'd16384 &&
                             fout(out_data, 17) != fout(out_data, 1));
        cv_idle_run:  cover (h_upd && !h_hr && h_run && c_seen[h_fac[0]] && c_p29 == 16'd0);
        cv_invalid:   cover (h_st == EOG_ST_INVALID && c_seen[0]);
        cv_dropped:   cover (h_st == EOG_ST_DROPPED);
        cv_fac_oob:   cover (h_vh && h_fac >= FV_N_FAC);
        cv_two_slots: cover (h_upd && c_seen == {FV_N_FAC{1'b1}});
        cv_bp:        cover (c_bp && f_out_cnt >= 8'd2);
    end
`endif

`ifdef FV_COVER64
    // spec cover: a slot that has run, stopped 64+ records, and run again (no reset in between)
    always_ff @(posedge clk) if (f_past_valid && rst_n && out_fire)
        cv_rerun64: cover (h_upd && !h_hr && h_run && c_seen[h_fac[0]] &&
                           c_p28 == 16'd16384 && c_p29 == 16'd16384);
`endif
endmodule

`default_nettype wire
