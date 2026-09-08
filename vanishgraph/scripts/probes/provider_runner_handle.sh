#!/usr/bin/env sh
set -eu
value="${PROVIDER_RUNNER_HANDLE:-}"
[ -n "$value" ] || exit 1
exit 0
