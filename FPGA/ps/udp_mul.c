/*
 * udp_mul.c — Zynq PS side: lwIP raw-API UDP server that drives axi_mul.
 *
 * Drop-in replacement for echo.c in the Vitis "lwIP Echo Server" template:
 * it provides the three functions that template's main.c calls
 *   print_app_header(), start_application(), transfer_data()
 * so main.c (MAC/PHY/DHCP bring-up, timers, xemacif_input loop) is untouched.
 *
 * Protocol (UDP port MUL_PORT, all fields big-endian / network order):
 *   request  (16 B): magic u32 | seq u32 | a i32 | b i32
 *   response (28 B): magic u32 | seq u32 | status u32 | a i32 | b i32 | p_hi u32 | p_lo u32
 *   status: 0 OK, 1 bad length, 2 bad magic, 3 hardware timeout
 */

#include <stdint.h>
#include <string.h>

#include "lwip/udp.h"
#include "lwip/pbuf.h"
#include "lwip/ip_addr.h"
#include "xil_io.h"
#include "xil_printf.h"
#include "xparameters.h"
#include "xil_cache.h"
#include "xil_mmu.h"

/* Built inside eog_app.c (EOG_APP defined): eog_app.c owns the template entry points, this file keeps the
 * 7777 multiply server under mul_* names, and the 7000 perf probe is left out (7000 carries DATA there). */
#ifdef EOG_APP
#define UDP_MUL_ENTRY(name) mul_##name
#else
#define UDP_MUL_ENTRY(name) name
#endif

/* Matches mul_base in vivado/build.tcl. If your xparameters.h defines the
 * module-reference base address, that wins. */
#if defined(XPAR_AXI_MUL_0_BASEADDR)
#define MUL_BASEADDR XPAR_AXI_MUL_0_BASEADDR
#else
#define MUL_BASEADDR 0x43C00000U
#endif

#define MUL_PORT        7777
#define MUL_MAGIC       0x4D554C31U   /* "MUL1" */
#define REQ_LEN         16
#define RSP_LEN         28

/* axi_mul register offsets */
#define REG_CTRL        0x00
#define REG_STATUS      0x04
#define REG_A           0x08
#define REG_B           0x0C
#define REG_PLO         0x10
#define REG_PHI         0x14
#define REG_ID          0x18
#define REG_COUNT       0x1C
#define STATUS_DONE     0x1
#define POLL_LIMIT      1000          /* hardware latency is 3 PL clocks */

enum { ST_OK = 0, ST_BAD_LEN = 1, ST_BAD_MAGIC = 2, ST_HW_TIMEOUT = 3 };

static struct udp_pcb *mul_pcb;
static uint32_t n_rx, n_err;

/* ---------- helpers ---------- */
static inline uint32_t get_be32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8)  |  (uint32_t)p[3];
}

static inline void put_be32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);  p[3] = (uint8_t)v;
}

/* Run one multiply on the PL. Returns 0 on success, -1 on timeout. */
static int hw_multiply(int32_t a, int32_t b, uint32_t *p_hi, uint32_t *p_lo)
{
    Xil_Out32(MUL_BASEADDR + REG_A, (uint32_t)a);
    Xil_Out32(MUL_BASEADDR + REG_B, (uint32_t)b);
    Xil_Out32(MUL_BASEADDR + REG_CTRL, 1);

    for (int i = 0; i < POLL_LIMIT; i++) {
        if (Xil_In32(MUL_BASEADDR + REG_STATUS) & STATUS_DONE) {
            *p_lo = Xil_In32(MUL_BASEADDR + REG_PLO);
            *p_hi = Xil_In32(MUL_BASEADDR + REG_PHI);
            return 0;
        }
    }
    return -1;
}

/* Power-on check of the PL before we open the socket. */
static int hw_selftest(void)
{
    static const int32_t v[][2] = {
        {0, 0}, {7, 6}, {-1, 1}, {-1, -1},
        {0x7FFFFFFF, 0x7FFFFFFF}, {(int32_t)0x80000000, (int32_t)0x80000000},
        {123456, -789},
    };
    uint32_t id = Xil_In32(MUL_BASEADDR + REG_ID);
    if (id != MUL_MAGIC) {
        xil_printf("axi_mul: bad ID 0x%08x at 0x%08x (bitstream loaded? address right?)\r\n",
                   id, MUL_BASEADDR);
        return -1;
    }
    int fails = 0;
    for (unsigned i = 0; i < sizeof(v) / sizeof(v[0]); i++) {
        uint32_t hi, lo;
        int64_t exp = (int64_t)v[i][0] * (int64_t)v[i][1];
        if (hw_multiply(v[i][0], v[i][1], &hi, &lo) != 0 ||
            hi != (uint32_t)((uint64_t)exp >> 32) || lo != (uint32_t)exp) {
            xil_printf("axi_mul: selftest %d FAILED\r\n", i);
            fails++;
        }
    }
    xil_printf("axi_mul: selftest %s (%d vectors)\r\n", fails ? "FAILED" : "passed",
               (int)(sizeof(v) / sizeof(v[0])));
    return fails ? -1 : 0;
}

/* ---------- UDP callback ---------- */
static void mul_recv(void *arg, struct udp_pcb *upcb, struct pbuf *p,
                     const ip_addr_t *addr, u16_t port)
{
    (void)arg;
    uint8_t req[REQ_LEN] = {0};
    uint8_t rsp[RSP_LEN] = {0};
    uint32_t status = ST_OK, seq = 0, p_hi = 0, p_lo = 0;
    int32_t a = 0, b = 0;

    if (p == NULL) return;
    n_rx++;

    u16_t len = p->tot_len;
    pbuf_copy_partial(p, req, (len < REQ_LEN) ? len : REQ_LEN, 0);
    pbuf_free(p);

    if (len >= 8) seq = get_be32(&req[4]);

    if (len != REQ_LEN) {
        status = ST_BAD_LEN;
    } else if (get_be32(&req[0]) != MUL_MAGIC) {
        status = ST_BAD_MAGIC;
    } else {
        a = (int32_t)get_be32(&req[8]);
        b = (int32_t)get_be32(&req[12]);
        if (hw_multiply(a, b, &p_hi, &p_lo) != 0) status = ST_HW_TIMEOUT;
    }
    if (status != ST_OK) n_err++;

    put_be32(&rsp[0],  MUL_MAGIC);
    put_be32(&rsp[4],  seq);
    put_be32(&rsp[8],  status);
    put_be32(&rsp[12], (uint32_t)a);
    put_be32(&rsp[16], (uint32_t)b);
    put_be32(&rsp[20], p_hi);
    put_be32(&rsp[24], p_lo);

    struct pbuf *q = pbuf_alloc(PBUF_TRANSPORT, RSP_LEN, PBUF_RAM);
    if (q == NULL) { n_err++; return; }
    memcpy(q->payload, rsp, RSP_LEN);
    udp_sendto(upcb, q, addr, port);
    pbuf_free(q);
}


#ifndef EOG_APP
/* ---------- UDP receive-ceiling probe (port 7000) ----------
 * Measures how many UDP packets/bytes the ARM + lwIP can absorb.
 *   PRF1 packet: magic u32 | seq u32 | mode u32 | payload...   (mode 0 = count, 1 = copy + cache flush)
 *   STA1 packet: request counters; reply = 15 x u32 (big-endian), see perf_reply()
 *   CLR1 packet: zero all counters; reply = CLR1
 * GEM0 statistics registers are clear-on-read, so they are accumulated here. */
#define PERF_PORT   7000
#define PRF_MAGIC   0x50524631U   /* "PRF1" */
#define STA_MAGIC   0x53544131U   /* "STA1" */
#define CLR_MAGIC   0x434C5231U   /* "CLR1" */
#define GEM0_BASE   0xE000B000U

static struct udp_pcb *perf_pcb;
static uint32_t pf_pkts, pf_copy, pf_bad, pf_gaps, pf_ooo, pf_last_seq;
static uint64_t pf_bytes, loop_iter;
static uint32_t mac_rx, mac_reserr, mac_overrun, mac_fcs;
static uint8_t ring[65536] __attribute__((aligned(32)));
static uint32_t ring_off;
/* 1 MB section mapped Normal non-cacheable at start-up (mode 3). */
static uint8_t nc_ring[1U << 20] __attribute__((aligned(1U << 20)));
static uint32_t nc_off;
/* Zero-copy stand-in (mode 4): hold pbufs as if a DMA engine still owned them. */
#define HOLD_N 256
static struct pbuf *held[HOLD_N];
static uint32_t held_head, held_n;

static void hold_release_all(void)
{
    while (held_n) {
        pbuf_free(held[held_head]);
        held_head = (held_head + 1) % HOLD_N;
        held_n--;
    }
}

static void mac_stats_accumulate(void)
{
    mac_rx      += Xil_In32(GEM0_BASE + 0x158);
    mac_reserr  += Xil_In32(GEM0_BASE + 0x1A0);
    mac_overrun += Xil_In32(GEM0_BASE + 0x1A4);
    mac_fcs     += Xil_In32(GEM0_BASE + 0x190);
}

static void perf_reply(struct udp_pcb *upcb, const ip_addr_t *addr, u16_t port, uint32_t magic)
{
    uint32_t v[15] = { magic, pf_pkts, (uint32_t)(pf_bytes >> 32), (uint32_t)pf_bytes,
                       pf_gaps, pf_ooo, pf_last_seq, pf_bad, pf_copy,
                       mac_rx, mac_reserr, mac_overrun, mac_fcs,
                       (uint32_t)(loop_iter >> 32), (uint32_t)loop_iter };
    struct pbuf *q = pbuf_alloc(PBUF_TRANSPORT, sizeof v, PBUF_RAM);
    if (q == NULL) return;
    for (int i = 0; i < 15; i++) put_be32((uint8_t *)q->payload + 4 * i, v[i]);
    udp_sendto(upcb, q, addr, port);
    pbuf_free(q);
}

static void perf_recv(void *arg, struct udp_pcb *upcb, struct pbuf *p,
                      const ip_addr_t *addr, u16_t port)
{
    (void)arg;
    if (p == NULL) return;
    u16_t len = p->tot_len;
    if (len < 4 || p->len < 4) { pf_bad++; pbuf_free(p); return; }
    const uint8_t *b = (const uint8_t *)p->payload;
    uint32_t magic = get_be32(b);

    if (magic == PRF_MAGIC && len >= 12 && p->len >= 12) {
        uint32_t seq = get_be32(b + 4), mode = get_be32(b + 8);
        pf_pkts++;
        pf_bytes += len;
        if (seq > pf_last_seq) {
            pf_gaps += seq - pf_last_seq - 1;
            pf_last_seq = seq;
        } else {
            pf_ooo++;
        }
        switch (mode) {
        case 1:   /* copy into cached ring + flush (what a non-coherent DMA needs) */
        case 2:   /* copy only */
            if (ring_off + len > sizeof ring) ring_off = 0;
            pbuf_copy_partial(p, ring + ring_off, len, 0);
            if (mode == 1) Xil_DCacheFlushRange((INTPTR)(ring + ring_off), len);
            ring_off += (len + 31U) & ~31U;
            pf_copy++;
            break;
        case 3:   /* copy into non-cacheable memory, no flush needed */
            if (nc_off + len > sizeof nc_ring) nc_off = 0;
            pbuf_copy_partial(p, nc_ring + nc_off, len, 0);
            nc_off += (len + 31U) & ~31U;
            pf_copy++;
            break;
        case 4:   /* zero-copy: keep the pbuf, free the oldest when the window is full */
            if (held_n == HOLD_N) {
                pbuf_free(held[held_head]);
                held_head = (held_head + 1) % HOLD_N;
                held_n--;
            }
            held[(held_head + held_n) % HOLD_N] = p;
            held_n++;
            pf_copy++;
            return;
        case 5:   /* cache flush of the received payload only */
            Xil_DCacheFlushRange((INTPTR)p->payload, p->len);
            pf_copy++;
            break;
        default:
            break;
        }
        pbuf_free(p);
        return;
    }
    pbuf_free(p);
    if (magic == STA_MAGIC) {
        mac_stats_accumulate();
        perf_reply(upcb, addr, port, STA_MAGIC);
    } else if (magic == CLR_MAGIC) {
        mac_stats_accumulate();
        hold_release_all();
        pf_pkts = pf_copy = pf_bad = pf_gaps = pf_ooo = pf_last_seq = 0;
        pf_bytes = loop_iter = 0;
        mac_rx = mac_reserr = mac_overrun = mac_fcs = 0;
        perf_reply(upcb, addr, port, CLR_MAGIC);
    } else {
        pf_bad++;
    }
}

#endif /* !EOG_APP */

/* ---------- functions the template's main.c calls ---------- */
void UDP_MUL_ENTRY(print_app_header)(void)
{
    xil_printf("\r\n----- HackUTD FPGA link: UDP multiply server -----\r\n");
    xil_printf("UDP port %d, axi_mul at 0x%08x\r\n", MUL_PORT, MUL_BASEADDR);
    xil_printf("request 16B: magic|seq|a|b   response 28B: magic|seq|status|a|b|p_hi|p_lo\r\n");
}

int UDP_MUL_ENTRY(start_application)(void)
{
    hw_selftest();   /* report only; keep serving so errors show up on the host too */

    mul_pcb = udp_new();
    if (mul_pcb == NULL) {
        xil_printf("udp_new failed\r\n");
        return -1;
    }
    err_t err = udp_bind(mul_pcb, IP_ADDR_ANY, MUL_PORT);
    if (err != ERR_OK) {
        xil_printf("udp_bind(%d) failed: %d\r\n", MUL_PORT, err);
        return -2;
    }
    udp_recv(mul_pcb, mul_recv, NULL);
    xil_printf("UDP multiply server listening on port %d\r\n", MUL_PORT);

#ifndef EOG_APP
    perf_pcb = udp_new();
    if (perf_pcb == NULL || udp_bind(perf_pcb, IP_ADDR_ANY, PERF_PORT) != ERR_OK) {
        xil_printf("perf probe: bind %d failed\r\n", PERF_PORT);
        return -3;
    }
    udp_recv(perf_pcb, perf_recv, NULL);
    Xil_SetTlbAttributes((INTPTR)nc_ring, NORM_NONCACHE);
    mac_stats_accumulate();
    xil_printf("UDP perf probe listening on port %d\r\n", PERF_PORT);
#endif
    return 0;
}

#ifndef EOG_APP
/* Called every main-loop iteration; prints a heartbeat every 2^24 calls. */
void UDP_MUL_ENTRY(transfer_data)(void)
{
    static uint32_t ticks;
    loop_iter++;
    static uint32_t last_pk = 0xFFFFFFFFU;
    if ((++ticks & 0x00FFFFFFU) != 0) return;
    /* Print only when idle: a blocking UART print (~4 ms) would drop packets mid-test. */
    uint32_t pk = pf_pkts;
    int idle = (pk == last_pk);
    last_pk = pk;
    if (idle)
        xil_printf("[udp_mul] rx=%d err=%d hw_ops=%d\r\n", (int)n_rx, (int)n_err,
                   (int)Xil_In32(MUL_BASEADDR + REG_COUNT));
}
#endif /* !EOG_APP */
