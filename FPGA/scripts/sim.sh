#!/usr/bin/env bash
# sim.sh <module> — Icarus simulation of tb/<module>/ (file list tb/<module>/files.f, paths relative to FPGA/).
# The testbench must print a line containing PASS on success and FAIL on any mismatch.
set -u
cd "$(dirname "$0")/.." || exit 2
EOG_SELF="scripts/$(basename "$0")"; . scripts/env.sh
m=${1:?usage: sim.sh <module>}
mkdir -p build reports
if [ "$m" = axi_mul ]; then
  iverilog -g2012 -o build/sim_axi_mul tb/tb_axi_mul.v rtl/axi_mul.v || exit 1
else
  [ -f "tb/$m/files.f" ] || { echo "FAIL: no tb/$m/files.f"; exit 2; }
  iverilog -g2012 -I rtl -I formal/common -c "tb/$m/files.f" -o "build/sim_$m" || exit 1
fi
vvp -n "build/sim_$m" | tee "reports/sim_$m.log"
grep -q "FAIL" "reports/sim_$m.log" && { echo "RESULT: FAIL sim $m"; exit 1; }
grep -q "PASS" "reports/sim_$m.log" && { echo "RESULT: PASS sim $m"; exit 0; }
echo "RESULT: FAIL sim $m (no PASS line)"; exit 1
