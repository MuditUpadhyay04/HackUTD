# xsdb_deploy.tcl — program PL, init PS, download and run the ELF over JTAG.
#   xsdb xsdb_deploy.tcl <bit> <ps7_init.tcl> <elf>
lassign $argv bit ps7init elf
foreach f [list $bit $ps7init $elf] {
    if {![file exists $f]} { puts "DEPLOY_FAIL missing $f"; exit 1 }
}
connect
after 500
puts "targets:"; puts [targets]
targets -set -nocase -filter {name =~ "APU*"}
rst -system
after 2000
targets -set -nocase -filter {name =~ "xc7z*"}
fpga -file $bit
targets -set -nocase -filter {name =~ "APU*"}
source $ps7init
ps7_init
ps7_post_config
targets -set -nocase -filter {name =~ "*A9*#0"}
dow $elf
con
puts "DEPLOY_OK"
disconnect
exit 0
