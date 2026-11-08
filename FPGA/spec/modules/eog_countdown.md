# eog_countdown — minutes to tank shutdown (p10 / p50 / p90)

Implements numerics.md §7 (decisions D1, D2, D4, D5).

## Parameters

`N_FAC` (32), `II` (16), `CD_N` (16, ring depth; formal may use 4).

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | |
| `in_valid`, `in_ready`, `in_data` | | `EOG_BM_W` | bus M |
| `out_valid`, `out_ready`, `out_data` | | `EOG_BC_W` | bus C |
| `cfg_fac` | out | 5 | |
| `cfg_row` | in | 512 | uses `SHUT_LVL`, `K_CD` |

Uses `eog_mul` for `K·Δ` and for `K·Δ·n` (`n` is not a power of two), and `eog_div` (`NW = 48`, `DW = 32`) for the
three quotients.

## Per-facility state

Ring of `CD_N` × u15 inflow values, a count `n` (0..CD_N) and a write pointer (or derive it). `sum`, `max`, `min` may
be recomputed from the ring each record (16 entries in ≤ 16 cycles) or kept incrementally.

## Behavior

Header copied; `FEAT` copied; `RULES = {NOT_FILLING, RULES4}`; `CD = {p90, p50, p10}` (p10 in `[15:0]`).

## Required properties (verifier)

Stage contract (conventions §3).

- C1 INVALID/DROPPED → `CD = 3 × 0xFFFF`, `NOT_FILLING = 0`, no state change.
- C2 `LEVEL ≥ SHUT_LVL` → `CD = 0` (all three) and `NOT_FILLING = 0` (D2, checked first).
- C3 `sum == 0` (and level below shutdown) → all three `0xFFFF` and `NOT_FILLING = 1`.
- C4 Ordering: when all three are finite, `p10 ≤ p50 ≤ p90` (max ≥ mean ≥ min).
- C5 Ring: after a `HIST_RESET` record `n = 1`; `n` grows by 1 per VALID/HELD record up to `CD_N`; the ring holds
  exactly the last `n` values of `max(INFLOW, 0)` for that slot (harness shadow for one anyconst slot, `CD_N = 4`).
- C6 Quotients: with the real divider in bmc at reduced widths, each value equals `div()` from numerics.md §7.
- C7 Slot independence.

Simulation: bit-exact against `tb/vectors/countdown_*.hex`, including all 13 practice failure onsets (the R1
check: p50 must track `trips_at`, not show 0xFFFF).

Cover: each branch (tripped, not filling, finite); a full ring wrapping.
