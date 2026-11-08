"""Train the four logistic heads, pick thresholds / persistence / gap_thr, export weights and a report.

    python -m hutd_ml.train --data <full_week folder> --answer-key <full_week/answer_key.json> --out artifacts/v1
                            [--version 1] [--mock <mock_test folder>]

Validation holds out one whole system at a time (S1..S5 -> 5 folds) as a stand-in for the unseen judging network.
Out-of-fold scores are computed with the QUANTIZED integer heads, so thresholds are chosen on the exact values the
FPGA produces. The answer key is read only here (offline), never by runtime code.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score

from . import encode, features_int as fi, labels, model_int, wire

C_GRID = (0.03, 0.1, 0.3, 1.0, 3.0)
FA_BUDGET = 0.05            # false alert episodes per facility-day
THR_GRID = np.round(np.arange(-8, 8.001, 0.25) * 256).astype(int)
K_GRID = (1, 2, 3, 4)


def fit_head(X, y, C):
    clf = LogisticRegression(C=C, class_weight="balanced", max_iter=10000)
    clf.fit(X, y)
    return clf.coef_[0], clf.intercept_[0]


def runs(pred_bool, fac):
    """Consecutive-true run length per facility (records are time-ordered within each facility)."""
    out = np.zeros(len(pred_bool), dtype=np.int64)
    for f in np.unique(fac):
        idx = np.where(fac == f)[0]
        a = pred_bool[idx].astype(np.int64)
        c = np.cumsum(a)
        out[idx] = c - np.maximum.accumulate(np.where(a == 0, c, 0))
    return out


def metrics(pred, y, fac, event_id=None, ts=None):
    tp = int((pred & (y == 1)).sum()); fp = int((pred & (y == 0)).sum()); fn = int((~pred & (y == 1)).sum())
    fa = 0
    for f in np.unique(fac):
        idx = np.where(fac == f)[0]
        p, yy = pred[idx], y[idx]
        rise = p & ~np.r_[False, p[:-1]]
        fa += int((rise & (yy == 0)).sum())
    days = len(y) / 288
    m = {"precision": tp / max(tp + fp, 1), "recall": tp / max(tp + fn, 1), "false_alerts_per_fac_day": fa / days}
    if event_id is not None:
        ids = [e for e in np.unique(event_id) if e]
        delays, det = [], 0
        for e in ids:
            idx = np.where(event_id == e)[0]
            hit = idx[pred[idx]]
            if len(hit):
                det += 1
                delays.append(int(ts[hit[0]] - ts[idx[0]]) // 60)
        m.update(events=len(ids), detected=det, median_delay_min=float(np.median(delays)) if delays else None,
                 max_delay_min=int(max(delays)) if delays else None)
    return m


def choose(logit_q, y, fac, event_id, ts, ks=K_GRID):
    best = None
    for k in ks:
        for thr in THR_GRID:
            pred = runs(logit_q > thr, fac) >= k
            m = metrics(pred, y, fac, event_id, ts)
            key = (m["false_alerts_per_fac_day"] <= FA_BUDGET, m.get("detected", 0), round(m["recall"], 3),
                   -(m.get("median_delay_min") or 0), -k, -abs(int(thr)))
            if best is None or key > best[0]:
                best = (key, int(thr), k, m)
    return best[1], best[2], best[3]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--answer-key", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--version", type=int, default=1)
    ap.add_argument("--mock", default=None, help="optional mock_test folder for a dry run (no labels)")
    ap.add_argument("--augment", action="store_true",
                    help="also train on augment.TRAIN copies (pressure offsets, sizes, noise); validation stays clean")
    ap.add_argument("--c", default=None, help="fixed C per head, e.g. 1,1,0.03,0.03 (skips the C search)")
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    enc = encode.encode_dataset(a.data)
    _, stages, _ = fi.run(enc.records, enc.global_config, enc.facility_config)
    X, ok = fi.feature_matrix(stages)
    assert ok.all(), "practice data should be fully valid"
    Y, event_id, _ = labels.make_labels(enc.records, enc.facilities, a.answer_key)
    fac = enc.records["fac_id"].astype(np.int64)
    ts = enc.records["ts_unix"].astype(np.int64)
    system = np.array([enc.facilities[f].system for f in fac])
    systems = sorted(set(system))
    Xf = X / 16384.0
    print(f"records {len(X)}, positives {dict(zip(wire.HEADS, Y.sum(0).tolist()))}, folds {systems}")
    aug = []
    if a.augment:
        import pandas as pd
        from . import augment
        net0 = encode.load_network(a.data)
        tel0 = pd.read_csv(Path(a.data) / "telemetry.csv")
        for name, fn in augment.TRAIN.items():
            e2 = encode.encode_frames(*fn(net0, tel0))
            _, st2, _ = fi.run(e2.records, e2.global_config, e2.facility_config)
            X2, ok2 = fi.feature_matrix(st2)
            Y2, _, _ = labels.make_labels(e2.records, e2.facilities, a.answer_key)
            sys2 = np.array([e2.facilities[f].system for f in e2.records["fac_id"].astype(np.int64)])
            aug.append((X2[ok2], Y2[ok2], sys2[ok2]))
            print(f"augmentation {name}: {int(ok2.sum())} records", flush=True)

    def train_rows(exclude=None, cols=None):
        """Clean rows (+ augmented copies) whose system is not `exclude`, as float features."""
        parts = [(X, Y, system)] + aug
        Xs = np.concatenate([p[0][p[2] != exclude] for p in parts]) / 16384.0
        Ys = np.concatenate([p[1][p[2] != exclude] for p in parts])
        return (Xs if cols is None else Xs[:, cols]), Ys

    # 1. C per head by pooled out-of-fold average precision (float)
    chosen_C, cv = [], {}
    folds = {s: train_rows(s) for s in systems}
    for h in range(4):
        if a.c:
            chosen_C.append(float(a.c.split(",")[h]))
            cv[wire.HEADS[h]] = {"fixed": chosen_C[-1]}
            continue
        scores = {}
        for C in C_GRID:
            oof = np.zeros(len(X))
            for s in systems:
                te = system == s
                w, b = fit_head(folds[s][0], folds[s][1][:, h], C)
                oof[te] = Xf[te] @ w + b
            scores[C] = average_precision_score(Y[:, h], oof)
        cv[wire.HEADS[h]] = {str(C): round(v, 4) for C, v in scores.items()}
        chosen_C.append(max(scores, key=lambda C: (round(scores[C], 3), -C)))
        print(f"{wire.HEADS[h]:17s} AP by C {cv[wire.HEADS[h]]} -> C = {chosen_C[-1]}")

    # 2. Out-of-fold INTEGER logits with the chosen C (quantized per fold, exactly like an export)
    oof_q = np.zeros((len(X), 4), dtype=np.int64)
    oof_f = np.zeros((len(X), 4))
    for s in systems:
        tr, te = system != s, system == s
        ws, bs = zip(*(fit_head(folds[s][0], folds[s][1][:, h], chosen_C[h]) for h in range(4)))
        w_q, b_q, s_out, _ = model_int.quantize(np.array(ws), np.array(bs))
        oof_q[te] = model_int.logits_int(X[te], w_q, b_q, s_out)
        oof_f[te] = Xf[te] @ np.array(ws).T + np.array(bs)

    # 3. thresholds + K: per class (proposal) and a single K (wire v1)
    per_class = []
    for h in range(4):
        thr, k, m = choose(oof_q[:, h], Y[:, h], fac, event_id[:, h] if h < 3 else None, ts)
        per_class.append({"thr": thr, "k": k, "metrics": m})
    single = None
    for k in K_GRID:
        picks = [choose(oof_q[:, h], Y[:, h], fac, event_id[:, h] if h < 3 else None, ts, ks=(k,)) for h in range(4)]
        score = (sum(p[2]["false_alerts_per_fac_day"] <= FA_BUDGET for p in picks),
                 sum(p[2].get("detected", 0) for p in picks), round(sum(p[2]["recall"] for p in picks), 3), -k)
        if single is None or score > single[0]:
            single = (score, k, picks)
    k_single = single[1]
    single_picks = [{"thr": p[0], "k": p[1], "metrics": p[2]} for p in single[2]]

    # 4. gap_thr from healthy running flow gap; E-STOP check on out-of-fold logits
    running = X[:, 7] == 16384
    healthy_gap = X[running & (Y[:, 0] == 0), 3]
    p999 = float(np.percentile(healthy_gap, 99.9))
    gap_thr = int(max(encode.DEFAULT_GAP_THR, np.ceil(p999 * 1.25)))
    thr0 = single_picks[0]["thr"]
    gap_hit = runs((X[:, 3] > gap_thr) & (oof_q[:, 0] > thr0), fac) >= k_single
    estop = {"gap_thr": gap_thr, "healthy_running_gap_p99_9": round(p999, 1),
             "leak_events_with_estop": int(sum(gap_hit[event_id[:, 0] == e].any() for e in np.unique(event_id[:, 0]) if e)),
             "leak_events": int(len([e for e in np.unique(event_id[:, 0]) if e])),
             "estop_frames_outside_leaks": int((gap_hit & (Y[:, 0] == 0)).sum())}

    # 5. calibration (Platt on out-of-fold integer logits; for the server's displayed confidence)
    calib = []
    for h in range(4):
        z = (oof_q[:, h] / 2 ** model_int.L_OUT).reshape(-1, 1)
        cl = LogisticRegression(C=1e6, max_iter=10000).fit(z, Y[:, h])
        calib.append({"a": float(cl.coef_[0][0]), "c": float(cl.intercept_[0])})

    # 6. ablation (frame P/R at logit 0): current channels only vs memory set v1
    ablation = {}
    for name, cols in (("current_12", list(range(12))), ("memory_v1_31", list(range(31)))):
        row = {}
        for h in range(4):
            oof = np.zeros(len(X))
            for s in systems:
                tr, te = system != s, system == s
                Xt, Yt = train_rows(s, cols)
                w, b = fit_head(Xt, Yt[:, h], chosen_C[h])
                oof[te] = Xf[te][:, cols] @ w + b
            m = metrics(oof > 0, Y[:, h], fac)
            row[wire.HEADS[h]] = f"{m['precision']:.2f} / {m['recall']:.2f}"
        ablation[name] = row

    # 7. final model on all systems
    Xall, Yall = train_rows(None)
    ws, bs = zip(*(fit_head(Xall, Yall[:, h], chosen_C[h]) for h in range(4)))
    W_f, B_f = np.array(ws), np.array(bs)
    w_q, b_q, s_out, fw = model_int.quantize(W_f, B_f)
    lq = model_int.logits_int(X, w_q, b_q, s_out)
    lf = Xf @ W_f.T + B_f
    unsat = np.abs(lf) < 127
    agreement = {"decision_agreement": float(np.mean((lq > 0) == (lf > 0))),
                 "max_abs_logit_error_unsaturated": float(np.abs(lq / 256 - lf)[unsat].max())}
    vec_rows = [int(np.argmax(Y[:, h])) for h in range(4)]
    vec_rows += [int(np.argmax(running & (Y.sum(1) == 0))), int(np.argmax(~running & (Y.sum(1) == 0)))]
    vectors = model_int.edge_vectors() + [X[i] for i in vec_rows]
    meta = {"version": a.version, "feature_set_id": fi.FEATURE_SET_ID, "C": chosen_C, "augmented": bool(a.augment),
            "w": W_f.round(6).tolist(), "b": B_f.round(6).tolist()}
    mh = model_int.model_hash(meta)
    blob = model_int.pack_blob(w_q, b_q, s_out, vectors, mhash=mh)
    assert model_int.self_test(blob)
    data_sha = hashlib.sha256(enc.records.tobytes()).hexdigest()

    thr_int = [p["thr"] for p in single_picks]
    gcfg = {"s_feat": encode.DEFAULT_S_FEAT, "persist_k": k_single, "logit_thr": thr_int, "gap_thr": gap_thr,
            "countdown": "plan_v1", "hold_max": 2, "cd_log2": 4,
            "proposed_per_class": {"persist_k": [p["k"] for p in per_class], "logit_thr": [p["thr"] for p in per_class]},
            "logit_units": "1/256"}
    wjson = {**meta, "heads": wire.HEADS, "feature_names": fi.FEATURE_NAMES, "w_q": w_q.tolist(),
             "b_q": b_q.tolist(), "S_out": s_out, "Fw": fw, "L_out": model_int.L_OUT, "model_hash": f"0x{mh:08X}",
             "blob_crc32": f"0x{model_int.crc32(blob):08X}", "blob_bytes": len(blob),
             "training_data_sha256": data_sha, "calibration_platt": calib,
             "feature_train_min": X.min(0).tolist(), "feature_train_max": X.max(0).tolist()}
    (out / "weights.bin").write_bytes(blob)
    (out / "weights.json").write_text(json.dumps(wjson, indent=1))
    (out / "global_config.json").write_text(json.dumps(gcfg, indent=1))

    mock = None
    if a.mock:
        mock = mock_dry_run(a.mock, blob, a.version, gcfg)
    report = render_report(a, cv, chosen_C, per_class, single_picks, k_single, estop, ablation, agreement, wjson,
                           mock)
    (out / "report.md").write_text(report)
    print(report)


def mock_dry_run(folder, blob, version, gcfg):
    enc = encode.encode_dataset(folder, persist_k=gcfg["persist_k"], logit_thr=gcfg["logit_thr"],
                                gap_thr=gcfg["gap_thr"])
    wts = model_int.to_weights(blob, version)
    res, stages, alerts = fi.run(enc.records, enc.global_config, enc.facility_config, wts, gcfg["countdown"])
    n = len(enc.facilities)
    last = res[-n:]
    rows = []
    for r in last:
        f = enc.facilities[int(r["fac_id"])]
        above = [wire.HEADS[h] for h in range(4) if int(r["logits"][h]) > gcfg["logit_thr"][h]]
        flags = [n_ for b, n_ in enumerate(["pump_fault", "shut_in", "at_shutdown", "at_warning"]) if int(r["rules"]) >> b & 1]
        if above or flags:
            rows.append({"facility": f.id, "model_above_threshold": above, "rules": flags,
                         "countdown_p50_min": int(r["countdown"][1])})
    return {"folder": Path(folder).name, "now_unix": int(enc.timestamps[-1]), "flagged_at_now": rows,
            "alerts": len(alerts)}


def _fmt(m):
    s = f"{m['precision']:.2f} / {m['recall']:.2f} | {m['false_alerts_per_fac_day']:.3f}"
    if "events" in m:
        s += f" | {m['detected']}/{m['events']} | {m['median_delay_min']} / {m['max_delay_min']}"
    else:
        s += " | — | —"
    return s


def render_report(a, cv, chosen_C, per_class, single, k_single, estop, ablation, agreement, wjson, mock):
    L = [f"# Weights v{a.version} — training report", "",
         "Four L2 logistic regressions on memory feature set v1 (31 integer features from `features_int.py`).",
         "Validation: train on 4 systems, score the 5th, for each of S1–S5 (out-of-fold, **integer logits** "
         "after int16 export). Thresholds and K are chosen on those same out-of-fold scores, so the numbers "
         "below are **optimistic exploration on one practice week**, not a benchmark on the unseen network. "
         "Failure and shut-in are directly signalled by pump status 2 / all wells off.", "",
         ("Training data: the clean practice week **plus augmented copies** (healthy pressure offsets x0.8 / x1.2, "
          "sizes x0.7 / x1.5, extra sensor noise; see `augment.TRAIN`). Validation scores are always on the clean "
          "held-out system." if wjson.get("augmented") else "Training data: the clean practice week."), "",
         f"Blob: {wjson['blob_bytes']} B, CRC32 {wjson['blob_crc32']}, model hash {wjson['model_hash']}, "
         f"S_out {wjson['S_out']}, Fw {wjson['Fw']}, logits in 1/256 units.", "",
         "## Regularization (pooled out-of-fold average precision by C)", ""]
    L += [f"- {h}: {cv[h]} → **C = {c}**" for h, c in zip(wire.HEADS, chosen_C)]
    L += ["", f"## Wire v1 settings (single persist_K = {k_single})", "",
          "| Head | logit_thr (1/256) | Precision / recall | False alerts per facility-day | Events | Delay median / max (min) |",
          "| --- | --- | --- | --- | --- | --- |"]
    L += [f"| {h} | {p['thr']} ({p['thr'] / 256:+.2f}) | {_fmt(p['metrics'])} |" for h, p in zip(wire.HEADS, single)]
    L += ["", "## Proposed per-class K (not in wire v1)", "",
          "| Head | logit_thr | K | Precision / recall | False alerts per facility-day | Events | Delay median / max (min) |",
          "| --- | --- | --- | --- | --- | --- | --- |"]
    L += [f"| {h} | {p['thr']} ({p['thr'] / 256:+.2f}) | {p['k']} | {_fmt(p['metrics'])} |"
          for h, p in zip(wire.HEADS, per_class)]
    L += ["", "## E-STOP rule (flow gap AND leak logit, K steps)", "", "```", json.dumps(estop, indent=1), "```", "",
          "## Ablation (frame precision / recall at logit 0, out-of-fold)", "",
          "| Features | " + " | ".join(wire.HEADS) + " |", "| --- | --- | --- | --- | --- |"]
    L += [f"| {k} | " + " | ".join(v[h] for h in wire.HEADS) + " |" for k, v in ablation.items()]
    L += ["", "## Integer export vs float (final model, in-sample)", "", "```", json.dumps(agreement, indent=1),
          "```", ""]
    if mock:
        L += ["## Mock-test dry run (no labels; same week as training, so a sanity check only)", "", "```",
              json.dumps(mock, indent=1), "```", ""]
    return "\n".join(L)


if __name__ == "__main__":
    main()
