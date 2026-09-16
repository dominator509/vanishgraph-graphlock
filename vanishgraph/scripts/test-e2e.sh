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

[ -d tests/ui ] || fail "tests/ui/ does not exist: no browser suite has been written yet, and a stage that runs nothing must not print its sentinel"

# THE SUITE ROOTS ARE DISCOVERED, NOT ASSUMED. TESTING.md declares two roots for browser work: `tests/ui/` (EP-005's
# Playwright suites) and `tests/e2e/` (a running app through the real entry point). MEASURED: the first version of this
# runner looked at `tests/e2e` only, and `playwright.config.ts` had `testDir: 'tests/e2e'`, so EP-005's suites named in
# the plan and in TESTING.md would have been invisible to the stage that is supposed to run them.
suites=$(find tests/ui tests/e2e -name '*.spec.ts' 2>/dev/null | sort)
[ -n "$suites" ] || fail "neither tests/ui/ nor tests/e2e/ contains a *.spec.ts: no browser suite exists yet, and a stage that runs nothing must not print its sentinel"

mkdir -p .agent/evidence/EP-005
out=.agent/evidence/EP-005/e2e-run.txt
set +e
npx --no-install playwright test >"$out" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  # A MISSING BROWSER IS AN ENVIRONMENT LIMITATION, AND THIS STAGE DOES NOT ASSUME IT IS PERMANENT: it ATTEMPTS the
  # provisioning once, records the attempt, retries the suites, and only then reports BLOCKED_ENVIRONMENT. MEASURED
  # reason for the attempt rather than a message: `npx playwright --version` printed 1.63.0 while the browser build it
  # wanted (chromium-1243) was absent from the cache — an installed package is not a provisioned runtime — and the
  # provisioning command is what closed that gap. Recording the attempt is what DOD-033 asks for: the environment
  # limitation is evidenced rather than asserted.
  if grep -qiE "Executable doesn't exist|playwright install|browserType.launch" "$out"; then
    attempt=.agent/evidence/EP-005/browser-provisioning-attempt.txt
    echo "end-to-end tests: the browser runtime is missing; attempting 'npx playwright install chromium' (log: $attempt)" >&2
    set +e
    npx playwright install chromium >"$attempt" 2>&1
    install_status=$?
    set -e
    if [ "$install_status" -eq 0 ]; then
      echo "end-to-end tests: provisioning reported success; re-running the suites" >&2
      set +e
      npx --no-install playwright test >"$out" 2>&1
      status=$?
      set -e
    fi
    if [ "$status" -ne 0 ]; then
      tail -n 5 "$attempt" >&2
      blocked "the browser runtime could not be provisioned (install exit $install_status; attempt log $attempt; suite log $out)"
    fi
  else
    tail -n 40 "$out" >&2
    fail "the Playwright suites failed; full output in $out"
  fi
fi

grep -qE '[1-9][0-9]* passed' "$out" || fail "Playwright exited 0 but reported no passing test; see $out"
cat "$out"
echo "end-to-end tests: ok"
