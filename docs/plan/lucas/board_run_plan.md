# Board run plan: from T2.top to the first live run

Lucas's answers to Mudit's three questions, Sun Nov 8, about 02:45 CST. Copied from his reply; the
cross-team summary is in [`global_plan.md`](../../../global_plan.md) §7. "Weights v4" means the ML model weights
(`ml/artifacts/v4/`); FPGA spec v4 is a separate thing.

## 1. Weights for the board run and the demo

**Weights v4 by default, v3 as the fallback.** The judging data will have missing readings, and v4 does much better
there. With 2 % of readings missing under R7 option C:

| | v4 | v3 |
| --- | --- | --- |
| False alerts per facility-day (leak / degradation) | 0.03 / 0.17 | 0.21 / 0.11 |
| Average precision (leak / degradation) | 0.98 / 0.89 | 0.93 / 0.77 |

On clean data, v4 detects leaks about 5 min later than v3 (median 10 min vs 5 min after onset). Board verification
also uses the weights v4 golden sets.

## 2. Order and timing after T2.top

| Step | What | Where | Time (estimate) |
| --- | --- | --- | --- |
| a. T2.top | `eog_top`, the top-level proof, and the full-week simulation, bit for bit against the model and the weights v4 G0 / G1 / G2. Starts once countdown, head and regs are signed off. Countdown and head are in integration; regs RTL is in review and its verifier hasn't finished: **regs is the long pole**. | other machine | — |
| b. T2.bd1 | Block design, constraints for LEDs / BTN0 / Pmods, Vivado build | Lucas's PC | 30–60 min the first time |
| c. ARM app | `eog_app` is merged and host-tested against `wire.py` and `board.py`: a Vitis build plus programming the board | Lucas's PC | about 10 min |
| d. T2.board1 | In this order, each byte-identical before the next: `board.py --golden artifacts/v4/golden/g0`, then `g2`, then `g1` (30,240 records), then `--heartbeat-test 6` (AUTONOMOUS mode + replay) | board | 15–30 min if nothing breaks |
| e. First live run | Right after G1 passes: `replay.py` streams weights v4 with its `global_config.json` over the full week, and `listen.py` sends JSON to Jason's server. The live weight swap (`--swap-at-step`) comes after that. | board PC → server | — |

No clock times until regs and T2.top land. Lucas pings Mudit when T2.bd1 starts.

## 3. Next FPGA step

T2.top → T2.bd1 → T2.board1, once countdown, head and regs are signed off under the three-tier standard (proven,
bounded, simulated; `FPGA/TASKS.md` "Sign-off standard"). The ARM app (T2.ps1) is already done, so it isn't on the
path.
