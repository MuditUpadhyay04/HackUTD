# Kickoff on a new machine

Everything an agent needs is in this repo; no chat history is required.

## 1. Machine setup (once)

Linux or WSL2 (SymbiYosys is unreliable on native Windows).

```sh
# OSS CAD Suite: Yosys, SymbiYosys, solvers, Icarus Verilog, Verilator in one bundle.
# Download the latest linux-x64 release from https://github.com/YosysHQ/oss-cad-suite-build/releases
tar xzf oss-cad-suite-linux-x64-*.tgz -C ~/
echo 'source ~/oss-cad-suite/environment' >> ~/.bashrc && source ~/oss-cad-suite/environment
yosys -V && sby --help >/dev/null && iverilog -V | head -1 && verilator --version

git clone <this repo> HackUTD && cd HackUTD && git checkout FPGA
git clone https://github.com/nihaal419/HackUTD-ZeroDay ../HackUTD-ZeroDay   # practice data for the model
export EOG_DATA=$(realpath ../HackUTD-ZeroDay)

bash FPGA/scripts/sim.sh axi_mul && bash FPGA/scripts/formal.sh axi_mul             # both must PASS
```

## 2. Run

Start Claude Code at the repo root and run:

```
/fpga-lead
```

The lead reads the rules and spec, runs wave 0 (model + vectors, shared formal pieces), then spawns one
`fpga-rtl` and one `fpga-verify` agent per module in separate worktrees, merges each module when lint, sim and
formal all pass, and keeps `FPGA/TASKS.md` and `FPGA/reports/SUMMARY.md` current. Agent definitions:
`.claude/agents/fpga-*.md`; the lead's instructions: `.claude/commands/fpga-lead.md`.

To run a single task by hand instead: start a session in its own worktree
(`git worktree add ../wt-T1.validate.rtl -b fpga/T1.validate.rtl FPGA`) and ask the matching agent, e.g.
"Use the fpga-rtl agent for T1.validate.rtl".

## 3. What stays on Lucas's PC

Vivado/Vitis 2026.1, the board (JTAG + Ethernet at 192.168.1.10), and tasks T2.bd1, T2.board1, T3.*. The lead
finishes with `FPGA/reports/RTL_DONE_HANDOFF.md` describing what to run there. (The repo-root `HANDOFF.md` is a
different file: the live lead-session state, for resuming a session on this machine.)

## 4. Decisions baked into spec v1 (reversible by Lucas)

D1 countdown from facility inflow (review R1) · D2 tripped tank → countdown 0 (R2) · D3 feature shift S = 17 fixed,
20×32-bit multiplies (R3) · D4 countdown is a serial stage · D5 p50 = K·Δ·n / (sum·256). See `spec/numerics.md` §1.
