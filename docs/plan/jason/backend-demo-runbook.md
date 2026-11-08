# Backend demo runbook

## Before the demo

- Use the application branch/worktree, install from the root lockfile, and verify both typechecks and tests.
- Configure Tiger Data/PostgreSQL and run additive migrations. Confirm storage health; do not present memory mode as durable.
- Configure distinct server-side API and operator credentials. Neither database/model credentials nor API bearer tokens belong in the browser bundle.
- Keep `FX_SESSIONS_DIR` on persistent disk if demonstrating agent recovery. Set the actual served model ID/base URL/key only after testing its tool-call parser.
- Upload only the three runtime files. Never upload/open an answer key in the application. Inspect validation errors and hardware eligibility reasons.

## Demonstrate the deterministic path

1. Upload an unfamiliar supported-schema network through the console, without server folder changes.
2. Select software mode, a dataset and a timestamp. Wait for the run to become ready.
3. Verify replay time comes from telemetry, not the system clock. Show source, coverage, unknown classifier capabilities and data-quality indicators.
4. Open an ongoing pump failure: show host countdown method, remaining repair horizon and system-wide truck/well alternatives. Unknown or overdue horizons must not display zero-cost safety advice.
5. Compare a complete system alternative in an isolated scenario. Confirm source telemetry and actual fleet state are unchanged.
6. Acknowledge advice against its plan revision. Refresh and verify the acknowledgment persists. Do not call this physical dispatch.
7. Request shift handoff. Show draft labeling when no model is configured; show actual model-written/cited output only after live provider verification succeeds.
8. Switch to an earlier timestamp or another dataset. A new run rebuilds causal state; old stream events cannot affect the new selection.

## Failure cases

- **No FPGA:** auto mode explicitly uses software; pinned FPGA mode reports failure/unavailability. No hardware-performance claim is made.
- **Incomplete inputs:** upload rejects invalid topology/schema; supported missing observations remain unknown or held only within the documented limit.
- **No weights:** unavailable model scores stay null; no fabricated 0.5 confidence and no claim that undetected leaks/degradation are absent.
- **No model provider:** detection/planning still work and the handoff becomes a solver draft.
- **Database unavailable:** no automatic memory substitution. Jobs and publication retry from durable state once storage recovers; show the outage.
- **Worker restart:** expired claims receive a new fence. Old claims cannot publish; a completed run is not recomputed as another current plan.
- **Browser reconnect:** obtain a consistent snapshot/cursor, resume committed events, and abort old subscriptions on selection change.

## Physical hardware remains a separate verification

Confirm CONFIG/WEIGHTS/DATA startup order, slot mapping, epoch reset/drain procedure, exact packet fixtures, heartbeat behavior, buffer limits and software/FPGA differences with Lucas. The in-process software checkpoint is not a hardware checkpoint. No live GPIO/equipment actuation, automatic model upload or board alarm acknowledgment is exposed by the app.

Report board receive throughput, backend persistence rate, replay duration and UI update rate separately. Benchmark traffic must never create operational incidents or agent work. Do not infer line-rate database capacity from board-only measurements.

## External checks that need credentials/equipment

- Actual Tiger Data service and Timescale extension/version/TLS verification.
- Actual Nemotron endpoint tool round trip and latency.
- Actual FPGA inference and failover/reconnection with approved epochs and golden vectors.

These are not established by local unit tests or software-mode screenshots.
