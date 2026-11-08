# HackUTD FPGA link — browser ⇄ PC ⇄ Eclypse Z7 multiply loopback

```
 Browser ──HTTP/JSON──▶ host/server.py ──UDP :7777──▶ Zynq PS (lwIP, bare metal)
   ▲                    (your PC)                       │ AXI4-Lite GP0 @ 0x43C0_0000
   └──────── product, RTT, raw hex ◀────────────────────┤
                                                        ▼
                                              PL: rtl/axi_mul.v
                                              signed 32×32→64, 3-cycle DSP48 pipeline
```

## Layout

| Path | What |
|---|---|
| `rtl/axi_mul.v` | AXI4-Lite multiplier peripheral + formal properties (`ifdef FORMAL`) |
| `tb/tb_axi_mul.v` | Self-checking testbench (edge cases, WSTRB, 2000 random) |
| `formal/axi_mul.sby` | SymbiYosys: `prove` (unbounded), `bmc` (real multiplier), `cover` |
| `vivado/build.tcl` | Creates project + block design, builds bitstream, exports `eclypse_mul.xsa` |
| `ps/udp_mul.c` | Drop-in replacement for `echo.c` in the Vitis *lwIP Echo Server* template |
| `host/server.py` | Web server + UDP client (stdlib only, Python ≥ 3.10) |
| `host/static/index.html` | UI: multiply, burst test, raw packet, history |
| `host/mock_board.py` | Software fake of the board (also `server.py --mock`) |
| `host/proto.py` | Wire format shared by host and mock |

## 0. Try it with no hardware

```bash
cd host
python3 server.py --mock                 # open http://127.0.0.1:8000
python3 server.py --mock --mock-fault-rate 0.1   # board flips bits; UI should flag MISMATCH
```

## 1. Vivado (bitstream + XSA)

1. Install Digilent board files: copy `new/board_files/*` from <https://github.com/Digilent/vivado-boards> into `<Vivado>/data/boards/board_files/`.
2. Build:
   ```bash
   cd vivado
   vivado -mode batch -source build.tcl          # ~5–10 min, writes eclypse_mul.xsa
   # or: -tclargs nobit   to just create the project and open it in the GUI
   ```
   The script picks up whatever `*eclypse-z7*` board-file version is installed, applies the
   board preset (DDR3L, UART0, ENET0), adds `axi_mul` as a module reference on `M_AXI_GP0`,
   pins it to `0x43C00000`, and prints worst setup slack. No XDC is needed — the design uses
   no PL pins.

## 2. Vitis (PS application)

Vitis Unified (2023.2+); Classic has the same steps under different menus.

1. **Create Platform Component** → select `vivado/eclypse_mul.xsa`, OS `standalone`, CPU `ps7_cortex_a9_0`.
2. In the platform's BSP settings, add the **lwip** library (lwip220 / lwip213 depending on version).
   - Direct PC↔board cable: set `dhcp` = false (board uses the template's static IP, normally **192.168.1.10**).
   - Board on a router/switch with DHCP: set `dhcp` = true and read the IP off the UART.
3. Build the platform. **Create Application Component** from the example **lwIP Echo Server**.
4. In the app's `src/`: delete `echo.c`, add `ps/udp_mul.c`. Leave `main.c` alone — it still does MAC/PHY
   bring-up and the RX loop, and calls our `start_application()` / `transfer_data()` / `print_app_header()`.
5. Build, open a serial terminal at 115200 8N1, Run on hardware. Expected UART:
   ```
   ----- HackUTD FPGA link: UDP multiply server -----
   axi_mul: selftest passed (7 vectors)
   UDP multiply server listening on port 7777
   ```
   `bad ID` here means the bitstream isn't loaded or the base address differs from `MUL_BASEADDR`.

The Eclypse Z7's PHY is a Realtek **RTL8211E-VL** (RGMII on MIO bank 501, MDIO on MIO 52/53),
which the stock Xilinx lwIP port supports. Digilent's patched `xemacpsif_physpeed.c` is only for
boards with the RTL8211**F**, so you shouldn't need it.

## 3. Network + run

Direct cable: give the PC's Ethernet adapter a static IP on the same subnet, e.g. `192.168.1.50/24`, no gateway.

```bash
ping 192.168.1.10
cd host && python3 server.py --board-ip 192.168.1.10     # http://127.0.0.1:8000
# teammates on the LAN:  --http-host 0.0.0.0
```

## 4. One-command build + JTAG deploy (for agents)

`deploy/fpga.py` wraps the whole flow headlessly. It finds Vivado/Vitis/xsdb under the usual install
roots (`C:/AMDDesignTools`, `C:/Xilinx`, `/tools/Xilinx`, `/opt/Xilinx`) or takes `VIVADO`, `VITIS`,
`XSDB` env vars.

```bash
python deploy/fpga.py pl       # RTL change: Vivado build -> JTAG program + run existing ELF -> UDP check
python deploy/fpga.py all      # hw -> sw -> deploy -> verify
python deploy/fpga.py verify   # just the 506-vector UDP smoke test
```

- `deploy` extracts the `.bit` and `ps7_init.tcl` from the XSA and runs the same xsdb sequence the
  Vitis IDE uses: system reset → program PL → `ps7_init` → download ELF → run.
- `sw` runs `deploy/vitis_build.py` through `vitis -s`. On first run it tries to create the platform
  and app headlessly; if that fails on your Vitis version, create them once in the GUI with the names
  `vitis_ws` / `eclypse_plat` / `mul_app` and later runs just rebuild.
- Each step prints `RESULT: PASS|FAIL …` and exits non-zero on failure. See `CLAUDE.md` for the agent loop.
- Set the board's boot-mode jumper to JTAG so the QSPI demo doesn't boot first.

## 5. Windows quick path (what's working on lucaslegion)

Outputs live outside the synced folder: Vivado project/bitstream/XSA in `C:\vb2`, Vitis workspace in
`..\vws2`, BOM-fixed lwIP repo in `..\eswfix`.

```
deploy\win_deploy_verify.bat   # JTAG: program PL + ps7_init + run ELF, capture UART, 506-vector UDP check
deploy\win_webserver.bat       # browser UI at http://127.0.0.1:8000 -> board 192.168.1.10
deploy\win_sw_deploy.bat       # after editing ps\udp_mul.c: rebuild app, deploy, verify
```
PC Ethernet adapter: static `192.168.1.50/24`. Board UART shows up as `USB Serial Port (COM9)`.

### Vitis 2026.1 workarounds baked into this flow
- **lwIP missing on Windows**: `lwip220.yaml` ships with a UTF-8 BOM and Vitis reads it as cp1252, so
  lwIP silently drops out of the repo. `eswfix/` is lwip220 from embeddedsw `xilinx_v2026.1` with the BOM
  stripped, added via `client.add_embedded_sw_repo(path=[...])`. If the domain was created before that,
  move its cached `bsp/lib_list.yaml` aside so it regenerates.
- **lwip_echo_server template needs a TTC/AXI timer** (`depends: ttcps|tmrctr`) -> `build.tcl` enables TTC0.
- **Template param check** wants `lwip220_dhcp=true`, `..._dhcp_does_acd_check=true`,
  `pbuf_pool_size=2048`, `XILTIMER_en_interval_timer=true` (set in `vitis_build.py`).
- **DHCP wait never times out** on a direct cable: `vws2/mul_app/src/main.c` is patched to
  `dhcp_timoutcntr = 0` (original saved as `main.c.orig`), so it uses 192.168.1.10 immediately.
- **XSA after a retried export can lack `ps7_init.tcl`**; `ps7_init.c` was identical, so the earlier one is reused.

## Protocol (UDP 7777, big-endian)

| | Bytes | Fields |
|---|---|---|
| Request | 16 | `magic=0x4D554C31` · `seq u32` · `a i32` · `b i32` |
| Response | 28 | `magic` · `seq` · `status u32` · `a` · `b` · `p_hi u32` · `p_lo u32` |

`status`: 0 OK, 1 BAD_LEN, 2 BAD_MAGIC, 3 HW_TIMEOUT. The board echoes `a`/`b` so the host checks
the operands survived the trip, not just the product. Host does stop-and-wait with `seq` matching,
250 ms timeout, 2 retries.

## axi_mul register map

| Off | Name | Access | Notes |
|---|---|---|---|
| 0x00 | CTRL | W | bit0 START (ignored while BUSY) |
| 0x04 | STATUS | R | bit0 DONE (sticky until next START), bit1 BUSY |
| 0x08 | A | RW | signed operand, honors WSTRB |
| 0x0C | B | RW | signed operand, honors WSTRB |
| 0x10 / 0x14 | P_LO / P_HI | R | 64-bit signed product |
| 0x18 | ID | R | `0x4D554C31` |
| 0x1C | COUNT | R | completed ops |

## Verification

```bash
iverilog -g2012 -o sim tb/tb_axi_mul.v rtl/axi_mul.v && vvp sim     # PASS: 2013 checks
cd formal && sby -f axi_mul.sby                                    # prove / bmc / cover all PASS
```

What the formal job establishes:

- **prove** (k-induction, unbounded, ~1 s): AXI4-Lite slave rules (B/R held until ready, RDATA
  stable, ≤1 outstanding, no response without a request, AW/W accepted together), one op in flight,
  DONE/BUSY exclusive, DONE exactly 3 cycles after START, and the operands that reach the result are
  the ones latched at START. The 32×32 multiplier is replaced by an *uninterpreted function*
  (`anyseq` output, constrained to be consistent for one `anyconst` input pair) — this is what keeps
  induction from bit-blasting the multiplier and hanging.
- **bmc** (depth 9, ~10 s): same assertions with the real `*`, checked against `s3_p == f_a * f_b`.
  Depth 9 covers one complete transaction; deeper gets slow with z3.
- **cover**: write A/B → START → DONE → read-back is reachable (6 cycles).

Mutation check: injecting "S3 loads one stage early" or "BVALID drops before BREADY" each produce a
counterexample. Removing the START-while-BUSY guard does *not* — the proof shows that this AXI slave
can't issue a second write within the 2 busy cycles, so the guard is currently unreachable logic
(keep it; it matters once you add a faster front end like AXI-Stream/DMA).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| UART stuck at "waiting for PHY link" / no link LEDs | cable/port; try DHCP off + direct cable |
| ping works, UI times out | PC firewall blocking inbound UDP from the board; wrong `--board-ip`; old app still running |
| `axi_mul: bad ID` | bitstream not programmed, or address changed in Address Editor (update `MUL_BASEADDR`) |
| `MISMATCH` in UI | real hardware/datapath bug — check `tx`/`rx` hex in the result panel |
| PC blue-screens (`KERNEL_SECURITY_CHECK_FAILURE`, 0x139/0xA) when `hw_server` starts | crash dump showed `ftdibus.sys` (FTDI 2.12.36.4) faulting; fixed on lucaslegion by uninstalling NoMachine (its `nxusb*` USB filter drivers) |
| Vivado `[Common 17-99] Failed to open zip archive ... .dcp` / `Failed to create directory 'C'` | intermittent checkpoint write failures on Windows; `build.tcl` now builds in memory (no intermediate .dcp) |
