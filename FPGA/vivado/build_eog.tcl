# build_eog.tcl — Eclypse Z7: PS7 + axi_mul (0x43C0_0000, UDP 7777 health check) + eog_top (0x43C1_0000)
#
# Usage (vivado/win_build_eog.bat does this):
#   vivado -mode batch -source build_eog.tcl -tclargs <out_dir> [nobit]
#     out_dir  where the project, .bit and .xsa go (default C:/vb2; keep it outside OneDrive)
#     nobit    project + block design only
#
# Reports are also copied into FPGA/build/ (gitignored) so a session without access to out_dir can read them:
#   build/eog_status.txt (one line per step), build/eog_timing.rpt, build/eog_util.rpt, build/eog_util_hier.rpt,
#   build/eog_timing_paths.rpt (10 worst setup paths).

set out_dir  C:/vb2
set build_bit 1
set fclk_mhz 100
foreach a $argv {
    if {$a eq "nobit"} { set build_bit 0 } elseif {[regexp {^mhz=?(\d+)$} $a -> m]} { set fclk_mhz $m } else { set out_dir [file normalize $a] }
}

set script_dir [file dirname [file normalize [info script]]]
set root       [file normalize [file join $script_dir ..]]
set rep_dir    [file join $root build]
file mkdir $rep_dir
set proj_name  eclypse_eog
set proj_dir   [file join $out_dir $proj_name]
set bd_name    system
set mul_base   0x43C00000
set eog_base   0x43C10000

set status_file [file join $rep_dir eog_status.txt]
set sf [open $status_file w]; close $sf
proc status {msg} {
    global status_file
    set f [open $status_file a]
    puts $f "[clock format [clock seconds] -format %H:%M:%S] $msg"
    close $f
    puts "STATUS: $msg"
}
status "start out_dir=$out_dir build_bit=$build_bit fclk=${fclk_mhz}MHz"

source [file join $script_dir eclypse_ps7_preset.tcl]
create_project $proj_name $proj_dir -part xc7z020clg484-1 -force
set_property target_language Verilog [current_project]

add_files -norecurse [file join $root rtl axi_mul.v]
source [file join $script_dir eog_top_files.tcl]
eog_add_files
if {$fclk_mhz != 100} {
    # eog_top_bd.v fixes FREQ_HZ = 100 MHz on clk and its bus interfaces (read-only in the BD). For another FCLK,
    # build from a copy with the frequency replaced; the repo file stays as it is.
    set shell_src [file join $script_dir eog_top_bd.v]
    set shell_dir [file join $out_dir eog_shell_${fclk_mhz}mhz]
    file mkdir $shell_dir
    set shell_dst [file join $shell_dir eog_top_bd.v]
    set fi [open $shell_src r]; set txt [read $fi]; close $fi
    set txt [string map [list "FREQ_HZ 100000000" "FREQ_HZ [expr {$fclk_mhz * 1000000}]"] $txt]
    set fo [open $shell_dst w]; puts -nonewline $fo $txt; close $fo
    remove_files [get_files -quiet $shell_src]
    add_files -norecurse $shell_dst
    update_compile_order -fileset sources_1
    puts "INFO: eog_top_bd.v copied to $shell_dst with FREQ_HZ for $fclk_mhz MHz"
}
add_files -fileset constrs_1 -norecurse [file join $script_dir eog_top_io.xdc]
update_compile_order -fileset sources_1

# ---- Block design ----------------------------------------------------------
create_bd_design $bd_name
set ps7 [create_bd_cell -type ip -vlnv xilinx.com:ip:processing_system7:5.5 ps7]
if {[catch {set_property -dict $eclypse_ps7_preset $ps7} err]} {
    set skipped 0
    foreach {k v} $eclypse_ps7_preset { if {[catch {set_property $k $v $ps7}]} { incr skipped } }
    puts "INFO: PS7 preset applied per-property ($skipped read-only entries skipped)"
}
apply_bd_automation -rule xilinx.com:bd_rule:processing_system7 \
    -config {make_external "FIXED_IO, DDR" apply_board_preset "0" Master "Disable" Slave "Disable"} $ps7
set_property -dict [list \
    CONFIG.PCW_USE_M_AXI_GP0 {1} \
    CONFIG.PCW_FPGA0_PERIPHERAL_FREQMHZ $fclk_mhz \
    CONFIG.PCW_EN_CLK0_PORT {1} \
    CONFIG.PCW_EN_RST0_PORT {1} \
    CONFIG.PCW_TTC0_PERIPHERAL_ENABLE {1} \
] [get_bd_cells ps7]

set fclk "/ps7/FCLK_CLK0 (${fclk_mhz} MHz)"
create_bd_cell -type module -reference axi_mul axi_mul_0
apply_bd_automation -rule xilinx.com:bd_rule:axi4 -config [list \
    Clk_master $fclk Clk_slave $fclk \
    Clk_xbar $fclk Master {/ps7/M_AXI_GP0} Slave {/axi_mul_0/s_axi} \
    ddr_seg {Auto} intc_ip {New AXI Interconnect} master_apm {0}] [get_bd_intf_pins axi_mul_0/s_axi]

create_bd_cell -type module -reference eog_top_bd eog_0
# The ms tick inside eog_alarm counts CYC_PER_MS clocks; keep it at 1 ms for any FCLK.
set_property CONFIG.CYC_PER_MS [expr {$fclk_mhz * 1000}] [get_bd_cells eog_0]
apply_bd_automation -rule xilinx.com:bd_rule:axi4 -config [list \
    Clk_master $fclk Clk_slave $fclk \
    Clk_xbar $fclk Master {/ps7/M_AXI_GP0} Slave {/eog_0/s_axi} \
    ddr_seg {Auto} intc_ip {Auto} master_apm {0}] [get_bd_intf_pins eog_0/s_axi]

# rst_n must be peripheral_aresetn (README_eog_top.md); force it if automation picked something else.
set rst_net [get_bd_nets -quiet -of_objects [get_bd_pins eog_0/rst_n]]
set periph  [get_bd_pins -quiet -filter {NAME == peripheral_aresetn} -of_objects [get_bd_cells -quiet -filter {VLNV =~ *proc_sys_reset*}]]
if {$periph eq ""} { error "no proc_sys_reset peripheral_aresetn found" }
set want_net [get_bd_nets -of_objects [lindex $periph 0]]
if {$rst_net ne $want_net} {
    if {$rst_net ne ""} { disconnect_bd_net $rst_net [get_bd_pins eog_0/rst_n] }
    connect_bd_net [lindex $periph 0] [get_bd_pins eog_0/rst_n]
    puts "INFO: eog_0/rst_n connected to [lindex $periph 0]"
}
if {[get_bd_nets -quiet -of_objects [get_bd_pins eog_0/clk]] eq ""} {
    connect_bd_net [get_bd_pins ps7/FCLK_CLK0] [get_bd_pins eog_0/clk]
}

# v1 (no DMA): tie the stream inputs (s_axis_tvalid = 0, m_axis_tready = 0 is harmless with src_dma = 0).
foreach {pin val w} {s_axis_tvalid 0 1 s_axis_tlast 0 1 s_axis_tdata 0 64 m_axis_tready 1 1} {
    set p [get_bd_pins -quiet eog_0/$pin]
    if {$p ne "" && [get_bd_nets -quiet -of_objects $p] eq ""} {
        set c [create_bd_cell -type ip -vlnv xilinx.com:ip:xlconstant:1.1 tie_$pin]
        set_property -dict [list CONFIG.CONST_VAL $val CONFIG.CONST_WIDTH $w] $c
        if {[catch {connect_bd_net [get_bd_pins $c/dout] $p} err]} {
            puts "INFO: left eog_0/$pin unconnected (interface pin): $err"
            delete_bd_objs $c
        }
    }
}

foreach p {btn0 ld0 ld1 pmod_ja pmod_jb} {
    make_bd_pins_external [get_bd_pins eog_0/$p]
    set_property name $p [get_bd_ports ${p}_0]
}

assign_bd_address
foreach {pat base range} [list *axi_mul* $mul_base 4K *eog_0* $eog_base 64K] {
    set seg [lindex [get_bd_addr_segs -quiet ps7/Data/$pat] 0]
    if {$seg eq ""} { error "no address segment matching $pat" }
    set_property range  $range $seg
    set_property offset $base  $seg
    puts "INFO: [get_property NAME $seg] at [get_property offset $seg] ([get_property range $seg])"
}

regenerate_bd_layout
validate_bd_design
save_bd_design
set wrapper [make_wrapper -files [get_files ${bd_name}.bd] -top]
add_files -norecurse $wrapper
set_property top ${bd_name}_wrapper [current_fileset]
update_compile_order -fileset sources_1
status "block design OK"

if {!$build_bit} { status "nobit: project at $proj_dir"; return }

# ---- Build in memory (same as build.tcl: avoids .dcp zip failures on this PC) ----
set bdf [get_files ${bd_name}.bd]
set_property synth_checkpoint_mode None $bdf
generate_target all $bdf
status "targets generated"
synth_design -top ${bd_name}_wrapper -part xc7z020clg484-1
status "synth done"
report_utilization -file [file join $rep_dir eog_util_synth.rpt]
opt_design
place_design
status "place done"
phys_opt_design
route_design
status "route done"

set wns [get_property SLACK [get_timing_paths -max_paths 1 -nworst 1 -setup]]
set whs [get_property SLACK [get_timing_paths -max_paths 1 -nworst 1 -hold]]
report_utilization -file [file join $rep_dir eog_util.rpt]
report_utilization -hierarchical -hierarchical_depth 4 -file [file join $rep_dir eog_util_hier.rpt]
report_timing_summary -file [file join $rep_dir eog_timing.rpt]
report_timing -setup -max_paths 10 -nworst 1 -file [file join $rep_dir eog_timing_paths.rpt]
report_drc -file [file join $rep_dir eog_drc.rpt]
# Worst setup slack per engine module (paths ending in the module), so a failure points at the right RTL.
set mf [open [file join $rep_dir eog_module_slack.txt] w]
puts $mf "fclk ${fclk_mhz} MHz; worst setup path ending in each module"
foreach m {unpack validate features memory countdown head alarm pack regs} {
    set cells [get_cells -quiet -hier -filter "NAME =~ */u_eog/u_${m}/*"]
    if {[llength $cells] == 0} { puts $mf "$m: no cells"; continue }
    set p [get_timing_paths -quiet -setup -max_paths 1 -to $cells]
    if {$p eq ""} { puts $mf "$m: no constrained path"; continue }
    puts $mf [format "%-10s slack %8.3f ns  levels %3s  from %s  to %s" $m [get_property SLACK $p] \
        [get_property LOGIC_LEVELS $p] [get_property STARTPOINT_PIN $p] [get_property ENDPOINT_PIN $p]]
}
close $mf
status "WNS $wns WHS $whs (fclk ${fclk_mhz} MHz)"
if {$wns < 0 || $whs < 0} { status "FAIL timing not met"; error "Timing not met (WNS $wns, WHS $whs)" }

set bit_out [file join $out_dir ${proj_name}.bit]
set xsa_out [file join $out_dir ${proj_name}.xsa]
write_bitstream -force $bit_out
status "bitstream $bit_out"
for {set try 1} {$try <= 5} {incr try} {
    if {![catch {write_hw_platform -fixed -force $xsa_out} err]} { break }
    puts "WARNING: write_hw_platform attempt $try failed: $err"
    after 2000
}
if {![file exists $xsa_out]} { status "FAIL write_hw_platform"; error "write_hw_platform failed 5 times" }
status "xsa $xsa_out"
status "DONE"
