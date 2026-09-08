#!/usr/bin/env sh
set -eu
[ -f PREFLIGHT.md ] || exit 1
[ -f .env ] || { echo "preflight: FAIL - missing .env" >&2; exit 1; }
echo "preflight: ok"
