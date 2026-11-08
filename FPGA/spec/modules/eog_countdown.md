# eog_countdown — minutes to tank shutdown (p10 / p50 / p90)

Implements numerics.md §7 (D1, D2, D4, D6).

## Parameters

`N_FAC` (32), `II` (16). Ring depth fixed at 16 (`EOG_CD_N`); formal may set `CD_LOG2 = 2`.

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | |
| `in_valid`, `in_ready`, `in_data` | | `EOG_BM_W` | bus M |
| `out_valid`, `out_ready`, `out_data` | | `EOG_BC_W` | bus C |
| `cfg_fac` | out | 5 | |
| `cfg_row` | in | 512 | uses `SHUT_LVL`, `K_CD` |

Uses one `eog_mul` (`K · Δ`, 24 × 17 bits) and `eog_div` (`NW = 48`, `DW = 32`) for the three quotients.

## Per-facility state

16 × s16 ring (prefilled), a "has ring" bit, a write pointer. `sum`/`max`/`min` may be recomputed per record (16
entries within II) or kept incrementally.

## Behavior

Header copied; `FEAT` copied; `RULES = {NOT_FILLING, RULES4}`; `CD = {p90, p50, p10}` (p10 in `[15:0]`).
A non-DROPPED `HIST_RESET` record clears the "has ring" bit first. VALID/HELD: fill-or-push, then numerics.md §7.

## Required properties (verifier)

Stage contract (conventions §3).

- C1 INVALID/DROPPED → `CD = 3 × 0xFFFF`, `NOT_FILLING = 0`, no ring change (INVALID may only clear via `HIST_RESET`).
- C2 `LEVEL ≥ SHUT_LVL` → `CD = 0` (all three); `NOT_FILLING = 0` (ruling #21).
- C3 First VALID/HELD record after a reset: all ring entries equal its `INFLOW` (so p10 = p50 = p90).
- C4 Ring contents: after the first fill, the ring holds the last 16 VALID/HELD `max(INFLOW, 0)` values (ruling #20) (shadow model for
  one anyconst slot with `CD_LOG2 = 2`).
- C5 `q ≤ 0` → that value is `0xFFFF`; `p10 ≤ p50 ≤ p90` whenever all three are finite and level is below shutdown.
- C6 With the real divider in bmc at reduced widths, each value equals `m(q)` from numerics.md §7.
- C7 Slot independence.

Simulation: bit-exact against `tb/vectors/countdown_*.hex` from Mudit's golden sets regenerated with
`review_r1r2` (all 13 practice failure onsets: p50 must track `trips_at`).

Cover: tripped, not filling, finite, and a ring that has wrapped.
