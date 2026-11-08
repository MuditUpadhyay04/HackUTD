# Lead response to the board findings (`LEAD_board_findings.md`)

From: the FPGA lead session. Sun Nov 8, ~07:30 CST.

Following Lucas's ground rule, **nothing was changed in RTL, spec or ARM app**. Every item below has a diagnosis, the
size of the fix and a proposal. Experiments ran only in scratch worktrees.

## Decisions needed from Lucas

| # | Decision | Lead recommendation |
| --- | --- | --- |
| D1 | Run the B4 board experiments E0–E5 (§1), including a debug ARM build kept on a scratch copy and never merged | Yes, E0 and E1 first |
| D2 | Clock: (a) 50 MHz demo, docs only; (b) 50 MHz plus the validate pipelining fix for margin; (c) the full 100 MHz plan | **(b)** for the demo; (c) later if time allows |
| D3 | `eog_memory` `ram_style = "distributed"` (1 line, §3) | Yes |
| D4 | Merge `eog/T2.bd1` into FPGA (§5); trial merge done, tests pass | Yes |
| D5 | The 50 MHz doc edits (§4), if D2 = (a) or (b) | Yes, after D2 |

## §1 B4: corrupted RESULT words during the heartbeat gap

**Diagnosis: not the RTL, and not the ARM protocol logic. Most likely the board's PS memory system or the PC's receive
side. Not yet root-caused.**

**Key clue.** The bad values are old data. Each value appears exactly once in v4 g1 `expected_results.bin`, as the
`result_no` word (bytes 28–31) of records 1028, 1032, 1572 and 1576. They appear nowhere in DATA, CONFIG or weights.
So bytes from about 14,000 records earlier reappear:
- in 8-byte patterns P1 = (1572, 1576) and P2 = (1028, 1032);
- typically as "record N bytes 24–31 = P1, then record N+1 bytes 4–11 = P2";
- at varying offsets in the 45-record packet, so the packet builder doesn't overwrite a fixed offset.

**What was ruled out:**
- **RTL (`eog_regs` RESULT window).**
  - The RESULT FIFO holds only 64 records, and those records left it about 14,000 records earlier.
  - Through the read mux, a `result_no` (the high half of beat 3) can never land in an even word, yet `0x408` appears
    in word 2. The P2 pairs also straddle 64-bit beats.
  - The read FSM serves exactly one transaction at a time. A pop happens only on `0x31C` while the FIFO is not empty.
    A same-slot read and write is only possible when the FIFO is empty (data ignored) or full (no push).
  - The top sim with the ARM's exact read sequence passes, and B3 is bit-exact on the board.
- **ARM protocol logic (`eog_proto.c`).**
  - The ring and flush index arithmetic is correct, and nothing changes at the AUTONOMOUS→NORMAL edge except the
    flush gate.
  - The packet buffer is rebuilt for every packet. There is no reentrancy, and the ring never wraps in a 30k-record run.
  - Host reproduction: the laptop's `board.py` on v4 g1, full week, heartbeat gaps of 6, 6.5, 8, 10 and 12 s, under
    ASan/UBSan, plus a run where 40 % of UDP sends fail to force the retry path. **All bit-exact and sanitizer-clean.**

**Remaining candidates.** These are what only B4 does on the board:
1. **(Most likely) PS memory system.** In B4, about 8k records (~250 KB) sit in the ring for seconds. Then up to 64
   packets go out per poll, keeping many TX pbufs from the lwIP heap in flight at once.
   - A stale cache line, a missing flush before GEM TX DMA, or a stray DMA/heap writer would all fit "old bytes at
     varying places, B4 only".
   - The 6-second receive silence also makes lwip220's `resetrx_on_no_rxdata` toggle GEM RXEN.
2. Writes into the ring `G.res` itself.
3. The PC's receive path. If the GEM offloads TX checksums, a buffer corrupted before DMA still goes out with a valid
   checksum, so the wire doesn't prove the board is clean.
4. Memory-map overlap: unlikely, since every buffer is a separate static array. It needs the board's ELF to check.

**Fix size:** unknown until located.
- If PS/BSP: `ps/eog_app.c` and/or `deploy/vitis_build.py` (lwIP, cache or linker settings), plus a host test if
  `eog_proto` changes.
- If the PC: nothing on the FPGA side.
- No RTL, spec, proofs or vectors are touched in either case.

**Proposal (D1): on-board experiments, in this order.**
- **E0. Determinism.** Rerun B3 ×2 and B4 ×2, each from a fresh board. For each bad record, record its `result_no`,
  the byte range and the value. The same records and values each time would mean a fixed-address writer (see E4).
- **E1. Wire capture: PC or board?** During B4:
  ```
  "C:\Program Files\Wireshark\dumpcap.exe" -i <direct-cable iface> -f "udp and src host 192.168.1.10 and src port 7001" -w B4.pcapng
  ```
  Then extract the RESULT payloads (16-byte header, then 32-byte records) and look up the bad `result_no`s.
  - Clean on the wire: the PC is at fault.
  - Bad on the wire: continue with E2.
- **E2. Debug ARM build** (scratch copy only, `-DEOG_DBG_CRC`, never merged):
  - In `res_push`, store an FNV-1a sum per ring slot.
  - In `flush`, recompute each slot's sum before the memcpy: a mismatch increments `ring_bad` and logs the slot and
    address.
  - After building `G.pkt`, memcmp it against the ring: a mismatch increments `pkt_bad`.
  - In `hal_udp_send`, memcmp the pbuf payload after the copy: a mismatch increments `pbuf_bad`. Then `pbuf_ref` it
    and keep it in a 128-entry FIFO; re-check its sum when it is evicted, after TX has finished: a mismatch increments
    `inflight_bad`.
  - Print the counters and the addresses on UART.
  - Reading it:
    - `ring_bad` > 0: something writes into the ring.
    - `inflight_bad` > 0: TX buffers are overwritten during DMA (lwIP, GEM or cache).
    - All zero but the wire is bad: GEM read stale DDR, which is a cache-flush problem.
- **E3. Map.** Run:
  ```
  arm-none-eabi-nm -n -S <app>.elf | grep -E " (G|ram_heap|memp_memory_PBUF_POOL_base|emac_bd_space|__bss_start|__bss_end|_heap_start|_heap_end|_stack_end)$"
  arm-none-eabi-size -A <app>.elf
  ```
  Send the output back together with E2's addresses.
- **E4. If E0/E2 give a fixed address:** rerun B4 under xsdb with a hardware write watchpoint
  (`bpadd -addr <addr> -type hw -mode w`), armed after the gap starts. The stop PC names the writer.
- **E5. Discriminators, if still open.**
  - `Xil_DCacheDisable()` at the top of `start_application`: if B4 comes out clean, it is cache maintenance.
  - Disable `xemacpsif_resetrx_on_no_rxdata`: if B4 comes out clean, it is the RXEN toggle.

Impact meanwhile: normal streaming (B1–B3) is bit-exact. The fault only shows on results buffered during a server
outage and replayed afterwards. The ALERT path is clean (71/71, 26 of them replayed).

## §2 Timing: 100 MHz misses by 8.1 ns

The estimates come from Yosys `synth_xilinx` plus a path-delay model. On today's validate the model says 19.2 ns over
23 levels, against Vivado's 18 ns over 23 levels, so it runs about 1 ns pessimistic. The fixes below were prototyped in
a scratch worktree, never committed, and every bit-exact sim still passes on the prototype:
- validate: 134,268 records;
- head: 134,268 records plus 10,360 debug captures;
- alarm: 201,402 records and 1,236 ALERTs;
- unpack, memory, countdown and top: PASS.

**Per-module diagnosis:**
- **validate (the −8 ns path).**
  - Path: FAC_ID → range compare → slot index (fan-out 264) → per-slot state LUTRAM read → 33-bit time difference →
    gap/hold logic → OR over 23 fields → INVALID/FLD_OK → consistency compares → REASON → `od`. About 17 of the 23
    levels come after the state read.
  - Registering the input alone doesn't help; the chain simply moves.
  - Fix: a 3-cycle record.
    1. Accept: register the record, the CONFIG row and the slot state.
    2. Time decode, field checks, the OR trees and the hold precompute.
    3. Hold limit, status, reason, output and the state write.
  - Estimate: 8.1 ns, from 19.2. Latency goes 1 → 3 and II 2 → 4. That is free, because unpack delivers at most one
    record every 6 cycles and countdown accepts one every 15.
- **head** (`sout_r` → `logit_q`). Fold the rounding constant into the accumulator at accept (exact). Estimate 10.9 →
  7.3 ns; latency and II unchanged.
- **alarm** (`head.in_r` → `al_pend`, plus the ACK sweep). Three changes:
  - rewrite the class compare (exact);
  - a find-first-set ACKED sweep, in the same order;
  - a 2-cycle accept.

  Estimate 10.8 → 9.5 ns. Latency 1 → 2, II 2 → 3 (4 with two ALERTs).
- **regs** (`a_q` fan-out 814 → `sbuf` and the weight-write decode). Register the address decode when the address is
  latched, and add `max_fanout`.
- **countdown** (LUTRAM write enable). Drop `rst_n` from four write enables; writes during reset are harmless.
- **features.** About 8.1 ns, so it should pass. If Vivado flags it, add an operand-prep cycle.
- **Reset fan-out** (memory, unpack, pack, regs, alarm).
  - Today: the engine reset is a LUT driving 3,159 synchronous resets, and the raw reset drives another 1,071.
  - Fix:
    - register both resets in `eog_top` with `max_fanout` (Vivado replicates them);
    - register `clr` in regs;
    - take datapath registers out of reset (unpack `od`, memory `in_r`/`mf_r`, pack `rec`, alarm `out_q`), removing
      about 900 reset loads.
  - Both resets arrive one cycle later. The soft-reset ordering was checked: no lost or extra record.

**Plan for 100 MHz, ordered by impact.** After fixes 1–7 the worst path is estimated at about 9.5 ns by the model,
about 8.5–9.5 in Vivado. Resources: about +1.6k FF; LUTs about unchanged. No vector, port or wire changes.
`CYC_PER_MS` goes back to 100,000.

| # | Fix | RTL size | Latency / II | Proofs and sims to re-run | Spec |
| --- | --- | --- | --- | --- | --- |
| 1 | validate 3-stage | ~150–200 lines + ~40 lines of formal invariants | 1/2 → 3/4 | validate formal: new invariants; prove depth 6 → ~8; bmc re-sized (4–5 records at depth 18–22). validate and top sim | none |
| 2 | Registered/replicated resets + datapath reset removal | ~25 lines (top, regs, unpack, memory, pack, alarm) | none | unpack/memory/countdown/alarm/pack sim and formal; top sim | 1 line in `eog_top.md` ("engine reset registered, 1 cycle") |
| 3 | head rounding fold | ~4 lines | none | head formal (all tasks) and sim | none |
| 4 | alarm compare + sweep + 2-cycle accept | ~45 lines | 1/2 → 2/3 | alarm formal (bmc depths +3–4, invariants for the new stage) and sim | none |
| 5 | regs address pre-decode + `max_fanout` | ~25 lines | none | regs formal and top sim | none |
| 6 | countdown write enables without `rst_n` | 4 lines | none | countdown formal and sim | none |
| 7 | memory `ram_style` (§3) | 1 line | none | memory sim | none |
| 8 | features operand prep, only if Vivado flags it | ~15 lines | +1 latency | features formal and sim | none |

**Proposal (D2):** demo at 50 MHz on the bitstream as it is now, plus **fix 1 (validate) for margin**. The current
50 MHz WNS is only +0.548 ns, all in validate, so any PL rebuild could flip it, and an XDC/Pmod-revision fix forces a
rebuild. Fix 1 alone gives about 12 ns of slack at 50 MHz. Fixes 2–6 make the 100 MHz build; do them after the demo
if wanted.

## §3 `eog_memory` `mem_reg` collision warning

**Diagnosis: no observable difference from simulation.**
- Vivado turned the asynchronous read `mem[in_r FAC]` into a Block RAM (5 of the 8 RAMB36 in the report) by absorbing
  the address register.
- Writes happen only during the reset sweep and at the S_CALC → S_OUT edge.
- The read data that is used is sampled at the accept edge (S_IDLE → S_CALC), where nothing is written. Collisions can
  only happen in cycles whose read data is never used, and on 7-series a collision corrupts only the read, never the
  write.
- This fits B3 being bit-exact.
- The regs RESULT and ALERT FIFOs are also safe: a same-address read only happens when the FIFO is empty (data
  ignored), and a full FIFO blocks the push.

**Fix (D3):** add `(* ram_style = "distributed" *)` to `mem`. That matches the RTL's own comment and the
asynchronous-read meaning, removes the warning, and trades 5 RAMB36 for about 59 RAM32M (~236 LUTs).
- **Size:** 1 line.
- **Re-run:** memory sim and a Vivado build. No re-proof.

## §4 Running at 50 MHz

**Diagnosis: fine for the demo. The change is docs only, with no RTL, proof, vector or wire change.**
- `CYC_PER_MS` is a build parameter, so the time-based functions keep real-time units.
- The engine is limited by countdown at one record every 15 cycles: 3.33M records/s at 50 MHz, above the 2.45M
  records/s ARM ceiling.
- Worth checking: the AXI-Lite v1 path is PL-cycle-bound per record. Measure B3's records/s at 50 MHz.

**Text that names 100 MHz (D5), about a dozen one-line edits, none of them numerics:**
- `spec/conventions.md:7` ("One clock, 100 MHz" → "100 MHz target; 50 MHz demo build")
- `spec/modules/eog_top.md:7`
- `spec/modules/eog_alarm.md:8` (`CYC_PER_MS` = f_clk/1000)
- `FPGA/AGENTS.md:43`
- `rtl/eog_top.sv:6` (a comment)
- the `vivado/README_eog_top.md` and `vivado/build.tcl` comments
- `LAPTOP_WORKORDER.md:44,71`
- `TASKS.md` T2.bd1
- regmap STATS 13: stall cycles become 20 ns units, and the ARM forwards the value raw as `engine_busy_cycles`. One
  note line.
- Lucas's plan doc: about 10 lines (lines 34, 69, 96, 117, 379, 423, 464, 624; latency becomes ~2.6 µs) and
  `global_plan.md:77`.

The `CYC_PER_MS` defaults in the RTL stay; the build sets 50,000.

## §5 `eog/T2.bd1`: review and merge

**Trial merge onto FPGA**, which already includes the T2.sd SD-boot work, on a scratch branch that is not pushed:
- **Conflict:** one, in `deploy/vitis_build.py`. T2.sd's `app_links_xilffs()` call and your DHCP-wait patch landed at
  the same spot. Both are kept; `py_compile` OK.
- **Auto-merged:** `ps/eog_app.c` (your `xiltimer.h` change next to T2.sd's SD-boot call) and
  `win_vitis_build_eog.bat`.
- **ARM host suite on the merged result:** `bash FPGA/ps/test/run_tests.sh` exits 0.
  - test_proto: 365 passed, 0 failed.
  - test_wire: 90 passed, 0 failed.
  - test_loopback: PASS.
  - test_sd_boot: PASS.

**Proposal (D4):** merge into FPGA as is.
- **Note for SD boot:** `BOOT.BIN` must be built from the 50 MHz XSA/bitstream (`C:\vb2\eclypse_eog.xsa`) and the
  fixed app. `make_boot_sd.bat` takes them from the Vitis workspace `out/` folder.
- **To re-check on the laptop after the merge:**
  - `win_vitis_build_eog.bat`, which now combines your BSP settings with T2.sd's xilffs and FSBL steps;
  - your `HUTD_WORK` workspace paths against T2.sd's `..\vws_eog` default.

## §6 Smaller items

- **Pmod pins:** `eog_top_io.xdc` has board rev B.0 active. Lucas to confirm the revision printed on the board; A.0
  needs the commented block instead (XDC only, but a rebuild — see §2's margin note).
- **BTN0 polarity (#8) and the LED/Pmod checks:** still to do on the board.
- **Link wait:** the ping wait in `win_board_golden.bat` is the right fix. It's included in the §5 merge.

## Where the RTL stands

- **DONE:** 10 of 11 modules on spec v4 (mul, div, unpack, validate, features, memory, countdown, head, alarm, pack),
  plus the model, the ARM app and SD boot.
- **regs:** 13 of 15 formal tasks pass on the real RTL. The other 2 fail on a harness over-constraint: a weight write
  with WSTRB = 0 must be a no-op (#101). The verifier is fixing its harness; no RTL change.
- **T2.top:** REVIEW. Every sim is bit-exact, including the full week in window and DMA mode.
