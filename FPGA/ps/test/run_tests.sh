#!/usr/bin/env bash
# run_tests.sh — all host tests for the ARM app (T2.ps1). From the repo root, in Git Bash on Windows:
#   bash FPGA/ps/test/run_tests.sh [--quick]
# 1. builds test_proto + simboard with gcc in WSL (FPGA/scripts/wsl.sh)
# 2. test_proto: C unit tests against the fake eog_regs (+ Mudit's v3 weight blob for CRC/self-test and the SD boot load)
# 3. test_wire.py: packets from the C code byte-compared with wire.py + golden RESULT/ALERT bytes (v3, v2)
# 4. test_loopback.py: Mudit's hutd_ml.board against the C code over UDP on 127.0.0.2 (incl. heartbeat gap)
# 5. test_sd_boot.py: weights.eog from deploy/make_weights_sd.py loaded by the C SD boot path; golden g0 with the
#    model from the card only (no WEIGHTS sent); missing card/file, bad CRC, version 0, failing self-test
# Needs Mudit's ml checkout (HUTD_ML=<dir containing hutd_ml>, found automatically next to the repo) and numpy.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PY=${PYTHON:-python}
G1=-1; LOOP_G1=--g1
if [ "${1:-}" = "--quick" ]; then G1=1500; LOOP_G1=; fi
bash FPGA/scripts/wsl.sh bash FPGA/ps/test/build.sh
ML=$($PY -c "import sys; sys.path.insert(0, 'FPGA/ps/test'); import simboard_bridge as s; print(s.default_ml_dir())")
BLOB="$ML/artifacts/v3/golden/g0/weights.bin"
CRC=$($PY -c "import json,sys; print(json.load(open(sys.argv[1]))['weights_crc32'])" "$ML/artifacts/v3/golden/g0/manifest.json")
BLOB_W=$(cd "$(dirname "$BLOB")" && pwd -W 2>/dev/null || pwd)/weights.bin
BLOB_L=$(bash FPGA/scripts/wsl.sh wslpath -u "$BLOB_W" 2>/dev/null || echo "$BLOB")
echo "== test_proto"; bash FPGA/scripts/wsl.sh FPGA/ps/test/build/test_proto "$BLOB_L" "$CRC" | tail -3
echo "== test_wire";  $PY FPGA/ps/test/test_wire.py --g1 "$G1" | tail -12
echo "== test_loopback"; $PY FPGA/ps/test/test_loopback.py $LOOP_G1 | grep -E "^(g|test_)"
echo "== test_sd_boot"; $PY FPGA/ps/test/test_sd_boot.py | grep -E "(PASS|FAIL)"
