#!/usr/bin/env sh
# EP-003 M3 evidence: prove append-only audit behaviour and RLS enforcement against live
# PostgreSQL, using the tenant-scoped transaction helper.
set -eu
cd "$(dirname "$0")/../../.."

STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
# shellcheck disable=SC1090
. "$STATE_FILE"

TENANT_A=11111111-1111-1111-1111-111111111111
TENANT_B=22222222-2222-2222-2222-222222222222

echo "== 1. an audit INSERT without app.tenant_id is refused by RLS (WITH CHECK working) =="
node src/infrastructure/database/psql.ts query "$VG_EMPTY_DSN_OWNER" \
  "INSERT INTO audit_event (tenant_id, actor, action, target_kind, correlation_id) VALUES (gen_random_uuid(),'t','a','k',gen_random_uuid());" \
  >/dev/null 2>&1 && echo "   UNEXPECTED: accepted" || echo "   refused, as it must be"

echo "== 2. the same INSERT inside a tenant transaction is accepted =="
node src/infrastructure/database/psql.ts query "$VG_EMPTY_DSN_OWNER" \
  "BEGIN; SELECT set_config('app.tenant_id','$TENANT_A',true); INSERT INTO audit_event (tenant_id, actor, action, target_kind, correlation_id) VALUES ('$TENANT_A','tester','TestAction','RequestCase',gen_random_uuid()); COMMIT;"

echo "== 3. UPDATE is a no-op (VG-EVIDENCE-003 / VG-DATA-004) =="
node src/infrastructure/database/psql.ts query "$VG_EMPTY_DSN_OWNER" \
  "BEGIN; SELECT set_config('app.tenant_id','$TENANT_A',true); UPDATE audit_event SET actor='TAMPERED'; COMMIT;"
echo "   actor value now:"
node src/infrastructure/database/psql.ts query "$VG_EMPTY_DSN_OWNER" \
  "SELECT actor FROM audit_event;"

echo "== 4. DELETE is a no-op =="
node src/infrastructure/database/psql.ts query "$VG_EMPTY_DSN_OWNER" \
  "BEGIN; SELECT set_config('app.tenant_id','$TENANT_A',true); DELETE FROM audit_event; COMMIT;"
node src/infrastructure/database/psql.ts query "$VG_EMPTY_DSN_OWNER" \
  "SELECT 'rows remaining: ' || count(*) FROM audit_event;"

echo "== 5. TRUNCATE is refused by the append-only trigger =="
node src/infrastructure/database/psql.ts query "$VG_EMPTY_DSN_OWNER" "TRUNCATE audit_event CASCADE;" 2>&1 \
  | grep -iE 'append-only|ERROR' || echo "   UNEXPECTED: truncate was allowed"

echo "== 6. cross-tenant read returns zero rows (RLS reads) =="
node src/infrastructure/database/psql.ts query "$VG_EMPTY_DSN_OWNER" \
  "BEGIN; SELECT set_config('app.tenant_id','$TENANT_B',true); SELECT 'tenant B sees ' || count(*) || ' audit rows' FROM audit_event; COMMIT;"
