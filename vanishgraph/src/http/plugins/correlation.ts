/**
 * Correlation (SPEC-003 §2.4).
 *
 * Every request gets a `correlationId` that is echoed in the response header AND appears in every
 * error envelope AND every log line. That is what lets a support conversation join a user-visible
 * failure to an audit row **without exchanging PII** — the alternative is asking a subject for
 * their email address, which is exactly what VG-SEC-002 forbids.
 *
 * An inbound `X-Correlation-ID` is honoured so a caller can join a trace across hops, but it is
 * validated first: an unvalidated header becomes a log-injection vector and an unbounded string
 * in every record.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export const CORRELATION_HEADER = 'x-correlation-id';

/** A W3C-traceparent-style 32-hex id, or a UUID. Anything else is replaced, not trusted. */
const ACCEPTED_INBOUND = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

/**
 * Install correlation on the instance it is given.
 *
 * DELIBERATELY NOT A Fastify PLUGIN FUNCTION. `app.register(plugin)` runs the plugin in an
 * ENCAPSULATED child context, so hooks it adds apply only to routes registered inside that child
 * — a sibling route on the parent instance never sees them. Measured: registering this as a
 * plugin left `request.correlationId` empty and set no response header at all, which silently
 * removed correlation from every route in the service.
 *
 * Installing directly on the root instance is what makes the hook global, which is the whole
 * point: correlation must reach the routes registered afterwards on the same instance.
 */
export function installCorrelation(app: FastifyInstance): void {
  app.decorateRequest('correlationId', '');

  app.addHook('onRequest', async (request, reply) => {
    const inbound = request.headers[CORRELATION_HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

    // An unrecognised or hostile value is REPLACED rather than rejected: refusing the request
    // would let a malformed header deny service, and correlating a request that did happen is
    // more useful than rejecting it.
    request.correlationId =
      candidate !== undefined && ACCEPTED_INBOUND.test(candidate)
        ? candidate.toLowerCase()
        : randomUUID().replace(/-/g, '');

    // Echoed so a client can quote it in a support request without reading logs.
    reply.header('x-correlation-id', request.correlationId);
  });
}
