# eog_top in the Vivado block design (T2.top → T2.bd1)

Files:

| File | Use |
| --- | --- |
| `eog_top_files.tcl` | Source list: `rtl/eog_*.sv` + `rtl/eog_top.sv` (SystemVerilog), `rtl/eog_defs.svh` (include dir `rtl/`), `vivado/eog_top_bd.v`. `eog_add_files` (project mode) or `eog_read_files` (non-project) |
| `eog_top_bd.v` | Plain Verilog shell around `eog_top`. Vivado module references can't take a SystemVerilog file as their top, so the BD references `eog_top_bd`. Carries `X_INTERFACE` attributes for `s_axi`, `s_axis`, `m_axis`, `clk`, `rst_n` |
| `eog_top_io.xdc` | **Draft** pins for `btn0`, `ld0`, `ld1`, `pmod_ja`, `pmod_jb` (from `boards/eclypse-z7/*/part0_pins.xml`; Pmod pins differ between board rev A.0 and B.0, B.0 active) |

## Hookup (next to `axi_mul` in `build.tcl`)

```tcl
source [file join $script_dir eog_top_files.tcl]
eog_add_files
create_bd_cell -type module -reference eog_top_bd eog_0
apply_bd_automation -rule xilinx.com:bd_rule:axi4 -config [list \
    Clk_master {/ps7/FCLK_CLK0 (100 MHz)} Clk_slave {/ps7/FCLK_CLK0 (100 MHz)} \
    Clk_xbar {/ps7/FCLK_CLK0 (100 MHz)} Master {/ps7/M_AXI_GP0} Slave {/eog_0/s_axi} \
    ddr_seg {Auto} intc_ip {Auto} master_apm {0}] [get_bd_intf_pins eog_0/s_axi]
# address: 0x43C1_0000, 64 KB (axi_mul stays at 0x43C0_0000, 4 KB)
set seg [lindex [get_bd_addr_segs -quiet ps7/Data/*eog_0*] 0]
set_property range 64K $seg; set_property offset 0x43C10000 $seg
# board I/O
foreach p {btn0 ld0 ld1 pmod_ja pmod_jb} { make_bd_pins_external [get_bd_pins eog_0/$p] }
foreach p {btn0 ld0 ld1 pmod_ja pmod_jb} { set_property name $p [get_bd_ports ${p}_0] }
# v1 (no DMA): leave s_axis / m_axis unconnected (Vivado ties s_axis_tvalid and m_axis_tready to 0)
add_files -fileset constrs_1 -norecurse [file join $script_dir eog_top_io.xdc]
```

- `clk` = `FCLK_CLK0` (100 MHz). `rst_n` = the `proc_sys_reset` `peripheral_aresetn` that connection automation
  creates for the GP0 interconnect (the same one `axi_mul` uses). The automation should pick these up from the
  `X_INTERFACE` attributes; check `eog_0/rst_n` is connected to `peripheral_aresetn`, not `interconnect_aresetn`.
- AXI-Lite: 16-bit address, 32-bit data, base **`0x43C1_0000`**, range 64 KB (`spec/regmap.md`). C code:
  `#define EOG_BASEADDR 0x43C10000`.
- Optional DMA (T3.dma): AXI DMA MM2S → `eog_0/s_axis`, `eog_0/m_axis` → S2MM, 64-bit stream width, set
  `CTRL.src_dma = 1` only with `stream_en = 0` and the pipeline drained. DATA = 6 beats per 48 B record (little
  endian, beat k = bytes 8k..8k+7), RESULT = 4 beats per 32 B record, `m_axis_tlast` every 45 results or on a record
  that came in with `tlast`.
- BTN0 → `btn0` (active high, debounced inside). LD0/LD1 RGB: `ld[2]` red, `ld[1]` green, `ld[0]` blue.
  Pmod JA = `{4'b0, hb_toggle, autonomous, |ns_latch, |es_latch}`, JB = `{2'b0, any_latch, worst_slot[4:0]}`.

ARM bring-up sequence: `spec/regmap.md` "v1 usage" (GLOBAL, CONFIG rows, 71-word weight image, `swap_req`, poll
`swap_pending`, `stream_en`, push DATA, drain RESULT/ALERT). `tb/top/tb_eog_top.sv` does exactly this.

## Resource estimate (Yosys, not Vivado: **estimate**)

Yosys 0.70+360 (OSS CAD Suite), `read_verilog -sv -I rtl rtl/eog_{mul,div,unpack,validate,features,memory,countdown,head,alarm,pack,regs,top}.sv;
synth_xilinx -family xc7 -flatten -top eog_top; stat`, default parameters (N_FAC 32), Sun Nov 8 2026:

| Resource | Yosys count | xc7z020 | Share |
| --- | --- | --- | --- |
| LUT (logic, LUT1–LUT6) | 14,714 | 53,200 | 28 % |
| LUT as memory (512 RAM32M, 43 RAM64M, 32 RAM256X1S, 123 SRL) | ~2,470 LUTs | 17,400 | 14 % |
| FF (FDRE + FDSE) | 11,701 | 106,400 | 11 % |
| CARRY4 | 1,125 | 13,300 | 8 % |
| DSP48E1 | 22 | 220 | 10 % |
| RAMB36E1 | 1 | 140 | < 1 % |

Vivado's numbers will differ (it maps the CONFIG LUTRAM and the FIFOs differently); timing at 100 MHz is not
checked by Yosys and is the first thing to look at in T2.bd1 (`eog_div` and the countdown are the deepest logic).
