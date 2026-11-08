"""Bit-exact reference model of the EOG engine (FPGA/spec, VERSION 1, FROZEN).

Integers only. Every stage is one Engine method that takes its input bus as an int and returns its output bus as an
int laid out per spec/gen/buses.py (unpack_beat, validate, features, memory, countdown, head, alarm, pack).

Readings the spec leaves open follow the lead's answers in FPGA/TASKS.md "Spec questions" (cited as TASKS #n);
the few the model still had to decide itself are marked `MODEL-Q<n>` and listed in model/README.md.

Abstractions (the model has no clock):
- `autonomous` = HB_TIMEOUT_MS != 0 and no "fresh" heartbeat: ms_since_hb is 65535 after reset, `heartbeat()`
  makes it fresh, `hb_expire()` (the bench waits HB_TIMEOUT_MS without heartbeats) makes it stale again.
- The ALERT FIFO is never full (al_full = 0).
- Events (touch, row write, weight write, swap, ack, heartbeat) happen between records: after the previous record
  has been accepted and before the next one is (a test bench drains the pipeline first where it matters).
"""
from layouts import (AK, BA, BC, BF, BL, BM, BU, BV, CD_N, CD_NONE, CD_SCALE, CFG, D, EMA_FAST, EMA_SLOW, FEAT_SHIFT,
                     G, K_DIS, K_LEVEL, K_PIPE, N_CLS, N_FAC, N_FEAT, N_WELL, ONE, R, RES, RULE, AL,
                     ST_DROPPED, ST_HELD, ST_INVALID, ST_VALID, LH_DIS, LH_INFLOW, LH_LEVEL, LH_PIPE, LH_PUMP_FLOW,
                     LH_RECV, P_DIS, P_INFLOW, P_LEVEL, P_PIPE, P_PUMP_FLOW, P_PUMP_ST, P_RECV, P_WELL_ST,
                     P_WELL_WATER, SPEC_VERSION, arr_get, arr_pack, arr_unpack)

HDR = ("REC_NO", "IN_LAST", "FAC_RAW", "FAC", "TS", "STATUS", "REASON", "SINCE_RESET", "HIST_RESET")
GATED = (1, 2, 3, 5, 6)  # numerics.md §5 gated channels
N_WIMG = 69  # weight image words (numerics.md §8)
CYC_NONE = CD_NONE


def sat16(x):
    return -32768 if x < -32768 else 32767 if x > 32767 else x


def bit(v, i):
    return (v >> i) & 1


def feat(x, m):
    """numerics.md §4: sat16((x*M + 2^(S-1)) >>> S). Returns (value, saturated)."""
    y = (x * m + (1 << (FEAT_SHIFT - 1))) >> FEAT_SHIFT  # Python >> floors (arithmetic shift)
    return sat16(y), not (-32768 <= y <= 32767)


def cd_div(a, b):
    """numerics.md §7 div(a, b)."""
    return CD_NONE if b == 0 else min(a // b, CD_NONE)


def hdr_of(lay, v):
    return {n: lay.get(v, n) for n in HDR}


# Facility fields in DATA PRESENT-bit order: (present bit, DATA field, LO/HI index or None for the enum).
FAC_FIELDS = ((P_INFLOW, "INFLOW", LH_INFLOW), (P_LEVEL, "LEVEL", LH_LEVEL), (P_PUMP_ST, "PUMP_ST", None),
              (P_PUMP_FLOW, "PUMP_FLOW", LH_PUMP_FLOW), (P_DIS, "DIS_PSI", LH_DIS), (P_RECV, "RECV_FLOW", LH_RECV),
              (P_PIPE, "PIPE_PSI", LH_PIPE))


class _VSlot:
    """eog_validate per-facility state."""

    def __init__(self):
        self.has_ts = False
        self.pending = True
        self.last_ts = 0
        self.since = 0
        self.prev_level = 0
        self.prev_ok = False
        self.clear_fields()

    def clear_fields(self):
        self.last = {}   # field key -> last value
        self.miss = {}   # field key -> miss counter


class _MSlot:
    def __init__(self):
        self.last_run = [0] * 5
        self.ema_f = [0] * 5
        self.ema_s = [0] * 5
        self.net_ema = 0
        self.nsr = 0
        self.has_run = False


class _ASlot:
    def __init__(self):
        self.cnt = [0] * N_CLS
        self.leak = 0


def decode_weights(img):
    """69-word image -> (W[4][31], B[4], S_OUT, VER)."""
    assert len(img) == N_WIMG
    w = [[0] * N_FEAT for _ in range(N_CLS)]
    for k in range(N_CLS):
        for i in range(N_FEAT):
            word = img[16 * k + i // 2]
            h = (word >> (16 * (i % 2))) & 0xFFFF
            w[k][i] = h - 0x10000 if h & 0x8000 else h
    b = []
    for k in range(N_CLS):
        x = img[64 + k] & 0xFFFFFFFF
        b.append(x - (1 << 32) if x >> 31 else x)
    return w, b, img[68] & 0x1F, (img[68] >> 8) & 0xFF


def encode_weights(w, b, s_out, ver):
    """W[4][31] (s16), B[4] (s32) -> 69-word image (W[k][31] padding written 0)."""
    img = [0] * N_WIMG
    for k in range(N_CLS):
        for j in range(16):
            lo = w[k][2 * j] & 0xFFFF
            hi = (w[k][2 * j + 1] & 0xFFFF) if 2 * j + 1 < N_FEAT else 0
            img[16 * k + j] = lo | (hi << 16)
        img[64 + k] = b[k] & 0xFFFFFFFF
    img[68] = (s_out & 0x1F) | ((ver & 0xFF) << 8)
    return img


def as_int(x, nbytes):
    if isinstance(x, (bytes, bytearray)):
        assert len(x) == nbytes, (len(x), nbytes)
        return int.from_bytes(x, "little")
    return x


class Engine:
    def __init__(self, n_fac=N_FAC, cd_n=CD_N, batch=45, trace=False):
        self.n_fac = n_fac
        self.cd_n = cd_n
        self.batch = batch
        self.glb = 0
        self.rows = [0] * 32
        self.banks = [[0] * N_WIMG, [0] * N_WIMG]  # word 68 = 0 after reset (no model)
        self.active = 0
        self.trace = trace
        self.mul_feat_log, self.mul_head_log, self.div_log = [], [], []
        self.reset()

    # ---------------------------------------------------------------- control
    def reset(self):
        """Hard or soft reset: per-facility state and counters; not CONFIG, GLOBAL or weight banks."""
        self.rec_no = 0
        self.beat = 0
        self.buf = 0
        self.vst = [_VSlot() for _ in range(32)]
        self.mst = [_MSlot() for _ in range(32)]
        self.ring = [[] for _ in range(32)]
        self.ast = [_ASlot() for _ in range(32)]
        self.ns_latch = self.es_latch = self.ns_cond = self.es_cond = 0
        self.batch_cnt = 0
        self.hb_fresh = False  # ms_since_hb = 65535 after reset

    def configure(self, glb, rows):
        """GLOBAL (32 B or int) and CONFIG rows {slot: 64 B or int}. Every written slot is touched."""
        self.set_glb(glb)
        for f, row in rows.items():
            self.write_row(f, row)

    def set_glb(self, glb):
        g = as_int(glb, 32)
        self.glb = G.put(g, "S", FEAT_SHIFT)  # eog_regs forces byte 0 (S) to 17

    def write_row(self, f, row):
        self.rows[f] = CFG.put(as_int(row, 64), "FAC_ID", f)  # FAC_ID reads back as the slot
        self.touch(f)

    def touch(self, f):
        """fac_touch[f]: the slot's next record starts a new history."""
        self.vst[f].pending = True
        self.vst[f].has_ts = False

    def load_weights(self, image):
        """Write a 69-word image into the inactive bank."""
        assert len(image) == N_WIMG
        self.banks[1 - self.active] = [x & 0xFFFFFFFF for x in image]

    def swap(self):
        self.active ^= 1

    def active_ver(self):
        return (self.banks[self.active][68] >> 8) & 0xFF

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
        """eog_validate, numerics.md §3."""
        r = BU.get(u, "REC")
        fac_raw = D.get(r, "FAC_ID")
        fac = fac_raw & 0x1F
        ts = D.get(r, "TS")
        out = dict(REC_NO=BU.get(u, "REC_NO"), IN_LAST=BU.get(u, "IN_LAST"), FAC_RAW=fac_raw, FAC=fac, TS=ts)

        def dropped(reason):
            out.update(STATUS=ST_DROPPED, REASON=1 << R[reason])
            return BV.pack(out)

        # 1 framing
        if BU.get(u, "FRAME_ERR") or D.get(r, "RSV0") or D.get(r, "RSV1") or D.get(r, "RSV2"):
            return dropped("FRAMING")
        # 2 facility
        row = self.rows[fac]
        if fac_raw >= self.n_fac or not (CFG.get(row, "FLAGS") & 1):
            return dropped("UNKNOWN_FAC")
        st = self.vst[fac]
        hold = min(G.get(self.glb, "HOLD_MAX"), 2)
        reason = 0
        # 3 time
        new_hist = True
        gap_held = False
        if st.has_ts and not st.pending:
            if ts == st.last_ts:
                return dropped("DUPLICATE")
            if ts < st.last_ts:
                return dropped("OUT_OF_ORDER")
            d = ts - st.last_ts
            if d == 300:
                new_hist = False
            elif d in (600, 900) and d // 300 - 1 <= hold:
                new_hist = False
                gap_held = True
                reason |= 1 << R["GAP_HELD"]
        # 4 new history
        if new_hist:
            st.clear_fields()
            st.prev_ok = False
            since = 0
            reason |= 1 << R["HIST_RESET"]
        else:
            since = min(st.since + 1, 255)
        # 5 fields
        present = D.get(r, "PRESENT")
        lo = [arr_get(row, CFG, "LO", j) for j in range(7)]
        hi = [arr_get(row, CFG, "HI", j) for j in range(7)]
        wlo = CFG.get(row, "WELL_LO", signed=True)
        whi = CFG.get(row, "WELL_HI", signed=True)
        n_wells = min(CFG.get(row, "N_WELLS"), N_WELL)
        flags = {"held": False, "lost": False}

        def field(key, pbit, v, legal, in_range):
            nonlocal reason
            if not bit(present, pbit):
                reason |= 1 << R["FIELD_ABSENT"]
            elif not legal:
                reason |= 1 << R["ILLEGAL_ENUM"]
            elif not in_range:
                reason |= 1 << R["OUT_OF_RANGE"]
            else:
                st.last[key] = v
                st.miss[key] = 0
                return v, 1
            if key in st.last and st.miss[key] < hold:
                st.miss[key] += 1
                reason |= 1 << R["FIELD_HELD"]
                flags["held"] = True
                return st.last[key], 1
            reason |= 1 << R["FIELD_LOST"]
            flags["lost"] = True
            return 0, 0

        vals = {}
        fld_ok = 0
        for pbit, name, lh in FAC_FIELDS:
            if lh is None:
                v = D.get(r, name)
                x, ok = field(name, pbit, v, v in (0, 1, 2), True)
            else:
                v = D.get(r, name, signed=True)
                x, ok = field(name, pbit, v, True, lo[lh] <= v <= hi[lh])
            vals[name] = x
            fld_ok |= ok << pbit
        wst = D.get(r, "WELL_ST")
        well_act = 0
        water = [0] * N_WELL
        wells_ok = 1  # 1 when n_wells = 0
        well_ok = [0] * N_WELL
        for i in range(n_wells):
            s = (wst >> (2 * i)) & 3
            x, ok1 = field(("WST", i), P_WELL_ST + i, s, s in (0, 1), True)
            v = arr_get(r, D, "WELL_WATER", i)
            y, ok2 = field(("WW", i), P_WELL_WATER + i, v, True, wlo <= v <= whi)
            well_act |= int(x == 1) << i
            water[i] = y
            well_ok[i] = ok1 & ok2
            wells_ok &= ok1 & ok2
        # 6 status
        status = ST_INVALID if flags["lost"] else ST_HELD if (flags["held"] or gap_held) else ST_VALID
        # 8 consistency flags (reason only), on the carried values and only when their inputs are OK (TASKS #12)
        if bit(fld_ok, P_PUMP_ST) and bit(fld_ok, P_PUMP_FLOW) and vals["PUMP_ST"] != 1 and vals["PUMP_FLOW"] > 0:
            reason |= 1 << R["PUMP_INCONS"]
        if any(well_ok[i] and not bit(well_act, i) and water[i] > 0 for i in range(n_wells)):
            reason |= 1 << R["WELL_INCONS"]
        # PREV_LEVEL / PREV_OK: PREV_LEVEL = 0 when PREV_OK = 0 (TASKS #13)
        prev_ok = int(st.prev_ok)
        prev_level = st.prev_level if prev_ok else 0
        # 7 state update
        st.has_ts = True
        st.last_ts = ts
        st.since = since
        if status == ST_INVALID:
            st.pending = True
        else:
            st.pending = False
            st.prev_level = vals["LEVEL"]
            st.prev_ok = True
        out.update(STATUS=status, REASON=reason, SINCE_RESET=since, HIST_RESET=int(new_hist),
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
        """eog_features, numerics.md §4."""
        h = hdr_of(BV, v)
        status = h["STATUS"]
        row = self.rows[h["FAC"]]
        g = lambda n: BV.get(v, n, signed=True)  # noqa: E731
        inflow, level = g("INFLOW"), g("LEVEL")
        pst = BV.get(v, "PUMP_ST")
        fld_ok = BV.get(v, "FLD_OK")
        well_act = BV.get(v, "WELL_ACT")
        water = arr_unpack(BV.get(v, "WELL_WATER"), N_WELL)
        n_wells = min(CFG.get(row, "N_WELLS"), N_WELL)
        rules = 0
        if status != ST_DROPPED:
            shut, warn = CFG.get(row, "SHUT_LVL"), CFG.get(row, "WARN_LVL")
            swm = G.get(self.glb, "SHUTIN_WATER_MAX")
            if bit(fld_ok, P_PUMP_ST) and pst == 2:
                rules |= 1 << RULE["PUMP_FAULT"]
            if (BV.get(v, "WELLS_OK") and n_wells >= 1 and well_act == 0
                    and all(water[i] <= swm for i in range(n_wells))):
                rules |= 1 << RULE["SHUT_IN"]
            if bit(fld_ok, P_LEVEL) and level >= shut:
                rules |= 1 << RULE["LVL_SHUTDOWN"]
            if bit(fld_ok, P_LEVEL) and level >= warn:
                rules |= 1 << RULE["LVL_WARNING"]
        ch = [0] * 12
        reason = h["REASON"]
        run = 0
        if status in (ST_VALID, ST_HELD):
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
                reason |= 1 << R["FEAT_SAT"]
            run = int(pst == 1)
        h["REASON"] = reason
        h.update(FEAT0_11=arr_pack(ch), RULES4=rules, INFLOW=inflow, LEVEL=level, PUMP_RUN=run)
        return BF.pack(h)

    def memory(self, fb):
        """eog_memory, numerics.md §5."""
        h = hdr_of(BF, fb)
        status = h["STATUS"]
        ch = arr_unpack(BF.get(fb, "FEAT0_11"), 12)
        mem = [0] * 19
        if status in (ST_VALID, ST_HELD) and h["FAC"] < self.n_fac:  # FAC >= N_FAC: no state (TASKS #1)
            f = h["FAC"]
            if h["HIST_RESET"]:
                self.mst[f] = _MSlot()
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
            s.net_ema += ((ch[11] << 8) - s.net_ema) >> EMA_FAST
            mem = (s.last_run + [e >> 8 for e in s.ema_f] + [e >> 8 for e in s.ema_s]
                   + [s.net_ema >> 8, min(s.nsr, 64) << 8, ONE if s.has_run else 0, min(h["SINCE_RESET"], 64) << 8])
            assert all(-32768 <= x <= 32767 for x in mem), mem  # numerics.md §5: fits int16 by construction
        h.update(FEAT=arr_pack(ch + mem), RULES4=BF.get(fb, "RULES4"), INFLOW=BF.get(fb, "INFLOW"),
                 LEVEL=BF.get(fb, "LEVEL"))
        return BM.pack(h)

    def _div(self, a, b):
        if self.trace:
            self.div_log.append((a, b))
        return cd_div(a, b)

    def countdown(self, m):
        """eog_countdown, numerics.md §7 (D1, D2, D5)."""
        h = hdr_of(BM, m)
        status = h["STATUS"]
        p10 = p50 = p90 = CD_NONE
        nf = 0
        if status in (ST_VALID, ST_HELD) and h["FAC"] < self.n_fac:  # FAC >= N_FAC: no state (TASKS #1)
            f = h["FAC"]
            row = self.rows[f]
            ring = self.ring[f]
            if h["HIST_RESET"]:
                ring.clear()
            ring.append(max(BM.get(m, "INFLOW", signed=True), 0))
            if len(ring) > self.cd_n:
                ring.pop(0)
            level = BM.get(m, "LEVEL", signed=True)
            shut = CFG.get(row, "SHUT_LVL")
            if level >= shut:
                p10 = p50 = p90 = 0
            else:
                dl = shut - level
                k = CFG.get(row, "K_CD")
                n, sm, mx, mn = len(ring), sum(ring), max(ring), min(ring)
                p10 = self._div(k * dl, mx << CD_SCALE)
                p50 = self._div(k * dl * n, sm << CD_SCALE)
                p90 = self._div(k * dl, mn << CD_SCALE)
                nf = int(sm == 0)
        h.update(FEAT=BM.get(m, "FEAT"), RULES=BM.get(m, "RULES4") | (nf << RULE["NOT_FILLING"]),
                 CD=p10 | (p50 << 16) | (p90 << 32))
        return BC.pack(h)

    def head(self, c):
        """eog_head, numerics.md §8. Uses the bank active when the record is accepted."""
        h = hdr_of(BC, c)
        status = h["STATUS"]
        w, b, s_out, ver = decode_weights(self.banks[self.active])
        x = arr_unpack(BC.get(c, "FEAT"), N_FEAT)
        logits = [0] * N_CLS
        if status in (ST_VALID, ST_HELD):
            if ver == 0:
                h["REASON"] |= 1 << R["NO_MODEL"]
            else:
                for k in range(N_CLS):
                    acc = b[k]
                    for i in range(N_FEAT):
                        if self.trace:
                            self.mul_head_log.append((w[k][i], x[i]))
                        acc += w[k][i] * x[i]
                    assert -(1 << 47) <= acc < (1 << 47)
                    rnd = (1 << (s_out - 1)) if s_out > 0 else 0
                    logits[k] = sat16((acc + rnd) >> s_out)
        # WVER: active VER at accept; 0 for DROPPED (conventions §3).  MODEL-Q3: INVALID carries the active VER.
        h.update(CH3=x[3] & 0xFFFF, RULES=BC.get(c, "RULES"), CD=BC.get(c, "CD"), LOGITS=arr_pack(logits),
                 WVER=0 if status == ST_DROPPED else ver)
        return BL.pack(h)

    def alarm(self, lb):
        """eog_alarm, numerics.md §9. Returns (bus A, [ALERT ints])."""
        h = hdr_of(BL, lb)
        status = h["STATUS"]
        rules = BL.get(lb, "RULES")
        cd = BL.get(lb, "CD")
        logits = arr_unpack(BL.get(lb, "LOGITS"), N_CLS)
        ch3 = BL.get(lb, "CH3", signed=True)
        alerts = []
        ca = 0
        if status in (ST_VALID, ST_HELD, ST_INVALID) and h["FAC"] < self.n_fac:  # codes 2, 5-7, DROPPED: no change
            f = h["FAC"]
            s = self.ast[f]
            K = max(G.get(self.glb, "PERSIST_K"), 1)
            gap_thr = G.get(self.glb, "GAP_THR", signed=True)
            gap = ch3 >= gap_thr
            if status in (ST_VALID, ST_HELD):
                hit = [logits[k] >= arr_get(self.glb, G, "LOGIT_THR", k) for k in range(N_CLS)]
                s.cnt = [min(s.cnt[k] + 1, 255) if hit[k] else 0 for k in range(N_CLS)]
                s.leak = min(s.leak + 1, 255) if (hit[0] and gap) else 0
                ca = sum(int(s.cnt[k] >= K) << k for k in range(N_CLS))
                es_c = s.leak >= K
                ns_c = (rules & 0xF) != 0 or ca != 0
            else:  # INVALID
                s.cnt = [0] * N_CLS
                s.leak = 0
                es_c = False
                ns_c = (rules & 0xF) != 0
            auto = int(self.autonomous)
            old_nl, old_el = bit(self.ns_latch, f), bit(self.es_latch, f)
            old_nc, old_ec = bit(self.ns_cond, f), bit(self.es_cond, f)

            def push(kind, source):
                alerts.append(AL.pack(dict(FAC_ID=h["FAC"], KIND=AK[kind], SOURCE=source, TS=h["TS"],
                                           RESULT_NO=h["REC_NO"], RULES=rules, CLASSES=ca, CD_P10=cd & 0xFFFF)))

            if ns_c and not old_nl:
                push("NS_RAISED", int((rules & 0xF) != 0) | (int(ca != 0) << 1) | (auto << 2))
            if es_c and not old_el:
                push("ES_RAISED", int(gap) | ((ca & 1) << 1) | (auto << 2) | (1 << 4))
            # order per record: NS_RAISED, ES_RAISED, CLEARED(NS), CLEARED(ES) (TASKS #3)
            if old_nc and not ns_c and old_nl:
                push("CLEARED", auto << 2)
            if old_ec and not es_c and old_el:
                push("CLEARED", (auto << 2) | (1 << 4))
            m = 1 << f
            self.ns_latch |= m * int(ns_c)
            self.es_latch |= m * int(es_c)
            self.ns_cond = (self.ns_cond & ~m) | (m * int(ns_c))
            self.es_cond = (self.es_cond & ~m) | (m * int(es_c))
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
        (RESULT fields), `result_bytes`, `alerts` (list of ALERT field dicts) and the raw buses."""
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
    LEDOVR, CONFIG table (enabled-slot protection, fac_touch), unmapped addresses. STATUS, STATS, FIFOs, DATA and
    WEIGHTS depend on other modules and are not modeled here."""

    ID = 0x31474F45

    def __init__(self, n_fac=N_FAC):
        self.n_fac = n_fac
        self.ctrl = 0
        self.glb = [0] * 8
        self.ledovr = 0
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
            return (w & ~0xFF) | FEAT_SHIFT if addr == 0x10 else w
        if addr == 0x0060:
            return self.ledovr
        if 0x1000 <= addr < 0x1000 + 64 * self.n_fac and addr % 4 == 0:
            f, i = (addr - 0x1000) // 64, ((addr - 0x1000) % 64) // 4
            w = self.cfg[f][i]
            return (w & ~0xFFFF) | f if i == 0 else w
        return 0
