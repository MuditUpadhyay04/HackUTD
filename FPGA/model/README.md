# model/ — bit-exact Python reference (task T0.2)

The golden model every RTL module is simulated against. It implements `spec/numerics.md` literally: integers only,
`>>`/`//` on non-negative values, explicit floor semantics for `>>>` (Python `>>` on negative ints already floors).

## Deliverables

| File | Contents |
| --- | --- |
| `eog_ref.py` | `class Engine`: `configure(glb: bytes, rows: dict[int, bytes])`, `load_weights(image: list[int])`, `swap()`, `push(record: bytes) -> dict` (one RESULT dict + any ALERT dicts). Internally one function per stage (`validate`, `features`, `memory`, `countdown`, `head`, `alarm`, `pack`) that returns that stage's **output bus as an int** laid out per `spec/gen/buses.py`, so per-module vectors come for free |
| `ingest.py` | Reference ingest: dataset folder (`network.json`, `ops.json`, `telemetry.csv`) → GLOBAL record, CONFIG rows (numerics.md §10, with the range checks) and 48 B DATA records in timestep-major order. The team's real ingest should match it byte for byte |
| `gen_vectors.py` | Writes `tb/vectors/<module>_<case>.{in,out}.hex` plus `<case>.cfg.hex` and `<case>.wts.hex` (format below) |
| `cases.py` | Synthetic bad-data cases: absent fields, illegal enums, out of range, gaps of 1/2/3 steps, duplicates, out of order, framing errors, unknown/disabled slots, CONFIG touch mid-stream, weight swap mid-stream, saturation |
| `test_model.py` | Self-checks: layouts round-trip, the R1 check (p50 near `trips_at` at all 13 practice failure onsets, offline use of the answer key only), invariants (averages within input range, p10 ≤ p50 ≤ p90) |

Data: the practice dataset is not in this repo. Clone https://github.com/nihaal419/HackUTD-ZeroDay next to this repo
(or set `EOG_DATA=/path/to/HackUTD-ZeroDay`) and use `history/full_week/`. `answer_key.json` may be read **only** by
`test_model.py` for offline checks (global_plan hard rule 1).

Weights for vectors: until Mudit exports a trained set, use deterministic pseudo-random int16 weights (seeded) and
one hand-made set that fires each class on the practice data; replace with his export when it lands (C5–C7).

## Vector file format (`tb/vectors/`)

- One line per record, the bus as one hexadecimal number, most significant digit first, zero-padded to
  `ceil(W/4)` digits (`$readmemh`-compatible). `.in.hex` = the stage's input bus, `.out.hex` = its expected output
  bus, same line count, same order.
- `<case>.cfg.hex`: line 0 = GLOBAL (256 bits), lines 1..32 = CONFIG rows of slots 0..31 (512 bits each).
- `<case>.wts.hex`: 69 lines of 32-bit words (the weight image), active bank at the start of the case;
  `<case>.events.txt` lists mid-stream events (`<record_index> swap` / `<record_index> touch <slot>` /
  `<record_index> cfg <slot> <hex row>`).
- `top_<case>.in.hex` holds 48 B DATA records (384 bits); `top_<case>.out.hex` the 32 B RESULT records (256 bits).
