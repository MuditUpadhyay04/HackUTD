# Closed-loop Nemotron agents: plan and proof of concept

Status: **PROPOSED** (Nick, Sun Nov 8 2026, ~05:30 CST). Not in [`global_plan.md`](../../../global_plan.md) yet: it
gets promoted there, with a changelog row, only after the fakeboard checkpoint passes and the team agrees. Agents
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

### P3 Orchestrator and sub-agents (Must; 2.25 h est.)

`agents/roles.ts`, read-only `read_countdown` and `compare_plans`, `agents/orchestrator.ts`, wiring in
`service.ts`, and tests with a fake runtime.

Done when: a live analysis has validated steps for every role.

### P4 Prompt registry and critic loop (Must; 3.0 h est.)

Migration `002`, store methods, v1 seeds (today's instructions), `agents/eval/{cases,metrics}.ts`,
`agents/critic.ts`, a CLI `apps/api/scripts/agent-loop.ts --role handoff --rounds 2`, and read routes.

Done when: the CLI prints v1 and v2 held-out scores, and the champion changes only on improvement.

### P5 Demo hardening (Must; 1.5 h est.)

1. A held-out dry run. Where `mock_test_*` lives is unknown; the public reference repo has only `full_week`.
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
