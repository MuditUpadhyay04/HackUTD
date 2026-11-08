/*
 * simboard.c — eog_proto + the fake eog_regs model as a process that talks over stdin/stdout, so a Python
 * bridge (simboard_bridge.py) can put real UDP sockets in front of it and Mudit's features_int.py behind the
 * DATA window. Every line is one message (hex = lowercase byte string):
 *
 *   in   U <local_port> <src_ip_u32> <src_port> <hex>     a datagram arrived
 *        R <result_hex> [<alert_hex> ...]                  engine reply to an E request
 *        X                                                 exit
 *   out  S <src_port> <dst_ip_u32> <dst_port> <hex>        send a datagram
 *        C <global_hex> <slot0_hex> ... <slot31_hex> <touched_mask>   GLOBAL/CONFIG changed (before the next E)
 *        W <version> <window_hex>                          a weight swap executed (280 B blob window)
 *        E <autonomous> <data_hex>                         run one DATA record; blocks until R
 *
 *   simboard <default_peer_ip_u32>
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <unistd.h>

#include "../eog_proto.h"
#include "fake_regs.h"

static char inbuf[1 << 20];
static size_t in_len;
/* lines that arrived while waiting for an engine reply */
static char *queue[4096];
static int q_head, q_n;

static void put_hex(const uint8_t *p, size_t n)
{
    static const char hx[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) { putchar(hx[p[i] >> 4]); putchar(hx[p[i] & 15]); }
}

static size_t get_hex(const char *s, uint8_t *out, size_t max)
{
    size_t n = 0;
    while (s[0] && s[1] && n < max && s[0] != ' ') {
        unsigned v;
        if (sscanf(s, "%2x", &v) != 1) break;
        out[n++] = (uint8_t)v;
        s += 2;
    }
    return n;
}

int hal_udp_send(uint16_t sport, uint32_t ip, uint16_t dport, const uint8_t *buf, uint16_t len)
{
    printf("S %u %u %u ", sport, ip, dport);
    put_hex(buf, len);
    putchar('\n');
    fflush(stdout);
    return 0;
}

/* Blocking read of one complete line from stdin; returns NULL on EOF. */
static char *read_line(void)
{
    for (;;) {
        char *nl = memchr(inbuf, '\n', in_len);
        if (nl) {
            size_t n = (size_t)(nl - inbuf);
            char *line = malloc(n + 1);
            memcpy(line, inbuf, n);
            line[n] = 0;
            memmove(inbuf, nl + 1, in_len - n - 1);
            in_len -= n + 1;
            return line;
        }
        ssize_t r = read(0, inbuf + in_len, sizeof inbuf - in_len);
        if (r <= 0) { if (r < 0 && errno == EINTR) continue; return NULL; }
        in_len += (size_t)r;
    }
}

static void pipe_engine(const uint8_t rec[48], int autonomous)
{
    if (FR.swapped) {
        FR.swapped = 0;
        uint8_t w[280];
        for (unsigned i = 0; i < 70; i++) eog_put32(w + 4 * i, FR.wwin[i]);
        printf("W %u ", FR.active_ver);
        put_hex(w, sizeof w);
        putchar('\n');
    }
    if (FR.cfg_dirty) {
        FR.cfg_dirty = 0;
        uint8_t b[64];
        putchar('C');
        for (unsigned i = 0; i < 8; i++) eog_put32(b + 4 * i, hal_reg_read(EOG_R_GLOBAL + 4 * i));
        putchar(' ');
        put_hex(b, 32);
        for (unsigned f = 0; f < 32; f++) {
            for (unsigned i = 0; i < 16; i++) eog_put32(b + 4 * i, hal_reg_read(EOG_R_CONFIG + 64 * f + 4 * i));
            putchar(' ');
            put_hex(b, 64);
        }
        printf(" %u\n", FR.touched_mask);
        FR.touched_mask = 0;
    }
    printf("E %d ", autonomous);
    put_hex(rec, 48);
    putchar('\n');
    fflush(stdout);
    for (;;) {
        char *line = read_line();
        if (!line) exit(0);
        if (line[0] != 'R') {
            if (q_n == 4096) { fprintf(stderr, "simboard: queue full\n"); exit(3); }
            queue[(q_head + q_n++) % 4096] = line;
            continue;
        }
        const char *s = line + 2;
        uint8_t r[32] = {0}, a[16];
        get_hex(s, r, 32);
        fr_push_result(r);
        while ((s = strchr(s, ' ')) != NULL) {
            s++;
            if (get_hex(s, a, 16) == 16) fr_push_alert(a);
        }
        free(line);
        return;
    }
}

/* the oldest unprocessed line (queued first, then complete lines in inbuf), or NULL */
static char *next_buffered(void)
{
    if (q_n) {
        char *l = queue[q_head];
        q_head = (q_head + 1) % 4096;
        q_n--;
        return l;
    }
    return memchr(inbuf, '\n', in_len) ? read_line() : NULL;
}

static int handle(char *line)
{
    if (line[0] == 'X') return 1;
    if (line[0] == 'U') {
        unsigned port, sport;
        unsigned long ip;
        int off = 0;
        if (sscanf(line + 2, "%u %lu %u %n", &port, &ip, &sport, &off) >= 3 && off > 0) {
            static uint8_t pkt[65536];
            size_t n = get_hex(line + 2 + off, pkt, sizeof pkt);
            eog_rx((uint16_t)port, (uint32_t)ip, (uint16_t)sport, pkt, (uint32_t)n);
        }
    }
    return 0;
}

int main(int argc, char **argv)
{
    fr_reset();
    FR.use_real_clock = 1;
    FR.engine = pipe_engine;
    FR.cfg_dirty = 1;
    eog_init(argc > 1 ? (uint32_t)strtoul(argv[1], NULL, 0) : 0x0100007Fu);
    for (;;) {
        char *l;
        while ((l = next_buffered()) != NULL) {
            int stop = handle(l);
            free(l);
            if (stop) return 0;
        }
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(0, &fds);
        struct timeval tv = {0, 2000};
        if (select(1, &fds, NULL, NULL, &tv) > 0) {
            ssize_t k = read(0, inbuf + in_len, sizeof inbuf - in_len);
            if (k <= 0) return 0;
            in_len += (size_t)k;
        }
        eog_poll();
        fflush(stdout);
    }
}
