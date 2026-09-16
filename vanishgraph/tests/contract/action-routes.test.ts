/**
 * The §5.8 boundary rules, credential-free (SPEC-003 §5.8, §3.2).
 *
 * WHAT BELONGS HERE: the declarations and the vocabularies. The guard evaluation, the reconciliation's effect on
 * state, and the readback's independence check all need a database and live in `tests/db/action-records.test.ts`.
 *
 *   * The six routes exist with the scopes, step-up and idempotency §5.8.1–§5.8.6 declare — including that
 *     §5.8.2 alone carries a step-up, because it is the route that writes to the outside world.
 *   * The three vocabularies are the contract's, and the mail-status mapping is TOTAL over the column's
 *     admitted tokens, so an unmapped value cannot reach the wire as a synthesised status.
 *   * The body rules that apply before the port: an unknown channel, a payload field nobody allowlisted, a
 *     malformed message id, an unknown reconciliation method or finding.
 *   * The three reads are READ-ONLY.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import {
  testActionQueries,
  testIdentity,
  testServerDependencies,
  TEST_TOKEN,
} from './server-support.ts';
import { ROUTES } from '../../src/http/openapi/registry.ts';
import { isErrorCode } from '../../src/http/errors/code-registry.ts';
import {
  MAIL_DELIVERY_STATUS,
  READBACK_METHODS,
  RECONCILIATION_FINDINGS,
  RECONCILIATION_METHODS,
} from '../../src/application/contracts/action-queries.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '77777777-1111-4111-8111-777777777777';
const ACTION_ID = '55555555-1111-4111-8111-555555555555';
const SCOPES = ['vg.actions.read', 'vg.actions.execute'];

function app(scopes: readonly string[] = SCOPES): VgFastify {
  return buildServer(
    testServerDependencies({
      identity: testIdentity({ tenantId: TENANT_A, scopes }),
      actionQueries: testActionQueries(),
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
  if (method === 'POST') headers['idempotency-key'] = `action-contract-${CASE_ID.slice(0, 8)}`;
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

describe('§5.8 is declared as the registry says it is', () => {
  test('the six routes carry the specified scopes, methods, step-up and idempotency', () => {
    const expected: readonly [string, string, string, string, boolean, string][] = [
      ['5.8.1', 'GET', '/v1/cases/{caseId}/external-actions', 'vg.actions.read', false, 'optional'],
      ['5.8.2', 'POST', '/v1/cases/{caseId}/external-actions', 'vg.actions.execute', true, 'required'],
      ['5.8.3', 'POST', '/v1/external-actions/{externalActionId}/reconciliations', 'vg.actions.execute', false, 'required'],
      ['5.8.4', 'POST', '/v1/external-actions/{externalActionId}/readback', 'vg.actions.execute', false, 'required'],
      ['5.8.5', 'GET', '/v1/external-actions/{externalActionId}', 'vg.actions.read', false, 'optional'],
      ['5.8.6', 'GET', '/v1/cases/{caseId}/mail-pieces', 'vg.actions.read', false, 'optional'],
    ];
    for (const [id, method, path, scope, stepUp, idempotency] of expected) {
      const route = ROUTES.find((candidate) => candidate.id === id);
      assert.ok(route !== undefined, `${id} is not in the registry`);
      assert.equal(route.method, method, id);
      assert.equal(route.path, path, id);
      assert.deepEqual(route.scopes, [scope], id);
      // §5.8.2 is the route that writes to the outside world, and the registry marks it as the only one here
      // that needs a fresh authentication (§3.2 item 7).
      assert.equal(route.stepUp, stepUp, id);
      assert.equal(route.idempotency, idempotency, id);
    }
  });

  test('the three reads are read-only', async () => {
    const server = app();
    for (const [url, method] of [
      [`/v1/cases/${CASE_ID}/external-actions`, 'PATCH'],
      [`/v1/cases/${CASE_ID}/external-actions`, 'DELETE'],
      [`/v1/external-actions/${ACTION_ID}`, 'DELETE'],
      [`/v1/cases/${CASE_ID}/mail-pieces`, 'PATCH'],
    ] as const) {
      const response = await call(server, method, url, { body: {} });
      assert.ok(
        response.status === 404 || response.status === 405,
        `${method} ${url} answered ${String(response.status)}`,
      );
    }
    await server.close();
  });

  test('a caller without vg.actions.execute is refused 403 on the three writes', async () => {
    const server = app(['vg.actions.read']);
    const writes: readonly [string, unknown][] = [
      [`/v1/cases/${CASE_ID}/external-actions`, { channel: 'OFFICIAL_SELF_SERVICE' }],
      [`/v1/external-actions/${ACTION_ID}/reconciliations`, { reconciliationMethod: 'PROVIDER_API_LOOKUP' }],
      [`/v1/external-actions/${ACTION_ID}/readback`, { observationMethod: 'PROVIDER_API' }],
    ];
    for (const [url, body] of writes) {
      const response = await call(server, 'POST', url, { body });
      assert.equal(response.status, 403, `${url} answered ${String(response.status)}`);
      assert.equal(codeOf(response), 'INSUFFICIENT_SCOPE');
    }
    await server.close();
  });
});

describe('§5.8 vocabularies are the contract’s, and total', () => {
  test('the reconciliation and readback vocabularies are exactly §5.8.3/§5.8.4’s', () => {
    assert.deepEqual([...RECONCILIATION_METHODS], [
      'PROVIDER_API_LOOKUP',
      'MAIL_TRACKING_LOOKUP',
      'CONTROLLER_CONTACT_CONFIRMATION',
    ]);
    assert.deepEqual([...RECONCILIATION_FINDINGS], ['EFFECT_CONFIRMED', 'EFFECT_ABSENT', 'INDETERMINATE']);
    assert.deepEqual([...READBACK_METHODS], [
      'PROVIDER_API',
      'INDEPENDENT_FETCH_DIFFERENT_EGRESS',
      'SECOND_CONTROLLER_CHANNEL',
    ]);
  });

  test('the mail-status mapping is TOTAL over both admitted vocabularies', () => {
    // §5.8.6 renders five tokens; the column admits seven (migration 0026 widened it rather than replacing any).
    // Every stored token must map, or a piece would reach the wire as a status nobody declared.
    for (const stored of ['NOT_SENT', 'SENT', 'ACCEPTED', 'IN_TRANSIT', 'DELIVERED', 'RETURNED', 'UNKNOWN']) {
      assert.ok(MAIL_DELIVERY_STATUS[stored] !== undefined, `${stored} has no wire mapping`);
    }
    for (const wire of ['ACCEPTED', 'IN_TRANSIT', 'DELIVERED', 'RETURNED', 'UNKNOWN']) {
      assert.ok(Object.values(MAIL_DELIVERY_STATUS).includes(wire), `${wire} is unreachable`);
    }
  });

  test('every code these routes emit is registered (H-7)', () => {
    for (const code of [
      'ACTION_NOT_AMBIGUOUS',
      'PAYLOAD_FIELD_NOT_ALLOWLISTED',
      'TEMPLATE_HASH_REQUIRED',
      'HUMAN_GATE_OPEN',
      'EFFECT_BUDGET_EXCEEDED',
      'RECIPE_DISABLED',
      'RECIPE_STALE',
      'SOURCE_PERMISSION_UNCLEAR',
      'CHANNEL_PRIORITY_VIOLATION',
      'DEPENDENCY_UNAVAILABLE',
      'OBSERVATION_PATH_NOT_INDEPENDENT',
      'INVALID_CURSOR',
    ]) {
      assert.equal(isErrorCode(code), true, `${code} must be in the registry`);
    }
  });
});

describe('§5.8 request rules decided before the port', () => {
  test('a channel outside the declared set is refused, and a payload field is checked against the allowlist', async () => {
    const server = app();
    const badChannel = await call(server, 'POST', `/v1/cases/${CASE_ID}/external-actions`, {
      // A well-formed §2.7 ETag: `"<token>:<version>"`. A malformed one is refused 412 before the body is read,
      // which is a different assertion — the next test makes it.
      headers: { 'if-match': '"REQUEST_READY:1"' },
      body: { channel: 'CARRIER_PIGEON' },
    });
    assert.equal(badChannel.status, 400, JSON.stringify(badChannel.json));
    assert.equal(codeOf(badChannel), 'SCHEMA_VALIDATION_FAILED');

    // The port is a stub that refuses everything, so reaching it is what proves the request passed validation —
    // and a NOT_FOUND answer is that proof.
    const reached = await call(server, 'POST', `/v1/cases/${CASE_ID}/external-actions`, {
      headers: { 'if-match': '"REQUEST_READY:1"' },
      body: {
        channel: 'OFFICIAL_SELF_SERVICE',
        recipeId: '55555555-1111-4111-8111-555555555555',
        recipeVersion: 1,
        authorityGrantId: '66666666-1111-4111-8111-666666666666',
        policyDecisionId: '77777777-1111-4111-8111-777777777777',
        idempotencyKey: `contract-${CASE_ID.slice(0, 8)}`,
      },
    });
    assert.equal(reached.status, 404, JSON.stringify(reached.json));
    await server.close();
  });

  test('the preconditions are enforced before the body decides anything', async () => {
    const server = app();
    const missing = await call(server, 'POST', `/v1/cases/${CASE_ID}/external-actions`, {
      body: { channel: 'CARRIER_PIGEON' },
    });
    assert.equal(missing.status, 428, JSON.stringify(missing.json));
    assert.equal(codeOf(missing), 'PRECONDITION_REQUIRED');

    const stale = await call(server, 'POST', `/v1/cases/${CASE_ID}/external-actions`, {
      headers: { 'if-match': 'garbage' },
      body: { channel: 'CARRIER_PIGEON' },
    });
    assert.equal(stale.status, 412, JSON.stringify(stale.json));
    assert.equal(codeOf(stale), 'PRECONDITION_FAILED');
    await server.close();
  });

  test('an unknown reconciliation method or finding is refused', async () => {
    const server = app();
    for (const body of [
      { reconciliationMethod: 'VIBES', finding: 'EFFECT_CONFIRMED', observedAt: '2026-02-01T00:00:00.000Z' },
      { reconciliationMethod: 'PROVIDER_API_LOOKUP', finding: 'MAYBE', observedAt: '2026-02-01T00:00:00.000Z' },
    ]) {
      const response = await call(server, 'POST', `/v1/external-actions/${ACTION_ID}/reconciliations`, { body });
      assert.equal(response.status, 400, JSON.stringify(response.json));
      assert.equal(codeOf(response), 'SCHEMA_VALIDATION_FAILED');
    }
    await server.close();
  });

  test('an unknown readback method is refused', async () => {
    const server = app();
    const response = await call(server, 'POST', `/v1/external-actions/${ACTION_ID}/readback`, {
      body: { observationMethod: 'LOOKING_AT_IT', requestedAt: '2026-02-01T00:00:00.000Z' },
    });
    assert.equal(response.status, 400, JSON.stringify(response.json));
    await server.close();
  });
});
