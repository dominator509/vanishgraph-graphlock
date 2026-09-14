#!/usr/bin/env sh
# EP-003 M2 evidence: verify the schema 0001 produced, using the pinned psql helper.
set -eu
cd "$(dirname "$0")/../../.."

STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
# shellcheck disable=SC1090
. "$STATE_FILE"

echo "== truth_state members, in spec order =="
node src/infrastructure/database/psql.ts query "$VG_EMPTY_DSN_OWNER" \
  "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'truth_state' ORDER BY e.enumsortorder;"

echo "== enum types created by 0001 =="
node src/infrastructure/database/psql.ts query "$VG_EMPTY_DSN_OWNER" \
  "SELECT typname FROM pg_type WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace ORDER BY typname;"

echo "== tables created by 0001 =="
node src/infrastructure/database/psql.ts query "$VG_EMPTY_DSN_OWNER" \
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"

echo "== apply idempotency: a second up applies nothing =="
sh scripts/migrate.sh up --dsn "$VG_EMPTY_DSN_OWNER" 2>&1 | grep 'migrate:' || true
