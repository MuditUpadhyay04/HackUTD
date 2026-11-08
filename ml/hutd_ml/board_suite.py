"""One command for the whole board test suite with weights v4: golden sets plus the live demo path, each with a verdict.

    python -m hutd_ml.board_suite --data <full_week> [--reset-cmd "<re-program command>"] [--out <folder>]
    python -m hutd_ml.board_suite --data <full_week> --fakeboard          # rehearsal on the software board

Tests (default order; --only / --skip pick by id):

  B1  golden v4 g0 + four rejected weight blobs (CRC, length, header, self-test)      board.py
  B2  golden v4 g2: 41 validation edge cases                                           board.py
  B3  golden v4 g1: the full week, every RESULT field and all 71 ALERTs                 board.py
  B5  golden v0 g0 + g2: untrained full-range weights (saturation path)               board.py
  B6  golden v2 g1: a second trained model, 130 ALERTs                                  board.py
  L1  live, the real demo tools: replay.py (v4) -> board -> listen.py, full week. Every RESULT in the JSON
      (status, reasons, since_reset, logits, rules, countdown, weights_ver, order), every `active` flag and every
      ALERT must equal an offline run of features_int.py on the same records.
  L2  live weight swap v3 -> v4 at step 1029 with --swap-config, checked the same way (the offline run swaps
      weights and GLOBAL at the same step)
  L3  every other dataset folder next to --data (mock_test_*, snapshot_*), live with v4, checked the same way
  B4  (only with --with-b4) golden v4 g1 --heartbeat-test 6: known issue on the board, see FPGA/reports
  T1  (only with --throughput) v4 g1 unpaced: records/s and completeness, reported as a measurement

Fresh board: alarm latches survive CONFIG writes, so ALERTs are compared only on a freshly started board. Before each
test the suite runs --reset-cmd (and waits for ping), or asks you to reset (--prompt-reset), or, with --fakeboard,
starts a new software board. Without any of these, only the first test compares ALERTs; RESULTs are always compared.

Writes <out>/report.md, <out>/report.json and one log per test. Exit code 0 when every test that ran passed.
"""
import argparse
import json
import platform
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

from . import encode, features_int as fi, listen, model_int, wire

ML = Path(__file__).resolve().parents[1]
ART = ML / "artifacts"
CFG_KEYS = ("persist_k", "logit_thr", "gap_thr", "s_feat", "persist_k_per_class")
GOLDEN = {"B1": [("v4", "g0", ["--weights-negative"])], "B2": [("v4", "g2", [])], "B3": [("v4", "g1", [])],
          "B5": [("v0", "g0", []), ("v0", "g2", [])], "B6": [("v2", "g1", [])],
          "B4": [("v4", "g1", ["--heartbeat-test", "6"])], "T1": [("v4", "g1", ["--skip-alerts"])]}
DEFAULT = ["B1", "B2", "B3", "B5", "B6", "L1", "L2", "L3"]


class Bench:
    """Where the board is and how to give each test a fresh one."""

    def __init__(self, a, out):
        self.a, self.out, self.fb, self.n = a, out, None, 0
        self.board, self.local = ("127.0.0.2", "127.0.0.1") if a.fakeboard else (a.board, a.local)

    def fresh(self, name):
        """Returns True when the board is freshly started (ALERTs comparable)."""
        self.n += 1
        if self.a.fakeboard:
            self.stop()
            log = open(self.out / f"{name}_fakeboard.log", "w")
            self.fb = subprocess.Popen([sys.executable, "-m", "hutd_ml.fakeboard"], cwd=ML, stdout=log, stderr=log)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not (self.out / f"{name}_fakeboard.log").stat().st_size:
                time.sleep(0.1)
            return True
        if self.a.reset_cmd:
            print(f"  re-programming: {self.a.reset_cmd}", flush=True)
            subprocess.run(self.a.reset_cmd, shell=True, cwd=ML)
            time.sleep(8)
            self.wait_ping()
            time.sleep(5)
            return True
        if self.a.prompt_reset:
            input(f"  reset or re-program the board for {name}, then press Enter ")
            self.wait_ping()
            return True
        return self.n == 1

    def wait_ping(self, tries=60):
        cmd = (["ping", "-n", "1", "-w", "1000", self.board] if platform.system() == "Windows"
               else ["ping", "-c", "1", "-W", "1", self.board])
        for _ in range(tries):
            if subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                return
            time.sleep(1)
        print("  warning: the board does not answer ping", flush=True)

    def stop(self):
        if self.fb:
            self.fb.terminate()
            self.fb.wait(timeout=10)
            self.fb = None

    @property
    def pps(self):
        return self.a.pps or (200 if self.a.fakeboard else 2000)


def run_golden(bench, tid, fresh):
    lines, ok = [], True
    for n, (ver, s, extra) in enumerate(GOLDEN[tid]):
        if n:  # every golden set gets its own fresh board (alarm latches survive CONFIG writes)
            fresh = bench.fresh(f"{tid}_{ver}_{s}")
        if not fresh and "--skip-alerts" not in extra:
            extra = extra + ["--skip-alerts"]
        args = [sys.executable, "-m", "hutd_ml.board", "--golden", str(ART / ver / "golden" / s),
                "--board", bench.board, "--local", bench.local,
                "--pps", "0" if tid == "T1" else str(bench.pps),
                "--out", str(bench.out / f"{tid}_{ver}_{s}")] + extra
        t0 = time.monotonic()
        p = subprocess.run(args, cwd=ML, capture_output=True, text=True)
        dt = time.monotonic() - t0
        (bench.out / f"{tid}_{ver}_{s}.log").write_text(p.stdout + p.stderr)
        keep = [ln for ln in p.stdout.splitlines() if ln.startswith(("WEIGHTS", "RESULTs", "ALERTs", "FIRST", "sent "))]
        if tid == "T1":
            sent = next((ln for ln in keep if ln.startswith("sent ")), "")
            try:
                n, secs = int(sent.split("received ")[1].split()[0]), float(sent.split(" in ")[1].split()[0])
                keep.append(f"measured: {n / secs:,.0f} records/s end to end over {secs:.1f} s (unpaced sender), "
                            f"{n}/30240 results" + ("" if n == 30240 else "; incomplete, so the time includes the "
                                                    "wait for missing results"))
            except (IndexError, ValueError):
                pass
        lines.append(f"{ver} {s} ({dt:.0f} s): " + "; ".join(keep))
        ok &= p.returncode == 0
        if not ok and tid != "T1":
            break
    if not fresh:
        lines.append("ALERTs not compared: the board was not freshly started (use --reset-cmd or --prompt-reset)")
    return ok, lines


# ---- live tests: real replay.py + listen.py, checked against the offline engine ------------------------------

def engine_expected(folder, start_cfg, start_w, start_ver, first, last, swap=None):
    """What the board must produce for replay.py's records [first, last): RESULTs, per-record active classes and
    ALERTs. `swap` = (step, config, weights, version): weights and GLOBAL change after that step, like replay.py."""
    c = json.loads(Path(start_cfg).read_text())
    enc = encode.encode_dataset(folder, **{k: c[k] for k in CFG_KEYS if k in c})
    steps = enc.records.reshape(len(enc.timestamps), len(enc.facilities))
    eng = fi.Engine(enc.global_config, enc.facility_config,
                    model_int.to_weights(Path(start_w).read_bytes(), start_ver))
    res, classes, alerts = [], [], []
    for i in range(first, last):
        for r in steps[i]:
            out, st, al = eng.process(r)
            res.append(out)
            classes.append(None if st is None else st["classes"])
            alerts += al
        if swap and i == swap[0]:
            c2 = json.loads(Path(swap[1]).read_text())
            g2 = encode.build_global_config(**{k: c2[k] for k in CFG_KEYS if k in c2})
            w2 = model_int.to_weights(Path(swap[2]).read_bytes(), swap[3])
            eng.weights = w2
            fresh = fi.Engine(g2, enc.facility_config, w2)
            for k in ("k", "logit_thr", "gap_thr"):
                setattr(eng, k, getattr(fresh, k))
    return res, classes, alerts, len(enc.facilities)


def bits_of(names, table):
    return sum(1 << table.index(n) for n in names)


def check_live(jsonl, exp, classes, exp_alerts, fresh):
    """Compares listen.py's JSON with the offline engine. Returns (ok, lines)."""
    L = [json.loads(x) for x in Path(jsonl).read_text().splitlines() if x.strip()]
    got = sorted((d for d in L if d["type"] == "result"), key=lambda d: d["result_no"])
    lines, ok = [], True
    if len(got) != len(exp):
        ok = False
        lines.append(f"received {len(got)} of {len(exp)} results")
    status_code = {v: k for k, v in listen.STATUS.items()}
    first_bad, n_bad, n_active = None, 0, 0
    exp_by_key = {(r["fac_id"], r["ts_unix"]): (r, c) for r, c in zip(exp, classes)}
    # the board's result_no keeps counting across runs: rebase on the first result received
    base = (got[0]["result_no"] - exp_by_key[(got[0]["fac_id"], got[0]["ts_unix"])][0]["result_no"]
            if got and (got[0]["fac_id"], got[0]["ts_unix"]) in exp_by_key else 0)
    for d in got:
        e = exp_by_key.get((d["fac_id"], d["ts_unix"]))
        if e is None:
            n_bad += 1
            first_bad = first_bad or f"unexpected record {d['facility']} {d['time']}"
            continue
        r, cls = e
        cd = [0xFFFF if d["countdown_min"][k] is None else d["countdown_min"][k] for k in ("p10", "p50", "p90")]
        checks = {
            "result_no": d["result_no"] - base == int(r["result_no"]),
            "status": status_code[d["status"]] == int(r["status"]),
            "reason": bits_of(d["reason"], listen.REASONS) == int(r["reason"]),
            "since_reset": d["since_reset"] == int(r["since_reset"]),
            "logits": [round(x * 256) for x in d["logits"].values()] == [int(x) for x in r["logits"]],
            "rules": bits_of(d["rules"], listen.RULES) == int(r["rules"]),
            "countdown": cd == [int(x) for x in r["countdown"]],
            "weights_ver": d["weights_ver"] == int(r["weights_ver"]),
        }
        if cls is not None and "active" in d:
            checks["active"] = bits_of(d["active"], wire.HEADS) == cls
            n_active += bool(d["active"])
        bad = [k for k, v in checks.items() if not v]
        if bad:
            n_bad += 1
            first_bad = first_bad or f"result_no {d['result_no'] - base} ({d['facility']} {d['time']}): {', '.join(bad)}"
    ok &= n_bad == 0
    lines.append(f"RESULTs: {len(got) - n_bad}/{len(exp)} identical to the offline engine (all fields, `active` "
                 f"included; {n_active} records with an active problem)")
    if first_bad:
        lines.append(f"first mismatch: {first_bad}")
    if fresh:
        kind = {v: k for k, v in listen.ALERT_KIND.items()}
        ga = sorted((d for d in L if d["type"] == "alert"), key=lambda d: d["result_no"])
        mask = ~(wire.SRC_AUTONOMOUS | wire.SRC_ARM_REPLAY)

        def norm_got(d):
            src = bits_of(d["source"], listen.ALERT_SOURCE) | (wire.SRC_LATCH_ESTOP if d["latch"] == "estop" else 0)
            return (d["fac_id"], d["ts_unix"], d["result_no"] - base, kind[d["kind"]], src & mask,
                    bits_of(d["classes"], wire.HEADS), bits_of(d["rules"], listen.RULES),
                    0xFFFF if d["countdown_p10_min"] is None else d["countdown_p10_min"])

        def norm_exp(a):
            return (a["fac_id"], a["ts_unix"], a["result_no"], a["kind"], a["source"] & mask, a["classes"],
                    a["rules"], a["countdown_p10"])

        same = sum(norm_got(g) == norm_exp(e) for g, e in zip(ga, exp_alerts))
        a_ok = same == len(exp_alerts) == len(ga)
        ok &= a_ok
        lines.append(f"ALERTs: {same}/{len(exp_alerts)} identical, {len(ga)} received")
    else:
        lines.append("ALERTs not compared: the board was not freshly started")
    stats = [d for d in L if d["type"] == "stats"]
    if stats:
        s = stats[-1]
        lines.append(f"last STATS: mode {s.get('mode')}, weights {s.get('weights_version')}, "
                     f"data_seq_gaps {s.get('data_seq_gaps')}, bad_packets {s.get('bad_packets')}")
    return ok, lines


def run_live(bench, tid, folder, fresh, swap=False):
    name = f"{tid}_{Path(folder).name}"
    jsonl = bench.out / f"{name}.jsonl"
    jsonl.unlink(missing_ok=True)
    lst_log = open(bench.out / f"{name}_listen.log", "w")
    lst = subprocess.Popen([sys.executable, "-m", "hutd_ml.listen", "--data", str(folder), "--board", bench.board,
                            "--local", bench.local, "--model", str(ART / "v3"), "--model", str(ART / "v4"),
                            "--jsonl", str(jsonl), "--quiet"], cwd=ML, stdout=lst_log, stderr=lst_log)
    time.sleep(2)
    n_steps = len(encode.encode_dataset(folder).timestamps)
    if swap:
        start = ("v3", 3)
        swap_at = 1029 if n_steps > 1100 else n_steps // 2
        extra = ["--swap-at-step", str(swap_at), "--swap-weights", str(ART / "v4" / "weights.bin"),
                 "--swap-version", "4", "--swap-config", str(ART / "v4" / "global_config.json")]
    else:
        start, swap_at, extra = ("v4", 4), None, []
    args = [sys.executable, "-m", "hutd_ml.replay", "--data", str(folder), "--board", bench.board,
            "--local", bench.local, "--weights", str(ART / start[0] / "weights.bin"),
            "--weights-version", str(start[1]), "--config", str(ART / start[0] / "global_config.json"),
            "--step-seconds", "0", "--pps", str(bench.pps)] + extra
    t0 = time.monotonic()
    p = subprocess.run(args, cwd=ML, capture_output=True, text=True)
    (bench.out / f"{name}_replay.log").write_text(p.stdout + p.stderr)
    exp, classes, exp_alerts, n_fac = engine_expected(
        folder, ART / start[0] / "global_config.json", ART / start[0] / "weights.bin", start[1], 0, n_steps,
        swap=(swap_at, ART / "v4" / "global_config.json", ART / "v4" / "weights.bin", 4) if swap else None)
    want, last, still = len(exp), -1, time.monotonic()
    while time.monotonic() - t0 < 600:  # wait until listen.py has everything or stops growing for 6 s
        have = jsonl.read_text().count('"type": "result"') if jsonl.exists() else 0
        if have >= want:
            break
        if have != last:
            last, still = have, time.monotonic()
        elif time.monotonic() - still > 6:
            break
        time.sleep(0.5)
    time.sleep(1.5)  # trailing ALERT / STATS packets
    lst.terminate()
    lst.wait(timeout=10)
    lines = [f"{Path(folder).name}: {n_steps} steps x {n_fac} facilities, replay exit {p.returncode}, "
             f"{time.monotonic() - t0:.0f} s"]
    lines += [ln for ln in p.stdout.splitlines() if "WEIGHTS" in ln or "swap" in ln or "GLOBAL" in ln]
    if p.returncode != 0:
        return False, lines + [p.stderr.strip().splitlines()[-1] if p.stderr.strip() else "replay failed"]
    ok, more = check_live(jsonl, exp, classes, exp_alerts, fresh)
    if swap:
        got = [json.loads(x) for x in jsonl.read_text().splitlines() if '"type": "result"' in x]
        vers = {}
        for d in got:
            vers.setdefault(d["weights_ver"], []).append(d["ts_unix"])
        t_first = min(d["ts_unix"] for d in got) if got else 0
        span = {v: ((min(t) - t_first) // 300, (max(t) - t_first) // 300) for v, t in vers.items()}
        clean = sorted(span) == [3, 4] and span[3][1] + 1 == span[4][0]
        ok &= clean
        more.append(f"swap: v3 steps {span.get(3)}, v4 steps {span.get(4)}: "
                    f"{'one clean step boundary' if clean else 'NOT a clean boundary'}")
    return ok, lines + more


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="history/full_week of the reference repo")
    ap.add_argument("--board", default="192.168.1.10")
    ap.add_argument("--local", default="192.168.1.50")
    ap.add_argument("--pps", type=float, default=None, help="DATA packets/s (default 2000; 200 with --fakeboard)")
    ap.add_argument("--reset-cmd", default=None, help="command that re-programs / resets the board before each test")
    ap.add_argument("--prompt-reset", action="store_true", help="ask for a manual reset before each test")
    ap.add_argument("--fakeboard", action="store_true", help="rehearsal: a fresh software board for each test")
    ap.add_argument("--only", default=None, help="comma-separated test ids, e.g. B1,B3,L1")
    ap.add_argument("--skip", default="", help="comma-separated test ids to leave out")
    ap.add_argument("--with-b4", action="store_true", help="also run B4 (heartbeat gap; known issue on the board)")
    ap.add_argument("--throughput", action="store_true", help="also run T1 (unpaced g1, records/s measured)")
    ap.add_argument("--out", default=None)
    a = ap.parse_args(argv)

    out = Path(a.out or f"board_suite_{datetime.now():%Y%m%d_%H%M%S}").resolve()
    out.mkdir(parents=True, exist_ok=True)
    tests = a.only.split(",") if a.only else DEFAULT + (["B4"] if a.with_b4 else []) + (["T1"] if a.throughput else [])
    tests = [t for t in tests if t not in a.skip.split(",")]
    data = Path(a.data).resolve()
    others = sorted(p for p in data.parent.iterdir() if p.is_dir() and p != data and (p / "telemetry.csv").exists())
    bench = Bench(a, out)
    rows = []
    print(f"board suite: {', '.join(tests)} -> {out}", flush=True)
    try:
        for tid in tests:
            folders = others if tid == "L3" else [data]
            for folder in folders:
                label = f"{tid} {folder.name}" if tid == "L3" else tid
                print(f"[{label}]", flush=True)
                fresh = bench.fresh(label.replace(" ", "_"))
                t0 = time.monotonic()
                if tid in GOLDEN:
                    ok, lines = run_golden(bench, tid, fresh)
                else:
                    ok, lines = run_live(bench, tid, folder, fresh, swap=(tid == "L2"))
                verdict = "INFO" if tid == "T1" else ("PASS" if ok else ("FAIL (known issue)" if tid == "B4" else "FAIL"))
                rows.append({"test": label, "verdict": verdict, "seconds": round(time.monotonic() - t0),
                             "details": lines})
                print(f"  {verdict}", *[f"  {ln}" for ln in lines], sep="\n", flush=True)
    finally:
        bench.stop()

    head = (f"# Board suite: weights v4\n\n{datetime.now():%Y-%m-%d %H:%M}, board {bench.board}, "
            f"{'software board' if a.fakeboard else 'hardware'}, data `{data.name}`, ml `{ML}`\n\n"
            "| Test | Verdict | Seconds | Details |\n| --- | --- | --- | --- |\n")
    body = "".join(f"| {r['test']} | **{r['verdict']}** | {r['seconds']} | {'<br>'.join(r['details'])} |\n" for r in rows)
    (out / "report.md").write_text(head + body)
    (out / "report.json").write_text(json.dumps(rows, indent=1))
    failed = [r["test"] for r in rows if r["verdict"].startswith("FAIL")]
    print(f"\n{len(rows) - len(failed)}/{len(rows)} passed{'; FAILED: ' + ', '.join(failed) if failed else ''}. "
          f"Report: {out / 'report.md'}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
