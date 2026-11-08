"""CSV -> binary sender (ingest), runs on Lucas's PC: streams a dataset folder to the board step by step.

    python -m hutd_ml.replay --data <dataset folder> [--board 192.168.1.10] [--local 192.168.1.50]
                             [--weights ../ml/artifacts/v1/weights.bin --weights-version 1]
                             [--config artifacts/v1/global_config.json] [--step-seconds 1.0] [--start-step 0]
                             [--loop]

Startup order (FPGA plan): GLOBAL CONFIG -> Facility CONFIG per facility (ACKed) -> WEIGHTS (ACKed) -> DATA.
Then one 5-minute step (all facilities, <= 30 records per packet) every --step-seconds (1.0 = 300x real time;
0 = as fast as --pps allows). Only network.json and telemetry.csv are read. It does NOT listen on 7001/7002:
results go to listen.py or the server. With --loop, each pass adds a time offset so timestamps keep advancing
(the board would otherwise drop the replay as out-of-order).
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np

from . import encode, wire
from .board import Board


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="dataset folder (network.json + telemetry.csv)")
    ap.add_argument("--board", default="192.168.1.10")
    ap.add_argument("--local", default="192.168.1.50")
    ap.add_argument("--weights", default=None, help="weights.bin blob to load before streaming")
    ap.add_argument("--weights-version", type=int, default=1)
    ap.add_argument("--config", default=None, help="global_config.json (thresholds, K, gap_thr) from training")
    ap.add_argument("--step-seconds", type=float, default=1.0)
    ap.add_argument("--pps", type=float, default=2000, help="packet pacing when --step-seconds is 0")
    ap.add_argument("--start-step", type=int, default=0)
    ap.add_argument("--steps", type=int, default=None, help="stop after this many steps (default: all)")
    ap.add_argument("--loop", action="store_true")
    a = ap.parse_args(argv)

    gkw = {}
    if a.config:
        cfg = json.loads(Path(a.config).read_text())
        gkw = {k: cfg[k] for k in ("persist_k", "logit_thr", "gap_thr", "s_feat") if k in cfg}
    enc = encode.encode_dataset(a.data, **gkw)
    n_f = len(enc.facilities)
    steps = enc.records.reshape(len(enc.timestamps), n_f)
    span = int(enc.timestamps[-1] - enc.timestamps[0]) + 300
    print(f"{Path(a.data).name}: {n_f} facilities, {len(steps)} steps, 'now' = {int(enc.timestamps[-1])}")

    b = Board(a.board, a.local, collect=False)
    b.send_config(enc.global_config, enc.facility_config)
    print(f"CONFIG: GLOBAL + {n_f} facilities ACKed")
    if a.weights:
        status, active = b.send_weights(Path(a.weights).read_bytes(), a.weights_version)
        print(f"WEIGHTS v{a.weights_version}: {status}, active version {active}")

    seq, loop = 0, 0
    while True:
        first = a.start_step if loop == 0 else 0
        last = min(len(steps), first + a.steps) if a.steps else len(steps)
        for i in range(first, last):
            rec = steps[i].copy()
            rec["ts_unix"] = rec["ts_unix"].astype(np.int64) + loop * span
            for p in wire.data_packets(rec, seq):
                b.data.sendto(p, (a.board, wire.PORT_DATA))
                seq += 1
                if a.step_seconds == 0 and a.pps:
                    time.sleep(1.0 / a.pps)
            if a.step_seconds:
                time.sleep(a.step_seconds)
            if i % 288 == 0:
                print(f"step {i}/{len(steps)} ts {int(rec['ts_unix'][0])}", flush=True)
        if not a.loop:
            break
        loop += 1
    print("done")


if __name__ == "__main__":
    main()
