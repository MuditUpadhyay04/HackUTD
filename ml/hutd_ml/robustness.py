"""Robustness pass: how do candidate models hold up on a network that looks different from the practice week?

    python -m hutd_ml.robustness --data <full_week> --answer-key <full_week/answer_key.json> --out artifacts/robustness

For each held-out system S1..S5: train on the other 4 (clean, or clean + TRAIN augmentations), quantize to the
FPGA's integers, and score the held-out system under every TEST distortion (augment.py). Pooled per distortion:
average precision (threshold-free) and, at thresholds chosen on CLEAN out-of-fold scores, events caught and
false alerts per facility-day. The answer key is used offline only.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score

from . import augment, encode, features_int as fi, labels, model_int, wire
from .train import choose, fit_head, metrics, runs

HEADS = wire.HEADS


def build(net, tel, answer_key):
    enc = encode.encode_frames(net, tel)
    _, stages, _ = fi.run(enc.records, enc.global_config, enc.facility_config)
    X, ok = fi.feature_matrix(stages)
    Y, event_id, _ = labels.make_labels(enc.records, enc.facilities, answer_key)
    fac = enc.records["fac_id"].astype(np.int64)
    return {"X": X, "ok": ok, "Y": Y, "event_id": event_id, "fac": fac, "ts": enc.records["ts_unix"].astype(np.int64),
            "system": np.array([enc.facilities[f].system for f in fac])}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--answer-key", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    net = encode.load_network(a.data)
    tel = pd.read_csv(Path(a.data) / "telemetry.csv")

    sets = {}
    for name, fn in {**augment.TEST, **augment.TRAIN}.items():
        n2, t2 = fn(net, tel)
        sets[name] = build(n2, t2, a.answer_key)
        d = sets[name]
        print(f"built {name}: {int(d['ok'].sum())}/{len(d['ok'])} records with features", flush=True)
    systems = sorted(set(sets["clean"]["system"]))

    candidates = [("v1 (C 3/3/0.03/0.03)", [3.0, 3.0, 0.03, 0.03], False)]
    candidates += [(f"C={c}", [c, c, 0.03, 0.03], False) for c in (0.01, 0.03, 0.1, 0.3, 1.0, 10.0)]
    candidates += [(f"augmented C={c}", [c, c, 0.03, 0.03], True) for c in (0.1, 0.3, 1.0, 3.0)]

    results = {}
    for cname, Cs, aug in candidates:
        oof = {d: np.zeros((len(sets[d]["X"]), 4), dtype=np.int64) for d in augment.TEST}
        wmax = 0.0
        for s in systems:
            parts = ["clean"] + (list(augment.TRAIN) if aug else [])
            Xtr = np.concatenate([sets[p]["X"][(sets[p]["system"] != s) & sets[p]["ok"]] for p in parts]) / 16384.0
            Ytr = np.concatenate([sets[p]["Y"][(sets[p]["system"] != s) & sets[p]["ok"]] for p in parts])
            ws, bs = zip(*(fit_head(Xtr, Ytr[:, h], Cs[h]) for h in range(4)))
            w_q, b_q, s_out, _ = model_int.quantize(np.array(ws), np.array(bs))
            wmax = max(wmax, float(np.abs(np.array(ws)).max()))
            for d in augment.TEST:
                te = sets[d]["system"] == s
                oof[d][te] = model_int.logits_int(sets[d]["X"][te], w_q, b_q, s_out)
        c = sets["clean"]
        thr = [choose(oof["clean"][:, h], c["Y"][:, h], c["fac"], c["event_id"][:, h] if h < 3 else None, c["ts"],
                      ks=(1,))[0] for h in range(4)]
        res = {"max_abs_weight": round(wmax, 1), "thr": thr, "by_distortion": {}}
        for d in augment.TEST:
            S = sets[d]
            ok = S["ok"]
            row = {}
            for h in range(4):
                ap_ = average_precision_score(S["Y"][ok, h], oof[d][ok, h])
                pred = (runs((oof[d][:, h] > thr[h]) & ok, S["fac"]) >= 1)
                m = metrics(pred, S["Y"][:, h], S["fac"], S["event_id"][:, h] if h < 3 else None, S["ts"])
                row[HEADS[h]] = {"ap": round(float(ap_), 3), "detected": m.get("detected"), "events": m.get("events"),
                                 "fa_per_fac_day": round(m["false_alerts_per_fac_day"], 3),
                                 "precision": round(m["precision"], 3), "recall": round(m["recall"], 3),
                                 "median_delay_min": m.get("median_delay_min")}
            res["by_distortion"][d] = row
        lead = [res["by_distortion"][d][HEADS[h]]["ap"] for d in augment.TEST for h in (0, 1)]
        res["mean_ap_leak_degr"] = round(float(np.mean(lead)), 3)
        res["worst_ap_leak_degr"] = round(float(np.min(lead)), 3)
        results[cname] = res
        print(f"{cname:24s} mean AP {res['mean_ap_leak_degr']} worst {res['worst_ap_leak_degr']} |w|max {wmax:.1f}",
              flush=True)
    (out / "results.json").write_text(json.dumps(results, indent=1))
    (out / "report.md").write_text(render(results))
    print(render(results))


def render(results):
    L = ["# Robustness pass", "",
         "Train on 4 systems (clean, or clean + augmentations with *different* factors), quantize to int16, score "
         "the held-out system under each test distortion; pooled over the 5 folds. AP = average precision "
         "(threshold-free, 1.0 = perfect ranking). Events / false alerts use thresholds chosen on clean "
         "out-of-fold scores with K = 1, then applied unchanged to the distorted data.", "",
         "## Summary (leak + degradation AP over all test distortions)", "",
         "| Candidate | Mean AP | Worst AP | Largest weight |", "| --- | --- | --- | --- |"]
    for k, r in results.items():
        L.append(f"| {k} | {r['mean_ap_leak_degr']} | {r['worst_ap_leak_degr']} | {r['max_abs_weight']} |")
    for k, r in results.items():
        L += ["", f"## {k}", "", "| Distortion | Leak AP | Leak events | Leak FA/fac-day | Degr AP | Degr events | "
              "Degr FA/fac-day | Failure AP | Shut-in AP |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for d, row in r["by_distortion"].items():
            lk, dg = row["pipeline_leak"], row["pump_degradation"]
            L.append(f"| {d} | {lk['ap']} | {lk['detected']}/{lk['events']} | {lk['fa_per_fac_day']} | {dg['ap']} | "
                     f"{dg['detected']}/{dg['events']} | {dg['fa_per_fac_day']} | {row['pump_failure']['ap']} | "
                     f"{row['facility_shut_in']['ap']} |")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    main()
