# Start here, Jason: what's on `main` now, and where your magic goes

Updated Sun Nov 8, ~11:40 CST, at `main` after PRs #17–#25 (yours: #20 OpenRouter fallback, #23 Pipe View).
This is your folder: edit or replace it. The single source of truth stays [`global_plan.md`](../../../global_plan.md).

## 1. State in one minute

- **Everything is on `main` and green:**
  - API 157 pass, 1 skip, 0 fail;
  - frontend 133 pass;
  - both typechecks clean;
  - lint 0 errors.
- **The board side works on hardware:**
  - v4 board suite 12/12, bit-exact;
  - on Mudit's laptop the FPGA streams the full week into the console;
  - `replay.py` no longer lets the board go AUTONOMOUS (open issue B4), and it waits for a rebooting board.
- **Owners (final say):**
  - server: you;
  - agents and Nemotron: you and Mudit together;
  - spec, FPGA and RTL: Lucas;
  - ML, `replay.py` and `listen.py`: Mudit;
  - the console: Gurneal.

## 2. What runs where

```text
dataset folder ─ replay.py ─UDP─► Eclypse Z7 (or fakeboard.py) ─UDP─► listen.py ─► live.jsonl
                                                                                   │ BOARD_JSONL
operator API (apps/api) ◄──────────────────────────────────────────────────────────┘
  datasets (upload or DATA_ROOT folders) · runs/snapshots · incidents (from the board's `active`) ·
  shared-fleet planner + validator · Nemotron orchestrator + sub-agents · timeline · board feed
console (frontend): /  full console ·  /live  night-shift wall ·  /lab  your Pipe View ·  /internal/providers
```

## 3. API surface added today (all additive, read-only unless noted)

| Endpoint | What |
| --- | --- |
| `GET /api/datasets` | also syncs dataset folders under `DATA_ROOT` (new folders appear on the next call; bad ones are logged and skipped) |
| `GET /api/datasets/:id/timeline` | `SimulationTimeline`: every incident, each pump failure's plan at onset (cost vs doing nothing, `shutdownUnix` / `planShutdownUnix`), trucks booked without overlaps, tank levels. Cached per dataset and board-file state; incremental rebuilds; ends at the board's last result while it streams. Built in the background when a dataset loads |
| `GET /api/board` | the board feed: online, source, weights, last time, `recent` results, `flagged` per facility, the board's own `stats` |
| `GET /api/internal/providers` | yours: Brev / OpenRouter lane in use |

Upload limit is 160 MB / 2.5M rows: the largest network the board takes, 32 facilities × 8 wells, is about 1.5M rows
for a week. A facility the board scored with nothing active is now `ok` health, not `unknown`.

## 4. Agents: where they stand (measured, live Nemotron on Brev)

On the hardest moment of the practice week (Thursday 10:30: 3 S2 pumps down, 2 trucks, 6 open incidents):
- triage, the handoff and 3 of 4 plan explainers were accepted;
- about 50 s per run.

What changed to get there:
- Sub-agents see plans as short refs (P1, P2, …), mapped back to solver IDs.
- Scoped roles accept truncated incident IDs.
- Harmless prose is tidied, not rejected: line breaks, markdown, "->", "< 3h", a slight overrun, domain words capitalised.
- An unknown plan citation is dropped instead of failing the handoff.
- Triage and handoff get 12 calls.
- The contract asks for names, never IDs, in prose.

Still open, and the obvious places for your magic (`global_plan.md` I-17):
- **Plan explainers sometimes burn their 8 calls on `request_subtask`.** The guards refuse the subtask, the explainer
  loops, and the remaining one fails on a wrong `presentFirstPlanId` when both options are "Do nothing".
- **Speed:** 50 s is long on stage. Explainers run in parallel already; a smaller budget, or skipping explainers for
  do-nothing-only incidents, would cut it.
- **Prose:** handoffs still cite evidence IDs in the text. The console cleans them on screen; the prompt could avoid
  them.

`ml/hutd_ml/combined_suite.py` measures all of this in one command (board stages → agents at 4 cutoffs → API path →
stale drill). `python -m hutd_ml.unseen` makes an unseen network (S6–S11) to rehearse the judges' `test/` folder.

## 5. Your open PR

[#26](https://github.com/MuditUpadhyay04/HackUTD/pull/26), compact dataset storage. It matters more now: the
timeline and the live wall call `getDataset` often. The memory store is unaffected.

## 6. Run it

```sh
STORAGE_MODE=memory ALLOW_INSECURE_LOCAL=1 DATA_ROOT=<HackUTD-ZeroDay clone> BOARD_JSONL=<live.jsonl> BOARD_SOURCE=fpga bun run dev:api
```

```sh
ALLOW_INSECURE_LOCAL=1 HOSTNAME=127.0.0.1 bun run dev:web
```

Then open http://localhost:3000/live. On the board PC, `ml\win_demo.bat` does all of it;
`docs/plan/mudit/judging_day.md` is the procedure.
