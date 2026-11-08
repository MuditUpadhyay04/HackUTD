# eog_top — the engine top level

## Ports (names chosen for Vivado IP packaging)

| Port | Dir | Width | Meaning |
| --- | --- | --- | --- |
| `clk` | in | 1 | FCLK0, 100 MHz |
| `rst_n` | in | 1 | from `proc_sys_reset` (`peripheral_aresetn`) |
| `s_axi_*` | | | AXI4-Lite slave, 16-bit address (`eog_regs`) |
| `s_axis_tdata` (64), `s_axis_tvalid`, `s_axis_tready`, `s_axis_tlast` | | | DATA records from AXI DMA MM2S |
| `m_axis_tdata` (64), `m_axis_tvalid`, `m_axis_tready`, `m_axis_tlast` | | | RESULT records to AXI DMA S2MM |
| `btn0` | in | 1 | |
| `ld0`, `ld1` | out | 3 each | |
| `pmod_ja`, `pmod_jb` | out | 8 each | |

## Structure

`eog_regs` + the eight stages in series (conventions §4) + `eog_head`'s weight port to `eog_regs`.

- Input mux: `src_dma ? s_axis_* : eog_regs DATA window` → `eog_unpack`; the unselected source sees `ready = 0`.
  When `stream_en = 0` both see `ready = 0`.
- Output demux: `src_dma ? m_axis_* : eog_regs RESULT FIFO`; the unselected sink gets `valid = 0`.
- Engine reset = `rst_n & ~soft_rst`. Exception (spec v3): `eog_head.wb_rst_n` = the raw `rst_n` (hard reset only),
  so soft reset keeps the weight banks (conventions §1).
- Changing `src_dma` while records are in flight is not supported (the ARM changes it only with `stream_en = 0`
  and the pipeline drained).

## Required properties (T2.top)

- T1 (bounded, small N_FAC/CYC_PER_MS, abstract multipliers): every record pushed through the DATA window yields
  exactly one RESULT in the RESULT FIFO, in order (`RESULT_NO` sequence), unless the FIFO is full.
- T2 Nothing reaches `m_axis` while `src_dma = 0`, and nothing reaches the RESULT FIFO while `src_dma = 1`.
- Simulation: the full practice week (`history/full_week`, 30,240 records) through `eog_top` via the DATA window,
  bit-exact against `model/` RESULTs, plus the synthetic bad-data suite.
- Golden sets: Mudit's `ml/artifacts/<ver>/golden/` G0/G1/G2 (`data.bin` in, `expected_results.bin` out, after task
  T0.0) must also pass bit-exact through `eog_top`; `model/bus_vectors.py` converts them to `tb/vectors/top_*.hex`.
