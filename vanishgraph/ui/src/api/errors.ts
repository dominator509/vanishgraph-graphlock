/**
 * The error envelope, as SPEC-003 §8.1 declares it (EP-005 M5).
 *
 * EVERY NON-2XX RESPONSE HAS THIS BODY AND ONLY THIS BODY. The client parses it once, here, so a surface never reads a
 * raw response and never has to guess whether `code` exists.
 *
 * `retryable` AND `code` COME FROM THE SERVER'S STATIC METADATA, not from the client's judgement (SPEC-006 §2.1 rule 5:
 * classification is a closed decision made by the error class, and runtime code may not re-decide it). The UI therefore
 * never decides that something is retryable: it renders the server's answer, which is what `ErrorState`'s
 * `RetryCapability` union consumes.
 *
 * THE `classification` FIELD IS DELIBERATELY ABSENT. SPEC-006 §5.1's error catalogue carries it server-side; it is not
 * in the §8.1 envelope, so this module does not invent it. A UI that inferred "this is a system error, not an outcome"
 * from the HTTP status would be re-deciding a classification it was not given.
 */

/** SPEC-003 §8.1's envelope, with the fields the UI reads. */
export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly correlationId: string;
    readonly retryable?: boolean;
    readonly occurredAt?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

/** A failed API call, carrying the contract's own identifiers so a surface can render them. */
export class ApiError extends Error {
  readonly code: string;
  readonly correlationId: string;
  readonly requestId: string;
  /** The server's answer to "may this be retried", or `undefined` when the envelope did not say. */
  readonly retryable: boolean | undefined;
  readonly httpStatus: number;

  constructor(status: number, envelope: ApiErrorEnvelope['error']) {
    super(envelope.message);
    this.name = 'ApiError';
    this.httpStatus = status;
    this.code = envelope.code;
    this.correlationId = envelope.correlationId;
    this.requestId = envelope.requestId;
    this.retryable = envelope.retryable;
  }
}

/** Whether a parsed body is the §8.1 envelope: exactly one top-level key, `error`. */
export function isErrorEnvelope(body: unknown): body is ApiErrorEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'error') return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const fields = error as Record<string, unknown>;
  return typeof fields['code'] === 'string' && typeof fields['correlationId'] === 'string';
}

/**
 * A response that is not JSON, or is JSON but not the envelope. It is NOT an `ApiError`, because an `ApiError` claims
 * the server told us something in the contract's shape — and this is the case where it did not. Surfaces render it as a
 * system error with no correlation identifier of its own, which is the honest presentation: there is nothing to quote.
 */
export class TransportFailure extends Error {
  readonly httpStatus: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'TransportFailure';
    this.httpStatus = status;
  }
}
