/* fake_regs.c — see fake_regs.h. Behavior is regmap.md; nothing here is RTL-accurate timing. */
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 199309L
#endif
#include "fake_regs.h"

#include <string.h>
#include <time.h>

#include "../eog_proto.h"

fake_regs_t FR;

uint32_t fr_ms(void)
{
    if (FR.use_real_clock) {
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        return (uint32_t)((uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u);
    }
    return FR.ms;
}

uint32_t hal_ms(void) { return fr_ms(); }

void fr_reset(void)
{
    memset(&FR, 0, sizeof FR);
    FR.n_fac = 32;
    FR.swap_immediate = 1;
    FR.engine = fr_echo_engine;
    FR.global[0] = 17u | (4u << 16);
}

static uint32_t hb_timeout(void) { return FR.global[1] >> 16; }   /* GLOBAL bytes 6-7 */

static uint32_t ms_since_hb(void)
{
    if (!FR.hb_seen) return 65535;
    uint32_t d = fr_ms() - FR.last_hb_ms;
    return d > 65535 ? 65535 : d;
}

int fr_autonomous(void)
{
    uint32_t t = hb_timeout();
    return t != 0 && ms_since_hb() >= t;
}

static void stat_inc(unsigned i) { if (FR.stats[i] != 0xFFFFFFFFu) FR.stats[i]++; }

void fr_push_result(const uint8_t r[32])
{
    memcpy(FR.res[(FR.res_head + FR.res_n) % FR_RES_DEPTH], r, 32);
    FR.res_n++;
    /* STATS words 1-9 come from the RESULT tap (status/reason of each record leaving the engine) */
    uint8_t st = r[2];
    uint32_t reason = eog_le32(r + 8);
    stat_inc(EOG_HS_RES_OUT);
    if (st == 0) stat_inc(EOG_HS_VALID);
    if (st == 1) stat_inc(EOG_HS_HELD);
    if (st == 3) stat_inc(EOG_HS_INVALID);
    if (st == 4 && (reason & (1u << 8))) stat_inc(EOG_HS_DUP);
    if (st == 4 && (reason & (1u << 9))) stat_inc(EOG_HS_OOO);
    if (st == 4 && (reason & (1u << 10))) stat_inc(EOG_HS_UNKNOWN);
    if (st == 4 && (reason & (1u << 12))) stat_inc(EOG_HS_FRAMING);
    if (st != 4 && (reason & (1u << 2))) stat_inc(EOG_HS_HIST_RESET);
}

void fr_push_alert(const uint8_t a[16])
{
    if (FR.al_n == FR_AL_DEPTH) { stat_inc(EOG_HS_ALERT_DROP); return; }
    memcpy(FR.al[(FR.al_head + FR.al_n) % FR_AL_DEPTH], a, 16);
    FR.al_n++;
    stat_inc(EOG_HS_ALERTS);
}

/* RESULT = fac_id, status VALID, ts echo, logits 0, rules 0, active version, countdown 0xFFFF, result_no. */
void fr_echo_engine(const uint8_t rec[48], int autonomous)
{
    (void)autonomous;
    uint8_t r[32] = {0};
    r[0] = rec[0]; r[1] = rec[1];
    memcpy(r + 4, rec + 4, 4);
    r[21] = (uint8_t)FR.active_ver;
    memset(r + 22, 0xFF, 6);
    eog_put32(r + 28, FR.result_no++);
    fr_push_result(r);
}

static void run_engine(void)
{
    while (FR.busy && FR.res_n < FR_RES_DEPTH) {
        FR.busy = 0;
        stat_inc(EOG_HS_REC_IN);
        FR.engine(FR.pending, fr_autonomous());
        if (FR.swap_pending) fr_swap_now();      /* record boundary */
    }
}

void fr_swap_now(void)
{
    if (!FR.swap_pending) return;
    FR.swap_pending = 0;
    FR.active_bank ^= 1;
    FR.active_ver = FR.wwin[70] & 0xFF;
    FR.swapped = 1;
}

static uint32_t status(void)
{
    uint32_t rn = FR.res_n > 255 ? 255 : FR.res_n, an = FR.al_n > 255 ? 255 : FR.al_n;
    return (uint32_t)fr_autonomous() | (FR.swap_pending << 1) | (FR.active_bank << 2) | ((FR.res_n != 0) << 3)
           | ((FR.al_n != 0) << 4) | ((uint32_t)FR.busy << 5) | (rn << 8) | (an << 16) | (FR.active_ver << 24);
}

uint32_t hal_reg_read(uint32_t off)
{
    FR.n_reads++;
    if (off == EOG_R_ID) return EOG_ID_VALUE;
    if (off == EOG_R_VERSION) return 4u | (FR.n_fac << 8) | (8u << 16);
    if (off == EOG_R_CTRL) return FR.ctrl;
    if (off == EOG_R_STATUS) return status();
    if (off >= EOG_R_GLOBAL && off < EOG_R_GLOBAL + 32) {
        uint32_t w = FR.global[(off - EOG_R_GLOBAL) / 4];
        if (off == EOG_R_GLOBAL) w = (w & 0xFF00FF00u) | 17u | (4u << 16);
        return w;
    }
    if (off >= EOG_R_ALERT && off < EOG_R_ALERT + 16) {
        if (!FR.al_n) return 0;
        uint32_t w = eog_le32(FR.al[FR.al_head] + (off - EOG_R_ALERT));
        if (off == EOG_R_ALERT + 12) { FR.al_head = (FR.al_head + 1) % FR_AL_DEPTH; FR.al_n--; }
        return w;
    }
    if (off >= EOG_R_STATS && off < EOG_R_STATS + 64) {
        unsigned i = (off - EOG_R_STATS) / 4;
        if (i == EOG_HS_MS_SINCE_HB) return ms_since_hb();
        if (i == EOG_HS_UPTIME_MS) return fr_ms();
        return FR.stats[i];
    }
    if (off >= EOG_R_RESULT && off < EOG_R_RESULT + 32) {
        if (!FR.res_n) return 0;
        uint32_t w = eog_le32(FR.res[FR.res_head] + (off - EOG_R_RESULT));
        if (off == EOG_R_RESULT + 28) {
            FR.res_head = (FR.res_head + 1) % FR_RES_DEPTH;
            FR.res_n--;
            run_engine();
        }
        return w;
    }
    if (off >= EOG_R_CONFIG && off < EOG_R_CONFIG + 32 * 64) {
        unsigned f = (off - EOG_R_CONFIG) / 64, w = (off - EOG_R_CONFIG) % 64 / 4;
        uint32_t v = FR.cfg[f][w];
        if (w == 0) v = (v & 0xFFFF0000u) | f;
        return v;
    }
    if (off >= EOG_R_WEIGHTS && off <= EOG_R_WVER) return FR.wwin[(off - EOG_R_WEIGHTS) / 4];
    return 0;
}

void hal_reg_write(uint32_t off, uint32_t v)
{
    FR.n_writes++;
    if (off == EOG_R_CTRL) {
        FR.ctrl = v & (EOG_CTRL_STREAM_EN | EOG_CTRL_SRC_DMA);
        if (v & EOG_CTRL_SOFT_RST) {
            FR.pulses_soft++;
            FR.res_n = FR.al_n = 0;
            FR.busy = 0;
        }
        if (v & EOG_CTRL_STATS_CLR) { FR.pulses_stats_clr++; memset(FR.stats, 0, sizeof FR.stats); }
        if (v & EOG_CTRL_HB) { FR.pulses_hb++; FR.hb_seen = 1; FR.last_hb_ms = fr_ms(); }
        if (v & EOG_CTRL_SWAP_REQ) {
            FR.pulses_swap++;
            FR.swap_pending = 1;
            if (FR.swap_immediate && !FR.busy) fr_swap_now();
        }
        return;
    }
    if (off >= EOG_R_GLOBAL && off < EOG_R_GLOBAL + 32) {
        if (FR.ctrl & EOG_CTRL_STREAM_EN) { FR.global_ignored++; return; }
        FR.global[(off - EOG_R_GLOBAL) / 4] = v;
        FR.cfg_dirty = 1;
        return;
    }
    if (off == EOG_R_LEDOVR || off == EOG_R_DBGSEL) return;
    if (off >= EOG_R_DATA && off < EOG_R_DATA + 48) {
        FR.data[(off - EOG_R_DATA) / 4] = v;
        if (off == EOG_R_DATA + 44) {
            if (!(FR.ctrl & EOG_CTRL_STREAM_EN)) return;     /* engine input not ready: nothing taken */
            if (FR.busy) { stat_inc(EOG_HS_OVERRUN); return; }
            for (unsigned i = 0; i < 12; i++) eog_put32(FR.pending + 4 * i, FR.data[i]);
            FR.busy = 1;
            run_engine();
        }
        return;
    }
    if (off >= EOG_R_CONFIG && off < EOG_R_CONFIG + 32 * 64) {
        unsigned f = (off - EOG_R_CONFIG) / 64, w = (off - EOG_R_CONFIG) % 64 / 4;
        if (f >= FR.n_fac) return;
        int enabled = (FR.cfg[f][0] >> 24) & 1;
        if (enabled && !(w == 0 && !((v >> 24) & 1))) { FR.cfg_ignored++; return; }
        FR.cfg[f][w] = v;
        FR.touch[f]++;
        FR.touched_mask |= 1u << f;
        FR.cfg_dirty = 1;
        return;
    }
    if (off >= EOG_R_WEIGHTS && off <= EOG_R_WVER) { FR.wwin[(off - EOG_R_WEIGHTS) / 4] = v; return; }
}
