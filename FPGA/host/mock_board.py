#!/usr/bin/env python3
"""Software stand-in for the Eclypse Z7 UDP multiply server.

Lets you develop/test the web UI with no hardware:
    python3 mock_board.py                      # listens on 127.0.0.1:7777
    python3 server.py --board-ip 127.0.0.1     # in another terminal

`server.py --mock` starts this in-process automatically.
Use --fault-rate to inject wrong products and check that the UI flags them.
"""
import argparse
import random
import socket
import threading

import proto


def serve(host="127.0.0.1", port=proto.DEFAULT_PORT, fault_rate=0.0,
          drop_rate=0.0, stop: threading.Event | None = None, verbose=True):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.settimeout(0.2)
    if verbose:
        print(f"[mock] UDP multiply server on {host}:{port} "
              f"(fault_rate={fault_rate}, drop_rate={drop_rate})")
    while stop is None or not stop.is_set():
        try:
            data, addr = sock.recvfrom(2048)
        except socket.timeout:
            continue
        if random.random() < drop_rate:
            continue
        seq = int.from_bytes(data[4:8], "big") if len(data) >= 8 else 0
        if len(data) != proto.REQ_LEN:
            sock.sendto(proto.pack_response(seq, 1, 0, 0, 0), addr)
            continue
        magic, seq, a, b = proto.unpack_request(data)
        if magic != proto.MAGIC:
            sock.sendto(proto.pack_response(seq, 2, 0, 0, 0), addr)
            continue
        p = a * b
        if random.random() < fault_rate:
            p ^= 1 << random.randrange(64)   # flip one bit
        sock.sendto(proto.pack_response(seq, 0, a, b, p), addr)
    sock.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=proto.DEFAULT_PORT)
    ap.add_argument("--fault-rate", type=float, default=0.0)
    ap.add_argument("--drop-rate", type=float, default=0.0)
    args = ap.parse_args()
    try:
        serve(args.host, args.port, args.fault_rate, args.drop_rate)
    except KeyboardInterrupt:
        pass
