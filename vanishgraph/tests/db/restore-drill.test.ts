/**
 * Backup, restore and erasure reconciliation (SPEC-002 §7, RET-3, DOD-036).
 *
 * Two layers are tested here, and the distinction matters:
 *
 *   1. This file asserts the RECONCILIATION RULES directly against a database: that a tombstone
 *      is enough to identify what a restore must re-sweep, that the key store is the thing that
 *      makes erased data unrecoverable, and that isolation holds after rows are copied.
 *   2. `scripts/backup-drill.sh` performs the actual destructive drill (dump, destroy, restore)
 *      and reports its own five post-conditions. Its output is asserted by the dry-run checks
 *      below, because a drill whose exit status nobody reads proves nothing.
 *
 * NOTHING HERE CLAIMS PITR, RPO, RTO OR MTTR. Point-in-time recovery needs WAL archiving to
 * object storage that is not provisioned, so it is BLOCKED_CREDENTIALS and is asserted to be
 * reported as such rather than silently omitted.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { TENANT_A, TENANT_B, asTenant, exec, ownerDsn, PROJECT_ROOT } from './harness.ts';

const EVIDENCE = join(PROJECT_ROOT, '.agent', 'evidence', 'EP-003', 'restore-drill');

/** Run the drill and capture its output plus exit status without throwing. */
function runDrill(): { status: number; output: string } {
  try {
    const output = execFileSync('sh', ['scripts/backup-drill.sh'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    });
    return { status: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('the backup drill executes a real destructive restore (DOD-036)', () => {
  test('the drill runs, restores, and passes every post-condition', () => {
    const { status, output } = runDrill();
    assert.equal(status, 0, `backup drill failed:\n${output}`);
    assert.match(output, /backup drill: ok$/m, 'the drill must print its sentinel');
  });

  test('every post-condition is reported individually, not summarised', () => {
    const report = join(EVIDENCE, 'post-conditions.txt');
    assert.ok(existsSync(report), 'the drill must write its post-condition report');
    const text = readFileSync(report, 'utf8');
    for (const condition of [
      'erased PII unrecoverable',
      'erasure tombstones present',
      'tombstone names the erased subject',
      'RLS intact',
      'no cross-tenant leakage after restore',
      'audit chain intact',
      'evidence digests verify',
      'restore did NOT resurrect erased PII',
    ]) {
      assert.match(text, new RegExp(`^PASS  ${condition}:`, 'm'), `${condition} must be reported`);
    }
    assert.equal(/^FAIL/m.test(text), false, 'no post-condition may fail');
  });

  test('the severity-1 resurrection check is present and passing', () => {
    const text = readFileSync(join(EVIDENCE, 'post-conditions.txt'), 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('PASS  restore did NOT resurrect'));
    assert.ok(line !== undefined, 'the drill must assert that a restore does not resurrect erased PII');
    assert.match(line, /recoverable key material=0/, 'no erased row may retain recoverable key material');
  });

  test('the pre-disaster state is recorded before the backup is taken', () => {
    // A post-condition compared against nothing is not a comparison.
    const text = readFileSync(join(EVIDENCE, 'pre-disaster.txt'), 'utf8');
    assert.match(text, /tombstones=1/, 'the pre-disaster tombstone count must be recorded');
    assert.match(text, /identifier_rows=2/, 'the ciphertext rows must survive erasure and be counted');
    assert.match(text, /rls_tables=\d+/, 'the pre-disaster RLS posture must be recorded');
  });

  test('the dump is identified by digest, and the raw dump is not committed', () => {
    const digestFile = join(EVIDENCE, 'dump-digest.txt');
    assert.ok(existsSync(digestFile), 'the dump digest must be recorded');
    assert.match(readFileSync(digestFile, 'utf8'), /^[0-9a-f]{64}\s/m, 'a sha256 digest is recorded');
    assert.equal(
      existsSync(join(EVIDENCE, 'drill.dump')),
      false,
      'the raw dump is a run artefact, not evidence; only its digest belongs in the repository',
    );
  });

  test('PITR is reported BLOCKED_CREDENTIALS rather than claimed', () => {
    const text = readFileSync(join(EVIDENCE, 'pitr-status.txt'), 'utf8');
    assert.match(text, /PITR: BLOCKED_CREDENTIALS/, 'the unexercised path must be labelled');
    assert.match(text, /What is NOT claimed/, 'the drill must state what it does not claim');
  });

  test('key recovery is recorded as independent of the database', () => {
    const text = readFileSync(join(EVIDENCE, 'key-recovery.txt'), 'utf8');
    assert.match(text, /kek_location=external-to-database/);
    assert.match(text, /kms_status=BLOCKED_CREDENTIALS/);
  });
});

describe('erasure reconciliation rules (RET-3)', () => {
  test('a tombstone identifies exactly what a restore must re-sweep', () => {
    const subject = `00000000-0000-4000-8000-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const inserted = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO erasure_tombstone
         (tenant_id, subject_id, erased_at, legal_basis, shredded_key_versions, shredded_counts)
       VALUES ('${TENANT_A}', '${subject}', now(), 'CCPA_DELETE', ARRAY[21,22]::integer[],
               '{"identifier":4}'::jsonb);
       COMMIT;`,
    );
    assert.equal(inserted.status, 0, inserted.output);

    // The sweep query a restore would run: which key versions must not exist any more?
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT shredded_key_versions::text FROM erasure_tombstone WHERE subject_id = '${subject}';`,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0] ?? '', /\{21,22\}/, 'the destroyed versions must be readable after a restore');
  });

  test('un-erased subjects have no tombstone, so the sweep cannot over-delete', () => {
    // The inverse of the check above: a restore that swept everything would destroy retained
    // data. Subjects with no tombstone must simply not appear in the sweep set.
    //
    // The subject must be one this suite KNOWS has never been erased. The seeded alpha subject
    // was previously used here and is NOT safe: the retention suite (M7) erases it, so the
    // assertion failed with '1' !== '0'. A fresh random subject has no tombstone by construction.
    const neverErased = `00000000-0000-4000-8000-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT count(*)::text FROM erasure_tombstone WHERE subject_id = '${neverErased}';`,
    );
    assert.equal(rows[0], '0', 'a subject that was never erased must have no tombstone');

    // And confirm the table is not simply empty, which would make the assertion above vacuous.
    const anyTombstones = asTenant(
      ownerDsn(),
      TENANT_A,
      'SELECT count(*)::text FROM erasure_tombstone;',
    );
    assert.ok(
      Number(anyTombstones[0]) >= 1,
      'the tombstone table must actually contain rows, or the check above proves nothing',
    );
  });

  test('isolation holds on rows copied into a fresh table (a restore in miniature)', () => {
    // The drill restores a whole database; this reproduces the part that could silently break —
    // that rows copied into a new table do NOT inherit RLS, so the policy must be re-applied.
    const table = 'restore_probe_tmp';
    const created = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       DROP TABLE IF EXISTS ${table};
       CREATE TABLE ${table} (tenant_id uuid NOT NULL, note text NOT NULL);
       INSERT INTO ${table} (tenant_id, note)
       VALUES ('${TENANT_A}', 'a-row'), ('${TENANT_B}', 'b-row');
       COMMIT;`,
    );
    assert.equal(created.status, 0, created.output);

    try {
      // With RLS not yet applied, vg_app sees both tenants' rows. This is the hazard the drill's
      // re-assert step exists to close, and asserting it makes the hazard explicit rather than
      // theoretical.
      const unprotected = asTenant(
        ownerDsn(),
        TENANT_A,
        `SELECT count(*)::text FROM ${table};`,
      );
      assert.equal(
        unprotected[0],
        '2',
        'a newly created table has no RLS until it is applied — this is why a restore must re-assert it',
      );

      const applied = exec(
        ownerDsn(),
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
         ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
         CREATE POLICY tenant_isolation ON ${table}
           USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
           WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`,
      );
      assert.equal(applied.status, 0, applied.output);

      const isolated = asTenant(ownerDsn(), TENANT_A, `SELECT count(*)::text FROM ${table};`);
      assert.equal(isolated[0], '1', 'after the policy is applied, only the tenant row is visible');
    } finally {
      exec(ownerDsn(), `DROP TABLE IF EXISTS ${table};`);
    }
  });
});
