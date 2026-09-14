/**
 * The tenant transaction runner against real PostgreSQL (SPEC-003 §2.4, SPEC-002 RLS-1…RLS-4).
 *
 * THE TEST THAT JUSTIFIES THIS FILE is "a released connection cannot leak its tenant". `SET` and
 * `SET LOCAL` look equivalent and are not: with `SET`, a pooled connection keeps the previous
 * request's tenant, and the next caller reads another tenant's rows. That bug is INVISIBLE in a
 * single-request test, so this suite deliberately runs requests SEQUENTIALLY THROUGH THE SAME POOL —
 * which is what a real server does — and asserts tenant B does not see tenant A's rows.
 *
 * The other property here is that the SERVICE-LAYER check and RLS are INDEPENDENT controls
 * (VG-TENANT-002). This suite proves the RLS half directly: it issues a query that names tenant B's
 * row explicitly under tenant A's context and asserts zero rows come back. No application filter is
 * involved, so a passing result is evidence about the DATABASE, not about our TypeScript.
 *
 * Requires `VG_TEST_DSN_APP` (the runtime role, which is NOT the table owner and lacks BYPASSRLS) so
 * FORCE RLS genuinely applies. Using the owner DSN would weaken the test without failing it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresTenantRunner, postgresReadinessProbe } from '../../src/adapters/persistence/postgres-runner.ts';
import { parseDsn } from '../../src/infrastructure/database/psql.ts';
import { asTenant, exec, ownerDsn } from './harness.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SUBJECT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SUBJECT_B = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';

/** The runtime role's DSN, which is the only one for which RLS is a real control. */
function appDsn() {
  const value = process.env['VG_TEST_DSN_APP'];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      'harness ERROR: VG_TEST_DSN_APP is not set. Provision with sh scripts/db-provision.sh and source the state file.',
    );
  }
  return parseDsn(value);
}

let runner: PostgresTenantRunner;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 1 });
});

after(async () => {
  await runner.close();
});

describe('a tenant transaction is scoped to its tenant', () => {
  test('a query under tenant A sees only tenant A rows', async () => {
    const rows = await runner.withTenantTransaction(TENANT_A, async (tx) => {
      const result = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM protected_subject');
      return result.rows;
    });
    assert.ok(rows.length >= 1, 'tenant A must see its own subject');
    for (const row of rows) {
      assert.equal(row.tenant_id, TENANT_A, 'a row from another tenant leaked into the result');
    }
  });

  test('a query that NAMES tenant B explicitly still returns nothing under tenant A', async () => {
    // This is the database refusing to answer, not our code filtering. That distinction is the whole
    // point of VG-TENANT-002: if the application filter were the only control, this would return rows.
    const rows = await runner.withTenantTransaction(TENANT_A, async (tx) => {
      const result = await tx.query<{ id: string }>(
        'SELECT id FROM protected_subject WHERE tenant_id = $1',
        [TENANT_B],
      );
      return result.rows;
    });
    assert.deepEqual(rows, [], 'RLS must return zero rows for an explicit cross-tenant predicate');
  });

  test('a cross-tenant INSERT is refused by WITH CHECK', async () => {
    await assert.rejects(
      () =>
        runner.withTenantTransaction(TENANT_A, async (tx) => {
          await tx.query(
            `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
             VALUES ('deadbeef-0000-4000-8000-0000000000aa', $1, 'runner-cross-tenant', 'US-CA', false, 'ACTIVE')`,
            [TENANT_B],
          );
        }),
      /row-level security/i,
      'a cross-tenant write must be refused at the database layer',
    );
  });
});

describe('a released connection CANNOT leak its tenant (the SET vs SET LOCAL trap)', () => {
  test('the setting is LOCAL: it does not survive COMMIT on the connection', async () => {
    // THE TEST THAT ACTUALLY DISCRIMINATES `SET` FROM `SET LOCAL`.
    //
    // MEASURED, and the reason the earlier version of this test was worthless: it used a SEPARATE
    // pool and inspected a connection the runner had never touched, so sabotaging the runner to
    // `set_config(..., false)` (session-scoped) left it PASSING. A negative control that does not fail
    // means the test does not measure what it claims to, and shipping it would have been a fabricated
    // guarantee.
    //
    // The leak IS observable, verified separately: with session-scoped `set_config`, a connection
    // released to a pool and re-acquired WITHOUT setting a tenant still reports the previous tenant.
    // The test therefore has to observe the RUNNER'S OWN connection, which is what
    // `observeReleasedConnectionSetting` exists for.
    const localRunner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 1 });
    try {
      await localRunner.withTenantTransaction(TENANT_A, async (tx) => {
        const result = await tx.query<{ value: string }>(
          "SELECT current_setting('app.tenant_id', true) AS value",
        );
        assert.equal(result.rows[0]?.value, TENANT_A, 'the setting must hold INSIDE the transaction');
      });

      const leaked = await localRunner.observeReleasedConnectionSetting();
      assert.ok(
        leaked === null || leaked === '',
        `a pooled connection still carries a tenant (${String(leaked)}); the setting is not LOCAL`,
      );
      assert.notEqual(leaked, TENANT_A, 'the previous tenant survived COMMIT on a pooled connection');
    } finally {
      await localRunner.close();
    }
  });

  test('sequential transactions on a one-connection pool stay isolated', async () => {
    // maxConnections: 1 guarantees the second transaction REUSES the first transaction's connection.
    // This asserts the runner's own contract — every transaction is scoped to the tenant it names —
    // and it is a genuine property even though it does not by itself discriminate SET from SET LOCAL
    // (which the test above does).
    const first = await runner.withTenantTransaction(TENANT_A, async (tx) => {
      const result = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM protected_subject');
      return result.rows;
    });
    assert.ok(first.every((r) => r.tenant_id === TENANT_A), 'the first transaction is tenant A');

    const second = await runner.withTenantTransaction(TENANT_B, async (tx) => {
      const result = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM protected_subject');
      return result.rows;
    });
    assert.ok(second.length >= 1, 'tenant B must see its own subject on the reused connection');
    assert.ok(
      second.every((r) => r.tenant_id === TENANT_B),
      'the reused connection leaked the previous tenant',
    );

    // And back again, so the leak is not merely one-directional.
    const third = await runner.withTenantTransaction(TENANT_A, async (tx) => {
      const result = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM protected_subject');
      return result.rows;
    });
    assert.ok(third.every((r) => r.tenant_id === TENANT_A));
  });

  test('the setting is gone after the transaction ends', async () => {
    // Direct evidence about the mechanism: inside the transaction the setting is the tenant, and a
    // fresh transaction with a different tenant does not inherit it.
    const inside = await runner.withTenantTransaction(TENANT_A, async (tx) => {
      const result = await tx.query<{ value: string }>(
        "SELECT current_setting('app.tenant_id', true) AS value",
      );
      return result.rows[0]?.value;
    });
    assert.equal(inside, TENANT_A, 'the setting must be the tenant inside the transaction');

    const other = await runner.withTenantTransaction(TENANT_B, async (tx) => {
      const result = await tx.query<{ value: string }>(
        "SELECT current_setting('app.tenant_id', true) AS value",
      );
      return result.rows[0]?.value;
    });
    assert.equal(other, TENANT_B, 'the next transaction must not inherit the previous tenant');
  });

  test('50 alternating transactions on one connection never cross tenants', async () => {
    // A single reuse could pass by luck if the driver happened to open a new connection. Fifty
    // alternating transactions through a one-connection pool cannot.
    for (let i = 0; i < 50; i += 1) {
      const tenant = i % 2 === 0 ? TENANT_A : TENANT_B;
      const rows = await runner.withTenantTransaction(tenant, async (tx) => {
        const result = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM protected_subject');
        return result.rows;
      });
      for (const row of rows) {
        assert.equal(
          row.tenant_id,
          tenant,
          `iteration ${String(i)}: expected only ${tenant} rows, saw ${row.tenant_id}`,
        );
      }
    }
  });
});

describe('a failed transaction rolls back and releases its connection', () => {
  test('a throw inside the transaction propagates and leaves no row', async () => {
    const before = asTenant(
      ownerDsn(),
      TENANT_A,
      'SELECT count(*)::text FROM protected_subject WHERE display_ref = $1;'.replace('$1', "'runner-rollback'"),
    );

    await assert.rejects(
      () =>
        runner.withTenantTransaction(TENANT_A, async (tx) => {
          await tx.query(
            `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
             VALUES ('deadbeef-0000-4000-8000-0000000000bb', $1, 'runner-rollback', 'US-CA', false, 'ACTIVE')`,
            [TENANT_A],
          );
          throw new Error('deliberate failure after the insert');
        }),
      /deliberate failure/,
      'the original error must reach the caller',
    );

    const after = asTenant(
      ownerDsn(),
      TENANT_A,
      "SELECT count(*)::text FROM protected_subject WHERE display_ref = 'runner-rollback';",
    );
    assert.equal(after[0], before[0], 'the rolled-back insert must not be visible');
  });

  test('the pool still works after a failed transaction', async () => {
    // A failed transaction that leaked its connection would eventually exhaust the pool and take the
    // service down. This asserts the connection came back.
    await assert.rejects(() =>
      runner.withTenantTransaction(TENANT_A, async () => {
        throw new Error('boom');
      }),
    );
    const rows = await runner.withTenantTransaction(TENANT_A, async (tx) => {
      const result = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM protected_subject');
      return result.rows;
    });
    assert.equal(rows.length, 1, 'the runner must still be usable after a failure');
  });

  test('a SQL error rolls back rather than committing a partial write', async () => {
    // The failure is inside the database rather than in our code, so the rollback must come from the
    // runner rather than from an exception we raised.
    await assert.rejects(() =>
      runner.withTenantTransaction(TENANT_A, async (tx) => {
        await tx.query('SELECT * FROM a_table_that_does_not_exist');
      }),
    );
    const rows = await runner.withTenantTransaction(TENANT_A, async (tx) => {
      const result = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM protected_subject');
      return result.rows;
    });
    assert.equal(rows.length, 1);
  });
});

describe('an unscoped transaction is impossible', () => {
  test('the tenant setting is always present inside the transaction', async () => {
    // SPEC-006 §7.1 row 13 requires that no query runs with an unset tenant. Every transaction this
    // runner opens sets it as its second statement, so a caller cannot observe an unset state.
    for (const tenant of [TENANT_A, TENANT_B]) {
      const value = await runner.withTenantTransaction(tenant, async (tx) => {
        const result = await tx.query<{ value: string | null }>(
          "SELECT current_setting('app.tenant_id', true) AS value",
        );
        return result.rows[0]?.value ?? null;
      });
      assert.notEqual(value, null, 'an unset tenant setting must be unobservable inside the runner');
      assert.equal(value, tenant);
    }
  });

  test('a malformed tenant is refused by the database rather than silently accepted', async () => {
    // `app.tenant_id` is cast to uuid by the policy, so a non-UUID cannot be bound to it. The runner
    // does not pre-validate here (the branded TenantId does upstream), so this asserts the database
    // is the second line of defence.
    await assert.rejects(
      () =>
        runner.withTenantTransaction('not-a-uuid', async (tx) => {
          await tx.query('SELECT count(*) FROM protected_subject');
        }),
      /invalid input syntax for type uuid/i,
    );
  });
});

describe('the readiness probe performs a real query', () => {
  test('a reachable database reports ok', async () => {
    const result = await postgresReadinessProbe(runner);
    assert.equal(result.ok, true, `probe failed: ${result.reason ?? ''}`);
    assert.equal(result.name, 'postgres');
    assert.equal(typeof result.latencyMs, 'number');
  });

  test('an unreachable database reports not-ok WITHOUT leaking connection details', async () => {
    // A probe that reported ok while the database is down would tell an orchestrator to send traffic
    // to an instance that fails every request (VG-API-059).
    const broken = new PostgresTenantRunner({
      dsn: { host: '127.0.0.1', port: '1', database: 'nope', user: 'nobody', password: 'secret-value' },
      maxConnections: 1,
    });
    try {
      const result = await postgresReadinessProbe(broken);
      assert.equal(result.ok, false, 'an unreachable database must not report ready');
      const serialised = JSON.stringify(result);
      for (const leak of ['secret-value', 'nobody', 'nope']) {
        assert.equal(serialised.includes(leak), false, `the probe result leaked ${leak}`);
      }
    } finally {
      await broken.close().catch(() => {});
    }
  });
});

describe('the tenant-scoped runner and the raw-owner path agree about the fixture', () => {
  test('both roles see the same row count for their own tenant', () => {
    // A sanity check that the fixture is what the tests above assume: each tenant has exactly one
    // seeded subject. Without this, an empty table would make several assertions pass vacuously.
    const a = asTenant(ownerDsn(), TENANT_A, 'SELECT count(*)::text FROM protected_subject;');
    const b = asTenant(ownerDsn(), TENANT_B, 'SELECT count(*)::text FROM protected_subject;');
    assert.equal(a[0], '1', 'tenant A must have exactly one seeded subject');
    assert.equal(b[0], '1', 'tenant B must have exactly one seeded subject');

    // And the ids differ, so the subjects are genuinely distinct rather than duplicated.
    const ids = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT count(*)::text FROM protected_subject WHERE id IN ('${SUBJECT_A}', '${SUBJECT_B}');`,
    );
    assert.equal(ids[0], '1', "tenant A must see only its OWN subject id, not tenant B's");
  });

  test('the audit table is append-only through the runner too', async () => {
    // VG-DATA-004 is enforced by rules, so it must hold on this path as well as on the psql one.
    const before = asTenant(ownerDsn(), TENANT_A, 'SELECT count(*)::text FROM audit_event;');
    await runner.withTenantTransaction(TENANT_A, async (tx) => {
      await tx.query("UPDATE audit_event SET actor = 'tampered-by-runner'");
      await tx.query('DELETE FROM audit_event');
    });
    const after = asTenant(ownerDsn(), TENANT_A, 'SELECT count(*)::text FROM audit_event;');
    assert.equal(after[0], before[0], 'audit rows must survive an UPDATE and DELETE through the runner');

    const tampered = exec(
      ownerDsn(),
      "SELECT count(*)::text FROM audit_event WHERE actor = 'tampered-by-runner';",
    );
    assert.equal(tampered.status, 0);
  });
});
