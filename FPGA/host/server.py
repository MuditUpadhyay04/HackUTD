#!/usr/bin/env python3
"""Host side: browser UI <-> HTTP (this script) <-> UDP <-> Eclypse Z7.

    python3 server.py                          # board at 192.168.1.10:7777
    python3 server.py --board-ip 10.0.0.42     # board on another address
    python3 server.py --mock                   # no hardware: in-process fake board
then open http://127.0.0.1:8000

Standard library only (Python 3.10+).
"""
import argparse
import json
import math
import random
import socket
import statistics
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import proto

STATIC = Path(__file__).with_name("static")
MAX_BURST = 20000


class BoardLink:
    """One UDP socket to the board, stop-and-wait, matched by sequence number."""

    def __init__(self, ip, port, timeout_s=0.25, retries=2):
        self.addr = (ip, port)
        self.timeout_s = timeout_s
        self.retries = retries
        self.lock = threading.Lock()
        self.seq = random.randrange(1 << 32)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", 0))
        self.stats = {"sent": 0, "ok": 0, "timeouts": 0, "stale": 0, "mismatch": 0}

    def _drain(self):
        self.sock.setblocking(False)
        try:
            while True:
                self.sock.recv(2048)
                self.stats["stale"] += 1
        except (BlockingIOError, OSError):
            pass
        finally:
            self.sock.setblocking(True)

    def transact(self, payload: bytes, seq: int | None):
        """Send payload, wait for a reply (matching seq if given). Returns (bytes|None, rtt_ms, tries)."""
        with self.lock:
            self._drain()
            for attempt in range(1, self.retries + 2):
                t0 = time.perf_counter()
                self.sock.sendto(payload, self.addr)
                self.stats["sent"] += 1
                deadline = t0 + self.timeout_s
                while True:
                    remaining = deadline - time.perf_counter()
                    if remaining <= 0:
                        break
                    self.sock.settimeout(remaining)
                    try:
                        data, src = self.sock.recvfrom(2048)
                    except socket.timeout:
                        break
                    if src[0] != self.addr[0]:
                        continue
                    if seq is not None and (len(data) < 8 or int.from_bytes(data[4:8], "big") != seq):
                        self.stats["stale"] += 1
                        continue
                    return data, (time.perf_counter() - t0) * 1e3, attempt
                self.stats["timeouts"] += 1
            return None, None, self.retries + 1

    def multiply(self, a: int, b: int) -> dict:
        self.seq = (self.seq + 1) & 0xFFFFFFFF
        seq = self.seq
        req = proto.pack_request(seq, a, b)
        rsp, rtt, tries = self.transact(req, seq)
        expected = a * b
        out = {"a": a, "b": b, "seq": seq, "expected": str(expected),
               "tx_hex": req.hex(" ", -4), "tries": tries}
        if rsp is None:
            out.update(ok=False, error=f"no reply from {self.addr[0]}:{self.addr[1]} "
                                       f"after {tries} tries ({self.timeout_s*1e3:.0f} ms each)")
            return out
        out["rx_hex"] = rsp.hex(" ", -4)
        out["rtt_ms"] = round(rtt, 3)
        try:
            r = proto.unpack_response(rsp)
        except ValueError as e:
            out.update(ok=False, error=f"malformed reply: {e}")
            return out
        out.update(status=r["status_name"], product=str(r["product"]),
                   echo_ok=(r["a"] == a and r["b"] == b))
        out["match"] = r["status"] == 0 and r["product"] == expected and out["echo_ok"]
        out["ok"] = r["status"] == 0
        if r["status"] == 0:
            self.stats["ok"] += 1
            if not out["match"]:
                self.stats["mismatch"] += 1
        return out


EDGE = [0, 1, -1, 2, -2, proto.INT32_MAX, proto.INT32_MIN, proto.INT32_MAX - 1,
        proto.INT32_MIN + 1, 46341, -46341, 65535, 65536, 0x5A5A5A5A, -0x5A5A5A5A]


def run_burst(link: BoardLink, n: int, mode: str) -> dict:
    if mode == "edge":
        pairs = [(a, b) for a in EDGE for b in EDGE][:n]
    else:
        pairs = [(random.randint(proto.INT32_MIN, proto.INT32_MAX),
                  random.randint(proto.INT32_MIN, proto.INT32_MAX)) for _ in range(n)]
    rtts, failures, timeouts, mismatches = [], [], 0, 0
    t0 = time.perf_counter()
    for a, b in pairs:
        r = link.multiply(a, b)
        if r.get("rtt_ms") is not None:
            rtts.append(r["rtt_ms"])
        if "error" in r:
            timeouts += 1
        elif not r["match"]:
            mismatches += 1
        if ("error" in r or not r["match"]) and len(failures) < 10:
            failures.append(r)
    wall = time.perf_counter() - t0
    out = {"n": len(pairs), "mode": mode, "passed": len(pairs) - timeouts - mismatches,
           "mismatches": mismatches, "timeouts": timeouts, "wall_s": round(wall, 3),
           "ops_per_s": round(len(pairs) / wall, 1) if wall > 0 else None,
           "failures": failures}
    if rtts:
        rs = sorted(rtts)
        out["rtt_ms"] = {"min": round(rs[0], 3), "median": round(statistics.median(rs), 3),
                         "p99": round(rs[min(len(rs) - 1, math.ceil(0.99 * len(rs)) - 1)], 3),
                         "max": round(rs[-1], 3)}
    return out


def parse_int32(v, name):
    if isinstance(v, bool):
        raise ValueError(f"{name} must be an integer")
    try:
        i = int(str(v).strip(), 0)
    except ValueError:
        raise ValueError(f"{name} must be an integer (decimal or 0x hex)")
    if not proto.INT32_MIN <= i <= proto.INT32_MAX:
        raise ValueError(f"{name} must fit in signed 32-bit [{proto.INT32_MIN}, {proto.INT32_MAX}]")
    return i


def make_handler(link: BoardLink, mock: bool):
    class Handler(BaseHTTPRequestHandler):
        server_version = "fpga-link/1.0"

        def log_message(self, fmt, *args):  # quieter console
            if not self.path.startswith("/api/stats"):
                super().log_message(fmt, *args)

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _json_body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > 65536:
                raise ValueError("request body too large")
            return json.loads(self.rfile.read(n) or b"{}")

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                self._send(200, (STATIC / "index.html").read_bytes(), "text/html; charset=utf-8")
            elif self.path == "/api/config":
                self._send(200, {"board_ip": link.addr[0], "board_port": link.addr[1],
                                 "mock": mock, "timeout_ms": link.timeout_s * 1e3})
            elif self.path == "/api/stats":
                self._send(200, link.stats)
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            try:
                body = self._json_body()
                if self.path == "/api/multiply":
                    a = parse_int32(body.get("a"), "a")
                    b = parse_int32(body.get("b"), "b")
                    self._send(200, link.multiply(a, b))
                elif self.path == "/api/burst":
                    n = int(body.get("n", 100))
                    if not 1 <= n <= MAX_BURST:
                        raise ValueError(f"n must be 1..{MAX_BURST}")
                    mode = body.get("mode", "random")
                    if mode not in ("random", "edge"):
                        raise ValueError("mode must be 'random' or 'edge'")
                    self._send(200, run_burst(link, n, mode))
                elif self.path == "/api/raw":
                    payload = bytes.fromhex(str(body.get("hex", "")).replace(" ", ""))
                    if not 1 <= len(payload) <= 1024:
                        raise ValueError("raw payload must be 1..1024 bytes")
                    rsp, rtt, tries = link.transact(payload, None)
                    out = {"tx_hex": payload.hex(" ", -4), "tries": tries}
                    if rsp is None:
                        out["error"] = "no reply"
                    else:
                        out.update(rx_hex=rsp.hex(" ", -4), rtt_ms=round(rtt, 3))
                        try:
                            out["decoded"] = proto.unpack_response(rsp)
                        except ValueError as e:
                            out["decode_error"] = str(e)
                    self._send(200, out)
                else:
                    self._send(404, {"error": "not found"})
            except (ValueError, json.JSONDecodeError) as e:
                self._send(400, {"error": str(e)})

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board-ip", default="192.168.1.10")
    ap.add_argument("--board-port", type=int, default=proto.DEFAULT_PORT)
    ap.add_argument("--http-host", default="127.0.0.1",
                    help="use 0.0.0.0 to let teammates on the LAN open the UI")
    ap.add_argument("--http-port", type=int, default=8000)
    ap.add_argument("--timeout-ms", type=float, default=250)
    ap.add_argument("--mock", action="store_true", help="run a fake board on 127.0.0.1")
    ap.add_argument("--mock-fault-rate", type=float, default=0.0)
    args = ap.parse_args()

    if args.mock:
        import mock_board
        args.board_ip = "127.0.0.1"
        threading.Thread(target=mock_board.serve,
                         kwargs={"port": args.board_port, "fault_rate": args.mock_fault_rate},
                         daemon=True).start()
        time.sleep(0.1)

    link = BoardLink(args.board_ip, args.board_port, timeout_s=args.timeout_ms / 1e3)
    httpd = ThreadingHTTPServer((args.http_host, args.http_port), make_handler(link, args.mock))
    print(f"UI:    http://{args.http_host}:{args.http_port}")
    print(f"Board: udp://{args.board_ip}:{args.board_port}{'  (mock)' if args.mock else ''}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
