#!/usr/bin/env sh
set -eu
value="${DATABASE_URL:-}"
[ -n "$value" ] || exit 1
exit 0
