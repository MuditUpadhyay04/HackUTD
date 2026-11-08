# formal/common — shared formal pieces (Lead, task T0.3)

- `eog_mul_abstract.sv`: same name, ports and parameters as `eog_mul`; `p` is `$anyseq` except `p == 0` when `a == 0`
  or `b == 0`. A module's `prove` task lists this file instead of `rtl/eog_mul.sv`.
- `axis_props.svh`: macros for the handshake rules (conventions §2) on a named link, e.g.
  `` `AXIS_ASSUME_IN(in_valid, in_ready, in_data) `` / `` `AXIS_ASSERT_OUT(out_valid, out_ready, out_data) ``.
- `stage_props.svh`: one-in-one-out-in-order via `REC_NO` (the harness drives `REC_NO` as a counter and asserts the
  output sequence), II ≤ 16 and latency ≤ 128 bounds.

Harness pattern (`formal/<m>/fv_eog_<m>.sv`): instantiate `eog_<m>` with small parameters, constrain inputs with
`assume`, model CONFIG as per-slot `anyconst` rows and GLOBAL as `anyconst`, keep shadow models for one `anyconst`
slot, and `assert` the properties listed in `spec/modules/eog_<m>.md` under their IDs (`// V6` etc.) so reports map
to the checklist. Each `.sby` has `prove` (k-induction), `cover`, and `bmc` where the spec asks for real arithmetic.
