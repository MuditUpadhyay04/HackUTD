# eog_regs — AXI-Lite registers, CONFIG table, FIFOs, STATS

Implements `regmap.md`.

## Parameters

`N_FAC` (32), `RES_DEPTH` (64 records), `AL_DEPTH` (64 alerts).

## Ports

| Group | Port | Dir | Width | Meaning |
| --- | --- | --- | --- | --- |
| clock | `clk`, `rst_n` | in | 1 | hard reset only (soft reset is generated here) |
| AXI-Lite | `s_axi_awaddr`, `awvalid`, `awready`, `wdata`, `wstrb`, `wvalid`, `wready`, `bresp`, `bvalid`, `bready`, `araddr`, `arvalid`, `arready`, `rdata`, `rresp`, `rvalid`, `rready` (all prefixed `s_axi_`) | | 16-bit address, 32-bit data | standard AXI4-Lite slave |
| control | `stream_en`, `src_dma` | out | 1 | CTRL bits |
| | `soft_rst` | out | 1 | 2-cycle pulse on `CTRL.soft_reset` |
| | `hb_pulse`, `swap_req`, `ack_srv` | out | 1 | 1-cycle pulses |
| | `glb` | out | 256 | GLOBAL CONFIG (`S` byte forced to 17) |
| | `ledovr` | out | 32 | |
| CONFIG | `cfg_fac_v`, `cfg_fac_f`, `cfg_fac_c` | in | 5 each | three read ports (validate, features, countdown) |
| | `cfg_row_v`, `cfg_row_f`, `cfg_row_c` | out | 512 each | combinational reads |
| | `fac_touch` | out | N_FAC | 1-cycle pulse per slot on an accepted CONFIG write |
| weights | `wb_we`, `wb_addr` (7), `wb_wdata`, `wb_raddr` (7) | out | | to `eog_head` (71-word window) |
| debug | `dbg_fac` | out | 5 | DBGSEL register |
| | `dbg_valid`, `dbg_feat` (496), `dbg_logits` (64), `dbg_rec_no` (32) | in | | captured into the DBG window |
| | `wb_rdata` | in | 32 | |
| status in | `autonomous`, `swap_pending`, `active_bank` | in | 1 | |
| | `active_ver` | in | 8 | |
| | `ms_since_hb` | in | 16 | |
| DATA window | `d_valid`, `d_ready`, `d_data` (64), `d_last` | out/in | | 6 beats per pushed record, `d_last` on beat 6 |
| RESULT FIFO | `r_valid`, `r_ready`, `r_data` (64), `r_last` | in/out | | accepts 64-bit beats, 4 per record |
| ALERT FIFO | `al_valid`, `al_data` (128) | in | | push |
| | `al_full` | out | 1 | |
| | `al_drop` | in | 1 | count it |
| taps | `tap_valid`, `tap_status` (3), `tap_reason` (16), `stall` | in | | for STATS |

## Behavior

Exactly `regmap.md`. Additionally:

- CONFIG table: N_FAC × 512-bit LUTRAM with three asynchronous read ports and one write port.
- Slot write rule: while a slot is enabled, only a word-0 write that clears `FLAGS[0]` is accepted.
- GLOBAL writes are ignored while `stream_en = 1`. `glb[7:0]` always reads 17 and `glb[23:16]` (`CD_LOG2`) 4.
- DBG window: on `dbg_valid` capture features, logits and `REC_NO` (regmap.md).
- RESULT FIFO depth `RES_DEPTH` records; `r_ready = 0` when it cannot take a whole record (back-pressure into
  `eog_pack`). In `src_dma = 1` mode `eog_top` does not route results here.
- ALERT FIFO depth `AL_DEPTH`; `al_full` when full.
- DATA push while `data_busy` (the previous record's beats not all accepted) → dropped, STATS word 12 + 1.
- STATS per regmap.md, saturating; cleared by `rst_n`, `soft_rst`, `stats_clear`.

## Required properties (verifier)

- G1 AXI4-Lite slave rules (reuse the `axi_mul` property set: B/R held until ready, RDATA stable, ≤ 1 outstanding
  per channel, no response without a request, AW/W accepted together or with correct buffering).
- G2 Enabled-slot protection: while `FLAGS[0]` of slot f is 1, its row changes only by a word-0 write that clears
  `FLAGS[0]` (anyconst slot and word).
- G3 GLOBAL never changes while `stream_en = 1`.
- G4 `fac_touch[f]` pulses exactly on accepted writes to slot f.
- G5 FIFOs: no overflow, no underflow, order preserved (anyconst entry), pop only on the pop address read.
- G6 DATA push: 6 beats in order with `d_last` on the 6th, equal to the 12 written words; overrun counted.
- G7 W1P bits read back 0 and produce exactly one pulse per write.
- Cover: write a CONFIG row, enable it, push a DATA record, read back a RESULT.
