#!/usr/bin/env sh
set -eu
value="${KMS_KEY_ID:-}"
[ -n "$value" ] || exit 1
exit 0
