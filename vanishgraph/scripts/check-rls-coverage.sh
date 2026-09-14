#!/usr/bin/env sh
# Live RLS coverage check (SPEC-002 RLS-2, VG-DATA-001). Sentinel: `rls coverage: ok`
#
# Wraps the migration runner's enumeration mode: every table carrying a tenant_id column must
# have RLS enabled, forced, and at least one policy. A new table without isolation fails here.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
fi

if [ -z "${VG_TEST_DSN_OWNER:-}" ]; then
  echo "rls coverage: FAIL - no DSN; run sh scripts/db-provision.sh first" >&2
  exit 1
fi

mkdir -p .agent/evidence/db
if ! node src/infrastructure/database/migrate.ts verify-rls --dsn "$VG_TEST_DSN_OWNER" \
     2>&1 | tee .agent/evidence/db/rls-coverage.txt; then
  echo "rls coverage: FAIL - see .agent/evidence/db/rls-coverage.txt" >&2
  exit 1
fi

grep -qx 'rls coverage: ok' .agent/evidence/db/rls-coverage.txt \
  || { echo "rls coverage: FAIL - the checker did not print its sentinel" >&2; exit 1; }

echo "rls coverage: ok"
