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
    CHECK_EQ(FR.ctrl & EOG_CTRL_STREAM_EN, 0);
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
    CHECK_EQ(eog_state()->peer_ip, SRV_IP);          /* results follow the heartbeat source */
    send_data(0, 10, 1000);
    push_alert(4, 1, 0x01, 3);
    eog_poll();
    CHECK_EQ(count_type(EOG_T_RESULT), 1);
    CHECK_EQ(nth_type(EOG_T_RESULT, 0)->ip, SRV_IP);
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

int main(int argc, char **argv)
{
    t_init();
    t_headers();
    t_global();
    t_facility();
    t_data_results();
    t_autonomous_replay();
    t_ring_overflow();
    t_send_fail();
    t_stats();
    t_weights(argc > 1 ? argv[1] : NULL, argc > 2 ? argv[2] : NULL);
    printf("test_proto: %d passed, %d failed\n", n_pass, n_fail);
    puts(n_fail ? "FAIL" : "PASS");
    return n_fail != 0;
}
