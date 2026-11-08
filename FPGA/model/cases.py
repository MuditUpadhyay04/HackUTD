"""Vector cases: practice-data cases (from the reference ingest) and synthetic bad-data cases.

A Case is a GLOBAL record, CONFIG rows, the weight image active at the start, and a list of steps:
  ("rec", record_int, last)        one 48 B DATA record as 6 beats (tlast on the 6th iff last)
  ("beats", [(data64, last), ...]) raw beats for eog_unpack (framing cases; such cases have no top_ vectors)
  ("touch", slot) | ("cfg", slot, row_int) | ("wts", image) | ("swap",) | ("ack",) | ("hb",) | ("hb_expire",)
Every event happens before the next record is accepted (see eog_ref.py).

Practice cases never read answer_key.json: failure windows are found from the telemetry (pump status rising to 2).
All randomness is seeded.
"""
import random

from eog_ref import N_WIMG, encode_weights
from ingest import Dataset, dataset_dir, encode_record, facility_row, global_record, metadata_bounds, present_all
from layouts import CFG, D, N_CLS, N_FEAT, P_PUMP_ST, P_WELL_ST, P_WELL_WATER

TS0 = 1791158400  # synthetic cases start here (any value works; this one is just a plausible epoch time)


class Case:
    def __init__(self, name, desc, glb, rows, wts, steps, top=True):
        self.name, self.desc, self.glb, self.rows, self.wts, self.steps, self.top = (
            name, desc, glb, rows, wts, steps, top)


# ------------------------------------------------------------------------------------------------ weights
def w_zero():
    """No model (VER = 0)."""
    return [0] * N_WIMG


def w_hand():
    """Hand-made set (VER 1, S_OUT 8) that fires each class on the practice data:
    0 leak: ema_f(flow gap) above 3 % of Q;  1 degradation: ema_f(pump flow / Q) below ~0.953 once the pump has run;
    2 failure: pump_fault channel;  3 shut-in: no active wells and no well water."""
    w = [[0] * N_FEAT for _ in range(N_CLS)]
    b = [0] * N_CLS
    w[0][19] = 256                      # FEAT 19 = ema_f of channel 3
    b[0] = -256 * 492
    w[1][17] = -256                     # FEAT 17 = ema_f of channel 1
    w[1][29] = 244                      # FEAT 29 = has_run (16384)
    b[1] = -256
    w[2][8] = 256                       # channel 8 pump_fault
    b[2] = -256 * 8192
    w[3][9] = -256                      # channel 9 wells_active_fraction
    w[3][10] = -256                     # channel 10 well_water_norm
    b[3] = 256 * 8192 - 256
    return encode_weights(w, b, 8, 1)


def w_random(seed, s_out=None, ver=None, wmax=32767):
    rng = random.Random(seed)
    w = [[rng.randint(-wmax - 1, wmax) for _ in range(N_FEAT)] for _ in range(N_CLS)]
    b = [rng.randint(-(1 << 31), (1 << 31) - 1) for _ in range(N_CLS)]
    return encode_weights(w, b, rng.randint(16, 22) if s_out is None else s_out,
                          rng.randint(2, 255) if ver is None else ver)


def w_const(wv, bv, s_out, ver):
    return encode_weights([[wv] * N_FEAT for _ in range(N_CLS)], [bv] * N_CLS, s_out, ver)


# ------------------------------------------------------------------------------------------------ practice
_DS = None


def practice():
    global _DS
    if _DS is None:
        _DS = Dataset(dataset_dir())
    return _DS


def _pump_st(rec):
    return D.get(rec, "PUMP_ST") if (D.get(rec, "PRESENT") >> P_PUMP_ST) & 1 else None


def fault_onsets(ds):
    """(record index, slot) where a facility's pump status changes to 2 (from the telemetry only)."""
    out, prev = [], {}
    for i, r in enumerate(ds.records):
        f = D.get(r, "FAC_ID")
        s = _pump_st(r)
        if s == 2 and prev.get(f) not in (2, None):
            out.append((i, f))
        prev[f] = s
    return out


def case_week():
    ds = practice()
    steps = [("hb",)]
    for i, r in enumerate(ds.records):
        if i and i % 2880 == 0:
            steps.append(("ack",))
        steps.append(("rec", r, True))
    return Case("week", "full practice week (history/full_week, %d records), hand-made weights, ack every 2880 "
                "records" % len(ds.records), ds.glb, ds.rows, w_hand(), steps)


def case_onsets(before=24, after=84):
    """Each facility's records from `before` steps ahead of every pump-fault onset to `after` steps past it."""
    ds = practice()
    nf = len(ds.facs)
    wins = []
    for i, f in fault_onsets(ds):
        t = i // nf
        lo, hi = max(0, t - before), min(len(ds.ts_list), t + after)
        if wins and wins[-1][0] == f and lo <= wins[-1][2]:
            wins[-1][2] = hi
        else:
            wins.append([f, lo, hi])
    steps = [("hb",)]
    for f, lo, hi in wins:
        for t in range(lo, hi):
            steps.append(("rec", ds.records[t * nf + f], True))
    return Case("onsets", "practice records of each facility around all %d pump-fault onsets (-%d..+%d steps): "
                "countdown R1, failure, shut-in, tripped tank; hand-made weights" % (len(fault_onsets(ds)), before,
                                                                                        after),
                ds.glb, ds.rows, w_hand(), steps)


def case_slice(n_steps=120):
    """All facilities over the n_steps window with the most pump-fault onsets; random weights, swaps mid-stream."""
    ds = practice()
    nf = len(ds.facs)
    on = [i // nf for i, _f in fault_onsets(ds)]
    best = max(range(0, len(ds.ts_list) - n_steps + 1, 6), key=lambda t0: sum(t0 <= t < t0 + n_steps for t in on))
    recs = ds.records[best * nf:(best + n_steps) * nf]
    steps = [("hb",)]
    for i, r in enumerate(recs):
        if i == len(recs) // 3:
            steps += [("wts", w_random(102)), ("swap",)]
        if i == 2 * len(recs) // 3:
            steps += [("wts", w_hand()), ("swap",), ("ack",)]
        steps.append(("rec", r, True))
    return Case("slice", "practice timesteps %d..%d (all facilities, the window with the most pump-fault onsets); "
                "random weight set A, swap to random set B at 1/3 and to the hand-made set at 2/3"
                % (best, best + n_steps - 1), ds.glb, ds.rows, w_random(101), steps)


# ------------------------------------------------------------------------------------------------ synthetic
class SimFac:
    """Tiny synthetic facility (raw DATA LSBs) for the bad-data cases."""

    def __init__(self, slot, B, Q, W, C, P0, rng, level_pct=50):
        self.slot, self.B, self.Q, self.W, self.C, self.P0, self.rng = slot, B, Q, W, C, P0, rng
        self.level = level_pct * 100
        self.running = False
        self.fault = False
        self.wells_on = True
        self.leak = 0.0

    def row(self, **kw):
        return facility_row(self.slot, self.B, self.Q, self.W, self.C, self.P0, 85, 92, **kw)

    def bounds(self):
        """Metadata LO/HI (present-bit order), WELL_LO/HI of this facility (A14)."""
        return metadata_bounds(self.B, self.Q, 3276.7, self.B / self.W)

    def step(self):
        """Advance 5 minutes; returns the field dict for encode_record (all fields present)."""
        r = self.rng
        if self.level >= 9200:
            self.wells_on = False
        water = [round(2 * self.B / self.W * (1 + r.uniform(-0.01, 0.01))) if self.wells_on else 0
                 for _ in range(self.W)]
        inflow = sum(water)
        if self.fault:
            self.running = False
        elif self.level >= 7000:
            self.running = True
        elif self.level <= 3000:
            self.running = False
        pf = round(2 * self.Q * (1 + r.uniform(-0.01, 0.01))) if self.running else 0
        rf = round(pf * (1 - self.leak - r.uniform(-0.005, 0.005))) if self.running else 0
        dlev = (inflow - pf) / 2 / 24 / 12 / self.C * 10000
        self.level = max(0, min(9200, round(self.level + dlev)))
        return dict(inflow=inflow, level=self.level, pump_flow=pf, recv_flow=rf,
                    dis=10 * self.P0 + (1500 if self.running else 0) + r.randint(-20, 20),
                    pipe=10 * self.P0 + (500 if self.running else 0) + r.randint(-20, 20),
                    pump_st=2 if self.fault else int(self.running),
                    well_st=[int(self.wells_on)] * self.W, well_water=water, present=present_all(self.W))


def rec(f, ts, d, **mut):
    """Encode a SimFac field dict with mutations: absent=[present bits], plus any encode_record field."""
    d = dict(d)
    absent = mut.pop("absent", ())
    d.update(mut)
    for b in absent:
        d["present"] &= ~(1 << b)
    return encode_record(f, ts, **d)


def _nets(rng):
    return {0: SimFac(0, 2400, 3600, 3, 1200, 1050, rng, 55), 1: SimFac(1, 500, 750, 1, 600, 950, rng, 40),
            2: SimFac(2, 4000, 6000, 8, 1000, 1100, rng, 65), 5: SimFac(5, 1500, 2250, 2, 800, 1000, rng, 72),
            31: SimFac(31, 3000, 4500, 4, 1200, 1000, rng, 35)}


def case_fields():
    """Absent fields, illegal enums, out of range (metadata and custom bounds incl. the pump-status bound), hold
    runs, INVALID, consistency flags, shut-in, level rules, reserved fields."""
    rng = random.Random(11)
    fs = _nets(rng)
    use = (0, 1, 2, 5)
    lo1, hi1, _wl, _wh = fs[1].bounds()
    lo5, hi5, _wl, _wh = fs[5].bounds()
    lo5 = lo5[:1] + (1000,) + lo5[2:]                        # level below 10 % out of range
    hi5 = hi5[:2] + (1,) + hi5[3:6] + (11000,)               # pump status <= 1 (2 out of range), pipeline <= 1100 psi
    rows = {0: fs[0].row(), 1: fs[1].row(hi=hi1[:1] + (9500,) + hi1[2:], well_hi=1000), 2: fs[2].row(),
            5: fs[5].row(lo=lo5, hi=hi5)}
    glb = global_record()
    W = P_WELL_WATER
    S = P_WELL_ST
    # step -> {slot: mutation}
    plan = {
        0: {2: dict(absent=[0], pump_st=0, pump_flow=100)},  # first record, inflow absent: INVALID, no PUMP_INCONS
        3: {0: dict(absent=[0])},                      # inflow absent once -> FIELD_HELD
        4: {5: dict(pump_st=2)}, 5: {0: dict(absent=[1]), 5: dict(pump_st=2)},  # pump status 2 > HI[2]: held
        6: {0: dict(absent=[1]), 5: dict(pump_st=2)},  # level held twice; slot 5: third -> reset, INVALID
        7: {5: dict(pipe=11001)}, 8: {0: dict(absent=[3]), 5: dict(pipe=11000)},  # pipeline bound (HI[6]) and edge
        9: {0: dict(absent=[3]), 5: dict(level=999)}, 10: {0: dict(absent=[3]), 5: dict(level=1000)},  # LO[1]
        11: {0: dict(absent=[4])},                     # after the hold-overflow reset: dis held from record 10
        13: {1: dict(pump_st=3)}, 14: {1: dict(pump_st=7)}, 15: {1: dict(pump_st=255)},  # illegal enum x3
        17: {2: dict(well_st=[1] * 7 + [2])}, 18: {2: dict(well_st=[3] + [1] * 7)},
        20: {1: dict(level=9501)}, 21: {0: dict(inflow=-361)}, 22: {0: dict(dis=-1), 1: dict(level=9500)},
        23: {1: dict(well_water=[1001]), 0: dict(inflow=-360)}, 24: {2: dict(well_water=[-51] + [1000] * 7)},
        25: {0: dict(level=10501), 2: dict(well_water=[-50] + [1000] * 7)}, 26: {0: dict(level=10500)},
        27: {0: dict(pump_st=0, pump_flow=100)},       # PUMP_INCONS
        28: {0: dict(well_st=[0, 1, 1], well_water=[500, 1600, 1600])},  # WELL_INCONS
        29: {2: dict(pump_st=2, pump_flow=0, recv_flow=0)},              # PUMP_FAULT rule
        31: {1: dict(present=0)},                      # everything absent -> all held (HELD)
        33: {0: dict(rsv0=1)}, 34: {1: dict(rsv1=0x80)}, 35: {2: dict(rsv2=0xDEADBEEF)},  # FRAMING
        36: {1: dict(well_st=[1, 3, 2, 1, 0, 0, 3, 3], well_water=[800, -5, 9999, -1, 0, 0, 0, 0])},  # >= n_wells
        38: {0: dict(absent=[0, 1, 2, 3, 4, 5, 6])},   # all facility fields held
        40: {2: dict(absent=[S + 3, W + 5, W + 7])},   # well fields held
        42: {0: dict(well_st=[0, 0, 0], well_water=[0, 0, 0])},   # SHUT_IN
        43: {0: dict(well_st=[0, 0, 0], well_water=[0, 0, 1])},   # not SHUT_IN (water 1), WELL_INCONS
        44: {0: dict(well_st=[0, 0, 0], well_water=[0, 0, 0], level=9200)},  # SHUT_IN + LVL_SHUTDOWN, CD = 0
        45: {0: dict(well_st=[0, 0, 0], well_water=[0, 0, 0], level=9300, absent=[S + 1])},  # SHUT_IN on held status
        46: {0: dict(level=8500)}, 47: {0: dict(level=8499)},     # warning edge (>=)
        48: {2: dict(absent=[1], level=0)}, 49: {2: dict(absent=[1])}, 50: {2: dict(absent=[1])},  # level lost
        52: {1: dict(pump_st=2, pump_flow=4)},         # fault with flow -> PUMP_INCONS + PUMP_FAULT
        54: {5: dict(present=0)}, 55: {5: dict(present=0)}, 56: {5: dict(present=0)},  # held, held, INVALID
        57: {5: dict(present=0)},                      # nothing to hold after the reset: INVALID again
        58: {5: dict(absent=[2])},                     # pump status missing (no history yet): INVALID
    }
    steps = [("hb",)]
    for t in range(60):
        for s in use:
            d = fs[s].step()
            steps.append(("rec", rec(s, TS0 + 300 * t, d, **plan.get(t, {}).get(s, {})), True))
    return Case("fields", "synthetic: absent/illegal/out-of-range fields (metadata bounds, custom LO/HI incl. the "
                "pump-status bound LO/HI[2]), hold runs and the overflow reset, INVALID (first record, after a "
                "reset), consistency flags, shut-in, level rules, reserved fields (FRAMING), well slots >= n_wells",
                glb, rows, w_hand(), steps)


def _time_steps():
    rng = random.Random(12)
    fs = _nets(rng)
    steps = [("hb",)]
    # (slot, delta from that slot's previous TS, mutation)
    seq = [(0, 0, {}), (1, 0, {}), (0, 300, {}), (1, 300, {}), (0, 600, {}), (1, 900, {}), (0, 900, {}),
           (1, 1200, {}), (0, 300, {}), (0, 0, {}), (0, -300, {}), (0, 300, {}), (1, 300, {}), (1, -1, {}),
           (1, 301, {}), (0, 600, dict(absent=[0])), (0, 600, dict(absent=[0])), (0, 300, dict(absent=[0])),
           (0, 300, {}), (1, 600, {}), (1, 600, {}), (1, 900, {}), (1, 300, dict(present=0)), (1, 0, {}),
           (1, 300, {}), (1, 0, {}), (0, 299, {}), (0, 300, {}), (0, 3600, {}), (0, 300, {}), (1, 300, {}),
           (0, 1 << 31, {}), (0, 300, {}), (0, -(1 << 31) - 300, {}), (1, 300, {}), (1, 600, dict(absent=[1])),
           (1, 300, dict(absent=[1])), (1, 900, dict(absent=[1])), (1, 300, {})]
    last = {0: TS0, 1: TS0 + 7}
    for s, dt, mut in seq:
        ts = last[s] = (last[s] + dt) & 0xFFFFFFFF
        steps.append(("rec", rec(s, ts, fs[s].step(), **mut), True))
    for t in range(20):  # a clean tail on both slots
        for s in (0, 1):
            last[s] = (last[s] + 300) & 0xFFFFFFFF
            steps.append(("rec", rec(s, last[s], fs[s].step()), True))
    return fs, steps


def case_time(hold):
    fs, steps = _time_steps()
    rows = {0: fs[0].row(), 1: fs[1].row()}
    return Case("time_h%d" % hold, "synthetic: step gaps of 1/2/3 missing steps, odd deltas, duplicates, out of "
                "order, unsigned wrap, gaps combined with field holds; GLOBAL HOLD_MAX=%d" % hold,
                global_record(HOLD_MAX=hold), rows, w_hand(), steps)


def _beats(r, last_at=None):
    """6 beats of a record; tlast on beat `last_at` (record cut there) or never (None) or 5 ('end')."""
    out = []
    for j in range(6):
        if last_at is not None and j > last_at:
            break
        out.append(((r >> (64 * j)) & ((1 << 64) - 1), last_at == j))
    return out


def case_framing():
    rng = random.Random(13)
    fs = _nets(rng)
    rows = {0: fs[0].row(), 1: fs[1].row()}
    beats = []
    t = 0

    def nxt(s):
        nonlocal t
        t += 1
        return rec(s, TS0 + 300 * (t // 2), fs[s].step())

    for n in (3, 1, 5):              # DMA-style packets: tlast only on the packet's last record
        for k in range(n):
            beats += _beats(nxt(k % 2), 5 if k == n - 1 else None)
    for cut in range(5):             # records cut short by tlast on beat 0..4
        beats += _beats(nxt(cut % 2), cut)
        beats += _beats(nxt((cut + 1) % 2), 5)
    beats += [(0, False)] * 6        # an all-zero record (slot 0, TS 0: out of order / framing-free)
    beats += _beats(nxt(0), 5)
    beats += [(0xFFFFFFFFFFFFFFFF, False)] * 5 + [(0xFFFFFFFFFFFFFFFF, True)]  # all ones: reserved != 0
    for k in range(10):
        beats += _beats(nxt(k % 2), 5 if k % 4 == 3 else None)
    beats += _beats(nxt(0), 5)
    return Case("framing", "synthetic beat stream for eog_unpack: tlast only at packet ends, records cut by tlast "
                "on beats 0-4, all-zero and all-ones records (no top_ vectors: the DATA window always sends 6 "
                "beats)", global_record(), rows, w_hand(), [("hb",), ("beats", beats)], top=False)


def case_slots():
    rng = random.Random(14)
    fs = _nets(rng)
    rows = {s: fs[s].row() for s in (0, 1, 2, 5, 31)}
    rows[7] = facility_row(7, 1000, 1500, 2, 600, 1000, 85, 92, enable=False)
    rows[8] = facility_row(8, 1000, 1500, 2, 600, 1000, 85, 92)
    sims8 = SimFac(8, 1000, 1500, 2, 600, 1000, rng)
    steps = [("hb",), ("touch", 2)]                  # touch before any record: nothing to clear, not flagged
    fs0b = SimFac(0, 1800, 2700, 2, 900, 1000, rng, 50)
    for t in range(40):
        ts = TS0 + 300 * t
        if t == 10:
            steps.append(("touch", 1))
        if t == 15:
            steps.append(("cfg", 0, fs0b.row()))       # slot 0 reconfigured: 2 wells, new constants
        if t == 20:
            steps.append(("cfg", 5, fs[5].row(enable=False)))  # slot 5 disabled
        if t == 26:
            steps.append(("cfg", 5, fs[5].row()))      # and re-enabled
        if t == 30:
            steps += [("touch", 31), ("touch", 2)]
        for s in (0, 1, 2, 5, 31):
            d = (fs0b if (s == 0 and t >= 15) else fs[s]).step()
            steps.append(("rec", rec(s, ts, d), True))
        if t % 5 == 0:
            d = fs[1].step()
            for fid in (7, 3, 32, 40, 0xFFFF, 0x20 + 31):
                steps.append(("rec", rec(fid, ts, d), True))
            steps.append(("rec", rec(8, ts, sims8.step()), True))
    return Case("slots", "synthetic: unknown ids (32, 40, 63, 0xFFFF), disabled and unconfigured slots, slot 31, "
                "CONFIG touch and row rewrite mid-stream (flagged HIST_RESET), touch before a slot's first record "
                "(not flagged), disable/re-enable a slot", global_record(), rows, w_hand(), steps)


def case_swap():
    rng = random.Random(15)
    fs = _nets(rng)
    rows = {s: fs[s].row() for s in (0, 1, 2)}
    steps = [("hb",)]
    images = {20: w_random(201), 40: w_random(202), 60: w_hand(), 80: w_random(203, s_out=0),
              100: w_random(204, s_out=31), 120: w_const(32767, (1 << 31) - 1, 0, 9),
              140: w_random(205, wmax=64, s_out=4)}
    t = 0
    for i in range(160):
        if i in images:
            steps += [("wts", images[i]), ("swap",)]
        if i == 70:
            steps += [("swap",), ("swap",)]             # back to back: hand -> random 202 -> hand
        if i == 150:
            steps += [("wts", w_zero()), ("swap",)]     # back to no model
        s = i % 3
        if s == 0:
            t += 1
        mut = {}
        if i % 17 in (5, 8, 11, 14):
            mut = dict(present=0)                       # same slot: HELD, HELD, INVALID (reset), INVALID
        if i % 23 == 7:
            mut = dict(rsv1=1)                          # DROPPED (FRAMING): WVER still the active VER
        steps.append(("rec", rec(s, TS0 + 300 * t, fs[s].step(), **mut), True))
    return Case("swap", "synthetic: no model at start (VER 0, logits 0), weight writes + swaps mid-stream (random "
                "sets, S_OUT 0 and 31, saturating set, back-to-back swaps, back to VER 0), HELD/INVALID/DROPPED "
                "records",
                global_record(), rows, w_zero(), steps)


def case_sat():
    """Saturation and arithmetic corners: extreme CONFIG multipliers and readings, countdown clamps, logits."""
    wide_lo, wide_hi = (-32768,) * 7, (32767,) * 7
    big = (1 << 32) - 1

    def row(slot, **kw):
        d = dict(FAC_ID=slot, N_WELLS=8, FLAGS=1, M_INV_B=big, M_INV_Q=big, M_INV_W=big, M_NET=big, P0=-32768,
                 SHUT_LVL=10000, WARN_LVL=0, K_CD=(1 << 24) - 1, LO=_arr(wide_lo), HI=_arr(wide_hi),
                 WELL_LO=0x8000, WELL_HI=0x7FFF)
        d.update(kw)
        return CFG.pack(d)

    rows = {0: row(0), 1: row(1, N_WELLS=12, M_INV_B=1, M_INV_Q=1 << 31, P0=32767, SHUT_LVL=0, K_CD=0),
            2: row(2, N_WELLS=0, M_INV_B=0, M_INV_Q=0, M_INV_W=0, M_NET=0, P0=0, SHUT_LVL=0xFFFF, WARN_LVL=0xFFFF),
            3: row(3, N_WELLS=1, M_NET=1 << 31, SHUT_LVL=32767 + 1, K_CD=(1 << 24) - 1)}
    vals = [32767, -32768, 0, 1, -1, 16384, -16384, 12345, -9876]
    rng = random.Random(16)
    steps = [("hb",)]
    p = present_all(8)
    for t in range(48):
        for s in (0, 1, 2, 3):
            v = [vals[(t + k * s + k) % len(vals)] for k in range(16)]
            if t % 6 == 5:
                v = [rng.randint(-32768, 32767) for _ in range(16)]
            pst = 1 if (t // 3 + s) % 3 else 0
            steps.append(("rec", encode_record(s, TS0 + 300 * t, inflow=v[0] if t % 4 else 1, level=v[1],
                                               pump_flow=v[2], recv_flow=v[3], dis=v[4], pipe=v[5], pump_st=pst,
                                               well_st=[(t >> k) & 1 for k in range(8)], well_water=v[6:14],
                                               present=p), True))
        if t == 16:
            steps += [("wts", w_const(-32768, -(1 << 31), 0, 3)), ("swap",)]
        if t == 32:
            steps += [("wts", w_random(301, s_out=1)), ("swap",)]
    return Case("sat", "synthetic: extreme CONFIG multipliers (2^32-1, 0, 2^31), N_WELLS 0/1/8/12, wide LO/HI, "
                "readings at +-32767/-32768 (every channel saturates), level jumps for channel 11, countdown with "
                "K_CD 2^24-1 / 0, SHUT_LVL 0 / 0xFFFF, signed inflow ring (mean <= 0, clamp to 0xFFFF), saturated "
                "logits (S_OUT 1, then 0 after a swap)",
                global_record(), rows, w_const(32767, (1 << 31) - 1, 1, 2), steps)


def _arr(vals):
    from layouts import arr_pack
    return arr_pack(vals)


def case_alarm():
    """Persistence, Night Shift / E-STOP latches, CLEARED, ACKED sweeps, autonomous source bit."""
    rng = random.Random(17)
    fs = _nets(rng)
    use = (0, 1, 2, 5)
    rows = {s: fs[s].row() for s in use}
    glb = global_record(PERSIST_K=2, PERSIST_K4=(0, 3, 1, 0), LOGIT_THR=(100, 0, -50, 200), GAP_THR=492)
    for s in use:
        fs[s].running = True
        fs[s].level = 6000
    steps = [("hb",)]
    for t in range(70):
        ts = TS0 + 300 * t
        fs[0].leak = 0.08 if 5 <= t < 20 or 50 <= t < 60 else 0.0   # leak -> model + E-STOP, then cleared
        fs[1].fault = 10 <= t < 30                                  # pump fault -> rule NS, model NS
        fs[5].leak = 0.05 if 8 <= t < 12 else 0.0                   # short leak (K=2)
        if t == 22:
            steps.append(("ack",))       # slot 0 cleared (latches drop), slot 1 still faulted (stays)
        if t == 35:
            steps.append(("hb_expire",))
        if t == 45:
            steps.append(("ack",))
        if t == 56:
            steps.append(("hb",))       # the leak raised at ~t=51 is reported with SOURCE bit 2 (autonomous)
        if t == 62:
            steps += [("ack",), ("ack",)]  # second ack finds nothing to clear
        for s in use:
            d = fs[s].step()
            mut = {}
            if s == 2 and t in (12, 13, 14):
                mut = dict(level=9000)                                  # LVL_WARNING -> NS
            if s == 1 and t == 25:
                mut = dict(present=0)                                   # INVALID: counters reset
            if s == 1 and t == 26:
                mut = dict(rsv0=5)                                      # DROPPED: nothing changes
            if s == 5 and t == 40:
                mut = dict(absent=[1])                                  # HELD record still counts
            steps.append(("rec", rec(s, ts, d, **mut), True))
    steps.append(("ack",))               # trailing ack after the last record
    return Case("alarm", "synthetic: PERSIST_K=2 with PERSIST_K4=(0,3,1,0) (K = 2,3,1,2), per-class thresholds "
                "(strict >), leak -> latched NS + E-STOP, CLEARED per latch type, ACKED sweeps over several slots, "
                "rule-only NS, INVALID resets counters, autonomous (hb_expire) source bit, trailing ack",
                glb, rows, w_hand(), steps)


def case_random(n=1500, seed=18):
    rng = random.Random(seed)
    fs = _nets(rng)
    slots = (0, 1, 2, 5, 31)
    rows = {s: fs[s].row() for s in slots}
    glb = global_record(HOLD_MAX=3, PERSIST_K=0, PERSIST_K4=(0, 2, 0, 5), LOGIT_THR=(-200, 300, 0, -1000),
                        GAP_THR=200, HB_TIMEOUT_MS=1)
    last = {s: TS0 + 11 * s for s in slots}
    steps = [("hb",)]
    i = 0
    while i < n:
        if rng.random() < 0.03:
            k = rng.choice(["touch", "cfg", "wts", "ack", "hb", "hb_expire"])
            s = rng.choice(slots)
            if k == "touch":
                steps.append(("touch", s))
            elif k == "cfg":
                f = SimFac(s, rng.randint(100, 9000), rng.randint(200, 12000), rng.randint(1, 8),
                           rng.randint(100, 2000), rng.randint(500, 3000), rng)
                steps.append(("cfg", s, f.row(well_hi=rng.choice([32767, 5000]))))
                fs[s] = f
            elif k == "wts":
                steps += [("wts", w_random(rng.randint(0, 1 << 30))), ("swap",)]
            else:
                steps.append((k,))
        s = rng.choice(slots + (rng.randint(0, 0xFFFF),) if rng.random() < 0.05 else slots)
        f = fs.get(s) or fs[0]
        d = f.step()
        if rng.random() < 0.05:
            f.fault = not f.fault
        if rng.random() < 0.05:
            f.leak = rng.choice([0, 0.05, 0.1])
        mut = {}
        x = rng.random()
        if x < 0.06:
            mut["absent"] = [rng.randrange(24) for _ in range(rng.randint(1, 3))]
        elif x < 0.08:
            mut["pump_st"] = rng.randint(0, 255)
        elif x < 0.10:
            mut["well_st"] = [rng.randint(0, 3) for _ in range(8)]
        elif x < 0.12:
            mut[rng.choice(["inflow", "level", "pump_flow", "recv_flow", "dis", "pipe"])] = rng.randint(-32768, 32767)
        elif x < 0.13:
            mut[rng.choice(["rsv0", "rsv1", "rsv2"])] = 1
        elif x < 0.14:
            mut["present"] = rng.getrandbits(32)
        dt = rng.choices([300, 600, 900, 1200, 0, -300, 301], [80, 6, 4, 2, 3, 3, 2])[0]
        key = s if s in last else 0
        last[key] = (last[key] + dt) & 0xFFFFFFFF
        steps.append(("rec", rec(s, last[key], d, **mut), rng.random() < 0.2))
        i += 1
    return Case("random", "synthetic fuzz (seed %d): %d records over 5 slots + random ids, random field faults, "
                "time deltas, IN_LAST, CONFIG rewrites, touches, weight swaps, acks, heartbeats; HOLD_MAX=3 (clamped "
                "to 2), PERSIST_K=0 with PERSIST_K4=(0,2,0,5) (K = 1,2,1,5)" % (seed, n), glb, rows, w_random(seed), steps)


def synthetic_cases():
    return [case_fields(), case_time(2), case_time(1), case_time(0), case_framing(), case_slots(), case_swap(),
            case_sat(), case_alarm(), case_random()]


def practice_cases():
    return [case_week(), case_onsets(), case_slice()]
