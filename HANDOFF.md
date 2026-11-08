# HANDOFF: FPGA lead, session state

Living status file for Claude sessions working as the FPGA lead (`/fpga-lead`). **Read this first, then
`FPGA/TASKS.md`** (the single source of task status). Every lead session updates this file and pushes the `FPGA`
branch after each merged module or batch of agent launches, so the next session can pick up from here.

Not the same file as `FPGA/reports/RTL_DONE_HANDOFF.md`. That one is the lead's final deliverable: the handoff to
the original laptop (Lucas's PC, with Vivado and the board). It covers what is proven and simulated, resource and
timing estimates, open spec questions, and the exact steps to run there (T2.bd1, T2.board1, wave 3). It is written
once RTL is done (all T1 DONE plus T2.top), as `FPGA/KICKOFF.md` §3 requires.

- **Last updated:** 2026-11-07 ~23:55 CST, session `04653333` (takes over from session `bd64467f`).
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

Spec questions 1–15 are answered in `FPGA/TASKS.md`. **#12** (validate `PUMP_INCONS`/`WELL_INCONS` set only when
their inputs are OK) is a lead call that Lucas may reverse. **#8** (BTN0 active high at `eog_alarm`) needs
confirming against the board pinout in T2.bd1.

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

**In flight (launched ~00:05 CST Nov 8 by session `04653333`, 8 background agents):**
- Verifiers, each in its old worktree and told to `git merge --ff-only FPGA` first: T1.validate.fv, T1.memory.fv
  (resuming its partial harness), T1.alarm.fv, T1.features.fv (resuming its partial harness), T1.head.fv.
- RTL, in new worktrees the lead created: T1.features.rtl, T1.head.rtl, T1.countdown.rtl.
- All were launched as `general-purpose` agents told to read `.claude/agents/fpga-{verify,rtl}.md` as their role
  (see the start-folder gotcha below). All were told to commit WIP often. If a session dies, check each worktree's
  `git log` and `git status`, then relaunch on top of whatever is there.

**Second cutoff (~00:30 CST Nov 8):** the old account hit its 5-hour limit again and 7 of the 8 agents stopped. On a
new account they were resumed in place with their context (SendMessage). Progress committed at that point:
validate.fv 2aa31de (WIP harness + sby, prove passes on a stub; it never stopped), memory.fv 76e0072 → a51db02
(harness + INDEX-driven tb), features.fv 055a9ee (harness; sby + tb uncommitted), features.rtl 9441fc4 (smoke PASS
on all features vector cases), head.rtl c700642 (16 multipliers, II 13), countdown.rtl 29922fe (bit-exact on all
12 countdown cases). alarm.fv and head.fv had nothing committed yet; their files were untracked in their
worktrees. The features verifier's throwaway stub was sitting at `FPGA/rtl/eog_features.sv` inside its worktree,
and it was told to move it out. Never merge that file.

**Next:**
1. As each agent reports: set its TASKS.md row to REVIEW (with its commit). When both halves of a module are
   REVIEW, integrate: `git switch -c eog/integrate-<m> FPGA`, merge both branches, run `lint.sh`, `sim.sh` and
   `formal.sh <m>` (generate the gitignored `*_week` vectors in the main checkout first:
   `python FPGA/model/gen_vectors.py`), then merge to `FPGA`, set DONE, run `check_all.sh`, and push.
   validate, memory and alarm have their RTL in REVIEW, so they integrate as soon as their verifier lands.
2. Queue, launch as slots free up (unpack.fv is running): T1.countdown.fv, T1.pack.rtl/.fv,
   T1.regs.rtl/.fv, T2.ps1.
3. T2.top once all T1 rows are DONE, then write `FPGA/reports/RTL_DONE_HANDOFF.md`.

## Worktrees (`HackUTD/.claude/worktrees/…`)

| Worktree | Branch | State |
| --- | --- | --- |
| agent-af0da0adf8ae2eacc | eog/T1.div.rtl | merged; removable |
| agent-a6c7847cc814d8679 | eog/T1.div.fv | merged; removable |
| agent-ab6d24063ec9bbe52 | eog/T1.mul.rtl | merged; removable |
| agent-a28845771a06344fc | eog/T1.mul.fv | merged; removable |
| agent-a11baa6d27ec3bc76 | eog/T0.2 | merged; removable (holds the gitignored `*_week` vectors) |
| agent-a6562db654e6251c2 | eog/T1.validate.rtl | REVIEW 2dd4565 |
| agent-a19dfaf203f8e17cc | eog/T1.memory.rtl | REVIEW 560ee3b |
| agent-a00b1b054767aadb0 | eog/T1.alarm.rtl | REVIEW 3da09f1 |
| agent-ac27b540402503b46 | eog/T1.unpack.rtl | REVIEW bc4a760 |
| agent-a36e87a8076c7f193 | eog/T1.validate.fv | verifier (relaunch) |
| agent-adadf9ed52b6a452c | eog/T1.memory.fv | verifier (relaunch; partial harness on disk) |
| agent-a1ef26a5b3ad9ded0 | eog/T1.alarm.fv | verifier (relaunch) |
| agent-a065500e10062e0d1 | eog/T1.features.fv | verifier (relaunch; partial harness on disk) |
| agent-a58188a3ae0d5e3fb | eog/T1.head.fv | verifier (relaunch) |
| T1.features.rtl | eog/T1.features.rtl | REVIEW 9441fc4 |
| T1.head.rtl | eog/T1.head.rtl | RTL agent (new) |
| T1.countdown.rtl | eog/T1.countdown.rtl | RTL agent (new) |
| T1.unpack.fv | eog/T1.unpack.fv | verifier (launched after features RTL reported) |

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
- **Usage:** the last session burned its limit fast with about 8 parallel agents. Agents are now told to commit
  WIP often, so a cutoff loses little.
- **Previous transcript:**
  `~/.claude/projects/C--Users-gurne-Documents-Lucas-HackUTD-HackUTD-HackUTD/bd64467f-e6e3-4690-9a85-a24ecb88f3db.jsonl`
  (subagent transcripts are in the folder of the same name).
