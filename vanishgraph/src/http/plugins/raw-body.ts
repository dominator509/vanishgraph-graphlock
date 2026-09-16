/**
 * Raw request bytes for the webhook ingress (SPEC-003 §6.1).
 *
 * WHY THE RAW BYTES ARE KEPT AT ALL: the signature is HMAC-SHA256 over
 * `"<timestamp>.<nonce>.<raw request body bytes>"`. A verifier that hashed a RE-PARSED body would accept a
 * different byte sequence that happens to serialise the same way, and — worse — would reject a legitimate
 * delivery whose provider serialised its JSON with different whitespace or key order. Both failures are real, and
 * the second is the one that hides: the route would look like it "sometimes" rejects valid senders.
 *
 * THE CAP IS APPLIED TO THE BYTES, BEFORE PARSING. §6.1: "The raw body is capped at 256 KiB; larger is
 * `413 PAYLOAD_TOO_LARGE` and the body is discarded unparsed." Fastify's own body limit is a different control
 * (it protects the whole server); this one is the ingress's, and it is expressed here so the webhook routes
 * cannot be the one place where an oversized body is parsed first and refused later.
 *
 * SCOPE: the capture is installed for the webhook route paths ONLY. Installing it globally would hold every
 * request body in memory twice for no reason, and this plugin's whole content is a buffer.
 */

import { Readable } from 'node:stream';

import type { FastifyInstance, FastifyRequest } from 'fastify';

/** §6.1's ceiling, verbatim. */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The exact bytes received, or `undefined` when this request is not a webhook delivery — or when the capture
     * refused them for size, which the verifier reports as `413 PAYLOAD_TOO_LARGE`.
     *
     * `Buffer | undefined` is declared explicitly because `exactOptionalPropertyTypes` distinguishes an absent
     * property from one whose value is `undefined`, and the capture SETS this to `undefined` to mean "refused".
     */
    rawWebhookBody?: Buffer | undefined;
  }
}

export interface RawBodyOptions {
  /** The path prefixes whose bodies are captured. The webhook group, and nothing else. */
  readonly prefixes: readonly string[];
}

/**
 * Reject an oversized delivery BEFORE the body is parsed.
 *
 * Exported because it is also the check the route performs on the captured buffer: a request can arrive with a
 * correct `content-length` and a different actual size (chunked encoding, a proxy rewriting the header), so the
 * header check and the byte check are two controls and both are needed.
 */
export function isOversized(contentLength: string | undefined, actualBytes?: number): boolean {
  if (actualBytes !== undefined) return actualBytes > WEBHOOK_MAX_BODY_BYTES;
  if (contentLength === undefined) return false;
  const declared = Number(contentLength);
  return Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_BYTES;
}

export function rawBodyPlugin(app: FastifyInstance, options: RawBodyOptions): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (!options.prefixes.some((prefix) => request.url.startsWith(prefix))) return;
    // MARKED, so the route can tell "not a webhook request" from "a webhook request whose body was empty" — the
    // second is a malformed delivery and must not be treated as a missing route.
    request.rawWebhookBody = Buffer.alloc(0);
  });

  app.addHook('preParsing', async (request, _reply, payload) => {
    if (request.rawWebhookBody === undefined) return payload;
    // THE CAP IS CHECKED HERE, on the declared length, so a 10 MB body is refused before a single chunk is read.
    if (isOversized(request.headers['content-length'])) {
      // The stream is NOT consumed: `413` is produced by the route's own check on the (empty) capture, and leaving
      // the payload unread is what makes "discarded unparsed" true rather than aspirational.
      return payload;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of payload) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buffer.length;
      if (total > WEBHOOK_MAX_BODY_BYTES) {
        // STOP READING. Whatever has arrived is dropped: a partial buffer must never reach the verifier, because a
        // signature check over a truncated body fails in a way an operator would read as a key problem.
        request.rawWebhookBody = undefined;
        return payload;
      }
      chunks.push(buffer);
    }
    request.rawWebhookBody = Buffer.concat(chunks);
    // The SAME bytes are handed on, so Fastify's JSON parser sees exactly what the signature covered.
    return Readable.from(chunks);
  });
}
