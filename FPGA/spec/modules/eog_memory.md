# eog_memory — the 19 memory features

Implements numerics.md §5.

## Parameters

`N_FAC` (32), `II` (16).

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | |
| `in_valid`, `in_ready`, `in_data` | | `EOG_BF_W` | bus F |
| `out_valid`, `out_ready`, `out_data` | | `EOG_BM_W` | bus M |

## Per-facility state

`last_run[5]` (s16), `ema_f[5]`, `ema_s[5]`, `net_ema` (s32 each; 25 bits suffice), `nsr` (u8), `has_run` (1). About
60 B per slot; RAM or flops. Cleared on reset (sweep allowed, conventions §1).

## Behavior

Header copied. `FEAT[0..11] = FEAT0_11`; `FEAT[12..30]` per numerics.md §5. `RULES4`, `INFLOW`, `LEVEL` copied.
Only VALID/HELD records update state; `HIST_RESET` clears that slot's state before the update.

## Required properties (verifier)

Stage contract (conventions §3).

- M1 INVALID/DROPPED → `FEAT[12..30] = 0` and no state change for any slot.
- M2 Each average stays within the min and max of the inputs it has absorbed since the last reset (harness tracks
  min/max for one anyconst slot and channel) — this is the int16-fit argument.
- M3 First running record after a reset: `FEAT[17+i] == FEAT[22+i] == FEAT[g_i]` and `FEAT[29] = 16384`.
- M4 `FEAT[28] = min(nsr, 64) << 8` where `nsr` counts VALID/HELD non-running records since the last running one
  (harness counter); `FEAT[30] = min(SINCE_RESET, 64) << 8`.
- M5 Exact update equations for one step (bmc, depth ~4, against a harness reference of the shift/add formulas).
- M6 Slot independence (as in validate V13).

Simulation: bit-exact against `tb/vectors/memory_*.hex` (full practice week per facility, including long pump-off
stretches and resets).

Cover: a slot that has run, stopped 64+ records, and run again.
