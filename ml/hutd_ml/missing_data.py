"""R7 comparison: hold policy C (spec question 70) vs legacy A6 under missing readings.

    python -m hutd_ml.missing_data --data <full_week> --answer-key <full_week/answer_key.json> \
        --config artifacts/v3/global_config.json --out artifacts/missing_data [--rates 0.01,0.02,0.05]

The model is trained once per held-out system with the v3 recipe (clean + augment.TRAIN, observable labels, C 3 /
0.03; none of that data has holds, so it is the same under C and A6) or, with --drop-aug, the v4 recipe (plus a 2 %
missing-readings copy, built under hold policy C), and quantized like the export. The same rows are then deleted from
the practice week at each rate, and the held-out system is run through the engine under each hold policy. Scoring uses
the shipped thresholds and per-class K from --config. Reported per (rate, policy):
  - false alerts per facility-day and AP, for leak and degradation;
  - events caught;
  - history resets per facility-day (the first record of each facility excluded);
  - share of VALID/HELD results with < 64 steps of memory (since_reset < 64);
  - share of INVALID records.
The answer key is used offline only.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score

from . import augment, encode, features_int as fi, labels, model_int, wire
from .train import fit_head, metrics, runs


def build(net, tel, answer_key, hold_policy="C"):
    enc = encode.encode_frames(net, tel)
    res, stages, _ = fi.run(enc.records, enc.global_config, enc.facility_config, hold_policy=hold_policy)
    X, ok = fi.feature_matrix(stages)
    Y, ev, _ = labels.make_labels(enc.records, enc.facilities, answer_key)
    fac = enc.records["fac_id"].astype(np.int64)
    return {"X": X, "ok": ok, "Y": Y, "ev": ev, "fac": fac, "ts": enc.records["ts_unix"].astype(np.int64),
            "system": np.array([enc.facilities[f].system for f in fac]), "res": res}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--answer-key", required=True)
    ap.add_argument("--config", required=True, help="global_config.json of the weights being evaluated")
    ap.add_argument("--out", required=True)
    ap.add_argument("--rates", default="0.01,0.02,0.05")
    ap.add_argument("--c", default="3,3,0.03,0.03")
    ap.add_argument("--drop-aug", action="store_true", help="also train on a 2 % missing-readings copy (v4 recipe)")
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    cfg = json.loads(Path(a.config).read_text())
    thr, kk = cfg["logit_thr"], cfg["persist_k_per_class"]
    Cs = [float(x) for x in a.c.split(",")]
    net = encode.load_network(a.data)
    tel = pd.read_csv(Path(a.data) / "telemetry.csv")

    makers = [augment.identity, *augment.TRAIN.values()] + ([augment.drop_rows(0.02, seed=7)] if a.drop_aug else [])
    train_sets = [build(*fn(net, tel), a.answer_key) for fn in makers]
    systems = sorted(set(train_sets[0]["system"]))
    folds = {}
    for s in systems:
        parts = [(d["X"][(d["system"] != s) & d["ok"]], d["Y"][(d["system"] != s) & d["ok"]],
                  labels.observable_weights(d["X"], d["ev"])[(d["system"] != s) & d["ok"]]) for d in train_sets]
        Xt = np.concatenate([p[0] for p in parts]) / 16384.0
        Yt = np.concatenate([p[1] for p in parts])
        Wt = np.concatenate([p[2] for p in parts])
        ws, bs = zip(*(fit_head(Xt, Yt[:, h], Cs[h], Wt[:, h]) for h in range(4)))
        folds[s] = model_int.quantize(np.array(ws), np.array(bs))[:3]
        print(f"fold {s} trained", flush=True)

    rows = []
    cases = [("clean", 0.0)] + [(f"{float(r) * 100:g}% missing", float(r)) for r in a.rates.split(",")]
    for label, rate in cases:
        n2, t2 = (net, tel) if rate == 0 else augment.drop_rows(rate, seed=2)(net, tel)
        for policy in (["C"] if rate == 0 else ["A6", "C"]):
            d = build(n2, t2, a.answer_key, policy)
            lq = np.zeros((len(d["X"]), 4), dtype=np.int64)
            for s in systems:
                te = d["system"] == s
                lq[te] = model_int.logits_int(d["X"][te], *folds[s])
            res, ok = d["res"], d["ok"]
            status = res["status"].astype(int)
            first = np.zeros(len(res), dtype=bool)
            seen = set()
            for i, f in enumerate(d["fac"]):
                if status[i] != wire.ST_DROPPED and f not in seen:
                    first[i] = True
                    seen.add(f)
            resets = ((res["reason"].astype(np.int64) & wire.R_RESET) != 0) & ~first & (status != wire.ST_DROPPED)
            days = len(res) / 288
            vh = (status == wire.ST_VALID) | (status == wire.ST_HELD)
            row = {"case": label, "policy": policy,
                   "resets_per_fac_day": round(float(resets.sum() / days), 2),
                   "share_memory_lt64": round(float((res["since_reset"][vh] < 64).mean()), 3),
                   "share_invalid": round(float((status == wire.ST_INVALID).mean()), 4),
                   "share_held": round(float((status == wire.ST_HELD).mean()), 4)}
            for h, name in ((0, "leak"), (1, "degr")):
                pred = runs((lq[:, h] > thr[h]) & ok, d["fac"]) >= kk[h]
                m = metrics(pred, d["Y"][:, h], d["fac"], d["ev"][:, h], d["ts"])
                row[name] = {"fa_per_fac_day": round(m["false_alerts_per_fac_day"], 3),
                             "ap": round(float(average_precision_score(d["Y"][ok, h], lq[ok, h])), 3),
                             "events": f"{m['detected']}/{m['events']}", "median_delay_min": m["median_delay_min"],
                             "precision": round(m["precision"], 3), "recall": round(m["recall"], 3)}
            rows.append(row)
            print(json.dumps(row), flush=True)
    (out / "results.json").write_text(json.dumps(rows, indent=1))
    L = [f"# R7: hold policy C vs A6 under missing readings ({Path(a.config).parent.name} settings"
         f"{', missing-data augmentation' if a.drop_aug else ''})", "",
         "Same rows deleted under both policies (seed 2). Each system is scored by a model trained without it, "
         f"using {Path(a.config).parent.name}'s shipped thresholds and per-class K. FA = false alerts per facility-day; AP = average precision "
         "(VALID/HELD records). Resets exclude each facility's first record.", "",
         "| Case | Policy | Leak FA | Degr FA | Leak AP | Degr AP | Leak / degr events | Resets per facility-day | "
         "Memory < 64 steps | INVALID | HELD |",
         "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        L.append(f"| {r['case']} | {r['policy']} | {r['leak']['fa_per_fac_day']} | {r['degr']['fa_per_fac_day']} | "
                 f"{r['leak']['ap']} | {r['degr']['ap']} | {r['leak']['events']} / {r['degr']['events']} | "
                 f"{r['resets_per_fac_day']} | {r['share_memory_lt64'] * 100:.1f} % | {r['share_invalid'] * 100:.2f} % | "
                 f"{r['share_held'] * 100:.1f} % |")
    (out / "report.md").write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
