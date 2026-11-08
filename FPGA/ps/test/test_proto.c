/*
 * test_proto.c — host unit tests for eog_proto against the fake eog_regs model (fake_regs.c).
 *
 *   bash FPGA/ps/test/run_tests.sh            (builds with gcc in WSL, runs this and the Python tests)
 *   ./test_proto [weights.bin [crc32-hex]]    (a real blob from Mudit's artifacts exercises the self-test path)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../eog_proto.h"
#include "fake_regs.h"

/* ---------- tiny harness ---------- */
static int n_pass, n_fail;
#define CHECK(c) do { if (c) n_pass++; else { n_fail++; printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); } } while (0)
#define CHECK_EQ(a, b) do { long long _a = (long long)(a), _b = (long long)(b); if (_a == _b) n_pass++; else { \
    n_fail++; printf("  FAIL %s:%d: %s == %s (%lld != %lld)\n", __FILE__, __LINE__, #a, #b, _a, _b); } } while (0)

/* ---------- captured sends ---------- */
typedef struct { uint16_t sport, dport; uint32_t ip; uint16_t len; uint8_t b[1500]; } pkt_t;
static pkt_t sent[4096];
static int n_sent, fail_sends;

int hal_udp_send(uint16_t sport, uint32_t ip, uint16_t dport, const uint8_t *buf, uint16_t len)
{
    if (fail_sends) { fail_sends--; return -1; }
    if (n_sent < 4096) {
        pkt_t *p = &sent[n_sent++];
        p->sport = sport; p->dport = dport; p->ip = ip; p->len = len;
        memcpy(p->b, buf, len);
    }
    return 0;
}

/* ---------- fake SD card (hal_read_file) and log ---------- */
static uint8_t sd_file[2048];
static int sd_len = EOG_FILE_MISSING;      /* bytes in sd_file, or an EOG_FILE_* error */
static char sd_name[64];
static char last_log[256];
static int n_logs;

int hal_read_file(const char *name, uint8_t *b, uint32_t maxlen)
{
    snprintf(sd_name, sizeof sd_name, "%s", name);
    if (sd_len < 0) return sd_len;
    uint32_t n = (uint32_t)sd_len < maxlen ? (uint32_t)sd_len : maxlen;
    memcpy(b, sd_file, n);
    return (int)n;
}

void hal_log(const char *msg)
{
    snprintf(last_log, sizeof last_log, "%s", msg);
    n_logs++;
}

static int count_type(uint8_t type)
{
    int n = 0;
    for (int i = 0; i < n_sent; i++) n += sent[i].b[5] == type;
    return n;
}

static const pkt_t *nth_type(uint8_t type, int k)
{
    for (int i = 0; i < n_sent; i++)
        if (sent[i].b[5] == type && k-- == 0) return &sent[i];
    return NULL;
}

/* ---------- packet builders (wire.py layouts) ---------- */
#define PC_IP   0x3201A8C0u   /* 192.168.1.50 as lwIP stores it */
#define SRV_IP  0x3301A8C0u
static uint8_t buf[65536];

static uint32_t hdr(uint8_t type, uint16_t count, uint32_t seq, uint32_t aux)
{
    eog_put_header(buf, type, count, seq, aux);
    return 16;
}

static void make_data(uint8_t *r, uint16_t fac, uint32_t ts)
{
    memset(r, 0, 48);
    eog_put16(r, fac);
    eog_put32(r + 4, ts);
    eog_put32(r + 8, 0x00FFFF7Fu);
}

static void send_data(uint32_t seq, int n, uint32_t ts0)
{
    uint32_t len = hdr(EOG_T_DATA, (uint16_t)n, seq, 0);
    for (int i = 0; i < n; i++) make_data(buf + len + 48 * i, (uint16_t)(i % 15), ts0 + 300u * (uint32_t)(i / 15));
    eog_rx(EOG_PORT_DATA, PC_IP, 40000, buf, len + 48u * n);
}

static void send_global(uint32_t seq, uint16_t hb_timeout)
{
    uint32_t len = hdr(EOG_T_CONFIG, 1, seq, 0);
    uint8_t *g = buf + len;
    memset(g, 0, 32);
    g[0] = 17; g[1] = 2; g[2] = 4; g[3] = 3;
    eog_put16(g + 4, 1000); eog_put16(g + 6, hb_timeout);
    eog_put16(g + 8, 0x1234);
    eog_rx(EOG_PORT_CONFIG, PC_IP, 40003, buf, len + 32);
}

static void send_hb(uint32_t seq)
{
    hdr(EOG_T_HEARTBEAT, 0, seq, 0);
    eog_rx(EOG_PORT_CONFIG, SRV_IP, 50000, buf, 16);
}

static void fresh(void)
{
    fr_reset();
    n_sent = 0;
    fail_sends = 0;
    CHECK_EQ(eog_init(PC_IP), 0);
}

static uint32_t result_no_at(const pkt_t *p, int i) { return eog_le32(p->b + 16 + 32 * i + 28); }

/* ---------- tests ---------- */
static void t_init(void)
{
    puts("init");
    fresh();
    CHECK_EQ(FR.pulses_soft, 1);
    CHECK_EQ(FR.pulses_stats_clr, 1);
    CHECK_EQ(FR.ctrl, 0);
    CHECK_EQ(eog_state()->n_fac, 32);
    FR.n_fac = 16;
    eog_init(PC_IP);
    CHECK_EQ(eog_state()->n_fac, 16);
}

static void t_headers(void)
{
    puts("bad headers");
    fresh();
    hdr(EOG_T_HEARTBEAT, 0, 0, 0);
    buf[0] ^= 1;                                     /* magic */
    eog_rx(EOG_PORT_CONFIG, SRV_IP, 1, buf, 16);
    hdr(EOG_T_HEARTBEAT, 0, 0, 0);
    buf[4] = 2;                                      /* version */
    eog_rx(EOG_PORT_CONFIG, SRV_IP, 1, buf, 16);
    hdr(EOG_T_HEARTBEAT, 0, 0, 0);
    eog_rx(EOG_PORT_CONFIG, SRV_IP, 1, buf, 15);     /* short */
    hdr(EOG_T_RESULT, 0, 0, 0);
    eog_rx(EOG_PORT_CONFIG, SRV_IP, 1, buf, 16);     /* wrong type for 7003 */
    hdr(EOG_T_HEARTBEAT, 0, 0, 0);
    eog_rx(EOG_PORT_WEIGHTS, SRV_IP, 1, buf, 16);    /* wrong type for 7004 */
    eog_rx(EOG_PORT_DATA, SRV_IP, 1, buf, 16);       /* wrong type for 7000 */
    CHECK_EQ(eog_state()->cnt.bad_packets, 6);
    CHECK_EQ(FR.pulses_hb, 0);
    CHECK_EQ(n_sent, 0);
}

static void t_global(void)
{
    puts("GLOBAL CONFIG");
    fresh();
    send_data(0, 3, 1000);                           /* before GLOBAL: refused (fakeboard.py) */
    CHECK_EQ(eog_state()->cnt.bad_packets, 1);
    CHECK_EQ(FR.stats[EOG_HS_REC_IN], 0);
    FR.ctrl = EOG_CTRL_STREAM_EN;                    /* pretend streaming: proto must turn it off first */
    send_global(7, 5000);
    CHECK_EQ(FR.global_ignored, 0);
    CHECK_EQ(FR.ctrl & EOG_CTRL_STREAM_EN, 1);        /* off for the write, then back on (#69) */
    CHECK_EQ(FR.global[1], 1000u | (5000u << 16));
    CHECK_EQ(FR.global[2] & 0xFFFF, 0x1234);
    CHECK_EQ(n_sent, 1);
    const pkt_t *a = &sent[0];
    uint8_t exp[24];
    eog_put_header(exp, EOG_T_CONFIG_ACK, 1, 0, 0);
    eog_put16(exp + 16, 0xFFFF); exp[18] = 0; exp[19] = 0; eog_put32(exp + 20, 7);
    CHECK_EQ(a->len, 24);
    CHECK(memcmp(a->b, exp, 24) == 0);
    CHECK_EQ(a->sport, 7003);
    CHECK_EQ(a->dport, 40003);
    CHECK_EQ(a->ip, PC_IP);
    hdr(EOG_T_CONFIG, 1, 8, 0);
    eog_rx(EOG_PORT_CONFIG, PC_IP, 40003, buf, 16 + 31);  /* short GLOBAL: no ACK */
    CHECK_EQ(n_sent, 1);
    CHECK_EQ(eog_state()->cnt.bad_packets, 2);
}

static void t_facility(void)
{
    puts("Facility CONFIG");
    fresh();
    send_global(0, 0);
    uint32_t len = hdr(EOG_T_CONFIG, 2, 1, 1);
    uint8_t *r = buf + len;
    memset(r, 0, 128);
    eog_put16(r, 3); r[2] = 4; r[3] = 1;             /* slot 3, 4 wells, enabled */
    for (int i = 4; i < 64; i++) r[i] = (uint8_t)i;
    eog_put16(r + 64, 40); r[66] = 2; r[67] = 1;     /* slot 40: out of range */
    eog_rx(EOG_PORT_CONFIG, PC_IP, 40003, buf, len + 128);
    CHECK_EQ(count_type(EOG_T_CONFIG_ACK), 3);
    const pkt_t *a1 = nth_type(EOG_T_CONFIG_ACK, 1), *a2 = nth_type(EOG_T_CONFIG_ACK, 2);
    CHECK_EQ(eog_le16(a1->b + 16), 3); CHECK_EQ(a1->b[18], 0); CHECK_EQ(eog_le32(a1->b + 20), 1);
    CHECK_EQ(eog_le32(a1->b + 8), 1);                /* ACK seq counts per port */
    CHECK_EQ(eog_le16(a2->b + 16), 40); CHECK_EQ(a2->b[18], 1);
    CHECK_EQ(eog_le32(a2->b + 8), 2);
    CHECK_EQ(FR.cfg[3][0] >> 24, 1);
    CHECK_EQ(FR.cfg[3][0] & 0xFF0000, 4u << 16);
    CHECK_EQ(FR.cfg[3][5], eog_le32(r + 20));
    CHECK_EQ(FR.cfg[3][15], eog_le32(r + 60));
    /* rewrite the enabled slot with new values: must go through (disable, fill, enable) */
    r[20] = 0xAA;
    hdr(EOG_T_CONFIG, 1, 2, 1);
    eog_rx(EOG_PORT_CONFIG, PC_IP, 40003, buf, len + 64);
    CHECK_EQ(FR.cfg[3][5] & 0xFF, 0xAA);
    CHECK_EQ(FR.cfg_ignored, 0);
    CHECK_EQ(FR.cfg[3][0] >> 24, 1);
    /* disable via flags = 0 */
    r[3] = 0;
    eog_rx(EOG_PORT_CONFIG, PC_IP, 40003, buf, len + 64);
    CHECK_EQ(FR.cfg[3][0] >> 24, 0);
    /* truncated: no ACK */
    int before = n_sent;
    hdr(EOG_T_CONFIG, 2, 3, 1);
    eog_rx(EOG_PORT_CONFIG, PC_IP, 40003, buf, len + 100);
    CHECK_EQ(n_sent, before);
}

static void t_data_results(void)
{
    puts("DATA -> RESULT");
    fresh();
    send_global(0, 0);
    send_data(0, 30, 1000);
    CHECK_EQ(FR.ctrl & EOG_CTRL_STREAM_EN, 1);
    CHECK_EQ(FR.stats[EOG_HS_REC_IN], 30);
    eog_poll();
    CHECK_EQ(count_type(EOG_T_RESULT), 1);
    const pkt_t *p = nth_type(EOG_T_RESULT, 0);
    CHECK_EQ(p->len, 16 + 30 * 32);
    CHECK_EQ(eog_le16(p->b + 6), 30);
    CHECK_EQ(eog_le32(p->b + 8), 0);
    CHECK_EQ(eog_le32(p->b + 12), 0);
    CHECK_EQ(p->sport, 7001); CHECK_EQ(p->dport, 7001); CHECK_EQ(p->ip, PC_IP);
    CHECK_EQ(eog_le16(p->b + 16 + 32 * 17), 2);      /* fac_id echo */
    CHECK_EQ(eog_le32(p->b + 16 + 32 * 17 + 4), 1300);
    CHECK_EQ(result_no_at(p, 29), 29);
    /* data seq gaps: 0 then 3 -> 2 lost packets; a restart at 0 is not a gap */
    send_data(3, 1, 2000);
    send_data(0, 1, 2300);
    send_data(1, 1, 2600);
    CHECK_EQ(eog_state()->cnt.data_seq_gaps, 2);
    /* backpressure: 120 records in one packet with a 64-deep RESULT FIFO (ring is 128 in the test build) */
    send_data(2, 120, 5000);
    CHECK_EQ(FR.stats[EOG_HS_OVERRUN], 0);
    CHECK_EQ(eog_state()->cnt.busy_timeouts, 0);
    CHECK_EQ(FR.stats[EOG_HS_REC_IN], 30 + 3 + 120);
    eog_poll();
    int nres = 0;
    uint32_t expect = 0;
    int in_order = 1;
    for (int k = 0; k < count_type(EOG_T_RESULT); k++) {
        const pkt_t *q = nth_type(EOG_T_RESULT, k);
        CHECK(eog_le16(q->b + 6) <= 45);
        CHECK_EQ(eog_le32(q->b + 8), k);
        for (int i = 0; i < eog_le16(q->b + 6); i++, nres++) in_order &= result_no_at(q, i) == expect++;
    }
    CHECK_EQ(nres, 153);
    CHECK(in_order);
    CHECK_EQ(eog_state()->cnt.results_sent, 153);
    CHECK_EQ(eog_state()->res_pending, 0);
    /* truncated DATA */
    hdr(EOG_T_DATA, 2, 9, 0);
    eog_rx(EOG_PORT_DATA, PC_IP, 1, buf, 16 + 95);
    CHECK_EQ(eog_state()->cnt.bad_packets, 1);
}

static void t_midrun_config(void)
{
    puts("CONFIG mid-run (#69)");
    fresh();
    send_global(0, 0);
    send_data(0, 70, 1000);                           /* stream on, more results than the FIFO holds */
    CHECK_EQ(FR.ctrl & EOG_CTRL_STREAM_EN, 1);
    n_sent = 0;
    send_global(1, 4321);                             /* GLOBAL while streaming */
    CHECK_EQ(FR.global_ignored, 0);
    CHECK_EQ(FR.global[1] >> 16, 4321);
    CHECK_EQ(FR.ctrl & EOG_CTRL_STREAM_EN, 1);        /* stream back on */
    CHECK_EQ(FR.res_n, 0);                            /* pipeline drained into the ring first */
    CHECK_EQ(eog_state()->cnt.drain_timeouts, 0);
    CHECK_EQ(count_type(EOG_T_CONFIG_ACK), 1);
    CHECK_EQ(nth_type(EOG_T_CONFIG_ACK, 0)->b[18], EOG_CFG_OK);
    send_hb(0);                                       /* HB_TIMEOUT_MS is now 4321 */
    send_data(1, 5, 30000);
    eog_poll();
    int n = 0;
    for (int k = 0; k < count_type(EOG_T_RESULT); k++) n += eog_le16(nth_type(EOG_T_RESULT, k)->b + 6);
    CHECK_EQ(n, 75);
    /* a pipeline that never empties: written anyway after the timeout, counted */
    FR.stats[EOG_HS_REC_IN] += 1;
    send_global(2, 100);
    CHECK_EQ(eog_state()->cnt.drain_timeouts, 1);
    CHECK_EQ(FR.global[1] >> 16, 100);
    CHECK_EQ(FR.ctrl & EOG_CTRL_STREAM_EN, 1);
    /* Facility CONFIG re-sent while streaming and enabled: disable, rewrite, re-enable; one touch each */
    uint32_t len = hdr(EOG_T_CONFIG, 1, 3, 1);
    uint8_t *r = buf + len;
    memset(r, 0, 64);
    eog_put16(r, 7); r[2] = 3; r[3] = 1; r[40] = 0x11;
    eog_rx(EOG_PORT_CONFIG, PC_IP, 40003, buf, len + 64);
    unsigned t0 = FR.touch[7];
    r[40] = 0x22;
    eog_rx(EOG_PORT_CONFIG, PC_IP, 40003, buf, len + 64);
    CHECK_EQ(FR.cfg[7][10] & 0xFF, 0x22);
    CHECK_EQ(FR.touch[7] - t0, 17);                   /* word 0 off, words 1-15, word 0 on */
    CHECK_EQ(FR.cfg_ignored, 0);
    CHECK_EQ(FR.ctrl & EOG_CTRL_STREAM_EN, 1);        /* facility rows do not stop the stream */
}

static void push_alert(uint16_t fac, uint8_t kind, uint8_t src, uint32_t rno)
{
    uint8_t a[16] = {0};
    eog_put16(a, fac); a[2] = kind; a[3] = src; eog_put32(a + 4, 77); eog_put32(a + 8, rno);
    a[12] = 1; a[13] = 2; eog_put16(a + 14, 0xFFFF);
    fr_push_alert(a);
}

static void t_autonomous_replay(void)
{
    puts("heartbeat, AUTONOMOUS, replay");
    fresh();
    FR.ms = 1000;
    send_global(0, 5000);
    send_hb(0);
    CHECK_EQ(FR.pulses_hb, 1);
    CHECK_EQ(eog_state()->peer_ip, PC_IP);           /* fixed destination, not the heartbeat source (#68) */
    send_data(0, 10, 1000);
    push_alert(4, 1, 0x01, 3);
    eog_poll();
    CHECK_EQ(count_type(EOG_T_RESULT), 1);
    CHECK_EQ(nth_type(EOG_T_RESULT, 0)->ip, PC_IP);
    CHECK_EQ(nth_type(EOG_T_RESULT, 0)->dport, 7001);
    CHECK_EQ(count_type(EOG_T_ALERT), 1);
    CHECK_EQ(nth_type(EOG_T_ALERT, 0)->b[16 + 3], 0x01);   /* live alert: no replay bit */
    CHECK_EQ(nth_type(EOG_T_ALERT, 0)->dport, 7002);
    FR.ms = 1000 + 4999;
    eog_poll();
    CHECK_EQ(eog_state()->autonomous, 0);
    FR.ms = 1000 + 5000;                              /* timeout reached */
    send_data(1, 60, 4000);
    push_alert(5, 2, 0x17, 12);                       /* raised while autonomous (hardware sets bit 2) */
    n_sent = 0;
    eog_poll();
    CHECK_EQ(eog_state()->autonomous, 1);
    CHECK_EQ(count_type(EOG_T_RESULT), 0);
    CHECK_EQ(count_type(EOG_T_ALERT), 0);
    CHECK_EQ(eog_state()->res_pending, 60);
    FR.ms += 1000;
    eog_poll();                                       /* STATS still go out while autonomous */
    CHECK_EQ(count_type(EOG_T_STATS), 1);
    const pkt_t *s = nth_type(EOG_T_STATS, 0);
    CHECK_EQ(eog_le32(s->b + 16 + 4 * 11), 1);       /* mode */
    CHECK_EQ(eog_le32(s->b + 16 + 4 * 15), 60);      /* replay_waiting */
    CHECK_EQ(eog_le32(s->b + 16 + 4 * 1), 10);       /* results_out (sent so far) */
    uint32_t stats_seq = eog_le32(s->b + 8);
    /* reconnect */
    n_sent = 0;
    send_hb(1);
    eog_poll();
    CHECK_EQ(eog_state()->autonomous, 0);
    CHECK_EQ(count_type(EOG_T_RESULT), 2);            /* 45 + 15 */
    CHECK_EQ(result_no_at(nth_type(EOG_T_RESULT, 0), 0), 10);
    CHECK_EQ(eog_le32(nth_type(EOG_T_RESULT, 0)->b + 8), stats_seq + 1);   /* 7001 seq shared with STATS */
    CHECK_EQ(count_type(EOG_T_ALERT), 1);
    const pkt_t *a = nth_type(EOG_T_ALERT, 0);
    CHECK_EQ(a->b[16 + 3], 0x17 | EOG_ALERT_SRC_REPLAY);
    CHECK_EQ(eog_le32(a->b + 8), 1);                  /* ALERT seq */
    CHECK_EQ(eog_le32(a->b + 16 + 8), 12);
    CHECK_EQ(eog_state()->res_pending, 0);
    /* hb_timeout 0 = never autonomous */
    fresh();
    send_global(0, 0);
    FR.ms = 1000000;
    send_data(0, 5, 1000);
    eog_poll();
    CHECK_EQ(eog_state()->autonomous, 0);
    CHECK_EQ(count_type(EOG_T_RESULT), 1);
}

static void t_ring_overflow(void)
{
    puts("replay ring overflow");
    fresh();
    send_global(0, 100);
    FR.ms = 500;                                      /* never a heartbeat: ms_since_hb = 65535 -> autonomous */
    for (int k = 0; k < 4; k++) { send_data((uint32_t)k, 50, 1000 + 3000u * (uint32_t)k); eog_poll(); }
    CHECK_EQ(count_type(EOG_T_RESULT), 0);
    CHECK_EQ(eog_state()->res_pending, EOG_RES_RING);
    CHECK_EQ(eog_state()->cnt.results_dropped, 200 - EOG_RES_RING);
    send_hb(0);
    eog_poll();
    const pkt_t *p = nth_type(EOG_T_RESULT, 0);
    CHECK_EQ(eog_le32(p->b + 12), 200 - EOG_RES_RING);   /* aux = dropped since the last RESULT packet */
    CHECK_EQ(result_no_at(p, 0), 200 - EOG_RES_RING);    /* the oldest were dropped */
    CHECK_EQ(eog_le32(nth_type(EOG_T_RESULT, 1)->b + 12), 0);
    int n = 0;
    for (int k = 0; k < count_type(EOG_T_RESULT); k++) n += eog_le16(nth_type(EOG_T_RESULT, k)->b + 6);
    CHECK_EQ(n, EOG_RES_RING);
}

static void t_send_fail(void)
{
    puts("send failure keeps data");
    fresh();
    send_global(0, 0);
    send_data(0, 50, 1000);
    n_sent = 0;
    fail_sends = 1;
    eog_poll();                                       /* first RESULT packet fails: nothing consumed */
    CHECK_EQ(n_sent, 0);
    CHECK_EQ(eog_state()->res_pending, 50);
    eog_poll();
    CHECK_EQ(count_type(EOG_T_RESULT), 2);
    CHECK_EQ(eog_le32(nth_type(EOG_T_RESULT, 0)->b + 8), 0);
    CHECK_EQ(result_no_at(nth_type(EOG_T_RESULT, 0), 0), 0);
    CHECK_EQ(eog_state()->cnt.send_fail, 1);
}

static void t_stats(void)
{
    puts("STATS");
    fresh();
    FR.ms = 10000;
    eog_init(PC_IP);
    n_sent = 0;
    for (int i = 0; i < 16; i++) FR.stats[i] = 100u + (uint32_t)i;
    FR.active_ver = 9;
    eog_poll();
    CHECK_EQ(count_type(EOG_T_STATS), 0);
    FR.ms = 10999; eog_poll();
    CHECK_EQ(count_type(EOG_T_STATS), 0);
    FR.ms = 11000; eog_poll();
    CHECK_EQ(count_type(EOG_T_STATS), 1);
    const pkt_t *s = nth_type(EOG_T_STATS, 0);
    CHECK_EQ(s->len, 16 + 64);
    CHECK_EQ(eog_le16(s->b + 6), 1);
    CHECK_EQ(s->dport, 7001);
    uint32_t exp[16] = {100, 0, 105, 106, 107, 104, 103, 109, 0, 0, 110, 0, 9, 113, 1, 0};
    for (int i = 0; i < 16; i++) CHECK_EQ(eog_le32(s->b + 16 + 4 * i), exp[i]);
    FR.ms = 11500; eog_poll();
    FR.ms = 12000; eog_poll();
    CHECK_EQ(count_type(EOG_T_STATS), 2);
    CHECK_EQ(eog_le32(nth_type(EOG_T_STATS, 1)->b + 8), 1);
}

/* ---------- WEIGHTS ---------- */
static uint8_t blob[EOG_MAX_BLOB];
static uint32_t blob_len;

static void synth_blob(void)
{
    /* format 1, 4 heads, 31 features, S_out 20, 0 vectors, feature set 1 */
    memset(blob, 0, sizeof blob);
    eog_put16(blob, 1); blob[2] = 4; blob[3] = 31; blob[4] = 20; blob[5] = 0; eog_put16(blob + 6, 1);
    for (int i = 0; i < 124; i++) eog_put16(blob + 8 + 2 * i, (uint16_t)(i * 517 - 30000));
    for (int k = 0; k < 4; k++) eog_put32(blob + 256 + 4 * k, 0x01000000u * (uint32_t)(k + 1));
    blob_len = 280;
}

static void w_chunk(uint32_t seq, uint32_t ver, uint32_t off, const uint8_t *d, uint16_t n)
{
    uint32_t len = hdr(EOG_T_WEIGHTS, 1, seq, ver);
    eog_put32(buf + 16, off); eog_put16(buf + 20, n); eog_put16(buf + 22, 0);
    memcpy(buf + 24, d, n);
    eog_rx(EOG_PORT_WEIGHTS, PC_IP, 40004, buf, len + 8 + n);
}

static void w_commit(uint32_t seq, uint32_t ver, uint32_t total, uint32_t crc)
{
    uint32_t len = hdr(EOG_T_WEIGHTS, 1, seq, ver);
    eog_put32(buf + 16, total); eog_put16(buf + 20, 0); eog_put16(buf + 22, 1);
    eog_put32(buf + 24, total); eog_put32(buf + 28, crc);
    eog_rx(EOG_PORT_WEIGHTS, PC_IP, 40004, buf, len + 16);
}

static const pkt_t *last_wack(void) { return nth_type(EOG_T_WEIGHTS_ACK, count_type(EOG_T_WEIGHTS_ACK) - 1); }

static void t_weights(const char *path, const char *crc_hex)
{
    puts("WEIGHTS");
    CHECK_EQ(eog_crc32((const uint8_t *)"123456789", 9), 0xCBF43926u);   /* standard check value */
    int real = 0;
    if (path) {
        FILE *f = fopen(path, "rb");
        if (f) {
            blob_len = (uint32_t)fread(blob, 1, sizeof blob, f);
            fclose(f);
            real = 1;
            printf("  blob %s: %u bytes, %u self-test vectors\n", path, blob_len, blob[5]);
            if (crc_hex) CHECK_EQ(eog_crc32(blob, blob_len), strtoul(crc_hex, NULL, 16));
            CHECK_EQ(eog_blob_check(blob, blob_len), EOG_W_OK);
            CHECK(blob[5] > 0);
        } else {
            printf("  (no blob at %s: synthetic blob only)\n", path);
        }
    }
    if (!real) synth_blob();
    /* #67: bad header fields -> status 3 */
    {
        static const int pos[] = {0, 2, 3, 6};
        for (int i = 0; i < 4; i++) {
            uint8_t save_b = blob[pos[i]];
            blob[pos[i]] ^= 0x40;
            CHECK_EQ(eog_blob_check(blob, blob_len), EOG_W_SELFTEST);
            blob[pos[i]] = save_b;
        }
        CHECK_EQ(eog_blob_check(blob, blob_len), EOG_W_OK);
        CHECK_EQ(eog_blob_check(blob, 279), EOG_W_LENGTH);
    }
    uint32_t crc = eog_crc32(blob, blob_len);
    fresh();
    /* three chunks, out of order */
    uint32_t c1 = blob_len / 3, c2 = 2 * blob_len / 3;
    w_chunk(0, 0x102, c1, blob + c1, (uint16_t)(c2 - c1));
    w_chunk(1, 0x102, c2, blob + c2, (uint16_t)(blob_len - c2));
    w_chunk(2, 0x102, 0, blob, (uint16_t)c1);
    CHECK_EQ(count_type(EOG_T_WEIGHTS_ACK), 3);
    const pkt_t *a = nth_type(EOG_T_WEIGHTS_ACK, 0);
    uint8_t exp[24];
    eog_put_header(exp, EOG_T_WEIGHTS_ACK, 1, 0, 0x102);
    eog_put32(exp + 16, c1); exp[20] = 0; exp[21] = 0; eog_put16(exp + 22, 0);
    CHECK(a->len == 24 && memcmp(a->b, exp, 24) == 0);
    CHECK_EQ(a->sport, 7004); CHECK_EQ(a->dport, 40004);
    CHECK_EQ(eog_state()->blob_len, blob_len);
    w_commit(3, 0x102, blob_len, crc);
    a = last_wack();
    CHECK_EQ(a->b[20], EOG_W_SWAPPED);
    CHECK_EQ(a->b[21], 0x02);                         /* version = aux & 0xFF */
    CHECK_EQ(eog_le32(a->b + 16), blob_len);
    CHECK_EQ(eog_le32(a->b + 12), 0x102);
    CHECK_EQ(FR.pulses_swap, 1);
    CHECK_EQ(FR.active_ver, 2);
    int win_ok = 1;
    for (int w = 0; w < 70; w++) win_ok &= FR.wwin[w] == eog_le32(blob + 4 * w);
    CHECK(win_ok);
    CHECK_EQ(FR.wwin[70], 2);
    CHECK_EQ(eog_state()->blob_len, 0);
    /* bad CRC */
    w_chunk(4, 3, 0, blob, (uint16_t)blob_len);
    w_commit(5, 3, blob_len, crc ^ 1);
    CHECK_EQ(last_wack()->b[20], EOG_W_CRC);
    CHECK_EQ(last_wack()->b[21], 2);
    CHECK_EQ(FR.pulses_swap, 1);
    /* commit with nothing assembled -> bad length */
    w_commit(6, 3, blob_len, crc);
    CHECK_EQ(last_wack()->b[20], EOG_W_LENGTH);
    /* chunk past 1024 -> bad length */
    w_chunk(7, 3, 1000, blob, 100);
    CHECK_EQ(last_wack()->b[20], EOG_W_LENGTH);
    /* a self-test vector that disagrees (or a bad header for the synthetic blob) */
    uint8_t save = real ? blob[280 + 62] : blob[2];
    if (real) blob[280 + 62] ^= 1; else blob[2] = 5;
    w_chunk(8, 4, 0, blob, (uint16_t)blob_len);
    w_commit(9, 4, blob_len, eog_crc32(blob, blob_len));
    CHECK_EQ(last_wack()->b[20], EOG_W_SELFTEST);
    if (real) blob[280 + 62] = save; else blob[2] = save;
    /* truncated vector area */
    if (real) {
        w_chunk(10, 4, 0, blob, (uint16_t)(blob_len - 1));
        w_commit(11, 4, blob_len - 1, eog_crc32(blob, blob_len - 1));
        CHECK_EQ(last_wack()->b[20], EOG_W_LENGTH);
    }
    /* swap stuck behind a busy engine: accepted (0) but not swapped; next one waits */
    FR.swap_immediate = 0;
    w_chunk(12, 7, 0, blob, (uint16_t)blob_len);
    w_commit(13, 7, blob_len, crc);
    CHECK_EQ(last_wack()->b[20], EOG_W_OK);
    CHECK_EQ(last_wack()->b[21], 2);
    fr_swap_now();
    CHECK_EQ(FR.active_ver, 7);
    CHECK_EQ(eog_state()->cnt.bad_packets, 0);
}

/* ---------- SD boot load (FPGA/docs/SD_BOOT_WEIGHTS.md) ---------- */
/* weights.eog = 16-byte wrapper + blob (make_weights_sd.py layout) */
static void sd_make(const uint8_t *b, uint32_t n, uint8_t ver)
{
    eog_put32(sd_file, EOG_SD_MAGIC);
    sd_file[4] = ver;
    sd_file[5] = 1;
    eog_put16(sd_file + 6, (uint16_t)n);
    eog_put32(sd_file + 8, eog_crc32(b, n));
    eog_put32(sd_file + 12, 0);
    memcpy(sd_file + 16, b, n);
    sd_len = (int)(16 + n);
}

/* power-up, then the boot load; checks that a failure leaves the engine with no model and sends nothing */
static int sd_boot_fail(int expect, const char *what)
{
    fresh();
    n_logs = 0;
    last_log[0] = 0;
    int r = eog_boot_load_weights();
    CHECK_EQ(r, expect);
    CHECK_EQ(FR.active_ver, 0);
    CHECK_EQ(n_logs, 1);
    CHECK(strncmp(last_log, "SD weights: ", 12) == 0);
    CHECK(strstr(last_log, eog_sd_reason(expect)) != NULL);
    CHECK_EQ(n_sent, 0);
    printf("  %-28s -> %s\n", what, last_log);
    return r;
}

static void t_sd_boot(const char *path)
{
    puts("SD boot load");
    uint8_t b[EOG_MAX_BLOB];
    uint32_t n;
    FILE *f = path ? fopen(path, "rb") : NULL;
    if (f) {
        n = (uint32_t)fread(b, 1, sizeof b, f);
        fclose(f);
    } else {
        /* synthetic blob + one self-test vector: features 0 -> logit = round(B[k] / 2^20) = 16 (k + 1) */
        synth_blob();
        memcpy(b, blob, 280);
        b[5] = 1;
        memset(b + 280, 0, 70);
        for (int k = 0; k < 4; k++) eog_put16(b + 280 + 62 + 2 * k, (uint16_t)(16 * (k + 1)));
        n = 350;
    }
    CHECK_EQ(eog_blob_check(b, n), EOG_W_OK);
    CHECK(b[5] > 0);

    /* good file: model active with the file's version before any UDP traffic */
    sd_make(b, n, 3);
    fresh();
    n_logs = 0;
    CHECK_EQ(eog_boot_load_weights(), EOG_SD_OK);
    CHECK(strcmp(sd_name, "weights.eog") == 0);
    CHECK_EQ(FR.active_ver, 3);
    CHECK_EQ(FR.pulses_swap, 1);
    CHECK_EQ(FR.swap_pending, 0);
    int win_ok = 1;
    for (int w = 0; w < 70; w++) win_ok &= FR.wwin[w] == eog_le32(b + 4 * w);
    CHECK(win_ok);
    CHECK_EQ(FR.wwin[70], 3);
    CHECK_EQ(n_logs, 1);
    CHECK(strncmp(last_log, "SD weights v3 active", 20) == 0);
    printf("  %-28s -> %s\n", "good file", last_log);
    CHECK_EQ(n_sent, 0);
    CHECK_EQ(hal_reg_read(EOG_R_STATUS) >> 24, 3);    /* STATS "active weights version" */
    send_global(0, 0);                                /* first RESULT carries WVER 3, no WEIGHTS sent */
    send_data(0, 2, 1000);
    eog_poll();
    CHECK_EQ(count_type(EOG_T_RESULT), 1);
    CHECK_EQ(nth_type(EOG_T_RESULT, 0)->b[16 + 21], 3);
    /* UDP WEIGHTS afterwards: same status codes as without an SD model (#67), and it replaces the SD model */
    uint32_t crc = eog_crc32(b, n);
    w_chunk(0, 5, 0, b, (uint16_t)n);
    w_commit(1, 5, n, crc ^ 1);
    CHECK_EQ(last_wack()->b[20], EOG_W_CRC);
    CHECK_EQ(last_wack()->b[21], 3);
    w_commit(2, 5, n, crc);
    CHECK_EQ(last_wack()->b[20], EOG_W_LENGTH);       /* nothing assembled any more */
    uint8_t hb = b[3];
    b[3] = 30;
    w_chunk(3, 5, 0, b, (uint16_t)n);
    w_commit(4, 5, n, eog_crc32(b, n));
    CHECK_EQ(last_wack()->b[20], EOG_W_SELFTEST);     /* bad header -> 3 */
    b[3] = hb;
    w_chunk(5, 5, 0, b, (uint16_t)n);
    w_commit(6, 5, n, crc);
    CHECK_EQ(last_wack()->b[20], EOG_W_SWAPPED);
    CHECK_EQ(last_wack()->b[21], 5);
    CHECK_EQ(FR.active_ver, 5);

    /* failures: reason logged, no model, boot continues */
    sd_len = EOG_FILE_MISSING;  sd_boot_fail(EOG_SD_NO_FILE, "missing file");
    sd_len = EOG_FILE_NO_CARD;  sd_boot_fail(EOG_SD_NO_CARD, "no card");
    sd_len = EOG_FILE_IO;       sd_boot_fail(EOG_SD_IO, "read error");
    sd_make(b, n, 3); sd_len = 15;                   sd_boot_fail(EOG_SD_SHORT, "15-byte file");
    sd_make(b, n, 3); sd_file[0] ^= 1;               sd_boot_fail(EOG_SD_MAGIC_BAD, "bad magic");
    sd_make(b, n, 3); sd_file[5] = 2;                sd_boot_fail(EOG_SD_FORMAT_BAD, "wrapper format 2");
    sd_make(b, n, 0);                                sd_boot_fail(EOG_SD_VERSION0, "version 0");
    sd_make(b, n, 3); sd_len--;                      sd_boot_fail(EOG_SD_LENGTH, "file 1 B short");
    sd_make(b, n, 3); sd_file[sd_len++] = 0;         sd_boot_fail(EOG_SD_LENGTH, "file 1 B long");
    sd_make(b, n, 3); eog_put16(sd_file + 6, 1025);  sd_boot_fail(EOG_SD_LENGTH, "length 1025");
    {   /* a 1,041-byte file that claims 1,025 B: still a length error, not a read past the buffer */
        memset(sd_file + 16, 0, 1025);
        eog_put32(sd_file, EOG_SD_MAGIC); sd_file[4] = 3; sd_file[5] = 1; eog_put16(sd_file + 6, 1025);
        sd_len = 16 + 1025;
        sd_boot_fail(EOG_SD_LENGTH, "1,041-byte file");
    }
    sd_make(b, n, 3); sd_file[8] ^= 0x80;            sd_boot_fail(EOG_SD_CRC, "bad CRC");
    sd_make(b, n, 3); sd_file[16 + 100] ^= 1;        sd_boot_fail(EOG_SD_CRC, "corrupt blob byte");
    {
        static const int pos[] = {0, 2, 3, 6};       /* blob_format, n_heads, n_features, feature_set_id */
        for (int i = 0; i < 4; i++) {
            uint8_t save_b = b[pos[i]];
            b[pos[i]] ^= 0x40;
            sd_make(b, n, 3);
            sd_boot_fail(EOG_SD_HEADER, "bad blob header");
            b[pos[i]] = save_b;
        }
    }
    b[280 + 62] ^= 1;                                /* first vector's expected logit 0 */
    sd_make(b, n, 3);                                sd_boot_fail(EOG_SD_SELFTEST, "failing self-test");
    b[280 + 62] ^= 1;
    sd_make(b, n - 1, 3);                            sd_boot_fail(EOG_SD_LENGTH, "truncated vectors");
    sd_make(b, 279, 3);                              sd_boot_fail(EOG_SD_LENGTH, "blob < 280 B");
    /* swap never completes (engine busy): bounded wait, logged */
    sd_make(b, n, 3);
    fr_reset();
    n_sent = 0;
    eog_init(PC_IP);
    FR.swap_immediate = 0;
    CHECK_EQ(eog_boot_load_weights(), EOG_SD_SWAP_TIMEOUT);
    CHECK_EQ(FR.swap_pending, 1);
    printf("  %-28s -> %s\n", "swap stuck", last_log);
    /* after a failed boot load the UDP path still works */
    sd_len = EOG_FILE_MISSING;
    fresh();
    eog_boot_load_weights();
    w_chunk(0, 9, 0, b, (uint16_t)n);
    w_commit(1, 9, n, eog_crc32(b, n));
    CHECK_EQ(last_wack()->b[20], EOG_W_SWAPPED);
    CHECK_EQ(FR.active_ver, 9);
}

int main(int argc, char **argv)
{
    t_init();
    t_headers();
    t_global();
    t_facility();
    t_data_results();
    t_midrun_config();
    t_autonomous_replay();
    t_ring_overflow();
    t_send_fail();
    t_stats();
    t_weights(argc > 1 ? argv[1] : NULL, argc > 2 ? argv[2] : NULL);
    t_sd_boot(argc > 1 ? argv[1] : NULL);
    printf("test_proto: %d passed, %d failed\n", n_pass, n_fail);
    puts(n_fail ? "FAIL" : "PASS");
    return n_fail != 0;
}
