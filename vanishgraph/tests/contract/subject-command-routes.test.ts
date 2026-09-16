/**
 * The §5.1.1/§5.1.4 declarations and boundary rules, credential-free (SPEC-003 §5.1).
 *
 * WHAT BELONGS HERE: the registry rows, the ORDER of the two preconditions, the body rules decided before any port
 * is reached, the mapping from a port's refusal to a wire code, and the fact that the codes these routes raise are
 * registered at all. The creation, the authority rows, the ETag arithmetic and the strict lane need a database and
 * live in `tests/db/subject-commands.test.ts`.
 *
 * THE LAST TEST IS THE ONE THAT WOULD HAVE SAVED A DEBUGGING CYCLE. `ErrorCode` is `string`, so `apiError('ANY',
 * …)` compiles whatever the registry holds and an unregistered code fails only at runtime — on the refusal path,
 * inside envelope construction, where it becomes a 500. MEASURED while implementing §5.1.1:
 * `AUTHORITY_WINDOW_INVALID` was raised by a correct handler and answered 500 because the registry had no row.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, testServerDependencies, TEST_TOKEN } from './server-support.ts';
import { ROUTES } from '../../src/http/openapi/registry.ts';
import { isErrorCode } from '../../src/http/errors/code-registry.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const SUBJECT_ID = '44444444-1111-4111-8111-444444444444';
const SCOPES = ['vg.subjects.read', 'vg.subjects.write'];
const ETAG = '"VALID:1"';

function app(scopes: readonly string[] = SCOPES): VgFastify {
  return buildServer(
    testServerDependencies({
      identity: testIdentity({ tenantId: TENANT_A, scopes }),
      // The default stub refuses every command, so the mapping from a refusal to a wire code is exercised without
      // a database — and a 201 here would mean the route reported success for a request nothing performed.
    }),
  );
}

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function call(
  server: VgFastify,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> {
  const headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}`, ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && headers['idempotency-key'] === undefined) headers['idempotency-key'] = 'contract-key-0001';
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

const VALID_CREATE = {
  displayRef: 'SUBJ-CONTRACT-0001',
  jurisdiction: 'US-CA',
  isMinor: false,
  authorityGrant: { kind: 'SELF', scope: ['REMOVAL_REQUEST'], expiresAt: '2027-02-04T00:00:00.000Z' },
};

describe('§5.1.1 and §5.1.4 are declared as the registry says they are', () => {
  test('the two routes carry the specified scopes, methods, idempotency and step-up', () => {
    const create = ROUTES.find((route) => route.id === '5.1.1');
    assert.ok(create !== undefined);
    assert.equal(create.method, 'POST');
    assert.equal(create.path, '/v1/subjects');
    assert.deepEqual(create.scopes, ['vg.subjects.write']);
    assert.equal(create.idempotency, 'required');
    // §5.1.1: "Scope vg.subjects.write + step-up."
    assert.equal(create.stepUp, true, '5.1.1 requires a fresh step-up');

    const update = ROUTES.find((route) => route.id === '5.1.4');
    assert.ok(update !== undefined);
    assert.equal(update.method, 'PATCH');
    assert.equal(update.path, '/v1/subjects/{subjectId}');
    assert.deepEqual(update.scopes, ['vg.subjects.write']);
    assert.equal(update.idempotency, 'required');
    // §5.1.4 lists no step-up, and the registry must not add one the contract does not state.
    assert.equal(update.stepUp ?? false, false, '5.1.4 must not demand a step-up the contract does not');
  });

  test('a caller without vg.subjects.write is refused on both routes', async () => {
    const server = app(['vg.subjects.read']);
    const created = await call(server, 'POST', '/v1/subjects', { body: VALID_CREATE });
    assert.equal(created.status, 403, JSON.stringify(created.json));
    assert.equal(codeOf(created), 'INSUFFICIENT_SCOPE');
    const patched = await call(server, 'PATCH', `/v1/subjects/${SUBJECT_ID}`, {
      headers: { 'if-match': ETAG },
      body: { isMinor: false },
    });
    assert.equal(patched.status, 403, JSON.stringify(patched.json));
    await server.close();
  });

  test('EVERY CODE THESE ROUTES RAISE IS REGISTERED — the check an unregistered code fails at runtime', () => {
    // The six added while implementing §5.1.1/§5.1.4, plus the two that already existed and are reused here.
    for (const code of [
      'AUTHORITY_GRANT_INVALID',
      'AUTHORITY_EVIDENCE_REQUIRED',
      'AUTHORITY_WINDOW_INVALID',
      'AUTHORITY_SCOPE_UNKNOWN',
      'AUTHORITY_KIND_UNSUPPORTED',
      'STRICT_LANE_CONFLICT',
      'EVIDENCE_NOT_FOUND',
      'FIELD_NOT_PATCHABLE',
      'IDENTITY_LEVEL_INSUFFICIENT',
      'SEPARATION_OF_DUTIES',
    ]) {
      assert.equal(isErrorCode(code), true, `${code} must be in the registry`);
    }
  });
});

describe('§5.1.1 request rules decided before the port', () => {
  test('a malformed body is refused with the field named, and an unknown kind is a kind refusal', async () => {
    const server = app();
    const noRef = await call(server, 'POST', '/v1/subjects', {
      body: { ...VALID_CREATE, displayRef: undefined },
    });
    assert.equal(noRef.status, 400, JSON.stringify(noRef.json));
    assert.equal(codeOf(noRef), 'SCHEMA_VALIDATION_FAILED');

    const badJurisdiction = await call(server, 'POST', '/v1/subjects', {
      body: { ...VALID_CREATE, jurisdiction: 'usa' },
    });
    assert.equal(badJurisdiction.status, 400, JSON.stringify(badJurisdiction.json));

    const badKind = await call(server, 'POST', '/v1/subjects', {
      body: { ...VALID_CREATE, authorityGrant: { ...VALID_CREATE.authorityGrant, kind: 'GUARDIAN' } },
    });
    assert.equal(badKind.status, 422, JSON.stringify(badKind.json));
    assert.equal(codeOf(badKind), 'AUTHORITY_GRANT_INVALID');

    const badScope = await call(server, 'POST', '/v1/subjects', {
      body: { ...VALID_CREATE, authorityGrant: { ...VALID_CREATE.authorityGrant, scope: 'REMOVAL_REQUEST' } },
    });
    assert.equal(badScope.status, 400, JSON.stringify(badScope.json));
    await server.close();
  });

  test('a port refusal becomes the contract’s code, never a 201 and never a 500', async () => {
    const server = app();
    // The default stub answers EVIDENCE_NOT_FOUND, which is §5.1.1's own error for an artifact that does not
    // resolve: 422, not 404 (the id is malformed-or-absent, and the contract lists it under 422).
    const response = await call(server, 'POST', '/v1/subjects', { body: VALID_CREATE });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'EVIDENCE_NOT_FOUND');
    await server.close();
  });
});

describe('§5.1.4 request rules decided before the port', () => {
  test('the precondition is checked BEFORE the body, and a stale token is not required to be well formed', async () => {
    const server = app();
    // No If-Match, and a body that is ALSO inadmissible: the precondition answers first. The same ordering §5.6.1
    // was measured to have (ASSUMPTIONS §3.33 item 3), asserted here so the two write routes cannot drift apart.
    const missing = await call(server, 'PATCH', `/v1/subjects/${SUBJECT_ID}`, { body: { jurisdiction: 'US-NY' } });
    assert.equal(missing.status, 428, JSON.stringify(missing.json));
    assert.equal(codeOf(missing), 'PRECONDITION_REQUIRED');

    const notPatchable = await call(server, 'PATCH', `/v1/subjects/${SUBJECT_ID}`, {
      headers: { 'if-match': ETAG },
      body: { jurisdiction: 'US-NY' },
    });
    assert.equal(notPatchable.status, 422, JSON.stringify(notPatchable.json));
    assert.equal(codeOf(notPatchable), 'FIELD_NOT_PATCHABLE');

    const malformedContact = await call(server, 'PATCH', `/v1/subjects/${SUBJECT_ID}`, {
      headers: { 'if-match': ETAG },
      body: { contactPreference: { channel: 'EMAIL' } },
    });
    assert.equal(malformedContact.status, 400, JSON.stringify(malformedContact.json));
    assert.equal(codeOf(malformedContact), 'SCHEMA_VALIDATION_FAILED');
    await server.close();
  });

  test('a subject that does not resolve is 404, and a malformed id is 404 by the same rule', async () => {
    const server = app();
    const unknown = await call(server, 'PATCH', `/v1/subjects/${SUBJECT_ID}`, {
      headers: { 'if-match': ETAG },
      body: { isMinor: false },
    });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
    assert.equal(codeOf(unknown), 'RESOURCE_NOT_FOUND');

    const malformed = await call(server, 'PATCH', '/v1/subjects/not-a-uuid', {
      headers: { 'if-match': ETAG },
      body: { isMinor: false },
    });
    assert.equal(malformed.status, 404, JSON.stringify(malformed.json));
    await server.close();
  });
});
