"""Feasibility probe: four logistic regressions on memory feature set v1 (docs/plan/lucas/fpga_hardware_plan.md).

Usage:
    python3 docs/research/probe_logistic_memory.py /path/to/HackUTD-ZeroDay

This is a PROBE, not the training pipeline and not features_int.py:
  * Features follow the plan's integer rules (48 B DATA LSBs, sat16((raw*M + 2^(S-1)) >> S), arithmetic-shift
    EMAs). The channel 4-6 constants and a few update-order details are ASSUMPTIONS until Lucas confirms them
    (see docs/plan/mudit/ml_plan.md, questions for Lucas).
  * Validation holds out one whole system at a time (S1..S5). Thresholds and persistence K are then picked on
    the pooled out-of-fold scores, so the event metrics are optimistic exploration, not a final benchmark.
  * answer_key.json is used only to build offline labels. Nothing here is a runtime input.
"""
import json
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

REF = sys.argv[1]
WEEK = f"{REF}/history/full_week"
S_FEAT = 11  # global feature shift; <= 11 keeps every CONFIG multiplier inside one DSP48E1 port (review R3)
HEADS = ["pipeline_leak", "pump_degradation", "pump_failure", "facility_shut_in"]
MEM_SRC = [1, 2, 3, 5, 6]  # channels with last-running values and running means
FEATURE_NAMES = (
    ["inflow", "pump_flow", "receive_flow", "flow_gap", "tank_frac", "discharge_off", "pipeline_off",
     "pump_running", "pump_fault", "wells_active", "well_water", "tank_net_flow"]
    + [f"last_run_ch{c}" for c in MEM_SRC] + [f"fast_ch{c}" for c in MEM_SRC] + [f"slow_ch{c}" for c in MEM_SRC]
    + ["net_flow_smooth", "steps_since_run", "has_run", "memory_depth"]
)


def sat16(v):
    return int(max(-32768, min(32767, v)))


def mul_shift(raw, m, s=S_FEAT):
    return sat16((raw * m + (1 << (s - 1))) >> s)


net = json.load(open(f"{WEEK}/network.json"))
tel = pd.read_csv(f"{WEEK}/telemetry.csv")
wide = tel.pivot_table(index="ts_unix", columns=["asset_id", "metric"], values="value")
ts = wide.index.values
answer_key = json.load(open(f"{WEEK}/answer_key.json"))
shutdown = net["defaults"]["tank_limits_pct"]["shutdown"]

rows = []
for system in net["systems"]:
    p0 = system["disposal_site"]["pressure_psi"]
    for fac in system["facilities"]:
        wells = fac["wells"]
        B = sum(w["baseline_water_bpd"] for w in wells)
        Q, C, W = fac["pump"]["max_flow_bpd"], fac["tank"]["capacity_bbl"], len(wells)
        M_B, M_Q = round(8192 / B * 2 ** S_FEAT), round(8192 / Q * 2 ** S_FEAT)
        M_W, M_net = round(16384 / W * 2 ** S_FEAT), round(16384 * 288 * C / (10000 * B) * 2 ** S_FEAT)
        M_lvl, M_dis, M_pl = round(16384 / 10000 * 2 ** S_FEAT), round(16384 / 1500 * 2 ** S_FEAT), round(16384 / 500 * 2 ** S_FEAT)

        def g(asset, metric):
            return wide[(asset, metric)].values

        # 48 B DATA encodings (LSBs from the plan)
        inflow = np.round(g(fac["id"], "inflow_bpd") * 2).astype(int)
        level = np.round(g(fac["tank"]["id"], "level_pct") * 100).astype(int)
        pstat = g(fac["pump"]["id"], "status").astype(int)
        pflow = np.round(g(fac["pump"]["id"], "flow_bpd") * 2).astype(int)
        dis = np.round(g(fac["pump"]["id"], "discharge_psi") * 10).astype(int)
        recv = np.round(g(fac["pipeline"]["id"], "receive_flow_bpd") * 2).astype(int)
        pl = np.round(g(fac["pipeline"]["id"], "pressure_psi") * 10).astype(int)
        wstat = np.stack([g(w["id"], "status").astype(int) for w in wells])
        wwat = np.stack([np.round(g(w["id"], "water_bpd") * 2).astype(int) for w in wells])
        P0 = p0 * 10

        last = [0] * 5; ef = [0] * 5; es = [0] * 5
        has_run = False; e_net = None; n_off = 0; prev_level = None
        for i, t in enumerate(ts):
            ch = [
                mul_shift(inflow[i], M_B), mul_shift(pflow[i], M_Q), mul_shift(recv[i], M_Q),
                mul_shift(pflow[i] - recv[i], M_Q), mul_shift(level[i], M_lvl), mul_shift(dis[i] - P0, M_dis),
                mul_shift(pl[i] - P0, M_pl), 16384 if pstat[i] == 1 else 0, 16384 if pstat[i] == 2 else 0,
                mul_shift(int(wstat[:, i].sum()), M_W), mul_shift(int(wwat[:, i].sum()), M_B),
                0 if prev_level is None else mul_shift(level[i] - prev_level, M_net),
            ]
            prev_level = level[i]
            running = pstat[i] == 1
            if running:
                for k, c in enumerate(MEM_SRC):
                    x8 = ch[c] << 8
                    last[k] = ch[c]
                    if not has_run:
                        ef[k] = es[k] = x8
                    else:
                        ef[k] += (x8 - ef[k]) >> 3
                        es[k] += (x8 - es[k]) >> 6
                has_run = True
                n_off = 0
            else:
                n_off += 1
            x8 = ch[11] << 8
            e_net = x8 if e_net is None else e_net + ((x8 - e_net) >> 3)
            mem = (last + [e >> 8 for e in ef] + [e >> 8 for e in es]
                   + [e_net >> 8, min(n_off, 64) << 8, 16384 if has_run else 0, min(i, 64) << 8])
            rows.append([system["id"], fac["id"], int(t)] + ch + mem
                        + [int(wstat[:, i].sum() == 0 and wwat[:, i].sum() == 0)])

cols = ["system", "facility", "ts"] + FEATURE_NAMES + ["shut_in_label"]
df = pd.DataFrame(rows, columns=cols)
X_int = df[FEATURE_NAMES].values.astype(np.int64)
X = X_int / 16384.0

# Offline labels: half-open [onset, end) per facility; shut-in derived from the wells (handoff section 3).
Y = np.zeros((len(df), 4), dtype=int)
Y[:, 3] = df.shut_in_label.values
for e in answer_key:
    h = HEADS.index(e["category"])
    m = (df.facility.values == e["facility"]) & (df.ts.values >= e["onset_unix"]) & (df.ts.values < e["end_unix"])
    Y[m, h] = 1
event_of = {h: np.full(len(df), "", dtype=object) for h in range(3)}
for e in answer_key:
    h = HEADS.index(e["category"])
    m = (df.facility.values == e["facility"]) & (df.ts.values >= e["onset_unix"]) & (df.ts.values < e["end_unix"])
    event_of[h][m] = e["id"]

print(f"frames {len(df)}, facilities {df.facility.nunique()}, positives per head:",
      dict(zip(HEADS, Y.sum(0).tolist())))
print("feature int range: min", X_int.min(), "max", X_int.max(),
      "| saturated values:", int((np.abs(X_int) >= 32767).sum()))

systems = sorted(df.system.unique())


def loso_scores(cols_idx, h, C=1.0):
    out = np.zeros(len(df))
    for s in systems:
        tr, te = df.system.values != s, df.system.values == s
        clf = LogisticRegression(C=C, class_weight="balanced", max_iter=5000)
        clf.fit(X[tr][:, cols_idx], Y[tr, h])
        out[te] = clf.decision_function(X[te][:, cols_idx])
    return out


def persist(alarm, k):
    """alarm held only after k consecutive positive steps, per facility (rows are facility-major, time-ordered)."""
    res = np.zeros_like(alarm)
    for f in df.facility.unique():
        idx = np.where(df.facility.values == f)[0]
        run = 0
        for j in idx:
            run = run + 1 if alarm[j] else 0
            res[j] = run >= k
    return res


def event_metrics(pred, h):
    y = Y[:, h]
    tp = int((pred & (y == 1)).sum()); fp = int((pred & (y == 0)).sum()); fn = int((~pred & (y == 1)).sum())
    prec = tp / max(tp + fp, 1); rec = tp / max(tp + fn, 1)
    # false alert episodes: rising edges of pred while label is 0, per facility-day
    fa = 0
    for f in df.facility.unique():
        idx = np.where(df.facility.values == f)[0]
        p = pred[idx]; yy = y[idx]
        rises = np.where(p & ~np.r_[False, p[:-1]])[0]
        fa += int(sum(yy[r] == 0 for r in rises))
    days = len(df) / 288
    res = dict(precision=round(prec, 3), recall=round(rec, 3), false_alerts_per_fac_day=round(fa / days, 3))
    if h < 3:
        delays, detected = [], 0
        ids = [e["id"] for e in answer_key if HEADS.index(e["category"]) == h]
        for eid in ids:
            m = np.where(event_of[h] == eid)[0]
            hit = m[pred[m]]
            if len(hit):
                detected += 1
                delays.append(5 * int(hit[0] - m[0]))
        res.update(events=f"{detected}/{len(ids)}",
                   median_delay_min=float(np.median(delays)) if delays else None,
                   max_delay_min=max(delays) if delays else None)
    return res


ALL = list(range(31))
CURRENT = list(range(12))
NO_STATUS = [i for i in ALL if i not in (7, 8, 9, 10, 28, 29)]  # drop pump/well status-derived inputs
PRESSURE = [5, 6] + [base + k for base in (12, 17, 22) for k, c in enumerate(MEM_SRC) if c in (5, 6)]
NO_PRESSURE = [i for i in ALL if i not in PRESSURE]
print("\n== Ablation: pooled out-of-fold frame metrics at logit 0 (p = 0.5), K = 1 ==")
for name, idx, C in [("current 12", CURRENT, 1.0), ("memory v1 (31)", ALL, 1.0), ("memory v1, C=0.1", ALL, 0.1),
                     ("31 minus status/well inputs", NO_STATUS, 1.0), ("31 minus pressure (23)", NO_PRESSURE, 1.0)]:
    line = []
    for h in range(4):
        s = loso_scores(idx, h, C)
        m = event_metrics(s > 0, h)
        line.append(f"{HEADS[h]}: P {m['precision']:.3f} R {m['recall']:.3f}")
    print(f"{name:28s} | " + " | ".join(line))

print("\n== memory v1, threshold + persistence picked on pooled out-of-fold scores (optimistic) ==")
best = {}
for h in range(4):
    s = loso_scores(ALL, h)
    cands = []
    for thr in np.unique(np.r_[np.arange(-8, 8.01, 0.25), np.quantile(s, np.linspace(0.9, 0.999, 40))]):
        for k in (1, 2, 3):
            m = event_metrics(persist(s > thr, k), h)
            cands.append((m["false_alerts_per_fac_day"] <= 0.05, m["recall"], -k, thr, k, m))
    cands.sort(key=lambda c: (c[0], c[1], c[2]), reverse=True)
    _, _, _, thr, k, m = cands[0]
    best[h] = (thr, k)
    print(f"{HEADS[h]:17s} logit_thr {thr:+.2f} K {k} -> {m}")

print("\n== Int16 export check: train on all systems, quantize, compare decisions ==")
L_OUT = 8  # logit output scale 2^-8 (range +-128)
for h in range(4):
    clf = LogisticRegression(C=1.0, class_weight="balanced", max_iter=5000).fit(X, Y[:, h])
    w, b = clf.coef_[0], clf.intercept_[0]
    fw = int(np.floor(np.log2(32767 / max(np.abs(w).max(), 1e-9))))
    fw = min(fw, 31 - 14 - int(np.ceil(np.log2(abs(b) + 1))) - 1)
    wq = np.round(w * 2 ** fw).astype(np.int64)
    bq = int(round(b * 2 ** (fw + 14)))
    s_out = fw + 14 - L_OUT
    acc = X_int @ wq + bq
    logit_q = np.clip((acc + (1 << (s_out - 1))) >> s_out, -32768, 32767)
    f_logit = clf.decision_function(X)
    agree = np.mean((logit_q > 0) == (f_logit > 0))
    unsat = np.abs(f_logit) < 127
    err = np.abs(logit_q / 2 ** L_OUT - f_logit)[unsat].max()
    print(f"{HEADS[h]:17s} |w|max {np.abs(w).max():7.2f} Fw {fw:2d} S_out {s_out:2d} bias_q {bq:>12d} "
          f"max|acc| 2^{np.log2(np.abs(acc).max() + 1):.1f} | max |logit err| {err:.4f} "
          f"(saturated frames {int((~unsat).sum())}) | decision agreement {agree:.5f}")
    top = np.argsort(-np.abs(w))[:5]
    print("   top weights:", ", ".join(f"{FEATURE_NAMES[i]} {w[i]:+.2f}" for i in top))
