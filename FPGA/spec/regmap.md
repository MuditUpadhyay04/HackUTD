# AXI-Lite register map (spec v1, FROZEN)

`eog_regs` is an AXI4-Lite slave (32-bit data, 16-bit byte address, 64 KB window) at **`0x43C1_0000`** on
`M_AXI_GP0`. `axi_mul` stays at `0x43C0_0000`. All multi-byte values are little-endian. Unmapped addresses read 0;
writes to them, or to read-only registers, are ignored with `OKAY`. `WSTRB` is honored on RW registers and on
CONFIG/GLOBAL/weight words; the DATA window requires full-word writes (`WSTRB = 4'hF`), others are ignored.

| Offset | Name | Access | Contents |
| --- | --- | --- | --- |
| `0x0000` | ID | RO | `0x31474F45` ("EOG1" in bytes) |
| `0x0004` | VERSION | RO | `[7:0]` spec version (1), `[15:8]` N_FAC, `[23:16]` N_WELL |
| `0x0008` | CTRL | RW / W1P | `bit0 stream_en` (RW), `bit5 src_dma` (RW: 0 = DATA/RESULT windows, 1 = AXI-Stream DMA); write-1-pulse, read 0: `bit1 soft_reset`, `bit2 heartbeat`, `bit3 swap_req`, `bit4 server_ack`, `bit6 stats_clear` |
| `0x000C` | STATUS | RO | `bit0 autonomous`, `bit1 swap_pending`, `bit2 active_bank`, `bit3 result_avail`, `bit4 alert_avail`, `bit5 data_busy`, `[15:8]` result FIFO count (records, saturating 255), `[23:16]` alert FIFO count, `[31:24]` active weights version |
| `0x0010`–`0x002C` | GLOBAL | RW | the 32 B GLOBAL CONFIG record, word i = bytes 4i..4i+3. **Writes ignored while `stream_en = 1`.** Byte 0 (`S`) always reads 17 |
| `0x0040`–`0x004C` | ALERT | RO | head of the ALERT FIFO (16 B, word i = bytes 4i..4i+3). **Reading `0x004C` pops.** Empty → reads 0 |
| `0x0060` | LEDOVR | RW | `bit31` override enable; `[2:0]` LD0 RGB, `[5:3]` LD1 RGB, `[15:8]` Pmod JA, `[23:16]` Pmod JB |
| `0x0100`–`0x013C` | STATS | RO | 16 × u32 counters, cleared by reset, soft reset and `stats_clear`, saturating at 2^32−1 (table below) |
| `0x0200`–`0x022C` | DATA | WO | one 48 B DATA record, word i = bytes 4i..4i+3. **Writing `0x022C` pushes** the record (6 beats, `tlast` on the 6th) into the engine when `src_dma = 0`. A push while `data_busy = 1` is dropped and counted |
| `0x0300`–`0x031C` | RESULT | RO | head of the RESULT FIFO (32 B, depth 64 records). **Reading `0x031C` pops.** Empty → reads 0 |
| `0x1000`–`0x17FC` | CONFIG | RW | Facility CONFIG table: slot f at `0x1000 + 64·f`, word i = bytes 4i..4i+3 of the 64 B record. **While a slot is enabled (`FLAGS[0] = 1`) only a write to its word 0 that clears `FLAGS[0]` is accepted; every other write to that slot is ignored.** Every accepted write to slot f pulses `fac_touch[f]` (its history restarts). Word 0 bytes 0–1 (`FAC_ID`) read back as f |
| `0x4000`–`0x4110` | WEIGHTS | RW | the 69-word weight image (numerics.md §8) of the **inactive** bank. `CTRL.swap_req` makes it active at the next record boundary |

STATS words: 0 records in, 1 results out, 2 VALID, 3 HELD, 4 INVALID, 5 dropped duplicate, 6 dropped out of order,
7 dropped unknown facility, 8 dropped framing, 9 history resets, 10 alerts raised, 11 alerts dropped (ALERT FIFO
full), 12 DATA-window overruns, 13 output stall cycles (`eog_pack` output valid and not ready), 14 ms since last
heartbeat (live value, not a counter), 15 uptime in ms.

Counts 1–9 come from the RESULT tap at the `eog_pack` output (status/reason of each record leaving the engine),
so they are identical in the window and DMA modes.

## v1 usage (AXI-Lite only, before DMA)

1. `CTRL = 0` (stream off). Write GLOBAL, then each slot's CONFIG row with `FLAGS[0] = 0`, then word 0 with
   `FLAGS[0] = 1`.
2. Write the weight image to `0x4000+`, pulse `swap_req`, poll `STATUS.swap_pending = 0`.
3. `CTRL.stream_en = 1`. Per record: poll `data_busy = 0`, write `0x0200`–`0x022C`. Drain results by reading
   `0x0300`–`0x031C` while `result_avail`; alerts from `0x0040`–`0x004C` while `alert_avail`.
4. Every heartbeat packet from the server → write `CTRL.heartbeat = 1`.
