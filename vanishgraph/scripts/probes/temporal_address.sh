#!/usr/bin/env sh
set -eu
value="${TEMPORAL_ADDRESS:-}"
[ -n "$value" ] || exit 1
exit 0
