#!/usr/bin/env sh
# EP-004 API/service node gate. Sentinel: `gate-api: ok`
#
# SCOPE, STATED HONESTLY ON EVERY RUN: this gate verifies what can be verified WITHOUT a
# provisioned external dependency — that the service type-checks, that the layer import boundary
# holds, that the route registry matches SPEC-003, that the error mapping matches SPEC-003 §8.2
# and SPEC-006 §6.2, that no request schema accepts a truth state, and that the credential-free
# contract and black-box suites pass.
#
# It does NOT verify anything that needs PostgreSQL, Valkey or Keycloak over HTTP, and it says so
# in its own output rather than omitting them. It never reports an unprovisioned dependency as
# passing, and it never substitutes a mock for one (DOD-010, DOD-020). A gate that silently
# skipped credential-dependent work would be a masking defect (DOD-024); a gate that failed
# forever on unprovisioned credentials would block unrelated independent work (DOD-031). Naming
# the gap in the gate's own output is the honest third option (EP-004 decision D4).
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "gate-api: FAIL - $1" >&2; exit 1; }

mkdir -p .agent/evidence/EP-004

# ---------------------------------------------------------------------------------------------
# 1. The service's structural preconditions.
# ---------------------------------------------------------------------------------------------
[ -f src/http/server.ts ] || fail "src/http/server.ts is missing"
[ -f src/http/openapi/registry.ts ] || fail "the route registry is missing"
[ -f src/http/errors/code-registry.ts ] || fail "the error code registry is missing"
[ -f src/infrastructure/config.ts ] || fail "src/infrastructure/config.ts is missing"
command -v node >/dev/null 2>&1 || fail "node is required but not found"

# ---------------------------------------------------------------------------------------------
# 2. Static gates.
# ---------------------------------------------------------------------------------------------
sh scripts/typecheck.sh >.agent/evidence/EP-004/typecheck.txt 2>&1 \
  || { cat .agent/evidence/EP-004/typecheck.txt >&2; fail "typecheck failed"; }

sh scripts/import-boundary.sh >.agent/evidence/EP-004/import-boundary.txt 2>&1 \
  || { cat .agent/evidence/EP-004/import-boundary.txt >&2; fail "layer import boundary violated"; }

# ---------------------------------------------------------------------------------------------
# 3. The handler scan, as the plan's decision D5 requires: no request schema may contain a truth
#    state, and no route may accept one as an input parameter.
#
#    SPEC-001 SM-6 makes a truth state the OUTPUT of a guarded command. A route that accepted one
#    as input would let a caller assert a state the domain never computed, which collapses the
#    distinction the whole product rests on.
#
#    IMPLEMENTED IN NODE, not with sed. The first version stripped comments with a LINE-BASED
#    `sed 's:/\*.*\*/::'`, which cannot span lines, so a multi-line doc comment survived and the
#    scan matched the words "schema" and "truthState" appearing anywhere in the same file — it
#    failed on the registry's own header comment explaining that neither appears. A lexical check
#    has to strip comments the way the language actually forms them.
# ---------------------------------------------------------------------------------------------
scan_file=.agent/evidence/EP-004/no-truth-state-input.txt
if ! node scripts/scan-truth-state-input.ts > "$scan_file" 2>&1; then
  cat "$scan_file" >&2
  fail "a route accepts a truth state as input (SM-6)"
fi
cat "$scan_file"
echo "gate-api: no route accepts a truth state as input (SM-6)"

# ---------------------------------------------------------------------------------------------
# 4. The contract suite, which is where the registry-vs-specification comparisons live.
# ---------------------------------------------------------------------------------------------
out=$(node --test "tests/contract/**/*.test.ts" 2>&1) || { printf '%s\n' "$out" >&2; fail "contract tests failed"; }
printf '%s\n' "$out" > .agent/evidence/EP-004/contract-tests.txt
printf '%s\n' "$out" | grep -E '^ℹ (tests|pass|fail) ' | sed 's/^/gate-api: contract /' || true

# Zero-test guard: a glob matching nothing exits non-zero, but assert it explicitly so the gate
# cannot pass on an empty suite. The reporter prefixes its summary with `ℹ` (U+2139), so the
# pattern matches that character rather than a `#` TAP comment — an earlier `^# tests ` pattern
# matched nothing and the gate refused to pass, which is the correct fail-closed behaviour.
collected=$(printf '%s\n' "$out" | sed -n 's/^ℹ tests \([0-9]*\)$/\1/p' | head -n 1)
[ -n "$collected" ] || fail "the contract suite reported no test count; refusing to pass on an unreadable result"
[ "$collected" -gt 0 ] || fail "the contract suite collected zero tests (DOD-007)"

# ---------------------------------------------------------------------------------------------
# 5. The black-box suite, when this node has produced one. Its absence is reported, not hidden.
# ---------------------------------------------------------------------------------------------
if [ -d tests/blackbox ] && [ -n "$(find tests/blackbox -name '*.test.ts' 2>/dev/null)" ]; then
  out=$(node --test "tests/blackbox/**/*.test.ts" 2>&1) || { printf '%s\n' "$out" >&2; fail "black-box acceptance tests failed"; }
  printf '%s\n' "$out" > .agent/evidence/EP-004/blackbox-tests.txt
  printf '%s\n' "$out" | grep -E '^# (tests|pass|fail) ' | sed 's/^/gate-api: blackbox /' || true
else
  echo "gate-api: NOTE - tests/blackbox/** does not exist yet; black-box acceptance is NOT verified by this run"
fi

# ---------------------------------------------------------------------------------------------
# 6. The unverified-by-this-gate block. Printed on EVERY run, success or failure, so the gap is
#    never mistaken for coverage.
# ---------------------------------------------------------------------------------------------
echo "ep004 api gate: UNVERIFIED-BY-THIS-GATE (credential-dependent; recorded as BLOCKED_CREDENTIALS):"
blocked=.agent/evidence/EP-004/blocked-credentials.txt
: > "$blocked"
for pair in "DATABASE_URL:scripts/probes/database_url.sh" \
            "VALKEY_URL:scripts/probes/valkey_url.sh" \
            "KEYCLOAK_ISSUER:scripts/probes/keycloak.sh"; do
  name=${pair%%:*}
  probe=${pair#*:}
  if sh "$probe" >/dev/null 2>&1; then
    echo "  - ${name}: probe ok"
    echo "${name}: probe ok" >> "$blocked"
  else
    echo "  - ${name}: BLOCKED_CREDENTIALS (probe: sh ${probe})"
    echo "${name}: BLOCKED_CREDENTIALS (probe: sh ${probe})" >> "$blocked"
  fi
done

# The nuance that must not be lost: PostgreSQL IS provisioned and reachable, proven by EP-003's
# gate-data; what is absent is the exported DATABASE_URL variable these probes read. Reporting
# those as "no database" would be false.
if command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^vanishgraph-'; then
    echo "  NOTE: a vanishgraph PostgreSQL container IS running (EP-003 gate-data provisions it);"
    echo "        what is unset above is the exported DATABASE_URL variable the probe reads."
  fi
fi

# ---------------------------------------------------------------------------------------------
# 7. What this node has NOT built, named so the gate cannot imply more than it proves.
# ---------------------------------------------------------------------------------------------
echo "ep004 api gate: NOT YET IMPLEMENTED at this milestone:"
for missing in "src/http/routes/*.ts beyond health.ts" "src/application/contracts/index.ts" "identity and tenancy plugins"; do
  case "$missing" in
    "src/application/contracts/index.ts") [ -f src/application/contracts/index.ts ] || echo "  - ${missing}" ;;
    "src/http/routes/*.ts beyond health.ts") [ "$(find src/http/routes -name '*.ts' | wc -l | tr -d ' ')" -gt 1 ] || echo "  - ${missing}" ;;
    *) [ -f src/http/plugins/identity.ts ] || echo "  - ${missing}" ;;
  esac
done

echo "gate-api: ok"
