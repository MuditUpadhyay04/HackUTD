"""Judging rehearsal: turn a practice week into a dataset for a network nobody has seen.

The judges' `test/` folder is "a week from a different network (S6 to S11)". This builds one from the practice week so
every stage (encoder -> board -> listen -> operator API -> agents -> console) can be run on a network with other
names, sizes and shape before judging. It never feeds training.

Every change keeps the physics of the recording consistent:

- systems become S6..S11 (6 by default) with new disposal pressures, map positions, fleets and prices;
- each new facility is a practice facility, renamed (letters or words), and maybe moved to another system (pressure
  readings shift with the disposal pressure) or copied at another size (flows, well rates, tank and pump ratings
  scale together; levels and pressures don't change);
- wells are split in two (rates and baselines divide, status is shared) or merged (rates add), so a facility's inflow
  stays the sum of its wells; facilities end up with 1..6 wells;
- the week moves to another date and starts off the hour;
- ops: new prices, truck size and cost, fleet sizes, response and cycle times (repair hours stay, the recording's
  repairs last that long).

It writes the three files plus `answer_key.json` (the practice events mapped through the same renames and copies,
for offline scoring only; the app never reads it), and with `--cut` a mock-test-style folder that stops mid-week.

    python -m hutd_ml.unseen --src <full_week> --out <dir> [--seed 7] [--facilities 24] [--cut 0.72]
    python -m hutd_ml.unseen --score <listen JSONL> <answer_key.json>      # offline scoring of the board's flags
"""
import argparse
import copy
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

FLOWS = ("inflow_bpd", "water_bpd", "flow_bpd", "receive_flow_bpd")
PSI = ("discharge_psi", "pressure_psi")
NAMES = ["NORTH", "EAST", "SOUTH", "WEST", "MESA", "RIDGE", "DRAW", "FLATS", "BASIN", "CREEK"]
METRIC_ORDER = {("well", "water_bpd"): 0, ("well", "status"): 1, ("facility", "inflow_bpd"): 2, ("tank", "level_pct"): 3,
                ("pump", "status"): 4, ("pump", "flow_bpd"): 5, ("pump", "discharge_psi"): 6,
                ("pipeline", "receive_flow_bpd"): 7, ("pipeline", "pressure_psi"): 8}


def _iso(ts):
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _plan(net, rng, n_systems, n_fac):
    """[(new_system_index, source_system, source_facility, scale)]: every practice facility once, then copies."""
    src = [(s, f) for s in net["systems"] for f in s["facilities"]]
    order = list(rng.permutation(len(src)))
    picks = [(src[i], 1.0) for i in order]
    while len(picks) < n_fac:
        picks.append((src[int(rng.integers(len(src)))], float(rng.choice([0.6, 0.8, 1.25, 1.5]))))
    sizes = np.full(n_systems, n_fac // n_systems)
    sizes[: n_fac % n_systems] += 1
    rng.shuffle(sizes)
    plan, k = [], 0
    for si, size in enumerate(sizes):
        for _ in range(size):
            (s, f), scale = picks[k]
            plan.append((si, s, f, scale))
            k += 1
    return plan


def _wells_plan(wells, rng):
    """New wells as lists of (source well id, fraction): split one, merge two, or keep."""
    groups = [[(w["id"], 1.0)] for w in wells]
    r = rng.random()
    if r < 0.45 and len(groups) < 6:                         # split one well (maybe twice)
        for _ in range(int(rng.integers(1, 3))):
            if len(groups) >= 6:
                break
            i = int(rng.integers(len(groups)))
            if len(groups[i]) != 1:
                continue
            (wid, frac), a = groups[i][0], float(rng.choice([0.35, 0.5, 0.6]))
            groups[i:i + 1] = [[(wid, frac * a)], [(wid, frac * (1 - a))]]
    elif r < 0.65 and len(groups) > 1:                       # merge two wells
        i = int(rng.integers(len(groups) - 1))
        groups[i:i + 2] = [groups[i] + groups[i + 1]]
    return groups


def make(src, out, seed=7, n_systems=6, n_fac=24, shift_days=28, offset_min=155, cut=None):
    src, out = Path(src), Path(out)
    rng = np.random.default_rng(seed)
    net = json.loads((src / "network.json").read_text())
    ops = json.loads((src / "ops.json").read_text())
    tel = pd.read_csv(src / "telemetry.csv")
    key = json.loads((src / "answer_key.json").read_text()) if (src / "answer_key.json").exists() else []
    shift = shift_days * 86400 + offset_min * 60
    assert shift % 300 == 0

    new_net = {"meta": copy.deepcopy(net.get("meta", {})), "defaults": copy.deepcopy(net["defaults"]), "systems": []}
    new_ops = {"dataset_id": f"rehearsal_unseen_{seed}",
               "prices": {"oil_per_bbl": float(rng.choice([55, 62, 68, 74])), "gas_per_mcf": float(rng.choice([2.2, 2.8, 3.4]))},
               "expected_repair_hours": copy.deepcopy(ops["expected_repair_hours"]),
               "emergency_trucking": {"truck_capacity_bbl": int(rng.choice([120, 150, 180, 200])),
                                      "cost_per_trip": int(rng.choice([760, 840, 980, 1100]))},
               "systems": {}}
    plan = _plan(net, rng, n_systems, n_fac)
    asset_map = {}          # new asset id -> (source asset id, kind, fraction, scale, psi_delta)
    kinds = {}
    fac_copies = {}         # source facility id -> [(new facility id, new system id, new asset ids by role)]
    for si in range(n_systems):
        sid = f"S{6 + si}"
        lat0, lon0 = 31.0 + float(rng.uniform(-0.8, 1.2)), -103.0 + float(rng.uniform(-1.0, 1.4))
        p0 = float(rng.choice([920, 980, 1040, 1120, 1210, 1280]))
        words = rng.random() < 0.5
        system = {"id": sid, "center": [round(lat0, 3), round(lon0, 3)],
                  "truck_yard": [round(lat0 - 0.18, 3), round(lon0 - 0.25, 3)],
                  "disposal_site": {"id": f"{sid}_DISPOSAL", "lat": round(lat0 + 0.02, 3), "lon": round(lon0 + 0.01, 3),
                                    "pressure_psi": p0},
                  "facilities": []}
        new_ops["systems"][sid] = {"emergency_fleet_size": int(rng.integers(1, 5)), "facilities": {}}
        members = [p for p in plan if p[0] == si]
        for k, (_, s, f, scale) in enumerate(members):
            name = NAMES[k] if words else chr(ord("A") + k)
            fid = f"{sid}_FACILITY_{name}"
            dp = p0 - float(s["disposal_site"]["pressure_psi"])
            dlat = f["lat"] - s["center"][0]
            dlon = f["lon"] - s["center"][1]
            nf = {"id": fid, "lat": round(lat0 + dlat, 4), "lon": round(lon0 + dlon, 4), "wells": [],
                  "tank": {**copy.deepcopy(f["tank"]), "id": f"{sid}_TANK_{name}"},
                  "pump": {**copy.deepcopy(f["pump"]), "id": f"{sid}_PUMP_{name}"},
                  "pipeline": {**copy.deepcopy(f["pipeline"]), "id": f"{sid}_PIPELINE_{name}"}}
            nf["tank"]["capacity_bbl"] = round(f["tank"]["capacity_bbl"] * scale)
            nf["pump"]["max_flow_bpd"] = round(f["pump"]["max_flow_bpd"] * scale)
            if "max_bpd" in nf["pipeline"]:
                nf["pipeline"]["max_bpd"] = round(f["pipeline"]["max_bpd"] * scale)
            if "max_pressure_psi" in nf["pipeline"]:
                nf["pipeline"]["max_pressure_psi"] = round(f["pipeline"]["max_pressure_psi"] + dp)
            wells_by_id = {w["id"]: w for w in f["wells"]}
            for wi, group in enumerate(_wells_plan(f["wells"], rng)):
                wid = f"{sid}_WELL_{name}{wi + 1}"
                nf["wells"].append({"id": wid, **{k2: round(sum(wells_by_id[w][k2] * fr for w, fr in group) * scale, 1)
                                                  for k2 in ("baseline_water_bpd", "oil_bpd", "gas_mcfd")}})
                asset_map[wid] = ("well", group, scale, 0.0)
            asset_map[fid] = ("facility", [(f["id"], 1.0)], scale, 0.0)
            for role in ("tank", "pump", "pipeline"):
                asset_map[nf[role]["id"]] = (role, [(f[role]["id"], 1.0)], scale, dp)
            system["facilities"].append(nf)
            fo = ops["systems"][s["id"]]["facilities"][f["id"]]
            new_ops["systems"][sid]["facilities"][fid] = {"response_min": int(fo["response_min"] + rng.integers(-20, 25)),
                                                         "cycle_min": int(fo["cycle_min"] + rng.integers(-40, 45))}
            fac_copies.setdefault(f["id"], []).append((fid, sid, {r: nf[r]["id"] for r in ("tank", "pump", "pipeline")}))
        new_net["systems"].append(system)

    # telemetry: one block per new asset, then the source's order (time, network order, metric)
    tel = tel[["ts_unix", "asset_id", "metric", "value"]]
    by_asset = {a: g for a, g in tel.groupby("asset_id", sort=False)}
    order = {}
    for s in new_net["systems"]:
        for f in s["facilities"]:
            for a in [w["id"] for w in f["wells"]] + [f["id"], f["tank"]["id"], f["pump"]["id"], f["pipeline"]["id"]]:
                order[a] = len(order)
    parts = []
    for new_id, (kind, group, scale, dp) in asset_map.items():
        frames = []
        for src_id, frac in group:
            g = by_asset[src_id].pivot_table(index="ts_unix", columns="metric", values="value", aggfunc="first")
            frames.append((g, frac))
        base = frames[0][0].copy()
        for m in base.columns:
            if m == "status":
                continue
            if m in FLOWS:
                base[m] = sum(g[m] * fr for g, fr in frames) * scale
            elif m in PSI:
                base[m] = base[m] + dp
        if kind == "well" and len(frames) > 1:                 # merged wells: producing only if every part is
            base["status"] = pd.concat([g["status"] for g, _ in frames], axis=1).min(axis=1, skipna=False)
        long = base.reset_index().melt(id_vars="ts_unix", var_name="metric", value_name="value")
        long["asset_id"] = new_id
        long["kind"] = kind
        parts.append(long)
    t = pd.concat(parts, ignore_index=True)
    # rows the source never had (a missing reading) stay missing: drop NaN rows that came from a missing source row
    t = t.dropna(subset=["value"])
    t["ts_unix"] = t["ts_unix"].astype(np.int64) + shift
    t["o_asset"] = t["asset_id"].map(order)
    t["o_metric"] = [METRIC_ORDER[(k, m)] for k, m in zip(t["kind"], t["metric"])]
    t = t.sort_values(["ts_unix", "o_asset", "o_metric"], kind="stable")

    def write(folder, frame, events):
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "network.json").write_text(json.dumps(new_net, indent=2))
        (folder / "ops.json").write_text(json.dumps(new_ops, indent=2))
        stamps = {ts: _iso(ts) for ts in frame["ts_unix"].unique()}
        vals = [str(int(v)) if m == "status" else (f"{v:.2f}" if m == "level_pct" else f"{v:.1f}")
                for v, m in zip(frame["value"], frame["metric"])]
        out_df = pd.DataFrame({"timestamp": frame["ts_unix"].map(stamps), "ts_unix": frame["ts_unix"],
                               "asset_id": frame["asset_id"], "metric": frame["metric"], "value": vals})
        out_df.to_csv(folder / "telemetry.csv", index=False)
        (folder / "answer_key.json").write_text(json.dumps(events, indent=2))

    events = []
    for e in key:
        for fid, sid, roles in fac_copies.get(e["facility"], []):
            ne = copy.deepcopy(e)
            ne["id"] = f"{e['id']}@{fid}"
            ne["system"], ne["facility"] = sid, fid
            role = e["asset"].split("_")[1].lower()           # S3_PIPELINE_B -> pipeline
            ne["asset"] = roles.get(role, fid)
            for k in list(ne):
                if k.endswith("_unix") and ne[k] is not None:
                    ne[k] += shift
                    ne[k[:-5]] = _iso(ne[k])
            events.append(ne)
    events.sort(key=lambda e: (e["onset_unix"], e["id"]))
    write(out / "full_week", t, events)
    report = {"systems": len(new_net["systems"]), "facilities": sum(len(s["facilities"]) for s in new_net["systems"]),
              "wells_per_facility": sorted({len(f["wells"]) for s in new_net["systems"] for f in s["facilities"]}),
              "rows": int(len(t)), "events": len(events), "first": _iso(t["ts_unix"].min()), "last": _iso(t["ts_unix"].max())}
    if cut:
        ts = np.sort(t["ts_unix"].unique())
        now = int(ts[int(len(ts) * cut)])
        cut_events = []
        for e in events:
            if e["onset_unix"] > now:
                continue
            ce = copy.deepcopy(e)
            if ce.get("end_unix") and ce["end_unix"] > now:
                ce["end"], ce["end_unix"], ce["status"] = None, None, "ongoing"
            cut_events.append(ce)
        name = f"mock_test_{datetime.fromtimestamp(now, tz=timezone.utc):%Y-%m-%dT%H%M}"
        write(out / name, t[t["ts_unix"] <= now], cut_events)
        report["cut"] = {"folder": name, "now": _iso(now), "ongoing": sum(e["status"] == "ongoing" for e in cut_events)}
    (out / "unseen_report.json").write_text(json.dumps(report, indent=1))
    return report


def score(jsonl, answer_key, slack_min=120):
    """Offline only: how the board's `active` flags (listen.py JSON) line up with an answer key.

    Per category: events found (`active` for that problem at that facility between onset and end, or "now"), the
    delay from onset to the first such record, and false episodes (runs of `active` that touch no event of that
    category at that facility, allowing `slack_min` after an event ends)."""
    rows = [json.loads(ln) for ln in Path(jsonl).read_text(encoding="utf-8").splitlines() if ln.strip()]
    rows = [r for r in rows if r.get("type") == "result"]
    now = max(r["ts_unix"] for r in rows)
    on = {}
    for r in rows:
        for c in r.get("active") or []:
            on.setdefault((r["facility"], c), []).append(r["ts_unix"])
    events = json.loads(Path(answer_key).read_text(encoding="utf-8"))
    out = {}
    for cat in ("pipeline_leak", "pump_degradation", "pump_failure"):
        evs = [e for e in events if e["category"] == cat]
        found, delays = 0, []
        for e in evs:
            end = e.get("end_unix") or now
            hits = [t for t in on.get((e["facility"], cat), []) if e["onset_unix"] <= t <= end]
            if hits:
                found += 1
                delays.append((min(hits) - e["onset_unix"]) / 60)
        false = 0
        for (fac, c), ts in on.items():
            if c != cat:
                continue
            ts = sorted(ts)
            runs, start = [], ts[0]
            for a, b in zip(ts, ts[1:] + [None]):
                if b is None or b - a > 300:
                    runs.append((start, a))
                    start = b
            for a, b in runs:
                if not any(e["facility"] == fac and a <= (e.get("end_unix") or now) + slack_min * 60 and b >= e["onset_unix"]
                           for e in evs):
                    false += 1
        out[cat] = {"events": len(evs), "found": found,
                    "median_delay_min": float(np.median(delays)) if delays else None,
                    "max_delay_min": max(delays) if delays else None, "false_episodes": false}
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--score", nargs=2, metavar=("JSONL", "ANSWER_KEY"),
                    help="score listen.py JSON against an answer key (offline) instead of making a dataset")
    ap.add_argument("--src", help="a practice full_week folder")
    ap.add_argument("--out")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--systems", type=int, default=6)
    ap.add_argument("--facilities", type=int, default=24, help="<= 32 for the board")
    ap.add_argument("--shift-days", type=int, default=28)
    ap.add_argument("--cut", type=float, default=0.72, help="mock-test cut as a fraction of the week; 0 = none")
    a = ap.parse_args(argv)
    if a.score:
        print(json.dumps(score(*a.score), indent=1))
        return
    if not (a.src and a.out):
        ap.error("--src and --out are required to make a dataset")
    print(json.dumps(make(a.src, a.out, a.seed, a.systems, a.facilities, a.shift_days, cut=a.cut or None), indent=1))


if __name__ == "__main__":
    main()
