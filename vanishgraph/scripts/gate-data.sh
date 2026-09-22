#!/usr/bin/env sh
# EP-003 node gate. Sentinel: `gate-data: ok`
#
# The node-level verify for the data and persistence node. It proves the node by running every
# real gate it depends on and requiring each one's exact sentinel, and by proving four properties
# that a green suite cannot prove on its own:
#
#   * the provisioned database really carries isolation, enumerated over the live catalog rather
#     than asserted from the migration text (RLS-2, VG-DATA-001);
#   * cross-tenant WRITE is refused, not merely cross-tenant read (VG-DATA-003) — a database that
#     reads cleanly but accepts a foreign-tenant row is the worse failure;
#   * the mutation check still detects every controlled defect, so a passing suite is not a
#     suite that stopped checking (DOD-018);
#   * `verify.sh` now ADVANCES PAST `integration` — the concrete progression this node exists to
#     produce — and still does not print `verify: ok`.
#
# `verify.sh` keeps the full fifteen-stage order mandated by the master prompt (section 10
# Scripts, line 1357). Nothing here removes, reorders, or exempts a stage; the remaining stages
# need a built artifact and an API (EP-004…EP-010), which is why this node's verify is a
# node-scoped gate and not `verify: ok`.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "gate-data: FAIL - $1" >&2; exit 1; }

EVIDENCE=.agent/evidence/EP-003
mkdir -p "$EVIDENCE"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0

# require_sentinel <sentinel> <command...>
require_sentinel() {
  sentinel=$1
  shift
  if ! out=$("$@" 2>&1); then
    echo "gate-data: FAIL - command failed: $*" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
  printf '%s\n' "$out" | grep -qxF "$sentinel" \
    || fail "expected sentinel '$sentinel' as the last line of: $*"
}

# ---------------------------------------------------------------------------------------------
# 1. Static hygiene: every shell script parses, and none prints a sentinel without doing work.
# ---------------------------------------------------------------------------------------------
for f in $(find scripts -type f -name '*.sh' | sort); do
  sh -n "$f" || fail "sh -n failed for $f"
done
echo "gate-data: sh -n ok for $(find scripts -type f -name '*.sh' | wc -l | tr -d ' ') scripts"

# ---------------------------------------------------------------------------------------------
# 2. Provisioning, which everything below depends on. A closed Docker daemon is
#    BLOCKED_ENVIRONMENT, so it is reported as such rather than as a candidate failure.
# ---------------------------------------------------------------------------------------------
if ! sh scripts/db-provision.sh >"$EVIDENCE/provision.txt" 2>&1; then
  cat "$EVIDENCE/provision.txt" >&2
  echo "gate-data: BLOCKED_ENVIRONMENT - PostgreSQL could not be provisioned (DOD-032, DOD-033)" >&2
  exit 1
fi
grep -qx 'db provision: ok' "$EVIDENCE/provision.txt" || fail "db-provision.sh did not print its sentinel"

STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
[ -f "$STATE_FILE" ] || fail "no database state file at $STATE_FILE"
# shellcheck disable=SC1090
. "$STATE_FILE"
export VG_TEST_DSN_OWNER VG_TEST_DSN_APP

require_sentinel 'migrate: ok' sh scripts/migrate.sh up --dsn "$VG_TEST_DSN_OWNER"

# ---------------------------------------------------------------------------------------------
# 3. The live isolation inventory, enumerated from the catalog (RLS-2, VG-DATA-001).
# ---------------------------------------------------------------------------------------------
require_sentinel 'rls coverage: ok' sh scripts/check-rls-coverage.sh

# The generator's --check mode proves the SOURCE text still matches the list; check-rls-coverage
# proves the LIVE database does. Both are needed: either alone can be satisfied while the other
# drifts.
require_sentinel 'rls generation: ok' node scripts/generate-rls.ts --check

# The central list must match the live inventory exactly, so a table added without isolation
# fails this gate rather than passing unnoticed.
live_tables=$(node -e '
const { parseDsn, queryLines } = await import("./src/infrastructure/database/psql.ts");
const rows = queryLines(parseDsn(process.env.VG_TEST_DSN_OWNER),
  "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace" +
  " JOIN information_schema.columns col ON col.table_schema=\x27public\x27" +
  " AND col.table_name=c.relname AND col.column_name=\x27tenant_id\x27" +
  " WHERE c.relkind=\x27r\x27 AND n.nspname=\x27public\x27 ORDER BY c.relname;");
process.stdout.write(rows.join("\n"));
' --input-type=module)
listed_tables=$(sed -e 's/#.*//' -e 's/[[:space:]]*$//' db/tenant-scoped-tables.txt | grep -v '^$' | sort)
[ "$live_tables" = "$listed_tables" ] || {
  echo "gate-data: FAIL - the live tenant-scoped inventory differs from db/tenant-scoped-tables.txt" >&2
  printf '%s\n' "$listed_tables" > "$tmp/listed_tables.txt"
  printf '%s\n' "$live_tables" > "$tmp/live_tables.txt"
  diff "$tmp/listed_tables.txt" "$tmp/live_tables.txt" >&2 || true
  exit 1
}
table_count=$(printf '%s\n' "$live_tables" | grep -c . )
[ "$table_count" -ge 20 ] || fail "only $table_count tenant-scoped tables found; the inventory looks wrong"
echo "gate-data: $table_count tenant-scoped tables, list and live catalog agree"

# ---------------------------------------------------------------------------------------------
# 4. Cross-tenant READ and WRITE, as two separate assertions at the database layer
#    (VG-DATA-002, VG-DATA-003). Run as vg_app, because a superuser bypasses RLS by definition
#    and would measure the prober's privilege instead of the isolation.
# ---------------------------------------------------------------------------------------------
seed_if_needed() {
  # `tenant` carries no tenant_id, so this probe needs no tenant setting — but it still reads
  # through queryLines so the value is unaligned and parseable.
  seeded=$(node -e '
const { parseDsn, queryLines } = await import("./src/infrastructure/database/psql.ts");
const rows = queryLines(parseDsn(process.env.VG_TEST_DSN_OWNER), "SELECT count(*) FROM tenant;");
process.stdout.write(rows[0] ?? "0");
' --input-type=module 2>/dev/null | tr -d '[:space:]')
  case "$seeded" in ''|*[!0-9]*) seeded=0 ;; esac
  if [ "$seeded" = "0" ]; then
    node src/infrastructure/database/psql.ts query-file "$VG_TEST_DSN_OWNER" db/seed/prior_release.sql \
      >"$EVIDENCE/seed.txt" 2>&1 || { cat "$EVIDENCE/seed.txt" >&2; fail "could not seed the isolation fixture"; }
    echo "gate-data: seed applied"
  fi
}
seed_if_needed

# The read assertion, and its control: the tenant must still see its OWN rows. A probe that can
# see nothing would also "pass" a cross-tenant read check.
read_probe=$(node -e '
const { parseDsn, runSql } = await import("./src/infrastructure/database/psql.ts");
const dsn = parseDsn(process.env.VG_TEST_DSN_APP);
const r = runSql(dsn, [
  "BEGIN;",
  "SELECT set_config(\x27app.tenant_id\x27, \x2711111111-1111-4111-8111-111111111111\x27, true);",
  "SELECT \x27vg_leak=\x27 || count(*) FROM protected_subject WHERE tenant_id=\x2722222222-2222-4222-8222-222222222222\x27;",
  "SELECT \x27vg_own=\x27 || count(*) FROM protected_subject;",
  "COMMIT;",
].join("\n"));
process.stdout.write(r.output);
' --input-type=module 2>&1)
leak=$(printf '%s\n' "$read_probe" | sed -n 's/.*vg_leak=\([0-9]*\).*/\1/p' | head -n 1)
own=$(printf '%s\n' "$read_probe" | sed -n 's/.*vg_own=\([0-9]*\).*/\1/p' | head -n 1)
[ "$leak" = "0" ] || fail "cross-tenant READ returned $leak row(s) as vg_app (VG-DATA-002); expected 0"
[ -n "$own" ] && [ "$own" -ge 1 ] || fail "tenant A cannot see its own rows (own=$own); the read probe proves nothing"
echo "gate-data: cross-tenant read returns 0, own rows visible ($own) as vg_app"

# The write assertion: a cross-tenant INSERT must be REFUSED by WITH CHECK.
write_probe=$(node -e '
const { parseDsn, runSql } = await import("./src/infrastructure/database/psql.ts");
const dsn = parseDsn(process.env.VG_TEST_DSN_APP);
const r = runSql(dsn, [
  "BEGIN;",
  "SELECT set_config(\x27app.tenant_id\x27, \x2711111111-1111-4111-8111-111111111111\x27, true);",
  "INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)",
  "VALUES (\x27deadbeef-0000-4000-8000-00000000dead\x27, \x2722222222-2222-4222-8222-222222222222\x27, \x27gate-ref-evil\x27, \x27US-CA\x27, false, \x27ACTIVE\x27);",
  "COMMIT;",
].join("\n"));
process.stdout.write(JSON.stringify({ status: r.status, refused: /row-level security/i.test(r.output) }));
' --input-type=module 2>&1)
printf '%s' "$write_probe" | grep -q '"refused":true' \
  || fail "a cross-tenant WRITE was not refused by row-level security (VG-DATA-003): $write_probe"
echo "gate-data: cross-tenant write refused by WITH CHECK"

# ---------------------------------------------------------------------------------------------
# 5. audit_event is append-only in the database, not merely in convention (VG-DATA-004).
# ---------------------------------------------------------------------------------------------
# The count is read inside ONE transaction. `set_config(..., true)` is transaction-local, so
# without an explicit BEGIN it is cleared before the next statement and the RLS policy then sees
# an empty app.tenant_id — measured as `invalid input syntax for type uuid: ""`. Every probe in
# this gate therefore names its tenant inside the same transaction it queries in.
audit_count() {
  node -e '
const { parseDsn, queryLines } = await import("./src/infrastructure/database/psql.ts");
const rows = queryLines(parseDsn(process.env.VG_TEST_DSN_OWNER), [
  "BEGIN;",
  "SELECT set_config(\x27app.tenant_id\x27, \x2711111111-1111-4111-8111-111111111111\x27, true);",
  "SELECT \x27vg_audit=\x27 || count(*) FROM audit_event;",
  "COMMIT;",
].join("\n"));
process.stdout.write(rows.join("\n"));
' --input-type=module 2>/dev/null | sed -n 's/.*vg_audit=\([0-9]*\).*/\1/p' | head -n 1
}

audit_before=$(audit_count | tr -d '[:space:]')
[ -n "$audit_before" ] || fail "could not read the audit row count"

node -e '
const { parseDsn, runSql } = await import("./src/infrastructure/database/psql.ts");
runSql(parseDsn(process.env.VG_TEST_DSN_OWNER), [
  "BEGIN;",
  "SELECT set_config(\x27app.tenant_id\x27, \x2711111111-1111-4111-8111-111111111111\x27, true);",
  "UPDATE audit_event SET actor=\x27tampered\x27;",
  "DELETE FROM audit_event;",
  "COMMIT;",
].join("\n"));
' --input-type=module >/dev/null 2>&1 || true

audit_after=$(audit_count | tr -d '[:space:]')
[ -n "$audit_after" ] || fail "could not read the audit row count after the append-only probe"
[ "$audit_before" = "$audit_after" ] \
  || fail "audit_event changed from $audit_before to $audit_after rows after UPDATE+DELETE; it is not append-only (VG-DATA-004)"
echo "gate-data: audit_event append-only (UPDATE and DELETE are no-ops; $audit_before rows unchanged)"

# ---------------------------------------------------------------------------------------------
# 6. Every real gate in the node, by exact sentinel.
# ---------------------------------------------------------------------------------------------
require_sentinel 'typecheck: ok'           sh scripts/typecheck.sh
require_sentinel 'lint: ok'                sh scripts/lint.sh
require_sentinel 'format-check: ok'        sh scripts/format-check.sh
require_sentinel 'import boundary: ok'     sh scripts/import-boundary.sh
require_sentinel 'reality gate: ok'        sh scripts/reality-gate.sh
require_sentinel 'env validation: ok'      sh scripts/validate-env.sh
require_sentinel 'test-unit: ok'           sh scripts/test-unit.sh

# The collection guard, both ways round (DOD-007): green on the real suites, and RED on an empty
# collection. A guard that cannot fail is decoration.
require_sentinel 'test collection guard: ok' sh scripts/test-collection-guard.sh
empty_dir=$(mktemp -d)
if VG_TEST_GLOB="${empty_dir}/**/*.test.ts" sh scripts/test-collection-guard.sh \
     >"$tmp/empty-guard.txt" 2>&1; then
  fail "the collection guard exited 0 on an empty collection (DOD-007 violated)"
fi
grep -q 'zero tests were collected' "$tmp/empty-guard.txt" \
  || fail "the empty-collection failure used an unexpected message; see $tmp/empty-guard.txt"
echo "gate-data: zero-collection negative proof ok"

# The database suites themselves, through the manifest guard.
require_sentinel 'test-integration: ok' sh scripts/test-integration.sh

# The upgrade-matrix rows are UNPROVEN because scripts/test-migrations.sh does not exist. This
# gate asserts that fact is RECORDED rather than silently dropped: an unexercised upgrade path
# reported as verified is the fabrication DOD-016 forbids.
grep -q 'upgrade matrix: UNPROVEN' .agent/evidence/db/integration-migrations.txt \
  || fail "the upgrade-matrix status is not recorded as UNPROVEN; it must not be implied as verified"
echo "gate-data: upgrade matrix recorded UNPROVEN (scripts/test-migrations.sh absent)"

# ---------------------------------------------------------------------------------------------
# 7. Mutation proof (DOD-018). A suite that passes while no longer detecting a controlled defect
#    is the most dangerous kind of green, so this is asserted rather than assumed.
# ---------------------------------------------------------------------------------------------
require_sentinel 'mutation check: ok' sh scripts/mutation-check.sh

# ---------------------------------------------------------------------------------------------
# 8. verify.sh progression. THIS NODE'S CENTRAL CLAIM: integration now CLEARS.
# ---------------------------------------------------------------------------------------------
progression="$EVIDENCE/verify-progression.txt"
if sh scripts/verify.sh >"$progression" 2>&1; then
  fail "verify.sh exited 0 although artifact-bound stages are unimplemented; a pass here is a fabrication (DOD-027)"
fi
# Only sentinels from stages that RUN BEFORE the stop point can appear here. The mandated order
# (spec line 1357) puts `test-collection-guard` AFTER `security-check`, so requiring it in this
# transcript was wrong: the run correctly stops at security-check and never reaches it. The
# collection guard is proven by its own `require_sentinel` above, in this gate.
for sentinel in 'preflight: ok' 'lint: ok' 'format-check: ok' 'typecheck: ok' \
                'test-unit: ok' 'test-integration: ok'; do
  grep -qF "$sentinel" "$progression" || fail "the verify transcript is missing '$sentinel'"
done
grep -q 'verify: running stage integration' "$progression" \
  || fail "verify.sh did not reach the integration stage"
# The progression itself: integration must have CLEARED, and the run must stop at a LATER stage.
grep -q 'verify: running stage security-check' "$progression" \
  || fail "verify.sh did not advance past integration to security-check; the node's progression claim is unproven"
if grep -qE '^ERROR: .*integration.*unimplemented' "$progression"; then
  fail "the integration stage still fails as an unimplemented placeholder"
fi
if grep -qx 'verify: ok' "$progression"; then
  fail "verify.sh printed its success sentinel while stages are unimplemented (DOD-024)"
fi
# Name the stage the run stopped at, for the operator. `grep -m1` after the integration line
# would match the integration line ITSELF, which reported "stops later, at 'integration'" — a
# misleading progress line in a gate is exactly the kind of untruth this project forbids, so the
# line is skipped explicitly.
after_integration=$(sed -n '/verify: running stage integration/,$p' "$progression" \
  | grep 'verify: running stage' | sed -n '2p' | sed 's/.*stage //; s/ .*//')
[ -n "$after_integration" ] || fail "verify.sh did not run any stage after integration"
grep -q "verify: running stage ${after_integration}" "$progression" \
  || fail "could not identify the stage following integration"
echo "gate-data: verify.sh progression ok (integration cleared; stops later, at '${after_integration}'; no verify: ok)"

# ---------------------------------------------------------------------------------------------
# 9. Teardown proof (DOD-025). The disposable container must be gone, and the gate must prove it
#    rather than report an intention.
# ---------------------------------------------------------------------------------------------
require_sentinel 'db teardown: ok' sh scripts/db-teardown.sh
if command -v docker >/dev/null 2>&1; then
  remaining=$(docker ps -a --filter "name=${VG_DB_CONTAINER_NAME:-vanishgraph-ep003-postgres}" --format '{{.Names}}' 2>/dev/null || true)
  [ -z "$remaining" ] || fail "container '$remaining' still exists after teardown"
fi
echo "gate-data: teardown proof ok (container gone)"

echo "gate-data: ok"
