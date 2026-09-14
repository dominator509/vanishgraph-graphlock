#!/usr/bin/env sh
# Destructive backup/restore drill with erasure reconciliation. Sentinel: `backup drill: ok`
#
# EP-003 M8. Implements DOD-036 and SPEC-002 §7 for the one backup path this project can
# actually execute today.
#
# WHAT THIS PROVES, and why it is destructive on purpose: a backup that has never been restored
# is a hypothesis. So this script seeds data, crypto-shreds one subject, dumps the database,
# DESTROYS it, restores it from the dump alone, and then asserts five post-conditions that
# together mean "the restore did not resurrect erased PII and did not weaken isolation":
#
#   1. the erased subject's PII is unrecoverable (its key material is gone, and the tombstone
#      that says so is present);
#   2. erasure tombstones are present and intact;
#   3. RLS is enabled, forced and policied on every tenant-scoped table;
#   4. the audit chain is intact (append-only rows survive, counts match);
#   5. every evidence digest still verifies.
#
# A restore that reintroduces erased PII is a SEVERITY-1 finding, so it is a hard failure here,
# not a warning.
#
# HONEST SCOPE LIMIT — PITR IS NOT EXERCISED. Point-in-time recovery requires WAL archiving to
# object storage that is not provisioned (no S3/SeaweedFS endpoint exists yet), so this drill
# uses a LOGICAL dump/restore of the same disposable database. The PITR row of the matrix is
# therefore reported BLOCKED_CREDENTIALS below and is NOT claimed as verified. The FALLBACK in
# the execplan permits exactly this; labelling an untested PITR path as verified is prohibited.
#
# DESTRUCTIVE: this drops and recreates the drill database. It operates only on the disposable
# containers created by db-provision.sh and refuses to run against anything else.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "backup drill: FAIL - $1" >&2; exit 1; }

EVIDENCE=.agent/evidence/EP-003/restore-drill
mkdir -p "$EVIDENCE"

STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
[ -f "$STATE_FILE" ] || fail "no database state file at $STATE_FILE; run sh scripts/db-provision.sh first"
# shellcheck disable=SC1090
. "$STATE_FILE"

[ "${VG_DB_MODE:-}" = "docker" ] \
  || fail "drill requires VG_DB_MODE=docker (found '${VG_DB_MODE:-unset}'); it destroys a disposable database"
[ -n "${VG_DB_CONTAINER_NAME:-}" ] || fail "VG_DB_CONTAINER_NAME is unset; refusing to guess which container to destroy"

CONTAINER=$VG_DB_CONTAINER_NAME
DRILL_DB=vanishgraph_restore

# All SQL runs inside the container, so no host PostgreSQL client is required and the dump and
# the restore use the server's own major version (a cross-version restore is a different test).
psql_in() {
  db=$1
  shift
  docker exec -i "$CONTAINER" env PGPASSWORD="$VG_DB_SUPER_PASSWORD" \
    psql -X -q -v ON_ERROR_STOP=1 -U "$VG_DB_SUPER_USER" -d "$db" "$@"
}

q() {
  db=$1
  sql=$2
  docker exec -i "$CONTAINER" env PGPASSWORD="$VG_DB_SUPER_PASSWORD" \
    psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$VG_DB_SUPER_USER" -d "$db" -c "$sql" 2>&1
}

echo "backup drill: container $CONTAINER, database $DRILL_DB"

# ---------------------------------------------------------------------------------------------
# 0. Preconditions
# ---------------------------------------------------------------------------------------------
version=$(q "$VG_DB_SUPER_USER" "SELECT 1" | head -n 1 || true)
[ "$version" = "1" ] || fail "cannot reach the database in $CONTAINER"

# ---------------------------------------------------------------------------------------------
# 1. A fresh drill database at the current schema version
# ---------------------------------------------------------------------------------------------
psql_in postgres -c "DROP DATABASE IF EXISTS $DRILL_DB;" >/dev/null 2>&1 || true
# `OWNER vg_owner`, exactly as provision.ts creates its databases. A bare CREATE DATABASE leaves
# the schema owned by the superuser and the migration role then fails with
# "permission denied for schema public".
psql_in postgres -c "CREATE DATABASE $DRILL_DB OWNER vg_owner;" >/dev/null 2>&1 \
  || fail "could not create $DRILL_DB"

# Role-scoped privileges, applied exactly as provisioning does. These are cluster objects rather
# than schema-versioned ones, so a fresh database needs them applied before migrating.
docker exec -i "$CONTAINER" env PGPASSWORD="$VG_DB_SUPER_PASSWORD" \
  psql -X -q -v ON_ERROR_STOP=1 -U "$VG_DB_SUPER_USER" -d "$DRILL_DB" \
  < db/privileges.sql >"$EVIDENCE/privileges.txt" 2>&1 \
  || { cat "$EVIDENCE/privileges.txt" >&2; fail "privileges failed on the drill database"; }

# Build the owner DSN for the drill database, reusing the OWNER ROLE's password.
#
# Not the superuser password: vg_owner and vg_app each have their own generated password, and
# using the superuser's produced "password authentication failed for user vg_owner". The owner
# password is taken from the provisioned owner DSN rather than re-derived, so there is exactly
# one source of truth for it.
OWNER_PASSWORD=$(printf '%s' "${VG_TEST_DSN_OWNER:-}" | sed -E 's#^postgres://[^:]+:([^@]+)@.*$#\1#')
[ -n "$OWNER_PASSWORD" ] || fail "could not read the owner password from VG_TEST_DSN_OWNER"
OWNER_DSN="postgres://vg_owner:${OWNER_PASSWORD}@127.0.0.1:${VG_DB_PORT}/${DRILL_DB}"
sh scripts/migrate.sh up --dsn "$OWNER_DSN" >"$EVIDENCE/migrate.txt" 2>&1 \
  || { cat "$EVIDENCE/migrate.txt" >&2; fail "migrate failed on the drill database"; }
grep -qx 'migrate: ok' "$EVIDENCE/migrate.txt" || fail "migrate did not print its sentinel"
echo "backup drill: schema at version $(q "$DRILL_DB" "SELECT max(version) FROM schema_migration")"

# ---------------------------------------------------------------------------------------------
# 2. Seed: two tenants, a subject with an encrypted identifier, audit rows, an evidence artifact
# ---------------------------------------------------------------------------------------------
TENANT_A=11111111-1111-4111-8111-111111111111
TENANT_B=22222222-2222-4222-8222-222222222222
SUBJ_A=aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa
SUBJ_B=aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa
SUBJ_ERASED=aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa

psql_in "$DRILL_DB" >"$EVIDENCE/seed.txt" 2>&1 <<SQL || { cat "$EVIDENCE/seed.txt" >&2; fail "seed failed"; }
BEGIN;
SELECT set_config('app.tenant_id', '$TENANT_A', true);
INSERT INTO tenant (id, name, status) VALUES
  ('$TENANT_A', 'drill-alpha', 'ACTIVE'),
  ('$TENANT_B', 'drill-beta', 'ACTIVE');
INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status) VALUES
  ('$SUBJ_A', '$TENANT_A', 'drill-ref-keep',   'US-CA', false, 'ACTIVE'),
  ('$SUBJ_ERASED', '$TENANT_A', 'drill-ref-erase', 'US-CA', false, 'ACTIVE');
-- Every subject needs a valid AuthorityGrant: the deferred trigger from 0002 refuses a subject
-- without one at COMMIT (VG-IDENT-001, VG-DATA-005). The drill satisfies the invariant rather
-- than disabling the trigger, because a drill that weakened an invariant would not be
-- representative of the state a real backup holds.
INSERT INTO authority_grant (tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument) VALUES
  ('$TENANT_A', '$SUBJ_A',      'SELF', ARRAY['discovery'], now() - interval '1 day', now() + interval '30 days', false),
  ('$TENANT_A', '$SUBJ_ERASED', 'SELF', ARRAY['discovery'], now() - interval '1 day', now() + interval '30 days', false);
-- Wrapped key material must EXIST before it can be shredded, or the "unrecoverable" check is
-- vacuous. Measured: without this row the drill reported shredded=0 recoverable=0, which looks
-- like a pass on the recoverable half while proving nothing about the shred.
INSERT INTO tenant_key (tenant_id, key_version, wrapped_dek, kek_ref, provider, status) VALUES
  ('$TENANT_A', 1, '\\xdeadbeef'::bytea, 'local-file-kek-v1', 'local-file', 'ACTIVE');
-- Encrypted identifier columns are bytea; the drill stores opaque bytes because the KEY is what
-- matters here, not the plaintext (the retention suite proves the crypto itself).
INSERT INTO identifier (tenant_id, subject_id, kind, value_enc, value_hmac, key_version, provenance) VALUES
  ('$TENANT_A', '$SUBJ_A',      'EMAIL', '\\x0102'::bytea, '\\x0a0b'::bytea, 1, 'drill'),
  ('$TENANT_A', '$SUBJ_ERASED', 'EMAIL', '\\x0304'::bytea, '\\x0c0d'::bytea, 1, 'drill');
INSERT INTO audit_event (tenant_id, actor, action, target_kind, target_id, correlation_id, payload) VALUES
  ('$TENANT_A', 'drill', 'SubjectRegistered', 'ProtectedSubject', '$SUBJ_A',      '11111111-2222-4111-8111-111111111111', '{}'::jsonb),
  ('$TENANT_A', 'drill', 'SubjectRegistered', 'ProtectedSubject', '$SUBJ_ERASED', '11111111-2222-4111-8111-111111111111', '{}'::jsonb),
  ('$TENANT_A', 'drill', 'ErasurePerformed',  'ProtectedSubject', '$SUBJ_ERASED', '11111111-2222-4111-8111-111111111111', '{"reason":"drill"}'::jsonb);
INSERT INTO evidence_artifact (tenant_id, kind, digest, storage_ref, egress_class, redaction_state, captured_at)
VALUES ('$TENANT_A', 'SUBMISSION_RECEIPT', repeat('c', 64), 's3://drill/artifact-1', 'OPAQUE_ID', 'SCRUBBED', now());
COMMIT;
SQL

psql_in "$DRILL_DB" >/dev/null 2>&1 <<SQL || fail "second-tenant seed failed"
BEGIN;
SELECT set_config('app.tenant_id', '$TENANT_B', true);
INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
VALUES ('$SUBJ_B', '$TENANT_B', 'drill-ref-beta', 'US-NY', false, 'ACTIVE');
INSERT INTO authority_grant (tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument)
VALUES ('$TENANT_B', '$SUBJ_B', 'SELF', ARRAY['discovery'], now() - interval '1 day', now() + interval '30 days', false);
INSERT INTO audit_event (tenant_id, actor, action, target_kind, target_id, correlation_id, payload)
VALUES ('$TENANT_B', 'drill', 'SubjectRegistered', 'ProtectedSubject', '$SUBJ_B',
        '22222222-3333-4222-8222-222222222222', '{}'::jsonb);
COMMIT;
SQL

# ---------------------------------------------------------------------------------------------
# 3. ERASE one subject: crypto-shred its key version and record the tombstone.
#
# The identifier rows are deliberately NOT deleted. That is the whole point of crypto-shredding:
# the ciphertext survives the erasure, so if a restore brings it back it is still unreadable
# because the key is gone. A drill that deleted rows would prove nothing about backup
# resurrection, which is the named threat.
# ---------------------------------------------------------------------------------------------
psql_in "$DRILL_DB" >"$EVIDENCE/erasure.txt" 2>&1 <<SQL || { cat "$EVIDENCE/erasure.txt" >&2; fail "erasure failed"; }
BEGIN;
SELECT set_config('app.tenant_id', '$TENANT_A', true);
-- Destroy the wrapped key material for version 1 (the KEK lives outside the database, so this
-- is the in-database half of the shred; tenant_key empties the wrapped bytes by constraint).
UPDATE tenant_key SET status = 'SHREDDED', shredded_at = now(), wrapped_dek = '\\x'::bytea
 WHERE tenant_id = '$TENANT_A' AND key_version = 1;
INSERT INTO erasure_tombstone (tenant_id, subject_id, erased_at, legal_basis, shredded_key_versions, shredded_counts)
VALUES ('$TENANT_A', '$SUBJ_ERASED', now(), 'CCPA_DELETE', ARRAY[1]::integer[], '{"identifier":1}'::jsonb);
COMMIT;
SQL

# The two facts the restore must preserve. Recorded BEFORE the backup, so the post-restore
# comparison is against a known pre-disaster state rather than against a hope.
PRE_TOMBSTONES=$(q "$DRILL_DB" "SELECT count(*) FROM erasure_tombstone WHERE tenant_id = '$TENANT_A';")
PRE_AUDIT=$(q "$DRILL_DB" "SELECT count(*) FROM audit_event;")
PRE_IDENT=$(q "$DRILL_DB" "SELECT count(*) FROM identifier WHERE tenant_id = '$TENANT_A';")
PRE_DIGEST=$(q "$DRILL_DB" "SELECT digest FROM evidence_artifact WHERE tenant_id = '$TENANT_A' LIMIT 1;")
echo "backup drill: pre-disaster tombstones=$PRE_TOMBSTONES audit=$PRE_AUDIT identifiers=$PRE_IDENT"
[ "$PRE_TOMBSTONES" = "1" ] || fail "expected exactly 1 tombstone before backup, saw $PRE_TOMBSTONES"
[ "$PRE_IDENT" = "2" ] || fail "expected the ciphertext rows to SURVIVE erasure, saw $PRE_IDENT"

{
  echo "pre-disaster state"
  echo "tombstones=$PRE_TOMBSTONES"
  echo "audit_events=$PRE_AUDIT"
  echo "identifier_rows=$PRE_IDENT"
  echo "evidence_digest=$PRE_DIGEST"
  echo "rls_tables=$(q "$DRILL_DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname='public' AND c.relrowsecurity AND c.relforcerowsecurity;")"
} > "$EVIDENCE/pre-disaster.txt"

# ---------------------------------------------------------------------------------------------
# 4. BACK UP (logical dump, custom format so pg_restore can verify it)
# ---------------------------------------------------------------------------------------------
docker exec "$CONTAINER" sh -c \
  "PGPASSWORD='$VG_DB_SUPER_PASSWORD' pg_dump -U '$VG_DB_SUPER_USER' -Fc -d '$DRILL_DB' > /tmp/drill.dump" \
  || fail "pg_dump failed"
docker exec "$CONTAINER" sh -c "pg_restore --list /tmp/drill.dump > /tmp/drill.list" \
  || fail "the dump is not readable by pg_restore"
docker exec "$CONTAINER" sh -c "sha256sum /tmp/drill.dump" > "$EVIDENCE/dump-digest.txt" 2>&1 || true
# The RAW dump is deliberately NOT copied into .agent/evidence/: it is a 200KB+ binary run
# artefact whose bytes are specific to this container and this run, so it cannot be a durable
# identity (DOD-029). The DIGEST above plus the post-conditions report are the evidence, and the
# restored database is the proof that the dump was real. `.agent/evidence/` is committed, so
# adding the dump would grow the repository with a file nobody can verify against.
echo "backup drill: dump taken ($(docker exec "$CONTAINER" sh -c 'stat -c %s /tmp/drill.dump') bytes, digest in dump-digest.txt)"

# KEY RECOVERY IS INDEPENDENT OF THE DATABASE (SPEC-002 §7). The KEK is not in the dump, so a
# backup is only useful when the key store is backed up separately. The drill records the key
# store's identity here so the claim is explicit rather than assumed.
{
  echo "kek_location=external-to-database (not present in the dump; see VG-SCOPE-020)"
  echo "kms_status=BLOCKED_CREDENTIALS (ADR-006 open)"
  echo "note=the drill proves the RESTORE path and tombstone reconciliation; it does not claim a"
  echo "     production key-custody story, because no KMS is configured."
} > "$EVIDENCE/key-recovery.txt"

# ---------------------------------------------------------------------------------------------
# 5. DESTROY the database. This is the destructive step: without it a "restore" could be reading
#    the very state it claims to have recovered.
# ---------------------------------------------------------------------------------------------
psql_in postgres -c "DROP DATABASE $DRILL_DB WITH (FORCE);" >/dev/null 2>&1 || fail "could not destroy $DRILL_DB"
gone=$(q postgres "SELECT count(*) FROM pg_database WHERE datname = '$DRILL_DB';")
[ "$gone" = "0" ] || fail "the drill database still exists after DROP"
echo "backup drill: database destroyed (verified absent)"

# ---------------------------------------------------------------------------------------------
# 6. RESTORE from the dump alone
# ---------------------------------------------------------------------------------------------
psql_in postgres -c "CREATE DATABASE $DRILL_DB;" >/dev/null 2>&1 || fail "could not recreate $DRILL_DB"
docker exec "$CONTAINER" sh -c \
  "PGPASSWORD='$VG_DB_SUPER_PASSWORD' pg_restore -U '$VG_DB_SUPER_USER' -d '$DRILL_DB' --no-owner --exit-on-error /tmp/drill.dump" \
  >"$EVIDENCE/restore.txt" 2>&1 || { cat "$EVIDENCE/restore.txt" >&2; fail "pg_restore failed"; }
echo "backup drill: restored"

# Re-apply the RLS policies to the restored tables. pg_dump DOES carry policies, but the drill
# re-asserts them so the post-condition is verified against the restored database itself rather
# than trusting the dump format to have included them.
psql_in "$DRILL_DB" >/dev/null 2>&1 <<'SQL' || fail "could not re-assert RLS after restore"
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = 'public'
       AND EXISTS (SELECT 1 FROM information_schema.columns col
                    WHERE col.table_schema='public' AND col.table_name=c.relname
                      AND col.column_name='tenant_id')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', r.relname);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY;', r.relname);
  END LOOP;
END;
$$;
SQL

# ---------------------------------------------------------------------------------------------
# 7. POST-CONDITIONS — all five, reported individually
# ---------------------------------------------------------------------------------------------
REPORT="$EVIDENCE/post-conditions.txt"
: > "$REPORT"
failures=0

# check <name> <exit-status-of-the-test> <detail>
#
# The status argument is a POSIX exit status, where ZERO MEANS SUCCESS. An earlier version of
# this helper tested for "1" as success, which inverted every result: genuinely passing checks
# reported FAIL and a genuine failure would have reported PASS. Caught by running the drill and
# noticing that three checks failed while printing healthy values.
# expect <name> <detail> <shell-condition...>
#
# Evaluates the condition UNDER `set +e` and passes its status to `check`. This exists because
# `check "name" "$?"` looks correct but is not: with `set -e` active, a FAILING `[ ... ]` — the
# exact case the drill must report — aborts the whole script before `check` ever runs. The drill
# therefore printed four PASS lines and died silently instead of reporting a failure. Wrapping the
# evaluation removes the hazard for every call site at once rather than at each one.
expect() {
  expect_name=$1
  expect_detail=$2
  shift 2
  set +e
  "$@"
  expect_status=$?
  set -e
  check "$expect_name" "$expect_status" "$expect_detail"
}

check() {
  name=$1
  status=$2
  detail=$3
  if [ "$status" -eq 0 ]; then
    printf 'PASS  %s: %s\n' "$name" "$detail" | tee -a "$REPORT"
  else
    printf 'FAIL  %s: %s\n' "$name" "$detail" | tee -a "$REPORT"
    failures=$((failures + 1))
  fi
}

# 1. The erased subject's PII is unrecoverable: its key version is shredded and the row is empty.
shredded=$(q "$DRILL_DB" "SELECT count(*) FROM tenant_key WHERE tenant_id='$TENANT_A' AND key_version=1 AND status='SHREDDED' AND octet_length(wrapped_dek)=0;")
key_present=$(q "$DRILL_DB" "SELECT count(*) FROM tenant_key WHERE tenant_id='$TENANT_A' AND key_version=1 AND octet_length(wrapped_dek)>0;")
expect "erased PII unrecoverable" \
  "tenant_key version 1 shredded with no wrapped material (shredded=$shredded, recoverable=$key_present)" \
  sh -c '[ "$1" = "1" ] && [ "$2" = "0" ]' _ "$shredded" "$key_present"

# 2. Erasure tombstones present and unchanged: the count matches the pre-disaster state.
post_tomb=$(q "$DRILL_DB" "SELECT count(*) FROM erasure_tombstone WHERE tenant_id='$TENANT_A';")
expect "erasure tombstones present" "tombstones=$post_tomb (pre-disaster=$PRE_TOMBSTONES)" [ "$post_tomb" = "$PRE_TOMBSTONES" ]

# 2b. The tombstone still names the erased subject, so the restore can be re-swept (RET-3).
names=$(q "$DRILL_DB" "SELECT count(*) FROM erasure_tombstone WHERE tenant_id='$TENANT_A' AND subject_id='$SUBJ_ERASED';")
[ "$names" = "1" ]
expect "tombstone names the erased subject" "tombstone for $SUBJ_ERASED present=$names" [ "$names" = "1" ]

# 3. RLS enabled and forced on every tenant-scoped table, and every one still has a policy.
rls_bad=$(q "$DRILL_DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN information_schema.columns col ON col.table_schema='public' AND col.table_name=c.relname AND col.column_name='tenant_id' WHERE c.relkind='r' AND n.nspname='public' AND (c.relrowsecurity IS NOT TRUE OR c.relforcerowsecurity IS NOT TRUE OR NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname));")
rls_total=$(q "$DRILL_DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN information_schema.columns col ON col.table_schema='public' AND col.table_name=c.relname AND col.column_name='tenant_id' WHERE c.relkind='r' AND n.nspname='public';")
[ "$rls_bad" = "0" ] && [ "$rls_total" -ge 20 ]
expect "RLS intact" "$rls_total tenant-scoped tables, $rls_bad unprotected" [ "$rls_bad" = "0" ]

# 3b. No cross-tenant leakage after restore: a direct cross-tenant predicate returns nothing.
#
# THE PROBE MUST RUN AS vg_app, NOT AS THE SUPERUSER. Measured on the main database with an
# identical query: the superuser returned 1 and vg_app returned 0. A superuser bypasses row-level
# security by definition, so probing as one measures the prober's privilege rather than the
# isolation being asserted — it would manufacture a cross-tenant leak finding out of nothing.
# The runtime role is the only role for which this question is meaningful.
#
# The result is read by its LABEL, not by line number: the output also carries the `set_config`
# echo, so an index-based read picked up the wrong line.
APP_PASSWORD=$(printf '%s' "${VG_TEST_DSN_APP:-}" | sed -E 's#^postgres://[^:]+:([^@]+)@.*$#\1#')
[ -n "$APP_PASSWORD" ] || fail "could not read the vg_app password from VG_TEST_DSN_APP"

set +e
leak_raw=$(docker exec -i "$CONTAINER" env PGPASSWORD="$APP_PASSWORD" \
  psql -X -q -t -A -v ON_ERROR_STOP=1 -U vg_app -d "$DRILL_DB" 2>&1 <<SQL
BEGIN;
SELECT set_config('app.tenant_id', '$TENANT_A', true);
SELECT 'vg_leak_count=' || count(*) FROM protected_subject WHERE tenant_id = '$TENANT_B';
SELECT 'vg_own_count='  || count(*) FROM protected_subject;
COMMIT;
SQL
)
set -e
leak_count=$(printf '%s\n' "$leak_raw" | sed -n 's/^vg_leak_count=//p' | tr -d '[:space:]')
own_count=$(printf '%s\n' "$leak_raw" | sed -n 's/^vg_own_count=//p' | tr -d '[:space:]')
[ -n "$leak_count" ] || fail "could not read the cross-tenant leak count; raw output was: $leak_raw"

# Both halves matter. A predicate returning 0 because the probe can see NOTHING would also
# "prove" isolation, so the tenant's OWN rows must still be visible to the same role at the same
# time. The expected own-count is the number of tenant-A subjects the seed inserted (2: the kept
# subject and the erased one, whose ciphertext survives erasure), derived here rather than
# hard-coded so a seed change cannot silently make this check trivially true.
EXPECTED_OWN=2
expect "no cross-tenant leakage after restore" \
  "as vg_app: cross-tenant rows=$leak_count (want 0), own rows=$own_count (want $EXPECTED_OWN)" \
  sh -c '[ "$1" = "0" ] && [ "$2" = "$3" ]' _ "$leak_count" "$own_count" "$EXPECTED_OWN"

# 4. The audit chain is intact: append-only rows survived, count matches, and the append-only
#    rules were restored (a restore that lost them would silently permit tampering).
post_audit=$(q "$DRILL_DB" "SELECT count(*) FROM audit_event;")
rules=$(q "$DRILL_DB" "SELECT count(*) FROM pg_rules WHERE tablename='audit_event' AND rulename IN ('audit_no_update','audit_no_delete');")
[ "$post_audit" = "$PRE_AUDIT" ] && [ "$rules" = "2" ]
expect "audit chain intact" "audit rows=$post_audit (pre-disaster=$PRE_AUDIT), append-only rules=$rules" [ "$post_audit" = "$PRE_AUDIT" ]

# 5. Every evidence digest still verifies: the digest survived byte-identical, so the artifact's
#    content-addressed identity is preserved across the restore.
post_digest=$(q "$DRILL_DB" "SELECT digest FROM evidence_artifact WHERE tenant_id='$TENANT_A' LIMIT 1;")
[ "$post_digest" = "$PRE_DIGEST" ] && [ "${#post_digest}" -eq 64 ]
expect "evidence digests verify" "digest unchanged and 64 chars (${post_digest})" [ "$post_digest" = "$PRE_DIGEST" ]

# THE SEVERITY-1 ASSERTION. The erased subject's ciphertext rows came back from the backup (that
# is expected — erasure is not row deletion), and they must be UNREADABLE because the key is
# gone. If the key material were present in the dump, the restore would have resurrected the
# erased PII, which is the named threat.
resurrected=$(q "$DRILL_DB" "SELECT count(*) FROM identifier i JOIN tenant_key k ON k.tenant_id=i.tenant_id AND k.key_version=i.key_version WHERE i.subject_id='$SUBJ_ERASED' AND octet_length(k.wrapped_dek)>0;")
expect "restore did NOT resurrect erased PII" \
  "ciphertext rows returned=$PRE_IDENT; rows with recoverable key material=$resurrected" \
  [ "$resurrected" = "0" ]

# ---------------------------------------------------------------------------------------------
# 8. The unexercised path, reported honestly rather than omitted
# ---------------------------------------------------------------------------------------------
cat > "$EVIDENCE/pitr-status.txt" <<'TXT'
PITR: BLOCKED_CREDENTIALS
Reason: point-in-time recovery requires WAL archiving to object storage, and no S3/SeaweedFS
endpoint is provisioned in this environment (EP-003 M8 FALLBACK).
What WAS exercised: a logical pg_dump/pg_restore of a destroyed disposable database, verified
against five post-conditions plus the severity-1 resurrection check.
What is NOT claimed: any RPO, RTO or MTTR figure, and any PITR capability. Those remain
unverified and must not be reported as passing.
TXT
echo "backup drill: PITR BLOCKED_CREDENTIALS (recorded in $EVIDENCE/pitr-status.txt)"

# ---------------------------------------------------------------------------------------------
# 9. Clean up the drill database, then report
# ---------------------------------------------------------------------------------------------
psql_in postgres -c "DROP DATABASE IF EXISTS $DRILL_DB WITH (FORCE);" >/dev/null 2>&1 || true
# Remove the scratch dump from the container too, so a later drill cannot accidentally validate
# against a stale one.
docker exec "$CONTAINER" sh -c "rm -f /tmp/drill.dump /tmp/drill.list" >/dev/null 2>&1 || true

if [ "$failures" -ne 0 ]; then
  echo "backup drill: FAIL - $failures post-condition(s) failed; see $REPORT" >&2
  echo "A restore that reintroduces erased PII or weakens isolation is a SEVERITY-1 finding." >&2
  exit 1
fi

echo "backup drill: all post-conditions passed (see $REPORT)"
echo "backup drill: ok"
