# FPGA/ — rules for agents

Read this before touching anything under `FPGA/`. It adds to the repo-wide rules in `../AGENTS.md` and
`../global_plan.md`; it never relaxes them.

## Read first, in this order

1. `../AGENTS.md`, then `../global_plan.md` §2 (hard rules) and §5 (contracts).
2. `../docs/plan/lucas/fpga_hardware_plan.md`: the FPGA design, a repo copy of Lucas's live doc. Never edit
   the live doc from automation.
3. `../docs/plan/lucas/review_notes.md`: open findings R1–R6 against that plan.
4. `spec/`: the **frozen module contracts** you build and prove against. If `spec/README.md` still says
   DRAFT, stop: wave 1 can't start until the spec is frozen (task T0.1).
5. `TASKS.md`: claim one task before you start.

## Roles and file ownership

Every task has exactly one role. You only write files your role owns; everything else is read-only to you.

| Role | Writes | Must not |
| --- | --- | --- |
| **Lead** | `spec/`, `TASKS.md`, `rtl/eog_defs.svh`, `scripts/`, `formal/common/` | Write module RTL or module proofs |
| **RTL** for module M | `rtl/eog_M.sv` (+ `ifdef FORMAL` *internal* invariants inside it) | Edit `formal/M/` or `tb/M/`; weaken a property |
| **Verify** for module M | `formal/M/` (harness `fv_eog_M.sv` + `eog_M.sby`), `tb/M/` | Read `rtl/eog_M.sv` beyond its port list while writing properties; edit RTL |
| **Model** | `model/` (bit-exact Python reference + vector generator) | Change numerics without a spec change |
| **Integration** | `rtl/eog_top.sv`, `vivado/`, `ps/`, `deploy/`, `host/` | Change a module's behavior to make integration pass |

Why: the verifier writes properties from the spec, not from the RTL, so the proof checks the design against
the contract instead of against itself. RTL authors may *add* internal invariants under `ifdef FORMAL` to help
k-induction converge; they may never edit or weaken the harness.

## When the spec is wrong or unclear

Don't guess and don't fix it locally. Add a row under **Spec questions** in `TASKS.md` with the module, the
question and your proposed answer, mark your task BLOCKED, and move to another task. Only the lead changes
`spec/`, and every change bumps `spec/VERSION` and adds a changelog row in `spec/README.md`.

## Coding rules (Yosys, Icarus, Verilator and Vivado must all accept the code)

- SystemVerilog synthesizable subset: `logic`, `always_ff`, `always_comb`, `localparam`, packed vectors.
  **No** `interface`, `struct`, `class`, `program`, or hierarchical references.
- Shared constants live in `rtl/eog_defs.svh` (`include` it); no SV packages.
- One clock `clk` (100 MHz FCLK0), synchronous active-low reset `rst_n`. No other clocks, no latches, no
  `initial` blocks in RTL (except `ifdef FORMAL`).
- Stage-to-stage links use the valid/ready handshake in `spec/conventions.md`: payload stable while
  `valid && !ready`; a transfer happens on `valid && ready`.
- Every size is a parameter (facilities, wells, features, cycles per record) so proofs can run on tiny
  instances. Defaults match the spec.
- Every multiply goes through `eog_mul` (one place), so `prove` can swap in the abstract multiplier from
  `formal/common/`.

## Definition of done for a module

1. `bash scripts/lint.sh M` clean (Verilator `--lint-only -Wall`, waivers justified inline).
2. `bash scripts/sim.sh M` prints `PASS`: the testbench matches the golden vectors from `model/` bit for bit.
3. `bash scripts/formal.sh M`: every SymbiYosys task (`prove`, `cover`, any `bmc`) is PASS. The report lands in
   `reports/formal_M.txt`.
4. `TASKS.md` updated: status DONE, commit hash, report path. No claim is DONE without its report.

## Git

- Work on your own branch, `fpga/<task-id>` (for example `fpga/T1.validate.rtl`), in its own worktree.
- Commit small and often; open a PR into the `FPGA` branch. Never force-push shared branches.
- Never commit generated output (sby work dirs, `build/`, Vivado projects, logs); see `.gitignore`.
- The repo shows CRLF-only diffs on some existing files; don't commit whitespace-only changes.

## Hardware

Only the **Integration** role touches Vivado, JTAG or the board, and only on the machine the board is plugged
into (Lucas's PC). The board is at 192.168.1.10 and the PC is at 192.168.1.50/24. Build, deploy and measurement
scripts are in `deploy/` and `vivado/`; see `docs/link_bringup.md` and the root of `deploy/` for the Windows
flow. Measured numbers go in reports with the command that produced them; estimates are labeled as estimates.
