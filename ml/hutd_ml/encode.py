"""Dataset folder -> GLOBAL CONFIG, Facility CONFIG and 48 B DATA records (the laptop's "CSV to binary" step).

Runtime inputs are only network.json and telemetry.csv (ops.json is for the server's planner). Nothing here reads
answer_key.json, and nothing is specific to the practice network: every constant comes from the folder.

Encoding rules (FPGA plan, "Wire layouts v1"): fac_id = position in network.json (systems, then facilities, in file
order); well slots in file order; LSBs 0.5 bpd / 0.01 % / 0.1 psi; a value that is missing, non-finite or not
representable is sent with its `present` bit cleared. Records are timestep-major (all facilities at step t, then
t + 1). The encoder computes no features and makes no judgments.
"""
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from . import wire

DEFAULT_S_FEAT = 11       # feature shift; <= 11 keeps every multiplier inside one DSP48E1 port (review R3)
MAX_MULT_BITS = 24        # unsigned magnitude that fits the DSP48E1 25-bit signed A port
DEFAULT_GAP_THR = 492     # 3 % of Q in feature units (1/16384); see docs/plan/mudit/ml_plan.md section 4.7


class EncodeError(ValueError):
    """The dataset cannot be represented in wire format v1; the message says why."""


@dataclass
class Facility:
    fac_id: int
    system: str
    id: str
    tank: str
    pump: str
    pipeline: str
    wells: list
    B: float           # sum of baseline well water, bpd
    Q: float           # pump max_flow_bpd
    C: float           # tank capacity_bbl
    W: int             # number of wells
    P0: float          # disposal pressure, psi
    max_pressure_psi: float
    well_baselines: list = field(default_factory=list)


def load_network(folder):
    return json.loads(Path(folder, "network.json").read_text())


def facilities_from_network(net):
    facs = []
    for system in net["systems"]:
        p0 = float(system["disposal_site"]["pressure_psi"])
        for f in system["facilities"]:
            wells = [w["id"] for w in f["wells"]]
            facs.append(Facility(
                fac_id=len(facs), system=system["id"], id=f["id"], tank=f["tank"]["id"], pump=f["pump"]["id"],
                pipeline=f["pipeline"]["id"], wells=wells,
                B=float(sum(w["baseline_water_bpd"] for w in f["wells"])), Q=float(f["pump"]["max_flow_bpd"]),
                C=float(f["tank"]["capacity_bbl"]), W=len(wells), P0=p0,
                max_pressure_psi=float(f["pipeline"].get("max_pressure_psi", 3276.7)),
                well_baselines=[float(w["baseline_water_bpd"]) for w in f["wells"]],
            ))
    if len(facs) > wire.MAX_FACILITIES:
        raise EncodeError(f"{len(facs)} facilities > {wire.MAX_FACILITIES} slots in wire format v1")
    for f in facs:
        if not 1 <= f.W <= wire.MAX_WELLS:
            raise EncodeError(f"{f.id} has {f.W} wells; wire format v1 allows 1-{wire.MAX_WELLS}")
        if f.B <= 0 or f.Q <= 0 or f.C <= 0:
            raise EncodeError(f"{f.id}: baseline water, pump max flow and tank capacity must be > 0")
    return facs


def _clip16(v):
    return int(max(-32768, min(32767, v)))


def multipliers(f, s_feat):
    """CONFIG multipliers M (FPGA plan, Facility CONFIG): feature = sat16((raw * M + 2^(S-1)) >> S)."""
    return {
        "M_inv_B": round(8192 / f.B * 2 ** s_feat),
        "M_inv_Q": round(8192 / f.Q * 2 ** s_feat),
        "M_inv_W": round(16384 / f.W * 2 ** s_feat),
        "M_net": round(16384 * 288 * f.C / (10000 * f.B) * 2 ** s_feat),
    }


def fixed_multipliers(s_feat):
    """Hard-wired channels 4-6 (ASSUMPTION A1 until Lucas confirms the RTL constants)."""
    return {
        "M_level": round(16384 / 10000 * 2 ** s_feat),      # level 0.01 % -> fraction * 16384
        "M_discharge": round(16384 / 1500 * 2 ** s_feat),   # 0.1 psi offset / 150 psi
        "M_pipeline": round(16384 / 500 * 2 ** s_feat),     # 0.1 psi offset / 50 psi
    }


def k_countdown(C):
    """K_cd: minutes = (K_cd * dlevel_raw) // (net_raw << 8)  (ASSUMPTION A9).

    minutes = 1440 * C * (dlevel_raw / 10000) / (net_raw / 2) = 0.288 * C * dlevel_raw / net_raw.
    """
    return round(0.288 * C * 256)


def build_facility_config(facs, net, s_feat=DEFAULT_S_FEAT, max_mult_bits=MAX_MULT_BITS):
    limits = net["defaults"]["tank_limits_pct"]
    cfg = np.zeros(len(facs), dtype=wire.FAC_CONFIG_DTYPE)
    fixed = fixed_multipliers(s_feat)
    for f in facs:
        m = multipliers(f, s_feat)
        for name, val in {**m, **fixed}.items():
            if val >= 2 ** max_mult_bits:
                raise EncodeError(
                    f"{f.id}: {name} = {val} needs {math.ceil(math.log2(val + 1))} bits > {max_mult_bits} "
                    f"at S_feat = {s_feat}; lower S_feat")
        flow_hi = _clip16(round(4 * max(f.Q, f.B) * 2))
        flow_lo = -_clip16(round(0.05 * f.Q * 2))
        psi_hi = _clip16(round(f.max_pressure_psi * 10))
        r = cfg[f.fac_id]
        r["fac_id"], r["n_wells"], r["flags"] = f.fac_id, f.W, 1
        r["M_inv_B"], r["M_inv_Q"], r["M_inv_W"], r["M_net"] = m["M_inv_B"], m["M_inv_Q"], m["M_inv_W"], m["M_net"]
        r["P0"] = _clip16(round(f.P0 * 10))
        r["shutdown_lvl"] = round(limits["shutdown"] * 100)
        r["warning_lvl"] = round(limits["warning"] * 100)
        r["K_cd"] = k_countdown(f.C)
        # lo/hi in present-bit order: inflow, level, pump_status, pump_flow, discharge, receive_flow, pipeline
        r["lo"] = [flow_lo, -500, 0, flow_lo, 0, flow_lo, 0]
        r["hi"] = [flow_hi, 10500, 2, flow_hi, psi_hi, flow_hi, psi_hi]
        r["well_lo"] = -_clip16(round(0.05 * max(f.well_baselines) * 2))
        r["well_hi"] = _clip16(round(4 * max(f.well_baselines) * 2))
    return cfg


def build_global_config(s_feat=DEFAULT_S_FEAT, hold_max=2, cd_log2=4, persist_k=1, logit_thr=(0, 0, 0, 0),
                        gap_thr=DEFAULT_GAP_THR, hb_period_ms=1000, hb_timeout_ms=5000, stream_enable=True):
    g = np.zeros(1, dtype=wire.GLOBAL_CONFIG_DTYPE)
    g["S"], g["hold_max"], g["cd_log2"], g["persist_K"] = s_feat, hold_max, cd_log2, persist_k
    g["hb_period_ms"], g["hb_timeout_ms"] = hb_period_ms, hb_timeout_ms
    g["logit_thr"] = [list(logit_thr)]
    g["gap_thr"], g["flags"] = gap_thr, int(stream_enable)
    return g


def _encode_values(values, scale, lo=-32768, hi=32767):
    """float array -> (int16 raw, valid mask). Rounds half up: floor(v * scale + 0.5)."""
    with np.errstate(invalid="ignore", over="ignore"):
        raw = np.floor(values * scale + 0.5)
    ok = np.isfinite(raw) & (raw >= lo) & (raw <= hi)
    return np.where(ok, raw, 0).astype(np.int64), ok


def _encode_enum(values, max_value):
    with np.errstate(invalid="ignore"):
        ok = np.isfinite(values) & (values == np.round(values)) & (values >= 0) & (values <= max_value)
    return np.where(ok, values, 0).astype(np.int64), ok


@dataclass
class Encoded:
    facilities: list
    global_config: np.ndarray
    facility_config: np.ndarray
    records: np.ndarray          # DATA_DTYPE, timestep-major
    timestamps: np.ndarray       # sorted unique ts_unix
    stats: dict


def encode_telemetry(telemetry, facs):
    """Long-form telemetry (timestamp, ts_unix, asset_id, metric, value) -> DATA records, timestep-major."""
    df = telemetry[["ts_unix", "asset_id", "metric", "value"]].copy()
    stats = {"rows_in": int(len(df))}
    df["ts_unix"] = pd.to_numeric(df["ts_unix"], errors="coerce")
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    bad_ts = df["ts_unix"].isna() | (df["ts_unix"] != np.floor(df["ts_unix"]))
    stats["rows_bad_timestamp"] = int(bad_ts.sum())
    df = df[~bad_ts]
    df["ts_unix"] = df["ts_unix"].astype(np.int64)

    # (asset, metric) -> (facility index, field, well slot)
    key = {}
    for f in facs:
        key[(f.id, "inflow_bpd")] = (f.fac_id, "inflow", -1)
        key[(f.tank, "level_pct")] = (f.fac_id, "level", -1)
        key[(f.pump, "status")] = (f.fac_id, "pump_status", -1)
        key[(f.pump, "flow_bpd")] = (f.fac_id, "pump_flow", -1)
        key[(f.pump, "discharge_psi")] = (f.fac_id, "discharge", -1)
        key[(f.pipeline, "receive_flow_bpd")] = (f.fac_id, "receive_flow", -1)
        key[(f.pipeline, "pressure_psi")] = (f.fac_id, "pipeline", -1)
        for slot, w in enumerate(f.wells):
            key[(w, "status")] = (f.fac_id, "well_status", slot)
            key[(w, "water_bpd")] = (f.fac_id, "well_water", slot)
    kdf = pd.DataFrame([(a, m, fi, fld, s) for (a, m), (fi, fld, s) in key.items()],
                       columns=["asset_id", "metric", "fac", "field", "slot"])
    df = df.merge(kdf, on=["asset_id", "metric"], how="left")
    unknown = df["fac"].isna()
    stats["rows_unknown_series"] = int(unknown.sum())
    df = df[~unknown]
    n_before = len(df)
    df = df.drop_duplicates(subset=["ts_unix", "asset_id", "metric"], keep="first")
    stats["rows_duplicate"] = int(n_before - len(df))

    ts = np.array(sorted(df["ts_unix"].unique()), dtype=np.int64)
    t_index = {t: i for i, t in enumerate(ts)}
    n_t, n_f = len(ts), len(facs)
    shape = (n_t, n_f)
    grid = {fld: np.full(shape, np.nan) for fld in ["inflow", "level", "pump_status", "pump_flow", "discharge",
                                                     "receive_flow", "pipeline"]}
    wst = np.full((n_t, n_f, wire.MAX_WELLS), np.nan)
    wwa = np.full((n_t, n_f, wire.MAX_WELLS), np.nan)
    ti = df["ts_unix"].map(t_index).values
    fi = df["fac"].astype(int).values
    si = df["slot"].astype(int).values
    vals = df["value"].values
    flds = df["field"].values
    for fld, arr in grid.items():
        m = flds == fld
        arr[ti[m], fi[m]] = vals[m]
    m = flds == "well_status"
    wst[ti[m], fi[m], si[m]] = vals[m]
    m = flds == "well_water"
    wwa[ti[m], fi[m], si[m]] = vals[m]

    rec = np.zeros(n_t * n_f, dtype=wire.DATA_DTYPE)
    rec["fac_id"] = np.tile(np.arange(n_f), n_t)
    rec["ts_unix"] = np.repeat(ts, n_f)
    present = np.zeros(n_t * n_f, dtype=np.int64)
    scaled = {"inflow": 2, "level": 100, "pump_flow": 2, "receive_flow": 2, "discharge": 10, "pipeline": 10}
    bit = {"inflow": wire.P_INFLOW, "level": wire.P_LEVEL, "pump_flow": wire.P_PUMP_FLOW,
           "receive_flow": wire.P_RECEIVE, "discharge": wire.P_DISCHARGE, "pipeline": wire.P_PIPELINE}
    for fld, sc in scaled.items():
        raw, ok = _encode_values(grid[fld].ravel(), sc)
        rec[fld] = raw
        present |= ok.astype(np.int64) << bit[fld]
    raw, ok = _encode_enum(grid["pump_status"].ravel(), 255)
    rec["pump_status"] = raw
    present |= ok.astype(np.int64) << wire.P_PUMP_STATUS
    wst_flat = wst.reshape(n_t * n_f, wire.MAX_WELLS)
    wwa_flat = wwa.reshape(n_t * n_f, wire.MAX_WELLS)
    well_status = np.zeros(n_t * n_f, dtype=np.int64)
    for s in range(wire.MAX_WELLS):
        raw, ok = _encode_enum(wst_flat[:, s], 3)
        well_status |= raw << (2 * s)
        present |= ok.astype(np.int64) << (wire.P_WELL_STATUS0 + s)
        raw, ok = _encode_values(wwa_flat[:, s], 2)
        rec["well_water"][:, s] = raw
        present |= ok.astype(np.int64) << (wire.P_WELL_WATER0 + s)
    rec["well_status"] = well_status
    rec["present"] = present
    expected = np.zeros(n_t * n_f, dtype=np.int64) | 0x7F
    for f in facs:
        mask = 0x7F | sum(1 << (wire.P_WELL_STATUS0 + s) | 1 << (wire.P_WELL_WATER0 + s) for s in range(f.W))
        expected[rec["fac_id"] == f.fac_id] = mask
    stats.update(records=int(len(rec)), timestamps=int(n_t), facilities=int(n_f),
                 records_with_absent_fields=int(((present & expected) != expected).sum()))
    return rec, ts, stats


def encode_frames(net, tel, s_feat=DEFAULT_S_FEAT, **global_kwargs):
    """Same as encode_dataset, from an already-loaded network dict and telemetry DataFrame."""
    facs = facilities_from_network(net)
    fac_cfg = build_facility_config(facs, net, s_feat=s_feat)
    glob = build_global_config(s_feat=s_feat, **global_kwargs)
    rec, ts, stats = encode_telemetry(tel, facs)
    return Encoded(facs, glob, fac_cfg, rec, ts, stats)


def encode_dataset(folder, s_feat=DEFAULT_S_FEAT, **global_kwargs):
    folder = Path(folder)
    return encode_frames(load_network(folder), pd.read_csv(folder / "telemetry.csv"), s_feat, **global_kwargs)


def decode_record(r):
    """One DATA record -> dict of engineering values (None where `present` is clear). For tests and humans."""
    p = int(r["present"])
    out = {"fac_id": int(r["fac_id"]), "ts_unix": int(r["ts_unix"])}
    for fld, b in [("inflow", wire.P_INFLOW), ("level", wire.P_LEVEL), ("pump_flow", wire.P_PUMP_FLOW),
                   ("receive_flow", wire.P_RECEIVE), ("discharge", wire.P_DISCHARGE), ("pipeline", wire.P_PIPELINE)]:
        out[fld] = int(r[fld]) * wire.LSB[fld] if p >> b & 1 else None
    out["pump_status"] = int(r["pump_status"]) if p >> wire.P_PUMP_STATUS & 1 else None
    out["well_status"] = [(int(r["well_status"]) >> (2 * s) & 3) if p >> (wire.P_WELL_STATUS0 + s) & 1 else None
                          for s in range(wire.MAX_WELLS)]
    out["well_water"] = [int(r["well_water"][s]) * 0.5 if p >> (wire.P_WELL_WATER0 + s) & 1 else None
                         for s in range(wire.MAX_WELLS)]
    return out


def facilities_json(facs):
    return [{"fac_id": f.fac_id, "system": f.system, "facility": f.id, "tank": f.tank, "pump": f.pump,
             "pipeline": f.pipeline, "wells": f.wells, "B": f.B, "Q": f.Q, "C": f.C, "W": f.W, "P0": f.P0}
            for f in facs]
