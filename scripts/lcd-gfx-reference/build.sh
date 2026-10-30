#!/bin/sh
# Builds the reference drawer from the firmware's lcd_gfx.c and redraws the
# fixture scene (see main.c). Needs a host C compiler.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
gfx="$root/firmware/esp32-cat-bridge/main"
fix="$root/src/lib/lcd/__tests__/fixtures"
out=$(mktemp -d)
cc -std=c11 -O1 -Wall -I"$here" -I"$gfx" -o "$out/lcd-gfx-reference" "$here/main.c" "$gfx/lcd_gfx.c" -lm
"$out/lcd-gfx-reference" "$fix/scene.txt" "$fix/scene.bin"
rm -rf "$out"
