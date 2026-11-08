# Start here, Jason: Nemotron next, and where ML and FPGA stand

Written for you by the ML side at integration time (Sun Nov 8, ~03:30 CST). This is your folder: edit, move or
delete this file. The single source of truth stays [`global_plan.md`](../../../global_plan.md); this page only
points into it.

## 1. The one-minute version

- **PR #6** (`ml` → `main`) brings your PR #4 (API + console) onto `main` unchanged, plus PR #3's Nemotron runbook,
  the ML pipeline with **weights v4**, a few console fixes for hard rule 9 (I-11), and the rewritten global plan.
  PR #3 is fully covered and can be closed. FPGA **code** stays on Lucas's branch `FPGA` until his own PR after
  T2.top; the FPGA spec and task board are already on `main` (his PR #5).
- **The FPGA is the fixed point.** Spec v4 and the RTL are done and won't change. Everything else, the server
  included, adapts to them (`global_plan.md`, "How this file works").
- **Final say:** server, agents and Nemotron are **yours**; spec / FPGA / RTL are Lucas's; ML, weights, `replay.py`
  and `listen.py` are Mudit's. It's a tiebreaker: the §8 approvers are consulted first.
- **Your first five minutes:** C9, C10, C12 (events/actions, server ↔ web API, agent scope) and hard rules 12–13
  are marked **PROPOSED** because nobody could record your confirmation overnight. They describe what your PR #4
  already implements. If you agree, flip them to ADOPTED in `global_plan.md` §2 / §5 with a changelog row
  (C9 / C10 also need Gurneal).

## 2. What the board side gives you

```text
dataset folder ──replay.py (CSV → 48 B DATA, on Lucas's PC)──UDP──► Eclypse Z7 board  ─┐
                                                       └──────────► fakeboard.py (no board, bit-exact)
                                     ┌─────────────────────────────────────────────────┘
                                     ▼ UDP 7001 / 7002 → 192.168.1.50
                              listen.py ──HTTP POST JSON arrays (contract C11)──► your ingest
```

Per record and facility (every 5 min of telemetry), one **result**; plus **alert** objects when the board's Night
Shift / E-STOP latches change; plus **stats**. A real line from the run below:

```json
{"type": "result", "fac_id": 0, "facility": "S1_FACILITY_A", "system": "S1", "ts_unix": 1791458400,
 "status": "VALID", "reason": ["history_reset"], "since_reset": 0,
 "logits": {"pipeline_leak": -14.21, "pump_degradation": -15.67, "pump_failure": -4.43, "facility_shut_in": -7.65},
 "probability": {"pipeline_leak": 0.0, "pump_degradation": 0.0, "pump_failure": 0.0001, "facility_shut_in": 0.0},
 "above_threshold": [], "rules": [], "countdown_min": {"p10": 167, "p50": 167, "p90": 167},
 "weights_ver": 4, "result_no": 0}
{"type": "alert", "fac_id": 3, "facility": "S2_FACILITY_A", "kind": "night_shift_raised", "source": ["rule", "model"],
 "latch": "night_shift", "rules": ["pump_fault"], "classes": ["pump_failure"], "countdown_p10_min": 194}
```

Field meanings, statuses and reason names: [`ml/INTEGRATION.md`](../../../ml/INTEGRATION.md) §3. The things that
matter for the server and the agent:

- `above_threshold` **is** the detection: the board applied the tuned thresholds and persistence. `probability` is
  the calibrated confidence to show.
- `status` is VALID / HELD / INVALID / DROPPED, with reasons. Missing readings: a field may be held for up to 2
  steps; after that the record is INVALID (`field_lost`) and **no scores are given** for it (hard rule 9: show it as
  unknown, never healthy).
- `countdown_min` assumes the failed pump moves nothing; it's only meaningful while `rules` has `pump_fault`.
  0 / 0 / 0 means the tank is already at shutdown. Your host countdown (inflow-only, rolling 16) is the same method.
- **Alerts are local alarms only** (LEDs / Pmod on the board, hard rule 8). The agent may explain them, never
  acknowledge them (I-9).
- `weights_ver` 4 = the deployed model; 240 = untrained test weights; 0 = no model loaded.

**Model (weights v4):** four logistic regressions on 31 streaming features computed on the FPGA. Out-of-fold on the
practice week: leak precision / recall 0.92 / 0.99, median 10 min after onset; degradation 0.96 / 0.90, median
160 min; failure and shut-in 1.00 / 1.00. With 2 % of readings missing: 0.03 / 0.17 false alerts per facility-day.
Design: [`docs/plan/mudit/ml_architecture.md`](../mudit/ml_architecture.md). Quote these only with their source
(hard rule 10).

**Board status (Lucas, Sun 02:45):** most modules are signed off; countdown, head and regs are in review. Then
T2.top → Vivado build → board tests with the v4 golden sets → **first live run, which streams into your server**.
No clock times yet; Lucas pings when the Vivado build starts. Until then, `fakeboard.py` gives identical JSON.
Order and estimates: `global_plan.md` §7 and [`../lucas/board_run_plan.md`](../lucas/board_run_plan.md).

### Run it locally today (verified Sun 03:25 CST with v4)

From `ml/` (`pip install -r requirements.txt`; `DATA` = the reference repo's `history/full_week`), three terminals:

```bash
python -m hutd_ml.fakeboard
```

```bash
python -m hutd_ml.listen --data $DATA --board 127.0.0.2 --weights-json artifacts/v4/weights.json --config artifacts/v4/global_config.json --jsonl results.jsonl --post http://127.0.0.1:<port>/<your-ingest-route>
```

```bash
python -m hutd_ml.replay --data $DATA --board 127.0.0.2 --local 127.0.0.1 --weights artifacts/v4/weights.bin --weights-version 4 --config artifacts/v4/global_config.json --start-step 1000 --steps 40 --step-seconds 0.05
```

Result of that exact run: 600 results (40 steps × 15 facilities) and 9 alerts. Night Shift was raised for the
three S2 pump failures (rule + model), two degradations and a leak (model), with E-STOP on the leak, followed by
two CLEARED alerts. Everything arrived as 35 POST batches. Starting at a later step starts the board's memory fresh
there, as after a power-on. Without `--post`, `listen.py` just prints JSON lines.

## 3. Your open items (from `global_plan.md` §9), in a suggested order

The order is a suggestion; the server is your call.

1. **Nemotron live.** Set `NVIDIA_BASE_URL`, `NEMOTRON_MODEL`, `NVIDIA_API_KEY` server-side (README "Optional ...";
   endpoint and model in [`nemotron-inference-operations.md`](nemotron-inference-operations.md)). Two things to check
   before the demo, both found while writing this:
   - the vLLM server runs with **max model len 4096**, while the coordinator asks for up to 1,024 output tokens on
     top of the facts and tool schemas. `Provider.contextWindow` exists, but `loadConfig` never sets it, so libfx
     doesn't know the limit;
   - the tool-call parser (`qwen3_coder` on Nemotron) is not yet verified end to end; your runbook already says to
     test it before setting the served model.
2. **I-10:** two `service.test.ts` tests fail on PR #4 as merged (same on `e001cf3` alone).
3. **I-8:** AI SDK fallback fixes (tool wiring, `ai-sdk` label in the UI, no fake FX session link, no `nowUnix ?? 0`).
4. **I-1 + I-4: model scores in runs.** Today a run has **no ML scores** unless `MODEL_METADATA_PATH` points at a
   registered model ("Classifier unavailable"), and `packages/fpga-sim` is a prototype, not bit-exact. Two ways to
   get the board's scores into incidents and the agent's facts:
   - **I-1 (matches the architecture):** accept `listen.py` JSON into a run, so the board, or `fakeboard.py` until
     then, feeds incidents. `apps/api/src/bridge.ts` currently posts to `/api/hardware/batches`, which the API
     deliberately doesn't expose; aligning it with `listen.py` gives one bridge. The console's `/api/ingest` is the
     interim consumer.
   - **I-4 (quick, labeled):** a registered model for `fpga-sim` built from v4. It wouldn't be bit-exact, and the
     formats differ: `fpga-sim` takes one `persistK` and probability thresholds; v4 uses per-class K [2, 4, 1, 1]
     and logit thresholds in 1/256 units. Mudit's side can generate the JSON if you want it. Label it "not FPGA
     bit-exact" (proposed hard rule 11).
5. **I-9 (with Lucas):** define the server → board alarm-acknowledge message. The ARM forwards it; the RTL already
   has `CTRL.server_ack`. Until then, acknowledge is the board's button only.
6. **I-5** fill rate from inflow only; **I-6** `fpga-sim` latch mapping; **I-3** one encoder (with Mudit).

Gurneal's items: **I-2** board data from `Snapshot.board`, **I-7** `SIMULATE_BOARD` dev-only, **I-12** dead links
(`/api/events` → your `GET /runs/:id/export`), **I-13** approvals through `POST /runs/:id/actions`, **I-14** shared
contracts; plus a review of the **I-11** console fixes in PR #6.

## 4. Don't

- Don't plan around any FPGA, RTL or wire-format change. If something on the board side looks broken, tell Lucas
  and work around it on the server.
- Don't load `answer_key.json` anywhere at runtime (hard rule 1).
- Don't label `fpga-sim` or host-computed scores "board" / "FPGA" / "model score".
- Don't commit keys: Nemotron, database and API tokens stay server-side environment variables.

## 5. Who to ask

| About | Ask |
| --- | --- |
| Board, wire format, alarms, timing of the board run | Lucas |
| The JSON (`listen.py`), weights, `replay.py`, `fakeboard.py`, model numbers | Mudit |
| Console and UI wording | Gurneal |
