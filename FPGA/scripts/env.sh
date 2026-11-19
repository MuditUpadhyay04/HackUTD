# env.sh — sourced by every FPGA/scripts/*.sh (and by wsl.sh). Not executable on its own.
#
# 1. Finds the OSS CAD Suite: $OSS_CAD_SUITE, ~/oss-cad-suite or /opt/oss-cad-suite (sources its `environment`).
# 2. On Windows (Git Bash / MSYS) with no local yosys, re-runs the calling script inside WSL
#    (distro $EOG_WSL_DISTRO, default Ubuntu-24.04) in the same directory, with the same arguments.
# 3. Sets EOG_DATA (practice dataset) if unset: the HackUTD-ZeroDay clone next to the main checkout,
#    found through git's common dir, so it also works from a linked worktree.
#
# Caller contract: set EOG_SELF to the script path (as invoked) before sourcing; the caller has already done
# `cd FPGA/` (scripts run from the FPGA directory).

_eog_find_suite() {
  command -v yosys >/dev/null 2>&1 && return 0
  local e
  for e in "${OSS_CAD_SUITE:+$OSS_CAD_SUITE/environment}" "$HOME/oss-cad-suite/environment" /opt/oss-cad-suite/environment; do
    if [ -n "$e" ] && [ -f "$e" ]; then
      # the suite's environment script edits PS1; harmless in non-interactive shells
      # shellcheck disable=SC1090
      . "$e"
      return 0
    fi
  done
  return 1
}

if [ -z "${EOG_DATA:-}" ]; then
  _c=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -n "$_c" ]; then
    _d="$(dirname "$(dirname "$_c")")/HackUTD-ZeroDay"
    [ -d "$_d" ] && export EOG_DATA="$_d"
  fi
  unset _c _d
fi

if ! _eog_find_suite; then
  if [ -z "${EOG_IN_WSL:-}" ] && command -v wsl.exe >/dev/null 2>&1; then
    _here=$(pwd -W 2>/dev/null || pwd)
    _data=""
    if [ -n "${EOG_DATA:-}" ]; then _data=$(cd "$EOG_DATA" 2>/dev/null && (pwd -W 2>/dev/null || pwd)); fi
    # --exec: no shell re-parsing of the arguments; wslpath turns C:/... into /mnt/c/...
    MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' exec wsl.exe -d "${EOG_WSL_DISTRO:-Ubuntu-24.04}" --exec bash -c '
      here=$(wslpath -u "$1"); data=$2; shift 2
      [ -n "$data" ] && export EOG_DATA=$(wslpath -u "$data")
      export EOG_IN_WSL=1
      cd "$here" || exit 97
      exec "$@"' _ "$_here" "$_data" bash "$EOG_SELF" "$@"
  fi
  echo "env.sh: OSS CAD Suite not found (install it under Linux/WSL2, see FPGA/KICKOFF.md)" >&2
  exit 98
fi
