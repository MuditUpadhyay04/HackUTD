# eog_features — the 12 channels and rule bits 0–3

Implements numerics.md §4.

## Parameters

`N_FAC` (32), `N_WELL` (8), `II` (16).

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | |
| `in_valid`, `in_ready`, `in_data` | | `EOG_BV_W` | bus V |
| `out_valid`, `out_ready`, `out_data` | | `EOG_BF_W` | bus F |
| `cfg_fac` | out | 5 | slot whose CONFIG row is read (= `FAC` of the current record) |
| `cfg_row` | in | 512 | combinational |

Uses one or more `eog_mul` (`AW = 20`, `BW = 32`, `A_SIGNED = 1`, `B_SIGNED = 0`). One shared multiplier issuing
one channel per cycle meets II = 16.

## Behavior

Stateless. Header copied; `REASON |= FEAT_SAT` if any channel saturates (VALID/HELD only). `FEAT0_11` per
numerics.md §4 (0 for INVALID/DROPPED). `RULES4` per numerics.md §4. `INFLOW`, `LEVEL` copied from bus V;
`PUMP_RUN = (PUMP_ST == 1)` for VALID/HELD, else 0.

## Required properties (verifier)

Stage contract (conventions §3).

- F1 INVALID/DROPPED → `FEAT0_11 = 0`, `RULES4 = 0`, `PUMP_RUN = 0`.
- F2 Channels 7 and 8 are exactly 16384/0 per `PUMP_ST`.
- F3 Channel 11 = 0 when `PREV_OK = 0`.
- F4 Saturation: every channel lies in [-32768, 32767] and `FEAT_SAT` is set iff some VALID/HELD channel's
  unsaturated value was outside that range (prove with the real multiplier in `bmc`, or with the abstract one plus
  a harness-side reference of the rounding/saturation step).
- F5 Rules: each rule bit equals its numerics.md §4 condition on VALID/HELD records (`SHUT_IN`: every configured
  slot has status 0 and water exactly 0).
- F6 `REASON` only gains bits.

Simulation: bit-exact against `tb/vectors/features_*.hex` from Mudit's golden sets (G0/G1/G2, `expected_stages.csv`
has all 31 features per record) plus saturation corner cases with extreme CONFIG multipliers.

Cover: a saturated channel; `SHUT_IN` set; channel 11 nonzero.
