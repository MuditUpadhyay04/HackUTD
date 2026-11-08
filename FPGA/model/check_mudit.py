"""Byte-for-byte agreement of eog_ref.Engine with Mudit's features_int.Engine (spec v4 + TASKS rulings 20-25, 70).

    python FPGA/model/check_mudit.py [--ml PATH] [--no-week] [--show N]

PATH is the `ml/` folder of a checkout of branch `ml` (the one holding `hutd_ml/` and `artifacts/`); default $EOG_ML,
else `ml/ml` next to this repository (`git worktree add ../ml origin/ml`; cases.ml_dir). Practice data: $EOG_DATA, as
for gen_vectors.py. Needs numpy (Mudit's code); pandas is not needed (a stub stands in for his encoder's import).
Mudit's code is the normative integer reference (spec v4 + Lucas's rulings on spec questions 20-25): a
disagreement is a spec question to raise, never something to "fix" by picking a side. Exception, by Lucas's ruling:
spec question #70 (R7 option C, Sun 02:03) changes the hold limit before Mudit's code has it (his task T0.5).

A. Spec v4 numerics.md §11 (Mudit's task T0.0), each probed on his engine with a small directed scenario:
   1 S = 17 and M < 2^32 in his encoder; 2 `review_r1r2` is the default countdown; 3 latched Night Shift / E-STOP
   with CLEARED per latch type, history resets keep the latches; 4 a nonzero reserved field is DROPPED `FRAMING`
   before the facility lookup; 5 per-class K from GLOBAL bytes 20-23; 7 golden sets regenerated (S = 17,
   review_r1r2). (§11.6, nsr saturation, has no observable output.)
R. Spec question #70 (R7 option C, Mudit's T0.5): probed on his engine. Until it lands, his engine runs with a
   stand-in for that one rule: at the hold-limit site of Engine.process his `reset_history()` call is skipped and
   the HIST_RESET bit it adds is cleared, which is exactly option C (held fields become missing -> INVALID with
   FIELD_LOST, last_valid kept, no reset). Every record where the stand-in acts is listed as a pre-T0.5 GAP; all
   other bytes must still agree. The stand-in switches itself off once the probe passes.
B. Ingest: ingest.py CONFIG rows and GLOBAL equal his encoder's; the practice DATA records equal his G1 data.bin.
C. Engines: every cases.py case, the practice week and every golden set's data.bin run through both engines from the
   same GLOBAL / CONFIG / weights; every RESULT (32 B) and every ALERT (16 B) is compared as bytes. FPGA-only inputs
   are left out for both engines alike: mid-stream events (CONFIG touch/rewrite, weight writes and swaps,
   acknowledge, heartbeat), records cut short by TLAST (FRAME_ERR) and AUTONOMOUS (GLOBAL HB_TIMEOUT_MS = 0).
D. Golden: his unmodified engine reproduces each golden set's expected_results.bin / expected_alerts.json (sanity),
   and so does eog_ref; before T0.5 a set may differ from its first hold-limit record on (reported as a GAP).

Exit status: 0 everything agrees; 1 a disagreement (a spec question: report it, don't pick a side); 2 only known
gaps (§11 before T0.0, R7 before T0.5).
"""
import argparse
import glob
import inspect
import json
import os
import random
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cases as C  # noqa: E402
import ingest as I  # noqa: E402
from eog_ref import Engine, decode_weights, encode_weights  # noqa: E402
from layouts import AL, BU, CFG, G, N_FAC, N_FEAT, N_WELL, R, RES  # noqa: E402

FAILS = {"gap": [], "agree": []}
R7 = {"shim": False, "hit": False}  # pre-T0.5 stand-in for spec question #70 on Mudit's side (see R. above)


def import_ml(path):
    try:
        import pandas  # noqa: F401
    except ImportError:  # his encode.py imports pandas at the top; nothing used here needs it
        sys.modules["pandas"] = types.ModuleType("pandas")
    sys.path.insert(0, path)
    from hutd_ml import encode, features_int, model_int, wire
    install_r7_shim(features_int)
    return types.SimpleNamespace(fi=features_int, wire=wire, encode=encode, model_int=model_int)


def install_r7_shim(fi):
    """Wrap _Fac.reset_history: while R7["shim"] is on, a call from the hold-limit site of Engine.process
    (`if st.hold_run > self.hold_max: st.reset_history()`) is skipped and flagged. Every other call runs as is."""
    import linecache
    orig = fi._Fac.reset_history

    def reset_history(self):
        if R7["shim"]:
            fr = sys._getframe(1)
            if fr.f_code.co_name == "process" and \
                    "st.hold_run > self.hold_max" in linecache.getline(fr.f_code.co_filename, fr.f_lineno - 1):
                R7["hit"] = True
                return
        orig(self)
    fi._Fac.reset_history = reset_history


def report(kind, name, ok, msg=""):
    print("%s %-58s %s" % ("ok  " if ok else ("GAP " if kind == "gap" else "FAIL"), name, msg))
    if not ok:
        FAILS[kind].append(name)
    return ok


# ------------------------------------------------------------------------------------------------ the two engines
class Ours:
    def __init__(self, glb, rows, img):
        self.e = Engine()
        self.e.configure(glb, rows)
        self.e.load_weights(img)
        self.e.swap()
        self.e.heartbeat()

    def process(self, rec):
        o = self.e.push(rec)
        return o["result_bytes"], [a.to_bytes(16, "little") for a in o["alerts"]]


class Theirs:
    """features_int.Engine fed the GLOBAL as eog_regs presents it (byte 0 = 17, byte 2 = 4), the CONFIG rows of
    all 32 slots (FAC_ID = slot; N_WELLS clamped to 8 as the RTL does, TASKS #14) and the active weight bank."""

    def __init__(self, ml, glb, rows, img):
        import numpy as np
        self.np, self.ml = np, ml
        e = Engine()
        e.set_glb(glb)
        g = np.frombuffer(e.glb.to_bytes(32, "little"), dtype=ml.wire.GLOBAL_CONFIG_DTYPE).copy()
        cfg = np.zeros(N_FAC, dtype=ml.wire.FAC_CONFIG_DTYPE)
        self.clamped = 0
        for f, row in rows.items():
            r = CFG.put(I_as_int(row, 64), "FAC_ID", f)
            if CFG.get(r, "N_WELLS") > N_WELL:
                r = CFG.put(r, "N_WELLS", N_WELL)
                self.clamped += 1
            cfg[f] = np.frombuffer(r.to_bytes(64, "little"), dtype=ml.wire.FAC_CONFIG_DTYPE)[0]
        w, b, s_out, ver = decode_weights(img)
        self.eng = ml.fi.Engine(g, cfg, ml.fi.Weights(w=w, b=b, s_out=s_out, version=ver))
        self.n = 0
        self.r7_hits = []  # record indices where the pre-T0.5 R7 stand-in acted

    def process(self, rec):
        np, wire = self.np, self.ml.wire
        r = np.frombuffer(I_as_int(rec, 48).to_bytes(48, "little"), dtype=wire.DATA_DTYPE)[0]
        R7["hit"] = False
        res, _stg, alerts = self.eng.process(r)
        if R7["hit"]:  # option C: the hold limit makes the record INVALID without a history reset
            res = dict(res, reason=res["reason"] & ~wire.R_RESET)
            self.r7_hits.append(self.n)
        self.n += 1
        o = np.zeros(1, dtype=wire.RESULT_DTYPE)[0]
        for k in ("fac_id", "status", "since_reset", "ts_unix", "reason", "rules", "weights_ver", "result_no"):
            o[k] = res[k]
        o["logits"], o["countdown"] = res["logits"], res["countdown"]
        out = []
        for a in alerts:
            x = np.zeros(1, dtype=wire.ALERT_DTYPE)[0]
            for k in wire.ALERT_DTYPE.names:
                x[k] = a[k]
            out.append(x.tobytes())
        return o.tobytes(), out


def rel(d, root):
    return os.path.relpath(d, root).replace(os.sep, "/")


def I_as_int(x, n):
    return int.from_bytes(x, "little") if isinstance(x, (bytes, bytearray)) else x


def diff_fields(a, b, lay):
    x, y = lay.unpack(int.from_bytes(a, "little")), lay.unpack(int.from_bytes(b, "little"))
    return {k: (x[k], y[k]) for k in lay.order if x[k] != y[k]}


def compare(ml, name, glb, rows, img, records, show):
    """Both engines over the same records. Returns the R7 stand-in's record indices (pre-T0.5 gap)."""
    a, b = Ours(glb, rows, img), Theirs(ml, glb, rows, img)
    n_res = n_al = same_al = 0
    bad = []
    for i, rec in enumerate(records):
        ra, aa = a.process(rec)
        rb, ab = b.process(rec)
        n_al += max(len(aa), len(ab))
        same_al += sum(x == y for x, y in zip(aa, ab))
        if ra == rb:
            n_res += 1
        else:
            bad.append((i, "RESULT", diff_fields(ra, rb, RES)))
        if aa != ab:
            bad.append((i, "ALERTS", {"eog_ref": [AL.unpack(int.from_bytes(x, "little")) for x in aa],
                                      "features_int": [AL.unpack(int.from_bytes(x, "little")) for x in ab]}))
    ok = not bad
    note = "" if not b.clamped else " (N_WELLS > 8 clamped on %d rows, TASKS #14)" % b.clamped
    report("agree", "engines agree: " + name, ok, "RESULT %d/%d, ALERT %d/%d%s" % (n_res, len(records), same_al,
                                                                                 n_al, note))
    for i, what, d in bad[:show]:
        print("       record %d %s (eog_ref, features_int): %s" % (i, what, d))
    if b.r7_hits:
        report("gap", "R7 pre-T0.5: " + name, False, "%d hold-limit record(s): %s" % (
            len(b.r7_hits), " ".join(map(str, b.r7_hits[:12])) + (" ..." if len(b.r7_hits) > 12 else "")))
    return b.r7_hits


# ------------------------------------------------------------------------------------------------ cases
def case_records(case):
    """The case's DATA records in order, without FPGA-only content (events, records cut short by TLAST)."""
    out = []
    e = Engine()
    for st in case.steps:
        if st[0] == "rec":
            out.append(st[1])
        elif st[0] == "beats":
            for data, last in st[1]:
                u = e.unpack_beat(data, last)
                if u is not None and not BU.get(u, "FRAME_ERR"):
                    out.append(BU.get(u, "REC"))
    return out


def no_hb(glb):
    return G.put(I_as_int(glb, 32), "HB_TIMEOUT_MS", 0)


def golden_sets(mlp):
    out = []
    for d in sorted(glob.glob(os.path.join(mlp, "artifacts", "*", "golden", "*"))):
        if os.path.exists(os.path.join(d, "data.bin")) and os.path.exists(os.path.join(d, "expected_results.bin")):
            out.append(d)
    return out


def load_golden(d):
    """cases.load_golden plus the expected RESULT bytes and ALERT dicts."""
    exp = open(os.path.join(d, "expected_results.bin"), "rb").read()
    alerts = json.load(open(os.path.join(d, "expected_alerts.json"), encoding="utf-8"))
    return C.load_golden(d) + (exp, alerts)


# ------------------------------------------------------------------------------------------------ §11 probes
def probe_world():
    rng = random.Random(7)
    f = C.SimFac(0, 2400, 3600, 3, 1200, 1050, rng, 55)
    f.running = True
    return f, {0: f.row()}


def bias_weights(cls_on, ver=7):
    """W = 0; class k's logit saturates high if k in cls_on, else low."""
    b = [(1 << 30) if k in cls_on else -(1 << 30) for k in range(4)]
    return encode_weights([[0] * N_FEAT for _ in range(4)], b, 8, ver)


def run_both(ml, glb, rows, img, recs):
    a, b = Ours(glb, rows, img), Theirs(ml, glb, rows, img)
    return [a.process(r) for r in recs], [b.process(r) for r in recs]


def alert_kinds(outs):
    return [[(AL.get(int.from_bytes(x, "little"), "KIND"), AL.get(int.from_bytes(x, "little"), "SOURCE"))
             for x in al] for _r, al in outs]


def r7_probe(ml):
    """Spec question #70 on his unmodified engine: HOLD_MAX 2 and 1, a held field for 3 records, then clean."""
    R7["shim"] = False
    ok, got = True, []
    for hold in (2, 1):
        f, rows = probe_world()
        recs = [C.rec(0, C.TS0, f.step())] + [C.rec(0, C.TS0 + 300 * k, f.step(), absent=[0]) for k in (1, 2, 3)]
        recs += [C.rec(0, C.TS0 + 1200, f.step(), present=0), C.rec(0, C.TS0 + 1500, f.step())]
        a, b = run_both(ml, no_hb(I.global_record(HOLD_MAX=hold)), rows, [0] * 71, recs)
        ok &= [r for r, _al in a] == [r for r, _al in b]
        got.append([(x["STATUS"], x["SINCE_RESET"], int(x["REASON"] >> R["HIST_RESET"] & 1)) for x in
                    (RES.unpack(int.from_bytes(r, "little")) for r, _al in b)])
    report("gap", "R7 (#70) hold limit -> INVALID, no history reset", ok,
           "features_int (status, since_reset, HIST_RESET) per record, HOLD_MAX 2 then 1: %s" % got)
    R7["shim"] = not ok
    if not ok:
        print("       -> T0.5 not landed: his engine runs with the R7 stand-in; every record it touches is a GAP")


def spec11(ml, mlp, goldens):
    fi, enc = ml.fi, ml.encode
    report("gap", "spec 11.1 S = 17 in the encoder, multipliers < 2^32",
           getattr(enc, "DEFAULT_S_FEAT", None) == 17 and getattr(enc, "MAX_MULT_BITS", 0) >= 32,
           "DEFAULT_S_FEAT %s, MAX_MULT_BITS %s" % (getattr(enc, "DEFAULT_S_FEAT", None),
                                                    getattr(enc, "MAX_MULT_BITS", None)))
    par = inspect.signature(fi.Engine.__init__).parameters.get("countdown")
    report("gap", "spec 11.2 countdown review_r1r2 is the default", par is None or par.default == "review_r1r2",
           "default %r" % (par.default if par else None))
    # 3 latched Night Shift / E-STOP
    f, rows = probe_world()
    glb = no_hb(I.global_record(PERSIST_K=1, LOGIT_THR=(0, 0, 0, 0), GAP_THR=492))
    ts = C.TS0
    recs = []
    for k, mut in enumerate([dict(pump_st=2), {}, dict(pump_st=2), {}]):     # rule NS: raise, clear, (latched)
        recs.append(C.rec(0, ts + 300 * k, f.step(), **mut))
    recs.append(C.rec(0, ts + 300 * 4 + 3600, f.step(), pump_st=2))           # history reset: latch survives
    a, b = run_both(ml, glb, rows, [0] * 71, recs)
    got = alert_kinds(b)
    report("gap", "spec 11.3 Night Shift latched; CLEARED source 0; reset keeps it",
           got == [[(1, 1)], [(3, 0)], [], [(3, 0)], []], "features_int alerts per record (kind, source): %s" % got)
    f, rows = probe_world()
    glb = no_hb(I.global_record(PERSIST_K=1, LOGIT_THR=(0, 0, 0, 0), GAP_THR=492))
    img = bias_weights({0})
    recs = []
    for k, gap in enumerate([True, False, True]):
        d = f.step()
        recs.append(C.rec(0, ts + 300 * k, d, pump_flow=7200, recv_flow=6000 if gap else 7200, pump_st=1))
    a, b = run_both(ml, glb, rows, img, recs)
    got = alert_kinds(b)
    report("gap", "spec 11.3 E-STOP latched; CLEARED with SOURCE bit 4", got == [[(1, 2), (2, 19)], [(3, 16)], []],
           "features_int alerts per record (kind, source): %s" % got)
    # 4 FRAMING before the lookup
    f, rows = probe_world()
    recs = [C.rec(0, ts, f.step()), C.rec(40, ts + 300, f.step(), rsv0=2), C.rec(0, ts + 300, f.step(), rsv1=1)]
    a, b = run_both(ml, no_hb(I.global_record()), rows, [0] * 71, recs)
    got = [RES.unpack(int.from_bytes(r, "little")) for r, _al in b[1:]]
    report("gap", "spec 11.4 reserved field -> DROPPED FRAMING before the lookup",
           all(x["STATUS"] == 4 and x["REASON"] == 1 << R["FRAMING"] and x["SINCE_RESET"] == 0 for x in got),
           "status/reason %s" % [(x["STATUS"], hex(x["REASON"])) for x in got])
    # 5 per-class K from bytes 20-23, byte 3 fallback (and K = max(K, 1))
    f, rows = probe_world()
    glb = no_hb(I.global_record(PERSIST_K=0, PERSIST_K4=(0, 3, 0, 0), LOGIT_THR=(0, 0, 0, 0)))
    recs = [C.rec(0, ts + 300 * k, f.step(), pump_st=1) for k in range(4)]
    a, b = run_both(ml, glb, rows, bias_weights({1}), recs)
    got = [[(AL.get(int.from_bytes(x, "little"), "KIND"), AL.get(int.from_bytes(x, "little"), "CLASSES"))
            for x in al] for _r, al in b]
    report("gap", "spec 11.5 per-class K (K4 = 0,3,0,0, byte 3 = 0 -> K = 1,3,1,1)", got == [[], [], [(1, 2)], []],
           "features_int (kind, classes) per record: %s" % got)
    # 7 golden sets regenerated under v4
    bad = []
    for d in goldens:
        man = json.load(open(os.path.join(d, "manifest.json"), encoding="utf-8"))
        g = open(os.path.join(d, "global_config.bin"), "rb").read()
        if g[0] != 17 or man.get("countdown") != "review_r1r2" or g[2] != 4:
            bad.append(rel(d, mlp))
    report("gap", "spec 11.7 golden sets regenerated (S = 17, CD_LOG2 4, review_r1r2)", not bad and bool(goldens),
           "%d sets%s" % (len(goldens), "; stale: " + ", ".join(bad) if bad else ""))


# ------------------------------------------------------------------------------------------------ ingest
def ingest_checks(ml, mlp, goldens):
    try:
        folder = I.dataset_dir()
    except FileNotFoundError as e:
        report("agree", "ingest (practice data)", False, str(e))
        return None
    net = json.load(open(os.path.join(folder, "network.json"), encoding="utf-8"))
    rows = I.config_rows(I.facilities(net))
    facs = ml.encode.facilities_from_network(net)
    his = ml.encode.build_facility_config(facs, net)
    mine = b"".join(rows[f].to_bytes(64, "little") for f in sorted(rows))
    report("agree", "ingest CONFIG rows == encode.build_facility_config", mine == his.tobytes(),
           "%d rows" % len(rows))
    g = ml.encode.build_global_config().tobytes()
    report("agree", "ingest GLOBAL == encode.build_global_config", I.global_record().to_bytes(32, "little") == g)
    for d in goldens:
        fc = open(os.path.join(d, "facility_config.bin"), "rb").read()
        report("agree", "ingest CONFIG == %s/facility_config.bin" % rel(d, mlp), fc == mine)
    g1 = [d for d in goldens if os.path.basename(d) == "g1"]
    ds = C.practice()
    if g1:
        data = open(os.path.join(g1[0], "data.bin"), "rb").read()
        ours = b"".join(ds.record_bytes())
        nbad = sum(data[i:i + 48] != ours[i:i + 48] for i in range(0, min(len(data), len(ours)), 48))
        report("agree", "ingest DATA (practice week) == %s/data.bin" % rel(g1[0], mlp),
               len(data) == len(ours) and nbad == 0, "%d records, %d differ" % (len(ours) // 48, nbad))
    return ds


# ------------------------------------------------------------------------------------------------ golden
GOLDEN_AL_KEY = (("FAC_ID", "fac_id"), ("KIND", "kind"), ("SOURCE", "source"), ("TS", "ts_unix"),
                 ("RESULT_NO", "result_no"), ("RULES", "rules"), ("CLASSES", "classes"), ("CD_P10", "countdown_p10"))


def vs_expected(eng, recs, exp, exp_al):
    """(RESULT bytes, first mismatching record or None, records equal, alerts equal, alerts) of one engine."""
    got, al = [], []
    for i, r in enumerate(recs):
        rb, ab = eng.process(r)
        got.append(rb)
        al += [(i, AL.unpack(int.from_bytes(x, "little"))) for x in ab]
    bad = [i for i in range(len(recs)) if got[i] != exp[32 * i:32 * i + 32]]
    want = [tuple(int(x[k]) for _K, k in GOLDEN_AL_KEY) for x in exp_al]
    have = [tuple(x[K] for K, _k in GOLDEN_AL_KEY) for _i, x in al]
    al_same = sum(x == y for x, y in zip(want, have))
    first_al = next((i for k, (i, _x) in enumerate(al) if k >= len(want) or have[k] != want[k]), None)
    if first_al is None and len(want) > len(have):
        first_al = len(recs)
    first = min([x for x in (bad[0] if bad else None, first_al) if x is not None], default=None)
    ok = not bad and len(exp) == 32 * len(recs) and want == have
    return got, first, ok, len(recs) - len(bad), al_same, max(len(want), len(have))


def golden_checks(ml, mlp, goldens, show):
    for d in goldens:
        name = rel(d, mlp)
        man, glb, rows, img, recs, exp, exp_al = load_golden(d)
        hits = compare(ml, "golden " + name, glb, rows, img, recs, show)
        shim, R7["shim"] = R7["shim"], False
        _g, first, ok, nr, na, nal = vs_expected(Theirs(ml, glb, rows, img), recs, exp, exp_al)
        R7["shim"] = shim
        report("agree", "features_int == expected_results/alerts: " + name, ok,
               "RESULT %d/%d, ALERT %d/%d (sanity: his unmodified engine)" % (nr, len(recs), na, nal))
        got, first, ok, nr, na, nal = vs_expected(Ours(glb, rows, img), recs, exp, exp_al)
        msg = "RESULT %d/%d, ALERT %d/%d" % (nr, len(recs), na, nal)
        if not ok and hits and first == hits[0]:
            report("gap", "R7 pre-T0.5: eog_ref == expected_results/alerts: " + name, False,
                   msg + "; first difference at record %d = its first hold-limit record" % first)
            continue
        report("agree", "eog_ref == expected_results/alerts: " + name, ok, msg)
        if not ok:
            for i in [i for i in range(len(recs)) if got[i] != exp[32 * i:32 * i + 32]][:show]:
                print("       record %d (eog_ref, expected): %s" % (i, diff_fields(got[i], exp[32 * i:32 * i + 32],
                                                                                RES)))


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ml", help="Mudit's ml/ folder (default $EOG_ML or ml/ml next to this repo)")
    ap.add_argument("--no-week", action="store_true", help="skip the 30,240-record practice-week engine runs")
    ap.add_argument("--show", type=int, default=5, help="mismatches to print per comparison")
    a = ap.parse_args(argv)
    mlp = C.ml_dir(a.ml)
    ml = import_ml(mlp)
    print("Mudit's code:", mlp)
    goldens = golden_sets(mlp)
    print("-- A. spec v4 numerics.md section 11 (T0.0)")
    spec11(ml, mlp, goldens)
    print("-- R. spec question #70, R7 option C (T0.5)")
    r7_probe(ml)
    print("-- B. ingest vs encode.py")
    ds = ingest_checks(ml, mlp, goldens)
    print("-- C. engines on every case (FPGA-only events, FRAME_ERR records and AUTONOMOUS left out)")
    for case in C.synthetic_cases() + (C.practice_cases() if ds is not None else []):
        if a.no_week and case.name == "week":
            continue
        compare(ml, "case " + case.name, no_hb(case.glb), case.rows, case.wts, case_records(case), a.show)
    print("-- C/D. golden sets")
    golden_checks(ml, mlp, [d for d in goldens if not (a.no_week and os.path.basename(d) == "g1")], a.show)
    print()
    if FAILS["agree"]:
        print("FAIL: %d disagreement(s) (spec questions): %s" % (len(FAILS["agree"]), "; ".join(FAILS["agree"])))
    if FAILS["gap"]:
        print("GAP: %d known gap(s) (section 11 before T0.0, R7 before T0.5): %s" % (len(FAILS["gap"]),
                                                                                    "; ".join(FAILS["gap"])))
    if not FAILS["agree"] and not FAILS["gap"]:
        print("PASS")
    return 1 if FAILS["agree"] else 2 if FAILS["gap"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
