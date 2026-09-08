#!/usr/bin/env sh
set -eu
value="${GITHUB_APP_ID:-}"
[ -n "$value" ] || exit 1
exit 0
