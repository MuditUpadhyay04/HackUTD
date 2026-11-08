# @hackutd/fpga-sim

> **Prototype; not integration-ready.** Rule availability is not represented
> independently from boolean flags; consult result status. Checkpoints are bound
> to the configured run and cannot be imported by a different runtime instance.
> Model arithmetic, scaling and metadata are unconfirmed. The v1
> codec is incomplete and requires independent byte-level validation before use.
> Do not use this package as authoritative detection or hardware parity.

Reusable TypeScript software/CPU replacement for the project's FPGA inference
runtime. Built for two purposes while the FPGA (Eclypse Z7) continues:

1. **Frontend/backend development** — a standalone in-process library that stands
   in for the board so Jason/Gurneal can build the API and dashboard against
   real inference semantics.
2. **Fallback when the FPGA is missing/disconnected/failing** — the dashboard can
   switch to software execution through common input/output semantics, with
   explicit provenance (`fpga` | `software` | `unavailable`) and isolated run
   state.

No Elysia server, DB, React, model training, or board deployment. No general
plugin framework.

## Source contracts consulted

- `global_plan.md` §2 (hard rules), §5 (contracts C1–C10)
- `docs/plan/lucas/fpga_hardware_plan.md` (v1 wire I/O contract, engine v2)
- `docs/plan/lucas/review_notes.md` (R1/R2 countdown findings → host O7 correction)
- `docs/research/FPGA_CLASSIFIER_HANDOFF.md` (12 channels, output order, int16 scale 1/16384)
- The superseded `model-input-v1.json` rounding rule is not used.
- Reference repo `https://github.com/nihaal419/HackUTD-ZeroDay` (README/SPEC schemas)

**Not edited:** `docs/plan/jason/agent-backend-architecture.md`, `global_plan.md`,
Lucas's live doc, or any existing user work. The bundled `origin/frontend-v1`
backend is deliberately ignored as authority; it may inform consuming DTOs only.

## What it implements

| Contract | Status |
|---|---|
| 12 channels (handoff §4 formulas) | implemented |
| 19 memory features (memory feature set v1) | implemented |
| 4 logistic regressions `[pipeline_leak, pump_degradation, pump_failure, facility_shut_in]` | implemented (logits only; sigmoid server-side) |
| Rule flags `pump_fault`, `shut_in`, level≥shutdown/warning, not filling | implemented |
| Countdown p10/p50/p90 with host O7 correction (inflow-only on pump failure; already-at-limit → 0) | implemented |
| Validation: VALID/HELD/INVALID/DROPPED + reason bits 0–10 | implemented |
| Hold ≤2 steps then history reset | implemented |
| Duplicate / out-of-order / gap detection | implemented |
| No weights ⇒ scores unavailable (never fabricated confidence) | implemented |
| Common `Runtime` interface (software + future FPGA adapter) | implemented |
| Snapshot / restore (checkpoint to a cutoff) | implemented |
| v1 wire codec (header/DATA/RESULT/CONFIG) byte-for-byte | implemented |
| v1 packed limits explicit: 32 facilities, 8 wells/facility | implemented |

## Honesty / capability gaps (documented, not silent)

- **No bit-exact parity claimed.** Float formulas use half-up rounding, but do not
  implement the unconfirmed CONFIG multiplier arithmetic or streaming golden vectors.
- **Countdown O7 is a host correction**, not a claimed FPGA fix. The FPGA plan's
  net-inflow ring has a known bug at failure onset (review R1). The software
  runtime maintains a separate inflow history for `pump_fault` and checks already-at-limit
  first (review R2). Method/source/version differences are preserved.
- **No weights ⇒ `logits` null, `weightsVer` 0, `availability: "degraded"`.** We do
  not apply sigmoid to zeros or invent 0.5 probabilities. Sigmoid/thresholding is
  a server-side Mudit contract.
- **Bad/missing data is never healthy.** Every result carries status + reason bits.
- **v1 codec is a packed adapter.** It rejects `fac_id > 31`, `n_wells > 8`,
  non-finite and out-of-int16-range values explicitly. It does not extend the
  protocol for larger topologies.
- **No seamless stateful midstream failover without state reconstruction.** Use
  `snapshot()`/`restore()` to rebuild state to a cutoff when switching datasets or
  recovering from a failure.

## Public API

```ts
import {
  SoftwareRuntime,
  buildDatasetConfig,
  STATUS,
  encodeResult, decodeResult, encodeDataRecord, decodeDataRecord,
  encodeHeader, decodeHeader,
  V1_MAX_FACILITIES, V1_MAX_WELLS_PER_FACILITY,
} from "@hackutd/fpga-sim";

// 1. Build config from network.json / ops.json (asset IDs & counts read from files — none hardcoded).
const config = buildDatasetConfig(networkJson, opsJson, firstTsUnix, lastTsUnix, 300);

// 2. Create the software runtime.
const rt = new SoftwareRuntime("sw-1");
rt.configure(config);

// 3. Load model weights when Mudit provides them (optional; rules/countdown work without).
// rt.configure(withModel(config, { weightsVer: 1, weights, biases, outputShift: S, loaded: true }));

// 4. Ingest records (one facility per 5-minute step).
const result = rt.ingest({
  facilityId: "S1_FACILITY_A",
  tsUnix: 1791186900,
  present: { inflow: true, level: true, pumpStatus: true, pumpFlow: true,
    receiveFlow: true, discharge: true, pipeline: true,
    wellStatus: [true,true,true], wellWater: [true,true,true] },
  inflowBpd: 2400, levelPct: 50, pumpStatus: 1, pumpFlowBpd: 3000,
  receiveFlowBpd: 3000, dischargePsi: 1100, pipelinePsi: 1050,
  wellStatus: [1,1,1], wellWaterBpd: [800,800,800],
});
// result.provenance === "software"
// result.logits === null until weights loaded (never fabricated)

// 5. Switch datasets / replay timestamps: rebuild isolated state.
// rt.reset(); rt.configure(otherConfig); rt.ingest(...)

// 6. Snapshot / restore to a cutoff.
const snap = rt.snapshot();
// ... later ...
rt.restore(snap);

// 7. v1 wire codec (bounded adapter: 32 facilities / 8 wells).
const bytes = encodeDataRecord(recordWithSlot);
const rec = decodeDataRecord(bytes);
const resultBytes = encodeResult(inferenceResult);
```

### Common runtime contract (`Runtime`)

Both the software adapter and a future FPGA adapter implement:

- `configure(config)` — bind a dataset (network + ops + telemetry bounds).
- `ingest(record)` / `ingestBatch(records)` — deterministic per-record inference.
- `reset(facilityId?)` — clear run state (isolated per dataset; no cross-run leakage).
- `snapshot()` / `restore(snapshot)` — checkpoint/rebuild state to a cutoff.
- `capabilities()` — explicit limits + gaps (`maxFacilitiesLogical: Infinity`,
  `maxFacilitiesPacked: 32`, `countdownO7Correction: true`, etc.).
- `dispose()`.

Every `InferenceResult` carries `provenance` ("fpga" | "software" | "unavailable")
and `availability` ("available" | "degraded" | "unavailable").

## Topology limits

| API | Max facilities | Max wells/facility |
|---|---|---|
| Logical software (`SoftwareRuntime`) | unbounded | unbounded |
| Packed v1 wire codec | 32 (u16 `fac_id`, eligible slots 0–31) | 8 |

> The 32-facility / 8-well figures are **per-config hardware limits** of the v1
> FPGA slot table, not uploaded-file counts. The software API does not inherit
> them; packed adapters enforce them explicitly and reject overflow.

## Tests

`bun test` runs the suite under `packages/fpga-sim/tests/`. Coverage:

- valid record stream → outputs (channels, rules, countdown)
- holds / invalid / reset
- duplicates / out-of-order / gaps
- independent multiple class outputs (all four logits)
- no-weight / unknown metadata (scores unavailable)
- already-tripped and zero / non-filling countdown
- state isolation between datasets / runs
- restart / replay determinism
- >32 facilities and >8 wells via logical software API
- explicit limits for packed v1 adapters
- switching rebuilds state without future-data access
- byte-level codec fixtures (header / DATA / RESULT round-trip)

Fixtures are explicit and independent of `answer_key.json`.

## Compatibility limitations

- No v1 heartbeat / ALERT / STATS / WEIGHTS encode beyond header skeleton
  (ALERT/STATS decode not implemented; WEIGHTS byte order open — O3/O11).
- Sigmoid, thresholds/persistence K, and alarm values come from Mudit/Lucas
  calibration (open questions O2, O10); not hardcoded here.
- No actual board deployment, UDP transport, or physical actuation.
- Metrics are never reported as physical hardware performance.
