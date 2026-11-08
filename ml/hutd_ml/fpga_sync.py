"""Stay in step with Lucas's branch `FPGA`: what changed since the last sync, and do both references still agree?

    python -m hutd_ml.fpga_sync [--remote origin] [--golden artifacts/v2/golden] [--sets g0,g2,g1] [--record]

1. `git fetch <remote> FPGA`, then reports the commits since the last recorded sync, the spec version, changed files
   under FPGA/spec, FPGA/model and FPGA/TASKS.md, and spec-question rows that are new or changed.
2. Extracts FPGA/model (+ rtl/eog_defs.svh, spec/gen) at origin/FPGA into a temp folder and runs hutd_ml.xcheck
   on our golden sets twice: as-is (the goal) and with --zero-k4 --remap-lohi (the pre-v4 eog_ref layout).
3. With --record, writes the new state to ml/FPGA_SYNC.json and appends a line to ml/FPGA_SYNC.md (commit both).

Read-only towards branch FPGA: the ML side never commits there.
"""
import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ML = Path(__file__).resolve().parents[1]
REPO = ML.parent
STATE = ML / "FPGA_SYNC.json"
LOG = ML / "FPGA_SYNC.md"


def git(*args, check=True):
    return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True, check=check).stdout


def spec_questions(ref):
    txt = git("show", f"{ref}:FPGA/TASKS.md", check=False)
    rows = {}
    on = False
    for line in txt.splitlines():
        if line.startswith("## Spec questions"):
            on = True
            continue
        if on and line.startswith("## "):
            break
        if on and line.startswith("| ") and line.split("|")[1].strip().isdigit():
            rows[line.split("|")[1].strip()] = hashlib.sha1(line.encode()).hexdigest()[:10]
    return rows


def run_xcheck(model_dir, golden, flags):
    out = subprocess.run([sys.executable, "-m", "hutd_ml.xcheck", "--fpga-model", str(model_dir), "--golden",
                          str(golden), "--show", "0", *flags], capture_output=True, text=True, cwd=str(ML))
    lines = [ln for ln in (out.stdout + out.stderr).splitlines() if ln.strip()]
    if "Traceback" in out.stderr:  # eog_ref itself failed (e.g. mid-rework): not a disagreement
        return "ERROR (eog_ref crashed)", lines[-1:]
    return ("PASS" if out.returncode == 0 else "DIFF"), lines[:2]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--remote", default="origin")
    ap.add_argument("--golden", default="artifacts/v2/golden")
    ap.add_argument("--sets", default="g0,g2,g1")
    ap.add_argument("--record", action="store_true")
    a = ap.parse_args(argv)

    git("fetch", "-q", a.remote, "FPGA")
    ref = f"{a.remote}/FPGA"
    head = git("rev-parse", "--short", ref).strip()
    version = git("show", f"{ref}:FPGA/spec/VERSION", check=False).strip() or "?"
    numerics = hashlib.sha1(git("show", f"{ref}:FPGA/spec/numerics.md", check=False).encode()).hexdigest()[:10]
    prev = json.loads(STATE.read_text()) if STATE.exists() else {}
    print(f"origin FPGA @ {head}, spec v{version}, numerics.md {numerics}"
          f" (last sync: {prev.get('commit', 'never')}, v{prev.get('spec_version', '?')})")
    if prev.get("commit"):
        log = git("log", "--oneline", f"{prev['commit']}..{ref}", check=False).strip()
        print("new commits:\n" + (log or "  none"))
        stat = git("diff", "--stat", prev["commit"], ref, "--", "FPGA/spec", "FPGA/model", "FPGA/TASKS.md",
                   check=False).strip()
        print("changed spec/model/tasks files:\n" + (stat or "  none"))
        if prev.get("numerics") != numerics:
            print("!! numerics.md changed: re-read it against features_int.py")
    sq = spec_questions(ref)
    old = prev.get("spec_questions", {})
    new_rows = sorted((k for k in sq if old.get(k) != sq[k]), key=int)
    print("spec questions new/changed since last sync:", ", ".join(new_rows) or "none")

    results = {}
    with tempfile.TemporaryDirectory() as tmp:
        arch = subprocess.run(["git", "-C", str(REPO), "archive", ref, "FPGA/model", "FPGA/rtl/eog_defs.svh",
                               "FPGA/spec/gen"], capture_output=True, check=True).stdout
        subprocess.run(["tar", "-x", "-C", tmp], input=arch, check=True)
        model = Path(tmp) / "FPGA" / "model"
        for s in a.sets.split(","):
            g = Path(a.golden) / s
            for label, flags in (("as-is", []), ("pre-v4 layout", ["--zero-k4", "--remap-lohi"])):
                verdict, tail = run_xcheck(model, g, flags)
                results[f"{s} {label}"] = verdict
                print(f"xcheck {s:3s} {label:14s}: {verdict}  " + " | ".join(tail)[:300])
    if a.record:
        state = {"commit": head, "spec_version": version, "numerics": numerics, "spec_questions": sq,
                 "xcheck": results, "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")}
        STATE.write_text(json.dumps(state, indent=1))
        line = (f"| {state['at']} | `{head}` | v{version} | {', '.join(new_rows) or '—'} | "
                + "; ".join(f"{k}: {v}" for k, v in results.items()) + " |\n")
        if not LOG.exists():
            LOG.write_text("# Sync log with branch FPGA\n\nWritten by `python -m hutd_ml.fpga_sync --record`.\n\n"
                           "| When (UTC) | FPGA commit | Spec | New / changed spec questions | xcheck (ours vs eog_ref) |\n"
                           "| --- | --- | --- | --- | --- |\n")
        with open(LOG, "a") as fh:
            fh.write(line)
        print(f"recorded in {STATE.name} and {LOG.name}")


if __name__ == "__main__":
    main()
