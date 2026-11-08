# RTL done: handoff to the board machine

For Lucas and the board-machine (laptop) session. Written by the FPGA lead, Sun Nov 8 2026, branch `FPGA` (all module
work merged by `7845154`). Spec **v4** plus Lucas's rulings and the spec questions in `FPGA/TASKS.md` (1–101). The
detailed laptop steps are in `FPGA/LAPTOP_WORKORDER.md` (including its SD-boot section). The open board findings and
their proposals are in `FPGA/reports/LEAD_board_response.md`.

## 1. Status

- **All 11 engine modules are DONE on spec v4:** mul, div, unpack, validate (with R7 option C), features, memory,
  countdown, head, alarm, pack and regs. Each module's RTL and its independent proofs and testbench were merged on an
  integration branch, then signed off by lint, `sim.sh` and every task of `formal.sh`.
- **T2.top** (`rtl/eog_top.sv`) is REVIEW: the simulation is complete, and the top-level formal proof is not closed (§3).
- **Model:** the bit-exact model (`FPGA/model/`) matches Mudit's `features_int.py` @ 59f3746 byte for byte.
  `check_mudit.py` passes with no gaps on every case and all 8 golden sets, including G1 for v2 and v3 (30,240
  records each).
- **ARM app** (`FPGA/ps/`) and **SD boot with default weights** (T2.ps1, T2.sd) are host-tested:
  - `run_tests.sh`: 365 unit tests, 90 wire byte-compares against Mudit's `wire.py`, a loopback against
    `hutd_ml.board`, and the SD-boot tests.
- **Final regression:** `bash FPGA/scripts/check_all.sh` on the final `FPGA`, with results in `reports/SUMMARY.md`.

## 2. Sign-off standard

Agreed with Lucas; the full text is in `FPGA/TASKS.md`, "Sign-off standard".

| Tier | What it covers | How it's shown |
| --- | --- | --- |
| Proven, unbounded | Control and data routing | k-induction or PDR |
| Bounded | History and real arithmetic | bmc from reset; each task is non-vacuous (a cover reaches a real output within the depth) |
| Simulated bit-exact | End-to-end numbers | All vector cases, under random back-pressure, with the model byte-equal to Mudit's engine |

Rules: UNKNOWN is never PASS, and no property was weakened to pass.

## 3. What is proven and simulated, per module

Property IDs refer to each module spec's "Required properties". Depths and harness restrictions are in each `.sby`.

| Module | Proven, unbounded | Bounded (depth) | Simulated bit-exact | Not closed |
| --- | --- | --- | --- | --- |
| mul | P1, P2, A1 (`prove`, `prove_w`) | `bmc_feat`, `bmc_head` | 736,704 products, 36 configurations, every sign mode, LAT 0–2 | — |
| div | P1–P4, P3_r (`prove`) | `bmc` | 19,123 divisions | — |
| unpack | P1–P5, B_hold, B_rate (PDR, unbounded) | `bmc` 14 | 108,846 records / 653,031 beats (13 cases × 3 runs) | — |
| validate | Stage contract; V1–V4, V7, V9 (#13), V10; RSN/HDR/STS/VAL/INC (k-induction 6) | V3/V5/V6/V8/V9/V11/V12 + the REF model of every output bit (`bmc` 14 narrow, `bmc_w` 12 full width) | 134,268 records (23 cases × 2, including hold_h0–h2 and Mudit's goldens) | bmc covers up to 6 records per slot |
| features | Stage contract, F1–F3, F5, F6, B_* (k-induction 20); F4 rounding and saturation with a stand-in multiplier (`prove_f4`) | — | 133,420 records (18 cases × 2) | F4 with the real 20×32 multiplier (too slow); covered by the mul proof plus simulation |
| memory | Stage contract, M1, record-local M3/M4 (`prove` 20) | M2–M6 history (`bmc` 18); exact averages (`bmcarith` 20); the spec cover (`cover64` 240) | 67,134 records (23 cases × 3 passes) | — |
| countdown | Stage contract (k-induction 12, using the RTL's opt-in `EOG_FV_RECNO_SEQ`) | C1–C5 record-local and history, with `st_ii` (`bmc` 70); 9 covers (`cover` 85) | 67,134 records (23 cases × 3), including the R1 onsets | Optional tasks `bmc_pass`, `bmc_arith` (C6 exact quotients, C5 ordering), `prove_one`, `bmc_deep`/`cover_wrap` (wrapped ring, latency); covered by simulation and the div proof |
| head | Stage contract, H2, H3, H4, H8 per cycle with #94 (k-induction 24, closes at 10) | H1/H6 (`bmc_bank` 16), readback (`bmc_rb` 8), H5/H7 at N_FEAT 3 (`bmc_h7` 13, `bmc_arith` 12; the first predicted logit is at step 11, so the checks are non-vacuous) | 134,226 records + 10,336 debug captures (23 cases × 2) | Full 31-feature sums (simulation); `H8_once`/`H8_logit_b`/`H8_live` (bmc only, unbounded stalls) |
| alarm | Stage contract, AL handshake, A3/A4 at the output, A6, A7 (`prove` 20) | ALERT sequence A1/A2/A4/A5/A9 (`bmc_seq` 14), the ACKED sweep (`bmc_ack` 18), the model (`bmc_mod` 14), debounce A8 (`bmc_a8` 20) | 200,130 records + 1,236 ALERTs (18 cases × 3, including dropped ALERTs and BTN0 acks) | bmc environment narrowed (FV_TIE, FV_HITS, acks only while quiet) |
| pack | K1–K4, B_rate, stage contract (PDR) | `bmc` 20 | 268,536 records / 1,074,144 beats (23 cases × 4, including a batch-only `m_last` run) | — |
| regs | G1–G7 and the register map (12 PDR tasks) | `bmc` 14 | 22,102 checks (regs_basic vectors + directed G5/G6/G7) | STATS saturation (proven up to 15); the #99 environment limits |
| top | — | — | Full week 30,240 records + 101 ALERTs in window **and** DMA mode; G1 30,240 + 130 ALERTs; goldens g0/g2 (v0/v2/v3); every synthetic case in both modes; soft-reset passes; the T2 output-routing property checked every cycle | Top formal T1/T2 (a bounded proof needs about 200 steps per record) |

Common checkers: `formal/common` and `axi_mul` are PASS.

## 4. Resources and timing

Estimates are labelled as such; the measured numbers come from the board machine.

- **Yosys estimate** (`synth_xilinx -family xc7`, eog_top): about 14.7k logic LUTs (28 %), about 2.5k LUTRAM, about
  11.7k FF (11 %), 22 DSP48E1, 1 RAMB36.
  - **Vivado (measured on the laptop)** also maps `eog_memory` to 5 RAMB36, for 8 RAMB36 in total.
  - The proposed `ram_style = "distributed"` fix turns those 5 into LUTRAM (§5).
- **Timing (measured on the laptop):**
  - At 100 MHz: WNS **−8.075 ns**. The path is `eog_unpack.od` → `eog_validate`, 23 levels.
  - At 50 MHz: WNS **+0.548 ns** (all in validate), and the board runs at 50 MHz with `CYC_PER_MS` = 50,000.
  - A per-module 100 MHz plan has been prototyped: about 9.5 ns estimated after 7 fixes. See `LEAD_board_response.md`
    §2.
- **Throughput:** countdown accepts one record every 15 cycles, so 3.33M records/s at 50 MHz (6.7M at 100 MHz). The
  ARM UDP ceiling is 2.45M records/s.

## 5. Open items and decisions

- **Board findings, awaiting Lucas** (`LEAD_board_response.md`):
  - D1: run the B4 experiments (replay corruption; not the RTL);
  - D2: the clock (recommended: 50 MHz plus the validate pipelining fix);
  - D3: the memory `ram_style` fix;
  - D4: merge `eog/T2.bd1` (trial merge done, tests pass);
  - D5: the 50 MHz doc edits.
- **Spec questions still open:**
  - #8: BTN0 polarity, confirm on the board;
  - #46: S_OUT = 0 in Mudit's Python (Mudit to guard it);
  - #50: keep weight versions in 1–255;
  - #73: the GLOBAL table in Lucas's plan doc (integration to update);
  - #77: the server-side acknowledge message (server team).
- **Board revision:** `eog_top_io.xdc` has rev B.0 Pmod pins active; confirm the revision printed on the board.
- **Wave 3 (DMA, line rate):** not started; the engine's AXIS ports are ready and bit-exact in DMA-mode sim.

## 6. Exact steps on the board machine

The details are in `FPGA/LAPTOP_WORKORDER.md`; this is the order.

1. `git pull origin FPGA`, and fetch Mudit's `ml` branch (≥ 59f3746).
2. **PL build:** `vivado/build_eog.tcl` (from `eog/T2.bd1` once D4 is merged) at the chosen clock.
   - 50 MHz: `mhz50`, with `CYC_PER_MS` = 50,000.
   - Then: synth/impl, the WNS report, and export `C:\vb2\eclypse_eog.xsa`.
3. **PS build:** `deploy\win_vitis_build_eog.bat`. It adds xilffs and the FSBL for SD boot.
4. **SD card** (JP5 on SD, permanently):
   ```
   python FPGA/deploy/make_weights_sd.py --blob <ml>/artifacts/v3/weights.bin --version 3 --out weights.eog
   FPGA\deploy\make_boot_sd.bat <drive>
   ```
   That puts `BOOT.BIN` + `weights.eog` on the card.
5. **Acceptance** (`hutd_ml.board`, PC 192.168.1.50 ↔ board 192.168.1.10):
   - power-cycle;
   - STATS `weights_ver` = 3 before any WEIGHTS packet;
   - golden g0 / g2 / g1 byte-exact;
   - `--heartbeat-test 6` (B4, currently failing; run D1's experiments);
   - the SD negative cases;
   - BTN0, LEDs and Pmods.
6. Report back in `FPGA/reports/board_bringup.md` on `eog/T2.board1`.
