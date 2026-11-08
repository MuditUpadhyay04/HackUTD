# UI v4 build plan (workers read this + ui-v4-brief.md)

Spec: `frontend/docs/ui-v4-brief.md`. Visual reference once it exists: `frontend/public/mockups/v4/` (static mockup;
match its look, but the real app reads real data).
Repo root: `/Users/json/Developer/projects/HackUTD-ui-v4` (branch `feature/ui-v4-pipeview`). Never commit, push or
switch branches; the orchestrator commits.

## File ownership (strict: only edit files you own; ask for shared changes in your final report)

| Phase | Owner | Files |
| --- | --- | --- |
| A | foundation | `src/app/page.tsx`, `src/app/classic/**`, `src/app/v4.css`, `src/lib/v4/{use-run,store,derive,format}.ts` (+ `*.test.ts`), `src/components/v4/shell.tsx`, `src/components/v4/rail.tsx`, stub files for every B slot below, `frontend/package.json` deps |
| B1 | pipe view | `src/components/v4/pipeview/**`, `src/lib/v4/pipeview-*.ts` |
| B2 | arrangement | `src/components/v4/arrangement/**`, `src/lib/v4/arrangement-*.ts` |
| B3 | chrome | `src/components/v4/ticker/**`, `src/components/v4/transport/**`, `src/components/v4/trucks/**`, `src/lib/v4/{audio,keyboard}*.ts` |
| C | orchestrator | integration fixes anywhere |

v3 files (`src/components/console/**`, `src/app/globals.css`, `src/lib/engine/**`, `src/lib/live/**`) are NOT edited,
except the minimal change in A that keeps v3 navigation on `/classic`.

## Slot contracts (A creates these as compiling stubs; B fills them in without changing the export signature)

```ts
// every slot is a client component and reads time/state via usePlayhead() from "@/lib/v4/store"
export function Ticker(props: { snapshot: Snapshot }): JSX.Element                  // ticker/ticker.tsx
export function PipeView(props: { snapshot: Snapshot }): JSX.Element                // pipeview/pipe-view.tsx
export function Arrangement(props: { snapshot: Snapshot }): JSX.Element             // arrangement/arrangement.tsx
export function TruckRoad(props: { snapshot: Snapshot }): JSX.Element               // trucks/truck-road.tsx
export function Transport(props: { snapshot: Snapshot; run: RunControls }): JSX.Element // transport/transport.tsx
```
`Snapshot` is `@/lib/engine/types` (what the v3 console consumes from the API). `RunControls` comes from `use-run.ts`
(datasets, current dataset, runtime, `commitAt(unix | null)`, `setDataset`, `setRuntime`, `upload(files)`).

## Time model (A implements in store.ts + derive.ts; everyone uses it)

- The API returns one causal snapshot per run at `at` (default: last telemetry timestamp). Each facility carries
  ~48 h of `series`; incidents carry onset/end.
- **Local window** = `[earliest series t, snapshot.nowUnix]`. Inside it, the playhead time `t` is rendered locally by
  pure derivation (`derive.ts`): sampled levels/flows, incidents active at `t`, countdowns, truck positions.
- **Outside it** (scrubbing earlier, or playing past `snapshot.nowUnix` while the dataset has more data),
  the shell debounces (600 ms after scrub/pause) and calls `run.commitAt(t)`, which loads a new run at `?at=t`.
  `LIVE` = `commitAt(null)`. Never invent data outside the window; show it as dithered "not loaded".
- Store state: `t`, `playing`, `speed` (1x = 5 min/s, 4x, 16x), `sound` (default off), `approved` (incident or plan
  ids acknowledged in this run), `focus` (hovered/selected `{ kind, id } | null`) shared so hovering a track
  highlights its metro line and vice versa.
- Approve = `POST /api/backend/api/runs/:id/actions` (see `apps/api/src/app.ts` and `@hackutd/contracts` for the
  body; idempotency key via `commandKey()` from `@/lib/api`). Acknowledges a plan revision; never "dispatch".

## Verification each worker runs before reporting

From the repo root: `bunx tsc --noEmit -p frontend/tsconfig.json`; `bun test frontend/src/lib/v4` (if you added
tests); `cd frontend && bunx eslint <your files>`. Report results verbatim; do not claim what you did not run.
