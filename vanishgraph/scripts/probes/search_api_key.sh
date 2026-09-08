#!/usr/bin/env sh
set -eu
value="${SEARCH_API_KEY:-}"
[ -n "$value" ] || exit 1
exit 0
