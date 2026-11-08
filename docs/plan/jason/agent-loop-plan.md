# Closed-loop Nemotron agents: plan and proof of concept

Status: **PROPOSED** (Nick, Sun Nov 8 2026, ~05:30 CST). **P0 and P1 done; checkpoint C1 passed Sun 05:39 CST**
(§7); P3 and P4 built (§9); P2 and P5 not started. **Promoted to [`global_plan.md`](../../../global_plan.md)
as PROPOSED** (C12 update, C13, I-16 … I-19, O18; Sun 07:15); ADOPTED needs the team's agreement. Agents
and Nemotron are Jason's domain (C12, final say), so this plan sits in his folder, the way
[`START_HERE.md`](START_HERE.md) does; edit or move it.

The idea: many closed-loop Nemotron agents that (a) improve the explanation and comparison of truck / shut-in plans,
(b) make the operator's shift easier, and (c) help improve the FPGA weights **offline**. A harness (the
orchestrator) sends sub-agents subtasks through prompts, and those prompts get better each run:
run → evaluate against the deterministic validators → critique → revise the template → version it.

Every part keeps the hard rules (`global_plan.md` §2): the agent advises and the deterministic layer decides
(rule 12); no answer key at runtime (1); no hardcoding (2); no unmeasured claims (10); no secrets in the repo, logs
or browser (13); the same code runs on the unseen `test/` folder (S6–S11).

## 1. Measured before any code change (Sun Nov 8, 04:52–04:58 CST)

Endpoint `https://hackutd-26-llm.jasonaa.me/v1`, model `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4`
(Jason's [runbook](nemotron-inference-operations.md)). Single runs from one machine, not a benchmark.

| Test | Latency | Tokens (in / out) | Result |
| --- | --- | --- | --- |
| `GET /v1/models` | – | – | 200; `max_model_len` **1,048,576** (the runbook's 4096 is out of date, so I-15's context concern is moot) |
| Chat, thinking on (default) | 2.40 s | 32 / 500 | good answer; 2,279 reasoning characters |
| Chat, `chat_template_kwargs.enable_thinking: false` | 0.41 s | 32 / 21 | same quality, no reasoning |
| Tool call (`qwen3_coder` parser), thinking on | 0.41 s | 296 / 44 | correct `read_incident {"id": "inc-1"}` |
| Tool result sent back | 1.67 s | 386 / 333 | markdown summary |
| Tool call, thinking off | 0.33 s | 296 / 27 | same correct call |
| Arithmetic prompt, thinking on | 4.69 s | – / 1,024 | hit `max_tokens`, **empty answer** |
| Same, `thinking_token_budget: 128` | 4.67 s | – / 1,024 | reasoning capped, answer truncated |
| Same, `reasoning_effort: "none"` | 1.86 s | – / 393 | no reasoning; answered "hour 9" (correct: 10.5) |
| API analysis, memory mode, full_week at step 1030 | ~11 s | – | **`source: draft`**: "Coordinator did not return a finalize_analysis result" |
| libfx trace of the same snapshot | 28.6 s | 47,592 / 5,827 | 8 tool calls; `finalize_analysis` rejected 6 times |

What the trace showed:

- `validateFinalization` rejected the handoff for an ungrounded word (×2: "failures" isn't on its ~200-word
  whitelist), truncated tool JSON (×1, reasoning used up the 1,024 output tokens), a number / completed-action claim
  (×1) and citations (×2). The only accepted handoff was the single word "incidents".
- Tool calling works with thinking on or off, so the parser half of I-15 is answered.
- The model's arithmetic is unreliable: costs and countdowns must stay in the solver (rule 12).
- Python's `urllib` default User-Agent gets HTTP 403 (Cloudflare error 1010) from the endpoint; Bun's `fetch` gets
  200. Any Python model client must set a User-Agent.

## 2. Gaps (existing items in brackets)

| # | Gap | Fix |
| --- | --- | --- |
| G1 | The vocabulary whitelist in `validateFinalization` (`apps/api/src/features/agents/tools.ts`) rejects normal prose (C12) | Grounded check: numbers and ID-like tokens must appear in the facts; keep the completed-action ban, citation checks and the length cap |
| G2 | `service.ts` swallows the timeout and session-persistence errors and tries the fallback without a provider (I-10) | Rethrow the session error; no fallback after an abort or without a provider |
| G3 | The AI SDK fallback uses pre-v5 names: `parameters`, `execute({ args })`, `systemPrompt`; facts in the prompt; fake session link (I-8) | `inputSchema: jsonSchema(...)`, `execute(input)`, `instructions`, a `stopWhen`, facts through tools only |
| G4 | Reasoning eats the output budget; `Provider.contextWindow` is never set (I-15) | Thinking off by default (`chat_template_kwargs`); `NEMOTRON_CONTEXT_WINDOW`, `NEMOTRON_MAX_OUTPUT_TOKENS`. libfx custom providers can't add body fields, but libfx takes a `fetch` option, which can |
| G5 | Board JSON from `listen.py` doesn't reach API runs (I-1) | `POST /api/runs/:id/board` (minimal, for the fakeboard checkpoint) |
| G6 | The console calls AI SDK output "Draft from the plan solver" | Label it as model-written |

## 3. Target architecture

```text
run snapshot ─► orchestrator (deterministic TS) ─► sub-agents on Nemotron ─► deterministic validators ─► console
                    ▲  champion / challenger prompt         (triage, plan explainer,      │ pass
                    │                                        handoff, later proposer)     ▼
              prompt registry ◄── critic (Nemotron) ◄── evaluator: scores + validator errors per trace
                                                              ┊ (offline)
                                       weights analyst ─► experiment spec ─► Mudit runs train.py (never deploys)
```

- **Orchestrator:** deterministic code for the hackathon, not an LLM. It picks the sub-agents from the snapshot (one
  triage per ongoing incident, one plan explainer per system with pump failures, one handoff), the champion prompt
  per role (sometimes a challenger), budgets and timeouts. Only validated outputs are shown.
- **Roles, read-only tools:**
  - triage: `read_incident`, `read_evidence`, `read_countdown`;
  - plan explainer: `read_plan` and a deterministic `compare_plans`;
  - handoff;
  - plan proposer (later): only `validateSystemPlan`-verified, cheaper candidates are shown;
  - critic;
  - weights analyst (offline).

  No tool dispatches, actuates, acknowledges alarms or deploys weights.
- **Prompt registry** (additive migration `db/migrations/002_agent_prompts.sql`, the same in `MemoryStore`):
  - `prompt_versions`: role, version, parent, template, author, rationale, status;
  - `agent_evals`: scores, validator errors, tokens, latency.
- **Evaluation:**
  - cases are snapshots built by the existing software runtime at a fixed stride, keeping cutoffs with ongoing
    incidents;
  - held out by system;
  - metrics come only from the snapshot and validators (validator pass 0.35, coverage 0.20, grounding 0.20,
    plan agreement 0.15, brevity 0.10, plus latency and tokens as separate objectives);
  - the answer key is never read.
- **Critic:** GEPA-style reflective mutation ([arXiv:2507.19457](https://arxiv.org/abs/2507.19457)): the worst
  traces and their validator messages go in, one child template comes out, and the child is promoted only if it
  beats the parent on held-out cases. [Ax](https://axllm.dev/typescript/subsystems/optimize/) is the off-the-shelf
  TypeScript option later.
- **Weights (offline, advisory):**
  - C2–C4 and C6 never change: the FPGA is the fixed point.
  - C5: the agent may propose retraining recipes (augmentation, missing-data copies, regularization).
  - C8: the agent may propose values (`logit_thr`, `persist_K4`, `gap_thr`).
  - Mudit decides, runs `train.py` (labels may use the answer key offline only), golden sets, `fpga_sync` and
    B1–B6 from [`ml/BOARD_CHECKLIST.md`](../../../ml/BOARD_CHECKLIST.md), writes a new `ml/artifacts/vN/`
    (never reusing N; 0 = no model, 240 = test weights) and tells Lucas.
  - Deployment stays a human `replay.py --weights` run.

## 4. Phases

Efforts are **estimates**. The critical path is P0 → P1 → P3 → P4 → P5, about 10.75 h; P2 can run in parallel.

| Phase | Priority | Effort (est.) | Cumulative (est.) | Checkpoint against fakeboard |
| --- | --- | --- | --- | --- |
| P0 Setup and baseline | Must | 0.75 h | 0.75 h | C0: fakeboard smoke test; API analysis is a labeled draft |
| P1 First live Nemotron answer | Must | 3.25 h | 4.0 h | C1: analysis `source` is `nemotron` or `ai-sdk` with a real cited sentence, fakeboard running |
| P2 Fakeboard into API runs (I-1), labels | Should | 2.75 h | parallel | C2: the handoff cites fakeboard detections |
| P3 Orchestrator and sub-agents | Must | 2.25 h | 6.25 h | C3: steps for triage, plan explainer, handoff |
| P4 Prompt registry, scoring, critic | Must | 3.0 h | 9.25 h | C4: v1 vs v2 score table; the promoted version is used live |
| P5 Demo hardening, dry run | Must | 1.5 h | 10.75 h | C5: the whole demo twice from a cold start, no code edits |
| P6+ Plan proposer, offline weights analyst, Ax GEPA, operator Q&A | Could | later | – | – |

### P0 Setup (Must; Nick; 0.75 h est.)

1. `git fetch origin && git switch -c feat/agent-loop-poc origin/main`.
2. `gh auth status`. Don't merge PR #9: its branch would revert `ml/` files; take only its doc if wanted.
3. Root `.env` (see §6); check it with `git check-ignore -v .env`.
4. `bun install && bun run test && bun run typecheck`. Baseline: 88 pass, 1 skip, 2 fail (I-10).
5. Practice data: `git clone https://github.com/nihaal419/HackUTD-ZeroDay`; `DATA=…/history/full_week`.

Done when: baseline recorded, `/api/health` says `configured-unverified`, and the C0 replay gives 600 results and
9 alerts.

### P1 First live Nemotron answer (Must; Jason approves C12; 3.25 h est.)

1. `service.ts`: rethrow `SessionPersistenceError`; no fallback after an abort or timeout, or without a provider.
   This fixes I-10.
2. `infrastructure/config.ts`: `NEMOTRON_CONTEXT_WINDOW`, `NEMOTRON_MAX_OUTPUT_TOKENS` and
   `NEMOTRON_THINKING=off|on|budget:N` (default `off`).
3. `runtime-ai-sdk.ts`: AI SDK v7 wiring (G3), thinking control through `providerOptions`.
4. `runtime.ts`: thinking control through libfx's `fetch` option, `contextWindow` and the output budget from
   config.
5. `tools.ts`: grounded `validateFinalization` (G1), with tests.
6. `/api/health`: non-secret `thinking`, `contextWindow` and `maxOutputTokens`.
7. Live check: three analyses on the C0 run.

Done when: `bun run test` shows 0 failures, typecheck is clean, and live analyses return `nemotron` or `ai-sdk`.

### P2 Fakeboard into API runs (Should; Jason, Mudit for `listen.py`, Gurneal for wording; 2.75 h est.)

1. Contract types for the C11 board JSON.
2. `POST /api/runs/:id/board`: `[]` answers 200 fast; records after the run cutoff are refused; the source label
   comes from `?source=`.
3. `GET /api/runs/:id/board`: a board summary.
4. Board detections become cited evidence in the agent facts, labeled fakeboard (never "FPGA", rule 11).
5. Console labels.

Done when: a replay of steps 1000–1030 is accepted as 465 results (31 × 15 facilities).

### P3 Orchestrator, sub-agents and recursive delegation (Must; built, see §9)

"Chip detects. Server plans. Nemotron explains." A deterministic orchestrator (`agents/orchestration/`)
dispatches scoped Nemotron sub-agents. Each role has its own read-only tools, a submit tool with a validator, and
a prompt version. Every call is recorded: role, prompt version, tools, tokens, latency, rejections, output and score.

| Role | Tools (read-only, deterministic specialists) | Output, validated |
| --- | --- | --- |
| triage / prioritizer | `list_incidents` (with evidence, plan summaries and board results), `alerts_view` (rule 7), `read_incident` | priority order and one note per ongoing incident; agreement scored against rule 7 |
| plan explainer (one per pump failure) | `read_incident`, `compare_plans` (fleet planner output), `well_economics` | the option to present first (must be a validated plan) and ≤700 characters of prose; agreement = the solver's pick |
| evidence reviewer | `read_incident`, `inspection_advice` | ≤400 characters answering one question |
| handoff writer | `list_incidents`, `read_agent_notes` (with `pumpFailuresWithoutPlanExplanation`), `read_incident` | ≤900 characters, with evidence and plan IDs in arrays |
| prompt critic (P4) | `read_current_template`, `read_failures` | a full replacement template and a rationale |

- **Facts.** Facts come from the run snapshot (software runtime). Board results come from `listen.py` JSONL
  (fakeboard): for each facility, the latest result at or before the cutoff, with its heads, rules and countdown.
- **Prose check.** All prose goes through the shared grounded check (`prose.ts`): numbers, IDs, names and categories
  must be in scope, and completed-action claims are refused.
- **Fixed contract.** A fixed harness contract is appended to every template, so the critic cannot remove it.
- **Recursive delegation.**
  - A sub-agent may call `request_subtask(role, incidentId, question)`.
  - The orchestrator grants or refuses deterministically. Guards:
    - allowed role pairs (triage→explainer/reviewer, explainer→reviewer, handoff→explainer/reviewer, reviewer→none);
    - the incident exists and is inside the requester's scope;
    - explainers only for pump failures with validated plans;
    - max depth 3;
    - max 10 sub-agents per run;
    - a 150k-token budget;
    - 70% of a 150 s deadline;
    - dedupe: a repeated accepted request returns the cached result.
  - Granted results go back to the requester as the tool result. Refusals are recorded as `denied` nodes with the
    reason.
  - The full task tree (parent, child, who requested it and why, the question) is in the trace, the CLI, the API and
    the console.
- **Strategies (decomposition granularity).**
  - v1 "coarse": triage and handoff; explainers only when requested.
  - v2 "fine": one explainer per pump failure, in parallel (concurrency 3); requests still allowed.
- **Advice only.** The orchestrator never changes plans, actions or the snapshot.

Done when: a live run shows every role validated and a recorded tree with a granted and a refused request. Done; see
§9.2.

### P4 Prompt registry, outcome learning and the weekly loop (Must; built, see §9)

- **Registry.**
  - Versioned templates per role (seed, critic, champion/challenger/retired) and strategy versions.
  - Two stores: `MemoryLearningStore` (JSON file `.data/agent-learning.json`, shared by the script and the API) and
    `PostgresLearningStore`.
  - Migration `002_agent_learning.sql`: prompt versions, strategies, evals, decisions, runs.
- **Scores.** Scores come only from validators, lint and snapshot facts, never the answer key:
  - node score = 0.3 accepted + 0.1 first try + 0.25 readability (no raw unix times, pasted IDs or snake_case labels)
    + 0.2 agreement + 0.1 brevity + 0.05 efficiency;
  - run score = 0.75 mean node score + 0.25 explainer coverage − a token penalty (at most 0.1).
- **Outcome learning.**
  - Every champion run records one decision per pump failure:
    - the solver's recommended plan (which decides);
    - the agent's suggested plan (advice);
    - the approval: the operator's `acknowledge_advice` (I-13) in the API, or "simulated" in the loop.
  - The outcome is measured from the following 6 h of telemetry, a runtime input: highest tank level, whether the
    tank reached the shutdown limit or was shut in, and whether the incident is still ongoing.
  - Nobody executed the advice in historical data, so this window is the no-action path. It checks the do-nothing
    forecast, and whether acting was warranted.
- **Weekly cycle** (`learning/cycle.ts`). Each simulated week runs on successive windows of `full_week`:
  1. Run the champion and the challenger configuration on the week's cases (an A/B test).
  2. Record decisions and outcomes.
  3. Promote a challenger prompt only if its role mean beats the champion's by ≥0.02 on the same week. If there were
     no samples, it stays a challenger.
  4. Promote a strategy on run score.
  5. Strategy tuner: when coarse runs leave most pump failures unexplained, propose the fine strategy, or raise the
     explainer cap.
  6. The critic rewrites the weakest ≤2 roles (mean < 0.9) from that week's failures. A template identical to an
     existing version is refused.
  7. Score the new champion on held-out `mock_test` cases. These are never used for critique or promotion.
- **Script.** `apps/api/scripts/agent-weeks.ts` runs N weeks and prints the version table, the weekly trend and the
  plan outcomes.

Done when: the loop prints scores per version for 3+ weeks, and champions change only on a measured win. Done; see
§9.3.

### P5 Demo hardening (Must; 1.5 h est.)

1. A held-out dry run. The reference repo has one: `HackUTD-ZeroDay/history/mock_test_2026-10-10T1530` (there
   are also `snapshot_*` folders).
2. Rule audit:
   - `rg -n answer_key apps packages frontend`;
   - `rg -n "S[0-9]_FACILITY" apps/api/src -g '!*.test.ts'`;
   - check that no key appears in logs.
3. Failure drills: no key, fakeboard stopped, a 1 s deadline.
4. Docs, then push and open a PR (Nick runs those himself).

### P6+ Later (Could)

- Plan proposer feeding seeded candidates into `solveSystemPlan`, gated by `validateSystemPlan`.
- Offline weights analyst with Mudit.
- Ax AxGEPA.
- Operator Q&A, with acknowledgements (I-13) as a scoring signal.
- An LLM orchestrator, only after one coordinator is solid.

## 5. Decisions needed

| Decision | Owner |
| --- | --- |
| Replace the vocabulary whitelist with the grounded check (C12) | Jason |
| Thinking off by default for the coordinator; optionally restart vLLM with `--default-chat-template-kwargs '{"enable_thinking": false}'` | Jason |
| Shape of `POST /api/runs/:id/board` and its provenance label (I-1, C11 ingest side) | Jason, with Mudit and Gurneal |
| Who owns agents and Nemotron (PR #9 says Mudit, `global_plan.md` says Jason); record it | Whole team |
| `listen.py`: an auth token option and a source field (C11 emit side) | Mudit |
| Experiment-spec format and candidate weight numbering | Mudit |
| Confirm no FPGA work is needed for this | Lucas |
| Console wording for model-written handoffs | Gurneal |
| Promote this plan into `global_plan.md` | Nick, then the whole team |

## 6. Where the Nemotron settings go

- Repo-root `.env`, next to `.env.example`. `bun run dev:api` runs from the root and Bun loads `.env` from the
  working directory. `.gitignore` covers `.env` and `.env.*` (but not `.env.example`).
- `loadConfig()` (`apps/api/src/infrastructure/config.ts`) enables the provider only when `NVIDIA_BASE_URL`,
  `NEMOTRON_MODEL` and `NVIDIA_API_KEY` are all set; the URL must be HTTPS.
- Never put them in `frontend/.env.local` or in a `NEXT_PUBLIC_` variable (rule 13).
- Get the key from Jason (`~/.nemotron/api_key` on the Brev instance); never commit or log it.

## 7. Checkpoint C1 results (Sun Nov 8, 05:31–05:39 CST)

Setup: the box (Linux, Bun 1.4.4), branch `feat/agent-loop-poc`, API in memory mode, provider from the root `.env`
(`NEMOTRON_THINKING=off`, `NEMOTRON_CONTEXT_WINDOW=1048576`, `NEMOTRON_MAX_OUTPUT_TOKENS` default 2048). The
fakeboard and `listen.py` ran the whole time, and the replay of steps 1000–1030 sent 465 results (31 × 15) twice,
the second time while analyses were running. Run: `full_week` at `at=1791467400` (step 1030), software runtime;
three ongoing S2 pump failures and two resolved S1 incidents.

| Check | Result |
| --- | --- |
| `bun run test` | **110 pass, 1 skip** (opt-in provider test), **0 fail**, 111 tests across 16 files (baseline: 88 pass, 1 skip, 2 fail) |
| `bun run typecheck` | clean |
| `/api/health` | `agents: configured-unverified`, `agentModel: { thinking: off, contextWindow: 1048576, maxOutputTokens: 2048 }` |
| Live analyses after the fixes | **8 of 8 accepted**, all `source: nemotron` (libfx path); the AI SDK fallback was not needed |
| First-try finalize accepted | 6 of 8 (4 rejected calls in total, each repaired using the validator's message) |
| Wall time, POST to completed | 3.6 / 5.1 / 10.7 s (min / median / max) |
| Tokens per analysis | input 7,685 / 8,034 / 21,703; output 536 / 738 / 1,954 (min / median / max) |
| Model calls per analysis | 3 to 6 (budget 10) |
| Before the last fixes (same day) | 2 of 6 accepted. libfx parsed cut-off `tool_end` text, thinking was still on for libfx (bytes body), and the model read item by item until the budget ran out |

Sample accepted handoff (verbatim; the last sentence is the service's caveat):

> Ongoing pump failures at S2_FACILITY_A, S2_FACILITY_B, and S2_FACILITY_C require operator review. S2_PUMP_A,
> S2_PUMP_B, and S2_PUMP_C each show fault (2) in their latest status. Plans include do_nothing and shut_in options
> with validated feasibility; operator to select and execute. Classifier capability is limited; health is unknown
> where evidence is unavailable.

Its steps include `coordinator`: "Written by the language model through libfx, 3 model calls, 2 tool calls, 0
rejected finalizations, 7863 input / 536 output tokens, 3.2 s."

Not good enough yet (for P3/P4, the critic loop's first targets):

- 2 of 8 handoffs copy raw unix times ("since 1791450000") or plan IDs into the prose. These are grounded, so
  they pass, but they're unreadable.
- Labels appear as written (`do_nothing`, `shut_in`).
- Board detections are not in the facts yet (P2).

Not done in this checkpoint:

- P2 (board JSON into API runs). C1 only needs the fakeboard running; the fakeboard → `listen.py` → JSONL path
  was checked, but the API does not read it yet.
- The console with a live analysis wasn't opened. `nemotron.tsx` now labels `ai-sdk` output as model-written.
- The frontend's own `tsc` reports the existing `PageProps` errors in `src/app/page.tsx`; the generated Next types
  are missing without a build. Not touched.

## 8. Reproduce on a Mac

Not run on a Mac yet; these are the same commands as §7. You need Bun, Python 3.10+, the key from Jason, and the
practice data.

```sh
git fetch origin && git switch feat/agent-loop-poc
bun install
git clone https://github.com/nihaal419/HackUTD-ZeroDay ../HackUTD-ZeroDay
export DATA=$PWD/../HackUTD-ZeroDay/history/full_week
```

Make the repo-root `.env`, next to `.env.example`, never in `frontend/`:

```sh
cat > .env <<'ENV'
NVIDIA_BASE_URL=https://hackutd-26-llm.jasonaa.me/v1
NEMOTRON_MODEL=nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4
NVIDIA_API_KEY=paste-the-key-here
NEMOTRON_CONTEXT_WINDOW=1048576
NEMOTRON_THINKING=off
STORAGE_MODE=memory
ALLOW_INSECURE_LOCAL=1
ENV
chmod 600 .env
git check-ignore -v .env     # must print: .gitignore:2:.env  .env
bun run test && bun run typecheck   # expect 124 pass, 1 skip, 0 fail; tsc clean
```

The fakeboard listens on 127.0.0.2, which macOS doesn't have by default. Add it once (undo with
`sudo ifconfig lo0 -alias 127.0.0.2`):

```sh
sudo ifconfig lo0 alias 127.0.0.2 up
cd ml && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
```

Four terminals, each from `ml/` with the venv active, except the API (repo root):

```sh
# 1. software board
python -m hutd_ml.fakeboard
# 2. board results as JSON lines
python -m hutd_ml.listen --data $DATA --board 127.0.0.2 --weights-json artifacts/v4/weights.json \
  --config artifacts/v4/global_config.json --jsonl /tmp/results.jsonl
# 3. stream steps 1000-1030 (the three S2 pump failures)
python -m hutd_ml.replay --data $DATA --board 127.0.0.2 --local 127.0.0.1 --weights artifacts/v4/weights.bin \
  --weights-version 4 --config artifacts/v4/global_config.json --step-seconds 0.2 --start-step 1000 --steps 31
grep -c '"type": "result"' /tmp/results.jsonl     # expect 465
# 4. API (repo root; Bun reads .env from here)
bun run dev:api
```

What to look for:

- The API prints `[API] Config loaded, provider: { baseUrl: …, model: … }`. The key must never appear.
- `curl -s 127.0.0.1:3001/api/health` shows `"agents":"configured-unverified"` and
  `"agentModel":{"thinking":"off","contextWindow":1048576,"maxOutputTokens":2048}`.

Then, in a fifth terminal (`jq` from Homebrew):

```sh
API=http://127.0.0.1:3001/api
DS=$(curl -s -X POST $API/datasets -F network=@$DATA/network.json -F ops=@$DATA/ops.json \
  -F telemetry=@$DATA/telemetry.csv -F label=full_week | jq -r .id)
RUN=$(curl -s -X POST $API/runs -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" \
  -d "{\"datasetId\":\"$DS\",\"at\":1791467400,\"runtime\":\"software\"}" | jq -r .id)
sleep 3; curl -s $API/runs/$RUN | jq .status                    # "ready"
AN=$(curl -s -X POST $API/runs/$RUN/analyses -H "idempotency-key: $(uuidgen)" | jq -r .id)
sleep 12; curl -s $API/analyses/$AN | jq '{state, source, model, error, handoff, step: .steps[0].text}'
```

Pass:

- `state: "completed"`, `source: "nemotron"` (or `"ai-sdk"`), `error: null`;
- a handoff naming S2_FACILITY_A/B/C;
- `steps[0]` begins "Written by the language model through libfx".

`source: "draft"` means it fell back; `error` says why: the last validator rejection, a timeout, or a provider
error. Repeat the last two lines a few times to see the acceptance rate.

## 9. Phase 3/4 results (Sun Nov 8, 06:00–06:45 CST)

### 9.1 Setup

- **Code.** Same box and `.env` as §7.
- **Board data.**
  - Fakeboard + `listen.py` + `replay.py` streamed the **whole** `full_week` (2016 steps at `--step-seconds 0.05`,
    about 30k results) into `/workspace/c1/results.jsonl`.
  - They then streamed `mock_test_2026-10-10T1530` (1627 steps, about 24k results) into `results-mock.jsonl`.
  - At the S2 cutoff (Thu 11:55 UTC) the board heads were: pump_failure at S2 A/B/C, pump_degradation at S3 A and
    S4 C, and pipeline_leak at S5 B. These come from the fakeboard, not the FPGA (rule 11).
- **Tests and checks.**
  - `bun run test`: **124 pass, 1 skip, 0 fail** (125 tests, 19 files). C1 had 110 pass.
  - `bun run typecheck`: clean.
  - Agent tests: 38 (the `features/agents` folder, including the integration route checks run separately). They cover delegation guards, depth 2 and 3, cache and refusals, the identical-template guard,
    promotion and retirement, "untested" challengers, the strategy tuner, outcome records and the API service.
- **Rule audit.**
  - `rg answer_key apps packages frontend/src` finds only comments saying it is never read.
    `loadDataset` opens only `network.json`, `ops.json` and `telemetry.csv`.
  - The key is not in the diff, the logs or the learning store (`grep -cF` = 0).

### 9.2 Live runs per role

Over 42 recorded runs (36 train and 6 held-out from weeks 1–8, using the code after the fixes in §9.4).
Latency includes waiting for one of 3 concurrent slots.

| Role | Accepted | First try | Latency median / p90 | Tokens per node median / p90 |
| --- | --- | --- | --- | --- |
| triage | 36 / 42 (86%) | 20 | 5.3 s / 11.0 s | 19.4k / 37.8k |
| plan explainer | 59 / 75 (79%) | 30 | 10.1 s / 15.0 s | 13.6k / 22.2k |
| handoff | 31 / 42 (74%) | 20 | 6.8 s / 19.6 s | 18.0k / 43.0k |
| evidence reviewer | not run in the loop; its 4 live requests in the API run were refused (see the tree below) | – | – | – |
| critic | 10 / 11 proposals accepted by its validator (1 rejected for a rationale over 400 characters) | – | – | – |

Totals: 2.89M tokens in the 42 recorded runs (critic calls not included). The whole day, including the earlier
loop attempts, was about 4.5M tokens. No rate-limit errors.

**Task tree with recursive delegation.** API run `POST /api/runs/:id/agents`, `full_week` at Thu 11:55 UTC, using
the learned champions (strategy v2, explainer v2, handoff v6):

```
orchestrator (deterministic): 3 ongoing incidents; board heads active at S2 A/B/C, S3 A, S4 C, S5 B
  triage v1 accepted
  plan_explainer ×3 (strategy v2, parallel) rejected: presentFirstPlanId not a validated option
  handoff v6 rejected (996 characters, limit 900)
    plan_explainer [S2 C] requested by handoff: "Provide a concise plan explanation for the recommended plan …"  accepted
      evidence_reviewer requested by plan_explainer: refused: unknown incident (it passed the run ID)
    plan_explainer [S2 A] requested by handoff  accepted
      evidence_reviewer requested by plan_explainer: refused: unknown incident
    (+2 more explainer requests, 2 refused grandchildren)
Totals: 13 nodes, depth 3, 3 accepted, 4 refused, 144k tokens, 51 s, run score 0.30
```

A coarse-strategy CLI run (`agent-run.ts --strategy 1`, same cutoff) shows the handoff using the gap list:

- The handoff requested 4 plan explainers (S2 B twice, because the first attempt was rejected, then S2 C and S2 A).
  3 were accepted, depth 2.
- An accepted child's output, verbatim: "Option 1 (1 truck, 1 trip) costs $905 and avoids a shut-in, preventing
  $2,450/hour revenue loss. Do-nothing would save the truck cost but would cause hourly shut-ins that quickly
  exceed the truck expense (≈$19,600 per 8-hour shift)."
- The handoff itself was then rejected (it used line breaks).

**Sample accepted outputs (verbatim).**

- **Triage** (S2, Thu 11:55): "Highest tank level (77.8%) and shortest time to limit (1h30m); also highest
  lost-revenue per hour ($2,450)." | "Tank at 68.39% with 2h26m remaining; revenue loss $2,393.75/hr …" | "Tank at
  67.42% with 2h41m left; though the lowest level, it has the highest revenue-loss rate ($3,931.25/hr) …".
- **Plan explainer**: see the coarse-run child above.
- **Handoff v6** (week 7, S4, score 0.917): "Ongoing pump failure at S4 C: pump faulting 1h20m, tank at 67.83%,
  2h29m to limit, loss $3450/h. Solver recommends option:c69d…739c (2 truck(s), 1 trip(s), cost $1,810) to limit
  shut-in and protect revenue."
- **Handoff v1** (week 1, S1, score 0.75): "Shift handoff for case-full_week-1791352800 at Wed 06:00 UTC. Incident
  is an ongoing pump failure at facility S1 B … Current plan is option:3e23…999e (Do nothing, cost $0,
  recommended)."
- **Critic rationale** (handoff v1 → v5): "The previous handoffs were rejected because they exceeded the
  900-character limit and they placed IDs inside the prose instead of using the provided ID fields …"

### 9.3 Simulated weeks: scores per version

`agent-weeks.ts --weeks 5`, then `--weeks 3 --first-week 6 --offset-hours 2` on the same store, for 8 weeks in total:

- Each week is a successive window of `full_week`, starting at the first incident. The cases are from S1, S2, S3,
  S4 and S5 (2 per week).
- Held-out: `mock_test` at S1 (Wed 00:40 UTC) and S2 (Thu 10:00 UTC), with the mock_test board results. Never
  critiqued.
- Week 5 had no cutoff with an ongoing pump failure in its window, so it only ran held-out.

Promotions, each one an A/B test inside one week:

| Week | Change | Measured (challenger vs champion, same week) |
| --- | --- | --- |
| 1 | strategy **v1 → v2** (fine) | run score 0.886 vs 0.603 |
| 2–4 | handoff v2, v3, v4 (critic) retired | 0.320 vs 0.677; 0.736 vs 0.750; 0.015 vs 0.015 |
| 6 | handoff **v1 → v5** (critic) | role mean 0.687 vs 0.383 |
| 6 | triage v2 (critic) retired | 0.509 vs 0.913 |
| 7 | plan explainer **v1 → v2** (critic) | 0.824 vs 0.514 |
| 7 | handoff **v5 → v6** | 0.834 vs 0.750, **but the v6 text is identical to v5**: sampling noise. The identical-template guard now refuses this (commit `d65031f`) |
| 8 | plan explainer v3, handoff v7 retired | 0.636 vs 0.677; 0.303 vs 0.621 |

Pooled per version (train / held-out, n):

| Role | v1 | Later versions |
| --- | --- | --- |
| handoff | 0.514 (10) / 0.576 (10) | v5 0.719 (4) / 0.684 (2); v6 0.727 (4) / 0.467 (4) |
| plan explainer | 0.844 (31) / 0.597 (24) | v2 0.719 (7) / 0.576 (8) |
| strategy | v1 0.603 (1) | v2 0.717 (25) / 0.578 (16) |

Champion run score per week, held-out: 0.61, 0.44, 0.45, 0.81, 0.59, 0.73, 0.62, 0.39.

Before and after (handoff):

- **v1 (seed):** "You write the shift handoff for the next operator from the triage notes and the plan explanations.
  Cover each ongoing incident."
- **v5 (critic, promoted week 6):** v1 plus "Keep the handoff under 900 characters. Put all case IDs, facility IDs,
  and plan option IDs in the designated ID fields – do not embed them in the prose. Use the tools' short facility
  labels (e.g., S2 B) when referring to facilities in the narrative."
- **Outputs:** compare the v1 and v6 (= v5) handoffs in §9.2. The later one uses "S4 C" instead of case IDs, but it
  still pastes one plan ID.

Plan outcomes. The following 6 h of telemetry is the no-action path, because nobody executed the advice:

| Recommended | Decisions | Tank hit limit without action | Do-nothing forecast matched |
| --- | --- | --- | --- |
| trucks | 13 | 13 / 13 | 13 / 13 |
| shut-in | 2 | 2 / 2 | 2 / 2 |
| do nothing | 7 | 5 / 7 | 7 / 7 |

Every trucks or shut-in recommendation was warranted: the tank did reach the limit without action. The solver's
do-nothing forecast matched what happened 22 of 22 times. Do-nothing was still recommended in 5 cases where the tank
tripped. The forecast predicted those trips, so this is the solver's cost trade-off, not a forecast miss. The
"recommendation justified" field (0.29 for do-nothing) is too blunt to grade that. The agents' first choice agreed
with the solver in every case where an explainer was accepted.

What this does and does not show:

- **It shows** a deterministic loop that changes the decomposition (v1 → v2) and the prompts (handoff v1 → v5,
  explainer v1 → v2) only on a measured same-week win. It records every decision and outcome and keeps held-out
  separate.
- **It does not show** a reliable held-out gain from prompt changes:
  - Held-out run scores swing 0.35–0.89 for the same configuration, mostly from whether the handoff passes the
    900-character check.
  - With 2–4 samples per version, a 0.02 margin is below the noise; the v5 → v6 promotion of an identical text
    proves it.
  - Next steps: more cases per week, repeat each case 2–3 times, and promote on a confidence bound.

### 9.4 Fixes found by the live runs (all committed)

- **Board facts.** They kept each facility's last result of the whole replay, so they were empty at any earlier
  cutoff. Now they keep the latest result at or before the cutoff (`boardAt`).
- **Completed-action check.** "solver-approved" was refused as a completed-action claim, and every explainer failed
  (first loop: explainer accepted 0/1, fine strategy lost). Hyphenated compounds now pass. The message suggests
  "recommended". With this fix the fine strategy won in week 1.
- **Length errors.** When IDs are pasted into the prose, the error now says that IDs go in the ID fields.
- **Outcomes.** They compared the recommended plan's forecast with no-action telemetry. They now check the
  do-nothing forecast.
- **Untested challengers.** A challenger with no samples, or an empty week, was retired as "0.000 vs 0.000". It now
  stays a challenger.
- **Strategy tuner.** It may retry the fine strategy when a plan-explainer challenger is waiting.
- **Critic.** A critic template identical to an existing version is refused.
- **Proxy.** The console proxy did not allow the agent routes.

### 9.5 Gaps

- **Postgres.** The Postgres learning store and migration 002 are untested live: no Postgres server on the box.
  Memory mode with a JSON file was used.
- **Simulated approvals.** Approvals in the loop are labeled `simulated`. Real operator acknowledgements (I-13) feed
  decisions only through the API.
- **Board ingest (P2).** The board facts come from the `BOARD_JSONL` file or the `--board` flag, not from P2 ingest.
  The console's own board banner still says "Board offline".
- **Evidence reviewer.** It never ran: no agent asked for one in scope, and the 4 requests in the API run used a run
  ID and were refused.
- **Model-written prose.** Grounding allows fluent but empty claims: "balances equipment availability and crew
  readiness"; a triage note said "capsizing". Explainer v2 sometimes pastes option hashes into the prose; lint
  penalizes this but does not reject it.
- **Handoff.** Acceptance (74%) is the main failure, from length and line breaks with 3 incidents.
- **Delegation hint.** The handoff gap list and request hint (commit `46a6529`) came after the weekly loop. Only the
  API and CLI runs in §9.2 use them.
- **Promotion statistics.** See the end of §9.3.

## 10. Watch the agents on a Mac

Do §8 first: the `.env`, `bun install`, the venv, and the `127.0.0.2` alias.

```sh
export DATA=$PWD/../HackUTD-ZeroDay/history/full_week
export MOCK=$PWD/../HackUTD-ZeroDay/history/mock_test_2026-10-10T1530
# Terminals 1-2 (from ml/): fakeboard and listener for the full week
python -m hutd_ml.fakeboard
python -m hutd_ml.listen --data $DATA --board 127.0.0.2 --weights-json artifacts/v4/weights.json \
  --config artifacts/v4/global_config.json --jsonl /tmp/results.jsonl
# Terminal 3 (from ml/): stream the whole week (~100 s)
python -m hutd_ml.replay --data $DATA --board 127.0.0.2 --local 127.0.0.1 --weights artifacts/v4/weights.bin \
  --weights-version 4 --config artifacts/v4/global_config.json --step-seconds 0.05 --start-step 0
# Then restart the listener with --data $MOCK --jsonl /tmp/results-mock.jsonl and replay $MOCK the same way.
```

One orchestrated run as a task tree (CLI). `--strategy 1` shows the handoff requesting explainers:

```sh
bun apps/api/scripts/agent-run.ts --data $DATA --at 1791460500 --strategy 1 --board /tmp/results.jsonl
```

The weekly loop. 5 weeks take about 12 minutes and 2M tokens; use `--weeks 3 --cases 1` for a quick look:

```sh
bun apps/api/scripts/agent-weeks.ts --train $DATA --heldout $MOCK --weeks 5 --cases 2 --heldout-cases 2 \
  --board /tmp/results.jsonl --heldout-board /tmp/results-mock.jsonl --store .data/agent-learning.json --fresh
```

The console Agents view. Two terminals, from the repo root:

```sh
BOARD_JSONL=/tmp/results.jsonl bun run dev:api   # uses .data/agent-learning.json (champions from the loop)
ALLOW_INSECURE_LOCAL=1 HOSTNAME=127.0.0.1 bun run dev:web
```

1. Open http://127.0.0.1:3000, then **Agents** in the sidebar. You see the prompt versions, the weekly scores, and a
   **Run agents** button that draws the task tree as it completes.
2. For the S2 incidents, choose **Replay** and pick Thu Oct 8 11:55 UTC before opening Agents. The latest reading
   of `full_week` has no ongoing pump failures.
3. The same data is available as JSON:
   - `curl -X POST 127.0.0.1:3001/api/runs/$RUN/agents`
   - `curl 127.0.0.1:3001/api/agent-runs/$ID`
   - `curl 127.0.0.1:3001/api/runs/$RUN/agent-runs`
   - `curl 127.0.0.1:3001/api/agents/learning`

Note: the console's server render calls `http://localhost/api/backend` (port 80, `frontend/src/lib/api.ts`,
unchanged). On the box this needed a local port 80 → 3000 forward. If the first page shows "Request failed", that
is the cause; it is outside this branch's changes.
