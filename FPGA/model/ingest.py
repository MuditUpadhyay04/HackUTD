"""Reference ingest: dataset folder -> GLOBAL record, Facility CONFIG rows and 48 B DATA records.

Runtime inputs only: network.json, ops.json (read for completeness, not used by the engine) and telemetry.csv.
Never answer_key.json (global_plan hard rule 1). Nothing about the practice network is hardcoded: slots, wells,
limits and constants all come from the files.

Rules (fpga_hardware_plan.md I/O contract + numerics.md §10):
- fac_id = position in network.json (systems in file order, then facilities in file order), from 0. Well slots
  follow the facility's well order. > 32 facilities or > 8 wells -> refused.
- DATA records are timestep-major: for every distinct ts_unix (ascending), one record per facility, in fac_id order.
- Encoding only, no judgment: flows 0.5 bpd, level 0.01 %, pressures 0.1 psi (int16); statuses raw. A value that
  is missing, unparseable, non-finite or not representable is sent with its PRESENT bit cleared and value 0.
  Duplicate (ts, asset, metric) rows keep the first. Unknown assets/metrics are ignored and counted.
- Rounding (MODEL-Q1): values are parsed as exact decimals and rounded half away from zero.

CLI:  python ingest.py <dataset folder> [--out DIR]   (writes global.bin, config.bin, data.bin; prints a summary)
"""
import csv
import json
import math
import os
import sys
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from layouts import (CFG, D, FEAT_SHIFT, G, N_FAC, N_WELL, ONE, P_DIS, P_INFLOW, P_LEVEL, P_PIPE,  # noqa: E402
                     P_PUMP_FLOW, P_PUMP_ST, P_RECV, P_WELL_ST, P_WELL_WATER, arr_pack)


class IngestError(ValueError):
    pass


def frac(x):
    """Exact rational from a JSON number or CSV string (decimal semantics). Raises ValueError if not finite."""
    if isinstance(x, bool):
        raise ValueError("bool")
    if isinstance(x, int):
        return Fraction(x)
    if isinstance(x, float):
        if not math.isfinite(x):
            raise ValueError("non-finite")
        return Fraction(repr(x))
    s = str(x).strip()
    if s.lower() in ("", "nan", "+nan", "-nan", "inf", "+inf", "-inf", "infinity", "+infinity", "-infinity"):
        raise ValueError("non-finite")
    return Fraction(s)


def rnd(q):
    """Round half away from zero (MODEL-Q1)."""
    q = Fraction(q)
    return math.floor(q + Fraction(1, 2)) if q >= 0 else -math.floor(-q + Fraction(1, 2))


# ------------------------------------------------------------------------------------------------ GLOBAL
GLOBAL_DEFAULTS = dict(S=FEAT_SHIFT, HOLD_MAX=2, CD_LOG2=4, PERSIST_K=3, HB_PERIOD_MS=1000, HB_TIMEOUT_MS=5000,
                       LOGIT_THR=(0, 0, 0, 0), GAP_THR=rnd(Fraction(3, 100) * ONE), FLAGS=0, SHUTIN_WATER_MAX=0)


def global_record(**over):
    """The 32 B GLOBAL CONFIG record (numerics.md §10 suggested defaults, overridable). Returns an int."""
    p = dict(GLOBAL_DEFAULTS)
    p.update(over)
    d = {k: v for k, v in p.items() if k != "LOGIT_THR"}
    d["LOGIT_THR"] = arr_pack(p["LOGIT_THR"])
    d["GAP_THR"] = p["GAP_THR"] & 0xFFFF
    return G.pack(d)


# ------------------------------------------------------------------------------------------------ CONFIG
# Suggested bounds (numerics.md §10), LO/HI index order: inflow, level, pump flow, receive flow, discharge, pipeline.
DEFAULT_LO = (0, 0, 0, 0, 0, 0, 0)
DEFAULT_HI = (32767, 10000, 32767, 32767, 32767, 32767, 0)
DEFAULT_WELL_LO, DEFAULT_WELL_HI = 0, 32767


def facility_row(slot, B, Q, W, C, P0, warn_pct, shut_pct, enable=True, lo=DEFAULT_LO, hi=DEFAULT_HI,
                 well_lo=DEFAULT_WELL_LO, well_hi=DEFAULT_WELL_HI, check=True, name=None):
    """One 64 B Facility CONFIG row (int) from physical constants (numerics.md §10), with the range checks."""
    who = name or "slot %d" % slot
    B, Q, C, P0, warn_pct, shut_pct = (frac(x) for x in (B, Q, C, P0, warn_pct, shut_pct))
    two_s = 1 << FEAT_SHIFT

    def need(cond, msg):
        if check and not cond:
            raise IngestError("%s: %s" % (who, msg))

    need(1 <= W <= N_WELL, "well count %d not in 1..%d" % (W, N_WELL))
    need(B > 0 and Q > 0 and C > 0, "baseline water, pump max flow and tank capacity must be > 0")
    m_inv_b = rnd(8192 * two_s / B)
    m_inv_q = rnd(8192 * two_s / Q)
    m_inv_w = rnd(Fraction(16384 * two_s, W))
    m_net = rnd(Fraction(16384 * 288) * C * two_s / (10000 * B))
    p0 = rnd(10 * P0)
    shut = rnd(100 * shut_pct)
    warn = rnd(100 * warn_pct)
    k_cd = rnd(Fraction(288, 1000) * C * 256)
    for n, v in (("M_INV_B", m_inv_b), ("M_INV_Q", m_inv_q), ("M_INV_W", m_inv_w), ("M_NET", m_net)):
        need(0 <= v < 1 << 32, "%s = %d does not fit u32" % (n, v))
    need(-32768 <= p0 <= 32767, "P0 = %d does not fit s16" % p0)
    need(0 <= shut <= 10000 and 0 <= warn <= 10000, "tank limits must be within 0..100 %")
    need(0 <= k_cd < 1 << 24, "K_CD = %d does not fit 24 bits" % k_cd)
    need(all(a <= b for a, b in zip(lo, hi)) and well_lo <= well_hi, "a lower bound exceeds its upper bound")
    return CFG.pack(dict(FAC_ID=slot, N_WELLS=W, FLAGS=int(enable), M_INV_B=m_inv_b, M_INV_Q=m_inv_q,
                         M_INV_W=m_inv_w, M_NET=m_net, P0=p0, SHUT_LVL=shut, WARN_LVL=warn, RSV=0, K_CD=k_cd,
                         LO=arr_pack(lo), HI=arr_pack(hi), WELL_LO=well_lo, WELL_HI=well_hi))


def tank_limits(net, tank):
    """defaults.tank_limits_pct unless the tank overrides them.  MODEL-Q2: the override key is the tank's own
    `tank_limits_pct` or `limits_pct` object with `warning` / `shutdown` (neither appears in the practice data)."""
    lim = dict(net.get("defaults", {}).get("tank_limits_pct", {}))
    for key in ("tank_limits_pct", "limits_pct"):
        lim.update(tank.get(key) or {})
    if "warning" not in lim or "shutdown" not in lim:
        raise IngestError("tank %s: no warning/shutdown limits" % tank.get("id"))
    return lim["warning"], lim["shutdown"]


def facilities(net):
    """Facilities in slot order with the constants and asset ids the ingest needs."""
    out = []
    for sysd in net["systems"]:
        p0 = sysd["disposal_site"]["pressure_psi"]
        for f in sysd["facilities"]:
            wells = f["wells"]
            warn, shut = tank_limits(net, f["tank"])
            out.append(dict(slot=len(out), id=f["id"], system=sysd["id"], tank=f["tank"]["id"],
                            pump=f["pump"]["id"], pipeline=f["pipeline"]["id"], wells=[w["id"] for w in wells],
                            B=sum((frac(w["baseline_water_bpd"]) for w in wells), Fraction(0)),
                            Q=f["pump"]["max_flow_bpd"], W=len(wells), C=f["tank"]["capacity_bbl"], P0=p0,
                            warn=warn, shut=shut))
    if len(out) > N_FAC:
        raise IngestError("network has %d facilities; the engine has %d slots" % (len(out), N_FAC))
    for f in out:
        if f["W"] > N_WELL:
            raise IngestError("%s has %d wells; the engine has %d well slots" % (f["id"], f["W"], N_WELL))
    return out


def config_rows(facs):
    return {f["slot"]: facility_row(f["slot"], f["B"], f["Q"], f["W"], f["C"], f["P0"], f["warn"], f["shut"],
                                    name=f["id"]) for f in facs}


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


# (asset kind, metric) -> (record key, LSBs per unit or None for a raw enum, enum max)
METRICS = {("fac", "inflow_bpd"): ("inflow", 2, P_INFLOW), ("tank", "level_pct"): ("level", 100, P_LEVEL),
           ("pump", "status"): ("pump_st", None, P_PUMP_ST), ("pump", "flow_bpd"): ("pump_flow", 2, P_PUMP_FLOW),
           ("pump", "discharge_psi"): ("dis", 10, P_DIS), ("pipe", "receive_flow_bpd"): ("recv_flow", 2, P_RECV),
           ("pipe", "pressure_psi"): ("pipe", 10, P_PIPE), ("well", "water_bpd"): ("water", 2, P_WELL_WATER),
           ("well", "status"): ("well_st", None, P_WELL_ST)}


def _encode_value(lsb, raw, enum_max):
    q = frac(raw)
    if lsb is None:
        if q.denominator != 1 or not 0 <= q <= enum_max:
            raise ValueError("not representable")
        return int(q)
    v = rnd(q * lsb)
    if not -32768 <= v <= 32767:
        raise ValueError("outside int16")
    return v


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
                a = amap.get(row.get("asset_id"))
                met = METRICS.get((a[0], row.get("metric"))) if a else None
                if met is None:
                    self.stats["unknown"] += 1
                    continue
                try:
                    ts = int(row["ts_unix"])
                    assert 0 <= ts < 1 << 32
                except (ValueError, TypeError, AssertionError):
                    self.stats["bad_ts"] += 1
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
                except (ValueError, ZeroDivisionError):
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
