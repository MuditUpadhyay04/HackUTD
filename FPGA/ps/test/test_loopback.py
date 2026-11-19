"""test_loopback.py — Mudit's own laptop harness (hutd_ml.board) against the C protocol over real UDP.

    python FPGA/ps/test/test_loopback.py [--ml <dir containing hutd_ml>] [--out <scratch dir>] [--g1]

Starts simboard_bridge on 127.0.0.2 (C eog_proto + fake eog_regs, Mudit's engine behind the DATA window) and runs
`python -m hutd_ml.board --golden <g> --board 127.0.0.2 --local 127.0.0.1` for each golden set: CONFIG + WEIGHTS
ACKs, DATA, RESULT collection and his bit-exact comparison must PASS. G2 is also run with --heartbeat-test 7, which
stops heartbeats mid-stream (HB_TIMEOUT_MS 5000): the board must go AUTONOMOUS, buffer and replay. Exactly as
`python -m hutd_ml.fakeboard` is used, but every ARM decision is the C code.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import simboard_bridge as sb  # noqa: E402


def run(ml, golden, out, extra=(), timeout=600):
    b = sb.SimBoard("127.0.0.2", "127.0.0.1", ml)
    try:
        time.sleep(0.3)
        cmd = [sys.executable, "-m", "hutd_ml.board", "--golden", str(golden), "--board", "127.0.0.2",
               "--local", "127.0.0.1", "--out", str(out), *extra]
        env = dict(os.environ, PYTHONPATH=str(ml) + os.pathsep + os.environ.get("PYTHONPATH", ""))
        t0 = time.monotonic()
        p = subprocess.run(cmd, cwd=str(ml), env=env, capture_output=True, text=True, timeout=timeout)
        dt = time.monotonic() - t0
        replayed = sum(1 for a in json.loads((Path(out) / "actual_alerts.json").read_text()) if a["source"] & 8) \
            if (Path(out) / "actual_alerts.json").exists() else 0
        # STATS sent while AUTONOMOUS (mode word 11 = 1) prove the outage was seen
        auton = sum(1 for _, _, _, pkt in b.sent if pkt[5] == 8 and pkt[16 + 44] == 1)
        return p.returncode, p.stdout + p.stderr, dt, b.engine_calls, (replayed, auton)
    finally:
        b.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ml", default=None)
    ap.add_argument("--out", default=None, help="where board.py writes its run folders (default: a temp dir)")
    ap.add_argument("--g1", action="store_true", help="also run G1 (30,240 records)")
    ap.add_argument("--artifacts", default="v3", help="Mudit's artifact version whose golden sets to use")
    a = ap.parse_args(argv)
    ml = Path(a.ml) if a.ml else sb.default_ml_dir()
    golden = ml / "artifacts" / a.artifacts / "golden"
    out = Path(a.out or tempfile.mkdtemp(prefix="eog_loopback_"))
    cases = [("g0", golden / "g0", ["--pps", "0", "--wait", "10"]),
             ("g2", golden / "g2", ["--pps", "0", "--wait", "10"]),
             ("g2 heartbeat gap 7 s", golden / "g2", ["--pps", "0", "--wait", "15", "--heartbeat-test", "7"])]
    if a.g1:
        cases.append(("g1", golden / "g1", ["--pps", "500", "--wait", "60"]))
    fails = 0
    for i, (name, g, extra) in enumerate(cases):
        rc, log, dt, calls, replayed = run(ml, g, out / f"run{i}", extra)
        last = [ln for ln in log.splitlines() if ln.strip()]
        summary = [ln for ln in last if ln.startswith(("CONFIG", "WEIGHTS", "sent", "mismatches", "FIRST", "PASS", "FAIL"))]
        ok = rc == 0 and "PASS" in last[-1:]
        if "heartbeat" in name and replayed[1] == 0:
            ok = False
            print("    no STATS with mode = AUTONOMOUS during the heartbeat gap")
        fails += not ok
        print(f"{name}: {'PASS' if ok else 'FAIL'} (rc {rc}, {dt:.1f} s, {calls} engine calls, "
              f"{replayed[0]} alerts with the replay bit, {replayed[1]} STATS in AUTONOMOUS)")
        for ln in summary if ok else last[-15:]:
            print("   ", ln)
    print("test_loopback:", "FAIL" if fails else "PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
