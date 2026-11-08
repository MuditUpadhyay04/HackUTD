# eog_div — the only divider

Unsigned, fully pipelined, one division accepted per cycle, fixed latency.

## Parameters

| Name | Default | Meaning |
| --- | --- | --- |
| `NW` | 48 | numerator width |
| `DW` | 32 | denominator width |
| `TW` | 4 | width of a tag carried alongside (for the caller's bookkeeping) |

Latency `LAT = NW + 1` cycles (one restoring step per quotient bit plus an input register). RTL may choose a
different fixed latency but must export it as `localparam LAT` and document it here via a spec question.

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk`, `rst_n` | in | 1 | |
| `in_valid` | in | 1 | start a division this cycle (no back-pressure; always accepted) |
| `n` | in | NW | numerator |
| `d` | in | DW | denominator |
| `tag_in` | in | TW | carried through |
| `out_valid` | out | 1 | exactly `LAT` cycles after the matching `in_valid` |
| `q` | out | NW | quotient `floor(n / d)`; all ones if `d == 0` |
| `r` | out | DW | remainder `n − q·d`; `n` truncated to DW if `d == 0` |
| `tag_out` | out | TW | the matching `tag_in` |

## Required properties (verifier)

- P1: `out_valid` is `in_valid` delayed by exactly `LAT` (after reset: 0 for the first `LAT` cycles).
- P2 (bmc at small widths, e.g. NW = 8, DW = 5, exhaustive over inputs): for `d ≠ 0`, `q·d + r == n` and `r < d`.
- P3: `d == 0` → `q` all ones.
- P4: `tag_out` is `tag_in` delayed by `LAT`.
- Cover: two back-to-back divisions complete on consecutive cycles.
