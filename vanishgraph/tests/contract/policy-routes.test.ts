/**
 * The §5.6 boundary rules, credential-free (SPEC-003 §5.6, §3.2).
 *
 * WHAT BELONGS HERE: the declarations and the rules decided before the port. The resolution's dependence on
 * policy data, the channel priority engine and the audit trail all need a database and live in
 * `tests/db/policy-decisions.test.ts`.
 *
 *   * The four routes exist with §5.6.1–§5.6.4's scopes, methods and idempotency — and `POST` is the only write.
 *   * §5.6.4 has NO WRITE COUNTERPART on `/v1`, which is the contract's own rule ("policy data is authored
 *     through an out-of-band, human-reviewed change process … there is no route by which an API caller or a model
 *     can author a jurisdiction rule or a legal basis").
 *   * A body asserting `legalBasis` is refused, and a malformed version label is refused rather than coerced.
 *   * An unknown query parameter on §5.6.4 is refused like every other collection.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, testPolicyQueries, testServerDependencies, TEST_TOKEN } from './server-support.ts';
import { ROUTES } from '../../src/http/openapi/registry.ts';
import { isErrorCode } from '../../src/http/errors/code-registry.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '77777777-1111-4111-8111-777777777777';
const DECISION_ID = '66666666-1111-4111-8111-666666666666';
const SCOPES = ['vg.policy.read', 'vg.policy.write'];

function app(scopes: readonly string[] = SCOPES): VgFastify {
  return buildServer(
    testServerDependencies({
      identity: testIdentity({ tenantId: TENANT_A, scopes }),
      policyQueries: testPolicyQueries(),
    }),
  );
}

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function call(
  server: VgFastify,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TEST_TOKEN}`,
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST') headers['idempotency-key'] = `policy-contract-${CASE_ID.slice(0, 8)}`;
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
    json = {};
  }
  return { status: response.statusCode, json };
}

function codeOf(response: Injected): unknown {
  const error = response.json['error'];
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined;
}

const VALID = {
  jurisdiction: 'US-CA',
  requestedChannel: 'OFFICIAL_SELF_SERVICE',
  policyVersion: '2026-01-15',
};

describe('§5.6 is declared as the registry says it is', () => {
  test('the four routes carry the specified scopes, methods and idempotency', () => {
    const expected: readonly [string, string, string, string, string][] = [
      ['5.6.1', 'POST', '/v1/cases/{caseId}/policy-decisions', 'vg.policy.write', 'required'],
      ['5.6.2', 'GET', '/v1/cases/{caseId}/policy-decisions', 'vg.policy.read', 'optional'],
      ['5.6.3', 'GET', '/v1/policy-decisions/{policyDecisionId}', 'vg.policy.read', 'optional'],
      ['5.6.4', 'GET', '/v1/jurisdiction-policies', 'vg.policy.read', 'optional'],
    ];
    for (const [id, method, path, scope, idempotency] of expected) {
      const route = ROUTES.find((candidate) => candidate.id === id);
      assert.ok(route !== undefined, `${id} is not in the registry`);
      assert.equal(route.method, method, id);
      assert.equal(route.path, path, id);
      assert.deepEqual(route.scopes, [scope], id);
      assert.equal(route.idempotency, idempotency, id);
    }
  });

  test('POLICY DATA HAS NO WRITE ROUTE ON /v1 — the contract says so in as many words', () => {
    // "This route is read-only with no write counterpart on /v1 … there is no route by which an API caller or a
    // model can author a jurisdiction rule or a legal basis (VG-POLICY-001, §10)." A registry row that created or
    // edited a policy version would break the product's central authorisation rule, so its absence is asserted
    // rather than assumed.
    const policyWrites = ROUTES.filter(
      (route) =>
        route.path.startsWith('/v1/jurisdiction-policies') &&
        route.method !== 'GET',
    );
    assert.deepEqual(policyWrites, [], 'a write route on jurisdiction policies would let a caller author policy');
  });

  test('the reads are read-only', async () => {
    const server = app();
    for (const [method, url] of [
      ['PATCH', `/v1/cases/${CASE_ID}/policy-decisions`],
      ['DELETE', `/v1/policy-decisions/${DECISION_ID}`],
      ['DELETE', '/v1/jurisdiction-policies'],
    ] as const) {
      const response = await call(server, method, url, { body: {} });
      assert.ok(
        response.status === 404 || response.status === 405,
        `${method} ${url} answered ${String(response.status)}`,
      );
    }
    await server.close();
  });

  test('a caller without the write scope is refused 403 on the resolution route', async () => {
    const server = app(['vg.policy.read']);
    const response = await call(server, 'POST', `/v1/cases/${CASE_ID}/policy-decisions`, {
      headers: { 'if-match': '"MATCH_CONFIRMED:1"' },
      body: VALID,
    });
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'INSUFFICIENT_SCOPE');
    await server.close();
  });

  test('every code these routes emit is registered (H-7)', () => {
    for (const code of [
      'POLICY_VERSION_SUPERSEDED',
      'LEGAL_BASIS_NOT_IN_POLICY_VERSION',
      'LEGAL_BASIS_NOT_AUTHORABLE',
      'CASE_AUTHORITY_INVALID',
      'JURISDICTION_UNRESOLVED',
      'CHANNEL_PRIORITY_VIOLATION',
      'STRICT_LANE_REQUIRED',
      'PRECONDITION_REQUIRED',
      'PRECONDITION_FAILED',
    ]) {
      assert.equal(isErrorCode(code), true, `${code} must be in the registry`);
    }
  });
});

describe('§5.6 request rules decided before the port', () => {
  test('a body asserting a legal basis is refused, after the precondition that guards every write', async () => {
    const server = app();
    // ORDERING, pinned because it was first written the other way round and the code disagreed. The precondition
    // is evaluated before the body is read at all — the same order every other §5 write route uses — so a request
    // that is missing If-Match is answered 428 even when its body is also inadmissible. Only once the precondition
    // holds does the legal-basis rule (VG-POLICY-001) speak.
    const withoutPrecondition = await call(server, 'POST', `/v1/cases/${CASE_ID}/policy-decisions`, {
      body: { ...VALID, legalBasis: 'CCPA_DELETE' },
    });
    assert.equal(withoutPrecondition.status, 428, JSON.stringify(withoutPrecondition.json));
    assert.equal(codeOf(withoutPrecondition), 'PRECONDITION_REQUIRED');

    const withPrecondition = await call(server, 'POST', `/v1/cases/${CASE_ID}/policy-decisions`, {
      headers: { 'if-match': '"MATCH_CONFIRMED:1"' },
      body: { ...VALID, legalBasis: 'CCPA_DELETE' },
    });
    assert.equal(withPrecondition.status, 422, JSON.stringify(withPrecondition.json));
    assert.equal(codeOf(withPrecondition), 'LEGAL_BASIS_NOT_AUTHORABLE');
    await server.close();
  });

  test('a version that is not a date string is refused, and a valid body reaches the port', async () => {
    const server = app();
    for (const policyVersion of ['3', 'v7', '2026-1-5', '']) {
      const refused = await call(server, 'POST', `/v1/cases/${CASE_ID}/policy-decisions`, {
        headers: { 'if-match': '"MATCH_CONFIRMED:1"' },
        body: { ...VALID, policyVersion },
      });
      assert.equal(refused.status, 400, `${policyVersion} was accepted: ${JSON.stringify(refused.json)}`);
    }
    // The stub port refuses everything with NOT_FOUND, so reaching it is the proof that the request passed
    // validation.
    const reached = await call(server, 'POST', `/v1/cases/${CASE_ID}/policy-decisions`, {
      headers: { 'if-match': '"MATCH_CONFIRMED:1"' },
      body: VALID,
    });
    assert.equal(reached.status, 404, JSON.stringify(reached.json));
    await server.close();
  });

  test('an unavailable channel with no reason is refused at the boundary', async () => {
    const server = app();
    const response = await call(server, 'POST', `/v1/cases/${CASE_ID}/policy-decisions`, {
      headers: { 'if-match': '"MATCH_CONFIRMED:1"' },
      body: {
        ...VALID,
        channelAlternativesConsidered: [{ channel: 'CERTIFIED_MAIL', unavailable: true }],
      },
    });
    assert.equal(response.status, 400, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'SCHEMA_VALIDATION_FAILED');
    await server.close();
  });

  test('§5.6.4 refuses an unknown query parameter and a malformed instant', async () => {
    const server = app();
    const unknown = await call(server, 'GET', '/v1/jurisdiction-policies?sort=version:desc');
    assert.equal(unknown.status, 400, JSON.stringify(unknown.json));
    assert.equal(codeOf(unknown), 'UNKNOWN_QUERY_PARAMETER');

    const malformed = await call(server, 'GET', '/v1/jurisdiction-policies?inForceOn=not-a-date');
    assert.equal(malformed.status, 400, JSON.stringify(malformed.json));

    const badJurisdiction = await call(server, 'GET', '/v1/jurisdiction-policies?jurisdiction=usa');
    assert.equal(badJurisdiction.status, 400, JSON.stringify(badJurisdiction.json));
    await server.close();
  });
});
