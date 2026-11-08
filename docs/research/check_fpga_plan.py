"""Offline cross-check of numbers in docs/plan/lucas/fpga_hardware_plan.md against the practice week.

Usage:
    python3 docs/research/check_fpga_plan.py /path/to/HackUTD-ZeroDay

Checks:
  1. Bit width of the Facility CONFIG multipliers (M_inv_B, M_inv_Q, M_inv_W, M_net) for each global shift S,
     against the u32 CONFIG field and a single DSP48E1 (25 x 18 signed) multiplier.
  2. The plan's countdown method (N=16 ring of inflow - pump flow; mean / max / min) at every pump-failure onset,
     compared with an inflow-only ring and with the answer key's trips_at.
  3. Tripped tanks (level >= shutdown, inflow 0): the plan's formula hits the "not filling" sentinel there.

answer_key.json is read here for OFFLINE EVALUATION ONLY. Nothing in this script is a runtime input.
"""
import json
import math
import sys

import numpy as np
import pandas as pd

ref = sys.argv[1]
week = f"{ref}/history/full_week"
net = json.load(open(f"{week}/network.json"))
answer_key = json.load(open(f"{week}/answer_key.json"))
tel = pd.read_csv(f"{week}/telemetry.csv")
shutdown = net["defaults"]["tank_limits_pct"]["shutdown"]

facs = []
for s in net["systems"]:
    for f in s["facilities"]:
        facs.append(dict(
            sys=s["id"], id=f["id"], tank=f["tank"]["id"], pump=f["pump"]["id"],
            B=sum(w["baseline_water_bpd"] for w in f["wells"]), Q=f["pump"]["max_flow_bpd"],
            C=f["tank"]["capacity_bbl"], W=len(f["wells"]),
        ))
print("facilities per system:", pd.Series([f["sys"] for f in facs]).value_counts().sort_index().to_dict())

# 1. CONFIG multiplier widths ------------------------------------------------------------------------------
DSP_A_MAX = 2 ** 24 - 1  # largest unsigned magnitude in the 25-bit signed DSP48E1 A port
U32_MAX = 2 ** 32 - 1
print("\n== CONFIG multipliers per global S (practice network; W=1 is the worst case for M_inv_W) ==")
for S in range(8, 21):
    ms = []
    for f in facs:
        ms += [8192 / f["B"], 8192 / f["Q"], 16384 / f["W"], 16384 * 288 * f["C"] / (10000 * f["B"])]
    mx = max(round(m * 2 ** S) for m in ms)
    mn = min(round(m * 2 ** S) for m in ms)
    w1 = round(16384 * 2 ** S)
    print(f"S={S:2d}: max M {mx:>14,d} ({math.log2(mx):4.1f} b) fits u32={mx <= U32_MAX!s:5} 1-DSP={mx <= DSP_A_MAX!s:5} | "
          f"W=1 M_inv_W {w1:>14,d} 1-DSP={w1 <= DSP_A_MAX!s:5} | min M {mn:>10,d} (rel. err <= {0.5 / mn:.1e})")

# 2. Countdown at pump-failure onsets ----------------------------------------------------------------------
wide = tel.pivot_table(index="ts_unix", columns=["asset_id", "metric"], values="value")
ts = wide.index.values


def col(asset, metric):
    return wide[(asset, metric)].values


def hours(level, rem_bbl, net_bpd):
    if level >= shutdown:
        return 0.0
    return 24 * rem_bbl / net_bpd if net_bpd > 0 else math.inf


rows = []
for e in (e for e in answer_key if e["category"] == "pump_failure"):
    f = next(x for x in facs if x["id"] == e["facility"])
    inflow, pflow = col(f["id"], "inflow_bpd"), col(f["pump"], "flow_bpd")
    level, pstat = col(f["tank"], "level_pct"), col(f["pump"], "status")
    i0 = int(np.searchsorted(ts, e["onset_unix"]))
    trip = pd.Timestamp(e["trips_at"]).timestamp() if e.get("trips_at") else None
    for k in (0, 3, 6, 12, 16):
        i = i0 + k
        lo = max(0, i - 15)
        ring = (inflow - pflow)[lo:i + 1]
        rem = f["C"] * max(shutdown - level[i], 0) / 100
        rows.append(dict(
            event=e["id"], pump_status_before=int(pstat[i0 - 1]), minutes_after_onset=5 * k,
            truth_h=(trip - ts[i]) / 3600 if trip else None,
            plan_p50=hours(level[i], rem, ring.mean()), plan_p10=hours(level[i], rem, ring.max()),
            plan_p90=hours(level[i], rem, ring.min()), inflow_ring_p50=hours(level[i], rem, inflow[lo:i + 1].mean()),
        ))
df = pd.DataFrame(rows)
pd.set_option("display.width", 200)
print(f"\n== Countdown at pump-failure onsets ({df.event.nunique()} events; hours; inf = 'not filling' sentinel) ==")
print(df.round(2).to_string(index=False))
on = df[df.minutes_after_onset == 0]
print("\npump running at the step before onset:", int((on.pump_status_before == 1).sum()), "of", len(on))
print("plan p50 = sentinel at onset:", int(np.isinf(on.plan_p50).sum()), " plan p90 = sentinel at onset:",
      int(np.isinf(on.plan_p90).sum()))
ok = df.dropna(subset=["truth_h"])
ok = ok[np.isfinite(ok.plan_p50) & (ok.truth_h > 0)]
print("median |p50 - trips_at| h  plan ring:", round(float((ok.plan_p50 - ok.truth_h).abs().median()), 2),
      " inflow-only ring:", round(float((ok.inflow_ring_p50 - ok.truth_h).abs().median()), 2))

# 3. Tripped tanks -----------------------------------------------------------------------------------------
tripped = sum(int(((col(f["tank"], "level_pct") >= shutdown) & (col(f["id"], "inflow_bpd") == 0)).sum()) for f in facs)
print(f"\nframes with level >= shutdown and inflow 0: {tripped} "
      "(plan formula: numerator 0, net inflow <= 0 -> 'not filling' sentinel unless level is checked first)")
