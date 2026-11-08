# Server → web app: board data (draft for global plan O11 / C10)

Status: **PROPOSED by the web app (Gurneal)**, needs Jason's OK. Nothing here changes the board wire format (C2).

The web app already computes events, countdowns and the cheapest plans from the dataset files itself. That is its
fallback when the board is offline (global plan §7). From the server it only needs what the **board** knows: model
scores, alarms, and board health. One read-only endpoint is enough.

## Endpoint

`GET {LIVE_API_URL}/v1/board?dataset=<folder id>&at=<unix seconds, optional>`

- `dataset`: the folder name the console is showing (e.g. `mock_test_2026-10-10T1530`, `test`).
- `at`: present when the operator is replaying the past; the server returns the board state as of that time, or
  omits fields it can't reconstruct.
- Auth: optional `Authorization: Bearer <LIVE_API_KEY>`.
- The web app waits at most 2.5 s; on any error it shows "Board offline" and keeps its local results.

## Response (JSON)

```json
{
  "provenance": "fpga",
  "online": true,
  "mode": "NORMAL",
  "lastSeenUnix": 1791646200,
  "weightsVersion": 1,
  "autonomousSinceUnix": null,
  "replayedAlerts": 0,
  "facilities": [
    {
      "facilityId": "S5_FACILITY_C",
      "updatedUnix": 1791646200,
      "scores": { "pipeline_leak": 0.03, "pump_degradation": 0.05, "pump_failure": 0.98, "facility_shut_in": 0.01 },
      "overThreshold": ["pump_failure"],
      "source": "both",
      "sinceReset": 255,
      "alarm": "night_shift",
      "alarmState": "raised",
      "alarmSinceUnix": 1791640800,
      "replayed": false,
      "degradationTrend": { "t": [1791639000, 1791639300], "v": [0.12, 0.14] }
    }
  ]
}
```

## Field mapping from the board packets

| Field | From | Notes |
| --- | --- | --- |
| `provenance` | server (fpga-sim `Provenance`) | `"fpga"` board results, `"software"` the server's fpga-sim stand-in is classifying, `"unavailable"` nothing is |
| `online` | server | `true` if a RESULT or STATS arrived in the last ~5 s |
| `mode` | STATS `mode` | `"NORMAL"` (0) or `"AUTONOMOUS"` (1) |
| `lastSeenUnix` | latest RESULT `ts_unix` | data time, not wall clock |
| `weightsVersion` | RESULT `weights_ver` / STATS | active weight bank; `240` = Mudit's untrained bring-up weights (the UI then says scores are not meaningful), `1` = trained v1 |
| `autonomousSinceUnix` | server | when the board last went AUTONOMOUS, else `null` |
| `replayedAlerts` | ALERT `source` bit 3 | count replayed since reconnect |
| `facilityId` | `fac_id` → `network.json` order | the web app needs the **ID string**, not the slot number (C3 slot rule) |
| `scores` | RESULT `logits` | **calibrated probabilities 0–1** (sigmoid + Mudit's calibration), head order `[pipeline_leak, pump_degradation, pump_failure, facility_shut_in]`; `null` before weights are loaded |
| `overThreshold` | ALERT `classes` / thresholds | head names above their threshold |
| `source` | ALERT `source` bits 0–1 | `"rule"`, `"model"`, `"both"` or `"none"` |
| `sinceReset` | RESULT `since_reset` | 0–255 |
| `alarm` | latest ALERT `kind` per facility | `"night_shift"` (1), `"e_stop"` (2), or `"none"` |
| `alarmState` | ALERT `kind` | `"raised"` (1/2), `"cleared"` (3), `"acknowledged"` (4) |
| `alarmSinceUnix` | ALERT `ts_unix` | when the current alarm was raised |
| `replayed` | ALERT `source` bit 3 | delivered from the board's buffer |
| `degradationTrend` | server, from RESULT logits | optional; `pump_degradation` probability over the last few hours, ≤ 200 points |

Data quality (VALID / HELD / INVALID / DROPPED) and countdown p10/p50/p90 are already computed by the web app from
the dataset; the server doesn't need to send them. If the team prefers the board's own values on screen, add
`status`, `reason` and `countdown` per facility with the same meaning as RESULT, and the web app will show those
instead.

## What the web app shows

- Toolbar: board online / offline / autonomous, weights version.
- Pump cards and inspection rows: the model's probability and whether a rule or the model raised it; Night Shift
  or E-STOP alarm with its state.
- Facility pop-up: all four scores, history behind them (`sinceReset`), alarm detail, wear score trend.
- A banner when the board was autonomous and replayed alerts.

Nothing is shown when the endpoint isn't configured, so the console never displays model numbers that don't exist.

## Trying it without the server

`SIMULATE_BOARD=1 npm run dev` serves a development feed shaped like this contract, derived from the console's own
detections and labelled "Simulated board" on screen. `SIMULATE_BOARD=autonomous` shows the board working on its own,
`SIMULATE_BOARD=software` the software stand-in, `SIMULATE_BOARD=reconnected` the alerts it replayed after reconnecting, and `SIMULATE_BOARD=offline` the offline state.
