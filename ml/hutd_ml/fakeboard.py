"""Software stand-in for the Eclypse Z7, speaking wire format v1 over UDP, computing with features_int.py.

    python -m hutd_ml.fakeboard [--bind 127.0.0.2] [--pc 127.0.0.1]

Use it to test board.py, the ingest sender and the server without hardware. It is the integer reference, not the
RTL: a mismatch between this and the real board is a bug on one side (compare with hutd_ml.compare).
Listens on DATA 7000, CONFIG 7003, WEIGHTS 7004; sends RESULT/STATS to the PC's 7001 and ALERT to 7002;
answers CONFIG_ACK / WEIGHTS_ACK to the sender's address. AUTONOMOUS mode after hb_timeout_ms without a
HEARTBEAT: results and alerts are buffered and replayed on the next heartbeat.
"""
import argparse
import select
import socket
import struct
import time

import numpy as np

from . import features_int as fi, model_int, wire


class FakeBoard:
    def __init__(self, bind="127.0.0.2", pc="127.0.0.1", countdown="review_r1r2"):
        self.pc = pc
        self.countdown = countdown
        self.socks = {}
        for port in (wire.PORT_DATA, wire.PORT_CONFIG, wire.PORT_WEIGHTS):
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((bind, port))
            self.socks[port] = s
        self.out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.out.bind((bind, 0))
        self.global_cfg = None
        self.fac_cfg = {}
        self.engine = None
        self.weights = fi.Weights()
        self.blob = bytearray()
        self.seq = {wire.PORT_RESULT: 0, wire.PORT_ALERT: 0, wire.PORT_CONFIG: 0, wire.PORT_WEIGHTS: 0}
        self.stats = dict.fromkeys(wire.STATS_FIELDS, 0)
        self.last_hb = time.monotonic()
        self.autonomous = False
        self.pending_results, self.pending_alerts, self.replay = [], [], []
        self.t0 = time.monotonic()

    # -- sending --------------------------------------------------------------------------------------------
    def _send(self, port, ptype, payload_records, aux=0):
        pkt = wire.header(ptype, len(payload_records), self.seq[port], aux) + payload_records.tobytes()
        self.seq[port] += 1
        self.out.sendto(pkt, (self.pc, port))

    def _flush(self):
        if self.autonomous:
            return
        for start in range(0, len(self.pending_results), wire.RESULT_PER_PACKET):
            self._send(wire.PORT_RESULT, wire.T_RESULT, np.array(self.pending_results[start:start + wire.RESULT_PER_PACKET],
                                                                 dtype=wire.RESULT_DTYPE))
        for a in self.pending_alerts:
            self._send(wire.PORT_ALERT, wire.T_ALERT, np.array([a], dtype=wire.ALERT_DTYPE))
        self.stats["results_out"] += len(self.pending_results)
        self.pending_results, self.pending_alerts = [], []

    def _stats(self):
        self.stats["mode"] = int(self.autonomous)
        self.stats["weights_version"] = self.weights.version
        self.stats["uptime_s"] = int(time.monotonic() - self.t0)
        self.stats["replay_waiting"] = len(self.pending_results) if self.autonomous else 0
        payload = wire.STATS.pack(*[self.stats[k] & 0xFFFFFFFF for k in wire.STATS_FIELDS])
        self.out.sendto(wire.header(wire.T_STATS, 1, self.seq[wire.PORT_RESULT]) + payload, (self.pc, wire.PORT_RESULT))
        self.seq[wire.PORT_RESULT] += 1

    # -- receiving ------------------------------------------------------------------------------------------
    def _config(self, buf, addr):
        ptype, count, seq, aux = wire.parse_header(buf)
        s = self.socks[wire.PORT_CONFIG]
        if ptype == wire.T_HEARTBEAT:
            self.last_hb = time.monotonic()
            if self.autonomous:
                self.autonomous = False
                self._flush()
            return
        if ptype != wire.T_CONFIG:
            self.stats["bad_packets"] += 1
            return
        if aux == 0:
            self.global_cfg = np.frombuffer(buf, dtype=wire.GLOBAL_CONFIG_DTYPE, count=1, offset=16).copy()
            acks = [(0xFFFF, 0)]
        else:
            recs = np.frombuffer(buf, dtype=wire.FAC_CONFIG_DTYPE, count=count, offset=16)
            acks = []
            for r in recs:
                ok = int(r["fac_id"]) < wire.MAX_FACILITIES
                if ok:
                    self.fac_cfg[int(r["fac_id"])] = r.copy()
                acks.append((int(r["fac_id"]), 0 if ok else 1))
        if self.engine is not None:
            # like the RTL: a CONFIG write never resets the engine. GLOBAL updates the run-wide settings; a Facility
            # CONFIG write makes that slot's next record a new history (HIST_RESET), keeping its alarm latches,
            # while result_no and the other slots carry on.
            fresh = fi.Engine(self.global_cfg, np.array(list(self.fac_cfg.values()), dtype=wire.FAC_CONFIG_DTYPE),
                              self.weights, self.countdown)
            for k in ("s", "hold_max", "cd_log2", "k", "logit_thr", "gap_thr", "cfg"):
                setattr(self.engine, k, getattr(fresh, k))
            for fid, _ in acks:
                if fid in fresh.fac:
                    old = self.engine.fac.get(fid)
                    self.engine.fac[fid] = fresh.fac[fid]
                    if old is not None:
                        for k in ("ns_cond", "es_cond", "ns_latch", "es_latch"):
                            setattr(self.engine.fac[fid], k, getattr(old, k))
        for fid, st in acks:
            s.sendto(wire.header(wire.T_CONFIG_ACK, 1, self.seq[wire.PORT_CONFIG]) + wire.CONFIG_ACK.pack(fid, st, 0, seq),
                     addr)
            self.seq[wire.PORT_CONFIG] += 1

    def _weights(self, buf, addr):
        ptype, count, seq, aux = wire.parse_header(buf)
        off, length, flags = wire.WEIGHTS_CHUNK.unpack_from(buf, 16)
        status = 0
        if flags & 1:
            total, crc = wire.WEIGHTS_COMMIT.unpack_from(buf, 16 + wire.WEIGHTS_CHUNK.size)
            blob = bytes(self.blob[:total])
            if len(blob) != total:
                status = 2
            elif model_int.crc32(blob) != crc:
                status = 1
            elif not model_int.self_test(blob):
                status = 3
            else:
                self.weights = model_int.to_weights(blob, aux & 0xFF)
                if self.engine:
                    self.engine.weights = self.weights  # swap at a record boundary
                status = 4
            self.blob = bytearray()
        else:
            data = buf[16 + wire.WEIGHTS_CHUNK.size:16 + wire.WEIGHTS_CHUNK.size + length]
            if len(self.blob) < off + length:
                self.blob.extend(b"\0" * (off + length - len(self.blob)))
            self.blob[off:off + length] = data
        self.socks[wire.PORT_WEIGHTS].sendto(
            wire.header(wire.T_WEIGHTS_ACK, 1, self.seq[wire.PORT_WEIGHTS], aux)
            + wire.WEIGHTS_ACK.pack(off, status, self.weights.version & 0xFF, 0), addr)
        self.seq[wire.PORT_WEIGHTS] += 1

    def _data(self, buf):
        ptype, count, seq, aux = wire.parse_header(buf)
        if ptype != wire.T_DATA or len(buf) < 16 + 48 * count:
            self.stats["bad_packets"] += 1
            return
        if self.global_cfg is None:
            self.stats["bad_packets"] += 1
            return
        if self.engine is None:
            cfg = np.array(list(self.fac_cfg.values()), dtype=wire.FAC_CONFIG_DTYPE)
            self.engine = fi.Engine(self.global_cfg, cfg, self.weights, self.countdown)
        for r in np.frombuffer(buf, dtype=wire.DATA_DTYPE, count=count, offset=16):
            self.stats["records_in"] += 1
            res, _, alerts = self.engine.process(r)
            row = np.zeros(1, dtype=wire.RESULT_DTYPE)[0]
            for k in ("fac_id", "status", "since_reset", "ts_unix", "reason", "rules", "weights_ver", "result_no"):
                row[k] = res[k]
            row["logits"], row["countdown"] = res["logits"], res["countdown"]
            self.pending_results.append(row)
            for a in alerts:
                al = np.zeros(1, dtype=wire.ALERT_DTYPE)[0]
                for k in ("fac_id", "kind", "ts_unix", "result_no", "rules", "classes", "countdown_p10"):
                    al[k] = a[k]
                al["source"] = a["source"] | (4 if self.autonomous else 0)
                self.pending_alerts.append(al)
                self.stats["alerts_raised"] += 1
            st = res["status"]
            if st == wire.ST_INVALID:
                self.stats["invalid"] += 1
            elif st == wire.ST_HELD:
                self.stats["held"] += 1
            if res["reason"] & wire.R_RESET:
                self.stats["history_resets"] += 1
            for bit, key in ((wire.R_DUPLICATE, "dropped_duplicate"), (wire.R_OUT_OF_ORDER, "dropped_out_of_order"),
                             (wire.R_UNKNOWN_FACILITY, "dropped_unknown")):
                if st == wire.ST_DROPPED and res["reason"] & bit:
                    self.stats[key] += 1
        self._flush()

    def serve(self, seconds=None):
        last_stats = time.monotonic()
        stop = time.monotonic() + seconds if seconds else None
        while stop is None or time.monotonic() < stop:
            ready, _, _ = select.select(list(self.socks.values()), [], [], 0.1)
            for s in ready:
                buf, addr = s.recvfrom(65535)
                try:
                    port = s.getsockname()[1]
                    if port == wire.PORT_DATA:
                        self._data(buf)
                    elif port == wire.PORT_CONFIG:
                        self._config(buf, addr)
                    else:
                        self._weights(buf, addr)
                except (ValueError, struct.error):
                    self.stats["bad_packets"] += 1
            now = time.monotonic()
            hb_timeout = int(self.global_cfg["hb_timeout_ms"][0]) / 1000 if self.global_cfg is not None else 5.0
            # FPGA numerics v4 section 9: AUTONOMOUS = (HB_TIMEOUT_MS != 0) & (time since heartbeat >= timeout)
            if not self.autonomous and hb_timeout and now - self.last_hb >= hb_timeout:
                self.autonomous = True
            if now - last_stats >= 1.0:
                self._stats()
                last_stats = now


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bind", default="127.0.0.2")
    ap.add_argument("--pc", default="127.0.0.1")
    ap.add_argument("--countdown", default="review_r1r2", choices=["review_r1r2", "plan_v1"])
    ap.add_argument("--seconds", type=float, default=None)
    a = ap.parse_args(argv)
    print(f"fake board on {a.bind} (DATA 7000, CONFIG 7003, WEIGHTS 7004) -> PC {a.pc} (7001, 7002)")
    FakeBoard(a.bind, a.pc, a.countdown).serve(a.seconds)


if __name__ == "__main__":
    main()
