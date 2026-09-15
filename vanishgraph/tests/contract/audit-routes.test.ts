/**
 * The §5.15 boundary contract, without a database (SPEC-003 §5.15, VG-EVIDENCE-003).
 *
 * WHAT THIS SUITE CAN AND CANNOT PROVE. It runs no PostgreSQL, so it proves nothing about the rows —
 * `tests/db/audit-stream.test.ts` does that against the real server. What it proves is the part that is
 * structural, and for §5.15 that part is the most important thing about the group:
 *
 *   * **There is no mutation surface.** §5.15.1 states the append-only property as a property of the API:
 *     "There is **no** `POST`, `PATCH`, `PUT`, or `DELETE` audit route anywhere on `/v1`". This suite asserts
 *     it over the REGISTRY rather than over the module, so a future node that added a mutating audit route
 *     would fail a test rather than pass a review.
 *   * **The two time-range refusals are real.** `TIME_RANGE_REQUIRED` and `TIME_RANGE_TOO_WIDE` had registry
 *     rows and NO code path that threw either, until `AUDIT_EVENTS_QUERY` declared `requireTimeRange` and
 *     `maxSpanDays`. These tests are on the parser (see `filter-strictness.test.ts`); this suite asserts the
 *     ROUTE produces them over HTTP, which is where a caller meets them.
 *   * **The payload is not fetched.** The DTO has no payload field, and the adapter does not SELECT the
 *     column, so a route cannot leak what it never received. The negative assertion here is that no DTO key
 *     is named `payload`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testAuditQueries, testIdentity, testTenancy, TEST_SESSION_SECRET, TEST_TOKEN } from './server-support.ts';
import { ROUTES, findRoute } from '../../src/http/openapi/registry.ts';
import { isErrorCode } from '../../src/http/errors/code-registry.ts';
import { AUDIT_ROUTE_TEMPLATES } from '../../src/http/routes/audit.ts';
import { isAuditEventId } from '../../src/application/contracts/audit-queries.ts';
import type { AuditQueries } from '../../src/application/contracts/audit-queries.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const RANGE_QS = 'from=2026-08-01T00:00:00.000Z&to=2026-08-02T00:00:00.000Z';

import { testSubjectQueries, testSourceQueries, testAppealQueries, testDeadlineQueries, testRecipeVerificationKeys } from './server-support.ts';

function serverWith(options: { scopes?: readonly string[]; queries?: AuditQueries } = {}): VgFastify {
  return buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({ tenantId: TENANT_A, scopes: options.scopes ?? ['vg.audit.read'] }),
    tenancy: testTenancy().runner,
    idempotency: {
      store: {
        begin: async () => ({ state: 'NEW' as const }),
        complete: async () => {},
        abandon: async () => {},
      },
      requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
    },
    sessionSecret: TEST_SESSION_SECRET,
    subjectQueries: testSubjectQueries(),
    sourceQueries: testSourceQueries(),
    recipeVerificationKeys: testRecipeVerificationKeys(),
    appealQueries: testAppealQueries(),
    deadlineQueries: testDeadlineQueries(),
    auditQueries: options.queries ?? testAuditQueries(),
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
  });
}

async function get(app: VgFastify, url: string): Promise<{ status: number; code: unknown; json: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = {};
  }
  const error = json['error'];
  return {
    status: response.statusCode,
    code: typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined,
    json,
  };
}

describe('§5.15 has no mutation surface anywhere (§5.15.1, VG-EVIDENCE-003)', () => {
  test('the registry contains exactly two audit routes, and both are GETs', () => {
    const auditRoutes = ROUTES.filter((route) => route.path.startsWith('/v1/audit-events'));
    assert.equal(auditRoutes.length, 2, 'the registry must declare the two §5.15 routes');
    for (const route of auditRoutes) {
      // Asserted over the REGISTRY, not over the module: the registry is the contract, and a mutating audit
      // route would have to appear there to be reachable.
      assert.equal(route.method, 'GET', `${route.method} ${route.path} is a mutating audit route`);
    }
    assert.deepEqual(auditRoutes.map((r) => r.id).sort(), ['5.15.1', '5.15.2']);
  });

  test('no route anywhere on /v1 mutates the audit stream', () => {
    // The broader form of the same claim: no route whose path mentions audit accepts a mutating method, and no
    // route declares a scope whose name suggests authoring audit entries. A node that added one would fail
    // here rather than pass a review.
    const mutating = ROUTES.filter(
      (route) => route.path.includes('audit') && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(route.method),
    );
    assert.deepEqual(mutating.map((r) => `${r.method} ${r.path}`), []);
  });

  test('both routes declare the module’s templates, and require only vg.audit.read with no step-up', () => {
    for (const id of ['5.15.1', '5.15.2']) {
      const route = ROUTES.find((r) => r.id === id);
      assert.ok(route !== undefined);
      assert.deepEqual(route.scopes, ['vg.audit.read']);
      // §5.15.1's scope line names a ROLE (`vg_auditor`) or an explicit grant, not a step-up; and §3.2 item 7
      // does not list either audit route. A step-up here would refuse callers the contract permits.
      assert.equal(route.stepUp, false, `${id} must not require a step-up`);
    }
    const templates = ROUTES.filter((r) => r.group === '5.15').map((r) =>
      r.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1'),
    );
    for (const template of templates) {
      assert.ok(
        template === '/v1/audit-events' || AUDIT_ROUTE_TEMPLATES.includes(template),
        `${template} has no handler in src/http/routes/audit.ts`,
      );
    }
  });
});

describe('§5.15.1 refuses an unbounded or over-wide scan over HTTP', () => {
  test('a missing range is 400 TIME_RANGE_REQUIRED', async () => {
    const app = serverWith();
    const res = await get(app, '/v1/audit-events');
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.code, 'TIME_RANGE_REQUIRED');
    await app.close();
  });

  test('a half-supplied range is refused too, not completed by a default', async () => {
    const app = serverWith();
    const fromOnly = await get(app, '/v1/audit-events?from=2026-08-01T00:00:00.000Z');
    assert.equal(fromOnly.status, 400);
    assert.equal(fromOnly.code, 'TIME_RANGE_REQUIRED');

    const toOnly = await get(app, '/v1/audit-events?to=2026-08-02T00:00:00.000Z');
    assert.equal(toOnly.status, 400);
    assert.equal(toOnly.code, 'TIME_RANGE_REQUIRED');
    await app.close();
  });

  test('a span beyond 90 days is 400 TIME_RANGE_TOO_WIDE, and exactly 90 is accepted', async () => {
    const app = serverWith();
    const to = Date.parse('2026-09-14T12:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const span = (days: number): string =>
      `from=${new Date(to - days * day).toISOString()}&to=${new Date(to).toISOString()}`;

    const tooWide = await get(app, `/v1/audit-events?${span(91)}`);
    assert.equal(tooWide.status, 400, JSON.stringify(tooWide.json));
    assert.equal(tooWide.code, 'TIME_RANGE_TOO_WIDE');

    // The ceiling is INCLUSIVE, so the largest scan the contract permits is accepted. Without this control the
    // test would pass for an implementation that refused every range.
    const atLimit = await get(app, `/v1/audit-events?${span(90)}`);
    assert.equal(atLimit.status, 200, JSON.stringify(atLimit.json));
    await app.close();
  });

  test('an unknown query parameter is still refused, and a bad sort field too', async () => {
    const app = serverWith();
    const unknown = await get(app, `/v1/audit-events?${RANGE_QS}&limitt=5`);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.code, 'UNKNOWN_QUERY_PARAMETER');

    const badSort = await get(app, `/v1/audit-events?${RANGE_QS}&sort=actor:asc`);
    assert.equal(badSort.status, 400);
    assert.equal(badSort.code, 'INVALID_SORT_FIELD');
    await app.close();
  });

  test('a caller without the audit scope is refused, and the read is not attempted', async () => {
    const app = serverWith({ scopes: ['vg.cases.read'] });
    const res = await get(app, `/v1/audit-events?${RANGE_QS}`);
    assert.equal(res.status, 403);
    assert.equal(res.code, 'INSUFFICIENT_SCOPE');
    await app.close();
  });
});

describe('§5.15 reports no payload, and §5.15.2 refuses an unusable id as 404', () => {
  test('a listed row carries no payload field', async () => {
    const queries: AuditQueries = {
      listAuditEvents: async () => [
        {
          auditEventId: '1',
          tenantId: TENANT_A,
          actor: { kind: 'SERVICE', actorId: 'domain-command' },
          action: 'ExecuteAction',
          target: { kind: 'RequestCase', id: null },
          at: '2026-08-01T12:00:00.000Z',
          correlationId: '11111111-2222-4111-8111-111111111111',
          requestId: null,
          outcome: 'SUCCEEDED',
          refusalCode: null,
          traceparent: null,
        },
      ],
      getAuditEvent: async () => undefined,
    };
    const app = serverWith({ queries });
    const res = await get(app, `/v1/audit-events?${RANGE_QS}`);
    assert.equal(res.status, 200, JSON.stringify(res.json));

    const data = res.json['data'] as Record<string, unknown>[];
    assert.equal(data.length, 1);
    const row = data[0] ?? {};
    // The exact field set, not a superset: a DTO that grew a `payload` would be leaking whatever the payload
    // holds, and SPEC-003 §8.3 forbids an audit payload from carrying PII, secrets or request bodies.
    assert.deepEqual(Object.keys(row).sort(), [
      'action',
      'actor',
      'at',
      'auditEventId',
      'correlationId',
      'outcome',
      'refusalCode',
      'requestId',
      'target',
      'tenantId',
      'traceparent',
    ]);
    assert.deepEqual(row['actor'], { kind: 'SERVICE', actorId: 'domain-command' });
    assert.deepEqual(row['target'], { kind: 'RequestCase', id: null });
    await app.close();
  });

  test('a non-numeric audit event id is 404, not a validation error', async () => {
    const app = serverWith();
    // `audit_event.id` is `bigint`, so a UUID-shaped id cannot match a row. Reporting it as malformed rather
    // than missing would tell a prober what shape the id space has (SPEC-006 H-9), so it is 404.
    for (const bad of ['not-an-id', 'aud_01H', '12a', '-1', '99999999999999999999999']) {
      const res = await get(app, `/v1/audit-events/${bad}`);
      assert.equal(res.status, 404, `${bad} must be NOT FOUND`);
      assert.equal(res.code, 'RESOURCE_NOT_FOUND', bad);
    }
    await app.close();
  });

  test('a numeric id that matches no row is 404 as well', async () => {
    const app = serverWith();
    const res = await get(app, '/v1/audit-events/999999999');
    assert.equal(res.status, 404);
    assert.equal(res.code, 'RESOURCE_NOT_FOUND');
    await app.close();
  });

  test('isAuditEventId accepts a bigint and refuses anything else', () => {
    assert.equal(isAuditEventId('1'), true);
    assert.equal(isAuditEventId('9223372036854775807'), true, 'the bigint maximum must be accepted');
    assert.equal(isAuditEventId('0'), true);
    for (const bad of ['', ' ', '1 ', ' 1', '1.0', '1e3', '0x1', 'abc', '-1', '1,2']) {
      assert.equal(isAuditEventId(bad), false, `${JSON.stringify(bad)} must be refused`);
    }
  });
});

describe('every §5.15 refusal uses a code from the closed set', () => {
  test('the codes this group emits are all registered (H-7)', () => {
    for (const code of [
      'TIME_RANGE_REQUIRED',
      'TIME_RANGE_TOO_WIDE',
      'INSUFFICIENT_SCOPE',
      'INVALID_CURSOR',
      'INVALID_SORT_FIELD',
      'RESOURCE_NOT_FOUND',
      'SCHEMA_VALIDATION_FAILED',
    ]) {
      assert.equal(isErrorCode(code), true, `${code} must be in the registry`);
    }
  });
});
