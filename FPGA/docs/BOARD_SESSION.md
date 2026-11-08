# Board-machine session context (Lucas's laptop "lucaslegion")

Read this first if you are a Claude session working on the **board machine**: the laptop with Vivado/Vitis 2026.1
and the Eclypse Z7. It holds what the previous board session (Sun Nov 8, 03:00–08:30 CST) learned.

- **The lead machine's state:** `HANDOFF.md` and `FPGA/TASKS.md`.
- **The board work order:** `FPGA/LAPTOP_WORKORDER.md`.

## Who decides what

- **Lucas owns the FPGA and makes every call.**
- **Before changing RTL or the spec:** say how big the spec change is and wait for his go.
- **ARM app changes need his approval too.** Scratch/debug builds are fine but never get committed.
- **Commit and push only when he asks.**
- **Mudit owns ML** (`ml/` on `main`). His `features_int.py` is the normative integer reference (spec v4 + rulings in
  `TASKS.md` "Spec questions").
- **Rulings:** Lucas's rulings so far are #20–25, #67–70 and the lead's #26–101. R7 = option C (#70).

## Machine setup (verified)

| Item | Where / what |
| --- | --- |
| Repo | `C:\Users\lqi20\OneDrive\Documents\GitHub\HackUTD`. The board branch is `eog/T2.bd1` (pushed; the lead merges it into `FPGA`) |
| Vitis workspaces, BOM-fixed lwIP repo | `C:\Users\lqi20\hackutd\` (`vws_eog`, `vws2`, `eswfix`). The deploy `.bat`s find them via `HUTD_WORK` (default `%USERPROFILE%\hackutd`) |
| Vivado outputs | `C:\vb2\eclypse_eog.{bit,xsa}`. The XSA has **no** bitstream inside; `EOG_BIT` points at the `.bit` |
| Mudit's code | Plain snapshots, not git: `C:\Users\lqi20\hackutd\ml_main_846463e\ml` (latest, has `board_suite`) and `ml_f07ae06\ml` |
| Practice data | `C:\Users\lqi20\hackutd\zeroday\history\full_week` (plus the mock and snapshot folders) |
| Python | `%USERPROFILE%\anaconda3\python.exe` (3.13, numpy 2.1.3, pandas 2.2.3) |
| Network | PC 192.168.1.50/24 ↔ board 192.168.1.10, direct cable. UART is COM9. Boot jumper JTAG for tests, SD for the demo. The board is **rev B** (Pmod pins = B.0 block in `eog_top_io.xdc`) |
| Running things | The Linux shell can't run Windows tools. Write a `.bat` and double-click it in File Explorer (click-only). Logs go to `FPGA\build\` (gitignored) or `FPGA\deploy\*.log`. Push with GitHub Desktop; it is signed in, the CLI isn't |

## Build and test commands (all in `FPGA\deploy` or `FPGA\vivado`)

| Script | What it does |
| --- | --- |
| `vivado\win_build_eog_50mhz.bat` | Full Vivado build at FCLK0 50 MHz (~18 min). Status in `build\eog_status.txt`, slack per module in `build\eog_module_slack.txt`. `win_build_eog.bat mhz48` for 48 MHz |
| `win_vitis_build_eog.bat` | Builds the ARM app, xilffs and the FSBL (~3 min). Outputs in `hackutd\vws_eog\out` (`eog_app.elf`, `mul_app.elf`, `fsbl.elf`, `eog.bit`) |
| `win_deploy_verify_eog.bat` | JTAG: programs the PL, runs the app, captures the UART (`uart.log`), runs the 7777 health check |
| `win_board_suite.bat` | **Mudit's full suite**: B1–B3, B5, B6, L1, L2, L3, T1. Re-programs the board before each test. Report: `build\board_suite_report.md` |
| `win_board_golden.bat`, `win_board_b4_once.bat`, `win_board_b4_repeat.bat` | Single golden / B4 runs |
| `win_live_v4.bat`, `win_live_swap.bat` | `listen.py` + `replay.py` live runs |
| `win_stats_peek.bat` | Reads the board's STATS for 4 s |
| `win_make_sd.bat [drive]` | Builds `BOOT.BIN` and stages Mudit's `ml/artifacts/v4/weights.eog`; with a drive letter, copies both to the card |

## Results (Sun Nov 8)

- **100 MHz build:** misses timing by 8.075 ns (validate). Lucas chose **50 MHz** and skipped the D2 validate fix:
  WNS +0.548 ns, 14.4k LUT, 12.2k FF, 8 BRAM, 28 DSP. If a rebuild ever fails timing, build at 48 MHz instead.
- **Mudit's board suite: 12/12 PASS** (`FPGA/reports/board_suite_v4_20261108.md`). Every RESULT and ALERT matches the
  reference on:
  - B1–B3, B5, B6;
  - the live full week;
  - the live v3→v4 swap;
  - the mock and the 3 snapshots.

  T1 throughput: 29,941 records/s end to end over the AXI-Lite path.
- **B4 (server-down replay): OPEN.**
  - **Failure:** 4–19 RESULTs per run carry the 16-byte pattern `0x624, 0x628, 0x404, 0x408` across a record boundary.
    Everything else in B4 is correct, including all ALERTs.
  - **Not the cause:**
    - the RTL;
    - the protocol logic (lead, host repro);
    - the cache (E5a);
    - the RX-reset workaround (E5b);
    - a TX pbuf hold (worse, 127 bad);
    - flushing 16 packets per poll.
  - **Passes 5/5:** a scratch debug build (per-record checksums plus holding 32 RESULT pbufs), which suggests timing
    in the lwIP/GEM TX path.
  - **Evidence:** `FPGA/build/{b4rep_*,b4exp_*,fix_try*}`; patch `FPGA/build/E2_debug_scratch.patch`.
  - **For the demo:** skip the server-down segment.
- **Fixes made on the board side (all committed):**
  - `xiltimer.h` instead of `xtime_l.h`;
  - lwIP UDP PCBs set to 8;
  - DHCP-wait patch;
  - `HUTD_WORK` paths;
  - `xilffs` link name;
  - `EOG_BIT`.
- **Reports for the team:** `FPGA/reports/board_bringup.md`, `LEAD_board_response.md` (lead, on `FPGA`).

## Gotchas

- Each JTAG re-program drops the direct-cable link for ~15 s; scripts wait for ping.
- A cached BSP `lib_list.yaml` can drop lwIP from the BSP. Fix: move it aside; it regenerates.
- cmd splits `=` in arguments: use `mhz50`, not `mhz=50`.
- The engine reads VERSION `0x00082004` = spec 4, 32 facilities, 8 wells.
- Deletion is not allowed in `C:\Users\lqi20\hackutd`. Move junk to `_to_delete_*` instead.
