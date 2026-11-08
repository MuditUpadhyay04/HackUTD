# Beat the Shutdown

Operator console for the HackUTD produced-water challenge. The feature-based Elysia backend owns uploaded datasets, causal replay, incidents, shared-fleet planning, scenarios and agent analysis. The Next.js/React application is a presentation layer; it does not run its own detector or planner.

## Start locally

Requires Bun 1.4+, Node 22+ for Next.js, and PostgreSQL 15+ or a Tiger Data service. Native `libfx` additionally requires a supported macOS/Linux host. Install dependencies from the repository root:

```sh
bun install
```

Set the server-only variables from `.env.example`: `DATABASE_URL`, `API_TOKEN`, `OPERATOR_PASSWORD`, and `API_URL`. Keep Tiger Data's TLS/certificate settings. Never commit actual credentials. The console uses HTTP Basic authentication (username `operator`); its password is separate from the upstream API bearer token.

```sh
bun run db:migrate
bun run dev:api
```

In a second terminal:

```sh
bun run dev:web
```

Open `http://localhost:3000`. Upload `network.json`, `ops.json` and `telemetry.csv`; choose a dataset, five-minute timestamp and runtime. No organizer data is bundled. The application never opens an answer key.

For an explicitly **nonpersistent, loopback-only** development session without database/model credentials:

```sh
STORAGE_MODE=memory ALLOW_INSECURE_LOCAL=1 bun run dev:api
```

```sh
ALLOW_INSECURE_LOCAL=1 HOSTNAME=127.0.0.1 bun run dev:web
```

Memory mode is labeled and never used automatically after a database failure. All data disappears when that API process stops.

## Architecture

- `apps/api/src/features/`: dataset import, runtime/projection, planning, agents, hardware and export.
- `apps/api/src/infrastructure/`: authentication/configuration, PostgreSQL persistence and leased jobs.
- `packages/contracts/`: browser-safe application types. React uses Eden and the exported listener-free Elysia `App` type.
- `packages/fpga-sim/`: deterministic software inference lifecycle, explicit capabilities and optional registered weights. Not a claim of bit-exact board parity.
- `frontend/`: existing Next.js console and authenticated same-origin API proxy.
- `apps/encoder/`: offline DATA encoding, independent from API/model work.
- `db/migrations/`: additive PostgreSQL schema and optional Timescale hypertables. No event-time retention policy deletes historical recordings.

The API runs a background worker by default. To separate processes, set `INLINE_WORKER=0` on the API and start `bun apps/api/src/worker.ts` with the same PostgreSQL environment. A separate worker cannot use process-local memory storage. FX sessions require a persistent `FX_SESSIONS_DIR` on the single worker host.

## Execution and safety boundaries

Software mode needs no board. Automatic mode reports a software fallback when hardware is unavailable. Explicit FPGA mode must not pretend to have executed on hardware. The UDP bridge/codec/encoder are integration infrastructure; live board configuration, reset epochs and ACK sequencing still require the hardware owner's validation. See `apps/encoder/README.md` before connecting a board. A validated import larger than the hardware's 32-facility/8-well limits remains usable in software, subject to upload and resource quotas.

Missing or unregistered classifier weights mean model scores and leak/degradation classification are **unavailable**, not healthy. Pump-fault rules and host countdown/planning can still operate. Registered model integration is explicit and must carry approved scale/threshold metadata; no trained model or accuracy claim is bundled.

Plans are recommendations, not physical dispatch. Approvals acknowledge an immutable system-plan revision. Proposed fleet allocations do not reserve actual trucks. Scenarios independently revalidate complete system alternatives and never modify recorded telemetry. The solver reports the best feasible candidate within a bounded policy, not a global continuous-time optimum.

Optional `NVIDIA_BASE_URL`, `NEMOTRON_MODEL` and `NVIDIA_API_KEY` configure direct FX/Nemotron analysis. Without them, handoffs are explicitly labeled deterministic drafts. Costs and countdowns remain deterministic regardless of model availability.

## Verify

```sh
bun test apps/api packages --timeout 30000
bun run typecheck
bunx tsc --noEmit -p frontend/tsconfig.json
bun run build:web
```

PostgreSQL contract tests require `TEST_DATABASE_URL` pointing to a **disposable test database**, never production. Actual Tiger Data/Timescale behavior and the actual Nemotron tool parser require separate service verification; local PostgreSQL and mock-provider checks do not establish that compatibility.

Full requirements and owner gates: `docs/plan/jason/agent-backend-architecture.md`. Operational demo checklist: `docs/plan/jason/backend-demo-runbook.md`.
