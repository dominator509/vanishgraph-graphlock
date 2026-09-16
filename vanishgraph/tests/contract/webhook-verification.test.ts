/**
 * Webhook verification and replay protection (SPEC-003 §6.1/§6.2, VG-SEC-004) — credential-free.
 *
 * WHAT THIS SUITE PROVES, and it is the security core of the ingress rather than a route's bookkeeping:
 *
 *   * **The signature covers the RAW BYTES.** A tampered body is rejected, and — the case that matters more — a body
 *     re-serialised from the same parsed value is rejected too, because its bytes differ. A verifier that hashed a
 *     re-parsed body would accept the first and reject the second, and an operator would see "sometimes rejects a
 *     valid sender".
 *   * **The verification ORDER is the contract's**, so each refusal names the operator's actual problem: unknown key
 *     → stale timestamp → malformed nonce → bad signature → missing event id.
 *   * **A repeated nonce is a replay and a repeated event id is not.** The first is `409` and the second returns the
 *     STORED response; both come from the store's own claim, not from a check the caller performs afterwards.
 *   * **Unavailability fails closed.** A store that throws produces a refusal, never an accepted delivery.
 *   * **The TTL EXPIRES rather than being cleaned up.** A record older than 3600 s no longer blocks a delivery.
 *
 * THE STORE UNDER TEST IS THE DURABLE FILE BINDING, against a real file in a temporary directory, because the
 * in-memory substitute M7's fallback clause prohibits is exactly what a suite like this would otherwise reach for.
 * The Valkey binding is exercised through its command interface with a scripted double, and that is stated rather
 * than implied: `VALKEY_URL` is not provisioned (BLOCKED_CREDENTIALS), so no test in this repository has ever
 * spoken to a real coordination store.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyWebhook, webhookSignature } from '../../src/http/webhooks/verify.ts';
import { FileReplayStore, ReplayUnavailableError, ValkeyReplayStore } from '../../src/adapters/coordination/replay-store.ts';
import { isLive, REPLAY_TTL_SECONDS } from '../../src/application/contracts/replay-store.ts';
import { WEBHOOK_MAX_BODY_BYTES } from '../../src/http/plugins/raw-body.ts';

const SECRET = 'webhook-shared-secret-not-a-real-credential';
const KEY_ID = 'provkey-0001';
const NOW_MS = 1_800_000_000_000;

/** The headers a correctly signed delivery carries. */
function signedHeaders(body: Buffer, overrides: Record<string, string> = {}): Record<string, string> {
  const timestamp = String(Math.floor(NOW_MS / 1000));
  const nonce = `nonce-${randomUUID()}`;
  return {
    'x-vg-key-id': KEY_ID,
    'x-vg-timestamp': timestamp,
    'x-vg-nonce': nonce,
    'x-vg-signature': webhookSignature(SECRET, timestamp, nonce, body),
    'x-vg-event-id': `evt-${randomUUID()}`,
    ...overrides,
  };
}

const resolveKey = async (keyId: string): Promise<{ secret: string } | { unknown: true }> =>
  keyId === KEY_ID ? { secret: SECRET } : { unknown: true };

describe('§6.1 signature verification over the raw bytes', () => {
  test('a correctly signed delivery verifies, and the verifier returns the SAME bytes it checked', async () => {
    const body = Buffer.from(JSON.stringify({ eventId: 'evt-1', bodyRef: 'eml-1' }), 'utf8');
    const result = await verifyWebhook({ headers: signedHeaders(body), rawBody: body, nowMs: NOW_MS, resolveKey });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.keyId, KEY_ID);
    assert.deepEqual(result.rawBody, body);
  });

  test('a TAMPERED body is rejected', async () => {
    const body = Buffer.from(JSON.stringify({ eventId: 'evt-2', claimedOutcome: 'NOT_DELETED' }), 'utf8');
    const headers = signedHeaders(body);
    const tampered = Buffer.from(JSON.stringify({ eventId: 'evt-2', claimedOutcome: 'DELETED' }), 'utf8');
    const result = await verifyWebhook({ headers, rawBody: tampered, nowMs: NOW_MS, resolveKey });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'WEBHOOK_SIGNATURE_INVALID');
  });

  test('a body RE-SERIALISED from the same value is rejected — the raw-bytes requirement', async () => {
    // The exact failure a re-parsing verifier hides: the same JSON VALUE, different BYTES (spacing and key order).
    const original = Buffer.from('{"a":1,   "b":2}', 'utf8');
    const headers = signedHeaders(original);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(original.toString('utf8')) as object), 'utf8');
    assert.notDeepEqual(reserialised, original, 'the fixture must actually differ in bytes');

    const result = await verifyWebhook({ headers, rawBody: reserialised, nowMs: NOW_MS, resolveKey });
    assert.equal(result.ok, false, 'a re-serialised body must NOT verify');
    if (result.ok) return;
    assert.equal(result.code, 'WEBHOOK_SIGNATURE_INVALID');

    // And the original bytes still verify with the same headers, so the rejection is about the bytes and not a bug.
    const accepted = await verifyWebhook({ headers, rawBody: original, nowMs: NOW_MS, resolveKey });
    assert.equal(accepted.ok, true);
  });

  test('the refusals come in the CONTRACT order, so each names the real problem', async () => {
    const body = Buffer.from('{"eventId":"evt-3"}', 'utf8');
    const headers = signedHeaders(body);

    // 1. Unknown key beats everything else: with no secret, no later answer is honest.
    const unknownKey = await verifyWebhook({
      headers: { ...headers, 'x-vg-key-id': 'provkey-retired', 'x-vg-timestamp': '1', 'x-vg-signature': 'v1=00' },
      rawBody: body,
      nowMs: NOW_MS,
      resolveKey,
    });
    assert.equal(unknownKey.ok, false);
    if (!unknownKey.ok) assert.equal(unknownKey.code, 'WEBHOOK_KEY_UNKNOWN');

    // 2. A stale timestamp beats a bad nonce and a bad signature.
    const stale = await verifyWebhook({
      headers: { ...headers, 'x-vg-timestamp': String(Math.floor(NOW_MS / 1000) - 3600), 'x-vg-nonce': 'short' },
      rawBody: body,
      nowMs: NOW_MS,
      resolveKey,
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');

    // A FUTURE-dated delivery is outside the window too: clock skew is not a licence.
    const future = await verifyWebhook({
      headers: { ...headers, 'x-vg-timestamp': String(Math.floor(NOW_MS / 1000) + 3600) },
      rawBody: body,
      nowMs: NOW_MS,
      resolveKey,
    });
    assert.equal(future.ok, false);
    if (!future.ok) assert.equal(future.code, 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');

    // 3. A malformed nonce, before the signature is even considered.
    const badNonce = await verifyWebhook({
      headers: { ...headers, 'x-vg-nonce': 'too-short' },
      rawBody: body,
      nowMs: NOW_MS,
      resolveKey,
    });
    assert.equal(badNonce.ok, false);
    if (!badNonce.ok) assert.equal(badNonce.code, 'WEBHOOK_NONCE_MISSING');

    // 4. A signature that is not `v1=<64 lowercase hex>` is invalid without a comparison.
    for (const signature of ['', 'v1=', 'v1=ABCDEF', 'sha256=abc', `v2=${'a'.repeat(64)}`]) {
      const bad = await verifyWebhook({
        headers: { ...headers, 'x-vg-signature': signature },
        rawBody: body,
        nowMs: NOW_MS,
        resolveKey,
      });
      assert.equal(bad.ok, false, `signature ${JSON.stringify(signature)} must be refused`);
      if (!bad.ok) assert.equal(bad.code, 'WEBHOOK_SIGNATURE_INVALID');
    }

    // 5. The event id LAST, and its refusal is MISSING_REQUIRED_HEADER rather than a webhook code: §6.1 says the
    //    ingress refuses rather than guessing an identity it cannot promise idempotency against.
    const noEvent = await verifyWebhook({
      headers: { ...headers, 'x-vg-event-id': '' },
      rawBody: body,
      nowMs: NOW_MS,
      resolveKey,
    });
    assert.equal(noEvent.ok, false);
    if (!noEvent.ok) {
      assert.equal(noEvent.code, 'MISSING_REQUIRED_HEADER');
      assert.equal(noEvent.field, 'X-VG-Event-Id');
    }
  });

  test('a body the capture REFUSED for size is 413, and the cap is 256 KiB', () => {
    assert.equal(WEBHOOK_MAX_BODY_BYTES, 256 * 1024);
    // The verifier reports the refusal rather than parsing whatever arrived: `rawBody` is undefined in that case.
    return verifyWebhook({
      headers: signedHeaders(Buffer.from('{}')),
      rawBody: undefined,
      nowMs: NOW_MS,
      resolveKey,
    }).then((result) => {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'PAYLOAD_TOO_LARGE');
    });
  });
});

describe('§6.2 replay protection on the durable fallback binding', () => {
  let dir: string;
  let store: FileReplayStore;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'vg-replay-'));
    store = new FileReplayStore({ path: join(dir, 'replay.log') });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a first delivery is NEW, a repeated NONCE is a replay, and neither depends on process memory', async () => {
    const nonce = `nonce-${randomUUID()}`;
    const eventId = `evt-${randomUUID()}`;
    const first = await store.begin({ providerKeyId: KEY_ID, nonce, eventId, nowMs: NOW_MS });
    assert.deepEqual(first, { kind: 'NEW' });

    // A SECOND STORE over the same file: the claim is durable, so a restart or a second process sees it. This is the
    // property an in-memory Map cannot have, and the reason M7 prohibits one.
    const reopened = new FileReplayStore({ path: join(dir, 'replay.log') });
    const replay = await reopened.begin({ providerKeyId: KEY_ID, nonce, eventId, nowMs: NOW_MS + 1000 });
    assert.deepEqual(replay, { kind: 'NONCE_REPLAY' });
  });

  test('a repeated EVENT ID returns the STORED response, and the nonce check comes first', async () => {
    const nonce = `nonce-${randomUUID()}`;
    const eventId = `evt-${randomUUID()}`;
    await store.begin({ providerKeyId: KEY_ID, nonce, eventId, nowMs: NOW_MS });
    const stored = { accepted: true, controllerResponseId: 'crp-1' };
    await store.complete({ providerKeyId: KEY_ID, eventId, status: 202, body: stored, nowMs: NOW_MS });

    // Same event id, FRESH nonce and timestamp — the provider redelivering the same logical event, which §6.2 says
    // is not an error.
    const redelivery = await store.begin({
      providerKeyId: KEY_ID,
      nonce: `nonce-${randomUUID()}`,
      eventId,
      nowMs: NOW_MS + 5000,
    });
    assert.equal(redelivery.kind, 'EVENT_REPLAY');
    if (redelivery.kind !== 'EVENT_REPLAY') return;
    assert.equal(redelivery.storedStatus, 202);
    // The ORIGINAL response, byte for byte: a redelivery must be indistinguishable from the first answer except for
    // the `X-VG-Webhook-Replayed` header the route adds.
    assert.deepEqual(redelivery.storedBody, stored);

    // The SAME nonce with the same event id is a NONCE replay, not an event redelivery: nonce catches the identical
    // signed bytes, and §6.2 makes that a 409.
    const byteIdentical = await store.begin({ providerKeyId: KEY_ID, nonce, eventId, nowMs: NOW_MS + 9000 });
    assert.deepEqual(byteIdentical, { kind: 'NONCE_REPLAY' });
  });

  test('a claim expires after the TTL instead of blocking the delivery forever', () => {
    // The window is a value this suite can reason about, and the boundary is asserted rather than assumed.
    assert.equal(REPLAY_TTL_SECONDS, 3600);
    assert.equal(isLive(NOW_MS, NOW_MS + 3599_000), true);
    assert.equal(isLive(NOW_MS, NOW_MS + 3600_000), false);
  });

  test('an expired record no longer blocks a delivery', async () => {
    const nonce = `nonce-${randomUUID()}`;
    const eventId = `evt-${randomUUID()}`;
    const fresh = new FileReplayStore({ path: join(dir, 'expiry.log') });
    await fresh.begin({ providerKeyId: KEY_ID, nonce, eventId, nowMs: NOW_MS });
    const afterTtl = await fresh.begin({
      providerKeyId: KEY_ID,
      nonce,
      eventId,
      nowMs: NOW_MS + (REPLAY_TTL_SECONDS + 1) * 1000,
    });
    assert.deepEqual(afterTtl, { kind: 'NEW' }, 'an expired claim must not block a legitimate delivery');
  });

  test('the same nonce under a DIFFERENT provider key is not a replay', async () => {
    const nonce = `nonce-${randomUUID()}`;
    const eventId = `evt-${randomUUID()}`;
    const other = new FileReplayStore({ path: join(dir, 'keys.log') });
    await other.begin({ providerKeyId: 'provkey-a', nonce, eventId, nowMs: NOW_MS });
    const second = await other.begin({ providerKeyId: 'provkey-b', nonce, eventId, nowMs: NOW_MS });
    // The store is keyed `(providerKeyId, nonce)` per §6.2, so two providers sharing a nonce value do not collide.
    assert.deepEqual(second, { kind: 'NEW' });
  });

  test('an unreadable store FAILS CLOSED', async () => {
    // A DIRECTORY where the log file should be: reading it fails, and the failure must surface as a refusal rather
    // than as a `NEW` that lets the delivery through. That is what §6.2's "never accept and dedupe later" means.
    const asDirectory = join(dir, 'a-directory.log');
    mkdirSync(asDirectory, { recursive: true });
    const broken = new FileReplayStore({ path: asDirectory });
    await assert.rejects(
      () => broken.begin({ providerKeyId: KEY_ID, nonce: `nonce-${randomUUID()}`, eventId: 'evt-x', nowMs: NOW_MS }),
      (error: unknown) => error instanceof ReplayUnavailableError,
    );
  });
});

describe('the Valkey binding, through its command interface', () => {
  test('the claim is the SET, so a second delivery cannot pass the read-then-write window', async () => {
    const seen = new Map<string, string>();
    const commands = {
      async setNx(key: string, value: string): Promise<boolean> {
        if (seen.has(key)) return false;
        seen.set(key, value);
        return true;
      },
      async get(key: string): Promise<string | null> {
        return seen.get(key) ?? null;
      },
      async set(key: string, value: string): Promise<void> {
        seen.set(key, value);
      },
    };
    const store = new ValkeyReplayStore({ commands });
    const nonce = 'nonce-valkey-0001';
    const eventId = 'evt-valkey-0001';
    assert.deepEqual(await store.begin({ providerKeyId: KEY_ID, nonce, eventId, nowMs: NOW_MS }), { kind: 'NEW' });
    assert.deepEqual(await store.begin({ providerKeyId: KEY_ID, nonce, eventId, nowMs: NOW_MS }), {
      kind: 'NONCE_REPLAY',
    });

    await store.complete({ providerKeyId: KEY_ID, eventId, status: 202, body: { accepted: true }, nowMs: NOW_MS });
    const redelivery = await store.begin({
      providerKeyId: KEY_ID,
      nonce: 'nonce-valkey-0002',
      eventId,
      nowMs: NOW_MS,
    });
    assert.equal(redelivery.kind, 'EVENT_REPLAY');
    if (redelivery.kind === 'EVENT_REPLAY') assert.deepEqual(redelivery.storedBody, { accepted: true });
  });

  test('a command failure is a refusal, not an accepted delivery', async () => {
    const store = new ValkeyReplayStore({
      commands: {
        setNx: async () => {
          throw new Error('connection refused');
        },
        get: async () => null,
        set: async () => {},
      },
    });
    await assert.rejects(
      () => store.begin({ providerKeyId: KEY_ID, nonce: 'nonce-x', eventId: 'evt-x', nowMs: NOW_MS }),
      (error: unknown) => error instanceof ReplayUnavailableError,
    );
  });
});

/** A constant this suite asserts directly: the HMAC helper and the verifier must agree on the signing base. */
test('the signing base is `<timestamp>.<nonce>.<raw bytes>`', () => {
  const body = Buffer.from('{"x":1}', 'utf8');
  const expected = createHmac('sha256', SECRET)
    .update(Buffer.concat([Buffer.from('100.nonce.', 'utf8'), body]))
    .digest('hex');
  assert.equal(webhookSignature(SECRET, '100', 'nonce', body), `v1=${expected}`);
});
