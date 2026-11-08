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
import select
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
    def __init__(self, facilities, calibration=None, logit_thr=None, persist_k=None, models=None, source=None):
        self.fac = {f.fac_id: f for f in facilities}
        self.source = source  # "fpga" or "fakeboard": written into every object so consumers can label provenance
        # default model settings, plus per-weights_ver settings for a live swap (each model has its own
        # calibration, thresholds and K); a result is read with the settings of the model that produced it
        self.default = (calibration, logit_thr, persist_k)
        self.models = models or {}
        self.cnt = {}  # fac_id -> consecutive hits per head, kept exactly like the board's persistence counters

    def _src(self):
        return {"source": self.source} if self.source else {}

    def _names(self, fid):
        f = self.fac.get(fid)
        return {"facility": f.id if f else None, "system": f.system if f else None}

    @staticmethod
    def _iso(ts):
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def result(self, r):
        fid, ts = int(r["fac_id"]), int(r["ts_unix"])
        logits = [int(x) / 256 for x in r["logits"]]
        out = {"type": "result", **self._src(), "fac_id": fid, **self._names(fid), "ts_unix": ts, "time": self._iso(ts),
               "status": STATUS.get(int(r["status"]), int(r["status"])), "reason": bits(r["reason"], REASONS),
               "since_reset": int(r["since_reset"]), "logits": dict(zip(wire.HEADS, logits)),
               "rules": bits(r["rules"], RULES), "weights_ver": int(r["weights_ver"]), "result_no": int(r["result_no"]),
               "countdown_min": {k: (None if int(v) == wire.COUNTDOWN_NONE else int(v))
                                 for k, v in zip(("p10", "p50", "p90"), r["countdown"])}}
        ver = int(r["weights_ver"])
        calib, thr, k = self.models.get(ver, self.default)
        if calib is not None and ver != 0:
            out["probability"] = {h: round(1 / (1 + math.exp(-(c["a"] * z + c["c"]))), 4)
                                  for h, z, c in zip(wire.HEADS, logits, calib)}
        if thr is not None:
            # No model loaded (weights_ver 0): the logits are 0, not scores, so nothing is a hit (hard rule 9).
            hits = [ver != 0 and int(z) > t for z, t in zip(r["logits"], thr)]
            out["above_threshold"] = [h for h, x in zip(wire.HEADS, hits) if x]
            if k is not None:
                out["active"] = self._active(fid, int(r["status"]), int(r["reason"]), hits, k)
        return out

    def _active(self, fid, status, reason, hits, k):
        """Heads with >= K consecutive hits: the detection the thresholds were tuned for (persist_K4, FPGA D10).
        Mirrors the board: VALID / HELD records count, INVALID clears, a history reset restarts the count, DROPPED
        changes nothing. Lost UDP packets (gaps in result_no) can make it lag the board by a record or two."""
        cnt = self.cnt.setdefault(fid, [0] * 4)
        if status in (wire.ST_VALID, wire.ST_HELD):
            if reason & wire.R_RESET:
                cnt[:] = [0] * 4
            for h in range(4):
                cnt[h] = cnt[h] + 1 if hits[h] else 0
            return [h for h, c, kk in zip(wire.HEADS, cnt, k) if c >= kk]
        if status == wire.ST_INVALID:
            cnt[:] = [0] * 4
        return []

    def alert(self, a):
        fid, ts = int(a["fac_id"]), int(a["ts_unix"])
        return {"type": "alert", **self._src(), "fac_id": fid, **self._names(fid), "ts_unix": ts, "time": self._iso(ts),
                "kind": ALERT_KIND.get(int(a["kind"]), int(a["kind"])), "source": bits(a["source"], ALERT_SOURCE),
                "latch": "estop" if int(a["source"]) >> 4 & 1 else "night_shift",
                "result_no": int(a["result_no"]), "rules": bits(a["rules"], RULES),
                "classes": bits(a["classes"], wire.HEADS),
                "countdown_p10_min": None if int(a["countdown_p10"]) == wire.COUNTDOWN_NONE else int(a["countdown_p10"])}

    def stats(self, buf):
        d = dict(zip(wire.STATS_FIELDS, wire.STATS.unpack_from(buf, 16)))
        d["mode"] = "AUTONOMOUS" if d["mode"] else "NORMAL"
        return {"type": "stats", **self._src(), **d}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="the SAME dataset folder the sender replays (for names)")
    ap.add_argument("--board", default="192.168.1.10")
    ap.add_argument("--local", default="0.0.0.0")
    ap.add_argument("--weights-json", default=None, help="weights.json (adds calibrated probabilities)")
    ap.add_argument("--config", default=None, help="global_config.json (adds above_threshold and active)")
    ap.add_argument("--model", action="append", default=[], metavar="DIR",
                    help="artifacts folder of a model (weights.json + global_config.json); repeat it for a live swap, "
                         "e.g. --model artifacts/v3 --model artifacts/v4. Results are read with the settings of the "
                         "model whose weights_ver they carry; --weights-json / --config remain the default")
    ap.add_argument("--source", choices=["fpga", "fakeboard"], default=None,
                    help="provenance written into every JSON object (default: fakeboard for a loopback --board, "
                         "otherwise fpga)")
    ap.add_argument("--jsonl", default=None)
    ap.add_argument("--post", default=None, help="POST batches of JSON objects to this URL")
    ap.add_argument("--quiet", action="store_true", help="don't print results to stdout")
    a = ap.parse_args(argv)

    facs = encode.facilities_from_network(encode.load_network(a.data))
    calib = json.loads(Path(a.weights_json).read_text())["calibration_platt"] if a.weights_json else None
    cfg = json.loads(Path(a.config).read_text()) if a.config else None
    thr = cfg["logit_thr"] if cfg else None
    k = (cfg.get("persist_k_per_class") or [cfg.get("persist_k", 1)] * 4) if cfg else None
    models = {}
    for d in a.model:
        wj = json.loads((Path(d) / "weights.json").read_text())
        gc = json.loads((Path(d) / "global_config.json").read_text())
        models[int(wj["version"])] = (wj["calibration_platt"], gc["logit_thr"],
                                      gc.get("persist_k_per_class") or [gc.get("persist_k", 1)] * 4)
    if models and calib is None and thr is None:  # --model only: the last one is also the default
        calib, thr, k = list(models.values())[-1]
    source = a.source or ("fakeboard" if a.board.startswith("127.") or a.board == "localhost" else "fpga")
    dec = Decoder(facs, calib, thr, k, models, source)
    socks = {}
    for port in (wire.PORT_RESULT, wire.PORT_ALERT):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
        s.bind((a.local, port))
        s.setblocking(False)
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
            # Wait on both sockets at once, then drain everything that's queued: no fixed per-socket timeout, so
            # the JSON keeps up with the board (Lucas saw the old 50 ms-per-socket loop fall behind).
            ready, _, _ = select.select(list(socks.values()), [], [], 0.5)
            for s in ready:
                while True:
                    try:
                        buf, _ = s.recvfrom(65535)
                    except (BlockingIOError, InterruptedError):
                        break
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
