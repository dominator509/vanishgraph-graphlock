/**
 * The §5.9 boundary rules, credential-free (SPEC-003 §5.9, §3.2).
 *
 * WHAT BELONGS HERE: the declarations and the rules decided before the port. The persistence behaviour —
 * which transition each response kind actually drives, and that a claim never becomes a removal — needs a
 * database and lives in `tests/db/controller-responses.test.ts`.
 *
 *   * The three routes exist with the scopes, idempotency and methods §5.9.1–§5.9.3 declare.
 *   * `CLAIMED_OUTCOMES` and `RESPONSE_KINDS` are exactly the contract's vocabularies, and every kind has a
 *     declared target outcome — a kind with no entry would silently fall back to `ACKNOWLEDGED`.
 *   * The request-level refusals reach the right code: an unsupported claim, a refusal with no basis, a
 *     malformed message id.
 *   * The response list route is READ-ONLY.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import {
  testIdentity,
  testTenancy,
  TEST_TOKEN,
  testServerDependencies,
} from './server-support.ts';
import { ROUTES, findRoute } from '../../src/http/openapi/registry.ts';
import { isErrorCode } from '../../src/http/errors/code-registry.ts';
import {
  CLAIMED_OUTCOMES,
  RESPONSE_KINDS,
  RESPONSE_KIND_OUTCOME,
} from '../../src/application/contracts/controller-response-queries.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '77777777-1111-4111-8111-777777777777';
const SCOPES = ['vg.cases.read', 'vg.cases.write'];

function app(scopes: readonly string[] = SCOPES): VgFastify {
  const tenancy = testTenancy();
  return buildServer(testServerDependencies({
    identity: testIdentity({ tenantId: TENANT_A, scopes }),
    tenancy: tenancy.runner,
    idempotency: {
      store: { begin: async () => ({ state: 'NEW' as const }), complete: async () => {}, abandon: async () => {} },
      requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
    },
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
  }));
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
  if (method === 'POST') headers['idempotency-key'] = `controller-contract-${CASE_ID.slice(0, 8)}`;
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
  responseKind: 'ACKNOWLEDGEMENT',
  claimedOutcome: 'UNSPECIFIED',
  bodyRef: 'eml-1',
  receivedAt: '2026-02-01T00:00:00.000Z',
};

describe('§5.9 is declared as the registry says it is', () => {
  test('the three routes carry the specified scopes, methods and idempotency', () => {
    const expected: readonly [string, string, string, string, string][] = [
      ['5.9.1', 'POST', '/v1/cases/{caseId}/controller-responses', 'vg.cases.write', 'required'],
      ['5.9.2', 'GET', '/v1/cases/{caseId}/controller-responses', 'vg.cases.read', 'optional'],
      ['5.9.3', 'POST', '/v1/cases/{caseId}/email-threads', 'vg.cases.write', 'required'],
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

  test('the response list is read-only', async () => {
    const server = app();
    // `POST` IS the create route (§5.9.1) and is deliberately NOT in this list: what must not exist is a way to
    // change or erase a response that was recorded, so the check is PATCH/PUT/DELETE.
    for (const method of ['PATCH', 'DELETE', 'PUT'] as const) {
      const response = await call(server, method, `/v1/cases/${CASE_ID}/controller-responses`, { body: {} });
      assert.ok(
        response.status === 404 || response.status === 405,
        `${method} answered ${String(response.status)}`,
      );
    }
    await server.close();
  });

  test('a caller without the write scope is refused 403 on both writes', async () => {
    const server = app(['vg.cases.read']);
    for (const url of [`/v1/cases/${CASE_ID}/controller-responses`, `/v1/cases/${CASE_ID}/email-threads`]) {
      const response = await call(server, 'POST', url, { body: VALID });
      assert.equal(response.status, 403, `${url} answered ${String(response.status)}`);
      assert.equal(codeOf(response), 'INSUFFICIENT_SCOPE');
    }
    await server.close();
  });
});

describe('§5.9 vocabularies are the contract’s, and total', () => {
  test('the claim vocabulary is exactly the three tokens §5.9.1 declares', () => {
    assert.deepEqual([...CLAIMED_OUTCOMES], ['DELETED', 'NOT_DELETED', 'UNSPECIFIED']);
    // None of them is a truth state: the point of the vocabulary is that a claim cannot be expressed as one.
    assert.equal(CLAIMED_OUTCOMES.includes('VERIFIED_REMOVED'), false);
  });

  test('the response kinds are exactly §5.9.1’s seven, and every one has a declared outcome', () => {
    assert.deepEqual(
      [...RESPONSE_KINDS].sort(),
      [
        'ACKNOWLEDGEMENT',
        'CLAIMED_DELETION',
        'CONTROLLER_DEMANDS_AUTHORITY',
        'CONTROLLER_DEMANDS_IDENTITY',
        'NO_RESPONSE_TIMEOUT',
        'PARTIAL_ACTION',
        'REFUSAL',
      ].sort(),
    );
    for (const kind of RESPONSE_KINDS) {
      // A kind with no entry would fall back to ACKNOWLEDGED in the adapter, which would make an unhandled kind
      // look like a successful acknowledgement.
      assert.ok(RESPONSE_KIND_OUTCOME[kind] !== undefined, `${kind} has no declared outcome`);
    }
    assert.equal(Object.keys(RESPONSE_KIND_OUTCOME).length, RESPONSE_KINDS.length);
  });

  test('every code these routes emit is registered (H-7)', () => {
    for (const code of [
      'REFUSAL_BASIS_REQUIRED',
      'CLAIMED_OUTCOME_UNSUPPORTED',
      'EMAIL_THREAD_DUPLICATE',
      'MESSAGE_ID_MALFORMED',
      'HUMAN_STEP_REQUIRED',
      'ILLEGAL_TRANSITION',
      'PRECONDITION_REQUIRED',
      'PRECONDITION_FAILED',
    ]) {
      assert.equal(isErrorCode(code), true, `${code} must be in the registry`);
    }
  });
});

describe('§5.9.1 request rules decided before the port', () => {
  test('an unsupported claim is refused with its own code', async () => {
    const server = app();
    for (const claim of ['VERIFIED_REMOVED', 'REMOVED', 'DONE']) {
      const response = await call(server, 'POST', `/v1/cases/${CASE_ID}/controller-responses`, {
        // The precondition is checked BEFORE the body, so it is supplied here: without it every assertion
        // below would be about the 428 rather than about the body rule under test.
        headers: { 'if-match': "REQUEST_SUBMITTED:1" },
        body: { ...VALID, claimedOutcome: claim },
      });
      assert.equal(response.status, 422, `${claim} answered ${String(response.status)}`);
      assert.equal(codeOf(response), 'CLAIMED_OUTCOME_UNSUPPORTED');
    }
    await server.close();
  });

  test('an unknown response kind is a schema failure, not an acknowledgement', async () => {
    const server = app();
    const response = await call(server, 'POST', `/v1/cases/${CASE_ID}/controller-responses`, {
      // The precondition is checked BEFORE the body, so it is supplied here: without it every assertion
      // below would be about the 428 rather than about the body rule under test.
      headers: { 'if-match': "REQUEST_SUBMITTED:1" },
      body: { ...VALID, responseKind: 'APPROVED' },
    });
    assert.equal(response.status, 400, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'SCHEMA_VALIDATION_FAILED');
    await server.close();
  });

  test('a missing If-Match is 428, before the body decides anything', async () => {
    const server = app();
    const response = await call(server, 'POST', `/v1/cases/${CASE_ID}/controller-responses`, {
      // NO If-Match, and deliberately a body that would ALSO fail validation: the precondition is checked first,
      // so the answer is 428 and not a body error. That ordering is the property this test pins.
      body: { ...VALID, responseKind: 'APPROVED' },
    });
    assert.equal(response.status, 428, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'PRECONDITION_REQUIRED');
    await server.close();
  });

  test('a malformed message id reaches the port only when it is well formed', async () => {
    const server = app();
    const refused = await call(server, 'POST', `/v1/cases/${CASE_ID}/email-threads`, {
      body: { direction: 'INBOUND', messageIds: ['nope'] },
    });
    assert.equal(refused.status, 422, JSON.stringify(refused.json));
    assert.equal(codeOf(refused), 'MESSAGE_ID_MALFORMED');

    // A well-formed request gets past validation and meets the stub port, which reports the case absent.
    const reached = await call(server, 'POST', `/v1/cases/${CASE_ID}/email-threads`, {
      body: { direction: 'INBOUND', messageIds: ['<a@b>'] },
    });
    assert.equal(reached.status, 404, JSON.stringify(reached.json));
    await server.close();
  });

  test('a direction outside the two declared values is refused', async () => {
    const server = app();
    const response = await call(server, 'POST', `/v1/cases/${CASE_ID}/email-threads`, {
      body: { direction: 'SIDEWAYS', messageIds: ['<a@b>'] },
    });
    assert.equal(response.status, 400, JSON.stringify(response.json));
    await server.close();
  });
});
