# eog_validate — framing, facility, time and field checks; hold/reset

Implements numerics.md §3 exactly. This is the stage that decides every record's `STATUS`.

## Parameters

`N_FAC` (32), `N_WELL` (8), `II` (16).

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | |
| `in_valid`, `in_ready`, `in_data` | | `EOG_BU_W` | bus U |
| `out_valid`, `out_ready`, `out_data` | | `EOG_BV_W` | bus V |
| `cfg_fac` | out | 5 | slot whose CONFIG row is read |
| `cfg_row` | in | 512 | that row, combinational (conventions §5) |
| `glb` | in | 256 | GLOBAL CONFIG (uses `HOLD_MAX`) |
| `fac_touch` | in | N_FAC | 1-cycle pulse per slot: its CONFIG row was written; the slot's next record starts a new history |

## Per-facility state

`has_ts`, `pending_reset` (one bit per slot, flip-flop vectors, so reset and `fac_touch` act in one cycle);
in RAM: `last_ts` (32), `since_reset` (8), per required field its last value, a "has value" bit and a 2-bit miss
counter, and `prev_level` (16). About 60 B per slot.

## Behavior

numerics.md §3, steps 1–9, for each accepted record. Bus V fields:

- header: `REC_NO`, `IN_LAST` copied; `FAC_RAW = FAC_ID`; `FAC = FAC_ID[4:0]`; `TS`; `STATUS`; `REASON`;
  `SINCE_RESET`; `HIST_RESET`.
- `INFLOW`, `LEVEL`, `PUMP_FLOW`, `RECV_FLOW`, `DIS_PSI`, `PIPE_PSI`: the observed or held value, 0 if lost.
- `PUMP_ST`: 2 bits, observed or held, 0 if lost. `FLD_OK[j]` per facility field j in DATA `PRESENT` bit order.
- `WELL_ACT`, `WELL_WATER`, `WELLS_OK`, `PREV_LEVEL`, `PREV_OK` as in numerics.md §3.

`fac_touch[f]` and reset set `pending_reset[f] = 1` and `has_ts[f] = 0`. A `fac_touch` arriving while slot f's
record is in flight takes effect for f's next record.

## Required properties (verifier)

Stage contract (conventions §3): handshake, one in → one out in order (`REC_NO` sequence), II ≤ 16, latency ≤ 128.

Status logic (prove with N_FAC = 2, small widths where allowed):

- V1 `FRAME_ERR` or a nonzero reserved field → DROPPED with `FRAMING`; no state of any slot changes.
- V2 `FAC_ID ≥ N_FAC` or slot disabled → DROPPED with `UNKNOWN_FAC`; no state changes.
- V3 Duplicate (`TS == last_ts`) → DROPPED `DUPLICATE`; older `TS` → DROPPED `OUT_OF_ORDER`; no state changes.
- V4 A DROPPED record never has `HIST_RESET = 1`, and it outputs `SINCE_RESET = 0`.
- V5 The first accepted (non-DROPPED) record of a slot after reset or `fac_touch` has `HIST_RESET = 1` and
  `SINCE_RESET = 0`.
- V6 Hold bound: no field is held on more than `min(HOLD_MAX, 2)` consecutive accepted records of its slot
  (track one anyconst slot and field with a harness counter).
- V7 Gap: `TS − last_ts ∈ {600, 900}` within the hold limit → `GAP_HELD` and status ≥ HELD and not a new history;
  outside it, or any other difference ≠ 300 → `HIST_RESET`.
- V8 Status priority: `STATUS == INVALID` iff some required field is lost; `FLD_OK`/`WELLS_OK` match.
- V9 After an INVALID record of slot f, f's next accepted non-DROPPED record has `HIST_RESET = 1`.
- V10 `SINCE_RESET` of consecutive accepted records of one slot increases by exactly 1 (saturating at 255)
  unless `HIST_RESET`.
- V11 `WELL_ACT[i] = 0` and `WELL_WATER[i] = 0` for `i ≥ n_wells`.
- V12 `PREV_OK = 0` on `HIST_RESET`; otherwise `PREV_LEVEL` equals the `LEVEL` output of the previous VALID/HELD
  record of the same slot (harness shadow register for one anyconst slot).
- V13 Independence: records of slot A never change any output for slot B (two-slot harness, compare against a
  copy that receives only B's records — or prove via the per-slot shadow model).

Simulation: bit-exact against `tb/vectors/validate_*.hex` from `model/` (practice week + synthetic bad-data
cases: absent fields, illegal enums, out of range, gaps of 1/2/3 steps, duplicates, out of order, framing errors,
unknown/disabled slots, CONFIG touch mid-stream).

Cover: a HELD record; a gap-held record; an INVALID followed by a new history; each DROPPED reason.
