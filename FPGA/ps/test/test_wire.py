"""test_wire.py — byte-compare the packets the C protocol (eog_proto via build/simboard) sends against packets
built with Mudit's wire.py, on his golden set v2 (CONFIG, WEIGHTS, DATA -> RESULT, ALERT, STATS, HEARTBEAT).

    python FPGA/ps/test/test_wire.py [--ml <dir containing hutd_ml>] [--golden <artifacts/v2/golden>] [--g1 N]

No sockets: datagrams are injected into simboard directly. Needs numpy (Windows Python) and build/simboard
(bash FPGA/scripts/wsl.sh bash FPGA/ps/test/build.sh).
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import simboard_bridge as sb  # noqa: E402

PC, PC_PORT = "192.168.1.50", 50123
N_PASS = N_FAIL = 0


def check(cond, what):
    global N_PASS, N_FAIL
    if cond:
        N_PASS += 1
    else:
        N_FAIL += 1
        print(f"  FAIL {what}")


def run_golden(ml, gdir, n_records=None, hb_timeout=None, midrun=False):
    import numpy as np
    wire, fi, mi = sb.import_ml(ml)
    b = sb.SimBoard(pc=PC, ml_dir=ml, udp=False)
    try:
        glob = np.fromfile(gdir / "global_config.bin", dtype=wire.GLOBAL_CONFIG_DTYPE)
        fac = np.fromfile(gdir / "facility_config.bin", dtype=wire.FAC_CONFIG_DTYPE)
        data = np.fromfile(gdir / "data.bin", dtype=wire.DATA_DTYPE)
        exp = np.fromfile(gdir / "expected_results.bin", dtype=wire.RESULT_DTYPE)
        man = json.loads((gdir / "manifest.json").read_text())
        exp_alerts = json.loads((gdir / "expected_alerts.json").read_text())
        if n_records:
            data, exp = data[:n_records], exp[:n_records]
            last = int(exp["result_no"][-1])
            exp_alerts = [a for a in exp_alerts if a["result_no"] <= last]
        if hb_timeout is not None:
            glob = glob.copy()
            glob["hb_timeout_ms"] = hb_timeout

        # GLOBAL CONFIG -> CONFIG_ACK (fac 0xFFFF)
        b.inject(wire.PORT_CONFIG, PC, PC_PORT, wire.header(wire.T_CONFIG, 1, 5, 0) + glob.tobytes())
        s = b.wait_sent(1)
        check(len(s) == 1 and s[0] == (wire.PORT_CONFIG, PC, PC_PORT,
                                       wire.header(wire.T_CONFIG_ACK, 1, 0) + wire.CONFIG_ACK.pack(0xFFFF, 0, 0, 5)),
              f"GLOBAL CONFIG_ACK bytes: {s[:1]}")
        b.take()

        # Facility CONFIG: all rows in one packet + an out-of-range slot
        bad = fac[:1].copy()
        bad["fac_id"] = 40
        rows = np.concatenate([fac, bad])
        b.inject(wire.PORT_CONFIG, PC, PC_PORT, wire.header(wire.T_CONFIG, len(rows), 6, 1) + rows.tobytes())
        s = b.wait_sent(len(rows))
        want = [(wire.PORT_CONFIG, PC, PC_PORT, wire.header(wire.T_CONFIG_ACK, 1, i + 1)
                 + wire.CONFIG_ACK.pack(int(r["fac_id"]), 1 if int(r["fac_id"]) >= 32 else 0, 0, 6))
                for i, r in enumerate(rows)]
        check(s == want, f"Facility CONFIG_ACK bytes ({len(s)} vs {len(want)})")
        b.take()

        # WEIGHTS: one chunk + COMMIT (board.py's packets) -> WEIGHTS_ACK OK, then swapped
        blob = (gdir / "weights.bin").read_bytes()
        ver = int(man["weights_version"])
        b.inject(wire.PORT_WEIGHTS, PC, PC_PORT, wire.header(wire.T_WEIGHTS, 1, 0, ver)
                 + wire.WEIGHTS_CHUNK.pack(0, len(blob), 0) + blob)
        b.inject(wire.PORT_WEIGHTS, PC, PC_PORT, wire.header(wire.T_WEIGHTS, 1, 1, ver)
                 + wire.WEIGHTS_CHUNK.pack(len(blob), 0, 1) + wire.WEIGHTS_COMMIT.pack(len(blob), mi.crc32(blob)))
        s = b.wait_sent(2)
        want = [(wire.PORT_WEIGHTS, PC, PC_PORT, wire.header(wire.T_WEIGHTS_ACK, 1, 0, ver) + wire.WEIGHTS_ACK.pack(0, 0, 0, 0)),
                (wire.PORT_WEIGHTS, PC, PC_PORT, wire.header(wire.T_WEIGHTS_ACK, 1, 1, ver)
                 + wire.WEIGHTS_ACK.pack(len(blob), 4, ver & 0xFF, 0))]
        check(s == want, f"WEIGHTS_ACK bytes: {s} vs {want}")
        b.take()

        # HEARTBEAT from another host/port: no reply; RESULT/ALERT/STATS still go to the PC (ruling #68)
        b.inject(wire.PORT_CONFIG, "10.0.0.9", 999, wire.header(wire.T_HEARTBEAT, 0, 0))

        # DATA (30 per packet, wire.data_packets) -> RESULT packets to PC:7001
        t0 = time.monotonic()
        pkts = wire.data_packets(data)
        acks_mid = []
        for i, p in enumerate(pkts):
            if midrun and i == len(pkts) // 2:
                # the same GLOBAL re-sent mid-run (ruling #69): stream off, drain, write, stream on, ACK OK;
                # nothing about the results may change
                b.wait_sent(0, 0.5)
                b.inject(wire.PORT_CONFIG, PC, PC_PORT, wire.header(wire.T_CONFIG, 1, 99, 0) + glob.tobytes())
                t_ack = time.monotonic() + 5
                while time.monotonic() < t_ack and not acks_mid:
                    time.sleep(0.01)
                    with b.lock:
                        acks_mid = [x for x in b.sent if x[3][5] == wire.T_CONFIG_ACK]
            b.inject(wire.PORT_DATA, PC, PC_PORT, p)
        if midrun:
            check(len(acks_mid) == 1 and acks_mid[0][3][16:] == wire.CONFIG_ACK.pack(0xFFFF, 0, 0, 99)
                  and acks_mid[0][1:3] == (PC, PC_PORT), f"mid-run GLOBAL CONFIG_ACK {acks_mid}")
        res, alerts, stats = [], [], []
        seq_res = seq_al = 0
        hdr_ok = True
        deadline = time.monotonic() + 30 + len(data) / 200
        while time.monotonic() < deadline:
            for sport, ip, dport, pkt in b.take():
                ptype, count, seq, aux = wire.parse_header(pkt)
                hdr_ok &= ip == PC
                if ptype == wire.T_RESULT:
                    hdr_ok &= (sport, dport, aux) == (7001, 7001, 0) and count <= 45 and seq == seq_res
                    hdr_ok &= pkt[:16] == wire.header(wire.T_RESULT, count, seq_res, 0) and len(pkt) == 16 + 32 * count
                    seq_res += 1
                    res.append(pkt[16:])
                elif ptype == wire.T_STATS:
                    hdr_ok &= seq == seq_res and len(pkt) == 80 and pkt[:16] == wire.header(wire.T_STATS, 1, seq_res)
                    seq_res += 1
                    stats.append(dict(zip(wire.STATS_FIELDS, wire.STATS.unpack_from(pkt, 16))))
                elif ptype == wire.T_CONFIG_ACK and midrun:
                    pass
                elif ptype == wire.T_ALERT:
                    hdr_ok &= (sport, dport) == (7002, 7002) and count == 1 and seq == seq_al
                    hdr_ok &= pkt[:16] == wire.header(wire.T_ALERT, 1, seq_al) and len(pkt) == 32
                    seq_al += 1
                    alerts.append(pkt[16:])
                else:
                    hdr_ok = False
            if sum(map(len, res)) // 32 >= len(exp) and len(alerts) >= len(exp_alerts):
                break
            time.sleep(0.01)
        dt = time.monotonic() - t0
        got = b"".join(res)
        check(hdr_ok, "RESULT/ALERT/STATS headers, ports, sequence numbers")
        check(got == exp.tobytes(), f"RESULT bytes == expected_results.bin ({len(got) // 32} / {len(exp)} records)")
        if got != exp.tobytes() and len(got) == len(exp.tobytes()):
            act = np.frombuffer(got, dtype=wire.RESULT_DTYPE)
            i = int(np.nonzero(act != exp)[0][0])
            print("   first mismatch", i, act[i], exp[i])
        want_al = []
        for a in exp_alerts:
            row = np.zeros(1, dtype=wire.ALERT_DTYPE)[0]
            for k in wire.ALERT_DTYPE.names:
                row[k] = a[k]
            want_al.append(row.tobytes())
        check(alerts == want_al, f"ALERT bytes == expected_alerts.json ({len(alerts)} / {len(want_al)})")
        # STATS after everything settled
        time.sleep(1.2)
        for sport, ip, dport, pkt in b.take():
            if pkt[5] == wire.T_STATS:
                stats.append(dict(zip(wire.STATS_FIELDS, wire.STATS.unpack_from(pkt, 16))))
        check(bool(stats), "STATS received")
        if stats:
            st = stats[-1]
            counts = man.get("status_counts", {}) if not n_records else None
            check(st["records_in"] == len(data) and st["results_out"] == len(exp), f"STATS records/results {st}")
            if counts is not None:
                check(st["dropped_duplicate"] + st["dropped_out_of_order"] + st["dropped_unknown"] <= counts.get("4", 0),
                      f"STATS drops vs manifest {counts}: {st}")
            check(st["weights_version"] == ver & 0xFF and st["mode"] == 0 and st["bad_packets"] == 0
                  and st["data_seq_gaps"] == 0, f"STATS mode/version/bad {st}")
            if counts is not None:
                check(st["held"] == counts.get("1", 0) and st["invalid"] == counts.get("3", 0),
                      f"STATS held/invalid vs manifest {counts}: {st}")
        print(f"  {gdir.name}: {len(got) // 32} results, {len(alerts)} alerts, {b.engine_calls} engine calls, "
              f"{dt:.1f} s")
    finally:
        b.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ml", default=None)
    ap.add_argument("--golden", default=None)
    ap.add_argument("--g1", type=int, default=1500, help="records of G1 to run (0 = skip, -1 = all 30,240)")
    ap.add_argument("--artifacts", default="v3,v2", help="artifact versions (golden sets) to run")
    a = ap.parse_args(argv)
    ml = Path(a.ml) if a.ml else sb.default_ml_dir()
    for ver in a.artifacts.split(","):
        golden = Path(a.golden) if a.golden else ml / "artifacts" / ver / "golden"
        for g, n, mid in (("g0", None, False), ("g2", None, False), ("g2", None, True), ("g1", a.g1, False)):
            if n == 0 or not (golden / g / "data.bin").exists():
                continue
            print(f"{ver} golden {g}" + (f" (first {n} records)" if n and n > 0 else "")
                  + (" + GLOBAL re-sent mid-run" if mid else ""))
            run_golden(ml, golden / g, n_records=n if n and n > 0 else None, midrun=mid)
    print(f"test_wire: {N_PASS} passed, {N_FAIL} failed")
    print("FAIL" if N_FAIL else "PASS")
    return 1 if N_FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
