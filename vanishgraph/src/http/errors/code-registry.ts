/**
 * The `/v1` error envelope and the closed code → status → message registry
 * (SPEC-003 §8.1/§8.2, SPEC-006 §6.2).
 *
 * SPEC-006 §1.1 forbids a DOMAIN error class from carrying an HTTP status or a human-facing
 * message, so those live here: the domain keeps `code`/`classification`/`retryable`, and this
 * module owns the wire. That division is what keeps `src/domain` importable by nothing but the
 * standard library.
 *
 * Three rules are enforced structurally rather than by review:
 *
 *  1. **The message is a fixed, non-interpolated template per code** (SPEC-006 H-3). A message
 *     therefore cannot contain an identifier, a subject value, a URL, or provider text, because
 *     there is no code path that puts one there. All dynamic context goes in `details`.
 *  2. **`details` is allowlisted per code.** An unexpected exception cannot serialise its own
 *     message into the response, because the response is built from this table rather than from
 *     the thrown value (SPEC-003 §8.3).
 *  3. **The status for a code exists once.** SPEC-003 §8.2 and SPEC-006 §6.2 must never disagree;
 *     the contract test compares this table against both and fails on divergence.
 */

/** Wire error codes, with the status and the fixed message template each carries. */
export interface ErrorCodeDefinition {
  readonly status: number;
  /** Fixed template: no interpolation and no dynamic content (SPEC-006 H-3). */
  readonly message: string;
  /** Whether a client may retry the same request unchanged (SPEC-006 §5.3). */
  readonly retryable: boolean;
}

/**
 * The closed `/v1` code registry (SPEC-003 §8.2, adopted verbatim by SPEC-006 §6.2).
 *
 * Grouped by status so a divergence between the two specifications is visible in one read. Codes
 * that SPEC-003 marks domain-only (`NO_LAWFUL_BASIS`, `TAINTED_CONTENT_REJECTED`, `EGRESS_DENIED`)
 * are present so that no domain code lacks a wire spelling, and are commented as such.
 */
export const ERROR_CODES = {
  // ---- 400: malformed request, missing header/parameter, opaque-value validation ----
  SCHEMA_VALIDATION_FAILED: { status: 400, message: 'The request is malformed.', retryable: false },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, message: 'An Idempotency-Key header is required for this operation.', retryable: false },
  IDEMPOTENCY_KEY_MALFORMED: { status: 400, message: 'The Idempotency-Key header is malformed.', retryable: false },
  INVALID_CURSOR: { status: 400, message: 'The pagination cursor is not valid.', retryable: false },
  INVALID_SORT_FIELD: { status: 400, message: 'The requested sort field is not supported.', retryable: false },
  UNKNOWN_QUERY_PARAMETER: { status: 400, message: 'The request contains an unknown query parameter.', retryable: false },
  INVALID_TRUTH_STATE: { status: 400, message: 'The requested truth state is not a recognised value.', retryable: false },
  INVALID_GROUP_BY: { status: 400, message: 'The requested grouping is not supported.', retryable: false },
  TIME_RANGE_REQUIRED: { status: 400, message: 'A time range is required for this query.', retryable: false },
  TIME_RANGE_TOO_WIDE: { status: 400, message: 'The requested time range is too wide.', retryable: false },
  FILTER_TOO_BROAD: { status: 400, message: 'The requested filter is too broad to be served.', retryable: false },
  WEBHOOK_NONCE_MISSING: { status: 400, message: 'The webhook request is missing its replay token.', retryable: false },
  MISSING_REQUIRED_HEADER: { status: 400, message: 'A required request header is missing.', retryable: false },

  // ---- 401: authentication and webhook signature ----
  TOKEN_MISSING: { status: 401, message: 'A bearer token is required.', retryable: false },
  TOKEN_INVALID: { status: 401, message: 'The bearer token could not be verified.', retryable: false },
  TOKEN_EXPIRED: { status: 401, message: 'The bearer token has expired.', retryable: false },
  TOKEN_INVALID_CLAIMS: { status: 401, message: 'The bearer token is missing a required claim.', retryable: false },
  TOKEN_AUDIENCE_MISMATCH: { status: 401, message: 'The bearer token was not issued for this audience.', retryable: false },
  TOKEN_SCOPE_WILDCARD_FORBIDDEN: { status: 401, message: 'The bearer token carries a forbidden wildcard.', retryable: false },
  WEBHOOK_SIGNATURE_INVALID: { status: 401, message: 'The webhook signature could not be verified.', retryable: false },
  WEBHOOK_KEY_UNKNOWN: { status: 401, message: 'The webhook signing key is not recognised.', retryable: false },
  WEBHOOK_TIMESTAMP_OUT_OF_WINDOW: { status: 401, message: 'The webhook timestamp is outside the accepted window.', retryable: false },

  // ---- 403: authenticated but not permitted ----
  INSUFFICIENT_SCOPE: { status: 403, message: 'The token does not carry a scope required by this operation.', retryable: false },
  INSUFFICIENT_ROLE: { status: 403, message: 'The caller does not hold a role permitted for this operation.', retryable: false },
  STEP_UP_REQUIRED: { status: 403, message: 'This operation requires a stronger authentication step.', retryable: false },
  SEPARATION_OF_DUTIES: { status: 403, message: 'The caller may not perform this operation on their own record.', retryable: false },
  IDENTITY_LEVEL_INSUFFICIENT: { status: 403, message: 'The verified identity level is below the level this operation requires.', retryable: false },
  // SPEC-003 §8.2 marks EGRESS_DENIED domain-only: the EgressGate refused the payload class.
  EGRESS_DENIED: { status: 403, message: 'This data class may not leave the system under the current policy.', retryable: false },

  // ---- 404: absent OR owned by another tenant (H-9: never distinguishes the cause) ----
  RESOURCE_NOT_FOUND: { status: 404, message: 'The requested resource was not found.', retryable: false },
  WEBHOOK_BINDING_NOT_FOUND: { status: 404, message: 'The webhook binding was not found.', retryable: false },

  // ---- 409: conflict with current resource state or a prior request ----
  ILLEGAL_TRANSITION: { status: 409, message: 'The requested state change is not permitted from the current state.', retryable: false },
  IDEMPOTENCY_KEY_REUSE: { status: 409, message: 'This idempotency key was already used for a different request.', retryable: false },
  IDEMPOTENCY_IN_FLIGHT: { status: 409, message: 'A request with this idempotency key is still in flight.', retryable: true },
  EFFECT_BUDGET_EXCEEDED: { status: 409, message: 'The action budget for this subject, source, and window is exhausted.', retryable: false },
  AUTHORITY_INVALID: { status: 409, message: 'No valid authority grant is bound to this case.', retryable: false },
  AUTHORITY_EXPIRED: { status: 409, message: 'The authority grant for this case is no longer valid.', retryable: false },
  AUTHORITY_REVOKED: { status: 409, message: 'The authority grant for this case was revoked.', retryable: false },
  AUTHORITY_ALREADY_REVOKED: { status: 409, message: 'The authority grant was already revoked.', retryable: false },
  RECIPE_STALE: { status: 409, message: 'The removal recipe for this source is stale.', retryable: false },
  RECIPE_UNSIGNED: { status: 409, message: 'The removal recipe for this source failed signature verification.', retryable: false },
  RECIPE_DISABLED: { status: 409, message: 'The removal recipe for this source is disabled.', retryable: false },
  RECIPE_GUARD_FAILED: { status: 409, message: 'A guard on the removal recipe was not satisfied.', retryable: false },
  RECIPE_VERSION_CONFLICT: { status: 409, message: 'The removal recipe version has changed since it was read.', retryable: false },
  SOURCE_PERMISSION_UNCLEAR: { status: 409, message: 'The write permission class for this source is unclear; writes are disabled.', retryable: false },
  SOURCE_PERMISSION_STALE: { status: 409, message: 'The recorded write permission for this source is stale.', retryable: false },
  SOURCE_ALREADY_DECLARED: { status: 409, message: 'This source is already declared for the tenant.', retryable: false },
  CATALOG_ENTRY_DUPLICATE: { status: 409, message: 'A catalogue entry already exists for this source and category.', retryable: false },
  CHANNEL_PRIORITY_VIOLATION: { status: 409, message: 'A higher-priority channel was available and was not recorded as unavailable.', retryable: false },
  POLICY_VERSION_SUPERSEDED: { status: 409, message: 'The policy version this decision used has been superseded.', retryable: false },
  CASE_AUTHORITY_INVALID: { status: 409, message: 'The authority grant bound to this case is not valid.', retryable: false },
  REAPPEARANCE_WITHOUT_PRIOR_REMOVAL: { status: 409, message: 'A reappearance requires a prior verified removal.', retryable: false },
  CASE_ALREADY_EXISTS: { status: 409, message: 'A case already exists for this subject and source.', retryable: false },
  CASE_EXPOSURE_STATE_MISMATCH: { status: 409, message: 'The exposure is not in a state that permits this case operation.', retryable: false },
  ALIAS_ALREADY_ATTACHED: { status: 409, message: 'This alias value is already attached to the subject.', retryable: false },
  IDENTIFIER_ALREADY_PRESENT: { status: 409, message: 'This identifier is already recorded for the subject.', retryable: false },
  EMAIL_THREAD_DUPLICATE: { status: 409, message: 'An email thread with this message set already exists.', retryable: false },
  DEADLINE_ALREADY_SATISFIED: { status: 409, message: 'This deadline has already been satisfied.', retryable: false },
  APPEAL_WINDOW_CLOSED: { status: 409, message: 'The appeal window for this case has closed.', retryable: false },
  STRICT_LANE_CONFLICT: { status: 409, message: 'The subject is in the strict review lane and cannot enter an automated write path.', retryable: false },
  DISCOVERY_RUN_IN_FLIGHT: { status: 409, message: 'A discovery run for this subject and source is already in flight.', retryable: true },
  ACTION_NOT_AMBIGUOUS: { status: 409, message: 'The external action is not in an ambiguous state.', retryable: false },
  EVIDENCE_INTEGRITY_FAILURE: { status: 409, message: 'A stored artifact failed integrity verification.', retryable: false },
  IDENTITY_CLASS_MISMATCH: { status: 409, message: 'The identity document class does not match this operation.', retryable: false },
  WEBHOOK_NONCE_REPLAY: { status: 409, message: 'This webhook replay token has already been used.', retryable: false },
  WEBHOOK_CASE_STATE_CONFLICT: { status: 409, message: 'The webhook conflicts with the current case state.', retryable: false },
  WEBHOOK_ACTION_NOT_FOUND: { status: 409, message: 'The external action this webhook refers to was not found.', retryable: false },
  WEBHOOK_PROVIDER_RUN_MISMATCH: { status: 409, message: 'The webhook does not match the recorded provider run.', retryable: false },
  WEBHOOK_MAIL_PIECE_NOT_FOUND: { status: 409, message: 'The mail piece this webhook refers to was not found.', retryable: false },
  // SPEC-003 §8.2 marks NO_LAWFUL_BASIS domain-only: an explicit refusal spelling of the
  // NOT_REMOVABLE outcome, which is normally a 200 outcome body.
  NO_LAWFUL_BASIS: { status: 409, message: 'No lawful removal path exists for this record.', retryable: false },

  // ---- 410: retention elapsed while metadata remains ----
  EVIDENCE_EXPIRED_RETENTION: { status: 410, message: 'The stored content has passed its retention window.', retryable: false },

  // ---- 412 / 428: concurrency token ----
  PRECONDITION_FAILED: { status: 412, message: 'The resource has changed since it was read.', retryable: false },
  PRECONDITION_REQUIRED: { status: 428, message: 'This operation requires an If-Match header.', retryable: false },

  // ---- 413 / 415 ----
  PAYLOAD_TOO_LARGE: { status: 413, message: 'The request body is too large.', retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'The request media type is not supported.', retryable: false },

  // ---- 422: well-formed request failing semantic or guard validation ----
  CONFIDENCE_BASIS_REQUIRED: { status: 422, message: 'A confidence score requires at least one recorded basis.', retryable: false },
  CONFIDENCE_OUT_OF_RANGE: { status: 422, message: 'The confidence score is outside the permitted range.', retryable: false },
  COVERAGE_BOUNDS_REQUIRED: { status: 422, message: 'A coverage claim requires its bounds.', retryable: false },
  OBSERVATION_PATH_NOT_INDEPENDENT: { status: 422, message: 'The observation does not use a path independent of the action.', retryable: false },
  OBSERVATION_WINDOW_NOT_MET: { status: 422, message: 'The required observation window has not yet elapsed.', retryable: false },
  OBSERVATION_METHOD_MISMATCH: { status: 422, message: 'The observation method does not match the recipe verification method.', retryable: false },
  LEGAL_BASIS_NOT_IN_POLICY_VERSION: { status: 422, message: 'The requested legal basis does not exist in the policy version in force.', retryable: false },
  LEGAL_BASIS_NOT_AUTHORABLE: { status: 422, message: 'This legal basis cannot be authored through the API.', retryable: false },
  JURISDICTION_UNRESOLVED: { status: 422, message: 'No jurisdiction policy resolves for this request.', retryable: false },
  EVIDENCE_DIGEST_MISMATCH: { status: 422, message: 'The supplied digest does not match the received content.', retryable: false },
  EVIDENCE_DIGEST_MALFORMED: { status: 422, message: 'The supplied digest is not a valid SHA-256 value.', retryable: false },
  EVIDENCE_REQUIRED: { status: 422, message: 'This operation requires a stored evidence artifact.', retryable: false },
  EVIDENCE_NOT_FOUND: { status: 422, message: 'A referenced evidence artifact does not resolve.', retryable: false },
  EVIDENCE_KIND_UNSUPPORTED: { status: 422, message: 'This evidence kind is not supported for the operation.', retryable: false },
  REDACTION_STATE_REQUIRED: { status: 422, message: 'An evidence artifact requires a recorded redaction state.', retryable: false },
  CASE_NOT_FOUND: { status: 422, message: 'The referenced case does not exist.', retryable: false },
  AUTHORITY_EVIDENCE_REQUIRED: { status: 422, message: 'This authority kind requires a stored signed instrument.', retryable: false },
  AUTHORITY_GRANT_INVALID: { status: 422, message: 'The supplied authority grant is not valid.', retryable: false },
  AUTHORITY_GRANT_SCOPE_INSUFFICIENT: { status: 422, message: 'The authority grant does not cover the requested action.', retryable: false },
  AUTHORITY_SCOPE_UNKNOWN: { status: 422, message: 'The requested authority scope is not recognised.', retryable: false },
  AUTHORITY_KIND_UNSUPPORTED: { status: 422, message: 'This authority grant kind is not supported.', retryable: false },
  AUTHORITY_WINDOW_INVALID: { status: 422, message: 'The authority grant window is not valid.', retryable: false },
  GUARD_FAILED: { status: 422, message: 'A required precondition for this operation was not satisfied.', retryable: false },
  TRANSITION_NOT_ROUTEABLE: { status: 422, message: 'No route can perform the requested transition from the current state.', retryable: false },
  FIELD_NOT_PATCHABLE: { status: 422, message: 'This field cannot be changed by this operation.', retryable: false },
  STRICT_LANE_REQUIRED: { status: 422, message: 'This subject requires the strict review lane.', retryable: false },
  MINOR_STRICT_LANE: { status: 422, message: 'A minor subject cannot enter an automated write path.', retryable: false },
  BYPASS_ATTEMPT_REFUSED: { status: 422, message: 'The request attempted to bypass a required control.', retryable: false },
  HUMAN_GATE_OPEN: { status: 422, message: 'A human gate is open for this case; automation cannot proceed.', retryable: false },
  HUMAN_STEP_REQUIRED: { status: 422, message: 'A human step is required before this operation can continue.', retryable: false },
  HUMAN_REVIEW_REQUIRED: { status: 422, message: 'This operation requires human review before it can proceed.', retryable: false },
  ARTIFACT_REQUIRED: { status: 422, message: 'This operation requires a materialised artifact.', retryable: false },
  PAYLOAD_FIELD_NOT_ALLOWLISTED: { status: 422, message: 'The request body contains a field that is not permitted.', retryable: false },
  TEMPLATE_HASH_REQUIRED: { status: 422, message: 'A rendered template requires its hash.', retryable: false },
  DISCOVERY_MODE_FORBIDDEN: { status: 422, message: 'This discovery mode is not permitted for the source.', retryable: false },
  SOURCE_NOT_PERMITTED_FOR_READ: { status: 422, message: 'The source permission class does not permit this read.', retryable: false },
  RATE_LIMIT_POLICY_MISSING: { status: 422, message: 'No rate limit policy resolves for this operation.', retryable: false },
  CATALOG_NOTES_REQUIRED: { status: 422, message: 'A catalogue entry requires coverage notes.', retryable: false },
  LICENSE_UNRECORDED: { status: 422, message: 'The source licence terms have not been recorded.', retryable: false },
  CONTROLLER_NOT_FOUND: { status: 422, message: 'The referenced controller does not exist.', retryable: false },
  PERMISSION_EVIDENCE_REQUIRED: { status: 422, message: 'The recorded source permission requires supporting evidence.', retryable: false },
  RECIPE_SIGNATURE_INVALID: { status: 422, message: 'The submitted recipe signature could not be verified.', retryable: false },
  RECIPE_VERIFICATION_METHOD_REQUIRED: { status: 422, message: 'A removal recipe requires a verification method.', retryable: false },
  RECIPE_CHANNEL_UNKNOWN: { status: 422, message: 'The requested removal channel is not recognised.', retryable: false },
  POLICY_DECISION_INCOMPLETE: { status: 422, message: 'The policy decision is missing a required field.', retryable: false },
  RECIPE_NOT_ENABLED: { status: 422, message: 'The removal recipe is not enabled.', retryable: false },
  IDENTIFIER_KIND_UNSUPPORTED: { status: 422, message: 'This identifier kind is not supported.', retryable: false },
  PRIOR_REMOVED_EVENT_NOT_FOUND: { status: 422, message: 'No prior verified removal exists for this record.', retryable: false },
  OVERLAPPING_INTERVAL: { status: 422, message: 'The supplied interval overlaps an existing interval.', retryable: false },
  DEADLINE_SOURCE_REQUIRED: { status: 422, message: 'A deadline requires its source.', retryable: false },
  DEADLINE_IN_PAST: { status: 422, message: 'The supplied deadline is in the past.', retryable: false },
  MESSAGE_ID_MALFORMED: { status: 422, message: 'The supplied message identifier is malformed.', retryable: false },
  CLAIMED_OUTCOME_UNSUPPORTED: { status: 422, message: 'This claimed outcome is not supported.', retryable: false },
  REFUSAL_BASIS_REQUIRED: { status: 422, message: 'A refusal requires a recorded basis.', retryable: false },
  DELIVERY_STATUS_UNKNOWN: { status: 422, message: 'The delivery status is not recognised.', retryable: false },
  // SPEC-003 §8.2 marks TAINTED_CONTENT_REJECTED domain-only: untrusted or model-produced
  // content reached a decision or write path, or attempted to select a channel (VG-SEC-001).
  TAINTED_CONTENT_REJECTED: { status: 422, message: 'Untrusted content cannot direct this operation.', retryable: false },

  // ---- 429 / 500 / 503 ----
  RATE_LIMITED: { status: 429, message: 'The request rate limit has been exceeded.', retryable: true },
  INTERNAL_ERROR: { status: 500, message: 'An unexpected error occurred.', retryable: true },
  DEPENDENCY_UNAVAILABLE: { status: 503, message: 'A required dependency is unavailable; the operation was not performed.', retryable: true },
} as const satisfies Record<string, ErrorCodeDefinition>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_CODE_NAMES = Object.keys(ERROR_CODES) as readonly ErrorCode[];

export function isErrorCode(value: string): value is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}

export function statusFor(code: ErrorCode): number {
  return ERROR_CODES[code].status;
}

/**
 * The allowlisted `details` keys per code (SPEC-003 §8.3).
 *
 * `details` never carries a request body, a value from a PII-bearing field, a stack trace, or an
 * upstream provider response body. Only identifiers, enum tokens, guard names, counts and
 * `ruleRef` are permitted, so the allowlist is explicit rather than "whatever the thrower passed".
 */
export const DETAILS_ALLOWLIST = [
  'field', 'ruleRef', 'fromTruthState', 'toTruthState', 'transitionCode', 'guard',
  'missingScopes', 'requiredScopes', 'heldScopes', 'sourceId', 'caseId', 'subjectId',
  'exposureId', 'authorityGrantId', 'recipeId', 'policyVersion', 'currentVersion',
  'retryAfterSeconds', 'limit', 'windowSeconds', 'providerReference', 'checks',
  'failedCheck', 'reason', 'candidateCount', 'expectedDigest', 'actualDigest',
  'requestedField', 'allowedFields', 'idempotencyKeyHash', 'gateKind',
] as const;

export type DetailsKey = (typeof DETAILS_ALLOWLIST)[number];

export type ErrorDetails = Partial<Record<DetailsKey, string | number | boolean | readonly string[]>>;

/** The `/v1` error envelope (SPEC-003 §8.1). Exactly one top-level key. */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    /** Fixed template for `code`; contains no identifier, value, URL or provider text. */
    readonly message: string;
    readonly requestId: string;
    readonly correlationId: string;
    readonly retryable: boolean;
    readonly occurredAt: string;
    readonly details?: ErrorDetails;
  };
}

/**
 * Build an envelope from a code and an already-allowlisted details object.
 *
 * `details` is filtered against `DETAILS_ALLOWLIST` here, so a caller that passes an unexpected
 * key gets it dropped rather than serialised. This is the response-boundary expression of
 * VG-SEC-002: an exception cannot leak its own message into a response, because the message comes
 * from the table above and the details come from the allowlist.
 */
export function buildErrorEnvelope(params: {
  code: ErrorCode;
  requestId: string;
  correlationId: string;
  occurredAt: string;
  details?: Record<string, unknown>;
}): ErrorEnvelope {
  const definition = ERROR_CODES[params.code];
  const filtered: Record<string, unknown> = {};
  let hasDetails = false;

  if (params.details !== undefined) {
    for (const key of Object.keys(params.details)) {
      if ((DETAILS_ALLOWLIST as readonly string[]).includes(key)) {
        filtered[key] = params.details[key];
        hasDetails = true;
      }
    }
  }

  return {
    error: {
      code: params.code,
      message: definition.message,
      requestId: params.requestId,
      correlationId: params.correlationId,
      retryable: definition.retryable,
      occurredAt: params.occurredAt,
      ...(hasDetails ? { details: filtered as ErrorDetails } : {}),
    },
  };
}
