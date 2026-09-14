/**
 * Correlation (SPEC-003 §2.4, §7.3 R-11; SPEC-007 VG-OBS-001).
 *
 * Every request carries a `correlationId` echoed in a response header, in every error envelope, and
 * in every log line. That is what lets a support conversation join a user-visible failure to an audit
 * row **without exchanging PII** — the alternative is asking a subject for their email address, which
 * is exactly what VG-SEC-002 forbids.
 *
 * TWO IDS, TWO PURPOSES, and conflating them would be a defect:
 *
 *   * `correlationId` — joins a request to its audit trail. Taken from a well-formed W3C
 *     `traceparent` when present so a trace spans hops, otherwise generated.
 *   * `requestId` — the HTTP invocation id, echoed from a valid `X-Request-Id`. It is one of exactly
 *     TWO sanctioned uses of the word "request" on the `/v1` surface (SPEC-003 §7.3 R-11), carries no
 *     domain meaning, and is not a synonym for `RequestCase`.
 *
 * `traceparent` IS NEVER TRUSTED FOR AUTHORIZATION, TENANCY OR SAMPLING (SPEC-003 §2.4). It is
 * caller-supplied data that reaches a log line, so it is validated as a shape and otherwise ignored.
 * A malformed value is REPLACED rather than rejected: refusing the call would let a bad header deny
 * service, and correlating a request that did happen is more useful than rejecting it.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export const CORRELATION_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';
export const TRACEPARENT_HEADER = 'traceparent';

/** A 32-hex trace id or a UUID. Anything else is replaced, never trusted. */
const ACCEPTED_CORRELATION = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * W3C traceparent: `version-traceid-spanid-flags`.
 *
 * Version `00` is the only version defined by the specification, and the trace id must not be all
 * zeroes. Validating the shape is all this does; the value is never used for a decision.
 */
const TRACEPARENT = /^00-(?!0{32})([0-9a-f]{32})-(?!0{16})([0-9a-f]{16})-(0[01])$/;

/** A request id we are willing to echo: printable, bounded, no control characters. */
const ACCEPTED_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    /** The HTTP invocation id. Sanctioned tracing name; not a `RequestCase` reference. */
    requestIdValue: string;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Extract the trace id from a valid `traceparent`, or undefined. */
export function traceIdFrom(traceparent: string | undefined): string | undefined {
  if (traceparent === undefined) return undefined;
  const match = TRACEPARENT.exec(traceparent.trim().toLowerCase());
  return match?.[1];
}

/** Generate a correlation id. */
function freshCorrelationId(): string {
  return randomUUID().replace(/-/g, '');
}

export function installCorrelation(app: FastifyInstance): void {
  app.decorateRequest('correlationId', '');
  app.decorateRequest('requestIdValue', '');

  app.addHook('onRequest', async (request, reply) => {
    const headers = request.headers as Record<string, string | string[] | undefined>;

    // 1. Correlation: prefer a valid traceparent's trace id, then a valid inbound header, then a
    //    fresh id. Each step is a shape check, not a trust decision.
    const fromTraceparent = traceIdFrom(firstHeader(headers[TRACEPARENT_HEADER]));
    const inbound = firstHeader(headers[CORRELATION_HEADER]);
    request.correlationId =
      fromTraceparent ??
      (inbound !== undefined && ACCEPTED_CORRELATION.test(inbound) ? inbound.toLowerCase() : freshCorrelationId());

    // 2. Request id: echoed verbatim when well formed, otherwise generated. It is deliberately a
    //    SEPARATE value from the correlation id: they coincide by accident today because nothing
    //    supplies a trace id, and a test asserts they are distinct when both are supplied.
    const inboundRequestId = firstHeader(headers[REQUEST_ID_HEADER]);
    request.requestIdValue =
      inboundRequestId !== undefined && ACCEPTED_REQUEST_ID.test(inboundRequestId)
        ? inboundRequestId
        : request.correlationId;

    reply.header(CORRELATION_HEADER, request.correlationId);
  });
}
