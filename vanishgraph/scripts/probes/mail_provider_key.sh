#!/usr/bin/env sh
set -eu
value="${MAIL_PROVIDER_KEY:-}"
[ -n "$value" ] || exit 1
exit 0
