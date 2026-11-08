# FPGA task board

Claim a task by writing your agent/session name in **Owner** and setting **Status** to CLAIMED, in the same
commit as your first work. Statuses: TODO · CLAIMED · BLOCKED · REVIEW · DONE. A task can start only when every
task in **Needs** is DONE (a Verify task may start writing properties before its vectors exist; it needs T0.2 only
to finish simulation). Rules: `AGENTS.md`. Spec: `spec/` (FROZEN v2).

**Branches on Windows:** `fpga/<task-id>` cannot coexist with the `FPGA` branch on a case-insensitive filesystem, so
task branches are named `eog/<task-id>` (e.g. `eog/T1.validate.rtl`). **Status edits:** only the lead edits this
file during a wave (agents report status in their final message) to avoid merge conflicts.

## Wave 0 — lead

| ID | Task | Needs | Owner | Status | Output |
| --- | --- | --- | --- | --- | --- |
| T0.1 | Freeze the spec (decisions D1–D5, conventions, numerics, regmap, 12 module specs, `rtl/eog_defs.svh`) | — | Claude (Lucas's session) | DONE | `spec/` v1 |
| T0.2 | Bit-exact model + reference ingest + vectors (`model/README.md`) | T0.1 | fpga-model agent (lead session) | DONE | `model/`, `tb/vectors/`; b873096, merged f9c083b; `python FPGA/model/test_model.py` 13 passed / 0 failed (R1 worst \|p50 − trips_at\| 2.0 min at all 13 onsets) |
| T0.3 | `formal/common/` (abstract multiplier, handshake/stage property macros); check `scripts/*.sh` against the installed tools | T0.1 | lead | DONE | `formal/common/` (checker modules, abstract mul, self-test), `scripts/env.sh`, `scripts/wsl.sh`; 5d34900; `reports/formal_common.txt`, `reports/formal_axi_mul.txt` |

## Wave 1 — parallel, two agents per module (RTL and Verify never share a branch)

| ID | Module (spec) | Role | Needs | Owner | Status | Report |
| --- | --- | --- | --- | --- | --- | --- |
| T1.mul.rtl | `eog_mul` | RTL | T0.1 | fpga-rtl agent | DONE | 3919c2e, merged caf9580; `reports/formal_mul.txt`, `reports/sim_mul.log` (PASS 736,704 products, 36 configurations) |
| T1.mul.fv | `eog_mul` | Verify | T0.1, T0.3 | fpga-verify agent | DONE | 8b25855, merged caf9580; `reports/formal_mul.txt` (prove, prove_w, bmc_feat, bmc_head, cover PASS) |
| T1.div.rtl | `eog_div` | RTL | T0.1 | fpga-rtl agent | DONE | 0a5a100, merged 1565f11; `reports/formal_div.txt`, `reports/sim_div.log` (PASS 19,123 divisions) |
| T1.div.fv | `eog_div` | Verify | T0.1, T0.3 | fpga-verify agent | DONE | 0ee19ef, merged 1565f11; `reports/formal_div.txt` (prove/bmc/cover PASS) |
| T1.unpack.rtl | `eog_unpack` | RTL | T0.1 | fpga-rtl agent | REVIEW | `eog/T1.unpack.rtl` bc4a760 (lint/iverilog/yosys clean, 1 beat/cycle at out_ready = 1, 841 flops) |
| T1.unpack.fv | `eog_unpack` | Verify | T0.1, T0.3 | | TODO | |
| T1.validate.rtl | `eog_validate` | RTL | T0.1 | fpga-rtl agent | REVIEW | `eog/T1.validate.rtl` 2dd4565 (lint/iverilog/yosys clean, latency 1, II 2, no reset sweep) |
| T1.validate.fv | `eog_validate` | Verify | T0.1, T0.2, T0.3 | fpga-verify agent | CLAIMED | |
| T1.features.rtl | `eog_features` | RTL | T0.1, T1.mul.rtl | fpga-rtl agent | REVIEW | `eog/T1.features.rtl` 9441fc4 (lint/iverilog/yosys clean; latency 13, II 14; smoke PASS all 12 features vector cases). Note: the RTL agent read the verifier's WIP harness after its RTL was final (last commit is a no-op refactor); the verifier never saw the RTL, so the proof stays independent |
| T1.features.fv | `eog_features` | Verify | T0.1, T0.2, T0.3 | fpga-verify agent | CLAIMED | |
| T1.memory.rtl | `eog_memory` | RTL | T0.1 | fpga-rtl agent | REVIEW | `eog/T1.memory.rtl` 560ee3b (lint/iverilog/yosys clean, II 3, latency 2) |
| T1.memory.fv | `eog_memory` | Verify | T0.1, T0.2, T0.3 | fpga-verify agent | CLAIMED | |
| T1.countdown.rtl | `eog_countdown` | RTL | T0.1, T1.mul.rtl, T1.div.rtl | fpga-rtl agent | CLAIMED | |
| T1.countdown.fv | `eog_countdown` | Verify | T0.1, T0.2, T0.3 | | TODO | |
| T1.head.rtl | `eog_head` | RTL | T0.1, T1.mul.rtl | fpga-rtl agent | CLAIMED | |
| T1.head.fv | `eog_head` | Verify | T0.1, T0.2, T0.3 | fpga-verify agent | CLAIMED | |
| T1.alarm.rtl | `eog_alarm` | RTL | T0.1 | fpga-rtl agent | REVIEW | `eog/T1.alarm.rtl` 3da09f1 (lint/iverilog/yosys clean, latency 1, II 2 + 1 per ALERT) |
| T1.alarm.fv | `eog_alarm` | Verify | T0.1, T0.2, T0.3 | fpga-verify agent | CLAIMED | |
| T1.pack.rtl | `eog_pack` | RTL | T0.1 | | TODO | |
| T1.pack.fv | `eog_pack` | Verify | T0.1, T0.3 | | TODO | |
| T1.regs.rtl | `eog_regs` | RTL | T0.1 | | TODO | |
| T1.regs.fv | `eog_regs` (reuse the `axi_mul` AXI-Lite properties) | Verify | T0.1, T0.3 | | TODO | |

Priority when capacity is limited: mul, div → validate, features, head → memory, countdown, alarm → unpack, pack, regs.

## Wave 2 — integration

| ID | Task | Needs | Owner | Status | Output |
| --- | --- | --- | --- | --- | --- |
| T2.top | `rtl/eog_top.sv` + bounded top proof + full-practice-week sim vs `model/` (`spec/modules/eog_top.md`) | all T1 DONE | | TODO | |
| T2.ps1 | ARM app v1 (`ps/eog_app.c`): UDP 7000/7003/7004/heartbeat → AXI-Lite windows, RESULT/ALERT/STATS packets back; keep `udp_mul.c` on 7777 | T0.1 | | TODO | `ps/` |
| T2.bd1 | Vivado block design v1: `eog_top` on GP0 at `0x43C1_0000` next to `axi_mul`; XDC for LEDs/BTN0/Pmods (O4); timing at 100 MHz | T2.top | | TODO | `vivado/` — **board machine only** |
| T2.board1 | Board bring-up v1: practice data end to end, RESULTs match `model/` | T2.ps1, T2.bd1 | | TODO | report — **board machine only** |

## Wave 3 — line rate (board machine only)

| ID | Task | Needs | Owner | Status | Output |
| --- | --- | --- | --- | --- | --- |
| T3.dma | AXI DMA (MM2S/S2MM, scatter-gather) + zero-copy ARM path + drop-before-starve rule | T2.board1 | | TODO | |
| T3.perf | Re-measure end to end at line rate; record in reports | T3.dma | | TODO | |

## Spec questions

| # | Module | Question | Proposed answer | Raised by | Answer (lead) |
| --- | --- | --- | --- | --- | --- |
| 1 | memory | VALID/HELD record with `FAC ≥ N_FAC` (validate never produces it) | Treat as a no-update record: no slot changes, `FEAT[12..30] = 0` | T1.memory.rtl | Accepted (clarification). Applies to every stateful stage (countdown, head, alarm): out-of-range `FAC` never touches state |
| 2 | memory | M2 "inputs absorbed" for `net_ema` (feature 27) | `net_ema` starts at 0 after a reset and updates on every VALID/HELD record, so 0 counts as an absorbed input for feature 27; gated EMAs start at the first running input (0 not included) | T1.memory.rtl | Accepted (clarification) |
| 3 | alarm | Order of ALERTs from one record; order of ACKED in a sweep | NS_RAISED, ES_RAISED, CLEARED(NS), CLEARED(ES); ACKED slot-major (lowest slot first), NS before ES | T1.alarm.rtl | Accepted |
| 4 | alarm | ACKED fields not listed (RULES, CLASSES, SOURCE bit 2) | 0, 0, 0 (only SOURCE bit 4 = latch type) | T1.alarm.rtl | Accepted |
| 5 | alarm | Does `al_valid` pulse when `al_full`? | No: `al_valid` and `al_drop` are exclusive; a dropped ALERT is not retried | T1.alarm.rtl | Accepted |
| 6 | alarm | ALERT `FAC_ID` width/source | Zero-extended `FAC` (= `FAC_RAW` for every non-DROPPED record; DROPPED raise no ALERT) | T1.alarm.rtl | Accepted |
| 7 | alarm | `GAP_THR` signedness | Signed i16, compared signed with `CH3` | T1.alarm.rtl | Accepted |
| 8 | alarm | BTN0 polarity | Active high at `eog_alarm`; any inversion happens in `eog_top`/XDC (O4) | T1.alarm.rtl | Accepted; confirm with the board pinout in T2.bd1 |
| 9 | alarm | LED details (PWM, fault window, blink phase, override) | 25 % PWM (64/256 cycles); fault window on a free-running ms tick (±1 ms); free-running 2 Hz blink; `ledovr` raw, no PWM | T1.alarm.rtl | Accepted |
| 10 | alarm | Status codes 2, 5–7 (never produced) | No state change (as DROPPED); they do light the `ld0` fault indicator | T1.alarm.rtl | Accepted |
| 11 | all | `II` parameter unused by a stage | Keep the parameter (uniform interface), waive UNUSEDPARAM inline | T1.alarm.rtl | Accepted. The `eog_defs.svh` UNUSEDPARAM waiver is now inside the generated header (b1ab919) |
| 12 | validate | numerics §3 step 8: are `PUMP_INCONS`/`WELL_INCONS` computed on raw or cleaned values, and when inputs are not OK? | On the carried (observed or held) values, and only when the inputs are OK: `PUMP_INCONS = FLD_OK[PUMP_ST] & FLD_OK[PUMP_FLOW] & PUMP_ST ≠ 1 & PUMP_FLOW > 0`; `WELL_INCONS` = some configured slot i with both its status and water OK, status 0 and water > 0 | T1.validate.rtl | Accepted (clarification, same rule as the §4 rule bits; reason-bit only, no layout change). Lucas may reverse |
| 13 | validate | `PREV_LEVEL` when `PREV_OK = 0` | 0 | T1.validate.rtl | Accepted |
| 14 | validate | `n_wells` when the `N_WELL` parameter < 8 (shrunk proofs) | `n_wells = min(CFG.N_WELLS, N_WELL)`; identical to the spec at the default N_WELL = 8 | T1.validate.rtl | Accepted |
| 15 | all | conventions §7 example uses `EOG_*_W` in an ANSI port list, but §6 includes `eog_defs.svh` inside the body | Use non-ANSI port declarations after the include, or literal widths checked by lint | T1.validate.rtl | Accepted; §7 wording fixed (no version bump: example only) |
