"""Reproduce the telemetry audit. Usage: python3 audit_dataset.py REF_REPO OUTPUT_DIR.

Requires numpy and pandas. Optional scikit-learn adds leave-one-system-out
diagnostic baselines; these are NOT CNN or FPGA performance measurements.
Answer keys are used offline only, never as inference inputs.
"""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd


FEATURES = [
    "inflow_norm", "pump_flow_norm", "receive_flow_norm", "flow_gap_norm",
    "tank_fraction", "discharge_offset_norm", "pipeline_offset_norm",
    "pump_running", "pump_fault", "wells_active_fraction", "well_water_norm",
    "tank_net_flow_norm",
]
TARGETS = ["pipeline_leak", "pump_degradation", "pump_failure", "facility_shut_in"]


def quantiles(values):
    series = pd.Series(values).dropna()
    return {str(p): float(series.quantile(p)) for p in [0, .01, .5, .99, 1]} if len(series) else {}


def runs(mask):
    a = np.asarray(mask, dtype=bool)
    starts = np.flatnonzero(a & ~np.r_[False, a[:-1]])
    ends = np.flatnonzero(a & ~np.r_[a[1:], False])
    return list(zip(starts.tolist(), ends.tolist()))


def main():
    root, output = map(Path, sys.argv[1:])
    output.mkdir(parents=True, exist_ok=True)
    base = root / "history/full_week"
    network = json.loads((base / "network.json").read_text())
    events = json.loads((base / "answer_key.json").read_text())
    raw = pd.read_csv(base / "telemetry.csv")
    times = np.sort(raw.ts_unix.unique())
    wide = raw.pivot(index="ts_unix", columns=["asset_id", "metric"], values="value")
    expected_keys = set()
    frames, facilities = [], []
    for system in network["systems"]:
        for facility in system["facilities"]:
            fid = facility["id"]
            f = pd.DataFrame(index=wide.index)
            f["facility"] = fid
            f["system"] = system["id"]
            mapping = {
                "inflow": (fid, "inflow_bpd"),
                "level": (facility["tank"]["id"], "level_pct"),
                "status": (facility["pump"]["id"], "status"),
                "pump_flow": (facility["pump"]["id"], "flow_bpd"),
                "discharge": (facility["pump"]["id"], "discharge_psi"),
                "receive_flow": (facility["pipeline"]["id"], "receive_flow_bpd"),
                "pipeline_pressure": (facility["pipeline"]["id"], "pressure_psi"),
            }
            for name, key in mapping.items():
                expected_keys.add(key)
                f[name] = wide[key]
            well_status, well_water = [], []
            for well in facility["wells"]:
                ks, kw = (well["id"], "status"), (well["id"], "water_bpd")
                expected_keys.update([ks, kw])
                well_status.append(wide[ks])
                well_water.append(wide[kw])
            f["active_fraction"] = pd.concat(well_status, axis=1).mean(axis=1)
            f["well_water"] = pd.concat(well_water, axis=1).sum(axis=1)
            b = sum(w["baseline_water_bpd"] for w in facility["wells"])
            q = facility["pump"]["max_flow_bpd"]
            c = facility["tank"]["capacity_bbl"]
            p = system["disposal_site"]["pressure_psi"]
            f["inflow_norm"] = f.inflow / b
            f["pump_flow_norm"] = f.pump_flow / q
            f["receive_flow_norm"] = f.receive_flow / q
            f["flow_gap_norm"] = (f.pump_flow - f.receive_flow) / q
            f["tank_fraction"] = f.level / 100
            f["discharge_offset_norm"] = (f.discharge - p) / 150
            f["pipeline_offset_norm"] = (f.pipeline_pressure - p) / 50
            f["pump_running"] = (f.status == 1).astype(int)
            f["pump_fault"] = (f.status == 2).astype(int)
            f["wells_active_fraction"] = f.active_fraction
            f["well_water_norm"] = f.well_water / b
            f["tank_net_flow_norm"] = (f.level.diff() * c * 288 / (100 * b)).fillna(0)
            f["balance_residual_bpd"] = f.level.diff() * c * 288 / 100 - (f.inflow - f.pump_flow)
            f["inflow_sum_residual_bpd"] = f.inflow - f.well_water
            f["leak_fraction_running"] = np.where(f.status == 1, 1 - f.receive_flow / f.pump_flow.replace(0, np.nan), np.nan)
            for target in TARGETS[:3]:
                f[target] = 0
            f["event_id"] = ""
            for event in events:
                if event["facility"] == fid:
                    mask = (f.index >= event["onset_unix"]) & (f.index < event["end_unix"])
                    f.loc[mask, event["category"]] = 1
                    f.loc[mask, "event_id"] = event["id"]
            # Derived observation, not an independently supplied fault label.
            f["facility_shut_in"] = ((f.active_fraction == 0) & (f.well_water == 0)).astype(int)
            f["normal"] = (f[TARGETS].sum(axis=1) == 0).astype(int)
            frames.append(f.reset_index())
            facilities.append({"id": fid, "capacity_bbl": c, "baseline_water_bpd": b,
                               "max_flow_bpd": q, "disposal_psi": p,
                               "healthy_flow_to_inflow": q / b})
    data = pd.concat(frames, ignore_index=True)
    # Bounded, causal memory probes: never use a future sample or backfill.
    memory_names = []
    for name in ["pump_flow_norm", "flow_gap_norm", "discharge_offset_norm", "pipeline_offset_norm"]:
        last_name, mean_name = f"last_running_{name}", f"running_mean96_{name}"
        memory_names.extend([last_name, mean_name])
        data[last_name] = data.groupby("facility", sort=False)[name].transform(
            lambda s: s.where(data.loc[s.index, "status"] == 1).ffill(limit=95))
        data[mean_name] = data.groupby("facility", sort=False)[name].transform(
            lambda s: s.where(data.loc[s.index, "status"] == 1).rolling(96, min_periods=1).mean())
    actual_keys = set(wide.columns.tolist())
    summary = {
        "source_commit": subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip(),
        "sha256": {name: hashlib.sha256((base / name).read_bytes()).hexdigest()
                   for name in ["network.json", "ops.json", "telemetry.csv", "answer_key.json"]},
        "integrity": {
            "rows": len(raw), "timestamps": len(times), "assets": raw.asset_id.nunique(),
            "series": len(wide.columns), "facilities": len(facilities),
            "first": raw.timestamp.iloc[0], "last": raw.timestamp.iloc[-1],
            "timestamp_step_seconds": np.unique(np.diff(times)).tolist(),
            "duplicate_keys": int(raw.duplicated(["ts_unix", "asset_id", "metric"]).sum()),
            "missing_values": int(raw.isna().sum().sum()),
            "missing_grid_cells": int(wide.isna().sum().sum()),
            "unexpected_series": sorted(actual_keys - expected_keys),
            "missing_series": sorted(expected_keys - actual_keys),
            "timestamp_string_mismatches": int((pd.to_datetime(raw.timestamp, utc=True).astype("int64") // 10**9 != raw.ts_unix).sum()),
        },
        "facilities": facilities,
        "event_counts": pd.Series([e["category"] for e in events]).value_counts().to_dict(),
        "label_counts": {t: int(data[t].sum()) for t in TARGETS + ["normal"]},
        "target_combinations": data.groupby(TARGETS).size().reset_index(name="count").to_dict("records"),
        "snapshots": [],
        "groups": {},
        "events": [],
        "shut_ins": [],
        "normal_off_runs": [],
        "feature_ranges": {name: quantiles(data[name]) for name in FEATURES},
        "normal_high_level_frames": int(((data.normal == 1) & (data.level >= 85)).sum()),
        "active_fraction_values": data.active_fraction.value_counts().to_dict(),
        "inflow_sum_residual_bpd": quantiles(data.inflow_sum_residual_bpd),
    }
    full_bytes = (base / "telemetry.csv").read_bytes()
    for folder in sorted((root / "history").iterdir()):
        if folder.is_dir() and folder.name != "full_week":
            content = (folder / "telemetry.csv").read_bytes()
            summary["snapshots"].append({
                "folder": folder.name, "rows": content.count(b"\n") - 1,
                "byte_exact_prefix": full_bytes.startswith(content),
                "same_network": (folder / "network.json").read_bytes() == (base / "network.json").read_bytes(),
                "same_ops": (folder / "ops.json").read_bytes() == (base / "ops.json").read_bytes(),
            })
    for category in ["normal"] + TARGETS:
        for state in [0, 1, 2]:
            subset = data[(data[category] == 1) & (data.status == state)]
            summary["groups"][f"{category}/pump_status={state}"] = {
                "count": len(subset),
                **{name: quantiles(subset[name]) for name in FEATURES + ["leak_fraction_running", "balance_residual_bpd", "inflow_sum_residual_bpd"]},
            }
    for event in events:
        f = data[data.facility == event["facility"]].set_index("ts_unix")
        part = f[(f.index >= event["onset_unix"]) & (f.index < event["end_unix"])]
        record = {k: event.get(k) for k in ["id", "facility", "category", "onset", "end", "trips_at"]}
        record.update({"rows": len(part), "status_counts": part.status.value_counts().to_dict(),
                       "level_range": [float(part.level.min()), float(part.level.max())],
                       "off_well_rows": int(part.facility_shut_in.sum()),
                       "running_flow_ratio": quantiles(part.loc[part.status == 1, "pump_flow_norm"]),
                       "running_leak_fraction": quantiles(part.leak_fraction_running)})
        running = part[part.status == 1]
        record["first_running_delay_min"] = float((running.index.min() - event["onset_unix"]) / 60) if len(running) else None
        if event["category"] == "pipeline_leak":
            record["signed_estimated_leak_bbl"] = float((part.pump_flow - part.receive_flow).sum() / 288)
        record["onset_and_end_readings"] = []
        for t in [event["onset_unix"] - 300, event["onset_unix"], event["onset_unix"] + 300,
                  event["end_unix"] - 300, event["end_unix"], event["end_unix"] + 300]:
            if t in f.index:
                row = f.loc[t]
                record["onset_and_end_readings"].append({"ts_unix": t, **{k: float(row[k]) for k in ["status", "level", "pump_flow_norm", "flow_gap_norm", "discharge_offset_norm", "pipeline_offset_norm", "active_fraction", "tank_net_flow_norm"]}})
        summary["events"].append(record)
    for fid, f in data.groupby("facility", sort=False):
        f = f.sort_values("ts_unix").reset_index(drop=True)
        for start, end in runs(f.facility_shut_in):
            summary["shut_ins"].append({"facility": fid, "first_ts": int(f.ts_unix.iloc[start]),
                "last_ts": int(f.ts_unix.iloc[end]), "samples": end - start + 1,
                "first_level": float(f.level.iloc[start]), "last_level": float(f.level.iloc[end]),
                "event_id": f.event_id.iloc[start], "failure_throughout": bool(f.pump_failure.iloc[start:end+1].all())})
        for start, end in runs((f.normal == 1) & (f.status == 0)):
            summary["normal_off_runs"].append({"facility": fid, "samples": end - start + 1})
    # Fixed physical rules: illustrative diagnostics, not optimized thresholds.
    predicted = {
        "pipeline_leak": (data.flow_gap_norm > .05) | (data.pipeline_offset_norm < -.5),
        "pump_degradation": ((data.status == 1) & (data.pump_flow_norm < .95)) | ((data.status == 0) & (data.discharge_offset_norm < -.05)),
        "pump_failure": data.status == 2,
        "facility_shut_in": (data.active_fraction == 0) & (data.well_water == 0),
    }
    summary["rule_baselines"] = {}
    for target in TARGETS:
        y, pred = data[target].astype(bool), predicted[target]
        tp, fp = int((y & pred).sum()), int((~y & pred).sum())
        fn, tn = int((y & ~pred).sum()), int((~y & ~pred).sum())
        summary["rule_baselines"][target] = {"tp": tp, "fp": fp, "fn": fn, "tn": tn}
    try:
        from sklearn.tree import DecisionTreeClassifier
        from sklearn.metrics import precision_recall_fscore_support
        for mode, columns in [("current_frame", FEATURES), ("causal96_memory", FEATURES + memory_names)]:
            results = []
            truth, predictions = [], []
            for system in sorted(data.system.unique()):
                train, test = data.system != system, data.system == system
                model = DecisionTreeClassifier(max_depth=4, min_samples_leaf=5, random_state=0)
                model.fit(data.loc[train, columns].fillna(0), data.loc[train, TARGETS])
                pred = model.predict(data.loc[test, columns].fillna(0))
                truth.append(data.loc[test, TARGETS].to_numpy())
                predictions.append(pred)
                precision, recall, f1, support = precision_recall_fscore_support(data.loc[test, TARGETS], pred, zero_division=0)
                results.append({"held_out": system,
                    "targets": {t: {"precision": float(precision[i]), "recall": float(recall[i]),
                        "f1": float(f1[i]), "positive_frames": int(support[i])} for i, t in enumerate(TARGETS)}})
            precision, recall, f1, support = precision_recall_fscore_support(np.concatenate(truth), np.concatenate(predictions), zero_division=0)
            summary[f"leave_one_system_out_{mode}_tree"] = {
                "folds": results,
                "pooled": {t: {"precision": float(precision[i]), "recall": float(recall[i]),
                    "f1": float(f1[i]), "positive_frames": int(support[i])} for i, t in enumerate(TARGETS)},
            }
    except ImportError:
        summary["diagnostic_tree"] = "scikit-learn unavailable"
    data.to_csv(output / "facility_frames.csv", index=False)
    (output / "audit.json").write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n")
    golden = []
    candidates = {
        "normal": data[(data.facility == "S1_FACILITY_A")].iloc[95],
        "leak_running": data[(data.event_id == "EVENT_1") & (data.status == 1)].iloc[100],
        "degradation_running": data[(data.event_id == "EVENT_5") & (data.status == 1)].iloc[150],
        "failure_onset": data[(data.event_id == "EVENT_9")].iloc[0],
        "shut_in": data[(data.facility == "S1_FACILITY_C") & (data.facility_shut_in == 1)].iloc[0],
    }
    for name, frame in candidates.items():
        history = data[(data.facility == frame.facility) & (data.ts_unix <= frame.ts_unix)].tail(96)
        # Channel-major, oldest -> newest inside each channel; IEEE ties-to-even.
        x = history[FEATURES].to_numpy(dtype=np.float64).T
        assert x.shape == (12, 96) and np.isfinite(x).all()
        q = np.clip(np.rint(x * 16384), -32768, 32767).astype("<i2")
        payload = q.tobytes(order="C")
        (output / f"{name}.i16le.bin").write_bytes(payload)
        golden.append({"name": name, "facility": frame.facility, "ts_unix": int(frame.ts_unix),
            "targets": [int(frame[t]) for t in TARGETS],
            "latest_float_features": x[:, -1].tolist(), "latest_quantized_features": q[:, -1].tolist(),
            "payload_file": f"{name}.i16le.bin", "payload_bytes": len(payload),
            "payload_sha256": hashlib.sha256(payload).hexdigest()})
    (output / "golden_vectors.json").write_text(json.dumps({"feature_order": FEATURES,
        "target_order": TARGETS, "vectors": golden}, indent=2) + "\n")
    print(json.dumps({k: summary[k] for k in ["source_commit", "integrity", "event_counts", "label_counts", "target_combinations", "snapshots", "shut_ins", "rule_baselines"]}, indent=2))
    for mode in ["current_frame", "causal96_memory"]:
        key = f"leave_one_system_out_{mode}_tree"
        if key in summary:
            print(key, json.dumps(summary[key]["pooled"], indent=2))


if __name__ == "__main__":
    main()
