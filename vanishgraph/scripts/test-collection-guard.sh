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
# Fails when: the runner produced no parseable JUnit summary; zero real tests were
# collected; a suite named in the expected manifest produced no results, or ran but
# contributed no real tests (an emptied suite); or any collected test failed.
#
# PARAMETERISED (EP-000 M2 fix). The suit glob and the manifest are overridable so
# that this one guard serves every suite rather than only the unit suite:
#
#   VG_TEST_GLOB          glob passed to `node --test`   (default tests/**/*.test.ts)
#   VG_EXPECTED_MANIFEST  manifest path                  (default EXPECTED_TEST_MANIFEST.txt)
#
# This matters because EP-003 runs the database suite through the same guard with
# `VG_TEST_GLOB="tests/db/**/*.test.ts"` and
# `VG_EXPECTED_MANIFEST=.agent/verification/EXPECTED_INTEGRATION_MANIFEST.txt`.
# The previous version hard-coded both values and overwrote any incoming
# VG_EXPECTED_MANIFEST, so EP-003's milestone could not have worked as written —
# the integration suite would silently have been checked against the unit manifest
# and the unit glob. Two suites, one guard, no silent cross-checking.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "test collection guard: FAIL - node is required but not found" >&2; exit 1; }

GLOB="${VG_TEST_GLOB:-tests/**/*.test.ts}"
MANIFEST="${VG_EXPECTED_MANIFEST:-.agent/verification/EXPECTED_TEST_MANIFEST.txt}"

[ -f "$MANIFEST" ] || { echo "test collection guard: FAIL - expected-test manifest $MANIFEST is missing" >&2; exit 1; }

node --test --test-reporter=junit "$GLOB" \
  | VG_EXPECTED_MANIFEST="$MANIFEST" node scripts/count-tests.mjs

echo "test collection guard: ok"
