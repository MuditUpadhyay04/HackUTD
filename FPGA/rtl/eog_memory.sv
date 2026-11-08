// eog_memory.sv -- the 19 per-facility memory features (spec v2: modules/eog_memory.md, numerics.md section 5,
// conventions section 7 formal observation ports).
//
// Bus F in, bus M out. One record at a time:
//   S_SWEEP  after reset: clears one state slot per cycle (N_FAC cycles), in_ready = 0
//   S_IDLE   in_ready = 1; an accepted record is captured into in_r
//   S_CALC   reads the record's slot (in_r FAC), computes the new state and the 19 features, writes the slot
//   S_OUT    out_valid = 1 until out_ready
// Latency 2 cycles (accept -> out_valid), II 3 cycles with out_ready = 1.
//
// Per-slot state (packed, one word per facility; a single write port and one async read port, so Vivado can map
// it to distributed RAM):
//   last_run[5] s16, ema_f[5] s24, ema_s[5] s24, net_ema s24, nsr u8, has_run 1   (353 bits)
// The averages are kept in 24 bits: every average is a convex step between its old value and an input x << 8
// (x s16), so it never leaves the s24 range of x << 8 (numerics.md section 5); the 25-bit intermediate sum is
// therefore exact when truncated to 24 bits, for every 24-bit state.
//
// Only VALID/HELD records with FAC < N_FAC read-modify-write their slot (HIST_RESET clears it first). All other
// records (INVALID, DROPPED, any other status code) touch no state and get FEAT[12..30] = 0.

module eog_memory #(
    parameter integer N_FAC = 32,
    parameter integer II    = 16
) (
    input  logic                clk,
    input  logic                rst_n,
    input  logic                in_valid,
    output logic                in_ready,
    input  logic [343-1:0]      in_data,      // bus F (EOG_BF_W)
    output logic                out_valid,
    input  logic                out_ready,
    output logic [646-1:0]      out_data      // bus M (EOG_BM_W)
`ifdef FORMAL
    , output logic [7:0]        f_inflight      // records accepted on in_* whose output has not yet transferred
    , output logic [31:0]       f_oldest_recno  // REC_NO of the oldest such record; don't-care when f_inflight == 0
`endif
);
    // the shared header defines constants for every module; most are unused here
    /* verilator lint_off UNUSEDPARAM */
    `include "eog_defs.svh"
    /* verilator lint_on UNUSEDPARAM */

    // ---------------------------------------------------------------------------------------------------
    // sizes
    localparam integer FW  = (N_FAC > 1) ? $clog2(N_FAC) : 1;   // slot index width
    localparam integer NFL = N_FAC - 1;                           // last slot index
    localparam integer NG  = 5;                                   // gated channels
    localparam integer EW  = 24;                                  // average width (s24 = s16 << 8)

    // gated channels g = (1, 2, 3, 5, 6), 4 bits each, entry i at [4i+3:4i]
    localparam logic [4*NG-1:0] GCH = {4'd6, 4'd5, 4'd3, 4'd2, 4'd1};

    // state word layout
    localparam integer O_LR  = 0;                    // last_run[i] at O_LR  + 16i
    localparam integer O_EF  = O_LR + 16 * NG;       // ema_f[i]    at O_EF  + EW*i
    localparam integer O_ES  = O_EF + EW * NG;       // ema_s[i]    at O_ES  + EW*i
    localparam integer O_NET = O_ES + EW * NG;       // net_ema
    localparam integer O_NSR = O_NET + EW;           // nsr (u8)
    localparam integer O_HR  = O_NSR + 8;            // has_run
    localparam integer SW    = O_HR + 1;             // 353

    // the 19 memory features, FEAT[12 + j] at [16j+15:16j]
    localparam integer MF    = EOG_N_FEAT - 12;      // 19
    localparam integer MFW   = 16 * MF;              // 304

    localparam logic [1:0] S_SWEEP = 2'd0, S_IDLE = 2'd1, S_CALC = 2'd2, S_OUT = 2'd3;

    // ---------------------------------------------------------------------------------------------------
    // control and registers
    logic [1:0]          st;
    logic [FW-1:0]       sw_idx;
    logic [EOG_BF_W-1:0] in_r;
    logic [MFW-1:0]      mf_r;

    logic [SW-1:0]       mem [N_FAC];

    assign in_ready  = (st == S_IDLE);
    assign out_valid = (st == S_OUT);

    // ---------------------------------------------------------------------------------------------------
    // fields of the held record
    logic [EOG_BF_STATUS_W-1:0] r_status;
    logic [EOG_BF_FAC_W-1:0]    r_fac;
    logic                       r_hist, r_run;
    logic [EOG_BF_SINCE_RESET_W-1:0] r_since;
    logic [15:0]                r_f11;
    logic                       fac_ok, upd;
    logic [FW-1:0]              slot;

    assign r_status = in_r[EOG_BF_STATUS +: EOG_BF_STATUS_W];
    assign r_fac    = in_r[EOG_BF_FAC +: EOG_BF_FAC_W];
    assign r_hist   = in_r[EOG_BF_HIST_RESET];
    assign r_run    = in_r[EOG_BF_PUMP_RUN];
    assign r_since  = in_r[EOG_BF_SINCE_RESET +: EOG_BF_SINCE_RESET_W];
    assign r_f11    = in_r[EOG_BF_FEAT0_11 + 16 * 11 +: 16];

    assign fac_ok = ({1'b0, r_fac} < N_FAC[EOG_BF_FAC_W:0]);
    assign upd    = fac_ok && ((r_status == EOG_ST_VALID) || (r_status == EOG_ST_HELD));
    assign slot   = r_fac[FW-1:0];

    // ---------------------------------------------------------------------------------------------------
    // state read (async) and HIST_RESET clear-before-update
    logic [SW-1:0] s_rd, s_old, s_new;
    assign s_rd  = mem[slot];
    assign s_old = r_hist ? {SW{1'b0}} : s_rd;

    logic       o_hr, n_hr;
    logic [7:0] o_nsr, n_nsr;
    assign o_hr  = s_old[O_HR];
    assign o_nsr = s_old[O_NSR +: 8];
    assign n_hr  = o_hr | r_run;
    assign n_nsr = r_run ? 8'd0 : ((o_nsr == 8'hFF) ? 8'hFF : o_nsr + 8'd1);

    // net_ema += ((FEAT[11] << 8) - net_ema) >>> 3, on every updating record
    // Every operand below is a signed wire of the same width, so the arithmetic is signed and >>> is arithmetic
    // (a concatenation or other unsigned operand would make the whole expression unsigned).
    logic signed [EW-1:0] o_net, n_net, t_net;
    logic signed [EW:0]   o_net_x, t_net_x, d_net, q_net;
    // bit EW of a convex step is a sign copy (the result stays in s24, see header): dropped on purpose
    /* verilator lint_off UNUSEDSIGNAL */
    logic signed [EW:0]   s_net;
    /* verilator lint_on UNUSEDSIGNAL */
    assign o_net   = s_old[O_NET +: EW];
    assign t_net   = {r_f11, 8'd0};
    assign o_net_x = {o_net[EW-1], o_net};         // sign-extend (standalone assign: bit pattern only)
    assign t_net_x = {t_net[EW-1], t_net};
    assign d_net   = t_net_x - o_net_x;            // exact in s25
    assign q_net   = d_net >>> EOG_EMA_FAST;
    assign s_net   = o_net_x + q_net;
    assign n_net   = s_net[EW-1:0];

    logic [16*NG-1:0] n_lr;
    logic [EW*NG-1:0] n_ef, n_es;

    genvar gi;
    generate
        for (gi = 0; gi < NG; gi = gi + 1) begin : g_ch
            localparam integer C = {28'd0, GCH[4*gi +: 4]};
            logic        [15:0]   x;
            logic signed [EW-1:0] t, o_ef, o_es, u_ef, u_es;
            logic signed [EW:0]   t_x, o_ef_x, o_es_x, d_ef, d_es, q_ef, q_es;
            // bit EW of a convex step is a sign copy (the result stays in s24, see header): dropped on purpose
            /* verilator lint_off UNUSEDSIGNAL */
            logic signed [EW:0]   a_ef, a_es;
            /* verilator lint_on UNUSEDSIGNAL */

            assign x    = in_r[EOG_BF_FEAT0_11 + 16 * C +: 16];
            assign t    = {x, 8'd0};
            assign o_ef = s_old[O_EF + EW * gi +: EW];
            assign o_es = s_old[O_ES + EW * gi +: EW];
            assign t_x    = {t[EW-1], t};              // sign-extend (see net_ema)
            assign o_ef_x = {o_ef[EW-1], o_ef};
            assign o_es_x = {o_es[EW-1], o_es};
            assign d_ef   = t_x - o_ef_x;              // exact in s25
            assign d_es   = t_x - o_es_x;
            assign q_ef   = d_ef >>> EOG_EMA_FAST;
            assign q_es   = d_es >>> EOG_EMA_SLOW;
            assign a_ef   = o_ef_x + q_ef;
            assign a_es   = o_es_x + q_es;
            // first running record of a history: both averages start at x << 8
            assign u_ef = o_hr ? a_ef[EW-1:0] : t;
            assign u_es = o_hr ? a_es[EW-1:0] : t;

            assign n_lr[16 * gi +: 16] = r_run ? x    : s_old[O_LR + 16 * gi +: 16];
            assign n_ef[EW * gi +: EW] = r_run ? u_ef : o_ef;
            assign n_es[EW * gi +: EW] = r_run ? u_es : o_es;
        end
    endgenerate

    // layout O_LR .. O_HR is contiguous, LSB first
    assign s_new = {n_hr, n_nsr, n_net, n_es, n_ef, n_lr};

    // ---------------------------------------------------------------------------------------------------
    // the 19 features (after the update)
    logic [15:0] f_nsr, f_since;
    assign f_nsr   = (n_nsr   >= 8'd64) ? 16'h4000 : {2'b00, n_nsr[5:0],   8'd0};
    assign f_since = (r_since >= 8'd64) ? 16'h4000 : {2'b00, r_since[5:0], 8'd0};

    logic [MFW-1:0] mf_new;
    genvar mi;
    generate
        for (mi = 0; mi < NG; mi = mi + 1) begin : g_mf
            assign mf_new[16 * (0  + mi) +: 16] = n_lr[16 * mi +: 16];      // FEAT[12+i] last_run
            assign mf_new[16 * (5  + mi) +: 16] = n_ef[EW * mi + 8 +: 16];  // FEAT[17+i] ema_f >>> 8
            assign mf_new[16 * (10 + mi) +: 16] = n_es[EW * mi + 8 +: 16];  // FEAT[22+i] ema_s >>> 8
        end
    endgenerate
    assign mf_new[16 * 15 +: 16] = n_net[EW-1:8];                           // FEAT[27] net_ema >>> 8
    assign mf_new[16 * 16 +: 16] = f_nsr;                                   // FEAT[28]
    assign mf_new[16 * 17 +: 16] = n_hr ? 16'h4000 : 16'h0000;              // FEAT[29]
    assign mf_new[16 * 18 +: 16] = f_since;                                 // FEAT[30]

    // ---------------------------------------------------------------------------------------------------
    // FSM
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            st     <= S_SWEEP;
            sw_idx <= '0;
        end else begin
            case (st)
                S_SWEEP: begin
                    if (sw_idx == NFL[FW-1:0]) st <= S_IDLE;
                    else                       sw_idx <= sw_idx + 1'b1;
                end
                S_IDLE: if (in_valid) begin
                    in_r <= in_data;
                    st   <= S_CALC;
                end
                S_CALC: begin
                    mf_r <= upd ? mf_new : {MFW{1'b0}};
                    st   <= S_OUT;
                end
                default: if (out_ready) st <= S_IDLE;     // S_OUT
            endcase
        end
    end

    // state RAM: one write port (sweep clear or the record's update), no reset (RAM-inferable)
    logic          we;
    logic [FW-1:0] wa;
    logic [SW-1:0] wd;
    assign we = rst_n && ((st == S_SWEEP) || ((st == S_CALC) && upd));
    assign wa = (st == S_SWEEP) ? sw_idx : slot;
    assign wd = (st == S_SWEEP) ? {SW{1'b0}} : s_new;

    always_ff @(posedge clk) begin
        if (we) mem[wa] <= wd;
    end

    // ---------------------------------------------------------------------------------------------------
    // bus M
    // (the fields below cover all EOG_BM_W bits)
    assign out_data[EOG_BM_REC_NO      +: EOG_BM_REC_NO_W]      = in_r[EOG_BF_REC_NO      +: EOG_BF_REC_NO_W];
    assign out_data[EOG_BM_IN_LAST     +: EOG_BM_IN_LAST_W]     = in_r[EOG_BF_IN_LAST     +: EOG_BF_IN_LAST_W];
    assign out_data[EOG_BM_FAC_RAW     +: EOG_BM_FAC_RAW_W]     = in_r[EOG_BF_FAC_RAW     +: EOG_BF_FAC_RAW_W];
    assign out_data[EOG_BM_FAC         +: EOG_BM_FAC_W]         = in_r[EOG_BF_FAC         +: EOG_BF_FAC_W];
    assign out_data[EOG_BM_TS          +: EOG_BM_TS_W]          = in_r[EOG_BF_TS          +: EOG_BF_TS_W];
    assign out_data[EOG_BM_STATUS      +: EOG_BM_STATUS_W]      = in_r[EOG_BF_STATUS      +: EOG_BF_STATUS_W];
    assign out_data[EOG_BM_REASON      +: EOG_BM_REASON_W]      = in_r[EOG_BF_REASON      +: EOG_BF_REASON_W];
    assign out_data[EOG_BM_SINCE_RESET +: EOG_BM_SINCE_RESET_W] = in_r[EOG_BF_SINCE_RESET +: EOG_BF_SINCE_RESET_W];
    assign out_data[EOG_BM_HIST_RESET  +: EOG_BM_HIST_RESET_W]  = in_r[EOG_BF_HIST_RESET  +: EOG_BF_HIST_RESET_W];
    assign out_data[EOG_BM_FEAT        +: EOG_BF_FEAT0_11_W]    = in_r[EOG_BF_FEAT0_11    +: EOG_BF_FEAT0_11_W];
    assign out_data[EOG_BM_FEAT + EOG_BF_FEAT0_11_W +: MFW]     = mf_r;
    assign out_data[EOG_BM_RULES4      +: EOG_BM_RULES4_W]      = in_r[EOG_BF_RULES4      +: EOG_BF_RULES4_W];
    assign out_data[EOG_BM_INFLOW      +: EOG_BM_INFLOW_W]      = in_r[EOG_BF_INFLOW      +: EOG_BF_INFLOW_W];
    assign out_data[EOG_BM_LEVEL       +: EOG_BM_LEVEL_W]       = in_r[EOG_BF_LEVEL       +: EOG_BF_LEVEL_W];

    // II is the spec's upper bound on cycles per record; this design needs 3, so it is unused here.
    logic unused_ii;
    assign unused_ii = (II == 0);

`ifdef FORMAL
    // ---- conventions section 7 observation ports: one record at a time, held in in_r from accept to transfer ----
    assign f_inflight     = (st == S_CALC || st == S_OUT) ? 8'd1 : 8'd0;
    assign f_oldest_recno = in_r[EOG_BF_REC_NO +: EOG_BF_REC_NO_W];

    // ---- internal invariants (own state only; help k-induction) ----
    // sweep index stays in range (matters for non-power-of-two N_FAC)
    always_comb if (rst_n && st == S_SWEEP) fi_sweep: assert (sw_idx <= NFL[FW-1:0]);
    // a record with no state access presents FEAT[12..30] = 0
    always_comb if (rst_n && st == S_OUT && !upd) fi_zero: assert (mf_r == {MFW{1'b0}});
    // every cleared-or-updated slot: before its first running record, last_run and both averages are 0
    genvar fs;
    generate
        for (fs = 0; fs < N_FAC; fs = fs + 1) begin : g_fslot
            logic [SW-1:0] w;
            assign w = mem[fs];
            always_comb
                if (rst_n && (st != S_SWEEP || fs < sw_idx) && !w[O_HR])
                    assert (w[O_LR +: O_NET - O_LR] == {(O_NET - O_LR){1'b0}});  // unlabeled: one per slot
        end
    endgenerate
`endif
endmodule
