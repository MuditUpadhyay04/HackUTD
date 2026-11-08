/*
 * eog_app.c — Zynq PS (Vitis standalone + lwIP raw API) glue for the EOG engine, task T2.ps1 (v1: AXI-Lite).
 *
 * Drop-in replacement for echo.c in the Vitis "lwIP Echo Server" template, like udp_mul.c: it provides
 * print_app_header(), start_application() and transfer_data(), so the template's main.c is untouched.
 * Everything protocol-related lives in eog_proto.c (portable, host-tested in ps/test/); this file only
 * implements its HAL on the board:
 *   hal_reg_read/write -> Xil_In32/Xil_Out32 at eog_regs (0x43C1_0000, FPGA/spec/regmap.md)
 *   hal_udp_send       -> udp_sendto on the pcb bound to the source port
 *   hal_ms             -> the Cortex-A9 global timer (XTime_GetTime)
 *   hal_read_file      -> FatFs on the microSD card (eog_sd.c, xilffs)
 *   hal_log            -> UART (xil_printf)
 * and keeps the 7777 multiply health check of udp_mul.c (compiled in here with EOG_APP, perf probe left out).
 *
 * Boot (FPGA/docs/SD_BOOT_WEIGHTS.md): the board boots from the microSD card (BOOT.BIN). start_application() runs
 * eog_init(), then eog_boot_load_weights() (weights.eog from the card, the same checks as a WEIGHTS COMMIT), and
 * only then opens the UDP ports. The outcome is on the UART: "SD weights v<N> active ..." or the failure reason.
 *
 * Unity build: this one file is what Vitis compiles. deploy/vitis_build.py copies eog_proto.c/.h, eog_sd.c and
 * udp_mul.c next to it as eog_inc/eog_proto_c.h, eog_inc/eog_proto.h, eog_inc/eog_sd_c.h, eog_inc/udp_mul_c.h
 * (header names, so a build that globs *.c never compiles them twice):
 *   vitis -s deploy/vitis_build.py <ws> <xsa> ps/eog_app.c ps/eog_proto.c ps/eog_proto.h ps/eog_sd.c ps/udp_mul.c
 */
#define EOG_APP 1

#if defined(__has_include)
#if __has_include("eog_inc/eog_proto_c.h")
#define EOG_INC_DIR 1
#endif
#endif
#ifdef EOG_INC_DIR
#include "eog_inc/eog_proto_c.h"
#include "eog_inc/eog_sd_c.h"
#include "eog_inc/udp_mul_c.h"
#else
#include "eog_proto.c"
#include "eog_sd.c"
#include "udp_mul.c"
#endif

#include "lwip/ip_addr.h"
#include "lwip/pbuf.h"
#include "lwip/udp.h"
#include "xil_io.h"
#include "xil_printf.h"
#include "xparameters.h"
#include "xtime_l.h"

#if defined(XPAR_EOG_TOP_0_BASEADDR)
#define EOG_BASEADDR XPAR_EOG_TOP_0_BASEADDR
#else
#define EOG_BASEADDR EOG_REGS_BASE        /* 0x43C10000, vivado block design (T2.bd1) */
#endif

/* The PC on the direct cable (ruling #68: RESULT/STATS/ALERT always go here). */
#define PC_IP0 192
#define PC_IP1 168
#define PC_IP2 1
#define PC_IP3 50

static struct udp_pcb *pcb_data, *pcb_cfg, *pcb_wts, *pcb_out;
static uint8_t rx_copy[2048];             /* only for chained pbufs (frames are <= 1500 B) */
static uint32_t n_rx_drop;

/* ---------- HAL ---------- */
uint32_t hal_reg_read(uint32_t off) { return Xil_In32(EOG_BASEADDR + off); }

void hal_reg_write(uint32_t off, uint32_t val) { Xil_Out32(EOG_BASEADDR + off, val); }

void hal_log(const char *msg) { xil_printf("eog: %s\r\n", msg); }

uint32_t hal_ms(void)
{
    XTime t;
    XTime_GetTime(&t);
    return (uint32_t)(t / (COUNTS_PER_SECOND / 1000u));
}

int hal_udp_send(uint16_t src_port, uint32_t dst_ip, uint16_t dst_port, const uint8_t *buf, uint16_t len)
{
    struct udp_pcb *pcb = src_port == EOG_PORT_CONFIG ? pcb_cfg : src_port == EOG_PORT_WEIGHTS ? pcb_wts : pcb_out;
    struct pbuf *q = pbuf_alloc(PBUF_TRANSPORT, len, PBUF_RAM);
    if (q == NULL) return -1;
    memcpy(q->payload, buf, len);
    ip_addr_t a;
    ip_addr_set_zero_ip4(&a);
    ip4_addr_set_u32(ip_2_ip4(&a), dst_ip);   /* dst_ip is lwIP's own encoding (network order) */
    err_t e = udp_sendto(pcb, q, &a, dst_port);
    pbuf_free(q);
    return e == ERR_OK ? 0 : -1;
}

/* ---------- lwIP receive ---------- */
static void eog_recv(void *arg, struct udp_pcb *upcb, struct pbuf *p, const ip_addr_t *addr, u16_t port)
{
    (void)upcb;
    if (p == NULL) return;
    uint16_t local = (uint16_t)(uintptr_t)arg;
    const uint8_t *data = (const uint8_t *)p->payload;
    uint32_t len = p->tot_len;
    if (p->len != p->tot_len) {               /* chained: make it contiguous */
        if (len > sizeof rx_copy) { n_rx_drop++; pbuf_free(p); return; }
        pbuf_copy_partial(p, rx_copy, (u16_t)len, 0);
        data = rx_copy;
    }
    eog_rx(local, ip4_addr_get_u32(ip_2_ip4(addr)), port, data, len);
    pbuf_free(p);
}

static struct udp_pcb *bind_port(uint16_t port, int rx)
{
    struct udp_pcb *pcb = udp_new();
    if (pcb == NULL || udp_bind(pcb, IP_ADDR_ANY, port) != ERR_OK) {
        xil_printf("eog: bind %d failed\r\n", port);
        return NULL;
    }
    if (rx) udp_recv(pcb, eog_recv, (void *)(uintptr_t)port);
    return pcb;
}

/* ---------- functions the template's main.c calls ---------- */
void print_app_header(void)
{
    mul_print_app_header();
    xil_printf("----- EOG engine app (wire v1): DATA 7000, CONFIG/HEARTBEAT 7003, WEIGHTS 7004 -> "
               "RESULT/STATS 7001, ALERT 7002 at %d.%d.%d.%d -----\r\n", PC_IP0, PC_IP1, PC_IP2, PC_IP3);
}

int start_application(void)
{
    int r = mul_start_application();         /* 7777 health check (axi_mul self-test inside) */
    if (r != 0) return r;
    ip_addr_t pc;
    IP_ADDR4(&pc, PC_IP0, PC_IP1, PC_IP2, PC_IP3);
    if (eog_init(ip4_addr_get_u32(ip_2_ip4(&pc))) != 0)
        xil_printf("eog: ID register at 0x%08x reads 0x%08x, expected 0x%08x (bitstream with eog_top?)\r\n",
                   EOG_BASEADDR, (unsigned)hal_reg_read(EOG_R_ID), EOG_ID_VALUE);
    else
        xil_printf("eog: eog_regs at 0x%08x, VERSION 0x%08x\r\n", EOG_BASEADDR, (unsigned)hal_reg_read(EOG_R_VERSION));
    /* Default model from the SD card before any UDP port is open. On failure the reason is logged and the board
     * runs with no model (weights_ver 0) until WEIGHTS arrive on 7004. */
    eog_boot_load_weights();
    pcb_data = bind_port(EOG_PORT_DATA, 1);
    pcb_cfg = bind_port(EOG_PORT_CONFIG, 1);
    pcb_wts = bind_port(EOG_PORT_WEIGHTS, 1);
    pcb_out = bind_port(EOG_PORT_RESULT, 0);  /* RESULT/STATS/ALERT leave from 7001 */
    if (!pcb_data || !pcb_cfg || !pcb_wts || !pcb_out) return -4;
    xil_printf("eog: listening on 7000/7003/7004\r\n");
    return 0;
}

/* Called every main-loop iteration (between xemacif_input calls). */
void transfer_data(void)
{
    static uint32_t last_print, last_rx;
    eog_poll();
    uint32_t now = hal_ms();
    if (now - last_print >= 10000u) {         /* status line every 10 s, only when idle: */
        const eog_state_t *s = eog_state();   /* a blocking UART print (~4 ms) would starve the RX ring */
        last_print = now;
        int idle = s->cnt.rx_packets == last_rx;
        last_rx = s->cnt.rx_packets;
        if (!idle) return;
        xil_printf("[eog] rx=%d data=%d res=%d al=%d pend=%d auton=%d bad=%d fail=%d mul_rx=%d\r\n",
                   (int)s->cnt.rx_packets, (int)s->cnt.data_records, (int)s->cnt.results_sent,
                   (int)s->cnt.alerts_sent, (int)s->res_pending, s->autonomous, (int)s->cnt.bad_packets,
                   (int)s->cnt.send_fail, (int)n_rx);
    }
}
