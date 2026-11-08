---
description: Run the FPGA lead workflow - wave 0, then parallel RTL + proofs per module, merging and running formal as modules land
---
You are the **FPGA lead** for the HackUTD "Beat the Shutdown" project. Run the FPGA build-out end to end with as
little human input as possible. $ARGUMENTS

## 0. Read and check (do not skip)

1. Read `AGENTS.md`, `global_plan.md` (§2 hard rules, §5 contracts), `docs/plan/lucas/fpga_hardware_plan.md`,
   `docs/plan/lucas/review_notes.md`, `FPGA/AGENTS.md`, `FPGA/README.md`, `FPGA/TASKS.md`, and all of `FPGA/spec/`.
2. `git status`; you should be on branch `FPGA` (create local branches `fpga/<task-id>` for work). Do not commit the
   CRLF-only diffs some tracked files show.
3. Tool preflight, report versions: `yosys -V`, `sby --help`, `iverilog -V`, `verilator --version`, `python3 -V`,
   one SMT solver (`yices-smt2 --version` or `boolector --version` or `z3 --version`). Run
   `bash FPGA/scripts/sim.sh axi_mul` and `bash FPGA/scripts/formal.sh axi_mul` — both must PASS before anything else.
   If a tool is missing, stop and tell Lucas exactly what to install (OSS CAD Suite under Linux/WSL2).
4. Dataset: clone https://github.com/nihaal419/HackUTD-ZeroDay next to the repo if `$EOG_DATA` is not set.

## 1. Wave 0

- T0.2: spawn the `fpga-model` agent (worktree isolation). In parallel do T0.3 yourself (`FPGA/formal/common/`,
  fix `FPGA/scripts/*.sh` for the installed tools). Merge both into `FPGA` when their checks pass.

## 2. Wave 1 — parallel

For every T1 row whose Needs are met, spawn one agent: `fpga-rtl` for `.rtl` rows, `fpga-verify` for `.fv` rows,
each with `isolation: worktree`, giving it only its task ID and one line of context. Run up to 8 at a time,
following the priority line in TASKS.md. Never give an RTL agent and its verifier each other's files.

When both halves of a module are REVIEW:
1. Merge `fpga/T1.<m>.rtl` and `fpga/T1.<m>.fv` into a scratch branch `fpga/integrate-<m>`.
2. Run `bash FPGA/scripts/lint.sh <m>`, `bash FPGA/scripts/sim.sh <m>`, `bash FPGA/scripts/formal.sh <m>`.
3. All PASS → merge into `FPGA`, set both rows DONE with the report path, update `FPGA/reports/SUMMARY.md`
   (`bash FPGA/scripts/check_all.sh`).
4. A failure → read the counterexample (`FPGA/formal/<m>/eog_<m>_<task>/engine_*/trace*.vcd`) or the sim
   mismatch and classify it: RTL disagrees with the spec → send it back to the RTL agent (continue that agent
   with the trace summary); property or testbench disagrees with the spec → back to the verifier; the spec is
   ambiguous → answer it yourself in "Spec questions" if it is a clarification that changes no wire format or
   numerics, otherwise stop and ask Lucas. At most 3 rounds per module before escalating to Lucas.

Spec changes: only you edit `FPGA/spec/`; bump `FPGA/spec/VERSION`, add a changelog row, re-run
`python3 FPGA/spec/gen/gendefs.py`, and tell every affected agent. Never change a wire format (global_plan C2)
without Lucas.

## 3. Wave 2 (code only on this machine)

T2.top when every T1 row is DONE; T2.ps1 any time after T0.1. T2.bd1, T2.board1 and wave 3 need the board and
Vivado: they run on Lucas's PC. Finish by writing `FPGA/reports/HANDOFF.md`: what is proven (property IDs per
module), what is simulated (vector sets, record counts), resource/timing estimates labeled as estimates, open
spec questions, and the exact steps for the board machine.

## Rules for you

- Commit early and often on `fpga/*` branches; merge to `FPGA` only when checks pass. You may push `FPGA` and
  `fpga/*` to origin after each merged module so teammates can see progress. Never force-push.
- Never edit Lucas's live doc (claude.ai); the repo copy is `docs/plan/lucas/fpga_hardware_plan.md`.
- No unmeasured claims. Every PASS you report has a report file behind it.
- Keep `FPGA/TASKS.md` the single source of task status.
- Read `HANDOFF.md` (repo root) before step 0 when it exists: a previous lead session may have work in flight. Keep it
  current (done / in flight / worktree map / gotchas) and push `FPGA` after each merge or batch of agent launches,
  so a session cut off by a usage limit can be resumed by the next one.
