@AGENTS.md

FPGA work: also read @FPGA/AGENTS.md. To start the FPGA agent workflow, run the `/fpga-lead` command.

FPGA lead / orchestrator sessions (not module agents): read `HANDOFF.md` at the repo root first. It is the live
session state (what's done, what's in flight, which worktree is which, machine gotchas). Update it and push the
`FPGA` branch after every merged module or batch of agent launches.

Board-machine sessions (Lucas's laptop with Vivado/Vitis and the Eclypse Z7): read @FPGA/docs/BOARD_SESSION.md
first (machine paths, build/test scripts, results, open B4 issue), then `FPGA/LAPTOP_WORKORDER.md`.
