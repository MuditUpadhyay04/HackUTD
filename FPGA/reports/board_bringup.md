# Board bring-up (T2.bd1 / T2.board1), Sun Nov 8 2026

Board machine: lucaslegion, Vivado/Vitis 2026.1, Eclypse Z7 over JTAG, PC 192.168.1.50 <-> board 192.168.1.10.
FPGA branch `eog/T2.bd1` (merged `FPGA` at 0d86b30, T2.top). Mudit's code: `ml` @ f07ae06 (golden sets v4).

## Build

| Item | Result |
| --- | --- |
| Baseline `axi_mul` (old bitstream) | 506/506 PASS |
| 100 MHz | **WNS -8.075 ns** (WHS +0.010). All 10 worst paths `eog_unpack.od` -> `eog_validate` (od / pl_mem), 23 logic levels, 18 ns (74 % route). Reports: `FPGA/build/run100/` (local) |
| 50 MHz bring-up (`vivado/win_build_eog_50mhz.bat`, CYC_PER_MS 50000) | **WNS +0.548 ns, WHS +0.034 ns** |
| Utilization (synth) | 14,380 LUT (27 %), 2,298 LUTRAM, 12,218 FF (11 %), 8 RAMB36, 28 DSP48E1 |

Worst setup slack per module at 50 MHz (20 ns period; data path = 20 - slack, so < 10 ns slack here would fail 100 MHz):

| Module | Slack (ns) | Levels | Note |
| --- | --- | --- | --- |
| validate | 0.548 | 28 | unpack.od -> validate.od |
| countdown | 5.230 | 4 | pay_mem LUTRAM WE |
| head | 5.442 | 21 | sout_r -> logit_q reset |
| alarm | 5.676 | 11 | head.in_r -> al_pend |
| regs | 6.308 | 4 | a_q -> sbuf reset |
| memory | 7.006 | 2 | proc_sys_reset -> in_r CE (reset/enable fan-out) |
| unpack | 7.821 | 2 | reset fan-out |
| features | 8.968 | 10 | |
| pack | 9.305 | 2 | reset fan-out |

Synthesis warning: `eog_memory` `mem_reg` (BRAM) "may get memory collision error if read and write address collide"
[Synth 8-6430]: check that the RTL never reads and writes the same slot in the same cycle.

## ARM app (PS glue fixes, no RTL change)

- Vitis 2026.1 no longer exports `xtime_l.h`: `eog_app.c` falls back to `xiltimer.h` + `xtimer_config.h`.
- lwIP `MEMP_NUM_UDP_PCB` 4 -> 8 (the app binds 7000/7003/7004/7001 next to 7777); `vitis_build.py` sets it.
- `vitis_build.py` patches the DHCP wait (direct cable); deploy scripts find `vws*`/`eswfix` in %USERPROFILE%\hackutd.
- Board: VERSION 0x00082004 (spec 4, 32 facilities, 8 wells); 7777 health check 506/506 with the EOG bitstream.

## Golden sets (Mudit's BOARD_CHECKLIST.md section 2), board re-programmed before each set

| # | Set | Result |
| --- | --- | --- |
| B1 | v4 g0 `--weights-negative` | **PASS**: CRC -> 1, length -> 2, header -> 3, self-test -> 3, model unchanged; v4 swapped; 30/30 |
| B2 | v4 g2 | **PASS**: 41/41 |
| B3 | v4 g1 | **PASS**: 30,240/30,240 RESULTs every field, 71/71 ALERTs |
| B4 | v4 g1 `--heartbeat-test 6` | **FAIL** (RESULTs); ALERTs 71/71 PASS, 26 raised while AUTONOMOUS, 26 replayed |

B4 detail: 30,240 RESULTs received; 10 records wrong. Words inside those 32 B records are overwritten with small
pairs `(0x0404, 0x0408)` or `(0x0624, 0x0628)` at 8-byte-aligned positions (e.g. result_no 15415: bytes 4-11;
16331: bytes 16-23; four records whose bytes 24-31 became 0x0624/0x0628, so they read as result_no 1576). Everything
else, including all ALERTs, matches. B3 (same data, no heartbeat gap) was clean, so this points at the ARM
buffering / replay path or memory corruption in the PS, not the engine arithmetic. Needs a rerun of B3 and B4 to see
whether it reproduces.

Earlier transient: a first B1 attempt received 0 RESULTs (STATS arrived) and a B2 attempt got no CONFIG_ACK, both
started 15 s after re-programming; the golden script now waits for ping after each re-program.

Pmod pins: `vivado/eog_top_io.xdc` uses board rev B.0 (unconfirmed). BTN0 polarity not yet checked.
