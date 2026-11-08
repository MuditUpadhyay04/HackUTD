# FPGA spec — module contracts

**Status: FROZEN, version 2** (Sat Nov 7 2026, 22:45 CST). Wave 1 may start. `VERSION` holds the number.

Source design: `../../docs/plan/lucas/fpga_hardware_plan.md` (engine v2) plus the decisions in `numerics.md` §1
(R1–R3 from `../../docs/plan/lucas/review_notes.md` resolved as D1–D3; D4–D5 new). Lucas may reverse any of them;
that is a spec change (bump `VERSION`, changelog row, regenerate `rtl/eog_defs.svh`).

## Files

| File | Contents |
| --- | --- |
| `conventions.md` | Clock/reset, handshake, stage contract, buses, config access, code rules |
| `numerics.md` | Every fixed-point value, bit-exact: validation, channels, memory features, countdown, head, alarms, ingest CONFIG values |
| `regmap.md` | AXI-Lite map at `0x43C1_0000`, v1 (no-DMA) usage |
| `modules/eog_*.md` | Per module: parameters, ports, behavior, **required properties** (the verifier's checklist), simulation vectors, cover goals |
| `gen/buses.py`, `gen/gendefs.py` | Single source of the bus/record layouts; `python3 gen/gendefs.py` regenerates `rtl/eog_defs.svh` and `gen/bus_tables.md` |

Modules: `eog_mul`, `eog_div` (helpers) · `eog_unpack` → `eog_validate` → `eog_features` → `eog_memory` →
`eog_countdown` → `eog_head` → `eog_alarm` → `eog_pack` (pipeline) · `eog_regs` (AXI-Lite) · `eog_top`.

## Wire-format notes (contract C2 in `global_plan.md`)

v1 layouts are unchanged in size and position. The freeze **adds** (all previously reserved):

- RESULT reason bits 11 `FIELD_ABSENT`, 12 `FRAMING`, 13 `NO_MODEL`, 14 `FIELD_LOST`. Status codes are exactly the
  plan's: 0 VALID, 1 HELD, 2 reserved (never produced), 3 INVALID, 4 DROPPED.
- GLOBAL CONFIG bytes 20–21 = `SHUTIN_WATER_MAX` (u16, 0.5 bpd); byte 0 `S` must be 17.
- ALERT SOURCE bit 4 = latch type for kinds 3/4 (0 Night Shift, 1 E-STOP).
- `K_CD` defined exactly: `round(0.288 · C · 256)`; countdown semantics per D1/D2.
- Weight image layout (numerics.md §8): resolves the AXI-Lite side of O3; the UDP WEIGHTS blob body should use
  the same 69-word image (Mudit + Lucas to confirm, plus CRC and self-test vectors).

## Changelog

| Version | When (CST) | Change |
| --- | --- | --- |
| 0 | Sat Nov 7 22:10 | Scaffold |
| 1 | Sat Nov 7 22:30 | Frozen: conventions, numerics (D1–D5), regmap, 12 module specs, generated `eog_defs.svh` |
| 2 | Sat Nov 7 22:45 | conventions §7: formal-only observation ports `f_inflight`, `f_oldest_recno` on every pipeline stage (needed for inductive stage proofs). No wire-format, numerics or synthesized-port change; `EOG_SPEC_VERSION` (and so the VERSION register `[7:0]`) is now 2. `formal/common` checkers are modules (`eog_fv_props.sv`), not macros |
