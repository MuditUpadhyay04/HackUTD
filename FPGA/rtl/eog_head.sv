// eog_head.sv -- four logistic regressions over the 31 features, double-buffered weights, debug capture
// (spec v4: modules/eog_head.md, numerics.md section 8 (D11, D12), conventions sections 1, 3 and 7).
//
// Bus C in, bus L out. One record at a time:
//   S_IDLE  in_ready = !swap_pending. A pending swap happens here (in_ready = 0 that cycle, TASKS.md spec
//           question 18), so it always falls between an output transfer and the next accept. On accept:
//           in_r <= bus C, acc[k] <= B[k] of the active bank, bank_r / ver_r / sout_r <= the active bank and its
//           VER / S_OUT (the record's snapshot).
//   S_MAC   cnt = 0..NC+MLAT-1. Issue cycle c = cnt (< NC) feeds FEAT[4c+m] and W[k][4c+m] (m = 0..3, bank bank_r)
//           into multiplier 4k+m; the products arrive MLAT cycles later and acc[k] += p0 + p1 + p2 + p3.
//   S_FIN   logit[k] <= sat16((acc[k] + rnd) >>> S_OUT), or 0 when the record gets no logits.
//   S_OUT   out_valid = 1 until out_ready.
// N_CLS * 4 multipliers (16: eog_mul 16x16 signed, LAT 2), NC = ceil(N_FEAT / 4) issue cycles (8).
// Latency 12 cycles (accept -> out_valid), II 13 cycles with out_ready = 1 (14 when a swap is pending).
//
// Numerics (numerics.md section 8): acc is 48-bit signed and exact (|acc| < 2^36). S_OUT is the whole byte 4
// (0..255): the shift is exact for every value (S_OUT >= 48 gives 0, since |acc| < 2^47). VALID/HELD with
// VER != 0 get logits; every other record gets 0. WVER = VER of the bank active at accept, 0 for DROPPED
// (conventions section 3). CH3 = FEAT[3] (spec question 19), RULES, CD and the header (REASON included) are copied.
//
// Weight window (D11; per bank, EOG_WIN_WORDS = 71 words of 32 bits): words 0..69 = Mudit's weight blob bytes
// 0..279 (little-endian), word 70 [7:0] = VER. The blob layout is fixed (31 features, 4 heads) whatever N_FEAT /
// N_CLS are: S_OUT = byte 4 (word 1 [7:0]); W[k][i] = s16 at byte 8 + 2(31k + i), i.e. halfword
// h = 4 + 31k + i (word h >> 1, half h & 1); B[k] = s32 at word 64 + k. Bytes 0-3, 5-7 and 272-279 are stored and
// read back but not used.
//   Storage: win (words 0..69 of both banks, for readback only); per multiplier q = 4k+m a 16-bit lane memory
//   holding W[k][4c+m] at {bank, c} (the MAC read port); bias_q, sout_q; w70_q (word 70, the only reset word).
//   Writes (wb_we) go to the bank that is inactive in the cycle of the write (also in the cycle a swap happens),
//   never to the active bank; writes while rst_n = 0 or wb_rst_n = 0 are ignored. Weights with k >= N_CLS or
//   i >= N_FEAT are not stored (they are still in win). Words >= 71: writes ignored, read back 0.
//   wb_rdata = the inactive bank's word wb_raddr, registered (1 cycle; read-first: a write to the same word in the
//   same cycle is not visible yet).
// Resets (spec v3):
//   rst_n = 0 (engine reset, includes the soft reset): flushes the record in flight (state machine only). Banks,
//     active_bank and swap_pending survive; a pending swap waits until rst_n = 1 (swap_req is still taken).
//   wb_rst_n = 0 (hard reset only): word 70 of both banks = 0 (VER = 0, no model), active_bank = 0,
//     swap_pending = 0. Words 0-69 are never reset (undefined until written).
//   In eog_top wb_rst_n = 0 implies rst_n = 0. If wb_rst_n alone pulses while a record is held, the record still
//   completes from its snapshot (bank_r, ver_r, sout_r, bias in acc), so it never mixes banks unless the ARM also
//   writes bank_r (now inactive) before it completes.
// Swap: swap_req sets swap_pending from the next cycle; requests while swap_pending = 1 coalesce (spec question 17).
// The swap happens in the first S_IDLE cycle with swap_pending = 1 and rst_n = 1: active_bank toggles and
// swap_pending falls at the same edge.
// Debug capture (D12): dbg_valid = 1 in the cycle a VALID/HELD record with FAC == dbg_fac transfers on the output
// (out_valid && out_ready, rst_n = 1); dbg_feat / dbg_logits / dbg_rec_no then hold that record's 31 features,
// 4 logits (as on out_data) and REC_NO. dbg_fac is compared in that cycle.

module eog_head #(
    // N_FAC, N_WELL, II: uniform stage interface (conventions section 6), unused here (TASKS.md spec question 11)
    /* verilator lint_off UNUSEDPARAM */
    parameter integer N_FAC  = 32,
    parameter integer N_WELL = 8,
    parameter integer II     = 16,
    /* verilator lint_on UNUSEDPARAM */
    parameter integer N_FEAT = 31,   // 1..31 features used (the window layout stays the 31-feature blob)
    parameter integer N_CLS  = 4     // 1..4 heads used
) (
    input  logic          clk,
    input  logic          rst_n,          // engine reset (includes soft reset): flushes the record in flight
    input  logic          wb_rst_n,       // weight-store reset, hard reset only (spec v3)
    input  logic          in_valid,
    output logic          in_ready,
    input  logic [662:0]  in_data,        // bus C (EOG_BC_W)
    output logic          out_valid,
    input  logic          out_ready,
    output logic [254:0]  out_data,       // bus L (EOG_BL_W)
    input  logic          wb_we,          // write one word of the inactive bank's window
    input  logic [6:0]    wb_addr,        // window word 0..70 (EOG_WIN_WORDS = 71)
    input  logic [31:0]   wb_wdata,
    input  logic [6:0]    wb_raddr,       // readback address (inactive bank)
    output logic [31:0]   wb_rdata,       // readback data, 1 cycle after wb_raddr
    input  logic          swap_req,       // pulse: the inactive bank becomes active at the next record boundary
    output logic          swap_pending,
    output logic          active_bank,
    output logic [7:0]    active_ver,     // window word 70 [7:0] of the active bank
    input  logic [4:0]    dbg_fac,        // facility to capture
    output logic          dbg_valid,      // 1-cycle pulse: capture dbg_* now
    output logic [495:0]  dbg_feat,       // the 31 features of the captured record (EOG_BC_FEAT_W)
    output logic [63:0]   dbg_logits,     // its 4 logits (EOG_BL_LOGITS_W)
    output logic [31:0]   dbg_rec_no      // its REC_NO
`ifdef FORMAL
    , output logic [7:0]  f_inflight      // records accepted on in_* whose output has not yet transferred
    , output logic [31:0] f_oldest_recno  // REC_NO of the oldest such record; don't-care when f_inflight == 0
`endif
);
    `include "eog_defs.svh"

    // ---------------------------------------------------------------------------------------------------
    // sizes
    localparam integer MPC   = 4;                           // multipliers per class = features per issue cycle
    localparam integer NMUL  = MPC * N_CLS;                 // 16
    localparam integer NC    = (N_FEAT + MPC - 1) / MPC;    // issue cycles per record (8)
    localparam integer CW    = (NC > 1) ? $clog2(NC) : 1;   // issue index width
    localparam integer NCP   = 1 << CW;                     // issue slots, padded to a power of two
    localparam integer MLAT  = 2;                           // eog_mul latency
    localparam integer LASTC = NC + MLAT - 1;               // cnt of the last accumulate (9)
    localparam integer KW    = $clog2(LASTC + 1);           // cnt width
    localparam integer FPW   = 16 * MPC * NCP;              // padded feature vector
    localparam integer ACC_W = 48;                          // accumulator (numerics.md section 8)
    localparam integer RS_W  = ACC_W + 1;                   // accumulator + rounding constant (exact)

    // weight window layout (D11): fixed by the blob (EOG_N_FEAT = 31 weights per head)
    localparam integer BS    = EOG_N_FEAT;                  // blob stride between heads, in halfwords
    localparam integer H_W0  = 4;                           // halfword of W[0][0] (byte 8)
    localparam integer A_SOUT = 1;                          // word holding S_OUT (byte 4)
    localparam integer A_W_LO = 2, A_W_HI = 63;             // words holding W
    localparam integer A_VER = EOG_WIN_WORDS - 1;           // 70
    localparam integer NBLOB = EOG_WIN_WORDS - 1;           // 70 blob words (0..69)

    localparam logic [1:0] S_IDLE = 2'd0, S_MAC = 2'd1, S_FIN = 2'd2, S_OUT = 2'd3;

    // ---------------------------------------------------------------------------------------------------
    // control and record registers
    logic [1:0]          st;
    logic [KW-1:0]       cnt;
    logic [EOG_BC_W-1:0] in_r;      // the held record (bus C)
    logic                bank_r;    // the bank active at accept (the held record's bank)
    logic [7:0]          ver_r;     // VER of the bank active at accept
    logic [7:0]          sout_r;    // S_OUT of the bank active at accept
    logic                bank_q;    // active bank
    logic                pend_q;    // swap pending
    logic [63:0]         w70_q;     // window word 70 of bank 0 at [31:0], bank 1 at [63:32]
    logic [15:0]         sout_q;    // S_OUT (window byte 4) of bank 0 at [7:0], bank 1 at [15:8]

    logic take, do_swap, acc_en, fin, wr_ok;
    assign in_ready  = (st == S_IDLE) && !pend_q;
    assign take      = in_valid && in_ready;
    assign do_swap   = rst_n && (st == S_IDLE) && pend_q;
    assign acc_en    = (st == S_MAC) && (cnt >= KW'(MLAT));
    assign fin       = (st == S_FIN);
    assign out_valid = (st == S_OUT);
    assign wr_ok     = wb_we && rst_n && wb_rst_n;

    assign active_bank  = bank_q;
    assign swap_pending = pend_q;

    logic [7:0] act_ver, act_sout;
    assign act_ver    = bank_q ? w70_q[32 +: 8] : w70_q[0 +: 8];
    assign act_sout   = bank_q ? sout_q[8 +: 8] : sout_q[0 +: 8];
    assign active_ver = act_ver;

    logic wbank;                                      // the inactive bank (writes and readback)
    assign wbank = ~bank_q;

    // weight store control: hard reset only (wb_rst_n)
    always_ff @(posedge clk) begin
        if (!wb_rst_n) begin
            pend_q <= 1'b0;
            bank_q <= 1'b0;
            w70_q  <= '0;
        end else begin
            // word 70 (VER) of the inactive bank
            if (wr_ok && wb_addr == 7'(A_VER)) begin
                if (bank_q) w70_q[31:0]  <= wb_wdata;
                else        w70_q[63:32] <= wb_wdata;
            end
            // swap: requests while pending coalesce; the swap itself only in S_IDLE (no record held), rst_n = 1
            if (pend_q) begin
                if (do_swap) begin
                    pend_q <= 1'b0;
                    bank_q <= ~bank_q;
                end
            end else if (swap_req) begin
                pend_q <= 1'b1;
            end
        end
    end

    // record state machine: engine reset (rst_n)
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            st  <= S_IDLE;
            cnt <= '0;
        end else begin
            case (st)
                S_IDLE: if (take) begin
                    st  <= S_MAC;
                    cnt <= '0;
                end
                S_MAC: begin
                    cnt <= cnt + 1'b1;
                    if (cnt == KW'(LASTC)) st <= S_FIN;
                end
                S_FIN:   st <= S_OUT;
                default: if (out_ready) st <= S_IDLE;   // S_OUT
            endcase
        end
    end

    always_ff @(posedge clk) begin
        if (take) begin
            in_r   <= in_data;
            bank_r <= bank_q;
            ver_r  <= act_ver;
            sout_r <= act_sout;
        end
    end

    // ---------------------------------------------------------------------------------------------------
    // fields of the held record
    logic [EOG_BC_STATUS_W-1:0] r_status;
    logic                       r_vh, r_mac;
    logic [7:0]                 r_wver;
    assign r_status = in_r[EOG_BC_STATUS +: EOG_BC_STATUS_W];
    assign r_vh     = (r_status == EOG_ST_VALID) || (r_status == EOG_ST_HELD);
    assign r_mac    = r_vh && (ver_r != 8'd0);
    assign r_wver   = (r_status == EOG_ST_DROPPED) ? 8'd0 : ver_r;

    // features of issue cycle c: FEAT[4c..4c+3], zero beyond N_FEAT
    logic [CW-1:0]      cc;
    logic [FPW-1:0]     feat_pad;
    logic [16*MPC-1:0]  fop;
    assign cc = cnt[CW-1:0];
    always_comb begin
        feat_pad = '0;
        feat_pad[16*N_FEAT-1:0] = in_r[EOG_BC_FEAT +: 16*N_FEAT];
    end
    assign fop = feat_pad[16*MPC*cc +: 16*MPC];

    // ---------------------------------------------------------------------------------------------------
    // window writes: the blob copy (readback), S_OUT, biases, and the two weights of a W word
    logic [31:0] win [256];                           // {bank, word}: words 0..69 of both banks
    always_ff @(posedge clk) begin
        if (wr_ok && wb_addr < 7'(NBLOB)) win[{wbank, wb_addr}] <= wb_wdata;
    end

    always_ff @(posedge clk) begin
        if (wr_ok && wb_addr == 7'(A_SOUT)) begin
            if (wbank) sout_q[15:8] <= wb_wdata[7:0];
            else       sout_q[7:0]  <= wb_wdata[7:0];
        end
    end

    logic w_isw, w_isb;
    logic [1:0] w_bk;
    assign w_isw = (wb_addr >= 7'(A_W_LO)) && (wb_addr <= 7'(A_W_HI));
    assign w_isb = (wb_addr[6:2] == 5'b10000);       // words 64..67: B[0..3]
    assign w_bk  = wb_addr[1:0];

    // halfword s of the written word: global weight index g = 2*addr + s - 4 = BS*k + i; lane m = i % 4,
    // entry c = i / 4, multiplier q = 4k + m
    logic [1:0]     hw_k   [2];
    logic [4:0]     hw_i   [2];
    logic           hw_we  [2];
    logic [CW-1:0]  hw_c   [2];
    logic [1:0]     hw_m   [2];
    always_comb begin
        for (int s = 0; s < 2; s++) begin
            logic [7:0] g;
            logic [7:0] i8;
            g = {wb_addr, s[0]} - 8'(H_W0);
            if      (g >= 8'(3 * BS)) begin hw_k[s] = 2'd3; i8 = g - 8'(3 * BS); end
            else if (g >= 8'(2 * BS)) begin hw_k[s] = 2'd2; i8 = g - 8'(2 * BS); end
            else if (g >= 8'(BS))     begin hw_k[s] = 2'd1; i8 = g - 8'(BS);     end
            else                      begin hw_k[s] = 2'd0; i8 = g;              end
            hw_i[s]  = i8[4:0];                                   // < 31 for every W word
            hw_we[s] = wr_ok && w_isw && ({1'b0, hw_k[s]} < 3'(N_CLS)) && (i8 < 8'(N_FEAT));
            hw_m[s]  = hw_i[s][1:0];
            hw_c[s]  = hw_i[s][CW+1:2];
        end
    end

    // readback of the inactive bank (registered)
    logic [31:0] rb_word;
    always_comb begin
        if (wb_raddr < 7'(NBLOB))      rb_word = win[{wbank, wb_raddr}];
        else if (wb_raddr == 7'(A_VER)) rb_word = wbank ? w70_q[63:32] : w70_q[31:0];
        else                            rb_word = 32'h0;
    end
    always_ff @(posedge clk) wb_rdata <= rb_word;

    // ---------------------------------------------------------------------------------------------------
    // multipliers: q = MPC*k + m computes W[k][4c+m] * FEAT[4c+m]; each has its own lane memory
    wire [32*NMUL-1:0]  prod;      // products, MLAT cycles later
    wire [16*N_CLS-1:0] logit_all;

    genvar q;
    generate
        for (q = 0; q < NMUL; q = q + 1) begin : g_mul
            localparam logic [1:0] QK = 2'(q / MPC);
            localparam logic [1:0] QM = 2'(q % MPC);
            localparam integer     QF = q % MPC;            // lane = feature offset within an issue cycle

            logic [15:0] lane [2*NCP];                      // W[QK][4c+QM] at {bank, c}
            always_ff @(posedge clk) begin
                if (hw_we[0] && hw_k[0] == QK && hw_m[0] == QM)      lane[{wbank, hw_c[0]}] <= wb_wdata[15:0];
                else if (hw_we[1] && hw_k[1] == QK && hw_m[1] == QM) lane[{wbank, hw_c[1]}] <= wb_wdata[31:16];
            end

            // MAC operand: the record's bank; 0 for features beyond N_FEAT (no weight is stored there)
            logic [15:0] wop;
            assign wop = (MPC * cc + QF < N_FEAT) ? lane[{bank_r, cc}] : 16'h0;

            eog_mul #(.AW(16), .BW(16), .A_SIGNED(1), .B_SIGNED(1), .LAT(MLAT)) u_mul (
                .clk (clk),
                .a   (wop),
                .b   (fop[16*QF +: 16]),
                .p   (prod[32*q +: 32])
            );
        end
    endgenerate

    // ---------------------------------------------------------------------------------------------------
    // per class: bias, accumulator, output rounding
    genvar k;
    generate
        for (k = 0; k < N_CLS; k = k + 1) begin : g_cls
            localparam logic [1:0] KID = 2'(k);

            logic [63:0] bias_q;            // B[k]: bank 0 at [31:0], bank 1 at [63:32]
            always_ff @(posedge clk) begin
                if (wr_ok && w_isb && (w_bk == KID)) begin
                    if (wbank) bias_q[63:32] <= wb_wdata;
                    else       bias_q[31:0]  <= wb_wdata;
                end
            end

            // accumulate: acc = B[k] at accept, then the four products of each issue cycle
            logic [31:0]             b_act;
            logic signed [ACC_W-1:0] acc, psum;
            assign b_act = bank_q ? bias_q[63:32] : bias_q[31:0];
            always_comb begin
                psum = '0;
                for (int m = 0; m < MPC; m++) begin
                    psum = psum + $signed({{(ACC_W - 32){prod[32*(MPC*k + m) + 31]}}, prod[32*(MPC*k + m) +: 32]});
                end
            end
            always_ff @(posedge clk) begin
                if (take)        acc <= $signed({{(ACC_W - 32){b_act[31]}}, b_act});
                else if (acc_en) acc <= acc + psum;
            end

            // LOGIT = sat16((acc + (S_OUT > 0 ? 2^(S_OUT-1) : 0)) >>> S_OUT), exact for S_OUT 0..255:
            // S_OUT >= 48 gives 0 (|acc| < 2^47); below that the sum fits RS_W bits.
            logic                   big;
            logic [5:0]             sh;
            logic [RS_W-1:0]        rnd;
            logic signed [RS_W-1:0] rsum, rsh;
            logic                   fits;
            logic [15:0]            logit_n, logit_q;
            assign big     = (sout_r >= 8'd48);
            assign sh      = sout_r[5:0];
            assign rnd     = (RS_W'(1) << sh) >> 1;
            assign rsum    = $signed({acc[ACC_W-1], acc}) + $signed(rnd);
            assign rsh     = rsum >>> sh;
            assign fits    = (rsh[RS_W-1:15] == '0) || (rsh[RS_W-1:15] == '1);
            assign logit_n = big  ? 16'h0
                           : fits ? rsh[15:0]
                           :        (rsh[RS_W-1] ? 16'h8000 : 16'h7FFF);
            always_ff @(posedge clk) begin
                if (fin) logit_q <= r_mac ? logit_n : 16'h0;
            end
            assign logit_all[16*k +: 16] = logit_q;
        end
    endgenerate

    // ---------------------------------------------------------------------------------------------------
    // output bus L
    logic [EOG_BL_LOGITS_W-1:0] logits;
    always_comb begin
        logits = '0;
        logits[16*N_CLS-1:0] = logit_all;
    end

    always_comb begin
        out_data = '0;
        out_data[EOG_BL_REC_NO      +: EOG_BL_REC_NO_W]      = in_r[EOG_BC_REC_NO      +: EOG_BC_REC_NO_W];
        out_data[EOG_BL_IN_LAST     +: EOG_BL_IN_LAST_W]     = in_r[EOG_BC_IN_LAST     +: EOG_BC_IN_LAST_W];
        out_data[EOG_BL_FAC_RAW     +: EOG_BL_FAC_RAW_W]     = in_r[EOG_BC_FAC_RAW     +: EOG_BC_FAC_RAW_W];
        out_data[EOG_BL_FAC         +: EOG_BL_FAC_W]         = in_r[EOG_BC_FAC         +: EOG_BC_FAC_W];
        out_data[EOG_BL_TS          +: EOG_BL_TS_W]          = in_r[EOG_BC_TS          +: EOG_BC_TS_W];
        out_data[EOG_BL_STATUS      +: EOG_BL_STATUS_W]      = r_status;
        out_data[EOG_BL_REASON      +: EOG_BL_REASON_W]      = in_r[EOG_BC_REASON      +: EOG_BC_REASON_W];
        out_data[EOG_BL_SINCE_RESET +: EOG_BL_SINCE_RESET_W] = in_r[EOG_BC_SINCE_RESET +: EOG_BC_SINCE_RESET_W];
        out_data[EOG_BL_HIST_RESET  +: EOG_BL_HIST_RESET_W]  = in_r[EOG_BC_HIST_RESET  +: EOG_BC_HIST_RESET_W];
        out_data[EOG_BL_CH3         +: EOG_BL_CH3_W]         = in_r[EOG_BC_FEAT + 16 * 3 +: EOG_BL_CH3_W];
        out_data[EOG_BL_RULES       +: EOG_BL_RULES_W]       = in_r[EOG_BC_RULES       +: EOG_BC_RULES_W];
        out_data[EOG_BL_CD          +: EOG_BL_CD_W]          = in_r[EOG_BC_CD          +: EOG_BC_CD_W];
        out_data[EOG_BL_LOGITS      +: EOG_BL_LOGITS_W]      = logits;
        out_data[EOG_BL_WVER        +: EOG_BL_WVER_W]        = r_wver;
    end

    // ---------------------------------------------------------------------------------------------------
    // debug capture (D12): pulse with the output transfer of a VALID/HELD record of facility dbg_fac
    assign dbg_valid  = rst_n && out_valid && out_ready && r_vh &&
                        (in_r[EOG_BC_FAC +: EOG_BC_FAC_W] == dbg_fac);
    assign dbg_feat   = in_r[EOG_BC_FEAT +: EOG_BC_FEAT_W];
    assign dbg_logits = logits;
    assign dbg_rec_no = in_r[EOG_BC_REC_NO +: EOG_BC_REC_NO_W];

`ifdef FORMAL
    // ---- conventions section 7 observation ports: one record at a time, held in in_r from accept to transfer ----
    assign f_inflight     = (st == S_IDLE) ? 8'd0 : 8'd1;
    assign f_oldest_recno = in_r[EOG_BC_REC_NO +: EOG_BC_REC_NO_W];

    // ---- internal invariants (own state only; help k-induction) ----
    // the MAC counter never passes the last accumulate
    always_comb if (rst_n && st == S_MAC) fi_cnt: assert (cnt <= KW'(LASTC));
    // While a record is held there is no swap and no write to the active bank, so its snapshot (bank, VER, S_OUT)
    // stays the active one. The only other case is a wb_rst_n pulse without rst_n after the accept (impossible in
    // eog_top): bank 0 is then active with word 70 = 0, and nothing can change that while the record is held
    // (writes go to bank 1, no swap). Valid for any combination of the two resets.
    logic fi_snap_cur, fi_store_rst;
    assign fi_snap_cur  = (bank_r == bank_q) && (ver_r == act_ver) && (sout_r == act_sout);
    assign fi_store_rst = !bank_q && (w70_q[31:0] == 32'd0);
    always_comb if (rst_n && st != S_IDLE) fi_bank: assert (fi_snap_cur || fi_store_rst);
`endif
endmodule
