// fv_eog_head.sv -- formal harness for eog_head (spec/modules/eog_head.md, numerics.md section 8 with D11/D12;
// spec v4 plus Lucas's rulings #23 (NO_MODEL kept) and #25 (DROPPED -> WVER 0)). Verify role, task T1.head.fv.
// Written from the spec's port table only: the harness uses the DUT's ports and its formal observation ports
// (conventions section 7), never an internal signal.
//
// Weight window (per bank, 71 words; Mudit's blob, D11): word 1 [7:0] = S_OUT (byte 4); W[k][i] (s16) at byte
// 8 + 2(31k + i), i.e. word 2 + ((31k+i) >> 1), half (31k+i) & 1; B[k] = word 64 + k; word 70 [7:0] = VER.
// Words 0, 1 [31:8], 68, 69 are carried (read back) but ignored by the logits.
//
// Property map (labels in sby logs; the "Required properties" list of the module spec):
//
//   stage contract  u_in.ax_* (assumed), u_out.ax_* (handshake, conventions section 2), u_stage.st_order /
//                   st_no_ghost / st_inflight / st_cnt / st_link_n / st_link_r / st_ii / st_lat
//                   (one in, one out, in order via REC_NO; II <= 16; latency <= LAT_MAX)
//   HDR             header pass-through: REC_NO, IN_LAST, FAC_RAW, FAC, TS, STATUS, SINCE_RESET, HIST_RESET copied;
//                   REASON = in.REASON | (NO_MODEL if VALID/HELD and the accept-time active_ver = 0)
//   CPY             CH3 = FEAT[3], RULES and CD copied, for every status
//   WV              WVER = active_ver in the accept cycle; 0 for DROPPED (ruling #25)
//   H1              logits come from the bank active in the accept cycle: the harness snapshots its shadow of that
//                   bank at the accept of an anyconst record and predicts the logits from the snapshot (labels
//                   H1H6_logit / H1H5_logit / H7_addr). With H2_bnd/H2_prio no swap falls inside a record and H3
//                   keeps the active bank unchanged by writes
//   H2_once         active_bank toggles only on a pending request (or one in that cycle): one swap per swap_req,
//                   requests while pending coalesce, including in the swap cycle (#17)
//   H2_pend         swap_pending is 1 exactly from swap_req until the swap (registered, or also combinationally
//                   in the swap_req cycle); a hard reset clears it, a soft reset does not
//   H2_fall         swap_pending falls only in the cycle active_bank toggles
//   H2_bnd          a swap happens only with no record in flight (between an output transfer and the next accept)
//   H2_prio         no record is accepted while a swap is pending (#18: the swap wins the idle cycle)
//   H2_live         a pending swap happens within SWAP_MAX cycles once no record is in flight and rst_n = 1
//   H3_ver          active_ver always equals the VER (word 70 [7:0]) the harness shadow holds for the active bank:
//                   writes never modify the active bank's VER; a swap makes the written bank's VER active
//   RB              wb_rdata, 1 cycle after wb_raddr, equals the harness shadow of the inactive bank, all 32 bits of
//                   every window word (catches a write that modified the active bank once that bank is inactive
//                   again: H3 for every word; and an aliasing write between shadowed words)
//   RST             after a hard reset (wb_rst_n = 0) active_ver = 0 (word 70 of both banks reads 0, via the
//                   shadow), active_bank = 0, swap_pending = 0 (via H2_pend)
//   SRST_bank/_ver  a soft reset (rst_n = 0, wb_rst_n = 1) leaves active_bank and active_ver unchanged and a pending
//                   swap pending (H2_pend) without executing; the shadow ignores rst_n, so RB / H3_ver check that
//                   every window word, readback included, survives it (spec v3)
//   WIGN            (through RB / H3_ver) writes while rst_n = 0 or wb_rst_n = 0 are ignored: the shadow drops them
//   H4_zero         active_ver = 0 at accept, or STATUS INVALID/DROPPED -> LOGITS = 0
//   H4_nm           NO_MODEL (reason bit 13) set iff VALID/HELD and active_ver = 0 at accept (#23)
//   H6 (H1H6_logit) every term W*FEAT known zero (acc = B): LOGIT = sat16((B + 2^(S_OUT-1)) >>> S_OUT), every S_OUT
//                   0..31, any B
//   H5 (H1H5_logit) real multipliers: LOGIT = sat16((sum W*FEAT + B + rnd) >>> S_OUT), 64-bit harness sum (the
//                   accumulator is observable only through the logits; S_OUT up to 31 exposes its high bits)
//   H7 (H7_addr)    weight addressing at the real layout (N_FEAT = 31): anyconst column i; the harness shadows
//                   the four words holding W[0..3][i]. A class whose W[k][i] is written 0 and whose other features
//                   are 0 must give exactly sat16((B + rnd) >>> S_OUT): if the RTL fetched W[k][i] from any other
//                   byte (another class, feature, half or an unwritten word), the solver puts a nonzero value there
//   H8_when         dbg_valid with REC_NO r only for a VALID/HELD record with FAC == dbg_fac, while it is in flight
//                   (accepted, output not yet transferred, transfer cycle included), at most once
//   H8_data         at that pulse dbg_rec_no = its REC_NO and dbg_feat = its 31 features
//   H8_logit(_b)    dbg_logits = its output LOGITS (whichever comes first)
//   H8_live         a qualifying record has had its pulse by the cycle its output transfers
//   covers          C_swap (a swap between two records, both with a model), C_sat (a saturated logit), C_sat5 (a
//                   saturated logit predicted from nonzero terms), C_nomodel, C_coalesce (a request while pending,
//                   then one swap), C_rb (a readback checked), C_srst (a record with a model after a soft reset),
//                   C_dbg (a debug capture)
//
// Parameters (set per task in eog_head.sby):
//   N_FEAT        features used by the DUT (bus C still carries 31; the window layout is unchanged)
//   MUL_REAL      1 when the task reads rtl/eog_mul.sv (enables H1H5_logit), 0 with the abstract multiplier
//   SH            weight-window shadow: 0 = VER of word 70 only, with wb_raddr assumed 70 so both banks' VER are
//                 observed every cycle (inductive; prove); 1 = {anyconst word A, S_OUT, B[0..3], VER};
//                 2 = SH 1 + every word holding a W[k][i < N_FEAT]; 3 = SH 1 + the 4 words of anyconst column i (H7)
//   FSET / WSET   assumed operand sets (real-multiplier tasks): 0 free; 2 {0, 1, -1, 32767, -32768};
//                 3 (features) {0} + {2^j, j = 0..14}
//   WR            1: writes and reads only touch shadowed words (bmc run time)
//   MAX_INFLIGHT  records the DUT may hold (the spec does not bound it; 4 leaves room for a pipelined head)
//   LAT_MAX       st_lat bound (spec: 128)
//   SWAP_MAX      H2_live bound (the spec says "next record boundary" without a number; 16 = II_MAX)
//   II_EXCL_SWAP  1 excludes cycles with a pending swap from st_ii (the spec does not; default 0 = strict)
//
// Input assumptions (upstream contract, eog_countdown -> eog_head; eog_regs -> weight and debug ports):
//   STATUS in {VALID, HELD, INVALID, DROPPED}; REASON[NO_MODEL] = 0 (only the head sets it). FEAT, RULES and CD are
//   free for every status.
//   wb_we: wb_addr <= 70; word 70 [31:8] written 0 (VER is [7:0]); word 1 [7:5] written 0 (S_OUT <= 31); a weight
//   half with feature index >= N_FEAT written 0, and at reduced N_FEAT only words the DUT uses are written (no
//   effect at N_FEAT = 31). Writes during either reset are allowed (and must be ignored). No swap_req while
//   rst_n = 0.
//   Resets (spec v3): wb_rst_n = 0 in the first cycle and wb_rst_n = 0 -> rst_n = 0 (a hard reset resets both);
//   rst_n alone (soft reset) is free.
//   dbg_fac (eog_regs DBGSEL) changes only while no record is in flight.

module fv_eog_head #(
    parameter integer N_FEAT       = 31,
    parameter integer MUL_REAL     = 0,
    parameter integer SH           = 0,
    parameter integer FSET         = 0,
    parameter integer WSET         = 0,
    parameter integer WR           = 0,
    parameter integer MAX_INFLIGHT = 4,
    parameter integer LAT_MAX      = 128,
    parameter integer SWAP_MAX     = 16,
    parameter integer II_EXCL_SWAP = 0
) (
    input logic         clk,          // top-level inputs are free: the solver drives them
    input logic         rst_n,
    input logic         wb_rst_n,     // spec v3: weight-store (hard) reset
    input logic         in_valid,
    input logic [662:0] in_data,      // EOG_BC_W
    input logic         out_ready,
    input logic         wb_we,
    input logic [6:0]   wb_addr,
    input logic [31:0]  wb_wdata,
    input logic [6:0]   wb_raddr,
    input logic         swap_req,
    input logic [4:0]   dbg_fac
);
    `include "eog_defs.svh"

    // Reason bit 13 NO_MODEL: restored by ruling #23 (TASKS.md), but the v4 eog_defs.svh has no EOG_R_NO_MODEL yet.
    localparam integer F_R_NO_MODEL = 13;

    localparam integer NSH = (SH == 0) ? 1 : (SH == 1) ? 7 : (SH == 2) ? (7 + 4 * N_FEAT) : 11;
    localparam integer SS  = 1;                    // shadow slot of word 1 (S_OUT)        (SH >= 1)
    localparam integer SB  = 2;                    // shadow slots of words 64..67 (B[k])  (SH >= 1)
    localparam integer SM  = (SH == 0) ? 0 : 6;    // shadow slot of word 70 (VER)
    localparam integer ST  = 7;                    // first weight-word slot (SH 2, 3)

    // ------------------------------------------------------------------------------------------------- DUT
    logic         in_ready, out_valid;
    logic [254:0] out_data;
    logic [31:0]  wb_rdata;
    logic         swap_pending, active_bank;
    logic [7:0]   active_ver;
    logic         dbg_valid;
    logic [495:0] dbg_feat;
    logic [63:0]  dbg_logits;
    logic [31:0]  dbg_rec_no;
    logic [7:0]   dut_inflight;
    logic [31:0]  dut_oldest;

    eog_head #(.II(16), .N_FEAT(N_FEAT), .N_CLS(4)) dut (
        .clk(clk), .rst_n(rst_n), .wb_rst_n(wb_rst_n),
        .in_valid(in_valid), .in_ready(in_ready), .in_data(in_data),
        .out_valid(out_valid), .out_ready(out_ready), .out_data(out_data),
        .wb_we(wb_we), .wb_addr(wb_addr), .wb_wdata(wb_wdata), .wb_raddr(wb_raddr), .wb_rdata(wb_rdata),
        .swap_req(swap_req), .swap_pending(swap_pending), .active_bank(active_bank), .active_ver(active_ver),
        .dbg_fac(dbg_fac), .dbg_valid(dbg_valid), .dbg_feat(dbg_feat), .dbg_logits(dbg_logits),
        .dbg_rec_no(dbg_rec_no),
        .f_inflight(dut_inflight), .f_oldest_recno(dut_oldest));

    // ------------------------------------------------------------------------------------- shared checkers
    logic f_past_valid;
    eog_fv_init u_init (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid));

    eog_fv_axis #(.W(EOG_BC_W), .ASSUME(1)) u_in (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(in_valid), .ready(in_ready), .data(in_data));
    eog_fv_axis #(.W(EOG_BL_W), .ASSUME(0)) u_out (.clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .valid(out_valid), .ready(out_ready), .data(out_data));

    logic       f_pend;       // harness model: a swap was requested and has not happened yet
    logic       f_excl;
    logic [7:0] f_in_cnt, f_out_cnt, f_in_flight;
    assign f_excl = (II_EXCL_SWAP != 0) && (f_pend || swap_pending);

    eog_fv_stage #(.RW(8), .MAX_INFLIGHT(MAX_INFLIGHT), .II_MAX(16), .LAT_MAX(LAT_MAX), .SWEEP(0)) u_stage (
        .clk(clk), .rst_n(rst_n), .f_past_valid(f_past_valid),
        .in_valid(in_valid), .in_ready(in_ready), .in_recno(in_data[EOG_BC_REC_NO +: 8]),
        .out_valid(out_valid), .out_ready(out_ready), .out_recno(out_data[EOG_BL_REC_NO +: 8]),
        .excl(f_excl), .dut_inflight(dut_inflight), .dut_oldest(dut_oldest),
        .f_in_cnt(f_in_cnt), .f_out_cnt(f_out_cnt), .f_in_flight(f_in_flight));

    logic in_fire, out_fire;
    assign in_fire  = in_valid && in_ready;
    assign out_fire = out_valid && out_ready;

    // ---------------------------------------------------------------------------------------------- helpers
    function automatic logic is_vh(input logic [2:0] st);
        is_vh = (st == EOG_ST_VALID) || (st == EOG_ST_HELD);
    endfunction

    function automatic logic small5(input logic [15:0] x);
        small5 = (x == 16'h0000) || (x == 16'h0001) || (x == 16'hFFFF) || (x == 16'h7FFF) || (x == 16'h8000);
    endfunction

    // 0 or a positive power of two below 2^15: its 32-bit sign extension is one-hot, so a product is one shifted row
    function automatic logic pos_p2(input logic [15:0] x);
        pos_p2 = !x[15] && ((x & (x - 16'd1)) == 16'd0);
    endfunction

    function automatic logic opnd_ok(input integer set, input logic [15:0] x);
        opnd_ok = (set == 2) ? small5(x) : (set == 3) ? pos_p2(x) : 1'b1;
    endfunction

    // window word holding W[k][i], and the half (0 = [15:0], 1 = [31:16])
    function automatic logic [6:0] w_word(input integer k, input integer i);
        w_word = 7'(2 + ((31 * k + i) >> 1));
    endfunction
    function automatic logic w_half(input integer k, input integer i);
        w_half = 1'((31 * k + i) & 1);
    endfunction

    // feature index of half h of window word w (2..63)
    function automatic logic [4:0] half_feat(input logic [6:0] w, input logic h);
        logic [6:0] f;
        f = 7'((w - 7'd2) << 1) + {6'd0, h};
        half_feat = 5'(f % 7'd31);
    endfunction

    // a word the DUT uses at N_FEAT (every word at N_FEAT = 31)
    function automatic logic used_word(input logic [6:0] w);
        if (w < 7'd2 || w > 7'd63) used_word = 1'b1;
        else used_word = (32'(half_feat(w, 1'b0)) < N_FEAT) || (32'(half_feat(w, 1'b1)) < N_FEAT);
    endfunction

    // numerics.md section 8: sat16((acc + (S_OUT > 0 ? 2^(S_OUT-1) : 0)) >>> S_OUT)
    function automatic logic [15:0] logit_of(input logic signed [63:0] acc, input logic [4:0] s);
        logic signed [63:0] r;
        r = acc + ((s == 5'd0) ? 64'sd0 : (64'sd1 <<< (s - 5'd1)));
        r = r >>> s;
        if (r > 64'sd32767)       logit_of = 16'h7FFF;
        else if (r < -64'sd32768) logit_of = 16'h8000;
        else                      logit_of = r[15:0];
    endfunction

    // ------------------------------------------------------------------------------------ input assumptions
    logic [2:0]  i_status;
    logic [30:0] i_fset_ok;
    assign i_status = in_data[EOG_BC_STATUS +: EOG_BC_STATUS_W];

    always_comb begin
        i_fset_ok = '1;
        for (int i = 0; i < N_FEAT; i++)
            i_fset_ok[i] = opnd_ok(FSET, in_data[EOG_BC_FEAT + 16 * i +: 16]);
    end

    always_comb begin
        if (in_valid) begin
            a_status: assume (is_vh(i_status) || i_status == EOG_ST_INVALID || i_status == EOG_ST_DROPPED);
            a_nm:     assume (!in_data[EOG_BC_REASON + F_R_NO_MODEL]);
            a_fset:   assume (&i_fset_ok);
        end
    end

    // weight port
    logic [15:0] w_lo, w_hi;
    assign w_lo = wb_wdata[15:0];
    assign w_hi = wb_wdata[31:16];

    always_comb begin
        if (!f_past_valid) a_hard0: assume (!wb_rst_n);
        if (!wb_rst_n)     a_hard:  assume (!rst_n);
        if (!rst_n)        a_rreq:  assume (!swap_req);
        if (wb_we) begin
            a_wb_addr: assume (wb_addr <= 7'd70 && used_word(wb_addr));
            if (wb_addr == 7'd70) a_wb_ver:  assume (wb_wdata[31:8] == 24'd0);
            if (wb_addr == 7'd1)  a_wb_sout: assume (wb_wdata[7:5] == 3'd0);
            if (wb_addr >= 7'd2 && wb_addr <= 7'd63) begin
                a_wb_pad: assume ((32'(half_feat(wb_addr, 1'b0)) < N_FEAT || w_lo == 16'd0)
                                  && (32'(half_feat(wb_addr, 1'b1)) < N_FEAT || w_hi == 16'd0));
                a_wset:   assume (opnd_ok(WSET, w_lo) && opnd_ok(WSET, w_hi));
            end
        end
        if (SH == 0) a_rb70: assume (wb_raddr == 7'd70);
    end

    // ------------------------------------------------------------------------------- previous-cycle values
    logic       p_rst, p_wbrst, p_bank, p_req_or, p_swap_pending;
    logic [7:0] p_ver;
    logic [4:0] p_dbg_fac;
    initial begin
        p_rst    = 1'b0;
        p_wbrst  = 1'b0;
        p_req_or = 1'b0;
    end
    always_ff @(posedge clk) begin
        p_rst          <= rst_n;
        p_wbrst        <= wb_rst_n;
        p_bank         <= active_bank;
        p_ver          <= active_ver;
        p_swap_pending <= swap_pending;
        p_req_or       <= wb_rst_n && (f_pend || swap_req);     // only a hard reset clears a pending swap
        p_dbg_fac      <= dbg_fac;
    end

    always_comb if (f_past_valid && f_in_flight != 8'd0) a_dbg_fac: assume (dbg_fac == p_dbg_fac);

    // a swap = active_bank toggling at a clock edge outside a hard reset
    logic f_toggle;
    assign f_toggle = f_past_valid && p_wbrst && (active_bank != p_bank);
    assign f_pend   = p_req_or && !f_toggle;

    // ------------------------------------------------------------------------------------------------- H2
    logic [7:0] f_swait;          // cycles a pending swap has waited with no record in flight
    initial f_swait = '0;
    always_ff @(posedge clk) begin
        if (!rst_n || !f_pend || f_in_flight != 8'd0) f_swait <= '0;
        else if (f_swait != 8'hFF)                     f_swait <= f_swait + 1'b1;
    end

    always_comb begin
        if (f_past_valid) begin
            H2_pend: assert ((swap_pending == f_pend) || (swap_req && swap_pending));
            if (p_wbrst) begin
                if (f_toggle) begin
                    H2_once: assert (p_req_or);
                    H2_bnd:  assert (f_in_flight == 8'd0);
                end
                if (p_swap_pending && !swap_pending)
                    H2_fall: assert (f_toggle);
                if (!p_rst) begin
                    SRST_bank: assert (active_bank == p_bank);
                    SRST_ver:  assert (active_ver == p_ver);
                end
            end else begin
                RST: assert (active_ver == 8'd0 && active_bank == 1'b0);
            end
        end
        if (f_past_valid && rst_n) begin
            H2_prio: assert (!(in_fire && f_pend));
            H2_live: assert (f_swait < SWAP_MAX);
        end
    end

    // ------------------------------------------------------------------------------ weight-window shadow
    // Slot j shadows word sh_addr(j) of both banks: value and "known" (written since power-up; word 70 is known 0
    // after every hard reset; rst_n alone leaves the shadow alone). A write goes to the bank inactive in the write
    // cycle (eog_head.md "Behavior"); writes while either reset is 0 are ignored.
    (* anyconst *) logic [6:0] f_a;     // any window word (RB)
    (* anyconst *) logic [4:0] f_i;     // any weight column (H7)
    always_comb begin
        a_fa: assume (f_a <= 7'd70 && used_word(f_a));
        a_fi: assume (32'(f_i) < N_FEAT);
    end

    function automatic logic [6:0] sh_addr(input integer j, input logic [6:0] a, input logic [4:0] fi);
        if (SH == 0)       sh_addr = 7'd70;
        else if (j == 0)   sh_addr = a;
        else if (j == SS)  sh_addr = 7'd1;
        else if (j < SM)   sh_addr = 7'(64 + (j - SB));
        else if (j == SM)  sh_addr = 7'd70;
        else if (SH == 2)  sh_addr = w_word((j - ST) / N_FEAT, (j - ST) % N_FEAT);
        else               sh_addr = 7'(2 + ((31 * (j - ST) + 32'(fi)) >> 1));
    endfunction

    logic [NSH*32-1:0] sh_v0, sh_v1;
    logic [NSH-1:0]    sh_k0, sh_k1;
    initial begin
        sh_k0 = '0;
        sh_k1 = '0;
    end
    always_ff @(posedge clk) begin
        for (int j = 0; j < NSH; j++) begin
            if (!wb_rst_n) begin
                if (sh_addr(j, f_a, f_i) == 7'd70) begin
                    sh_v0[j*32 +: 32] <= 32'd0;
                    sh_v1[j*32 +: 32] <= 32'd0;
                    sh_k0[j]          <= 1'b1;
                    sh_k1[j]          <= 1'b1;
                end
            end else if (rst_n && wb_we && wb_addr == sh_addr(j, f_a, f_i)) begin
                if (active_bank) begin
                    sh_v0[j*32 +: 32] <= wb_wdata;
                    sh_k0[j]          <= 1'b1;
                end else begin
                    sh_v1[j*32 +: 32] <= wb_wdata;
                    sh_k1[j]          <= 1'b1;
                end
            end
        end
    end

    // WR = 1: writes and reads only touch shadowed words (bmc speed: the solver need not track a RAM written at
    // arbitrary addresses; an aliasing write from one shadowed word into another is still caught)
    logic wa_ok, ra_ok;
    always_comb begin
        wa_ok = 1'b0;
        ra_ok = 1'b0;
        for (int j = 0; j < NSH; j++) begin
            if (sh_addr(j, f_a, f_i) == wb_addr)  wa_ok = 1'b1;
            if (sh_addr(j, f_a, f_i) == wb_raddr) ra_ok = 1'b1;
        end
        if (WR != 0 && SH != 0) begin
            if (wb_we) a_wr: assume (wa_ok);
            a_rr: assume (ra_ok);
        end
    end

    // H3_ver: active_ver = VER (word 70 [7:0]) of the active bank's shadow
    logic [31:0] sh_ver_act;
    logic        sh_ver_act_k;
    assign sh_ver_act   = active_bank ? sh_v1[SM*32 +: 32] : sh_v0[SM*32 +: 32];
    assign sh_ver_act_k = active_bank ? sh_k1[SM] : sh_k0[SM];
    always_comb if (f_past_valid && sh_ver_act_k) H3_ver: assert (active_ver == sh_ver_act[7:0]);

    // RB: readback of the inactive bank, 1 cycle after wb_raddr (not across a swap, not for a word written in the
    // read cycle: read-during-write is unspecified; not for a read during a hard reset). Reads during a soft reset
    // are checked (rst_n only flushes the record in flight). SH = 0 compares VER only (S_OUT of the active bank is
    // not observable every cycle, so it is not inductive).
    localparam logic [31:0] RB_MASK = (SH == 0) ? 32'h0000_00FF : 32'hFFFF_FFFF;
    logic        rb_hit, p_rb_chk;
    logic [31:0] rb_exp, p_rb_exp;
    always_comb begin
        rb_hit = 1'b0;
        rb_exp = '0;
        for (int j = 0; j < NSH; j++) begin
            if (sh_addr(j, f_a, f_i) == wb_raddr && (active_bank ? sh_k0[j] : sh_k1[j])) begin
                rb_hit = 1'b1;
                rb_exp = active_bank ? sh_v0[j*32 +: 32] : sh_v1[j*32 +: 32];
            end
        end
    end
    initial p_rb_chk = 1'b0;
    always_ff @(posedge clk) begin
        p_rb_chk <= wb_rst_n && rb_hit && !(rst_n && wb_we && wb_addr == wb_raddr);
        p_rb_exp <= rb_exp;
    end
    always_comb if (f_past_valid && p_rb_chk && active_bank == p_bank) RB: assert ((wb_rdata & RB_MASK) == (p_rb_exp & RB_MASK));

    // ------------------------------------------------------------------------- tracked record (anyconst)
    (* anyconst *) logic [7:0] f_k;
    logic                f_tv;      // record f_k accepted since the last engine reset
    logic                f_tlive;   // ... and its output not yet transferred
    logic                f_tq;      // ... and it qualifies for a debug capture (VALID/HELD, FAC == dbg_fac)
    logic                f_dseen;   // its capture pulse has happened
    logic [63:0]         f_dlog;    // dbg_logits at that pulse
    logic [662:0]        f_td;
    logic [7:0]          f_tver;
    logic [NSH*32-1:0]   f_snap_v;
    logic [NSH-1:0]      f_snap_k;

    logic        o_track, d_track;
    logic [63:0] o_logits;
    assign o_track  = f_past_valid && rst_n && out_valid && f_tv && out_data[EOG_BL_REC_NO +: 8] == f_k;
    assign d_track  = f_past_valid && rst_n && dbg_valid && dbg_rec_no[7:0] == f_k;
    assign o_logits = out_data[EOG_BL_LOGITS +: EOG_BL_LOGITS_W];

    initial begin
        f_tv    = 1'b0;
        f_tlive = 1'b0;
    end
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            f_tv    <= 1'b0;
            f_tlive <= 1'b0;
        end else if (in_fire && in_data[EOG_BC_REC_NO +: 8] == f_k) begin
            f_tv     <= 1'b1;
            f_tlive  <= 1'b1;
            f_tq     <= is_vh(i_status) && in_data[EOG_BC_FAC +: 5] == dbg_fac;
            f_dseen  <= 1'b0;
            f_td     <= in_data;
            f_tver   <= active_ver;
            f_snap_v <= active_bank ? sh_v1 : sh_v0;
            f_snap_k <= active_bank ? sh_k1 : sh_k0;
        end else begin
            if (o_track && out_ready) f_tlive <= 1'b0;
            if (d_track) begin
                f_dseen <= 1'b1;
                f_dlog  <= dbg_logits;
            end
        end
    end

    // expected output fields
    logic [2:0]  t_status;
    logic        t_vh, t_drop, t_nm;
    logic [15:0] t_reason;
    assign t_status = f_td[EOG_BC_STATUS +: EOG_BC_STATUS_W];
    assign t_vh     = is_vh(t_status);
    assign t_drop   = (t_status == EOG_ST_DROPPED);
    assign t_nm     = t_vh && (f_tver == 8'd0);
    assign t_reason = f_td[EOG_BC_REASON +: EOG_BC_REASON_W] | (t_nm ? 16'(1 << F_R_NO_MODEL) : 16'd0);

    logic [113:0] e_hdr, o_hdr;
    assign e_hdr = {f_td[EOG_BC_HIST_RESET], f_td[EOG_BC_SINCE_RESET +: 8], t_reason, t_status,
                    f_td[EOG_BC_TS +: 32], f_td[EOG_BC_FAC +: 5], f_td[EOG_BC_FAC_RAW +: 16],
                    f_td[EOG_BC_IN_LAST], f_td[EOG_BC_REC_NO +: 32]};
    assign o_hdr = {out_data[EOG_BL_HIST_RESET], out_data[EOG_BL_SINCE_RESET +: 8],
                    out_data[EOG_BL_REASON +: EOG_BL_REASON_W], out_data[EOG_BL_STATUS +: EOG_BL_STATUS_W],
                    out_data[EOG_BL_TS +: 32], out_data[EOG_BL_FAC +: 5], out_data[EOG_BL_FAC_RAW +: 16],
                    out_data[EOG_BL_IN_LAST], out_data[EOG_BL_REC_NO +: 32]};

    always_comb begin
        if (o_track) begin
            HDR: assert (o_hdr == e_hdr);
            CPY: assert (out_data[EOG_BL_CH3 +: 16] == f_td[EOG_BC_FEAT + 16 * 3 +: 16]
                         && out_data[EOG_BL_RULES +: EOG_BL_RULES_W] == f_td[EOG_BC_RULES +: EOG_BC_RULES_W]
                         && out_data[EOG_BL_CD +: EOG_BL_CD_W] == f_td[EOG_BC_CD +: EOG_BC_CD_W]);
            WV:  assert (out_data[EOG_BL_WVER +: 8] == (t_drop ? 8'd0 : f_tver));
            if (f_tver == 8'd0 || !t_vh)
                H4_zero: assert (o_logits == 64'd0);
            H4_nm: assert (out_data[EOG_BL_REASON + F_R_NO_MODEL] == t_nm);
            if (f_dseen)
                H8_logit_b: assert (o_logits == f_dlog);
            if (out_ready && f_tq)
                H8_live: assert (f_dseen || d_track);
        end
        if (d_track) begin
            H8_when: assert (f_tv && f_tlive && f_tq && !f_dseen);
            H8_data: assert (dbg_rec_no == f_td[EOG_BC_REC_NO +: 32] && dbg_feat == f_td[EOG_BC_FEAT +: EOG_BC_FEAT_W]);
            if (o_track)
                H8_logit: assert (dbg_logits == o_logits);
        end
    end

    // ------------------------------------------------------------- logit prediction from the snapshot (H1/H5-H7)
    generate
        if (SH != 0) begin : g_pred
            logic [3:0]         pr_ok, pr_z, pr_bad_z, pr_bad_n;
            logic [63:0]        pr_want;           // expected logits, class k at [16k +: 16]
            logic signed [63:0] c_acc;
            logic signed [31:0] c_p;
            logic signed [15:0] c_w, c_f;
            logic [31:0]        c_word;
            logic               c_wk;
            logic [31:0]        sout_w, ver_w;

            assign sout_w = f_snap_v[SS*32 +: 32];
            assign ver_w  = f_snap_v[SM*32 +: 32];

            always_comb begin
                pr_ok   = '0;
                pr_z    = '0;
                pr_want = '0;
                c_acc   = '0;
                c_p     = '0;
                c_w     = '0;
                c_f     = '0;
                c_word  = '0;
                c_wk    = 1'b0;
                for (int k = 0; k < 4; k++) begin
                    c_word   = f_snap_v[(SB + k)*32 +: 32];
                    c_acc    = {{32{c_word[31]}}, c_word};
                    pr_ok[k] = t_vh && f_snap_k[SS] && f_snap_k[SM] && ver_w[7:0] != 8'd0 && f_snap_k[SB + k];
                    pr_z[k]  = 1'b1;
                    for (int i = 0; i < N_FEAT; i++) begin
                        c_f = f_td[EOG_BC_FEAT + 16 * i +: 16];
                        if (c_f != 16'd0) begin
                            if (SH == 2) begin
                                c_word = f_snap_v[(ST + k * N_FEAT + i)*32 +: 32];
                                c_wk   = f_snap_k[ST + k * N_FEAT + i];
                            end else if (SH == 3 && 32'(f_i) == i) begin
                                c_word = f_snap_v[(ST + k)*32 +: 32];
                                c_wk   = f_snap_k[ST + k];
                            end else begin
                                c_word = '0;
                                c_wk   = 1'b0;
                            end
                            c_w = w_half(k, i) ? c_word[31:16] : c_word[15:0];
                            if (!c_wk) pr_ok[k] = 1'b0;
                            else if (c_w != 16'd0) begin
                                pr_z[k] = 1'b0;
                                if (MUL_REAL == 0) pr_ok[k] = 1'b0;
                                c_p   = c_w * c_f;
                                c_acc = c_acc + {{32{c_p[31]}}, c_p};
                            end
                        end
                    end
                    pr_want[16*k +: 16] = logit_of(c_acc, sout_w[4:0]);
                end
            end

            always_comb begin
                for (int k = 0; k < 4; k++) begin
                    pr_bad_z[k] = pr_ok[k] && pr_z[k] && (o_logits[16*k +: 16] != pr_want[16*k +: 16]);
                    pr_bad_n[k] = pr_ok[k] && !pr_z[k] && (o_logits[16*k +: 16] != pr_want[16*k +: 16]);
                end
            end

            always_comb begin
                if (o_track) begin
                    if (SH == 3) H7_addr:    assert (pr_bad_z == 4'd0);
                    else         H1H6_logit: assert (pr_bad_z == 4'd0);
                    H1H5_logit: assert (pr_bad_n == 4'd0);
                end
            end

            always_ff @(posedge clk) if (f_past_valid && rst_n) begin
                C_sat5: cover (o_track && out_ready && (pr_ok & ~pr_z) != 4'd0
                               && (o_logits[15:0] == 16'h7FFF || o_logits[15:0] == 16'h8000));
            end
        end
    endgenerate

    // ------------------------------------------------------------------------------------------------ covers
    logic [7:0] c_last_wver;
    logic       c_nout, c_coal, c_srst;
    initial begin
        c_nout = 1'b0;
        c_coal = 1'b0;
        c_srst = 1'b0;
    end
    always_ff @(posedge clk) begin
        if (!wb_rst_n)                         c_srst <= 1'b0;
        else if (!rst_n && active_ver != 8'd0) c_srst <= 1'b1;
        if (!rst_n) begin
            c_nout <= 1'b0;
            c_coal <= 1'b0;
        end else begin
            if (out_fire) begin
                c_nout      <= 1'b1;
                c_last_wver <= out_data[EOG_BL_WVER +: 8];
            end
            if (swap_req && f_pend) c_coal <= 1'b1;
            else if (f_toggle)      c_coal <= 1'b0;
        end
    end
    always_ff @(posedge clk) if (f_past_valid && rst_n) begin
        C_swap:     cover (out_fire && c_nout && out_data[EOG_BL_WVER +: 8] != c_last_wver
                           && out_data[EOG_BL_WVER +: 8] != 8'd0 && c_last_wver != 8'd0);
        C_sat:      cover (o_track && out_ready && t_vh && f_tver != 8'd0
                           && (o_logits[15:0] == 16'h7FFF || o_logits[15:0] == 16'h8000));
        C_nomodel:  cover (out_fire && out_data[EOG_BL_REASON + F_R_NO_MODEL]);
        C_coalesce: cover (f_toggle && c_coal);
        C_rb:       cover (p_rb_chk && active_bank == p_bank && wb_rdata != 32'd0);
        C_srst:     cover (out_fire && c_srst && out_data[EOG_BL_WVER +: 8] != 8'd0);
        C_dbg:      cover (d_track && f_tver != 8'd0 && dbg_logits != 64'd0);
    end
endmodule
