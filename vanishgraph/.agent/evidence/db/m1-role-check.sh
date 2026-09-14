#!/usr/bin/env sh
# EP-003 M1 evidence: prove the two-role model has the security properties SPEC-002 RLS-4
# requires. Uses the pinned Node helper rather than shell quoting.
set -eu
# This evidence script lives at .agent/evidence/db/, so the project root is three levels up.
cd "$(dirname "$0")/../../.."

STATE="$(node -e 'console.log(require("node:os").tmpdir())')/vanishgraph-db.env"
# shellcheck disable=SC1090
. "$STATE"

node src/infrastructure/database/psql.ts query "$VG_TEST_DSN_OWNER" \
  "SELECT rolname || ' super=' || rolsuper || ' bypassrls=' || rolbypassrls || ' createdb=' || rolcreatedb FROM pg_roles WHERE rolname IN ('vg_owner','vg_app') ORDER BY rolname;"

echo "== databases owned by vg_owner =="
node src/infrastructure/database/psql.ts query "$VG_TEST_DSN_OWNER" \
  "SELECT datname FROM pg_database WHERE datname LIKE 'vanishgraph%' ORDER BY datname;"

echo "== vg_app can connect and is NOT the table owner (RLS-4) =="
node src/infrastructure/database/psql.ts query "$VG_TEST_DSN_APP" \
  "SELECT current_user || ' is_superuser=' || (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) || ' bypassrls=' || (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user);"

echo "== vg_app holds no table ownership =="
node src/infrastructure/database/psql.ts query "$VG_TEST_DSN_APP" \
  "SELECT count(*) || ' tables owned by vg_app' FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'vg_app';"
