# Nemotron + v4 + FPGA: the combined test

Status: **steps 0–3 done (board suite all PASS on hardware); the combined run on the board is next** (Sun Nov 8, 07:55 CST; plan written 07:25). Owners: agents and Nemotron **Mudit + Jason** (`global_plan.md`,
O18); board **Lucas**. It runs right after the v4 board suite passes on the board.

**Goal:** real board results (weights v4 on the Eclypse Z7) become the incidents the Nemotron agents investigate. Their
validated explanations and handoff appear in the console, and every link in the chain is checked:

```text
dataset → replay.py → FPGA (v4) → listen.py → board results → API run (incidents from the board) → orchestrator
        → Nemotron sub-agents → validators → console
```

## 1. What the deep dive found

Checked in the code on `ml` (PR #12) and by running the agents' fact builder on board JSON from the software board.

| # | Finding | Evidence | Consequence for the test |
| --- | --- | --- | --- |
| F1 | **v4's leak and degradation detections never become incidents.** API runs use the software runtime, which without a registered model only opens pump failures ("Classifier unavailable"). | `apps/api/src/features/runtimes/service.ts` L114–140, L216. Probe at step 1030: the API has the 3 S2 pump failures; the board also has degradation at S3 A and S4 C and a leak at S5 B. At step 1080 the API has **no** incidents while the board has 3 problems. | Without step 2, the test only shows Nemotron explaining pump failures. v4's real value (leaks, worn pumps) is invisible, and the console says "nothing ongoing" while the board alarms. |
| F2 | Board results reach the agents only as a side list of per-facility facts, read from a JSONL file. | `BOARD_JSONL` (API, `config.ts` L33) or `--board` (`scripts/agent-run.ts`); `readBoardJsonl` in `orchestration/cases.ts` | Works for a first test without new endpoints. A live file works: the API re-reads it for every agent run. |
| F3 | **Every board fact is labeled `fakeboard`**, even from the FPGA. | `readBoardJsonl(path, source = "fakeboard")`; `listen.py` JSON has no source field (I-19) | The agents and the console would mislabel real board results (hard rule 11). |
| F4 | Board facts have **no staleness flag and no model version**. | `boardAt` takes the latest result at or before the cutoff, however old; `BoardFact` has no `weights_ver` | If the board stops, old results look current (hard rule 9). After a live swap the agents can't tell v3 from v4. |
| F5 | `tools.ts` still defaults `nowUnix` to 0. | `apps/api/src/features/agents/tools.ts` L16 (I-8) | An agent could see "now" = 1970 if a snapshot lacks it (hard rule 3). |
| F6 | The Nemotron endpoint can't be checked from the cloud session (proxy 403). Jason's runbook gave 31.9 h of credit at Sat 22:01 ($1.80/h), so roughly until Mon ~06:00, if nothing else used it. Rate limit 10 req/s, burst 20; the orchestrator uses 3 concurrent slots. | `docs/plan/jason/nemotron-inference-operations.md`; `agent-loop-plan.md` §9 | Pre-flight from a team machine before the test (step 4). |
| F7 | A Python client to Nemotron needs a User-Agent (Cloudflare error 1010). Bun's `fetch` is fine. | `agent-loop-plan.md` §1 | Only matters if a Python tool ever calls Nemotron directly; the agents call it from Bun. |
| F8 | The board's server-down replay (B4) corrupts some buffered results. | `global_plan.md` O16 | Keep the server-down drill out of this test and the demo. |

What already works: board results at the cutoff (the latest per facility, never from the future), `active` (K in a row)
as the detection, the orchestrator and validators, Nemotron live (8/8 accepted at checkpoint C1), and the board
suite's L1, which leaves the full-week board JSON on Lucas's laptop.

## 2. Topology

| Option | How | When |
| --- | --- | --- |
| **B, store and forward** (first) | The board suite's L1 run on Lucas's laptop writes `board_suite_*/L1_full_week.jsonl`. Copy that file to the agent machine (Bun + the root `.env` with the Nemotron key; Mudit's or Jason's), then run the agents on it. | Right after the board suite: nothing new to install on Lucas's laptop, and any machine with internet reaches Nemotron. |
| **A, live on one laptop** (second) | On Lucas's laptop: board on the direct cable (192.168.1.50 ↔ .10); internet over Wi-Fi for Nemotron; `listen.py` writes a live JSONL and POSTs to the console's `/api/ingest`; the API runs in memory mode on loopback with `BOARD_JSONL` set to that file; console on localhost. Needs Bun on Windows, the repo at `main`, and the `.env` (key from Jason, never committed). | After B passes: this is the demo set-up. |

A third option, `listen.py` POSTing across machines into the operator API, needs the board-ingest endpoint and an
auth-token option (I-1, I-19). It isn't needed for this test.

## 3. Steps

Steps 1–3 run in parallel with Lucas's board suite; estimates in hours of work.

| Step | What | Owner | Size | Done when |
| --- | --- | --- | --- | --- |
| **0. Gate** — **PASSED on hardware, Sun 08:05** (every test, including the live demo path and the swap) | v4 board suite on the board: `python -m hutd_ml.board_suite --data <full_week> --reset-cmd "<FPGA checkout>\deploy\win_deploy_eog.bat"` (or double-click `FPGA\deploy\win_board_suite.bat`). Keep the output folder: L1's JSONL is the board data for step 5. | Lucas | runs ~10–15 min | B1–B3, B5, B6, L1, L2, L3 PASS |
| **1. Provenance and staleness** (F3–F5) — **DONE** (`de36e16`) | (a) `listen.py --source fpga\|fakeboard` (default: loopback board address → `fakeboard`, otherwise `fpga`), written into every JSON object. (b) `boardFacts` reads `source` from each line; `BoardFact` gains `weightsVer` and `stale` (older than 2 steps at the cutoff); the agent tools show both; `agent-run.ts --board-source` and `BOARD_SOURCE` override. (c) I-8: drop the `nowUnix ?? 0` default. | Mudit (a), Mudit + Jason (b, c) | ~1 h with tests | Facts from the FPGA say `fpga`, `weights_ver` 4, `stale` false; a snapshot without "now" is refused, not 0 |
| **2. v4 detections become incidents** (F1, the core) — **DONE** (`7e974d0`) | `buildRunSnapshot` takes board results. When present, the leak / degradation / failure heads come from the board's `active` (K already applied); confidence from `probability`; onset = the first record of the run of `above_threshold` that led to `active`; resolved after 3 steps without it (`ml/INTEGRATION.md` §4). Provenance `fpga` / `fakeboard` and `modelVersion` "weights_ver 4"; `scoresAvailable` true; runtime reasons say "board results". Board INVALID / DROPPED records freeze the streaks, as now. Pump status 2 still opens a failure on its own. Feed it from `BOARD_JSONL` (API) and `--board` (`agent-run.ts`, `agent-weeks.ts`). `Snapshot.board` filled (part of I-2). | Mudit + Jason | ~2 h (≈60 lines in `runtimes/service.ts`, plumbing, 3–4 tests) | On the software board's JSON: at step 1030 the incidents are 3 pump failures plus degradation at S3 A, S4 C and a leak at S5 B (provenance `fakeboard`); at 1080 the 2 degradations and the leak; leaks and worn pumps get inspection advice, failures get countdown + plan. `bun run test` green. |
| **3. Rehearse on the software board** — **DONE**, now one command: `ml/COMBINED_TEST.md` | `fakeboard.py` + `listen.py --source fakeboard --jsonl sw.jsonl` + `replay.py` (v4, full week, `--step-seconds 0.05`). Then `agent-run.ts` at the cutoffs below (needs the Nemotron key) and the API + console with `BOARD_JSONL=sw.jsonl`. | Mudit | ~30 min | §4 criteria pass with source `fakeboard` |
| **4. Nemotron pre-flight** — endpoint answers (200, `max_model_len` 1,048,576) and live runs work from the cloud session (Sun 07:40) | On the machine that will run the agents: Brev instance running and credit left; key in the root `.env`; `curl -A hutd-check -H "Authorization: Bearer $NVIDIA_API_KEY" https://hackutd-26-llm.jasonaa.me/v1/models` → 200; `bun run dev:api` then `/api/health` shows `agentModel` (thinking off); one analysis accepted. | Jason | 15 min | 200, and one `source: nemotron` analysis |
| **5. N1: combined test, store and forward** | Copy L1's JSONL from step 0 (`fpga.jsonl`), or have Lucas double-click `ml\win_combined_suite_board.bat` (no Bun needed) and send its two `L*.jsonl`; then `combined_suite --board-jsonl … --heldout-jsonl … --source fpga --skip A` runs everything below. Run `agent-run.ts --data <full_week> --board fpga.jsonl --board-source fpga --json n1_<step>.json` at steps 1030, 1080 and 2015, and on `mock_test` at its "now" (held out). Then the API with `BOARD_JSONL=fpga.jsonl BOARD_SOURCE=fpga`, a run at step 1030, `POST /api/runs/:id/agents`, and the console's Agents view. | Mudit + Jason, data from Lucas | ~45 min | §4 criteria, with source `fpga` |
| **6. N2: live, on Lucas's laptop** | One command first: `ml\win_agents_setup.bat`, then `ml\win_combined_suite.bat` (`ml/COMBINED_TEST.md`). The live demo set-up: Terminal 1: `listen.py --data <full_week> --model artifacts/v3 --model artifacts/v4 --source fpga --jsonl live.jsonl --post http://127.0.0.1:3000/api/ingest`. Terminal 2: API (`STORAGE_MODE=memory ALLOW_INSECURE_LOCAL=1 BOARD_JSONL=…\live.jsonl BOARD_SOURCE=fpga bun run dev:api`). Terminal 3: console (`BOARD_INGEST=1 ALLOW_INSECURE_LOCAL=1 bun run dev:web`; with `INGEST_TOKEN` set, add `?token=…` to the `--post` URL). Terminal 4: `replay.py` v4 full week at `--step-seconds 0.05`. Then a run at step 1030 and the agents, while the replay continues. | Lucas + Mudit / Jason | ~1 h first time (Bun install, `.env`) | §4 criteria live; the console shows the board feed and the agents' handoff |
| **7. Drills** | (a) Remove the key: the handoff becomes the deterministic draft, labeled, never blank. (b) Stop `replay.py` mid-week, then run the agents at a later cutoff: board facts marked stale, not presented as current. (c) Live swap v3 → v4 (`--swap-config`): facts show `weights_ver` change at one step boundary. **Not** the server-down replay (F8). | Mudit + Jason | ~30 min | each behaves as stated |
| **8. Record** | Results in §5 below and a `global_plan.md` changelog row; the demo script uses only measured numbers (hard rule 10). | Mudit | 15 min | written |

## 4. Pass criteria for N1 / N2

| Check | Pass |
| --- | --- |
| Board data | The board facts the agents saw equal the `listen.py` JSON at the cutoff for every facility: source `fpga`, `weights_ver` 4, not stale |
| v4 incidents | Step 1030: 3 pump failures (S2 A, B, C) plus degradation at S3 A and S4 C and a leak at S5 B, provenance `fpga`. Step 1080: the 2 degradations and the leak. (These are what v4 flags on the software board, which the board matches bit for bit.) |
| Actions | Leak and worn pump → field inspection, no countdown. Pump failures → countdown + the solver's plan; the three S2 failures share S2's fleet (rule 5). Order per rule 7. |
| Nemotron | Every role's output is `source: nemotron` and accepted by the validators; no draft or fallback in the happy path |
| Grounding | Every number and ID in the prose comes from the facts; no completed-action claims; the plan presented first is the solver's recommended plan |
| Time | Analysis latency recorded (median and max); quote only what was measured |
| Hard rules | No answer key read; no key in logs or the store (`grep -cF` = 0); no tool dispatches, acknowledges alarms or deploys weights |

Cutoffs (UTC):

| Dataset | Step | `--at` | What's there |
| --- | --- | --- | --- |
| `full_week` | 1030 | `1791467400` (Thu 13:50) | 3 S2 pump failures sharing 2 trucks, plus 2 worn pumps and a leak: the "hard case" |
| `full_week` | 1080 | `1791482400` (Thu 18:00) | only leak / degradation from the board: tests F1 |
| `full_week` | 2015 | `1791762900` (Sun 23:55) | nothing active: the agents must say so, not invent |
| `mock_test_2026-10-10T1530` | its "now" | `1791646200` (Sat 15:30) | held out: the two S5 pump failures in progress |

## 5. Results

| When | Step | Result | Notes |
| --- | --- | --- | --- |
| Sun 07:35–07:50 | 3: `combined_suite --fakeboard`, live Nemotron | **6 / 6 PASS** | Board stages bit-exact. Incidents = what the board flags: step 1030 has 6 (3 S2 pump failures, the S5 B leak, the S3 A and S4 C worn pumps); step 1080 has 3; the last step has none; the mock test has the 2 S5 failures. API path with provenance; stale drill 15/15. Single runs, not a benchmark: per agent run 15–50 s and 15k–145k input tokens. |
| Sun 07:35–07:50 | same | findings | (1) Nemotron's acceptance varies by run: in one rehearsal triage passed at step 1030, in the next it didn't. The orchestrator now writes a deterministic fallback for triage / handoff, so the operator never gets a blank, and the report counts them. (2) The handoff often exceeds the 900-character cap with several incidents (950, 1,119, 2,635). (3) On the API path the plan explainers mangle 64-hex plan IDs (`presentFirstPlanId must be one of …`): give the model short aliases. (4) With no ongoing incidents the handoff agent used its whole budget and failed: now deterministic, no model call. |

## 6. After the test (not needed for it)

- I-1 proper: `POST /api/runs/:id/board` with a provenance label and an auth-token option in `listen.py` (I-19), so
  the board can feed an API on another machine.
- The weights analyst (C13): it may propose a recipe or threshold experiment. Mudit runs `train.py`, golden sets
  and the board suite; a human swaps the weights live with `replay.py --swap-config`.
