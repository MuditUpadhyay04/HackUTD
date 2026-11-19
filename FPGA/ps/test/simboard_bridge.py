"""simboard_bridge.py — run the C protocol (eog_proto + fake eog_regs, built as `build/simboard`) as a UDP board.

    python FPGA/ps/test/simboard_bridge.py [--bind 127.0.0.2] [--pc 127.0.0.1] [--ml <dir containing hutd_ml>]

simboard speaks lines on stdin/stdout (see simboard.c). This bridge:
  * binds UDP 7000/7003/7004 on --bind and forwards every datagram to simboard (`U ...`);
  * sends simboard's datagrams (`S ...`) from the matching local port (7003/7004 for ACKs, any port for
    7001/7002), so Mudit's board.py / listen.py / replay.py can talk to it exactly like to fakeboard.py;
  * runs the DATA window's engine with Mudit's features_int.Engine (`C`/`W`/`E` -> `R`), building RESULT/ALERT
    rows the same way fakeboard.py does.
So everything the board's ARM does is the C code under test; only the PL engine is Mudit's Python reference.
On Windows the C binary runs in WSL (wsl.exe), the bridge in Windows Python (numpy).
"""
import argparse
import os
import socket
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def default_ml_dir():
    env = os.environ.get("HUTD_ML")
    if env:
        return Path(env)
    for p in HERE.parents:  # <root>/HackUTD/.claude/worktrees/T2.ps1/FPGA/ps/test -> <root>/ml/ml
        cand = p / "ml" / "ml"
        if (cand / "hutd_ml" / "wire.py").exists():
            return cand
    raise SystemExit("set HUTD_ML to the folder that contains hutd_ml/ (Mudit's ml checkout)")


def import_ml(ml_dir=None):
    ml_dir = Path(ml_dir or default_ml_dir())
    if str(ml_dir) not in sys.path:
        sys.path.insert(0, str(ml_dir))
    try:  # features_int imports encode, which needs pandas only for CSV loading (not used here)
        import pandas  # noqa: F401
    except ImportError:
        import types
        sys.modules["pandas"] = types.ModuleType("pandas")
    from hutd_ml import features_int, model_int, wire  # noqa: E402
    return wire, features_int, model_int


def ip_u32(ip):
    return struct.unpack("<I", socket.inet_aton(ip))[0]  # lwIP stores ip4_addr in network order


def u32_ip(v):
    return socket.inet_ntoa(struct.pack("<I", v))


def host_path(p):
    """A path as the simboard binary sees it (WSL on Windows)."""
    s = str(p)
    if os.name == "nt":
        s = s.replace("\\", "/")
        return "/mnt/" + s[0].lower() + s[2:] if s[1] == ":" else s
    return s


def simboard_cmd(binary=None):
    b = Path(binary or HERE / "build" / "simboard")
    if os.name == "nt":
        return ["wsl.exe", "-d", os.environ.get("EOG_WSL_DISTRO", "Ubuntu-24.04"), "--exec", host_path(b)]
    return [str(b)]


class SimBoard:
    def __init__(self, bind="127.0.0.2", pc="127.0.0.1", ml_dir=None, udp=True, binary=None, log=None, sd_dir=None):
        """sd_dir: boot from SD, with sd_dir as the card's root directory (weights.eog is loaded before any
        datagram); simboard's hal_log lines (the load outcome) collect in self.logs."""
        self.wire, self.fi, self.mi = import_ml(ml_dir)
        self.log = log
        self.engine = None
        self.weights = self.fi.Weights()
        self.sent = []            # (src_port, dst_ip, dst_port, bytes) in send order
        self.engine_calls = 0
        self.logs = []            # hal_log lines (L ...)
        self.lock = threading.Lock()
        self.wlock = threading.Lock()
        self.stop = threading.Event()
        args = [str(ip_u32(pc))] + ([host_path(Path(sd_dir).resolve())] if sd_dir is not None else [])
        self.proc = subprocess.Popen(simboard_cmd(binary) + args, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, bufsize=0)
        self.socks = {}
        self.out = None
        if udp:
            for port in (self.wire.PORT_DATA, self.wire.PORT_CONFIG, self.wire.PORT_WEIGHTS):
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
                s.bind((bind, port))
                s.settimeout(0.1)
                self.socks[port] = s
                threading.Thread(target=self._rx, args=(port, s), daemon=True).start()
            self.out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.out.bind((bind, 0))
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    # ---- to simboard ------------------------------------------------------------------------------------
    def _write(self, line):
        with self.wlock:
            self.proc.stdin.write(line.encode() + b"\n")
            self.proc.stdin.flush()

    def inject(self, port, src_ip, src_port, data):
        self._write(f"U {port} {ip_u32(src_ip)} {src_port} {bytes(data).hex()}")

    def _rx(self, port, s):
        while not self.stop.is_set():
            try:
                buf, (ip, sport) = s.recvfrom(65535)
            except (socket.timeout, OSError):
                continue
            self.inject(port, ip, sport, buf)

    # ---- from simboard ----------------------------------------------------------------------------------
    def _read(self):
        f = self.proc.stdout
        while True:
            line = f.readline()
            if not line:
                return
            try:
                self._handle(line.decode().strip())
            except Exception as e:  # keep serving; report
                print(f"simboard_bridge: {e!r} on {line[:80]!r}", file=sys.stderr)
                if line.startswith(b"E"):
                    self._write("R " + "00" * 32)

    def _handle(self, line):
        w = self.wire
        if not line:
            return
        tag, *f = line.split(" ")
        if tag == "L":
            with self.lock:
                self.logs.append(line[2:])
            if self.log:
                self.log(line[2:])
        elif tag == "S":
            sport, ip, dport, data = int(f[0]), u32_ip(int(f[1])), int(f[2]), bytes.fromhex(f[3])
            with self.lock:
                self.sent.append((sport, ip, dport, data))
            if self.out is not None:
                sock = self.socks.get(sport, self.out)
                try:
                    sock.sendto(data, (ip, dport))
                except OSError as e:
                    print(f"simboard_bridge: send to {ip}:{dport} failed: {e}", file=sys.stderr)
        elif tag == "C":
            import numpy as np
            g = np.frombuffer(bytes.fromhex(f[0]), dtype=w.GLOBAL_CONFIG_DTYPE).copy()
            fac = np.frombuffer(b"".join(bytes.fromhex(x) for x in f[1:33]), dtype=w.FAC_CONFIG_DTYPE).copy()
            touched = int(f[33])
            fresh = self.fi.Engine(g, fac, self.weights)
            if self.engine is None:
                self.engine = fresh
            else:
                # as fakeboard.py @ 5e013eb (and the RTL): GLOBAL updates the run-wide settings; a touched slot starts
                # a new history but keeps its alarm latches; result_no and the other slots carry on
                for k in ("s", "hold_max", "cd_log2", "k", "logit_thr", "gap_thr", "cfg"):
                    setattr(self.engine, k, getattr(fresh, k))
                for fid in range(32):
                    if touched >> fid & 1 and fid in fresh.fac:
                        old = self.engine.fac.get(fid)
                        self.engine.fac[fid] = fresh.fac[fid]
                        if old is not None:
                            for k in ("ns_cond", "es_cond", "ns_latch", "es_latch"):
                                setattr(self.engine.fac[fid], k, getattr(old, k))
        elif tag == "W":
            ver, win = int(f[0]), bytearray(bytes.fromhex(f[1]))
            win[5] = 0  # the window holds no self-test vectors
            self.weights = self.mi.to_weights(bytes(win), ver)
            if self.engine is not None:
                self.engine.weights = self.weights
        elif tag == "E":
            import numpy as np
            auton, rec = int(f[0]), np.frombuffer(bytes.fromhex(f[1]), dtype=w.DATA_DTYPE)[0]
            self.engine_calls += 1
            res, _, alerts = self.engine.process(rec)
            row = np.zeros(1, dtype=w.RESULT_DTYPE)[0]
            for k in ("fac_id", "status", "since_reset", "ts_unix", "reason", "rules", "weights_ver", "result_no"):
                row[k] = res[k]
            row["logits"], row["countdown"] = res["logits"], res["countdown"]
            out = ["R", row.tobytes().hex()]
            for a in alerts:
                al = np.zeros(1, dtype=w.ALERT_DTYPE)[0]
                for k in ("fac_id", "kind", "ts_unix", "result_no", "rules", "classes", "countdown_p10"):
                    al[k] = a[k]
                al["source"] = a["source"] | (4 if auton else 0)
                out.append(al.tobytes().hex())
            self._write(" ".join(out))
        elif self.log:
            self.log(line)

    # ---- helpers for tests --------------------------------------------------------------------------------
    def wait_sent(self, n, timeout=5.0):
        t = time.monotonic() + timeout
        while time.monotonic() < t:
            with self.lock:
                if len(self.sent) >= n:
                    return list(self.sent)
            time.sleep(0.005)
        with self.lock:
            return list(self.sent)

    def take(self):
        with self.lock:
            s, self.sent = self.sent, []
        return s

    def close(self):
        self.stop.set()
        try:
            self._write("X")
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        for s in list(self.socks.values()) + ([self.out] if self.out else []):
            s.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bind", default="127.0.0.2")
    ap.add_argument("--pc", default="127.0.0.1")
    ap.add_argument("--ml", default=None)
    ap.add_argument("--seconds", type=float, default=None)
    ap.add_argument("--sd", default=None, help="boot from SD: folder standing in for the card's root (weights.eog)")
    a = ap.parse_args(argv)
    b = SimBoard(a.bind, a.pc, a.ml, sd_dir=a.sd, log=lambda m: print("board:", m, flush=True))
    print(f"simboard (C eog_proto) on {a.bind} (7000/7003/7004) -> PC {a.pc} (7001/7002)", flush=True)
    try:
        t_end = time.monotonic() + a.seconds if a.seconds else None
        while (t_end is None or time.monotonic() < t_end) and b.proc.poll() is None:
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    finally:
        b.close()


if __name__ == "__main__":
    main()
