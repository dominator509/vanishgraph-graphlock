/**
 * Webhook signature verification (SPEC-003 §6.1, VG-SEC-004).
 *
 * THE ORDER IS THE CONTRACT, NOT AN IMPLEMENTATION DETAIL. §6.1 fixes it: resolve key → timestamp window → nonce
 * shape → HMAC over the RAW bytes → event id. Each refusal is a different code and a different operator problem, so
 * a verifier that reordered them would report a stale delivery as an unknown key, or a malformed nonce as a bad
 * signature, and the operator would chase the wrong thing. This module performs the steps in that order and returns
 * exactly one outcome.
 *
 * NOTHING IS PARSED, NORMALISED OR VALIDATED BEFORE THE SIGNATURE CHECK. A JSON parser that runs first is a parser
 * an unauthenticated caller can feed, and normalising the body would change the bytes the signature covers. The
 * verifier therefore takes a `Buffer` and never a parsed value.
 *
 * THE COMPARISON IS CONSTANT-TIME, over equal-length buffers. `timingSafeEqual` throws on a length mismatch, so the
 * lengths are compared first — and that comparison is not secret: the length of an HMAC digest is public.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: it does not resolve the path capability token, does not touch the
 * database, and does not decide what a verified body means. Those are the route's jobs, and keeping them out of here
 * is what lets the whole rule be tested without a server, a database or a network.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The header names §6.1 fixes, and the only place they are spelled. */
export const WEBHOOK_HEADERS = {
  keyId: 'x-vg-key-id',
  timestamp: 'x-vg-timestamp',
  nonce: 'x-vg-nonce',
  signature: 'x-vg-signature',
  eventId: 'x-vg-event-id',
} as const;

/** §6.1's window, in seconds. */
export const WEBHOOK_TIMESTAMP_WINDOW_SECONDS = 300;
/** §6.1's nonce grammar and bounds. */
export const WEBHOOK_NONCE_SHAPE = /^[A-Za-z0-9._:-]{16,128}$/;
/** `v1=<lowercase hex>`. */
export const WEBHOOK_SIGNATURE_SHAPE = /^v1=([0-9a-f]{64})$/;

/** The verification failures, in the contract's own vocabulary. */
export type WebhookVerificationFailure =
  | { readonly ok: false; readonly code: 'WEBHOOK_KEY_UNKNOWN' }
  | { readonly ok: false; readonly code: 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW'; readonly detail: string }
  | { readonly ok: false; readonly code: 'WEBHOOK_NONCE_MISSING'; readonly detail: string }
  | { readonly ok: false; readonly code: 'WEBHOOK_SIGNATURE_INVALID' }
  | { readonly ok: false; readonly code: 'MISSING_REQUIRED_HEADER'; readonly field: string }
  | { readonly ok: false; readonly code: 'PAYLOAD_TOO_LARGE' };

export interface VerifiedWebhook {
  readonly ok: true;
  readonly keyId: string;
  readonly nonce: string;
  /** The provider's stable event identity, echoed so the route can key its replay record on it. */
  readonly eventId: string;
  /** The exact bytes the signature covered — what the route must treat as the payload. */
  readonly rawBody: Buffer;
}

export interface VerifyWebhookInput {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The captured bytes, or `undefined` when the capture refused them for size. */
  readonly rawBody: Buffer | undefined;
  /** What this server believes the time is, in epoch milliseconds. Injected so a test can age a delivery. */
  readonly nowMs: number;
  /** Resolves a provider key id to its shared secret, or to an unknown/retired result. */
  readonly resolveKey: (keyId: string) => Promise<{ readonly secret: string } | { readonly unknown: true }>;
}

/** One header value as a string, refusing the array form `set-cookie`-style headers can take. */
function header(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** The exact string the HMAC covers, exported so a test (and a provider's implementer) can build it. */
export function webhookSigningBase(timestamp: string, nonce: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.${nonce}.`, 'utf8'), rawBody]);
}

/** The expected `v1=` signature for a delivery. Exported for tests and for a provider-side reimplementation. */
export function webhookSignature(secret: string, timestamp: string, nonce: string, rawBody: Buffer): string {
  return `v1=${createHmac('sha256', secret).update(webhookSigningBase(timestamp, nonce, rawBody)).digest('hex')}`;
}

export async function verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedWebhook | WebhookVerificationFailure> {
  // 0. SIZE, BEFORE ANYTHING ELSE. §6.1 caps the raw body at 256 KiB and says the bytes are "discarded unparsed";
  //    the capture leaves `rawBody` undefined when it refused them, and that refusal is reported as what it is.
  if (input.rawBody === undefined) return { ok: false, code: 'PAYLOAD_TOO_LARGE' };

  // 1. THE KEY. An unknown or retired key id is its own refusal, and it must come first: every later step depends
  //    on a secret, and "we cannot tell you whether the signature was right" is the honest answer.
  const keyId = header(input.headers, WEBHOOK_HEADERS.keyId);
  if (keyId === undefined || keyId.length === 0) return { ok: false, code: 'WEBHOOK_KEY_UNKNOWN' };
  const resolved = await input.resolveKey(keyId);
  if ('unknown' in resolved) return { ok: false, code: 'WEBHOOK_KEY_UNKNOWN' };

  // 2. THE TIMESTAMP WINDOW. ±300 s of SERVER time, and the comparison is on the server's clock so a sender cannot
  //    widen its own window. A future-dated delivery is outside the window too — clock skew is not a licence.
  const timestamp = header(input.headers, WEBHOOK_HEADERS.timestamp);
  if (timestamp === undefined || !/^-?\d+$/.test(timestamp)) {
    return { ok: false, code: 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW', detail: 'absent or not an integer' };
  }
  const sentMs = Number(timestamp) * 1000;
  const skewSeconds = Math.abs(input.nowMs - sentMs) / 1000;
  if (skewSeconds > WEBHOOK_TIMESTAMP_WINDOW_SECONDS) {
    return { ok: false, code: 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW', detail: `skew ${skewSeconds.toFixed(0)}s` };
  }

  // 3. THE NONCE SHAPE. 16–128 chars of a closed alphabet: a short nonce is guessable and a long one is a way to
  //    spend the store's memory, so both ends of the range are structural rather than cosmetic.
  const nonce = header(input.headers, WEBHOOK_HEADERS.nonce);
  if (nonce === undefined || !WEBHOOK_NONCE_SHAPE.test(nonce)) {
    return { ok: false, code: 'WEBHOOK_NONCE_MISSING', detail: nonce === undefined ? 'absent' : 'malformed' };
  }

  // 4. THE SIGNATURE, over the raw bytes. Shape first (so a missing header is not reported as a mismatch), then a
  //    constant-time comparison of equal-length digests.
  const presented = header(input.headers, WEBHOOK_HEADERS.signature);
  const shape = presented === undefined ? null : WEBHOOK_SIGNATURE_SHAPE.exec(presented);
  if (shape === null) return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };
  const expected = createHmac('sha256', resolved.secret)
    .update(webhookSigningBase(timestamp, nonce, input.rawBody))
    .digest();
  const provided = Buffer.from(shape[1] ?? '', 'hex');
  // `timingSafeEqual` throws on unequal lengths, so the length is checked first. The LENGTH of an HMAC-SHA256
  // digest is public, so comparing it leaks nothing; comparing the BYTES is what has to be constant-time.
  if (provided.length !== expected.length) return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };

  // 5. THE EVENT ID, last. §6.1: without a stable event identity the ingress cannot promise idempotent processing,
  //    so it refuses rather than guessing — and it refuses with MISSING_REQUIRED_HEADER, not with a webhook code.
  const eventId = header(input.headers, WEBHOOK_HEADERS.eventId);
  if (eventId === undefined || eventId.length === 0 || eventId.length > 128) {
    return { ok: false, code: 'MISSING_REQUIRED_HEADER', field: 'X-VG-Event-Id' };
  }

  return { ok: true, keyId, nonce, eventId, rawBody: input.rawBody };
}
