/**
 * The `/v1` error envelope (SPEC-003 §8.1, SPEC-006 §6.1).
 *
 * Every non-2xx response has this body and ONLY this body, with exactly one top-level key. An
 * empty or absent body on a non-2xx response is a contract defect (SPEC-006 H-1).
 *
 * The envelope is built from the registry, never from the thrown value:
 *
 *   * `message` is looked up by code, so it is the byte-exact template and cannot carry an
 *     identifier, a value, a URL or provider text (SPEC-006 H-3);
 *   * `details` is filtered against the allowlist, so a thrower that attaches an unexpected field
 *     has it dropped;
 *   * an unmapped exception becomes `500 INTERNAL_ERROR` with NO exception message and NO stack
 *     (SPEC-006 H-8), because the alternative is serialising a driver string or a SQL fragment
 *     into a response body.
 */

import {
  DETAILS_ALLOWLIST,
  WIRE_STATUS_AMBIGUITY,
  messageFor,
  retryableFor,
  statusFor,
  type ErrorCode,
  type ErrorDetails,
} from './code-registry.ts';

/** The single allowed shape of a non-2xx body. */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    /** Byte-exact template for `code` from SPEC-006 §6.2. */
    readonly message: string;
    readonly requestId: string;
    readonly correlationId: string;
    readonly retryable: boolean;
    readonly occurredAt: string;
    readonly details?: ErrorDetails;
  };
}

export interface EnvelopeContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  /** Raw candidate details. Filtered here; unknown keys are dropped, not serialised. */
  readonly details?: Record<string, unknown>;
}

/**
 * Build the envelope for a wire code.
 *
 * `statusOverride` exists for exactly one case: `SCHEMA_VALIDATION_FAILED`, which SPEC-003 §8.2
 * lists under both 400 (syntactic) and 422 (semantic). An override for any other code is IGNORED
 * rather than raised on: a throwing envelope builder is how Fastify's default error output escapes
 * and leaks an internal defect message into a response, which is precisely what SPEC-003 §8.3
 * forbids. The caller's declared status wins instead.
 *
 * MEASURED: an earlier version threw here, and the response for an undeclared override became
 * `500 {"statusCode":500,"error":"Internal Server Error","message":"error envelope defect: status
 * override 409 is not permitted for AUTHORITY_EXPIRED"}` — an envelope-shaped failure that leaked
 * the internals it was supposed to protect.
 */
export function toEnvelope(
  code: ErrorCode,
  ctx: EnvelopeContext,
  statusOverride?: number,
): ErrorEnvelope {
  const allowed = WIRE_STATUS_AMBIGUITY[code];
  const effectiveStatus =
    statusOverride !== undefined && allowed !== undefined && allowed.includes(statusOverride)
      ? statusOverride
      : statusFor(code);

  const details = filterDetails(ctx.details);

  return {
    error: {
      code,
      message: messageForStatus(code, effectiveStatus),
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      retryable: retryableFor(code),
      occurredAt: ctx.occurredAt,
      ...(details === undefined ? {} : { details }),
    },
  };
}

/**
 * The message template for a code AT A GIVEN STATUS.
 *
 * A declared multi-status code has one template per status, and the status the caller will receive
 * determines which text is correct. Selecting by status rather than by code is what makes
 * `SCHEMA_VALIDATION_FAILED` say "The request body is malformed." at 400 and "The request is well
 * formed but fails a semantic validation." at 422.
 *
 * MEASURED: before this, a 422 request returned the 400 message, so a client could not tell a
 * parse failure from a semantic one even though SPEC-003 §8.2 distinguishes them.
 */
function messageForStatus(code: ErrorCode, status: number): string {
  const perStatus = MESSAGE_BY_STATUS[code];
  if (perStatus !== undefined) {
    const chosen = perStatus[status];
    if (chosen !== undefined) return chosen;
  }
  return messageFor(code);
}

/**
 * Messages that differ by status for one wire code.
 *
 * Only `SCHEMA_VALIDATION_FAILED` qualifies, and it does so because SPEC-003 §8.2 declares two
 * distinct statuses with "(syntax)" and "(semantic)" parentheticals. The 400 text is quoted from
 * SPEC-006 §6.2; the 422 text comes from the EP-004 plan and has no specification source, which is
 * recorded as a finding in EP-004 §12 rather than presented as a spec quote.
 */
const MESSAGE_BY_STATUS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  SCHEMA_VALIDATION_FAILED: {
    400: 'The request body is malformed.',
    422: 'The request is well formed but fails a semantic validation.',
  },
};

/**
 * Keep only allowlisted keys.
 *
 * Returns `undefined` when nothing survives, so an empty `details` object is absent rather than
 * present-and-empty: SPEC-003 §8.1 shows `details` as optional and code-specific.
 */
export function filterDetails(raw: Record<string, unknown> | undefined): ErrorDetails | undefined {
  if (raw === undefined) return undefined;
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const key of Object.keys(raw)) {
    if ((DETAILS_ALLOWLIST as readonly string[]).includes(key)) {
      const value = raw[key];
      // A nested object is refused rather than serialised: it is the shape through which a
      // request body or a provider response would reach the wire.
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) continue;
      out[key] = value;
      kept += 1;
    }
  }
  return kept === 0 ? undefined : (out as ErrorDetails);
}

/** The status to send for an envelope, honouring the one declared multi-status code. */
export function statusForEnvelope(code: ErrorCode, statusOverride?: number): number {
  if (statusOverride !== undefined) {
    const allowed = WIRE_STATUS_AMBIGUITY[code];
    if (allowed !== undefined && allowed.includes(statusOverride)) return statusOverride;
  }
  return statusFor(code);
}
