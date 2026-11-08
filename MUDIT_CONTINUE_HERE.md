# Mudit — agent backend continue-here

You own the agent/Nemotron path now. Jason was the prior owner; this file is your starting point.

## What exists

`apps/api/src/features/agents/`:

| File | Responsibility |
|------|----------------|
| `service.ts` | Analysis coordinator. Drafts deterministic fallback, tries `libfx` → AI SDK fallback, validates finalization, enforces 30s deadline, fenced session persistence |
| `runtime.ts` | `libfx` runtime: `createFxAgent` ("operator-coordinator"), durable-local FX sessions, tool loop, 8-model-call budget, 20-turn cap, fenced `onSession` persistence callback |
| `runtime-ai-sdk.ts` | Fallback: AI SDK `ToolLoopAgent` + `@ai-sdk/openai-compatible` provider, same Nemotron-compatible endpoint |
| `tools.ts` | Domain tools: `read_snapshot`, `read_incident`, `read_evidence`, `read_plan`, `finalize_analysis` — reads only, strict output validation |
| `service.test.ts` | Tests (88 pass; 2 pre-existing timing failures unrelated to agent logic) |

**Entry point:** `apps/api/src/application.ts` — `createAnalysisService({ store, provider, sessionDir })` wired into `/api/analyses` runs.

## How it works

One `operator-coordinator` agent per worker process (created once, reused). It receives an immutable `facts` projection (incidents, evidence, plans, coverage, recommendation state). Role logic lives in prompts, not separate agents: inspect → investigate → `finalize_analysis` (handoff + evidence/plan citations). Fleet planner and well economist are deterministic solver/economics functions; the agent only chooses comparisons and explains trade-offs.

Flow:
1. Frontend POSTs to `/api/analyses` → `agents.generate(...)`.
2. `service.ts` builds facts, drafts deterministic handoff, then:
   - Attempt 1: `libfx` → `finalize_analysis` → source `"nemotron"`
   - Attempt 2 (fallback): AI SDK `ToolLoopAgent` → same → source `"ai-sdk"`
   - Both fail: deterministic draft, source `"draft"`, error attached. Never fabricate health/confidence.
3. `onSession` persists `{ fxSessionId, messageId }` to the analysis record (fenced — persistence failure aborts the turn).

Safety: no physical dispatch/actuation, no arbitrary SQL/shell, no board acknowledgment, no autonomous weight uploads. Model prose is never a substitute for a validated plan. Agent work triggered by incident transitions, plan changes, or explicit operator questions — not every telemetry packet.

## How to run

From repo root:
```bash
bun install
bun apps/api/src/index.ts   # entry script; verify root package.json
```

Env vars (server-only, never in browser):

```
DATABASE_URL=postgresql://user:password@your-tiger-host:5432/tsdb?sslmode=verify-full
API_TOKEN=<strong random token — same value in frontend env>
OPERATOR_PASSWORD=<Basic auth password for console, username: operator>
API_HOST=127.0.0.1
API_PORT=3001
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
FX_SESSIONS_DIR=.data/fx-sessions   # keep on persistent disk for recovery
STORAGE_MODE=memory   # nonpersistent dev only; not durable
MODEL_METADATA_PATH=   # optional administrator weights/scale/threshold metadata, never from uploads
```

For live Nemotron agent inference (optional — agent works in draft-only mode without it):

```
NVIDIA_BASE_URL=https://hackutd-26-llm.jasonaa.me/v1
NEMOTRON_MODEL=nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4
NVIDIA_API_KEY=<from Jason — see below>
```

## Tokens / credentials

- **Nemotron API key**: Jason owns it. It lives at `~/.nemotron/api_key` (mode 600) on his Brev instance `revolutionary-fuchsia-clownfish`. Retrieve via `brev shell revolutionary-fuchsia-clownfish; cat ~/.nemotron/api_key`. Do not commit or log it. Jason handles rotation.
- **API_TOKEN**: generate a strong random string; set identically in API env and frontend env.
- **OPERATOR_PASSWORD**: frontend Basic Auth; console users know it.

## Current state

- Live Nemotron inference confirmed working via direct curl and API endpoint (`source: "nemotron"`)
- Nemotron endpoint is rate-limited (nginx 10 r/s burst 20); AI SDK fallback works around it in tests/demo
- Typechecks pass; frontend production build succeeds
- Docs: `docs/plan/jason/backend-demo-runbook.md`, `docs/plan/jason/nemotron-inference-operations.md`, `docs/plan/jason/agent-backend-architecture.md`
- PR #4 is `main` ← `feature/operator-backend` (open)
- Remote branches: `feature/operator-backend`, `feature/fpga-sim-software-runtime`, `ml`, `FPGA` exist; frontend-* branches deleted

## Open questions / next

- Verify Tiger Data/Timescale service connection (needs URL/credentials)
- Verify actual FPGA operation/failover (needs Lucas's board)
- Consider merging `origin/ml` (Mudit's trained weights v1, golden sets, board harness) if classifier capability is needed
- Consider merging `origin/FPGA` (Lucas's RTL) if hardware integration is needed
- Full test suite, typechecks, and frontend build re-run after any changes
