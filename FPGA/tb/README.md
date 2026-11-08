# tb/ — simulation testbenches (Verify role)

`tb/<module>/` holds `tb_eog_<module>.sv` and `files.f` (paths relative to `FPGA/`, e.g. `rtl/eog_mul.sv`,
`rtl/eog_validate.sv`, `tb/validate/tb_eog_validate.sv`). `scripts/sim.sh <module>` compiles with
`iverilog -g2012 -I rtl -I formal/common -c tb/<module>/files.f`.

Each testbench: loads `tb/vectors/<module>_*.{in,out,cfg,wts}.hex` with `$readmemh`, drives the input with random
`in_valid` gaps and random `out_ready` back-pressure (fixed seed, plus one run with ready always 1 that also checks
II ≤ 16), compares every output bus bit for bit, and prints exactly one final line: `PASS: <n> records` or
`FAIL: <first mismatch: record, field, expected, got>`. Field names in messages come from `eog_defs.svh` offsets.
