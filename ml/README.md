# ml — encoder, bit-exact FPGA reference, logistic heads, board tests

Implements [`docs/plan/mudit/ml_plan.md`](../docs/plan/mudit/ml_plan.md) against wire format v1 and engine v2 in
[`docs/plan/lucas/fpga_hardware_plan.md`](../docs/plan/lucas/fpga_hardware_plan.md). Python 3.10+;
`pip install -r requirements.txt`. Run everything from this `ml/` folder. The commands work the same on Windows
(`python` instead of `python3`).

| Module | What it does |
| --- | --- |
| `hutd_ml/wire.py` | Every v1 packet layout (header, DATA 48 B, CONFIG 64/32 B, RESULT 32 B, ALERT 16 B, STATS, WEIGHTS) as numpy dtypes / structs |
| `hutd_ml/encode.py` | Dataset folder → GLOBAL CONFIG + Facility CONFIG + DATA records (the laptop's CSV → binary step). Reads only `network.json` + `telemetry.csv`; every constant comes from the folder |
| `hutd_ml/features_int.py` | **Bit-exact integer engine reference**: validate/hold/reset → 12 channels → 19 memory features → 4 heads → rules → countdown → alarms, with per-stage outputs |
| `hutd_ml/model_int.py` | Integer heads, int16 quantization, weight blob pack/unpack + self-test, CRC32, untrained v0 weights |
| `hutd_ml/labels.py` | Offline labels from `answer_key.json` (training/evaluation only; runtime modules never import it) |
| `hutd_ml/train.py` | Trains the 4 heads with held-out-system validation; picks thresholds / K / `gap_thr`; exports blob + config + report |
| `hutd_ml/golden.py` | Golden vector sets for the RTL testbench and the board |
| `hutd_ml/compare.py` | Diffs RESULT dumps against a golden set; names the first mismatching record and field |
| `hutd_ml/board.py` | Laptop UDP harness: CONFIG → WEIGHTS → DATA (+ HEARTBEAT) to the board, collects RESULT/ALERT/STATS, diffs |
| `hutd_ml/fakeboard.py` | Software stand-in for the board (same UDP protocol, computes with `features_int.py`), for testing the harness, ingest and server without hardware |
| `hutd_ml/replay.py` | **CSV → binary sender (runs on Lucas's PC)**: CONFIG → WEIGHTS → one 5-minute step at a time to the board; leaves 7001/7002 free |
| `hutd_ml/listen.py` | Board output → JSON (stdout / JSONL / HTTP POST batches) + heartbeat. Reference consumer for the server and dashboard: see [`INTEGRATION.md`](INTEGRATION.md) |
| `hutd_ml/augment.py`, `robustness.py` | Raw-domain distortions (pressure offsets, sizes, noise, dropped rows) and the robustness evaluation |

## Quick start

```sh
DATA=/path/to/HackUTD-ZeroDay/history/full_week
HUTD_DATA=$DATA python3 -m pytest -q tests                      # 10 tests, ~6 s
python3 -m hutd_ml.train --data $DATA --answer-key $DATA/answer_key.json --out artifacts/v2 --version 2 \
    --augment --c 1,1,0.03,0.03 \
    --mock $DATA/../mock_test_2026-10-10T1530                     # ~3 min
python3 -m hutd_ml.golden --data $DATA --out artifacts/v2/golden/g1 --set g1 \
    --weights artifacts/v2/weights.bin --weights-version 2 --config artifacts/v2/global_config.json
python3 -m hutd_ml.robustness --data $DATA --answer-key $DATA/answer_key.json --out artifacts/robustness  # ~25 min
```

## For Lucas: what to use

**Committed artifacts:**

| Folder | Weights | Contents |
| --- | --- | --- |
| `artifacts/v0/golden/g0`, `g2` | Untrained pseudo-random int16 (`weights_ver` **240**): full range, both signs, saturating logits | Bring-up of the head/accumulator/saturation path |
| `artifacts/v2/golden/g0`, `g1`, `g2` | **Trained v2, current** (`weights_ver` 2) + its GLOBAL CONFIG (thresholds, K, `gap_thr`) | The real thing |
| `artifacts/v2/` | `weights.bin` (980 B blob), `weights.json`, `global_config.json`, `report.md` | Current model + validation report |
| (v1 removed) | v1 used the pre-review spec (`S_feat` 11, old countdown); it is in git history only | — |
| `artifacts/robustness/` | `report.md`, `results.json` | Robustness pass (section below) |

**The golden sets:**

- **G0:** 30 records, one facility (`fac_id` 0), across a pump start. Cold start, small enough to check by hand.
- **G1:** the whole practice week, 30,240 records, timestep-major.
- **G2:** 34 synthetic edge cases:
  - duplicate, out-of-order;
  - a 1-step gap (HELD), a 3-step gap (reset);
  - inflow absent ×3 (HELD, HELD, reset → INVALID);
  - illegal pump enum, level out of range, illegal well status (→ reset), inflow above `hi`;
  - disabled slot 31, `fac_id` 40;
  - two framing errors (non-zero reserved field, one with `fac_id` 40: framing is checked first), then normal records.

**Files in each set:**

| File | Contents |
| --- | --- |
| `global_config.bin` (32 B), `facility_config.bin` (n × 64 B), `weights.bin` | What to load first, in that order |
| `data.bin` | 48 B DATA records in send order |
| `data.mem` | `$readmemh`, one 64-bit beat per line, 6 beats per record, as stage S0 reads them; little-endian beats printed as hex numbers |
| `expected_results.bin` / `.mem` | One 32 B RESULT per DATA record |
| `expected_stages.csv` | Per record: status, reason, `since_reset`; validated field values; **all 31 features**; logits; rules; countdown; Night Shift / E-STOP |
| `expected_alerts.json`, `facilities.json` | Alerts; the `fac_id` → names map |
| `manifest.json` | SHA-256 of every file |

G1 omits `.mem` and `.csv` to keep the repo small. Regenerate them with `--mem --stages`.

**Check an RTL dump or a board capture:**

```sh
python3 -m hutd_ml.compare artifacts/v1/golden/g2/expected_results.bin my_results.bin --stages artifacts/v1/golden/g2/expected_stages.csv
```

**On the board** (direct cable, PC 192.168.1.50 ↔ board 192.168.1.10):

```sh
python3 -m hutd_ml.board --golden artifacts/v2/golden/g0                      # then g2, then g1
python3 -m hutd_ml.board --golden artifacts/v2/golden/g0 --heartbeat-test 6   # AUTONOMOUS + replay
```

The harness binds local UDP ports 7001–7004. Stop anything else on the PC that uses them first.

**Without the board:**

```sh
python3 -m hutd_ml.fakeboard &        # listens on 127.0.0.2
python3 -m hutd_ml.board --golden artifacts/v2/golden/g1 --board 127.0.0.2 --local 127.0.0.1 --pps 200
```

Verified Sat 23:05 CST: G0, G2 and G1 (30,240/30,240 RESULTs) byte-identical over UDP, plus a 6 s heartbeat gap
replayed correctly. The Python stand-in needs `--pps` ≤ about 200; the real board shouldn't.

## Assumptions where the FPGA plan is silent

These are implemented in `features_int.py` / `encode.py` / `board.py`. **Lucas reviewed them (Sun 00:45 CST):**
`features_int.py` is the normative integer reference for the RTL. A3, A8, A11, A13 and A19 changed as below;
A20–A22 were added while cross-checking against the FPGA team's `FPGA/model/eog_ref.py`. If anything changes again,
change the code here and regenerate the golden sets.

| # | Assumption |
| --- | --- |
| A1 | Hard-wired channels 4–6 use `round(16384/10000·2^S)`, `round(16384/1500·2^S)`, `round(16384/500·2^S)` with the same `S_feat`, applied to level (0.01 %), discharge − P0 (0.1 psi) and pipeline − P0 (0.1 psi) |
| A2 | Channels 7 / 8 (`pump_running`, `pump_fault`) are 16384 or 0 |
| A3 | `(raw·M + 2^(S−1)) >> S` with an arithmetic shift (round half up, negatives included). **`S_feat` = 17, fixed** (FPGA D3: signed 20-bit × unsigned 32-bit); ingest refuses any M ≥ 2^32 |
| A4 | Timestamp step: Δ = 0 → DROPPED duplicate; 0 < Δ < 300 or Δ < 0 → DROPPED out-of-order; Δ = 600/900 → HELD with reason bit 1; Δ ≥ 1200 or not a multiple of 300 → history reset. Channel 11 uses the level change since the last accepted record (not divided over the gap). Memory features are **post-update**: record t includes its own update. |
| A5 | Feature 27's average starts at `x << 8` on the first record after a reset |
| A6 | One hold counter per facility counts consecutive records with ≥ 1 held field. Above `hold_max` the history resets, which also clears the last-valid values. A field with no last-valid value makes the record **INVALID**: no features or memory update, logits 0, rules 0, countdown `0xFFFF`, `since_reset` not incremented, persistence counters cleared. Range/enum failures count as absent (reason bits 3 / 4). |
| A7 | `since_reset` = VALID/HELD records since the reset (0 on the first). The steps-since-run counter starts at 0 at a reset. Feature 30 uses `since_reset` before its increment. |
| A8 | **`review_r1r2` (default; FPGA D1, D2, D6).** The ring holds `max(inflow, 0)` and starts filled with the first value after a reset; mean = sum >> `cd_log2`; p10 = max, p50 = mean, p90 = min. Level ≥ shutdown → 0 / 0 / 0 and "not filling" = 0. Otherwise "not filling" = mean ≤ 0. (`plan_v1`, which rings inflow − pump flow, is kept only as a non-default option.) |
| A9 | `K_cd = round(0.288·C·256)`; `minutes = (K_cd·Δlevel_raw) // (net_raw << 8)`; ≥ `0xFFFF` → `0xFFFF` |
| A10 | Model alarm: logit **>** `logit_thr` for K consecutive VALID/HELD records; INVALID clears the counters, DROPPED doesn't touch them |
| A11 | E-STOP condition: channel 3 **>** `gap_thr` and leak logit **>** its threshold for K(leak) consecutive records. Latched like Night Shift (A19). |
| A12 | Night Shift rule flags = `pump_fault`, `shut_in`, level ≥ shutdown, level ≥ warning. **Not "not filling"**, which is true whenever the pump runs. |
| A13 | **A non-zero reserved field → DROPPED, reason bit 12 `FRAMING`** (FPGA D9), checked *before* the facility lookup. No state change. |
| A14 | CONFIG `lo[]` / `hi[]` follow `present`-bit order (inflow, level, pump_status, pump_flow, discharge, receive_flow, pipeline). Bounds come from metadata, never from observed data: flows −5 % Q … 4 × max(Q, B); psi 0 … pipeline `max_pressure_psi`; level −5 … 105 %; wells −5 % … 4 × max baseline. |
| A15 | Encoder rounding is `floor(v·scale + 0.5)` |
| A16 | WEIGHTS: data chunks ≤ 1,024 B, each ACKed. COMMIT is a chunk with offset = blob length, length 0, flags 1, followed by u32 total length and u32 CRC32 (zlib / IEEE). |
| A17 | `result_no` counts from 0 at engine start; DROPPED records also get one |
| A18 | Weight blob layout: `docs/plan/mudit/ml_plan.md` §4.8 (also documented in `model_int.py`) |
| A19 | **Latched Night Shift and E-STOP** (FPGA D8). Per facility: conditions `ns_cond` / `es_cond` and latches.<br>- VALID / HELD: `latch \|= cond`.<br>- `NS_RAISED` / `ES_RAISED` when the condition holds and the latch was clear.<br>- `CLEARED` when a condition goes 1 → 0 (the latch stays set).<br>- Order per record: NS_RAISED, ES_RAISED, CLEARED(NS), CLEARED(ES).<br>- SOURCE: bit 0 rule (for E-STOP, the gap rule), bit 1 model (any class active), bit 2 autonomous, bit 4 latch type. CLEARED carries only bits 2 and 4.<br>- INVALID clears the persistence counters but no condition, latch or ALERT. History resets keep the latches.<br>- Acknowledge exists only in hardware (never modelled; golden sets never acknowledge). |
| A20 | **Per-class K** (FPGA D10): GLOBAL bytes 20–23 `persist_K4`, where 0 falls back to byte 3; K = max(K, 1) |
| A21 | Every DROPPED RESULT carries `since_reset` 0, `weights_ver` 0, logits 0, rules 0, countdown `0xFFFF` (FPGA numerics.md 3.9) |
| A22 | The first record a facility ever sends starts a new history (reason bit 2). Additive reason bits from FPGA numerics.md §6: 11 `FIELD_ABSENT` (present bit clear), 13 `NO_MODEL` (VALID/HELD with weights version 0), 14 `FIELD_LOST` (no value to hold → INVALID) |

## Current model (v2)

See `artifacts/v2/report.md`. Retrained Sun Nov 8 ~01:00 CST under the reviewed spec (`S_feat` = 17,
`review_r1r2` countdown). Training data: the practice week **plus augmented copies**:

- healthy pressure offsets ×0.8 / ×1.2;
- sizes ×0.7 / ×1.5;
- extra sensor noise.

C = 1 for leak and degradation, 0.03 for failure and shut-in. Shipped GLOBAL settings: `persist_K` = 1,
`persist_K4` = [1, 1, 1, 1], `logit_thr` = [0, 384, 0, 0] in 1/256 units, `gap_thr` = 504. Thresholds and K are
chosen, within ≤ 0.05 false alerts per facility-day, for the most events caught and then the fastest median
detection. Scored out-of-fold (holding out one system at a time) on clean data, with integer logits:

| Head | Precision / recall | Events caught | Median / max delay after onset | False alerts per facility-day |
| --- | --- | --- | --- | --- |
| Leak | 0.94 / 0.99 | 5/5 | 5 / 60 min | 0.048 |
| Degradation | 0.95 / 0.84 | 5/5 | 170 / 275 min | 0.048 |
| Failure | 1.00 / 1.00 | 13/13 | 0 | 0 |
| Shut-in | 1.00 / 1.00 | — | — | 0 |

- E-STOP fires on 5/5 leaks and never outside a leak.
- int16 vs float decisions agree on 99.999% of records.
- The thresholds were picked on the same out-of-fold scores, so these numbers are optimistic on one practice week.
- Failure and shut-in are signalled directly by pump status 2 / all wells off.

**Why degradation is slower than leak:**

- Three of the five degradation events start while the pump is off; it first runs 105–145 min after onset. Before
  that there is nothing to measure.
- When the pump does run, flow is still within healthy noise: 0.990–1.002 of normal, against a healthy 1st–99th
  percentile of 0.987–1.013.
- The model fires once the loss reaches about 1–2 %, which is at the edge of that noise.
- Events last 24–36 h, and three end in a pump failure. Detection 3–4 h in is about 30 h before those
  failures (an in-sample check gave 31–33 h).

## Cross-check with the FPGA team's reference model

`python -m hutd_ml.xcheck --fpga-model <FPGA/model> --golden artifacts/v2/golden/g1 --zero-k4 --remap-lohi` runs
`FPGA/model/eog_ref.py` (branch `FPGA` at `97ef685`) on the same records. Results, Sun 01:05 CST:

- **G1 (30,240 records):**
  - every field is identical except p50 countdowns, which differ by ±1 min in 1,096 records;
  - 103 of 130 ALERTs are identical in order. The first difference is one record whose flow gap equals `gap_thr`
    exactly.
- **G2:** the hold/reset records (12–33) differ.

All remaining differences are decisions Lucas already accepted that `eog_ref.py` doesn't implement yet:

- D6: the prefilled ring with mean = sum >> 4;
- D7: A6 hold/reset;
- A10: strict `>` for logits and the gap;
- A14: `lo[]/hi[]` in present-bit order. `--remap-lohi` exists only to see past this.

Spec v1's SHUTIN_WATER_MAX also sits in GLOBAL bytes 20–21, where D10 now puts `persist_K4` (`--zero-k4`).

## Robustness pass (rerun Sun 01:15 CST under the reviewed spec, `S_feat` = 17)

`python -m hutd_ml.robustness` distorts the held-out system's data **before encoding**: it goes through the real
encoder and engine. Thresholds come from clean data and are applied unchanged. Full tables are in
`artifacts/robustness/report.md`. Leak / degradation false alerts per facility-day:

| Test distortion | Clean-trained (v1 settings, C 3) | **v2 (augmented, C 1)** |
| --- | --- | --- |
| None | 0.04 / 0.05 | 0.05 / 0.05 |
| Healthy pressure offsets ×0.7 | 0.02 / **1.7** | 0.04 / 0.03 |
| Healthy pressure offsets ×1.3 | **5.1** / 0.01 | 0.08 / 0.27 |
| Disposal pressure +200 psi; all sizes ×0.5 or ×2 | identical to none | identical to none |
| Extra sensor noise | 0.16 / 0.10 | 0.19 / 0.17 |
| 2 % of readings missing | 0.20 / 0.19 (AP 0.85 / 0.77) | 0.33 / 0.26 (AP 0.83 / 0.73) |

Both models caught 5/5 leaks and 5/5 degradations under every distortion.

**What the table shows:**

- **Normalization works:** resizing every facility or shifting disposal pressure changes nothing.
- **v1's weak spot was pressure:** if the judging network's healthy pressure offsets differ from the practice
  week's +150 / +50 psi (SPEC calls them placeholders), v1's thresholds produce up to 4.9 false alarms per
  facility-day. Stronger regularization alone didn't fix this; augmentation did. Hence v2.
- **Missing data is the remaining weakness, for every model.** With 2 % of readings missing:
  - 22 % of records are HELD;
  - the hold rule resets a facility's memory about 2.7 times a day;
  - half of all results have less than 64 steps of memory.

  The cause is the FPGA's hold/reset policy, not the weights: review R7 in `docs/plan/lucas/review_notes.md`. The
  practice data has no gaps, and SPEC says every sensor reports every interval, so this matters only if the judging
  data is dirty.
