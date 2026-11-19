# eog_top_files.tcl -- source list of the EOG engine (eog_top) for Vivado.
#
# Usage, from an open project (project mode, e.g. after create_project in build.tcl):
#     source [file join <FPGA>/vivado eog_top_files.tcl]
#     eog_add_files              ;# add_files + include dir; block-design module reference: eog_top_bd
# or non-project mode:
#     source eog_top_files.tcl
#     eog_read_files             ;# read_verilog -sv ... ; then synth_design -top eog_top (or eog_top_bd)
#
# Optional: set eog_top_name before sourcing to change the top set by eog_add_files (default eog_top_bd, the
# Verilog shell the block design references; use eog_top for an out-of-context check of the engine alone).

set eog_vivado_dir [file dirname [file normalize [info script]]]
set eog_root       [file normalize [file join $eog_vivado_dir ..]]
set eog_rtl_dir    [file join $eog_root rtl]
if {![info exists eog_top_name]} { set eog_top_name eog_top_bd }

# Every module includes rtl/eog_defs.svh inside its body; the include directory is all it needs.
set eog_sv_files [list \
    [file join $eog_rtl_dir eog_mul.sv] \
    [file join $eog_rtl_dir eog_div.sv] \
    [file join $eog_rtl_dir eog_unpack.sv] \
    [file join $eog_rtl_dir eog_validate.sv] \
    [file join $eog_rtl_dir eog_features.sv] \
    [file join $eog_rtl_dir eog_memory.sv] \
    [file join $eog_rtl_dir eog_countdown.sv] \
    [file join $eog_rtl_dir eog_head.sv] \
    [file join $eog_rtl_dir eog_alarm.sv] \
    [file join $eog_rtl_dir eog_pack.sv] \
    [file join $eog_rtl_dir eog_regs.sv] \
    [file join $eog_rtl_dir eog_top.sv] \
]
set eog_hdr_file [file join $eog_rtl_dir eog_defs.svh]
set eog_v_files  [list [file join $eog_vivado_dir eog_top_bd.v]]

proc eog_read_files {} {
    global eog_sv_files eog_v_files eog_rtl_dir
    read_verilog -sv $eog_sv_files
    read_verilog $eog_v_files
    # include path for eog_defs.svh (non-project mode)
    set_property include_dirs [list $eog_rtl_dir] [current_fileset]
}

proc eog_add_files {} {
    global eog_sv_files eog_v_files eog_hdr_file eog_rtl_dir eog_top_name
    add_files -norecurse $eog_sv_files
    add_files -norecurse $eog_hdr_file
    set_property file_type {Verilog Header} [get_files $eog_hdr_file]
    set_property is_global_include false [get_files $eog_hdr_file]
    foreach f $eog_sv_files { set_property file_type SystemVerilog [get_files $f] }
    add_files -norecurse $eog_v_files
    set_property include_dirs [list $eog_rtl_dir] [get_filesets sources_1]
    # The block design wraps everything, so its wrapper is the real top; eog_top_name is used for an
    # out-of-context synthesis of the engine alone.
    if {[llength [get_files -quiet *.bd]] == 0} {
        set_property top $eog_top_name [get_filesets sources_1]
    }
    update_compile_order -fileset sources_1
}
