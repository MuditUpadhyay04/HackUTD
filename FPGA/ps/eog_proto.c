/*
 * eog_proto.c — portable ARM-side protocol for the EOG engine (see eog_proto.h).
 *
 * Board behavior follows Mudit's software stand-in (ml/hutd_ml/fakeboard.py) unless noted:
 *   7000 DATA      -> each 48 B record written to the DATA window (0x200..0x22C, the last word pushes)
 *   7003 CONFIG    -> GLOBAL (aux 0) to 0x10..0x2C with stream_en = 0; Facility (aux != 0) to the CONFIG table,
 *                     one CONFIG_ACK per record to the sender; HEARTBEAT -> CTRL.heartbeat pulse
 *   7004 WEIGHTS   -> chunks assembled in RAM; COMMIT checks length, CRC32, blob header and self-test vectors,
 *                     writes the inactive bank + version, pulses swap_req, waits for swap_pending = 0;
 *                     every chunk is ACKed (WEIGHTS_ACK echoes the header aux)
 *   7001 RESULT    <- up to 45 per packet; aux = results the ARM dropped (replay ring full) since the last one
 *   7001 STATS     <- every 1 s (shares the 7001 sequence number with RESULT, as fakeboard.py does)
 *   7002 ALERT     <- one per packet; SOURCE bit 3 set on alerts replayed after an outage
 * Destinations (ruling #68): RESULT/STATS -> peer:7001, ALERT -> peer:7002 with peer fixed at eog_init (the PC,
 * 192.168.1.50), so buffered output always has somewhere to go; CONFIG_ACK/WEIGHTS_ACK -> the sender's IP:port.
 * Facility CONFIG on an enabled slot: disable (word 0 with FLAGS[0] = 0), rewrite, re-enable (ruling #69).
 * WEIGHTS_ACK status 3 also covers a bad blob header (ruling #67).
 * AUTONOMOUS is the hardware's STATUS.autonomous (HB_TIMEOUT_MS from GLOBAL, 0 = never), so the ARM's buffering
 * and the ALERT SOURCE bit 2 set by eog_alarm always agree. While it is 1, RESULT/ALERT stay in the rings; the
 * first eog_poll() after it falls replays them in order, then new ones follow.
 */
#include "eog_proto.h"

#include <string.h>

static struct {
    eog_state_t s;
    uint32_t seq_res, seq_al, seq_cfg, seq_w;
    int      have_data_seq;
    uint32_t next_data_seq;
    uint32_t res_drop_since_pkt;
    uint32_t t0, last_stats;
    /* replay rings */
    uint32_t res_head, al_head;          /* oldest entry */
    uint8_t  res[EOG_RES_RING][EOG_RESULT_LEN];
    uint8_t  al[EOG_AL_RING][EOG_ALERT_LEN];
    uint8_t  al_replay[EOG_AL_RING];
    /* WEIGHTS assembly */
    uint8_t  blob[EOG_MAX_BLOB];
    uint8_t  pkt[EOG_HDR_LEN + EOG_RESULT_PER_PKT * EOG_RESULT_LEN];
} G;

#define S (G.s)

const eog_state_t *eog_state(void) { return &G.s; }

/* ---------- helpers ---------- */
void eog_put_header(uint8_t *p, uint8_t type, uint16_t count, uint32_t seq, uint32_t aux)
{
    eog_put32(p, EOG_MAGIC);
    p[4] = EOG_WIRE_VERSION;
    p[5] = type;
    eog_put16(p + 6, count);
    eog_put32(p + 8, seq);
    eog_put32(p + 12, aux);
}

uint32_t eog_crc32(const uint8_t *p, size_t n)
{
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) {
        c ^= p[i];
        for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1u)));
    }
    return ~c;
}

/* floor(v / 2^s) without relying on implementation-defined signed shifts */
static int64_t asr64(int64_t v, unsigned s)
{
    if (s >= 63) return v < 0 ? -1 : 0;
    if (v >= 0) return (int64_t)((uint64_t)v >> s);
    return -(int64_t)((uint64_t)(-(v + 1)) >> s) - 1;
}

static int32_t sat16(int64_t v) { return v < -32768 ? -32768 : v > 32767 ? 32767 : (int32_t)v; }

int eog_blob_check(const uint8_t *b, uint32_t len)
{
    if (len < EOG_BLOB_HDR_LEN) return EOG_W_LENGTH;
    unsigned s_out = b[4], nv = b[5];
    if (eog_le16(b) != 1 || b[2] != 4 || b[3] != 31 || eog_le16(b + 6) != 1) return EOG_W_SELFTEST;
    if (len < EOG_BLOB_HDR_LEN + EOG_BLOB_VEC_LEN * nv) return EOG_W_LENGTH;
    for (unsigned v = 0; v < nv; v++) {
        const uint8_t *x = b + EOG_BLOB_HDR_LEN + EOG_BLOB_VEC_LEN * v;
        for (unsigned k = 0; k < 4; k++) {
            int64_t acc = (int32_t)eog_le32(b + 256 + 4 * k);
            for (unsigned i = 0; i < 31; i++)
                acc += (int64_t)(int16_t)eog_le16(b + 8 + 2 * (31 * k + i)) * (int16_t)eog_le16(x + 2 * i);
            if (s_out > 0 && s_out < 63) acc += (int64_t)1 << (s_out - 1);
            if (sat16(asr64(acc, s_out)) != (int16_t)eog_le16(x + 62 + 2 * k)) return EOG_W_SELFTEST;
        }
    }
    return EOG_W_OK;
}

static int hdr_ok(const uint8_t *buf, uint32_t len)
{
    return len >= EOG_HDR_LEN && eog_le32(buf) == EOG_MAGIC && buf[4] == EOG_WIRE_VERSION;
}

static void ctrl_pulse(uint32_t bits) { hal_reg_write(EOG_R_CTRL, S.ctrl | bits); }

static void ctrl_set(uint32_t ctrl)
{
    S.ctrl = ctrl & (EOG_CTRL_STREAM_EN | EOG_CTRL_SRC_DMA);
    hal_reg_write(EOG_R_CTRL, S.ctrl);
}

static int send(uint16_t sport, uint32_t ip, uint16_t dport, const uint8_t *p, uint16_t n)
{
    if (hal_udp_send(sport, ip, dport, p, n) != 0) {
        S.cnt.send_fail++;
        return -1;
    }
    return 0;
}

/* ---------- FIFOs -> rings ---------- */
static void res_push(const uint8_t *r)
{
    if (S.res_pending == EOG_RES_RING) {         /* full: drop the oldest */
        G.res_head = (G.res_head + 1) & (EOG_RES_RING - 1);
        S.res_pending--;
        S.cnt.results_dropped++;
        G.res_drop_since_pkt++;
    }
    memcpy(G.res[(G.res_head + S.res_pending) & (EOG_RES_RING - 1)], r, EOG_RESULT_LEN);
    S.res_pending++;
}

static void al_push(const uint8_t *a, int replay)
{
    if (S.al_pending == EOG_AL_RING) {
        G.al_head = (G.al_head + 1) & (EOG_AL_RING - 1);
        S.al_pending--;
        S.cnt.alerts_dropped++;
    }
    uint32_t i = (G.al_head + S.al_pending) & (EOG_AL_RING - 1);
    memcpy(G.al[i], a, EOG_ALERT_LEN);
    G.al_replay[i] = (uint8_t)replay;
    S.al_pending++;
}

/* Read everything the RESULT and ALERT FIFOs hold (bounded) into the rings. */
static void drain(void)
{
    uint8_t rec[EOG_RESULT_LEN];
    uint32_t budget = EOG_DRAIN_MAX;
    while (budget) {
        uint32_t st = hal_reg_read(EOG_R_STATUS);
        S.autonomous = (int)(st & EOG_ST_AUTONOMOUS);
        uint32_t nr = (st >> 8) & 0xFFu, na = (st >> 16) & 0xFFu;
        if (nr == 0 && na == 0) break;
        for (; nr && budget; nr--, budget--) {
            for (unsigned w = 0; w < 8; w++)   /* word 7 (0x31C) last: it pops */
                eog_put32(rec + 4 * w, hal_reg_read(EOG_R_RESULT + 4 * w));
            res_push(rec);
        }
        for (; na && budget; na--, budget--) {
            for (unsigned w = 0; w < 4; w++)   /* word 3 (0x4C) last: it pops */
                eog_put32(rec + 4 * w, hal_reg_read(EOG_R_ALERT + 4 * w));
            al_push(rec, S.autonomous);
        }
    }
}

/* Send what the rings hold (only while the server is up). */
static void flush(void)
{
    unsigned pkts = 0;
    while (S.res_pending && pkts < EOG_FLUSH_PKTS) {
        uint32_t n = S.res_pending < EOG_RESULT_PER_PKT ? S.res_pending : EOG_RESULT_PER_PKT;
        eog_put_header(G.pkt, EOG_T_RESULT, (uint16_t)n, G.seq_res, G.res_drop_since_pkt);
        for (uint32_t i = 0; i < n; i++)
            memcpy(G.pkt + EOG_HDR_LEN + EOG_RESULT_LEN * i, G.res[(G.res_head + i) & (EOG_RES_RING - 1)],
                   EOG_RESULT_LEN);
        pkts++;
        if (send(EOG_PORT_RESULT, S.peer_ip, EOG_PORT_RESULT, G.pkt, (uint16_t)(EOG_HDR_LEN + EOG_RESULT_LEN * n)))
            return;
        G.seq_res++;
        G.res_drop_since_pkt = 0;
        G.res_head = (G.res_head + n) & (EOG_RES_RING - 1);
        S.res_pending -= n;
        S.cnt.results_sent += n;
    }
    while (S.al_pending && pkts < EOG_FLUSH_PKTS) {
        uint32_t i = G.al_head;
        eog_put_header(G.pkt, EOG_T_ALERT, 1, G.seq_al, 0);
        memcpy(G.pkt + EOG_HDR_LEN, G.al[i], EOG_ALERT_LEN);
        if (G.al_replay[i]) G.pkt[EOG_HDR_LEN + 3] |= EOG_ALERT_SRC_REPLAY;
        pkts++;
        if (send(EOG_PORT_ALERT, S.peer_ip, EOG_PORT_ALERT, G.pkt, EOG_HDR_LEN + EOG_ALERT_LEN)) return;
        G.seq_al++;
        G.al_head = (i + 1) & (EOG_AL_RING - 1);
        S.al_pending--;
        S.cnt.alerts_sent++;
    }
}

static void send_stats(uint32_t now)
{
    uint32_t hs[16], v[16];
    for (unsigned i = 0; i < 16; i++) hs[i] = hal_reg_read(EOG_R_STATS + 4 * i);
    uint32_t st = hal_reg_read(EOG_R_STATUS);
    int auton = (int)(st & EOG_ST_AUTONOMOUS);
    /* wire.py STATS_FIELDS order */
    v[0] = hs[EOG_HS_REC_IN];
    v[1] = S.cnt.results_sent;
    v[2] = hs[EOG_HS_DUP];
    v[3] = hs[EOG_HS_OOO];
    v[4] = hs[EOG_HS_UNKNOWN];
    v[5] = hs[EOG_HS_INVALID];
    v[6] = hs[EOG_HS_HELD];
    v[7] = hs[EOG_HS_HIST_RESET];
    v[8] = S.cnt.data_seq_gaps;
    v[9] = S.cnt.bad_packets;
    v[10] = hs[EOG_HS_ALERTS];
    v[11] = (uint32_t)auton;
    v[12] = st >> 24;
    v[13] = hs[EOG_HS_STALL];
    v[14] = (now - G.t0) / 1000u;
    v[15] = auton ? S.res_pending : 0;
    uint8_t p[EOG_HDR_LEN + EOG_STATS_LEN];
    eog_put_header(p, EOG_T_STATS, 1, G.seq_res, 0);
    for (unsigned i = 0; i < 16; i++) eog_put32(p + EOG_HDR_LEN + 4 * i, v[i]);
    if (send(EOG_PORT_RESULT, S.peer_ip, EOG_PORT_RESULT, p, sizeof p) == 0) {
        G.seq_res++;
        S.cnt.stats_sent++;
    }
}

/* ---------- 7000 DATA ---------- */
static void on_data(const uint8_t *buf, uint32_t len)
{
    uint16_t count = eog_le16(buf + 6);
    uint32_t seq = eog_le32(buf + 8);
    if (buf[5] != EOG_T_DATA || len < EOG_HDR_LEN + (uint32_t)EOG_DATA_LEN * count || !S.have_global) {
        S.cnt.bad_packets++;
        return;
    }
    if (G.have_data_seq && seq > G.next_data_seq) S.cnt.data_seq_gaps += seq - G.next_data_seq;
    G.have_data_seq = 1;
    G.next_data_seq = seq + 1;   /* a sender restart (smaller seq) just restarts the tracking */
    S.cnt.data_packets++;
    if (!(S.ctrl & EOG_CTRL_STREAM_EN)) ctrl_set(S.ctrl | EOG_CTRL_STREAM_EN);
    for (uint16_t r = 0; r < count; r++) {
        const uint8_t *rec = buf + EOG_HDR_LEN + EOG_DATA_LEN * r;
        for (uint32_t i = 0;; i++) {
            uint32_t st = hal_reg_read(EOG_R_STATUS);
            if (!(st & EOG_ST_DATA_BUSY)) break;
            if (i >= EOG_BUSY_SPINS) { S.cnt.busy_timeouts++; break; }
            if (st & (EOG_ST_RESULT_AVAIL | EOG_ST_ALERT_AVAIL)) drain();   /* back-pressure from a full FIFO */
        }
        for (unsigned w = 0; w < 12; w++)       /* word 11 (0x22C) last: it pushes */
            hal_reg_write(EOG_R_DATA + 4 * w, eog_le32(rec + 4 * w));
        S.cnt.data_records++;
    }
}

/* Wait (bounded) until every record taken by the engine has left it: STATS records in == results out and the
 * DATA window idle. Results/alerts are drained into the rings meanwhile so the RESULT FIFO never blocks it. */
static int wait_pipeline_empty(void)
{
    uint32_t t = hal_ms();
    for (uint32_t i = 0; i < 1000000u; i++) {
        drain();
        uint32_t st = hal_reg_read(EOG_R_STATUS);
        if (!(st & EOG_ST_DATA_BUSY) && (st & 0x00FFFF00u) == 0
            && hal_reg_read(EOG_R_STATS + 4 * EOG_HS_REC_IN) == hal_reg_read(EOG_R_STATS + 4 * EOG_HS_RES_OUT))
            return 0;
        if (hal_ms() - t > EOG_DRAIN_TIMEOUT_MS) break;
    }
    return -1;
}

/* ---------- 7003 CONFIG / HEARTBEAT ---------- */
static void config_ack(uint32_t ip, uint16_t port, uint16_t fid, uint8_t status, uint32_t acked_seq)
{
    uint8_t p[EOG_HDR_LEN + EOG_CONFIG_ACK_LEN];
    eog_put_header(p, EOG_T_CONFIG_ACK, 1, G.seq_cfg++, 0);
    eog_put16(p + 16, fid);
    p[18] = status;
    p[19] = 0;
    eog_put32(p + 20, acked_seq);
    if (send(EOG_PORT_CONFIG, ip, port, p, sizeof p) == 0) S.cnt.config_acks++;
}

static void write_slot(uint32_t f, const uint8_t *rec)
{
    uint32_t base = EOG_R_CONFIG + 64u * f, w0 = eog_le32(rec);
    /* An enabled slot only accepts a word-0 write that clears FLAGS[0] (byte 3 bit 0): disable, fill, enable. */
    hal_reg_write(base, w0 & ~(1u << 24));
    for (unsigned w = 1; w < 16; w++) hal_reg_write(base + 4 * w, eog_le32(rec + 4 * w));
    hal_reg_write(base, w0);
}

static void on_config(uint32_t ip, uint16_t port, const uint8_t *buf, uint32_t len)
{
    uint8_t type = buf[5];
    uint16_t count = eog_le16(buf + 6);
    uint32_t seq = eog_le32(buf + 8), aux = eog_le32(buf + 12);
    if (type == EOG_T_HEARTBEAT) {
        ctrl_pulse(EOG_CTRL_HB);                     /* any source address/port (ruling #68) */
        S.cnt.heartbeats++;
        return;
    }
    if (type != EOG_T_CONFIG) { S.cnt.bad_packets++; return; }
    if (aux == 0) {                                     /* GLOBAL CONFIG */
        if (len < EOG_HDR_LEN + EOG_GLOBAL_LEN) { S.cnt.bad_packets++; return; }
        /* GLOBAL writes are ignored while streaming (ruling #69): stream off, drain, write, stream back on */
        uint32_t was = hal_reg_read(EOG_R_CTRL) & EOG_CTRL_STREAM_EN;
        if (was) {
            ctrl_set(S.ctrl & ~EOG_CTRL_STREAM_EN);
            if (wait_pipeline_empty()) S.cnt.drain_timeouts++;
        }
        for (unsigned w = 0; w < 8; w++) hal_reg_write(EOG_R_GLOBAL + 4 * w, eog_le32(buf + EOG_HDR_LEN + 4 * w));
        if (was) ctrl_set(S.ctrl | EOG_CTRL_STREAM_EN);
        S.have_global = 1;
        config_ack(ip, port, 0xFFFF, EOG_CFG_OK, seq);
        return;
    }
    if (len < EOG_HDR_LEN + (uint32_t)EOG_FACCFG_LEN * count) { S.cnt.bad_packets++; return; }
    for (uint16_t i = 0; i < count; i++) {
        const uint8_t *rec = buf + EOG_HDR_LEN + EOG_FACCFG_LEN * i;
        uint16_t fid = eog_le16(rec);
        if (fid >= S.n_fac) {
            config_ack(ip, port, fid, EOG_CFG_BAD_SLOT, seq);
            continue;
        }
        write_slot(fid, rec);
        config_ack(ip, port, fid, EOG_CFG_OK, seq);
    }
}

/* ---------- 7004 WEIGHTS ---------- */
static int wait_swap_idle(void)
{
    uint32_t t = hal_ms();
    for (uint32_t i = 0; i < 1000000u; i++) {
        if (!(hal_reg_read(EOG_R_STATUS) & EOG_ST_SWAP_PENDING)) return 0;
        if (hal_ms() - t > EOG_SWAP_TIMEOUT_MS) break;
    }
    return -1;
}

static int load_bank(const uint8_t *b, uint8_t ver)
{
    if (wait_swap_idle()) return EOG_W_OK;            /* a previous swap is stuck: leave the banks alone */
    for (unsigned w = 0; w < EOG_BLOB_HDR_LEN / 4; w++) hal_reg_write(EOG_R_WEIGHTS + 4 * w, eog_le32(b + 4 * w));
    hal_reg_write(EOG_R_WVER, ver);
    ctrl_pulse(EOG_CTRL_SWAP_REQ);
    return wait_swap_idle() ? EOG_W_OK : EOG_W_SWAPPED;   /* OK = accepted, swap still pending */
}

static void on_weights(uint32_t ip, uint16_t port, const uint8_t *buf, uint32_t len)
{
    if (buf[5] != EOG_T_WEIGHTS || len < EOG_HDR_LEN + 8) { S.cnt.bad_packets++; return; }
    uint32_t aux = eog_le32(buf + 12);
    uint32_t off = eog_le32(buf + 16);
    uint16_t n = eog_le16(buf + 20), flags = eog_le16(buf + 22);
    uint8_t status = EOG_W_OK;
    if (flags & 1u) {                                   /* COMMIT: total length u32, CRC32 u32 */
        if (len < EOG_HDR_LEN + 16) { S.cnt.bad_packets++; return; }
        uint32_t total = eog_le32(buf + 24), crc = eog_le32(buf + 28);
        if (total > S.blob_len) status = EOG_W_LENGTH;
        else if (eog_crc32(G.blob, total) != crc) status = EOG_W_CRC;
        else if ((status = (uint8_t)eog_blob_check(G.blob, total)) == EOG_W_OK)
            status = (uint8_t)load_bank(G.blob, (uint8_t)aux);
        S.blob_len = 0;
    } else if ((uint64_t)off + n > EOG_MAX_BLOB || len < EOG_HDR_LEN + 8u + n) {
        status = EOG_W_LENGTH;
    } else {
        if (off > S.blob_len) memset(G.blob + S.blob_len, 0, off - S.blob_len);
        memcpy(G.blob + off, buf + EOG_HDR_LEN + 8, n);
        if (off + n > S.blob_len) S.blob_len = off + n;
    }
    uint8_t p[EOG_HDR_LEN + EOG_WEIGHTS_ACK_LEN];
    eog_put_header(p, EOG_T_WEIGHTS_ACK, 1, G.seq_w++, aux);
    eog_put32(p + 16, off);
    p[20] = status;
    p[21] = (uint8_t)(hal_reg_read(EOG_R_STATUS) >> 24);
    eog_put16(p + 22, 0);
    if (send(EOG_PORT_WEIGHTS, ip, port, p, sizeof p) == 0) S.cnt.weights_acks++;
}

/* ---------- API ---------- */
int eog_init(uint32_t default_peer_ip)
{
    memset(&G.s, 0, sizeof G.s);
    G.seq_res = G.seq_al = G.seq_cfg = G.seq_w = 0;
    G.have_data_seq = 0;
    G.next_data_seq = 0;
    G.res_drop_since_pkt = 0;
    G.res_head = G.al_head = 0;
    S.peer_ip = default_peer_ip;
    int ok = hal_reg_read(EOG_R_ID) == EOG_ID_VALUE ? 0 : -1;
    uint32_t nf = (hal_reg_read(EOG_R_VERSION) >> 8) & 0xFFu;
    S.n_fac = (nf == 0 || nf > EOG_MAX_FAC) ? EOG_MAX_FAC : nf;
    /* Fresh engine state (weights survive a soft reset), counters cleared, stream off, stale FIFOs dropped. */
    hal_reg_write(EOG_R_CTRL, EOG_CTRL_SOFT_RST | EOG_CTRL_STATS_CLR);
    ctrl_set(0);
    drain();
    S.res_pending = S.al_pending = 0;
    G.res_head = G.al_head = 0;
    memset(&S.cnt, 0, sizeof S.cnt);
    G.t0 = G.last_stats = hal_ms();
    return ok;
}

void eog_rx(uint16_t local_port, uint32_t src_ip, uint16_t src_port, const uint8_t *buf, uint32_t len)
{
    S.cnt.rx_packets++;
    if (!hdr_ok(buf, len)) { S.cnt.bad_packets++; return; }
    switch (local_port) {
    case EOG_PORT_DATA:    on_data(buf, len); break;
    case EOG_PORT_CONFIG:  on_config(src_ip, src_port, buf, len); break;
    case EOG_PORT_WEIGHTS: on_weights(src_ip, src_port, buf, len); break;
    default:               S.cnt.bad_packets++; break;
    }
}

void eog_poll(void)
{
    drain();
    if (!S.autonomous) flush();
    uint32_t now = hal_ms();
    if (now - G.last_stats >= EOG_STATS_PERIOD_MS) {
        G.last_stats = now;
        send_stats(now);
    }
}
