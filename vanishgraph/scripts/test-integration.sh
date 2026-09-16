#!/usr/bin/env sh
# Integration test stage. Sentinel: `test-integration: ok`
#
# EP-003 M9. Replaces the loud-fail placeholder that stood here while the database node was
# unbuilt. The placeholder was CORRECT while the stage was unimplemented: it refused to print a
# sentinel rather than reporting a false green (DOD-024, DOD-027). This is the real
# implementation it was waiting for, not a weakening of it.
#
# SCOPE (TESTING.md "Test suite layout", binding): tests/db/** and, as later nodes add them,
# tests/integration/**, tests/blackbox/** and tests/api/**. Each root is declared here rather
# than globbed as `tests/**`, because a broad glob would sweep in browser and artifact suites
# that belong to a different stage — the error that made the unit stage unrunnable on a clean
# checkout (DOD-032).
#
# WHY IT PROVISIONS RATHER THAN ASSUMES: an integration stage that silently skips when no
# database is present reports the same green as one that ran, which is the confusion DOD-006
# exists to prevent. If the service cannot be provisioned the stage reports
# BLOCKED_ENVIRONMENT loudly and prints no sentinel. A harness limitation is never written as a
# product failure, and it is never written as a pass either.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

mkdir -p .agent/evidence/db

fail() { echo "test-integration: FAIL - $1" >&2; exit 1; }
blocked() { echo "test-integration: BLOCKED_ENVIRONMENT - $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node is required but not found"

# Collect the service-dependent roots that actually exist. Roots a later node has not created
# yet are reported rather than silently ignored.
ROOTS=""
for root in tests/db tests/integration tests/blackbox tests/api; do
  [ -d "$root" ] || continue
  found=$(find "$root" -name '*.test.ts' | sort)
  [ -n "$found" ] || continue
  ROOTS="$ROOTS $found"
done
[ -n "$ROOTS" ] || fail "no service-dependent test files found under tests/db, tests/integration, tests/blackbox or tests/api"

# ---------------------------------------------------------------------------------------------
# Provision. An unreachable Docker daemon is BLOCKED_ENVIRONMENT, not a candidate failure.
# ---------------------------------------------------------------------------------------------
if ! sh scripts/db-provision.sh >.agent/evidence/db/integration-provision.txt 2>&1; then
  cat .agent/evidence/db/integration-provision.txt >&2
  blocked "could not provision PostgreSQL; see .agent/evidence/db/integration-provision.txt (DOD-032, DOD-033)"
fi
grep -qx 'db provision: ok' .agent/evidence/db/integration-provision.txt \
  || { cat .agent/evidence/db/integration-provision.txt >&2; fail "db-provision.sh did not print its sentinel"; }

# The state file holds the only copy of the generated passwords, outside the repository
# (VG-SEC-002).
STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
[ -f "$STATE_FILE" ] || fail "provisioning reported success but wrote no state file at $STATE_FILE"
# shellcheck disable=SC1090
. "$STATE_FILE"
export VG_TEST_DSN_OWNER VG_TEST_DSN_APP

# ---------------------------------------------------------------------------------------------
# Migrate and seed. Both are preconditions for the suites below, so a failure here is a stage
# failure rather than a confusing test error later.
# ---------------------------------------------------------------------------------------------
sh scripts/migrate.sh up --dsn "$VG_TEST_DSN_OWNER" >.agent/evidence/db/integration-migrate.txt 2>&1 \
  || { cat .agent/evidence/db/integration-migrate.txt >&2; fail "migrate failed"; }
grep -qx 'migrate: ok' .agent/evidence/db/integration-migrate.txt \
  || { cat .agent/evidence/db/integration-migrate.txt >&2; fail "migrate did not print its sentinel"; }

# The seed supplies the two-tenant fixture the isolation suites assert against. It is applied
# only when its tenants are absent: the seed is not idempotent (a second apply fails on
# tenant_pkey), so a re-provisioned database needs it while a reused one already has it.
#
# The count is read through `queryLines`, NOT through the `query` subcommand.
#
# MEASURED: `psql.ts query` prints psql's default ALIGNED output, so the value arrives padded as
# ` vg_tenants=2`, and a `sed -n 's/^vg_tenants=//p'` anchor silently fails to match. The script
# then treated the database as unseeded and re-applied the fixture into a database that already
# had it. `queryLines` sets tuples-only unaligned formatting, which is what makes a labelled
# value reliably parseable.
seeded=$(node -e '
import("./src/infrastructure/database/psql.ts").then(({ parseDsn, queryLines }) => {
  const rows = queryLines(parseDsn(process.env.VG_TEST_DSN_OWNER), "SELECT \x27vg_tenants=\x27 || count(*) FROM tenant;");
  process.stdout.write(rows.join("\n"));
}).catch(() => process.stdout.write(""));
' 2>/dev/null | sed -n 's/^vg_tenants=//p' | tr -d '[:space:]')
case "$seeded" in
  ''|*[!0-9]*) seeded=0 ;;
esac
if [ "$seeded" = "0" ]; then
  node src/infrastructure/database/psql.ts query-file "$VG_TEST_DSN_OWNER" db/seed/prior_release.sql \
    >.agent/evidence/db/integration-seed.txt 2>&1 \
    || { cat .agent/evidence/db/integration-seed.txt >&2; fail "seeding the integration fixture failed"; }
  echo "test-integration: seed applied"
else
  echo "test-integration: seed already present ($seeded tenant row(s))"
fi

# Verify the live database carries the isolation invariant, rather than trusting the migration
# text to have produced it.
sh scripts/check-rls-coverage.sh >.agent/evidence/db/integration-rls.txt 2>&1 \
  || { cat .agent/evidence/db/integration-rls.txt >&2; fail "RLS coverage failed on the provisioned database"; }
grep -q 'rls coverage: ok' .agent/evidence/db/integration-rls.txt \
  || { cat .agent/evidence/db/integration-rls.txt >&2; fail "check-rls-coverage.sh did not print its sentinel"; }

# ---------------------------------------------------------------------------------------------
# Run the suites through the collection guard, so a suite that silently stops being collected
# fails the stage (DOD-007).
# ---------------------------------------------------------------------------------------------
MANIFEST=.agent/verification/EXPECTED_INTEGRATION_MANIFEST.txt
[ -f "$MANIFEST" ] || fail "$MANIFEST is missing; the integration manifest is this stage's contract"

VG_TEST_GLOB="tests/db/**/*.test.ts" VG_EXPECTED_MANIFEST="$MANIFEST" \
  sh scripts/test-collection-guard.sh >.agent/evidence/db/integration-guard.txt 2>&1 \
  || {
    # PRESERVE THE FAILING RUN BEFORE EXITING. MEASURED GAP this closes: this stage runs the suites TWICE (once
    # inside the guard, once directly below), and both write to FIXED paths — so a single failure that does not
    # reproduce is erased by the next run, leaving only "fail 1" with no name. A flake whose identity is lost cannot
    # be investigated, and an unexplained failure is worse than a known one. The copy keeps the runner's own output,
    # which names the failing test.
    cp .agent/evidence/db/integration-guard.txt .agent/evidence/db/integration-guard.failed.txt
    cat .agent/evidence/db/integration-guard.txt >&2
    fail "the integration collection guard failed; the failing run is preserved at .agent/evidence/db/integration-guard.failed.txt"
  }
grep -qx 'test collection guard: ok' .agent/evidence/db/integration-guard.txt \
  || { cat .agent/evidence/db/integration-guard.txt >&2; fail "the collection guard did not print its sentinel"; }
grep -E '^\{"tests":' .agent/evidence/db/integration-guard.txt | tail -n 1

# A direct run as well, so the stage's own output names the suites it ran rather than only
# reporting the guard's summary line.
# Unquoted expansion is deliberate: the collected file list is passed as separate arguments.
# shellcheck disable=SC2086
node --test $ROOTS >.agent/evidence/db/integration-run.txt 2>&1 \
  || { tail -n 60 .agent/evidence/db/integration-run.txt >&2; fail "the service-dependent suites failed"; }
tail -n 8 .agent/evidence/db/integration-run.txt

# Zero-skip assertion (DOD-006): a skipped integration test is a silent blind spot, and this
# stage is precisely where a missing service would tempt one.
if grep -qE '^ℹ skipped [1-9]' .agent/evidence/db/integration-run.txt; then
  grep -E '^ℹ skipped' .agent/evidence/db/integration-run.txt >&2
  fail "the integration suites contain skipped tests; DOD-006 requires an approved waiver per skip"
fi

# ---------------------------------------------------------------------------------------------
# The upgrade matrix. `scripts/test-migrations.sh` is named by db/UPGRADE_MATRIX.md but does not
# exist yet, so the matrix rows it would exercise are UNPROVEN. This stage says so rather than
# implying they passed: an unexercised upgrade path reported as verified is the fabrication
# DOD-016 and DOD-027 forbid.
# ---------------------------------------------------------------------------------------------
{
  echo "upgrade matrix: UNPROVEN"
  echo "scripts/test-migrations.sh does not exist. db/UPGRADE_MATRIX.md names it as the producer of"
  echo "the from-empty, from-prior and failed-migration evidence rows, so those rows are NOT"
  echo "claimed as verified by this stage."
  echo "What IS exercised here: migrations applied to a provisioned database, RLS coverage on the"
  echo "live schema, and the failed-migration retry path recorded by EP-003 M7 (migration 0010"
  echo "failed, rolled back to a known version 9, then applied on retry)."
} > .agent/evidence/db/integration-migrations.txt
echo "test-integration: upgrade matrix UNPROVEN (scripts/test-migrations.sh absent); recorded in integration-migrations.txt"

echo "test-integration: ok"
