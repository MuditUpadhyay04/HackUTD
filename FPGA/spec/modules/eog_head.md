# eog_head — four logistic regressions + double-buffered weights

Implements numerics.md §8.

## Parameters

`II` (16), `N_FEAT` (31), `N_CLS` (4).

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | `rst_n` = engine reset (includes soft reset): flushes the record in flight only |
| `wb_rst_n` | in | 1 | weight-store reset, hard reset only (spec v3): `eog_top` wires the raw `rst_n`, not the engine reset |
| `in_valid`, `in_ready`, `in_data` | | `EOG_BC_W` | bus C |
| `out_valid`, `out_ready`, `out_data` | | `EOG_BL_W` | bus L |
| `wb_we` | in | 1 | write one word of the **inactive** bank |
| `wb_addr` | in | 7 | word index 0..68 of the weight image |
| `wb_wdata` | in | 32 | |
| `wb_raddr` | in | 7 | readback address (inactive bank) |
| `wb_rdata` | out | 32 | readback data, 1 cycle after `wb_raddr` |
| `swap_req` | in | 1 | pulse: make the inactive bank active at the next record boundary |
| `swap_pending` | out | 1 | 1 from `swap_req` until the swap happens |
| `active_bank` | out | 1 | |
| `active_ver` | out | 8 | `VER` of the active bank |

Uses `eog_mul` (`AW = 16`, `BW = 16`, both signed). 124 MACs per record in ≤ 16 cycles means ≥ 8 multipliers
(for example two per class).

## Behavior

Header copied (`REASON |= NO_MODEL` for VALID/HELD when `active_ver == 0`). `CH3 = FEAT[3]`. `RULES`, `CD` copied.
`LOGITS` per numerics.md §8. `WVER` = `active_ver` at accept time.

Reset (spec v3):
- `wb_rst_n` = 0 resets the weight store: both banks' word 68 reads 0 (no model), `active_bank` = 0, and
  `swap_pending` = 0. Words 0–67 are undefined after power-up until written.
- `rst_n` = 0 (engine reset, including the 2-cycle soft-reset pulse) only flushes the record in flight. Both banks,
  `active_bank` and a pending swap survive it, so soft reset never clears the model (conventions §1).
- Weight writes are ignored while either reset is 0. A pending swap does not execute while `rst_n` = 0.
A swap happens only when no record is being processed (between output transfer and next accept); writes during a
pending swap go to the bank that is inactive at the time of the write.

## Required properties (verifier)

Stage contract (conventions §3).

- H1 Bank atomicity: every record's four logits are computed entirely from the bank that was active when it was
  accepted (harness: anyconst record, snapshot of the bank id).
- H2 A swap happens exactly once per `swap_req` (back-to-back requests while pending coalesce) and only at a
  record boundary; `swap_pending` falls exactly when `active_bank` toggles.
- H3 Writes never modify the active bank.
- H4 `active_ver == 0` or status INVALID/DROPPED → `LOGITS = 0`; `NO_MODEL` set iff VALID/HELD with `active_ver == 0`.
- H5 No accumulator overflow: a harness-side 64-bit sum equals the RTL accumulator for every term (bmc with real
  multipliers at reduced `N_FEAT`, e.g. 3).
- H6 Rounding and saturation of the output shift match numerics.md §8 for all `S_OUT` 0..31 (bmc on the
  post-accumulate step).

Simulation: bit-exact against `tb/vectors/head_*.hex` (random weight sets + Mudit's first trained set when available,
swaps mid-stream).

Cover: a swap between two records; a saturated logit.
