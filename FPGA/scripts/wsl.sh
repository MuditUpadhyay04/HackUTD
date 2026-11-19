#!/usr/bin/env bash
# wsl.sh <command> [args...] — run any command with the OSS CAD Suite on PATH and EOG_DATA set, in the current
# directory. On Linux/WSL it just runs it; on Windows (Git Bash) it runs it inside WSL.
#   bash FPGA/scripts/wsl.sh python3 FPGA/model/test_model.py
#   bash FPGA/scripts/wsl.sh yosys -p "read_verilog -sv -I FPGA/rtl FPGA/rtl/eog_mul.sv; synth -top eog_mul"
# The lint/sim/formal/check_all scripts do this themselves; call them directly.
set -u
[ $# -gt 0 ] || { echo "usage: wsl.sh <command> [args...]" >&2; exit 2; }
_eog_dir=$(cd "$(dirname "$0")" && pwd)
if [ -z "${EOG_IN_WSL:-}" ] && ! command -v yosys >/dev/null 2>&1 && command -v wsl.exe >/dev/null 2>&1 \
   && ! [ -f "$HOME/oss-cad-suite/environment" ]; then
  # Windows: re-run this wrapper inside WSL, from the same directory
  EOG_SELF=$(cd "$_eog_dir" && (pwd -W 2>/dev/null || pwd))/wsl.sh
  _here=$(pwd -W 2>/dev/null || pwd)
  _data=""
  if [ -z "${EOG_DATA:-}" ]; then
    _c=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
    [ -n "$_c" ] && [ -d "$(dirname "$(dirname "$_c")")/HackUTD-ZeroDay" ] && EOG_DATA="$(dirname "$(dirname "$_c")")/HackUTD-ZeroDay"
  fi
  if [ -n "${EOG_DATA:-}" ]; then _data=$(cd "$EOG_DATA" 2>/dev/null && (pwd -W 2>/dev/null || pwd)); fi
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' exec wsl.exe -d "${EOG_WSL_DISTRO:-Ubuntu-24.04}" --exec bash -c '
    here=$(wslpath -u "$1"); data=$2; self=$(wslpath -u "$3"); shift 3
    [ -n "$data" ] && export EOG_DATA=$(wslpath -u "$data")
    export EOG_IN_WSL=1
    cd "$here" || exit 97
    exec bash "$self" "$@"' _ "$_here" "$_data" "$EOG_SELF" "$@"
fi
EOG_SELF="$0"
# shellcheck disable=SC1091
. "$_eog_dir/env.sh"
exec "$@"
