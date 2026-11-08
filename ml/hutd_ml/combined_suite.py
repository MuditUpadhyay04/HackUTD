"""One command for the combined test: weights v4 on the board -> board results -> API incidents -> Nemotron agents.

    python -m hutd_ml.combined_suite --data <full_week> --reset-cmd "..\\FPGA\\deploy\\win_deploy_eog.bat"   # the board
    python -m hutd_ml.combined_suite --data <full_week> --fakeboard                                         # rehearsal
    python -m hutd_ml.combined_suite --data <full_week> --board-jsonl L1.jsonl --source fpga                # store and forward

Stages (docs/plan/mudit/nemotron_v4_fpga_test.md):
  A   Board results. The demo path replay.py -> board -> listen.py over the full week and the held-out folder, checked
      bit-exact against the reference (board_suite L1 / L3). Skipped with --board-jsonl / --heldout-jsonl, which reuse
      the JSON of an earlier board run.
  N1  The agents on those results at each cutoff (bun apps/api/scripts/agent-run.ts):
        - the run's incidents are exactly what the board flags;
        - the board facts the agents saw equal the JSON at the cutoff (source, weights version, not stale);
        - every sub-agent's output is accepted by the validators, or written deterministically; a handoff exists.
      Latency and tokens are recorded.
  N2  The API path the console uses: API in memory mode with BOARD_JSONL; upload the dataset; a run at the first
      cutoff; incidents with their provenance; POST /runs/:id/agents. The plan each explainer presents first must be
      the solver's recommended plan.
  D1  Stale drill: board results cut 1 h before a cutoff -> every board fact marked stale.

Expected incidents come from the board JSON alone (never from the answer key). Needs Bun, `bun install` at the repo
root, and the Nemotron key in the repo-root .env (NVIDIA_BASE_URL, NEMOTRON_MODEL, NVIDIA_API_KEY); see .env.example.
Writes <out>/report.md and report.json. Exit code 0 only if every stage passed.
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

from . import board_suite as bs

ML = Path(__file__).resolve().parents[1]
ROOT = ML.parent
AGENT_RUN = ROOT / "apps" / "api" / "scripts" / "agent-run.ts"
RESOLVE_AFTER = 3  # usable board records without `active` before a leak / degradation incident resolves (runtime rule)
CATEGORY = {"pipeline_leak": "pipeline_leak", "pump_degradation": "pump_degradation"}


# ---- what the board says, read independently from the JSON -----------------------------------------------------

def load_jsonl(path):
    out = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def board_at(lines, cutoff):
    """Latest result per facility at or before the cutoff."""
    latest = {}
    for d in lines:
        if d.get("type") == "result" and d["ts_unix"] <= cutoff:
            if d["facility"] not in latest or latest[d["facility"]]["ts_unix"] <= d["ts_unix"]:
                latest[d["facility"]] = d
    return latest


def expected_incidents(lines, cutoff):
    """Ongoing (category, facility) pairs at the cutoff, by the runtime's rule: a leak / degradation head is on from the
    record where it is `active` until RESOLVE_AFTER usable records without it; a pump failure is on while the latest
    usable record says pump_fault or has pump_failure active."""
    by_fac = {}
    for d in sorted((d for d in lines if d.get("type") == "result" and d["ts_unix"] <= cutoff), key=lambda d: d["ts_unix"]):
        by_fac.setdefault(d["facility"], []).append(d)
    out = set()
    for fac, recs in by_fac.items():
        on, miss = {h: False for h in CATEGORY}, {h: 0 for h in CATEGORY}
        failure = False
        for d in recs:
            if d["status"] not in ("VALID", "HELD"):
                continue
            act = d.get("active", d.get("above_threshold", []))
            for h in CATEGORY:
                if h in act:
                    on[h], miss[h] = True, 0
                else:
                    miss[h] += 1
                    if miss[h] >= RESOLVE_AFTER:
                        on[h] = False
            failure = "pump_fault" in d.get("rules", []) or "pump_failure" in act
        out |= {(CATEGORY[h], fac) for h in CATEGORY if on[h]}
        if failure:
            out.add(("pump_failure", fac))
    return out


def incident_key(incident_id):
    """'<run>:<category>:<facility>:<onset>' -> (category, facility)."""
    parts = incident_id.split(":")
    return parts[-3], parts[-2]


# ---- N1: the agents CLI ------------------------------------------------------------------------------------------

def run_agents_cli(bun, folder, cutoff, jsonl, source, out_json, log):
    t0 = time.monotonic()
    p = subprocess.run([bun, str(AGENT_RUN), "--data", str(folder), "--at", str(cutoff), "--board", str(jsonl),
                        "--board-source", source, "--json", str(out_json)], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    Path(log).write_text(p.stdout + p.stderr, encoding="utf-8")
    return p.returncode, time.monotonic() - t0


def check_trace(trace, lines, cutoff, source, stale_expected=False, strict=False):
    ok, out = True, []
    want = expected_incidents(lines, cutoff)
    got = {incident_key(a["incidentId"]) for a in trace.get("alertsView", [])}
    if got != want:
        ok = False
        out.append(f"incidents differ from the board: missing {sorted(want - got)}, extra {sorted(got - want)}")
    else:
        out.append(f"incidents = what the board flags: {len(got)} ({', '.join(sorted(f'{c}@{f}' for c, f in got)) or 'none'})")
    latest = board_at(lines, cutoff)
    facts = {b["facilityId"]: b for b in trace.get("board", [])}
    bad = []
    for fac, d in latest.items():
        b = facts.get(fac)
        want_heads = sorted(d.get("active", []))
        if b is None or sorted(b["heads"]) != want_heads or b["tsUnix"] != d["ts_unix"] or b["source"] != source \
                or b["weightsVer"] != d.get("weights_ver") or b["stale"] != stale_expected:
            bad.append(fac)
    if bad:
        ok = False
        out.append(f"board facts differ from the JSON at the cutoff for {', '.join(sorted(bad))}")
    else:
        out.append(f"board facts = the JSON at the cutoff for all {len(latest)} facilities (source {source}, "
                   f"weights v{next(iter(latest.values())).get('weights_ver') if latest else '?'}, "
                   f"{'stale' if stale_expected else 'not stale'})")
    nodes = [n for n in trace.get("nodes", []) if n["role"] != "orchestrator"]
    model = [n for n in nodes if n["status"] != "deterministic"]
    accepted = [n for n in model if n["status"] in ("accepted", "cached")]
    denied = [n for n in model if n["status"] == "denied"]  # a guard refusing a sub-agent request: working as designed
    rejected = [f"{n['role']} ({(n.get('error') or n['status'])[:120]})" for n in model if n["status"] in ("rejected", "failed")]
    fallbacks = trace.get("fallbacks", [])
    handoff = (trace.get("outputs") or {}).get("handoff") or next(
        (n["output"] for n in nodes if n["role"] == "handoff" and n["status"] == "deterministic"), None)
    if not handoff:
        ok = False
        out.append("no handoff for the operator")
    if strict and (rejected or fallbacks):
        ok = False
    t = trace.get("totals", {})
    out.append(f"Nemotron: {len(accepted)}/{len(model) - len(denied)} sub-agent outputs accepted by the validators"
               f"{f', {len(denied)} requests refused by the guards' if denied else ''}"
               f"{f'; not accepted: ' + '; '.join(rejected) if rejected else ''}"
               f"{f'; deterministic fallback for {fallbacks}' if fallbacks else ''}")
    out.append(f"{t.get('modelCalls')} model calls, {t.get('inputTokens')}/{t.get('outputTokens')} tokens, "
               f"{t.get('latencyMs', 0) / 1000:.1f} s")
    return ok, out


# ---- N2: the API path --------------------------------------------------------------------------------------------

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def http(method, url, body=None, headers=None, timeout=60):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def multipart(folder, label):
    boundary = uuid.uuid4().hex
    parts = []
    for field in ("network", "ops", "telemetry"):
        name = {"network": "network.json", "ops": "ops.json", "telemetry": "telemetry.csv"}[field]
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{name}"\r\n'
                     f"Content-Type: application/octet-stream\r\n\r\n".encode() + (Path(folder) / name).read_bytes() + b"\r\n")
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="label"\r\n\r\n{label}\r\n'.encode())
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def poll(fn, done, timeout, every=1.0):
    deadline = time.monotonic() + timeout
    while True:
        v = fn()
        if done(v) or time.monotonic() > deadline:
            return v
        time.sleep(every)


def run_api(bun, folder, cutoff, jsonl, source, out, lines, strict=False):
    port = free_port()
    base = f"http://127.0.0.1:{port}/api"
    env = {**os.environ, "STORAGE_MODE": "memory", "ALLOW_INSECURE_LOCAL": "1", "API_HOST": "127.0.0.1",
           "API_PORT": str(port), "BOARD_JSONL": str(jsonl), "BOARD_SOURCE": source,
           "AGENT_LEARNING_FILE": str(out / "agent-learning.json")}
    log = open(out / "N2_api.log", "w", encoding="utf-8")
    api = subprocess.Popen([bun, "apps/api/src/index.ts"], cwd=ROOT, env=env, stdout=log, stderr=log)
    lines_out, ok = [], True
    try:
        health = poll(lambda: _try(lambda: http("GET", f"{base}/health")), lambda v: bool(v), 60)
        if not health:
            return False, ["the API did not start (see N2_api.log)"]
        lines_out.append(f"API up: agents {health.get('agents')}, model settings {health.get('agentModel')}")
        body, headers = multipart(folder, Path(folder).name)
        ds = http("POST", f"{base}/datasets", body, headers, timeout=180)
        ds_id = (ds.get("dataset") or ds).get("id") if isinstance(ds, dict) else None
        run = http("POST", f"{base}/runs", json.dumps({"datasetId": ds_id, "at": cutoff, "runtime": "software"}).encode(),
                   {"Content-Type": "application/json", "Idempotency-Key": uuid.uuid4().hex})
        run = poll(lambda: http("GET", f"{base}/runs/{run['id']}"), lambda r: r["status"] in ("ready", "failed", "cancelled"), 180)
        if run["status"] != "ready":
            return False, lines_out + [f"run ended {run['status']}"]
        snap = http("GET", f"{base}/runs/{run['id']}/snapshot")
        want = expected_incidents(lines, cutoff)
        got = {(a["category"], a["facilityId"]) for a in snap["alerts"] if a["status"] == "ongoing"}
        prov = {a["provenance"] for a in snap["alerts"] if a["category"] in CATEGORY.values()}
        reason = next((r for r in snap["runtime"]["reasons"] if r.startswith("Detections from")), None)
        if got != want:
            ok = False
            lines_out.append(f"API incidents differ from the board: missing {sorted(want - got)}, extra {sorted(got - want)}")
        else:
            lines_out.append(f"API incidents = what the board flags ({len(got)}); provenance {sorted(prov) or '-'}; {reason}")
        if prov and prov != {"fpga" if source == "fpga" else "software"}:
            ok = False
            lines_out.append(f"wrong provenance {sorted(prov)} for source {source}")
        live = http("POST", f"{base}/runs/{run['id']}/agents", b"{}", {"Content-Type": "application/json"})
        live = poll(lambda: http("GET", f"{base}/agent-runs/{live['id']}"), lambda r: r["status"] != "running", 420, 2)
        (out / "N2_agent_run.json").write_text(json.dumps(live, indent=1), encoding="utf-8")
        if live["status"] != "done" or not live.get("trace"):
            return False, lines_out + [f"agent run ended {live['status']}: {live.get('error')}"]
        tok, tlines = check_trace(live["trace"], lines, cutoff, source, strict=strict)
        ok &= tok
        lines_out += tlines
        rec = {a["id"]: (a.get("plan") or {}).get("id") for a in snap["alerts"]}
        exps = live["trace"]["outputs"]["explanations"]
        disagree = [e["incidentId"] for e in exps if rec.get(e["incidentId"]) and e["presentFirstPlanId"] != rec[e["incidentId"]]]
        if disagree:
            ok = False
            lines_out.append(f"explainer's first plan differs from the solver's recommended plan for {disagree}")
        else:
            lines_out.append(f"every explainer ({len(exps)}) presents the solver's recommended plan first")
    except (urllib.error.URLError, KeyError, TypeError, ValueError) as e:
        ok = False
        lines_out.append(f"API step failed: {e!r} (see N2_api.log)")
    finally:
        api.terminate()
        try:
            api.wait(timeout=10)
        except subprocess.TimeoutExpired:
            api.kill()
    return ok, lines_out


def _try(fn):
    try:
        return fn()
    except (urllib.error.URLError, ConnectionError, OSError):
        return None


# ---- main --------------------------------------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="history/full_week of the reference repo")
    ap.add_argument("--heldout", default=None, help="held-out folder (default: the mock_test_* next to --data)")
    ap.add_argument("--board-jsonl", default=None, help="reuse board results from an earlier run (skips stage A)")
    ap.add_argument("--heldout-jsonl", default=None)
    ap.add_argument("--source", choices=["fpga", "fakeboard"], default=None,
                    help="where --board-jsonl came from (default: fakeboard with --fakeboard, otherwise fpga)")
    ap.add_argument("--cutoffs", default="1030,1080,last", help="steps of --data; 'last' = its final step")
    ap.add_argument("--board", default="192.168.1.10")
    ap.add_argument("--local", default="192.168.1.50")
    ap.add_argument("--pps", type=float, default=None)
    ap.add_argument("--reset-cmd", default=None)
    ap.add_argument("--prompt-reset", action="store_true")
    ap.add_argument("--fakeboard", action="store_true")
    ap.add_argument("--skip", default="", help="comma-separated stages to leave out: A,N1,N2,D1")
    ap.add_argument("--strict-agents", action="store_true",
                    help="also fail when any Nemotron output was not accepted (default: a deterministic fallback "
                         "for triage / handoff passes, and the acceptance rate is reported)")
    ap.add_argument("--out", default=None)
    a = ap.parse_args(argv)

    out = Path(a.out or f"combined_suite_{datetime.now():%Y%m%d_%H%M%S}").resolve()
    out.mkdir(parents=True, exist_ok=True)
    skip = set(a.skip.split(",")) - {""}
    data = Path(a.data).resolve()
    held = Path(a.heldout).resolve() if a.heldout else next(
        (p for p in sorted(data.parent.iterdir()) if p.name.startswith("mock_test") and (p / "telemetry.csv").exists()), None)
    source = a.source or ("fakeboard" if a.fakeboard else "fpga")
    bun = shutil.which("bun")
    rows = []

    def record(test, ok, lines, t0, info=False):
        verdict = "INFO" if info else ("PASS" if ok else "FAIL")
        rows.append({"test": test, "verdict": verdict, "seconds": round(time.monotonic() - t0), "details": lines})
        print(f"[{test}] {verdict}", *[f"  {ln}" for ln in lines], sep="\n", flush=True)

    # A: board results, verified bit-exact
    jsonl, held_jsonl = a.board_jsonl, a.heldout_jsonl
    if not jsonl and "A" not in skip:
        ns = argparse.Namespace(fakeboard=a.fakeboard, board=a.board, local=a.local, reset_cmd=a.reset_cmd,
                                prompt_reset=a.prompt_reset, pps=a.pps)
        bench = bs.Bench(ns, out)
        try:
            for tid, folder in (("L1", data), ("L3", held)):
                if folder is None:
                    continue
                t0 = time.monotonic()
                ok, lines = bs.run_live(bench, tid, folder, bench.fresh(f"A_{tid}"))
                record(f"A {tid} {folder.name}", ok, lines, t0)
                if tid == "L1":
                    jsonl = out / f"{tid}_{folder.name}.jsonl" if ok else None
                else:
                    held_jsonl = out / f"{tid}_{folder.name}.jsonl" if ok else None
        finally:
            bench.stop()
    if not jsonl:
        print("no verified board results: stopping before the agents", flush=True)
        return finish(out, rows, data, source)
    if not bun:
        record("N1", False, ["bun not found: install Bun and run `bun install` at the repo root"], time.monotonic())
        return finish(out, rows, data, source)

    lines = load_jsonl(jsonl)
    first_ts = min(d["ts_unix"] for d in lines if d.get("type") == "result")
    last_ts = max(d["ts_unix"] for d in lines if d.get("type") == "result")
    cutoffs = [last_ts if c == "last" else first_ts + int(c) * 300 for c in a.cutoffs.split(",")]

    if "N1" not in skip:
        cases = [(data, c, jsonl, lines) for c in cutoffs]
        if held_jsonl:
            hl = load_jsonl(held_jsonl)
            cases.append((held, max(d["ts_unix"] for d in hl if d.get("type") == "result"), held_jsonl, hl))
        for folder, cutoff, jl, ll in cases:
            t0 = time.monotonic()
            step = (cutoff - min(d["ts_unix"] for d in ll if d.get("type") == "result")) // 300
            name = f"N1 {folder.name} step {step}"
            tj = out / f"N1_{folder.name}_{step}.json"
            rc, dt = run_agents_cli(bun, folder, cutoff, jl, source, tj, out / f"N1_{folder.name}_{step}.log")
            if rc != 0 or not tj.exists():
                record(name, False, [f"agent-run.ts exit {rc} (see the .log; is the Nemotron key in the root .env?)"], t0)
                continue
            ok, det = check_trace(json.loads(tj.read_text(encoding="utf-8")), ll, cutoff, source, strict=a.strict_agents)
            record(name, ok, det, t0)

    if "N2" not in skip:
        t0 = time.monotonic()
        ok, det = run_api(bun, data, cutoffs[0], jsonl, source, out, lines, a.strict_agents)
        record(f"N2 API {data.name} step {(cutoffs[0] - first_ts) // 300}", ok, det, t0)

    if "D1" not in skip and len(cutoffs) > 1:
        t0 = time.monotonic()
        c = cutoffs[1]
        cut = out / "D1_stale.jsonl"
        cut.write_text("".join(json.dumps(d) + "\n" for d in lines if d.get("type") != "result" or d["ts_unix"] <= c - 3600), encoding="utf-8")
        tj = out / "D1_trace.json"
        rc, _ = run_agents_cli(bun, data, c, cut, source, tj, out / "D1.log")
        if rc != 0 or not tj.exists():
            record("D1 stale drill", False, [f"agent-run.ts exit {rc}"], t0)
        else:
            tr = json.loads(tj.read_text(encoding="utf-8"))
            stale = [b["stale"] for b in tr.get("board", [])]
            ok = bool(stale) and all(stale)
            record("D1 stale drill", ok, [f"board results cut 1 h before step {(c - first_ts) // 300}: "
                                          f"{sum(stale)}/{len(stale)} board facts marked stale"], t0)
    return finish(out, rows, data, source)


def finish(out, rows, data, source):
    head = (f"# Combined suite: v4 board -> API -> Nemotron agents\n\n{datetime.now():%Y-%m-%d %H:%M}, data `{data.name}`, "
            f"board results from **{source}**\n\n| Test | Verdict | Seconds | Details |\n| --- | --- | --- | --- |\n")
    body = "".join(f"| {r['test']} | **{r['verdict']}** | {r['seconds']} | {'<br>'.join(r['details'])} |\n" for r in rows)
    (out / "report.md").write_text(head + body, encoding="utf-8")
    (out / "report.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    failed = [r["test"] for r in rows if r["verdict"] == "FAIL"]
    print(f"\n{len(rows) - len(failed)}/{len(rows)} passed{'; FAILED: ' + ', '.join(failed) if failed else ''}. "
          f"Report: {out / 'report.md'}")
    sys.exit(1 if failed or not rows else 0)


if __name__ == "__main__":
    main()
