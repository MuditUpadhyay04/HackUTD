"""Board output -> JSON. Reference consumer for the server and dashboard, and an optional bridge.

    python -m hutd_ml.listen --data <dataset folder> [--board 192.168.1.10] [--local 0.0.0.0]
                             [--weights-json artifacts/v1/weights.json] [--config artifacts/v1/global_config.json]
                             [--jsonl out.jsonl] [--post http://server:8000/ingest] [--quiet]

Binds UDP 7001 (RESULT, STATS) and 7002 (ALERT) on the machine the board sends to (Lucas's PC on the direct cable,
or localhost with the fake board), sends a HEARTBEAT to the board every second, and turns every binary record into
one JSON object (schema: ml/INTEGRATION.md). Output goes to stdout as JSON lines, to --jsonl, and/or is POSTed in
batches (a JSON array) to --post. With --post, heartbeats stop when the server hasn't accepted a batch for 5 s, so
the board correctly enters AUTONOMOUS mode while the server is down and replays afterwards.
"""
import argparse
import json
import math
import socket
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import encode, wire

STATUS = {0: "VALID", 1: "HELD", 2: "RESERVED", 3: "INVALID", 4: "DROPPED"}
REASONS = ["field_held", "step_gap_held", "history_reset", "out_of_range", "illegal_enum", "feature_saturated",
           "pump_flow_inconsistent", "well_status_water_inconsistent", "duplicate", "out_of_order",
           "unknown_facility", "field_absent", "framing", "no_model", "field_lost"]
RULES = ["pump_fault", "shut_in", "level_at_shutdown", "level_at_warning", "not_filling"]
ALERT_KIND = {1: "night_shift_raised", 2: "estop_raised", 3: "cleared", 4: "acknowledged"}
ALERT_SOURCE = ["rule", "model", "raised_while_autonomous", "replayed_from_buffer"]  # bit 4 = latch type


def bits(v, names):
    return [n for i, n in enumerate(names) if int(v) >> i & 1]


class Decoder:
    def __init__(self, facilities, calibration=None, logit_thr=None):
        self.fac = {f.fac_id: f for f in facilities}
        self.calib = calibration or [None] * 4
        self.thr = logit_thr

    def _names(self, fid):
        f = self.fac.get(fid)
        return {"facility": f.id if f else None, "system": f.system if f else None}

    @staticmethod
    def _iso(ts):
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def result(self, r):
        fid, ts = int(r["fac_id"]), int(r["ts_unix"])
        logits = [int(x) / 256 for x in r["logits"]]
        out = {"type": "result", "fac_id": fid, **self._names(fid), "ts_unix": ts, "time": self._iso(ts),
               "status": STATUS.get(int(r["status"]), int(r["status"])), "reason": bits(r["reason"], REASONS),
               "since_reset": int(r["since_reset"]), "logits": dict(zip(wire.HEADS, logits)),
               "rules": bits(r["rules"], RULES), "weights_ver": int(r["weights_ver"]), "result_no": int(r["result_no"]),
               "countdown_min": {k: (None if int(v) == wire.COUNTDOWN_NONE else int(v))
                                 for k, v in zip(("p10", "p50", "p90"), r["countdown"])}}
        if self.calib[0] is not None:
            out["probability"] = {h: round(1 / (1 + math.exp(-(c["a"] * z + c["c"]))), 4)
                                  for h, z, c in zip(wire.HEADS, logits, self.calib)}
        if self.thr is not None:
            out["above_threshold"] = [h for h, z, t in zip(wire.HEADS, r["logits"], self.thr) if int(z) > t]
        return out

    def alert(self, a):
        fid, ts = int(a["fac_id"]), int(a["ts_unix"])
        return {"type": "alert", "fac_id": fid, **self._names(fid), "ts_unix": ts, "time": self._iso(ts),
                "kind": ALERT_KIND.get(int(a["kind"]), int(a["kind"])), "source": bits(a["source"], ALERT_SOURCE),
                "latch": "estop" if int(a["source"]) >> 4 & 1 else "night_shift",
                "result_no": int(a["result_no"]), "rules": bits(a["rules"], RULES),
                "classes": bits(a["classes"], wire.HEADS),
                "countdown_p10_min": None if int(a["countdown_p10"]) == wire.COUNTDOWN_NONE else int(a["countdown_p10"])}

    @staticmethod
    def stats(buf):
        d = dict(zip(wire.STATS_FIELDS, wire.STATS.unpack_from(buf, 16)))
        d["mode"] = "AUTONOMOUS" if d["mode"] else "NORMAL"
        return {"type": "stats", **d}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the SAME dataset folder the sender replays (for names)")
    ap.add_argument("--board", default="192.168.1.10")
    ap.add_argument("--local", default="0.0.0.0")
    ap.add_argument("--weights-json", default=None, help="weights.json (adds calibrated probabilities)")
    ap.add_argument("--config", default=None, help="global_config.json (adds above_threshold)")
    ap.add_argument("--jsonl", default=None)
    ap.add_argument("--post", default=None, help="POST batches of JSON objects to this URL")
    ap.add_argument("--quiet", action="store_true", help="don't print results to stdout")
    a = ap.parse_args(argv)

    facs = encode.facilities_from_network(encode.load_network(a.data))
    calib = json.loads(Path(a.weights_json).read_text())["calibration_platt"] if a.weights_json else None
    thr = json.loads(Path(a.config).read_text())["logit_thr"] if a.config else None
    dec = Decoder(facs, calib, thr)
    socks = {}
    for port in (wire.PORT_RESULT, wire.PORT_ALERT):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
        s.bind((a.local, port))
        s.settimeout(0.05)
        socks[port] = s
    jsonl = open(a.jsonl, "a", buffering=1) if a.jsonl else None  # line-buffered: nothing lost on kill
    state = {"server_ok_at": time.monotonic(), "batch": [], "lock": threading.Lock(), "stop": False}

    def heartbeat():
        hb = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        seq = 0
        while not state["stop"]:
            if not a.post or time.monotonic() - state["server_ok_at"] < 5.0:
                hb.sendto(wire.header(wire.T_HEARTBEAT, 0, seq), (a.board, wire.PORT_CONFIG))
                seq += 1
            time.sleep(1.0)

    def poster():
        while not state["stop"]:
            time.sleep(0.5)
            with state["lock"]:
                batch, state["batch"] = state["batch"], []
            try:  # an empty array is also posted: it doubles as the "server is up" check while idle
                req = urllib.request.Request(a.post, data=json.dumps(batch).encode(),
                                             headers={"Content-Type": "application/json"})
                urllib.request.urlopen(req, timeout=2).read()
                state["server_ok_at"] = time.monotonic()
            except Exception as e:  # keep the batch; the board buffers while heartbeats are off
                with state["lock"]:
                    state["batch"] = batch + state["batch"]
                print(f"POST failed: {e}", file=sys.stderr)

    threading.Thread(target=heartbeat, daemon=True).start()
    if a.post:
        threading.Thread(target=poster, daemon=True).start()

    def emit(obj):
        line = json.dumps(obj)
        if jsonl:
            jsonl.write(line + "\n")
        if not a.quiet or obj["type"] != "result":
            print(line, flush=True)
        if a.post:
            with state["lock"]:
                state["batch"].append(obj)

    print(f"listening on {a.local}:7001/7002, heartbeat -> {a.board}:7003", file=sys.stderr)
    try:
        while True:
            for port, s in socks.items():
                try:
                    buf, _ = s.recvfrom(65535)
                except socket.timeout:
                    continue
                try:
                    ptype, count, seq, aux = wire.parse_header(buf)
                except ValueError:
                    continue
                if ptype == wire.T_RESULT:
                    for r in np.frombuffer(buf, dtype=wire.RESULT_DTYPE, count=count, offset=16):
                        emit(dec.result(r))
                elif ptype == wire.T_ALERT:
                    for al in np.frombuffer(buf, dtype=wire.ALERT_DTYPE, count=count, offset=16):
                        emit(dec.alert(al))
                elif ptype == wire.T_STATS:
                    emit(dec.stats(buf))
    except KeyboardInterrupt:
        state["stop"] = True
    finally:
        if jsonl:
            jsonl.close()


if __name__ == "__main__":
    main()
