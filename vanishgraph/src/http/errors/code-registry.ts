/**
 * The closed `/v1` error-code registry (SPEC-003 §8.2, SPEC-006 §6.2).
 *
 * SPEC-006 §6.2 is the normative mapping table: it pairs a DOMAIN code (the token used in audit,
 * telemetry and the internal error registry) with a WIRE code (the only token that may appear in a
 * response body). They differ for many classes on purpose — the domain token names the cause, the
 * wire token is the contract.
 *
 * Three rules are structural here rather than conventions, because each one is the difference
 * between a leak and no leak:
 *
 *  1. **`message` is the byte-exact template from SPEC-006 §6.2.** Never paraphrased, never
 *     interpolated. A message is a fixed string per code, so there is no code path that can put an
 *     identifier, a subject value, a URL or provider text into it (SPEC-006 H-3).
 *  2. **`retryable` mirrors the `Rty` column of SPEC-006 §5.3.** A client that blind-retries a
 *     non-retryable effect-bearing request is how a duplicate removal is submitted; a client that
 *     refuses to retry a transient 503 is how an outage becomes permanent.
 *  3. **A STATUS CONFLICT BETWEEN THE TWO SPECIFICATIONS IS A DEFECT TO RECORD, NOT A VALUE TO
 *     PICK.** See `KNOWN_STATUS_CONFLICTS` below and EP-004 §12. Neither specification is edited
 *     inside this node.
 *
 * `tests/contract/error-mapping-parity.test.ts` reads both specification files and compares them
 * against this table, so the table cannot drift from the contract it claims to implement.
 */

/** One row of the SPEC-006 §6.2 mapping. */
export interface ErrorCodeSpec {
  /** Token for audit, telemetry and the internal registry. Never appears in a response body. */
  readonly domainCode: string;
  /** The only token that may appear in a response body. */
  readonly wireCode: string;
  readonly status: number;
  /** Byte-exact template from SPEC-006 §6.2. */
  readonly message: string;
  /** From the `Rty` column of SPEC-006 §5.3 for a domain class; API-layer codes set it directly. */
  readonly retryable: boolean;
}

/**
 * Statuses on which SPEC-003 §8.2 and SPEC-006 §6.2 disagree, recorded with their resolution.
 *
 * `INVALID_TRUTH_STATE` is the only one. SPEC-003 §8.2 and §2.3/§5.5/§7.3/§11.4 (VG-API-006) all
 * say 400, and SPEC-006's own family table in §6.2 also says 400; only SPEC-006's
 * `INVALID_VALUE_OBJECT` row says 422, and that row's own wire-code cell reads "field-specific
 * code from SPEC-003 §8.2", i.e. it defers to SPEC-003 for the specific code. SPEC-003 §8.4 also
 * states SPEC-006 "owns the taxonomy; this file owns the wire".
 *
 * Resolution: 400. Recorded in EP-004 §12 with both citations. The parity test asserts this
 * conflict still has the shape recorded here, so the resolution cannot rot silently.
 */
export const KNOWN_STATUS_CONFLICTS: Readonly<Record<string, { readonly spec003: number; readonly spec006GenericRow: number }>> = {
  INVALID_TRUTH_STATE: { spec003: 400, spec006GenericRow: 422 },
};

/**
 * The complete mapping from SPEC-006 §6.2, followed by the API-layer codes SPEC-003 §8.2 owns.
 *
 * ORDER: domain classes first (the §6.2 table order), then the transport/auth/ingestion families
 * §6.2 lists separately. Keeping the spec's order makes a diff against the spec readable.
 */
export const ERROR_CODE_REGISTRY: readonly ErrorCodeSpec[] = Object.freeze([
  // ---------------------------------------------------------------------------------------
  // SPEC-006 §6.2 domain-class rows. `message` is byte-exact.
  // ---------------------------------------------------------------------------------------
  { domainCode: 'ILLEGAL_TRANSITION', wireCode: 'ILLEGAL_TRANSITION', status: 409, retryable: false,
    message: 'The requested state change is not permitted from the current state.' },
  { domainCode: 'AUTHORITY_EXPIRED', wireCode: 'AUTHORITY_EXPIRED', status: 409, retryable: false,
    message: 'The authority grant for this case is no longer valid.' },
  { domainCode: 'AUTHORITY_EXPIRED', wireCode: 'AUTHORITY_REVOKED', status: 409, retryable: false,
    message: 'The authority grant for this case was revoked.' },
  { domainCode: 'AUTHORITY_MISSING', wireCode: 'AUTHORITY_INVALID', status: 409, retryable: false,
    message: 'No valid authority grant is bound to this case.' },
  { domainCode: 'AUTHORITY_SCOPE_VIOLATION', wireCode: 'AUTHORITY_GRANT_SCOPE_INSUFFICIENT', status: 422, retryable: false,
    message: 'The authority grant does not cover the requested action.' },
  { domainCode: 'POLICY_UNRESOLVED', wireCode: 'JURISDICTION_UNRESOLVED', status: 422, retryable: false,
    message: 'No jurisdiction policy resolves for this request.' },
  { domainCode: 'POLICY_UNRESOLVED', wireCode: 'LEGAL_BASIS_NOT_IN_POLICY_VERSION', status: 422, retryable: false,
    message: 'The requested legal basis does not exist in the policy version in force.' },
  { domainCode: 'NO_LAWFUL_BASIS', wireCode: 'NO_LAWFUL_BASIS', status: 409, retryable: false,
    message: 'No lawful removal path exists for this record.' },
  { domainCode: 'RECIPE_STALE', wireCode: 'RECIPE_STALE', status: 409, retryable: false,
    message: 'The removal recipe for this source is stale.' },
  { domainCode: 'RECIPE_UNSIGNED', wireCode: 'RECIPE_UNSIGNED', status: 409, retryable: false,
    message: 'The removal recipe for this source failed signature verification.' },
  { domainCode: 'RECIPE_UNSIGNED', wireCode: 'RECIPE_SIGNATURE_INVALID', status: 422, retryable: false,
    message: 'The submitted recipe signature could not be verified.' },
  { domainCode: 'PERMISSION_CLASS_UNCLEAR', wireCode: 'SOURCE_PERMISSION_UNCLEAR', status: 409, retryable: false,
    message: 'The write permission class for this source is unclear; writes are disabled.' },
  { domainCode: 'IDEMPOTENCY_CONFLICT', wireCode: 'IDEMPOTENCY_KEY_REUSE', status: 409, retryable: false,
    message: 'This idempotency key was already used for a different request.' },
  { domainCode: 'IDEMPOTENCY_CONFLICT', wireCode: 'IDEMPOTENCY_IN_FLIGHT', status: 409, retryable: true,
    message: 'A request with this idempotency key is still in flight.' },
  { domainCode: 'IDEMPOTENCY_CONFLICT', wireCode: 'IDEMPOTENCY_KEY_REQUIRED', status: 400, retryable: false,
    message: 'An Idempotency-Key header is required for this operation.' },
  { domainCode: 'BUDGET_EXCEEDED', wireCode: 'EFFECT_BUDGET_EXCEEDED', status: 409, retryable: false,
    message: 'The action budget for this subject, source, and window is exhausted.' },
  { domainCode: 'TAINTED_CONTENT_REJECTED', wireCode: 'TAINTED_CONTENT_REJECTED', status: 422, retryable: false,
    message: 'Untrusted content cannot direct this operation.' },
  { domainCode: 'EGRESS_DENIED', wireCode: 'EGRESS_DENIED', status: 403, retryable: false,
    message: 'This data class may not leave the system under the current policy.' },
  { domainCode: 'DIGEST_MISMATCH', wireCode: 'EVIDENCE_INTEGRITY_FAILURE', status: 409, retryable: false,
    message: 'A stored artifact failed integrity verification.' },
  { domainCode: 'DIGEST_MISMATCH', wireCode: 'EVIDENCE_DIGEST_MISMATCH', status: 422, retryable: false,
    message: 'The supplied digest does not match the received content.' },
  { domainCode: 'DIGEST_MISMATCH', wireCode: 'EVIDENCE_DIGEST_MALFORMED', status: 422, retryable: false,
    message: 'The supplied digest is not a valid SHA-256 value.' },
  { domainCode: 'TENANT_SCOPE_VIOLATION', wireCode: 'RESOURCE_NOT_FOUND', status: 404, retryable: false,
    message: 'The requested resource was not found.' },
  { domainCode: 'OBSERVATION_NOT_INDEPENDENT', wireCode: 'OBSERVATION_PATH_NOT_INDEPENDENT', status: 422, retryable: false,
    message: 'The observation does not use a path independent of the action.' },
  // Retryable even though it is a 422: SPEC-006 H-10 states this is "a legitimate, non-error,
  // retryable condition in the domain" whose wire status is nonetheless 422. §5.3 marks it Rty=Y.
  { domainCode: 'OBSERVATION_WINDOW_NOT_MET', wireCode: 'OBSERVATION_WINDOW_NOT_MET', status: 422, retryable: true,
    message: 'The required observation window has not yet elapsed.' },
  { domainCode: 'VERIFICATION_METHOD_MISMATCH', wireCode: 'OBSERVATION_METHOD_MISMATCH', status: 422, retryable: false,
    message: "The observation method does not match the recipe's verification method." },
  { domainCode: 'HUMAN_GATE_REQUIRED', wireCode: 'HUMAN_GATE_OPEN', status: 422, retryable: false,
    message: 'A human gate is open for this case; automation cannot proceed.' },
  { domainCode: 'HUMAN_GATE_REQUIRED', wireCode: 'HUMAN_STEP_REQUIRED', status: 422, retryable: false,
    message: 'A human step is required before this operation can continue.' },
  { domainCode: 'INVALID_VALUE_OBJECT', wireCode: 'SCHEMA_VALIDATION_FAILED', status: 400, retryable: false,
    message: 'The request body is malformed.' },
  { domainCode: 'AUDIT_UNAVAILABLE', wireCode: 'DEPENDENCY_UNAVAILABLE', status: 503, retryable: true,
    message: 'A required dependency is unavailable; the operation was not performed.' },
  { domainCode: 'STORAGE_UNAVAILABLE', wireCode: 'DEPENDENCY_UNAVAILABLE', status: 503, retryable: true,
    message: 'A required dependency is unavailable; the operation was not performed.' },
  { domainCode: 'DEPENDENCY_UNAVAILABLE', wireCode: 'DEPENDENCY_UNAVAILABLE', status: 503, retryable: true,
    message: 'A required dependency is unavailable.' },
  { domainCode: 'EXTERNAL_TIMEOUT', wireCode: 'DEPENDENCY_UNAVAILABLE', status: 503, retryable: true,
    message: 'A required dependency is unavailable.' },

  // ---------------------------------------------------------------------------------------
  // The SPEC-003 §5.3 declaration and recipe-authoring guards.
  //
  // These codes are enumerated in SPEC-003 §8.2 (409 and 422 rows) and named by §5.3's own error
  // lists, but SPEC-006 §6.2 gives them NO domain class and NO message template — its §6.2 tables
  // cover the §5.3 write path (the case lifecycle) and not the §5.3 catalogue path. The templates
  // below therefore have no SPEC-006 source. They are non-interpolated, state the condition, and
  // claim no success (H-3, H-12); their provenance is recorded in EP-004 §12 as a finding rather
  // than presented as a spec quote. `domainCode` equals `wireCode` for the same reason: there is no
  // separate domain token to keep distinguishable in audit, and inventing one would imply a domain
  // class that no specification declares.
  //
  // CONSEQUENCE WORTH STATING: `wireCodeForDomain()` is what tells audit which domain cause raised
  // a wire code. For these ten codes it maps one-to-one, so a telemetry consumer sees the same token
  // the client does. That is weaker than the shared-cause codes above (four domain causes collapse
  // onto DEPENDENCY_UNAVAILABLE) but it is not wrong, and it is preferable to a fabricated class.
  // ---------------------------------------------------------------------------------------
  { domainCode: 'SOURCE_ALREADY_DECLARED', wireCode: 'SOURCE_ALREADY_DECLARED', status: 409, retryable: false,
    message: 'A source with this name is already declared for this tenant.' },
  { domainCode: 'CONTROLLER_NOT_FOUND', wireCode: 'CONTROLLER_NOT_FOUND', status: 422, retryable: false,
    message: 'The referenced controller does not exist.' },
  { domainCode: 'PERMISSION_EVIDENCE_REQUIRED', wireCode: 'PERMISSION_EVIDENCE_REQUIRED', status: 422, retryable: false,
    message: 'A write-permitted declaration requires current official-permission evidence.' },
  { domainCode: 'CATALOG_NOTES_REQUIRED', wireCode: 'CATALOG_NOTES_REQUIRED', status: 422, retryable: false,
    message: 'A catalogue entry requires non-empty coverage notes.' },
  { domainCode: 'CATALOG_ENTRY_DUPLICATE', wireCode: 'CATALOG_ENTRY_DUPLICATE', status: 409, retryable: false,
    message: 'This source already has a catalogue entry for that category.' },
  { domainCode: 'LICENSE_UNRECORDED', wireCode: 'LICENSE_UNRECORDED', status: 422, retryable: false,
    message: 'A catalogue entry requires a recorded licence.' },
  { domainCode: 'RECIPE_VERIFICATION_METHOD_REQUIRED', wireCode: 'RECIPE_VERIFICATION_METHOD_REQUIRED', status: 422, retryable: false,
    message: 'A recipe version requires a declared verification method.' },
  { domainCode: 'RECIPE_CHANNEL_UNKNOWN', wireCode: 'RECIPE_CHANNEL_UNKNOWN', status: 422, retryable: false,
    message: 'The requested channel is not one of the declared channels.' },
  { domainCode: 'RECIPE_VERSION_CONFLICT', wireCode: 'RECIPE_VERSION_CONFLICT', status: 409, retryable: false,
    message: 'Another recipe version was created concurrently; retry with the current version.' },
  { domainCode: 'RECIPE_GUARD_FAILED', wireCode: 'RECIPE_GUARD_FAILED', status: 409, retryable: false,
    message: 'A recipe enablement guard failed; the recipe remains disabled.' },

  // ---------------------------------------------------------------------------------------
  // The SPEC-003 §5.14 appeal and counsel-review guards.
  //
  // Enumerated in SPEC-003 §8.2 (`APPEAL_WINDOW_CLOSED` under 409; the other three under 422) and named
  // by §5.14.1's own error list, but — as with the §5.3 block above — SPEC-006 §6.2 gives them no domain
  // class and no message template, so these templates have no SPEC-006 source and are recorded as a
  // finding in EP-004 §12 rather than presented as a spec quote. `domainCode` equals `wireCode` for the
  // same reason as the §5.3 block: there is no separate domain token to keep distinguishable in audit.
  // ---------------------------------------------------------------------------------------
  { domainCode: 'HUMAN_REVIEW_REQUIRED', wireCode: 'HUMAN_REVIEW_REQUIRED', status: 422, retryable: false,
    message: 'This operation requires human review and cannot be recorded as exempt from it.' },
  { domainCode: 'ARTIFACT_REQUIRED', wireCode: 'ARTIFACT_REQUIRED', status: 422, retryable: false,
    message: 'At least one evidence artifact is required for this operation.' },
  { domainCode: 'TEMPLATE_HASH_REQUIRED', wireCode: 'TEMPLATE_HASH_REQUIRED', status: 422, retryable: false,
    message: 'A template hash is required so the reviewed wording is pinned.' },
  { domainCode: 'APPEAL_WINDOW_CLOSED', wireCode: 'APPEAL_WINDOW_CLOSED', status: 409, retryable: false,
    message: 'The appeal window for this case has closed.' },

  // ---------------------------------------------------------------------------------------
  // The SPEC-003 §5.13 deadline guards.
  //
  // Enumerated in SPEC-003 §8.2 (`DEADLINE_ALREADY_SATISFIED` under 409; `DEADLINE_SOURCE_REQUIRED` and
  // `DEADLINE_IN_PAST` under 422) and named by §5.13.2/§5.13.3's own error lists, but — as with the §5.3
  // and §5.14 blocks above — SPEC-006 §6.2 gives them no domain class and no message template, so these
  // templates have no SPEC-006 source and are recorded as a finding in EP-004 §12 rather than presented as
  // a spec quote.
  // ---------------------------------------------------------------------------------------
  { domainCode: 'DEADLINE_SOURCE_REQUIRED', wireCode: 'DEADLINE_SOURCE_REQUIRED', status: 422, retryable: false,
    message: 'A deadline recorded out of band must name the source its date came from.' },
  { domainCode: 'DEADLINE_IN_PAST', wireCode: 'DEADLINE_IN_PAST', status: 422, retryable: false,
    message: 'A deadline must fall in the future when it is recorded.' },
  { domainCode: 'DEADLINE_ALREADY_SATISFIED', wireCode: 'DEADLINE_ALREADY_SATISFIED', status: 409, retryable: false,
    message: 'This deadline has already been satisfied.' },

  // ---------------------------------------------------------------------------------------
  // SPEC-006 §6.2 "codes owned by SPEC-003 §8.2 with no domain class of their own".
  // ---------------------------------------------------------------------------------------
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_MISSING', status: 401, retryable: false,
    message: 'A bearer access token is required.' },
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_INVALID', status: 401, retryable: false,
    message: 'The access token could not be verified.' },
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_EXPIRED', status: 401, retryable: false,
    message: 'The access token has expired.' },
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_INVALID_CLAIMS', status: 401, retryable: false,
    message: 'The access token is missing a required claim.' },
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_AUDIENCE_MISMATCH', status: 401, retryable: false,
    message: 'The access token was issued for a different audience.' },
  { domainCode: 'UNAUTHENTICATED', wireCode: 'TOKEN_SCOPE_WILDCARD_FORBIDDEN', status: 401, retryable: false,
    message: 'A wildcard scope is not permitted.' },
  { domainCode: 'FORBIDDEN', wireCode: 'INSUFFICIENT_SCOPE', status: 403, retryable: false,
    message: 'The access token does not carry a required scope.' },
  { domainCode: 'FORBIDDEN', wireCode: 'INSUFFICIENT_ROLE', status: 403, retryable: false,
    message: 'The access token does not carry a required role.' },
  { domainCode: 'FORBIDDEN', wireCode: 'STEP_UP_REQUIRED', status: 403, retryable: false,
    message: 'Re-authentication is required for this operation.' },
  { domainCode: 'FORBIDDEN', wireCode: 'SEPARATION_OF_DUTIES', status: 403, retryable: false,
    message: 'This operation may not be performed on the caller’s own record.' },
  { domainCode: 'FORBIDDEN', wireCode: 'IDENTITY_LEVEL_INSUFFICIENT', status: 403, retryable: false,
    message: 'The verified identity level is below the level this operation requires.' },

  { domainCode: 'INVALID_REQUEST', wireCode: 'INVALID_CURSOR', status: 400, retryable: false,
    message: 'The supplied cursor is not valid for this collection.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'INVALID_SORT_FIELD', status: 400, retryable: false,
    message: 'The requested sort field is not available on this collection.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'UNKNOWN_QUERY_PARAMETER', status: 400, retryable: false,
    message: 'An unknown query parameter was supplied.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'INVALID_TRUTH_STATE', status: 400, retryable: false,
    message: 'The supplied truth state is not one of the eleven canonical states.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'INVALID_GROUP_BY', status: 400, retryable: false,
    message: 'The requested grouping is not available.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'TIME_RANGE_REQUIRED', status: 400, retryable: false,
    message: 'An explicit time range is required for this collection.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'TIME_RANGE_TOO_WIDE', status: 400, retryable: false,
    message: 'The requested time range exceeds the permitted span.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'FILTER_TOO_BROAD', status: 400, retryable: false,
    message: 'A filter supplied too many values.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'MISSING_REQUIRED_HEADER', status: 400, retryable: false,
    message: 'A required header is missing.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'IDEMPOTENCY_KEY_MALFORMED', status: 400, retryable: false,
    message: 'The Idempotency-Key header is malformed.' },
  // The SEMANTIC spelling of SCHEMA_VALIDATION_FAILED. The 400 row above is the syntactic one.
  // Both are real and distinct: SPEC-003 §8.2 lists SCHEMA_VALIDATION_FAILED under 400 ("syntax")
  // and under 422 ("semantic"). See WIRE_STATUS_AMBIGUITY below.
  { domainCode: 'INVALID_REQUEST', wireCode: 'SCHEMA_VALIDATION_FAILED', status: 422, retryable: false,
    message: 'The request is well formed but fails a semantic validation.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'EVIDENCE_NOT_FOUND', status: 422, retryable: false,
    message: 'A referenced evidence artifact does not resolve.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'FIELD_NOT_PATCHABLE', status: 422, retryable: false,
    message: 'This field cannot be changed by this operation.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'OVERLAPPING_INTERVAL', status: 422, retryable: false,
    message: 'The supplied interval overlaps an existing interval.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'IDENTIFIER_KIND_UNSUPPORTED', status: 422, retryable: false,
    message: 'This identifier kind is not supported.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'CONFIDENCE_BASIS_REQUIRED', status: 422, retryable: false,
    message: 'A confidence score requires at least one recorded basis.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'CONFIDENCE_OUT_OF_RANGE', status: 422, retryable: false,
    message: 'The confidence score is outside the permitted range.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'COVERAGE_BOUNDS_REQUIRED', status: 422, retryable: false,
    message: 'A coverage claim requires its bounds.' },

  // SPEC-003 §5.5.3 / §8.2's 409 list. It had NO registry row until §5.5's assessment route needed it, which
  // is why the route could reach a code the envelope had no template for: `ErrorCode` is `string`, so an
  // unregistered wire code typechecks and would only fail when a response was built. VG-IDENT-004 is the rule
  // it carries — a record seen through a search-engine-class source cannot enter a removal path, because
  // "found on a search engine" is not "matched to the subject".
  { domainCode: 'IDENTITY_CLASS_MISMATCH', wireCode: 'IDENTITY_CLASS_MISMATCH', status: 409, retryable: false,
    message: 'The source class of this record does not permit this transition.' },

  // SPEC-003 §5.7 / §8.2's 409 list. Same reason as the row above: enumerated in the contract, absent from this
  // registry until §5.7's routes were implemented.
  { domainCode: 'CASE_ALREADY_EXISTS', wireCode: 'CASE_ALREADY_EXISTS', status: 409, retryable: false,
    message: 'A live case already exists for this subject, source and exposure.' },
  { domainCode: 'CASE_EXPOSURE_STATE_MISMATCH', wireCode: 'CASE_EXPOSURE_STATE_MISMATCH', status: 409, retryable: false,
    message: 'A case may only be created at the exposure’s own current truth state.' },
  // SPEC-003 §5.11.1 / §8.2's 409 list. VG-REAPPEAR-001's rule: a first-ever sighting is never labelled a
  // reappearance, and the refusal names the observed state so the caller learns the truth.
  { domainCode: 'REAPPEARANCE_WITHOUT_PRIOR_REMOVAL', wireCode: 'REAPPEARANCE_WITHOUT_PRIOR_REMOVAL', status: 409,
    retryable: false, message: 'This exposure has no prior removal to reappear from.' },
  // SPEC-003 §5.11.1's 422 list.
  { domainCode: 'INVALID_REQUEST', wireCode: 'PRIOR_REMOVED_EVENT_NOT_FOUND', status: 422, retryable: false,
    message: 'The referenced prior removal event does not resolve for this exposure.' },

  // SPEC-003 §5.9.1/§5.9.3. `CLAIMED_OUTCOME_UNSUPPORTED` is the code that keeps VG-VERIFY-004 enforceable at
  // the boundary: a controller's CLAIM may not be expressed as one of the system's truth states, so a caller
  // offering `VERIFIED_REMOVED` as a claim is refused rather than mapped onto one.
  { domainCode: 'INVALID_REQUEST', wireCode: 'REFUSAL_BASIS_REQUIRED', status: 422, retryable: false,
    message: 'A refusal must name the basis the controller gave.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'CLAIMED_OUTCOME_UNSUPPORTED', status: 422, retryable: false,
    message: 'A controller’s claim cannot be expressed as a truth state.' },
  { domainCode: 'EMAIL_THREAD_DUPLICATE', wireCode: 'EMAIL_THREAD_DUPLICATE', status: 409, retryable: false,
    message: 'A thread with one of these message ids is already recorded for this case.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'MESSAGE_ID_MALFORMED', status: 422, retryable: false,
    message: 'A message id must be an RFC 5322 msg-id of the form <local@domain>.' },

  // SPEC-003 §5.7.4/§5.7.5 / §8.2's 422 list.
  { domainCode: 'INVALID_REQUEST', wireCode: 'POLICY_DECISION_INCOMPLETE', status: 422, retryable: false,
    message: 'The policy decision is missing one of the four fields a decision must carry.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'RECIPE_NOT_ENABLED', status: 422, retryable: false,
    message: 'The named recipe is not enabled for this source.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'TRANSITION_NOT_ROUTEABLE', status: 422, retryable: false,
    message: 'That truth state is reachable only through its own effect or observation route.' },
  { domainCode: 'GUARD_NOT_SATISFIED', wireCode: 'GUARD_FAILED', status: 422, retryable: false,
    message: 'A guard for the requested transition was not satisfied.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'EVIDENCE_REQUIRED', status: 422, retryable: false,
    message: 'This transition requires recorded evidence.' },
  { domainCode: 'INVALID_REQUEST', wireCode: 'BYPASS_ATTEMPT_REFUSED', status: 422, retryable: false,
    message: 'A gate bypass attempt is refused and audited.' },

  { domainCode: 'PRECONDITION', wireCode: 'PRECONDITION_FAILED', status: 412, retryable: false,
    message: 'The supplied If-Match value does not match the current resource state.' },
  { domainCode: 'PRECONDITION', wireCode: 'PRECONDITION_REQUIRED', status: 428, retryable: false,
    message: 'An If-Match header is required for this operation.' },
  { domainCode: 'TRANSPORT', wireCode: 'PAYLOAD_TOO_LARGE', status: 413, retryable: false,
    message: 'The request body exceeds the permitted size.' },
  { domainCode: 'TRANSPORT', wireCode: 'UNSUPPORTED_MEDIA_TYPE', status: 415, retryable: false,
    message: 'The request media type is not supported.' },
  { domainCode: 'TRANSPORT', wireCode: 'RATE_LIMITED', status: 429, retryable: true,
    message: 'The rate limit for this operation has been reached.' },
  { domainCode: 'TRANSPORT', wireCode: 'INTERNAL_ERROR', status: 500, retryable: false,
    message: 'An unexpected server fault occurred.' },
  { domainCode: 'TRANSPORT', wireCode: 'EVIDENCE_EXPIRED_RETENTION', status: 410, retryable: false,
    message: 'The stored content has passed its retention window.' },

  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_SIGNATURE_INVALID', status: 401, retryable: false,
    message: 'The webhook signature could not be verified.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_KEY_UNKNOWN', status: 401, retryable: false,
    message: 'The webhook key identifier is not trusted.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW', status: 401, retryable: false,
    message: 'The webhook timestamp is outside the accepted window.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_NONCE_MISSING', status: 400, retryable: false,
    message: 'The webhook replay token is missing or malformed.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_NONCE_REPLAY', status: 409, retryable: false,
    message: 'This webhook delivery has already been processed.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_BINDING_NOT_FOUND', status: 404, retryable: false,
    message: 'The webhook destination is not recognised.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_CASE_STATE_CONFLICT', status: 409, retryable: false,
    message: 'The case cannot accept this webhook at its current state.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_ACTION_NOT_FOUND', status: 409, retryable: false,
    message: 'The referenced external action was not found.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_PROVIDER_RUN_MISMATCH', status: 409, retryable: false,
    message: 'The provider run does not match the referenced external action.' },
  { domainCode: 'WEBHOOK', wireCode: 'WEBHOOK_MAIL_PIECE_NOT_FOUND', status: 409, retryable: false,
    message: 'The referenced mail piece was not found.' },
]);

/**
 * Wire codes that legitimately carry MORE THAN ONE status, with the distinction that separates
 * them. These are not conflicts: SPEC-003 §8.2 lists each status deliberately.
 *
 * Any other duplicate wire code is an error, which `indexRegistry()` below enforces.
 */
export const WIRE_STATUS_AMBIGUITY: Readonly<Record<string, readonly number[]>> = {
  // 400 for a syntactically malformed body, 422 for a well-formed body failing semantic
  // validation. SPEC-003 §8.2 states both, with the parentheticals "(syntax)" and "(semantic)".
  SCHEMA_VALIDATION_FAILED: [400, 422],
  // One wire code for four domain causes; the domain token keeps them distinguishable in audit.
  DEPENDENCY_UNAVAILABLE: [503],
};

/**
 * Wire codes for which SPEC-006 §6.2 states MORE THAN ONE message template.
 *
 * `DEPENDENCY_UNAVAILABLE` is mapped from four domain classes, and §6.2 gives two different
 * templates for the same wire code:
 *
 *   | AUDIT_UNAVAILABLE     | DEPENDENCY_UNAVAILABLE | 503 | "A required dependency is unavailable; the operation was not performed." |
 *   | STORAGE_UNAVAILABLE   | DEPENDENCY_UNAVAILABLE | 503 | "A required dependency is unavailable; the operation was not performed." |
 *   | DEPENDENCY_UNAVAILABLE| DEPENDENCY_UNAVAILABLE | 503 | "A required dependency is unavailable."                       |
 *   | EXTERNAL_TIMEOUT (read)| DEPENDENCY_UNAVAILABLE| 503 | "A required dependency is unavailable."                       |
 *
 * This contradicts SPEC-006 H-3, which requires the message to be "a fixed, non-interpolated
 * template string **per code**". A client that receives one code with two possible messages cannot
 * depend on either, and SPEC-003 §8.1 says the message "may change; clients must never branch on
 * it" — but a code whose meaning is stable while its text varies is still a contract defect.
 *
 * RESOLUTION: the canonical row for the code is the one where the domain code EQUALS the wire code
 * (row `DEPENDENCY_UNAVAILABLE`), because that is the row that defines the code rather than one
 * that reaches it. Its template — the shorter one — is used. Recorded in EP-004 §12; neither
 * specification is edited in this node, and the parity test asserts the divergence still has this
 * shape so the resolution cannot rot silently.
 */
export const KNOWN_MESSAGE_CONFLICTS: Readonly<Record<string, readonly string[]>> = {
  DEPENDENCY_UNAVAILABLE: [
    'A required dependency is unavailable; the operation was not performed.',
    'A required dependency is unavailable.',
  ],
  // NOT a defect, and NOT a spec-stated conflict. SPEC-003 §8.2 gives this code two spellings —
  // "(syntax)" at 400 and "(semantic)" at 422 — but SPEC-006 §6.2 states a template for only the
  // syntactic one. The semantic template used here comes from the EP-004 plan's registry table and
  // has NO specification source; that is recorded as a finding rather than presented as a spec
  // quote. The canonical (400, syntactic) template is the one SPEC-006 states.
  SCHEMA_VALIDATION_FAILED: [
    'The request is well formed but fails a semantic validation.',
    'The request body is malformed.',
  ],
};

/** A single wire code's resolved definition: status, template and retryability. */
export interface WireCodeSpec {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly retryable: boolean;
  /** Every domain code that maps here. More than one means the wire code is a shared spelling. */
  readonly domainCodes: readonly string[];
}

export interface RegistryIndex {
  readonly byWireCode: ReadonlyMap<string, WireCodeSpec>;
  /** `domainCode -> wireCode` for the cases where a domain code has exactly one wire spelling. */
  readonly domainToWire: ReadonlyMap<string, readonly string[]>;
}

/**
 * Index the registry by wire code.
 *
 * Throws on a duplicate wire code with DIFFERING status, message or retryability, because that is
 * a registry defect that would make the response depend on row order. The two deliberate
 * multi-status codes are declared in `WIRE_STATUS_AMBIGUITY` and must be listed there.
 */
export function indexRegistry(rows: readonly ErrorCodeSpec[] = ERROR_CODE_REGISTRY): RegistryIndex {
  const byWireCode = new Map<string, { status: number; message: string; retryable: boolean; domainCodes: string[] }>();

  for (const row of rows) {
    const existing = byWireCode.get(row.wireCode);
    if (existing === undefined) {
      byWireCode.set(row.wireCode, {
        status: row.status,
        message: row.message,
        retryable: row.retryable,
        domainCodes: [row.domainCode],
      });
      continue;
    }

    const allowed = WIRE_STATUS_AMBIGUITY[row.wireCode] ?? [];
    if (!allowed.includes(row.status)) {
      throw new Error(
        `error registry defect: wire code ${row.wireCode} appears with status ${row.status} and ` +
          `${existing.status}, but only ${allowed.join(', ') || 'no statuses'} are declared for it`,
      );
    }
    if (existing.message !== row.message) {
      // A message conflict is permitted ONLY where SPEC-006 §6.2 itself states two templates for
      // one code. Anything else is a registry defect: a client cannot depend on which message it
      // receives for the same code. The canonical template is resolved after the merge, below.
      if (KNOWN_MESSAGE_CONFLICTS[row.wireCode] === undefined) {
        throw new Error(
          `error registry defect: wire code ${row.wireCode} has two different messages and no ` +
            'declared conflict; a client cannot depend on which one it receives',
        );
      }
    }
    if (existing.retryable !== row.retryable) {
      throw new Error(`error registry defect: wire code ${row.wireCode} has conflicting retryable flags`);
    }
    // A multi-status code keeps the LOWEST status as its canonical entry, and each status is
    // reachable through statusesFor().
    if (row.status < existing.status) {
      existing.status = row.status;
      existing.message = row.message;
    }
    if (!existing.domainCodes.includes(row.domainCode)) existing.domainCodes.push(row.domainCode);
  }

  const domainToWire = new Map<string, string[]>();
  for (const row of rows) {
    const list = domainToWire.get(row.domainCode) ?? [];
    if (!list.includes(row.wireCode)) list.push(row.wireCode);
    domainToWire.set(row.domainCode, list);
  }

  const finalByWire = new Map<string, WireCodeSpec>();
  for (const [code, value] of byWireCode) {
    // Resolve the canonical message for a declared conflict. Where a row's domain code EQUALS the
    // wire code, that row defines the code and its template wins (DEPENDENCY_UNAVAILABLE). Where
    // no such row exists, the template for the LOWEST status wins, which is the syntactic spelling
    // for SCHEMA_VALIDATION_FAILED (400). Both rules are deterministic, so the response text does
    // not depend on registry row order.
    let message = value.message;
    if (KNOWN_MESSAGE_CONFLICTS[code] !== undefined) {
      const defining = rows.find((r) => r.wireCode === code && r.domainCode === code);
      if (defining !== undefined) {
        message = defining.message;
      } else {
        const lowest = rows
          .filter((r) => r.wireCode === code)
          .reduce((best, r) => (r.status < best.status ? r : best));
        message = lowest.message;
      }
    }
    finalByWire.set(code, {
      code,
      status: value.status,
      message,
      retryable: value.retryable,
      domainCodes: value.domainCodes,
    });
  }
  return { byWireCode: finalByWire, domainToWire };
}

const INDEX = indexRegistry();

export const WIRE_CODES = [...INDEX.byWireCode.values()];

export type ErrorCode = string;

export function isErrorCode(value: string): value is ErrorCode {
  return INDEX.byWireCode.has(value);
}

/**
 * Every status a wire code may legitimately carry.
 *
 * `SCHEMA_VALIDATION_FAILED` has two, so a caller that needs one status must choose by the
 * distinction in `WIRE_STATUS_AMBIGUITY`, not by guessing. `statusFor` returns the canonical
 * (lowest) one, which is the syntactic 400.
 */
export function statusesFor(code: ErrorCode): readonly number[] {
  const spec = INDEX.byWireCode.get(code);
  if (spec === undefined) return [];
  return WIRE_STATUS_AMBIGUITY[code] ?? [spec.status];
}

export function statusFor(code: ErrorCode): number {
  const spec = INDEX.byWireCode.get(code);
  if (spec === undefined) {
    // An unknown code must never silently become a 200 or a 500 that hides the defect.
    throw new Error(`unknown wire error code: ${code}`);
  }
  return spec.status;
}

export function messageFor(code: ErrorCode): string {
  const spec = INDEX.byWireCode.get(code);
  if (spec === undefined) throw new Error(`unknown wire error code: ${code}`);
  return spec.message;
}

export function retryableFor(code: ErrorCode): boolean {
  const spec = INDEX.byWireCode.get(code);
  if (spec === undefined) throw new Error(`unknown wire error code: ${code}`);
  return spec.retryable;
}

/** The wire spelling for a domain code, or undefined when the domain code has no wire form. */
export function wireCodeForDomain(domainCode: string): readonly string[] {
  return INDEX.domainToWire.get(domainCode) ?? [];
}

/**
 * The allowlisted `details` keys (SPEC-003 §8.3).
 *
 * `details` never carries a request body, a value from a PII-bearing field, a stack trace, or an
 * upstream provider body. Only identifiers, enum tokens, guard names, counts and `ruleRef`.
 */
export const DETAILS_ALLOWLIST = [
  'field', 'ruleRef', 'fromTruthState', 'toTruthState', 'transitionCode', 'guard',
  'missingScopes', 'requiredScopes', 'heldScopes', 'sourceId', 'caseId', 'subjectId',
  'exposureId', 'authorityGrantId', 'recipeId', 'policyVersion', 'currentVersion',
  'retryAfterSeconds', 'limit', 'windowSeconds', 'providerReference', 'checks',
  'failedCheck', 'reason', 'candidateCount', 'expectedDigest', 'actualDigest',
  'requestedField', 'allowedFields', 'idempotencyKeyHash', 'gateKind',
  'earliestEligibleAt', 'timeRangeFrom', 'timeRangeTo', 'collection', 'filterName',
  // SPEC-003 §5.10.1 names these four in the refusal bodies themselves:
  // `422 OBSERVATION_WINDOW_NOT_MET` carries `{"requiredSeconds":…,"elapsedSeconds":…}` and
  // `422 OBSERVATION_METHOD_MISMATCH` carries `{"required":"…","supplied":"…"}`. All four are DURATIONS, METHOD
  // TOKENS or numbers — the caller's own request values and the instant arithmetic over them — so they disclose
  // nothing the request did not already contain. Without them the two refusals would have had to drop the fields
  // the contract specifies, which is the same gap §3.16 records for `currentEtag`.
  'requiredSeconds', 'elapsedSeconds', 'required', 'supplied',
  // SPEC-003 §4.3 names originalResourceId in the IDEMPOTENCY_KEY_REUSE conflict body. It is an
  // identifier in the caller's OWN tenant, never a request body value.
  'originalResourceId',
  // SPEC-003 §2.7: "a stale value is 412 PRECONDITION_FAILED with the current ETag in the body".
  // The current ETag is a concurrency TOKEN, not a resource value, and echoing it is what lets the
  // loser of a race re-read and re-issue instead of blind-retrying — which VG-ACTION-002 forbids.
  // The value is the same string the response's own `ETag` header carries, so this discloses nothing
  // the caller could not already read from the header.
  'currentEtag',
] as const;

export type DetailsKey = (typeof DETAILS_ALLOWLIST)[number];

export type ErrorDetails = Partial<Record<DetailsKey, string | number | boolean | readonly string[]>>;

/**
 * Tokens that must never appear as a `code` or in a `message`: they are success or lifecycle
 * words, and a code carrying one is how a failure gets reported as a success (SPEC-000 §5).
 */
export const FORBIDDEN_ADHOC_TOKENS = ['SUCCESS', 'DONE', 'COMPLETE', 'COMPLETED', 'REMOVED', 'OK', 'NONE'] as const;
