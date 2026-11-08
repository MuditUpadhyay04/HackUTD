// eog_head.sv -- four logistic regressions over the 31 features + double-buffered weight banks
// (spec v2: modules/eog_head.md, numerics.md section 8, conventions section 7 formal observation ports).
//
// Bus C in, bus L out. One record at a time:
//   S_IDLE  in_ready = !swap_pending. A pending swap happens here (in_ready = 0 that cycle), so it always falls
//           between an output transfer and the next accept. On accept: in_r <= bus C, acc[k] <= B[k] of the active
//           bank, ver_r / sout_r <= VER / S_OUT of the active bank.
//   S_MAC   cnt = 0..NC+MLAT-1. Issue cycle c = cnt (< NC) feeds FEAT[4c..4c+3] and W[k][4c..4c+3] (image words
//           16k+2c, 16k+2c+1 of the active bank) into 4 multipliers per class; their products arrive MLAT cycles
//           later and acc[k] += p0 + p1 + p2 + p3 (cnt >= MLAT).
//   S_FIN   logit[k] <= sat16((acc[k] + rnd) >>> S_OUT), or 0 when the record gets no logits.
//   S_OUT   out_valid = 1 until out_ready.
// N_CLS * 4 multipliers (16: eog_mul 16x16 signed, LAT 2), NC = ceil(N_FEAT / 4) issue cycles (8).
// Latency 12 cycles (accept -> out_valid), II 13 cycles with out_ready = 1 (14 when a swap is pending).
//
// Numerics: acc is 48-bit signed and exact (|acc| < 2^36). FEAT[i] for i >= N_FEAT is fed as 0, so the padding
// weight W[k][31] (upper half of word 16k+15) is stored and read back but never contributes.
// VALID/HELD with active VER != 0: logits; VALID/HELD with VER == 0: logits 0 and REASON |= NO_MODEL; every other
// status: logits 0. WVER = VER of the bank active at accept, 0 for DROPPED (model: eog_ref.Engine.head). CH3 is
// FEAT[3], RULES and CD are copied, the header is copied.
//
// Weight banks (69-word image, numerics.md section 8): two banks, bank_q is the active one.
//   words 16k+j (k < N_CLS, j < 2*NC): per class, even words in mem_e, odd words in mem_o (index {bank, j >> 1});
//   words 64+k (k < N_CLS): bias_q; word 68 ([4:0] S_OUT, [15:8] VER; all 32 bits stored): w68_q.
//   Other addresses: writes ignored, read back 0. Writes (wb_we) go to the bank that is inactive in the cycle of
//   the write (also in the cycle a swap happens), never to the active bank; writes while rst_n = 0 are ignored.
//   wb_rdata = the inactive bank's word wb_raddr, registered (1 cycle; read-first: a write to the same word in the
//   same cycle is not visible yet).
//   rst_n clears word 68 of both banks (VER = 0, no model), selects bank 0 and drops a pending swap; the other
//   words are not reset (undefined until written). eog_top drives rst_n with the engine reset, which includes
//   CTRL.soft_reset (see the spec question in the task report).
// Swap: swap_req sets swap_pending from the next cycle; requests while swap_pending = 1 coalesce. The swap happens
// in the first S_IDLE cycle with swap_pending = 1: active_bank toggles and swap_pending falls at the same edge.

module eog_head #(
    // N_FAC, N_WELL, II: uniform stage interface (conventions section 6), unused here (TASKS.md spec question 11)
    /* verilator lint_off UNUSEDPARAM */
    parameter integer N_FAC  = 32,
    parameter integer N_WELL = 8,
    parameter integer II     = 16,
    /* verilator lint_on UNUSEDPARAM */
    parameter integer N_FEAT = 31,   // 1..31
    parameter integer N_CLS  = 4     // 1..4
) (
    input  logic          clk,
    input  logic          rst_n,
    input  logic          in_valid,
    output logic          in_ready,
    input  logic [662:0]  in_data,        // bus C (EOG_BC_W)
    output logic          out_valid,
    input  logic          out_ready,
    output logic [254:0]  out_data,       // bus L (EOG_BL_W)
    input  logic          wb_we,          // write one word of the inactive bank
    input  logic [6:0]    wb_addr,        // word index 0..68 of the weight image
    input  logic [31:0]   wb_wdata,
    input  logic [6:0]    wb_raddr,       // readback address (inactive bank)
    output logic [31:0]   wb_rdata,       // readback data, 1 cycle after wb_raddr
    input  logic          swap_req,       // pulse: make the inactive bank active at the next record boundary
    output logic          swap_pending,
    output logic          active_bank,
    output logic [7:0]    active_ver
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

    localparam logic [1:0] S_IDLE = 2'd0, S_MAC = 2'd1, S_FIN = 2'd2, S_OUT = 2'd3;

    // ---------------------------------------------------------------------------------------------------
    // control and record registers
    logic [1:0]          st;
    logic [KW-1:0]       cnt;
    logic [EOG_BC_W-1:0] in_r;      // the held record (bus C)
    logic [7:0]          ver_r;     // VER of the bank active at accept
    logic [4:0]          sout_r;    // S_OUT of the bank active at accept
    logic                bank_q;    // active bank
    logic                pend_q;    // swap pending
    logic [63:0]         w68_q;     // word 68 of bank 0 at [31:0], bank 1 at [63:32]

    logic take, do_swap, acc_en, fin, wr_ok;
    assign in_ready  = (st == S_IDLE) && !pend_q;
    assign take      = in_valid && in_ready;
    assign do_swap   = (st == S_IDLE) && pend_q;
    assign acc_en    = (st == S_MAC) && (cnt >= KW'(MLAT));
    assign fin       = (st == S_FIN);
    assign out_valid = (st == S_OUT);
    assign wr_ok     = wb_we && rst_n;

    assign active_bank  = bank_q;
    assign swap_pending = pend_q;

    logic [7:0] act_ver;
    logic [4:0] act_sout;
    assign act_ver    = bank_q ? w68_q[32 + 8 +: 8] : w68_q[8 +: 8];
    assign act_sout   = bank_q ? w68_q[32 +: 5]     : w68_q[0 +: 5];
    assign active_ver = act_ver;

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            st     <= S_IDLE;
            cnt    <= '0;
            pend_q <= 1'b0;
            bank_q <= 1'b0;
            w68_q  <= '0;
        end else begin
            // word 68 of the inactive bank
            if (wb_we && wb_addr == 7'd68) begin
                if (bank_q) w68_q[31:0]  <= wb_wdata;
                else        w68_q[63:32] <= wb_wdata;
            end
            // swap: requests while pending coalesce; the swap itself only in S_IDLE (no record held)
            if (pend_q) begin
                if (do_swap) begin
                    pend_q <= 1'b0;
                    bank_q <= ~bank_q;
                end
            end else if (swap_req) begin
                pend_q <= 1'b1;
            end
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
            ver_r  <= act_ver;
            sout_r <= act_sout;
        end
    end

    // ---------------------------------------------------------------------------------------------------
    // fields of the held record
    logic [EOG_BC_STATUS_W-1:0] r_status;
    logic                       r_vh, r_mac, r_nomodel;
    logic [7:0]                 r_wver;
    assign r_status  = in_r[EOG_BC_STATUS +: EOG_BC_STATUS_W];
    assign r_vh      = (r_status == EOG_ST_VALID) || (r_status == EOG_ST_HELD);
    assign r_mac     = r_vh && (ver_r != 8'd0);
    assign r_nomodel = r_vh && (ver_r == 8'd0);
    assign r_wver    = (r_status == EOG_ST_DROPPED) ? 8'd0 : ver_r;

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
    // weight-port address decode (write: wb_addr, readback: wb_raddr; both on the inactive bank)
    logic       w_isw, w_isb, w_cok, w_odd;
    logic [1:0] w_cls, w_bk;
    logic [2:0] w_cf;
    logic [CW-1:0] w_c;
    assign w_isw = !wb_addr[6];                       // 0..63: W words
    assign w_isb = (wb_addr[6:2] == 5'b10000);        // 64..67: biases
    assign w_cls = wb_addr[5:4];
    assign w_cf  = wb_addr[3:1];
    assign w_c   = w_cf[CW-1:0];
    assign w_cok = ({1'b0, w_cf} < 4'(NC));
    assign w_odd = wb_addr[0];
    assign w_bk  = wb_addr[1:0];

    logic       r_isw, r_isb, r_is68, r_cok, r_odd;
    logic [1:0] r_cls, r_bk;
    logic [2:0] r_cf;
    logic [CW-1:0] r_c;
    assign r_isw  = !wb_raddr[6];
    assign r_isb  = (wb_raddr[6:2] == 5'b10000);
    assign r_is68 = (wb_raddr == 7'd68);
    assign r_cls  = wb_raddr[5:4];
    assign r_cf   = wb_raddr[3:1];
    assign r_c    = r_cf[CW-1:0];
    assign r_cok  = ({1'b0, r_cf} < 4'(NC));
    assign r_odd  = wb_raddr[0];
    assign r_bk   = wb_raddr[1:0];

    logic wbank;                                      // the inactive bank (writes and readback)
    assign wbank = ~bank_q;

    // ---------------------------------------------------------------------------------------------------
    // multipliers: q = MPC*k + m computes W[k][4c+m] * FEAT[4c+m]
    wire [16*NMUL-1:0]  wop;       // weight operands
    wire [32*NMUL-1:0]  prod;      // products, MLAT cycles later
    wire [32*N_CLS-1:0] rb_cls;    // per-class readback contribution (0 unless the address is that class's)
    wire [16*N_CLS-1:0] logit_all;

    genvar q;
    generate
        for (q = 0; q < NMUL; q = q + 1) begin : g_mul
            eog_mul #(.AW(16), .BW(16), .A_SIGNED(1), .B_SIGNED(1), .LAT(MLAT)) u_mul (
                .clk (clk),
                .a   (wop[16*q +: 16]),
                .b   (fop[16*(q % MPC) +: 16]),
                .p   (prod[32*q +: 32])
            );
        end
    endgenerate

    // ---------------------------------------------------------------------------------------------------
    // per class: weight storage, accumulator, output rounding
    genvar k;
    generate
        for (k = 0; k < N_CLS; k = k + 1) begin : g_cls
            localparam logic [1:0] KID = 2'(k);

            logic [31:0] mem_e [2*NCP];     // word 16k+2c   = {W[k][4c+1], W[k][4c]},   index {bank, c}
            logic [31:0] mem_o [2*NCP];     // word 16k+2c+1 = {W[k][4c+3], W[k][4c+2]}, index {bank, c}
            logic [63:0] bias_q;            // B[k]: bank 0 at [31:0], bank 1 at [63:32]

            logic wsel;
            assign wsel = wr_ok && w_isw && (w_cls == KID) && w_cok;
            always_ff @(posedge clk) begin
                if (wsel && !w_odd) mem_e[{wbank, w_c}] <= wb_wdata;
                if (wsel &&  w_odd) mem_o[{wbank, w_c}] <= wb_wdata;
                if (wr_ok && w_isb && (w_bk == KID)) begin
                    if (wbank) bias_q[63:32] <= wb_wdata;
                    else       bias_q[31:0]  <= wb_wdata;
                end
            end

            // MAC operands: words 2c and 2c+1 of the active bank
            logic [31:0] rd_e, rd_o;
            assign rd_e = mem_e[{bank_q, cc}];
            assign rd_o = mem_o[{bank_q, cc}];
            assign wop[64*k +: 64] = {rd_o, rd_e};

            // readback of the inactive bank
            logic [31:0] rb_w, rb_b;
            assign rb_b = wbank ? bias_q[63:32] : bias_q[31:0];
            assign rb_w = (r_isw && (r_cls == KID) && r_cok) ? (r_odd ? mem_o[{wbank, r_c}] : mem_e[{wbank, r_c}])
                        : (r_isb && (r_bk == KID))           ? rb_b
                        :                                      32'h0;
            assign rb_cls[32*k +: 32] = rb_w;

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

            // LOGIT = sat16((acc + (S_OUT > 0 ? 2^(S_OUT-1) : 0)) >>> S_OUT); never overflows (|acc| < 2^36)
            logic [ACC_W-1:0]        rnd;
            logic signed [ACC_W-1:0] rsum, rsh;
            logic                    fits;
            logic [15:0]             logit_n, logit_q;
            assign rnd     = (ACC_W'(1) << sout_r) >> 1;
            assign rsum    = acc + $signed(rnd);
            assign rsh     = rsum >>> sout_r;
            assign fits    = (rsh[ACC_W-1:15] == '0) || (rsh[ACC_W-1:15] == '1);
            assign logit_n = fits ? rsh[15:0] : (rsh[ACC_W-1] ? 16'h8000 : 16'h7FFF);
            always_ff @(posedge clk) begin
                if (fin) logit_q <= r_mac ? logit_n : 16'h0;
            end
            assign logit_all[16*k +: 16] = logit_q;
        end
    endgenerate

    // readback: OR of the per-class contributions and word 68
    logic [31:0] rb_any;
    always_comb begin
        rb_any = r_is68 ? (wbank ? w68_q[63:32] : w68_q[31:0]) : 32'h0;
        for (int i = 0; i < N_CLS; i++) rb_any = rb_any | rb_cls[32*i +: 32];
    end
    always_ff @(posedge clk) wb_rdata <= rb_any;

    // ---------------------------------------------------------------------------------------------------
    // output bus L
    logic [EOG_BL_REASON_W-1:0] r_reason;
    always_comb begin
        r_reason = in_r[EOG_BC_REASON +: EOG_BC_REASON_W];
        if (r_nomodel) r_reason[EOG_R_NO_MODEL] = 1'b1;
    end

    always_comb begin
        out_data = '0;
        out_data[EOG_BL_REC_NO      +: EOG_BL_REC_NO_W]      = in_r[EOG_BC_REC_NO      +: EOG_BC_REC_NO_W];
        out_data[EOG_BL_IN_LAST     +: EOG_BL_IN_LAST_W]     = in_r[EOG_BC_IN_LAST     +: EOG_BC_IN_LAST_W];
        out_data[EOG_BL_FAC_RAW     +: EOG_BL_FAC_RAW_W]     = in_r[EOG_BC_FAC_RAW     +: EOG_BC_FAC_RAW_W];
        out_data[EOG_BL_FAC         +: EOG_BL_FAC_W]         = in_r[EOG_BC_FAC         +: EOG_BC_FAC_W];
        out_data[EOG_BL_TS          +: EOG_BL_TS_W]          = in_r[EOG_BC_TS          +: EOG_BC_TS_W];
        out_data[EOG_BL_STATUS      +: EOG_BL_STATUS_W]      = r_status;
        out_data[EOG_BL_REASON      +: EOG_BL_REASON_W]      = r_reason;
        out_data[EOG_BL_SINCE_RESET +: EOG_BL_SINCE_RESET_W] = in_r[EOG_BC_SINCE_RESET +: EOG_BC_SINCE_RESET_W];
        out_data[EOG_BL_HIST_RESET  +: EOG_BL_HIST_RESET_W]  = in_r[EOG_BC_HIST_RESET  +: EOG_BC_HIST_RESET_W];
        out_data[EOG_BL_CH3         +: EOG_BL_CH3_W]         = in_r[EOG_BC_FEAT + 16 * 3 +: EOG_BL_CH3_W];
        out_data[EOG_BL_RULES       +: EOG_BL_RULES_W]       = in_r[EOG_BC_RULES       +: EOG_BC_RULES_W];
        out_data[EOG_BL_CD          +: EOG_BL_CD_W]          = in_r[EOG_BC_CD          +: EOG_BC_CD_W];
        out_data[EOG_BL_LOGITS      +: 16 * N_CLS]           = logit_all;
        out_data[EOG_BL_WVER        +: EOG_BL_WVER_W]        = r_wver;
    end

`ifdef FORMAL
    // ---- conventions section 7 observation ports: one record at a time, held in in_r from accept to transfer ----
    assign f_inflight     = (st == S_IDLE) ? 8'd0 : 8'd1;
    assign f_oldest_recno = in_r[EOG_BC_REC_NO +: EOG_BC_REC_NO_W];

    // ---- internal invariants (own state only; help k-induction) ----
    // the MAC counter never passes the last accumulate
    always_comb if (rst_n && st == S_MAC) fi_cnt: assert (cnt <= KW'(LASTC));
    // no swap and no write to the active bank while a record is held: its VER / S_OUT snapshot stays current
    always_comb if (rst_n && st != S_IDLE) fi_bank: assert (ver_r == act_ver && sout_r == act_sout);
`endif
endmodule
