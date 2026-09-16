/**
 * Idempotency boundary semantics (SPEC-003 §4.1–§4.5, VG-ACTION-001, VG-API-020).
 *
 * HONEST SCOPE, stated first: this suite runs against an IN-PROCESS store double, so it proves the
 * BOUNDARY LOGIC — replay, conflict, in-flight, refusal ordering, canonicalisation — and proves
 * NOTHING about durability, cross-process atomicity, or retention expiry. Those need real PostgreSQL
 * and are asserted by `tests/db/idempotency-store.test.ts` under `gate-data`.
 *
 * The tests drive a REAL Fastify instance through `app.inject`, not the plugin's functions directly.
 * That matters because the plugin installs two hooks whose ORDER is the contract: a claim that ran
 * after the handler would be a claim that could not prevent the effect.
 *
 * TWO PROPERTIES ARE THE POINT, and everything else supports them:
 *
 *   1. **A replay produces no second effect.** The handler is counted, so "the effect happened once"
 *      is measured rather than inferred from a status code.
 *   2. **The refusal happens BEFORE any work.** SPEC-003 §4.1 says a required route arriving without
 *      the header "produces no state change"; the counter proves it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../../src/http/server.ts';
import { canonicalise, fingerprintOf, validateIdempotencyKey } from '../../src/http/plugins/idempotency.ts';
import {
  testIdentity,
  testTenancy,
  TEST_TOKEN,
  testServerDependencies,
} from './server-support.ts';
import { recordingStore, type RecordingIdempotencyStore } from './idempotency-support.ts';
import type { IdempotencyRequirement } from '../../src/http/plugins/idempotency.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const VALID_KEY = 'idem-key-00000000000001';
const OTHER_KEY = 'idem-key-00000000000002';

/** Build a server whose only route is an effect-bearing test route. */
function effectServer(options: {
  store: RecordingIdempotencyStore;
  requirement?: IdempotencyRequirement;
  tenantId?: string;
  /** Called once per ACTUAL handler invocation, so a replay is visible as a non-increment. */
  onEffect: () => void;
  /** When set, the handler throws this instead of succeeding. */
  failWith?: Error;
}) {
  const requirement = options.requirement ?? 'required';
  const app = buildServer(testServerDependencies({
    identity: testIdentity({ tenantId: options.tenantId ?? TENANT_A }),
    tenancy: testTenancy().runner,
    idempotency: {
      store: options.store,
      requirementFor: (method, routeTemplate) =>
        method === 'POST' && routeTemplate === '/__test/effect' ? requirement : undefined,
    },
    health: {
      startedAt: new Date(),
      now: () => new Date(),
      probes: [async () => ({ name: 'stub', ok: true })],
    },
  }));

  app.post('/__test/effect', async (request, reply) => {
    const { withIdempotency } = await import('../../src/http/plugins/idempotency.ts');
    return withIdempotency(
      request,
      {
        store: options.store,
        requirementFor: (method, routeTemplate) =>
          method === 'POST' && routeTemplate === '/__test/effect' ? requirement : undefined,
      },
      reply,
      async () => {
        if (options.failWith !== undefined) throw options.failWith;
        options.onEffect();
        return { status: 201, body: { resourceId: 'res-1' }, resourceId: 'res-1' };
      },
    );
  });

  return app;
}

/** A plain POST with an optional key and body. */
async function post(
  app: ReturnType<typeof buildServer>,
  options: { key?: string; body?: unknown; method?: 'POST' | 'GET' } = {},
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TEST_TOKEN}`,
    'content-type': 'application/json',
  };
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  return app.inject({
    method: options.method ?? 'POST',
    url: '/__test/effect',
    headers,
    payload: JSON.stringify(options.body ?? { action: 'submit', caseId: 'case-1' }),
  });
}

describe('canonicalisation fingerprints semantically identical bodies equally (§4.2)', () => {
  test('key order does not change the fingerprint', () => {
    // An honest retry may serialise its body with a different key order. Refusing it as a conflict
    // would break the retry the mechanism exists to support.
    assert.equal(fingerprintOf({ a: 1, b: 2 }), fingerprintOf({ b: 2, a: 1 }));
    assert.equal(fingerprintOf({ z: 1, a: { y: 2, b: 3 } }), fingerprintOf({ a: { b: 3, y: 2 }, z: 1 }));
  });

  test('insignificant whitespace in the raw body does not change it', () => {
    // The fingerprint is over the PARSED body, so formatting is already gone.
    assert.equal(fingerprintOf(JSON.parse('{"a":1,"b":2}')), fingerprintOf(JSON.parse('{ "a" : 1 , "b" : 2 }')));
  });

  test('-0 and 0 fingerprint equally', () => {
    // They compare equal in JavaScript, so treating them as different would fingerprint the same
    // value two ways.
    assert.equal(fingerprintOf({ n: -0 }), fingerprintOf({ n: 0 }));
  });

  test('a semantically DIFFERENT body fingerprints differently', () => {
    // The other direction, and the one that matters for safety: if these collided, a caller could
    // change the request and silently receive the previous response.
    const different = [
      [{ a: 1 }, { a: 2 }],
      [{ a: '1' }, { a: 1 }],
      [{ a: true }, { a: 'true' }],
      [{ a: null }, { a: 'null' }],
      [{ a: [1, 2] }, { a: [2, 1] }],
      [{ a: 'A' }, { a: 'a' }],
      [{}, { a: 1 }],
      [{ a: { b: 1 } }, { a: { b: 1, c: 2 } }],
    ];
    for (const [left, right] of different) {
      assert.notEqual(
        fingerprintOf(left),
        fingerprintOf(right),
        `${JSON.stringify(left)} and ${JSON.stringify(right)} must not collide`,
      );
    }
  });

  test('an undefined member is dropped, so it does NOT change the fingerprint', () => {
    // JSON cannot express `undefined`, so a caller cannot send `{b: undefined}` as a distinct body.
    // Treating it as different would make the fingerprint depend on a JavaScript detail rather than
    // on the request, and the same body would fingerprint two ways across clients.
    assert.equal(fingerprintOf({ a: 1 }), fingerprintOf({ a: 1, b: undefined }));
  });

  test('array order is significant, because it is a different request', () => {
    assert.notEqual(fingerprintOf([1, 2]), fingerprintOf([2, 1]));
  });

  test('canonicalise is deterministic across repeated calls', () => {
    const value = { b: [3, { z: 1, a: 2 }], a: 'x', c: null };
    const first = canonicalise(value);
    for (let i = 0; i < 10; i += 1) assert.equal(canonicalise(value), first);
  });
});

describe('the key shape of §4.2 is enforced', () => {
  test('a 16–255 character key of the permitted charset is accepted', () => {
    assert.equal(validateIdempotencyKey('a'.repeat(16)), 'a'.repeat(16));
    assert.equal(validateIdempotencyKey('a'.repeat(255)), 'a'.repeat(255));
    assert.equal(validateIdempotencyKey('A-Z.a_z:0-9-abcdef'), 'A-Z.a_z:0-9-abcdef');
  });

  test('a key shorter than 16 characters is refused', () => {
    // The MINIMUM matters: a 3-character key has so little entropy that two clients collide, and the
    // second request would be replayed against the first's response.
    for (const short of ['a', 'abc', 'a'.repeat(15)]) {
      assert.throws(() => validateIdempotencyKey(short), /16-255/);
    }
  });

  test('an over-long key is refused at the SPEC bound of 255', () => {
    assert.throws(() => validateIdempotencyKey('a'.repeat(256)), /16-255/);
  });

  test('a key with a character outside the permitted set is refused', () => {
    for (const bad of ['a'.repeat(15) + ' ', 'a'.repeat(15) + '/', 'a'.repeat(15) + '@', 'a'.repeat(15) + '\n', 'a'.repeat(15) + '+']) {
      assert.throws(() => validateIdempotencyKey(bad), /16-255/, `${JSON.stringify(bad)} must be refused`);
    }
  });

  test('an absent key is refused', () => {
    assert.throws(() => validateIdempotencyKey(undefined), /16-255/);
  });
});

describe('a replayed key returns the original response and produces no second effect (§4.3)', () => {
  test('the second identical request replays with the marker header', async () => {
    const store = recordingStore();
    let effects = 0;
    const app = effectServer({ store, onEffect: () => { effects += 1; } });

    const first = await post(app, { key: VALID_KEY, body: { action: 'submit' } });
    assert.equal(first.statusCode, 201);
    assert.equal(effects, 1, 'the first request performs the effect');

    const second = await post(app, { key: VALID_KEY, body: { action: 'submit' } });
    assert.equal(second.statusCode, 201, 'the ORIGINAL status is returned');
    assert.equal(second.body, first.body, 'the ORIGINAL body is returned byte for byte');
    assert.equal(second.headers['idempotency-replayed'], 'true');
    assert.equal(effects, 1, 'a replay MUST NOT perform a second effect');

    await app.close();
  });

  test('a third replay is still one effect', async () => {
    const store = recordingStore();
    let effects = 0;
    const app = effectServer({ store, onEffect: () => { effects += 1; } });
    for (let i = 0; i < 5; i += 1) await post(app, { key: VALID_KEY, body: { action: 'submit' } });
    assert.equal(effects, 1);
    await app.close();
  });

  test('the replay body is the STORED text, not a re-serialisation', async () => {
    // A reparse could reorder keys and change the bytes a client sees; the contract is verbatim.
    const store = recordingStore();
    const app = effectServer({ store, onEffect: () => {} });
    const first = await post(app, { key: VALID_KEY, body: { action: 'submit' } });
    const second = await post(app, { key: VALID_KEY, body: { action: 'submit' } });
    assert.equal(second.body, first.body);
    assert.equal(store.entries.size, 1);
    await app.close();
  });

  test('a DIFFERENT key performs its own effect', async () => {
    const store = recordingStore();
    let effects = 0;
    const app = effectServer({ store, onEffect: () => { effects += 1; } });
    await post(app, { key: VALID_KEY, body: { action: 'submit' } });
    await post(app, { key: OTHER_KEY, body: { action: 'submit' } });
    assert.equal(effects, 2, 'two distinct keys are two intended effects');
    await app.close();
  });

  test('a semantically identical body with different formatting replays', async () => {
    const store = recordingStore();
    let effects = 0;
    const app = effectServer({ store, onEffect: () => { effects += 1; } });
    const first = await app.inject({
      method: 'POST',
      url: '/__test/effect',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': VALID_KEY },
      payload: '{"action":"submit","n":1}',
    });
    const second = await app.inject({
      method: 'POST',
      url: '/__test/effect',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': VALID_KEY },
      payload: '{ "n" : 1 , "action" : "submit" }',
    });
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(second.headers['idempotency-replayed'], 'true', 'a reformatted retry must replay');
    assert.equal(effects, 1);
    await app.close();
  });
});

describe('a different body under the same key is a conflict, not a replay (§4.3)', () => {
  test('a changed body is refused 409 IDEMPOTENCY_KEY_REUSE', async () => {
    const store = recordingStore();
    let effects = 0;
    const app = effectServer({ store, onEffect: () => { effects += 1; } });
    await post(app, { key: VALID_KEY, body: { action: 'submit', caseId: 'case-1' } });

    const conflict = await post(app, { key: VALID_KEY, body: { action: 'submit', caseId: 'case-2' } });
    assert.equal(conflict.statusCode, 409);
    const envelope = JSON.parse(conflict.body) as { error: { code: string } };
    assert.equal(envelope.error.code, 'IDEMPOTENCY_KEY_REUSE');
    assert.equal(effects, 1, 'a conflict MUST NOT perform a second effect');
    await app.close();
  });

  test('the conflict body carries the scope policy binding, not the offending values', async () => {
    // SPEC-003 §8.3 forbids echoing request values. The key is echoed because the caller supplied it
    // and already knows it; the BODY is not.
    const store = recordingStore();
    const app = effectServer({ store, onEffect: () => {} });
    await post(app, { key: VALID_KEY, body: { action: 'submit', secretish: 'do-not-echo' } });
    const conflict = await post(app, { key: VALID_KEY, body: { action: 'submit', changed: 'do-not-echo-2' } });
    assert.equal(conflict.body.includes('do-not-echo'), false, 'a request body value was echoed');
    await app.close();
  });
});

describe('an in-flight key is refused with a retry hint (§4.3)', () => {
  test('a key held by an in-flight request is 409 IDEMPOTENCY_IN_FLIGHT with Retry-After', async () => {
    // Simulated by leaving a key IN_FLIGHT, which is exactly the state a slow first request leaves.
    const store = recordingStore();
    let effects = 0;
    const app = effectServer({ store, onEffect: () => { effects += 1; } });

    const scope = {
      tenantId: { value: TENANT_A } as never,
      method: 'POST',
      routeTemplate: '/__test/effect',
      idempotencyKey: VALID_KEY,
    };
    store.forceState(scope, { state: 'IN_FLIGHT', fingerprint: fingerprintOf({ action: 'submit' }), record: undefined });

    const res = await post(app, { key: VALID_KEY, body: { action: 'submit' } });
    assert.equal(res.statusCode, 409);
    const envelope = JSON.parse(res.body) as { error: { code: string; retryable: boolean } };
    assert.equal(envelope.error.code, 'IDEMPOTENCY_IN_FLIGHT');
    assert.equal(envelope.error.retryable, true, 'in-flight is retryable; a reused key is not');
    assert.equal(res.headers['retry-after'], '5');
    assert.equal(effects, 0, 'an in-flight key must not run the handler');
    await app.close();
  });
});

describe('refusals happen BEFORE any work (§4.1)', () => {
  test('a required route with no key is 400 IDEMPOTENCY_KEY_REQUIRED and runs nothing', async () => {
    const store = recordingStore();
    let effects = 0;
    const app = effectServer({ store, onEffect: () => { effects += 1; } });

    const res = await post(app, { body: { action: 'submit' } });
    assert.equal(res.statusCode, 400);
    const envelope = JSON.parse(res.body) as { error: { code: string } };
    assert.equal(envelope.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal(effects, 0, 'no state change may occur without the header');
    assert.equal(store.calls.length, 0, 'the store must not even be consulted');
    await app.close();
  });

  test('a malformed key is 400 IDEMPOTENCY_KEY_MALFORMED and runs nothing', async () => {
    const store = recordingStore();
    let effects = 0;
    const app = effectServer({ store, onEffect: () => { effects += 1; } });

    for (const bad of ['short', 'a'.repeat(256), 'has spaces here!!', 'has/slash/here!!']) {
      const res = await post(app, { key: bad, body: { action: 'submit' } });
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad)} must be refused`);
      const envelope = JSON.parse(res.body) as { error: { code: string } };
      assert.equal(envelope.error.code, 'IDEMPOTENCY_KEY_MALFORMED');
    }
    assert.equal(effects, 0);
    assert.equal(store.calls.length, 0);
    await app.close();
  });

  test('an optional route ignores the key, echoes it, and still runs', async () => {
    // SPEC-003 §4.3 last row: on a route where the key adds no protection it is ignored and echoed
    // for diagnosis.
    const store = recordingStore();
    let effects = 0;
    const app = effectServer({ store, requirement: 'optional', onEffect: () => { effects += 1; } });
    const res = await post(app, { key: VALID_KEY, body: { action: 'submit' } });
    assert.equal(res.statusCode, 201);
    assert.equal(effects, 1);
    assert.equal(res.headers['idempotency-key-echo'], VALID_KEY);
    await app.close();
  });

  test('an optional route without a key still runs', async () => {
    const store = recordingStore();
    let effects = 0;
    const app = effectServer({ store, requirement: 'optional', onEffect: () => { effects += 1; } });
    const res = await post(app, { body: { action: 'submit' } });
    assert.equal(res.statusCode, 201);
    assert.equal(effects, 1);
    await app.close();
  });
});

describe('the non-promotion rule is structural (§4.4)', () => {
  test('a replayed 2xx increments no counter, because nothing counts responses', async () => {
    // §4.4 forbids counting HTTP 2xx as effects. The strongest available evidence is that the plugin
    // holds no counter at all: the only observable count is the handler's own invocation, and a
    // replay does not invoke it.
    const store = recordingStore();
    let handlerInvocations = 0;
    const app = effectServer({ store, onEffect: () => { handlerInvocations += 1; } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await post(app, { key: VALID_KEY, body: { action: 'submit' } });
      statuses.push(res.statusCode);
    }
    assert.deepEqual(statuses, [201, 201, 201, 201], 'four 2xx responses');
    assert.equal(handlerInvocations, 1, 'but exactly ONE effect');
    await app.close();
  });
});

describe('the key scope is (tenant, method, routeTemplate, key) (§4.2)', () => {
  test('the same key under a DIFFERENT tenant is a different scope', async () => {
    // Cross-tenant key collision would let one tenant observe another's conflict body, which reports
    // the original resource id.
    const store = recordingStore();
    let effects = 0;

    const appA = effectServer({ store, tenantId: TENANT_A, onEffect: () => { effects += 1; } });
    await post(appA, { key: VALID_KEY, body: { action: 'submit' } });

    const appB = effectServer({ store, tenantId: TENANT_B, onEffect: () => { effects += 1; } });
    const res = await post(appB, { key: VALID_KEY, body: { action: 'submit' } });
    assert.equal(res.statusCode, 201, "another tenant's key must not shadow this one");
    assert.equal(effects, 2);
    assert.equal(store.entries.size, 2, 'two tenants are two scopes');
    await appA.close();
    await appB.close();
  });
});

describe('a pre-effect failure releases the key so the caller can retry', () => {
  test('a handler failure abandons the claim', async () => {
    const store = recordingStore();
    const app = effectServer({ store, onEffect: () => {}, failWith: new Error('transient failure') });
    const res = await post(app, { key: VALID_KEY, body: { action: 'submit' } });
    assert.equal(res.statusCode, 500);
    assert.ok(store.calls.includes(`abandon:${VALID_KEY}`), 'the key must be released');
    assert.equal(store.entries.size, 0, 'the key is free for a retry');
    await app.close();
  });

  test('the retry after a failure succeeds rather than being stuck in flight', async () => {
    // The reason `abandon` exists: without it a transient error leaves the key in flight forever and
    // the caller can never retry.
    const store = recordingStore();
    let effects = 0;
    let shouldFail = true;
    const app = buildServer(testServerDependencies({
      version: 't', commit: 't', logLevel: 'silent',
      identity: testIdentity(),
      tenancy: testTenancy().runner,
      idempotency: {
        store,
        requirementFor: (m, r) => (m === 'POST' && r === '/__test/effect' ? 'required' : undefined),
      },
      health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 's', ok: true })] },
    }));
    const { withIdempotency } = await import('../../src/http/plugins/idempotency.ts');
    app.post('/__test/effect', async (request, reply) =>
      withIdempotency(
        request,
        {
          store,
          requirementFor: (m, r) => (m === 'POST' && r === '/__test/effect' ? 'required' : undefined),
        },
        reply,
        async () => {
          if (shouldFail) throw new Error('transient');
          effects += 1;
          return { status: 201, body: { ok: true }, resourceId: 'res-1' };
        },
      ),
    );

    const failed = await post(app, { key: VALID_KEY, body: { action: 'submit' } });
    assert.equal(failed.statusCode, 500);
    shouldFail = false;
    const retried = await post(app, { key: VALID_KEY, body: { action: 'submit' } });
    assert.equal(retried.statusCode, 201, 'the retry must succeed');
    assert.equal(effects, 1);
    await app.close();
  });
});
