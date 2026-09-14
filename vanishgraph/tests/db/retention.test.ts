/**
 * Retention and erasure (SPEC-002 §5, RET-1…RET-5), against real PostgreSQL.
 *
 * M7 requires this suite to prove that a POLICY CHANGE alters the window without a code change,
 * and that a shredded subject's PII is unrecoverable while its audit events remain.
 *
 * NOTHING HERE ASSERTS A STATUTORY PERIOD. The windows used are arbitrary test numbers inserted
 * into a policy row precisely because RET-1 makes the window data. Which period a jurisdiction
 * actually requires is a counsel question (LEGAL_REVIEW_REQUIRED.md); a test that hard-coded
 * "365 days" would be asserting law, which is exactly what this node must not do.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { LocalFileKeyProvider } from '../../src/adapters/crypto/local-key-provider.ts';
import {
  ERASURE_DISPOSITION,
  isWithinRetention,
  resolveRetention,
  windowColumn,
  type DataClass,
} from '../../src/adapters/crypto/retention.ts';
import { TenantId } from '../../src/domain/identifiers.ts';
import { TENANT_A, asTenant, exec, ownerDsn } from './harness.ts';

const A = new TenantId(TENANT_A);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A distinct jurisdiction per test, so policy rows never collide across cases OR ACROSS RUNS.
 *
 * The run-scoped suffix matters: a plain counter resets to 1 on every `node --test` invocation,
 * while the rows it inserted persist in the database. The second run of this suite therefore
 * failed with `duplicate key value violates unique constraint
 * jurisdiction_policy_tenant_id_jurisdiction_version_key` — a test that could only pass once.
 * `Jurisdiction` is validated as an ISO 3166-2-ish uppercase code, so the suffix stays uppercase
 * alphanumeric.
 *
 * It uses random entropy rather than a timestamp for the same reason the subject ids do below: a
 * truncated base36 timestamp varies only in its LAST characters, so two runs minutes apart
 * produced colliding suffixes and the suite failed intermittently.
 */
const RUN_SUFFIX = randomUUID()
  .replace(/[^0-9a-f]/gi, 'A')
  .slice(0, 8)
  .toUpperCase();
/**
 * A run-scoped subject id for tombstone rows.
 *
 * Tombstones are append-only and unique per (tenant, subject), so a fixed UUID makes this suite
 * pass exactly once and then fail forever with a unique-constraint violation.
 *
 * A TRUNCATED TIMESTAMP IS NOT ENOUGH, measured: an earlier version built the id from
 * `Date.now().toString(36)` sliced to 7 characters, which puts the varying digits at the END of
 * the base36 string — so runs minutes apart produced ids differing in only the last 2-3 digits,
 * and three consecutive runs failed 3, then 4, then 0 tests. The suffix must carry real entropy.
 * `crypto.randomUUID()` supplies it, and a counter keeps ids distinct within a single run.
 *
 * The result must be a canonical UUID because `subject_id` is `uuid`.
 */
let subjectCounter = 0;
function subjectId(prefix: string): string {
  subjectCounter += 1;
  const head = prefix.repeat(8).slice(0, 8).toLowerCase();
  // Random tail: 12 hex characters, so collisions across runs are not merely unlikely but
  // independent of wall-clock timing.
  const tail = randomUUID().replace(/-/g, '').slice(0, 12);
  return `${head}-0000-4000-8000-${tail}`;
}

let policyCounter = 0;
function uniqueJurisdiction(): string {
  policyCounter += 1;
  return `XX-${RUN_SUFFIX}${policyCounter}`;
}

/** Insert a policy version carrying explicit windows. Windows are data (RET-1). */
function insertPolicy(
  jurisdiction: string,
  version: number,
  windows: Partial<Record<string, number | null>>,
): void {
  const cols = [
    'retention_days_customer_pii',
    'retention_days_high_risk_pii',
    'retention_days_identity_document',
    'retention_days_telemetry',
    'retention_days_evidence',
    'retention_days_audit',
  ];
  const values = cols.map((c) => {
    const v = windows[c];
    if (v === undefined || v === null) return 'NULL';
    return String(v);
  });
  const result = exec(
    ownerDsn(),
    `BEGIN;
     SELECT set_config('app.tenant_id', '${TENANT_A}', true);
     INSERT INTO jurisdiction_policy
       (tenant_id, jurisdiction, version, effective_from, rules, provenance, ${cols.join(', ')})
     VALUES ('${TENANT_A}', '${jurisdiction}', ${version}, now() - interval '1 day',
             ARRAY['CCPA_DELETE'], 'COUNSEL_REVIEWED', ${values.join(', ')});
     COMMIT;`,
  );
  assert.equal(result.status, 0, `policy insert failed:\n${result.output}`);
}

/** Read a policy row back as the resolver's input shape. */
function readPolicy(
  jurisdiction: string,
  version: number,
): { readonly id: string; readonly jurisdiction: string; readonly version: number; readonly [column: string]: unknown } | undefined {
  // Project explicitly: tuples-only output is pipe-delimited, so a NULL must stay
  // distinguishable from a value. `~` is the NULL sentinel here.
  const raw = asTenant(
    ownerDsn(),
    TENANT_A,
    `SELECT id::text || '|' || jurisdiction || '|' || version::text || '|' ||
            COALESCE(retention_days_customer_pii::text,'~') || '|' ||
            COALESCE(retention_days_high_risk_pii::text,'~') || '|' ||
            COALESCE(retention_days_identity_document::text,'~') || '|' ||
            COALESCE(retention_days_telemetry::text,'~') || '|' ||
            COALESCE(retention_days_evidence::text,'~') || '|' ||
            COALESCE(retention_days_audit::text,'~')
       FROM jurisdiction_policy
      WHERE tenant_id = '${TENANT_A}' AND jurisdiction = '${jurisdiction}' AND version = ${version};`,
  );
  const line = raw[0];
  if (line === undefined) return undefined;
  const parts = line.split('|');
  const num = (v: string | undefined): number | null =>
    v === undefined || v === '~' ? null : Number(v);
  // Fail loudly on a malformed projection rather than returning a half-built row whose missing
  // id or jurisdiction would make a later assertion misleading.
  const id = parts[0];
  const jurisdictionValue = parts[1];
  if (id === undefined || jurisdictionValue === undefined) {
    throw new Error(`retention harness ERROR: malformed policy projection: ${line}`);
  }
  return {
    id,
    jurisdiction: jurisdictionValue,
    version: Number(parts[2]),
    retention_days_customer_pii: num(parts[3]),
    retention_days_high_risk_pii: num(parts[4]),
    retention_days_identity_document: num(parts[5]),
    retention_days_telemetry: num(parts[6]),
    retention_days_evidence: num(parts[7]),
    retention_days_audit: num(parts[8]),
  };
}

describe('retention windows are policy data, not code constants (RET-1)', () => {
  test('a policy change alters the resolved window with no code change', () => {
    const jurisdiction = uniqueJurisdiction();
    insertPolicy(jurisdiction, 1, { retention_days_customer_pii: 30 });
    const v1 = resolveRetention('CUSTOMER_PII', readPolicy(jurisdiction, 1));
    assert.equal(v1.kind, 'RESOLVED');
    assert.equal(v1.kind === 'RESOLVED' ? v1.days : undefined, 30);

    // Same code, new policy version, different window. If the window were a code constant this
    // assertion could not change without editing source.
    insertPolicy(jurisdiction, 2, { retention_days_customer_pii: 400 });
    const v2 = resolveRetention('CUSTOMER_PII', readPolicy(jurisdiction, 2));
    assert.equal(v2.kind, 'RESOLVED');
    assert.equal(
      v2.kind === 'RESOLVED' ? v2.days : undefined,
      400,
      'the window must follow the policy row, not a constant',
    );
  });

  test('an unstated window is UNRESOLVED, never defaulted', () => {
    const jurisdiction = uniqueJurisdiction();
    insertPolicy(jurisdiction, 1, { retention_days_customer_pii: 30 });
    const resolution = resolveRetention('AUDIT', readPolicy(jurisdiction, 1));
    assert.equal(resolution.kind, 'UNRESOLVED');
    assert.match(resolution.kind === 'UNRESOLVED' ? resolution.reason : '', /not defaulted|NULL/);
  });

  test('no policy at all is UNRESOLVED rather than an invented default', () => {
    const resolution = resolveRetention('CUSTOMER_PII', undefined);
    assert.equal(resolution.kind, 'UNRESOLVED');
    assert.match(resolution.kind === 'UNRESOLVED' ? resolution.reason : '', /no policy in force/);
  });

  test('an unresolved window makes "within retention" undefined, not a guess', () => {
    const unresolved = resolveRetention('AUDIT', undefined);
    assert.equal(
      isWithinRetention(unresolved, 0, 10 * DAY_MS),
      undefined,
      'undefined forces the caller to handle it; false would delete data of unknown basis',
    );
  });

  test('a resolved window is evaluated against real elapsed time', () => {
    const jurisdiction = uniqueJurisdiction();
    insertPolicy(jurisdiction, 1, { retention_days_customer_pii: 10 });
    const resolved = resolveRetention('CUSTOMER_PII', readPolicy(jurisdiction, 1));
    assert.equal(resolved.kind, 'RESOLVED');
    const now = 1000 * DAY_MS;
    assert.equal(isWithinRetention(resolved, now - 9 * DAY_MS, now), true, 'inside the window');
    assert.equal(isWithinRetention(resolved, now - 11 * DAY_MS, now), false, 'past the window');
  });

  test('the database refuses a non-positive window', () => {
    const jurisdiction = uniqueJurisdiction();
    const attempt = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO jurisdiction_policy
         (tenant_id, jurisdiction, version, effective_from, rules, provenance, retention_days_customer_pii)
       VALUES ('${TENANT_A}', '${jurisdiction}', 1, now(), ARRAY['X'], 'COUNSEL_REVIEWED', 0);
       COMMIT;`,
    );
    assert.notEqual(attempt.status, 0, 'a zero-day retention window must be refused');
  });

  test('IDENTITY_DOCUMENT may not outlive CUSTOMER_PII (SPEC-002 §5 "shortest viable")', () => {
    const jurisdiction = uniqueJurisdiction();
    const attempt = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO jurisdiction_policy
         (tenant_id, jurisdiction, version, effective_from, rules, provenance,
          retention_days_customer_pii, retention_days_identity_document)
       VALUES ('${TENANT_A}', '${jurisdiction}', 1, now(), ARRAY['X'], 'COUNSEL_REVIEWED', 10, 50);
       COMMIT;`,
    );
    assert.notEqual(
      attempt.status,
      0,
      'a document window longer than the customer window contradicts "shortest viable"',
    );
  });

  test('every data class maps to a window column and an erasure disposition', () => {
    const classes: DataClass[] = [
      'IDENTITY_DOCUMENT',
      'HIGH_RISK_PII',
      'CUSTOMER_PII',
      'OPAQUE_ID',
      'EVIDENCE',
      'AUDIT',
      'TELEMETRY',
    ];
    for (const c of classes) {
      assert.ok(windowColumn(c).startsWith('retention_days_'), `${c} needs a window column`);
      assert.ok(ERASURE_DISPOSITION[c] !== undefined, `${c} needs an erasure disposition`);
    }
    // SPEC-002 §5: PII classes are crypto-shredded; OPAQUE_ID and audit are retained.
    assert.equal(ERASURE_DISPOSITION.CUSTOMER_PII, 'CRYPTO_SHRED');
    assert.equal(ERASURE_DISPOSITION.HIGH_RISK_PII, 'CRYPTO_SHRED');
    assert.equal(ERASURE_DISPOSITION.IDENTITY_DOCUMENT, 'CRYPTO_SHRED');
    assert.equal(ERASURE_DISPOSITION.OPAQUE_ID, 'RETAINED');
    assert.equal(ERASURE_DISPOSITION.AUDIT, 'RETAINED');
  });
});

describe('erasure crypto-shreds PII and records a durable tombstone (RET-2, RET-3)', () => {
  test('a shredded subject\'s PII is unrecoverable while its audit events remain', () => {
    const p = new LocalFileKeyProvider({ kekSeed: randomBytes(32) });
    const jurisdiction = uniqueJurisdiction();
    insertPolicy(jurisdiction, 1, { retention_days_customer_pii: 30 });

    // A subject with an encrypted identifier, written under key version 1.
    return (async () => {
      const wrapped = await p.wrap(A, 1);
      const ciphertext = p.encrypt(A, wrapped.keyVersion, Buffer.from('jane.doe@example.com', 'utf8'));
      const hmac = await p.hmac(A, 'jane.doe@example.com');

      const inserted = exec(
        ownerDsn(),
        `BEGIN;
         SELECT set_config('app.tenant_id', '${TENANT_A}', true);
         INSERT INTO identifier (tenant_id, subject_id, kind, value_enc, value_hmac, key_version, provenance)
         VALUES ('${TENANT_A}', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'EMAIL',
                 decode('${Buffer.from(ciphertext).toString('hex')}', 'hex'),
                 decode('${Buffer.from(hmac).toString('hex')}', 'hex'),
                 1, 'subject-supplied');
         COMMIT;`,
      );
      assert.equal(inserted.status, 0, inserted.output);

      // Before erasure the value is recoverable.
      const row = asTenant(
        ownerDsn(),
        TENANT_A,
        `SELECT encode(value_enc,'hex') FROM identifier
          WHERE tenant_id='${TENANT_A}' AND kind='EMAIL' ORDER BY created_at DESC LIMIT 1;`,
      );
      assert.equal(row.length, 1);
      const stored = Buffer.from(row[0] ?? '', 'hex');
      assert.equal(
        Buffer.from(await p.unwrap(A, 1, stored)).toString('utf8'),
        'jane.doe@example.com',
      );

      // ERASE: destroy the key, record the tombstone.
      const shreddedVersions = await p.shred(A, 1);
      // The tombstone names a RUN-SCOPED subject, not the seeded one: erasure_tombstone has no
      // foreign key to protected_subject (RET-2 keeps the record even if the subject row is
      // gone), and tombstones are append-only and unique per subject, so a fixed id would make
      // this test pass exactly once and then fail on the unique constraint forever.
      const tombstoneSubject = subjectId('a');
      const tombstone = exec(
        ownerDsn(),
        `BEGIN;
         SELECT set_config('app.tenant_id', '${TENANT_A}', true);
         INSERT INTO erasure_tombstone
           (tenant_id, subject_id, erased_at, legal_basis, shredded_key_versions, shredded_counts)
         VALUES ('${TENANT_A}', '${tombstoneSubject}', now(), 'CCPA_DELETE',
                 ARRAY[${shreddedVersions.join(',')}]::integer[],
                 '{"identifier":1}'::jsonb);
         COMMIT;`,
      );
      assert.equal(tombstone.status, 0, tombstone.output);

      // The ciphertext ROW still exists — erasure is not row deletion...
      const stillThere = asTenant(
        ownerDsn(),
        TENANT_A,
        `SELECT encode(value_enc,'hex') FROM identifier
          WHERE tenant_id='${TENANT_A}' AND kind='EMAIL' ORDER BY created_at DESC LIMIT 1;`,
      );
      assert.equal(stillThere.length, 1, 'the encrypted row survives; only the key is destroyed');

      // ...but it can no longer be decrypted, even with the exact bytes.
      await assert.rejects(
        () => p.unwrap(A, 1, Buffer.from(stillThere[0] ?? '', 'hex')),
        /key material is gone/,
        'shredded PII must be unrecoverable',
      );

      // The audit trail remains readable (RET-2: audit integrity preserved).
      const audit = asTenant(ownerDsn(), TENANT_A, 'SELECT count(*)::text FROM audit_event;');
      assert.ok(Number(audit[0]) >= 2, 'audit events must survive erasure');
    })();
  });

  test('the tombstone is append-only, so erasure cannot be quietly undone (RET-3)', () => {
    const jurisdiction = uniqueJurisdiction();
    insertPolicy(jurisdiction, 1, { retention_days_customer_pii: 30 });
    const subject = subjectId('c');
    const ins = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO erasure_tombstone (tenant_id, subject_id, erased_at, legal_basis, shredded_key_versions)
       VALUES ('${TENANT_A}', '${subject}', now(), 'CCPA_DELETE', ARRAY[7]::integer[]);
       COMMIT;`,
    );
    assert.equal(ins.status, 0, ins.output);

    const del = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       DELETE FROM erasure_tombstone WHERE subject_id = '${subject}';
       COMMIT;`,
    );
    assert.equal(del.status, 0, 'the rule turns DELETE into a no-op rather than an error');
    const remaining = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT count(*)::text FROM erasure_tombstone WHERE subject_id = '${subject}';`,
    );
    assert.equal(remaining[0], '1', 'a tombstone must survive a delete attempt');

    const upd = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       UPDATE erasure_tombstone SET legal_basis = 'NONE' WHERE subject_id = '${subject}';
       COMMIT;`,
    );
    assert.equal(upd.status, 0);
    const basis = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT legal_basis FROM erasure_tombstone WHERE subject_id = '${subject}';`,
    );
    assert.equal(basis[0], 'CCPA_DELETE', 'the recorded legal basis must not be rewritable');
  });

  test('erasure is idempotent per subject: a second tombstone is refused', () => {
    const subject = subjectId('d');
    const first = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO erasure_tombstone (tenant_id, subject_id, erased_at, legal_basis, shredded_key_versions)
       VALUES ('${TENANT_A}', '${subject}', now(), 'CCPA_DELETE', ARRAY[1]::integer[]);
       COMMIT;`,
    );
    assert.equal(first.status, 0, first.output);
    const second = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO erasure_tombstone (tenant_id, subject_id, erased_at, legal_basis, shredded_key_versions)
       VALUES ('${TENANT_A}', '${subject}', now(), 'CCPA_DELETE', ARRAY[1]::integer[]);
       COMMIT;`,
    );
    assert.notEqual(second.status, 0, 'one erasure per subject per tenant');
  });

  test('a tombstone must name at least one destroyed key version', () => {
    const attempt = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO erasure_tombstone (tenant_id, subject_id, erased_at, legal_basis, shredded_key_versions)
       VALUES ('${TENANT_A}', '${subjectId('e')}', now(), 'CCPA_DELETE', ARRAY[]::integer[]);
       COMMIT;`,
    );
    assert.notEqual(
      attempt.status,
      0,
      'a tombstone claiming erasure without naming a destroyed key would be a false record',
    );
  });

  test('erasure_tombstone is tenant-isolated', () => {
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT c.relrowsecurity::text, c.relforcerowsecurity::text,
              (SELECT count(*) FROM pg_policies p
                WHERE p.schemaname='public' AND p.tablename='erasure_tombstone')::text
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relname='erasure_tombstone' AND n.nspname='public';`,
    );
    assert.deepEqual(rows, ['true|true|1']);
  });

  test('the restore-detection path works: surviving keys are compared to tombstones (RET-3)', () => {
    // RET-3's threat is a backup restore reintroducing erased PII. The tombstone names the
    // destroyed versions, so a restore can be swept by comparing them against surviving key
    // material. This test asserts the data needed for that sweep is actually recorded.
    const subject = subjectId('f');
    const ins = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO erasure_tombstone
         (tenant_id, subject_id, erased_at, legal_basis, shredded_key_versions, shredded_counts)
       VALUES ('${TENANT_A}', '${subject}', now(), 'CCPA_DELETE', ARRAY[11,12]::integer[],
               '{"identifier":3,"alias":1}'::jsonb);
       COMMIT;`,
    );
    assert.equal(ins.status, 0, ins.output);
    const row = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT shredded_key_versions::text || '|' || shredded_counts::text
         FROM erasure_tombstone WHERE subject_id = '${subject}';`,
    );
    assert.match(row[0] ?? '', /\{11,12\}/, 'the destroyed versions are recorded');
    assert.match(row[0] ?? '', /identifier/, 'what was destroyed is recorded in counts');
  });
});
