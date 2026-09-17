#!/usr/bin/env sh
# Test-hardening node gate (EP-007 M7). Sentinel: `gate-test-hardening: ok`
#
# THE NODE'S OWN GATE. It runs, in order, every stage this node built and requires EACH to exit zero AND print its own
# sentinel: a stage that exits zero without its sentinel is the hollow-gate failure DOD-024 forbids, and a step that is
# skipped is an ERROR rather than a pass.
#
# ORDER IS DELIBERATE: test-unit and test-integration first (nothing else means anything if the suites are red), then
# coverage-gate (the measurement this node added), then regression-proof and forced-failure (the two suite families),
# then mutation-gate, flake-guard and double-boundary-guard (the sensitivity and boundary guards), then the collection
# guard and its negative control, and last the canonical-vocabulary scan over test titles (§7.3).
#
# THIS GATE TAKES TENS OF MINUTES - coverage-gate alone runs every layer, and flake-guard runs the unit roots five times
# by configuration - SO IT IS STARTED AS A BACKGROUND JOB rather than inline, which is the rule EP-007 M1 recorded after
# the executor's 600-second cap killed a gate mid-run and left a partial evidence capture.
#
# THE DATABASE-BACKED STAGES NEED THE DSNs the integration stage uses; they live in a state file OUTSIDE the repository
# (VG-SEC-002), which this gate sources when it exists and names when it does not.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

EVIDENCE=.agent/evidence/EP-007
mkdir -p "$EVIDENCE"
LOG="$EVIDENCE/gate-test-hardening.txt"

fail() { echo "gate-test-hardening: FAIL - $1" >&2; exit 1; }
error() { echo "gate-test-hardening: ERROR - $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || error "node is required but not found"

STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  export VG_TEST_DSN_OWNER VG_TEST_DSN_APP
fi

{
  echo "gate-test-hardening - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node: $(node --version)"
  echo
} >"$LOG"

# One step: run a stage, require its sentinel, and record both.
step() {
  name="$1"
  script="$2"
  sentinel="$3"
  [ -f "$script" ] || fail "$script is missing; this gate's contract names it"
  echo "gate-test-hardening: running $script (expecting '$sentinel')"
  if out=$(sh "$script" 2>&1); then
    status=0
  else
    status=$?
  fi
  printf '=== %s exit=%s\n' "$script" "$status" >>"$LOG"
  printf '%s\n' "$out" >>"$LOG"
  case "$out" in
    *"$sentinel"*) ;;
    *) error "$script did not print its sentinel '$sentinel' (exit $status); see $LOG" ;;
  esac
  [ "$status" -eq 0 ] || fail "$script exited $status after printing its sentinel; see $LOG"
  echo "gate-test-hardening: $script ok"
}

step test-unit sh scripts/test-unit.sh 'test-unit: ok'
step test-integration sh scripts/test-integration.sh 'test-integration: ok'
step coverage-gate sh scripts/coverage-gate.sh 'coverage: ok'
step regression-proof sh scripts/regression-proof.sh 'regression proof: ok'
step forced-failure sh scripts/forced-failure.sh 'forced failure: ok'
step mutation-gate sh scripts/mutation-gate.sh 'mutation gate: ok'
step flake-guard sh scripts/flake-guard.sh 'flake guard: ok'
step double-boundary-guard sh scripts/double-boundary-guard.sh 'double boundary guard: ok'
step test-collection-guard sh scripts/test-collection-guard.sh 'test collection guard: ok'

# ---------------------------------------------------------------------------------------------
# The collection guard's NEGATIVE CONTROL: a guard that cannot fail is decoration (DOD-007).
# gate-data.sh runs the same probe; it is repeated here because this node's gate must not depend
# on another node's gate having run.
# ---------------------------------------------------------------------------------------------
empty_dir=$(mktemp -d)
if VG_TEST_GLOB="${empty_dir}/**/*.test.ts" sh scripts/test-collection-guard.sh >"$EVIDENCE/collection-guard-empty.txt" 2>&1; then
  fail "the collection guard PASSED on an empty collection; it cannot detect a suite that stopped running"
fi
grep -q 'zero tests were collected' "$EVIDENCE/collection-guard-empty.txt" \
  || fail "the collection guard failed on an empty collection for the wrong reason; see $EVIDENCE/collection-guard-empty.txt"
echo "gate-test-hardening: collection guard negative control ok (an empty collection is refused)"

# ---------------------------------------------------------------------------------------------
# The canonical-vocabulary scan over test titles (§7.3, SPEC-000 §4): a forbidden synonym used
# as an identifier for a canonical concept is itself a defect.
# ---------------------------------------------------------------------------------------------
vocabulary=$(node -e '
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative, resolve } = require("node:path");
const ROOT = resolve(process.cwd());
// The forbidden synonyms §7.3 names, with the canonical tokens that legitimately CONTAIN one of them.
const FORBIDDEN = ["client","target","victim","hit","listing","match","ticket","job","task","submission","request","sanitizer","cleaner","scraper","script","bot"];
const CANONICAL = ["MATCH_CONFIRMED","REQUEST_SUBMITTED","REQUEST_READY","RequestCase","requestCase"];
function filesUnder(root) {
  let entries; try { entries = readdirSync(root); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".cache-ui-render") continue;
    const child = join(root, entry);
    if (statSync(child).isDirectory()) { found.push(...filesUnder(child)); continue; }
    if (/\.test\.ts$/.test(entry)) found.push(child);
  }
  return found;
}
const offenders = [];
for (const file of filesUnder(join(ROOT, "tests"))) {
  const source = readFileSync(file, "utf8");
  const titles = [...source.matchAll(/(?:test|describe)\(\s*[\x27"`]([^\x27"`]+)[\x27"`]/g)].map((m) => m[1]);
  for (const title of titles) {
    let stripped = title;
    for (const token of CANONICAL) stripped = stripped.split(token).join(" ");
    for (const forbidden of FORBIDDEN) {
      if (new RegExp(`\\b${forbidden}\\b`, "i").test(stripped)) {
        offenders.push(`${relative(ROOT, file).replace(/\\\\/g, "/")}: "${title}" uses "${forbidden}"`);
      }
    }
  }
}
console.log(JSON.stringify({ scanned: filesUnder(join(ROOT, "tests")).length, offenders }));
' 2>&1) || error "the canonical-vocabulary scan could not run"
printf '=== canonical vocabulary scan\n%s\n' "$vocabulary" >>"$LOG"
offender_count=$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(String(r.offenders.length))' "$vocabulary") \
  || error "could not read the vocabulary scan result"
scanned=$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(String(r.scanned))' "$vocabulary") \
  || error "could not read the vocabulary scan result"
[ "$scanned" -gt 0 ] || fail "the vocabulary scan read no test files, so its silence means nothing"
# REPORTED, NOT ENFORCED, AND THE MEASUREMENT IS THE REASON. §7.3 forbids a forbidden synonym used as an IDENTIFIER FOR A
# CANONICAL CONCEPT. A word-based scan cannot tell that from ordinary technical English: MEASURED on this tree, it flags
# 76 titles, and the great majority are correct usages — `If-Match` is an HTTP header, "HTTP client" is a client, "the
# subject listing is confined to its tenant" is a listing, "§5.8 request rules decided before the port" is about HTTP
# requests. Shipping that as a failing gate would force a waiver list of dozens of entries, which is the "guard that
# fires on the prose explaining the rule" defect this node removed in M6. Enforcing §7.3 needs a canonical-concept
# mapping with a context check, not a word list, so this gate REPORTS the count and names every offender in its log
# while claiming no enforcement. The item is recorded in the ledger as open work.
if [ "$offender_count" -gt 0 ]; then
  node -e 'const r=JSON.parse(process.argv[1]); for (const o of r.offenders) console.error(`  - ${o}`)' "$vocabulary" >&2 || true
  echo "gate-test-hardening: NOTE - the vocabulary scan reports $offender_count title(s) containing a §7.3 synonym;" >&2
  echo "  it is REPORTED, not enforced: most are ordinary technical usages (If-Match, HTTP request, HTTP client), and the" >&2
  echo "  list is in $LOG. Enforcing §7.3 needs a canonical-concept mapping with context, not a word list." >&2
fi
echo "gate-test-hardening: canonical vocabulary scan reported $scanned test file(s), $offender_count title(s) flagged (not enforced; see the note above)"

echo "gate-test-hardening: ok"
