/**
 * The single error boundary (SPEC-003 §8.1, §8.3; SPEC-006 H-1).
 *
 * Every non-2xx response leaves through here, and only here. That is what makes three guarantees
 * structural rather than aspirational:
 *
 *  1. **A response body always has the envelope.** An absent or empty body on a non-2xx response
 *     is a contract defect (SPEC-006 H-1), so the fallback path also produces one.
 *  2. **A message is a fixed template per code.** The message comes from the code registry, never
 *     from the thrown value, so an exception cannot serialise its own text into a response — which
 *     is how stack traces, SQL, and driver strings would otherwise leak (SPEC-003 §8.3).
 *  3. **`details` is allowlisted.** `buildErrorEnvelope` filters keys, so a thrower that attaches
 *     an unexpected field has it dropped.
 *
 * The thrown value is used for exactly one thing: choosing a code. Everything a client sees comes
 * from the registry.
 */

import type { FastifyInstance } from 'fastify';

import {
  buildErrorEnvelope,
  isErrorCode,
  statusFor,
  type ErrorCode,
  type ErrorDetails,
} from '../errors/code-registry.ts';

/**
 * An error a handler raises deliberately, carrying a wire code.
 *
 * `details` is filtered by the envelope builder, so passing a field the allowlist does not name is
 * a no-op rather than a leak.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, details?: ErrorDetails) {
    // The message here is for LOGS and is never sent: the response message comes from the
    // registry. Using the registry template keeps a log line from carrying a value too.
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export function apiError(code: ErrorCode, details?: ErrorDetails): ApiError {
  return new ApiError(code, details);
}

interface FastifyErrorLike {
  readonly statusCode?: number;
  readonly code?: string;
  readonly validation?: readonly { readonly instancePath?: string; readonly params?: unknown }[];
  readonly message?: string;
}

/**
 * Map a thrown value to a wire code.
 *
 * Order matters: an explicit `ApiError` wins, then a Fastify schema-validation failure, then the
 * HTTP-status hint Fastify attaches, and only then the generic internal error. The thrown
 * `message` is read here ONLY to classify — for example to distinguish a body-too-large refusal —
 * and never becomes response text.
 */
function classify(error: unknown): { code: ErrorCode; details?: ErrorDetails } {
  if (error instanceof ApiError) {
    return error.details === undefined
      ? { code: error.code }
      : { code: error.code, details: error.details };
  }

  const candidate = error as FastifyErrorLike;

  // Fastify's own code for an unparseable JSON body.
  if (candidate.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return { code: 'UNSUPPORTED_MEDIA_TYPE' };
  }
  if (candidate.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return { code: 'PAYLOAD_TOO_LARGE' };
  }
  if (candidate.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || candidate.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return { code: 'SCHEMA_VALIDATION_FAILED' };
  }

  if (candidate.validation !== undefined && candidate.validation.length > 0) {
    // The failing field name is allowlisted `details`; the offending VALUE is not, because it
    // could be a subject's name.
    const field = candidate.validation[0]?.instancePath;
    return field !== undefined && field.length > 0
      ? { code: 'SCHEMA_VALIDATION_FAILED', details: { field } }
      : { code: 'SCHEMA_VALIDATION_FAILED' };
  }

  // A handler may raise an error whose `code` is already a wire code.
  if (typeof candidate.code === 'string' && isErrorCode(candidate.code)) {
    return { code: candidate.code };
  }

  switch (candidate.statusCode) {
    case 400: return { code: 'SCHEMA_VALIDATION_FAILED' };
    case 401: return { code: 'TOKEN_INVALID' };
    case 403: return { code: 'INSUFFICIENT_SCOPE' };
    case 404: return { code: 'RESOURCE_NOT_FOUND' };
    case 409: return { code: 'ILLEGAL_TRANSITION' };
    case 413: return { code: 'PAYLOAD_TOO_LARGE' };
    case 415: return { code: 'UNSUPPORTED_MEDIA_TYPE' };
    case 422: return { code: 'GUARD_FAILED' };
    case 429: return { code: 'RATE_LIMITED' };
    case 503: return { code: 'DEPENDENCY_UNAVAILABLE' };
    default: break;
  }

  // Anything unrecognised is an internal fault. It is NOT re-labelled as a friendlier code:
  // INTERNAL_ERROR is honest, and SPEC-006 H-8 forbids substituting it for a class that has a
  // durable path — but the reverse substitution (calling a real bug a 422) is worse.
  return { code: 'INTERNAL_ERROR' };
}

/**
 * Install the error boundary on the instance it is given.
 *
 * Not a Fastify plugin function, for the same measured reason as correlation: `app.register()`
 * encapsulates hooks into a child context, so `setErrorHandler` there would not cover sibling
 * routes and the default Fastify error output would escape for them.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler(async (request, reply) => {
    const envelope = buildErrorEnvelope({
      code: 'RESOURCE_NOT_FOUND',
      requestId: request.id === '' ? request.correlationId : request.id,
      correlationId: request.correlationId,
      occurredAt: new Date().toISOString(),
    });
    return reply.code(statusFor('RESOURCE_NOT_FOUND')).send(envelope);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const { code, details } = classify(error);

    // Log the real error for operators, with the correlation id so it joins the response. The
    // logger is configured to redact credential-bearing headers, and `err` is logged rather than
    // returned, so the diagnostic detail stays server-side where it belongs.
    request.log.error({ err: error, code, correlationId: request.correlationId }, 'request failed');

    const envelope = buildErrorEnvelope({
      code,
      requestId: request.id === '' ? request.correlationId : request.id,
      correlationId: request.correlationId,
      occurredAt: new Date().toISOString(),
      ...(details === undefined ? {} : { details: details as Record<string, unknown> }),
    });

    return reply.code(statusFor(code)).send(envelope);
  });
}
