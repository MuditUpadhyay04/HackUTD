# FPGA task board

Claim a task by writing your agent/session name in **Owner** and setting **Status** to CLAIMED, in the same
commit as your first work. Statuses: TODO · CLAIMED · BLOCKED · REVIEW · DONE. A task can start only when every
task in **Needs** is DONE (a Verify task may start writing properties before its vectors exist; it needs T0.2 only
to finish simulation). Rules: `AGENTS.md`. Spec: `spec/` (FROZEN v3).

**Branches on Windows:** `fpga/<task-id>` cannot coexist with the `FPGA` branch on a case-insensitive filesystem, so
task branches are named `eog/<task-id>` (e.g. `eog/T1.validate.rtl`). **Status edits:** only the lead edits this
file during a wave (agents report status in their final message) to avoid merge conflicts.

## Wave 0 — lead

| ID | Task | Needs | Owner | Status | Output |
| --- | --- | --- | --- | --- | --- |
| T0.1 | Freeze the spec (decisions D1–D5, conventions, numerics, regmap, 12 module specs, `rtl/eog_defs.svh`) | — | Claude (Lucas's session) | DONE | `spec/` v1 |
| T0.2 | Bit-exact model + reference ingest + vectors (`model/README.md`) | T0.1 | fpga-model agent (lead session) | DONE | `model/`, `tb/vectors/`; b873096, merged f9c083b; `python FPGA/model/test_model.py` 13 passed / 0 failed (R1 worst \|p50 − trips_at\| 2.0 min at all 13 onsets) |
| T0.3 | `formal/common/` (abstract multiplier, handshake/stage property macros); check `scripts/*.sh` against the installed tools | T0.1 | lead | DONE | `formal/common/` (checker modules, abstract mul, self-test), `scripts/env.sh`, `scripts/wsl.sh`; 5d34900; `reports/formal_common.txt`, `reports/formal_axi_mul.txt` |
| T0.4 | Spec v4: align with Mudit's `features_int.py` (numerics.md §1 D6–D12, Lucas's calls Sun 00:10) | T0.1 | Claude (Lucas's session) | DONE | `spec/` v4, `spec/README.md` changelog |
| T0.0 | **Mudit:** apply `spec/numerics.md` §11 to `ml/hutd_ml`, regenerate weights + golden sets G0/G1/G2 | T0.4 | Mudit | TODO | branch `ml` |
| T0.5 | **Mudit:** R7 option C (spec question 70) in `features_int.py`; regenerate weights + golden sets; re-run `robustness.py` and report the 2 %-missing numbers | Q70 | Mudit | DONE | ml@59f3746 (R7 option C + regenerated golden sets); verified by `check_mudit.py` (lead run) |
| T0.2c | `model/` + vectors for spec question 70 (R7 option C); `check_mudit.py` PASS against Mudit's T0.5 | Q70 (finish on T0.5) | fpga-model agent | DONE | faa98eb (merged e632fda) + T0.2d 7c3ff04 (merged 31bf8a2; g2 sets from Mudit's T0.5 @ 59f3746, 41 records); `test_model.py` 15/15; `check_mudit.py` full run exit 0, no gaps (re-run by the lead: every case, week, and all 8 golden sets incl. v2/v3 G1 byte-equal) |
| T0.2b | Update `model/` (`eog_ref.py`, `cases.py`, `gen_vectors.py`, `test_model.py`) to spec v4; add `check_mudit.py` (byte-for-byte RESULT/ALERT agreement with Mudit's engine, see `model/README.md`); regenerate `tb/vectors/` | T0.4 (finish on T0.0) | fpga-model agent | DONE | 097f0a1, merged adf6dcb (vectors 388eb6e merged d1e29fc); model = Mudit @ d1ba779 byte for byte; `check_mudit.py` full run PASS (38 checks, every case + all 5 golden sets incl. G1 30,240 records); `test_model.py` 14/14 |

## Wave 1 — parallel, two agents per module (RTL and Verify never share a branch)

| ID | Module (spec) | Role | Needs | Owner | Status | Report |
| --- | --- | --- | --- | --- | --- | --- |
| T1.mul.rtl | `eog_mul` | RTL | T0.1 | fpga-rtl agent | DONE | 3919c2e, merged caf9580; `reports/formal_mul.txt`, `reports/sim_mul.log` (PASS 736,704 products, 36 configurations) |
| T1.mul.fv | `eog_mul` | Verify | T0.1, T0.3 | fpga-verify agent | DONE | 8b25855, merged caf9580; `reports/formal_mul.txt` (prove, prove_w, bmc_feat, bmc_head, cover PASS) |
| T1.div.rtl | `eog_div` | RTL | T0.1 | fpga-rtl agent | DONE | 0a5a100, merged 1565f11; `reports/formal_div.txt`, `reports/sim_div.log` (PASS 19,123 divisions) |
| T1.div.fv | `eog_div` | Verify | T0.1, T0.3 | fpga-verify agent | DONE | 0ee19ef, merged 1565f11; `reports/formal_div.txt` (prove/bmc/cover PASS) |
| T1.unpack.rtl | `eog_unpack` | RTL | T0.1 | fpga-rtl agent | DONE | bc4a760, merged into FPGA via `eog/integrate-unpack`; `reports/formal_unpack.txt`; sim PASS 108,846 records / 653,031 beats (13 cases x 3 runs) |
| T1.unpack.fv | `eog_unpack` | Verify | T0.1, T0.3 | fpga-verify agent | DONE | 99fef58, merged via `eog/integrate-unpack`; `reports/formal_unpack.txt` (prove = abc pdr unbounded, bmc depth 14, cover PASS) |
| T1.validate.rtl | `eog_validate` | RTL | T0.1, T0.4 | fpga-rtl agent | REWORK R7 | **R7 rework done at 7353342** (step 5 only: hold_run cap 3, overflow → INVALID + FIELD_LOST, no history reset; self-check vs a transcription of #70 PASS, 55k records); waiting for T0.2c vectors. Previous: 4876df8 merged 86b93eb |
| T1.validate.fv | `eog_validate` | Verify | T0.1, T0.2, T0.3, T0.4 | fpga-verify agent | REVIEW | `eog/T1.validate.fv` f4b8f30 (R7 #70/#71; integration `eog/integrate-validate-r7` running) |
| T1.features.rtl | `eog_features` | RTL | T0.1, T1.mul.rtl, T0.4 | fpga-rtl agent | DONE | 0a84769, merged 78b2a21 via `eog/integrate-features-v4`; `reports/formal_features.txt`; sim PASS 133,420 records (18 v4 cases) |
| T1.features.fv | `eog_features` | Verify | T0.1, T0.2, T0.3, T0.4 | fpga-verify agent | DONE | 735fef2, merged 78b2a21; `reports/formal_features.txt` (cover, prove, prove_f4 PASS) |
| T1.memory.rtl | `eog_memory` | RTL | T0.1, T0.4 | fpga-rtl agent | REVIEW | **Spec v4: re-read the module spec + numerics.md; vectors after T0.2b.** `eog/T1.memory.rtl` 560ee3b (lint/iverilog/yosys clean, II 3, latency 2) **v4 done: ac38fd3** (merge ddfc52c); bit-exact on all 15 v4 memory vector cases (6,230 records); latency 2, II 3 |
| T1.memory.fv | `eog_memory` | Verify | T0.1, T0.2, T0.3, T0.4 | fpga-verify agent | CLAIMED | **Spec v4: re-read the module spec + numerics.md; vectors after T0.2b.** |
| T1.countdown.rtl | `eog_countdown` | RTL | T0.1, T1.mul.rtl, T1.div.rtl, T0.4 | fpga-rtl agent | REVIEW | `eog/T1.countdown.rtl` 8b386e5 (v4 + rulings #20/#21; bit-exact on all 18 v4 countdown cases; latency 57, P = 4 at II 16) |
| T1.countdown.fv | `eog_countdown` | Verify | T0.1, T0.2, T0.3, T0.4 | fpga-verify agent | REVIEW | `eog/T1.countdown.fv` fc085b1 (v4 + #20/#21; default tasks prove/bmc/cover; integration `eog/integrate-countdown` running) |
| T1.head.rtl | `eog_head` | RTL | T0.1, T1.mul.rtl, T0.4 | fpga-rtl agent | REVIEW | `eog/T1.head.rtl` 5358207 (v3 + v4 + rulings #23/#25; bit-exact on all 18 v4 head cases; latency 12, II 13; 16 DSP48E1 estimate) |
| T1.head.fv | `eog_head` | Verify | T0.1, T0.2, T0.3, T0.4 | fpga-verify agent | REVIEW | `eog/T1.head.fv` 6b3b218 (v4; integration `eog/integrate-head`: lint ok, sim PASS 134,226 records + 10,336 debug captures on 23 cases; formal running) |
| T1.alarm.rtl | `eog_alarm` | RTL | T0.1, T0.4 | fpga-rtl agent | DONE | ea519d9, merged via `eog/integrate-alarm`; `reports/formal_alarm.txt`; sim PASS 200,130 records / 1,236 ALERTs (18 v4 cases x 3 modes incl. dropped ALERTs, BTN0 acks) |
| T1.alarm.fv | `eog_alarm` | Verify | T0.1, T0.2, T0.3, T0.4 | fpga-verify agent | DONE | 0cf99c7, merged via `eog/integrate-alarm`; `reports/formal_alarm.txt` (prove, bmc_seq, bmc_ack, bmc_mod, bmc_a8, cover PASS) |
| T1.pack.rtl | `eog_pack` | RTL | T0.1 | fpga-rtl agent | REVIEW | `eog/T1.pack.rtl` 9e684bc (v4; latency 1, 4 beats/record at 1 beat/cycle; smoke PASS all 19 pack_* cases incl. week/g1; #25 is owned upstream, pack copies) |
| T1.pack.fv | `eog_pack` | Verify | T0.1, T0.3 | fpga-verify agent | CLAIMED | v4 from the start |
| T1.regs.rtl | `eog_regs` | RTL | T0.1, T0.4 | fpga-rtl agent | REVIEW | `eog/T1.regs.rtl` ac0d183 (v4 full regmap: CTRL/GLOBAL/LEDOVR/DBGSEL, CONFIG table, DATA window, RESULT/ALERT FIFOs, STATS, DBG, 71-word weight window; smoke PASS 447 regs_basic ops + directed; xc7 estimate ~2.3k LUT, ~1.7k LUTRAM, 2,466 FF, 1 RAMB36) |
| T1.regs.fv | `eog_regs` (reuse the `axi_mul` AXI-Lite properties) | Verify | T0.1, T0.3, T0.4 | fpga-verify agent | CLAIMED | v4 from the start |

Priority when capacity is limited: mul, div → validate, features, head → memory, countdown, alarm → unpack, pack, regs.

## Wave 2 — integration

| ID | Task | Needs | Owner | Status | Output |
| --- | --- | --- | --- | --- | --- |
| T2.top | `rtl/eog_top.sv` + bounded top proof + full-practice-week sim vs `model/` (`spec/modules/eog_top.md`) | all T1 DONE | | TODO | |
| T2.ps1 | ARM app v1 (`ps/eog_app.c`): UDP 7000/7003/7004/heartbeat → AXI-Lite windows, RESULT/ALERT/STATS packets back; keep `udp_mul.c` on 7777 | T0.1 | integration agent | DONE | 4251f8e, merged d658d41: `ps/eog_proto.{c,h}` (portable protocol + HAL), `ps/eog_app.c` (lwIP glue, unity build with udp_mul.c), `deploy/win_vitis_build_eog.bat`; host tests re-run by the lead: `bash FPGA/ps/test/run_tests.sh` PASS (C unit tests, 90 wire byte-compares vs Mudit wire.py on G0/G1/G2, loopback vs `hutd_ml.board` incl. 7 s heartbeat gap). Vitis build + board run → T2.bd1/T2.board1 |
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
| 16 | head | Spec conflict: conventions §1 / head spec say soft reset keeps the weight banks, but `eog_head` only gets the engine reset `rst_n & ~soft_rst` | (RTL agent implemented: any reset clears VER in both banks; alternative: separate hard-reset port) | T1.head.rtl | **Spec v3:** new input `eog_head.wb_rst_n` = raw `rst_n` (hard reset only) resets word 70 (v4; was 68) of both banks, `active_bank`, `swap_pending`; `rst_n` (incl. soft reset) only flushes the record in flight; writes ignored while either reset is 0; a pending swap waits for `rst_n` = 1. Internal port only, no wire-format/numerics change. Lucas may reverse |
| 17 | head | `swap_req` while `swap_pending` = 1, including the cycle the swap executes | Merges with the pending swap (one swap); the ARM waits for `swap_pending` = 0 before writing the next image | T1.head.rtl | Accepted |
| 18 | head | Pending swap vs accepting the next record in the same idle cycle | The swap wins; `in_ready` = 0 for that one cycle (II still ≤ 16) | T1.head.rtl | Accepted |
| 19 | head | `CH3` for DROPPED records | Copied from `FEAT[3]` like every status (upstream already zeroes FEAT for DROPPED), as the head spec and the model do | T1.head.rtl | Accepted |
| 20 | countdown | Ring contents: signed `INFLOW` (numerics §7) or `max(INFLOW, 0)` (Mudit 8e67750)? | Clamp: the ring holds `max(INFLOW, 0)` | Mudit (T0.0 cross-check) | **Lucas (final, Sun 01:17): matches Mudit's `features_int.py` @ 8e67750; overrides the `numerics.md` v4 text, no version bump.** |
| 21 | countdown | `NOT_FILLING` when `LEVEL ≥ SHUT_LVL` | p10 = p50 = p90 = 0 **and** `NOT_FILLING = 0` | Mudit (T0.0 cross-check) | **Lucas (final, Sun 01:17): matches Mudit's `features_int.py` @ 8e67750; overrides the `numerics.md` v4 text, no version bump.** |
| 22 | alarm | ALERT `SOURCE` per kind | NS_RAISED: bit 0 `RULES[3:0] ≠ 0`, bit 1 any class active, bit 2 autonomous. ES_RAISED: bit 0 = 1 (gap rule), bit 1 any class active, bit 2, bit 4 = 1. CLEARED: only bits 2 and 4. ACKED: only bit 4 (#4) | Mudit (T0.0 cross-check) | **Lucas (final, Sun 01:17): matches Mudit's `features_int.py` @ 8e67750; overrides the `numerics.md` v4 text, no version bump.** |
| 23 | validate, head | Reason bits 11 `FIELD_ABSENT`, 13 `NO_MODEL`, 14 `FIELD_LOST` (removed in v4 §6) | Restored, with the set/clear rules of `features_int.py` @ 8e67750 (Mudit lists them in `ml/README.md`); `eog_ref.py` must match his code byte for byte | Mudit (T0.0 cross-check) | **Lucas (final, Sun 01:17): matches Mudit's `features_int.py` @ 8e67750; overrides the `numerics.md` v4 text, no version bump.** |
| 24 | validate | `HIST_RESET` on a facility's first record (v4 §3: not flagged after power-up/soft reset) | A facility's first record (no `last_ts`) is a new history: `HIST_RESET` = 1, reason bit 2 | Mudit (T0.0 cross-check) | **Lucas (final, Sun 01:17): matches Mudit's `features_int.py` @ 8e67750; overrides the `numerics.md` v4 text, no version bump.** |
| 25 | validate, head, pack | DROPPED `SINCE_RESET` / `WVER` (v4 §3 step 3: DUPLICATE/OUT_OF_ORDER carry the current `SINCE_RESET`; `WVER` = active version) | Every DROPPED RESULT has `SINCE_RESET = 0` and `WVER = 0` | Mudit (T0.0 cross-check) | **Lucas (final, Sun 01:17): matches Mudit's `features_int.py` @ 8e67750; overrides the `numerics.md` v4 text, no version bump.** |
| 26 | unpack | P5 "with out_ready = 1" window | out_ready = 1 in the last-beat cycle and the 2 after; s_ready never low 2 cycles in a row, counted from the first cycle after reset | T1.unpack.fv | Accepted |
| 27 | unpack | "accept a beat every cycle while out_ready = 1" | out_ready = 1 for 3 consecutive cycles → s_ready = 1 (one bubble allowed when back-pressure releases) | T1.unpack.fv | Accepted |
| 28 | unpack | "holds at most one record … second buffer optional" | At most 2 records held, counting a partial one | T1.unpack.fv | Accepted |
| 29 | unpack | May a record be presented in the cycle its last beat is accepted? | Allowed (the RTL presents it the next cycle) | T1.unpack.fv | Accepted |
| 30 | unpack | Beats during reset | `s_valid && s_ready` while `rst_n` = 0 is not a transfer | T1.unpack.fv | Accepted |
| 31 | alarm | v4: HIST_RESET on an INVALID record | Clears the persistence counters only; NS/ES conditions and latches stay, so the next VALID/HELD record with the condition false emits CLEARED | T1.alarm.rtl | Accepted: T0.2b confirmed from Mudit's `reset_history` (counters, memory, ring and last_valid clear; ns/es conditions and latches survive) |
| 32 | alarm | v4: ACKED SOURCE bit 2 (autonomous) | 0, as in #4 (ACKED carries only bit 4 = latch type) | T1.alarm.rtl | Settled by #22 (ACKED: only bit 4) |
| 33 | countdown | v4: K·Δ width (spec says 24 × 17) | Full 32-bit K_CD × 17 (exact for any K_CD; identical for K_CD < 2^24, which ingest enforces) | T1.countdown.rtl | Accepted (no numerics change in the valid range) |
| 34 | countdown | v4: HIST_RESET clears the ring on status codes 2/5/6/7 | Yes, literal "non-DROPPED"; those codes are never produced | T1.countdown.rtl | Accepted |
| 35 | validate | `d = TS − last_ts` width | Exact 33-bit signed difference, as in `features_int.py` (a 32-bit wrap would turn jumps ≥ 2^31 s into OUT_OF_ORDER) | T1.validate.fv | Accepted (Mudit's code decides) |
| 36 | validate | Is a slot's first record after power-up/soft reset flagged? | — | T1.validate.fv | Superseded by #24: the first record (no `last_ts`) gets `HIST_RESET` = 1 |
| 37 | validate | INVALID outputs | Only observed-OK values (0 for the rest, held fields included); FLD_OK/WELLS_OK show observed OK. VALID/HELD: FLD_OK = 7F, WELLS_OK = 1 | T1.validate.fv, T1.validate.rtl | Accepted (RTL and verifier agree; bus V only, so the model must match) |
| 38 | validate | Re-check of #12 under v4 | PUMP_INCONS/WELL_INCONS only on VALID/HELD (Mudit computes them after the INVALID return) | T1.validate.fv | Accepted (Mudit's code decides; replaces #12's "only when inputs OK") |
| 39 | validate | DROPPED payload | All values, FLD_OK, WELLS_OK and PREV_* = 0; plus #25 (SINCE_RESET = 0, WVER = 0) | T1.validate.fv | Accepted |
| 40 | validate | PREV_LEVEL / PREV_OK on INVALID records | The slot's current previous level, after any reset in that record (bus V only) | T1.validate.fv, T1.validate.rtl | Accepted (RTL's answer; the model must match) |
| 41 | features | v4: SHUT_IN when n_wells = min(CFG.N_WELLS, N_WELL) = 0 | 1 for VALID/HELD (vacuous `all()` in `features_int.py`; ingest refuses N_WELLS = 0, so only proofs/fuzz see it) | T1.features.rtl | Accepted (Mudit's code decides) |
| 42 | all | `eog_defs.svh` has no names for the restored reason bits 11/13/14 | Add `EOG_R_FIELD_ABSENT` = 11, `EOG_R_NO_MODEL` = 13, `EOG_R_FIELD_LOST` = 14 and list them in numerics §6 | T1.validate.rtl | Done by the lead (gendefs regenerated; part of ruling #23, no version bump) |
| 43 | memory | v4 re-check of #2 (net_ema start) | Feature 27 is gated like the other averages: `net_ema` starts at the first VALID/HELD record's FEAT[11] (`has_net`, Mudit's `e_net is None`); M2 min/max start there, 0 not included. Replaces #2 | T1.memory.rtl | Accepted (Mudit's code decides) |
| 44 | memory | HIST_RESET on status codes 2/5–7 | Clears the slot like INVALID (literal "non-DROPPED"; same as #34); outputs FEAT[12..30] = 0 | T1.memory.rtl | Accepted |
| 45 | validate | Pump status out of LO[2]/HI[2] | Enum check {0,1,2} first (ILLEGAL_ENUM), then range (OUT_OF_RANGE) | T0.2b | Accepted (Mudit's code; validate RTL does this) |
| 46 | head | `S_OUT = 0` | Spec stands: no rounding constant, no shift (RTL does this). Mudit's Python raises on `1 << -1`; his `quantize` never emits 0 | T0.2b, T1.head.rtl | **Open for Mudit:** guard `S_OUT = 0` in `features_int.py` |
| 47 | head | `S_OUT` > 31 (Mudit's `quantize` can emit up to 36) | The head RTL uses the whole byte exactly (S_OUT ≥ 48 gives 0), so any value works; H6 covers 0..31 | T0.2b, T1.head.rtl | Accepted (no change needed) |
| 48 | ingest | N_WELLS > 8 | Clamped to 8 (#14); Mudit's engine raises there; ingest refuses > 8 | T0.2b | Note for Mudit |
| 49 | docs | `model/bus_vectors.py` named in `eog_top.md` / `ml_assumptions_response.md` | The golden-set conversion lives in `model/gen_vectors.py` | T0.2b | Fixed in `eog_top.md`; `ml_assumptions_response.md` left as sent |
| 50 | head | Logit gating: Mudit uses the full integer weights version, the FPGA the u8 `VER` | Equal for versions 1..255; keep weight versions in 1..255 | T0.2b | **Open for Lucas/Mudit** (no RTL change if versions stay ≤ 255) |
| 51 | head | Debug capture (D12) vectors | No dedicated file: `dbg_valid` = VALID/HELD and FAC == `dbg_fac`, payload from the head vectors | T0.2b | Accepted |
| 52 | head | `swap_req` during an engine-only reset (`rst_n` = 0, `wb_rst_n` = 1) | Taken (`swap_pending` rises); the swap executes once `rst_n` = 1 | T1.head.rtl | Accepted |
| 53 | alarm | A8 debounce tolerance with a free-running ms tick | ±1 ms (as #9) | T1.alarm.fv | Accepted |
| 54 | alarm | Pmod/LED output timing | May lag state by 1 cycle; `hb_toggle` 1–2 cycles after `hb_pulse`; `ms_since_hb`/`autonomous` exact | T1.alarm.fv | Accepted |
| 55 | alarm | Records open in the stage | At most 2, counting ALERTs not yet pushed (RTL keeps 0/1) | T1.alarm.fv | Accepted |
| 56 | alarm, countdown, memory | Codes 2/5–7 with HIST_RESET | Per stage: alarm changes no state (#10); countdown (#34) and memory (#44) clear. Never produced by validate; the model does the same | T1.alarm.fv, T0.2b | Accepted |
| 57 | pack | The vectors never produce a batch-only `m_last` (IN_LAST is set wherever m_last is) | Add a pack case with IN_LAST = 0 on most records (model follow-up); formal K3 covers it meanwhile | T1.pack.rtl | Open (model follow-up) |
| 58 | pack | `tap_valid` timing | Same cycle as the beat-3 transfer | T1.pack.rtl | Accepted |
| 59 | regs | STATS 0 "records in" in DMA mode | Counts DATA-window records only (6th beat accepted); regs has no view of DMA input | T1.regs.rtl | **Open for T2.top:** add an input-record tap from `eog_unpack` to regs if DMA-mode counting is wanted |
| 60 | regs | STATS 10 "alerts raised" vs drops | Word 10 counts alerts pushed into the FIFO; word 11 counts drops (incl. `al_valid` while full) | T1.regs.rtl | Accepted |
| 61 | regs | STATS 15 uptime tick | New parameter `CYC_PER_MS`; uptime cleared by reset, soft reset and `stats_clear` like all 16 | T1.regs.rtl | Accepted |
| 62 | regs | Weight-window WSTRB (eog_head has no byte enables) | Partial strobes are read-modify-write via `wb_rdata`; a swap in the one cycle between would merge with the other bank (the ARM waits for `swap_pending` = 0) | T1.regs.rtl | Accepted |
| 63 | regs | CONFIG after hard reset | Zero-filled by an N_FAC-cycle sweep; AXI not served during it | T1.regs.rtl | Accepted (matches the model) |
| 64 | regs | DBG capture across soft reset | Cleared only by hard reset; capture count wraps at 2^32 | T1.regs.rtl | Accepted |
| 65 | regs | DATA window while busy / in DMA mode | Words 0–10 writable any time; only the push is dropped while busy (counted as overrun); a push while `src_dma` = 1 is ignored and not counted | T1.regs.rtl | Accepted |
| 66 | regs | VERSION[23:16] (N_WELL) | New parameter `N_WELL` (default 8) | T1.regs.rtl | Accepted |
| 67 | ps (T2.ps1) | ML-9: what the ARM checks before a weight swap | WEIGHTS_ACK status 3 = self-test failed **or** bad blob header (`blob_format` ≠ 1, `n_heads` ≠ 4, `n_features` ≠ 31, `feature_set_id` ≠ 1); CRC failure = 1, bad length = 2. Plan updated | Mudit (`docs/plan/mudit/fpga_spec_questions.md`) | **Lucas (Sun 01:59): ARM software only (T2.ps1); no RTL or numerics change.** |
| 68 | ps (T2.ps1) | ML-5 / ML-6: packet destinations | RESULT/STATS → 192.168.1.50:7001 and ALERT → 192.168.1.50:7002, fixed (not last sender), so buffered results have a destination after an outage. CONFIG_ACK / WEIGHTS_ACK → the sender's IP and port. HEARTBEAT accepted on 7003 from any source port (ML-7) | Mudit (`docs/plan/mudit/fpga_spec_questions.md`) | **Lucas (Sun 01:59): ARM software only (T2.ps1); no RTL or numerics change.** |
| 69 | ps (T2.ps1) | ML-11: CONFIG re-sent mid-run | RTL unchanged (writes to an enabled slot are ignored). The ARM disables the slot (word 0 with FLAGS[0] = 0), rewrites the row, re-enables it: the slot's history restarts, latches and `result_no` continue. GLOBAL CONFIG while streaming: the ARM clears `stream_en`, waits for the pipeline to drain, writes GLOBAL, sets `stream_en` again; ACK OK | Mudit (`docs/plan/mudit/fpga_spec_questions.md`) | **Lucas (Sun 01:59): ARM software only (T2.ps1); no RTL or numerics change.** |
| 70 | validate | R7: hold/reset policy under missing data (review R7, ML-12) | **Option C.** Replaces numerics §3 step 5: `hold_run = (any field held) ? min(hold_run + 1, 3) : 0`. If `hold_run > hold`: every held field becomes missing, so the record is INVALID with `FIELD_LOST` (step 7: persistence counters cleared, no memory/ring/`prev_level` update). **No history reset, no `HIST_RESET`**; `last_valid` is kept (not used while `hold_run > hold`); `since_reset` not incremented. History resets now come only from time gaps (`missing > hold`, step 3), CONFIG writes and a facility's first record. Memory, countdown and alarm RTL unchanged (they only react to `HIST_RESET`) | Lucas | **Lucas (final, Sun 02:03; the judging data will have missing readings): overrides numerics.md v4 §3 step 5. Reopens validate RTL + proofs; Mudit T0.5, model T0.2c.** |
| 71 | validate | #70: FIELD_HELD (bit 0) on a hold-limit record | 0: the held fields have become missing (old code's `held = []`); record keeps the current SINCE_RESET, HIST_RESET = 0, PREV_* unchanged | T1.validate.rtl | Proposed; model T0.2c follows it; **Mudit's T0.5 should match** |
| 72 | ps | STATS packet (wire.py) vs STATS registers (regmap) | Different layouts; the ARM translates: `engine_busy_cycles` ← STATS word 13 (output stall cycles); `results_out` = what the ARM sent; `uptime_s`, `data_seq_gaps`, `bad_packets`, `mode`, `replay_waiting` from the ARM; DATA overruns, framing drops and dropped alerts are not on the wire | T2.ps1 | Accepted (wire.py wins on the wire) |
| 73 | docs | GLOBAL layout in `docs/plan/lucas/fpga_hardware_plan.md` (byte 18 flags, 19–31 reserved) is older than numerics §10 / wire.py (bytes 20–23 = PERSIST_K4) | Update the plan's table | T2.ps1 | **Open for Lucas** (his plan doc) |
| 74 | ps | ALERT SOURCE bit 3 (ARM replay) | Set by the ARM on replayed alerts (numerics + wire.py `SRC_ARM_REPLAY`); Mudit's fakeboard doesn't set it | T2.ps1 | Accepted; note for Mudit's fakeboard |
| 75 | ps | WEIGHTS commit with a bad blob header | ACK status 3 (#67); Mudit's fakeboard raises without an ACK | T2.ps1 | Accepted; note for Mudit's fakeboard |
| 76 | ps | WEIGHTS commit while a swap is stuck | ACK status 0 (accepted, not swapped); no status code covers it | T2.ps1 | Proposed |
| 77 | ps, wire | Server-side latch acknowledge: the plan mentions it, but there is no wire message, so `CTRL.server_ack` is never pulsed | — | T2.ps1 | **Open for Lucas/Jason** (needs a wire message, C2 change) |
| 78 | head | II across a swap | No exception: II ≤ 16 holds with a pending swap (RTL: 14) | T1.head.fv | Accepted |
| 79 | head | Swap deadline after a record boundary | Within 16 cycles | T1.head.fv | Accepted |
| 80 | head | `swap_pending` timing | Registered or combinational in the request cycle; an immediate swap may never show `swap_pending` = 1 | T1.head.fv | Accepted (clarification) |
| 81 | head | Readback | Exactly 1 cycle after `wb_raddr`, all 32 bits of words 0–70, works during soft reset; read-during-write and reads across a swap edge unspecified | T1.head.fv | Accepted |
| 82 | head | Harness write assumptions (word 70 [31:8] = 0, S_OUT ≤ 31, no writes ≥ 71) | Proof restrictions only. The ARM writes word 70 = version & 0xFF; S_OUT may exceed 31 (#47: RTL handles 0–255) | T1.head.fv | Accepted as proof-only |
| 83 | head | `dbg_valid` timing | Once per qualifying record, no later than its output transfer; `dbg_fac` stable while a record is in flight | T1.head.fv | Accepted |
| 84 | head | N_FEAT < 31 | Proof-only; the window layout stays fixed | T1.head.fv | Accepted |
| 85 | head | In-flight bound | 4 (RTL keeps 1) | T1.head.fv | Accepted |
| 86 | countdown | Stale text: numerics §7 and module C2/C4 still say signed INFLOW and "NOT_FILLING = mean ≤ 0 when tripped" | Rulings #20/#21 govern; update the text, no version bump | T1.countdown.fv | Accepted; text fix by the lead |
| 87 | countdown | HIST_RESET on DROPPED | Never set (conventions v4); bus contract | T1.countdown.fv | Accepted |
| 88 | countdown | VALID/HELD with FAC ≥ N_FAC | 3 × 0xFFFF, NOT_FILLING = 0, no state change (#1) | T1.countdown.fv | Accepted |
| 89 | model | `sat` case description says "signed inflow ring" | Fix wording (vectors already follow #20) | T1.countdown.fv | Sent to the model agent |
