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
python3 -m hutd_ml.train --data $DATA --answer-key $DATA/answer_key.json --out artifacts/v3 --version 3 \
    --augment --observable --c 3,3,0.03,0.03 \
    --mock $DATA/../mock_test_2026-10-10T1530                     # ~3 min
python3 -m hutd_ml.golden --data $DATA --out artifacts/v3/golden/g1 --set g1 \
    --weights artifacts/v3/weights.bin --weights-version 3 --config artifacts/v3/global_config.json
python3 -m hutd_ml.experiments --data $DATA --answer-key $DATA/answer_key.json --out artifacts/experiments  # ~15 min
python3 -m hutd_ml.fpga_sync --record     # what changed on branch FPGA + xcheck vs eog_ref
python3 -m hutd_ml.robustness --data $DATA --answer-key $DATA/answer_key.json --out artifacts/robustness  # ~25 min
```

## For Lucas: what to use

**Committed artifacts:**

| Folder | Weights | Contents |
| --- | --- | --- |
| `artifacts/v0/golden/g0`, `g2` | Untrained pseudo-random int16 (`weights_ver` **240**): full range, both signs, saturating logits | Bring-up of the head/accumulator/saturation path |
| `artifacts/v3/golden/g0`, `g1`, `g2` | **Trained v3, deployed** (`weights_ver` 3) + its GLOBAL CONFIG | Use for the board run and the demo |
| `artifacts/v3/` | `weights.bin` (980 B blob), `weights.json`, `global_config.json`, `report.md` | Deployed model + validation report |
| `artifacts/v2/golden/g0`, `g1`, `g2` | Trained v2 (`weights_ver` 2) | What the RTL is verified against (T2.top). Equally valid: the RTL doesn't depend on the weights. |
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
python3 -m hutd_ml.board --golden artifacts/v3/golden/g0                      # then g2, then g1 (v2 sets work too)
python3 -m hutd_ml.board --golden artifacts/v3/golden/g0 --heartbeat-test 6   # AUTONOMOUS + replay
```

The harness binds local UDP ports 7001–7004. Stop anything else on the PC that uses them first.

**Without the board:**

```sh
python3 -m hutd_ml.fakeboard &        # listens on 127.0.0.2
python3 -m hutd_ml.board --golden artifacts/v3/golden/g1 --board 127.0.0.2 --local 127.0.0.1 --pps 200
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
| A6 | **Replaced by R7 option C** (FPGA spec question 70, Sun 02:10). One hold counter per facility counts consecutive records with ≥ 1 held field, saturating at 3. Above `hold_max` the held fields become missing → INVALID (`FIELD_LOST`), **without** a history reset. A field with no `last_valid` value also makes the record INVALID: no features or memory update, logits 0, rules 0, countdown `0xFFFF`, `since_reset` not incremented, persistence counters cleared. Range/enum failures count as absent (reason bits 3 / 4). The legacy A6 rule (overflow → history reset) is still available as `Engine(hold_policy="A6")`, for comparison only. |
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

## RESULT semantics, exactly as `features_int.py` computes them

Lucas asked for this list so the RTL matches the code rather than spec text (FPGA spec questions 20–25). It
covers FPGA spec v4 plus those rulings. "Effective value" = the observed value if the field is OK, else its held
`last_valid` value.

### Order of checks for one DATA record

1. Any reserved field (`reserved0/1/2`) ≠ 0 → **DROPPED**, reason `FRAMING` only. This is checked before the
   facility lookup.
2. `fac_id ≥ 32`, or the slot is not enabled in CONFIG → **DROPPED**, reason `UNKNOWN_FAC` only.
3. Time step, with `d = ts − last_ts`:
   - no `last_ts` (the facility's first record) → history reset;
   - `d == 0` → **DROPPED** `DUPLICATE`;
   - `d < 300` (negative or a partial step) → **DROPPED** `OUT_OF_ORDER`;
   - `d` a multiple of 300 with 1–`hold` missing steps → `GAP_HELD`;
   - more missing steps, or not a multiple of 300 → history reset.

   After this step, `last_ts = ts` for every non-DROPPED record.
4. Fields (the 7 facility fields, plus status and water of slots `< n_wells`):
   - `present` bit clear → `FIELD_ABSENT`;
   - pump status ∉ {0,1,2} or well status ∉ {0,1} → `ILLEGAL_ENUM`;
   - outside `lo[j]..hi[j]` (j = present-bit index; j = 2 bounds the pump status) or `well_lo..well_hi` →
     `OUT_OF_RANGE`.

   A field that fails becomes **held** if it has a `last_valid`, otherwise **missing**.
5. `hold_run` = consecutive non-DROPPED records with ≥ 1 held field, **saturating at 3**. Records that end INVALID
   count too. **R7 option C** (FPGA spec question 70): `hold_run > hold` (`hold = min(HOLD_MAX, 2)`) → every held
   field becomes missing, so the record is INVALID with `FIELD_LOST`. There is **no history reset**: `last_valid`,
   memory, ring, `prev_level` and latches survive, and the next fully-OK record continues the same history.
6. Every OK field updates its `last_valid`, also on records that end INVALID.
7. Any missing field → **INVALID**. Otherwise **HELD** if `FIELD_HELD` or `GAP_HELD` is set, else **VALID**.

A **history reset** clears `last_valid`, `hold_run`, `since_reset`, `prev_level`, the memory features, the countdown
ring, the persistence counters and the gap counter. It never clears the alarm conditions or latches.

### Reason bits

| Bit | Name | Set when | Statuses it can appear with |
| --- | --- | --- | --- |
| 0 | `FIELD_HELD` | ≥ 1 field was replaced by its `last_valid` value, and no hold-overflow reset happened on this record | VALID never; HELD; INVALID (another field missing) |
| 1 | `GAP_HELD` | 1–`hold` 5-minute steps were skipped | HELD, INVALID |
| 2 | `HIST_RESET` | history reset on this record: first record of the facility, or a time gap above `hold` (or not a multiple of 300 s). **Not** on a hold overflow (R7 C). | VALID, HELD, INVALID |
| 3 | `OUT_OF_RANGE` | ≥ 1 present field outside its bounds | VALID never; HELD, INVALID |
| 4 | `ILLEGAL_ENUM` | ≥ 1 present pump or well status with an illegal code | HELD, INVALID |
| 5 | `FEAT_SAT` | any of the 10 multiplied channels (0–6, 9, 10, 11) saturated to int16 | VALID, HELD |
| 6 | `PUMP_INCONS` | effective pump status ≠ 1 **and** effective pump flow > 0 (raw) | **VALID, HELD only** (0 on INVALID) |
| 7 | `WELL_INCONS` | some configured slot with effective status 0 **and** effective water > 0 | **VALID, HELD only** (0 on INVALID) |
| 8 | `DUPLICATE` | `d == 0` | DROPPED (only bit) |
| 9 | `OUT_OF_ORDER` | `d < 300` | DROPPED (only bit) |
| 10 | `UNKNOWN_FAC` | `fac_id ≥ 32` or the slot is disabled | DROPPED (only bit) |
| 11 | `FIELD_ABSENT` | ≥ 1 required field had its `present` bit clear | HELD, INVALID |
| 12 | `FRAMING` | a reserved field ≠ 0 | DROPPED (only bit) |
| 13 | `NO_MODEL` | the active weights version is 0 | VALID, HELD |
| 14 | `FIELD_LOST` | ≥ 1 required field had no value to use (failed with no `last_valid`, or held fields turned missing by a hold overflow, R7 C) | INVALID (always) |
| 15–31 | — | never | — |

Bits 0, 3, 4 and 11 are ORed over all required fields. Several of them, plus bits 1 and 2, can appear together.

### RESULT fields per status

| Field | VALID / HELD | INVALID | DROPPED |
| --- | --- | --- | --- |
| `fac_id`, `ts_unix` | echo | echo | echo (raw `fac_id`, even ≥ 32) |
| `since_reset` | value **before** this record (0 on a reset record), then +1 (the RESULT field saturates at 255) | current value, not incremented (0 if this record reset) | 0 |
| `logits` | the 4 heads; 0 if no model | 0 | 0 |
| `rules` | bit 0 pump status = 2; bit 1 every configured slot status 0 **and** water 0; bit 2 level ≥ shutdown; bit 3 level ≥ warning; bit 4 not filling (below) | 0 | 0 |
| `countdown` p10 / p50 / p90 | level ≥ shutdown → 0 / 0 / 0; else `m(max)`, `m(mean)`, `m(min)` with `m(q) = q ≤ 0 ? 0xFFFF : min((K_CD·Δ) // (q << 8), 0xFFFF)` | `0xFFFF` × 3 | `0xFFFF` × 3 |
| `weights_ver` | active version | active version | 0 |
| `result_no` | +1 for every record, DROPPED included, from 0 at engine start | same | same |

**Countdown ring:** 16 entries of `max(effective inflow, 0)`. It is filled with the first VALID/HELD value after a
reset and shifted on each later VALID/HELD record, with `mean = sum >> 4`. Not filling = `mean ≤ 0`, but forced to 0
when level ≥ shutdown.

**Alarms:** VALID/HELD only.

- `hit[k] = logit[k] > logit_thr[k]` (strict); `cnt[k]` counts consecutive hits; `class_active[k] = cnt[k] ≥ K[k]`.
- `gap_run` counts records with channel 3 > `gap_thr` **and** `logit[0] > logit_thr[0]`.
- `ns_c` = rules bits 0–3 or any class active; `es_c = gap_run ≥ K[0]`.
- INVALID clears `cnt` and `gap_run`, and leaves the conditions, latches and ALERTs alone.
- ALERT rules: A19 above.

## Current model (v3, deployed)

**Full design, recipe and the experiments behind it:** [`docs/plan/mudit/ml_architecture.md`](../docs/plan/mudit/ml_architecture.md).

| Item | v3 |
| --- | --- |
| Recipe | practice week + augmented copies; **observable labels** (leak/degradation positives before the pump first runs in the event get weight 0); C = 3 for leak and degradation, 0.03 for failure and shut-in |
| GLOBAL | `persist_K4` [1, 3, 1, 1], `logit_thr` [−64, 0, 0, 0] (1/256), `gap_thr` 504, S 17 |
| Blob | 980 B, CRC32 `0xA8E1639F`, Fw 8, S_out 14 |

Out-of-fold results, holding out one system at a time, with integer logits:

| Head | Precision / recall | Events caught | Median / worst delay | False alerts per facility-day |
| --- | --- | --- | --- | --- |
| Leak | 0.95 / 0.99 | 5/5 | 5 / 60 min | 0.019 |
| Degradation | 0.95 / 0.90 | 5/5 | 155 / 180 min | 0.038 |
| Failure | 1.00 / 1.00 | 13/13 | 0 | 0 |
| Shut-in | 1.00 / 1.00 | — | — | 0 |

- E-STOP fires on 5/5 leaks and never outside one.
- Under healthy pressure offsets ×1.3, false alerts are 0.05 / 0.11 per facility-day (v2: 0.08 / 0.27).
- G0 / G1 / G2 plus all 100 alerts are byte-identical over UDP against the stand-in.

**Why degradation is slower than leak:**

- Three of the five degradation events start while the pump is off; it first runs 105–145 min after onset. Before
  that there is nothing to measure.
- When the pump does run, flow is still within healthy noise: 0.990–1.002 of normal, against a healthy 1st–99th
  percentile of 0.987–1.013.
- Events last 24–36 h, and three end in a pump failure, so detection about 2.5–3 h in is about 30 h before those
  failures.

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
