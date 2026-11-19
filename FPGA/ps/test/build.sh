#!/usr/bin/env bash
# build.sh — compile the host test binaries for eog_proto (gcc; on Windows run through FPGA/scripts/wsl.sh).
#   bash FPGA/scripts/wsl.sh bash FPGA/ps/test/build.sh
# Output: FPGA/ps/test/build/{test_proto,simboard} (build/ is git-ignored).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/build"
mkdir -p "$out"
CFLAGS="-std=c99 -O2 -Wall -Wextra -Werror -Wconversion -Wno-sign-conversion -Wshadow -Wstrict-prototypes -g"
# small rings so overflow is testable
gcc $CFLAGS -DEOG_RES_RING=128 -DEOG_AL_RING=16 -o "$out/test_proto" \
    "$here/test_proto.c" "$here/fake_regs.c" "$here/../eog_proto.c"
gcc $CFLAGS -D_POSIX_C_SOURCE=200809L -DEOG_RES_RING=65536 -o "$out/simboard" \
    "$here/simboard.c" "$here/fake_regs.c" "$here/../eog_proto.c"
echo "built $out/test_proto $out/simboard"
