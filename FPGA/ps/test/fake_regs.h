/*
 * fake_regs.h — a software model of the eog_regs AXI-Lite window (FPGA/spec/regmap.md, spec v4) for host tests
 * of eog_proto. It implements hal_reg_read/hal_reg_write and hal_ms; the engine behind the DATA window is a
 * callback (an echo engine by default, Mudit's features_int.py through simboard + simboard_bridge.py).
 */
#ifndef FAKE_REGS_H
#define FAKE_REGS_H

#include <stdint.h>

#define FR_RES_DEPTH 64
#define FR_AL_DEPTH  64

typedef void (*fr_engine_fn)(const uint8_t rec[48], int autonomous);

typedef struct {
    uint32_t ctrl;                 /* stream_en | src_dma */
    uint32_t global[8];
    uint32_t cfg[32][16];
    uint32_t wwin[71];             /* inactive bank window */
    uint32_t active_ver, active_bank, swap_pending;
    int      swap_immediate;       /* 1: a swap request executes at once (idle engine) */
    uint32_t stats[16];
    uint32_t data[12];
    uint8_t  pending[48];          /* a pushed record waiting for RESULT FIFO room (data_busy) */
    int      busy;
    uint8_t  res[FR_RES_DEPTH][32]; unsigned res_head, res_n;
    uint8_t  al[FR_AL_DEPTH][16];  unsigned al_head, al_n;
    uint32_t ms;                   /* fake clock (hal_ms) */
    uint32_t last_hb_ms; int hb_seen;
    uint32_t n_fac;
    uint32_t result_no;
    unsigned n_reads, n_writes;
    unsigned touch[32];            /* accepted CONFIG writes per slot */
    unsigned pulses_hb, pulses_swap, pulses_soft, pulses_stats_clr;
    unsigned global_ignored;       /* GLOBAL writes dropped because stream_en = 1 */
    unsigned cfg_ignored;          /* CONFIG writes dropped by the enabled-slot rule */
    int      cfg_dirty;            /* GLOBAL or CONFIG changed since fr_take_cfg_dirty() */
    int      swapped;              /* a swap executed since fr_take_swapped() */
    int      use_real_clock;       /* simboard: hal_ms from CLOCK_MONOTONIC */
    fr_engine_fn engine;
} fake_regs_t;

extern fake_regs_t FR;

void fr_reset(void);                         /* power-up state, echo engine */
void fr_push_result(const uint8_t r[32]);    /* engine output */
void fr_push_alert(const uint8_t a[16]);
void fr_echo_engine(const uint8_t rec[48], int autonomous);
int  fr_autonomous(void);
void fr_swap_now(void);                      /* execute a pending swap */
uint32_t fr_ms(void);

#endif
