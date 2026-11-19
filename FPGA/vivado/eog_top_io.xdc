# eog_top_io.xdc -- DRAFT pin constraints for eog_top's board I/O on the Eclypse Z7 (task T2.bd1 confirms them).
#
# Pins come from the Digilent board files in vivado/boards/eclypse-z7/<rev>/part0_pins.xml. The LEDs and BTN0
# are the same on revisions A.0 and B.0; the Pmod JA/JB pins DIFFER between them. Active below: B.0.
# Check the board revision (silkscreen) and Digilent's master XDC before the first bitstream.
#
# Port names assume the block-design ports are made external with these names
# (make_bd_pins_external, then rename to btn0 / ld0 / ld1 / pmod_ja / pmod_jb).
#
# LED colour order: eog_alarm drives ld[2] = red, ld[1] = green, ld[0] = blue. Board-file order of
# rgbled_6bits is A17, B16, B17 (LD0) and A16, A18, A19 (LD1), which the master XDC names led0_b, led0_g,
# led0_r, led1_b, led1_g, led1_r (verify).
# BTN0 is expected to be active high on the board (Digilent convention; verify); eog_alarm expects active high (TASKS.md question 8), so no inversion.

set_property -dict { PACKAGE_PIN C17 IOSTANDARD LVCMOS33 } [get_ports { btn0 }]

set_property -dict { PACKAGE_PIN A17 IOSTANDARD LVCMOS33 } [get_ports { ld0[0] }]
set_property -dict { PACKAGE_PIN B16 IOSTANDARD LVCMOS33 } [get_ports { ld0[1] }]
set_property -dict { PACKAGE_PIN B17 IOSTANDARD LVCMOS33 } [get_ports { ld0[2] }]
set_property -dict { PACKAGE_PIN A16 IOSTANDARD LVCMOS33 } [get_ports { ld1[0] }]
set_property -dict { PACKAGE_PIN A18 IOSTANDARD LVCMOS33 } [get_ports { ld1[1] }]
set_property -dict { PACKAGE_PIN A19 IOSTANDARD LVCMOS33 } [get_ports { ld1[2] }]

# Pmod JA / JB, rev B.0: pmod_x[0..3] = pins 1..4, pmod_x[4..7] = pins 7..10
set_property -dict { PACKAGE_PIN B15 IOSTANDARD LVCMOS33 } [get_ports { pmod_ja[0] }]
set_property -dict { PACKAGE_PIN C15 IOSTANDARD LVCMOS33 } [get_ports { pmod_ja[1] }]
set_property -dict { PACKAGE_PIN D15 IOSTANDARD LVCMOS33 } [get_ports { pmod_ja[2] }]
set_property -dict { PACKAGE_PIN E16 IOSTANDARD LVCMOS33 } [get_ports { pmod_ja[3] }]
set_property -dict { PACKAGE_PIN E15 IOSTANDARD LVCMOS33 } [get_ports { pmod_ja[4] }]
set_property -dict { PACKAGE_PIN F17 IOSTANDARD LVCMOS33 } [get_ports { pmod_ja[5] }]
set_property -dict { PACKAGE_PIN F16 IOSTANDARD LVCMOS33 } [get_ports { pmod_ja[6] }]
set_property -dict { PACKAGE_PIN G16 IOSTANDARD LVCMOS33 } [get_ports { pmod_ja[7] }]
set_property -dict { PACKAGE_PIN G15 IOSTANDARD LVCMOS33 } [get_ports { pmod_jb[0] }]
set_property -dict { PACKAGE_PIN D16 IOSTANDARD LVCMOS33 } [get_ports { pmod_jb[1] }]
set_property -dict { PACKAGE_PIN D17 IOSTANDARD LVCMOS33 } [get_ports { pmod_jb[2] }]
set_property -dict { PACKAGE_PIN E18 IOSTANDARD LVCMOS33 } [get_ports { pmod_jb[3] }]
set_property -dict { PACKAGE_PIN F18 IOSTANDARD LVCMOS33 } [get_ports { pmod_jb[4] }]
set_property -dict { PACKAGE_PIN G17 IOSTANDARD LVCMOS33 } [get_ports { pmod_jb[5] }]
set_property -dict { PACKAGE_PIN H18 IOSTANDARD LVCMOS33 } [get_ports { pmod_jb[6] }]
set_property -dict { PACKAGE_PIN H17 IOSTANDARD LVCMOS33 } [get_ports { pmod_jb[7] }]

# Rev A.0 Pmod pins (replace the block above on an A.0 board):
#   pmod_ja[0..7] = H17 H18 E16 F16 D17 D16 D15 E15
#   pmod_jb[0..7] = G16 G15 E18 F18 F17 G17 B15 C15

# btn0 is asynchronous (2-flop synchronizer in eog_alarm); LEDs/Pmods are static indicators.
set_false_path -from [get_ports btn0]
set_false_path -to [get_ports {ld0[*] ld1[*] pmod_ja[*] pmod_jb[*]}]
