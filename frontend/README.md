# Beat the Shutdown: operator console

Web app for the HackUTD 2026 Zero Day EOG challenge. It reads a dataset folder (`network.json`, `ops.json`,
`telemetry.csv`), finds pump failures, leaks and worn pumps, counts down to tank shutdown, and recommends the
cheapest response. NVIDIA Nemotron writes the shift handoff when an endpoint is configured.

## Run it

From this `frontend/` folder. The challenge data isn't committed here; clone it next to this folder first:

```bash
git clone https://github.com/nihaal419/HackUTD-ZeroDay ../data-repo
npm install
npm run dev          # http://localhost:3000
```

For the demo, use a production build:

```bash
npm run build && npm start
```

## Data

The app looks for dataset folders in `../data-repo/history` (a clone of `nihaal419/HackUTD-ZeroDay`) and also in
`../data-repo/test`. Any folder holding the three files shows up in the dataset picker. The judging `test/` folder is
picked by default when present, then the mock test.

- Point somewhere else with `DATA_ROOT=/path/to/folders`.
- `answer_key.json` is never read by the app (only by `scripts/check-engine.ts`).
- "Now" is the last timestamp in `telemetry.csv`, not the clock.

**On judging day:** drop the `test/` folder next to `history/` (or set `DATA_ROOT`), reload, and pick it. No code changes.

## Nemotron

Set these to turn on the Nemotron shift handoff (any OpenAI-compatible endpoint, e.g. Jason's Brev server or
build.nvidia.com):

```bash
NVIDIA_BASE_URL=https://your-endpoint/v1
NEMOTRON_MODEL=nvidia/your-nemotron-model
NVIDIA_API_KEY=...        # never commit this
```

Without a key, or if the endpoint fails, the console shows the plan solver's draft and says so. Every cost and
countdown comes from the deterministic solver, never from the model.

## Checks

```bash
npx tsc --noEmit && npx eslint src
npx tsx scripts/check-engine.ts      # compares detection and plans with the practice answer keys
```

Expected `check-engine` differences: an S2 pipeline C leak that is still open at the Oct 10 09:00 snapshot (its end
can't be seen while the pump is idle) and a $7 difference on EVENT_20 from sensor noise.

Worst-case datasets and an HTTP checker were used during development (not in this branch); ask Gurneal for them.

## Where things are

- `src/lib/engine/`: loading, data quality, detection, countdown, plan solver, snapshot, events.json export.
- `src/components/console/`: the UI (Mockup A, approved; see `DESIGN.md`).
- `src/app/api/events`: events.json download. `src/app/api/brief`: shift handoff.
- `public/mockups/`: the approved mockup and the alternative that wasn't picked.
