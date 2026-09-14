#!/usr/bin/env sh
# EP-002 node gate. Sentinel: `gate-domain: ok`
#
# Proves the domain node by running every real gate and requiring its exact sentinel, plus
# four properties a green suite cannot prove on its own:
#
#   * zero skipped or todo tests (DOD-006 — a skip is a silent blind spot);
#   * the domain file set is exactly the audited set (no unaccounted domain module);
#   * the requirement→test map has no PLANNED rows left (DOD-001);
#   * the mutation check actually detects controlled defects (DOD-018).
#
# `verify.sh` keeps its full fifteen-stage order (master prompt §10, line 1357). EP-003 has since
# implemented the `integration` stage, so the run no longer stops there; nothing here removes,
# reorders, or exempts a stage.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "gate-domain: FAIL - $1" >&2; exit 1; }

mkdir -p .agent/evidence/EP-002
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0

# require_sentinel <sentinel> <command...>
require_sentinel() {
  sentinel=$1
  shift
  if ! out=$("$@" 2>&1); then
    echo "gate-domain: FAIL - command failed: $*" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
  printf '%s\n' "$out" | grep -qxF "$sentinel" \
    || fail "expected sentinel '$sentinel' as the last line of: $*"
}

for f in scripts/mutation-check.sh scripts/gate-domain.sh; do
  sh -n "$f" || fail "sh -n failed for $f"
done

require_sentinel 'typecheck: ok' sh scripts/typecheck.sh
require_sentinel 'import boundary: ok' sh scripts/import-boundary.sh
require_sentinel 'lint: ok' sh scripts/lint.sh
require_sentinel 'test-unit: ok' sh scripts/test-unit.sh
require_sentinel 'test collection guard: ok' sh scripts/test-collection-guard.sh

# Zero-skip assertion (DOD-006). The collection guard reports skips as a note; a domain
# node must not close with any.
#
# SCOPE (EP-003 M5 fix). This glob used to be `tests/**/*.test.ts`, which was correct only
# while every suite under tests/ was pure. Once EP-003 added the service-dependent
# tests/db/** suite, the broad glob collected it here, its harness failed on the unset DSN
# (this gate never exports one), and the whole gate failed with "the domain suite failed"
# on every machine including a fully provisioned one. The gate's own words say "the domain
# suite"; the glob now matches that claim by naming the pure roots, the same set
# scripts/test-unit.sh runs. The database suite is asserted by gate-* for its own node, where
# a provisioned PostgreSQL is a precondition rather than an accident.
DOMAIN_GLOB="tests/domain/**/*.test.ts tests/harness/**/*.test.ts tests/architecture/**/*.test.ts"
# Unquoted expansion is deliberate: several space-separated patterns must reach node as
# separate arguments.
# shellcheck disable=SC2086
if ! node --test --test-reporter=junit $DOMAIN_GLOB >"$tmp/domain-junit.xml" 2>"$tmp/domain-junit.err"; then
  echo "gate-domain: FAIL - the domain suite failed" >&2
  tail -n 40 "$tmp/domain-junit.err" >&2
  exit 1
fi
if grep -q '<skipped' "$tmp/domain-junit.xml"; then
  echo "gate-domain: FAIL - the domain suite contains skipped tests; DOD-006 requires an approved time-bounded waiver per skip" >&2
  grep -o 'name="[^"]*"' "$tmp/domain-junit.xml" | head -n 10 >&2
  exit 1
fi
collected=$(grep -c '<testcase' "$tmp/domain-junit.xml" || true)
[ "$collected" -gt 0 ] || fail "zero tests collected (DOD-007)"
echo "gate-domain: $collected domain tests collected, 0 skipped, 0 todo"

# The expected-test manifest must point at files that exist.
while IFS= read -r entry; do
  case "$entry" in ''|'#'*) continue ;; esac
  [ -f "$entry" ] || fail "manifest entry ${entry} does not exist"
done < .agent/verification/EXPECTED_TEST_MANIFEST.txt

# The domain file set is exactly the audited set. A new domain module must be added here
# deliberately, with its spec basis, rather than appearing silently.
#
# `src/domain/ports/key-provider.ts` was added by EP-003 M7: key management is a domain port
# because *what must be encrypted and when key material must be destroyed* is a domain rule
# (SPEC-002 §4, RET-2, VG-SEC-002), placed under ports/ per SPEC-001 §5.1 rule 1 rather than at
# the `src/domain/key-provider.ts` path the execplan named.
expected=$(printf '%s\n' \
  src/domain/commands.ts \
  src/domain/entities.ts \
  src/domain/errors.ts \
  src/domain/events.ts \
  src/domain/identifiers.ts \
  src/domain/invariants.ts \
  src/domain/ports/index.ts \
  src/domain/ports/key-provider.ts \
  src/domain/state-machine.ts \
  src/domain/truth-state.ts \
  src/domain/values.ts | sort)
actual=$(find src/domain -type f -name '*.ts' | sort)
if [ "$actual" != "$expected" ]; then
  echo "gate-domain: FAIL - the domain file set is not the audited set:" >&2
  printf '%s\n' "$actual" >&2
  echo "Update the EP-002 audit list, the node gate, and the requirement map deliberately." >&2
  exit 1
fi

# Traceability completeness (DOD-001): no unmeasured rows.
if grep -q ',PLANNED$' tests/domain/DOMAIN_TEST_MAP.csv; then
  echo "gate-domain: FAIL - DOMAIN_TEST_MAP.csv still contains PLANNED rows:" >&2
  grep -n ',PLANNED$' tests/domain/DOMAIN_TEST_MAP.csv >&2
  exit 1
fi
printf 'gate-domain: traceability rows: %s\n' "$(($(wc -l < tests/domain/DOMAIN_TEST_MAP.csv) - 1))"

require_sentinel 'mutation check: ok' sh scripts/mutation-check.sh

# verify.sh progression: every implemented stage passes, the FIRST UNIMPLEMENTED stage still
# fails loudly, and `verify: ok` never appears.
#
# EP-003 implemented the integration stage, so the assertion that integration loud-fails was
# updated rather than deleted: the property it protected (stop at the first unimplemented stage
# with the mandated signature) still holds, now restated against security-check, which EP-006
# implements.
progression=.agent/evidence/EP-002/verify-progression.txt
if sh scripts/verify.sh >"$progression" 2>&1; then
  fail "verify.sh exited 0 although artifact-bound stages are unimplemented; that is a fabrication (DOD-027)"
fi
grep -q 'test-unit: ok' "$progression" || fail "verify.sh did not pass the unit stage"
grep -q 'test-integration: ok' "$progression" || fail "verify.sh did not pass the integration stage (EP-003)"
grep -qE '^ERROR: .* is an unimplemented placeholder' "$progression" \
  || fail "the first unimplemented stage must still fail loudly; see $progression"
if grep -qx 'verify: ok' "$progression"; then
  fail "verify.sh printed verify: ok while stages are unimplemented (DOD-024)"
fi
echo "gate-domain: verify.sh progression ok (unit and integration green, first unimplemented stage loud-fails, no verify: ok)"

echo "gate-domain: ok"
