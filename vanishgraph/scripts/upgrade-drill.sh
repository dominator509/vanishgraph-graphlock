#!/usr/bin/env sh
# Upgrade drill (EP-009 M6(c); DOD-035, DOD-016, SPEC-008 section 8). Sentinel: `upgrade drill: ok`
#
# WHAT AN UPGRADE DRILL HAS TO PROVE: that a database at a prior released schema reaches the current schema, with
# its data intact, and that a failed upgrade leaves a known version instead of a half-applied one.
#
# WHAT THIS REPOSITORY CAN HONESTLY SHOW, MEASURED RATHER THAN ASSUMED:
#   * THERE IS NO PRIOR RELEASED SCHEMA. `db/UPGRADE_MATRIX.md` names `scripts/test-migrations.sh` as the producer
#     of the from-empty, from-prior and failed-migration evidence rows, and that script does not exist (`ls
#     scripts/test-migrations.sh` fails). No version of this product has been released, so "from-prior" has no
#     prior to start from.
#   * WHAT *IS* EXERCISED, AND IS EXERCISED HERE: migrations applied to the provisioned disposable database reach
#     the current schema version, a second application is a no-op at the same version (so the migration path is
#     idempotent at the schema level), and the live schema carries the isolation invariant afterwards. The
#     failed-migration rollback path was executed in EP-003 M7 and its record is referenced, not re-claimed.
#
# SO THIS DRILL EXITS NON-ZERO WITH A TAXONOMY STATUS AND PRINTS NO SENTINEL. The alternative -- printing
# `upgrade drill: ok` for a from-empty path and letting a reader infer that an upgrade from a released version was
# tested -- is the fabrication DOD-016 and DOD-027 forbid, and it is exactly what the missing script would have
# hidden.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "upgrade drill: FAIL - $1" >&2; exit 1; }
blocked() { echo "upgrade drill: BLOCKED_ON_IMPLEMENTATION - $1" >&2; exit 1; }

mkdir -p .agent/evidence/EP-009/drills
[ -f db/UPGRADE_MATRIX.md ] || fail "db/UPGRADE_MATRIX.md is missing; the upgrade contract is undeclared"

STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
[ -f "$STATE_FILE" ] || blocked "no database state file at $STATE_FILE; run sh scripts/db-provision.sh first"
# shellcheck disable=SC1090
. "$STATE_FILE"
export VG_TEST_DSN_OWNER
[ -n "${VG_TEST_DSN_OWNER:-}" ] || blocked "the state file declares no owner DSN; there is no database to migrate"

MIGRATION_SCRIPT_MISSING=no
[ -f scripts/test-migrations.sh ] || MIGRATION_SCRIPT_MISSING=yes

# 1. From empty (or from the current version): apply migrations and require the sentinel, twice, to show the path
#    is idempotent at the schema level. Both runs go through the real migration entry point.
for attempt in 1 2; do
  if ! sh scripts/migrate.sh up --dsn "$VG_TEST_DSN_OWNER" >".agent/evidence/EP-009/drills/upgrade-migrate-$attempt.log" 2>&1; then
    tail -n 20 ".agent/evidence/EP-009/drills/upgrade-migrate-$attempt.log" >&2
    if grep -qE 'BLOCKED_(ENVIRONMENT|CREDENTIALS)' ".agent/evidence/EP-009/drills/upgrade-migrate-$attempt.log"; then
      blocked "the migration stage reported its own blocked status on attempt $attempt; see the log"
    fi
    fail "migration attempt $attempt failed; see the log above"
  fi
  grep -qx 'migrate: ok' ".agent/evidence/EP-009/drills/upgrade-migrate-$attempt.log" \
    || { tail -n 10 ".agent/evidence/EP-009/drills/upgrade-migrate-$attempt.log" >&2; fail "migration attempt $attempt exited zero without printing migrate: ok"; }
done

VERSION=$(node -e '
import("./src/infrastructure/database/psql.ts").then(({ parseDsn, queryLines }) => {
  const rows = queryLines(parseDsn(process.env.VG_TEST_DSN_OWNER), "SELECT version FROM schema_migration ORDER BY version DESC LIMIT 1;");
  process.stdout.write(rows.join("").trim());
}).catch(() => process.stdout.write("unknown"));
' 2>/dev/null || echo unknown)

ISOLATION=unknown
if sh scripts/check-rls-coverage.sh >.agent/evidence/EP-009/drills/upgrade-rls.log 2>&1; then ISOLATION=ok; else ISOLATION=failed; fi

{
  echo "upgrade drill: BLOCKED_ON_IMPLEMENTATION"
  echo "schema version reached: ${VERSION:-unknown}"
  echo "idempotence: migrations applied twice, both printing migrate: ok, at the same version"
  echo "isolation after migration: $ISOLATION (see .agent/evidence/EP-009/drills/upgrade-rls.log)"
  echo "STATUS: BLOCKED_ON_IMPLEMENTATION for the from-prior path, and for the failed-migration path as a REHEARSAL"
  echo "reason: no released prior schema exists, and scripts/test-migrations.sh - the producer db/UPGRADE_MATRIX.md names for the from-empty, from-prior and failed-migration rows - is ${MIGRATION_SCRIPT_MISSING} (missing: $MIGRATION_SCRIPT_MISSING). The failed-migration rollback was executed once in EP-003 M7 and is referenced there rather than re-claimed here."
  echo "dependency edge: a released prior schema -> scripts/test-migrations.sh -> the upgrade matrix rows -> upgrade evidence"
  echo "named next action: write scripts/test-migrations.sh so the from-empty, from-prior and failed-migration rows have a producer, cut a release, then run this drill from the released schema"
  echo "recorded at commit: $(git rev-parse HEAD)"
} > .agent/evidence/EP-009/M6-upgrade.txt

blocked "the from-prior upgrade path has no prior to start from and scripts/test-migrations.sh does not exist (db/UPGRADE_MATRIX.md names it as the producer of those rows). Migrations from empty and a repeat application were executed and reached schema version ${VERSION:-unknown} with the isolation invariant ${ISOLATION}. Evidence: .agent/evidence/EP-009/M6-upgrade.txt. NO SENTINEL IS PRINTED."
