// fv_eog_memory.sv — formal harness for eog_memory (task T1.memory.fv, Verify role).
//
// Written from spec v4: spec/modules/eog_memory.md, spec/numerics.md §5, spec/conventions.md §1-3 and §7, and the
// lead's answers in TASKS.md (#1 FAC >= N_FAC touches no state; #43 net_ema starts at the first VALID/HELD record,
// replacing #2; #44 HIST_RESET on any non-DROPPED status code clears the slot). Only the DUT's ports are used (spec
// port table + the conventions §7 observation ports); no hierarchical references into the DUT.
//
// Instance: N_FAC = 2, II = 4. One anyconst slot `f_slot` (< N_FAC) and one anyconst gated channel `f_chan` (0..4)
// carry the shadow models. eog_memory has no multiplier (shifts and adds only), so no eog_mul file is read.
//
// Defines (set per task in eog_memory.sby):
//   FV_PROVE     k-induction, free inputs: every property that depends only on the record being output (stage
//                contract, header/copies, M1/Q1 zero outputs, the record-local parts of M3/M4). Per-slot state can
//                sit untouched for unbounded time and the low 8 bits of every average never reach the ports, so
//                history-dependent values are not port-only inductive.
//   FV_BMC       bmc from reset: the above plus a shadow of slot f_slot (numerics.md §5): exact last_run, has_run,
//                nsr (M4), first-run and first-record values (M3), cleared state (M2), and so M1 "INVALID changes
//                state only by its HIST_RESET, DROPPED changes none" and M6 slot independence (the shadow absorbs
//                only f_slot's own non-DROPPED records).
//   FV_ARITH     with FV_BMC: also the averages, exact (M5: ema_f/ema_s of channel f_chan, net_ema) and within the
//                min/max of their inputs (M2), plus harness lemmas L_* about the shadow. Expensive (hidden low bits),
//                so it runs at full rate (FV_FULLRATE) in its own task.
//   FV_FULLRATE  one reset in cycle 0, then in_valid = out_ready = 1; data free.
//   FV_DEEP      FV_FULLRATE with every value field 0 and only STATUS/FAC/HIST_RESET/PUMP_RUN/SINCE_RESET free
//                (64+ record stretches). With FV_COVER64 also FAC = 0, HIST_RESET = 0, STATUS = VALID.
//   FV_COVER     short cover goals.   FV_COVER64  the spec's cover: a slot that ran, stopped 64+ records, ran again.
//
// Property labels: H_* header pass-through, C_* copies, M1..M6 per the module spec, Q1 = TASKS.md #1, L_* harness
// lemmas (facts about the shadow alone), stage contract inside u_in/u_out (eog_fv_axis) and u_stage (eog_fv_stage).

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
    // Inputs
    logic                rst_n, in_valid, out_ready;
    logic [EOG_BF_W-1:0] in_data;
    logic [RW-1:0]       f_in_cnt, f_out_cnt;   // from u_stage below
    logic                f_past_valid;          // from u_init below
`ifdef FV_DEEP
 `define FV_FR
`endif
`ifdef FV_FULLRATE
 `define FV_FR
`endif
`ifndef FV_FR
    // prove, bmc, cover: everything free (the solver drives it)
    assign rst_n     = $anyseq;
    assign in_valid  = $anyseq;
    assign out_ready = $anyseq;
    assign in_data   = $anyseq;
`else
    // one reset in cycle 0, then in_valid = out_ready = 1 from cycle 2 on: records follow each other at the DUT's
    // own rate (back-to-back records of one slot are the hazard case); gaps and back-pressure are covered by the
    // prove and bmc tasks. (A reset of free length here makes the arithmetic bmc several times slower.)
    logic [1:0] d_t;
    initial d_t = 2'd0;
    always_ff @(posedge clk) if (d_t != 2'd3) d_t <= d_t + 2'd1;
    assign rst_n     = (d_t != 2'd0);
    assign in_valid  = (d_t >= 2'd2);
    assign out_ready = 1'b1;
 `ifndef FV_DEEP
    assign in_data   = $anyseq;
 `else
    // FV_DEEP: the 64-record nsr cap needs ~66 records of one slot (~200 cycles), too deep for free data. Every
    // value field is 0 and REC_NO = the acceptance count.
    logic [2:0] d_st;
    logic       d_fac, d_hr, d_run;
    logic [7:0] d_since;
    assign d_run   = $anyseq;
  `ifndef FV_COVER64
    assign d_st    = $anyseq;
    assign d_fac   = $anyseq;
    assign d_hr    = $anyseq;
    assign d_since = $anyseq;
  `else
    assign d_st    = EOG_ST_VALID;
    assign d_fac   = 1'b0;
    assign d_hr    = 1'b0;
    assign d_since = 8'd0;
  `endif
    always_comb begin
        in_data                          = '0;
        in_data[EOG_BF_REC_NO +: RW]     = f_in_cnt;
        in_data[EOG_BF_STATUS +: 3]      = d_st;
        in_data[EOG_BF_FAC +: 5]         = {4'd0, d_fac};
        in_data[EOG_BF_HIST_RESET]       = d_hr;
        in_data[EOG_BF_PUMP_RUN]         = d_run;
        in_data[EOG_BF_SINCE_RESET +: 8] = d_since;
    end
 `endif
`endif

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
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    eog_fv_axis #(.W(EOG_BF_W), .ASSUME(1)) u_in (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(in_valid), .ready(in_ready), .data(in_data));
    eog_fv_axis #(.W(EOG_BM_W), .ASSUME(0)) u_out (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(out_valid), .ready(out_ready), .data(out_data));

    logic [7:0] f_in_flight;
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
    function automatic logic good(input logic [2:0] st);   // VALID or HELD: the only codes that update state
        good = (st == EOG_ST_VALID) || (st == EOG_ST_HELD);
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
    // element c (0..4) of five packed 16-bit values, element 0 in the low bits (a mux, not a variable part-select:
    // those put x bits into the AIG that the abc engines refuse)
    function automatic logic [15:0] pick5(input logic [79:0] v, input logic [2:0] c);
        case (c)
            3'd0:    pick5 = v[15:0];
            3'd1:    pick5 = v[31:16];
            3'd2:    pick5 = v[47:32];
            3'd3:    pick5 = v[63:48];
            default: pick5 = v[79:64];
        endcase
    endfunction

    // ---------------------------------------------------------------------------------------------------------
    // Input environment. Every STATUS code may arrive (2 and 5..7 are never produced, but #44 defines them: a
    // HIST_RESET clears the slot, nothing updates it, outputs 0). FAC may be >= N_FAC (#1), HIST_RESET may come
    // with any status, the channels take any int16. One upstream contract is assumed: eog_features gives channels
    // only to VALID/HELD records (numerics.md §4 "INVALID/DROPPED -> 0", conventions §3), so FEAT0_11 = 0 on every
    // other record. (Without it FEAT[0..11] of such a record would be ambiguous: the module spec says "copied",
    // numerics.md §5 "all 0 for INVALID/DROPPED"; with it both readings agree.)
    always_comb if (in_valid && !good(in_data[EOG_BF_STATUS +: 3]))
        A_feat0: assume (in_data[EOG_BF_FEAT0_11 +: EOG_BF_FEAT0_11_W] == '0);

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
    logic       h_vh, h_upd, h_hr, h_run;
    logic [4:0] h_fac;
    assign h_st  = h[EOG_BF_STATUS +: 3];
    assign h_fac = h[EOG_BF_FAC +: EOG_BF_FAC_W];
    assign h_vh  = good(h_st);
    assign h_upd = h_vh && (h_fac < FV_N_FAC);
    assign h_hr  = h[EOG_BF_HIST_RESET];
    assign h_run = h[EOG_BF_PUMP_RUN];

    logic chk;   // an output is presented and the properties apply
    assign chk = f_past_valid && rst_n && out_valid;

    // ---------------------------------------------------------------------------------------------------------
    // Port-only properties (every task)
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
        // Copies: FEAT[0..11] = FEAT0_11 for a VALID/HELD record of a real slot, 0 for every other status (A_feat0:
        // both spec readings agree); RULES4, INFLOW, LEVEL for every record. FEAT[0..11] of a VALID/HELD record
        // with FAC >= N_FAC is left open (spec question; it cannot occur at N_FAC = 32).
        if (h_upd)
            C_feat:  assert (out_data[EOG_BM_FEAT +: EOG_BF_FEAT0_11_W] == h[EOG_BF_FEAT0_11 +: EOG_BF_FEAT0_11_W]);
        if (!h_vh)
            C_feat0: assert (out_data[EOG_BM_FEAT +: EOG_BF_FEAT0_11_W] == '0);
        C_rules:  assert (out_data[EOG_BM_RULES4 +: EOG_BM_RULES4_W]           == h[EOG_BF_RULES4 +: EOG_BF_RULES4_W]);
        C_inflow: assert (out_data[EOG_BM_INFLOW +: EOG_BM_INFLOW_W]           == h[EOG_BF_INFLOW +: EOG_BF_INFLOW_W]);
        C_level:  assert (out_data[EOG_BM_LEVEL +: EOG_BM_LEVEL_W]             == h[EOG_BF_LEVEL +: EOG_BF_LEVEL_W]);

        // M1 (output part): every status other than VALID/HELD (INVALID, DROPPED, and #44's 2/5..7) ->
        // FEAT[12..30] = 0, with or without HIST_RESET
        if (!h_vh)
            M1_zero: assert (out_data[EOG_BM_FEAT + 16*12 +: 16*19] == '0);
        // Q1 (#1): VALID/HELD with FAC >= N_FAC -> FEAT[12..30] = 0
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
                // a non-running record: nsr >= 1 (also catches an nsr counter that wraps at 255: induction
                // starts from any stored nsr)
                M4_norun: assert (fout(out_data, 28) >= 16'd256);
            end
            if (h_hr) begin
                // a record that starts a new history: state cleared before the update, so this is the first
                // VALID/HELD record: net_ema = FEAT[11] << 8 (#43), FEAT[27] = FEAT[11]
                M3_hr_net: assert (fout(out_data, 27) == fin(h, 11));
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
    // Shadow of slot f_slot (numerics.md §5 v4, written from the spec), updated at acceptance in REC_NO order.
    // last_run is shadowed for all 5 gated channels (plain copies); the two EMAs exactly for the anyconst channel
    // f_chan only (the solver may pick any channel, so every channel is covered, at 1/5 of the arithmetic).
    logic [5*16-1:0] sh_last;
    logic [31:0]     sh_ef, sh_es;          // ema_f[f_chan], ema_s[f_chan]
    logic [31:0]     sh_net;
    logic            sh_hasnet;
    logic [7:0]      sh_nsr;
    logic            sh_has;
    // M2 trackers: min/max of the absorbed inputs of gated channel f_chan, and of net_ema's inputs (#43: from the
    // first VALID/HELD record on; the cleared 0 is not an input)
    logic [15:0]     tr_mn, tr_mx, tr_nmn, tr_nmx;

    logic [2:0] i_st;
    logic       i_clr, i_upd, in_f;
    assign i_st  = in_data[EOG_BF_STATUS +: 3];
    assign i_clr = in_data[EOG_BF_HIST_RESET] && (i_st != EOG_ST_DROPPED);   // clears first (any non-DROPPED)
    assign i_upd = good(i_st);                                              // only VALID/HELD update
    assign in_f  = in_fire && (in_data[EOG_BF_FAC +: 5] == f_slot) && (i_clr || i_upd);

    logic [5*16-1:0] xg_in;   // x_g[0..4] of the input record, x_g[0] in the low bits
    logic [15:0]     xj_in;   // x_g[f_chan]
    assign xg_in = {fin(in_data, 6), fin(in_data, 5), fin(in_data, 3), fin(in_data, 2), fin(in_data, 1)};
    assign xj_in = pick5(xg_in, f_chan);

    logic [5*16-1:0] n_last;
    logic [31:0]     n_ef, n_es, n_net;
    logic            n_hasnet, n_has;
    logic [7:0]      n_nsr;
    logic            n_first;     // the record is the slot's first running record since the last reset
    logic            n_netfirst;  // the record is the slot's first VALID/HELD record since the last reset
    logic [15:0]     n_mn, n_mx, n_nmn, n_nmx;

    always_comb begin : shadow_next
        logic signed [31:0] d, q;
        logic [31:0] xs;
        logic [15:0] x11;
        logic        run;
        run = in_data[EOG_BF_PUMP_RUN];
        d = '0; q = '0; xs = '0; x11 = '0;   // no latches for the block temporaries
        n_last = sh_last; n_ef = sh_ef; n_es = sh_es; n_net = sh_net; n_hasnet = sh_hasnet;
        n_nsr = sh_nsr; n_has = sh_has;
        n_mn = tr_mn; n_mx = tr_mx; n_nmn = tr_nmn; n_nmx = tr_nmx;
        if (i_clr) begin   // HIST_RESET on a non-DROPPED record clears the slot before the update
            n_last = '0; n_ef = '0; n_es = '0; n_net = '0; n_hasnet = 1'b0; n_nsr = '0; n_has = 1'b0;
            n_mn = '0; n_mx = '0; n_nmn = '0; n_nmx = '0;
        end
        n_first    = i_upd && run && !n_has;
        n_netfirst = i_upd && !n_hasnet;
        if (i_upd) begin
            if (run) begin
                xs = sh8(xj_in);
                if (!n_has) begin
                    n_ef = xs;
                    n_es = xs;
                    n_mn = xj_in;
                    n_mx = xj_in;
                end else begin
                    d    = $signed(xs) - $signed(n_ef);
                    q    = d >>> EOG_EMA_FAST;
                    n_ef = n_ef + q;
                    d    = $signed(xs) - $signed(n_es);
                    q    = d >>> EOG_EMA_SLOW;
                    n_es = n_es + q;
                    if (slt(xj_in, n_mn)) n_mn = xj_in;
                    if (slt(n_mx, xj_in)) n_mx = xj_in;
                end
                n_last = xg_in;
                n_has  = 1'b1;
                n_nsr  = 8'd0;
            end else begin
                n_nsr = (n_nsr == 8'd255) ? 8'd255 : n_nsr + 8'd1;
            end
            x11 = fin(in_data, 11);
            if (!n_hasnet) begin
                n_net = sh8(x11);
                n_nmn = x11;
                n_nmx = x11;
            end else begin
                d     = $signed(sh8(x11)) - $signed(n_net);
                q     = d >>> EOG_EMA_FAST;
                n_net = n_net + q;
                if (slt(x11, n_nmn)) n_nmn = x11;
                if (slt(n_nmx, x11)) n_nmx = x11;
            end
            n_hasnet = 1'b1;
        end
    end

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            sh_last <= '0; sh_ef <= '0; sh_es <= '0; sh_net <= '0; sh_hasnet <= 1'b0; sh_nsr <= '0; sh_has <= 1'b0;
            tr_mn <= '0; tr_mx <= '0; tr_nmn <= '0; tr_nmx <= '0;
        end else if (in_f) begin
            sh_last <= n_last; sh_ef <= n_ef; sh_es <= n_es; sh_net <= n_net; sh_hasnet <= n_hasnet;
            sh_nsr <= n_nsr; sh_has <= n_has;
            tr_mn <= n_mn; tr_mx <= n_mx; tr_nmn <= n_nmn; tr_nmx <= n_nmx;
        end
    end

    // Harness lemmas: facts about the shadow alone, true by the numerics.md §5 equations. smtbmc keeps every
    // assertion it has proven at earlier steps as a hypothesis, so L_* turn M2 on the DUT into a one-step argument
    // (DUT = shadow by M5, shadow within bounds by L_*).
    function automatic logic in_rng(input logic [31:0] v, input logic [15:0] lo, input logic [15:0] hi);
        in_rng = !($signed(v) < $signed(sh8(lo))) && !($signed(sh8(hi)) < $signed(v));
    endfunction
    always_comb if (f_past_valid && rst_n) begin
        if (sh_has) begin
            L_last: assert (!slt(pick5(sh_last, f_chan), tr_mn) && !slt(tr_mx, pick5(sh_last, f_chan)));
`ifdef FV_ARITH
            L_ef:   assert (in_rng(sh_ef, tr_mn, tr_mx));
            L_es:   assert (in_rng(sh_es, tr_mn, tr_mx));
`endif
        end else begin
            L_clr:  assert (sh_last == '0 && tr_mn == '0 && tr_mx == '0);
`ifdef FV_ARITH
            L_clre: assert (sh_ef == '0 && sh_es == '0);
`endif
        end
`ifdef FV_ARITH
        if (sh_hasnet) L_net:  assert (in_rng(sh_net, tr_nmn, tr_nmx));
        else           L_net0: assert (sh_net == '0 && tr_nmn == '0 && tr_nmx == '0);
`endif
    end

    // Expected outputs and bounds travel with the record through the same 2-entry queue:
    //   [159:80] last_run[0..4], [79:64] ema_f[f_chan] >>> 8, [63:48] ema_s[f_chan] >>> 8,
    //   [47:32] net_ema >>> 8, [31:16] min(nsr, 64) << 8, [15:0] has_run ? 16384 : 0
    localparam integer XW = 160;
    logic [XW-1:0] n_exp, q_exp0, q_exp1, h_exp;
    assign n_exp = {n_last, n_ef[8 +: 16], n_es[8 +: 16], n_net[8 +: 16], cap64(n_nsr), n_has ? 16'd16384 : 16'd0};
    logic [63:0] q_bnd0, q_bnd1, h_bnd;   // {min, max} of channel f_chan's inputs, {min, max} of net_ema's
    logic [2:0]  q_flg0, q_flg1, h_flg;   // {has_run, first running record, first VALID/HELD record}
    always_ff @(posedge clk) if (in_fire) begin
        if (f_in_cnt[0]) begin
            q_exp1 <= n_exp; q_bnd1 <= {n_mn, n_mx, n_nmn, n_nmx}; q_flg1 <= {n_has, n_first, n_netfirst};
        end else begin
            q_exp0 <= n_exp; q_bnd0 <= {n_mn, n_mx, n_nmn, n_nmx}; q_flg0 <= {n_has, n_first, n_netfirst};
        end
    end
    assign h_exp = (f_in_flight == 8'd0) ? n_exp : (f_out_cnt[0] ? q_exp1 : q_exp0);
    assign h_bnd = (f_in_flight == 8'd0) ? {n_mn, n_mx, n_nmn, n_nmx} : (f_out_cnt[0] ? q_bnd1 : q_bnd0);
    assign h_flg = (f_in_flight == 8'd0) ? {n_has, n_first, n_netfirst} : (f_out_cnt[0] ? q_flg1 : q_flg0);

    logic h_f;   // the current output is a VALID/HELD record of slot f_slot
    assign h_f = h_upd && (h_fac == f_slot);

    // outputs of channel f_chan
    logic [15:0] o_last_c, o_ef_c, o_es_c;
    assign o_last_c = pick5(out_data[EOG_BM_FEAT + 16*12 +: 80], f_chan);
    assign o_ef_c   = pick5(out_data[EOG_BM_FEAT + 16*17 +: 80], f_chan);
    assign o_es_c   = pick5(out_data[EOG_BM_FEAT + 16*22 +: 80], f_chan);

    always_comb if (chk && h_f) begin
        // M2 (cleared state): no running record since the last reset -> FEAT[12..26] still 0
        if (!h_flg[2])
            M2_norun: assert (out_data[EOG_BM_FEAT + 16*12 +: 16*15] == '0);
        // M3: first running record after a reset (rst_n, or HIST_RESET on any non-DROPPED record, also INVALID),
        // after any number of idle records: FEAT[17+i] == FEAT[22+i] == FEAT[g_i] for all 5 channels (ok_hr_*),
        // FEAT[29] = 16384
        if (h_flg[1])
            M3_first: assert (ok_hr_f == 5'b11111 && ok_hr_s == 5'b11111 && fout(out_data, 29) == 16'd16384);
        // M3 (#43): first VALID/HELD record after a reset: net_ema = FEAT[11] << 8, so FEAT[27] = FEAT[11]
        if (h_flg[0])
            M3_net0:  assert (fout(out_data, 27) == fin(h, 11));
        // Exact state of slot f_slot. Because the shadow absorbs only f_slot's own records (VALID/HELD update,
        // non-DROPPED HIST_RESET clears), these also prove M1 "DROPPED changes no state, INVALID changes state only
        // by its HIST_RESET, FAC >= N_FAC touches nothing" and M6 slot independence.
        M5_last:  assert (out_data[EOG_BM_FEAT + 16*12 +: 80] == h_exp[80 +: 80]);
        M4_nsr:   assert (fout(out_data, 28) == h_exp[16 +: 16]);   // harness nsr counter
        M5_has:   assert (fout(out_data, 29) == h_exp[0 +: 16]);
        // M2: each average within the min/max of the inputs absorbed since the last reset
        if (h_flg[2])
            M2_last: assert (!slt(o_last_c, h_bnd[48 +: 16]) && !slt(h_bnd[32 +: 16], o_last_c));
`ifdef FV_ARITH
        // M5: exact update equations of numerics.md §5 (EMAs of channel f_chan, net_ema)
        M5_emaf:  assert (o_ef_c == h_exp[64 +: 16]);
        M5_emas:  assert (o_es_c == h_exp[48 +: 16]);
        M5_net:   assert (fout(out_data, 27) == h_exp[32 +: 16]);
        if (h_flg[2]) begin
            M2_emaf: assert (!slt(o_ef_c, h_bnd[48 +: 16]) && !slt(h_bnd[32 +: 16], o_ef_c));
            M2_emas: assert (!slt(o_es_c, h_bnd[48 +: 16]) && !slt(h_bnd[32 +: 16], o_es_c));
        end
        M2_net:   assert (!slt(fout(out_data, 27), h_bnd[16 +: 16]) && !slt(h_bnd[0 +: 16], fout(out_data, 27)));
`endif
    end
`endif

    // ---------------------------------------------------------------------------------------------------------
    // Cover (port-only). Per real slot (indexing by h_fac[0] assumes FV_N_FAC = 2): FEAT[28], FEAT[29] of its last
    // VALID/HELD output, whether it had one, and whether a non-DROPPED HIST_RESET record came out since.
    logic [15:0] c_prev28_0, c_prev28_1, c_prev29_0, c_prev29_1;
    logic [FV_N_FAC-1:0] c_seen, c_clr;
    initial begin
        c_seen = '0;
        c_clr  = '0;
    end
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            c_seen <= '0;
            c_clr  <= '0;
        end else if (out_fire && h_upd) begin
            if (h_fac[0]) begin c_prev28_1 <= fout(out_data, 28); c_prev29_1 <= fout(out_data, 29); end
            else          begin c_prev28_0 <= fout(out_data, 28); c_prev29_0 <= fout(out_data, 29); end
            if (h_fac[0]) begin c_seen[1] <= 1'b1; c_clr[1] <= 1'b0; end
            else          begin c_seen[0] <= 1'b1; c_clr[0] <= 1'b0; end
        end else if (out_fire && !h_vh && h_hr && h_st != EOG_ST_DROPPED && h_fac < FV_N_FAC) begin
            if (h_fac[0]) c_clr[1] <= 1'b1; else c_clr[0] <= 1'b1;
        end
    end
    logic [15:0] c_p28, c_p29;   // previous VALID/HELD output of the current output's slot
    logic        c_pseen, c_pclr;
    assign c_p28   = h_fac[0] ? c_prev28_1 : c_prev28_0;
    assign c_p29   = h_fac[0] ? c_prev29_1 : c_prev29_0;
    assign c_pseen = h_fac[0] ? c_seen[1] : c_seen[0];
    assign c_pclr  = h_fac[0] ? c_clr[1] : c_clr[0];

`ifdef FV_COVER
    logic c_bp;   // an output was held under back-pressure
    initial c_bp = 1'b0;
    always_ff @(posedge clk) if (!rst_n) c_bp <= 1'b0; else if (out_valid && !out_ready) c_bp <= 1'b1;
    always_ff @(posedge clk) if (f_past_valid && rst_n && out_fire) begin
        cv_first_run: cover (h_upd && h_hr && h_run);
        cv_ema:       cover (h_upd && !h_hr && h_run && c_pseen && c_p29 == 16'd16384 &&
                             fout(out_data, 17) != fout(out_data, 1));
        cv_idle_run:  cover (h_upd && !h_hr && h_run && c_pseen && c_p29 == 16'd0);
        cv_invalid:   cover (h_st == EOG_ST_INVALID && c_seen[0]);
        cv_dropped:   cover (h_st == EOG_ST_DROPPED);
        cv_fac_oob:   cover (h_vh && h_fac >= FV_N_FAC);
        cv_two_slots: cover (h_upd && c_seen == {FV_N_FAC{1'b1}});
        cv_bp:        cover (c_bp && f_out_cnt >= 8'd2);
        // #44 / M1: an INVALID (or other non-DROPPED) HIST_RESET record cleared a slot that had run: its next
        // VALID/HELD record (no HIST_RESET of its own) shows has_run = 0
        cv_inv_clear: cover (h_upd && !h_hr && !h_run && c_pseen && c_pclr && c_p29 == 16'd16384 &&
                             fout(out_data, 29) == 16'd0);
    end
`endif

`ifdef FV_COVER64
    // spec cover: a slot that has run, stopped 64+ records, and run again (no reset in between)
    always_ff @(posedge clk) if (f_past_valid && rst_n && out_fire)
        cv_rerun64: cover (h_upd && !h_hr && h_run && c_pseen &&
                           c_p28 == 16'd16384 && c_p29 == 16'd16384);
`endif
endmodule

`default_nettype wire
