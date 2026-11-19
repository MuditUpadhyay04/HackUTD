"""Reference ingest: dataset folder -> GLOBAL record, Facility CONFIG rows and 48 B DATA records.

Runtime inputs only: network.json, ops.json (read for completeness, not used by the engine) and telemetry.csv.
Never answer_key.json (global_plan hard rule 1). Nothing about the practice network is hardcoded: slots, wells,
limits and constants all come from the files.

Rules (spec v4, numerics.md §10 = Mudit's ml/hutd_ml/encode.py, which this mirrors byte for byte at S = 17):
- fac_id = position in network.json (systems in file order, then facilities in file order), from 0. Well slots
  follow the facility's well order. > 32 facilities or a well count outside 1..8 -> refused.
- DATA records are timestep-major: for every distinct ts_unix (ascending), one record per facility, in fac_id order.
- Encoding only, no judgment: flows 0.5 bpd, level 0.01 %, pressures 0.1 psi (int16); statuses raw. A value that
  is missing, unparseable, non-finite or not representable is sent with its PRESENT bit cleared and value 0.
  Duplicate (ts, asset, metric) rows keep the first. Unknown assets/metrics are ignored and counted.
- Rounding (A15): DATA values are float64, encoded as floor(v * scale + 0.5) (round half up). CONFIG values use the
  same float64 formulas as encode.py (Python round(), half to even on the float).
- CONFIG LO/HI (A14) come from metadata only, in DATA present-bit order: flows -5 % Q .. 4 max(Q, B); level
  -5 .. 105 %; pump status 0 .. 2; psi 0 .. the pipeline's max_pressure_psi (3276.7 if absent); wells -5 % .. 4 x
  the largest well baseline. Tank limits come from defaults.tank_limits_pct (SPEC.md: the same for every tank).

CLI:  python ingest.py <dataset folder> [--out DIR]   (writes global.bin, config.bin, data.bin; prints a summary)
"""
import csv
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from layouts import (CD_LOG2, CFG, D, FEAT_SHIFT, G, N_FAC, N_WELL, ONE, P_DIS, P_INFLOW, P_LEVEL,  # noqa: E402
                     P_PIPE, P_PUMP_FLOW, P_PUMP_ST, P_RECV, P_WELL_ST, P_WELL_WATER, arr_pack)


class IngestError(ValueError):
    pass


# ------------------------------------------------------------------------------------------------ GLOBAL
# encode.build_global_config() defaults with S = 17 (spec v4; FLAGS bit 0 = stream_enable), plus PERSIST_K4 (v4).
GLOBAL_DEFAULTS = dict(S=FEAT_SHIFT, HOLD_MAX=2, CD_LOG2=CD_LOG2, PERSIST_K=1, HB_PERIOD_MS=1000, HB_TIMEOUT_MS=5000,
                       LOGIT_THR=(0, 0, 0, 0), GAP_THR=round(0.03 * ONE), FLAGS=1, PERSIST_K4=(0, 0, 0, 0))


def global_record(**over):
    """The 32 B GLOBAL CONFIG record (numerics.md §10, encode.py defaults, overridable). Returns an int."""
    p = dict(GLOBAL_DEFAULTS)
    p.update(over)
    d = {k: v for k, v in p.items() if k not in ("LOGIT_THR", "PERSIST_K4")}
    d["LOGIT_THR"] = arr_pack(p["LOGIT_THR"])
    d["PERSIST_K4"] = arr_pack(p["PERSIST_K4"], 8)
    d["GAP_THR"] = p["GAP_THR"] & 0xFFFF
    return G.pack(d)


# ------------------------------------------------------------------------------------------------ CONFIG
def _clip16(v):
    return int(max(-32768, min(32767, v)))


def metadata_bounds(B, Q, max_psi, well_base_max):
    """CONFIG LO/HI (present-bit order) and WELL_LO/HI from metadata only (A14, encode.build_facility_config)."""
    flow_hi = _clip16(round(4 * max(Q, B) * 2))
    flow_lo = -_clip16(round(0.05 * Q * 2))
    psi_hi = _clip16(round(max_psi * 10))
    lo = (flow_lo, -500, 0, flow_lo, 0, flow_lo, 0)
    hi = (flow_hi, 10500, 2, flow_hi, psi_hi, flow_hi, psi_hi)
    return lo, hi, -_clip16(round(0.05 * well_base_max * 2)), _clip16(round(4 * well_base_max * 2))


def facility_row(slot, B, Q, W, C, P0, warn_pct, shut_pct, max_psi=3276.7, well_base_max=None, enable=True,
                 lo=None, hi=None, well_lo=None, well_hi=None, check=True, name=None):
    """One 64 B Facility CONFIG row (int) from physical constants (numerics.md §10), with the range checks.
    Bounds default to the metadata bounds (A14); `well_base_max` defaults to B / W."""
    who = name or "slot %d" % slot
    B, Q, C, P0, warn_pct, shut_pct, max_psi = (float(x) for x in (B, Q, C, P0, warn_pct, shut_pct, max_psi))
    two_s = 2 ** FEAT_SHIFT

    def need(cond, msg):
        if check and not cond:
            raise IngestError("%s: %s" % (who, msg))

    need(1 <= W <= N_WELL, "well count %d not in 1..%d" % (W, N_WELL))
    need(B > 0 and Q > 0 and C > 0, "baseline water, pump max flow and tank capacity must be > 0")
    m_inv_b = round(8192 / B * two_s)
    m_inv_q = round(8192 / Q * two_s)
    m_inv_w = round(16384 / W * two_s)
    m_net = round(16384 * 288 * C / (10000 * B) * two_s)
    p0 = round(P0 * 10)
    shut = round(shut_pct * 100)
    warn = round(warn_pct * 100)
    k_cd = round(0.288 * C * 256)
    blo, bhi, bwlo, bwhi = metadata_bounds(B, Q, max_psi, B / W if well_base_max is None else float(well_base_max))
    lo, hi = blo if lo is None else lo, bhi if hi is None else hi
    well_lo, well_hi = bwlo if well_lo is None else well_lo, bwhi if well_hi is None else well_hi
    for n, v in (("M_INV_B", m_inv_b), ("M_INV_Q", m_inv_q), ("M_INV_W", m_inv_w), ("M_NET", m_net)):
        need(0 <= v < 1 << 32, "%s = %d does not fit u32" % (n, v))
    need(-32768 <= p0 <= 32767, "P0 = %d does not fit s16" % p0)
    need(0 <= shut <= 10000 and 0 <= warn <= 10000, "tank limits must be within 0..100 %")
    need(0 <= k_cd < 1 << 24, "K_CD = %d does not fit 24 bits" % k_cd)
    need(all(a <= b for a, b in zip(lo, hi)) and well_lo <= well_hi, "a lower bound exceeds its upper bound")
    return CFG.pack(dict(FAC_ID=slot, N_WELLS=W, FLAGS=int(enable), M_INV_B=m_inv_b, M_INV_Q=m_inv_q,
                         M_INV_W=m_inv_w, M_NET=m_net, P0=p0, SHUT_LVL=shut, WARN_LVL=warn, RSV=0, K_CD=k_cd,
                         LO=arr_pack(lo), HI=arr_pack(hi), WELL_LO=well_lo, WELL_HI=well_hi))


def tank_limits(net):
    """defaults.tank_limits_pct (SPEC.md: the same for every tank; encode.py reads only this)."""
    lim = net.get("defaults", {}).get("tank_limits_pct", {})
    if "warning" not in lim or "shutdown" not in lim:
        raise IngestError("network.json: no defaults.tank_limits_pct warning/shutdown")
    return lim["warning"], lim["shutdown"]


def facilities(net):
    """Facilities in slot order with the constants and asset ids the ingest needs (encode.facilities_from_network)."""
    out = []
    warn, shut = tank_limits(net)
    for sysd in net["systems"]:
        p0 = sysd["disposal_site"]["pressure_psi"]
        for f in sysd["facilities"]:
            wells = f["wells"]
            out.append(dict(slot=len(out), id=f["id"], system=sysd["id"], tank=f["tank"]["id"],
                            pump=f["pump"]["id"], pipeline=f["pipeline"]["id"], wells=[w["id"] for w in wells],
                            B=float(sum(w["baseline_water_bpd"] for w in wells)), Q=float(f["pump"]["max_flow_bpd"]),
                            W=len(wells), C=float(f["tank"]["capacity_bbl"]), P0=float(p0), warn=warn, shut=shut,
                            max_psi=float(f["pipeline"].get("max_pressure_psi", 3276.7)),
                            well_base_max=max((float(w["baseline_water_bpd"]) for w in wells), default=0.0)))
    if len(out) > N_FAC:
        raise IngestError("network has %d facilities; the engine has %d slots" % (len(out), N_FAC))
    for f in out:
        if not 1 <= f["W"] <= N_WELL:
            raise IngestError("%s has %d wells; the engine allows 1..%d" % (f["id"], f["W"], N_WELL))
    return out


def config_rows(facs):
    return {f["slot"]: facility_row(f["slot"], f["B"], f["Q"], f["W"], f["C"], f["P0"], f["warn"], f["shut"],
                                    max_psi=f["max_psi"], well_base_max=f["well_base_max"], name=f["id"])
            for f in facs}


# ------------------------------------------------------------------------------------------------ DATA
def encode_record(fac_id, ts, inflow=0, level=0, pump_flow=0, recv_flow=0, dis=0, pipe=0, pump_st=0, well_st=(),
                  well_water=(), present=0, rsv0=0, rsv1=0, rsv2=0):
    """48 B DATA record (int, byte k at bits [8k+7:8k]) from raw-LSB integer fields."""
    ws = 0
    for i, s in enumerate(well_st):
        ws |= (s & 3) << (2 * i)
    ww = list(well_water) + [0] * (N_WELL - len(well_water))
    return D.pack(dict(FAC_ID=fac_id, RSV0=rsv0, TS=ts, PRESENT=present, INFLOW=inflow, LEVEL=level,
                       PUMP_FLOW=pump_flow, RECV_FLOW=recv_flow, DIS_PSI=dis, PIPE_PSI=pipe, PUMP_ST=pump_st,
                       RSV1=rsv1, WELL_ST=ws, WELL_WATER=arr_pack(ww), RSV2=rsv2))


def present_all(n_wells):
    p = (1 << 7) - 1
    for i in range(n_wells):
        p |= (1 << (P_WELL_ST + i)) | (1 << (P_WELL_WATER + i))
    return p


# (asset kind, metric) -> (record key, LSBs per unit or None for a raw enum, present bit)
METRICS = {("fac", "inflow_bpd"): ("inflow", 2, P_INFLOW), ("tank", "level_pct"): ("level", 100, P_LEVEL),
           ("pump", "status"): ("pump_st", None, P_PUMP_ST), ("pump", "flow_bpd"): ("pump_flow", 2, P_PUMP_FLOW),
           ("pump", "discharge_psi"): ("dis", 10, P_DIS), ("pipe", "receive_flow_bpd"): ("recv_flow", 2, P_RECV),
           ("pipe", "pressure_psi"): ("pipe", 10, P_PIPE), ("well", "water_bpd"): ("water", 2, P_WELL_WATER),
           ("well", "status"): ("well_st", None, P_WELL_ST)}


def _encode_value(lsb, raw, enum_max):
    """encode._encode_values / _encode_enum: float64; floor(v * scale + 0.5) into int16, or an integer 0..enum_max."""
    q = float(str(raw).strip())
    if not math.isfinite(q):
        raise ValueError("non-finite")
    if lsb is None:
        if q != math.floor(q) or not 0 <= q <= enum_max:
            raise ValueError("not representable")
        return int(q)
    v = math.floor(q * lsb + 0.5)
    if not -32768 <= v <= 32767:
        raise ValueError("outside int16")
    return v


def _parse_ts(raw):
    """encode.encode_telemetry: numeric and integral, else the row is dropped (and it must fit u32)."""
    q = float(str(raw).strip())
    if not math.isfinite(q) or q != math.floor(q) or not 0 <= q < 1 << 32:
        raise ValueError("bad ts")
    return int(q)


class Dataset:
    """Result of ingesting one dataset folder."""

    def __init__(self, folder):
        self.folder = folder
        with open(os.path.join(folder, "network.json"), encoding="utf-8") as fh:
            self.net = json.load(fh)
        ops = os.path.join(folder, "ops.json")
        self.ops = json.load(open(ops, encoding="utf-8")) if os.path.exists(ops) else None
        self.facs = facilities(self.net)
        self.glb = global_record()
        self.rows = config_rows(self.facs)
        self.stats = dict(rows=0, unknown=0, duplicate=0, bad_ts=0, unrepresentable=0)
        self.records, self.ts_list = self._data(os.path.join(folder, "telemetry.csv"))

    def _asset_map(self):
        m = {}
        for f in self.facs:
            s = f["slot"]
            m[f["id"]] = ("fac", s, None)
            m[f["tank"]] = ("tank", s, None)
            m[f["pump"]] = ("pump", s, None)
            m[f["pipeline"]] = ("pipe", s, None)
            for i, w in enumerate(f["wells"]):
                m[w] = ("well", s, i)
        return m

    def _data(self, path):
        amap = self._asset_map()
        cells = {}  # (ts, slot) -> {key: value or None}
        seen = set()
        with open(path, newline="", encoding="utf-8") as fh:
            rd = csv.DictReader(fh)
            for row in rd:
                self.stats["rows"] += 1
                try:
                    ts = _parse_ts(row["ts_unix"])
                except (ValueError, TypeError):
                    self.stats["bad_ts"] += 1
                    continue
                a = amap.get(row.get("asset_id"))
                met = METRICS.get((a[0], row.get("metric"))) if a else None
                if met is None:
                    self.stats["unknown"] += 1
                    continue
                kind, slot, wi = a
                key = (met[0], wi) if kind == "well" else (met[0], None)
                k3 = (ts, slot, key)
                if k3 in seen:
                    self.stats["duplicate"] += 1
                    continue
                seen.add(k3)
                try:
                    v = _encode_value(met[1], row.get("value"), 3 if key[0] == "well_st" else 255)
                except (ValueError, TypeError, OverflowError):
                    self.stats["unrepresentable"] += 1
                    v = None
                cells.setdefault((ts, slot), {})[key] = v
        ts_list = sorted({t for t, _s in cells})
        recs = []
        for t in ts_list:
            for f in self.facs:
                recs.append(self._record(f, t, cells.get((t, f["slot"]), {})))
        return recs, ts_list

    def _record(self, f, ts, c):
        present = 0
        vals = {}
        for (_kind, _m), (key, _lsb, pbit) in METRICS.items():
            if key in ("water", "well_st"):
                continue
            v = c.get((key, None))
            if v is not None:
                present |= 1 << pbit
                vals[key] = v
        wst, ww = [0] * N_WELL, [0] * N_WELL
        for i in range(f["W"]):
            s, w = c.get(("well_st", i)), c.get(("water", i))
            if s is not None:
                present |= 1 << (P_WELL_ST + i)
                wst[i] = s
            if w is not None:
                present |= 1 << (P_WELL_WATER + i)
                ww[i] = w
        return encode_record(f["slot"], ts, present=present, well_st=wst, well_water=ww, **vals)

    def record_bytes(self):
        return [r.to_bytes(48, "little") for r in self.records]


def dataset_dir():
    """Practice dataset: $EOG_DATA (repo root or a dataset folder), else ../HackUTD-ZeroDay next to this repo."""
    cands = []
    if os.environ.get("EOG_DATA"):
        cands.append(os.environ["EOG_DATA"])
    here = os.path.dirname(os.path.abspath(__file__))
    for up in ("../../..", "../../../..", "../../../../..", "../../../../../.."):
        cands.append(os.path.join(here, up, "HackUTD-ZeroDay"))
    for c in cands:
        for sub in ("", os.path.join("history", "full_week")):
            d = os.path.normpath(os.path.join(c, sub))
            if os.path.exists(os.path.join(d, "telemetry.csv")) and os.path.exists(os.path.join(d, "network.json")):
                return d
    raise FileNotFoundError("practice dataset not found: set EOG_DATA=/path/to/HackUTD-ZeroDay")


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("folder", nargs="?", help="dataset folder (default: practice full_week)")
    ap.add_argument("--out", help="write global.bin, config.bin (32 slots x 64 B) and data.bin here")
    a = ap.parse_args(argv)
    ds = Dataset(a.folder or dataset_dir())
    print("facilities:", len(ds.facs), " timesteps:", len(ds.ts_list), " records:", len(ds.records),
          " csv:", ds.stats)
    if a.out:
        os.makedirs(a.out, exist_ok=True)
        open(os.path.join(a.out, "global.bin"), "wb").write(ds.glb.to_bytes(32, "little"))
        open(os.path.join(a.out, "config.bin"), "wb").write(
            b"".join(ds.rows.get(s, 0).to_bytes(64, "little") for s in range(N_FAC)))
        open(os.path.join(a.out, "data.bin"), "wb").write(b"".join(ds.record_bytes()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
