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

## Quick start

```sh
DATA=/path/to/HackUTD-ZeroDay/history/full_week
HUTD_DATA=$DATA python3 -m pytest -q tests                      # 10 tests, ~6 s
python3 -m hutd_ml.train --data $DATA --answer-key $DATA/answer_key.json --out artifacts/v1 --version 1 \
    --mock $DATA/../mock_test_2026-10-10T1530                     # ~3 min
python3 -m hutd_ml.golden --data $DATA --out artifacts/v1/golden/g1 --set g1 \
    --weights artifacts/v1/weights.bin --weights-version 1 --config artifacts/v1/global_config.json
```

## For Lucas: what to use

**Committed artifacts:**

| Folder | Weights | Contents |
| --- | --- | --- |
| `artifacts/v0/golden/g0`, `g2` | Untrained pseudo-random int16 (`weights_ver` **240**): full range, both signs, saturating logits | Bring-up of the head/accumulator/saturation path |
| `artifacts/v1/golden/g0`, `g1`, `g2` | **Trained v1** (`weights_ver` 1) + trained GLOBAL CONFIG (thresholds, K, `gap_thr`) | The real thing |
| `artifacts/v1/` | `weights.bin` (980 B blob), `weights.json`, `global_config.json`, `report.md` | Model + validation report |

**The golden sets:**

- **G0:** 30 records, one facility (`fac_id` 0), across a pump start. Cold start, small enough to check by hand.
- **G1:** the whole practice week, 30,240 records, timestep-major.
- **G2:** 29 synthetic edge cases:
  - duplicate, out-of-order;
  - a 1-step gap (HELD), a 3-step gap (reset);
  - inflow absent ×3 (HELD, HELD, reset → INVALID);
  - illegal pump enum, level out of range, illegal well status (→ reset), inflow above `hi`;
  - disabled slot 31, `fac_id` 40.

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
python3 -m hutd_ml.board --golden artifacts/v1/golden/g0                      # then g2, then g1
python3 -m hutd_ml.board --golden artifacts/v1/golden/g0 --heartbeat-test 6   # AUTONOMOUS + replay
```

The harness binds local UDP ports 7001–7004. Stop anything else on the PC that uses them first.

**Without the board:**

```sh
python3 -m hutd_ml.fakeboard &        # listens on 127.0.0.2
python3 -m hutd_ml.board --golden artifacts/v1/golden/g1 --board 127.0.0.2 --local 127.0.0.1 --pps 200
```

Verified Sat 23:05 CST: G0, G2 and G1 (30,240/30,240 RESULTs) byte-identical over UDP, plus a 6 s heartbeat gap
replayed correctly. The Python stand-in needs `--pps` ≤ about 200; the real board shouldn't.

## Assumptions where the FPGA plan is silent

These are implemented in `features_int.py` / `encode.py` / `board.py`. Each one must match the RTL: if Lucas
decides differently, change the code here and regenerate the golden sets.

| # | Assumption |
| --- | --- |
| A1 | Hard-wired channels 4–6 use `round(16384/10000·2^S)`, `round(16384/1500·2^S)`, `round(16384/500·2^S)` with the same `S_feat`, applied to level (0.01 %), discharge − P0 (0.1 psi) and pipeline − P0 (0.1 psi) |
| A2 | Channels 7 / 8 (`pump_running`, `pump_fault`) are 16384 or 0 |
| A3 | `(raw·M + 2^(S−1)) >> S` with an arithmetic shift (round half up, negatives included); `S_feat` = 11 (review R3: every M < 2^24) |
| A4 | Timestamp step: Δ = 0 → DROPPED duplicate; 0 < Δ < 300 or Δ < 0 → DROPPED out-of-order; Δ = 600/900 → HELD with reason bit 1; Δ ≥ 1200 or not a multiple of 300 → history reset. Channel 11 uses the level change since the last accepted record (not divided over the gap). Memory features are **post-update**: record t includes its own update. |
| A5 | Feature 27's average starts at `x << 8` on the first record after a reset |
| A6 | One hold counter per facility counts consecutive records with ≥ 1 held field. Above `hold_max` the history resets, which also clears the last-valid values. A field with no last-valid value makes the record **INVALID**: no features or memory update, logits 0, rules 0, countdown `0xFFFF`, `since_reset` not incremented, persistence counters cleared. Range/enum failures count as absent (reason bits 3 / 4). |
| A7 | `since_reset` = VALID/HELD records since the reset (0 on the first). The steps-since-run counter starts at 0 at a reset. Feature 30 uses `since_reset` before its increment. |
| A8 | Countdown ring starts filled with the first value after a reset; mean = sum >> `cd_log2`; p10 = max, p50 = mean, p90 = min; "not filling" = mean ≤ 0. `plan_v1` rings `inflow − pump flow`. Option `review_r1r2` rings inflow only and reports 0 for a tripped tank (review R1 / R2). |
| A9 | `K_cd = round(0.288·C·256)`; `minutes = (K_cd·Δlevel_raw) // (net_raw << 8)`; ≥ `0xFFFF` → `0xFFFF` |
| A10 | Model alarm: logit **>** `logit_thr` for K consecutive VALID/HELD records; INVALID clears the counters, DROPPED doesn't touch them |
| A11 | E-STOP: channel 3 > `gap_thr` **and** leak logit > its threshold for K consecutive records; latched (acknowledge not modelled) |
| A12 | Night Shift rule flags = `pump_fault`, `shut_in`, level ≥ shutdown, level ≥ warning. **Not "not filling"**, which is true whenever the pump runs. |
| A13 | A non-zero reserved field in DATA → INVALID, reason 0 |
| A14 | CONFIG `lo[]` / `hi[]` follow `present`-bit order (inflow, level, pump_status, pump_flow, discharge, receive_flow, pipeline). Bounds come from metadata, never from observed data: flows −5 % Q … 4 × max(Q, B); psi 0 … pipeline `max_pressure_psi`; level −5 … 105 %; wells −5 % … 4 × max baseline. |
| A15 | Encoder rounding is `floor(v·scale + 0.5)` |
| A16 | WEIGHTS: data chunks ≤ 1,024 B, each ACKed. COMMIT is a chunk with offset = blob length, length 0, flags 1, followed by u32 total length and u32 CRC32 (zlib / IEEE). |
| A17 | `result_no` counts from 0 at engine start; DROPPED records also get one |
| A18 | Weight blob layout: `docs/plan/mudit/ml_plan.md` §4.8 (also documented in `model_int.py`) |
| A19 | ALERT: Night Shift raised / cleared on condition edges (not latched); E-STOP raised once (latched) |

## Current model (v1)

See `artifacts/v1/report.md`. Out-of-fold, holding out one system at a time, with integer logits and wire-v1
settings (one K = 1):

| Head | Precision / recall | Events caught | Median delay after onset |
| --- | --- | --- | --- |
| Leak | 0.94 / 0.99 | 5/5 | 5 min |
| Degradation | 0.95 / 0.83 | 5/5 | 190 min |
| Failure | 1.00 / 1.00 | 13/13 | 0 |
| Shut-in | 1.00 / 1.00 | — | — |

- E-STOP fires on 5/5 leaks and never outside a leak.
- int16 vs float decisions agree 100%.
- The thresholds were picked on the same out-of-fold scores, so these numbers are optimistic on one practice week.
- Failure and shut-in are signalled directly by pump status 2 / all wells off.
