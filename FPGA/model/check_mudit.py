"""Byte-for-byte agreement of eog_ref.Engine with Mudit's features_int.Engine (spec v4 + TASKS rulings 20-25).

    python FPGA/model/check_mudit.py [--ml PATH] [--no-week] [--show N]

PATH is the `ml/` folder of a checkout of branch `ml` (the one holding `hutd_ml/` and `artifacts/`); default $EOG_ML,
else `ml/ml` next to this repository (`git worktree add ../ml origin/ml`). Practice data: $EOG_DATA, as for
gen_vectors.py. Needs numpy (Mudit's code); pandas is not needed (a stub stands in for his encoder's import).

A. Spec v4 numerics.md §11 (Mudit's task T0.0), each probed on his engine with a small directed scenario:
   1 S = 17 and M < 2^32 in his encoder; 2 `review_r1r2` is the default countdown; 3 latched Night Shift / E-STOP
   with CLEARED per latch type, history resets keep the latches; 4 a nonzero reserved field is DROPPED `FRAMING`
   before the facility lookup; 5 per-class K from GLOBAL bytes 20-23; 7 golden sets regenerated (S = 17,
   review_r1r2). (§11.6, nsr saturation, has no observable output.)
B. Ingest: ingest.py CONFIG rows and GLOBAL equal his encoder's; the practice DATA records equal his G1 data.bin.
C. Engines: every cases.py case, the practice week and every golden set's data.bin run through both engines from the
   same GLOBAL / CONFIG / weights; every RESULT (32 B) and every ALERT (16 B) is compared as bytes. FPGA-only inputs
   are left out for both engines alike: mid-stream events (CONFIG touch/rewrite, weight writes and swaps,
   acknowledge, heartbeat), records cut short by TLAST (FRAME_ERR) and AUTONOMOUS (GLOBAL HB_TIMEOUT_MS = 0).
D. Golden: eog_ref reproduces each golden set's expected_results.bin and expected_alerts.json byte for byte.

Exit status: 0 everything agrees; 1 a disagreement (a spec question: report it, don't pick a side); 2 only §11
checks fail (T0.0 not landed).
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
from eog_ref import Engine, decode_weights, encode_weights, window_from_blob  # noqa: E402
from layouts import AL, BU, CFG, D, G, N_FAC, N_WELL, R, RES, N_FEAT, arr_unpack  # noqa: E402

FAILS = {"spec11": [], "agree": []}


def ml_dir(arg):
    cands = [arg] if arg else []
    if os.environ.get("EOG_ML"):
        cands.append(os.environ["EOG_ML"])
    for up in ("../../..", "../../../..", "../../../../..", "../../../../../.."):
        cands += [os.path.join(HERE, up, "ml", "ml"), os.path.join(HERE, up, "ml")]
    for c in cands:
        if c and os.path.exists(os.path.join(c, "hutd_ml", "features_int.py")):
            return os.path.normpath(c)
    raise FileNotFoundError("Mudit's ml/ folder not found: pass --ml or set EOG_ML (git worktree add ../ml origin/ml)")


def import_ml(path):
    try:
        import pandas  # noqa: F401
    except ImportError:  # his encode.py imports pandas at the top; nothing used here needs it
        sys.modules["pandas"] = types.ModuleType("pandas")
    sys.path.insert(0, path)
    from hutd_ml import encode, features_int, model_int, wire
    return types.SimpleNamespace(fi=features_int, wire=wire, encode=encode, model_int=model_int)


def report(kind, name, ok, msg=""):
    print("%s %-58s %s" % ("ok  " if ok else ("GAP " if kind == "spec11" else "FAIL"), name, msg))
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

    def process(self, rec):
        np, wire = self.np, self.ml.wire
        r = np.frombuffer(I_as_int(rec, 48).to_bytes(48, "little"), dtype=wire.DATA_DTYPE)[0]
        res, _stg, alerts = self.eng.process(r)
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
    """Both engines over the same records. Returns (results equal, records, alerts equal, alerts)."""
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
    return n_res, len(records), same_al, n_al


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
    man = json.load(open(os.path.join(d, "manifest.json"), encoding="utf-8"))
    glb = open(os.path.join(d, "global_config.bin"), "rb").read()
    fc = open(os.path.join(d, "facility_config.bin"), "rb").read()
    rows = {int.from_bytes(fc[64 * i:64 * i + 2], "little"): fc[64 * i:64 * i + 64] for i in range(len(fc) // 64)}
    wp = os.path.join(d, "weights.bin")
    img = window_from_blob(open(wp, "rb").read(), man.get("weights_version", 0)) if os.path.exists(wp) else [0] * 71
    data = open(os.path.join(d, "data.bin"), "rb").read()
    recs = [data[48 * i:48 * i + 48] for i in range(len(data) // 48)]
    exp = open(os.path.join(d, "expected_results.bin"), "rb").read()
    alerts = json.load(open(os.path.join(d, "expected_alerts.json"), encoding="utf-8"))
    return man, glb, rows, img, recs, exp, alerts


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


def spec11(ml, mlp, goldens):
    fi, enc = ml.fi, ml.encode
    report("spec11", "spec 11.1 S = 17 in the encoder, multipliers < 2^32",
           getattr(enc, "DEFAULT_S_FEAT", None) == 17 and getattr(enc, "MAX_MULT_BITS", 0) >= 32,
           "DEFAULT_S_FEAT %s, MAX_MULT_BITS %s" % (getattr(enc, "DEFAULT_S_FEAT", None),
                                                    getattr(enc, "MAX_MULT_BITS", None)))
    par = inspect.signature(fi.Engine.__init__).parameters.get("countdown")
    report("spec11", "spec 11.2 countdown review_r1r2 is the default", par is None or par.default == "review_r1r2",
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
    report("spec11", "spec 11.3 Night Shift latched; CLEARED source 0; reset keeps it",
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
    report("spec11", "spec 11.3 E-STOP latched; CLEARED with SOURCE bit 4", got == [[(1, 2), (2, 19)], [(3, 16)], []],
           "features_int alerts per record (kind, source): %s" % got)
    # 4 FRAMING before the lookup
    f, rows = probe_world()
    recs = [C.rec(0, ts, f.step()), C.rec(40, ts + 300, f.step(), rsv0=2), C.rec(0, ts + 300, f.step(), rsv1=1)]
    a, b = run_both(ml, no_hb(I.global_record()), rows, [0] * 71, recs)
    got = [RES.unpack(int.from_bytes(r, "little")) for r, _al in b[1:]]
    report("spec11", "spec 11.4 reserved field -> DROPPED FRAMING before the lookup",
           all(x["STATUS"] == 4 and x["REASON"] == 1 << R["FRAMING"] and x["SINCE_RESET"] == 0 for x in got),
           "status/reason %s" % [(x["STATUS"], hex(x["REASON"])) for x in got])
    # 5 per-class K from bytes 20-23, byte 3 fallback (and K = max(K, 1))
    f, rows = probe_world()
    glb = no_hb(I.global_record(PERSIST_K=0, PERSIST_K4=(0, 3, 0, 0), LOGIT_THR=(0, 0, 0, 0)))
    recs = [C.rec(0, ts + 300 * k, f.step(), pump_st=1) for k in range(4)]
    a, b = run_both(ml, glb, rows, bias_weights({1}), recs)
    got = [[(AL.get(int.from_bytes(x, "little"), "KIND"), AL.get(int.from_bytes(x, "little"), "CLASSES"))
            for x in al] for _r, al in b]
    report("spec11", "spec 11.5 per-class K (K4 = 0,3,0,0, byte 3 = 0 -> K = 1,3,1,1)", got == [[], [], [(1, 2)], []],
           "features_int (kind, classes) per record: %s" % got)
    # 7 golden sets regenerated under v4
    bad = []
    for d in goldens:
        man = json.load(open(os.path.join(d, "manifest.json"), encoding="utf-8"))
        g = open(os.path.join(d, "global_config.bin"), "rb").read()
        if g[0] != 17 or man.get("countdown") != "review_r1r2" or g[2] != 4:
            bad.append(rel(d, mlp))
    report("spec11", "spec 11.7 golden sets regenerated (S = 17, CD_LOG2 4, review_r1r2)", not bad and bool(goldens),
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
def golden_checks(ml, mlp, goldens, show):
    counts = {}
    for d in goldens:
        name = rel(d, mlp)
        man, glb, rows, img, recs, exp, exp_al = load_golden(d)
        counts[name] = compare(ml, "golden " + name, glb, rows, img, recs, show)
        a = Ours(glb, rows, img)
        got, al = [], []
        for r in recs:
            rb, ab = a.process(r)
            got.append(rb)
            al += [AL.unpack(int.from_bytes(x, "little")) for x in ab]
        nbad = sum(got[i] != exp[32 * i:32 * i + 32] for i in range(len(recs)))
        key = (("FAC_ID", "fac_id"), ("KIND", "kind"), ("SOURCE", "source"), ("TS", "ts_unix"),
               ("RESULT_NO", "result_no"), ("RULES", "rules"), ("CLASSES", "classes"), ("CD_P10", "countdown_p10"))
        want = [tuple(int(x[k]) for _K, k in key) for x in exp_al]
        have = [tuple(x[K] for K, _k in key) for x in al]
        ok = nbad == 0 and len(exp) == 32 * len(recs) and want == have
        report("agree", "eog_ref == expected_results/alerts: " + name, ok,
               "RESULT %d/%d, ALERT %d/%d" % (len(recs) - nbad, len(recs), sum(x == y for x, y in zip(want, have)),
                                              max(len(want), len(have))))
        if not ok:
            for i in [i for i in range(len(recs)) if got[i] != exp[32 * i:32 * i + 32]][:show]:
                print("       record %d (eog_ref, expected): %s" % (i, diff_fields(got[i], exp[32 * i:32 * i + 32],
                                                                                RES)))
    return counts


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ml", help="Mudit's ml/ folder (default $EOG_ML or ml/ml next to this repo)")
    ap.add_argument("--no-week", action="store_true", help="skip the 30,240-record practice-week engine runs")
    ap.add_argument("--show", type=int, default=5, help="mismatches to print per comparison")
    a = ap.parse_args(argv)
    mlp = ml_dir(a.ml)
    ml = import_ml(mlp)
    print("Mudit's code:", mlp)
    goldens = golden_sets(mlp)
    print("-- A. spec v4 numerics.md section 11 (T0.0)")
    spec11(ml, mlp, goldens)
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
    if FAILS["spec11"]:
        print("GAP: %d section-11 check(s) fail (T0.0): %s" % (len(FAILS["spec11"]), "; ".join(FAILS["spec11"])))
    if not FAILS["agree"] and not FAILS["spec11"]:
        print("PASS")
    return 1 if FAILS["agree"] else 2 if FAILS["spec11"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
