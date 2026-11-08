# model/ — bit-exact Python reference (task T0.2; spec v4 rework = T0.2b)

The golden model every RTL module is simulated against. It implements `spec/numerics.md` literally: integers only,
`>>`/`//` on non-negative values, explicit floor semantics for `>>>` (Python `>>` on negative ints already floors).

**Spec v4:** the normative integer reference is now Mudit's `ml/hutd_ml/features_int.py` (branch `ml`) with the
changes in `spec/numerics.md` §11 (his task T0.0). `eog_ref.py` stays (it produces the per-stage bus vectors his
code does not), but it must be updated to spec v4 and must agree with his engine **byte for byte** on every
RESULT and ALERT. `check_mudit.py` enforces that; a disagreement is a spec question, not a choice.

## Deliverables

| File | Contents |
| --- | --- |
| `eog_ref.py` | `class Engine`: `configure(glb: bytes, rows: dict[int, bytes])`, `load_weights(image: list[int])`, `swap()`, `push(record: bytes) -> dict` (one RESULT dict + any ALERT dicts). Internally one function per stage (`validate`, `features`, `memory`, `countdown`, `head`, `alarm`, `pack`) that returns that stage's **output bus as an int** laid out per `spec/gen/buses.py`, so per-module vectors come for free |
| `ingest.py` | Reference ingest: dataset folder (`network.json`, `ops.json`, `telemetry.csv`) → GLOBAL record, CONFIG rows (numerics.md §10, with the range checks) and 48 B DATA records in timestep-major order. The team's real ingest should match it byte for byte |
| `gen_vectors.py` | Writes `tb/vectors/<module>_<case>.{in,out}.hex` plus `<case>.cfg.hex` and `<case>.wts.hex` (format below) |
| `cases.py` | Synthetic bad-data cases: absent fields, illegal enums, out of range, gaps of 1/2/3 steps, duplicates, out of order, framing errors, unknown/disabled slots, CONFIG touch mid-stream, weight swap mid-stream, saturation |
| `check_mudit.py` | **New in v4.** Runs Mudit's `Engine` (`git worktree add ../ml origin/ml`, `PYTHONPATH=../ml/ml`) and `eog_ref.Engine` on the same GLOBAL/CONFIG/weights/DATA (full practice week, every `cases.py` case, his golden sets G0/G1/G2 `data.bin` → `expected_results.bin`) and compares the RESULT and ALERT bytes. Also asserts his code has the §11 changes (S = 17, `review_r1r2`, latched Night Shift, FRAMING, `persist_K4`) and fails loudly until T0.0 lands. Acknowledge, heartbeat and mid-stream swap events are FPGA-only and are skipped in the comparison |
| `test_model.py` | Self-checks: layouts round-trip, the R1 check (p50 near `trips_at` at all 13 practice failure onsets, offline use of the answer key only), invariants (averages within input range, p10 ≤ p50 ≤ p90) |

Data: the practice dataset is not in this repo. Clone https://github.com/nihaal419/HackUTD-ZeroDay next to this repo
(or set `EOG_DATA=/path/to/HackUTD-ZeroDay`) and use `history/full_week/`. `answer_key.json` may be read **only** by
`test_model.py` for offline checks (global_plan hard rule 1).

Weights for vectors: Mudit's trained blob (`ml/artifacts/<ver>/`, layout in `model_int.py`); the FPGA image is its
bytes 0–279 as 70 little-endian words plus word 70 = version (spec v4, D11). Keep the seeded pseudo-random set for
saturation cases.

## Vector file format (`tb/vectors/`)

- One line per record, the bus as one hexadecimal number, most significant digit first, zero-padded to
  `ceil(W/4)` digits (`$readmemh`-compatible). `.in.hex` = the stage's input bus, `.out.hex` = its expected output
  bus, same line count, same order.
- `<case>.cfg.hex`: line 0 = GLOBAL (256 bits), lines 1..32 = CONFIG rows of slots 0..31 (512 bits each).
- `<case>.wts.hex`: 71 lines of 32-bit words (the weight window, spec v4), active bank at the start of the case;
  `<case>.events.txt` lists mid-stream events (`<record_index> swap` / `<record_index> touch <slot>` /
  `<record_index> cfg <slot> <hex row>`).
- `top_<case>.in.hex` holds 48 B DATA records (384 bits); `top_<case>.out.hex` the 32 B RESULT records (256 bits).
  For Mudit's golden sets these equal his `data.bin` / `expected_results.bin`.
