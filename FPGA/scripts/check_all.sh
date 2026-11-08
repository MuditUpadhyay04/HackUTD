#!/usr/bin/env bash
# check_all.sh — lint, simulate and prove every module that has the pieces; writes reports/SUMMARY.md
set -u
cd "$(dirname "$0")/.."
mkdir -p reports
out=reports/SUMMARY.md
{
  echo "# FPGA check summary — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "Tools: $(yosys -V 2>/dev/null | head -n1); $(iverilog -V 2>/dev/null | head -n1); $(verilator --version 2>/dev/null)"
  echo
  echo "| Module | Lint | Sim | Formal |"
  echo "| --- | --- | --- | --- |"
} > "$out"
mods=$( (ls rtl/eog_*.sv 2>/dev/null | sed 's#rtl/eog_\(.*\)\.sv#\1#'; echo axi_mul) | sort -u )
fail=0
for m in $mods; do
  l=n/a; s=n/a; f=n/a
  [ -f "rtl/eog_$m.sv" ] && { bash scripts/lint.sh "$m" >/dev/null 2>&1 && l=PASS || { l=FAIL; fail=1; }; }
  { [ -d "tb/$m" ] || [ "$m" = axi_mul ]; } && { bash scripts/sim.sh "$m" >/dev/null 2>&1 && s=PASS || { s=FAIL; fail=1; }; }
  { [ -d "formal/$m" ] || [ -f "formal/$m.sby" ]; } && { bash scripts/formal.sh "$m" >/dev/null 2>&1 && f=PASS || { f=FAIL; fail=1; }; }
  echo "| $m | $l | $s | $f |" >> "$out"
done
cat "$out"
exit $fail
