#!/usr/bin/env sh
# Regression proof stage (DOD-018, EP-007 M2). Sentinel: `regression proof: ok`
#
# WHAT IT RUNS: the twelve `LIVE-FIRE-PROOF-0N` suites, one per core outcome, and it requires each one to run AND to
# pass. A suite that is missing, that contributes no test, or that fails is a failure of this stage, named individually:
# a stage that reported one number for twelve suites would hide which outcome stopped being proven.
#
# WHY THE SUITES ARE LISTED BY PATH RATHER THAN GLOBED: deleting or renaming a suite is exactly the change this stage
# must notice, and a glob would collect one fewer file and still print its sentinel. The list below is the contract, and
# `EXPECTED_TEST_MANIFEST.txt` carries the same twelve paths for the unit stage, so the two cannot drift apart without
# one of them failing.
#
# THE VERDICT COMES FROM THE JUNIT SUMMARY through `scripts/count-tests.mjs`, which gives the test count, the failure
# count and the verdict per suite as one JSON line and NAMES each failing test rather than only counting them.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

EVIDENCE=.agent/evidence/regression
mkdir -p "$EVIDENCE"

fail() { echo "regression proof: FAIL - $1" >&2; exit 1; }
error() { echo "regression proof: ERROR - $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || error "node is required but not found"

SUITES="tests/regression/live-fire-proof-01.test.ts
tests/regression/live-fire-proof-02.test.ts
tests/regression/live-fire-proof-03.test.ts
tests/regression/live-fire-proof-04.test.ts
tests/regression/live-fire-proof-05.test.ts
tests/regression/live-fire-proof-06.test.ts
tests/regression/live-fire-proof-07.test.ts
tests/regression/live-fire-proof-08.test.ts
tests/regression/live-fire-proof-09.test.ts
tests/regression/live-fire-proof-10.test.ts
tests/regression/live-fire-proof-11.test.ts
tests/regression/live-fire-proof-12.test.ts"

{
  echo "regression proof - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
} >"$EVIDENCE/run.txt"

set -f
total=0
seen=0
for suite in $SUITES; do
  [ -f "$suite" ] || fail "$suite is missing; this stage's contract is the twelve suites it names"
  if summary=$(node --test --test-reporter=junit "$suite" 2>"$EVIDENCE/$(basename "$suite" .test.ts).txt" | node scripts/count-tests.mjs); then
    status=0
  else
    status=$?
  fi
  line=$(printf '%s\n' "$summary" | grep -E '^\{"tests":' | tail -n 1)
  [ -n "$line" ] || fail "$suite produced no JUnit summary (exit $status); nothing can be compared"
  printf '%s exit=%s %s\n' "$suite" "$status" "$line" >>"$EVIDENCE/run.txt"

  count=$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(String(r.tests))' "$line") \
    || error "could not read the test count for $suite"
  [ "$count" -gt 0 ] || fail "$suite collected no tests; an outcome proven by nothing is not proven (DOD-007)"
  [ "$status" -eq 0 ] || fail "$suite failed (exit $status); see $EVIDENCE/$(basename "$suite" .test.ts).txt"
  case "$line" in
    *'"fail":0'*) ;;
    *) fail "$suite reported failures: $line" ;;
  esac

  echo "regression proof: $suite $count test(s) PASS"
  total=$((total + count))
  seen=$((seen + 1))
done
set +f

[ "$seen" -eq 12 ] || fail "only $seen of the twelve outcomes ran"
echo "regression proof: $total test(s) across $seen outcomes; every LIVE-FIRE-PROOF outcome has its rule and its negative case asserted"
echo "regression proof: ok"
