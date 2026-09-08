#!/usr/bin/env sh
set -eu
value="${BILLING_PROVIDER_KEY:-}"
[ -n "$value" ] || exit 1
exit 0
