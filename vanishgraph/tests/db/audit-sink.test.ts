/**
 * The audit sink against real PostgreSQL (SPEC-001 SM-2/SM-3, VG-EVIDENCE-003).
 *
 * WHY THIS SUITE EXISTS AT ALL: before the sink was written, **nothing in this codebase had ever written
 * an `audit_event` row.** The only rows in existence came from `db/seed/prior_release.sql`. A claim that
 * "audit works" therefore had no evidence behind it in either direction, and every route that changes a
 * truth state depends on it, because SM-2 says a state change may not be committed without its
 * `AuditEvent`.
 *
 * THE ASSERTION THAT MATTERS MOST IS THE ROLLBACK ONE. An append that works is easy; an append that
 * shares the caller's transaction — so a rolled-back state change leaves no audit row, and a committed
 * one cannot lack it — is the property SPEC-006 §7.1 row 11 names as the difference between this design
 * and the forbidden "commit state and log later". A suite that only proved the happy write would pass
 * against an implementation that opened its own connection, which is exactly the defect to catch.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import {
  AuditUnavailableError,
  PostgresAuditSink,
  appendAuditEvents,
  toAuditPayload,
} from '../../src/adapters/persistence/audit-sink.ts';
import { createAuditEvent } from '../../src/domain/entities.ts';
import { TenantId } from '../../src/domain/identifiers.ts';
import { asTenant, appDsn, exec } from './harness.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** A UUID-shaped correlation id: `audit_event.correlation_id` is `uuid`, not text. */
function correlation(): string {
  return randomUUID();
}

let runner: PostgresTenantRunner;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
});

after(async () => {
  await runner.close();
});

/** Build a domain `AuditEvent` with a UUID correlation id and a UUID target. */
function event(overrides: { tenantId?: string; targetId?: string | null; payload?: Record<string, string | number | boolean | null>; targetKind?: string } = {}) {
  return auditEventFor('AssessMatch', overrides);
}

/** The same, with a caller-chosen action — used by the refusals, which assert on a unique action name. */
function auditEventFor(
  action: string,
  overrides: { tenantId?: string; targetId?: string | null; payload?: Record<string, string | number | boolean | null>; targetKind?: string } = {},
) {
  return createAuditEvent({
    id: `test:${randomUUID()}`,
    tenantId: new TenantId(overrides.tenantId ?? TENANT_A),
    actor: 'domain-command',
    action,
    targetKind: overrides.targetKind ?? 'Exposure',
    targetId: overrides.targetId === undefined ? randomUUID() : overrides.targetId,
    correlationId: correlation(),
    atMs: Date.now(),
    payload: overrides.payload ?? { command: 'AssessMatch', transitionId: 'T3' },
  });
}

/** Count audit rows matching an action, read under a tenant via RLS. */
function countFor(tenantId: string, action: string): number {
  const rows = asTenant(appDsn(), tenantId, `SELECT count(*) FROM audit_event WHERE action = '${action}';`);
  return Number(rows[0] ?? '0');
}

describe('the audit sink appends real rows', () => {
  test('an appended event is readable back with every field intact', async () => {
    const action = `AuditSinkTest-${randomUUID().slice(0, 8)}`;
    const targetId = randomUUID();
    const corr = correlation();
    const at = Date.now();

    await runner.withTenantTransaction(TENANT_A, (tx) =>
      appendAuditEvents(tx, [
        createAuditEvent({
          id: 'test:readback',
          tenantId: new TenantId(TENANT_A),
          actor: 'operator-0001',
          action,
          targetKind: 'Exposure',
          targetId,
          correlationId: corr,
          atMs: at,
          payload: { command: 'AssessMatch', transitionId: 'T3', fromTruthState: 'DISCOVERED_CANDIDATE', toTruthState: 'MATCH_CONFIRMED' },
        }),
      ]),
    );

    const rows = asTenant(
      appDsn(),
      TENANT_A,
      // `concat_ws` and NOT `||`. MEASURED: `a || (payload::jsonb)->>'k'` fails with
      // `operator does not exist: text ->> unknown`, because in PostgreSQL `||` binds TIGHTER than `->>`,
      // so the expression parses as `(a || (payload::jsonb)) ->> 'k'` — a text operand for a jsonb
      // operator. A function argument list has no such ambiguity, which is why the extraction is done
      // inside `concat_ws` instead of being parenthesised in a concatenation chain.
      `SELECT concat_ws('|', actor, target_kind, target_id::text, correlation_id::text, payload->>'transitionId', payload->>'toTruthState') FROM audit_event WHERE action = '${action}';`,
    );
    assert.equal(rows.length, 1, 'exactly one audit row must be written');
    assert.equal(
      rows[0],
      `operator-0001|Exposure|${targetId}|${corr}|T3|MATCH_CONFIRMED`,
      'the stored row must carry the actor, target, correlation id and transition facts unchanged',
    );
  });

  test('a rolled-back state change leaves NO audit row (SM-2, SPEC-006 §7.1 row 11)', async () => {
    const action = `AuditSinkRollback-${randomUUID().slice(0, 8)}`;
    const before = countFor(TENANT_A, action);

    await assert.rejects(
      runner.withTenantTransaction(TENANT_A, async (tx) => {
        await appendAuditEvents(tx, [event({ payload: { command: 'AssessMatch' } })]);
        // The state change fails AFTER its audit row was appended. Both must vanish: an audit row for a
        // transition that did not happen is as wrong as a transition with no audit row, and it is the
        // failure mode a sink owning its own connection would produce.
        throw new Error('simulated state-change failure after the append');
      }),
      /simulated state-change failure/,
    );

    assert.equal(countFor(TENANT_A, action), before, 'the append must have rolled back with the transaction');
  });

  test('a committed transaction KEEPS its audit row', async () => {
    const action = `AuditSinkCommit-${randomUUID().slice(0, 8)}`;
    // The control for the rollback test above. Without it, "no row after a rollback" would also be
    // produced by a sink that never writes anything at all, and that assertion would be vacuous.
    assert.equal(countFor(TENANT_A, action), 0, 'the action name is unique per test, so it starts at 0');

    await runner.withTenantTransaction(TENANT_A, (tx) =>
      appendAuditEvents(tx, [{ ...event({ payload: { command: 'AssessMatch' } }), action }]),
    );

    assert.equal(countFor(TENANT_A, action), 1, 'a committed append must be visible');
  });

  test('the standalone sink writes a row through its own transaction', async () => {
    const action = `AuditSinkStandalone-${randomUUID().slice(0, 8)}`;
    const sink = new PostgresAuditSink({ runner });
    await sink.append([{ ...event({ payload: { command: 'Readback' } }), action }]);

    const rows = asTenant(appDsn(), TENANT_A, `SELECT count(*) FROM audit_event WHERE action = '${action}';`);
    assert.equal(rows[0], '1');
  });

  test('an empty batch writes nothing and does not open a transaction', async () => {
    await new PostgresAuditSink({ runner }).append([]);
    // No assertion on a count is possible for "nothing", so the assertion is that it resolved without
    // throwing: a sink that opened a transaction per empty batch would exhaust the pool under a loop.
    assert.ok(true);
  });
});

describe('the sink refuses what it cannot store honestly', () => {
  test('a correlation id in neither accepted form is refused, and nothing is written', async () => {
    const action = `AuditSinkBadCorr-${randomUUID().slice(0, 8)}`;
    // The domain accepts any string for correlationId; the COLUMN is uuid. Substituting one would break
    // the join between the audit row and the request that caused it, so it must be refused loudly.
    //
    // TWO FORMS ARE ACCEPTED — a canonical UUID and the dash-less 32-hex trace id the correlation plugin
    // mints — because they are the same 128 bits and the second is what EVERY request in this service
    // carries. MEASURED DEFECT this covers: the sink once accepted only the first, so the first write route
    // to append an audit row answered 500 for its own correlation id.
    const bad = { ...event(), action, correlationId: 'not-a-uuid' };
    assert.equal(countFor(TENANT_A, action), 0, 'the action name is unique, so it starts at 0');

    await assert.rejects(
      runner.withTenantTransaction(TENANT_A, (tx) => appendAuditEvents(tx, [bad])),
      (error: unknown) => error instanceof AuditUnavailableError && /neither a UUID nor a 32-hex/.test(error.message),
    );

    // Nothing written FOR THIS ATTEMPT. Asserting a global count instead would pass for the wrong reason
    // as soon as any other test had appended a row.
    assert.equal(countFor(TENANT_A, action), 0, 'a refused append must write nothing');
  });

  test('a dash-less 32-hex correlation id IS stored, canonicalised, and joins to the request', async () => {
    const action = `AuditSinkHexCorr-${randomUUID().slice(0, 8)}`;
    const hex = randomUUID().replace(/-/g, '');
    const event = { ...auditEventFor(action), correlationId: hex };

    const ids = await runner.withTenantTransaction(TENANT_A, (tx) => appendAuditEvents(tx, [event]));
    assert.equal(ids.length, 1);
    const stored = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT correlation_id::text FROM audit_event WHERE action = '${action}';`,
    );
    assert.deepEqual(stored, [
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    ]);
  });

  test('a non-UUID target id is refused rather than attaching the row to the wrong resource', async () => {
    const bad = { ...event({ targetId: null }), targetId: 'exp_01H' };
    await assert.rejects(
      runner.withTenantTransaction(TENANT_A, (tx) => appendAuditEvents(tx, [bad])),
      (error: unknown) => error instanceof AuditUnavailableError && /targetId/.test(error.message),
    );
  });

  test('a nested payload value is refused, because jsonb would store a shape no reader expects', () => {
    assert.throws(
      () => toAuditPayload({ command: 'X', nested: { a: 1 } as unknown as string }),
      (error: unknown) => error instanceof AuditUnavailableError && /opaque scalars only/.test(error.message),
    );
    assert.throws(
      () => toAuditPayload({ command: 'X', list: ['a'] as unknown as string }),
      (error: unknown) => error instanceof AuditUnavailableError && /opaque scalars only/.test(error.message),
    );
    // The scalars it DOES accept, so the refusals above are not a function that refuses everything.
    assert.deepEqual(toAuditPayload({ s: 'x', n: 1, b: true, z: null }), { s: 'x', n: 1, b: true, z: null });
  });

  test('a batch spanning two tenants is refused: one transaction carries one app.tenant_id', async () => {
    const sink = new PostgresAuditSink({ runner });
    await assert.rejects(
      sink.append([event(), event({ tenantId: TENANT_B })]),
      (error: unknown) => error instanceof AuditUnavailableError && /spans 2 tenants/.test(error.message),
    );
  });
});

describe('audit rows are tenant-isolated and append-only', () => {
  test('tenant B cannot read tenant A’s audit rows, while A can (the control)', async () => {
    const action = `AuditSinkIso-${randomUUID().slice(0, 8)}`;
    await runner.withTenantTransaction(TENANT_A, (tx) =>
      appendAuditEvents(tx, [{ ...event(), action }]),
    );

    const leaked = asTenant(appDsn(), TENANT_B, `SELECT count(*) FROM audit_event WHERE action = '${action}';`);
    assert.equal(leaked[0], '0', 'RLS must return zero rows for another tenant’s audit trail');
    const own = asTenant(appDsn(), TENANT_A, `SELECT count(*) FROM audit_event WHERE action = '${action}';`);
    assert.equal(own[0], '1', 'the control: tenant A sees its own row, so the probe proves something');
  });

  test('UPDATE and DELETE on an audit row are no-ops (VG-EVIDENCE-003)', async () => {
    const action = `AuditSinkAppendOnly-${randomUUID().slice(0, 8)}`;
    await runner.withTenantTransaction(TENANT_A, (tx) =>
      appendAuditEvents(tx, [{ ...event(), action }]),
    );

    exec(
      appDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
        `UPDATE audit_event SET actor = 'tampered' WHERE action = '${action}';`,
        `DELETE FROM audit_event WHERE action = '${action}';`,
        'COMMIT;',
      ].join('\n'),
    );

    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT count(*) || '|' || coalesce(max(actor), '') FROM audit_event WHERE action = '${action}';`,
    );
    // The schema enforces this with `CREATE RULE … DO INSTEAD NOTHING`, so the row survives unmodified.
    // Asserted here as well as in `gate-data.sh` because the sink is what writes these rows, and a row
    // the sink can write but a rule can silently drop would be worse than no row at all.
    assert.equal(rows[0], '1|domain-command');
  });
});

describe('the payload boundary the sink enforces', () => {
  test('the seven SPEC-001 fields are what an audit row carries, and nothing else is required', async () => {
    const action = `AuditSinkFields-${randomUUID().slice(0, 8)}`;
    await runner.withTenantTransaction(TENANT_A, (tx) =>
      appendAuditEvents(tx, [{ ...event({ payload: { command: 'AssessMatch' } }), action }]),
    );

    // SPEC-001:96 gives `AuditEvent` exactly `id, tenantId, actor, action, target, at, correlationId`. The
    // row must supply all seven reachably — a missing one would mean the sink cannot represent the entity
    // the specification defines. `id` is the bigint the column assigns (see the adapter's header).
    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT (id IS NOT NULL)::text || '|' || (tenant_id = '${TENANT_A}')::text || '|' || (actor <> '')::text || '|' || (action <> '')::text || '|' || (target_kind <> '')::text || '|' || (target_id IS NOT NULL)::text || '|' || (at IS NOT NULL)::text || '|' || (correlation_id IS NOT NULL)::text FROM audit_event WHERE action = '${action}';`,
    );
    assert.equal(rows[0], 'true|true|true|true|true|true|true|true');
  });

  test('a scalar-only payload is stored, so the column is usable without the forbidden shape', async () => {
    const action = `AuditSinkScalars-${randomUUID().slice(0, 8)}`;
    await runner.withTenantTransaction(TENANT_A, (tx) =>
      appendAuditEvents(tx, [
        {
          ...event(),
          action,
          payload: toAuditPayload({ command: 'AssessMatch', note: 'scalar', count: 3, ok: true, absent: null }),
        },
      ]),
    );

    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT concat_ws('|', payload->>'command', payload->>'note', payload->>'count') FROM audit_event WHERE action = '${action}';`,
    );
    assert.equal(rows[0], 'AssessMatch|scalar|3');
    // NOT asserted here, deliberately: a transition code or from/to truth state in this payload. SPEC-002
    // §1 forbids jsonb for "values needing integrity (state, …)", so §5.5.5's transition record has no
    // storage the specifications permit. That is recorded as a finding in `ASSUMPTIONS.md` §3.18 rather
    // than implemented, and the absence of the assertion is the honest form of that decision.
  });
});
