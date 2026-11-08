"""Golden vector sets for the RTL testbench and the board (docs/plan/mudit/ml_plan.md section 4.9).

    python -m hutd_ml.golden --data <dataset folder> --out <dir> [--set g0|g1|g2] [--weights v0|<blob>]
                             [--weights-version N] [--config <global_config.json>] [--countdown review_r1r2|plan_v1]
                             [--mem] [--stages]

Writes: global_config.bin (32 B), facility_config.bin (n x 64 B), weights.bin (blob, if any), data.bin (48 B
records in send order), expected_results.bin (32 B RESULT per record), expected_alerts.json, facilities.json,
manifest.json (SHA-256 of every file, versions, assumptions); optionally data.mem ($readmemh, 64-bit beats) and
expected_stages.csv (per-record validated values, 31 features, logits, rules, countdown, status, reason).
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path

import numpy as np

from . import encode, features_int as fi, model_int, wire

ASSUMPTIONS_VERSION = "A1-A19 + FPGA response (S=17, review_r1r2, A13 FRAMING, A19 latches, per-class K), 2026-11-08"
V0_VERSION = 240  # untrained test weights report weights_ver 240; trained weights start at 1


def _write(out, name, data):
    p = out / name
    p.write_bytes(data) if isinstance(data, (bytes, bytearray)) else p.write_text(data)
    return p


def g0_records(enc):
    """One facility, 30 steps around a pump start (cold start + transition), small enough to check by hand."""
    rec = enc.records
    f0 = rec[rec["fac_id"] == 0]
    status = f0["pump_status"].astype(int)
    starts = np.where((status[1:] == 1) & (status[:-1] != 1))[0] + 1
    s = int(max(starts[0] - 15, 0)) if len(starts) else 0
    return f0[s:s + 30]


def g2_records(enc):
    """Synthetic edge cases on facility 0 (and an unknown facility), built from real records."""
    base = enc.records[enc.records["fac_id"] == 0][:40].copy()
    seq = []
    seq += list(base[0:5])                           # 0-4 normal
    r = base[5].copy(); seq.append(r); seq.append(r.copy())  # duplicate -> DROPPED
    seq.append(base[4].copy())                       # out of order -> DROPPED
    seq += list(base[7:9])                           # one-step gap (6 missing) -> HELD
    seq += list(base[12:14])                         # three missing (9-11) -> reset
    for k in (14, 15, 16):                           # inflow absent 3 times -> held, held, reset -> INVALID
        r = base[k].copy(); r["present"] = int(r["present"]) & ~(1 << wire.P_INFLOW); seq.append(r)
    seq += list(base[17:19])                         # recovers
    r = base[19].copy(); r["pump_status"] = 3; seq.append(r)          # illegal enum -> held
    r = base[20].copy(); r["level"] = 20000; seq.append(r)            # out of range -> held
    r = base[21].copy(); r["well_status"] = int(r["well_status"]) | 2; seq.append(r)  # well status 2/3 -> held
    r = base[22].copy(); r["inflow"] = 32767; seq.append(r)           # out of range (> hi) -> held
    r = base[23].copy(); r["fac_id"] = 31; seq.append(r)              # disabled slot -> DROPPED
    r = base[23].copy(); r["fac_id"] = 40; seq.append(r)              # id >= 32 -> DROPPED
    seq += list(base[24:30])
    r = base[30].copy(); r["reserved1"] = 1; seq.append(r)           # non-zero reserved field -> DROPPED FRAMING
    r = base[30].copy(); r["reserved0"] = 2; r["fac_id"] = 40; seq.append(r)  # framing is checked before the slot
    seq += list(base[30:33])                         # 30 is then accepted (the framing drops changed nothing)
    return np.array(seq, dtype=wire.DATA_DTYPE)


def build(data, out, which="g1", weights="v0", weights_version=None, config=None, countdown="review_r1r2",
          mem=False, stages_csv=False):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    gkw = {}
    persist_k = None
    if config:
        cfg = json.loads(Path(config).read_text())
        gkw = {k: cfg[k] for k in ("persist_k", "logit_thr", "gap_thr", "s_feat", "persist_k_per_class") if k in cfg}
        countdown = cfg.get("countdown", countdown)  # wire v1 has one persist_K; per-class K is only a proposal
    # golden sets use HB_TIMEOUT_MS = 0 so the board never goes AUTONOMOUS and ALERT SOURCE bit 2 is deterministic
    # (FPGA numerics.md v4 section 9); deployment configs keep 5000
    enc = encode.encode_dataset(data, **{**gkw, "hb_timeout_ms": 0})
    records = {"g0": g0_records, "g1": lambda e: e.records, "g2": g2_records}[which](enc)

    blob, wts = None, None
    if weights == "v0":
        w_q, b_q, s_out = model_int.weights_v0()
        blob = model_int.pack_blob(w_q, b_q, s_out, model_int.edge_vectors(), mhash=0)
        wts = model_int.to_weights(blob, weights_version or V0_VERSION)
    elif weights and weights != "none":
        blob = Path(weights).read_bytes()
        wts = model_int.to_weights(blob, weights_version or 1)

    res, stages, alerts = fi.run(records, enc.global_config, enc.facility_config, wts, countdown, persist_k)
    files = {
        "global_config.bin": enc.global_config.tobytes(),
        "facility_config.bin": enc.facility_config.tobytes(),
        "data.bin": records.tobytes(),
        "expected_results.bin": res.tobytes(),
        "expected_alerts.json": json.dumps(alerts, indent=1),
        "facilities.json": json.dumps(encode.facilities_json(enc.facilities), indent=1),
    }
    if blob is not None:
        files["weights.bin"] = blob
    if mem:
        files["data.mem"] = wire.records_to_mem(records)
        files["expected_results.mem"] = wire.records_to_mem(res)
    for name, data_ in files.items():
        _write(out, name, data_)
    if stages_csv:
        write_stages_csv(out / "expected_stages.csv", records, res, stages)
    manifest = {
        "set": which, "dataset": str(Path(data).name), "records": int(len(records)),
        "wire_version": wire.VERSION, "feature_set_id": fi.FEATURE_SET_ID, "countdown": countdown,
        "weights": weights, "weights_version": int(wts.version) if wts else 0,
        "weights_crc32": f"0x{model_int.crc32(blob):08X}" if blob else None,
        "assumptions": ASSUMPTIONS_VERSION,
        "status_counts": {int(k): int(v) for k, v in zip(*np.unique(res["status"], return_counts=True))},
        "sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir())
                   if p.name != "manifest.json"},
    }
    _write(out, "manifest.json", json.dumps(manifest, indent=1))
    return manifest


def write_stages_csv(path, records, res, stages):
    vnames = list(wire.FACILITY_FIELDS) + [f"ws{i}" for i in range(8)] + [f"ww{i}" for i in range(8)]
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["i", "fac_id", "ts_unix", "status", "reason", "since_reset"] + [f"v_{n}" for n in vnames]
                   + fi.FEATURE_NAMES + ["logit_" + h for h in wire.HEADS] + ["rules", "cd_p10", "cd_p50", "cd_p90",
                                                                               "ns_cond", "es_cond",
                                                                               "ns_latch", "es_latch"])
        for i, (r, s) in enumerate(zip(res, stages)):
            row = [i, int(r["fac_id"]), int(r["ts_unix"]), int(r["status"]), int(r["reason"]), int(r["since_reset"])]
            if s is None:
                row += [""] * (len(vnames) + fi.N_FEATURES)
            else:
                row += [s["values"].get(n, "") for n in vnames] + list(s["features"])
            row += [int(x) for x in r["logits"]] + [int(r["rules"])] + [int(x) for x in r["countdown"]]
            row += ["" if s is None else int(s[k]) for k in ("ns_cond", "es_cond", "ns_latch", "es_latch")]
            w.writerow(row)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="dataset folder with network.json and telemetry.csv")
    ap.add_argument("--out", required=True)
    ap.add_argument("--set", default="g1", choices=["g0", "g1", "g2"])
    ap.add_argument("--weights", default="v0", help="'v0', 'none', or a weights.bin blob")
    ap.add_argument("--weights-version", type=int, default=None)
    ap.add_argument("--config", default=None, help="global_config.json from training (thresholds, K, gap_thr)")
    ap.add_argument("--countdown", default="review_r1r2", choices=["review_r1r2", "plan_v1"])
    ap.add_argument("--mem", action="store_true", help="also write $readmemh files")
    ap.add_argument("--stages", action="store_true", help="also write expected_stages.csv")
    a = ap.parse_args(argv)
    m = build(a.data, a.out, a.set, a.weights, a.weights_version, a.config, a.countdown, a.mem, a.stages)
    print(json.dumps({k: m[k] for k in ("set", "records", "weights", "weights_version", "status_counts")}))


if __name__ == "__main__":
    main()
