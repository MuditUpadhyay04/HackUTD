/*
 * eog_proto.h — portable (C99) ARM-side protocol for the EOG engine, wire format v1.
 *
 * Contract C2 (global_plan.md §5); byte layouts follow Mudit's ml/hutd_ml/wire.py (FPGA plan "I/O contract").
 * Registers: FPGA/spec/regmap.md (eog_regs at 0x43C1_0000). No lwIP or Xilinx headers here: the platform
 * supplies the four hal_* functions below (eog_app.c on the board, test/ on a PC).
 *
 * Flow: the platform calls eog_init() once, eog_rx() for every UDP datagram on ports 7000/7003/7004, and
 * eog_poll() every main-loop iteration. eog_poll() drains the RESULT/ALERT FIFOs into the replay rings, sends
 * them while the server is up (STATUS.autonomous = 0), replays them after an outage, and sends STATS every 1 s.
 */
#ifndef EOG_PROTO_H
#define EOG_PROTO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---------- HAL (implemented by the platform) ---------- */
uint32_t hal_reg_read(uint32_t off);                 /* 32-bit read at eog_regs base + off */
void     hal_reg_write(uint32_t off, uint32_t val);  /* 32-bit write (WSTRB = 0xF) */
/* Send one datagram from local port src_port. ip is opaque to this module (the platform's own encoding,
 * e.g. lwIP ip4_addr.addr). Returns 0 on success, nonzero if it could not be queued (retried later). */
int      hal_udp_send(uint16_t src_port, uint32_t dst_ip, uint16_t dst_port, const uint8_t *buf, uint16_t len);
uint32_t hal_ms(void);                               /* free-running millisecond counter (wraps) */

/* ---------- wire format v1 (wire.py) ---------- */
#define EOG_MAGIC          0x46474F45u   /* "EOGF" */
#define EOG_WIRE_VERSION   1
#define EOG_HDR_LEN        16
enum {
    EOG_T_DATA = 1, EOG_T_RESULT, EOG_T_ALERT, EOG_T_CONFIG, EOG_T_CONFIG_ACK,
    EOG_T_WEIGHTS, EOG_T_WEIGHTS_ACK, EOG_T_STATS, EOG_T_HEARTBEAT
};
enum {
    EOG_PORT_DATA = 7000, EOG_PORT_RESULT = 7001, EOG_PORT_ALERT = 7002,
    EOG_PORT_CONFIG = 7003, EOG_PORT_WEIGHTS = 7004, EOG_PORT_MUL = 7777
};
#define EOG_DATA_LEN        48
#define EOG_RESULT_LEN      32
#define EOG_ALERT_LEN       16
#define EOG_GLOBAL_LEN      32
#define EOG_FACCFG_LEN      64
#define EOG_STATS_LEN       64
#define EOG_CONFIG_ACK_LEN  8
#define EOG_WEIGHTS_ACK_LEN 8
#define EOG_RESULT_PER_PKT  45
#define EOG_MAX_FAC         32
#define EOG_MAX_BLOB        1024
#define EOG_BLOB_HDR_LEN    280          /* window words 0..69 */
#define EOG_BLOB_VEC_LEN    70           /* i16[31] features + i16[4] expected logits */
#define EOG_ALERT_SRC_REPLAY 0x08        /* ALERT SOURCE bit 3: set by the ARM on replayed alerts */

/* CONFIG_ACK status */
enum { EOG_CFG_OK = 0, EOG_CFG_BAD_SLOT = 1, EOG_CFG_BAD_VALUE = 2, EOG_CFG_BUSY = 3 };
/* WEIGHTS_ACK status */
enum { EOG_W_OK = 0, EOG_W_CRC = 1, EOG_W_LENGTH = 2, EOG_W_SELFTEST = 3, EOG_W_SWAPPED = 4 };

/* ---------- eog_regs (regmap.md, spec v4) ---------- */
#define EOG_REGS_BASE      0x43C10000u
#define EOG_ID_VALUE       0x31474F45u   /* "EOG1" */
#define EOG_R_ID           0x0000u
#define EOG_R_VERSION      0x0004u
#define EOG_R_CTRL         0x0008u
#define EOG_R_STATUS       0x000Cu
#define EOG_R_GLOBAL       0x0010u
#define EOG_R_ALERT        0x0040u       /* 4 words; reading +0xC pops */
#define EOG_R_LEDOVR       0x0060u
#define EOG_R_DBGSEL       0x0064u
#define EOG_R_STATS        0x0100u       /* 16 words */
#define EOG_R_DATA         0x0200u       /* 12 words; writing +0x2C pushes */
#define EOG_R_RESULT       0x0300u       /* 8 words; reading +0x1C pops */
#define EOG_R_CONFIG       0x1000u       /* slot f at +64 f */
#define EOG_R_WEIGHTS      0x4000u       /* words 0..69 blob, word 70 version */
#define EOG_R_WVER         0x4118u

#define EOG_CTRL_STREAM_EN 0x01u
#define EOG_CTRL_SOFT_RST  0x02u
#define EOG_CTRL_HB        0x04u
#define EOG_CTRL_SWAP_REQ  0x08u
#define EOG_CTRL_SRV_ACK   0x10u
#define EOG_CTRL_SRC_DMA   0x20u
#define EOG_CTRL_STATS_CLR 0x40u

#define EOG_ST_AUTONOMOUS   0x01u
#define EOG_ST_SWAP_PENDING 0x02u
#define EOG_ST_ACTIVE_BANK  0x04u
#define EOG_ST_RESULT_AVAIL 0x08u
#define EOG_ST_ALERT_AVAIL  0x10u
#define EOG_ST_DATA_BUSY    0x20u

/* hardware STATS word indices (regmap.md) */
enum {
    EOG_HS_REC_IN = 0, EOG_HS_RES_OUT, EOG_HS_VALID, EOG_HS_HELD, EOG_HS_INVALID, EOG_HS_DUP, EOG_HS_OOO,
    EOG_HS_UNKNOWN, EOG_HS_FRAMING, EOG_HS_HIST_RESET, EOG_HS_ALERTS, EOG_HS_ALERT_DROP, EOG_HS_OVERRUN,
    EOG_HS_STALL, EOG_HS_MS_SINCE_HB, EOG_HS_UPTIME_MS
};

/* ---------- sizes (override with -D) ---------- */
#ifndef EOG_RES_RING
#define EOG_RES_RING   (1u << 18)   /* RESULT replay ring, records (8 MB); power of 2 */
#endif
#ifndef EOG_AL_RING
#define EOG_AL_RING    (1u << 14)   /* ALERT replay ring, records; power of 2 */
#endif
#ifndef EOG_FLUSH_PKTS
#define EOG_FLUSH_PKTS 64           /* datagrams sent per eog_poll() at most, so receive keeps up */
#endif
#ifndef EOG_DRAIN_MAX
#define EOG_DRAIN_MAX  1024         /* FIFO entries drained per call at most */
#endif
#ifndef EOG_BUSY_SPINS
#define EOG_BUSY_SPINS 10000        /* STATUS.data_busy polls per record before pushing anyway */
#endif
#ifndef EOG_SWAP_TIMEOUT_MS
#define EOG_SWAP_TIMEOUT_MS 100
#endif
#ifndef EOG_DRAIN_TIMEOUT_MS
#define EOG_DRAIN_TIMEOUT_MS 50     /* GLOBAL CONFIG mid-run: wait this long for the pipeline to empty */
#endif
#ifndef EOG_STATS_PERIOD_MS
#define EOG_STATS_PERIOD_MS 1000
#endif

/* ---------- ARM-side counters (also used by the tests) ---------- */
typedef struct {
    uint32_t rx_packets;       /* datagrams handed to eog_rx */
    uint32_t bad_packets;      /* bad header/type/length, DATA before GLOBAL */
    uint32_t data_packets, data_records, data_seq_gaps;
    uint32_t busy_timeouts;    /* records pushed while data_busy was still 1 (hardware drops + counts them) */
    uint32_t results_sent, alerts_sent;
    uint32_t results_dropped;  /* replay ring overflow (oldest dropped) */
    uint32_t alerts_dropped;
    uint32_t heartbeats, config_acks, weights_acks, stats_sent;
    uint32_t send_fail;
    uint32_t drain_timeouts;   /* GLOBAL CONFIG mid-run: pipeline did not empty in time (written anyway) */
} eog_counters_t;

typedef struct {
    int       autonomous;      /* last STATUS.autonomous seen by eog_poll */
    int       have_global;     /* a GLOBAL CONFIG was received since init */
    uint32_t  ctrl;            /* CTRL shadow (RW bits only) */
    uint32_t  peer_ip;         /* where RESULT/ALERT/STATS go (fixed, ruling #68) */
    uint32_t  res_pending, al_pending;
    uint32_t  n_fac;           /* slots from VERSION[15:8] (32 if 0) */
    uint32_t  blob_len;        /* WEIGHTS bytes assembled so far */
    eog_counters_t cnt;
} eog_state_t;

/* ---------- API ---------- */
/* Returns 0, or -1 if the ID register is wrong (the module still runs; packets still get answered). */
int  eog_init(uint32_t default_peer_ip);
void eog_rx(uint16_t local_port, uint32_t src_ip, uint16_t src_port, const uint8_t *buf, uint32_t len);
void eog_poll(void);
const eog_state_t *eog_state(void);

/* helpers, exported for tests */
uint32_t eog_crc32(const uint8_t *p, size_t n);   /* IEEE 802.3, same as zlib.crc32 */
/* Checks a weight blob (format, sizes) and runs its self-test vectors. Returns EOG_W_OK, EOG_W_LENGTH or
 * EOG_W_SELFTEST. */
int      eog_blob_check(const uint8_t *blob, uint32_t len);
void     eog_put_header(uint8_t *p, uint8_t type, uint16_t count, uint32_t seq, uint32_t aux);

static inline uint16_t eog_le16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static inline uint32_t eog_le32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static inline void eog_put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
static inline void eog_put32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

#ifdef __cplusplus
}
#endif
#endif /* EOG_PROTO_H */
