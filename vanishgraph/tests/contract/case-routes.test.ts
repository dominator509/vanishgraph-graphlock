/**
 * The §5.7 boundary rules, credential-free (SPEC-003 §5.7, §2.6, §3.2).
 *
 * WHAT BELONGS HERE RATHER THAN IN `tests/db/case-lifecycle.test.ts`: the rules decided BEFORE the port is
 * called. A stub port that refuses everything is the right instrument for those, because an assertion that
 * passes with a port that never succeeds cannot be an assertion about persistence.
 *
 *   * The six routes exist and the registry's declaration matches §5.7.1–§5.7.6: scopes, idempotency, and which
 *     of them are reads.
 *   * §5.7.2's declared filter surface matches the specification, including the two fields it had wrong
 *     (`jurisdiction` was offered and `channel`/`authorityGrantState` were missing).
 *   * §5.7.4's body rules: `requestedTruthState` outside the routeable set is refused HERE, before any port call,
 *     because the route — not the port — owns that licence.
 *   * §5.7.5's bypass refusal happens before the transaction opens (VG-DISC-004).
 *   * The precondition codes: 428 when `If-Match` is absent, 412 when it is unparseable.
 *   * The timeline route is READ-ONLY: no POST/PATCH/DELETE handler exists on it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import {
  testAppealQueries,
  testAuditQueries,
  testCaseQueries,
  testDeadlineQueries,
  testExposureQueries,
  testIdentity,
  testObservationQueries,
  testRecipeVerificationKeys,
  testSourceQueries,
  testSubjectQueries,
  testTenancy,
  testTransitionQueries,
  TEST_SESSION_SECRET,
  TEST_TOKEN,
} from './server-support.ts';
import { ROUTES, findRoute } from '../../src/http/openapi/registry.ts';
import { CASES_QUERY } from '../../src/http/query/filters.ts';
import { parseQuery, QueryError } from '../../src/http/query/strict.ts';
import { ROUTEABLE_CASE_TARGETS, HUMAN_GATE_ROUTING } from '../../src/application/contracts/case-queries.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '77777777-1111-4111-8111-777777777777';
const SCOPES = ['vg.cases.read', 'vg.cases.write'];

function app(scopes: readonly string[] = SCOPES): VgFastify {
  const tenancy = testTenancy();
  return buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({ tenantId: TENANT_A, scopes }),
    tenancy: tenancy.runner,
    idempotency: {
      store: { begin: async () => ({ state: 'NEW' as const }), complete: async () => {}, abandon: async () => {} },
      requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
    },
    sessionSecret: TEST_SESSION_SECRET,
    subjectQueries: testSubjectQueries(),
    sourceQueries: testSourceQueries(),
    recipeVerificationKeys: testRecipeVerificationKeys(),
    appealQueries: testAppealQueries(),
    deadlineQueries: testDeadlineQueries(),
    auditQueries: testAuditQueries(),
    observationQueries: testObservationQueries(),
    exposureQueries: testExposureQueries(),
    transitionQueries: testTransitionQueries(),
    caseQueries: testCaseQueries(),
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
  });
}

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

async function call(
  server: VgFastify,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> {
  const headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}`, ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && headers['idempotency-key'] === undefined) {
    // 16–255 characters from SPEC-003 §4.2's charset: a short key is refused `IDEMPOTENCY_KEY_MALFORMED`
    // before the handler runs, which would make every assertion below a statement about the key.
    headers['idempotency-key'] = `case-contract-key-${CASE_ID.slice(0, 8)}`;
  }
  const response = await server.inject({
    method,
    url,
    headers,
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = { __raw: response.body };
  }
  return { status: response.statusCode, json, headers: response.headers as Record<string, unknown> };
}

function codeOf(response: Injected): unknown {
  const error = response.json['error'];
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined;
}

describe('§5.7 is declared as the registry says it is', () => {
  test('the six routes carry the specified scopes, methods and idempotency', () => {
    const expected: readonly [string, string, string, string, string][] = [
      ['5.7.1', 'POST', '/v1/cases', 'vg.cases.write', 'required'],
      ['5.7.2', 'GET', '/v1/cases', 'vg.cases.read', 'optional'],
      ['5.7.3', 'GET', '/v1/cases/{caseId}', 'vg.cases.read', 'optional'],
      ['5.7.4', 'PATCH', '/v1/cases/{caseId}', 'vg.cases.write', 'required'],
      ['5.7.5', 'POST', '/v1/cases/{caseId}/human-gates', 'vg.cases.write', 'required'],
      ['5.7.6', 'GET', '/v1/cases/{caseId}/timeline', 'vg.cases.read', 'optional'],
    ];
    for (const [id, method, path, scope, idempotency] of expected) {
      const route = ROUTES.find((candidate) => candidate.id === id);
      assert.ok(route !== undefined, `${id} is not in the registry`);
      assert.equal(route.method, method, id);
      assert.equal(route.path, path, id);
      assert.equal(route.idempotency, idempotency, id);
      assert.deepEqual(route.scopes, [scope], id);
    }
  });

  test('the timeline is read-only', async () => {
    const server = app();
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT'] as const) {
      const response = await call(server, method, `/v1/cases/${CASE_ID}/timeline`, { body: {} });
      assert.ok(
        response.status === 404 || response.status === 405,
        `${method} answered ${String(response.status)}: the timeline must have no write counterpart (VG-EVIDENCE-003)`,
      );
    }
    await server.close();
  });

  test('a caller without the write scope is refused 403 on all three writes', async () => {
    const server = app(['vg.cases.read']);
    const writes: readonly [string, string, unknown][] = [
      ['POST', '/v1/cases', {}],
      ['PATCH', `/v1/cases/${CASE_ID}`, { requestedTruthState: 'REQUEST_READY', reason: { code: 'x', detail: 'y' } }],
      ['POST', `/v1/cases/${CASE_ID}/human-gates`, { gateKind: 'CAPTCHA', detectedAt: new Date().toISOString() }],
    ];
    for (const [method, url, body] of writes) {
      const response = await call(server, method as 'POST' | 'PATCH', url, { body });
      assert.equal(response.status, 403, `${url} answered ${String(response.status)}`);
      assert.equal(codeOf(response), 'INSUFFICIENT_SCOPE');
    }
    await server.close();
  });
});

describe('§5.7.2 query surface', () => {
  test('the declaration matches the specification field for field', () => {
    // §5.7.2: subjectId, sourceId, truthState, channel, authorityGrantState, from, to, sort ∈
    // createdAt|updatedAt|truthState (default updatedAt:desc).
    assert.deepEqual(Object.keys(CASES_QUERY.parameters).sort(), [
      'authorityGrantState',
      'channel',
      'cursor',
      'limit',
      'sourceId',
      'subjectId',
    ]);
    assert.deepEqual([...CASES_QUERY.sortFields], ['createdAt', 'updatedAt', 'truthState']);
    assert.equal(CASES_QUERY.defaultSort, 'updatedAt:desc');
    assert.equal(CASES_QUERY.timeFilterable, true);
    assert.equal(CASES_QUERY.truthStateFilterable, true);
    // The drifted declaration offered `jurisdiction` (not a §5.7.2 filter) and sorted on
    // `truthStateChangedAt` (not a column, so every documented sort would have been refused).
    assert.equal(Object.hasOwn(CASES_QUERY.parameters, 'jurisdiction'), false);

    const parsed = parseQuery(
      {
        subjectId: '11111111-1111-4111-8111-111111111111',
        channel: 'OFFICIAL_SELF_SERVICE',
        authorityGrantState: 'VALID',
        truthState: 'REQUEST_READY',
        sort: 'truthState:asc',
      },
      CASES_QUERY,
    );
    assert.equal(parsed.sort, 'truthState:asc');
    assert.equal(parsed.filter['authorityGrantState'], 'VALID');
    assert.equal(parsed.filter['channel'], 'OFFICIAL_SELF_SERVICE');
  });

  test('an unknown sort field and an unknown parameter are both refused', () => {
    assert.throws(
      () => parseQuery({ sort: 'truthStateChangedAt:desc' }, CASES_QUERY),
      (error: unknown) => error instanceof QueryError && error.code === 'INVALID_SORT_FIELD',
    );
    assert.throws(
      () => parseQuery({ jurisdiction: 'US-CA' }, CASES_QUERY),
      (error: unknown) => error instanceof QueryError && error.code === 'UNKNOWN_QUERY_PARAMETER',
    );
  });
});

describe('§5.7.4 and §5.7.5 request rules decided before the port', () => {
  test('a target outside the routeable set is refused by the ROUTE, not by the port', async () => {
    // The three routeable states are the contract's, and every other one is reachable only through its own
    // effect or observation route (§5.7.4). Each is refused without the port being consulted — this server's
    // port refuses everything, so a 422 here is the route's own rule.
    for (const state of ['REQUEST_SUBMITTED', 'ACKNOWLEDGED', 'VERIFIED_REMOVED', 'SEARCH_DELISTED', 'REAPPARED']) {
      const server = app();
      const response = await call(server, 'PATCH', `/v1/cases/${CASE_ID}`, {
        headers: { 'if-match': '"MATCH_CONFIRMED:1"' },
        body: { requestedTruthState: state, reason: { code: 'X', detail: 'x' } },
      });
      // INVALID_TRUTH_STATE for a token that is not one of the eleven, TRANSITION_NOT_ROUTEABLE for one that is
      // but cannot be requested here; both are refusals and neither reaches the port.
      assert.ok(
        response.status === 422 || response.status === 400,
        `${state} answered ${String(response.status)}`,
      );
      await server.close();
    }
    assert.deepEqual([...ROUTEABLE_CASE_TARGETS], ['REQUEST_READY', 'NOT_REMOVABLE', 'HUMAN_REQUIRED']);
  });

  test('every gate kind §5.7.5 declares has a queue and a service level', () => {
    assert.deepEqual(Object.keys(HUMAN_GATE_ROUTING).sort(), [
      'AUTHORITY_DEFECT',
      'CAPTCHA',
      'IDENTITY_DOCUMENT_UPLOAD',
      'LEGAL_REVIEW',
      'OTP',
      'PHONE_VERIFICATION',
      'PROVIDER_MANUAL_STEP',
    ]);
    for (const [kind, routing] of Object.entries(HUMAN_GATE_ROUTING)) {
      assert.ok(routing.queue.length > 0, kind);
      assert.ok(routing.serviceLevelSeconds > 0, kind);
    }
  });

  test('a bypass attempt is refused before anything else', async () => {
    const server = app();
    // WITHOUT `If-Match` the refusal is 428: §2.7's precondition is checked before the body, so a caller that
    // cannot prove it read the current state is told that first. The bypass refusal below is asserted with the
    // precondition satisfied, which is the state a real caller is in.
    const noPrecondition = await call(server, 'POST', `/v1/cases/${CASE_ID}/human-gates`, {
      body: { gateKind: 'CAPTCHA', detectedAt: new Date().toISOString(), attemptedBypass: true },
    });
    assert.equal(noPrecondition.status, 428, JSON.stringify(noPrecondition.json));

    const response = await call(server, 'POST', `/v1/cases/${CASE_ID}/human-gates`, {
      headers: { 'if-match': '"MATCH_CONFIRMED:1"' },
      body: { gateKind: 'CAPTCHA', detectedAt: new Date().toISOString(), attemptedBypass: true },
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'BYPASS_ATTEMPT_REFUSED');
    await server.close();
  });

  test('a missing precondition is 428 and an unparseable one is 412', async () => {
    const server = app();
    const missing = await call(server, 'PATCH', `/v1/cases/${CASE_ID}`, {
      body: { requestedTruthState: 'REQUEST_READY', reason: { code: 'X', detail: 'x' } },
    });
    assert.equal(missing.status, 428, JSON.stringify(missing.json));
    assert.equal(codeOf(missing), 'PRECONDITION_REQUIRED');

    for (const header of ['*', 'garbage', '"MATCH_CONFIRMED"']) {
      const stale = await call(server, 'PATCH', `/v1/cases/${CASE_ID}`, {
        headers: { 'if-match': header },
        body: { requestedTruthState: 'REQUEST_READY', reason: { code: 'X', detail: 'x' } },
      });
      assert.equal(stale.status, 412, `If-Match: ${header} answered ${String(stale.status)}`);
      assert.equal(codeOf(stale), 'PRECONDITION_FAILED');
    }
    await server.close();
  });

  test('a malformed case id is 404, indistinguishable from an absent one', async () => {
    const server = app();
    for (const url of ['/v1/cases/not-a-uuid', '/v1/cases/123', '/v1/cases/not-a-uuid/timeline']) {
      const response = await call(server, 'GET', url);
      assert.equal(response.status, 404, `${url} answered ${String(response.status)}`);
      assert.equal(codeOf(response), 'RESOURCE_NOT_FOUND');
    }
    await server.close();
  });

  test('creation refuses a body whose id fields are not UUIDs', async () => {
    const server = app();
    for (const field of ['subjectId', 'exposureId', 'sourceId', 'authorityGrantId', 'policyDecisionId', 'recipeId']) {
      const body: Record<string, string> = {
        subjectId: '11111111-1111-4111-8111-111111111111',
        exposureId: '22222222-2222-4222-8222-222222222222',
        sourceId: '33333333-3333-4333-8333-333333333333',
        authorityGrantId: '44444444-4444-4444-8444-444444444444',
        policyDecisionId: '55555555-5555-4555-8555-555555555555',
        recipeId: '66666666-6666-4666-8666-666666666666',
      };
      body[field] = 'sub_01H';
      const response = await call(server, 'POST', '/v1/cases', { body });
      assert.equal(response.status, 400, `${field} answered ${String(response.status)}`);
      assert.equal(codeOf(response), 'SCHEMA_VALIDATION_FAILED');
    }
    await server.close();
  });
});
