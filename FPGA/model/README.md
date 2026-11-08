# model/ — bit-exact Python reference (task T0.2; spec v4 rework = T0.2b)

The golden model every RTL module is simulated against. It implements `spec/numerics.md` literally: integers only,
`>>`/`//` on non-negative values, explicit floor semantics for `>>>` (Python `>>` on negative ints already floors).

**Spec v4:** the normative integer reference is Mudit's `ml/hutd_ml/features_int.py` (branch `ml`, ≥ 8e67750, which
has the `spec/numerics.md` §11 changes) plus Lucas's rulings on spec questions 20–25 in `TASKS.md` (they override the
numerics.md v4 text where it differs: countdown ring of `max(INFLOW, 0)`, `NOT_FILLING = 0` when tripped, ALERT
`SOURCE` per kind, reason bits 11/13/14 restored, `HIST_RESET` on a facility's first record, DROPPED RESULTs with
`SINCE_RESET = 0` and `WVER = 0`). `eog_ref.py` stays (it produces the per-stage bus vectors his code does not) and
agrees with his engine **byte for byte** on every RESULT and ALERT. `check_mudit.py` enforces that; a disagreement is
a spec question, not a choice.

**Spec question #70 (R7 option C, Lucas Sun 02:03, task T0.2c)** replaces numerics.md §3 step 5 ahead of Mudit's code
(his task T0.5): `hold_run = any field held ? min(hold_run + 1, 3) : 0`; if `hold_run > hold` every held field
becomes missing, so the record is INVALID with `FIELD_LOST`, with **no history reset and no `HIST_RESET`**
(`last_valid` kept, `since_reset` not incremented). History resets come only from time gaps, CONFIG writes and a
facility's first record. Spec question #71 (proposed, as the validate RTL does it): on a hold-limit record
`FIELD_HELD` = 0 (the held fields became missing), `SINCE_RESET` is the current value, `HIST_RESET` = 0,
`PREV_LEVEL`/`PREV_OK` are unchanged, and a field that is OK on it still updates `last_valid`. Until T0.5 lands, `check_mudit.py` runs his engine with a stand-in for that one rule and
lists every record it touches as a pre-T0.5 GAP (exit 2); everything else must still agree byte for byte.

## Deliverables

| File | Contents |
| --- | --- |
| `eog_ref.py` | `class Engine`: `configure(glb: bytes, rows: dict[int, bytes])`, `load_weights(image: list[int])` (71-word window), `swap()`, `push(record: bytes) -> dict` (`result_bytes`, `result`, `alerts`, `alert_dicts`, buses). Internally one function per stage (`validate`, `features`, `memory`, `countdown`, `head`, `alarm`, `pack`) that returns that stage's **output bus as an int** laid out per `spec/gen/buses.py`, so per-module vectors come for free. `encode_weights`, `window_from_blob`, `decode_weights` handle the weight window (Mudit's blob bytes 0–279 + version word) |
| `ingest.py` | Reference ingest: dataset folder (`network.json`, `ops.json`, `telemetry.csv`) → GLOBAL record, CONFIG rows (numerics.md §10, with the range checks) and 48 B DATA records in timestep-major order. Mirrors Mudit's `encode.py` at S = 17 (float64 formulas, `floor(v·scale + 0.5)`, metadata LO/HI in present-bit order); `check_mudit.py` proves the CONFIG rows, GLOBAL and the practice-week DATA are byte-identical to his |
| `gen_vectors.py` | Writes `tb/vectors/<module>_<case>.*` (format below) and `INDEX.txt` |
| `cases.py` | Synthetic bad-data cases (absent fields, illegal enums, out of range incl. the pump-status bound, hold runs and the hold limit (`hold_h0/1/2`, #70), gaps of 1/2/3 steps, duplicates, out of order, framing errors, unknown/disabled slots, CONFIG touch mid-stream, weight swaps, saturation, latches/acks, fuzz), practice-data cases, and **golden cases** replaying Mudit's golden sets: `g0`, `g1`, `g2` (trained v2 weights), `g0v0`, `g2v0` (pseudo-random v0 weights), `g0v3`, `g2v3` (release-candidate v3 weights) |
| `check_mudit.py` | Runs Mudit's `Engine` and `eog_ref.Engine` on the same GLOBAL/CONFIG/weights/DATA (every `cases.py` case, the practice week, every golden set) and compares the RESULT and ALERT bytes; checks `eog_ref` reproduces each golden set's `expected_results.bin` / `expected_alerts.json`; probes the §11 changes (S = 17, `review_r1r2`, latched Night Shift / E-STOP, FRAMING, `persist_K4`, regenerated goldens); checks the ingest against `encode.py`. Acknowledge, heartbeat, CONFIG touch/rewrite and mid-stream weight events, records cut short by TLAST and AUTONOMOUS are FPGA-only and are left out of the engine comparison (for both engines). Exit 0 = all agree, 1 = a disagreement, 2 = only §11 checks fail |
| `test_model.py` | Self-checks (no Mudit code needed): layouts, arithmetic, weight window layout, ingest, directed v4 semantics, the R1 check (p50 near `trips_at` at all 13 practice failure onsets, offline use of the answer key only), invariants (stage contract, DROPPED/INVALID rules, averages within input range, p10 ≤ p50 ≤ p90), vectors up to date |

```sh
export EOG_DATA=/path/to/HackUTD-ZeroDay          # practice data
export EOG_ML=/path/to/ml-checkout/ml              # optional: found automatically at ../ml/ml (git worktree add ../ml origin/ml)
python FPGA/model/test_model.py                    # ~30 s
python FPGA/model/gen_vectors.py                   # ~15 s; --no-large skips the git-ignored *_week / *_g1 files
python FPGA/model/check_mudit.py                   # ~2 min (needs numpy); --no-week skips the 30,240-record runs
```

Data: the practice dataset is not in this repo. Clone https://github.com/nihaal419/HackUTD-ZeroDay next to this repo
(or set `EOG_DATA=/path/to/HackUTD-ZeroDay`) and use `history/full_week/`. `answer_key.json` may be read **only** by
`test_model.py` for offline checks (global_plan hard rule 1). The golden cases read Mudit's committed artifacts
(`ml/artifacts/v0|v2/golden/*`); `gen_vectors.py --no-golden` skips them.

Weights for vectors: Mudit's blobs for the golden cases (the window is the blob's bytes 0–279 as 70 little-endian
words plus word 70 = version, D11); hand-made (`cases.w_hand`, fires each class on the practice data), seeded
pseudo-random and constant sets for the synthetic cases (S_OUT 0..31, VER 0).

## Model readings the spec leaves open (`MODEL-Q<n>` in the code)

| # | Reading |
| --- | --- |
| Q5 | `LEDOVR` stores all 32 bits (vectors use only the defined ones) |
| Q7 | Time step `d = TS − last_ts` is the exact difference of two u32 (33-bit signed), as `features_int.py`; no 32-bit wrap |
| Q8 | `DBGSEL` stores `[4:0]` only; the other bits read 0 |
| Q9 | Bus V of an INVALID record carries the OK values only (held fields → 0); `FLD_OK`/`WELLS_OK` = the fields that passed their checks. On VALID/HELD every carried value is usable, so `FLD_OK = 0x7F`, `WELLS_OK = 1`. Later stages never use these on INVALID records |

Also: a CONFIG write (`fac_touch`) clears the slot's `last_ts`, so its next non-DROPPED record is a first record
again (history reset, `HIST_RESET = 1`, TASKS #24). `N_WELLS` > 8 is clamped to 8 (TASKS #14); `N_WELLS = 0` means
no wells (`SHUT_IN` holds vacuously, as in `features_int.py`).

## Vector file format (`tb/vectors/`)

- One line per record, the bus as one hexadecimal number, most significant digit first, zero-padded to
  `ceil(W/4)` digits (`$readmemh`-compatible). `.in.hex` = the stage's input bus, `.out.hex` = its expected output
  bus, same line count, same order. `unpack_<case>.in.hex` holds beats `{s_last, s_data[63:0]}`;
  `pack_<case>.last.hex` the `m_last` bit of each result's 4th beat (BATCH = 45).
- `<module>_<case>.cfg.hex`: line 0 = GLOBAL (256 bits, as `eog_regs` presents it: byte 0 = 17, byte 2 = 4), lines
  1..32 = CONFIG rows of slots 0..31 (512 bits each).
- `<module>_<case>.wts.hex`: 71 lines of 32-bit words (the weight window), the active bank at the start of the case;
  `.wts<k>.hex` the image written by the k-th `wts` event.
- `<module>_<case>.events.txt`: mid-stream events the module sees, one per line `<record_index> <event> <arg> <hex>`
  (the event happens before record `<record_index>` is accepted): `touch <slot> 0`, `cfg <slot> <row hex>`,
  `wts <k> 0` (write `.wts<k>.hex` into the inactive bank), `swap 0 0`, `ack 0 0`, `hb 0 0`, `hb_expire 0 0`.
- `alarm_<case>.al.hex` / `top_<case>.al.hex`: the ALERT records (128 bits) in push order; `.al.txt` adds the record
  index and the cause (`rec`, or `ack` for an ACKED sweep before that record).
- `top_<case>.in.hex` holds 48 B DATA records (384 bits); `top_<case>.out.hex` the 32 B RESULT records (256 bits).
  For the golden cases `top_<case>.in.hex` equals Mudit's `data.bin` and `top_<case>.out.hex` his
  `expected_results.bin`, except that his sets predate #70 (R7): `g2`, `g2v0`, `g2v3` differ from their first
  hold-limit record (record 14) on until his T0.5 regenerates them; `g0*` and `g1` have no hold-limit record.
- Per-module files of `week` and `g1` (30,240 records each) are git-ignored; `top_week.*`, `top_g1.*` are committed.
