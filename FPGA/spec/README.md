# FPGA spec — module contracts

**Status: FROZEN, version 4** (Sun Nov 8 2026, ~01:00 CST; v4 = alignment with Mudit's reference, see changelog). `VERSION` holds the number.

**Normative integer reference:** Mudit's `ml/hutd_ml/features_int.py` (branch `ml`) with the changes listed in
`numerics.md` §11. The spec states the same rules readably; disagreements are spec questions, not choices.

Source design: `../../docs/plan/lucas/fpga_hardware_plan.md` (engine v2) plus the decisions in `numerics.md` §1
(R1–R3 from `../../docs/plan/lucas/review_notes.md` resolved as D1–D3; D4 and D6–D12 new; D5 replaced by D6 in v4). Lucas may reverse any of them;
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

v1 packet sizes and field positions are unchanged. v4 defines or adds (all previously reserved or unspecified):

- Status codes exactly as the plan: 0 VALID, 1 HELD, 2 never produced, 3 INVALID, 4 DROPPED.
- RESULT reason bit 12 `FRAMING` (bits 0–10 as the plan).
- GLOBAL bytes 20–23 = `PERSIST_K4[4]` (per-class persistence; byte 3 is the fallback); byte 0 `S` = 17; byte 2
  `CD_LOG2` = 4.
- CONFIG `LO[j]`/`HI[j]` index = DATA present-bit order (index 2 bounds the pump status).
- ALERT SOURCE bit 4 = latch type for kinds 2/3/4 (0 Night Shift, 1 E-STOP); both latch until acknowledged.
- `K_CD = round(0.288 · C · 256)`; countdown per D1/D2/D6.
- Weight blob = Mudit's layout (`ml_plan.md` §4.8); the AXI-Lite window holds its first 280 bytes + a version word.

## Changelog

| Version | When (CST) | Change |
| --- | --- | --- |
| 0 | Sat Nov 7 22:10 | Scaffold |
| 1 | Sat Nov 7 22:30 | Frozen: conventions, numerics (D1–D5), regmap, 12 module specs, generated `eog_defs.svh` |
| 2 | Sat Nov 7 22:45 | conventions §7: formal-only observation ports `f_inflight`, `f_oldest_recno` on every pipeline stage (needed for inductive stage proofs). No wire-format, numerics or synthesized-port change; `EOG_SPEC_VERSION` (and so the VERSION register `[7:0]`) is now 2. `formal/common` checkers are modules (`eog_fv_props.sv`), not macros |
| 3 | Sun Nov 8 ~00:45 | `eog_head` gets a second reset input, `wb_rst_n` (hard reset only; `eog_top` wires the raw `rst_n`). This resolves a conflict: conventions §1 and the head spec say soft reset keeps the weight banks, but the head only had the engine reset `rst_n & ~soft_rst`. Internal module port only: no wire-format or numerics change. `EOG_SPEC_VERSION` (VERSION register `[7:0]`) is now 3. Spec question 16; Lucas may reverse |
| 4 | Sun Nov 8 ~01:00 | Aligned with Mudit's `features_int.py` (Lucas's calls): S stays 17; countdown `review_r1r2` with prefilled ring and `mean = sum >>> 4` (D6, replaces D5); per-facility hold counter, sub-step timestamps DROPPED, strict `>` thresholds, LO/HI in present-bit order, INVALID semantics (D7); Night Shift latched like E-STOP (D8); reserved field → DROPPED/FRAMING (D9); per-class K (D10); weight window = Mudit's blob (D11); feature debug readback (D12). Reason bits 11, 13, 14 and GLOBAL `SHUTIN_WATER_MAX` dropped. `EOG_SPEC_VERSION` (VERSION register `[7:0]`) is now 4. Weight window grows 69 → 71 words (version is word 70). Reopens RTL for unpack, validate, features, memory, countdown, head, alarm (see `TASKS.md`) |
