/**
 * The HTTP request boundary: `If-Match`/ETag handling and the raw-body capture (SPEC-003 §2.7, §6.1; EP-007 M1).
 *
 * WHY THIS SUITE EXISTS. `scripts/coverage-gate.sh` measures the `http` layer, and its first honest run put the layer at
 * 74.39% of functions against a target of 75 — with `src/http/routes/preconditions.ts` at 60% and
 * `src/http/plugins/raw-body.ts` at 25%. The thresholds are not lowered to obtain a pass (DOD-027), so the missing
 * behaviours were looked for, and both files turned out to hold a real, unasserted boundary rule:
 *
 *   * the ETag FORMAT is produced by one function and consumed by another, and nothing asserted that the two agree —
 *     a round trip is what makes "stale `If-Match` is `412`" mean anything;
 *   * the raw-body capture is the input to the webhook signature (`HMAC` over the exact bytes), and NOTHING in the
 *     `http` layer's own suites ever drove a request through it, because the ingress suites live under `tests/db`.
 *
 * Both are asserted here against the real modules and a real Fastify instance, and the assertions are about behaviour a
 * reader can check rather than about the lines they happen to execute.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import Fastify from 'fastify';

import { buildServer, listen } from '../../src/http/server.ts';
import { testServerDependencies } from './server-support.ts';
import {
  epochMillisFromIfMatch,
  etagFor,
  ifMatchHeader,
  integerVersionFromIfMatch,
} from '../../src/http/routes/preconditions.ts';
import { ApiError } from '../../src/http/plugins/error-handler.ts';
import { WEBHOOK_MAX_BODY_BYTES, isOversized, rawBodyPlugin } from '../../src/http/plugins/raw-body.ts';

/** The refusal a call produced, or `undefined` when it did not refuse. */
function refusalOf(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('the ETag builder and the If-Match parser are one contract (SPEC-003 §2.7)', () => {
  test('what etagFor produces, epochMillisFromIfMatch recovers — the round trip the comparison depends on', () => {
    const epochMillis = 1_760_000_000_123;
    for (const truthState of ['REQUEST_SUBMITTED', 'VERIFIED_REMOVED', 'HUMAN_REQUIRED']) {
      const etag = etagFor(truthState, epochMillis);
      assert.equal(etag, `"${truthState}:${String(epochMillis)}"`, 'the shape is quoted state colon instant');
      assert.equal(epochMillisFromIfMatch(etag), epochMillis, `${truthState} must survive the round trip`);
      // AND THE UNQUOTED FORM IS ACCEPTED TOO, because a caller may send the bare value and RFC 9110 permits it.
      assert.equal(epochMillisFromIfMatch(`${truthState}:${String(epochMillis)}`), epochMillis);
      assert.equal(epochMillisFromIfMatch(`  ${etag}  `), epochMillis, 'surrounding whitespace is not a malformed value');
    }
  });

  test('a MISSING header is PRECONDITION_REQUIRED and a MALFORMED one is PRECONDITION_FAILED', () => {
    // Two different failures with two different codes: a missing precondition can be retried by sending one, whereas a
    // malformed value cannot be acted on at all. Collapsing them would tell a caller to retry what it already sent.
    const missing = refusalOf(() => integerVersionFromIfMatch(undefined));
    assert.ok(missing instanceof ApiError);
    assert.equal(missing.code, 'PRECONDITION_REQUIRED');

    for (const malformed of ['', 'not-an-etag', '7', '"STATE:"', '"STATE:12x"', '"STATE:-1"']) {
      const refusal = refusalOf(() => integerVersionFromIfMatch(malformed));
      assert.ok(refusal instanceof ApiError, `${JSON.stringify(malformed)} must be refused, not accepted`);
      assert.equal(refusal.code, 'PRECONDITION_FAILED', `${JSON.stringify(malformed)} must be a precondition failure`);
    }
  });

  test('the two version bounds are enforced, and the difference between them is the point of the module', () => {
    // NINE DIGITS for an integer-backed counter, FIFTEEN for an epoch instant. Accepting the wider bound on the narrower
    // route would let a caller send milliseconds to a route that compares counters, and every write would then fail 412
    // for a reason nothing in the response explains.
    assert.equal(integerVersionFromIfMatch('"STATE:123456789"'), 123_456_789);
    assert.equal(epochMillisFromIfMatch('"STATE:123456789012345"'), 123_456_789_012_345);
    const tooWideForCounter = refusalOf(() => integerVersionFromIfMatch('"STATE:1234567890"'));
    assert.ok(tooWideForCounter instanceof ApiError);
    assert.equal(tooWideForCounter.code, 'PRECONDITION_FAILED', 'ten digits is not a row counter');
  });

  test('a repeated If-Match header reads its FIRST value, and an absent one is undefined', () => {
    // The module states this reading explicitly: two values sent a request the contract has no meaning for, and using
    // the first is the only reading that does not invent one.
    assert.equal(ifMatchHeader({ headers: {} } as never), undefined);
    assert.equal(ifMatchHeader({ headers: { 'if-match': '"STATE:1"' } } as never), '"STATE:1"');
    assert.equal(ifMatchHeader({ headers: { 'if-match': ['"STATE:2"', '"STATE:9"'] } } as never), '"STATE:2"');
  });
});

describe('the entry point binds a real socket and reports the port it got (EP-007 M1)', () => {
  test('listen() returns the BOUND port, and the server answers on it', async () => {
    // THE ONLY TEST IN THIS REPOSITORY THAT BINDS A PORT, and it is deliberate: `server.ts` keeps `listen` separate from
    // `buildServer` so that every other suite can drive the app without a socket, which left the one function the
    // process actually starts with unexercised. What it asserts is the documented contract — a caller that asks for
    // port 0 must be told the REAL port, because otherwise nothing can report the address it is serving on.
    const app = buildServer(testServerDependencies());
    const bound = await listen(app, { port: 0, host: '127.0.0.1' });
    try {
      assert.ok(bound.port > 0, `port 0 must resolve to a real port, saw ${String(bound.port)}`);
      assert.equal(bound.host, '127.0.0.1');
      const address = app.server.address();
      assert.ok(address !== null && typeof address !== 'string');
      assert.equal(bound.port, address.port, 'and it must be the port the socket actually bound');

      // A PUBLIC ROUTE, so the assertion is about the socket rather than about authentication. MEASURED: `/health` is
      // 401 — the declared path is `/v1/health` (registry §5.17), and asking for the wrong one is exactly the kind of
      // assumption that would have been read as an authentication defect.
      const response = await fetch(`http://127.0.0.1:${String(bound.port)}/v1/health`);
      assert.equal(response.status, 200, `GET /v1/health over the socket must answer 200, saw ${String(response.status)}`);
      const payload = (await response.json()) as Record<string, unknown>;
      assert.equal(typeof payload['status'], 'string', `the health payload must be JSON with a status, saw ${JSON.stringify(payload)}`);
    } finally {
      await app.close();
    }
  });
});

describe('the raw-body capture is byte-exact and capped before parsing (SPEC-003 §6.1)', () => {
  test('isOversized answers for both controls: the declared length and the actual bytes', () => {
    assert.equal(WEBHOOK_MAX_BODY_BYTES, 262_144, '§6.1 caps the delivery at 256 KiB');
    assert.equal(isOversized(undefined), false, 'no declared length and no measurement is not an oversize claim');
    assert.equal(isOversized(String(WEBHOOK_MAX_BODY_BYTES)), false, 'the cap itself is allowed');
    assert.equal(isOversized(String(WEBHOOK_MAX_BODY_BYTES + 1)), true);
    assert.equal(isOversized('not-a-number'), false, 'an unparseable length is the byte check\'s problem, not this one');
    // THE BYTE CHECK IS THE SECOND CONTROL, and it overrides the declared one: a request may declare a small body and
    // arrive with a large one through chunked encoding or a rewriting proxy.
    assert.equal(isOversized(undefined, WEBHOOK_MAX_BODY_BYTES + 1), true);
    assert.equal(isOversized(String(10), WEBHOOK_MAX_BODY_BYTES + 1), true, 'the measurement wins over the declaration');
  });

  test('the capture holds the EXACT bytes a webhook delivery carried, and only on its own prefixes', async () => {
    const app = Fastify({ logger: false });
    rawBodyPlugin(app, { prefixes: ['/v1/webhooks/'] });
    app.post('/v1/webhooks/delivery', async (request) => ({
      captured: request.rawWebhookBody === undefined ? null : request.rawWebhookBody.toString('utf8'),
      bytes: request.rawWebhookBody?.length ?? -1,
    }));
    app.post('/v1/other', async (request) => ({ captured: request.rawWebhookBody === undefined ? null : 'set' }));
    await app.ready();
    try {
      // WHITESPACE AND KEY ORDER ARE PART OF THE SIGNED BYTES, which is why the assertion is on the string and not on a
      // parsed object: a verifier that hashed a re-serialised body would reject a legitimate sender.
      const body = '{"b":2,  "a":1, "note":"ünïcode ✓"}';
      const delivery = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/delivery',
        payload: body,
        // MEASURED: without a content type Fastify answers 415 for a string payload, which is the framework's own
        // parser selection rather than anything this plugin does.
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(delivery.statusCode, 200);
      const parsed = JSON.parse(delivery.body) as { captured: string | null; bytes: number };
      assert.equal(parsed.captured, body, 'the captured bytes must be the sent bytes, whitespace and encoding included');
      assert.equal(parsed.bytes, Buffer.byteLength(body, 'utf8'), 'counted in bytes, not in characters');

      // THE SCOPE: a non-webhook path is not captured at all, which is what keeps this plugin from holding every body.
      const other = await app.inject({ method: 'POST', url: '/v1/other', payload: { a: 1 } });
      assert.deepEqual(JSON.parse(other.body), { captured: null });
    } finally {
      await app.close();
    }
  });

  test('an EMPTY webhook body is marked as zero bytes rather than left absent', async () => {
    // The distinction the module documents: "not a webhook request" and "a webhook request whose body was empty" are
    // different facts, and the second is a malformed delivery rather than a missing route.
    const app = Fastify({ logger: false });
    rawBodyPlugin(app, { prefixes: ['/v1/webhooks/'] });
    app.post('/v1/webhooks/empty', async (request) => ({
      marked: request.rawWebhookBody !== undefined,
      bytes: request.rawWebhookBody?.length ?? -1,
    }));
    await app.ready();
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/webhooks/empty', payload: '' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), { marked: true, bytes: 0 });
    } finally {
      await app.close();
    }
  });

  test('an OVERSIZED delivery is refused BEFORE it is parsed, and never reaches the verifier as a partial buffer', async () => {
    // TWO CONTROLS, TWO DIFFERENT INTERNAL STATES, AND THE FIRST VERSION OF THIS TEST CONFLATED THEM (measured: it
    // expected `captured === false` and observed `true`). The declared-length control refuses without reading a chunk, so
    // the capture stays at its empty marker — zero bytes, not `undefined`. Only the byte control, which fires while the
    // chunks are arriving, clears the capture; and that is the state the module documents as "a partial buffer must
    // never reach the verifier", because a signature over a truncated body fails in a way an operator reads as a key
    // problem.
    const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
    rawBodyPlugin(app, { prefixes: ['/v1/webhooks/'] });
    app.post('/v1/webhooks/declared', async (request) => ({
      captured: request.rawWebhookBody !== undefined,
      bytes: request.rawWebhookBody?.length ?? -1,
      oversizeByHeader: isOversized(request.headers['content-length']),
    }));
    // A TEXT parser for the chunked case: the capture consumes part of the stream before it gives up, and a JSON parser
    // would then fail on the remainder — turning an assertion about the capture into an assertion about the parser.
    app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });
    const reachedHandler: { readonly bytes: number }[] = [];
    app.post('/v1/webhooks/streamed', async (request) => {
      reachedHandler.push({ bytes: request.rawWebhookBody?.length ?? -1 });
      return { ok: true };
    });
    await app.ready();
    try {
      const declared = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/declared',
        payload: JSON.stringify({ pad: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES) }),
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(declared.statusCode, 200);
      const declaredBody = JSON.parse(declared.body) as { captured: boolean; bytes: number; oversizeByHeader: boolean };
      assert.equal(declaredBody.oversizeByHeader, true, 'the declared length is what refused it');
      assert.equal(declaredBody.bytes, 0, 'and it was refused before a chunk was read, so the capture holds nothing');

      // CHUNKED: no content-length to check, so the byte cap fires mid-read. The payload is deliberately NOT consumed to
      // the end, and the observable consequence is that NOTHING reaches the route: the request is refused rather than
      // completed, and the handler never runs with a truncated buffer. (Under `app.inject` the partially-read stream
      // surfaces as an aborted request; over a real socket the client sees the connection end. The assertion is on the
      // property rather than on that rendering.)
      const streamed = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/streamed',
        payload: Readable.from([Buffer.alloc(200_000, 0x61), Buffer.alloc(200_000, 0x62)]),
        headers: { 'content-type': 'text/plain' },
      });
      assert.ok(streamed.statusCode >= 400, `a delivery past the cap must not succeed, saw ${String(streamed.statusCode)}`);
      assert.deepEqual(reachedHandler, [], 'no handler ran, so no truncated buffer reached the verifier');
    } finally {
      await app.close();
    }
  });
});
