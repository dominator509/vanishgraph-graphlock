#!/usr/bin/env sh
set -eu
value="${STAGING_KUBECONFIG:-}"
[ -n "$value" ] || exit 1
exit 0
