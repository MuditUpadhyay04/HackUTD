// eog_countdown.sv -- minutes to tank shutdown, p10 / p50 / p90 (spec v2: modules/eog_countdown.md, numerics.md
// section 7, decisions D1, D2, D4, D5; conventions section 7 formal observation ports).
//
// Bus M in, bus C out. Header, FEAT and RULES[3:0] pass through; RULES[4] = NOT_FILLING; CD = {p90, p50, p10}.
//
// Structure: a serial front end (one record at a time) owns the per-facility state; a fixed-latency arithmetic
// pipeline (eog_mul x2, one eog_div) follows; a P-entry FIFO holds each record from accept until its output
// transfers, so several records can be inside the 49-cycle divider at once (needed for II <= 16).
//
//   cycle t        accept: read the slot's ring row / n / write pointer (in_data.FAC; cfg_fac = in_data.FAC, so
//                  SHUT_LVL and K_CD are sampled in the accept cycle), push q = max(INFLOW, 0) (HIST_RESET clears
//                  the ring first), write the slot back, load the CD_N ring values into a reduction register, and
//                  store the record's bus-C fields in the FIFO.
//   t+1 .. t+R     in-place tree reduction (R = log2 CD_N steps) to sum / max / min of the last n values.
//   t+1 ..         K*delta (eog_mul, LAT 2), then K*delta*n (eog_mul, LAT 2).
//   t+I0 .. t+I0+2 three divisions issued to eog_div on consecutive cycles: p10, p50, p90.
//   t+I0+DLAT ..   quotients come back (DLAT = 49); at t+TL the record's CD is written into its FIFO entry.
//   t+TL+1         out_valid (if the record is the oldest).
//
// Defaults (N_FAC 32, CD_N 16, II 16): latency 57 cycles (accept -> out_valid), front end accepts every 7 cycles,
// FIFO depth P = 7, worst gap between accepts with out_ready = 1 is 16 cycles. CD_N = 4: latency 56, every 6
// cycles, P = 8. P is derived from the II parameter (the smallest depth that keeps an accept every II cycles); with
// II >= latency + 2 it is 1 (one record at a time). Requires II >= F (7 at CD_N 16, 6 at CD_N 4).
//
// Rules (numerics.md section 7):
//   - only VALID/HELD records with FAC < N_FAC ("upd") touch the slot; every other record gets CD = 3 x 0xFFFF and
//     NOT_FILLING = 0 (this override is applied at the output, from the record's own STATUS / FAC).
//   - LEVEL >= SHUT_LVL (s16 vs zero-extended u16): CD = 0, NOT_FILLING = 0 (D2, checked first).
//   - else delta = SHUT_LVL - LEVEL (u17), K = K_CD:
//       p10 = div(K*delta, max*256), p50 = div(K*delta*n, sum*256) (D5), p90 = div(K*delta, min*256),
//       div(a, b) = b == 0 ? 0xFFFF : min(a / b, 0xFFFF), NOT_FILLING = (sum == 0).
//   - Exact for every 32-bit K_CD: the products are kept in full (49 and 49 + NB bits); a numerator >= 2^48 can
//     only give a quotient >= 2^16 (every denominator is < 2^32), so it reads 0xFFFF without dividing. Ingest keeps
//     K_CD < 2^24, where this never triggers.
//
// Every multiply goes through eog_mul and the divide through eog_div (NW 48, DW 32). The divider's out_valid is
// not used: the result timing comes from this module's own token shift register (eog_div's latency is exactly
// NW + 1), so the control state is entirely local (k-induction never depends on the divider's pipeline). Its
// tag carries {nf, tripped, overflow} for each division.
//
// Parameters: N_FAC (1..32), II, CD_N (>= 2; ring depth, numerics.md n <= 16).

module eog_countdown #(
    parameter integer N_FAC = 32,
    parameter integer II    = 16,
    parameter integer CD_N  = 16
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
    // FIFO depth: records are accepted at least F cycles apart, and a FIFO slot can be reused D cycles after its
    // record was accepted (out_ready = 1), so with P slots the longest gap between accepts is max(F, D - (P-1)*F).
    // Smallest P with D - (P-1)*F <= ii.
    function automatic integer fifo_depth(input integer d, input integer f, input integer ii);
        integer p, gap, k;
        begin
            p   = 1;
            gap = d;
            for (k = 0; k < 128; k = k + 1) begin
                if (gap > ii) begin
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
    localparam integer QW   = 15;                                 // ring value q = max(INFLOW, 0), u15
    localparam integer NB   = $clog2(CD_N + 1);                   // n = 0..CD_N
    localparam integer WB   = $clog2(CD_N);                       // write pointer 0..CD_N-1
    localparam integer SB   = QW + WB;                            // sum of up to CD_N values
    localparam integer RW   = CD_N * QW;                          // ring row of one slot
    localparam integer R    = $clog2(CD_N);                       // reduction steps
    localparam integer CDP  = 1 << R;                             // ring padded to a power of two
    localparam integer EW   = SB + 2 * QW;                        // reduction entry {min, max, sum}
    localparam integer O_MX = SB;                                 // entry: max at [O_MX +: QW]
    localparam integer O_MN = SB + QW;                            // entry: min at [O_MN +: QW]

    localparam integer KW   = EOG_CFG_K_CD_W;                     // K_CD, u32
    localparam integer DLW  = 17;                                 // delta = SHUT_LVL - LEVEL, u17
    localparam integer KDW  = DLW + KW;                           // K * delta (49 bits)
    localparam integer KNW  = KDW + NB;                           // K * delta * n
    localparam integer MLAT = 2;                                  // eog_mul latency

    localparam integer DNW  = 48;                                 // eog_div numerator width (spec)
    localparam integer DDW  = 32;                                 // eog_div denominator width (spec)
    localparam integer DTW  = 3;                                  // tag: {nf, tripped, overflow}
    localparam integer T_OV = 0, T_TRIP = 1, T_NF = 2;
    localparam integer DLAT = DNW + 1;                            // eog_div LAT = NW + 1 (spec/modules/eog_div.md)

    // schedule, in cycles after the accept cycle t (token ph[j] is set in cycle t+1+j)
    localparam integer I0   = (R + 1 > 2 * MLAT) ? R + 1 : 2 * MLAT;  // p10 issue (p50 at I0+1, p90 at I0+2)
    localparam integer F    = I0 + 2;                             // cycles between accepts (front end)
    localparam integer TL   = I0 + DLAT + 2;                      // result written in cycle t+TL
    localparam integer D    = TL + 2;                             // FIFO slot reusable from cycle t+D
    localparam integer P    = fifo_depth(D, F, II);               // FIFO depth (records in flight)
    localparam integer PB   = (P > 1) ? $clog2(P) : 1;            // FIFO pointer width
    localparam integer CB   = $clog2(P + 1);                      // FIFO count width

    localparam integer PAYW = EOG_BC_RULES + EOG_BM_RULES4_W;     // bus C below NOT_FILLING: header, FEAT, RULES4
    localparam integer RESW = 1 + EOG_BC_CD_W;                    // result: {NOT_FILLING, p90, p50, p10}

    localparam logic [EW-1:0] IDENT = {{QW{1'b1}}, {QW{1'b0}}, {SB{1'b0}}};   // min = 0x7FFF, max = 0, sum = 0

    // ---------------------------------------------------------------------------------------------------------
    // input record fields (used in the accept cycle)
    logic [EOG_BM_STATUS_W-1:0] i_status;
    logic [EOG_BM_FAC_W-1:0]    i_fac;
    logic                       i_hist;
    logic [15:0]                i_inflow, i_level;
    logic                       i_fac_ok, i_upd;
    logic [FW-1:0]              i_slot;

    assign i_status = in_data[EOG_BM_STATUS     +: EOG_BM_STATUS_W];
    assign i_fac    = in_data[EOG_BM_FAC        +: EOG_BM_FAC_W];
    assign i_hist   = in_data[EOG_BM_HIST_RESET];
    assign i_inflow = in_data[EOG_BM_INFLOW     +: EOG_BM_INFLOW_W];
    assign i_level  = in_data[EOG_BM_LEVEL      +: EOG_BM_LEVEL_W];

    assign i_fac_ok = ({1'b0, i_fac} < N_FAC[EOG_BM_FAC_W:0]);
    assign i_upd    = i_fac_ok && ((i_status == EOG_ST_VALID) || (i_status == EOG_ST_HELD));
    assign i_slot   = i_fac_ok ? i_fac[FW-1:0] : {FW{1'b0}};

    // CONFIG row of the record's slot, read in the accept cycle
    logic [15:0]   c_shut;
    logic [KW-1:0] c_k;
    assign cfg_fac = i_fac;
    assign c_shut  = cfg_row[EOG_CFG_SHUT_LVL +: EOG_CFG_SHUT_LVL_W];
    assign c_k     = cfg_row[EOG_CFG_K_CD     +: EOG_CFG_K_CD_W];

    // D2: tripped = LEVEL >= SHUT_LVL (signed LEVEL, zero-extended SHUT_LVL); else delta = SHUT_LVL - LEVEL in 1..98303
    logic signed [DLW:0] lvl_x, shut_x, dl_x;
    logic                i_trip;
    assign lvl_x  = {{(DLW + 1 - 16){i_level[15]}}, i_level};
    assign shut_x = {{(DLW + 1 - 16){1'b0}}, c_shut};
    assign dl_x   = shut_x - lvl_x;                               // exact in s18
    assign i_trip = dl_x[DLW] || (dl_x == {(DLW + 1){1'b0}});     // delta <= 0  <=>  LEVEL >= SHUT_LVL

    // ---------------------------------------------------------------------------------------------------------
    // per-slot state: ring rows (one write port, one async read port: distributed RAM), n and write pointer (flops,
    // reset to 0). Slot invariant: n <= CD_N, wp < CD_N, and wp == n while n < CD_N, so the valid ring entries are
    // exactly 0..n-1 (all of them once n == CD_N).
    logic [RW-1:0]       ring_mem [N_FAC];
    logic [N_FAC*NB-1:0] n_st;
    logic [N_FAC*WB-1:0] wp_st;

    logic [RW-1:0] r_old, r_new;
    logic [NB-1:0] s_n_rd, s_n_old, s_n_new;
    logic [WB-1:0] s_wp_rd, s_wp_old, s_wp_new;
    logic [QW-1:0] i_q;

    assign r_old = ring_mem[i_slot];

    always_comb begin
        s_n_rd  = {NB{1'b0}};
        s_wp_rd = {WB{1'b0}};
        for (int f = 0; f < N_FAC; f++) begin
            if (i_slot == FW'(f)) begin
                s_n_rd  = n_st[f * NB +: NB];
                s_wp_rd = wp_st[f * WB +: WB];
            end
        end
    end

    // HIST_RESET clears the ring before the push
    assign s_n_old  = i_hist ? {NB{1'b0}} : s_n_rd;
    assign s_wp_old = i_hist ? {WB{1'b0}} : s_wp_rd;
    assign s_n_new  = (s_n_old == NB'(CD_N)) ? NB'(CD_N) : s_n_old + 1'b1;
    assign s_wp_new = (s_wp_old == WB'(CD_N - 1)) ? {WB{1'b0}} : s_wp_old + 1'b1;
    assign i_q      = i_inflow[15] ? {QW{1'b0}} : i_inflow[QW-1:0];      // max(INFLOW, 0)

    always_comb begin
        r_new = r_old;
        for (int i = 0; i < CD_N; i++)
            if (s_wp_old == WB'(i)) r_new[i * QW +: QW] = i_q;
    end

    // ---------------------------------------------------------------------------------------------------------
    // control: FIFO pointers / counts, token shift register
    logic          busy, in_fire, out_fire, st_we, done;
    logic [TL-1:0] ph;              // ph[j]: the front-end record was accepted j+1 cycles ago (one token per record)
    logic [PB-1:0] head, tail, dptr;
    logic [CB-1:0] cnt;             // records in the FIFO (accepted, output not yet transferred)
    logic [CB-1:0] ndone;           // of those, records whose CD is written (the oldest ndone)

    assign busy      = |ph[I0:0];
    assign in_ready  = !busy && (cnt != CB'(P));
    assign out_valid = (ndone != {CB{1'b0}});
    assign in_fire   = in_valid && in_ready;
    assign out_fire  = out_valid && out_ready;
    assign st_we     = rst_n && in_fire && i_upd;
    assign done      = ph[TL-1];

    function automatic logic [PB-1:0] ptr_inc(input logic [PB-1:0] p);
        ptr_inc = (p == PB'(P - 1)) ? {PB{1'b0}} : p + 1'b1;
    endfunction

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            ph    <= {TL{1'b0}};
            head  <= {PB{1'b0}};
            tail  <= {PB{1'b0}};
            dptr  <= {PB{1'b0}};
            cnt   <= {CB{1'b0}};
            ndone <= {CB{1'b0}};
        end else begin
            ph <= {ph[TL-2:0], in_fire};
            if (in_fire)  tail <= ptr_inc(tail);
            if (done)     dptr <= ptr_inc(dptr);
            if (out_fire) head <= ptr_inc(head);
            cnt   <= cnt   + CB'(in_fire) - CB'(out_fire);
            ndone <= ndone + CB'(done)    - CB'(out_fire);
        end
    end

    // per-slot state write (accept cycle, upd records only)
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            n_st  <= {(N_FAC * NB){1'b0}};
            wp_st <= {(N_FAC * WB){1'b0}};
        end else if (st_we) begin
            for (int f = 0; f < N_FAC; f++) begin
                if (i_slot == FW'(f)) begin
                    n_st[f * NB +: NB]  <= s_n_new;
                    wp_st[f * WB +: WB] <= s_wp_new;
                end
            end
        end
    end

    always_ff @(posedge clk) begin
        if (st_we) ring_mem[i_slot] <= r_new;
    end

    // ---------------------------------------------------------------------------------------------------------
    // reduction register: loaded at accept with the CD_N ring values after the push (entries >= n are the
    // identity), then one tree level per cycle; after R cycles entry 0 holds {min, max, sum} and stays there (every
    // other entry is the identity by then).
    logic [CDP*EW-1:0] win, win_ld, win_nx;

    genvar gi;
    generate
        for (gi = 0; gi < CDP; gi = gi + 1) begin : g_win
            if (gi < CD_N) begin : g_ld
                logic [QW-1:0] v;
                assign v = r_new[gi * QW +: QW];
                assign win_ld[gi * EW +: EW] = (NB'(gi) < s_n_new) ? {v, v, SB'(v)} : IDENT;
            end else begin : g_pad
                assign win_ld[gi * EW +: EW] = IDENT;
            end
            if (gi < CDP / 2) begin : g_red
                logic [EW-1:0] a, b;
                logic [QW-1:0] mx, mn;
                logic [SB-1:0] sm;
                assign a  = win[(2 * gi) * EW +: EW];
                assign b  = win[(2 * gi + 1) * EW +: EW];
                assign mx = (a[O_MX +: QW] >= b[O_MX +: QW]) ? a[O_MX +: QW] : b[O_MX +: QW];
                assign mn = (a[O_MN +: QW] <= b[O_MN +: QW]) ? a[O_MN +: QW] : b[O_MN +: QW];
                assign sm = a[SB-1:0] + b[SB-1:0];
                assign win_nx[gi * EW +: EW] = {mn, mx, sm};
            end else begin : g_idle
                assign win_nx[gi * EW +: EW] = IDENT;
            end
        end
    endgenerate

    // front-end registers (stable from the accept until the next accept, which is after the last issue)
    logic [DLW-1:0] dl_r;
    logic [KW-1:0]  k_r;
    logic [NB-1:0]  n_r;
    logic           trip_r;

    always_ff @(posedge clk) begin
        win <= in_fire ? win_ld : win_nx;
        if (in_fire) begin
            dl_r   <= i_trip ? {DLW{1'b0}} : dl_x[DLW-1:0];
            k_r    <= c_k;
            n_r    <= s_n_new;
            trip_r <= i_trip;
        end
    end

    logic [SB-1:0] w_sum;
    logic [QW-1:0] w_max, w_min;
    assign w_sum = win[0 +: SB];
    assign w_max = win[O_MX +: QW];
    assign w_min = win[O_MN +: QW];

    // ---------------------------------------------------------------------------------------------------------
    // numerators: K*delta valid from t+1+MLAT, K*delta*n from t+1+2*MLAT (inputs held until the next accept)
    logic [KDW-1:0] kd;
    logic [KNW-1:0] kdn;

    eog_mul #(.AW(DLW), .BW(KW), .A_SIGNED(0), .B_SIGNED(0), .LAT(MLAT)) u_mul_kd (
        .clk(clk), .a(dl_r), .b(k_r), .p(kd));

    eog_mul #(.AW(NB), .BW(KDW), .A_SIGNED(0), .B_SIGNED(0), .LAT(MLAT)) u_mul_kdn (
        .clk(clk), .a(n_r), .b(kd), .p(kdn));

    logic ov_kd, ov_kdn;
    assign ov_kd  = |kd[KDW-1:DNW];
    assign ov_kdn = |kdn[KNW-1:DNW];

    // ---------------------------------------------------------------------------------------------------------
    // divisions: p10 at ph[I0-1] (cycle t+I0), p50 at ph[I0], p90 at ph[I0+1]
    logic           dv_in;
    logic [DNW-1:0] dv_n;
    logic [DDW-1:0] dv_d;
    logic [DTW-1:0] dv_t;
    logic           dv_ov;
    logic [DNW-1:0] dv_q;
    logic [DDW-1:0] dv_r;
    logic [DTW-1:0] dv_to;

    logic           is50, is90;
    logic [DDW-1:0] d10, d50, d90;
    assign is50  = ph[I0];
    assign is90  = ph[I0+1];
    assign dv_in = ph[I0-1] | is50 | is90;

    assign d10  = DDW'(w_max) << EOG_CD_SCALE;    // p10 = div(K*delta,   max*256)
    assign d50  = DDW'(w_sum) << EOG_CD_SCALE;    // p50 = div(K*delta*n, sum*256)
    assign d90  = DDW'(w_min) << EOG_CD_SCALE;    // p90 = div(K*delta,   min*256)
    assign dv_n = is50 ? kdn[DNW-1:0] : kd[DNW-1:0];
    assign dv_d = is50 ? d50 : (is90 ? d90 : d10);
    assign dv_t = is50 ? {(w_sum == {SB{1'b0}}) && !trip_r, trip_r, ov_kdn} : {1'b0, trip_r, ov_kd};

    eog_div #(.NW(DNW), .DW(DDW), .TW(DTW)) u_div (
        .clk(clk), .rst_n(rst_n), .in_valid(dv_in), .n(dv_n), .d(dv_d), .tag_in(dv_t),
        .out_valid(dv_ov), .q(dv_q), .r(dv_r), .tag_out(dv_to));

    // quotient -> minutes: tripped 0; overflow or > 0xFFFF (including d == 0: q all ones) 0xFFFF
    logic [15:0] dq;
    assign dq = dv_to[T_TRIP] ? 16'h0000
              : (dv_to[T_OV] || (dv_q[DNW-1:16] != {(DNW - 16){1'b0}})) ? EOG_CD_NONE
              : dv_q[15:0];

    logic [15:0]     r10, r50;
    logic            rnf;
    logic [RESW-1:0] res_wd;

    always_ff @(posedge clk) begin
        if (ph[I0+DLAT-1]) r10 <= dq;
        if (ph[I0+DLAT]) begin
            r50 <= dq;
            rnf <= dv_to[T_NF];
        end
    end
    assign res_wd = {rnf, dq, r50, r10};         // in cycle t+TL (ph[TL-1]), dq is p90

    // ---------------------------------------------------------------------------------------------------------
    // record FIFO: bus-C fields written at accept (tail), result written at done (dptr), read at head
    logic [PAYW-1:0] pay_mem [P];
    logic [RESW-1:0] res_mem [P];
    logic [PAYW-1:0] pay_in, pay_h;
    logic [RESW-1:0] res_h;

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
        if (rst_n && in_fire) pay_mem[tail] <= pay_in;
        if (rst_n && done)    res_mem[dptr] <= res_wd;
    end

    assign pay_h = pay_mem[head];
    assign res_h = res_mem[head];

    // output: records that do not update state (INVALID, DROPPED, other codes, FAC >= N_FAC) read 3 x 0xFFFF, NF 0
    logic [EOG_BC_STATUS_W-1:0] h_status;
    logic [EOG_BC_FAC_W-1:0]    h_fac;
    logic                       h_upd;
    assign h_status = pay_h[EOG_BC_STATUS +: EOG_BC_STATUS_W];
    assign h_fac    = pay_h[EOG_BC_FAC    +: EOG_BC_FAC_W];
    assign h_upd    = ({1'b0, h_fac} < N_FAC[EOG_BC_FAC_W:0])
                   && ((h_status == EOG_ST_VALID) || (h_status == EOG_ST_HELD));

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
    assign out_data[EOG_BC_RULES + EOG_RULE_NOT_FILLING]        = h_upd && res_h[EOG_BC_CD_W];
    assign out_data[EOG_BC_CD          +: EOG_BC_CD_W]          = h_upd ? res_h[EOG_BC_CD_W-1:0]
                                                                        : {3{EOG_CD_NONE}};

    // Unused: most of the CONFIG row; the divider's out_valid (timing comes from ph) and remainder.
    logic unused_ok;
    assign unused_ok = ^{cfg_row, dv_ov, dv_r};

`ifdef FORMAL
    // ---- conventions section 7 observation ports: the FIFO holds every record from accept to output transfer ----
    assign f_inflight     = 8'(cnt);
    assign f_oldest_recno = pay_h[EOG_BC_REC_NO +: EOG_BC_REC_NO_W];

    // ---- internal invariants (own state only; help k-induction) ----
    // Some bounds are trivially true at some parameter sets (e.g. a power-of-two P or CD_N); kept for the others.
    /* verilator lint_off CMPCONST */
    /* verilator lint_off UNSIGNED */
    logic [7:0] f_tok;   // tokens in ph = records accepted whose CD is not yet written
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

    // tokens are at least F apart (an accept needs ph[I0:0] == 0)
    always_comb begin
        if (rst_n) begin
            for (int j = 0; j < TL; j++)
                for (int k = 1; k < F; k++)
                    if (j + k < TL) assert (!(ph[j] && ph[j + k]));   // unlabeled: one per pair
        end
    end

    // per-slot ring bookkeeping
    always_comb begin
        if (rst_n) begin
            for (int f = 0; f < N_FAC; f++) begin
                assert (32'(n_st[f * NB +: NB]) <= CD_N);                                 // unlabeled: one per slot
                assert (32'(wp_st[f * WB +: WB]) < CD_N);
                if (n_st[f * NB +: NB] < NB'(CD_N))
                    assert (NB'(wp_st[f * WB +: WB]) == n_st[f * NB +: NB]);
            end
        end
    end
    /* verilator lint_on UNSIGNED */
    /* verilator lint_on CMPCONST */
`endif
endmodule
