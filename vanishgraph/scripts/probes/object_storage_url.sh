#!/usr/bin/env sh
set -eu
value="${OBJECT_STORAGE_URL:-}"
[ -n "$value" ] || exit 1
exit 0
