#!/usr/bin/env bash
# lint.sh [module] — Verilator lint of rtl/eog_<module>.sv (or every rtl/eog_*.sv).
set -u
cd "$(dirname "$0")/.." || exit 2
EOG_SELF="scripts/$(basename "$0")"; . scripts/env.sh
files=$( [ $# -gt 0 ] && echo "rtl/eog_$1.sv" || ls rtl/eog_*.sv 2>/dev/null )
rc=0
for f in $files; do
  top=$(basename "$f" .sv)
  verilator --lint-only -Wall -Irtl --top-module "$top" rtl/eog_*.sv \
    && echo "lint ok: $top" || { echo "lint FAIL: $top"; rc=1; }
done
exit $rc
