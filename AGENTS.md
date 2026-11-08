# HackUTD project context

Always read this file before working here and use the key resources below as references. Keep verified context current; distinguish proposed interfaces from implemented behavior.

## Event and key resources

- We are building at **HackUTD 2026: Zero Day, November 7–8, 2026**. The hackathon ends November 8: prioritize the working end-to-end demo over expanding scope.
- Event details and tracks: https://zeroday.hackutd.co/#tracks
- Hackerpack (rules, logistics, challenge resources): https://hackutd-2026.notion.site/HackUTD-2026-Zero-Day-Hackerpack-3b163cec774080bea6c5fb7358a42dac
- **Essential project/challenge reference:** https://github.com/nihaal419/HackUTD-ZeroDay. Always consult it before implementation or architecture decisions. Start with `README.md`, then `SPEC.md` for schemas, equipment behavior, and planning rules; these are external reference files, not files in this checkout.
- Additional architecture thoughts: https://claude.ai/artifact/XyRUpbFJisX48WrbFAYA2H. Content was inaccessible behind a security check when this file was updated; consult it when available rather than assume its contents.
- **Team plans:** `global_plan.md` is the cross-team source of truth: hard rules, architecture, contracts, owners and open questions. Per-owner working plans live in `docs/plan/<owner>/`; solidified decisions are promoted into `global_plan.md` with a changelog row. Check changes against `global_plan.md` §2 (hard rules) and §5 (contracts).
- **FPGA plan (source of truth for the FPGA side):** Lucas's live doc https://claude.ai/artifact/1fzKUqpVAnbrWTYDQkEmEQ, copied into `docs/plan/lucas/fpga_hardware_plan.md`. **Never edit the live doc from automation**; update the repo copy instead. Repo-side cross-check findings are in `docs/plan/lucas/review_notes.md`.

## Domain owners

- **Lucas:** FPGA, using the **Eclypse Z7** development kit.
- **Mudit:** model training; works closely with Lucas because model inference runs on the FPGA, not on the training host.
- **Gurneal (also called Jimmy):** web interface and full stack, with Jason helping.
- **Jason:** primary owner of agents; additional contributors may join.
- Coordinate model/tensor/weight-format changes with Mudit and Lucas, and agent/dashboard API changes with Jason and Gurneal.
- **The FPGA is the fixed point:** FPGA spec v4 is locked and the RTL is built to it (every module signed off, running on the board); neither changes for anyone else's convenience. Make every other part (ingest, ML, server, agents, console) adapt to them; never propose an FPGA/RTL change unless something is broken, and then Lucas decides (`global_plan.md`, "How this file works").
- **Final say when owners disagree:** spec, FPGA and RTL → **Lucas**; ML (model, features, weights, ingest, board tooling) → **Mudit**; server, agents and Nemotron → **Jason** (`global_plan.md`, "How this file works").

## Working architecture

Current architecture, contracts and open items: `global_plan.md` §3–§9 (integrated Sun Nov 8, 02:55 CST). In short:

1. `ml/hutd_ml/replay.py` (CSV → 48 B binary, on the board PC) sends records to the Eclypse Z7 (spec v4, locked),
   or to `ml/hutd_ml/fakeboard.py` when there's no board.
2. `ml/hutd_ml/listen.py` turns the results into JSON (contract C11).
3. The operator API (`apps/api/`) owns runs, incidents, the shared-fleet planner and the Nemotron coordinator.
4. The web console (`frontend/`) is presentation only.

`ml/hutd_ml/features_int.py` is the normative integer reference for the board (hard rule 11).

`docs/research/FPGA_CLASSIFIER_HANDOFF.md` and `model-input-v1.json` are superseded in part: the CNN, the window
and the full-window transport. Its 12 channel formulas and four independent outputs still hold; shut-in is not a
fourth independent equipment fault.

## Challenge constraints that affect implementation

- Build an operator console for produced-water facilities: detect pipeline leaks, pump degradation, and pump failures; estimate shutdown time and cost-effective responses where applicable.
- Runtime inputs are only `network.json`, `ops.json`, and `telemetry.csv`. Practice `answer_key.json` is for offline training/evaluation, never runtime detection or planning; do not hardcode asset IDs, event schedules, or practice-network constants.
- Telemetry is sampled every five minutes. Use its last timestamp as replay “now,” not the system clock; the practice recording is in October, not the hackathon weekend.
- Leaks and degradation get inspection recommendations, not shutdown countdowns. Pump failures require a countdown and a response planner; concurrent failures share the **system-wide** truck fleet, so plans cannot allocate trucks independently per facility.
- Recommendations do not rewrite recorded telemetry. Keep intervention effects in a separate what-if simulation; the source recording contains no operator actions.

## Checkout/tooling

| Area | Toolchain | Start here |
| --- | --- | --- |
| Operator API, contracts, web console (`apps/`, `packages/`, `frontend/`, `db/`) | Bun workspace (root `package.json`, `bun.lock`), Next.js | root `README.md`; `docs/plan/jason/backend-demo-runbook.md` |
| FPGA (`FPGA/`) | Vivado / Vitis on Lucas's PC; Icarus + SymbiYosys; Python model | `FPGA/AGENTS.md`, `FPGA/TASKS.md`, `HANDOFF.md`. `main` has the FPGA docs and spec; RTL, proofs, testbenches, model and scripts are on branch `FPGA` until Lucas merges them after T2.top. The board and Vitis workspace are only on Lucas's PC. `docs/research/check_fpga_plan.py <reference-repo>` re-runs the checks behind `docs/plan/lucas/review_notes.md`. |
| ML, ingest, board tooling (`ml/`) | Python 3.10+, `ml/requirements.txt` | `ml/README.md`, `ml/INTEGRATION.md`; tests: `cd ml && HUTD_DATA=<full_week> python -m pytest -q tests` |

**Branches:**

- `FPGA` is Lucas's (his agents push there);
- `ml` is Mudit's integration branch;
- `main` receives merges from both;
- feature branches (`feature/*`, `frontend-*`) merge into `main` through PRs reviewed against `global_plan.md`.

Run `python -m hutd_ml.fpga_sync` (in `ml/`) to see what changed on `FPGA` and whether the two references still
agree. Don't copy organizer-only commands from the external reference as if they run here.
