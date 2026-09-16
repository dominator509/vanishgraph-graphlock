/**
 * The audit stream against real PostgreSQL (SPEC-003 §5.15, VG-EVIDENCE-003).
 *
 * EVERY assertion runs through the real HTTP boundary, the real `PostgresAuditQueries` read model and the real
 * audit sink as the writer. The credential-free half (`tests/contract/audit-routes.test.ts`) proves the
 * structural properties — no mutation surface, the two time-range refusals — and can prove nothing about the
 * rows.
 *
 * WHAT THIS SUITE PROVES:
 *
 *   * An event the sink writes is readable back through §5.15.1 with its actor kind, outcome, request id,
 *     refusal code and trace context intact — the five fields migration 0017 added, which SPEC-001's
 *     `AuditEvent` does not have and the append path supplies as REQUEST metadata.
 *   * The two column DEFAULTs are what a metadata-less append records, so "SERVICE/SUCCEEDED" is a stored
 *     fact for the domain-command actor rather than a value the read model invents.
 *   * The time range BOUNDS the result: an event inside it is returned and an event outside it is not. Without
 *     that control the range predicate could be absent and every other assertion would still pass.
 *   * Each filter narrows the result, and pagination walks a range without repeating or skipping a row —
 *     which for an audit trail means an auditor sees every event exactly once.
 *   * RLS isolates the stream, and a cross-tenant read is 404 rather than 403.
 *
 * FIXTURE DISCIPLINE. Every test appends events whose `action` carries a per-run suffix, so a filter on that
 * action can only ever match rows the test itself wrote — the shared-table lesson from `ASSUMPTIONS.md` §3.24.
 * Nothing is deleted: the audit stream is append-only, and a test that removed its own rows would be
 * demonstrating a capability the API deliberately does not have.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresAuditQueries } from '../../src/adapters/persistence/audit-queries.ts';
import { PostgresObservationQueries } from '../../src/adapters/persistence/observations.ts';
import { PostgresExposureQueries } from '../../src/adapters/persistence/exposures.ts';
import { PostgresTransitionQueries } from '../../src/adapters/persistence/transitions.ts';
import { PostgresCaseQueries } from '../../src/adapters/persistence/cases.ts';
import { PostgresControllerResponseQueries } from '../../src/adapters/persistence/controller-responses.ts';
import { PostgresActionQueries } from '../../src/adapters/persistence/actions.ts';
import { PostgresPolicyQueries } from '../../src/adapters/persistence/policies.ts';
import { PostgresCoverageQueries } from '../../src/adapters/persistence/coverage.ts';
import { appendAuditEvents } from '../../src/adapters/persistence/audit-sink.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresSourceQueries } from '../../src/adapters/persistence/sources.ts';
import { PostgresAppealQueries } from '../../src/adapters/persistence/appeals.ts';
import { PostgresDeadlineQueries } from '../../src/adapters/persistence/deadlines.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { createAuditEvent } from '../../src/domain/entities.ts';
import { TenantId } from '../../src/domain/identifiers.ts';
import { appDsn } from './harness.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** A per-run action suffix, so every filter below can only match rows this run wrote. */
const RUN = randomUUID().slice(0, 8);
const action = (name: string): string => `AuditTest-${name}-${RUN}`;

/** A one-day window wide enough for the events this suite writes, in the past so it cannot drift. */
const FROM = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const TO = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const RANGE = `from=${FROM}&to=${TO}`;

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
});

after(async () => {
  await runner.close();
});

function serverFor(tenantId: string, scopes: readonly string[] = ['vg.audit.read']): VgFastify {
  return buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({ tenantId, scopes }),
    tenancy: { runner },
    idempotency: {
      store: idempotency,
      requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
    },
    sessionSecret: TEST_SESSION_SECRET,
    subjectQueries: new PostgresSubjectQueries(),
    sourceQueries: new PostgresSourceQueries(),
    recipeVerificationKeys: { publicKeysByRef: new Map<string, string>() },
    appealQueries: new PostgresAppealQueries(),
    deadlineQueries: new PostgresDeadlineQueries(),
    auditQueries: new PostgresAuditQueries(),
    observationQueries: new PostgresObservationQueries(),
    exposureQueries: new PostgresExposureQueries(),
    transitionQueries: new PostgresTransitionQueries(),
    caseQueries: new PostgresCaseQueries({ recipeVerificationKeys: { publicKeysByRef: new Map() } }),
    controllerResponseQueries: new PostgresControllerResponseQueries(),
    actionQueries: new PostgresActionQueries({ recipeVerificationKeys: { publicKeysByRef: new Map() } }),
    policyQueries: new PostgresPolicyQueries(),
    coverageQueries: new PostgresCoverageQueries(),
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
  });
}

/** Append one audit event through the sink, which is the only writer of the stream. */
async function append(
  options: {
    tenantId?: string;
    action: string;
    targetId?: string | null;
    targetKind?: string;
    actor?: string;
    atMs?: number;
    correlationId?: string;
    metadata?: Parameters<typeof appendAuditEvents>[2];
  },
): Promise<{ correlationId: string }> {
  const correlationId = options.correlationId ?? randomUUID();
  const tenantId = options.tenantId ?? TENANT_A;
  await runner.withTenantTransaction(tenantId, (tx) =>
    appendAuditEvents(
      tx,
      [
        createAuditEvent({
          id: `test:${randomUUID()}`,
          tenantId: new TenantId(tenantId),
          actor: options.actor ?? 'domain-command',
          action: options.action,
          targetKind: options.targetKind ?? 'RequestCase',
          targetId: options.targetId === undefined ? randomUUID() : options.targetId,
          correlationId,
          atMs: options.atMs ?? Date.now(),
          payload: { command: 'ExecuteAction' },
        }),
      ],
      options.metadata ?? {},
    ),
  );
  return { correlationId };
}

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

async function get(app: VgFastify, url: string): Promise<Injected> {
  const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.statusCode, json, headers: response.headers as Record<string, unknown> };
}

function rows(response: Injected): Record<string, unknown>[] {
  assert.equal(response.status, 200, `expected 200, got ${JSON.stringify(response.json)}`);
  return (response.json['data'] ?? []) as Record<string, unknown>[];
}

describe('§5.15.1 reads what the sink wrote, including the observability fields', () => {
  test('actor kind, outcome, request id, refusal code and traceparent round-trip', async () => {
    const name = action('round-trip');
    const requestId = randomUUID();
    const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    const { correlationId } = await append({
      action: name,
      metadata: {
        actorKind: 'HUMAN',
        outcome: 'REFUSED',
        requestId,
        refusalCode: 'ILLEGAL_TRANSITION',
        traceparent,
      },
    });

    const app = serverFor(TENANT_A);
    const listed = rows(await get(app, `/v1/audit-events?${RANGE}&action=${name}`));
    assert.equal(listed.length, 1, 'the appended event must be listed');
    const row = listed[0] ?? {};

    assert.deepEqual(row['actor'], { kind: 'HUMAN', actorId: 'domain-command' });
    assert.equal(row['outcome'], 'REFUSED');
    assert.equal(row['requestId'], requestId);
    assert.equal(row['refusalCode'], 'ILLEGAL_TRANSITION');
    assert.equal(row['traceparent'], traceparent);
    assert.equal(row['correlationId'], correlationId);
    assert.equal(row['action'], name);
    // `auditEventId` is the bigint row id as a decimal string — see the port's note on why it is not a UUID.
    assert.match(String(row['auditEventId']), /^[0-9]+$/);
    await app.close();
  });

  test('a metadata-less append stores the column defaults, so SERVICE/SUCCEEDED is a stored fact', async () => {
    const name = action('defaults');
    await append({ action: name });

    const app = serverFor(TENANT_A);
    const row = rows(await get(app, `/v1/audit-events?${RANGE}&action=${name}`))[0] ?? {};
    // The five columns were added with `NOT NULL DEFAULT` values, and the INSERT uses `coalesce($n, …)` so an
    // unsupplied metadata field falls back to the DEFAULT rather than writing NULL into a NOT NULL column.
    // Asserted because the alternative — the read model inventing SERVICE — would look identical from outside.
    assert.deepEqual(row['actor'], { kind: 'SERVICE', actorId: 'domain-command' });
    assert.equal(row['outcome'], 'SUCCEEDED');
    assert.equal(row['requestId'], null);
    assert.equal(row['refusalCode'], null);
    assert.equal(row['traceparent'], null);
    await app.close();
  });

  test('§5.15.2 returns one event, and 404s for an absent id', async () => {
    const name = action('detail');
    await append({ action: name });

    const app = serverFor(TENANT_A);
    const listed = rows(await get(app, `/v1/audit-events?${RANGE}&action=${name}`));
    const id = String(listed[0]?.['auditEventId']);

    const detail = await get(app, `/v1/audit-events/${id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    assert.equal(detail.json['auditEventId'], id);
    assert.equal(detail.json['action'], name);

    const absent = await get(app, '/v1/audit-events/999999999');
    assert.equal(absent.status, 404);
    await app.close();
  });
});

describe('the time range BOUNDS the result', () => {
  test('an event inside the range is returned and one outside it is not', async () => {
    const insideAction = action('inside');
    const outsideAction = action('outside');
    // Two hours ago, which is outside the ±1h window this suite queries.
    const outsideAtMs = Date.now() - 2 * 60 * 60 * 1000;

    await append({ action: insideAction });
    await append({ action: outsideAction, atMs: outsideAtMs });

    const app = serverFor(TENANT_A);
    // Same action filter, same range: the ONLY difference between the two queries is the instant.
    const inside = rows(await get(app, `/v1/audit-events?${RANGE}&action=${insideAction}`));
    const outside = rows(await get(app, `/v1/audit-events?${RANGE}&action=${outsideAction}`));

    assert.equal(inside.length, 1, 'the event inside the range must be returned');
    // THE CONTROL. Without it, a read model that ignored the range entirely would pass the assertion above and
    // an unbounded audit scan would be indistinguishable from a bounded one.
    assert.equal(outside.length, 0, 'the event outside the range must NOT be returned');

    // And the same event IS found when the range covers it, so the zero above is about the range and not about
    // the row being unreadable.
    const wide = `from=${new Date(outsideAtMs - 60_000).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}`;
    assert.equal(rows(await get(app, `/v1/audit-events?${wide}&action=${outsideAction}`)).length, 1);
    await app.close();
  });
});

describe('the filters narrow the stream', () => {
  test('action, actor, targetKind, targetId and correlationId each select the right row', async () => {
    const name = action('filters');
    const targetId = randomUUID();
    const { correlationId } = await append({
      action: name,
      targetId,
      targetKind: 'Exposure',
      actor: 'operator-0007',
    });
    const app = serverFor(TENANT_A);

    const byAction = rows(await get(app, `/v1/audit-events?${RANGE}&action=${name}`));
    assert.equal(byAction.length, 1);

    for (const [label, query] of [
      ['actor', `actor=operator-0007&action=${name}`],
      ['targetKind', `targetKind=Exposure&action=${name}`],
      ['targetId', `targetId=${targetId}&action=${name}`],
      ['correlationId', `correlationId=${correlationId}`],
    ] as const) {
      const matched = rows(await get(app, `/v1/audit-events?${RANGE}&${query}`));
      assert.equal(matched.length, 1, `${label} must select the row`);
      assert.equal(matched[0]?.['action'], name, `${label} selected the wrong row`);
    }

    // A filter that matches nothing returns nothing rather than being ignored: a filter silently dropped is a
    // result set wider than the caller asked for.
    const none = rows(await get(app, `/v1/audit-events?${RANGE}&actor=nobody-at-all`));
    assert.equal(none.length, 0);
    await app.close();
  });

  test('action accepts a comma-separated list, and an unknown targetKind matches nothing', async () => {
    const first = action('multi-a');
    const second = action('multi-b');
    await append({ action: first });
    await append({ action: second });

    const app = serverFor(TENANT_A);
    const both = rows(await get(app, `/v1/audit-events?${RANGE}&action=${first},${second}`));
    assert.equal(both.length, 2, 'a multi-valued action filter must match either value');
    const actions = both.map((r) => r['action']).sort();
    assert.deepEqual(actions, [first, second].sort());

    assert.equal(rows(await get(app, `/v1/audit-events?${RANGE}&targetKind=NoSuchKind-${RUN}`)).length, 0);
    await app.close();
  });
});

describe('pagination walks the stream without repeating or skipping', () => {
  test('a limit of 1 over a one-instant range returns each row exactly once', async () => {
    const prefix = action('paged');
    // Five events sharing ONE instant, which is the case the id tiebreaker exists for: without it a page
    // boundary between equal instants repeats or skips a row.
    const atMs = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await append({ action: `${prefix}-${String(i)}`, atMs });
    }

    const app = serverFor(TENANT_A);
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = `/v1/audit-events?${RANGE}&action=${prefix}-0,${prefix}-1,${prefix}-2,${prefix}-3,${prefix}-4&sort=at:asc&limit=1${
        cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
      }`;
      const response = await get(app, url);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      const page = response.json['page'] as Record<string, unknown>;
      for (const row of (response.json['data'] ?? []) as Record<string, unknown>[]) {
        const id = String(row['auditEventId']);
        assert.equal(seen.has(id), false, `row ${id} was returned twice`);
        seen.add(id);
      }
      cursor = page['nextCursor'] === null ? null : String(page['nextCursor']);
      pages += 1;
      assert.ok(pages <= 10, 'pagination must terminate');
    } while (cursor !== null);

    assert.equal(seen.size, 5, 'every event the suite wrote must be seen exactly once');
    await app.close();
  });
});

describe('the stream is tenant-isolated', () => {
  test('tenant B cannot read tenant A’s events, while A can (the control)', async () => {
    const name = action('isolation');
    await append({ action: name });

    const appA = serverFor(TENANT_A);
    assert.equal(rows(await get(appA, `/v1/audit-events?${RANGE}&action=${name}`)).length, 1, 'the control');
    await appA.close();

    const appB = serverFor(TENANT_B);
    // The audit stream is the one collection where a leak is unthinkable: it records what a tenant did. RLS is
    // the control, and the empty result is the assertion.
    assert.equal(rows(await get(appB, `/v1/audit-events?${RANGE}&action=${name}`)).length, 0);
    await appB.close();
  });

  test('a cross-tenant detail read is 404, indistinguishable from an absent id', async () => {
    const name = action('cross-detail');
    await append({ action: name });

    const appA = serverFor(TENANT_A);
    const id = String(rows(await get(appA, `/v1/audit-events?${RANGE}&action=${name}`))[0]?.['auditEventId']);
    await appA.close();

    const appB = serverFor(TENANT_B);
    const other = await get(appB, `/v1/audit-events/${id}`);
    const absent = await get(appB, '/v1/audit-events/999999999');
    assert.equal(other.status, 404, 'another tenant’s event must not be readable');
    assert.equal(absent.status, 404);
    // Compared on the parts a prober can learn from; the correlation fields are per-request by construction
    // (VG-OBS-001), so no two responses are byte-identical (SPEC-006 H-9).
    const outcome = (res: Injected): Record<string, unknown> => {
      const error = res.json['error'] as Record<string, unknown>;
      return { status: res.status, code: error['code'], message: error['message'], retryable: error['retryable'] };
    };
    assert.deepEqual(outcome(other), outcome(absent));
    await appB.close();
  });
});
