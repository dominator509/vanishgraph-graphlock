#!/usr/bin/env sh
# Flake guard (DOD-006; EP-007 M5). Sentinel: `flake guard: ok`
#
# WHAT IT DOES: runs the given suites `flakeRuns` times (default 5, `config/testing/flake-runs.json`) and fails when any
# run's verdict differs from the first — a different test count, a different failure count, or a different verdict. The
# first differing run's raw output is preserved under `.agent/evidence/flake/` before anything else happens, because a
# flake whose identity is lost cannot be investigated and an unexplained failure is worse than a known one.
#
# WHY REPEATED RUNS ARE THE RIGHT CONTROL AND RETRY-UNTIL-GREEN IS NOT: a test whose verdict changes between identical
# runs is a defect in the product, the test, the environment or the oracle, and the permitted resolutions are exactly
# those `TESTING.md` names — fix the defect, fix the oracle with a recorded reason, or delete the test with an ADR that
# names what it protected and what protects it now. Re-running until it passes hides all four.
#
# THE VERDICT IS READ FROM THE JUNIT SUMMARY, NOT FROM A TAP TAIL. `scripts/count-tests.mjs` parses the JUnit document
# and prints one JSON line per run with the test count, the failure count, the skip count and the verdict, so two runs
# are compared on numbers a machine produced rather than on a human reading two logs.
#
# USAGE:
#   sh scripts/flake-guard.sh                       # the unit roots, `flakeRuns` times
#   sh scripts/flake-guard.sh "tests/harness/**/*.test.ts"
#   FLAKE_RUNS=2 sh scripts/flake-guard.sh ...      # override for a bounded evidence run, recorded in the output
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

CONFIG=config/testing/flake-runs.json
EVIDENCE=.agent/evidence/flake
mkdir -p "$EVIDENCE"

fail() { echo "flake guard: FAIL - $1" >&2; exit 1; }
error() { echo "flake guard: ERROR - $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || error "node is required but not found"
[ -f "$CONFIG" ] || error "$CONFIG is missing; the flake policy parameters are this guard's contract"

CONFIG_RUNS=$(node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.flakeRuns))' "$CONFIG") \
  || error "$CONFIG is not valid JSON"
SEED=$(node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.seed))' "$CONFIG") \
  || error "$CONFIG has no seed"

RUNS=${FLAKE_RUNS:-$CONFIG_RUNS}
case "$RUNS" in
  ''|*[!0-9]*) error "FLAKE_RUNS must be a positive integer, got '$RUNS'" ;;
esac
[ "$RUNS" -ge 2 ] || error "FLAKE_RUNS must be at least 2; one run cannot show a verdict change"

# The unit roots by default, which is the same set `scripts/test-unit.sh` runs and `tests/architecture` guards.
if [ "$#" -gt 0 ]; then
  GLOBS="$*"
else
  GLOBS="tests/domain/**/*.test.ts tests/harness/**/*.test.ts tests/architecture/**/*.test.ts tests/contract/**/*.test.ts tests/security/**/*.test.ts"
fi

{
  echo "flake guard - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "config: $CONFIG (flakeRuns=$CONFIG_RUNS seed=$SEED)"
  echo "runs: $RUNS${FLAKE_RUNS:+ (FLAKE_RUNS override)}"
  echo "suites: $GLOBS"
  echo
} >"$EVIDENCE/run.txt"

# GLOBBING IS DISABLED FOR THE EXPANSION (EP-007 M1's measured defect: with it enabled the shell expands a `**` pattern
# itself, under a non-globstar shell to a single directory level, so the guard would repeatedly run a subset and report
# a stable verdict about it).
set -f
first=""
run=1
while [ "$run" -le "$RUNS" ]; do
  out="$EVIDENCE/run-$run.txt"
  # shellcheck disable=SC2086
  if node --test --test-reporter=junit $GLOBS 2>&1 | node scripts/count-tests.mjs >"$EVIDENCE/summary-$run.txt" 2>"$out"; then
    status=0
  else
    status=$?
  fi
  summary=$(grep -E '^\{"tests":' "$EVIDENCE/summary-$run.txt" | tail -n 1)
  [ -n "$summary" ] || {
    printf '%s\n' "  (see $out for the runner's own output)" >&2
    fail "run $run produced no JUnit summary (exit $status); nothing can be compared"
  }
  printf 'run %s exit=%s %s\n' "$run" "$status" "$summary" >>"$EVIDENCE/run.txt"
  echo "flake guard: run $run/$RUNS exit=$status $summary"

  if [ "$run" -eq 1 ]; then
    first="$summary"
    # A CONSISTENTLY RED SUITE IS NOT A FLAKE, BUT A GREEN GUARD OVER IT WOULD BE A LIE. MEASURED while writing this
    # script: the verdict comparison alone treats `{"fail":3}` in every run as "stable", so the guard would print its
    # sentinel over three failing tests. A red first run is therefore reported as the failure it is, naming the count,
    # and the guard's sentinel means "stable AND green" rather than "stable".
    case "$summary" in
      *'"fail":0'*) ;;
      *)
        printf 'run 1 summary: %s\n' "$summary" >>"$EVIDENCE/run.txt"
        fail "the first run already failed ($summary); this is a failure, not a flake — run the stage that owns it"
        ;;
    esac
  elif [ "$summary" != "$first" ]; then
    # PRESERVE BEFORE FAILING: the differing run's output is copied to a name that later runs cannot overwrite.
    cp "$out" "$EVIDENCE/first-difference-run$run.txt"
    fail "run $run differs from run 1; a verdict that changes between identical runs is a flake (DOD-006). Preserved: $EVIDENCE/first-difference-run$run.txt"
  fi
  run=$((run + 1))
done
set +f

echo "flake guard: $RUNS identical run(s) of $((run - 1)) expected; verdict stable"
echo "flake guard: ok"
