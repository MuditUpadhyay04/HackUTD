# build.tcl — Eclypse Z7: Zynq PS7 (board preset, ENET0 on MIO) + axi_mul in PL
#
# Usage (from this directory):
#   vivado -mode batch -source build.tcl                 # full build -> eclypse_mul.xsa
#   vivado -mode batch -source build.tcl -tclargs nobit  # project + block design only
#
# Needs Vivado with Zynq-7000 device support. No board files required (see eclypse_ps7_preset.tcl).
#
# Output: vivado/eclypse_mul.xsa (hardware platform incl. bitstream) for Vitis.

set build_bit 1
if {[llength $argv] > 0 && [lindex $argv 0] eq "nobit"} { set build_bit 0 }

set script_dir [file dirname [file normalize [info script]]]
set root       [file normalize [file join $script_dir ..]]
set proj_name  eclypse_mul
set proj_dir   [file join $script_dir $proj_name]
if {[info exists ::proj_root]} { set proj_dir [file join $::proj_root $proj_name] }
set bd_name    system
set mul_base   0x43C00000

# ---- Part + PS7 preset (no board files needed) ----------------------------
# The Eclypse Z7 PS configuration (DDR3L timing, MIO map, ENET0/UART0/SD/USB, clocks) comes
# from eclypse_ps7_preset.tcl, generated from Digilent's board-file preset. Board files are
# avoided on purpose: on Windows a custom board repo path breaks child runs
# ("[Common 17-1257] Failed to create directory 'C'").
source [file join $script_dir eclypse_ps7_preset.tcl]

create_project $proj_name $proj_dir -part xc7z020clg484-1 -force
set_property target_language Verilog [current_project]

add_files -norecurse [file join $root rtl axi_mul.v]
add_files -fileset sim_1 -norecurse [file join $root tb tb_axi_mul.v]
set_property top tb_axi_mul [get_filesets sim_1]
update_compile_order -fileset sources_1

# ---- Block design ----------------------------------------------------------
create_bd_design $bd_name

set ps7 [create_bd_cell -type ip -vlnv xilinx.com:ip:processing_system7:5.5 ps7]
# Eclypse preset: DDR3L, UART0 (MIO 14/15), ENET0 (RGMII to the RTL8211E on MIO 16-27,
# MDIO on MIO 52/53), SD0, USB0, FCLK_CLK0 = 100 MHz.
if {[catch {set_property -dict $eclypse_ps7_preset $ps7} err]} {
    # Some preset entries are derived/read-only in newer IP versions; apply one by one.
    set skipped 0
    foreach {k v} $eclypse_ps7_preset {
        if {[catch {set_property $k $v $ps7}]} { incr skipped }
    }
    puts "INFO: PS7 preset applied per-property ($skipped read-only entries skipped)"
}
apply_bd_automation -rule xilinx.com:bd_rule:processing_system7 \
    -config {make_external "FIXED_IO, DDR" apply_board_preset "0" Master "Disable" Slave "Disable"} \
    $ps7

# Make sure GP0 master and FCLK0 @ 100 MHz are on (preset normally does this).
set_property -dict [list \
    CONFIG.PCW_USE_M_AXI_GP0 {1} \
    CONFIG.PCW_FPGA0_PERIPHERAL_FREQMHZ {100} \
    CONFIG.PCW_EN_CLK0_PORT {1} \
    CONFIG.PCW_EN_RST0_PORT {1} \
    CONFIG.PCW_TTC0_PERIPHERAL_ENABLE {1} \
] [get_bd_cells ps7]
# TTC0 is required by the Vitis 2026.1 lwip_echo_server template (depends: ttcps or tmrctr).

# Our RTL as a module reference; Vivado infers the s_axi interface from port names.
create_bd_cell -type module -reference axi_mul axi_mul_0

apply_bd_automation -rule xilinx.com:bd_rule:axi4 -config [list \
    Clk_master {/ps7/FCLK_CLK0 (100 MHz)} \
    Clk_slave  {/ps7/FCLK_CLK0 (100 MHz)} \
    Clk_xbar   {/ps7/FCLK_CLK0 (100 MHz)} \
    Master     {/ps7/M_AXI_GP0} \
    Slave      {/axi_mul_0/s_axi} \
    ddr_seg    {Auto} \
    intc_ip    {New AXI Interconnect} \
    master_apm {0} \
] [get_bd_intf_pins axi_mul_0/s_axi]

# Pin the address so the C code's MUL_BASEADDR matches without relying on xparameters.
assign_bd_address
set seg [get_bd_addr_segs -quiet -of_objects [get_bd_addr_spaces ps7/Data] -filter {NAME =~ *axi_mul*}]
if {$seg eq ""} { set seg [lindex [get_bd_addr_segs -quiet ps7/Data/*axi_mul*] 0] }
if {$seg ne ""} {
    set_property range  4K        $seg
    set_property offset $mul_base $seg
    puts "INFO: axi_mul mapped at [get_property offset $seg] ([get_property range $seg])"
} else {
    puts "WARNING: could not find axi_mul address segment; check Address Editor and MUL_BASEADDR in ps/udp_mul.c"
}

regenerate_bd_layout
validate_bd_design
save_bd_design

set wrapper [make_wrapper -files [get_files ${bd_name}.bd] -top]
add_files -norecurse $wrapper
set_property top ${bd_name}_wrapper [current_fileset]
update_compile_order -fileset sources_1

if {!$build_bit} {
    puts "INFO: nobit requested — project created at $proj_dir"
    return
}

# ---- Build (in memory) -----------------------------------------------------
# Synthesis/implementation run inside this Vivado process instead of launch_runs. That avoids
# writing intermediate .dcp checkpoints, which failed intermittently on the dev PC with
# "[Common 17-99] Failed to open zip archive ... .dcp" (likely antivirus locking the files).
set bdf [get_files ${bd_name}.bd]
set_property synth_checkpoint_mode None $bdf
generate_target all $bdf
synth_design -top ${bd_name}_wrapper -part xc7z020clg484-1
opt_design
place_design
route_design

set out_dir [file dirname $proj_dir]
set wns [get_property SLACK [get_timing_paths -max_paths 1 -nworst 1 -setup]]
set whs [get_property SLACK [get_timing_paths -max_paths 1 -nworst 1 -hold]]
puts "INFO: worst setup slack = $wns ns, worst hold slack = $whs ns"
report_utilization -file [file join $out_dir utilization.rpt]
report_timing_summary -file [file join $out_dir timing.rpt]
if {$wns < 0 || $whs < 0} { error "Timing not met (WNS $wns, WHS $whs) — see $out_dir/timing.rpt" }

# Bitstream + hardware platform. The XSA does not embed the .bit (that needs a launch_runs
# bitstream); deploy/fpga.py picks up eclypse_mul.bit next to the XSA.
set bit_build [file join $out_dir ${proj_name}.bit]
set xsa_build [file join $out_dir ${proj_name}.xsa]
write_bitstream -force $bit_build
# write_hw_platform intermittently fails with "[Common 17-99] Failed to open zip archive" on the
# dev PC; it succeeds on retry.
for {set try 1} {$try <= 5} {incr try} {
    if {![catch {write_hw_platform -fixed -force $xsa_build} err]} { break }
    puts "WARNING: write_hw_platform attempt $try failed: $err"
    after 2000
}
if {![file exists $xsa_build]} { error "write_hw_platform failed 5 times" }
foreach f [list $bit_build $xsa_build] {
    set dst [file join $script_dir [file tail $f]]
    if {$f ne $dst && [catch {file copy -force $f $dst} err]} {
        puts "WARNING: could not copy $f to $dst ($err)"
    }
}
puts "INFO: wrote $bit_build"
puts "INFO: wrote $xsa_build"
