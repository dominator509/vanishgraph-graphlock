/**
 * The single error boundary (SPEC-003 §8.1, §8.3; SPEC-006 H-1, H-8).
 *
 * Every non-2xx response leaves through here, and only here. That is what makes the guarantees
 * structural rather than aspirational:
 *
 *  1. **A response body always has the envelope.** An absent or empty body on a non-2xx response
 *     is a contract defect (SPEC-006 H-1), so the not-found path and the fallback path both
 *     produce one.
 *  2. **A message is a fixed template per code**, looked up from the registry. The thrown value is
 *     read ONLY to classify; it never becomes response text.
 *  3. **`details` is allowlisted**, so a thrower cannot smuggle a field onto the wire.
 *  4. **An unmapped exception becomes 500 INTERNAL_ERROR with no detail.** SPEC-006 H-8: the
 *     exception's message and stack stay server-side, where they are logged with the correlation
 *     id. A handler must not catch-and-continue, so there is no path that swallows an error and
 *     returns 2xx.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { toEnvelope, statusForEnvelope, type ErrorEnvelope } from '../errors/envelope.ts';
import { isErrorCode, type ErrorCode, type ErrorDetails } from '../errors/code-registry.ts';

/**
 * An error a handler raises deliberately, carrying a wire code.
 *
 * `details` is filtered by the envelope builder, so passing a field the allowlist does not name is
 * a no-op rather than a leak.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;
  /** Set only for `SCHEMA_VALIDATION_FAILED`, which has both a 400 and a 422 spelling. */
  readonly statusOverride: number | undefined;

  constructor(code: ErrorCode, details?: ErrorDetails, statusOverride?: number) {
    // For LOGS only; never sent. Using the code as the message keeps a log line from carrying a
    // value too, and the response message comes from the registry regardless.
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    this.statusOverride = statusOverride;
  }
}

export function apiError(code: ErrorCode, details?: ErrorDetails, statusOverride?: number): ApiError {
  return new ApiError(code, details, statusOverride);
}

interface FastifyErrorLike {
  readonly statusCode?: number;
  readonly code?: string;
  readonly validation?: readonly { readonly instancePath?: string; readonly params?: unknown }[];
  /**
   * `details` on a non-`ApiError` thrower.
   *
   * MEASURED DEFECT this exists to fix: `classify` returned `{ code }` and DROPPED `details` for anything that was
   * not an `ApiError` — so every refusal raised by the query parser (`QueryError`, which carries `field` and
   * `collection`) reached the client with its reason stripped. The parser's own comment says the offending
   * parameter is "named in `details` so the caller can fix it", and no test noticed because every suite asserted
   * the CODE. Values still pass through the envelope's allowlist, so this widens no disclosure.
   */
  readonly details?: unknown;
}

/**
 * Map a thrown value to a wire code.
 *
 * The thrown `message` is never read for response text. It is also not read for classification:
 * matching on English prose would be a classification that breaks the moment a dependency rewords
 * its error. Only structured fields (`code`, `statusCode`, `validation`) are consulted.
 */
function classify(error: unknown): { code: ErrorCode; details?: ErrorDetails; statusOverride?: number } {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.statusOverride === undefined ? {} : { statusOverride: error.statusOverride }),
    };
  }

  const candidate = error as FastifyErrorLike;

  if (candidate.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return { code: 'UNSUPPORTED_MEDIA_TYPE' };
  if (candidate.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return { code: 'PAYLOAD_TOO_LARGE' };
  if (
    candidate.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    candidate.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
  ) {
    // A body that is not parseable JSON is the SYNTACTIC failure, which is the 400 spelling.
    return { code: 'SCHEMA_VALIDATION_FAILED', statusOverride: 400 };
  }

  if (candidate.validation !== undefined && candidate.validation.length > 0) {
    // Both spellings of SCHEMA_VALIDATION_FAILED exist (400 syntactic, 422 semantic). The 400
    // spelling is chosen here; a handler that knows its violation is semantic raises ApiError
    // with the 422 override explicitly, so the distinction is a decision rather than a guess.
    const field = candidate.validation[0]?.instancePath;
    return {
      code: 'SCHEMA_VALIDATION_FAILED',
      ...(field !== undefined && field.length > 0 ? { details: { field } as ErrorDetails } : {}),
    };
  }

  if (typeof candidate.code === 'string' && isErrorCode(candidate.code)) {
    const details = candidate.details;
    return {
      code: candidate.code,
      // A non-null, non-array object; anything else is ignored rather than passed to the envelope, which filters
      // KEYS and would be the wrong place to discover that the thrower handed it a string.
      ...(typeof details === 'object' && details !== null && !Array.isArray(details)
        ? { details: details as ErrorDetails }
        : {}),
    };
  }

  switch (candidate.statusCode) {
    case 400: return { code: 'SCHEMA_VALIDATION_FAILED' };
    case 401: return { code: 'TOKEN_INVALID' };
    case 403: return { code: 'INSUFFICIENT_SCOPE' };
    case 404: return { code: 'RESOURCE_NOT_FOUND' };
    case 409: return { code: 'ILLEGAL_TRANSITION' };
    case 410: return { code: 'EVIDENCE_EXPIRED_RETENTION' };
    case 412: return { code: 'PRECONDITION_FAILED' };
    case 413: return { code: 'PAYLOAD_TOO_LARGE' };
    case 415: return { code: 'UNSUPPORTED_MEDIA_TYPE' };
    case 422: return { code: 'SCHEMA_VALIDATION_FAILED', statusOverride: 422 };
    case 428: return { code: 'PRECONDITION_REQUIRED' };
    case 429: return { code: 'RATE_LIMITED' };
    case 503: return { code: 'DEPENDENCY_UNAVAILABLE' };
    default: break;
  }

  // Anything unrecognised is a server fault. It is NOT re-labelled as a friendlier code:
  // INTERNAL_ERROR is honest, and SPEC-006 H-8 forbids substituting it for a class that HAS a
  // durable path — but the reverse (calling a real bug a 422) is worse.
  return { code: 'INTERNAL_ERROR' };
}

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  code: ErrorCode,
  details: ErrorDetails | undefined,
  statusOverride: number | undefined,
): FastifyReply {
  const envelope: ErrorEnvelope = toEnvelope(
    code,
    {
      // `request.id` is deliberately empty in this service (the correlation plugin is the only id
      // generator), so the correlation id serves as the request id. That is intentional: two ids
      // that are always equal would invite a reader to assume they can differ.
      requestId: request.id === '' ? request.correlationId : request.id,
      correlationId: request.correlationId,
      occurredAt: new Date().toISOString(),
      ...(details === undefined ? {} : { details: details as Record<string, unknown> }),
    },
    statusOverride,
  );
  return reply.code(statusForEnvelope(code, statusOverride)).send(envelope);
}

/**
 * Install the error boundary on the instance it is given.
 *
 * Not a Fastify plugin function: `app.register()` encapsulates hooks into a child context, so
 * `setErrorHandler` there would not cover sibling routes and Fastify's default error output —
 * which includes the exception message — would escape for them.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler(async (request, reply) => {
    return send(reply, request, 'RESOURCE_NOT_FOUND', undefined, undefined);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const { code, details, statusOverride } = classify(error);

    // Log the real error for operators WITH the correlation id so it joins the response. `err` is
    // logged rather than returned: the diagnostic detail stays server-side, which is what makes
    // the 500 body safe to be so uninformative.
    request.log.error(
      { err: error, code, correlationId: request.correlationId, alert: code === 'INTERNAL_ERROR' },
      'request failed',
    );

    try {
      return send(reply, request, code, details, statusOverride);
    } catch (envelopeFailure) {
      // The envelope builder must not throw, and this is the backstop for the case where it does.
      // Without it, a failure INSIDE error handling escapes to Fastify's default handler, which
      // serialises `statusCode`, `error` and `message` — leaking the internal defect text to the
      // caller. MEASURED: that is exactly what an undeclared status override produced before the
      // builder was made total.
      request.log.error(
        { err: envelopeFailure, correlationId: request.correlationId },
        'error envelope construction failed; sending the minimal safe envelope',
      );
      // A hardcoded minimal envelope, built without the registry, so nothing can throw again.
      return reply.code(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected server fault occurred.',
          requestId: request.correlationId,
          correlationId: request.correlationId,
          retryable: false,
          occurredAt: new Date().toISOString(),
        },
      });
    }
  });
}
