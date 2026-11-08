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
| T0.2 | Bit-exact model + reference ingest + vectors (`model/README.md`) | T0.1 | fpga-model agent (lead session) | CLAIMED | `model/`, `tb/vectors/` |
| T0.3 | `formal/common/` (abstract multiplier, handshake/stage property macros); check `scripts/*.sh` against the installed tools | T0.1 | lead | DONE | `formal/common/` (checker modules, abstract mul, self-test), `scripts/env.sh`, `scripts/wsl.sh`; 5d34900; `reports/formal_common.txt`, `reports/formal_axi_mul.txt` |

## Wave 1 — parallel, two agents per module (RTL and Verify never share a branch)

| ID | Module (spec) | Role | Needs | Owner | Status | Report |
| --- | --- | --- | --- | --- | --- | --- |
| T1.mul.rtl | `eog_mul` | RTL | T0.1 | fpga-rtl agent | REVIEW | `eog/T1.mul.rtl` 3919c2e (lint/iverilog/yosys clean) |
| T1.mul.fv | `eog_mul` | Verify | T0.1, T0.3 | fpga-verify agent | CLAIMED | |
| T1.div.rtl | `eog_div` | RTL | T0.1 | fpga-rtl agent | REVIEW | `eog/T1.div.rtl` 0a5a100 (lint/iverilog/yosys clean, LAT = NW+1) |
| T1.div.fv | `eog_div` | Verify | T0.1, T0.3 | fpga-verify agent | CLAIMED | |
| T1.unpack.rtl | `eog_unpack` | RTL | T0.1 | | TODO | |
| T1.unpack.fv | `eog_unpack` | Verify | T0.1, T0.3 | | TODO | |
| T1.validate.rtl | `eog_validate` | RTL | T0.1 | fpga-rtl agent | CLAIMED | |
| T1.validate.fv | `eog_validate` | Verify | T0.1, T0.2, T0.3 | fpga-verify agent | CLAIMED | |
| T1.features.rtl | `eog_features` | RTL | T0.1, T1.mul.rtl | | TODO | |
| T1.features.fv | `eog_features` | Verify | T0.1, T0.2, T0.3 | fpga-verify agent | CLAIMED | |
| T1.memory.rtl | `eog_memory` | RTL | T0.1 | fpga-rtl agent | REVIEW | `eog/T1.memory.rtl` 560ee3b (lint/iverilog/yosys clean, II 3, latency 2) |
| T1.memory.fv | `eog_memory` | Verify | T0.1, T0.2, T0.3 | fpga-verify agent | CLAIMED | |
| T1.countdown.rtl | `eog_countdown` | RTL | T0.1, T1.mul.rtl, T1.div.rtl | | TODO | |
| T1.countdown.fv | `eog_countdown` | Verify | T0.1, T0.2, T0.3 | | TODO | |
| T1.head.rtl | `eog_head` | RTL | T0.1, T1.mul.rtl | | TODO | |
| T1.head.fv | `eog_head` | Verify | T0.1, T0.2, T0.3 | | TODO | |
| T1.alarm.rtl | `eog_alarm` | RTL | T0.1 | fpga-rtl agent | CLAIMED | |
| T1.alarm.fv | `eog_alarm` | Verify | T0.1, T0.2, T0.3 | | TODO | |
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
