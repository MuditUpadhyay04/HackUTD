#!/usr/bin/env bash
# formal.sh <module> — run SymbiYosys for one module; writes reports/formal_<module>.txt
# Looks for formal/<module>/eog_<module>.sby, then formal/<module>/<module>.sby, then formal/<module>.sby (axi_mul).
set -u
cd "$(dirname "$0")/.." || exit 2
EOG_SELF="scripts/$(basename "$0")"; . scripts/env.sh
m=${1:?usage: formal.sh <module>}
mkdir -p reports
for c in "formal/$m/eog_$m.sby" "formal/$m/$m.sby" "formal/$m.sby"; do
  [ -f "$c" ] && { sby_file=$c; break; }
done
[ -n "${sby_file:-}" ] || { echo "FAIL: no .sby for $m"; exit 2; }
dir=$(dirname "$sby_file"); base=$(basename "$sby_file" .sby)
( cd "$dir" && sby -f "$base.sby" ) > "reports/formal_$m.log" 2>&1
rc=$?
{
  echo "# formal $m  $(date -u +%Y-%m-%dT%H:%M:%SZ)  sby rc=$rc  ($sby_file)"
  for s in "$dir/${base}"_*/status; do
    [ -f "$s" ] && echo "$(basename "$(dirname "$s")"): $(head -n1 "$s")"
  done
} > "reports/formal_$m.txt"
cat "reports/formal_$m.txt"
[ $rc -eq 0 ] && echo "RESULT: PASS formal $m" || echo "RESULT: FAIL formal $m (see reports/formal_$m.log)"
exit $rc
