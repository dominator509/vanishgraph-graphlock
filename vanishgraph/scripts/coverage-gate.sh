#!/usr/bin/env sh
# Coverage gate (DOD-008; EP-007 M1). Sentinel: `coverage: ok`
#
# WHAT IT MEASURES, AND WHY IT RUNS ONCE PER LAYER. Node's built-in test coverage reports PER-FILE percentages and no
# counts, so a per-layer aggregate cannot be derived from one run over everything: the only way to get one is to include
# exactly one layer's sources in a run of its own. This script therefore reads its layer table from
# `config/testing/coverage-thresholds.json` and runs
#
#   node --test --experimental-test-coverage --test-coverage-include=<layer sources> <layer suites>
#
# once per layer, reads the `all files` row the reporter prints, and compares the three numbers with the targets.
#
# MEASURED BEHAVIOUR OF THIS BUILD (Node 24.14.1; recorded verbatim in .agent/evidence/EP-007/M1-discovery.txt):
#   * `--test-coverage-include=<glob>` filters the report to matching files, and its `all files` row is the aggregate;
#   * a DIRECTORY argument does NOT work — `node --test tests/domain/` fails with MODULE_NOT_FOUND — so every suite
#     argument here is a glob, the same form the other stages use;
#   * the reporter prints the table even when tests fail, so the exit code is checked FIRST and a failing suite is an
#     ERROR rather than a coverage verdict.
#
# FAILURE MODES, all non-zero and none printing the sentinel:
#   * the configuration file is missing or unparseable -> ERROR naming it;
#   * a layer's run exits non-zero (a test failed, or a glob matched nothing) -> ERROR for that layer;
#   * a run prints no coverage table -> ERROR: coverage could not be measured, which is never a pass (DOD-008);
#   * a layer with `requiresPostgres` cannot reach a database and no DSN is available -> BLOCKED_CREDENTIALS naming
#     DATABASE_URL, because a layer measured over half its suites would report a number that means nothing;
#   * any measured percentage below its target -> FAIL naming the layer, the metric, the measured value and the target.
#
# THE TARGETS ARE NOT LOWERABLE FROM HERE. They are read from the configuration file, TESTING.md carries the same table,
# and `tests/harness/coverage-config.test.ts` asserts the two agree — so lowering one to obtain a pass requires editing
# both a specification and its test, which is the specification change DOD-027 requires rather than an edit to a gate.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

CONFIG=config/testing/coverage-thresholds.json
EVIDENCE=.agent/evidence/EP-007
mkdir -p "$EVIDENCE"

fail() { echo "coverage: FAIL - $1" >&2; exit 1; }
error() { echo "coverage: ERROR - $1" >&2; exit 1; }
blocked() { echo "coverage: BLOCKED_CREDENTIALS - $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || error "node is required but not found"
[ -f "$CONFIG" ] || error "$CONFIG is missing; the thresholds and the layer table are this gate's contract"
node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'))" "$CONFIG" \
  || error "$CONFIG is not valid JSON"

# The database-backed layers need the DSNs the integration stage uses. They live in a state file OUTSIDE the repository
# (VG-SEC-002), so this gate sources it when it exists and says which layers it could not measure when it does not.
STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  export VG_TEST_DSN_OWNER VG_TEST_DSN_APP
fi

# Flatten the layer table to `name|sources|suites|requiresPostgres|lines|branches|functions` lines.
LAYERS=$(node -e '
const config = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
for (const layer of config.layers) {
  const target = config.targets[layer.name];
  if (target === undefined) throw new Error(`no target for layer ${layer.name}`);
  console.log([
    layer.name,
    layer.sources.join(" "),
    (layer.exclude ?? []).join(" "),
    layer.suites.join(" "),
    layer.requiresPostgres ? "yes" : "no",
    target.lines,
    target.branches,
    target.functions,
    layer.isolation ?? "process",
  ].join("|"));
}
' "$CONFIG") || error "could not read the layer table from $CONFIG"

[ -n "$LAYERS" ] || error "$CONFIG declares no layers"

report="$EVIDENCE/coverage-gate.txt"
: >"$report"
{
  echo "coverage gate - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "configuration: $CONFIG"
  echo "node: $(node --version)"
  echo
} >>"$report"

echo "$LAYERS" | while IFS='|' read -r name sources excludes suites needs_pg lines branches functions isolation; do
  [ -n "$name" ] || continue

  if [ "$needs_pg" = "yes" ] && [ -z "${VG_TEST_DSN_APP:-}" ]; then
    echo "coverage: BLOCKED_CREDENTIALS - layer $name needs PostgreSQL and no DSN is available" >&2
    echo "  provision it with sh scripts/db-provision.sh and re-run with VG_DB_STATE_FILE set" >&2
    exit 2
  fi

  # GLOBBING IS DISABLED FOR THE WHOLE LAYER BODY, INCLUDING THE ARGUMENT LOOPS. MEASURED, AND THIS WAS THE REAL
  # DEFECT: `set -f` was originally placed just before the `node` call, so the `for source in $sources` loop ABOVE it
  # globbed the pattern itself — under a non-globstar shell `src/domain/**/*.ts` expanded to the six files in
  # `src/domain/ports/`, and the layer reported `100.00/100.00/100.00` because those six are type-only modules with no
  # executable lines. A gate that measures the wrong set and reports a perfect score is worse than no gate, and the two
  # guards below (zero tests, no file rows) do NOT catch it: the wrong set was non-empty.
  set -f
  include_args=""
  for source in $sources; do
    include_args="$include_args --test-coverage-include=$source"
    case "$source" in
      # `src/domain/**/*.ts` -> `src/domain/*.ts`: the `**/` segment is REMOVED, not rewritten to `*/` (the first
      # version of this line produced `src/domain/*/*.ts`, which is the shape the runner already matched, so the fix did
      # nothing). This runner's coverage glob does treat `**/` as zero-or-more directories — measured — so this is
      # belt-and-braces for any future runner whose globstar differs.
      *'/**/'*) include_args="$include_args --test-coverage-include=$(printf '%s' "$source" | sed 's#/\*\*/#/#')" ;;
    esac
  done

  exclude_args=""
  for pattern in $excludes; do
    exclude_args="$exclude_args --test-coverage-exclude=$pattern"
  done

  # ISOLATION IS A PER-LAYER CHOICE, AND THE ui LAYER NEEDS IT OFF (see its `basis`): its instrumented files are a
  # MIRROR directory whose name carries the process id, so one child process per test file means the same module is
  # measured several times over and each partial measurement dilutes the aggregate.
  isolation_arg=""
  [ "$isolation" = "none" ] && isolation_arg="--experimental-test-isolation=none"

  # shellcheck disable=SC2086
  out=$(node --test --experimental-test-coverage $isolation_arg $include_args $exclude_args $suites 2>&1) || {
    set +f
    printf '%s\n' "$out" | tail -n 25 >&2
    echo "coverage: ERROR - layer $name: its suites did not pass, so no coverage verdict is available" >&2
    exit 3
  }
  set +f

  # ZERO-TEST AND EMPTY-REPORT GUARDS. The runner prints a coverage table with `all files | 100.00` when it collected no
  # tests at all, so a mistyped suite glob would otherwise read as a perfect score — the failure this gate exists to
  # prevent, in the one place it could not see it.
  ran=$(printf '%s\n' "$out" | sed -n 's/^ℹ tests \([0-9][0-9]*\)$/\1/p' | tail -n 1)
  [ -n "$ran" ] || error "layer $name: the runner printed no test count, so nothing is known about what ran"
  [ "$ran" -gt 0 ] || error "layer $name: ZERO tests collected; a coverage figure over no tests is not a measurement (DOD-007)"
  measured_files=$(printf '%s\n' "$out" | grep -cE '^ℹ +[A-Za-z0-9_.-]+\.(ts|tsx|js) +\|' || true)
  [ "$measured_files" -gt 0 ] \
    || error "layer $name: the coverage report contains NO file rows, so no file of this layer was measured"

  printf '=== layer %s\ntests: %s\nsources: %s\nexcludes: %s\nsuites: %s\n' \
    "$name" "$ran" "$sources" "${excludes:-（none）}" "$suites" >>"$report"
  # EVERY `ℹ` LINE IS KEPT, including the per-file rows. MEASURED: the first version filtered to `^ℹ (all files|[a-z].*\|)`,
  # which DROPPED the indented per-file rows — exactly the rows a reader needs to see WHICH module is short when a layer
  # fails — and the aggregate alone cannot say.
  printf '%s\n' "$out" | grep -E '^ℹ' >>"$report" || true

  row=$(printf '%s\n' "$out" | grep -E '^ℹ all files' | tail -n 1)
  [ -n "$row" ] || error "layer $name printed no coverage table; coverage could not be measured (DOD-008)"

  measured=$(printf '%s' "$row" | sed -n 's/^ℹ all files *| *\([0-9.]*\) *| *\([0-9.]*\) *| *\([0-9.]*\) *|.*/\1 \2 \3/p')
  [ -n "$measured" ] || error "layer $name: could not parse the coverage row: $row"

  set -- $measured
  m_lines=${1:-}; m_branches=${2:-}; m_functions=${3:-}

  verdict=$(node -e '
const [lines, branches, functions, tLines, tBranches, tFunctions] = process.argv.slice(1).map(Number);
const checks = [
  ["lines", lines, tLines],
  ["branches", branches, tBranches],
  ["functions", functions, tFunctions],
];
const short = checks.filter(([, measured, target]) => measured < target);
if (short.length === 0) {
  console.log(`ok ${lines} ${branches} ${functions}`);
} else {
  console.log(`short ${short.map(([metric, measured, target]) => `${metric} ${measured} < ${target}`).join("; ")}`);
}
' "$m_lines" "$m_branches" "$m_functions" "$lines" "$branches" "$functions")

  case "$verdict" in
    ok\ *)
      echo "coverage: $name lines=$m_lines branches=$m_branches functions=$m_functions (targets $lines/$branches/$functions)"
      printf 'result: PASS lines=%s branches=%s functions=%s targets=%s/%s/%s\n\n' \
        "$m_lines" "$m_branches" "$m_functions" "$lines" "$branches" "$functions" >>"$report"
      ;;
    *)
      echo "coverage: FAIL - layer $name: ${verdict#short } (targets $lines/$branches/$functions)" >&2
      printf 'result: FAIL %s\n\n' "${verdict#short }" >>"$report"
      exit 4
      ;;
  esac
done
sub=$?
[ "$sub" = "0" ] || exit "$sub"

echo "coverage: ok"
