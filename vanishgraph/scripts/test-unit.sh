#!/usr/bin/env sh
# Unit test stage. Sentinel: `test-unit: ok`
#
# Real implementation (EP-000 M2). This script previously printed
# "test-unit.sh: accounted" with no check of any kind.
#
# Runs the domain unit suite with Node's built-in test runner directly against the
# TypeScript sources (Node >= 24 strips types natively). That keeps the domain layer
# free of runtime dependencies, which is what the ARCHITECTURE.md code law requires.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "test-unit: FAIL - node is required but not found" >&2; exit 1; }
[ -d tests ] || { echo "test-unit: FAIL - tests/ directory is missing" >&2; exit 1; }

node --test "tests/**/*.test.ts"

echo "test-unit: ok"
