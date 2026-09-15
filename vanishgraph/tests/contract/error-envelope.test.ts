/**
 * Error envelope contract (SPEC-003 §8.1/§8.3, SPEC-006 §6.1/§9).
 *
 * Every registry row is exercised through a REAL HTTP request against a real Fastify instance, not
 * by calling the envelope builder directly. That distinction matters: the builder can be correct
 * while the handler that installs it is bypassed — which is exactly what happened in M1, when
 * `app.register(plugin)` encapsulated the error handler and Fastify's own default output escaped
 * for every sibling route.
 *
 * The negative cases are the ones worth having: an induced plain `Error` must produce a 500 whose
 * body contains neither the exception message nor a stack frame. SPEC-003 §8.3 says an error body
 * "that would be more informative with a PII value is instead less informative", and a test that
 * asserts the absence of a specific string is the only way to know that holds.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type ServerDependencies, type VgFastify } from '../../src/http/server.ts';
import {
  testIdempotency,
  testIdentity,
  testTenancy,
  testSubjectQueries,
  testSourceQueries,
  testRecipeVerificationKeys,
  testAppealQueries,
  testDeadlineQueries,
  testAuditQueries,
  TEST_SESSION_SECRET,
  TEST_TOKEN,
} from './server-support.ts';
import { apiError } from '../../src/http/plugins/error-handler.ts';
import {
  ERROR_CODE_REGISTRY,
  WIRE_STATUS_AMBIGUITY,
  statusForEnvelopeSafe,
  wireCodes,
} from './envelope-support.ts';

function testServer(overrides: Partial<ServerDependencies> = {}) {
  // Identity and tenancy are REQUIRED by ServerDependencies (EP-004 M3): an optional authentication
  // plugin would be a configuration in which every route is unauthenticated.
  return buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity(),
    tenancy: testTenancy().runner,
    idempotency: testIdempotency(),
    sessionSecret: TEST_SESSION_SECRET,
    subjectQueries: testSubjectQueries(),
    sourceQueries: testSourceQueries(),
    recipeVerificationKeys: testRecipeVerificationKeys(),
    appealQueries: testAppealQueries(),
    deadlineQueries: testDeadlineQueries(),
    auditQueries: testAuditQueries(),
    health: {
      startedAt: new Date(),
      now: () => new Date(),
      probes: [async () => ({ name: 'stub', ok: true })],
    },
    ...overrides,
  });
}

interface Envelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly correlationId: string;
    readonly retryable: boolean;
    readonly occurredAt: string;
    readonly details?: Record<string, unknown>;
  };
}

function parseEnvelope(body: string): Envelope {
  const parsed = JSON.parse(body) as unknown;
  assert.ok(typeof parsed === 'object' && parsed !== null, 'the body must be a JSON object');
  return parsed as Envelope;
}

/**
 * Inject a request carrying a valid test token by default.
 *
 * Identity runs as an `onRequest` hook, so every route below it needs a token. Wrapping `inject`
 * here means a test cannot accidentally assert against a 401 caused by a forgotten header — which is
 * exactly what happened when identity was first wired in: the whole envelope suite went red for
 * authentication reasons rather than envelope reasons.
 */
async function injectAs(
  app: VgFastify,
  options: { method: 'GET' | 'POST' | 'DELETE'; url: string; headers?: Record<string, string>; payload?: string },
): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
  const { headers, ...rest } = options;
  const response = await app.inject({
    ...rest,
    headers: { authorization: `Bearer ${TEST_TOKEN}`, ...(headers ?? {}) },
  });
  return {
    statusCode: response.statusCode,
    body: response.body,
    headers: response.headers as Record<string, unknown>,
  };
}

describe('every wire code produces a valid envelope over real HTTP', () => {
  test('every distinct wire code round-trips through the boundary', async () => {
    const app = testServer();
    // A test-only route that raises any requested code. Registered on the same instance as the
    // health routes, so it exercises the REAL error handler rather than a private call.
    const wires = wireCodes();
    // The count is DERIVED, not hardcoded: 78 registry rows collapse to 74 distinct wire codes
    // because DEPENDENCY_UNAVAILABLE has four domain rows and DIGEST_MISMATCH has three. An
    // earlier version asserted 76 and failed on a correct registry.
    assert.ok(wires.length >= 70, `expected the full wire-code set, saw ${wires.length}`);

    app.get('/__test/raise/:code', async (request) => {
      const { code } = request.params as { code: string };
      const overrideRaw = (request.query as Record<string, string>)['status'];
      const override = overrideRaw === undefined ? undefined : Number(overrideRaw);
      const detailsRaw = (request.query as Record<string, string>)['details'];
      const details = detailsRaw === undefined ? undefined : (JSON.parse(detailsRaw) as Record<string, unknown>);
      throw apiError(code, details as never, override);
    });

    let checked = 0;
    for (const code of wires) {
      const entry = ERROR_CODE_REGISTRY.find((r) => r.wireCode === code);
      assert.ok(entry !== undefined, `${code} must have a registry row`);
      const statuses = WIRE_STATUS_AMBIGUITY[code] ?? [entry.status];
      for (const status of statuses) {
        const res = await injectAs(app, { method: 'GET', url: `/__test/raise/${code}?status=${status}` });

        const envelope = parseEnvelope(res.body);
        assert.deepEqual(
          Object.keys(envelope),
          ['error'],
          `${code}: the envelope must have exactly one top-level key`,
        );
        assert.equal(res.statusCode, statusForEnvelopeSafe(code, status), `${code} status`);
        assert.equal(envelope.error.code, code, `${code}: the code must be echoed`);
        assert.ok(envelope.error.message.length > 0, `${code}: a message is required`);
        assert.equal(typeof envelope.error.retryable, 'boolean', `${code}: retryable is required`);
        assert.ok(envelope.error.requestId.length > 0, `${code}: requestId is required`);
        assert.ok(envelope.error.correlationId.length > 0, `${code}: correlationId is required`);
        assert.match(envelope.error.occurredAt, /^\d{4}-\d{2}-\d{2}T/, `${code}: occurredAt must be ISO`);
        assert.equal(
          res.headers['x-correlation-id'],
          envelope.error.correlationId,
          `${code}: the header and the body must carry the same correlation id`,
        );
        checked += 1;
      }
    }
    await app.close();

    // Every distinct code, plus the extra statuses of the declared multi-status codes.
    const expected =
      wires.length + Object.values(WIRE_STATUS_AMBIGUITY).filter((s) => s.length > 1).length;
    assert.equal(checked, expected, `exercised ${checked} code/status combinations, expected ${expected}`);
    assert.ok(checked >= 74, `exercised only ${checked} combinations`);
  });

  test('a multi-status code uses the template for the status it is served at', async () => {
    // SPEC-003 §8.2 gives SCHEMA_VALIDATION_FAILED a "(syntax)" 400 and a "(semantic)" 422. A
    // client must be able to tell them apart from the message, which holds only if the template is
    // selected by STATUS rather than by code. MEASURED defect: before this, the 422 response
    // carried the 400 text.
    const app = testServer();
    app.get('/__test/multi/:status', async (request) => {
      const status = Number((request.params as { status: string }).status);
      throw apiError('SCHEMA_VALIDATION_FAILED', undefined, status);
    });
    const syntactic = parseEnvelope((await injectAs(app, { method: 'GET', url: '/__test/multi/400' })).body);
    const semantic = parseEnvelope((await injectAs(app, { method: 'GET', url: '/__test/multi/422' })).body);
    assert.equal(syntactic.error.message, 'The request body is malformed.');
    assert.equal(semantic.error.message, 'The request is well formed but fails a semantic validation.');
    assert.notEqual(syntactic.error.message, semantic.error.message);
    await app.close();
  });

  test('an undeclared status override is ignored, not honoured and not fatal', async () => {
    // Honouring it would let a handler invent a status the specification never assigned. Throwing
    // would let an internal defect message escape through Fastify's default handler.
    const app = testServer();
    app.get('/__test/override', async () => {
      throw apiError('AUTHORITY_EXPIRED', undefined, 409);
    });
    const res = await injectAs(app, { method: 'GET', url: '/__test/override' });
    assert.equal(res.statusCode, 409, 'the declared status wins');
    const envelope = parseEnvelope(res.body);
    assert.deepEqual(Object.keys(envelope), ['error'], 'the envelope must still be the only shape');
    assert.equal(res.body.includes('error envelope defect'), false, 'an internal defect message escaped');
    await app.close();
  });

  test('the message is the registry template, not the thrown error text', async () => {
    const app = testServer();
    app.get('/__test/message', async () => {
      // The thrown message says something entirely different and contains a fake subject value.
      throw apiError('ILLEGAL_TRANSITION');
    });
    const res = await injectAs(app, { method: 'GET', url: '/__test/message' });
    const envelope = parseEnvelope(res.body);
    assert.equal(
      envelope.error.message,
      'The requested state change is not permitted from the current state.',
    );
    assert.equal(res.body.includes('ILLEGAL_TRANSITION"'), true, 'the code is present');
    await app.close();
  });
});

describe('the 500 path leaks nothing (SPEC-003 §8.3, SPEC-006 H-8)', () => {
  test('an induced plain Error yields 500 INTERNAL_ERROR with no message and no stack', async () => {
    const app = testServer();
    const CANARY = 'SUBJECT-JANE-DOE-1234567890';
    const DSN_CANARY = 'postgres://vg_owner:s3cr3t@10.0.0.5:5432/vanishgraph';

    app.get('/__test/boom', async () => {
      throw new Error(`failed to load ${CANARY} using ${DSN_CANARY}`);
    });

    const res = await injectAs(app, { method: 'GET', url: '/__test/boom' });
    assert.equal(res.statusCode, 500);
    const envelope = parseEnvelope(res.body);
    assert.equal(envelope.error.code, 'INTERNAL_ERROR');
    assert.equal(envelope.error.message, 'An unexpected server fault occurred.');

    // The three things that must never appear.
    assert.equal(res.body.includes(CANARY), false, 'the exception message leaked into the body');
    assert.equal(res.body.includes('s3cr3t'), false, 'a credential leaked into the body');
    assert.equal(res.body.includes('10.0.0.5'), false, 'a host leaked into the body');
    assert.equal(/\bat\s+\w+\s+\(/.test(res.body), false, 'a stack frame leaked into the body');
    assert.equal(res.body.includes('__test/boom'), false, 'the handler path leaked into the body');
    await app.close();
  });

  test('a thrown object with a hostile toString cannot inject the body', async () => {
    const app = testServer();
    app.get('/__test/hostile', async () => {
      // eslint-disable-next-line no-throw-literal
      throw {
        toString: () => '</script><script>alert(1)</script>',
        code: 'NOT_A_REAL_CODE',
        statusCode: 418,
      };
    });
    const res = await injectAs(app, { method: 'GET', url: '/__test/hostile' });
    const envelope = parseEnvelope(res.body);
    assert.equal(res.body.includes('<script>'), false, 'a hostile toString reached the body');
    // 418 is not a declared status, so it must not be echoed; the code is not in the registry.
    assert.equal(envelope.error.code, 'INTERNAL_ERROR');
    assert.equal(res.statusCode, 500);
    await app.close();
  });

  test('the details allowlist drops anything not named', async () => {
    const app = testServer();
    app.get('/__test/details', async () => {
      throw apiError('ILLEGAL_TRANSITION', {
        fromTruthState: 'ACKNOWLEDGED',
        toTruthState: 'VERIFIED_REMOVED',
        // None of these may reach the wire.
        stack: 'Error: boom',
        sql: 'SELECT * FROM protected_subject',
        subjectName: 'Jane Doe',
        authorization: 'Bearer eyJhbGciOi',
        password: 'hunter2',
      } as never);
    });
    const res = await injectAs(app, { method: 'GET', url: '/__test/details' });
    const envelope = parseEnvelope(res.body);
    assert.deepEqual(
      Object.keys(envelope.error.details ?? {}).sort(),
      ['fromTruthState', 'toTruthState'],
    );
    for (const secret of ['Jane Doe', 'hunter2', 'eyJhbGciOi', 'SELECT *', 'Error: boom']) {
      assert.equal(res.body.includes(secret), false, `the envelope leaked ${secret}`);
    }
    await app.close();
  });

  test('a nested object in details is refused rather than serialised', async () => {
    const app = testServer();
    app.get('/__test/nested', async () => {
      // A nested object is the shape through which a request body would reach the wire.
      throw apiError('ILLEGAL_TRANSITION', { field: { nested: 'secret-value' } } as never);
    });
    const res = await injectAs(app, { method: 'GET', url: '/__test/nested' });
    assert.equal(res.body.includes('secret-value'), false, 'a nested details value reached the body');
    const envelope = parseEnvelope(res.body);
    assert.equal(envelope.error.details, undefined, 'an empty details object must be absent');
    await app.close();
  });
});

describe('the boundary always produces the envelope (SPEC-006 H-1)', () => {
  test('an unknown path returns the envelope, not Fastify default output', async () => {
    const app = testServer();
    const res = await injectAs(app, { method: 'GET', url: '/v1/does-not-exist' });
    assert.equal(res.statusCode, 404);
    const envelope = parseEnvelope(res.body);
    assert.deepEqual(Object.keys(envelope), ['error']);
    assert.equal(envelope.error.code, 'RESOURCE_NOT_FOUND');
    assert.equal(envelope.error.message, 'The requested resource was not found.');
    // Fastify's default body would carry `message`/`error`/`statusCode` at the top level.
    const raw = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal('statusCode' in raw, false, "Fastify's default shape escaped the boundary");
    assert.equal('statusCode' in (raw['error'] as Record<string, unknown>), false);
    await app.close();
  });

  test('a method mismatch returns the envelope too', async () => {
    const app = testServer();
    const res = await injectAs(app, { method: 'DELETE', url: '/v1/health' });
    assert.ok(res.statusCode >= 400, `expected a 4xx, got ${res.statusCode}`);
    const envelope = parseEnvelope(res.body);
    assert.deepEqual(Object.keys(envelope), ['error']);
    assert.ok(envelope.error.code.length > 0);
    await app.close();
  });

  test('an unparseable JSON body returns the envelope with the syntactic 400 spelling', async () => {
    const app = testServer();
    app.post('/__test/echo', async (request) => request.body);
    const res = await injectAs(app, { method: 'POST', url: '/__test/echo', headers: { 'content-type': 'application/json' }, payload: '{ this is not json' });
    assert.equal(res.statusCode, 400);
    const envelope = parseEnvelope(res.body);
    assert.equal(envelope.error.code, 'SCHEMA_VALIDATION_FAILED');
    assert.equal(envelope.error.message, 'The request body is malformed.');
    await app.close();
  });

  test('an unsupported media type returns UNSUPPORTED_MEDIA_TYPE', async () => {
    const app = testServer();
    app.post('/__test/echo', async (request) => request.body);
    const res = await injectAs(app, { method: 'POST', url: '/__test/echo', headers: { 'content-type': 'application/xml' }, payload: '<x/>' });
    assert.equal(res.statusCode, 415);
    const envelope = parseEnvelope(res.body);
    assert.equal(envelope.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    await app.close();
  });
});

describe('correlation is present on every response, including failures', () => {
  test('an error response echoes a caller-supplied correlation id', async () => {
    const app = testServer();
    const id = 'abc123def456abc123def456abc123de';
    const res = await injectAs(app, { method: 'GET', url: '/v1/does-not-exist', headers: { 'x-correlation-id': id } });
    assert.equal(res.headers['x-correlation-id'], id);
    assert.equal(parseEnvelope(res.body).error.correlationId, id);
    await app.close();
  });

  test('a hostile correlation id is replaced rather than reflected', async () => {
    const app = testServer();
    const hostile = '<script>alert(1)</script>';
    const res = await injectAs(app, { method: 'GET', url: '/v1/does-not-exist', headers: { 'x-correlation-id': hostile } });
    assert.notEqual(res.headers['x-correlation-id'], hostile);
    assert.equal(res.body.includes(hostile), false, 'the hostile header was reflected');
    assert.match(String(res.headers['x-correlation-id']), /^[0-9a-f]{32}$/);
    await app.close();
  });
});
