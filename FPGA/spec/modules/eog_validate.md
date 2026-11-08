# eog_validate — framing, facility, time and field checks; hold/reset

Implements numerics.md §3 (= `features_int.py` `Engine.process` steps S1, with the v4 changes). This stage decides
every record's `STATUS`.

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
| `fac_touch` | in | N_FAC | 1-cycle pulse per slot: its CONFIG row was written; its next record starts a new history (flagged) |

## Per-facility state

`has_ts`, `pending_reset` (flip-flop vectors, one bit per slot); in RAM: `last_ts` (32), `since_reset` (8),
`hold_run` (2–3 bits), per required field its `last_valid` value and a "has value" bit, `prev_level` (16) and a
"has prev" bit. About 50 B per slot.

## Behavior

numerics.md §3 steps 1–10. Bus V:

- header: `REC_NO`, `IN_LAST` copied; `FAC_RAW = FAC_ID`; `FAC = FAC_ID[4:0]`; `TS`; `STATUS`; `REASON`;
  `SINCE_RESET`; `HIST_RESET`.
- `INFLOW`, `LEVEL`, `PUMP_FLOW`, `RECV_FLOW`, `DIS_PSI`, `PIPE_PSI`, `PUMP_ST`: the OK or held value (VALID/HELD);
  for INVALID: the OK value where available, else 0. `FLD_OK[j]` per facility field j (present-bit order) and
  `WELLS_OK` say which values are usable (diagnostic; later stages use VALID/HELD only).
- `WELL_ACT`, `WELL_WATER`, `PREV_LEVEL`, `PREV_OK` per numerics.md §3.
- `fac_touch[f]` (or reset) sets `pending_reset[f]`, clears `has_ts[f]`. With `pending_reset[f]`, f's next
  non-DROPPED record is treated as after a history reset and carries `HIST_RESET = 1` and reason bit 2.

## Required properties (verifier)

Stage contract (conventions §3): handshake, one in → one out in order (`REC_NO`), II ≤ 16, latency ≤ 128.

- V1 `FRAME_ERR` or a nonzero reserved field → DROPPED with `FRAMING`, `SINCE_RESET = 0`; no slot's state changes.
- V2 `FAC_ID ≥ N_FAC` or slot disabled → DROPPED `UNKNOWN_FAC`, `SINCE_RESET = 0`; no state changes.
- V3 `TS == last_ts` → DROPPED `DUPLICATE`; `TS − last_ts < 300` (signed) → DROPPED `OUT_OF_ORDER`; both carry
  the slot's current `SINCE_RESET`; no state changes.
- V4 DROPPED never has `HIST_RESET = 1`.
- V5 Gap: `d ∈ {600, 900}` with `d/300 − 1 ≤ HOLD_MAX` → `GAP_HELD`, no reset; `d > 300` otherwise → `HIST_RESET`.
- V6 Hold bound: `hold_run` never exceeds `HOLD_MAX` on a VALID/HELD output; a record whose held-field run would
  exceed it has `HIST_RESET = 1` and status INVALID (harness counter for one anyconst slot).
- V7 `STATUS == INVALID` iff some required field is neither OK nor held (after step 5).
- V8 `SINCE_RESET` of a slot's consecutive non-DROPPED records: +1 after each VALID/HELD (saturating at 255), unchanged
  after INVALID, 0 on a `HIST_RESET` record.
- V9 `PREV_OK = 0` on the first VALID/HELD record after a reset; otherwise `PREV_LEVEL` = the previous VALID/HELD
  record's `LEVEL` for that slot (shadow register, anyconst slot).
- V10 `WELL_ACT[i] = 0` and `WELL_WATER[i] = 0` for `i ≥ n_wells`.
- V11 `last_ts` advances on VALID/HELD/INVALID records only.
- V12 Slot independence: records of slot A never change any later output for slot B.

Simulation: bit-exact against Mudit's golden G2 (29 edge cases) and G1 (full week), converted to bus V vectors by
`model/` (T0.2), plus extra cases: CONFIG touch mid-stream, framing errors, hold limit 0/1/2.

Cover: HELD; gap-held; INVALID; a hold-overflow reset; each DROPPED reason.
