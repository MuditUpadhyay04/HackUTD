"""Laptop-side harness: load a golden set onto the board over UDP and diff every RESULT.

    python -m hutd_ml.board --golden artifacts/v1/golden/g1 [--board 192.168.1.10] [--local 192.168.1.50]
                            [--weights-version 1] [--pps 2000] [--out run_dir] [--heartbeat-test]

Order (FPGA plan "Startup order"): GLOBAL CONFIG -> one Facility CONFIG per facility (each ACKed, retried)
-> WEIGHTS chunks + COMMIT (ACKed: CRC, self-test, swapped) -> DATA (30 records per packet, paced) while a
HEARTBEAT goes out every second. RESULT/STATS are collected on local port 7001 and ALERT on 7002, written to
<out>/actual_results.bin, actual_alerts.json and stats.json, then compared with expected_results.bin.
Against the software stand-in: run `python -m hutd_ml.fakeboard` and use --board 127.0.0.2 --local 127.0.0.1.
"""
import argparse
import json
import socket
import sys
import threading
import time
from pathlib import Path

import numpy as np

from . import compare as cmp, model_int, wire

WEIGHTS_STATUS = {0: "OK", 1: "CRC fail", 2: "bad length", 3: "self-test fail", 4: "swapped"}


class Board:
    def __init__(self, board, local, timeout=0.5, collect=True):
        self.board = board
        self.timeout = timeout
        self.cfg = self._sock(local, wire.PORT_CONFIG)
        self.wts = self._sock(local, wire.PORT_WEIGHTS)
        if collect:  # the replay sender leaves 7001/7002 free for listen.py / the server
            self.res = self._sock(local, wire.PORT_RESULT)
            self.alr = self._sock(local, wire.PORT_ALERT)
        self.data = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.data.bind((local, 0))
        self.seq = {"cfg": 0, "wts": 0, "data": 0, "hb": 0}
        self.results, self.alerts, self.stats = [], [], []
        self._stop = threading.Event()

    @staticmethod
    def _sock(local, port):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
        s.bind((local, port))
        return s

    def _request(self, sock, port, pkt, want_type, tries=5):
        for _ in range(tries):
            sock.sendto(pkt, (self.board, port))
            sock.settimeout(self.timeout)
            try:
                while True:
                    buf, _ = sock.recvfrom(65535)
                    ptype, count, seq, aux = wire.parse_header(buf)
                    if ptype == want_type:
                        return buf
            except socket.timeout:
                continue
        raise TimeoutError(f"no reply of type {want_type} from {self.board}:{port}")

    def send_global(self, global_cfg):
        """GLOBAL CONFIG only: run-wide thresholds, K, gap_thr. No Facility CONFIG is written, so no slot's history
        restarts (FPGA spec question 69: the ARM pauses the stream, writes it and resumes)."""
        pkt = wire.header(wire.T_CONFIG, 1, self.seq["cfg"], 0) + global_cfg.tobytes()
        fid, st, _, aseq = wire.CONFIG_ACK.unpack_from(self._request(self.cfg, wire.PORT_CONFIG, pkt, wire.T_CONFIG_ACK), 16)
        self.seq["cfg"] += 1
        if st:
            raise RuntimeError(f"GLOBAL CONFIG rejected, status {st}")

    def send_config(self, global_cfg, fac_cfg):
        self.send_global(global_cfg)
        for r in fac_cfg:
            pkt = wire.header(wire.T_CONFIG, 1, self.seq["cfg"], 1) + r.tobytes()
            fid, st, _, aseq = wire.CONFIG_ACK.unpack_from(self._request(self.cfg, wire.PORT_CONFIG, pkt, wire.T_CONFIG_ACK), 16)
            self.seq["cfg"] += 1
            if st:
                raise RuntimeError(f"Facility CONFIG {int(r['fac_id'])} rejected, status {st}")

    def send_weights(self, blob, version, crc=None, total=None):
        """Chunks + COMMIT. `crc` / `total` override the COMMIT fields (negative tests only)."""
        for off in range(0, len(blob), 1024):
            part = blob[off:off + 1024]
            pkt = wire.header(wire.T_WEIGHTS, 1, self.seq["wts"], version) + wire.WEIGHTS_CHUNK.pack(off, len(part), 0) + part
            self._request(self.wts, wire.PORT_WEIGHTS, pkt, wire.T_WEIGHTS_ACK)
            self.seq["wts"] += 1
        pkt = (wire.header(wire.T_WEIGHTS, 1, self.seq["wts"], version) + wire.WEIGHTS_CHUNK.pack(len(blob), 0, 1)
               + wire.WEIGHTS_COMMIT.pack(len(blob) if total is None else total,
                                          model_int.crc32(blob) if crc is None else crc))
        buf = self._request(self.wts, wire.PORT_WEIGHTS, pkt, wire.T_WEIGHTS_ACK)
        self.seq["wts"] += 1
        off, status, active, _ = wire.WEIGHTS_ACK.unpack_from(buf, 16)
        return WEIGHTS_STATUS.get(status, status), active

    def _collect(self):
        self.res.settimeout(0.05)
        self.alr.setblocking(False)
        while not self._stop.is_set():
            try:
                buf, _ = self.res.recvfrom(65535)
                ptype, count, seq, aux = wire.parse_header(buf)
                if ptype == wire.T_RESULT:
                    self.results.append(np.frombuffer(buf, dtype=wire.RESULT_DTYPE, count=count, offset=16).copy())
                elif ptype == wire.T_STATS:
                    self.stats.append(dict(zip(wire.STATS_FIELDS, wire.STATS.unpack_from(buf, 16))))
            except socket.timeout:
                pass
            try:
                while True:
                    buf, _ = self.alr.recvfrom(65535)
                    ptype, count, seq, aux = wire.parse_header(buf)
                    for a in np.frombuffer(buf, dtype=wire.ALERT_DTYPE, count=count, offset=16):
                        self.alerts.append({k: int(a[k]) for k in wire.ALERT_DTYPE.names})
            except (BlockingIOError, socket.timeout):
                pass

    def _heartbeat(self, hold):
        while not self._stop.is_set():
            if not hold.is_set():
                self.cfg.sendto(wire.header(wire.T_HEARTBEAT, 0, self.seq["hb"]), (self.board, wire.PORT_CONFIG))
                self.seq["hb"] += 1
            time.sleep(1.0)

    def stream(self, records, pps=2000, expect=None, wait=5.0, heartbeat_gap=None):
        hold = threading.Event()
        threads = [threading.Thread(target=self._collect, daemon=True),
                   threading.Thread(target=self._heartbeat, args=(hold,), daemon=True)]
        for t in threads:
            t.start()
        pkts = wire.data_packets(records, self.seq["data"])
        gap_at = len(pkts) // 2 if heartbeat_gap else None
        for i, p in enumerate(pkts):
            if gap_at is not None and i == gap_at:
                hold.set()                      # stop heartbeats -> AUTONOMOUS after the timeout
                time.sleep(heartbeat_gap)
                hold.clear()
            self.data.sendto(p, (self.board, wire.PORT_DATA))
            if pps:
                time.sleep(1.0 / pps)
        self.seq["data"] += len(pkts)
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline and sum(map(len, self.results)) < (expect or len(records)):
            time.sleep(0.05)
        time.sleep(0.2)
        self._stop.set()
        for t in threads:
            t.join(timeout=2)
        res = np.concatenate(self.results) if self.results else np.zeros(0, dtype=wire.RESULT_DTYPE)
        return np.sort(res, order="result_no", kind="stable")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--golden", required=True, help="golden set folder from hutd_ml.golden")
    ap.add_argument("--board", default="192.168.1.10")
    ap.add_argument("--local", default="192.168.1.50")
    ap.add_argument("--weights-version", type=int, default=None, help="default: from the golden manifest")
    ap.add_argument("--pps", type=float, default=2000, help="DATA packets per second (0 = unpaced)")
    ap.add_argument("--wait", type=float, default=10.0, help="seconds to wait for results after the last DATA")
    ap.add_argument("--out", default=None)
    ap.add_argument("--weights-negative", action="store_true",
                    help="before loading the real weights, send four bad blobs (CRC, length, header, self-test); each "
                         "must be refused with its status and leave the active model unchanged")
    ap.add_argument("--skip-alerts", action="store_true", help="compare RESULTs only (e.g. on a board that isn't fresh)")
    ap.add_argument("--heartbeat-test", type=float, default=None, metavar="SECONDS",
                    help="pause heartbeats for SECONDS mid-stream (AUTONOMOUS + replay check)")
    a = ap.parse_args(argv)
    g = Path(a.golden)
    out = Path(a.out or g / "board_run")
    out.mkdir(parents=True, exist_ok=True)
    man = json.loads((g / "manifest.json").read_text())
    glob = np.fromfile(g / "global_config.bin", dtype=wire.GLOBAL_CONFIG_DTYPE)
    fac = np.fromfile(g / "facility_config.bin", dtype=wire.FAC_CONFIG_DTYPE)
    data = np.fromfile(g / "data.bin", dtype=wire.DATA_DTYPE)
    exp = np.fromfile(g / "expected_results.bin", dtype=wire.RESULT_DTYPE)

    if a.heartbeat_test:  # golden GLOBAL has HB_TIMEOUT_MS = 0 (never AUTONOMOUS); the heartbeat test needs a timeout
        glob = glob.copy()
        glob["hb_timeout_ms"] = 5000
    b = Board(a.board, a.local)
    b.send_config(glob, fac)
    print(f"CONFIG: GLOBAL + {len(fac)} facilities ACKed")
    ok_weights = True
    if (g / "weights.bin").exists():
        ver = a.weights_version or man["weights_version"]
        blob = (g / "weights.bin").read_bytes()
        if a.weights_negative:
            ok_weights = weights_negative(b, blob, ver)
        status, active = b.send_weights(blob, ver)
        print(f"WEIGHTS v{ver}: {status}, active version {active}")
        ok_weights &= status == "swapped" and active == ver & 0xFF
    t0 = time.monotonic()
    act = b.stream(data, a.pps, expect=len(exp), wait=a.wait, heartbeat_gap=a.heartbeat_test)
    dt = time.monotonic() - t0
    act.tofile(out / "actual_results.bin")
    (out / "actual_alerts.json").write_text(json.dumps(b.alerts, indent=1))
    (out / "stats.json").write_text(json.dumps(b.stats[-1:] if b.stats else [], indent=1))
    print(f"sent {len(data)} records, received {len(act)} results, {len(b.alerts)} alerts in {dt:.2f} s")
    if b.stats:
        print("last STATS:", b.stats[-1])
    # result_no restarts with the board, so compare it only relative to the first result
    shift = 0
    if len(act):
        act = act.copy()
        shift = int(exp["result_no"][0]) - int(act["result_no"][0])
        act["result_no"] = act["result_no"] + shift
    n, counts, first = cmp.compare(exp, act)
    print("mismatches per field:", counts)
    if first:
        print(f"FIRST MISMATCH record {first[0]}: field {first[1]}: expected {first[2]}, actual {first[3]}")
    ok = first is None and len(act) == len(exp)
    print(f"RESULTs: {'PASS' if ok else 'FAIL'}")
    if not a.skip_alerts:
        ok &= compare_alerts(json.loads((g / "expected_alerts.json").read_text()), b.alerts, shift,
                             heartbeat=bool(a.heartbeat_test))
    if not ok_weights:
        print("WEIGHTS: FAIL")
    ok &= ok_weights
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


def weights_negative(b, blob, ver):
    """Four blobs the board must refuse (FPGA spec questions 67 / 75, A16): each gets its ACK status and leaves the
    active weights unchanged."""
    bad_header = bytearray(blob)
    bad_header[0] ^= 0x02                      # blob_format != 1
    bad_vector = bytearray(blob)
    bad_vector[280 + 62] ^= 0x01               # first self-test vector: expected leak logit off by one
    cases = [("CRC", blob, {"crc": model_int.crc32(blob) ^ 1}, "CRC fail"),
             ("length", blob, {"total": len(blob) + 2}, "bad length"),
             ("header", bytes(bad_header), {}, "self-test fail"),
             ("self-test vector", bytes(bad_vector), {}, "self-test fail")]
    ok, before = True, None
    for name, data, kw, want in cases:
        status, active = b.send_weights(data, ver, **kw)
        before = active if before is None else before
        good = status == want and active == before
        ok &= good
        print(f"WEIGHTS negative ({name}): {status}, active {active} -> {'ok' if good else f'FAIL (want {want!r}, active {before})'}")
    return ok


def compare_alerts(expected, actual, shift, heartbeat=False):
    """Every ALERT field, in order, with result_no rebased like the RESULTs. In the heartbeat test the SOURCE bits for
    'raised while AUTONOMOUS' (2) and 'replayed by the ARM' (3) legitimately differ, so they are masked and counted."""
    keys = list(expected[0].keys()) if expected else ["fac_id", "ts_unix", "result_no", "rules", "classes",
                                                      "countdown_p10", "kind", "source"]
    mask = ~(wire.SRC_AUTONOMOUS | wire.SRC_ARM_REPLAY) if heartbeat else ~0
    act = sorted(({**x, "result_no": x["result_no"] + shift} for x in actual), key=lambda x: x["result_no"])
    norm = lambda x: tuple((x[k] & mask) if k == "source" else x[k] for k in keys)
    same = sum(1 for e, x in zip(expected, act) if norm(e) == norm(x))
    ok = same == len(expected) == len(act)
    extra = ""
    if heartbeat:
        extra = (f"; {sum(1 for x in act if x['source'] & wire.SRC_AUTONOMOUS)} raised while AUTONOMOUS, "
                 f"{sum(1 for x in act if x['source'] & wire.SRC_ARM_REPLAY)} replayed")
    print(f"ALERTs: {same}/{len(expected)} identical, {len(act)} received{extra}: {'PASS' if ok else 'FAIL'}")
    if not ok:
        for i, (e, x) in enumerate(zip(expected, act)):
            if norm(e) != norm(x):
                print(f"FIRST ALERT MISMATCH #{i}: expected {e}, actual {x}")
                break
        print("(A board that already ran another set keeps its alarm latches, which suppresses *_RAISED: restart "
              "the board, or pass --skip-alerts.)")
    return ok


if __name__ == "__main__":
    main()
