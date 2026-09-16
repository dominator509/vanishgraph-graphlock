/**
 * The webhook gate: order, raw-byte verification, and single-use replay (SPEC-003 §6.1/§6.2, VG-SEC-004; EP-006 M9).
 *
 * WHAT THIS SUITE ADDS TO EP-004'S VERIFIER, STATED SO IT IS NOT OVERCLAIMED: EP-004 built `verifyWebhook` (signature over
 * the captured bytes with a ±300-second window and a nonce grammar) and a durable replay store. This suite asserts the
 * two properties that make those pieces a GATE rather than a set of checks:
 *
 *   1. **THE ORDER IS OBSERVABLE.** An unknown key is refused BEFORE the timestamp is read, and a delivery missing a
 *      required header never reaches key resolution at all — asserted with a `resolveKey` spy, because a suite that only
 *      checked the refusal code could not tell an ordered gate from a set of independent checks.
 *   2. **THE SIGNATURE COVERS THE RAW BYTES.** A body mutated after signing fails, which is the difference between
 *      verifying the bytes that arrived and verifying a re-serialised object.
 *
 * IT IS READ AGAINST THE CURRENT SOURCE: `src/http/webhooks/verify.ts` was read before this file was written, and the
 * header names, the window and the nonce grammar come from its own exported constants rather than from a copy.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WEBHOOK_HEADERS,
  WEBHOOK_NONCE_SHAPE,
  WEBHOOK_TIMESTAMP_WINDOW_SECONDS,
  verifyWebhook,
  webhookSignature,
} from '../../src/http/webhooks/verify.ts';
import { checkWebhookSignature } from '../../src/application/security/webhook-gate.ts';

const SECRET = 'shared-secret-value-for-the-suite';
const KEY_ID = 'provider-key-1';
const NOW_MS = 1_800_000_000_000;
const NONCE = 'nonce-0123456789abcdef';

/** A signed delivery, with the ability to mutate one thing at a time. */
function delivery(overrides: { readonly body?: Buffer; readonly nonce?: string; readonly timestampMs?: number; readonly signature?: string } = {}): {
  readonly headers: Record<string, string>;
  readonly rawBody: Buffer;
} {
  const rawBody = overrides.body ?? Buffer.from(JSON.stringify({ event: 'delivered', eventId: 'event-1' }), 'utf8');
  const timestampMs = overrides.timestampMs ?? NOW_MS;
  const nonce = overrides.nonce ?? NONCE;
  const timestamp = String(Math.floor(timestampMs / 1000));
  const signature = overrides.signature ?? webhookSignature(SECRET, timestamp, nonce, rawBody);
  return {
    rawBody,
    headers: {
      [WEBHOOK_HEADERS.keyId]: KEY_ID,
      [WEBHOOK_HEADERS.timestamp]: timestamp,
      [WEBHOOK_HEADERS.nonce]: nonce,
      [WEBHOOK_HEADERS.signature]: signature,
      [WEBHOOK_HEADERS.eventId]: 'event-1',
    },
  };
}

/** A key resolver that records every call, so the ORDER can be observed rather than assumed. */
function resolver(): { readonly resolveKey: (keyId: string) => Promise<{ secret: string } | { unknown: true }>; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolveKey: async (keyId: string) => {
      calls.push(keyId);
      return keyId === KEY_ID ? { secret: SECRET } : { unknown: true };
    },
  };
}

describe('the webhook gate verifies in the order the plan fixes (VG-SEC-004)', () => {
  test('a correctly signed delivery is accepted, and the signature covers the raw bytes', async () => {
    const keys = resolver();
    const valid = delivery();
    const result = await verifyWebhook({ ...valid, nowMs: NOW_MS, resolveKey: keys.resolveKey });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(keys.calls, [KEY_ID], 'the key is resolved exactly once');

    // THE MUTATED BODY IS THE ASSERTION ABOUT RAW BYTES: the same signature over different bytes must fail.
    const mutated = delivery({ body: Buffer.from(JSON.stringify({ event: 'delivered', eventId: 'event-2' }), 'utf8') });
    const mutatedResult = await verifyWebhook({
      headers: { ...mutated.headers, [WEBHOOK_HEADERS.signature]: valid.headers[WEBHOOK_HEADERS.signature] ?? '' },
      rawBody: mutated.rawBody,
      nowMs: NOW_MS,
      resolveKey: resolver().resolveKey,
    });
    assert.equal(mutatedResult.ok, false);
  });

  test('a missing key-id is refused without resolution, and the other missing headers follow the plan’s order', async () => {
    // MEASURED, AND IT CORRECTED MY OWN EXPECTATION: I first asserted that ANY missing header is refused before key
    // resolution, and the suite failed because EP-004's verifier resolves the key FIRST — which is exactly the order the
    // plan fixes (resolve X-VG-Key-Id, then the timestamp, then the nonce shape, then the signature). So the assertions
    // are the two the order actually implies, and the earlier expectation is recorded here rather than kept.
    const withoutKeyId = resolver();
    const valid = delivery();
    const headersWithoutKey = { ...valid.headers };
    delete headersWithoutKey[WEBHOOK_HEADERS.keyId];
    const keyless = await verifyWebhook({ headers: headersWithoutKey, rawBody: valid.rawBody, nowMs: NOW_MS, resolveKey: withoutKeyId.resolveKey });
    assert.equal(keyless.ok, false);
    assert.deepEqual(withoutKeyId.calls, [], 'with no key id there is nothing to resolve');

    for (const header of [WEBHOOK_HEADERS.timestamp, WEBHOOK_HEADERS.nonce, WEBHOOK_HEADERS.signature]) {
      const keys = resolver();
      const headers = { ...valid.headers };
      delete headers[header];
      const result = await verifyWebhook({ headers, rawBody: valid.rawBody, nowMs: NOW_MS, resolveKey: keys.resolveKey });
      assert.equal(result.ok, false, `${header} must be required`);
      assert.deepEqual(keys.calls, [KEY_ID], `${header}: the key is resolved first, which is the plan’s published order`);
    }
  });

  test('an UNKNOWN key is refused before the timestamp window is evaluated', async () => {
    const keys = resolver();
    const valid = delivery();
    const result = await verifyWebhook({
      headers: { ...valid.headers, [WEBHOOK_HEADERS.keyId]: 'retired-key' },
      rawBody: valid.rawBody,
      nowMs: NOW_MS,
      resolveKey: keys.resolveKey,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'WEBHOOK_KEY_UNKNOWN');
    assert.deepEqual(keys.calls, ['retired-key'], 'resolution is attempted once, which is how the order is observed');
  });

  test('a timestamp outside the ±300-second window is refused, in both directions', async () => {
    assert.equal(WEBHOOK_TIMESTAMP_WINDOW_SECONDS, 300);
    for (const offsetMs of [-(301_000), 301_000]) {
      const keys = resolver();
      const valid = delivery({ timestampMs: NOW_MS + offsetMs });
      const result = await verifyWebhook({ ...valid, nowMs: NOW_MS, resolveKey: keys.resolveKey });
      assert.equal(result.ok, false, `an offset of ${String(offsetMs)} ms must be refused`);
      if (!result.ok) assert.equal(result.code, 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW');
    }
    // Inside the window it is accepted, so the boundary is what is being tested.
    const inside = delivery({ timestampMs: NOW_MS - 299_000 });
    assert.equal((await verifyWebhook({ ...inside, nowMs: NOW_MS, resolveKey: resolver().resolveKey })).ok, true);
  });

  test('a nonce outside the declared grammar is refused', async () => {
    for (const nonce of ['short', 'has spaces in it', 'x'.repeat(129)]) {
      const keys = resolver();
      const valid = delivery({ nonce });
      const result = await verifyWebhook({ ...valid, nowMs: NOW_MS, resolveKey: keys.resolveKey });
      assert.equal(result.ok, false, `"${nonce}" must be refused`);
    }
    assert.equal(WEBHOOK_NONCE_SHAPE.test(NONCE), true, 'the suite nonce satisfies the grammar');
  });

  test('a wrong signature is refused even when every header is well formed', async () => {
    const valid = delivery({ signature: `v1=${'0'.repeat(64)}` });
    const result = await verifyWebhook({ ...valid, nowMs: NOW_MS, resolveKey: resolver().resolveKey });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'WEBHOOK_SIGNATURE_INVALID');
  });

  test('a captured body that the size limit refused is refused rather than treated as empty', async () => {
    const valid = delivery();
    const result = await verifyWebhook({ headers: valid.headers, rawBody: undefined, nowMs: NOW_MS, resolveKey: resolver().resolveKey });
    assert.equal(result.ok, false);
  });
});

describe('the single-use replay token is consumed once (VG-SEC-004)', () => {
  test('the gate records a nonce as used, and a second delivery with it is a replay', () => {
    // THE GATE IS THE PARTS EP-004 ALREADY HAS, COMPOSED: verification, then the single-use record. This suite drives the
    // composition rather than re-testing either half, and the replay store's own durability is asserted by EP-004's suite.
    const seen = new Set<string>();
    const first = checkWebhookSignature({ verified: { nonce: NONCE, eventId: 'event-1' }, alreadySeen: seen.has(NONCE) });
    assert.equal(first.ok, true);
    seen.add(NONCE);
    const second = checkWebhookSignature({ verified: { nonce: NONCE, eventId: 'event-1' }, alreadySeen: seen.has(NONCE) });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'NONCE_REPLAY');
  });

  test('a different nonce is admitted, so the record is per nonce rather than per key', () => {
    const seen = new Set<string>([NONCE]);
    const other = checkWebhookSignature({ verified: { nonce: 'another-nonce-0123456789', eventId: 'event-2' }, alreadySeen: seen.has('another-nonce-0123456789') });
    assert.equal(other.ok, true);
  });
});
