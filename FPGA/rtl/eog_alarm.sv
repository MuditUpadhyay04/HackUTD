// eog_alarm.sv -- persistence counters, Night Shift / E-STOP latches, ALERT pushes, acknowledge sweep,
// heartbeat / autonomous, BTN0 debounce, LEDs and Pmods.  Spec v4: spec/modules/eog_alarm.md, numerics.md §9
// (D7 strict '>', D8 both latches held until acknowledged, D10 per-class K).
//
// LOCAL ALARM SIGNALS ONLY (global_plan hard rule 8): nothing here is wired to equipment.
//
// Structure (one record at a time):
//   accept (cycle t)  : read the slot's counters/latches, compute hit/cnt/ns_c/es_c, write the new state,
//                       load the bus-A output register and the (up to 2) pending ALERT flags.
//                       VALID/HELD: counters (from 0 if HIST_RESET), conditions, latches, ALERTs.
//                       INVALID: counters cleared only.  DROPPED / codes 2, 5..7 / FAC >= N_FAC: nothing.
//   t+1 ...           : out_valid = 1 until it transfers; pending ALERTs pushed one per cycle in the order
//                       NS_RAISED, ES_RAISED, CLEARED(NS), CLEARED(ES).
//   in_ready = 1 again once the output has transferred and no ALERT is pending (II = 2, 3 with two ALERTs).
//   Acknowledge (ack_srv pulse or debounced BTN0 press) is applied between records: in the first cycle with no
//   record ALERT pending, no sweep running and no input accepted in that cycle. latch &= cond for both vectors;
//   one ACKED ALERT per cleared bit follows on consecutive cycles (lowest slot first, NS before ES within a slot),
//   in_ready = 0 meanwhile.
module eog_alarm #(
    parameter integer N_FAC      = 32,
    // II is part of the common parameter set (conventions §6); this stage needs no cycle budget (II <= 3).
    /* verilator lint_off UNUSEDPARAM */
    parameter integer II         = 16,
    /* verilator lint_on UNUSEDPARAM */
    parameter integer CYC_PER_MS = 100000,
    parameter integer DEB_MS     = 10
) (
    input  logic         clk,
    input  logic         rst_n,
    // bus L in
    input  logic         in_valid,
    output logic         in_ready,
    input  logic [254:0] in_data,      // EOG_BL_W
    // bus A out
    output logic         out_valid,
    input  logic         out_ready,
    output logic [242:0] out_data,     // EOG_BA_W
    // GLOBAL CONFIG: only PERSIST_K, PERSIST_K4, LOGIT_THR, GAP_THR, HB_TIMEOUT_MS are used here
    /* verilator lint_off UNUSEDSIGNAL */
    input  logic [255:0] glb,
    /* verilator lint_on UNUSEDSIGNAL */
    input  logic         hb_pulse,
    input  logic         ack_srv,
    input  logic         btn0,
    // ALERT FIFO push
    output logic         al_valid,
    output logic [127:0] al_data,
    input  logic         al_full,
    output logic         al_drop,
    output logic         autonomous,
    output logic [15:0]  ms_since_hb,
    // LEDOVR register: bits [30:24] and [7:6] are not used
    /* verilator lint_off UNUSEDSIGNAL */
    input  logic [31:0]  ledovr,
    /* verilator lint_on UNUSEDSIGNAL */
    output logic [2:0]   ld0,
    output logic [2:0]   ld1,
    output logic [7:0]   pmod_ja,
    output logic [7:0]   pmod_jb
`ifdef FORMAL
    , output logic [7:0]  f_inflight      // records accepted whose bus-A output has not yet transferred
    , output logic [31:0] f_oldest_recno  // REC_NO of that record (don't-care when f_inflight == 0)
`endif
);
    // the shared header defines every spec constant (it waives UNUSEDPARAM for the ones not used here)
    `include "eog_defs.svh"

    localparam integer FW  = EOG_BL_FAC_W;                          // 5
    localparam integer PW  = (CYC_PER_MS < 2) ? 1 : $clog2(CYC_PER_MS);
    localparam integer DMS = (DEB_MS < 1) ? 1 : DEB_MS;             // debounce length in ms (>= 1)
    localparam integer DW  = (DMS < 2) ? 1 : $clog2(DMS);

    // ------------------------------------------------------------------ input record fields
    logic [FW-1:0] in_fac;
    logic [2:0]    in_st;
    logic          is_vh, is_inv, in_range, in_fire, upd, upd_vh, in_hist;
    logic [31:0]   in_fac32;

    assign in_fac   = in_data[EOG_BL_FAC +: EOG_BL_FAC_W];
    assign in_st    = in_data[EOG_BL_STATUS +: EOG_BL_STATUS_W];
    assign in_hist  = in_data[EOG_BL_HIST_RESET];
    assign is_vh    = (in_st == EOG_ST_VALID) || (in_st == EOG_ST_HELD);
    assign is_inv   = (in_st == EOG_ST_INVALID);
    assign in_fac32 = {{(32-FW){1'b0}}, in_fac};
    assign in_range = (in_fac32 < N_FAC);
    assign in_fire  = in_valid && in_ready;
    // DROPPED (and the never-produced codes 2, 5..7) change no state; INVALID only clears the counters;
    // VALID/HELD also update conditions and latches and raise ALERTs
    assign upd      = in_fire && in_range && (is_vh || is_inv);
    assign upd_vh   = in_fire && in_range && is_vh;

    // ------------------------------------------------------------------ per-facility state
    logic [8*N_FAC-1:0] c0_q, c1_q, c2_q, c3_q, lk_q;   // cnt[0..3], leak_cnt (u8 saturating)
    logic [N_FAC-1:0]   ns_latch, es_latch, ns_cond, es_cond;

    // read the record's slot
    logic [31:0] c_rd;    // cnt[k] of the slot at [8k+7:8k]
    logic [7:0] lk_rd;
    logic       nsl_rd, esl_rd, nsc_rd, esc_rd;

    always_comb begin
        c_rd   = 32'd0;
        lk_rd  = 8'd0;
        nsl_rd = 1'b0; esl_rd = 1'b0; nsc_rd = 1'b0; esc_rd = 1'b0;
        for (int i = 0; i < N_FAC; i++) begin
            if (in_fac32 == i) begin
                c_rd[8*0 +: 8] = c0_q[8*i +: 8];
                c_rd[8*1 +: 8] = c1_q[8*i +: 8];
                c_rd[8*2 +: 8] = c2_q[8*i +: 8];
                c_rd[8*3 +: 8] = c3_q[8*i +: 8];
                lk_rd   = lk_q[8*i +: 8];
                nsl_rd  = ns_latch[i];
                esl_rd  = es_latch[i];
                nsc_rd  = ns_cond[i];
                esc_rd  = es_cond[i];
            end
        end
    end

    // ------------------------------------------------------------------ numerics.md §9
    // K[k] = PERSIST_K4[k] != 0 ? PERSIST_K4[k] : max(PERSIST_K, 1)   (D10)
    logic [7:0]  g_k, k_fb;
    logic [31:0] g_k4;
    logic [31:0] kk;      // K[k] at [8k+7:8k]
    logic [3:0]  hit, cls_act;
    logic [31:0] c_old;   // cnt[k] before this record's update (0 after a history reset)
    logic [31:0] c_nx;    // new cnt[k] at [8k+7:8k]
    logic [7:0]  lk_old, lk_nx;
    logic        gap_hit, leak_hit, es_c, ns_c, rule_any;
    logic [3:0]  cls_out;

    assign g_k    = glb[EOG_G_PERSIST_K  +: EOG_G_PERSIST_K_W];
    assign g_k4   = glb[EOG_G_PERSIST_K4 +: EOG_G_PERSIST_K4_W];
    assign k_fb   = (g_k == 8'd0) ? 8'd1 : g_k;
    // a non-DROPPED HIST_RESET record clears the counters before its own update
    assign c_old  = in_hist ? 32'd0 : c_rd;
    assign lk_old = in_hist ? 8'd0  : lk_rd;

    always_comb begin
        for (int k = 0; k < 4; k++) begin
            kk[8*k +: 8] = (g_k4[8*k +: 8] != 8'd0) ? g_k4[8*k +: 8] : k_fb;
            // strict, signed (D7)
            hit[k]  = $signed(in_data[EOG_BL_LOGITS + 16*k +: 16]) > $signed(glb[EOG_G_LOGIT_THR + 16*k +: 16]);
            // INVALID (not VALID/HELD) clears the counter
            c_nx[8*k +: 8] = (is_vh && hit[k])
                           ? ((c_old[8*k +: 8] == 8'hFF) ? 8'hFF : c_old[8*k +: 8] + 8'd1) : 8'd0;
            cls_act[k] = is_vh && (c_nx[8*k +: 8] >= kk[8*k +: 8]);
        end
    end

    assign gap_hit  = $signed(in_data[EOG_BL_CH3 +: EOG_BL_CH3_W]) > $signed(glb[EOG_G_GAP_THR +: EOG_G_GAP_THR_W]);
    assign leak_hit = is_vh && hit[0] && gap_hit;
    assign lk_nx    = leak_hit ? ((lk_old == 8'hFF) ? 8'hFF : lk_old + 8'd1) : 8'd0;
    assign es_c     = is_vh && (lk_nx >= kk[7:0]);        // E-STOP uses K[0]
    assign rule_any = (in_data[EOG_BL_RULES +: 4] != 4'd0);
    assign ns_c     = is_vh && (rule_any || (cls_act != 4'd0));
    assign cls_out  = upd ? cls_act : 4'd0;

    // ------------------------------------------------------------------ record / ALERT / ack control
    logic [242:0]     out_q;
    logic             out_valid_q;
    logic [3:0]       al_pend;      // [0] NS_RAISED [1] ES_RAISED [2] CLEARED NS [3] CLEARED ES
    logic             auto_q;       // autonomous when the record was accepted
    logic [N_FAC-1:0] ackp_ns, ackp_es;   // ACKED alerts still to push
    logic             sweeping;
    logic             ack_req, ack_now, ack_apply;
    logic             btn_press;

    assign sweeping  = (ackp_ns != '0) || (ackp_es != '0);
    assign ack_now   = ack_srv || btn_press;
    assign ack_apply = (ack_now || ack_req) && (al_pend == 4'd0) && !sweeping && !in_fire;

    assign in_ready  = !out_valid_q && (al_pend == 4'd0) && !sweeping && !ack_req;
    assign out_valid = out_valid_q;
    assign out_data  = out_q;

    // bus A assembly from bus L
    logic [242:0] out_nx;
    always_comb begin
        out_nx = '0;
        out_nx[EOG_BA_REC_NO      +: EOG_BA_REC_NO_W]      = in_data[EOG_BL_REC_NO      +: EOG_BL_REC_NO_W];
        out_nx[EOG_BA_IN_LAST     +: EOG_BA_IN_LAST_W]     = in_data[EOG_BL_IN_LAST     +: EOG_BL_IN_LAST_W];
        out_nx[EOG_BA_FAC_RAW     +: EOG_BA_FAC_RAW_W]     = in_data[EOG_BL_FAC_RAW     +: EOG_BL_FAC_RAW_W];
        out_nx[EOG_BA_FAC         +: EOG_BA_FAC_W]         = in_data[EOG_BL_FAC         +: EOG_BL_FAC_W];
        out_nx[EOG_BA_TS          +: EOG_BA_TS_W]          = in_data[EOG_BL_TS          +: EOG_BL_TS_W];
        out_nx[EOG_BA_STATUS      +: EOG_BA_STATUS_W]      = in_data[EOG_BL_STATUS      +: EOG_BL_STATUS_W];
        out_nx[EOG_BA_REASON      +: EOG_BA_REASON_W]      = in_data[EOG_BL_REASON      +: EOG_BL_REASON_W];
        out_nx[EOG_BA_SINCE_RESET +: EOG_BA_SINCE_RESET_W] = in_data[EOG_BL_SINCE_RESET +: EOG_BL_SINCE_RESET_W];
        out_nx[EOG_BA_HIST_RESET  +: EOG_BA_HIST_RESET_W]  = in_data[EOG_BL_HIST_RESET  +: EOG_BL_HIST_RESET_W];
        out_nx[EOG_BA_RULES       +: EOG_BA_RULES_W]       = in_data[EOG_BL_RULES       +: EOG_BL_RULES_W];
        out_nx[EOG_BA_CD          +: EOG_BA_CD_W]          = in_data[EOG_BL_CD          +: EOG_BL_CD_W];
        out_nx[EOG_BA_LOGITS      +: EOG_BA_LOGITS_W]      = in_data[EOG_BL_LOGITS      +: EOG_BL_LOGITS_W];
        out_nx[EOG_BA_WVER        +: EOG_BA_WVER_W]        = in_data[EOG_BL_WVER        +: EOG_BL_WVER_W];
        out_nx[EOG_BA_CLASSES     +: EOG_BA_CLASSES_W]     = cls_out;
    end

    // ACKED sweep: lowest slot first, NS before ES within a slot
    logic [FW-1:0]    sw_slot;
    logic             sw_es;
    logic [N_FAC-1:0] sw_clr;      // one-hot slot being pushed
    always_comb begin
        sw_slot = '0;
        sw_es   = 1'b0;
        sw_clr  = '0;
        for (int i = N_FAC - 1; i >= 0; i--) begin
            if (ackp_es[i]) begin sw_slot = i[FW-1:0]; sw_es = 1'b1; sw_clr = '0; sw_clr[i] = 1'b1; end
            if (ackp_ns[i]) begin sw_slot = i[FW-1:0]; sw_es = 1'b0; sw_clr = '0; sw_clr[i] = 1'b1; end
        end
    end

    // record ALERT selection (lowest pending flag first)
    logic [1:0] rs;
    always_comb begin
        if      (al_pend[0]) rs = 2'd0;
        else if (al_pend[1]) rs = 2'd1;
        else if (al_pend[2]) rs = 2'd2;
        else                 rs = 2'd3;
    end

    logic       al_want;
    logic [7:0] rec_kind, rec_src;
    logic       q_rule, q_model, rec_es;
    assign al_want = (al_pend != 4'd0) || sweeping;
    assign al_valid = al_want && !al_full;
    assign al_drop  = al_want && al_full;
    assign q_rule   = (out_q[EOG_BA_RULES +: 4] != 4'd0);
    assign q_model  = (out_q[EOG_BA_CLASSES +: EOG_BA_CLASSES_W] != 4'd0);
    assign rec_es   = rs[0];                // flags 1 and 3 are the E-STOP latch type

    // SOURCE (every record ALERT): bit 0 RULES[3:0] != 0, bit 1 class_active != 0, bit 2 AUTONOMOUS,
    // bit 3 reserved (ARM), bit 4 latch type (0 Night Shift, 1 E-STOP)
    assign rec_src  = {3'd0, rec_es, 1'b0, auto_q, q_model, q_rule};
    always_comb begin
        case (rs)
            2'd0:    rec_kind = EOG_AK_NS_RAISED;
            2'd1:    rec_kind = EOG_AK_ES_RAISED;
            default: rec_kind = EOG_AK_CLEARED;
        endcase
    end

    always_comb begin
        al_data = '0;
        if (al_pend != 4'd0) begin
            al_data[EOG_AL_FAC_ID    +: EOG_AL_FAC_ID_W]    = {{(EOG_AL_FAC_ID_W-FW){1'b0}}, out_q[EOG_BA_FAC +: EOG_BA_FAC_W]};
            al_data[EOG_AL_KIND      +: EOG_AL_KIND_W]      = rec_kind;
            al_data[EOG_AL_SOURCE    +: EOG_AL_SOURCE_W]    = rec_src;
            al_data[EOG_AL_TS        +: EOG_AL_TS_W]        = out_q[EOG_BA_TS +: EOG_BA_TS_W];
            al_data[EOG_AL_RESULT_NO +: EOG_AL_RESULT_NO_W] = out_q[EOG_BA_REC_NO +: EOG_BA_REC_NO_W];
            al_data[EOG_AL_RULES     +: EOG_AL_RULES_W]     = {3'd0, out_q[EOG_BA_RULES +: EOG_BA_RULES_W]};
            al_data[EOG_AL_CLASSES   +: EOG_AL_CLASSES_W]   = {4'd0, out_q[EOG_BA_CLASSES +: EOG_BA_CLASSES_W]};
            al_data[EOG_AL_CD_P10    +: EOG_AL_CD_P10_W]    = out_q[EOG_BA_CD +: 16];
        end else if (sweeping) begin
            // ACKED: TS, RESULT_NO, RULES, CLASSES 0, CD_P10 0xFFFF; SOURCE = latch type only (TASKS #4)
            al_data[EOG_AL_FAC_ID    +: EOG_AL_FAC_ID_W]    = {{(EOG_AL_FAC_ID_W-FW){1'b0}}, sw_slot};
            al_data[EOG_AL_KIND      +: EOG_AL_KIND_W]      = EOG_AK_ACKED;
            al_data[EOG_AL_SOURCE    +: EOG_AL_SOURCE_W]    = {3'd0, sw_es, 4'd0};
            al_data[EOG_AL_CD_P10    +: EOG_AL_CD_P10_W]    = EOG_CD_NONE;
        end
    end

    // ------------------------------------------------------------------ sequential: record, latches, ack
    always_ff @(posedge clk) begin
        if (!rst_n) begin
            c0_q <= '0; c1_q <= '0; c2_q <= '0; c3_q <= '0; lk_q <= '0;
            ns_latch <= '0; es_latch <= '0; ns_cond <= '0; es_cond <= '0;
            out_q <= '0; out_valid_q <= 1'b0;
            al_pend <= 4'd0; auto_q <= 1'b0;
            ackp_ns <= '0; ackp_es <= '0; ack_req <= 1'b0;
        end else begin
            // output handshake
            if (in_fire) begin
                out_q       <= out_nx;
                out_valid_q <= 1'b1;
                auto_q      <= autonomous;
            end else if (out_valid_q && out_ready) begin
                out_valid_q <= 1'b0;
            end

            // record ALERTs (VALID/HELD only): pending flags loaded at accept, one consumed per cycle
            // (pushed or dropped). CLEARED: the old cond = 1, the new cond = 0 (the latch is then still set).
            if (upd_vh) begin
                al_pend <= {esc_rd && !es_c && esl_rd,
                            nsc_rd && !ns_c && nsl_rd,
                            es_c && !esl_rd,
                            ns_c && !nsl_rd};
            end else if (al_pend != 4'd0) begin
                al_pend[rs] <= 1'b0;
            end

            // per-facility state update: counters on VALID/HELD and INVALID (cleared), conditions and
            // latches on VALID/HELD only; history resets never touch the latches
            for (int i = 0; i < N_FAC; i++) begin
                if (upd && in_fac32 == i) begin
                    c0_q[8*i +: 8] <= c_nx[8*0 +: 8];
                    c1_q[8*i +: 8] <= c_nx[8*1 +: 8];
                    c2_q[8*i +: 8] <= c_nx[8*2 +: 8];
                    c3_q[8*i +: 8] <= c_nx[8*3 +: 8];
                    lk_q[8*i +: 8] <= lk_nx;
                end
                if (upd_vh && in_fac32 == i) begin
                    ns_latch[i]    <= ns_latch[i] | ns_c;
                    es_latch[i]    <= es_latch[i] | es_c;
                    ns_cond[i]     <= ns_c;
                    es_cond[i]     <= es_c;
                end
            end

            // acknowledge: latch &= cond, remember the cleared bits for the ACKED sweep
            if (ack_apply) begin
                ns_latch <= ns_latch & ns_cond;
                es_latch <= es_latch & es_cond;
                ackp_ns  <= ns_latch & ~ns_cond;
                ackp_es  <= es_latch & ~es_cond;
                ack_req  <= 1'b0;
            end else begin
                if (ack_now) ack_req <= 1'b1;
                if (sweeping) begin
                    if (sw_es) ackp_es <= ackp_es & ~sw_clr;
                    else       ackp_ns <= ackp_ns & ~sw_clr;
                end
            end
        end
    end

    // ------------------------------------------------------------------ heartbeat
    logic [PW-1:0] hb_pre;
    logic [15:0]   ms_q;
    logic          hb_toggle;
    logic [15:0]   hb_to;

    assign hb_to       = glb[EOG_G_HB_TIMEOUT_MS +: EOG_G_HB_TIMEOUT_MS_W];
    assign ms_since_hb = ms_q;
    assign autonomous  = (hb_to != 16'd0) && (ms_q >= hb_to);

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            hb_pre    <= '0;
            ms_q      <= 16'hFFFF;
            hb_toggle <= 1'b0;
        end else if (hb_pulse) begin
            hb_pre    <= '0;
            ms_q      <= 16'd0;
            hb_toggle <= !hb_toggle;
        end else if ({{(32-PW){1'b0}}, hb_pre} == CYC_PER_MS - 1) begin
            hb_pre <= '0;
            if (ms_q != 16'hFFFF) ms_q <= ms_q + 16'd1;
        end else begin
            hb_pre <= hb_pre + 1'b1;
        end
    end

    // ------------------------------------------------------------------ BTN0: 2-flop sync + debounce
    // The debounced level follows the synchronized input after it has differed for DEB_MS * CYC_PER_MS
    // consecutive cycles; a press is its 0 -> 1 edge (BTN0 active high).
    logic          btn_m, btn_s, btn_deb;
    logic [PW-1:0] deb_cyc;
    logic [DW-1:0] deb_ms;
    logic          deb_cyc_end, deb_ms_end;

    assign deb_cyc_end = ({{(32-PW){1'b0}}, deb_cyc} == CYC_PER_MS - 1);
    assign deb_ms_end  = ({{(32-DW){1'b0}}, deb_ms}  == DMS - 1);

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            btn_m     <= 1'b0;
            btn_s     <= 1'b0;
            btn_deb   <= 1'b0;
            deb_cyc   <= '0;
            deb_ms    <= '0;
            btn_press <= 1'b0;
        end else begin
            btn_m     <= btn0;
            btn_s     <= btn_m;
            btn_press <= 1'b0;
            if (btn_s == btn_deb) begin
                deb_cyc <= '0;
                deb_ms  <= '0;
            end else if (deb_cyc_end) begin
                deb_cyc <= '0;
                if (deb_ms_end) begin
                    deb_ms    <= '0;
                    btn_deb   <= btn_s;
                    btn_press <= btn_s;
                end else begin
                    deb_ms <= deb_ms + 1'b1;
                end
            end else begin
                deb_cyc <= deb_cyc + 1'b1;
            end
        end
    end

    // ------------------------------------------------------------------ LED timing (free-running ms tick)
    logic [PW-1:0] fr_pre;
    logic          fr_tick;
    logic [8:0]    blink_ms;     // 0..499: 2 Hz, on for the first 250 ms
    logic [9:0]    fault_age;    // ms since the last INVALID/DROPPED record, saturating at 1000 (= none)
    logic [7:0]    pwm_cnt;
    logic          pwm_on, blink_on, fault_on;

    assign fr_tick  = ({{(32-PW){1'b0}}, fr_pre} == CYC_PER_MS - 1);
    assign pwm_on   = (pwm_cnt[7:6] == 2'b00);          // 64 of 256 cycles = 25 % duty
    assign blink_on = (blink_ms < 9'd250);
    assign fault_on = (fault_age < 10'd1000);

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            fr_pre    <= '0;
            blink_ms  <= 9'd0;
            fault_age <= 10'd1000;
            pwm_cnt   <= 8'd0;
        end else begin
            pwm_cnt <= pwm_cnt + 8'd1;
            if (fr_tick) begin
                fr_pre   <= '0;
                blink_ms <= (blink_ms >= 9'd499) ? 9'd0 : blink_ms + 9'd1;
            end else begin
                fr_pre <= fr_pre + 1'b1;
            end
            if (in_fire && !is_vh)                      fault_age <= 10'd0;
            else if (fr_tick && fault_age < 10'd1000)  fault_age <= fault_age + 10'd1;
        end
    end

    // ------------------------------------------------------------------ LEDs and Pmods
    logic          any_es, any_ns;
    logic [FW-1:0] worst;
    logic [2:0]    ld0_col, ld1_col;

    assign any_es = (es_latch != '0);
    assign any_ns = (ns_latch != '0);

    always_comb begin
        worst = '0;
        if (any_es) begin
            for (int i = N_FAC - 1; i >= 0; i--) if (es_latch[i]) worst = i[FW-1:0];
        end else begin
            for (int i = N_FAC - 1; i >= 0; i--) if (ns_latch[i]) worst = i[FW-1:0];
        end
    end

    always_comb begin
        if (fault_on)        ld0_col = {blink_on, 2'b00};   // red, blinking 2 Hz
        else if (autonomous) ld0_col = 3'b001;              // blue
        else                 ld0_col = 3'b010;              // green
        if (any_es)          ld1_col = 3'b100;              // red
        else if (any_ns)     ld1_col = 3'b110;              // amber
        else                 ld1_col = 3'b000;
    end

    always_comb begin
        if (ledovr[31]) begin
            ld0     = ledovr[2:0];
            ld1     = ledovr[5:3];
            pmod_ja = ledovr[15:8];
            pmod_jb = ledovr[23:16];
        end else begin
            ld0     = pwm_on ? ld0_col : 3'b000;
            ld1     = pwm_on ? ld1_col : 3'b000;
            pmod_ja = {4'b0000, hb_toggle, autonomous, any_ns, any_es};
            pmod_jb = {2'b00, any_es || any_ns, worst};     // FW = EOG_BL_FAC_W = 5
        end
    end

    // ------------------------------------------------------------------ formal: exports + internal invariants
`ifdef FORMAL
    assign f_inflight     = {7'd0, out_valid_q};
    assign f_oldest_recno = out_q[EOG_BA_REC_NO +: EOG_BA_REC_NO_W];

    always_comb begin
        if (rst_n) begin
            // cond implies latch; E-STOP condition implies Night Shift condition
            fi_cond_latch_ns: assert ((ns_cond & ~ns_latch) == '0);
            fi_cond_latch_es: assert ((es_cond & ~es_latch) == '0);
            fi_es_in_ns:      assert ((es_cond & ~ns_cond) == '0);
            // record ALERTs and the ACKED sweep never overlap; nothing is accepted while either is pending
            fi_excl:          assert (!((al_pend != 4'd0) && sweeping));
            // a slot still to be ACKED has its latch and condition clear (no record runs during a sweep)
            fi_sweep_ns:      assert ((ackp_ns & (ns_latch | ns_cond)) == '0);
            fi_sweep_es:      assert ((ackp_es & (es_latch | es_cond)) == '0);
            // at most two record ALERTs: {NS_RAISED, ES_RAISED} or {CLEARED NS, CLEARED ES} or one alone
            // (es_c implies ns_c, and an old es_cond implies an old ns_cond and ns_latch)
            fi_al_ns:         assert (!(al_pend[0] && al_pend[2]));
            fi_al_es:         assert (!(al_pend[1] && al_pend[3]));
            fi_al_x0:         assert (!(al_pend[0] && al_pend[3]));
            fi_al_x1:         assert (!(al_pend[1] && al_pend[2]));
            // counters in range
            fi_hb_pre:        assert ({{(32-PW){1'b0}}, hb_pre}  < ((CYC_PER_MS < 1) ? 1 : CYC_PER_MS));
            fi_fr_pre:        assert ({{(32-PW){1'b0}}, fr_pre}  < ((CYC_PER_MS < 1) ? 1 : CYC_PER_MS));
            fi_deb_cyc:       assert ({{(32-PW){1'b0}}, deb_cyc} < ((CYC_PER_MS < 1) ? 1 : CYC_PER_MS));
            fi_deb_ms:        assert ({{(32-DW){1'b0}}, deb_ms}  < DMS);
            fi_blink:         assert (blink_ms < 9'd500);
            fi_fault:         assert (fault_age <= 10'd1000);
            fi_press:         assert (!btn_press || btn_deb);
        end
    end

    // leak counter never exceeds the leak-class counter
    logic [N_FAC-1:0] f_leak_ok;
    always_comb for (int i = 0; i < N_FAC; i++) f_leak_ok[i] = (lk_q[8*i +: 8] <= c0_q[8*i +: 8]);
    always_comb if (rst_n) fi_leak_le_c0: assert (&f_leak_ok);
`endif
endmodule
