# board_temp.tcl: the Zynq die temperature and core supplies, read over JTAG from the XADC (Vivado Hardware Manager).
# Read-only: it never programs or resets the device, so it can run while the board streams (and during the demo).
#   vivado -mode batch -nolog -nojournal -source board_temp.tcl -tclargs [samples] [seconds_between]
set n      [expr {[llength $argv] > 0 ? [lindex $argv 0] : 30}]
set period [expr {[llength $argv] > 1 ? [lindex $argv 1] : 10}]
set log [open [file join [file dirname [file normalize [info script]]] board_temp.log] a]
proc say {msg} { global log; puts $msg; puts $log $msg; flush $log }

open_hw_manager
connect_hw_server
open_hw_target
set dev ""
foreach d [get_hw_devices] { if {[string match -nocase "xc7z*" [get_property NAME $d]]} { set dev $d; break } }
if {$dev eq ""} { say "NO_DEVICE: no Zynq (xc7z*) on the JTAG chain: is the USB cable in and the board powered?"; exit 1 }
current_hw_device $dev
catch {refresh_hw_device -update_hw_probes false $dev}
set sm [lindex [get_hw_sysmons -of_objects $dev] 0]
if {$sm eq ""} { say "NO_SYSMON: Vivado found no XADC on $dev"; exit 1 }
set props [list_property $sm]
set volts {}
foreach p {VCCINT VCCAUX VCCBRAM VCCPINT VCCPAUX} { if {[lsearch -exact $props $p] >= 0} { lappend volts $p } }
say "== [clock format [clock seconds] -format {%Y-%m-%d %H:%M:%S}] $dev: $n samples every $period s"
set peak -1000
for {set i 0} {$i < $n} {incr i} {
    refresh_hw_sysmon $sm
    set t [get_property TEMPERATURE $sm]
    if {$t > $peak} { set peak $t }
    set line "[clock format [clock seconds] -format %H:%M:%S]  die [format %.1f $t] C"
    foreach p $volts { append line "  $p [format %.3f [get_property $p $sm]] V" }
    if {$t >= 80} { append line "  HOT: near the 85 C limit of a commercial-grade part; add airflow now" } \
    elseif {$t >= 70} { append line "  WARM: watch it; point a fan at the heatsink" }
    say $line
    if {$i < $n - 1} { after [expr {$period * 1000}] }
}
say "peak [format %.1f $peak] C"
close_hw_target
disconnect_hw_server
close_hw_manager
