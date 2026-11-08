"""udp_perf.py - measure how many UDP packets the board's ARM + lwIP can absorb.

Talks to the perf probe in ps/udp_mul.c (UDP port 7000). For each test it clears the
board counters, sends PRF1 packets for a few seconds (paced or flat out, from one or
more processes), then reads the board counters and the GEM MAC statistics.

  delivered = packets lwIP handed to the app       mac_rx = error-free frames at the MAC
  reserr    = frames the MAC dropped for lack of RX buffers (ARM too slow to recycle them)
Usage: python udp_perf.py [--board 192.168.1.10] [--secs 3] [--quick]
"""
import argparse, json, multiprocessing as mp, socket, struct, sys, time

PORT = 7000
PRF, STA, CLR = 0x50524631, 0x53544131, 0x434C5231
LINE_BPS = 1e9
WIRE_OVERHEAD = 8 + 20 + 14 + 4 + 8 + 12   # UDP + IP + Eth hdr + FCS + preamble + IFG


def line_pps(payload):
    return LINE_BPS / ((payload + WIRE_OVERHEAD) * 8)


def control(board, magic, tries=5):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(0.5)
    try:
        for _ in range(tries):
            s.sendto(struct.pack(">I", magic), (board, PORT))
            try:
                d, _ = s.recvfrom(256)
            except socket.timeout:
                continue
            if len(d) >= 60:
                v = struct.unpack(">15I", d[:60])
                if v[0] == magic:
                    return dict(pkts=v[1], bytes=(v[2] << 32) | v[3], gaps=v[4], ooo=v[5],
                                last_seq=v[6], bad=v[7], copies=v[8], mac_rx=v[9],
                                reserr=v[10], overrun=v[11], fcs=v[12], loops=(v[13] << 32) | v[14])
        raise RuntimeError("no reply from board on UDP %d (magic %08x)" % (PORT, magic))
    finally:
        s.close()


def sender(board, payload, pps, secs, mode, seq0, stride, q):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4 << 20)
    body = bytearray(payload)
    struct.pack_into(">III", body, 0, PRF, 0, mode)
    n, seq = 0, seq0
    t0 = time.perf_counter()
    end = t0 + secs
    period = (1.0 / pps) if pps else 0.0
    nxt = t0
    while True:
        now = time.perf_counter()
        if now >= end:
            break
        if period:
            if now < nxt:
                continue
            nxt += period
        struct.pack_into(">I", body, 4, seq)
        try:
            s.sendto(body, (board, PORT))
            n += 1
        except OSError:
            pass
        seq += stride
    q.put((n, time.perf_counter() - t0))
    s.close()


def run(board, payload, pps, secs, mode, procs):
    control(board, CLR)
    time.sleep(0.05)
    before = control(board, STA)
    q = mp.Queue()
    per = (pps / procs) if pps else 0
    ps = [mp.Process(target=sender, args=(board, payload, per, secs, mode, 1 + i, procs, q))
          for i in range(procs)]
    for p in ps: p.start()
    res = [q.get() for _ in ps]
    for p in ps: p.join()
    time.sleep(0.4)                       # let the board drain its RX ring
    after = control(board, STA)
    sent = sum(r[0] for r in res)
    dt = max(r[1] for r in res)
    d = {k: after[k] - before[k] for k in after}
    recs = max((payload - 16) // 48, 0)
    out = dict(payload=payload, mode=mode, procs=procs, target_pps=round(pps) if pps else "max",
               secs=round(dt, 3), sent=sent, sent_pps=round(sent / dt), mac_rx=d["mac_rx"],
               delivered=d["pkts"], delivered_pps=round(d["pkts"] / dt),
               delivered_mbps=round(d["bytes"] * 8 / dt / 1e6, 1),
               loss_pct=round(100.0 * (sent - d["pkts"]) / sent, 3) if sent else None,
               reserr=d["reserr"], overrun=d["overrun"], fcs=d["fcs"], bad=d["bad"],
               line_pps=round(line_pps(payload)),
               pct_of_line=round(100.0 * d["pkts"] / dt / line_pps(payload), 1),
               records_per_s=round(d["pkts"] * recs / dt) if recs else 0,
               idle_loops_per_s=round(d["loops"] / dt))
    print(json.dumps(out), flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--board", default="192.168.1.10")
    ap.add_argument("--secs", type=float, default=3.0)
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--round2", action="store_true")
    a = ap.parse_args()
    b, T = a.board, a.secs
    print("baseline:", json.dumps(control(b, STA)), flush=True)
    results = []
    # 0) idle CPU reference: main-loop spins per second with no traffic
    control(b, CLR); t0 = time.perf_counter(); time.sleep(T); st = control(b, STA)
    print(json.dumps(dict(test="idle", idle_loops_per_s=round(st["loops"] / (time.perf_counter() - t0)))), flush=True)
    lp = line_pps(1472)
    plan = [(1472, 0.25 * lp, 0, 1), (1472, 0.5 * lp, 0, 1), (1472, 0.75 * lp, 0, 1),
            (1472, 0, 0, 1), (1472, 0, 0, 3),
            (1472, 0, 1, 1), (1472, 0, 1, 3)]
    if a.round2:
        plan = [(1472, 0, m, 1) for m in (0, 1, 2, 3, 4, 5)]
        plan += [(1472, f * lp, m, 1) for m in (1, 2, 3, 5) for f in (0.5, 0.75)]
        plan += [(1024, 0, 4, 3), (1024, 0, 3, 3)]
    elif not a.quick:
        plan += [(1024, 0, 0, 3), (512, 0, 0, 3), (256, 0, 0, 3), (64, 0, 0, 3),
                 (512, 0, 1, 3), (64, 0, 1, 3)]
    for payload, pps, mode, procs in plan:
        try:
            results.append(run(b, payload, pps, T, mode, procs))
        except Exception as e:
            print("ERROR", payload, pps, mode, procs, e, flush=True)
    print("PERF_DONE", flush=True)


if __name__ == "__main__":
    mp.freeze_support()
    main()
