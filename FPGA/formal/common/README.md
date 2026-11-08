# formal/common — shared formal pieces (Lead, task T0.3)

Formal-only files: list them in a `.sby` `[files]` section and read them with `read_verilog -formal -sv`. Never put
them in a `tb/*/files.f`.

| File | What |
| --- | --- |
| `eog_mul_abstract.sv` | Module `eog_mul` (same name, ports, parameters as `rtl/eog_mul.sv`); `p` is `$anyseq` except `p == 0` when `a == 0` or `b == 0` (`LAT` cycles earlier). A `prove` task lists this file **instead of** `rtl/eog_mul.sv`; `bmc` uses the real one. |
| `eog_fv_props.sv` | Checker modules: `eog_fv_init`, `eog_fv_axis`, `eog_fv_stage` (below). |
| `common.sby`, `fv_selftest.sv` | A tiny reference stage proven with the checkers (`bash scripts/formal.sh common`), so a failure in a module's proof is about the module, not the checkers. |

The checkers are **modules**, not macros (the earlier plan said `axis_props.svh` / `stage_props.svh`): one instance
per link, no name clashes, and sby reports the failing property with its instance path.

## `eog_fv_init (clk, rst_n, f_past_valid)`

Assumes `rst_n = 0` in the first cycle; `f_past_valid` is 1 from the second cycle on. One per harness.

## `eog_fv_axis #(W, ASSUME) (clk, rst_n, f_past_valid, valid, ready, data)`

Conventions §2 rules on one link: `valid` is 0 in the cycle after a reset cycle (`ax_reset`); once `valid` is 1 it
stays 1 with `data` unchanged until the transfer (`ax_hold`, `ax_data`). `ASSUME = 1` for a DUT input link (the
upstream behaves), `ASSUME = 0` for an output link (the DUT behaves). Rules 3–4 (no combinational valid↔ready
loops) are structural and left to lint/integration.

## `eog_fv_stage #(RW, MAX_INFLIGHT, II_MAX, LAT_MAX, SWEEP) (...)`

Ports: `clk, rst_n, f_past_valid, in_valid, in_ready, in_recno[RW-1:0], out_valid, out_ready, out_recno[RW-1:0],
excl, dut_inflight[7:0], dut_oldest[31:0]` → outputs `f_in_cnt, f_out_cnt` (RW bits), `f_in_flight` (8 bits).
`dut_inflight`/`dut_oldest` take the DUT's formal-only observation ports `f_inflight`/`f_oldest_recno`
(spec conventions §7).

- `st_recno_in` (assume): the input `REC_NO` equals the number of inputs accepted since reset.
- `st_order`: every output's `REC_NO` equals the number of outputs already transferred (in order, none skipped).
- `st_no_ghost`: no output without an accepted, not-yet-output input (same-cycle pass-through allowed).
- `st_link_n`, `st_link_r`: the DUT's `f_inflight` equals the checker's count, and its `f_oldest_recno` is the next
  expected `REC_NO`. Without this link, k-induction can start from a state where the DUT has silently dropped a
  record, and no port-only property closes.
- `st_cnt`: checker-internal consistency (`f_in_cnt − f_out_cnt == f_in_flight`).
- `st_inflight`: at most `MAX_INFLIGHT` records held (1 for one-record-at-a-time stages); this also keeps induction
  finite.
- `st_ii` (`II_MAX > 0`): while `in_valid = 1` and `out_ready = 1`, never `II_MAX` consecutive cycles without an
  accept. Off for the first `SWEEP` cycles after reset (RAM-clearing sweep, conventions §1) and while `excl = 1`
  (e.g. `eog_alarm`'s acknowledge sweep; tie to 0 otherwise).
- `st_lat` (`LAT_MAX > 0`): while `out_ready = 1`, the oldest in-flight record shows `out_valid` within `LAT_MAX`
  cycles of becoming the oldest.

`RW` (8..32) may be smaller than 32 (compare the low bits of `REC_NO`; e.g. 8) to keep counters small; the harness must then
wire `in_data[REC_NO lsb +: RW]`. Use `f_in_cnt`/`f_out_cnt` to build per-record shadows (e.g. "the record with
`REC_NO == anyconst k`").

Self-test: `fv_selftest.sv` also carries three mutants (`-DMUT_DROP`, `-DMUT_DUP`, `-DMUT_STALL`); a `bmc` at depth
40 fails each of them on `st_link_n` (checked Sat Nov 7 22:38).

## Harness pattern (`formal/<m>/fv_eog_<m>.sv`)

Instantiate `eog_<m>` with small parameters; one `eog_fv_init`; `eog_fv_axis` with `ASSUME = 1` on the input and
`ASSUME = 0` on the output; one `eog_fv_stage`. Constrain other inputs with `assume`; model CONFIG as per-slot
`anyconst` rows and GLOBAL as `anyconst`; keep shadow models for one `anyconst` slot; `assert` the properties of
`spec/modules/eog_<m>.md` with labels named after their IDs (`V6: assert (...)`) so reports map to the checklist.
Each `.sby` has `prove` (k-induction), `cover`, and `bmc` where the spec asks for real arithmetic; `formal.sh`
passes only if every task passes. Liveness bounds (`st_ii`, `st_lat`) need induction depth above `II_MAX` /
`LAT_MAX` unless the RTL exports internal invariants under `ifdef FORMAL`; it is fine to prove them in a separate
`bmc`-free task with a smaller parameterization, or to set `LAT_MAX` to the module's documented latency + margin.

## Running on this machine

All scripts work from Git Bash on Windows: `scripts/env.sh` re-runs them inside WSL (`Ubuntu-24.04`) with the OSS
CAD Suite from `~/oss-cad-suite`. For any other tool command use `bash FPGA/scripts/wsl.sh <cmd> ...`.
