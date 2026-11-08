"""Bit-exact integer reference of the FPGA engine (docs/plan/lucas/fpga_hardware_plan.md, engine v2).

Per DATA record: S0/S1 validate (slot, timestamp step, enums, bounds, hold <= hold_max then reset) -> S2 the 12
channels `sat16((raw * M + 2^(S-1)) >> S)` + rule flags -> S3 the 19 memory features -> S4 countdown -> S5 the
four logistic heads -> S6 alarms. One RESULT per record. Training computes its features with this file, so the
board and the model see identical inputs.

Everything is Python integers with explicit width checks. Where the plan is silent, the choice is marked
ASSUMPTION A<n> and listed in ml/README.md; change it here and in the RTL together.
"""
from dataclasses import dataclass, field

from . import wire

N_CHANNELS = 12
MEM_SRC = (1, 2, 3, 5, 6)  # pump flow, receive flow, flow gap, discharge offset, pipeline offset
N_FEATURES = 31
FEATURE_SET_ID = 1
FEATURE_NAMES = (
    ["inflow_norm", "pump_flow_norm", "receive_flow_norm", "flow_gap_norm", "tank_fraction",
     "discharge_offset_norm", "pipeline_offset_norm", "pump_running", "pump_fault", "wells_active_fraction",
     "well_water_norm", "tank_net_flow_norm"]
    + [f"last_run_{c}" for c in ("pump_flow", "receive_flow", "flow_gap", "discharge_off", "pipeline_off")]
    + [f"fast_mean_{c}" for c in ("pump_flow", "receive_flow", "flow_gap", "discharge_off", "pipeline_off")]
    + [f"slow_mean_{c}" for c in ("pump_flow", "receive_flow", "flow_gap", "discharge_off", "pipeline_off")]
    + ["net_flow_smooth", "steps_since_run", "has_run", "memory_depth"]
)
assert len(FEATURE_NAMES) == N_FEATURES

ALARM_RULES = wire.RULE_PUMP_FAULT | wire.RULE_SHUT_IN | wire.RULE_AT_SHUTDOWN | wire.RULE_AT_WARNING  # A12
STEP_S = 300
ACC_BITS = 48


def sat16(v):
    return -32768 if v < -32768 else 32767 if v > 32767 else v


def round_shift(acc, s_out):
    """Head output step: round half up, then shift right by S_OUT. S_OUT = 0 means no rounding constant and no
    shift (FPGA spec question 46); quantize() never emits it, but the RTL accepts it."""
    return (acc + (1 << (s_out - 1))) >> s_out if s_out > 0 else acc


def mul_shift(raw, m, s):
    """sat16((raw * M + 2^(S-1)) >> S); Python >> is an arithmetic shift (A3). Returns (value, saturated)."""
    v = (raw * m + (1 << (s - 1))) >> s
    return sat16(v), not -32768 <= v <= 32767


@dataclass
class Weights:
    """Active weight bank. version 0 = no weights loaded: logits are 0 (FPGA plan)."""
    w: list = field(default_factory=lambda: [[0] * N_FEATURES for _ in range(4)])  # int16 [4][31]
    b: list = field(default_factory=lambda: [0] * 4)                                # int32 [4]
    s_out: int = 1
    version: int = 0


class _Fac:
    def __init__(self, n_wells):
        self.n_wells = n_wells
        self.last_ts = None
        # alarm conditions and latches (FPGA D8): survive history resets; only an acknowledge (hardware) clears
        self.ns_cond = self.es_cond = self.ns_latch = self.es_latch = False
        self.reset_history()

    def reset_history(self):
        self.last_valid = {}          # field -> raw value; cleared on a history reset (A6)
        self.hold_run = 0
        self.since_reset = 0
        self.prev_level = None
        self.last = [0] * 5
        self.ef = [0] * 5
        self.es = [0] * 5
        self.has_run = False
        self.e_net = None
        self.n_off = 0
        self.ring = None
        self.persist = [0] * 4
        self.gap_run = 0


class Engine:
    """Stateful engine for one run. `process(record)` -> (RESULT dict, stages dict, list of ALERT dicts)."""

    def __init__(self, global_config, facility_config, weights=None, countdown="review_r1r2", persist_k=None,
                 hold_policy="C"):
        g = global_config[0] if getattr(global_config, "shape", ()) else global_config
        self.s = int(g["S"])
        self.hold_max = min(int(g["hold_max"]), 2)  # the RTL clamps HOLD_MAX to 2 (FPGA numerics.md v4 section 3)
        self.cd_log2 = int(g["cd_log2"])
        assert self.cd_log2 == 4, "GLOBAL CD_LOG2 must be 4 (fixed in the RTL)"
        if persist_k is not None:
            self.k = [max(int(x), 1) for x in persist_k]
        else:  # per-class K from GLOBAL bytes 20-23; 0 falls back to byte 3 (FPGA D10)
            self.k = [max(int(k4) or int(g["persist_K"]), 1) for k4 in g["persist_K4"]]
        self.logit_thr = [int(x) for x in g["logit_thr"]]
        self.gap_thr = int(g["gap_thr"])
        self.cfg = {int(c["fac_id"]): c for c in facility_config if int(c["flags"]) & 1}
        self.weights = weights or Weights()
        if countdown not in ("plan_v1", "review_r1r2"):
            raise ValueError("countdown must be 'plan_v1' or 'review_r1r2'")
        self.countdown_variant = countdown
        if hold_policy not in ("C", "A6"):
            raise ValueError("hold_policy must be 'C' (R7, spec question 70) or 'A6' (legacy, comparison only)")
        self.hold_policy = hold_policy
        from .encode import fixed_multipliers
        fm = fixed_multipliers(self.s)
        self.m_level, self.m_dis, self.m_pl = fm["M_level"], fm["M_discharge"], fm["M_pipeline"]
        # N_WELLS > 8 is clamped to 8, like the RTL (FPGA spec questions 14 / 48); the ingest never writes more
        self.fac = {fid: _Fac(min(int(c["n_wells"]), 8)) for fid, c in self.cfg.items()}
        self.result_no = 0

    # ---- helpers ---------------------------------------------------------------------------------------------
    def _result(self, r, status, reason, st=None, logits=(0, 0, 0, 0), rules=0, cd=(wire.COUNTDOWN_NONE,) * 3):
        res = {"fac_id": int(r["fac_id"]), "status": status, "since_reset": min(st.since_reset, 255) if st else 0,
               "ts_unix": int(r["ts_unix"]), "reason": reason, "logits": list(logits), "rules": rules,
               "weights_ver": 0 if status == wire.ST_DROPPED else self.weights.version & 0xFF,
               "countdown": list(cd), "result_no": self.result_no}
        self.result_no = (self.result_no + 1) & 0xFFFFFFFF
        return res

    def _fields(self, r, c, st):
        """S1: per-field validity. Returns (values or None, reason bits, any_held, any_missing)."""
        p = int(r["present"])
        reason = 0
        lo = [int(x) for x in c["lo"]]
        hi = [int(x) for x in c["hi"]]
        raw = {"inflow": int(r["inflow"]), "level": int(r["level"]), "pump_status": int(r["pump_status"]),
               "pump_flow": int(r["pump_flow"]), "discharge": int(r["discharge"]),
               "receive_flow": int(r["receive_flow"]), "pipeline": int(r["pipeline"])}
        checks = {}
        for i, name in enumerate(wire.FACILITY_FIELDS):
            ok = bool(p >> i & 1)
            if not ok:
                reason |= wire.R_FIELD_ABSENT
            elif name == "pump_status" and raw[name] not in (0, 1, 2):
                ok, reason = False, reason | wire.R_ENUM
            elif not lo[i] <= raw[name] <= hi[i]:
                ok, reason = False, reason | wire.R_RANGE
            checks[name] = ok
        ws = int(r["well_status"])
        for s in range(st.n_wells):
            name = f"ws{s}"
            raw[name] = ws >> (2 * s) & 3
            ok = bool(p >> (wire.P_WELL_STATUS0 + s) & 1)
            if not ok:
                reason |= wire.R_FIELD_ABSENT
            elif raw[name] not in (0, 1):
                ok, reason = False, reason | wire.R_ENUM
            checks[name] = ok
            name = f"ww{s}"
            raw[name] = int(r["well_water"][s])
            ok = bool(p >> (wire.P_WELL_WATER0 + s) & 1)
            if not ok:
                reason |= wire.R_FIELD_ABSENT
            elif not int(c["well_lo"]) <= raw[name] <= int(c["well_hi"]):
                ok, reason = False, reason | wire.R_RANGE
            checks[name] = ok
        held = [n for n, ok in checks.items() if not ok and n in st.last_valid]
        missing = [n for n, ok in checks.items() if not ok and n not in st.last_valid]
        return raw, checks, reason, held, missing

    def _countdown(self, c, level, st):
        n = 1 << self.cd_log2
        ring = st.ring
        total = sum(ring)
        mean = total >> self.cd_log2
        shutdown = int(c["shutdown_lvl"])
        if self.countdown_variant == "review_r1r2" and level >= shutdown:
            return (0, 0, 0), False  # D2: tripped tank reads 0, checked before "not filling"
        dl = max(shutdown - level, 0)
        kcd = int(c["K_cd"])

        def minutes(net):
            if net <= 0:
                return wire.COUNTDOWN_NONE
            v = (kcd * dl) // (net << 8)
            return v if v < wire.COUNTDOWN_NONE else wire.COUNTDOWN_NONE

        assert len(ring) == n
        return (minutes(max(ring)), minutes(mean), minutes(min(ring))), mean <= 0

    # ---- main ------------------------------------------------------------------------------------------------
    def process(self, r):
        fid = int(r["fac_id"])
        if int(r["reserved0"]) or int(r["reserved1"]) or int(r["reserved2"]):  # A13 / FPGA D9: before the lookup
            return self._result(r, wire.ST_DROPPED, wire.R_FRAMING), None, []
        if fid >= wire.MAX_FACILITIES or fid not in self.cfg:
            return self._result(r, wire.ST_DROPPED, wire.R_UNKNOWN_FACILITY), None, []
        c, st = self.cfg[fid], self.fac[fid]

        # S1: timestamp step
        ts = int(r["ts_unix"])
        reason = 0
        if st.last_ts is None:  # first record of this facility: a new history (FPGA numerics.md 3.3)
            reason |= wire.R_RESET
        else:
            d = ts - st.last_ts
            if d == 0:  # every DROPPED RESULT carries since_reset = 0 and changes no state
                return self._result(r, wire.ST_DROPPED, wire.R_DUPLICATE), None, []
            if d < STEP_S:  # negative, or a partial step (A4)
                return self._result(r, wire.ST_DROPPED, wire.R_OUT_OF_ORDER), None, []
            missing_steps = d // STEP_S - 1 if d % STEP_S == 0 else self.hold_max + 1  # A4
            if 1 <= missing_steps <= self.hold_max:
                reason |= wire.R_GAP_HELD
            elif missing_steps > self.hold_max:
                st.reset_history()
                reason |= wire.R_RESET
        st.last_ts = ts

        # S1: fields, hold, reset
        raw, checks, freason, held, missing = self._fields(r, c, st)
        reason |= freason
        if self.hold_policy == "C":
            # R7 option C (FPGA spec question 70): the counter saturates at 3; above hold_max every held field is
            # missing -> INVALID (FIELD_LOST). NO history reset: last_valid, memory, ring and latches all survive.
            st.hold_run = min(st.hold_run + 1, 3) if held else 0
            if st.hold_run > self.hold_max:
                missing = missing + held
                held = []
        else:  # legacy A6: the overflow resets the facility's history
            st.hold_run = st.hold_run + 1 if held else 0
            if st.hold_run > self.hold_max:
                st.reset_history()
                reason |= wire.R_RESET
                missing = missing + held
                held = []
        for n, ok in checks.items():
            if ok:
                st.last_valid[n] = raw[n]
        if held:
            reason |= wire.R_FIELD_HELD
        if missing:  # A6: nothing to hold -> INVALID, state other than last_valid untouched
            reason |= wire.R_FIELD_LOST
            for h in range(4):
                st.persist[h] = 0
            st.gap_run = 0
            return self._result(r, wire.ST_INVALID, reason, st), None, []
        v = {n: (raw[n] if checks[n] else st.last_valid[n]) for n in checks}
        status = wire.ST_HELD if reason & (wire.R_FIELD_HELD | wire.R_GAP_HELD) else wire.ST_VALID
        if not self.weights.version:
            reason |= wire.R_NO_MODEL

        # S2: channels
        s = self.s
        P0 = int(c["P0"])
        W = st.n_wells
        wells_on = sum(v[f"ws{i}"] == 1 for i in range(W))
        water = sum(v[f"ww{i}"] for i in range(W))
        level = v["level"]
        sat = False
        ch = []
        for raw_v, m in ((v["inflow"], int(c["M_inv_B"])), (v["pump_flow"], int(c["M_inv_Q"])),
                         (v["receive_flow"], int(c["M_inv_Q"])), (v["pump_flow"] - v["receive_flow"], int(c["M_inv_Q"])),
                         (level, self.m_level), (v["discharge"] - P0, self.m_dis), (v["pipeline"] - P0, self.m_pl)):
            x, o = mul_shift(raw_v, m, s)
            ch.append(x)
            sat |= o
        ch.append(16384 if v["pump_status"] == 1 else 0)
        ch.append(16384 if v["pump_status"] == 2 else 0)
        for raw_v, m in ((wells_on, int(c["M_inv_W"])), (water, int(c["M_inv_B"]))):
            x, o = mul_shift(raw_v, m, s)
            ch.append(x)
            sat |= o
        if st.prev_level is None:
            ch.append(0)
        else:
            x, o = mul_shift(level - st.prev_level, int(c["M_net"]), s)
            ch.append(x)
            sat |= o
        st.prev_level = level
        if v["pump_status"] != 1 and v["pump_flow"] > 0:
            reason |= wire.R_PUMP_INCONSISTENT
        if any(v[f"ws{i}"] == 0 and v[f"ww{i}"] > 0 for i in range(W)):
            reason |= wire.R_WELL_INCONSISTENT

        # S3: memory features (post-update, A4b)
        running = v["pump_status"] == 1
        if running:
            for k, src in enumerate(MEM_SRC):
                x8 = ch[src] << 8
                st.last[k] = ch[src]
                if not st.has_run:
                    st.ef[k] = st.es[k] = x8
                else:
                    st.ef[k] += (x8 - st.ef[k]) >> 3
                    st.es[k] += (x8 - st.es[k]) >> 6
            st.has_run = True
            st.n_off = 0
        else:
            st.n_off += 1
        x8 = ch[11] << 8
        st.e_net = x8 if st.e_net is None else st.e_net + ((x8 - st.e_net) >> 3)  # A5
        for e in st.ef + st.es + [st.e_net]:
            assert -(1 << 31) <= e < (1 << 31), "EMA register exceeds 32 bits"
        mem = (st.last + [e >> 8 for e in st.ef] + [e >> 8 for e in st.es]
               + [st.e_net >> 8, min(st.n_off, 64) << 8, 16384 if st.has_run else 0, min(st.since_reset, 64) << 8])
        feats = ch + mem
        assert len(feats) == N_FEATURES and all(-32768 <= x <= 32767 for x in feats)
        if sat:
            reason |= wire.R_SATURATED

        # S2: rules; S4: countdown
        rules = 0
        if v["pump_status"] == 2:
            rules |= wire.RULE_PUMP_FAULT
        if all(v[f"ws{i}"] == 0 and v[f"ww{i}"] == 0 for i in range(W)):
            rules |= wire.RULE_SHUT_IN
        if level >= int(c["shutdown_lvl"]):
            rules |= wire.RULE_AT_SHUTDOWN
        if level >= int(c["warning_lvl"]):
            rules |= wire.RULE_AT_WARNING
        net = v["inflow"] - v["pump_flow"] if self.countdown_variant == "plan_v1" else max(v["inflow"], 0)  # D1
        if st.ring is None:
            st.ring = [net] * (1 << self.cd_log2)  # A8: ring starts filled with the first value
        else:
            st.ring = st.ring[1:] + [net]
        cd, not_filling = self._countdown(c, level, st)
        if not_filling:
            rules |= wire.RULE_NOT_FILLING

        # S5: logistic heads
        wts = self.weights
        logits = [0, 0, 0, 0]
        if wts.version:
            for h in range(4):
                acc = sum(w * x for w, x in zip(wts.w[h], feats)) + wts.b[h]
                assert -(1 << (ACC_BITS - 1)) <= acc < (1 << (ACC_BITS - 1)), "48-bit accumulator overflow"
                logits[h] = sat16(round_shift(acc, wts.s_out))  # S_OUT = 0: no shift (FPGA #46)

        # S6: alarms (A10-A12, A19 / FPGA D8). Order per record: NS_RAISED, ES_RAISED, CLEARED(NS), CLEARED(ES).
        for h in range(4):
            st.persist[h] = st.persist[h] + 1 if logits[h] > self.logit_thr[h] else 0
        model_on = [st.persist[h] >= self.k[h] for h in range(4)]
        classes = sum(1 << h for h in range(4) if model_on[h])
        rule_on = rules & ALARM_RULES
        st.gap_run = st.gap_run + 1 if (ch[3] > self.gap_thr and logits[0] > self.logit_thr[0]) else 0
        ns_c = bool(rule_on) or any(model_on)
        es_c = st.gap_run >= self.k[0]
        model_src = wire.SRC_MODEL if any(model_on) else 0
        base = {"fac_id": fid, "ts_unix": ts, "result_no": self.result_no, "rules": rules, "classes": classes,
                "countdown_p10": cd[0]}
        alerts = []
        if ns_c and not st.ns_latch:
            alerts.append({**base, "kind": wire.A_NIGHT_SHIFT, "source": (wire.SRC_RULE if rule_on else 0) | model_src})
        if es_c and not st.es_latch:
            alerts.append({**base, "kind": wire.A_ESTOP, "source": wire.SRC_RULE | model_src | wire.SRC_LATCH_ESTOP})
        if st.ns_cond and not ns_c:
            alerts.append({**base, "kind": wire.A_CLEARED, "source": 0})
        if st.es_cond and not es_c:
            alerts.append({**base, "kind": wire.A_CLEARED, "source": wire.SRC_LATCH_ESTOP})
        st.ns_cond, st.es_cond = ns_c, es_c
        st.ns_latch |= ns_c  # cleared only by an acknowledge (BTN0 / CTRL.server_ack), never modelled
        st.es_latch |= es_c

        res = self._result(r, status, reason, st, logits, rules, cd)
        stages = {"values": v, "features": feats, "ns_cond": st.ns_cond, "es_cond": st.es_cond,
                  "ns_latch": st.ns_latch, "es_latch": st.es_latch, "classes": classes}
        st.since_reset += 1
        return res, stages, alerts


def run(records, global_config, facility_config, weights=None, countdown="review_r1r2", persist_k=None,
        hold_policy="C"):
    """Process records in order. Returns (results ndarray RESULT_DTYPE, list of stages, list of alerts)."""
    import numpy as np
    eng = Engine(global_config, facility_config, weights, countdown, persist_k, hold_policy)
    out = np.zeros(len(records), dtype=wire.RESULT_DTYPE)
    stages, alerts = [], []
    for i, r in enumerate(records):
        res, stg, al = eng.process(r)
        o = out[i]
        for k in ("fac_id", "status", "since_reset", "ts_unix", "reason", "rules", "weights_ver", "result_no"):
            o[k] = res[k]
        o["logits"] = res["logits"]
        o["countdown"] = res["countdown"]
        stages.append(stg)
        alerts.extend(al)
    return out, stages, alerts


def feature_matrix(stages):
    """int16 features (N x 31) for records that produced features; rows without features are all-zero + mask."""
    import numpy as np
    X = np.zeros((len(stages), N_FEATURES), dtype=np.int64)
    ok = np.zeros(len(stages), dtype=bool)
    for i, s in enumerate(stages):
        if s is not None:
            X[i] = s["features"]
            ok[i] = True
    return X, ok
