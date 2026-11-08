# FPGA — Eclypse Z7 engine for Beat the Shutdown

The Zynq-7020 fabric validates every 48 B telemetry record, computes 12 channels plus 19 memory features, runs
four logistic regressions, the rule flags and the tank countdown, and returns one 32 B RESULT per record. The ARM
only moves packets, using zero-copy DMA. Design: `../docs/plan/lucas/fpga_hardware_plan.md`. Rules for agents:
`AGENTS.md`. Work queue: `TASKS.md`.

## Layout

| Path | What |
| --- | --- |
| `spec/` | Frozen module contracts (ports, handshake, numerics, required properties). Lead-owned |
| `rtl/` | Synthesizable SystemVerilog, one module per file; `eog_defs.svh` shared constants; `axi_mul.v` (link health check) |
| `formal/<module>/` | SymbiYosys: harness `fv_eog_<module>.sv` + `eog_<module>.sby` (`prove`, `cover`, optional `bmc`) |
| `formal/common/` | Shared property helpers and the abstract multiplier used in `prove` |
| `tb/<module>/` | Simulation testbench + `files.f`; `tb/vectors/` holds generated golden vectors |
| `model/` | Bit-exact Python reference (until Mudit's `features_int.py` lands, then checked against it) |
| `scripts/` | `lint.sh`, `sim.sh`, `formal.sh`, `check_all.sh` → `reports/` |
| `reports/` | Generated summaries; only `SUMMARY.md` and `formal_*.txt` are committed |
| `ps/` | ARM bare-metal app (lwIP); `udp_mul.c` has the multiply server + UDP perf probe on port 7000 |
| `host/` | PC tools: web UI/server for the multiply link, wire-format helpers |
| `deploy/` | Windows build/JTAG/verify/measure scripts (Lucas's PC); `perf_round*.log` = the Sat 21:20 measurements |
| `vivado/` | `build.tcl` (block design + bitstream + XSA), PS7 preset, Digilent board files |
| `docs/` | `link_bringup.md`: how the browser → board multiply link was built and deployed |

## Tools

OSS CAD Suite (Yosys, SymbiYosys, Icarus Verilog, Verilator, solvers) for lint/sim/formal on any machine;
Vivado/Vitis 2026.1 only on the board machine. Record the OSS CAD Suite version in `reports/SUMMARY.md`.

```sh
bash scripts/lint.sh validate        # Verilator lint of rtl/eog_validate.sv
bash scripts/sim.sh validate         # tb/validate/ against tb/vectors/
bash scripts/formal.sh validate      # formal/validate/eog_validate.sby, report in reports/
bash scripts/check_all.sh            # everything, writes reports/SUMMARY.md
bash scripts/formal.sh axi_mul       # the existing proven link block
```
