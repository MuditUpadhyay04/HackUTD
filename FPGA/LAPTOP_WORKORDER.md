# Laptop work order: get the EOG engine running on the Eclypse Z7

For a Claude Code session (and Lucas) on the board machine: the laptop with Vivado/Vitis 2026.1, the Eclypse Z7 on
JTAG, and Ethernet to 192.168.1.10. Start Claude Code in the repo root and give it this file.

## Context (read first)

- Branch **`FPGA`** (`git pull origin FPGA`). The engine is specified in `FPGA/spec/` (spec v4 plus Lucas's rulings
  in `FPGA/TASKS.md` "Spec questions"). Status lives in `FPGA/TASKS.md` and the repo-root `HANDOFF.md`.
- **You are the Integration role** (`FPGA/AGENTS.md`). You write `FPGA/vivado/`, `FPGA/deploy/`, the PS glue, and
  reports. Never edit `FPGA/spec/` or a module's `FPGA/rtl/eog_<m>.sv`, `formal/` or `tb/`.
  - If the board disagrees with the golden results, capture the record index and the RESULT bytes and report it. RTL
    fixes happen on the lead machine.
- **Commits:** on branches `eog/T2.bd1` and `eog/T2.board1`, pushed to origin. Don't edit `FPGA/TASKS.md`; the lead
  session updates it from your report.
- **What's ready on `FPGA` now:**
  - all module RTL that is DONE: mul, div, unpack, validate, features, memory, alarm, pack;
  - the ARM app: `FPGA/ps/eog_app.c` + `eog_proto.{c,h}`, host-tested byte-for-byte against Mudit's `wire.py` and
    `hutd_ml.board`;
  - the Vitis build script `FPGA/deploy/win_vitis_build_eog.bat`.
- **Also landed (T2.top, Sun ~05:00):**
  - `FPGA/rtl/eog_top.sv`, bit-exact in sim on the full week and Mudit's goldens, in both window and DMA mode;
  - `FPGA/vivado/eog_top_files.tcl` (file list) and `eog_top_bd.v` (a plain-Verilog shell, because the BD module
    reference can't take an SV top);
  - `eog_top_io.xdc` (**draft**) and `README_eog_top.md` (hookup snippet and a resource estimate);
  - the countdown, head and regs RTL, merged early. Their formal sign-off is still running on the lead machine; their
    ports are final.
  - **Phase B can start right away.**
- **Existing working flow to reuse:** `FPGA/docs/link_bringup.md` §4–5 (`axi_mul` on lucaslegion).
  - Paths: Vivado outputs in `C:\vb2`, Vitis workspaces in `..\vws2` / `..\vws_eog`, lwIP fix repo `..\eswfix`.
  - Network: PC 192.168.1.50/24, board 192.168.1.10. UART is COM9. The boot jumper must be on JTAG.

## Phase A: now (no `eog_top.sv` yet)

1. **Baseline.** Run `FPGA\deploy\win_deploy_verify.bat`; the `axi_mul` 506-vector UDP check must still pass. That
   confirms the tools, JTAG and network before anything changes.
2. **Block design `FPGA/vivado/build_eog.tcl`**, modelled on `vivado/build.tcl`. It writes `C:\vb2\eclypse_eog.xsa`.
   - PS7 from `eclypse_ps7_preset.tcl`, part `xc7z020clg484-1`, TTC0 enabled as in `build.tcl`.
   - Keep `axi_mul` on `M_AXI_GP0` at **0x43C0_0000** (UDP 7777 health check).
   - Add `eog_top` as a module reference on `M_AXI_GP0` at **0x43C1_0000**, 64 KB (16-bit AXI-Lite address). Ports
     are in `FPGA/spec/modules/eog_top.md`.
   - Clock and reset: `clk` = FCLK0 at 100 MHz; `rst_n` = `proc_sys_reset` `peripheral_aresetn`.
   - v1 uses AXI-Lite only: tie `s_axis_tvalid` = 0, `s_axis_tdata`/`tlast` = 0, `m_axis_tready` = 1. The ARM keeps
     `src_dma` = 0. DMA comes in phase D.
   - Pins: map `btn0`, `ld0[2:0]`, `ld1[2:0]` (RGB LEDs), `pmod_ja[7:0]` and `pmod_jb[7:0]` from Digilent's
     `Eclypse-Z7-Master.xdc` into `FPGA/vivado/eclypse_eog.xdc`.
   - **BTN0 polarity (TASKS #8):** `eog_alarm` expects active-high. If the board button is active-low, invert it in
     `eog_top`'s wrapper or the BD (not in `eog_alarm`) and note it in your report.
   - Use `FPGA/vivado/eog_top_bd.v` as the module reference and start from the snippet in
     `FPGA/vivado/README_eog_top.md`.
   - **Check the draft `FPGA/vivado/eog_top_io.xdc`:** the Pmod JA/JB pins differ between board revisions A.0 and
     B.0 (B.0 is active; A.0 is in a comment), so read the revision printed on the board. Confirm the LED colour order
     against Digilent's master XDC.
3. **Out-of-context synthesis of the merged modules**, to catch timing and RAM-mapping problems early.
   - Run `synth_design -mode out_of_context -part xc7z020clg484-1` with `create_clock -period 10` on each
     `FPGA/rtl/eog_<m>.sv` (include dir `FPGA/rtl`; `eog_mul.sv`/`eog_div.sv` where instantiated).
   - Report per module: worst setup slack, LUT / LUTRAM / FF / DSP48 / BRAM.
   - Watch `eog_validate` (per-facility arrays) and later `eog_countdown` (ring + FIFO). Yosys counted about 14.5k and
     17k flip-flops for them because it can't infer LUTRAM. Vivado should map them to distributed RAM; report if it
     doesn't.
   - Write the results to `FPGA/reports/board_ooc.md`.
4. Commit phase A on `eog/T2.bd1` and push.

## Phase B: real sources (`eog_top.sv` is on `FPGA`)

1. Add the sources with `FPGA/vivado/eog_top_files.tcl` (`eog_add_files`) and follow `FPGA/vivado/README_eog_top.md`
   for the hookup. Connect `eog_0/rst_n` to `peripheral_aresetn`, not `interconnect_aresetn`.
2. Full synth, implementation and bitstream.
   - **Timing at 100 MHz must close: WNS ≥ 0.** If it doesn't, report the failing paths (module, start/end points)
     and stop; RTL changes happen on the lead machine.
   - Report utilization: DSP48E1 (about 16 in head plus a few in features/countdown), LUT, LUTRAM, FF, BRAM.
3. Export `C:\vb2\eclypse_eog.xsa`, including the bitstream.
4. **Vitis:** `set EOG_XSA=C:\vb2\eclypse_eog.xsa` then run `FPGA\deploy\win_vitis_build_eog.bat` (log in
   `deploy\vitis_eog.log`; workspace `..\vws_eog`). Known risks from the host-only build:
   - the unity build and `__has_include` under Vitis;
   - the 8 MB RESULT replay ring in `.bss` may not fit the linker script (lower it with `-DEOG_RES_RING=...`);
   - lwIP needs enough MEM_SIZE / PBUF_RAM for bursts of 1.5 KB sends.
5. **Deploy:** add `FPGA\deploy\win_deploy_eog.bat`, a copy of `win_deploy.bat` pointing at the eog bitstream and the
   `vws_eog` ELF and `ps7_init.tcl`. Program, run, and capture the UART.
6. **Smoke test:** UDP 7777 (`axi_mul`) must still answer, using `deploy\win_verify.bat` or `deploy/fpga.py verify`.

## Phase C: bring-up against Mudit's golden sets (T2.board1)

1. Get Mudit's code: `git fetch origin ml && git worktree add ../ml origin/ml`. It should be at or after `59f3746`
   (R7 option C plus regenerated goldens). Then `cd ../ml/ml`.
2. Run, in order, and stop at the first failure:
   ```
   python -m hutd_ml.board --golden artifacts/v3/golden/g0
   python -m hutd_ml.board --golden artifacts/v3/golden/g2              # 41 records, exercises R7 hold overflow
   python -m hutd_ml.board --golden artifacts/v3/golden/g1              # full practice week, 30,240 records
   python -m hutd_ml.board --golden artifacts/v3/golden/g0 --heartbeat-test 6   # AUTONOMOUS + replay
   ```
   **Pass:** every RESULT equals `expected_results.bin` and every ALERT equals `expected_alerts.json`, byte for byte.
   Run the v2 sets as well (`artifacts/v2/golden/...`).
3. **Physical checks:**
   - BTN0 press → ACKED ALERTs, lowest slot first, Night Shift before E-STOP;
   - `ld0` / `ld1` colours and the 25 % PWM;
   - Pmod latch outputs;
   - STATS every 1 s on 7001.
4. **If a RESULT differs:** record the case, the record index, the expected vs got bytes and the field (the layout is
   in `FPGA/spec/numerics.md`). Check whether the same record passes in RTL sim on the lead machine, then report.
   Don't patch module RTL here.
5. Write `FPGA/reports/board_bringup.md`. Include:
   - the commands you ran and their output (pass counts);
   - timing and utilization;
   - the BTN0 polarity finding;
   - anything else that differed.

   Commit on `eog/T2.board1` and push.

## Phase D: later (line rate, T3)

- Wire AXI DMA (MM2S → `s_axis`, S2MM ← `m_axis`, scatter-gather) and switch `src_dma` = 1 only with `stream_en` = 0
  and the pipeline drained.
- Add the zero-copy ARM path, then re-measure end to end at line rate (T3.perf).

## Known open items (don't block on them)

| # | Item |
| --- | --- |
| #8 | BTN0 polarity, confirmed in phase A |
| #73 | The GLOBAL table in `docs/plan/lucas/fpga_hardware_plan.md` is stale (bytes 20–23 = PERSIST_K4). Integration updates it |
| #77 | The server-side alarm acknowledge has no wire message yet; the server team is adding it, and the ARM forwards it later |
| #50 | Keep weight versions in 1–255 (the FPGA stores 8 bits) |
| #46 | S_OUT = 0: Mudit's Python errors there, while the RTL handles it |

## Report back

At the end of each phase:
- push your branch;
- summarize these four things in your final message for Lucas:
  - the pass counts per golden set;
  - WNS and utilization;
  - the BTN0 polarity;
  - any byte-level mismatch with its case, record and field.

The lead machine merges your branch and updates `FPGA/TASKS.md` and `HANDOFF.md`.
