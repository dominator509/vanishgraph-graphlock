#!/usr/bin/env sh
set -eu
L=.agent/state/LEDGER.md
cmd=${1:-};shift || true
case $cmd in append) printf '%s | %s | %s | %s | %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "${4:-}" >>$L;; status) grep -E "\| $1 \|" $L|tail -1|grep -q NODE_DONE&&echo DONE||echo PENDING;; tail) tail -n ${1:-30} $L;; *) exit 2;; esac
