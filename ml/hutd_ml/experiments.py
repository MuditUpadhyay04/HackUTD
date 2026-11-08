"""ML architecture experiments (offline): feature-set variants x training recipes, with integer export.

    python -m hutd_ml.experiments --data <full_week> --answer-key <full_week/answer_key.json> --out artifacts/experiments

Every configuration is trained holding out one system at a time (S1..S5), quantized to the FPGA's int16 heads, given
a threshold + persistence K chosen on CLEAN out-of-fold scores (train.choose), and then scored unchanged on clean data
and on held-out distortions (pressure offsets x0.7 / x1.3, extra noise, 2 % missing readings). Only the leak and
degradation heads are compared: failure and shut-in follow the status bits and don't change across these variants.

Feature-set variants keep 31 features and the 12 handoff channels. They only re-purpose memory slots 13 / 18 / 23
(last-running / fast / slow average of receive flow). Receive flow = pump flow - flow gap, so for a linear model those
three slots are almost exactly redundant with the pump-flow and flow-gap slots. A variant therefore changes only
eog_memory. Every new feature uses shifts, adds and compares, like the existing ones.
The answer key is used offline only.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import augment, encode, features_int as fi, labels, model_int, wire
from .train import choose, fit_head, metrics, runs

CH_PUMP, CH_DIS, CH_PIPE = 1, 5, 6
RECV_SLOTS = (13, 18, 23)            # last-running / fast / slow average of receive flow
FAST = {CH_PUMP: 17, CH_DIS: 20, CH_PIPE: 21}   # feature index of the fast average of that channel
SLOW = {CH_PUMP: 22, CH_DIS: 25, CH_PIPE: 26}   # slow average
TEST = ["clean", "pressure_x0.7", "pressure_x1.3", "noise", "drop_2pct"]
DROP_TRAIN = {"drop_train": augment.drop_rows(0.02, seed=7)}


def base_run(net, tel, answer_key):
    enc = encode.encode_frames(net, tel)
    res, stages, _ = fi.run(enc.records, enc.global_config, enc.facility_config)
    X, ok = fi.feature_matrix(stages)
    Y, event_id, _ = labels.make_labels(enc.records, enc.facilities, answer_key)
    fac = enc.records["fac_id"].astype(np.int64)
    status = res["status"].astype(np.int64)
    reset = ((res["reason"].astype(np.int64) & wire.R_RESET) != 0) & (status != wire.ST_DROPPED)
    return {"X": X, "ok": ok, "Y": Y, "ev": event_id, "fac": fac, "ts": enc.records["ts_unix"].astype(np.int64),
            "system": np.array([enc.facilities[f].system for f in fac]), "reset": reset, "n_f": len(enc.facilities)}


def vslow(d, ch, shift=8):
    """Very slow running average of channel `ch` (alpha = 2^-shift), same rules as the engine's averages:
    starts at the first running record after a reset, updates on running VALID/HELD records only."""
    X, ok, fac, reset = d["X"], d["ok"], d["fac"], d["reset"]
    out = np.zeros(len(X), dtype=np.int64)
    state = {}
    for i in range(len(X)):  # records are timestep-major; state is per facility
        f = fac[i]
        if reset[i]:
            state[f] = None
        if not ok[i]:
            continue
        e = state.get(f)
        if X[i, 7] == 16384:
            x8 = int(X[i, ch]) << 8
            e = x8 if e is None else e + ((x8 - e) >> shift)
            state[f] = e
        out[i] = (e >> 8) if e is not None else 0
    return out


def relu(a):
    return np.maximum(a, 0)


def variant(d, name):
    X = d["X"].copy()
    if name == "base31":
        return X
    if name == "drop_redundant26":
        return np.delete(X, [2, 10] + list(RECV_SLOTS), axis=1)
    new = {
        # "pump flow / discharge / pipeline pressure has dropped below its own ~8 h baseline", clamped at 0:
        # no new state, a subtract and a compare on the existing averages
        "relu3": [relu(X[:, SLOW[c]] - X[:, FAST[c]]) for c in (CH_PUMP, CH_DIS, CH_PIPE)],
        # a very slow (alpha 1/256, about 21 h of running) baseline of the same three channels
        "vslow3": [vslow(d, c) for c in (CH_PUMP, CH_DIS, CH_PIPE)],
        # drop below the very slow baseline, clamped at 0
        "relu_vslow3": [relu(vslow(d, c) - X[:, FAST[c]]) for c in (CH_PUMP, CH_DIS, CH_PIPE)],
    }[name]
    for slot, col in zip(RECV_SLOTS, new):
        X[:, slot] = np.where(d["ok"], col, 0)
    return X


def observable_weights(d):
    """See labels.observable_weights (heads 0 and 1 only here)."""
    return labels.observable_weights(d["X"], d["ev"])[:, :2]


def evaluate(sets, feats, recipe, C):
    train_names = ["clean"] + list(augment.TRAIN) + (list(DROP_TRAIN) if recipe.get("drop_aug") else [])
    systems = sorted(set(sets["clean"]["system"]))
    oof = {t: np.zeros((len(sets[t]["X"]), 2), dtype=np.int64) for t in TEST}
    wmax = 0.0
    for s in systems:
        Xs, Ys, Ws = [], [], []
        for n in train_names:
            d = sets[n]
            m = (d["system"] != s) & d["ok"]
            Xs.append(feats[n][m])
            Ys.append(d["Y"][m][:, :2])
            Ws.append(observable_weights(d)[m] if recipe.get("observable") else np.ones((m.sum(), 2)))
        Xtr = np.concatenate(Xs) / 16384.0
        Ytr, Wtr = np.concatenate(Ys), np.concatenate(Ws)
        ws, bs = [], []
        for h in (0, 1):
            from sklearn.linear_model import LogisticRegression
            clf = LogisticRegression(C=C, class_weight="balanced", max_iter=10000)
            clf.fit(Xtr, Ytr[:, h], sample_weight=Wtr[:, h])
            ws.append(clf.coef_[0])
            bs.append(clf.intercept_[0])
        w_q, b_q, s_out, _ = model_int.quantize(np.array(ws), np.array(bs))
        wmax = max(wmax, float(np.abs(np.array(ws)).max()))
        for t in TEST:
            te = sets[t]["system"] == s
            oof[t][te] = model_int.logits_int(feats[t][te], w_q, b_q, s_out)
    c = sets["clean"]
    picks = [choose(oof["clean"][:, h], c["Y"][:, h], c["fac"], c["ev"][:, h], c["ts"], ks=(1, 2, 3)) for h in (0, 1)]
    out = {"max_abs_weight": round(wmax, 1), "thr": [p[0] for p in picks], "k": [p[1] for p in picks], "by": {}}
    from sklearn.metrics import average_precision_score
    for t in TEST:
        d = sets[t]
        row = {}
        for h, name in ((0, "leak"), (1, "degr")):
            pred = runs((oof[t][:, h] > picks[h][0]) & d["ok"], d["fac"]) >= picks[h][1]
            m = metrics(pred, d["Y"][:, h], d["fac"], d["ev"][:, h], d["ts"])
            row[name] = {"ap": round(float(average_precision_score(d["Y"][d["ok"], h], oof[t][d["ok"], h])), 3),
                         "p": round(m["precision"], 3), "r": round(m["recall"], 3),
                         "fa": round(m["false_alerts_per_fac_day"], 3), "ev": f"{m['detected']}/{m['events']}",
                         "med": m["median_delay_min"], "max": m["max_delay_min"]}
        out["by"][t] = row
    return out


CONFIGS = [
    ("base31 | current recipe", "base31", {}, 1.0),
    ("drop_redundant26 | current recipe", "drop_redundant26", {}, 1.0),
    ("relu3 | current recipe", "relu3", {}, 1.0),
    ("vslow3 | current recipe", "vslow3", {}, 1.0),
    ("relu_vslow3 | current recipe", "relu_vslow3", {}, 1.0),
    ("base31 | observable labels", "base31", {"observable": True}, 1.0),
    ("base31 | + missing-data aug", "base31", {"drop_aug": True}, 1.0),
]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--answer-key", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--configs", default=None, help="comma-separated indices into CONFIGS (default: all)")
    ap.add_argument("--extra", default=None, help="JSON list of extra [label, variant, recipe, C] configs")
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    net = encode.load_network(a.data)
    tel = pd.read_csv(Path(a.data) / "telemetry.csv")
    makers = {**{t: augment.TEST[t] for t in TEST}, **augment.TRAIN, **DROP_TRAIN}
    sets = {}
    for n, fn in makers.items():
        sets[n] = base_run(*fn(net, tel), a.answer_key)
        print(f"built {n}", flush=True)
    configs = CONFIGS if not a.configs else [CONFIGS[int(i)] for i in a.configs.split(",")]
    if a.extra:
        configs = configs + [tuple(x) for x in json.loads(a.extra)]
    results = {}
    cache = {}
    for label, var, recipe, C in configs:
        if var not in cache:
            cache[var] = {n: variant(d, var) for n, d in sets.items()}
        r = evaluate(sets, cache[var], recipe, C)
        results[label] = r
        cl = r["by"]["clean"]
        print(f"{label:40s} leak {cl['leak']['p']}/{cl['leak']['r']} med {cl['leak']['med']} | degr "
              f"{cl['degr']['p']}/{cl['degr']['r']} med {cl['degr']['med']} max {cl['degr']['max']} | "
              f"FA p1.3 {r['by']['pressure_x1.3']['leak']['fa']}/{r['by']['pressure_x1.3']['degr']['fa']} "
              f"drop {r['by']['drop_2pct']['leak']['fa']}/{r['by']['drop_2pct']['degr']['fa']}", flush=True)
        (out / "results.json").write_text(json.dumps(results, indent=1))
    (out / "report.md").write_text(render(results))


def render(results):
    L = ["# Architecture experiments", "",
         "Train on 4 systems (clean + augmentations), quantize, choose threshold and K on clean out-of-fold scores, "
         "score the held-out system (clean and distorted). Cells: precision / recall, events caught, median / max "
         "delay in minutes, false alerts per facility-day (FA). Optimistic: thresholds are chosen on the same "
         "clean out-of-fold scores.", ""]
    L += ["| Config | Leak (clean) | Degradation (clean) | FA leak / degr at pressure x0.7 | at x1.3 | with noise | "
          "2 % missing (AP leak / degr) |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for k, r in results.items():
        b = r["by"]
        lk, dg = b["clean"]["leak"], b["clean"]["degr"]
        L.append(f"| {k} | {lk['p']}/{lk['r']}, {lk['ev']}, {lk['med']}/{lk['max']} min, FA {lk['fa']} | "
                 f"{dg['p']}/{dg['r']}, {dg['ev']}, {dg['med']}/{dg['max']} min, FA {dg['fa']} | "
                 f"{b['pressure_x0.7']['leak']['fa']} / {b['pressure_x0.7']['degr']['fa']} | "
                 f"{b['pressure_x1.3']['leak']['fa']} / {b['pressure_x1.3']['degr']['fa']} | "
                 f"{b['noise']['leak']['fa']} / {b['noise']['degr']['fa']} | "
                 f"{b['drop_2pct']['leak']['ap']} / {b['drop_2pct']['degr']['ap']} |")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    main()
