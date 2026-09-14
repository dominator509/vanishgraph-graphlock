#!/usr/bin/env sh
# Test collection guard (DOD-007). Sentinel: `test collection guard: ok`
#
# Real implementation (EP-000 M2). This script previously printed
# "test-collection-guard.sh: accounted" with no check of any kind.
#
# Why this gate exists: many runners exit zero for an empty, misconfigured, or
# partially discovered suite. A green suite that collected nothing is the most
# dangerous result in the harness because it is indistinguishable from success.
#
# Fails when: the runner produced no parseable TAP summary; zero tests were
# collected; a suite named in .agent/verification/EXPECTED_TEST_MANIFEST.txt
# produced no results; or any collected test failed.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "test collection guard: FAIL - node is required but not found" >&2; exit 1; }

MANIFEST=.agent/verification/EXPECTED_TEST_MANIFEST.txt
[ -f "$MANIFEST" ] || { echo "test collection guard: FAIL - expected-test manifest $MANIFEST is missing" >&2; exit 1; }

node --test --test-reporter=junit "tests/**/*.test.ts" \
  | VG_EXPECTED_MANIFEST="$MANIFEST" node scripts/count-tests.mjs

echo "test collection guard: ok"
