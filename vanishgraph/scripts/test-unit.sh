#!/usr/bin/env sh
# Unit test stage. Sentinel: `test-unit: ok`
#
# Real implementation (EP-000 M2). This script previously printed
# "test-unit.sh: accounted" with no check of any kind.
#
# Runs pure suites against the TypeScript sources with Node's built-in test runner
# (Node >= 24 strips types natively), so the domain layer needs no runtime dependency
# — which is what the ARCHITECTURE.md code law requires.
#
# SERVICE-DEPENDENT SUITES ARE EXCLUDED. The original version ran
# `node --test "tests/**/*.test.ts"`, which sweeps in every suite under tests/,
# including those that need a provisioned PostgreSQL, a running API, or a built
# artifact. That would make the unit stage unrunnable on a clean checkout and would
# turn a harness limitation into an apparent product failure — exactly the confusion
# DOD-032 forbids.
#
# The exclusion list below is the single definition of "service-dependent" and must
# stay in step with the suite table in TESTING.md. Adding a new service-dependent root
# means adding it here, in `scripts/test-integration.sh`, and in TESTING.md.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "test-unit: FAIL - node is required but not found" >&2; exit 1; }
[ -d tests ] || { echo "test-unit: FAIL - tests/ directory is missing" >&2; exit 1; }

FILES=""
for f in $(find tests -name '*.test.ts' | sort); do
  case "$f" in
    tests/integration/*|tests/db/*|tests/blackbox/*|tests/api/*|tests/e2e/*|tests/live-fire/*|tests/release/*)
      continue ;;
  esac
  FILES="$FILES $f"
done

[ -n "$FILES" ] || { echo "test-unit: FAIL - no pure test files found; refusing to report a green unit stage" >&2; exit 1; }

# Unquoted expansion is deliberate: the file list is passed as separate arguments.
# shellcheck disable=SC2086
node --test $FILES

echo "test-unit: ok"
