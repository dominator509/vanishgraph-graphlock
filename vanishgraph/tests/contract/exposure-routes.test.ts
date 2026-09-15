/**
 * The §5.5 boundary rules, credential-free (SPEC-003 §5.5, §2.6, §3.2).
 *
 * WHAT THIS SUITE CAN PROVE WITHOUT A DATABASE, and why each item belongs here rather than in
 * `tests/db/exposure-transitions.test.ts`: the rules below are decided BEFORE the port is called, so a stub
 * port that refuses everything is the right instrument — an assertion that passes with a port that never
 * succeeds cannot be an assertion about persistence.
 *
 *   * The five routes exist and the registry's declaration matches §5.5.1–§5.5.5: scopes, idempotency and
 *     which of them is a READ.
 *   * §5.5.1's filter surface matches the specification — the four parts of `EXPOSURES_QUERY` that had drifted
 *     before the route existed, asserted against §5.5.1's own list rather than against the declaration.
 *   * `minConfidence` parses as a DECIMAL in 0–1 and an out-of-range value is refused rather than returning an
 *     empty page (`number` is a parameter type this route is the first to need).
 *   * The request-level refusals: a basis-less score, an out-of-range score, an incomplete coverage claim, and
 *     a uuid-shaped evidence field.
 *   * The precondition codes: 428 when `If-Match` is absent, 412 when it is unparseable.
 *   * §5.5.5 and §5.5's reads are READ-ONLY: no POST/PATCH/DELETE handler exists on the history route.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import {
  testAppealQueries,
  testAuditQueries,
  testDeadlineQueries,
  testExposureQueries,
  testIdentity,
  testObservationQueries,
  testRecipeVerificationKeys,
  testSourceQueries,
  testSubjectQueries,
  testTenancy,
  testCaseQueries,
  testTransitionQueries,
  TEST_SESSION_SECRET,
  TEST_TOKEN,
} from './server-support.ts';
import { ROUTES, findRoute } from '../../src/http/openapi/registry.ts';
import { EXPOSURES_QUERY } from '../../src/http/query/filters.ts';
import { parseQuery, QueryError } from '../../src/http/query/strict.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const EXPOSURE_ID = '99999999-1111-4111-8111-999999999999';
const SCOPES = ['vg.exposures.read', 'vg.exposures.assess'];

function app(): VgFastify {
  const tenancy = testTenancy();
  return buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({ tenantId: TENANT_A, scopes: SCOPES }),
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
  method: 'GET' | 'POST',
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> {
  const headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}`, ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST' && headers['idempotency-key'] === undefined) {
    // 16–255 characters from SPEC-003 §4.2's charset. MEASURED: a short key is refused
    // `400 IDEMPOTENCY_KEY_MALFORMED` before the handler runs, which would make every assertion below a
    // statement about the key rather than about §5.5.
    headers['idempotency-key'] = `exposure-contract-key-${EXPOSURE_ID.slice(0, 8)}`;
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

const VALID_CONFIDENCE = {
  value: 0.9,
  basis: [{ feature: 'NAME_EXACT', weight: 0.4 }],
};

describe('§5.5 is declared as the registry says it is', () => {
  test('the five routes carry the specified scopes and methods', () => {
    const expected: readonly [string, string, string, string][] = [
      ['5.5.1', 'GET', '/v1/exposures', 'optional'],
      ['5.5.2', 'GET', '/v1/exposures/{exposureId}', 'optional'],
      ['5.5.3', 'POST', '/v1/exposures/{exposureId}/match-assessments', 'required'],
      ['5.5.4', 'POST', '/v1/exposures/{exposureId}/disproofs', 'required'],
      ['5.5.5', 'GET', '/v1/exposures/{exposureId}/transitions', 'optional'],
    ];
    for (const [id, method, path, idempotency] of expected) {
      const route = ROUTES.find((candidate) => candidate.id === id);
      assert.ok(route !== undefined, `${id} is not in the registry`);
      assert.equal(route.method, method, id);
      assert.equal(route.path, path, id);
      assert.equal(route.idempotency, idempotency, id);
      const scope = id === '5.5.3' || id === '5.5.4' ? 'vg.exposures.assess' : 'vg.exposures.read';
      assert.deepEqual(route.scopes, [scope], id);
    }
  });

  test('the history route is read-only: no mutating handler exists for it', async () => {
    const server = app();
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT'] as const) {
      const response = await server.inject({
        method,
        url: `/v1/exposures/${EXPOSURE_ID}/transitions`,
        headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
        payload: {},
      });
      // 404 (no such route) or 405 (method not allowed) both mean "the contract has no such operation"; a 2xx
      // would mean the API offers a way to write the append-only trail.
      assert.ok(
        response.statusCode === 404 || response.statusCode === 405,
        `${method} answered ${String(response.statusCode)}`,
      );
    }
    await server.close();
  });

  test('a caller without the assess scope is refused 403 on both writes', async () => {
    const server = buildServer({
      version: '0.0.0-test',
      commit: 'test',
      logLevel: 'silent',
      identity: testIdentity({ tenantId: TENANT_A, scopes: ['vg.exposures.read'] }),
      tenancy: testTenancy().runner,
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
    const response = await call(server, 'POST', `/v1/exposures/${EXPOSURE_ID}/match-assessments`, {
      headers: { 'if-match': '"DISCOVERED_CANDIDATE:1"' },
      body: { confidence: VALID_CONFIDENCE, method: 'FEATURE_SET_V1' },
    });
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'INSUFFICIENT_SCOPE');
    await server.close();
  });
});

describe('§5.5.1 query surface', () => {
  test('the declaration matches the specification field for field', () => {
    // §5.5.1: subjectId, sourceId, truthState, minConfidence, from, to, sort ∈ observedAt|confidence|truthState.
    // `from`/`to`/`truthState`/`sort` are NOT declared in `parameters`: each is contributed by the flag that
    // declares it (`timeFilterable`, `truthStateFilterable`, `sortFields`), which is what keeps one rule in one
    // place. This asserts the declared members AND that the flags make the other four reachable.
    assert.deepEqual(Object.keys(EXPOSURES_QUERY.parameters).sort(), [
      'cursor',
      'limit',
      'minConfidence',
      'sourceId',
      'subjectId',
    ]);
    assert.deepEqual([...EXPOSURES_QUERY.sortFields], ['observedAt', 'confidence', 'truthState']);
    assert.equal(EXPOSURES_QUERY.defaultSort, 'observedAt:desc');
    assert.equal(EXPOSURES_QUERY.timeFilterable, true);
    assert.equal(EXPOSURES_QUERY.truthStateFilterable, true);
    // `caseId` was offered by the declaration and is NOT a §5.5.1 parameter.
    assert.equal(Object.hasOwn(EXPOSURES_QUERY.parameters, 'caseId'), false);

    const accepted = parseQuery(
      {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
        truthState: 'MATCH_CONFIRMED',
        sort: 'confidence:asc',
      },
      EXPOSURES_QUERY,
    );
    assert.equal(accepted.sort, 'confidence:asc');
    assert.equal(accepted.filter['truthState'], 'MATCH_CONFIRMED');
  });

  test('minConfidence parses as a decimal, and an out-of-range value is refused', () => {
    const parsed = parseQuery({ minConfidence: '0.85' }, EXPOSURES_QUERY);
    assert.equal(parsed.filter['minConfidence'], 0.85);
    for (const bad of ['2', '-0.1', '', 'abc', '1e3']) {
      assert.throws(
        () => parseQuery({ minConfidence: bad }, EXPOSURES_QUERY),
        (error: unknown) => error instanceof QueryError && error.code === 'SCHEMA_VALIDATION_FAILED',
        `minConfidence=${bad} was accepted`,
      );
    }
  });

  test('an absent from/to applies the 30-day default and says so', () => {
    const parsed = parseQuery({}, EXPOSURES_QUERY);
    assert.equal(parsed.filter['appliedDefaultTimeRangeDays'], 30);
  });

  test('the route refuses an unknown parameter rather than ignoring it', async () => {
    const server = app();
    const response = await call(server, 'GET', '/v1/exposures?caseId=00000000-0000-4000-8000-000000000000');
    assert.equal(response.status, 400, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'UNKNOWN_QUERY_PARAMETER');
    await server.close();
  });
});

describe('§5.5 write refusals decided before the port', () => {
  test('a basis-less score is 422 with its own code', async () => {
    const server = app();
    const response = await call(server, 'POST', `/v1/exposures/${EXPOSURE_ID}/match-assessments`, {
      headers: { 'if-match': '"DISCOVERED_CANDIDATE:1"' },
      body: { confidence: { value: 0.9, basis: [] }, method: 'FEATURE_SET_V1' },
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'CONFIDENCE_BASIS_REQUIRED');
    await server.close();
  });

  test('a score outside 0–1 is 422 CONFIDENCE_OUT_OF_RANGE', async () => {
    const server = app();
    const response = await call(server, 'POST', `/v1/exposures/${EXPOSURE_ID}/match-assessments`, {
      headers: { 'if-match': '"DISCOVERED_CANDIDATE:1"' },
      body: { confidence: { value: 1.2, basis: VALID_CONFIDENCE.basis }, method: 'FEATURE_SET_V1' },
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'CONFIDENCE_OUT_OF_RANGE');
    await server.close();
  });

  test('a missing If-Match is 428, before the body is examined', async () => {
    const server = app();
    const response = await call(server, 'POST', `/v1/exposures/${EXPOSURE_ID}/match-assessments`, {
      body: { confidence: { value: 'not-a-number' }, method: '' },
    });
    assert.equal(response.status, 428, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'PRECONDITION_REQUIRED');
    await server.close();
  });

  test('an unparseable If-Match is 412, and `*` is refused', async () => {
    const server = app();
    for (const header of ['*', 'garbage', '"DISCOVERED_CANDIDATE"']) {
      const response = await call(server, 'POST', `/v1/exposures/${EXPOSURE_ID}/disproofs`, {
        headers: { 'if-match': header },
        body: {
          disproofBasis: 'DIFFERENT_MIDDLE_NAME',
          evidenceArtifactId: '44444444-1111-4111-8111-444444444444',
          scanComplete: true,
          coverageBounds: { sourcesAttempted: 12, sourcesTotal: 12 },
        },
      });
      assert.equal(response.status, 412, `If-Match: ${header} answered ${String(response.status)}`);
      assert.equal(codeOf(response), 'PRECONDITION_FAILED');
    }
    await server.close();
  });

  test('an incomplete or absent coverage claim is refused before anything else', async () => {
    const server = app();
    for (const bounds of [
      { sourcesAttempted: 9, sourcesTotal: 12 },
      { sourcesAttempted: 0, sourcesTotal: 0 },
      'not-an-object',
      undefined,
    ]) {
      const response = await call(server, 'POST', `/v1/exposures/${EXPOSURE_ID}/disproofs`, {
        headers: { 'if-match': '"DISCOVERED_CANDIDATE:1"' },
        body: {
          disproofBasis: 'DIFFERENT_MIDDLE_NAME',
          evidenceArtifactId: '44444444-1111-4111-8111-444444444444',
          scanComplete: true,
          coverageBounds: bounds,
        },
      });
      assert.ok(
        response.status === 422,
        `coverageBounds ${JSON.stringify(bounds)} answered ${String(response.status)}`,
      );
      assert.ok(
        codeOf(response) === 'COVERAGE_BOUNDS_REQUIRED' || codeOf(response) === 'SCHEMA_VALIDATION_FAILED',
        `unexpected code ${String(codeOf(response))}`,
      );
    }
    await server.close();
  });

  test('an evidence id that is not a UUID is refused rather than passed to SQL', async () => {
    const server = app();
    const response = await call(server, 'POST', `/v1/exposures/${EXPOSURE_ID}/match-assessments`, {
      headers: { 'if-match': '"DISCOVERED_CANDIDATE:1"' },
      body: { confidence: VALID_CONFIDENCE, method: 'FEATURE_SET_V1', evidenceArtifactId: 'evd_01HXYZ' },
    });
    assert.equal(response.status, 400, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'SCHEMA_VALIDATION_FAILED');
    await server.close();
  });

  test('a malformed exposure id is 404, indistinguishable from an absent one', async () => {
    const server = app();
    for (const id of ['not-a-uuid', '123']) {
      const response = await call(server, 'GET', `/v1/exposures/${id}`);
      assert.equal(response.status, 404, JSON.stringify(response.json));
      assert.equal(codeOf(response), 'RESOURCE_NOT_FOUND');
    }
    await server.close();
  });
});
