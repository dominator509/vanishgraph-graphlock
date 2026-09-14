/**
 * The durable idempotency store against real PostgreSQL (SPEC-003 §4.2, VG-ACTION-001).
 *
 * HONEST SCOPE: this suite proves the DURABLE and ATOMIC properties that the in-process double in
 * `tests/contract/idempotency.test.ts` cannot: that a claim survives a process boundary, that the
 * unique constraint — not application logic — arbitrates two simultaneous claims, and that a
 * completed record is replayed after the claiming process is gone.
 *
 * It runs the real `PostgresIdempotencyStore` against real PostgreSQL, so it requires
 * `VG_TEST_DSN_OWNER`. When that is unset the tests FAIL with a harness error rather than skipping,
 * because a skipped concurrency test is indistinguishable from a passing one.
 *
 * `DATABASE_URL` as an ENVIRONMENT VARIABLE is `BLOCKED_CREDENTIALS` (the probe reads the variable,
 * not the running server), so this suite is invoked with the provisioned owner DSN by
 * `gate-data`/`test-integration`, not by the credential-free `gate-api`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { PostgresIdempotencyStore, IDEMPOTENCY_TABLE } from '../../src/adapters/idempotency/postgres-store.ts';
import { TenantId } from '../../src/domain/identifiers.ts';
import { asTenant, exec, ownerDsn } from './harness.ts';
import type { IdempotencyScope } from '../../src/application/contracts/index.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** A distinct key per test, so the shared table never leaks state between them. */
function freshKey(): string {
  return `itest-${randomUUID().replace(/-/g, '')}`.slice(0, 32);
}

function scopeFor(key: string, tenantId = TENANT_A, routeTemplate = '/v1/cases/{caseId}/external-actions'): IdempotencyScope {
  return {
    tenantId: new TenantId(tenantId),
    method: 'POST',
    routeTemplate,
    idempotencyKey: key,
  };
}

const FINGERPRINT_A = 'a'.repeat(64);

function completedRecord(fingerprint = FINGERPRINT_A) {
  return {
    responseStatus: 201,
    responseBody: '{"externalActionId":"xac-1"}',
    fingerprint,
    resourceId: null,
    traceparent: null,
    completedAtMs: Date.now(),
  };
}

describe('the idempotency table exists with the shape the store relies on', () => {
  test('the unique scope constraint is present, because atomicity depends on it', () => {
    // The store's `ON CONFLICT (tenant_id, method, route_template, idempotency_key)` only works
    // because this constraint exists. A missing constraint would make `begin` silently non-atomic
    // rather than fail, so the constraint is asserted rather than assumed.
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT conname FROM pg_constraint
        WHERE conrelid = '${IDEMPOTENCY_TABLE}'::regclass AND contype = 'u';`,
    );
    assert.ok(
      rows.includes('http_idempotency_scope_key'),
      `the scope unique constraint must exist, saw: ${rows.join(', ')}`,
    );
  });

  test('the table is tenant-isolated like every other tenant-scoped table', () => {
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|' ||
              (SELECT count(*) FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = '${IDEMPOTENCY_TABLE}')::text
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = '${IDEMPOTENCY_TABLE}' AND n.nspname = 'public';`,
    );
    assert.deepEqual(rows, ['true|true|1'], 'the store table must be enabled, forced and policied');
  });
});

describe('a claim survives the process that made it', () => {
  test('COMPLETED is replayed by a SECOND store instance', async () => {
    // This is the property the in-memory double cannot show: durability. The second instance shares
    // no memory with the first, so reading the record back proves it was persisted.
    const key = freshKey();
    const scope = scopeFor(key);

    const first = new PostgresIdempotencyStore({ dsn: ownerDsn() });
    assert.deepEqual((await first.begin(scope, FINGERPRINT_A)).state, 'NEW');
    await first.complete(scope, completedRecord());

    const second = new PostgresIdempotencyStore({ dsn: ownerDsn() });
    const outcome = await second.begin(scope, FINGERPRINT_A);
    assert.equal(outcome.state, 'COMPLETED');
    assert.equal(outcome.record?.responseStatus, 201);
    assert.equal(outcome.record?.responseBody, '{"externalActionId":"xac-1"}');
    assert.equal(outcome.record?.fingerprint, FINGERPRINT_A);
  });

  test('a stored body is returned byte-for-byte, not re-serialised', async () => {
    const key = freshKey();
    const scope = scopeFor(key);
    const store = new PostgresIdempotencyStore({ dsn: ownerDsn() });
    const body = '{"z":1,  "a":2}'; // deliberately unusual spacing and key order
    await store.begin(scope, FINGERPRINT_A);
    await store.complete(scope, { ...completedRecord(), responseBody: body });
    const outcome = await store.begin(scope, FINGERPRINT_A);
    assert.equal(outcome.record?.responseBody, body, 'the stored text must be returned verbatim');
  });
});

describe('two simultaneous claims produce exactly one NEW', () => {
  test('a concurrent begin race yields one NEW and one IN_FLIGHT', async () => {
    // THE property the unique constraint exists for. Both calls start before either resolves, so an
    // implementation that read-then-wrote would report NEW twice and both callers would perform the
    // effect — the duplicate certified letter this whole mechanism prevents.
    const key = freshKey();
    const scope = scopeFor(key);
    const store = new PostgresIdempotencyStore({ dsn: ownerDsn() });

    const [left, right] = await Promise.all([
      store.begin(scope, FINGERPRINT_A),
      store.begin(scope, FINGERPRINT_A),
    ]);
    const states = [left.state, right.state].sort();
    assert.deepEqual(states, ['IN_FLIGHT', 'NEW'], `expected exactly one NEW, saw ${states.join(' + ')}`);

    // And the database agrees: exactly one row.
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT count(*)::text FROM ${IDEMPOTENCY_TABLE} WHERE idempotency_key = '${key}';`,
    );
    assert.equal(rows[0], '1', 'a race must not create two rows');
  });

  test('twenty concurrent claims still produce exactly one NEW', async () => {
    // A two-caller race can pass by luck; twenty makes a non-atomic implementation fail reliably.
    const key = freshKey();
    const scope = scopeFor(key);
    const store = new PostgresIdempotencyStore({ dsn: ownerDsn() });

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => store.begin(scope, FINGERPRINT_A)),
    );
    const news = outcomes.filter((o) => o.state === 'NEW').length;
    assert.equal(news, 1, `exactly one caller may claim the key, saw ${news}`);

    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT count(*)::text FROM ${IDEMPOTENCY_TABLE} WHERE idempotency_key = '${key}';`,
    );
    assert.equal(rows[0], '1');
  });
});

describe('abandon releases a pre-effect claim and never a completed one', () => {
  test('abandoning an in-flight key returns it to NEW', async () => {
    // Without this a transient failure would leave the key in flight forever and the caller could
    // never retry.
    const key = freshKey();
    const scope = scopeFor(key);
    const store = new PostgresIdempotencyStore({ dsn: ownerDsn() });
    assert.equal((await store.begin(scope, FINGERPRINT_A)).state, 'NEW');
    await store.abandon(scope);
    assert.equal((await store.begin(scope, FINGERPRINT_A)).state, 'NEW', 'the key must be claimable again');
  });

  test('abandoning a COMPLETED key is a no-op, so a retry cannot re-execute the effect', async () => {
    // The dangerous case: if abandon deleted a completed row, a retry would re-perform an effect that
    // already happened.
    const key = freshKey();
    const scope = scopeFor(key);
    const store = new PostgresIdempotencyStore({ dsn: ownerDsn() });
    await store.begin(scope, FINGERPRINT_A);
    await store.complete(scope, completedRecord());

    await store.abandon(scope);

    const outcome = await store.begin(scope, FINGERPRINT_A);
    assert.equal(outcome.state, 'COMPLETED', 'a completed key must survive an abandon');
    assert.equal(outcome.record?.responseStatus, 201);
  });
});

describe('the scope key separates tenant, method, route and key', () => {
  test('a different ROUTE with the same key is a different scope', async () => {
    const key = freshKey();
    const store = new PostgresIdempotencyStore({ dsn: ownerDsn() });
    const onRouteA = scopeFor(key, TENANT_A, '/v1/cases/{caseId}/external-actions');
    const onRouteB = scopeFor(key, TENANT_A, '/v1/cases/{caseId}/deadlines');

    assert.equal((await store.begin(onRouteA, FINGERPRINT_A)).state, 'NEW');
    await store.complete(onRouteA, completedRecord());
    assert.equal(
      (await store.begin(onRouteB, FINGERPRINT_A)).state,
      'NEW',
      'a different route is a different key scope (SPEC-003 §4.2)',
    );
  });

  test('a different METHOD with the same key is a different scope', async () => {
    const key = freshKey();
    const store = new PostgresIdempotencyStore({ dsn: ownerDsn() });
    assert.equal((await store.begin(scopeFor(key), FINGERPRINT_A)).state, 'NEW');
    await store.complete(scopeFor(key), completedRecord());
    const other = { ...scopeFor(key), method: 'PUT' };
    assert.equal((await store.begin(other, FINGERPRINT_A)).state, 'NEW');
  });

  test('the same key under another tenant is a different scope, and RLS hides the row', async () => {
    const key = freshKey();
    const store = new PostgresIdempotencyStore({ dsn: ownerDsn() });
    assert.equal((await store.begin(scopeFor(key, TENANT_A), FINGERPRINT_A)).state, 'NEW');

    // Tenant B has its own key space, so its claim is NEW rather than IN_FLIGHT.
    assert.equal(
      (await store.begin(scopeFor(key, TENANT_B), FINGERPRINT_A)).state,
      'NEW',
      "another tenant's key must not shadow this one",
    );

    // And RLS means tenant B cannot SEE tenant A's row at all, which is what stops a cross-tenant
    // information leak through the conflict body.
    const asB = asTenant(
      ownerDsn(),
      TENANT_B,
      `SELECT count(*)::text FROM ${IDEMPOTENCY_TABLE} WHERE idempotency_key = '${key}';`,
    );
    assert.equal(asB[0], '1', 'tenant B sees only its own row');
    const asA = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT count(*)::text FROM ${IDEMPOTENCY_TABLE} WHERE idempotency_key = '${key}';`,
    );
    assert.equal(asA[0], '1', 'tenant A sees only its own row');
  });
});

describe('the table refuses a row that would break the replay contract', () => {
  test('a COMPLETED row without a response is refused', () => {
    // Otherwise a replay could return a NULL status as though it were a real answer.
    const attempt = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO ${IDEMPOTENCY_TABLE}
         (tenant_id, method, route_template, idempotency_key, state, fingerprint, expires_at)
       VALUES ('${TENANT_A}', 'POST', '/v1/x', '${freshKey()}', 'COMPLETED', '${FINGERPRINT_A}', now() + interval '1 day');
       COMMIT;`,
    );
    assert.notEqual(attempt.status, 0, 'a COMPLETED row must carry a response');
  });

  test('a fingerprint that is not a SHA-256 hex value is refused', () => {
    const attempt = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO ${IDEMPOTENCY_TABLE}
         (tenant_id, method, route_template, idempotency_key, state, fingerprint, expires_at)
       VALUES ('${TENANT_A}', 'POST', '/v1/x', '${freshKey()}', 'IN_FLIGHT', 'not-a-digest', now() + interval '1 day');
       COMMIT;`,
    );
    assert.notEqual(attempt.status, 0);
  });

  test('a key below the SPEC-003 §4.2 minimum of 16 characters is refused', () => {
    const attempt = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO ${IDEMPOTENCY_TABLE}
         (tenant_id, method, route_template, idempotency_key, state, fingerprint, expires_at)
       VALUES ('${TENANT_A}', 'POST', '/v1/x', 'short', 'IN_FLIGHT', '${FINGERPRINT_A}', now() + interval '1 day');
       COMMIT;`,
    );
    assert.notEqual(attempt.status, 0, 'the table must enforce the same bounds as the boundary');
  });

  test('an impossible response status is refused', () => {
    const attempt = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO ${IDEMPOTENCY_TABLE}
         (tenant_id, method, route_template, idempotency_key, state, fingerprint, response_status, response_body, completed_at, expires_at)
       VALUES ('${TENANT_A}', 'POST', '/v1/x', '${freshKey()}', 'COMPLETED', '${FINGERPRINT_A}', 999, '{}', now(), now() + interval '1 day');
       COMMIT;`,
    );
    assert.notEqual(attempt.status, 0, 'only a real HTTP status may be stored');
  });
});

describe('expiry is recorded so a policy change needs no migration', () => {
  test('a new claim records an expiry about 24 hours out', async () => {
    const key = freshKey();
    const store = new PostgresIdempotencyStore({ dsn: ownerDsn() });
    await store.begin(scopeFor(key), FINGERPRINT_A);
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT round(EXTRACT(EPOCH FROM (expires_at - created_at)) / 3600)::text
         FROM ${IDEMPOTENCY_TABLE} WHERE idempotency_key = '${key}';`,
    );
    assert.equal(rows[0], '24', 'retention defaults to 24 hours');
  });
});
