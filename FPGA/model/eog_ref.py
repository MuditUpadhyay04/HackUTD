"""Bit-exact reference model of the EOG engine (FPGA/spec, VERSION 4, FROZEN).

Integers only. Every stage is one Engine method that takes its input bus as an int and returns its output bus as an
int laid out per spec/gen/buses.py (unpack_beat, validate, features, memory, countdown, head, alarm, pack).

Spec v4: the normative integer reference is Mudit's ml/hutd_ml/features_int.py (branch ml, >= 8e67750, which has the
numerics.md §11 changes); check_mudit.py proves this model agrees with it byte for byte on every RESULT and ALERT.
Lucas's rulings on spec questions 20-25 (FPGA/TASKS.md, Sun 01:17) override the numerics.md v4 text where they
differ: ring of max(INFLOW, 0) (#20), NOT_FILLING = 0 at/above shutdown (#21), ALERT SOURCE per kind (#22), reason
bits 11/13/14 restored (#23), HIST_RESET on a facility's first record (#24), DROPPED RESULTs carry SINCE_RESET 0 and
WVER 0 (#25). Spec question #70 (R7 option C, Lucas Sun 02:03) replaces numerics.md §3 step 5: a hold run above
HOLD_MAX makes the record INVALID (FIELD_LOST) with no history reset; Mudit's code gets it in his task T0.5, and
check_mudit.py reports the difference as the pre-T0.5 gap until then. Other open readings follow the lead's answers
(cited as TASKS #n) or Mudit's code; the few the model still had to decide itself are marked `MODEL-Q<n>` and listed
in model/README.md.

Abstractions (the model has no clock):
- `autonomous` = HB_TIMEOUT_MS != 0 and no "fresh" heartbeat: ms_since_hb is 65535 after reset, `heartbeat()`
  makes it fresh, `hb_expire()` (the bench waits HB_TIMEOUT_MS without heartbeats) makes it stale again.
- The ALERT FIFO is never full (al_full = 0).
- Events (touch, row write, weight write, swap, ack, heartbeat) happen between records: after the previous record
  has been accepted and before the next one is (a test bench drains the pipeline first where it matters).
"""
from layouts import (AK, BA, BC, BF, BL, BM, BU, BV, CD_LOG2, CD_N, CD_NONE, CD_SCALE, CFG, D, EMA_FAST, EMA_SLOW,
                     FEAT_SHIFT, G, K_DIS, K_LEVEL, K_PIPE, N_CLS, N_FAC, N_FEAT, N_WELL, ONE, R, RES, RULE, AL,
                     ST_DROPPED, ST_HELD, ST_INVALID, ST_VALID, LH_PUMP_ST, P_DIS, P_INFLOW, P_LEVEL, P_PIPE,
                     P_PUMP_FLOW, P_PUMP_ST, P_RECV, P_WELL_ST, P_WELL_WATER, SPEC_VERSION, WIN_WORDS, arr_get,
                     arr_pack, arr_unpack)

HDR = ("REC_NO", "IN_LAST", "FAC_RAW", "FAC", "TS", "STATUS", "REASON", "SINCE_RESET", "HIST_RESET")
GATED = (1, 2, 3, 5, 6)  # numerics.md §5 gated channels
N_WIMG = WIN_WORDS       # weight window words (numerics.md §8, D11): 70 words = blob bytes 0..279, word 70 = VER
BLOB_BYTES = 4 * (N_WIMG - 1)
STEP_S = 300
GOOD = (ST_VALID, ST_HELD)


def sat16(x):
    return -32768 if x < -32768 else 32767 if x > 32767 else x


def bit(v, i):
    return (v >> i) & 1


def feat(x, m):
    """numerics.md §4: sat16((x*M + 2^(S-1)) >>> S). Returns (value, saturated)."""
    y = (x * m + (1 << (FEAT_SHIFT - 1))) >> FEAT_SHIFT  # Python >> floors (arithmetic shift)
    return sat16(y), not (-32768 <= y <= 32767)


def cd_minutes(k_dl, q):
    """numerics.md §7 m(q) with k_dl = K * delta: q <= 0 -> 0xFFFF, else min((K*delta) // (q << 8), 0xFFFF)."""
    return CD_NONE if q <= 0 else min(k_dl // (q << CD_SCALE), CD_NONE)


def hdr_of(lay, v):
    return {n: lay.get(v, n) for n in HDR}


# Facility fields in DATA PRESENT-bit order = CONFIG LO/HI index (numerics.md §2): (present bit, DATA field).
FAC_FIELDS = ((P_INFLOW, "INFLOW"), (P_LEVEL, "LEVEL"), (P_PUMP_ST, "PUMP_ST"), (P_PUMP_FLOW, "PUMP_FLOW"),
              (P_DIS, "DIS_PSI"), (P_RECV, "RECV_FLOW"), (P_PIPE, "PIPE_PSI"))


class _VSlot:
    """eog_validate per-facility state (features_int._Fac, validation part)."""

    def __init__(self):
        self.has_ts = False   # last_ts exists: cleared by reset and by a CONFIG write (fac_touch)
        self.last_ts = 0
        self.reset_history()

    def reset_history(self):
        self.last = {}        # field key -> last valid raw value
        self.hold_run = 0
        self.since = 0
        self.prev_level = None


class _MSlot:
    def __init__(self):
        self.last_run = [0] * 5
        self.ema_f = [0] * 5
        self.ema_s = [0] * 5
        self.net_ema = 0
        self.has_net = False
        self.nsr = 0
        self.has_run = False


class _ASlot:
    def __init__(self):
        self.cnt = [0] * N_CLS
        self.leak = 0


# ---------------------------------------------------------------- weight window (D11: Mudit's blob layout)
def _s(x, w):
    return x - (1 << w) if x >> (w - 1) else x


def window_blob(img):
    """The 280 blob bytes held in words 0..69."""
    return b"".join((img[i] & 0xFFFFFFFF).to_bytes(4, "little") for i in range(N_WIMG - 1))


def decode_weights(img):
    """71-word window -> (W[4][31] s16, B[4] s32, S_OUT u8, VER u8)."""
    assert len(img) == N_WIMG
    blob = window_blob(img)
    w = [[_s(int.from_bytes(blob[8 + 2 * (N_FEAT * k + i):10 + 2 * (N_FEAT * k + i)], "little"), 16)
          for i in range(N_FEAT)] for k in range(N_CLS)]
    b = [_s(int.from_bytes(blob[256 + 4 * k:260 + 4 * k], "little"), 32) for k in range(N_CLS)]
    return w, b, blob[4], img[N_WIMG - 1] & 0xFF


def window_from_blob(blob, ver):
    """Mudit's weight blob (bytes 0..279 used) + version -> 71-word window."""
    blob = bytes(blob[:BLOB_BYTES])
    assert len(blob) == BLOB_BYTES
    return [int.from_bytes(blob[4 * i:4 * i + 4], "little") for i in range(N_WIMG - 1)] + [ver & 0xFF]


def encode_blob(w, b, s_out, mhash=0):
    """model_int.pack_blob without self-test vectors: header (format 1, 4 heads, 31 features, S_OUT, 0 vectors,
    feature set 1), W[4][31] s16, B[4] s32, model hash, reserved. 280 bytes."""
    out = bytearray((1).to_bytes(2, "little") + bytes((N_CLS, N_FEAT, s_out & 0xFF, 0)) + (1).to_bytes(2, "little"))
    for k in range(N_CLS):
        for i in range(N_FEAT):
            out += (w[k][i] & 0xFFFF).to_bytes(2, "little")
    for k in range(N_CLS):
        out += (b[k] & 0xFFFFFFFF).to_bytes(4, "little")
    out += (mhash & 0xFFFFFFFF).to_bytes(4, "little") + bytes(4)
    assert len(out) == BLOB_BYTES
    return bytes(out)


def encode_weights(w, b, s_out, ver):
    """W[4][31] (s16), B[4] (s32), S_OUT, VER -> 71-word window."""
    return window_from_blob(encode_blob(w, b, s_out), ver)


def as_int(x, nbytes):
    if isinstance(x, (bytes, bytearray)):
        assert len(x) == nbytes, (len(x), nbytes)
        return int.from_bytes(x, "little")
    return x


def persist_k(glb):
    """numerics.md §9 (D10): K[k] = PERSIST_K4[k] if nonzero, else max(PERSIST_K, 1)."""
    k4 = arr_unpack(G.get(glb, "PERSIST_K4"), N_CLS, 8, signed=False)
    return [k4[k] if k4[k] else max(G.get(glb, "PERSIST_K"), 1) for k in range(N_CLS)]


class Engine:
    def __init__(self, n_fac=N_FAC, batch=45, trace=False):
        self.n_fac = n_fac
        self.batch = batch
        self.glb = 0
        self.rows = [0] * 32
        self.banks = [[0] * N_WIMG, [0] * N_WIMG]  # word 70 = 0 after hard reset (no model)
        self.active = 0
        self.dbg_fac = 0
        self._dec_key = self._dec = None
        self.trace = trace
        self.mul_feat_log, self.mul_head_log, self.div_log = [], [], []
        self.reset()

    # ---------------------------------------------------------------- control
    def reset(self):
        """Hard or soft reset: per-facility state, latches and counters; not CONFIG, GLOBAL or weight banks."""
        self.rec_no = 0
        self.beat = 0
        self.buf = 0
        self.vst = [_VSlot() for _ in range(32)]
        self.mst = [_MSlot() for _ in range(32)]
        self.ring = [None] * 32
        self.ast = [_ASlot() for _ in range(32)]
        self.ns_latch = self.es_latch = self.ns_cond = self.es_cond = 0
        self.batch_cnt = 0
        self.hb_fresh = False  # ms_since_hb = 65535 after reset
        self.dbg = None        # last D12 capture: (FEAT[31], LOGITS[4], REC_NO, count)
        self.dbg_count = 0

    def configure(self, glb, rows):
        """GLOBAL (32 B or int) and CONFIG rows {slot: 64 B or int}. Every written slot is touched."""
        self.set_glb(glb)
        for f, row in rows.items():
            self.write_row(f, row)

    def set_glb(self, glb):
        """eog_regs: byte 0 (S) always reads 17 and byte 2 (CD_LOG2) 4."""
        self.glb = G.put(G.put(as_int(glb, 32), "S", FEAT_SHIFT), "CD_LOG2", CD_LOG2)

    def write_row(self, f, row):
        self.rows[f] = CFG.put(as_int(row, 64), "FAC_ID", f)  # FAC_ID reads back as the slot
        self.touch(f)

    def touch(self, f):
        """fac_touch[f]: the slot's next non-DROPPED record is a first record again: a flagged history reset
        (TASKS #24: a facility's first record, no last_ts, gets HIST_RESET = 1, after power-up too)."""
        self.vst[f].has_ts = False

    def load_weights(self, image):
        """Write a 71-word window into the inactive bank."""
        assert len(image) == N_WIMG
        self.banks[1 - self.active] = [x & 0xFFFFFFFF for x in image]

    def swap(self):
        self.active ^= 1

    def _decoded(self):
        key = tuple(self.banks[self.active])
        if self._dec_key != key:
            self._dec_key, self._dec = key, decode_weights(self.banks[self.active])
        return self._dec

    def active_ver(self):
        return self.banks[self.active][N_WIMG - 1] & 0xFF

    @property
    def autonomous(self):
        """numerics.md §9: HB_TIMEOUT_MS != 0 and ms_since_hb >= HB_TIMEOUT_MS."""
        return G.get(self.glb, "HB_TIMEOUT_MS") != 0 and not self.hb_fresh

    def heartbeat(self):
        """hb_pulse: ms_since_hb = 0 (the bench never lets HB_TIMEOUT_MS elapse without an hb_expire event)."""
        self.hb_fresh = True

    def hb_expire(self):
        """The bench idles until ms_since_hb >= HB_TIMEOUT_MS."""
        self.hb_fresh = False

    def ack(self):
        """Acknowledge (BTN0 or CTRL.server_ack): latch &= cond, then one ACKED ALERT per cleared bit.
        Sweep order: lowest slot first, NS (type 0) before ES (type 1) within a slot; ACKED RULES, CLASSES and
        SOURCE bits other than bit 4 are 0 (TASKS #3, #4)."""
        cl_ns = self.ns_latch & ~self.ns_cond
        cl_es = self.es_latch & ~self.es_cond
        self.ns_latch &= self.ns_cond
        self.es_latch &= self.es_cond
        out = []
        for f in range(32):
            for typ, cl in ((0, cl_ns), (1, cl_es)):
                if bit(cl, f):
                    out.append(AL.pack(dict(FAC_ID=f, KIND=AK["ACKED"], SOURCE=typ << 4, TS=0, RESULT_NO=0,
                                            RULES=0, CLASSES=0, CD_P10=CD_NONE)))
        return out

    # ---------------------------------------------------------------- stages
    def unpack_beat(self, data, last):
        """eog_unpack: one 64-bit beat. Returns bus U when a record is emitted, else None."""
        self.buf |= (data & ((1 << 64) - 1)) << (64 * self.beat)
        self.beat += 1
        if self.beat < 6 and not last:
            return None
        u = BU.pack(dict(REC_NO=self.rec_no, IN_LAST=int(bool(last)), FRAME_ERR=int(self.beat < 6), REC=self.buf))
        self.rec_no = (self.rec_no + 1) & 0xFFFFFFFF
        self.beat = 0
        self.buf = 0
        return u

    def validate(self, u):
        """eog_validate, numerics.md §3 (= features_int.Engine.process S1 with the §11 changes)."""
        r = BU.get(u, "REC")
        fac_raw = D.get(r, "FAC_ID")
        fac = fac_raw & 0x1F
        ts = D.get(r, "TS")
        out = dict(REC_NO=BU.get(u, "REC_NO"), IN_LAST=BU.get(u, "IN_LAST"), FAC_RAW=fac_raw, FAC=fac, TS=ts)

        def dropped(reason):  # every DROPPED record: SINCE_RESET = 0, no state change (TASKS #25)
            out.update(STATUS=ST_DROPPED, REASON=1 << R[reason], SINCE_RESET=0)
            return BV.pack(out)

        # 1 framing (D9): before the facility lookup, no state change
        if BU.get(u, "FRAME_ERR") or D.get(r, "RSV0") or D.get(r, "RSV1") or D.get(r, "RSV2"):
            return dropped("FRAMING")
        # 2 facility
        row = self.rows[fac]
        if fac_raw >= self.n_fac or not (CFG.get(row, "FLAGS") & 1):
            return dropped("UNKNOWN_FAC")
        st = self.vst[fac]
        hold = min(G.get(self.glb, "HOLD_MAX"), 2)
        reason = 0
        hist = False
        # 3 time: d is the exact difference of two u32 (MODEL-Q7, as features_int: no 32-bit wrap)
        if not st.has_ts:  # first record after reset or a CONFIG write: a new history, flagged (TASKS #24)
            st.reset_history()
            hist = True
        else:
            d = ts - st.last_ts
            if d == 0:
                return dropped("DUPLICATE")
            if d < STEP_S:
                return dropped("OUT_OF_ORDER")
            missing = d // STEP_S - 1 if d % STEP_S == 0 else hold + 1
            if 1 <= missing <= hold:
                reason |= 1 << R["GAP_HELD"]
            elif missing > hold:
                st.reset_history()
                hist = True
        st.has_ts = True
        st.last_ts = ts
        # 4 fields: (key, present bit, raw value, check) -> ok
        present = D.get(r, "PRESENT")
        lo = [arr_get(row, CFG, "LO", j) for j in range(7)]
        hi = [arr_get(row, CFG, "HI", j) for j in range(7)]
        wlo = CFG.get(row, "WELL_LO", signed=True)
        whi = CFG.get(row, "WELL_HI", signed=True)
        n_wells = min(CFG.get(row, "N_WELLS"), N_WELL)  # TASKS #14
        raw, ok = {}, {}
        for j, name in FAC_FIELDS:
            v = D.get(r, name) if j == P_PUMP_ST else D.get(r, name, signed=True)
            good = bool(bit(present, j))
            if not good:
                reason |= 1 << R["FIELD_ABSENT"]
            elif j == LH_PUMP_ST and v not in (0, 1, 2):
                good = False
                reason |= 1 << R["ILLEGAL_ENUM"]
            elif not lo[j] <= v <= hi[j]:
                good = False
                reason |= 1 << R["OUT_OF_RANGE"]
            raw[name], ok[name] = v, good
        wst = D.get(r, "WELL_ST")
        for i in range(n_wells):
            s = (wst >> (2 * i)) & 3
            good = bool(bit(present, P_WELL_ST + i))
            if not good:
                reason |= 1 << R["FIELD_ABSENT"]
            elif s not in (0, 1):
                good = False
                reason |= 1 << R["ILLEGAL_ENUM"]
            raw[("WST", i)], ok[("WST", i)] = s, good
            v = arr_get(r, D, "WELL_WATER", i)
            good = bool(bit(present, P_WELL_WATER + i))
            if not good:
                reason |= 1 << R["FIELD_ABSENT"]
            elif not wlo <= v <= whi:
                good = False
                reason |= 1 << R["OUT_OF_RANGE"]
            raw[("WW", i)], ok[("WW", i)] = v, good
        held = [k for k in ok if not ok[k] and k in st.last]
        missing = [k for k in ok if not ok[k] and k not in st.last]
        # 5 hold run (TASKS #70, R7 option C): capped at 3; above `hold` every held field becomes missing, so the
        # record is INVALID (FIELD_LOST). No history reset, no HIST_RESET; last_valid is kept.
        st.hold_run = min(st.hold_run + 1, 3) if held else 0
        if st.hold_run > hold:
            missing += held
            held = []
        # 6 last_valid (also on records that end up INVALID)
        for k in ok:
            if ok[k]:
                st.last[k] = raw[k]
        if held:
            reason |= 1 << R["FIELD_HELD"]
        if hist:
            reason |= 1 << R["HIST_RESET"]
        prev_ok = int(st.prev_level is not None)
        prev_level = st.prev_level if prev_ok else 0  # TASKS #13
        since = min(st.since, 255)
        if missing:
            # 7 INVALID (FIELD_LOST): values = the OK value where available, else 0 (eog_validate.md, MODEL-Q9);
            # no other state update
            status = ST_INVALID
            reason |= 1 << R["FIELD_LOST"]
            vals = {k: (raw[k] if ok[k] else 0) for k in ok}
            usable = ok
        else:
            # 8 VALID/HELD: OK value or last_valid
            status = ST_HELD if reason & ((1 << R["FIELD_HELD"]) | (1 << R["GAP_HELD"])) else ST_VALID
            vals = {k: (raw[k] if ok[k] else st.last[k]) for k in ok}
            usable = {k: True for k in ok}
            # 9 consistency flags (reason only), on the carried values
            if vals["PUMP_ST"] != 1 and vals["PUMP_FLOW"] > 0:
                reason |= 1 << R["PUMP_INCONS"]
            if any(vals[("WST", i)] == 0 and vals[("WW", i)] > 0 for i in range(n_wells)):
                reason |= 1 << R["WELL_INCONS"]
            # 10 since_reset increments after a VALID/HELD record; prev_level
            st.since = min(st.since + 1, 255)
            st.prev_level = vals["LEVEL"]
        well_act = sum(int(vals[("WST", i)] == 1) << i for i in range(n_wells))
        water = [vals[("WW", i)] if i < n_wells else 0 for i in range(N_WELL)]
        fld_ok = sum(int(usable[name]) << j for j, name in FAC_FIELDS)
        wells_ok = int(all(usable[("WST", i)] and usable[("WW", i)] for i in range(n_wells)))
        out.update(STATUS=status, REASON=reason, SINCE_RESET=since, HIST_RESET=int(hist),
                   INFLOW=vals["INFLOW"], LEVEL=vals["LEVEL"], PUMP_FLOW=vals["PUMP_FLOW"],
                   RECV_FLOW=vals["RECV_FLOW"], DIS_PSI=vals["DIS_PSI"], PIPE_PSI=vals["PIPE_PSI"],
                   PUMP_ST=vals["PUMP_ST"], WELL_ACT=well_act, WELL_WATER=arr_pack(water), FLD_OK=fld_ok,
                   WELLS_OK=wells_ok, PREV_LEVEL=prev_level, PREV_OK=prev_ok)
        return BV.pack(out)

    def _fmul(self, x, m):
        if self.trace:
            self.mul_feat_log.append((x, m))
        return feat(x, m)

    def features(self, v):
        """eog_features, numerics.md §4. Only VALID/HELD records get channels and rules."""
        h = hdr_of(BV, v)
        status = h["STATUS"]
        row = self.rows[h["FAC"]]
        g = lambda n: BV.get(v, n, signed=True)  # noqa: E731
        inflow, level = g("INFLOW"), g("LEVEL")
        pst = BV.get(v, "PUMP_ST")
        ch = [0] * 12
        rules = 0
        run = 0
        if status in GOOD:
            well_act = BV.get(v, "WELL_ACT")
            water = arr_unpack(BV.get(v, "WELL_WATER"), N_WELL)  # 0 for slots >= n_wells
            if pst == 2:
                rules |= 1 << RULE["PUMP_FAULT"]
            if well_act == 0 and not any(water):  # every configured slot: status 0 and water exactly 0
                rules |= 1 << RULE["SHUT_IN"]
            if level >= CFG.get(row, "SHUT_LVL"):
                rules |= 1 << RULE["LVL_SHUTDOWN"]
            if level >= CFG.get(row, "WARN_LVL"):
                rules |= 1 << RULE["LVL_WARNING"]
            mb, mq, mw, mn = (CFG.get(row, n) for n in ("M_INV_B", "M_INV_Q", "M_INV_W", "M_NET"))
            p0 = CFG.get(row, "P0", signed=True)
            pf, rf = g("PUMP_FLOW"), g("RECV_FLOW")
            sat = False
            for c, (x, m) in enumerate(((inflow, mb), (pf, mq), (rf, mq), (pf - rf, mq), (level, K_LEVEL),
                                        (g("DIS_PSI") - p0, K_DIS), (g("PIPE_PSI") - p0, K_PIPE))):
                ch[c], s = self._fmul(x, m)
                sat |= s
            ch[7] = ONE if pst == 1 else 0
            ch[8] = ONE if pst == 2 else 0
            ch[9], s = self._fmul(bin(well_act).count("1"), mw)
            sat |= s
            ch[10], s = self._fmul(sum(water), mb)
            sat |= s
            if BV.get(v, "PREV_OK"):
                ch[11], s = self._fmul(level - g("PREV_LEVEL"), mn)
                sat |= s
            if sat:
                h["REASON"] |= 1 << R["FEAT_SAT"]
            run = int(pst == 1)
        h.update(FEAT0_11=arr_pack(ch), RULES4=rules, INFLOW=inflow, LEVEL=level, PUMP_RUN=run)
        return BF.pack(h)

    def memory(self, fb):
        """eog_memory, numerics.md §5."""
        h = hdr_of(BF, fb)
        status = h["STATUS"]
        f = h["FAC"]
        ch = arr_unpack(BF.get(fb, "FEAT0_11"), 12)
        mem = [0] * 19
        if status != ST_DROPPED and h["HIST_RESET"] and f < self.n_fac:
            self.mst[f] = _MSlot()  # history reset clears first, even on INVALID
        if status in GOOD and f < self.n_fac:  # FAC >= N_FAC: no state (TASKS #1)
            s = self.mst[f]
            if BF.get(fb, "PUMP_RUN"):
                for i, c in enumerate(GATED):
                    x = ch[c] << 8
                    if not s.has_run:
                        s.ema_f[i] = s.ema_s[i] = x
                    else:
                        s.ema_f[i] += (x - s.ema_f[i]) >> EMA_FAST
                        s.ema_s[i] += (x - s.ema_s[i]) >> EMA_SLOW
                    s.last_run[i] = ch[c]
                s.has_run = True
                s.nsr = 0
            else:
                s.nsr = min(s.nsr + 1, 255)
            x = ch[11] << 8
            s.net_ema = s.net_ema + ((x - s.net_ema) >> EMA_FAST) if s.has_net else x
            s.has_net = True
            mem = (s.last_run + [e >> 8 for e in s.ema_f] + [e >> 8 for e in s.ema_s]
                   + [s.net_ema >> 8, min(s.nsr, 64) << 8, ONE if s.has_run else 0, min(h["SINCE_RESET"], 64) << 8])
            assert all(-32768 <= x <= 32767 for x in mem), mem  # numerics.md §5: fits int16 by construction
        else:
            ch = [0] * 12
        h.update(FEAT=arr_pack(ch + mem), RULES4=BF.get(fb, "RULES4"), INFLOW=BF.get(fb, "INFLOW"),
                 LEVEL=BF.get(fb, "LEVEL"))
        return BM.pack(h)

    def _cd(self, k_dl, q):
        if self.trace and q > 0:
            self.div_log.append((k_dl, q << CD_SCALE))
        return cd_minutes(k_dl, q)

    def countdown(self, m):
        """eog_countdown, numerics.md §7 (D1, D2, D6) with TASKS #20, #21: prefilled 16-entry ring of max(INFLOW, 0),
        mean = sum >>> 4; level >= shutdown -> 0/0/0 and NOT_FILLING = 0."""
        h = hdr_of(BM, m)
        status = h["STATUS"]
        f = h["FAC"]
        p10 = p50 = p90 = CD_NONE
        nf = 0
        if status != ST_DROPPED and h["HIST_RESET"] and f < self.n_fac:
            self.ring[f] = None
        if status in GOOD and f < self.n_fac:  # FAC >= N_FAC: no state (TASKS #1)
            row = self.rows[f]
            x = max(BM.get(m, "INFLOW", signed=True), 0)
            ring = self.ring[f] = [x] * CD_N if self.ring[f] is None else self.ring[f][1:] + [x]
            mean = sum(ring) >> CD_LOG2
            level = BM.get(m, "LEVEL", signed=True)
            shut = CFG.get(row, "SHUT_LVL")
            if level >= shut:
                p10 = p50 = p90 = 0
            else:
                nf = int(mean <= 0)
                k_dl = CFG.get(row, "K_CD") * (shut - level)
                p10, p50, p90 = self._cd(k_dl, max(ring)), self._cd(k_dl, mean), self._cd(k_dl, min(ring))
        h.update(FEAT=BM.get(m, "FEAT"), RULES=BM.get(m, "RULES4") | (nf << RULE["NOT_FILLING"]),
                 CD=p10 | (p50 << 16) | (p90 << 32))
        return BC.pack(h)

    def head(self, c):
        """eog_head, numerics.md §8. Uses the bank active when the record is accepted."""
        h = hdr_of(BC, c)
        status = h["STATUS"]
        w, b, s_out, ver = self._decoded()
        x = arr_unpack(BC.get(c, "FEAT"), N_FEAT)
        logits = [0] * N_CLS
        if status in GOOD and ver == 0:
            h["REASON"] |= 1 << R["NO_MODEL"]  # TASKS #23
        if status in GOOD and ver != 0:
            for k in range(N_CLS):
                acc = b[k]
                for i in range(N_FEAT):
                    if self.trace:
                        self.mul_head_log.append((w[k][i], x[i]))
                    acc += w[k][i] * x[i]
                assert -(1 << 47) <= acc < (1 << 47)
                rnd = (1 << (s_out - 1)) if s_out > 0 else 0
                logits[k] = sat16((acc + rnd) >> s_out)
        if status in GOOD and h["FAC"] == self.dbg_fac:  # D12 debug capture
            self.dbg_count = (self.dbg_count + 1) & 0xFFFFFFFF
            self.dbg = (x, logits, h["REC_NO"], self.dbg_count)
        # WVER = the active VER at accept; 0 for DROPPED (TASKS #25); INVALID carries the active VER (features_int)
        h.update(CH3=x[3] & 0xFFFF, RULES=BC.get(c, "RULES"), CD=BC.get(c, "CD"), LOGITS=arr_pack(logits),
                 WVER=0 if status == ST_DROPPED else ver)
        return BL.pack(h)

    def alarm(self, lb):
        """eog_alarm, numerics.md §9 (D8 latched Night Shift and E-STOP, D10 per-class K).
        Returns (bus A, [ALERT ints])."""
        h = hdr_of(BL, lb)
        status = h["STATUS"]
        f = h["FAC"]
        rules = BL.get(lb, "RULES")
        cd = BL.get(lb, "CD")
        logits = arr_unpack(BL.get(lb, "LOGITS"), N_CLS)
        ch3 = BL.get(lb, "CH3", signed=True)
        alerts = []
        ca = 0
        if status in (ST_VALID, ST_HELD, ST_INVALID) and f < self.n_fac:  # codes 2, 5-7, DROPPED: no change
            s = self.ast[f]
            if h["HIST_RESET"] or status == ST_INVALID:
                s.cnt = [0] * N_CLS
                s.leak = 0
            if status in GOOD:
                K = persist_k(self.glb)
                thr = [arr_get(self.glb, G, "LOGIT_THR", k) for k in range(N_CLS)]
                hit = [logits[k] > thr[k] for k in range(N_CLS)]
                s.cnt = [min(s.cnt[k] + 1, 255) if hit[k] else 0 for k in range(N_CLS)]
                leak_hit = ch3 > G.get(self.glb, "GAP_THR", signed=True) and hit[0]
                s.leak = min(s.leak + 1, 255) if leak_hit else 0
                ca = sum(int(s.cnt[k] >= K[k]) << k for k in range(N_CLS))
                es_c = int(s.leak >= K[0])
                ns_c = int((rules & 0xF) != 0 or ca != 0)
                auto = int(self.autonomous) << 2
                model = int(ca != 0) << 1
                # SOURCE per kind (TASKS #22): bit 0 rule (E-STOP: the gap rule, always 1), bit 1 any class active,
                # bit 2 autonomous at accept, bit 4 latch type; CLEARED carries only bits 2 and 4
                src = {("NS_RAISED", 0): int((rules & 0xF) != 0) | model | auto, ("ES_RAISED", 1): 1 | model | auto,
                       ("CLEARED", 0): auto, ("CLEARED", 1): auto}
                old_nl, old_el = bit(self.ns_latch, f), bit(self.es_latch, f)
                old_nc, old_ec = bit(self.ns_cond, f), bit(self.es_cond, f)
                m = 1 << f
                self.ns_cond = (self.ns_cond & ~m) | (m * ns_c)
                self.es_cond = (self.es_cond & ~m) | (m * es_c)
                self.ns_latch |= m * ns_c
                self.es_latch |= m * es_c

                def push(kind, typ):
                    alerts.append(AL.pack(dict(FAC_ID=f, KIND=AK[kind], SOURCE=src[kind, typ] | (typ << 4), TS=h["TS"],
                                               RESULT_NO=h["REC_NO"], RULES=rules, CLASSES=ca, CD_P10=cd & 0xFFFF)))

                # order per record: NS_RAISED, ES_RAISED, CLEARED(NS), CLEARED(ES) (TASKS #3)
                if ns_c and not old_nl:
                    push("NS_RAISED", 0)
                if es_c and not old_el:
                    push("ES_RAISED", 1)
                if old_nc and not ns_c and bit(self.ns_latch, f):
                    push("CLEARED", 0)
                if old_ec and not es_c and bit(self.es_latch, f):
                    push("CLEARED", 1)
        h.update(RULES=rules, CD=cd, LOGITS=BL.get(lb, "LOGITS"), WVER=BL.get(lb, "WVER"), CLASSES=ca)
        return BA.pack(h), alerts

    def pack(self, a):
        """eog_pack: bus A -> RESULT (256 bits) and m_last of its 4th beat."""
        cd = BA.get(a, "CD")
        res = RES.pack(dict(FAC_ID=BA.get(a, "FAC_RAW"), STATUS=BA.get(a, "STATUS"),
                            SINCE_RESET=BA.get(a, "SINCE_RESET"), TS=BA.get(a, "TS"), REASON=BA.get(a, "REASON"),
                            LOGITS=BA.get(a, "LOGITS"), RULES=BA.get(a, "RULES"), WVER=BA.get(a, "WVER"),
                            CD_P10=cd & 0xFFFF, CD_P50=(cd >> 16) & 0xFFFF, CD_P90=(cd >> 32) & 0xFFFF,
                            RESULT_NO=BA.get(a, "REC_NO")))
        self.batch_cnt += 1
        last = bool(BA.get(a, "IN_LAST")) or self.batch_cnt == self.batch
        if last:
            self.batch_cnt = 0
        return res, last

    # ---------------------------------------------------------------- whole pipeline
    def run_u(self, u):
        """Run one bus-U record through validate..pack. Returns every bus, the RESULT and ALERTs."""
        bus = {"U": u}
        bus["V"] = self.validate(u)
        bus["F"] = self.features(bus["V"])
        bus["M"] = self.memory(bus["F"])
        bus["C"] = self.countdown(bus["M"])
        bus["L"] = self.head(bus["C"])
        bus["A"], alerts = self.alarm(bus["L"])
        res, last = self.pack(bus["A"])
        return {"bus": bus, "res": res, "m_last": last, "alerts": alerts}

    def push_beats(self, beats):
        """Feed (data64, last) beats through eog_unpack. Returns one run_u() dict per emitted record."""
        out = []
        for data, last in beats:
            u = self.unpack_beat(data, last)
            if u is not None:
                out.append(self.run_u(u))
        return out

    def push(self, record, last=True):
        """One 48 B DATA record (6 beats, tlast on the 6th when `last`). Returns a dict with `result`
        (RESULT fields), `result_bytes`, `alerts` (list of ALERT ints), `alert_dicts` and the raw buses."""
        r = as_int(record, 48)
        assert self.beat == 0
        o = self.push_beats([((r >> (64 * j)) & ((1 << 64) - 1), last and j == 5) for j in range(6)])[0]
        o["result"] = result_dict(o["res"])
        o["result_bytes"] = o["res"].to_bytes(32, "little")
        o["alert_dicts"] = [alert_dict(a) for a in o["alerts"]]
        return o


def result_dict(res):
    d = RES.unpack(res)
    d["LOGITS"] = arr_unpack(d["LOGITS"], N_CLS)
    return d


def alert_dict(al):
    return AL.unpack(al)


# ---------------------------------------------------------------- AXI-Lite register file (regmap.md), standalone
class Regs:
    """The pure register behavior of eog_regs that does not depend on the engine: ID, VERSION, CTRL, GLOBAL,
    LEDOVR, DBGSEL, CONFIG table (enabled-slot protection, fac_touch), unmapped addresses. STATUS, STATS, FIFOs,
    DATA, DBG and WEIGHTS depend on other modules and are not modeled here."""

    ID = 0x31474F45

    def __init__(self, n_fac=N_FAC):
        self.n_fac = n_fac
        self.ctrl = 0
        self.glb = [0] * 8
        self.ledovr = 0
        self.dbgsel = 0
        self.cfg = [[0] * 16 for _ in range(n_fac)]

    @staticmethod
    def _merge(old, data, strb):
        for i in range(4):
            if bit(strb, i):
                old = (old & ~(0xFF << (8 * i))) | (data & (0xFF << (8 * i)))
        return old

    def write(self, addr, data, strb=0xF):
        """Returns the touched slot (fac_touch pulse) or None."""
        if addr == 0x0008:
            self.ctrl = self._merge(self.ctrl, data, strb) & 0x21  # stream_en, src_dma; W1P bits read 0
        elif 0x0010 <= addr <= 0x002C and addr % 4 == 0:
            if not (self.ctrl & 1):
                self.glb[(addr - 0x10) // 4] = self._merge(self.glb[(addr - 0x10) // 4], data, strb)
        elif addr == 0x0060:
            self.ledovr = self._merge(self.ledovr, data, strb)  # MODEL-Q5: all 32 bits stored (vectors use defined bits)
        elif addr == 0x0064:
            self.dbgsel = self._merge(self.dbgsel, data, strb) & 0x1F  # MODEL-Q8: only [4:0] stored, rest reads 0
        elif 0x1000 <= addr < 0x1000 + 64 * self.n_fac and addr % 4 == 0:
            f, i = (addr - 0x1000) // 64, ((addr - 0x1000) % 64) // 4
            enabled = bit(self.cfg[f][0], 24)
            if enabled and not (i == 0 and bit(strb, 3) and not bit(data, 24)):
                return None
            self.cfg[f][i] = self._merge(self.cfg[f][i], data, strb)
            return f
        return None

    def read(self, addr):
        if addr == 0x0000:
            return self.ID
        if addr == 0x0004:
            return SPEC_VERSION | (self.n_fac << 8) | (N_WELL << 16)
        if addr == 0x0008:
            return self.ctrl
        if 0x0010 <= addr <= 0x002C and addr % 4 == 0:
            w = self.glb[(addr - 0x10) // 4]
            return (w & ~0xFF00FF) | FEAT_SHIFT | (CD_LOG2 << 16) if addr == 0x10 else w
        if addr == 0x0060:
            return self.ledovr
        if addr == 0x0064:
            return self.dbgsel
        if 0x1000 <= addr < 0x1000 + 64 * self.n_fac and addr % 4 == 0:
            f, i = (addr - 0x1000) // 64, ((addr - 0x1000) % 64) // 4
            w = self.cfg[f][i]
            return (w & ~0xFFFF) | f if i == 0 else w
        return 0
