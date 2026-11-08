# Integration guide: server / agents (Jason) and dashboard (Gurneal)

How to get live detection results from the FPGA, or from its software stand-in, into the server and the dashboard.
Written Sun Nov 8 2026. Read [`global_plan.md`](../global_plan.md) §2 (hard rules) first. Lucas's
[FPGA plan](../docs/plan/lucas/fpga_hardware_plan.md) defines the binary protocol. This guide wraps it so you
only deal with JSON.

## 1. The data path

```
dataset folder ─► replay.py (CSV → binary) ─UDP 7000/7003/7004─► board (Eclypse Z7)  or  fakeboard.py
                       on Lucas's PC                                       │
                                                       UDP 7001 RESULT/STATS, 7002 ALERT
                                                                           ▼
                                                    listen.py (binary → JSON, sends HEARTBEAT)
                                                      │ stdout / JSONL file / HTTP POST batches
                                                      ▼
                                          your server + agents ─► dashboard
```

- **CSV → binary runs on Lucas's PC** (`python -m hutd_ml.replay`). It is the only thing that reads `telemetry.csv`
  for the board, and it computes nothing.
- The board does **all detection**:
  - data checks;
  - features and the four ML scores (leak, degradation, failure, shut-in);
  - rule flags;
  - the countdown to tank shutdown;
  - local alarms.

  It returns **one result per facility per 5-minute step**.
- **The server does the planning:**
  - building events (onset, ongoing, resolved);
  - inspections;
  - truck / shut-in plans across each system's shared fleet (from `ops.json`, read directly by the server);
  - the agents' explanations.
- The board sends its output to the PC on the direct cable (192.168.1.50). `listen.py` runs there and forwards JSON
  to the server with `--post`. Alternatively, the server runs on Lucas's PC. **Jason decides which**; nothing else
  changes.

## 2. Run it today without the board (3 terminals, any OS)

From the repo root: `cd ml && pip install -r requirements.txt`. You need a dataset folder, e.g.
`HackUTD-ZeroDay/history/full_week` from https://github.com/nihaal419/HackUTD-ZeroDay.

```sh
# 1. software board (Python copy of the FPGA logic; same UDP protocol)
python -m hutd_ml.fakeboard

# 2. results as JSON: printed, saved, and/or POSTed to your server
python -m hutd_ml.listen --data $DATA --board 127.0.0.2 \
    --weights-json artifacts/v2/weights.json --config artifacts/v2/global_config.json \
    --jsonl results.jsonl --post http://127.0.0.1:8000/ingest

# 3. stream the dataset: 1 five-minute step per second (300x real time)
python -m hutd_ml.replay --data $DATA --board 127.0.0.2 --local 127.0.0.1 \
    --weights artifacts/v2/weights.bin --weights-version 2 --config artifacts/v2/global_config.json \
    --step-seconds 1
```

Useful replay options:

- `--start-step N`: start at step N, each step being 5 minutes. For example, step 1,000 = Thu Oct 8 11:20 UTC,
  just before three S2 pumps fail.
- `--steps M`: stop after M steps.
- `--step-seconds 0.05`: faster.
- `--loop`: repeat forever with advancing timestamps.

The Python board handles up to about 200 packets/s.

Without `--post`, `listen.py` just prints JSON lines: that's the easiest way to see the data.

**Tested Sun 00:20 CST:** 300 steps × 15 facilities = 4,500 results, all received and POSTed, plus alerts and
STATS.

## 3. The JSON you receive

With `--post`, `listen.py` sends a JSON **array** of these objects about every 0.5 s. It sends `[]` when idle, so
answer 2xx quickly. Three types:

### `result`: one per facility per 5-minute step (example values are illustrative)

```json
{"type": "result", "fac_id": 4, "facility": "S2_FACILITY_B", "system": "S2",
 "ts_unix": 1791458400, "time": "2026-10-08T11:20:00Z",
 "status": "VALID", "reason": [], "since_reset": 37,
 "logits": {"pipeline_leak": -10.87, "pump_degradation": -6.45, "pump_failure": 9.2, "facility_shut_in": -5.3},
 "probability": {"pipeline_leak": 0.0, "pump_degradation": 0.0, "pump_failure": 1.0, "facility_shut_in": 0.0},
 "above_threshold": ["pump_failure"],
 "rules": ["pump_fault"],
 "countdown_min": {"p10": 120, "p50": 124, "p90": 129},
 "weights_ver": 1, "result_no": 4}
```

| Field | Meaning / how to use it |
| --- | --- |
| `facility`, `system` | Names from the dataset's `network.json`. `fac_id` = position in that file. Always use the names in the UI. |
| `ts_unix` / `time` | Telemetry time of this reading (UTC). **"Now" = the newest `ts_unix` you've received**, never the wall clock: the data is from October. |
| `status` | `VALID`; `HELD` (a missing reading was filled with the last good value, at most 2 steps); `INVALID` (not enough data; scores are 0, don't use them); `DROPPED` (duplicate / out-of-order / unknown facility). **Never show INVALID / DROPPED as "healthy"**: show a data-quality badge. |
| `reason` | Why the status isn't plain VALID, e.g. `field_held`, `history_reset`, `out_of_range`, `pump_flow_inconsistent` |
| `since_reset` | How much history backs the scores (saturates at 255). Small right after startup or a data gap. |
| `logits` | Raw model scores, one per problem. > 0 leans "problem", < 0 leans "normal". |
| `probability` | Calibrated confidence 0–1. Needs `--weights-json`. **Show this as the "confidence" in the UI.** |
| `above_threshold` | Problems whose score is over the tuned alarm threshold. Needs `--config`. **This is the detection.** |
| `rules` | Hard facts, not ML: `pump_fault` (pump reports a fault), `shut_in` (all wells off), `level_at_shutdown`, `level_at_warning`, `not_filling` (normal while the pump runs; ignore it for alerting). |
| `countdown_min` | Minutes until the tank reaches its shutdown level if nothing changes. p50 = best estimate; p10 = soonest; p90 = latest. `null` = not filling / > 45 days. **Only meaningful while `pump_fault`** (see §5, countdown caveat). |
| `weights_ver` | Which model made the call: **2** = current trained model (v2); **1** = previous trained model; **240** = untrained test weights (scores meaningless); **0** = no model loaded (scores 0; rules and countdown still valid). |
| `result_no` | Monotonic counter. Gaps mean lost UDP packets. |

### `alert`: the board's own alarm changed state

```json
{"type": "alert", "fac_id": 4, "facility": "S2_FACILITY_B", "system": "S2", "ts_unix": 1791458400,
 "time": "2026-10-08T11:20:00Z", "kind": "night_shift_raised", "source": ["rule", "model"],
 "result_no": 4, "rules": ["pump_fault"], "classes": ["pump_failure"], "countdown_p10_min": 124}
```

| Field | Meaning |
| --- | --- |
| `kind` | `night_shift_raised` (operator attention needed), `estop_raised`, `cleared` (condition gone), `acknowledged` |
| `source` | `rule`, `model`, `raised_while_autonomous`, `replayed_from_buffer` |

**`estop_raised`** fires on a *confirmed leak*: the flow-gap rule and the leak score both trip. It's a **local
hardware alarm signal (LED / pin)** for the demo, not an equipment shutdown. Per the challenge, the recommended
action for a leak is still `field_inspection` (global_plan hard rule 8, open question O6).

### `stats`: board health, about once per second

Counters: `records_in`, `results_out`, `dropped_*`, `invalid`, `held`, `history_resets`, `alerts_raised`, `mode`
(`NORMAL` / `AUTONOMOUS`), `weights_version`, `uptime_s`, `replay_waiting`. Show `mode`, throughput and data
quality in a small status panel. `AUTONOMOUS` means the board stopped hearing heartbeats (server down) and is
buffering.

## 4. What the server should build on top (challenge rules)

1. **Events.** For each facility and problem, open an event when the problem appears in `above_threshold`, or for
   failure / shut-in when the matching rule appears. Keep it `ongoing` while it stays. Mark it `resolved` after
   about 3 consecutive steps without it (tune this).
   - `onset_ts` = the first step it appeared.
   - The challenge's optional `events.json` shape is in its SPEC (`event_id`, `category`, `status`, `onset_ts`,
     `confidence`, `hours_to_limit`, `recommended_actions`).
   - Categories map one to one: `pipeline_leak`, `pump_degradation`, `pump_failure`.
   - **Shut-in is not a separate incident:** it's the consequence of a pump failure. Attach it to that failure
     event (production lost), don't open a second one or plan trucks twice.
2. **Actions.**
   - Leak or degradation → `field_inspection`, with **no countdown**.
   - Pump failure → countdown (`hours_to_limit` = `countdown_min.p50 / 60`, band from p10 / p90) plus the cheapest
     plan: trucks, early well shut-ins, or accept the trip.
3. **Planning.**
   - Plan **per system**: all ongoing failures in a system share its `emergency_fleet_size` (`ops.json`).
   - Read `ops.json` and `network.json` from the **same dataset folder** the replay uses.
   - Truck timing rules: SPEC "Plans".
   - Plans never rewrite the telemetry: what-if replays are a separate simulation.
4. **Alerts view order:** pump failures first, soonest shutdown first (ties: higher lost revenue per hour); then
   leaks and worn pumps.
5. **No hardcoding:** asset names, counts and prices always come from the files. At judging the dataset is a
   different network (S6–S11): switching folders must need no code change. `answer_key.json` is never loaded at
   runtime.
6. **Heartbeat:**
   - `listen.py` sends it for you.
   - With `--post`, it only keeps sending while your endpoint returns 2xx. If your server dies, the board enters
     AUTONOMOUS within 5 s, keeps alarming locally, and replays the results it buffered when you're back.
   - If you replace `listen.py`, send a HEARTBEAT (16-byte header, type 9, count 0) to the board's UDP 7003
     every second.

## 5. Caveats you should know

- **The model is accurate on the practice week:**

  | Problem | Precision / recall | Events caught | Typical delay |
  | --- | --- | --- | --- |
  | Leak | 0.94 / 0.99 | 5/5 | 5 min |
  | Degradation | 0.95 / 0.84 | 5/5 | about 3 h |
  | Failure / shut-in | 1.00 / 1.00 | — | — |

  Degradation is slow by nature, because early wear looks like normal noise. Failure and shut-in come straight from
  the pump fault code and the well status.
- **Countdown caveat:**
  - Right after a pump fails, the countdown can read `null` or far too long for about the first hour. The board's
    countdown averages the last 80 minutes, which include the time before the failure when the pump was still
    running.
  - A fix is proposed (review R1/R2 in `docs/plan/lucas/review_notes.md`) and pending Lucas's decision.
  - Until then, the server can compute its own countdown for failed pumps: remaining room in the tank ÷ facility
    inflow. Inflow and level are in the telemetry, and tank capacity and limits are in `network.json`.
  - It will change if the fix is adopted (`fakeboard.py --countdown review_r1r2` already behaves that way).
- **The fake board is the reference**, not the hardware. The real board must produce byte-identical results;
  Lucas is verifying that. The JSON contract above doesn't change between them.
- **Current weights are v2**, trained with augmented copies of the data so they hold up if the judging network's pressures look different. Future weights keep the same JSON; only `weights_ver` changes.
- `fac_id`, the wire format, and the exact meaning of some fields depend on 19 implementation details
  (`ml/README.md`, A1–A19) that Lucas is reviewing. Expect small changes in edge cases only.

## 6. Raw protocol, if you don't want listen.py

All UDP, little-endian, every packet starts with a 16-byte header: magic `EOGF`, version 1, type, count, seq,
aux. Record layouts are the numpy dtypes in [`hutd_ml/wire.py`](hutd_ml/wire.py): RESULT 32 B (type 2, port 7001),
ALERT 16 B (type 3, port 7002), STATS 64 B (type 8, port 7001). `hutd_ml/listen.py` (about 200 lines) is the
reference decoder.

## 7. Paste-ready brief for your Claude

> We're integrating with the HackUTD FPGA pipeline. Read `ml/INTEGRATION.md`, then `global_plan.md` §2 (hard
> rules) in the repo (branch `ml`).
> - Results arrive as JSON from `python -m hutd_ml.listen` (stdout, a JSONL file, or HTTP POST arrays to our
>   endpoint), one `result` per facility per 5-minute step, plus `alert` and `stats` objects. Use the schema in
>   INTEGRATION.md §3 exactly.
> - Develop against the software board: run `python -m hutd_ml.fakeboard`, then `listen.py`, then
>   `python -m hutd_ml.replay` as in §2.
> - "Now" is the newest telemetry timestamp received, never the wall clock.
> - Build events, inspections, countdowns and per-system truck plans on the server as in §4. Read `ops.json` /
>   `network.json` from the same dataset folder.
> - Show `probability` as confidence and `above_threshold` + `rules` as detections. Treat INVALID / DROPPED as
>   data-quality states, never as healthy.
> - E-STOP is a local alarm signal only; leaks still get `field_inspection`.
> - Never load `answer_key.json` at runtime and never hardcode asset names or counts: the judging dataset is a
>   different network.
