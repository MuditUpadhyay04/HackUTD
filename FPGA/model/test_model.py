"""Self-checks of the reference model, ingest and vectors (spec v4 + TASKS rulings 20-25).
    python FPGA/model/test_model.py

1. Layouts: every bus/record field matches rtl/eog_defs.svh; pack/unpack round-trips.
2. Arithmetic primitives against independent (Fraction) formulas; weight window (Mudit's blob layout) round trip.
3. Ingest: practice dataset shape, CONFIG values and metadata bounds, refusals, DATA encoding of sampled CSV rows.
4. Directed v4 semantics: framing before the lookup, first-record reset, DROPPED fields, latched Night Shift /
   E-STOP with CLEARED and SOURCE per kind, per-class K, countdown ring clamp and tripped tank.
5. R1 (offline): p50 tracks the answer key's trips_at at all 13 practice pump-failure onsets.
   answer_key.json is read ONLY here, ONLY for this offline evaluation (global_plan hard rule 1).
6. Invariants over every vector case: stage contract, DROPPED/INVALID rules, averages within input range,
   p10 <= p50 <= p90, REC_NO sequence; the hand-made weights fire each class on the practice week.
7. Vector files: present for every module in spec/modules/, LF only, line counts match, and identical to a fresh
   regeneration (so the committed vectors are current).
Byte-for-byte agreement with Mudit's features_int.py is check_mudit.py (needs his branch and numpy).
"""
import json
import math
import os
import random
import re
import shutil
import sys
import tempfile
import traceback
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cases as C  # noqa: E402
import gen_vectors as GV  # noqa: E402
import ingest as I  # noqa: E402
from eog_ref import (Engine, Regs, cd_minutes, decode_weights, encode_blob, encode_weights, feat,  # noqa: E402
                     result_dict, window_from_blob)
from layouts import (BUS, CFG, D, DEFS, FPGA, G, REC, RULE, R, ST_DROPPED, ST_HELD, ST_INVALID, ST_VALID,  # noqa
                     K_DIS, K_LEVEL, K_PIPE, AL, AK, arr_get, arr_unpack)

FAILS = []
PASSES = []


def check(name):
    def deco(fn):
        try:
            fn()
            PASSES.append(name)
            print("ok   ", name)
        except Exception as e:  # noqa: BLE001
            FAILS.append(name)
            print("FAIL ", name, "--", e)
            traceback.print_exc(limit=3)
        return fn
    return deco


# ------------------------------------------------------------------------------------------------ 1 layouts
@check("layouts match rtl/eog_defs.svh")
def _():
    for b, lay in BUS.items():
        assert DEFS["EOG_B%s_W" % b] == lay.width, b
        for n, (off, w) in lay.fields.items():
            assert DEFS["EOG_B%s_%s" % (b, n)] == off and DEFS["EOG_B%s_%s_W" % (b, n)] == w, (b, n)
        assert sum(1 for k in DEFS if re.fullmatch("EOG_B%s_[A-Z0-9_]+_W" % b, k)) == len(lay.fields), b
    for p, lay in REC.items():
        assert DEFS["EOG_%s_BITS" % p] == lay.width, p
        for n, (off, w) in lay.fields.items():
            assert DEFS["EOG_%s_%s" % (p, n)] == off and DEFS["EOG_%s_%s_W" % (p, n)] == w, (p, n)
    assert (BUS["U"].width, BUS["V"].width, BUS["A"].width) == (418, 373, 243)
    assert (D.width, CFG.width, G.width, REC["RES"].width, AL.width) == (384, 512, 256, 256, 128)


@check("pack/unpack round trip, hex width")
def _():
    rng = random.Random(1)
    for lay in list(BUS.values()) + list(REC.values()):
        for _ in range(50):
            d = {n: rng.getrandbits(w) for n, (_o, w) in lay.fields.items()}
            v = lay.pack(d)
            assert lay.unpack(v) == d
            h = lay.hex(v)
            assert len(h) == (lay.width + 3) // 4 and int(h, 16) == v


@check("numerics constants (K_LEVEL, K_DIS, K_PIPE) match numerics.md and their formulas")
def _():
    txt = open(os.path.join(FPGA, "spec", "numerics.md"), encoding="utf-8").read()
    for n, v, den in (("K_LEVEL", K_LEVEL, 10000), ("K_DIS", K_DIS, 1500), ("K_PIPE", K_PIPE, 500)):
        assert math.floor(Fraction(2 ** 17 * 16384, den) + Fraction(1, 2)) == v == round(16384 / den * 2 ** 17), n
        assert re.search(r"%s = %d\b" % (n, v), txt), n


# ------------------------------------------------------------------------------------------------ 2 arithmetic
@check("feat(): round-half-up shift and saturation (vs Fraction floor)")
def _():
    rng = random.Random(2)
    xs = [0, 1, -1, 65535, -65536, (1 << 19) - 1, -(1 << 19)] + [rng.randint(-(1 << 19), (1 << 19) - 1)
                                                                 for _ in range(3000)]
    ms = [0, 1, (1 << 32) - 1, 1 << 31, 214748] + [rng.getrandbits(32) for _ in range(30)]
    for x in xs[:400]:
        for m in ms:
            y = math.floor(Fraction(x * m, 1 << 17) + Fraction(1, 2))
            v, s = feat(x, m)
            assert v == max(-32768, min(32767, y)) and s == (y != v), (x, m)
    assert feat(1, 65536) == (1, False) and feat(-1, 65536) == (0, False)  # ties round toward +inf


@check("countdown m(q), weight window = Mudit's blob layout, head output rounding for S_OUT 0..31")
def _():
    assert cd_minutes(5, 0) == 0xFFFF and cd_minutes(5, -3) == 0xFFFF and cd_minutes(10 ** 12, 1) == 0xFFFF
    assert cd_minutes(7 * 256, 2) == 3 and cd_minutes(0, 3) == 0
    e = Engine()
    rng = random.Random(3)
    for s_out in range(32):
        w = [[rng.randint(-32768, 32767) for _ in range(31)] for _ in range(4)]
        b = [rng.randint(-(1 << 31), (1 << 31) - 1) for _ in range(4)]
        img = encode_weights(w, b, s_out, 7)
        assert len(img) == 71 and img[70] == 7 and img == window_from_blob(encode_blob(w, b, s_out), 7)
        blob = b"".join(x.to_bytes(4, "little") for x in img[:70])
        k, i = rng.randrange(4), rng.randrange(31)   # numerics.md §8 byte offsets
        assert blob[4] == s_out and int.from_bytes(blob[8 + 2 * (31 * k + i):10 + 2 * (31 * k + i)], "little",
                                                   signed=True) == w[k][i]
        assert int.from_bytes(blob[256 + 4 * k:260 + 4 * k], "little", signed=True) == b[k]
        w2, b2, s2, v2 = decode_weights(img)
        assert (w2, b2, s2, v2) == (w, b, s_out, 7)
        e.load_weights(img)
        e.swap()
        feats = [rng.randint(-32768, 32767) for _ in range(31)]
        from layouts import BC, arr_pack
        c = BC.pack(dict(STATUS=ST_VALID, FEAT=arr_pack(feats), CD=0xFFFFFFFFFFFF))
        lg = arr_unpack(BUS["L"].get(e.head(c), "LOGITS"), 4)
        for k in range(4):
            acc = sum(w[k][i] * feats[i] for i in range(31)) + b[k]
            y = math.floor(Fraction(acc, 1 << s_out) + (Fraction(1, 2) if s_out else 0))
            assert lg[k] == max(-32768, min(32767, y)), (s_out, k)


@check("Regs: ID, VERSION, S reads 17 and CD_LOG2 4, DBGSEL, GLOBAL locked while streaming, CONFIG protection")
def _():
    m = Regs()
    assert m.read(0) == 0x31474F45 and m.read(4) == DEFS["EOG_SPEC_VERSION"] | (32 << 8) | (8 << 16)
    assert DEFS["EOG_SPEC_VERSION"] == 4
    m.write(0x10, 0xFFFFFF05)
    assert m.read(0x10) == 0xFF04FF11
    m.write(0x64, 0xFFFFFFFF)
    assert m.read(0x64) == 0x1F
    m.write(0x08, 1)
    m.write(0x14, 0x1234)
    assert m.read(0x14) == 0 and m.read(0x08) == 1
    assert m.write(0x1000, 0x01000000) == 0 and m.write(0x1004, 5) is None and m.read(0x1004) == 0
    assert m.write(0x1000, 0, 0x8) == 0 and m.write(0x1004, 5) == 0 and m.read(0x1004) == 5


# ------------------------------------------------------------------------------------------------ 3 ingest
DS = None


@check("ingest: practice dataset shape and CONFIG values")
def _():
    global DS
    DS = C.practice()
    nf = len(DS.facs)
    assert nf == len([f for s in DS.net["systems"] for f in s["facilities"]])
    assert len(DS.records) == nf * len(DS.ts_list)
    assert DS.stats["unknown"] == DS.stats["duplicate"] == DS.stats["unrepresentable"] == 0
    for t in range(1, len(DS.ts_list)):
        assert DS.ts_list[t] - DS.ts_list[t - 1] == 300
    for f in DS.facs:
        row = DS.rows[f["slot"]]
        assert CFG.get(row, "N_WELLS") == f["W"] and CFG.get(row, "FLAGS") == 1
        for n, x in (("M_INV_B", 8192 / f["B"]), ("M_INV_Q", 8192 / f["Q"]), ("M_INV_W", 16384 / f["W"]),
                     ("M_NET", 16384 * 288 * f["C"] / (10000 * f["B"]))):
            assert abs(CFG.get(row, n) - x * 2 ** 17) <= 0.5 and CFG.get(row, n) < 1 << 32, n
        assert abs(CFG.get(row, "K_CD") - 0.288 * f["C"] * 256) <= 0.5
        assert CFG.get(row, "SHUT_LVL") == round(100 * f["shut"]) and CFG.get(row, "WARN_LVL") == round(100 * f["warn"])
        lo, hi, wlo, whi = I.metadata_bounds(f["B"], f["Q"], f["max_psi"], f["well_base_max"])
        assert [arr_get(row, CFG, "LO", j) for j in range(7)] == list(lo)          # present-bit order (A14)
        assert [arr_get(row, CFG, "HI", j) for j in range(7)] == list(hi) and hi[2] == 2 and lo[1] == -500
        assert (CFG.get(row, "WELL_LO", signed=True), CFG.get(row, "WELL_HI", signed=True)) == (wlo, whi)
    for r in DS.records:
        n = CFG.get(DS.rows[D.get(r, "FAC_ID")], "N_WELLS")
        assert D.get(r, "PRESENT") == I.present_all(n)
    assert (G.get(DS.glb, "S"), G.get(DS.glb, "CD_LOG2"), G.get(DS.glb, "GAP_THR"), G.get(DS.glb, "PERSIST_K"),
            G.get(DS.glb, "PERSIST_K4")) == (17, 4, 492, 1, 0)


@check("ingest: DATA encoding of sampled CSV rows (float64, floor(v * scale + 0.5), A15)")
def _():
    import csv
    amap = DS._asset_map()
    lsb = {k: v for k, v in I.METRICS.items()}
    nf = len(DS.facs)
    tsi = {t: i for i, t in enumerate(DS.ts_list)}
    with open(os.path.join(DS.folder, "telemetry.csv"), newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    rng = random.Random(4)
    fieldname = {"inflow": "INFLOW", "level": "LEVEL", "pump_flow": "PUMP_FLOW", "recv_flow": "RECV_FLOW",
                 "dis": "DIS_PSI", "pipe": "PIPE_PSI"}
    for row in rng.sample(rows, 3000):
        kind, slot, wi = amap[row["asset_id"]]
        key, scale, _p = lsb[(kind, row["metric"])]
        r = DS.records[tsi[int(row["ts_unix"])] * nf + slot]
        if key == "water":
            got = arr_unpack(D.get(r, "WELL_WATER"), 8)[wi]
        elif key == "well_st":
            got = (D.get(r, "WELL_ST") >> (2 * wi)) & 3
        elif key == "pump_st":
            got = D.get(r, "PUMP_ST")
        else:
            got = D.get(r, fieldname[key], signed=True)
        want = int(float(row["value"])) if scale is None else math.floor(float(row["value"]) * scale + 0.5)
        assert got == want, (row, got, want)
    assert I._encode_value(2, "1.25", 0) == 3 and I._encode_value(2, "-1.25", 0) == -2   # round half up
    assert I._encode_value(None, "2", 255) == 2
    for bad in ((None, "2.5", 255), (None, "4", 3), (2, "nan", 0), (2, "16384", 0)):
        try:
            I._encode_value(*bad)
        except ValueError:
            continue
        raise AssertionError("encoded " + repr(bad))


@check("ingest: refuses > 8 wells, > 32 facilities, W = 0, non-positive constants")
def _():
    base = json.loads(json.dumps(DS.net))
    f0 = base["systems"][0]["facilities"][0]
    for mut in ("wells9", "wells0", "fac33", "q0"):
        net = json.loads(json.dumps(base))
        f = net["systems"][0]["facilities"][0]
        if mut == "wells9":
            f["wells"] = [dict(f0["wells"][0], id="W%d" % i) for i in range(9)]
        elif mut == "wells0":
            f["wells"] = []
        elif mut == "fac33":
            net["systems"][0]["facilities"] = [dict(f0, id="F%d" % i) for i in range(33)]
        else:
            f["pump"]["max_flow_bpd"] = 0
        try:
            I.config_rows(I.facilities(net))
        except I.IngestError:
            continue
        raise AssertionError("ingest accepted " + mut)


# ------------------------------------------------------------------------------------------------ 4 directed v4
def _alerts(o):
    return [(AL.get(a, "KIND"), AL.get(a, "SOURCE"), AL.get(a, "CLASSES")) for a in o["alerts"]]


@check("v4 directed: framing, first-record reset, DROPPED fields, latches, SOURCE per kind, per-class K, ring")
def _():
    import random as _r
    f = C.SimFac(0, 2400, 3600, 3, 1200, 1050, _r.Random(5), 55)
    f.running = True
    bias = lambda on: encode_weights([[0] * 31] * 4, [(1 << 30) if k in on else -(1 << 30) for k in range(4)], 8, 7)

    def eng(glb, img):
        e = Engine()
        e.configure(glb, {0: f.row()})
        e.load_weights(img)
        e.swap()
        e.heartbeat()
        return e
    t0 = C.TS0
    e = eng(I.global_record(HB_TIMEOUT_MS=0), C.w_zero())
    d = [e.push(C.rec(0, t0, f.step()))["result"]]                              # first record: HIST_RESET (#24)
    d.append(e.push(C.rec(40, t0 + 300, f.step(), rsv0=2))["result"])          # FRAMING before the lookup (D9)
    d.append(e.push(C.rec(0, t0 + 300, f.step()))["result"])
    d.append(e.push(C.rec(0, t0 + 300, f.step()))["result"])                    # DUPLICATE: SINCE_RESET 0 (#25)
    d.append(e.push(C.rec(0, t0 + 600, f.step(), absent=[0]))["result"])       # FIELD_HELD + FIELD_ABSENT (#23)
    assert [x["STATUS"] for x in d] == [0, 4, 0, 4, 1]
    assert d[0]["REASON"] == (1 << R["HIST_RESET"]) | (1 << R["NO_MODEL"]) and d[0]["SINCE_RESET"] == 0
    assert d[1]["REASON"] == 1 << R["FRAMING"] and d[3]["REASON"] == 1 << R["DUPLICATE"]
    assert d[3]["SINCE_RESET"] == 0 and d[3]["WVER"] == 0 and d[4]["SINCE_RESET"] == 2
    assert d[4]["REASON"] == (1 << R["FIELD_HELD"]) | (1 << R["FIELD_ABSENT"]) | (1 << R["NO_MODEL"])
    # rule Night Shift: raised once, CLEARED (source 0) on each fall, latch survives a history reset (D8, #22)
    e = eng(I.global_record(HB_TIMEOUT_MS=0), C.w_zero())
    al = [_alerts(e.push(C.rec(0, t0 + 300 * k, f.step(), **m))) for k, m in
          enumerate([dict(pump_st=2), {}, dict(pump_st=2), {}])]
    al.append(_alerts(e.push(C.rec(0, t0 + 300 * 4 + 3600, f.step(), pump_st=2))))
    assert al == [[(1, 1, 0)], [(3, 0, 0)], [], [(3, 0, 0)], []], al
    assert e.ack() == [] and e.ns_latch == 1
    e.push(C.rec(0, t0 + 300 * 18, f.step()))
    assert [AL.get(a, "SOURCE") for a in e.ack()] == [0]                       # ACKED: only bit 4 (type 0)
    # E-STOP (gap rule + leak logit): ES_RAISED source 1|2|16, CLEARED(ES) source 16
    e = eng(I.global_record(HB_TIMEOUT_MS=0), bias({0}))
    al = [_alerts(e.push(C.rec(0, t0 + 300 * k, f.step(), pump_flow=7200, recv_flow=r, pump_st=1)))
          for k, r in enumerate([6000, 7200, 6000])]
    assert al == [[(1, 2, 1), (2, 19, 1)], [(3, 16, 1)], []], al
    # per-class K: PERSIST_K4 = (0, 3, 0, 0), PERSIST_K = 0 -> K = (1, 3, 1, 1)
    e = eng(I.global_record(HB_TIMEOUT_MS=0, PERSIST_K=0, PERSIST_K4=(0, 3, 0, 0)), bias({1}))
    al = [_alerts(e.push(C.rec(0, t0 + 300 * k, f.step(), pump_st=1))) for k in range(4)]
    assert al == [[], [], [(1, 2, 2)], []], al
    # countdown: ring of max(INFLOW, 0) (#20); level >= shutdown -> 0/0/0 and NOT_FILLING 0 (#21)
    e = eng(I.global_record(HB_TIMEOUT_MS=0), C.w_zero())
    x = e.push(C.rec(0, t0, f.step(), inflow=-300, level=5000))["result"]
    assert (x["CD_P10"], x["CD_P50"], x["CD_P90"]) == (0xFFFF,) * 3 and x["RULES"] >> RULE["NOT_FILLING"] & 1
    x = e.push(C.rec(0, t0 + 300, f.step(), inflow=1600, level=9200))["result"]
    assert (x["CD_P10"], x["CD_P50"], x["CD_P90"]) == (0, 0, 0) and x["RULES"] & 0x1C == 0x0C
    x = e.push(C.rec(0, t0 + 600, f.step(), inflow=1600, level=5000))["result"]
    k_dl = CFG.get(f.row(), "K_CD") * (9200 - 5000)
    assert (x["CD_P10"], x["CD_P50"], x["CD_P90"]) == (cd_minutes(k_dl, 1600), cd_minutes(k_dl, 200), 0xFFFF)


# ------------------------------------------------------------------------------------------------ 5 R1
@check("R1: p50 tracks trips_at at all 13 practice pump-failure onsets (offline answer key)")
def _():
    key = json.load(open(os.path.join(DS.folder, "answer_key.json"), encoding="utf-8"))  # OFFLINE ONLY
    events = [e for e in key if e["category"] == "pump_failure"]
    assert len(events) == 13, len(events)
    slot = {f["id"]: f["slot"] for f in DS.facs}
    e = Engine()
    e.configure(DS.glb, DS.rows)
    res = {}
    for r in DS.records:
        d = e.push(r)["result"]
        res[(d["FAC_ID"], d["TS"])] = d
    worst = 0
    for ev in events:
        f = slot[ev["facility"]]
        d = res[(f, ev["onset_unix"])]
        assert d["STATUS"] == ST_VALID and d["RULES"] >> RULE["PUMP_FAULT"] & 1, ev["id"]
        p10, p50, p90 = d["CD_P10"], d["CD_P50"], d["CD_P90"]
        assert p10 <= p50 <= p90 < 0xFFFF, (ev["id"], p10, p50, p90)
        if ev.get("trips_at_unix"):
            t = ev["onset_unix"]
            while t < ev["trips_at_unix"] - 300:   # every step from onset to the trip
                d = res[(f, t)]
                truth = (ev["trips_at_unix"] - t) / 60
                err = abs(d["CD_P50"] - truth)
                worst = max(worst, err)
                assert err <= 10, (ev["id"], t, d["CD_P50"], truth)
                t += 300
            t = ev["trips_at_unix"] - ev["trips_at_unix"] % 300 + 300
            d = res[(f, t)]
            assert d["RULES"] >> RULE["LVL_SHUTDOWN"] & 1 and d["CD_P50"] == 0 == d["CD_P10"] == d["CD_P90"], ev["id"]
        else:
            assert p50 > (ev["end_unix"] - ev["onset_unix"]) / 60, (ev["id"], p50)  # no trip before the repair
    print("      worst |p50 - trips_at| over all steps before the trip: %.1f min" % worst)


# ------------------------------------------------------------------------------------------------ 6 invariants
RUNS = {}


def runs():
    if not RUNS:
        for c in C.synthetic_cases() + C.practice_cases():
            RUNS[c.name] = (c, GV.run_case(c))
    return RUNS


HDR_FIX = ("REC_NO", "IN_LAST", "FAC_RAW", "FAC", "TS", "STATUS", "SINCE_RESET", "HIST_RESET")


@check("invariants over every case (stage contract, DROPPED/INVALID, ranges, ordering)")
def _():
    for name, (case, r) in runs().items():
        track = {}
        for i, o in enumerate(r["recs"]):
            b = o["bus"]
            assert BUS["U"].get(b["U"], "REC_NO") == i, name
            prev = None
            for k in "VFMCLA":
                h = {n: BUS[k].get(b[k], n) for n in HDR_FIX}
                rs = BUS[k].get(b[k], "REASON")
                if prev:
                    assert h == prev[0] and rs & prev[1] == prev[1], (name, i, k)  # pass-through, OR-only
                prev = (h, rs)
            st = BUS["V"].get(b["V"], "STATUS")
            assert st in (ST_VALID, ST_HELD, ST_INVALID, ST_DROPPED)
            d = result_dict(o["res"])
            cd = (d["CD_P10"], d["CD_P50"], d["CD_P90"])
            feats = arr_unpack(BUS["M"].get(b["M"], "FEAT"), 31)
            f = BUS["V"].get(b["V"], "FAC")
            if st != ST_DROPPED and (BUS["V"].get(b["V"], "HIST_RESET") or f not in track):
                track[f] = {"g": [None] * 5, "n": None}
            if st == ST_DROPPED:   # TASKS #25: SINCE_RESET 0, WVER 0; one reason bit
                assert d["SINCE_RESET"] == 0 and BUS["V"].get(b["V"], "HIST_RESET") == 0
                assert bin(d["REASON"]).count("1") == 1 and d["RULES"] == 0 and d["WVER"] == 0
                assert d["LOGITS"] == [0] * 4 and cd == (0xFFFF,) * 3 and not any(feats) and not o["alerts"]
            elif st == ST_INVALID:
                assert d["LOGITS"] == [0] * 4 and cd == (0xFFFF,) * 3 and not any(feats) and d["RULES"] == 0
                assert d["REASON"] >> R["FIELD_LOST"] & 1 and not o["alerts"]
                assert not d["REASON"] & ((1 << R["PUMP_INCONS"]) | (1 << R["WELL_INCONS"]) | (1 << R["NO_MODEL"]))
            else:
                assert not d["REASON"] >> R["FIELD_LOST"] & 1
                assert (d["REASON"] >> R["NO_MODEL"] & 1) == (d["WVER"] == 0)
                assert (st == ST_HELD) == bool(d["REASON"] & ((1 << R["FIELD_HELD"]) | (1 << R["GAP_HELD"])))
                if 0xFFFF not in cd:
                    assert cd[0] <= cd[1] <= cd[2], (name, i, cd)
                # averages stay within the min/max of their inputs since the last reset (M2)
                t = track[f]
                if BUS["F"].get(b["F"], "PUMP_RUN"):
                    for j, c in enumerate((1, 2, 3, 5, 6)):
                        lo_hi = t["g"][j] or [feats[c], feats[c]]
                        t["g"][j] = [min(lo_hi[0], feats[c]), max(lo_hi[1], feats[c])]
                t["n"] = [min(t["n"][0], feats[11]), max(t["n"][1], feats[11])] if t["n"] else [feats[11]] * 2
                for j in range(5):
                    if t["g"][j]:
                        for x in (feats[17 + j], feats[22 + j]):
                            assert t["g"][j][0] <= x <= t["g"][j][1], (name, i, j, x, t["g"][j])
                assert t["n"][0] <= feats[27] <= t["n"][1], (name, i)
                assert feats[28] <= 16384 and feats[30] == min(d["SINCE_RESET"], 64) << 8
        for _i, src, a in r["alerts"]:
            x = AL.unpack(a)
            if src == "ack":
                assert x["KIND"] == AK["ACKED"] and x["TS"] == 0 and x["CD_P10"] == 0xFFFF


@check("hand-made weights fire each class and E-STOP on the practice week (offline answer key overlap)")
def _():
    case, r = runs()["week"]
    key = json.load(open(os.path.join(DS.folder, "answer_key.json"), encoding="utf-8"))  # OFFLINE ONLY
    slot = {f["id"]: f["slot"] for f in DS.facs}
    cls = {"pipeline_leak": 0, "pump_degradation": 1, "pump_failure": 2}
    fired = [0] * 4
    in_event = [0] * 3
    for o in r["recs"]:
        a = BUS["A"].get(o["bus"]["A"], "CLASSES")
        for k in range(4):
            fired[k] += a >> k & 1
    for ev in key:
        k = cls.get(ev["category"])
        if k is None:
            continue
        hit = any(BUS["A"].get(o["bus"]["A"], "CLASSES") >> k & 1 for o in r["recs"]
                  if BUS["A"].get(o["bus"]["A"], "FAC") == slot[ev["facility"]]
                  and ev["onset_unix"] <= BUS["A"].get(o["bus"]["A"], "TS") < ev["end_unix"])
        in_event[k] += hit
    es = sum(1 for _i, _s, a in r["alerts"] if AL.get(a, "KIND") == AK["ES_RAISED"])
    print("      class-active records:", fired, " events detected (leak, degradation, failure):", in_event,
          " E-STOP raises:", es)
    assert all(fired) and all(in_event) and es >= 1


# ------------------------------------------------------------------------------------------------ 7 vectors
@check("vectors: every module in spec/modules/ has files; LF only; matching line counts; up to date")
def _():
    vd = os.path.join(FPGA, "tb", "vectors")
    names = set(os.listdir(vd))
    mods = [m[4:-3] for m in os.listdir(os.path.join(FPGA, "spec", "modules")) if m.startswith("eog_")]
    for m in mods:
        assert any(n.startswith(m + "_") and n.endswith(".in.hex") for n in names), "no vectors for " + m
    for n in names:
        if n.endswith(".in.hex"):
            base = n[:-len(".in.hex")]
            if base.startswith("unpack_"):
                continue
            a = open(os.path.join(vd, n), "rb").read()
            b = open(os.path.join(vd, base + ".out.hex"), "rb").read()
            assert b"\r" not in a and b"\r" not in b, n
            assert a.count(b"\n") == b.count(b"\n"), n
    tmp = tempfile.mkdtemp(prefix="eog_vec_")
    try:
        GV.main(["--out", tmp])
        fresh = set(os.listdir(tmp))
        assert fresh == names - {".gitignore", ".gitattributes"}, sorted(fresh ^ names)
        for n in fresh:
            if open(os.path.join(tmp, n), "rb").read() != open(os.path.join(vd, n), "rb").read():
                raise AssertionError("stale vector file (rerun gen_vectors.py): " + n)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    print("\n%d passed, %d failed" % (len(PASSES), len(FAILS)))
    if FAILS:
        print("FAIL:", ", ".join(FAILS))
        sys.exit(1)
    print("PASS")
