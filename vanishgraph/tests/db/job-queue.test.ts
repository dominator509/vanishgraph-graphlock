/**
 * The Postgres-native job queue (ADR-016, SPEC-001 §10).
 *
 * The two assertions that matter are the first two in this file: a rolled-back transaction leaves
 * NO job row, and an identical idempotency key is not enqueued twice. Everything else is support.
 *
 * The rollback test is the reason this suite exists at all. A queue that enqueues on its own
 * connection passes every "the job was created" test while being exactly the dual-write bug
 * ADR-016 removed, so proving that a rollback removes the job is the only evidence that enqueue
 * is genuinely inside the caller's transaction.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PostgresJobQueue,
  isPostgresTransactionHandle,
  runTransaction,
  type PostgresTransactionHandle,
} from '../../src/adapters/queue/postgres-job-queue.ts';
import type { JobDefinition } from '../../src/application/ports/job-queue.ts';
import { TenantId } from '../../src/domain/identifiers.ts';
import { TENANT_A, TENANT_B, asTenant, exec, ownerDsn } from './harness.ts';
import type { Dsn } from '../../src/infrastructure/database/psql.ts';

const queue = new PostgresJobQueue();

/** `JobDefinition.tenantId` is the branded domain type, not a bare string. */
const TENANT_A_ID = new TenantId(TENANT_A);
const TENANT_B_ID = new TenantId(TENANT_B);

function newHandle(): PostgresTransactionHandle {
  return { dsn: ownerDsn(), statements: [], closed: false };
}

function job(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    kind: 'reobserve-exposure',
    tenantId: TENANT_A_ID,
    payload: { exposureId: '99999999-1111-4111-8111-999999999999' },
    runAtMs: Date.now(),
    // Unique per call by default; tests that exercise idempotency pass an explicit key.
    idempotencyKey: `k-${Math.random().toString(36).slice(2)}`,
    maxAttempts: 5,
    ...overrides,
  };
}

/** Count jobs for a tenant, at the database's own isolation boundary. */
function jobCount(dsn: Dsn, tenantId: string, key?: string): number {
  const where = key === undefined ? '' : ` WHERE idempotency_key = '${key}'`;
  const rows = asTenant(dsn, tenantId, `SELECT count(*)::text FROM job${where};`);
  return Number(rows[0]);
}

describe('transactional enqueue (the property ADR-016 exists to protect)', () => {
  test('enqueue then ROLLBACK leaves no job row', async () => {
    const key = `rollback-${Date.now()}`;
    const handle = newHandle();
    await queue.enqueue(handle, job({ idempotencyKey: key }));

    // The statement was accumulated into the caller's transaction, not executed on its own.
    assert.equal(
      handle.statements.length,
      1,
      'enqueue must append to the caller\'s transaction rather than execute immediately',
    );

    const before = jobCount(ownerDsn(), TENANT_A, key);
    assert.equal(before, 0, 'nothing may be durable before the transaction commits');

    const result = runTransaction(ownerDsn(), TENANT_A, handle.statements, { rollback: true });
    assert.equal(result.status, 0, `rollback transaction failed:\n${result.output}`);

    assert.equal(
      jobCount(ownerDsn(), TENANT_A, key),
      0,
      'a rolled-back transition must leave NO job row; a job that survives its transition is the dual-write bug',
    );
  });

  test('enqueue then COMMIT makes exactly one durable row', async () => {
    const key = `commit-${Date.now()}`;
    const handle = newHandle();
    await queue.enqueue(handle, job({ idempotencyKey: key }));
    const result = runTransaction(ownerDsn(), TENANT_A, handle.statements);
    assert.equal(result.status, 0, `commit transaction failed:\n${result.output}`);
    assert.equal(jobCount(ownerDsn(), TENANT_A, key), 1);
  });

  test('a job with an identical idempotency key is not enqueued twice', async () => {
    const key = `dup-${Date.now()}`;
    const first = newHandle();
    await queue.enqueue(first, job({ idempotencyKey: key }));
    assert.equal(runTransaction(ownerDsn(), TENANT_A, first.statements).status, 0);

    // A replay of the same key — a retried command, a redelivered message — must be a no-op.
    const second = newHandle();
    await queue.enqueue(second, job({ idempotencyKey: key }));
    assert.equal(runTransaction(ownerDsn(), TENANT_A, second.statements).status, 0);

    assert.equal(
      jobCount(ownerDsn(), TENANT_A, key),
      1,
      'ON CONFLICT DO NOTHING must make a replayed key at-most-once (VG-ACTION-001)',
    );
  });

  test('the same key may be used by two different tenants', async () => {
    const key = `shared-${Date.now()}`;
    for (const tenantId of [TENANT_A_ID, TENANT_B_ID]) {
      const handle = newHandle();
      await queue.enqueue(handle, job({ tenantId, idempotencyKey: key }));
      // `.value`, not `String(...)`: OpaqueId.toString() renders as "TenantId:<uuid>".
      assert.equal(
        runTransaction(ownerDsn(), tenantId.value, handle.statements).status,
        0,
        `enqueue for ${tenantId.value} must commit`,
      );
    }
    assert.equal(jobCount(ownerDsn(), TENANT_A, key), 1);
    // The uniqueness constraint is (tenant_id, idempotency_key), so B is not blocked by A.
    assert.equal(
      asTenant(ownerDsn(), TENANT_B, `SELECT count(*)::text FROM job WHERE idempotency_key = '${key}';`)[0],
      '1',
      'tenant-scoped uniqueness must not let one tenant block another tenant\'s key',
    );
  });
});

describe('the adapter refuses to enqueue outside a transaction', () => {
  test('a non-transaction handle is rejected, not silently given a connection', async () => {
    await assert.rejects(
      () => queue.enqueue({}, job()),
      /job queue ERROR: enqueue\/cancel require a PostgresTransactionHandle/,
      'a bare object must not silently become a fresh connection',
    );
    await assert.rejects(() => queue.enqueue(undefined, job()), /job queue ERROR/);
    await assert.rejects(() => queue.enqueue(null, job()), /job queue ERROR/);
  });

  test('a closed handle is rejected', async () => {
    const handle = newHandle();
    handle.closed = true;
    await assert.rejects(
      () => queue.enqueue(handle, job()),
      /the transaction handle is already closed/,
    );
  });

  test('isPostgresTransactionHandle distinguishes real handles', () => {
    assert.equal(isPostgresTransactionHandle(newHandle()), true);
    assert.equal(isPostgresTransactionHandle({}), false);
    assert.equal(isPostgresTransactionHandle({ dsn: {}, statements: [] }), false);
    assert.equal(isPostgresTransactionHandle('a dsn string'), false);
  });
});

describe('job table constraints hold in the database, not only in code', () => {
  test('the queue table is tenant-isolated like every other tenant-scoped table', () => {
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT c.relrowsecurity::text, c.relforcerowsecurity::text,
              (SELECT count(*) FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = 'job')::text
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'job' AND n.nspname = 'public';`,
    );
    assert.deepEqual(rows, ['true|true|1'], 'job must be enabled, forced and policied');
  });

  test('a cross-tenant job insert is refused by WITH CHECK', () => {
    const attempt = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO job (tenant_id, kind, idempotency_key)
       VALUES ('${TENANT_B}', 'cross-tenant-evil', 'evil-key');
       COMMIT;`,
    );
    assert.notEqual(attempt.status, 0);
    assert.match(attempt.output, /row-level security/i, attempt.output);
  });

  test('a terminal job may not change status', () => {
    const key = `terminal-${Date.now()}`;
    const setup = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO job (tenant_id, kind, idempotency_key, status, completed_at)
       VALUES ('${TENANT_A}', 'reobserve-exposure', '${key}', 'SUCCEEDED', now());
       COMMIT;`,
    );
    assert.equal(setup.status, 0, setup.output);

    const resurrect = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       UPDATE job SET status = 'RUNNING' WHERE idempotency_key = '${key}';
       COMMIT;`,
    );
    assert.notEqual(resurrect.status, 0, 'a completed job must not be resurrected');
    assert.match(resurrect.output, /terminal|may not change status/i, resurrect.output);
  });

  test('a job may not be born already completed or exceed its attempt budget', () => {
    const bornDone = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO job (tenant_id, kind, idempotency_key, status, completed_at)
       VALUES ('${TENANT_A}', 'k', 'born-done-${Date.now()}', 'PENDING', now());
       COMMIT;`,
    );
    assert.notEqual(bornDone.status, 0, 'PENDING with completed_at set violates job_status_lifecycle');

    const overspend = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO job (tenant_id, kind, idempotency_key, attempt, max_attempts)
       VALUES ('${TENANT_A}', 'k', 'overspend-${Date.now()}', 9, 5);
       COMMIT;`,
    );
    assert.notEqual(overspend.status, 0, 'attempt > max_attempts must be refused');
  });

  test('the worker heartbeat is NOT tenant-scoped, by design', () => {
    // job_worker is infrastructure liveness serving every tenant. If a later change adds
    // tenant_id to it, this test fails and forces that to be a deliberate decision.
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'job_worker' AND column_name = 'tenant_id';`,
    );
    assert.equal(rows[0], '0', 'job_worker must carry no tenant_id (see db/tenant-scoped-tables.txt)');
  });
});
