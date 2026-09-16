#!/usr/bin/env sh
# end-to-end tests -- REAL RUNNER. Sentinel: `end-to-end tests: ok`
#
# Replaces the loud-fail placeholder that stood here while no UI existed. The placeholder was CORRECT while the node was
# unbuilt: it refused to print a sentinel rather than reporting a false green (DOD-024, DOD-027). This is the
# implementation it was waiting for, not a weakening of it.
#
# WHAT IT DOES: requires the BUILT application (never a dev server — SPEC-008 VG-SHIP-021/022), makes a REAL attempt to
# run the Playwright suites against that artefact, and classifies the outcome honestly:
#
#   * a missing browser runtime is `BLOCKED_ENVIRONMENT` with the missing property named, exit 1 — an environment
#     limitation is never written as a product failure and never as a pass (DOD-006);
#   * no suites at all is `FAIL`, not a pass: a stage that ran nothing has verified nothing;
#   * a genuine suite failure is `FAIL` with Playwright's own output.
#
# IT PRINTS ITS SENTINEL ONLY AFTER THE SUITES RAN AND PASSED AGAINST THE BUILT BUNDLE.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "end-to-end tests: FAIL - $1" >&2; exit 1; }
blocked() { echo "end-to-end tests: BLOCKED_ENVIRONMENT - $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || blocked "node is not on PATH"
[ -f ui/dist/index.html ] || fail "the built application is missing at ui/dist/index.html; run 'npm run build:web' first (this stage never runs against a dev server)"

[ -d tests/e2e ] || fail "tests/e2e/ does not exist: no end-to-end suite has been written yet, and a stage that runs nothing must not print its sentinel"

suites=$(find tests/e2e -name '*.spec.ts' 2>/dev/null | sort)
[ -n "$suites" ] || fail "tests/e2e/ contains no *.spec.ts: no end-to-end suite exists yet, and a stage that runs nothing must not print its sentinel"

mkdir -p .agent/evidence/EP-005
out=.agent/evidence/EP-005/e2e-run.txt
set +e
npx --no-install playwright test >"$out" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  # A MISSING BROWSER IS AN ENVIRONMENT LIMITATION. Playwright names it in its own words; classifying it by reading the
  # output is how this stage avoids reporting an unprovisioned runtime as a product defect.
  if grep -qiE "Executable doesn't exist|playwright install|browserType.launch" "$out"; then
    tail -n 5 "$out" >&2
    blocked "the browser runtime is not provisioned; run 'npx playwright install chromium' (see $out)"
  fi
  tail -n 40 "$out" >&2
  fail "the Playwright suites failed; full output in $out"
fi

grep -qE '[1-9][0-9]* passed' "$out" || fail "Playwright exited 0 but reported no passing test; see $out"
cat "$out"
echo "end-to-end tests: ok"
