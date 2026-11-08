# eog_mul — the only multiplier

Every multiply in the engine goes through this module, so `prove` runs can replace it with
`formal/common/eog_mul_abstract.sv` and `bmc`/simulation check the real one.

## Parameters

| Name | Default | Meaning |
| --- | --- | --- |
| `AW` | 20 | width of `a` |
| `BW` | 32 | width of `b` |
| `A_SIGNED` | 1 | `a` is two's complement |
| `B_SIGNED` | 0 | `b` is two's complement |
| `LAT` | 2 | output latency in cycles (0 = combinational) |

## Ports

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk` | in | 1 | |
| `a` | in | AW | |
| `b` | in | BW | |
| `p` | out | AW+BW | signed product of `a` and `b` (as typed by the parameters), sign-extended, valid `LAT` cycles after `a`/`b` were presented |

No reset, no handshake: a pure pipelined multiplier (Vivado maps it to DSP48E1s). The caller keeps its own
valid bits alongside.

## Required properties (verifier)

- P1 (bmc, small AW/BW such as 6×8 and full 20×32 in sim): `p == a·b` delayed by exactly `LAT` cycles, for every
  combination of `A_SIGNED`/`B_SIGNED` used in the design (1/0 for features, 1/1 for the head).
- P2: for `LAT = 0`, `p` is a pure function of `a`, `b`.

## Abstract model (`formal/common/eog_mul_abstract.sv`, owned by Lead/T0.3)

Same ports and parameters; `p` is `$anyseq`, except that `a == 0 || b == 0` forces `p == 0`. Used in `prove` tasks of
modules whose properties do not depend on the product's value.
