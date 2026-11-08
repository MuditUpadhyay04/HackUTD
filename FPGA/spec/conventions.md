# Conventions (spec v2, FROZEN)

Applies to every module in `rtl/`, every harness in `formal/` and every testbench in `tb/`.

## 1. Clock and reset

- One clock, `clk`, 100 MHz (Zynq FCLK0). No other clocks, no gated clocks, no latches.
- One reset, `rst_n`: synchronous, active low. After reset every `*_valid` output is 0.
- Soft reset (`CTRL.soft_reset`) is applied by `eog_top` as a 2-cycle `rst_n` pulse to the engine stages. It clears
  all per-facility state and FIFOs, not the CONFIG table or weight banks (those live in `eog_regs` / `eog_head`
  and are not reset by soft reset). `eog_head` receives the hard reset separately on `wb_rst_n` for this (spec v3).
- A stage that keeps per-facility state in RAM may spend up to `N_FAC + 8` cycles after reset clearing it; it holds
  `in_ready = 0` until done.

## 2. Handshake

Stage-to-stage links are valid/ready (AXI-Stream semantics), named `in_valid`/`in_ready`/`in_data` and
`out_valid`/`out_ready`/`out_data`:

1. A transfer happens on a cycle where `valid && ready`.
2. Once `valid` is 1 it stays 1, and `data` stays unchanged, until the transfer happens.
3. `ready` may depend combinationally on nothing of the same link's `valid` (no `valid -> ready -> valid` loops);
   it may be registered or combinational from internal state.
4. `valid` must not depend combinationally on the same link's `ready`.

The external AXI-Stream ports of `eog_top` (`s_axis_*`, `m_axis_*`) follow the same rules with `tdata`/`tlast`.

## 3. Stage contract (every pipeline stage)

- **One in, one out, in order.** Every accepted input produces exactly one output, and outputs leave in
  acceptance order. The header field `REC_NO` is copied unchanged, so order and completeness are checkable.
- **Header pass-through.** `REC_NO`, `IN_LAST`, `FAC_RAW`, `FAC`, `TS`, `SINCE_RESET`, `HIST_RESET` pass through
  unchanged after `eog_validate`. `STATUS` (3 bits, the RESULT wire codes: 0 VALID, 1 HELD, 3 INVALID, 4 DROPPED; 2 is never produced) passes
  through unchanged after `eog_validate`. A stage may only **OR**
  bits into `REASON` (never clear them).
- **DROPPED records** (`STATUS = 4`) pass through every later stage without touching any per-facility state; every
  field a later stage produces is 0 for them, except `CD`, which is three `0xFFFF`.
- **INVALID records** (`STATUS = 3`) do not update per-facility state in `eog_memory`, `eog_countdown` or
  `eog_head`; `eog_alarm` resets that facility's persistence counters. Rules are still computed from the fields
  whose `FLD_OK` bit is set.
- **Throughput.** With `out_ready` held at 1 and `in_valid` held at 1, a stage accepts a new input at least once
  every `II_MAX = 16` cycles (except during its reset sweep, and `eog_alarm` during an acknowledge sweep).
- **Latency.** An accepted input appears at the output (`out_valid = 1`) within `LAT_MAX = 128` cycles if
  `out_ready` stays 1.
- **Per-facility state.** Each stage owns its own state (no stage reads another's). Simplest correct
  implementation: process one record at a time (accept, read state, compute, write state, present output, then
  accept the next). Overlap is allowed only with a same-facility hazard check (scoreboard stall).

## 4. Inter-stage buses

The pipeline is strictly serial (the countdown is a stage, not a parallel branch):

`eog_unpack → eog_validate → eog_features → eog_memory → eog_countdown → eog_head → eog_alarm → eog_pack`

Each bus is a flat vector. Field offsets and widths are generated into `rtl/eog_defs.svh` as
`EOG_B<bus>_<FIELD>` / `EOG_B<bus>_<FIELD>_W`; always use those names, never literal offsets. Signed fields are two's
complement. The tables below are generated (`spec/gen/bus_tables.md`); `H` = the common header (first 9 fields).

See `gen/bus_tables.md` for the full tables. Summary:

| Bus | Link | Width | Fields after the header |
| --- | --- | --- | --- |
| U | unpack → validate | 418 | (no header) `REC_NO`, `IN_LAST`, `FRAME_ERR`, `REC` (the 48 B DATA record) |
| V | validate → features | 373 | cleaned readings, `PUMP_ST`, `WELL_ACT`, `WELL_WATER`, `FLD_OK`, `WELLS_OK`, `PREV_LEVEL`, `PREV_OK` |
| F | features → memory | 343 | `FEAT0_11`, `RULES4`, `INFLOW`, `LEVEL`, `PUMP_RUN` |
| M | memory → countdown | 646 | `FEAT` (31 features), `RULES4`, `INFLOW`, `LEVEL` |
| C | countdown → head | 663 | `FEAT`, `RULES` (5 bits), `CD` |
| L | head → alarm | 255 | `CH3`, `RULES`, `CD`, `LOGITS`, `WVER` |
| A | alarm → pack | 243 | `RULES`, `CD`, `LOGITS`, `WVER`, `CLASSES` |

## 5. Configuration inputs

- **Facility CONFIG row**: 512 bits, the 64 B Facility CONFIG record exactly as on the wire (`EOG_CFG_*` offsets).
  A stage that needs it drives `cfg_fac[4:0]` and reads `cfg_row[511:0]` **combinationally in the same cycle**
  (the table is LUTRAM in `eog_regs`). The row of an **enabled** slot never changes (`eog_regs` ignores writes to
  it), so a stage may read it at any time during a record. Harnesses model it as a per-slot constant.
- **GLOBAL CONFIG**: 256 bits `glb[255:0]` (`EOG_G_*` offsets), constant while `CTRL.stream_en = 1` (`eog_regs`
  ignores writes while streaming). Harnesses assume it constant.

## 6. Code rules

- Each module `eog_<m>` lives in `rtl/eog_<m>.sv` with `` `include "eog_defs.svh" `` inside the module body.
- Parameters: `N_FAC` (default 32), `N_WELL` (8), `II` (16), plus module-specific ones in its spec. Defaults must
  match `eog_defs.svh`; harnesses override them to shrink proofs (for example `N_FAC = 2`).
- Every multiply uses `eog_mul`; every divide uses `eog_div`. No `*`, `/` or `%` elsewhere, except by constants that
  are powers of two (shifts) and in `ifdef FORMAL` code.
- `>>>` on signed values is an arithmetic right shift (floor). Write signedness explicitly (`$signed`).
- Formal helpers inside RTL go under `` `ifdef FORMAL `` and may only **add** assertions/assumptions about the
  module's own internal state (to help induction), never assumptions about inputs.

## 7. Formal observation ports (added in v2)

Port-level k-induction cannot see a record a stage silently dropped or is still holding, so every **pipeline
stage** (`eog_validate`, `eog_features`, `eog_memory`, `eog_countdown`, `eog_head`, `eog_alarm`, `eog_pack`) has two
extra output ports that exist **only under `` `ifdef FORMAL ``** (simulation and synthesis never see them):

| Port | Width | Meaning |
| --- | --- | --- |
| `f_inflight` | 8 | number of records accepted on `in_*` whose output has not yet transferred (for `eog_pack`: whose last beat has not transferred) |
| `f_oldest_recno` | 32 | `REC_NO` of the oldest such record; don't-care when `f_inflight = 0` |

Place them last in the port list. (Because `eog_defs.svh` is included inside the module body, an ANSI port list
cannot use `EOG_*_W`: either declare the ports non-ANSI after the include, or use literal widths in the ANSI list,
which Verilator lint checks against the connected buses. The example shows the ANSI form with a literal width.)

```systemverilog
    output logic [242:0] out_data       // EOG_BA_W
`ifdef FORMAL
    , output logic [7:0]  f_inflight
    , output logic [31:0] f_oldest_recno
`endif
);
```

The RTL drives them from its own state (for a one-record-at-a-time stage: `busy ? 1 : 0` and the held record's
`REC_NO`) and may add internal invariants relating them to that state. The harness never trusts them: the shared
checker `formal/common/eog_fv_stage` *asserts* they equal its own count and the next expected `REC_NO`
(`st_link_n`, `st_link_r`), which makes "one in, one out, nothing lost" inductive. Verifiers use these two ports
and the normal ports only; all other internals stay off limits. `eog_unpack` (beats in) and the helpers `eog_mul`,
`eog_div`, `eog_regs` don't have them.
