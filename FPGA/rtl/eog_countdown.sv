// eog_countdown.sv -- minutes to tank shutdown, p10 / p50 / p90 (spec v4: modules/eog_countdown.md, numerics.md
// section 7, decisions D1, D2, D4, D6 = Mudit's features_int.py `review_r1r2`; conventions section 7 formal
// observation ports).
//
// Bus M in, bus C out. Header, FEAT and RULES[3:0] pass through; RULES[4] = NOT_FILLING; CD = {p90, p50, p10}.
//
// Numerics (numerics.md section 7 with TASKS.md rulings 20, 21, 33, 34; = Mudit's features_int.py @ 8e67750):
//   - per slot: a ring of 2^CD_LOG2 (16) values x = max(INFLOW, 0) (ruling 20), a "has ring" bit, a write pointer.
//   - a non-DROPPED HIST_RESET record (FAC < N_FAC) clears "has ring" first (even if INVALID; ruling 34: also the
//     never-produced codes 2/5/6/7).
//   - a VALID/HELD record (FAC < N_FAC) then fills the whole ring with its x if "has ring" is 0 (and sets it),
//     otherwise replaces the oldest entry. sum, mean = sum >>> CD_LOG2, max, min over the ring after that.
//     LEVEL >= SHUT_LVL (s16 vs zero-extended u16): CD = 0 and NOT_FILLING = 0 (ruling 21). Otherwise
//     NOT_FILLING = (mean <= 0) and, with delta = SHUT_LVL - LEVEL and K = K_CD: p10 = m(max), p50 = m(mean),
//     p90 = m(min), m(q) = q <= 0 ? 0xFFFF : min((K*delta) // (q << 8), 0xFFFF).
//   - every other record (INVALID, DROPPED, unused codes 2/5/6/7, FAC >= N_FAC): CD = 3 x 0xFFFF, NOT_FILLING = 0,
//     ring untouched (spec question 1: FAC >= N_FAC never touches state).
//   - K * delta is kept in full (32 x 17 bits, so every 32-bit K_CD is exact): a product >= 2^48 can only give a
//     quotient >= 2^25 (q << 8 < 2^23), so it reads 0xFFFF without dividing. Ingest keeps K_CD < 2^24 (product
//     < 2^41), where this never triggers.
//
// Structure. One record at a time can't meet II <= 16: eog_div (NW 48) alone takes 49 cycles. So a serial front end
// owns the per-facility state, a fixed-latency arithmetic pipeline (one eog_mul, one eog_div) follows, and a P-entry
// FIFO holds each record from accept until its output transfers:
//
//   cycle t        accept: read the slot (in_data.FAC; cfg_fac = in_data.FAC, so SHUT_LVL and K_CD are sampled
//                  in the accept cycle), fill or push, write the slot back, load the ring into a reduction
//                  register, store the record's bus-C fields in the FIFO entry `tail`.
//   t+1 .. t+R     in-place tree reduction to {min, max, sum} (R = CD_LOG2 levels); K*delta (eog_mul, LAT 2).
//   t+I0           the record's flags {nf, tripped, q<=0 / overflow per value} go into its FIFO entry;
//   t+I0 .. +2     three divisions issued to eog_div on consecutive cycles: p10, p50, p90.
//   t+TL           quotients are back (eog_div latency 49); the saturated quotients go into the FIFO entry.
//   t+TL+1         out_valid (if the record is the oldest).
//
// Accepts are spaced F = max(I0 + 2, II - 1) cycles apart on purpose: fewer records in flight. P is the smallest
// FIFO depth whose worst gap between accepts (in_valid = out_ready = 1) is <= II - 1.
//   Defaults (N_FAC 32, II 16, CD_LOG2 4): latency 57 cycles (accept -> out_valid), accept every 15 cycles, P = 4.
//   CD_LOG2 2: latency 55, every 15 cycles, P = 4.
//   II >= latency + 2 (59 at CD_LOG2 4, 57 at CD_LOG2 2): P = 1, one record at a time (accept, compute, output).
// Requires II - 1 >= I0 + 2 (7 at CD_LOG2 4, 5 at CD_LOG2 2).
//
// Every multiply goes through eog_mul and the divide through eog_div (NW 48, DW 32). The divider's out_valid / tag
// are not used: result timing comes from this module's own token shift register (eog_div's latency is exactly
// NW + 1), and every forced value (0 when tripped, 0xFFFF when q <= 0 or overflow, the !upd override, NOT_FILLING)
// comes from this module's own state. Only the finite quotient values come from the divider.
//
// Parameters: N_FAC (1..32), II, CD_LOG2 (>= 1; the spec fixes 4 = EOG_CD_LOG2, formal may use 2).

module eog_countdown #(
    parameter integer N_FAC   = 32,
    parameter integer II      = 16,
    parameter integer CD_LOG2 = 4
) (
    input  logic          clk,
    input  logic          rst_n,
    // bus M in
    input  logic          in_valid,
    output logic          in_ready,
    input  logic [645:0]  in_data,        // EOG_BM_W
    // bus C out
    output logic          out_valid,
    input  logic          out_ready,
    output logic [662:0]  out_data,       // EOG_BC_W
    // Facility CONFIG row of in_data.FAC (combinational read); only SHUT_LVL and K_CD are used
    output logic [4:0]    cfg_fac,
    input  logic [511:0]  cfg_row
`ifdef FORMAL
    , output logic [7:0]  f_inflight      // records accepted whose bus-C output has not yet transferred
    , output logic [31:0] f_oldest_recno  // REC_NO of the oldest such record (don't-care when f_inflight == 0)
`endif
);
    `include "eog_defs.svh"

    // ---------------------------------------------------------------------------------------------------------
    // FIFO depth: accepts are at least f cycles apart and a FIFO slot can be reused d cycles after its record was
    // accepted (out_ready = 1), so with P slots the longest gap between accepts is max(f, d - (P-1)*f).
    // Smallest P with d - (P-1)*f <= g.
    function automatic integer fifo_depth(input integer d, input integer f, input integer g);
        integer p, gap, k;
        begin
            p   = 1;
            gap = d;
            for (k = 0; k < 128; k = k + 1) begin
                if (gap > g) begin
                    gap = gap - f;
                    p   = p + 1;
                end
            end
            fifo_depth = p;
        end
    endfunction

    // ---------------------------------------------------------------------------------------------------------
    // sizes
    localparam integer FW   = (N_FAC > 1) ? $clog2(N_FAC) : 1;   // slot index width
    localparam integer CDN  = 1 << CD_LOG2;                       // ring depth (16)
    localparam integer WB   = CD_LOG2;                            // write pointer width
    localparam integer VW   = 16;                                 // ring value: max(INFLOW, 0), kept as s16
    localparam integer SB   = VW + CD_LOG2;                       // ring sum, signed (s20)
    localparam integer RW   = CDN * VW;                           // ring row of one slot
    localparam integer R    = CD_LOG2;                            // reduction levels
    localparam integer EW   = SB + 2 * VW;                        // reduction entry {min, max, sum}
    localparam integer O_MX = SB;                                 // entry: max at [O_MX +: VW]
    localparam integer O_MN = SB + VW;                            // entry: min at [O_MN +: VW]

    localparam integer KW   = EOG_CFG_K_CD_W;                     // K_CD, u32
    localparam integer DLW  = 17;                                 // delta = SHUT_LVL - LEVEL, 1..98303
    localparam integer KDW  = DLW + KW;                           // K * delta (49 bits)
    localparam integer MLAT = 2;                                  // eog_mul latency

    localparam integer DNW  = 48;                                 // eog_div numerator width (spec)
    localparam integer DDW  = 32;                                 // eog_div denominator width (spec)
    localparam integer DLAT = DNW + 1;                            // eog_div LAT = NW + 1 (spec/modules/eog_div.md)

    // schedule, in cycles after the accept cycle t (token ph[j] is set in cycle t+1+j)
    localparam integer I0   = ((R > MLAT) ? R : MLAT) + 1;        // flags + p10 issue (p50 at I0+1, p90 at I0+2)
    localparam integer G    = II - 1;                             // target: worst gap between accepts
    localparam integer F    = (G > I0 + 2) ? G : I0 + 2;          // minimum spacing of accepts
    localparam integer TL   = I0 + DLAT + 2;                      // result written in cycle t+TL
    localparam integer D    = TL + 2;                             // FIFO slot reusable from cycle t+D
    localparam integer PHL  = (TL > F - 1) ? TL : F - 1;          // token shift register length
    localparam integer P    = fifo_depth(D, F, G);                // FIFO depth (max records in flight)
    localparam integer PB   = (P > 1) ? $clog2(P) : 1;            // FIFO pointer width
    localparam integer CB   = $clog2(P + 1);                      // FIFO count width

    localparam integer PAYW = EOG_BC_RULES + EOG_BM_RULES4_W;     // bus C below NOT_FILLING: header, FEAT, RULES4
    localparam integer CDW  = EOG_BC_CD_W;                        // {p90, p50, p10}
    // per-record flags: [0..2] value i reads 0xFFFF (q <= 0 or overflow), [3] tripped, [4] NOT_FILLING
    localparam integer FL_TRIP = 3, FL_NF = 4, FLW = 5;

    // reduction identity: min = 0x7FFF, max = 0x8000, sum = 0
    localparam logic [EW-1:0] IDENT = {16'h7FFF, 16'h8000, {SB{1'b0}}};

    // ---------------------------------------------------------------------------------------------------------
    // input record fields (used in the accept cycle)
    logic [EOG_BM_STATUS_W-1:0] i_status;
    logic [EOG_BM_FAC_W-1:0]    i_fac;
    logic                       i_hist;
    logic [VW-1:0]              i_inflow;
    logic [15:0]                i_level;
    logic                       i_fac_ok, i_upd, i_clr;
    logic [FW-1:0]              i_slot;

    assign i_status = in_data[EOG_BM_STATUS     +: EOG_BM_STATUS_W];
    assign i_fac    = in_data[EOG_BM_FAC        +: EOG_BM_FAC_W];
    assign i_hist   = in_data[EOG_BM_HIST_RESET];
    assign i_inflow = in_data[EOG_BM_INFLOW     +: EOG_BM_INFLOW_W];
    logic [VW-1:0] i_x;                                            // ruling 20: the ring holds max(INFLOW, 0)
    assign i_x      = i_inflow[VW-1] ? {VW{1'b0}} : i_inflow;
    assign i_level  = in_data[EOG_BM_LEVEL      +: EOG_BM_LEVEL_W];

    assign i_fac_ok = ({1'b0, i_fac} < N_FAC[EOG_BM_FAC_W:0]);
    assign i_upd    = i_fac_ok && ((i_status == EOG_ST_VALID) || (i_status == EOG_ST_HELD));
    assign i_clr    = i_fac_ok && i_hist && (i_status != EOG_ST_DROPPED);
    assign i_slot   = i_fac_ok ? i_fac[FW-1:0] : {FW{1'b0}};

    // CONFIG row of the record's slot, read in the accept cycle
    logic [15:0]   c_shut;
    logic [KW-1:0] c_k;
    assign cfg_fac = i_fac;
    assign c_shut  = cfg_row[EOG_CFG_SHUT_LVL +: EOG_CFG_SHUT_LVL_W];
    assign c_k     = cfg_row[EOG_CFG_K_CD     +: EOG_CFG_K_CD_W];

    // D2: tripped = LEVEL >= SHUT_LVL (signed LEVEL, zero-extended SHUT_LVL); else delta = SHUT_LVL - LEVEL >= 1
    logic signed [DLW:0] lvl_x, shut_x, dl_x;
    logic                i_trip;
    assign lvl_x  = {{(DLW + 1 - 16){i_level[15]}}, i_level};
    assign shut_x = {{(DLW + 1 - 16){1'b0}}, c_shut};
    assign dl_x   = shut_x - lvl_x;                               // exact in s18
    assign i_trip = dl_x[DLW] || (dl_x == {(DLW + 1){1'b0}});     // delta <= 0  <=>  LEVEL >= SHUT_LVL

    // ---------------------------------------------------------------------------------------------------------
    // per-slot state: ring rows (one write port, one async read port: distributed RAM; contents are don't-care
    // while "has ring" is 0), "has ring" and write pointer (flops, reset to 0)
    logic [RW-1:0]            ring_mem [N_FAC];
    logic [N_FAC-1:0]         has_st;
    logic [N_FAC*WB-1:0]      wp_st;

    logic [RW-1:0] r_old, r_new;
    logic          s_has_rd, s_has_old;
    logic [WB-1:0] s_wp_rd, s_wp_new;

    assign r_old = ring_mem[i_slot];

    always_comb begin
        s_has_rd = 1'b0;
        s_wp_rd  = {WB{1'b0}};
        for (int f = 0; f < N_FAC; f++) begin
            if (i_slot == FW'(f)) begin
                s_has_rd = has_st[f];
                s_wp_rd  = wp_st[f * WB +: WB];
            end
        end
    end

    // HIST_RESET clears "has ring" before the fill-or-push
    assign s_has_old = s_has_rd && !i_clr;
    assign s_wp_new  = s_has_old ? s_wp_rd + 1'b1 : {WB{1'b0}};   // after a fill, entry 0 is replaced first

    always_comb begin
        r_new = r_old;
        for (int i = 0; i < CDN; i++)
            if (!s_has_old || (s_wp_rd == WB'(i))) r_new[i * VW +: VW] = i_x;
    end

    // ---------------------------------------------------------------------------------------------------------
    // control: FIFO pointers / counts, token shift register
    logic           busy, in_fire, out_fire, done;
    logic [PHL-1:0] ph;             // ph[j]: a record was accepted j+1 cycles ago (one token per record)
    logic [PB-1:0]  head, tail, dptr, fe_idx;
    logic [CB-1:0]  cnt;            // records in the FIFO (accepted, output not yet transferred)
    logic [CB-1:0]  ndone;          // of those, records whose quotients are written (the oldest ndone)

    assign busy      = |ph[F-2:0];
    assign in_ready  = !busy && (cnt != CB'(P));
    assign out_valid = (ndone != {CB{1'b0}});
    assign in_fire   = in_valid && in_ready;
    assign out_fire  = out_valid && out_ready;
    assign done      = ph[TL-1];

    function automatic logic [PB-1:0] ptr_inc(input logic [PB-1:0] p);
        ptr_inc = (p == PB'(P - 1)) ? {PB{1'b0}} : p + 1'b1;
    endfunction

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            ph    <= {PHL{1'b0}};
            head  <= {PB{1'b0}};
            tail  <= {PB{1'b0}};
            dptr  <= {PB{1'b0}};
            cnt   <= {CB{1'b0}};
            ndone <= {CB{1'b0}};
        end else begin
            ph <= {ph[PHL-2:0], in_fire};
            if (in_fire)  tail <= ptr_inc(tail);
            if (done)     dptr <= ptr_inc(dptr);
            if (out_fire) head <= ptr_inc(head);
            cnt   <= cnt   + CB'(in_fire) - CB'(out_fire);
            ndone <= ndone + CB'(done)    - CB'(out_fire);
        end
    end

    // per-slot state write (accept cycle): VALID/HELD fill-or-push; other non-DROPPED HIST_RESET records only clear
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            has_st <= {N_FAC{1'b0}};
            wp_st  <= {(N_FAC * WB){1'b0}};
        end else if (in_fire && (i_upd || i_clr)) begin
            for (int f = 0; f < N_FAC; f++) begin
                if (i_slot == FW'(f)) begin
                    has_st[f] <= i_upd;
                    if (i_upd) wp_st[f * WB +: WB] <= s_wp_new;
                end
            end
        end
    end

    always_ff @(posedge clk) begin
        if (rst_n && in_fire && i_upd) ring_mem[i_slot] <= r_new;
    end

    // ---------------------------------------------------------------------------------------------------------
    // reduction register: loaded at accept with the ring after the fill-or-push, then one tree level per cycle;
    // after R cycles entry 0 holds {min, max, sum} and stays there (every other entry is the identity by then).
    logic [CDN*EW-1:0] win, win_ld, win_nx;

    genvar gi;
    generate
        for (gi = 0; gi < CDN; gi = gi + 1) begin : g_win
            logic signed [VW-1:0] v;
            logic signed [SB-1:0] vx;
            assign v  = r_new[gi * VW +: VW];
            assign vx = SB'(v);                                        // sign-extended
            assign win_ld[gi * EW +: EW] = {v, v, vx};
            if (gi < CDN / 2) begin : g_red
                logic signed [VW-1:0] amx, bmx, amn, bmn, mx, mn;
                logic signed [SB-1:0] as, bs, sm;
                assign amx = win[(2 * gi) * EW + O_MX +: VW];
                assign bmx = win[(2 * gi + 1) * EW + O_MX +: VW];
                assign amn = win[(2 * gi) * EW + O_MN +: VW];
                assign bmn = win[(2 * gi + 1) * EW + O_MN +: VW];
                assign as  = win[(2 * gi) * EW +: SB];
                assign bs  = win[(2 * gi + 1) * EW +: SB];
                assign mx  = (amx >= bmx) ? amx : bmx;
                assign mn  = (amn <= bmn) ? amn : bmn;
                assign sm  = as + bs;                                  // |sum| < 2^(SB-1): exact
                assign win_nx[gi * EW +: EW] = {mn, mx, sm};
            end else begin : g_idle
                assign win_nx[gi * EW +: EW] = IDENT;
            end
        end
    endgenerate

    // front-end registers (stable from the accept until the next accept, which is after the p90 issue)
    logic [DLW-1:0] dl_r;
    logic [KW-1:0]  k_r;
    logic           trip_r;

    always_ff @(posedge clk) begin
        win <= in_fire ? win_ld : win_nx;
        if (in_fire) begin
            dl_r   <= i_trip ? {DLW{1'b0}} : dl_x[DLW-1:0];
            k_r    <= c_k;
            trip_r <= i_trip;
            fe_idx <= tail;
        end
    end

    logic signed [SB-1:0] w_sum, w_mean_x;
    logic signed [VW-1:0] w_max, w_min, w_mean;
    assign w_sum    = win[0 +: SB];
    assign w_max    = win[O_MX +: VW];
    assign w_min    = win[O_MN +: VW];
    assign w_mean_x = w_sum >>> CD_LOG2;                               // floor; within s16 (mean of s16 values)
    assign w_mean   = w_mean_x[VW-1:0];

    // numerator K * delta, valid from cycle t+1+MLAT (inputs held until the next accept)
    logic [KDW-1:0] kd;
    eog_mul #(.AW(DLW), .BW(KW), .A_SIGNED(0), .B_SIGNED(0), .LAT(MLAT)) u_mul_kd (
        .clk(clk), .a(dl_r), .b(k_r), .p(kd));

    logic ov_kd;
    assign ov_kd = |kd[KDW-1:DNW];

    // ---------------------------------------------------------------------------------------------------------
    // flags (cycle t+I0) and divisions: p10 at ph[I0-1] (cycle t+I0), p50 at ph[I0], p90 at ph[I0+1]
    logic           np_max, np_mean, np_min;      // value <= 0
    logic [FLW-1:0] flg_wd;
    assign np_max  = w_max[VW-1]  || (w_max  == {VW{1'b0}});
    assign np_mean = w_mean[VW-1] || (w_mean == {VW{1'b0}});
    assign np_min  = w_min[VW-1]  || (w_min  == {VW{1'b0}});
    assign flg_wd  = {np_mean && !trip_r, trip_r, np_min || ov_kd, np_mean || ov_kd, np_max || ov_kd};  // ruling 21

    logic           is50, is90;
    logic [VW-1:0]  dq_sel;
    logic           dv_in;
    logic [DDW-1:0] dv_d;
    logic           dv_ov;
    logic [DNW-1:0] dv_q;
    logic [DDW-1:0] dv_r;
    logic           dv_to;

    assign is50   = ph[I0];
    assign is90   = ph[I0+1];
    assign dv_in  = ph[I0-1] | is50 | is90;
    assign dq_sel = is50 ? w_mean : (is90 ? w_min : w_max);
    // d = q << 8 for q > 0 (q < 2^15, so d < 2^23); 0 otherwise (that value is forced to 0xFFFF by its flag)
    assign dv_d   = dq_sel[VW-1] ? {DDW{1'b0}} : (DDW'(dq_sel) << EOG_CD_SCALE);

    eog_div #(.NW(DNW), .DW(DDW), .TW(1)) u_div (
        .clk(clk), .rst_n(rst_n), .in_valid(dv_in), .n(kd[DNW-1:0]), .d(dv_d), .tag_in(1'b0),
        .out_valid(dv_ov), .q(dv_q), .r(dv_r), .tag_out(dv_to));

    // quotient saturated to 16 bits (d == 0 gives all ones: 0xFFFF)
    logic [15:0] dq;
    assign dq = (dv_q[DNW-1:16] != {(DNW - 16){1'b0}}) ? EOG_CD_NONE : dv_q[15:0];

    logic [15:0]    r10, r50;
    logic [CDW-1:0] res_wd;
    always_ff @(posedge clk) begin
        if (ph[I0+DLAT-1]) r10 <= dq;
        if (ph[I0+DLAT])   r50 <= dq;
    end
    assign res_wd = {dq, r50, r10};               // in cycle t+TL (ph[TL-1]), dq is p90

    // ---------------------------------------------------------------------------------------------------------
    // record FIFO: bus-C fields written at accept (tail), flags at t+I0 (fe_idx), quotients at done (dptr)
    logic [PAYW-1:0] pay_mem [P];
    logic [FLW-1:0]  flg_mem [P];
    logic [CDW-1:0]  res_mem [P];
    logic [PAYW-1:0] pay_in, pay_h;
    logic [FLW-1:0]  flg_h;
    logic [CDW-1:0]  res_h;

    assign pay_in[EOG_BC_REC_NO      +: EOG_BC_REC_NO_W]      = in_data[EOG_BM_REC_NO      +: EOG_BM_REC_NO_W];
    assign pay_in[EOG_BC_IN_LAST     +: EOG_BC_IN_LAST_W]     = in_data[EOG_BM_IN_LAST     +: EOG_BM_IN_LAST_W];
    assign pay_in[EOG_BC_FAC_RAW     +: EOG_BC_FAC_RAW_W]     = in_data[EOG_BM_FAC_RAW     +: EOG_BM_FAC_RAW_W];
    assign pay_in[EOG_BC_FAC         +: EOG_BC_FAC_W]         = in_data[EOG_BM_FAC         +: EOG_BM_FAC_W];
    assign pay_in[EOG_BC_TS          +: EOG_BC_TS_W]          = in_data[EOG_BM_TS          +: EOG_BM_TS_W];
    assign pay_in[EOG_BC_STATUS      +: EOG_BC_STATUS_W]      = in_data[EOG_BM_STATUS      +: EOG_BM_STATUS_W];
    assign pay_in[EOG_BC_REASON      +: EOG_BC_REASON_W]      = in_data[EOG_BM_REASON      +: EOG_BM_REASON_W];
    assign pay_in[EOG_BC_SINCE_RESET +: EOG_BC_SINCE_RESET_W] = in_data[EOG_BM_SINCE_RESET +: EOG_BM_SINCE_RESET_W];
    assign pay_in[EOG_BC_HIST_RESET  +: EOG_BC_HIST_RESET_W]  = in_data[EOG_BM_HIST_RESET  +: EOG_BM_HIST_RESET_W];
    assign pay_in[EOG_BC_FEAT        +: EOG_BC_FEAT_W]        = in_data[EOG_BM_FEAT        +: EOG_BM_FEAT_W];
    assign pay_in[EOG_BC_RULES       +: EOG_BM_RULES4_W]      = in_data[EOG_BM_RULES4      +: EOG_BM_RULES4_W];

    always_ff @(posedge clk) begin
        if (rst_n && in_fire)  pay_mem[tail]   <= pay_in;
        if (rst_n && ph[I0-1]) flg_mem[fe_idx] <= flg_wd;
        if (rst_n && done)     res_mem[dptr]   <= res_wd;
    end

    assign pay_h = pay_mem[head];
    assign flg_h = flg_mem[head];
    assign res_h = res_mem[head];

    // output: records that don't update state (INVALID, DROPPED, codes 2/5/6/7, FAC >= N_FAC) read 3 x 0xFFFF, NF 0
    logic [EOG_BC_STATUS_W-1:0] h_status;
    logic [EOG_BC_FAC_W-1:0]    h_fac;
    logic                       h_upd;
    logic [CDW-1:0]             h_cd;
    assign h_status = pay_h[EOG_BC_STATUS +: EOG_BC_STATUS_W];
    assign h_fac    = pay_h[EOG_BC_FAC    +: EOG_BC_FAC_W];
    assign h_upd    = ({1'b0, h_fac} < N_FAC[EOG_BC_FAC_W:0])
                   && ((h_status == EOG_ST_VALID) || (h_status == EOG_ST_HELD));

    genvar gc;
    generate
        for (gc = 0; gc < 3; gc = gc + 1) begin : g_cd
            assign h_cd[16 * gc +: 16] = !h_upd       ? EOG_CD_NONE
                                       : flg_h[FL_TRIP] ? 16'h0000
                                       : flg_h[gc]      ? EOG_CD_NONE
                                       : res_h[16 * gc +: 16];
        end
    endgenerate

    assign out_data[EOG_BC_REC_NO      +: EOG_BC_REC_NO_W]      = pay_h[EOG_BC_REC_NO      +: EOG_BC_REC_NO_W];
    assign out_data[EOG_BC_IN_LAST     +: EOG_BC_IN_LAST_W]     = pay_h[EOG_BC_IN_LAST     +: EOG_BC_IN_LAST_W];
    assign out_data[EOG_BC_FAC_RAW     +: EOG_BC_FAC_RAW_W]     = pay_h[EOG_BC_FAC_RAW     +: EOG_BC_FAC_RAW_W];
    assign out_data[EOG_BC_FAC         +: EOG_BC_FAC_W]         = pay_h[EOG_BC_FAC         +: EOG_BC_FAC_W];
    assign out_data[EOG_BC_TS          +: EOG_BC_TS_W]          = pay_h[EOG_BC_TS          +: EOG_BC_TS_W];
    assign out_data[EOG_BC_STATUS      +: EOG_BC_STATUS_W]      = pay_h[EOG_BC_STATUS      +: EOG_BC_STATUS_W];
    assign out_data[EOG_BC_REASON      +: EOG_BC_REASON_W]      = pay_h[EOG_BC_REASON      +: EOG_BC_REASON_W];
    assign out_data[EOG_BC_SINCE_RESET +: EOG_BC_SINCE_RESET_W] = pay_h[EOG_BC_SINCE_RESET +: EOG_BC_SINCE_RESET_W];
    assign out_data[EOG_BC_HIST_RESET  +: EOG_BC_HIST_RESET_W]  = pay_h[EOG_BC_HIST_RESET  +: EOG_BC_HIST_RESET_W];
    assign out_data[EOG_BC_FEAT        +: EOG_BC_FEAT_W]        = pay_h[EOG_BC_FEAT        +: EOG_BC_FEAT_W];
    assign out_data[EOG_BC_RULES       +: EOG_BM_RULES4_W]      = pay_h[EOG_BC_RULES       +: EOG_BM_RULES4_W];
    assign out_data[EOG_BC_RULES + EOG_RULE_NOT_FILLING]        = h_upd && flg_h[FL_NF];
    assign out_data[EOG_BC_CD          +: EOG_BC_CD_W]          = h_cd;

    // Unused: most of the CONFIG row; the divider's out_valid (timing comes from ph), remainder and tag; the top
    // bits of the shifted mean (sign copies: the mean of s16 values is within s16).
    logic unused_ok;
    assign unused_ok = ^{cfg_row, dv_ov, dv_r, dv_to, w_mean_x[SB-1:VW]};

`ifdef FORMAL
    // ---- conventions section 7 observation ports: the FIFO holds every record from accept to output transfer ----
    assign f_inflight     = 8'(cnt);
    assign f_oldest_recno = pay_h[EOG_BC_REC_NO +: EOG_BC_REC_NO_W];

    // ---- internal invariants (own state only; help k-induction) ----
    // Some bounds are trivially true at some parameter sets (e.g. a power-of-two P); kept for the others.
    /* verilator lint_off CMPCONST */
    /* verilator lint_off UNSIGNED */
    logic [7:0] f_tok;   // tokens in ph[TL-1:0] = records accepted whose quotients are not yet written
    always_comb begin
        f_tok = 8'd0;
        for (int j = 0; j < TL; j++) f_tok = f_tok + {7'd0, ph[j]};
    end

    always_comb begin
        if (rst_n) begin
            fi_cnt:   assert (cnt <= CB'(P) && ndone <= cnt);
            fi_tok:   assert (8'(cnt) - 8'(ndone) == f_tok);
            fi_ptr:   assert (32'(head) < P && 32'(tail) < P && 32'(dptr) < P);
            fi_tail:  assert (32'(tail) == (32'(head) + 32'(cnt)) % P);
            fi_dptr:  assert (32'(dptr) == (32'(head) + 32'(ndone)) % P);
        end
    end

    // tokens are at least F apart (an accept needs ph[F-2:0] == 0)
    always_comb begin
        if (rst_n) begin
            for (int j = 0; j < PHL; j++)
                for (int k = 1; k < F; k++)
                    if (j + k < PHL) assert (!(ph[j] && ph[j + k]));   // unlabeled: one per pair
        end
    end

    // the record in the front end (token in ph[I0-1:0]) is the newest one in the FIFO
    always_comb begin
        if (rst_n && (|ph[I0-1:0]))
            fi_feidx: assert (32'(fe_idx) == (32'(tail) + P - 1) % P);
    end
    /* verilator lint_on UNSIGNED */
    /* verilator lint_on CMPCONST */

`ifdef EOG_FV_RECNO_SEQ
    // Opt-in (define EOG_FV_RECNO_SEQ = the harness's REC_NO compare width RW): the FIFO entries hold consecutive
    // REC_NOs in their low RW bits. True whenever the input REC_NO is the acceptance counter (formal/common
    // eog_fv_stage assumption st_recno_in); with it, st_link_r / st_order are k-inductive for P > 1 (without it a
    // FIFO entry behind the head may start with any REC_NO). Not an input assumption: off unless the harness opts in.
    localparam integer FRW = `EOG_FV_RECNO_SEQ;
    always_comb begin
        if (rst_n) begin
            for (int i = 1; i < P; i++)
                if (i < 32'(cnt))
                    assert (pay_mem[(32'(head) + i) % P][EOG_BC_REC_NO +: FRW]
                            == pay_h[EOG_BC_REC_NO +: FRW] + FRW'(i));                     // unlabeled: one per entry
        end
    end
`endif
`endif
endmodule
