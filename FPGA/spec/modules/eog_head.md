# eog_head — four logistic regressions, double-buffered weights, debug capture

Implements numerics.md §8 (D11, D12).

## Parameters

`II` (16), `N_FEAT` (31), `N_CLS` (4).

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | `rst_n` = engine reset (includes soft reset): flushes the record in flight only |
| `wb_rst_n` | in | 1 | weight-store reset, hard reset only (spec v3): `eog_top` wires the raw `rst_n`, not the engine reset |
| `in_valid`, `in_ready`, `in_data` | | `EOG_BC_W` | bus C |
| `out_valid`, `out_ready`, `out_data` | | `EOG_BL_W` | bus L |
| `wb_we` | in | 1 | write one word of the **inactive** bank's window |
| `wb_addr` | in | 7 | word 0..70 (`EOG_WIN_WORDS` = 71) |
| `wb_wdata` | in | 32 | |
| `wb_raddr` | in | 7 | readback address (inactive bank) |
| `wb_rdata` | out | 32 | readback data, 1 cycle after `wb_raddr` |
| `swap_req` | in | 1 | pulse: the inactive bank becomes active at the next record boundary |
| `swap_pending` | out | 1 | 1 from `swap_req` until the swap |
| `active_bank` | out | 1 | |
| `active_ver` | out | 8 | window word 70 `[7:0]` of the active bank |
| `dbg_fac` | in | 5 | facility to capture |
| `dbg_valid` | out | 1 | 1-cycle pulse: capture `dbg_*` now |
| `dbg_feat` | out | 496 | the 31 features of the captured record |
| `dbg_logits` | out | 64 | its 4 logits |
| `dbg_rec_no` | out | 32 | its `REC_NO` |

Uses `eog_mul` (`AW = 16`, `BW = 16`, both signed); 124 MACs in ≤ 16 cycles needs ≥ 8 multipliers.

## Window layout (per bank, 71 × 32-bit words)

Words 0–69 = Mudit's weight blob bytes 0–279 (little-endian): `S_OUT` = byte 4; `W[k][i]` = s16 at byte
`8 + 2·(31k + i)`; `B[k]` = s32 at byte `256 + 4k` (words 64–67). Word 70 `[7:0]` = `VER`. The RTL ignores bytes
0–3, 5–7 and 272–279.

## Behavior

Header copied. `CH3 = FEAT[3]`. `RULES`, `CD` copied. `LOGITS` per numerics.md §8 for VALID/HELD with `VER ≠ 0`,
else 0. `WVER` = `active_ver` at accept time. `dbg_valid` pulses for every VALID/HELD record whose `FAC == dbg_fac`.

Reset (spec v3, word numbers per v4):
- `wb_rst_n` = 0 resets the weight store: both banks' word 70 (VER) reads 0 (no model), `active_bank` = 0, and
  `swap_pending` = 0. Words 0–69 are undefined after power-up until written.
- `rst_n` = 0 (engine reset, including the 2-cycle soft-reset pulse) only flushes the record in flight. Both banks,
  `active_bank` and a pending swap survive it, so soft reset never clears the model (conventions §1).
- Weight writes are ignored while either reset is 0. A pending swap does not execute while `rst_n` = 0.
A swap happens only when no record is being processed (between output transfer and next accept); writes during a
pending swap go to the bank that is inactive at the time of the write.

## Required properties (verifier)

Stage contract (conventions §3).

- H1 Bank atomicity: each record's four logits come entirely from the bank active at its acceptance.
- H2 One swap per `swap_req` (requests while pending coalesce), only at a record boundary; `swap_pending` falls
  exactly when `active_bank` toggles.
- H3 Writes never modify the active bank.
- H4 `active_ver == 0` or status INVALID/DROPPED → `LOGITS = 0`.
- H5 No accumulator overflow; the accumulator equals a harness 64-bit sum (bmc, real multipliers, reduced `N_FEAT`).
- H6 Output rounding/saturation matches numerics.md §8 for `S_OUT` 0..31.
- H7 Weight addressing: `W[k][i]` is read from byte `8 + 2(31k + i)` (anyconst k, i; harness writes a marker there).
- H8 `dbg_*` equals the record's features/logits/`REC_NO` when `dbg_valid`.

Simulation: bit-exact against `tb/vectors/head_*.hex` from Mudit's golden sets (v0 = pseudo-random saturating
weights, v1 = trained), plus a swap mid-stream.

Cover: a swap between two records; a saturated logit.
