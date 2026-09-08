#!/usr/bin/env sh
set -eu
case "${1:-tail}" in tail) tail -n "${2:-30}" .agent/state/LEDGER.md ;; append) printf "| %s | %s | %s | %s |\n" "$(date -u +%FT%TZ)" "${2:-FORGE}" "${3:-EVENT}" "${4:-recorded}" >> .agent/state/LEDGER.md ;; *) echo "ledger: unsupported operation" >&2; exit 1;; esac
