#!/usr/bin/env sh
# Forced-failure stage (DOD-014; EP-007 M3). Sentinel: `forced failure: ok`
#
# WHAT IT RUNS: the five fail-closed suites that make a control's INPUT fail — authority, dependency, credentials, egress
# and recipe — and it requires each one to run AND to pass. A suite that is missing, that contributes no test, or that
# fails is a failure of this stage, named individually: a stage that reported one number for five suites would hide which
# control stopped being proven.
#
# WHY THE SUITES ARE LISTED BY PATH RATHER THAN GLOBED: deleting or renaming a suite is exactly the change this stage
# must notice, and a glob would simply collect one fewer file and still print its sentinel. The list below is the
# contract; `EXPECTED_TEST_MANIFEST.txt` carries the same five paths for the unit stage, so the two cannot drift apart
# without one of them failing.
#
# THE VERDICT COMES FROM THE JUNIT SUMMARY, read through `scripts/count-tests.mjs`, not from a TAP tail: it gives the
# test count, the failure count and the verdict per suite as one JSON line, and it names each failing test rather than
# only counting them.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

EVIDENCE=.agent/evidence/failure
mkdir -p "$EVIDENCE"

fail() { echo "forced failure: FAIL - $1" >&2; exit 1; }
error() { echo "forced failure: ERROR - $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || error "node is required but not found"

SUITES="tests/failure/fail-closed-authority.test.ts
tests/failure/fail-closed-dependency.test.ts
tests/failure/fail-closed-credentials.test.ts
tests/failure/fail-closed-egress.test.ts
tests/failure/fail-closed-recipe.test.ts"

{
  echo "forced failure - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
} >"$EVIDENCE/run.txt"

set -f
total=0
for suite in $SUITES; do
  [ -f "$suite" ] || fail "$suite is missing; this stage's contract is the five suites it names"
  if summary=$(node --test --test-reporter=junit "$suite" 2>"$EVIDENCE/$(basename "$suite" .test.ts).txt" | node scripts/count-tests.mjs); then
    status=0
  else
    status=$?
  fi
  line=$(printf '%s\n' "$summary" | grep -E '^\{"tests":' | tail -n 1)
  [ -n "$line" ] || fail "$suite produced no JUnit summary (exit $status); nothing can be compared"
  printf '%s exit=%s %s\n' "$suite" "$status" "$line" >>"$EVIDENCE/run.txt"

  count=$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(String(r.tests))' "$line") || error "could not read the test count for $suite"
  [ "$count" -gt 0 ] || fail "$suite collected no tests; a suite that runs nothing proves nothing (DOD-007)"
  [ "$status" -eq 0 ] || fail "$suite failed (exit $status); see $EVIDENCE/$(basename "$suite" .test.ts).txt"
  case "$line" in
    *'"fail":0'*) ;;
    *) fail "$suite reported failures: $line" ;;
  esac

  echo "forced failure: $suite $count test(s) PASS"
  total=$((total + count))
done
set +f

echo "forced failure: $total test(s) across the five fail-closed suites; every control refuses when its input is broken"
echo "forced failure: ok"
