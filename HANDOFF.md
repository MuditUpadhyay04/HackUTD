# HANDOFF: FPGA lead, session state

Living status file for Claude sessions working as the FPGA lead (`/fpga-lead`). **Read this first, then
`FPGA/TASKS.md`** (the single source of task status). Every lead session updates this file and pushes the `FPGA`
branch after each merged module or batch of agent launches, so the next session can pick up from here.

Not the same file as `FPGA/reports/RTL_DONE_HANDOFF.md`. That one is the lead's final deliverable: the handoff to
the original laptop (Lucas's PC, with Vivado and the board). It covers what is proven and simulated, resource and
timing estimates, open spec questions, and the exact steps to run there (T2.bd1, T2.board1, wave 3). It is written
once RTL is done (all T1 DONE plus T2.top), as `FPGA/KICKOFF.md` §3 requires.

## ⚠ SPEC v4 (Sun Nov 8 ~01:00 CST, Lucas's laptop session) — read before anything else

Lucas decided to align the engine with Mudit's bit-exact reference (`ml/hutd_ml/features_int.py`, branch `ml`).
That is **spec v4**, committed on top of v3 (v2 observation ports and v3 `wb_rst_n` are kept). Everything built so
far used v1 numerics, so:

- **What changed:** `FPGA/spec/README.md` changelog row 4 and `spec/numerics.md` §1 (D6–D12). In short: countdown
  `review_r1r2` with a prefilled 16-entry ring and `mean = sum >>> 4` (D6, replaces D5); validation, hold, INVALID,
  timing and strict-`>` alarm rules as in `features_int.py` (D7); Night Shift latched like E-STOP (D8); reserved
  field → DROPPED/`FRAMING` (D9); per-class K in GLOBAL bytes 20–23 (D10); weight window = Mudit's blob, 71 words,
  version in word 70 (D11, was 69/68); feature debug readback (D12). Reason bits 11/13/14 and GLOBAL
  `SHUTIN_WATER_MAX` are gone. `EOG_SPEC_VERSION` = 4.
- **Unaffected:** mul, div (DONE), unpack (spec unchanged).
- **Rework (TASKS.md status `REWORK v4`):** validate, countdown, alarm (substantial); head (weight window, debug
  ports, word numbers); features, memory (small). Rework each from its existing branch/worktree, not from scratch.
  Verifiers in flight on these modules must re-read their module spec and update properties.
- **pack, regs:** not started; write them to v4 (regs gains DBGSEL/DBG and the 71-word window).
- **Order:** T0.2b first (update `model/` to v4 + `check_mudit.py`, see `model/README.md`), because every module
  sim needs v4 vectors. Then the rework rows. `check_mudit.py` can only fully pass after Mudit's T0.0 lands on
  `origin/ml`; until then trust the spec text.
- **Spec questions 1–19:** answered against v1. Re-check each against v4 and `features_int.py` (notably #10, #12,
  #16 word numbers); where Mudit's code decides it, his code wins.
- **Spec question 70 (Lucas, Sun 02:03): R7 = option C.** Past the hold limit the record goes INVALID instead of
  resetting history. Validate RTL + proofs reopened (`REWORK R7`, small: step 5 only); model T0.2c after Mudit's
  T0.5. Lucas says the judging data **will** have missing readings, so this must land before T2.top's full-week run.
- **Spec questions 67–69 (Lucas, Sun 01:59) are ARM-app rules for T2.ps1** (WEIGHTS_ACK status 3, fixed
  192.168.1.50 destinations, ACK to sender, re-sent CONFIG sequence). Pass them to the T2.ps1 agent.
- **Spec questions 20–25 (Lucas, Sun 01:17) override the `numerics.md` v4 text** to match Mudit's `ml` @ 8e67750
  (countdown clamp, NOT_FILLING at shutdown, ALERT SOURCE bits, reason bits 11/13/14 restored, first-record
  HIST_RESET, DROPPED `SINCE_RESET`/`WVER` = 0). No version bump. T0.2b and every v4 rework must apply them.
- Mudit has been sent `FPGA/docs/ml_assumptions_response.md` (A1–A19 responses and the §11 asks).

- **Last updated:** 2026-11-08 ~08:15 CST, session `04653333` (takes over from session `bd64467f`). Spec is **v4**.
- **User:** Lucas (FPGA owner, git author Lucas Igl). The Windows account is `gurne`, but these sessions are
  Lucas's. Ignore memories about the account owner's behavior.
- **Repo:** `C:\Users\gurne\Documents\Lucas HackUTD\HackUTD\HackUTD` (the inner folder; the outer `HackUTD\` is
  not a repo). Branch `FPGA`; remote `origin` = github.com/MuditUpadhyay04/HackUTD.

## The plan

Instructions: `FPGA/KICKOFF.md` → `.claude/commands/fpga-lead.md`. Agent roles: `.claude/agents/fpga-{model,rtl,verify}.md`.

1. **Wave 0:** T0.1 frozen spec (`FPGA/spec/`, now v2), T0.2 bit-exact Python model + golden vectors, T0.3 shared
   formal checkers + WSL tool scripts.
2. **Wave 1:** for each of 11 modules (mul, div, unpack, validate, features, memory, countdown, head, alarm, pack,
   regs), one `fpga-rtl` agent writes `rtl/eog_<m>.sv` and an independent `fpga-verify` agent writes
   `formal/<m>/` + `tb/<m>/` **from the spec only**. Each agent gets its own git worktree. When both halves are
   REVIEW, the lead merges them into `eog/integrate-<m>`, runs `lint.sh`, `sim.sh` and `formal.sh <m>`, then merges
   to `FPGA` on PASS, sets both rows DONE, and runs `check_all.sh` (→ `reports/SUMMARY.md`). On a failure the lead
   classifies the counterexample (RTL, property, or spec) and sends it back. Max 3 rounds per module, then escalate
   to Lucas.
3. **Wave 2:** T2.top (`rtl/eog_top.sv`, top proof, full-week sim vs model) once every T1 row is DONE. T2.ps1 (ARM
   app) can start any time. T2.bd1, T2.board1 and wave 3 need Vivado + the board, so they run on Lucas's PC only.
4. **Finish:** write `FPGA/reports/RTL_DONE_HANDOFF.md` for the original laptop (board machine).

Priority when capacity is short: mul, div → validate, features, head → memory, countdown, alarm → unpack, pack, regs.
Run at most 8 agents at once.

## Done

| Item | Evidence |
| --- | --- |
| T0.1 spec frozen (v1, then v2 = formal-only observation ports, conventions §7) | `FPGA/spec/`, `spec/VERSION` = 2 |
| T0.3 formal common + WSL scripts | 5d34900; `reports/formal_common.txt`, `reports/formal_axi_mul.txt` |
| T0.2 model + vectors | b873096, merged f9c083b; `python FPGA/model/test_model.py`: 13 passed / 0 failed (re-run this session) |
| eog_div (T1.div.rtl + .fv) | merged 1565f11; `reports/formal_div.txt`; sim PASS 19,123 divisions |
| eog_mul (T1.mul.rtl + .fv) | merged caf9580; `reports/formal_mul.txt` (prove, prove_w, bmc_feat, bmc_head, cover); sim PASS 736,704 products |
| eog_unpack (T1.unpack.rtl + .fv) | merged 39fd4ed; `reports/formal_unpack.txt` (prove = abc pdr, bmc, cover); sim PASS 108,846 records / 653,031 beats |

**Spec is v4** (f32f60b, Lucas): see the ⚠ section at the top. v3 (`eog_head.wb_rst_n`, a350f71) is kept.
Spec questions 1–19 were answered against v1 and must be re-checked against v4 (agents were told to). **#8** (BTN0
active high at `eog_alarm`) still needs confirming against the board pinout in T2.bd1.

**Integrated against v1 only (not merged; evidence kept):** features. `eog/integrate-features` (RTL 9441fc4 + proofs
b0f7bd1): lint ok, sim PASS 72,564 records, formal cover/prove/prove_f4 PASS (`reports/formal_features.txt` on that
branch). Spec v4 sends it back for a small rework.

## How the last session ended (bd64467f, 22:27–22:59 CST)

It hit the 5-hour usage limit at ~22:53. **Six background agents failed, all with HTTP 429 (usage limit), none
from a bug in their work:** T0.2, T1.memory.fv, T1.features.fv, T1.validate.fv, T1.head.fv, T1.alarm.fv. Two
finished just before the cutoff: T1.mul.fv (8b25855) and T1.unpack.rtl (bc4a760). The lead had integrated mul
(lint/sim/formal PASS) but not merged it; Lucas committed the report as `WIP` 56a2629.

What was left on disk, and what this session did with it:

- **T0.2:** finished (suite 13/13, vectors generated) but never committed. Re-ran the suite (PASS), committed it as
  b873096 and merged it.
- **mul:** merged `eog/integrate-mul` into `FPGA` (caf9580).
- **features.fv, memory.fv:** partial harness files, uncommitted, in their worktrees. Relaunching on top of them.
- **validate.fv, head.fv, alarm.fv:** nothing written. Relaunching from scratch in the same worktrees.

## In flight / next steps

**Spec v4 replan (Nov 8 ~01:10, after a third usage cutoff and an account switch).** Lucas's order: T0.2b first,
then rework validate, features, memory, countdown, head and alarm from their existing branches (verifiers re-read
their specs), write pack and regs to v4 from the start, leave mul, div and unpack alone.

**STATE ~08:15: every T1 module DONE on spec v4** (regs last, e921032). `FPGA/reports/RTL_DONE_HANDOFF.md` is written
(proven / bounded / simulated per module, estimates, open items, board steps). T2.top REVIEW (top formal not closed).
T2.ps1, T2.sd DONE (host). **Final `check_all.sh` on FPGA @ 3560bda: ALL PASS** (lint/sim/formal every module, top
sim; no UNKNOWN/FAIL in any formal_*.txt; 93 min). `reports/SUMMARY.md` + formal reports committed.
**Answered Lucas (~11:40):** "loading new weights during operation" = UDP 7004 WEIGHTS → ARM checks (len 2 / CRC 1 /
header+self-test 3) → write inactive bank words 0–70 → `CTRL.swap_req` → head swaps at record boundary (1 cycle
in_ready=0, H1–H3 proven) → ACK 4 (or 0 if still pending). No warm-up; thresholds/K are GLOBAL (needs stop+drain, #69).
Gap: no live mid-stream swap on the board yet; suggested adding `replay.py --swap-at-step` to board acceptance.
**Board (laptop) findings:** `D:\LEAD_board_findings.md` (laptop) → lead response `FPGA/reports/LEAD_board_response.md`
(B4 replay corruption is not the RTL: E0–E5 experiments; 100 MHz fails by 8 ns in validate, prototyped plan; 50 MHz
demo; memory ram_style; trial merge of `eog/T2.bd1` passes on local branch `scratch/bd1-trial`, not pushed).
**Waiting on Lucas: D1–D5** in that response. Lucas's ground rule: no RTL/spec/ARM-app edits for board findings until
he approves.
**Next after approval:** merge `eog/T2.bd1` (D4), then the approved fixes, re-run `check_all`, then the full FPGA → main
PR.

**SD boot + default weights (Lucas, ~05:30):** the board always boots from microSD and loads `weights.eog` at boot
(read-only card; UDP 7004 still overrides at run time; CONFIG still comes from the PC). Branch `eog/T2.sd`; overview for
integration agents: `FPGA/docs/SD_BOOT_WEIGHTS.md` (on that branch). No RTL, spec or wire change.

**Out-of-order fast path (Lucas, ~04:20):** T2.top started before the last T1 sign-offs (branch `eog/T2.top`, includes the
countdown/head/regs RTL branches). Lucas can start now on his PC: Vivado block design with `eog_top` as a black box
(eog_top.md ports, 0x43C1_0000, XDC, BTN0 polarity #8) and out-of-context synth of the merged modules for 100 MHz timing.
Formal sign-off and check_all continue in parallel with bring-up; a real bug found there means an RTL patch and a rebuild.

**Docs on main (~04:10):** PR #5 (`docs/fpga-plans`, docs only: spec, TASKS, KICKOFF, plans, HANDOFF, agent defs)
merged into main as d16e111; main was merged back into FPGA (5449bbc) so the later full FPGA → main merge is clean.
Plan: open the full FPGA → main PR after T2.top and the final `check_all`.

**Sign-off standard agreed (Lucas, ~03:50):** three tiers (proven / bounded non-vacuous / simulated bit-exact), see
`FPGA/TASKS.md` "Sign-off standard". Use it for every module and for `RTL_DONE_HANDOFF.md`. Lucas's decisions ~03:40:
#59 add the regs `rec_in` tap (done, regs bfd6b44), #73 integration updates the plan table, #77 the server team adds
the acknowledge message.

**Update ~03:10:** alarm DONE (1bed865); pack RTL (9e684bc) and regs RTL (ac0d183) in REVIEW, so every module's RTL
is written. Lucas's rulings #67–#70 landed (59ee67b): #67–#69 go to the ARM app (T2.ps1 agent told); **#70 R7 option C
reopens validate** (hold overflow → INVALID + FIELD_LOST, no history reset). Validate RTL and verifier were resumed for
it, and the model agent is doing T0.2c (model + vectors for #70). Mudit's T0.5 (R7 in features_int.py) is pending;
ml checkout now at 5e013eb (v3 weights and goldens, pre-R7). In flight: verifiers for countdown, head, memory, pack,
regs; validate RTL + verifier (R7); T0.2c; T2.ps1.

**State at ~02:55 (Nov 8):**
- **DONE on spec v4:** T0.2b (model = Mudit @ d1ba779 byte for byte, check_mudit full PASS), validate, features; plus
  mul, div, unpack (unaffected by v4). See TASKS.md for hashes and reports.
- **Integrating:** alarm (`.claude/worktrees/integrate-alarm`, branch `eog/integrate-alarm`): lint ok, sim PASS
  200,130 records / 1,236 ALERTs; formal running. On PASS: commit the report there, then in the main checkout
  `git merge --no-ff eog/integrate-alarm`, set both rows DONE.
- **RTL REVIEW, waiting on its verifier:** countdown 8b386e5 (verifier running), head 5358207 (verifier running),
  memory ac38fd3 (verifier running), pack 9e684bc (verifier running).
- **In flight:** verifiers for countdown, head, memory, pack; regs RTL + verifier (new, medium effort).
- Integration recipe for the rest: a worktree per module (`git worktree add -b eog/integrate-<m>
  .claude/worktrees/integrate-<m> FPGA`), merge the RTL and verifier branches, generate the git-ignored vectors there
  (`EOG_DATA=… EOG_ML=…/ml/ml python FPGA/model/gen_vectors.py`), then `lint.sh`/`sim.sh`/`formal.sh <m>`.
- After the last merge: `check_all.sh` (slow now: validate and alarm formal take 6–20 min), then T2.top.

**Queue:** T2.ps1 (ARM app; can start any time), then T2.top once every T1 row is DONE.

**Then:** integrate each module when both halves are REVIEW (`git switch -c eog/integrate-<m> FPGA`, merge both,
`lint.sh`/`sim.sh`/`formal.sh <m>`, merge to FPGA, DONE, `check_all.sh`, push). T2.top when all T1 rows are DONE,
then `FPGA/reports/RTL_DONE_HANDOFF.md`.

## Worktrees (`HackUTD/.claude/worktrees/…`)

| Worktree | Branch | State |
| --- | --- | --- |
| agent-af0da0adf8ae2eacc, agent-a6c7847cc814d8679 | eog/T1.div.rtl, .fv | merged; removable |
| agent-ab6d24063ec9bbe52, agent-a28845771a06344fc | eog/T1.mul.rtl, .fv | merged; removable |
| agent-a11baa6d27ec3bc76 | eog/T0.2 | merged; removable |
| T0.2b | eog/T0.2b | model v4 (in flight) |
| agent-ac27b540402503b46, T1.unpack.fv | eog/T1.unpack.rtl, .fv | merged (unpack DONE, 39fd4ed); removable |
| agent-a6562db654e6251c2 | eog/T1.validate.rtl | REWORK v4 (in flight) |
| agent-a36e87a8076c7f193 | eog/T1.validate.fv | verifier, v4 (in flight) |
| T1.countdown.rtl | eog/T1.countdown.rtl | v4 rework done 9dc2ca5; waiting for v4 vectors |
| T1.countdown.fv | eog/T1.countdown.fv | verifier, v4 (in flight) |
| agent-a00b1b054767aadb0 | eog/T1.alarm.rtl | v4 rework done a130317; waiting for v4 vectors |
| agent-a1ef26a5b3ad9ded0 | eog/T1.alarm.fv | verifier, v4 (in flight) |
| T1.head.rtl | eog/T1.head.rtl | REWORK v3+v4 (in flight; 364fe4c) |
| agent-a58188a3ae0d5e3fb | eog/T1.head.fv | verifier, v4 (in flight) |
| T1.features.rtl | eog/T1.features.rtl | REWORK v4 (in flight; v1 version 9441fc4) |
| agent-a065500e10062e0d1 | eog/T1.features.fv | REWORK v4 (queued; v1 version b0f7bd1) |
| agent-a19dfaf203f8e17cc | eog/T1.memory.rtl | REWORK v4 (queued; v1 version 560ee3b) |
| agent-adadf9ed52b6a452c | eog/T1.memory.fv | verifier (queued) |
| `..\ml` (outside the repo) | detached origin/ml 296dd48 | read-only checkout of Mudit's code for agents |

## Machine notes and gotchas

- **Start Claude Code in the inner repo folder** (`...\HackUTD\HackUTD`). Started from the outer `...\HackUTD`, the
  `fpga-rtl`, `fpga-verify` and `fpga-model` agent types and `/fpga-lead` are not loaded, and `isolation: worktree`
  is unreliable. Workaround: create the worktree with `git worktree add -b eog/<task> .claude/worktrees/<task>
  FPGA`, then launch a `general-purpose` agent that reads the role file first and works only in that path.
- **Push auth:** `git push origin FPGA` goes through Git Credential Manager, which can sit waiting at a sign-in
  window. Look for that window if a push hangs.
- **Tools:** Git Bash on Windows; the OSS CAD Suite lives in WSL. `FPGA/scripts/{lint,sim,formal,check_all}.sh`
  re-run themselves in WSL. For anything else use `bash FPGA/scripts/wsl.sh <cmd>`.
- **Python:** in Git Bash it is `python` (3.13). `python3` is a broken Store stub.
- **Dataset:** `EOG_DATA=C:/Users/gurne/Documents/Lucas HackUTD/HackUTD/HackUTD-ZeroDay`. Only
  `model/test_model.py` may read `answer_key.json` (global_plan hard rule 1).
- **Vectors:** `python FPGA/model/gen_vectors.py` (~10 s) regenerates everything, including the gitignored
  per-module `*_week` files. `tb/vectors/INDEX.txt` describes every case. The event kinds are `swap`, `touch`,
  `cfg`, `wts`, `ack`, `hb`, `hb_expire`.
- **Branch names:** `eog/<task-id>`, because `fpga/*` collides with `FPGA` on a case-insensitive filesystem. `FPGA`
  is also a directory name, so use `git switch FPGA` and `git diff FPGA other --`.
- **Claude Code safety check:** it blocks globbed removals such as `rm -f tb/vectors/*`; don't work around it.
- **Resuming agents:** a new session cannot SendMessage an agent from an ended session. Its files survive in its
  worktree, so relaunch a fresh agent pointed at that worktree path and tell it what is already there.
- **Yosys 0.70:** avoid packed 2-D arrays declared in one generate block and indexed from a nested one. Labeled
  asserts inside `for` loops can duplicate cell names, so fold them into vectors.
- **Subagent effort (Lucas, Nov 8):** launch every NEW subagent with `effort: "medium"`; `"high"` only when really
  needed; never `"xhigh"`/`"max"`.
- **Usage:** each account lasts roughly an hour with 8 parallel agents. On a cutoff, Lucas switches accounts; resume
  every stopped agent with SendMessage (same session) and give it its last commit and any uncommitted files.
- **Shared WSL and scratchpad:** never kill processes you didn't start (no `pkill`/`killall` or cwd-based kills; one
  agent's cleanup script killed others' proofs on Nov 8 ~00:26). Each agent keeps scratch files in its own
  scratchpad subfolder.
- **Previous transcript:**
  `~/.claude/projects/C--Users-gurne-Documents-Lucas-HackUTD-HackUTD-HackUTD/bd64467f-e6e3-4690-9a85-a24ecb88f3db.jsonl`
  (subagent transcripts are in the folder of the same name).
