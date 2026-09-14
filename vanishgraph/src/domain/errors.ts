/**
 * Domain error taxonomy.
 *
 * SPEC-006 (errors) and DOD-032 require three distinct things that are commonly
 * and dangerously conflated:
 *
 *   OUTCOME        a legitimate product result (NOT_REMOVABLE, HUMAN_REQUIRED).
 *                  NOT an error. Must never decrement a success metric.
 *   CANDIDATE_FAILURE  the system worked; the outside world did not cooperate.
 *   SYSTEM_ERROR   our own code, configuration, or infrastructure is broken.
 *
 * Misclassifying these is itself a defect. `HUMAN_REQUIRED` recorded as an error
 * would make a lawful human gate look like a bug; a `SYSTEM_ERROR` recorded as a
 * candidate failure would hide our own breakage behind the outside world.
 *
 * SPEC-001 §4.2 also requires every illegal state transition to be refused with a
 * typed error that names the violated rule, leaving state unchanged.
 */

/** The three-way classification from SPEC-006. */
export type ErrorClassification = 'CANDIDATE_FAILURE' | 'SYSTEM_ERROR';

/** Base class for every domain error. Never carries PII (VG-SEC-002). */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly classification: ErrorClassification;
  abstract readonly retryable: boolean;
  /** Opaque identifiers only. Never a subject name, email, phone, or document. */
  readonly details: Readonly<Record<string, string>>;

  constructor(message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * Raised when a transition not present in the legal table (SPEC-001 §4.1) is
 * attempted. Names the specific forbidden pair so the negative tests can assert
 * on it, and so logs explain *why* rather than just "invalid".
 */
export class IllegalTransition extends DomainError {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string, reason: string) {
    super(`Illegal transition ${from} -> ${to}: ${reason}`, { from, to });
    this.from = from;
    this.to = to;
  }
}

/** A guard required by SPEC-001 §4.1 was not satisfied, so the transition is refused. */
export class GuardNotSatisfied extends DomainError {
  readonly code = 'GUARD_NOT_SATISFIED';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(transitionId: string, guard: string) {
    super(`Guard for ${transitionId} not satisfied: ${guard}`, { transitionId, guard });
  }
}

/** VG-AUTHZ-001 / VG-AUTH-024: no valid grant at execution time. */
export class AuthorityExpired extends DomainError {
  readonly code = 'AUTHORITY_EXPIRED';
  readonly classification: ErrorClassification = 'CANDIDATE_FAILURE';
  readonly retryable = false;

  constructor(grantId: string, at: string) {
    super(`AuthorityGrant ${grantId} is expired or revoked at ${at}`, { grantId });
  }
}

export class AuthorityMissing extends DomainError {
  readonly code = 'AUTHORITY_MISSING';
  readonly classification: ErrorClassification = 'CANDIDATE_FAILURE';
  readonly retryable = false;

  constructor(subjectId: string) {
    super(`ProtectedSubject ${subjectId} has no valid AuthorityGrant`, { subjectId });
  }
}

/** VG-AUTHZ-004 / VG-AUTH-025: action falls outside the grant's declared scope. */
export class AuthorityScopeViolation extends DomainError {
  readonly code = 'AUTHORITY_SCOPE_VIOLATION';
  readonly classification: ErrorClassification = 'CANDIDATE_FAILURE';
  readonly retryable = false;

  constructor(grantId: string, requiredScope: string, heldScopes: readonly string[]) {
    super(
      `AuthorityGrant ${grantId} lacks scope '${requiredScope}' (held: ${heldScopes.join(', ') || 'none'})`,
      { grantId, requiredScope },
    );
  }
}

/** VG-POLICY-002: a PolicyDecision is incomplete and cannot unlock REQUEST_READY. */
export class PolicyUnresolved extends DomainError {
  readonly code = 'POLICY_UNRESOLVED';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(missingField: string) {
    super(`PolicyDecision is incomplete: missing ${missingField}`, { missingField });
  }
}

/**
 * VG-POLICY-001 / SPEC-000 §8: no lawful basis exists. This is a legitimate
 * terminal product outcome (NOT_REMOVABLE), not a failure and never retried.
 */
export class NoLawfulBasis extends DomainError {
  readonly code = 'NO_LAWFUL_BASIS';
  readonly classification: ErrorClassification = 'CANDIDATE_FAILURE';
  readonly retryable = false;

  constructor(jurisdiction: string, reason: string) {
    super(`No lawful removal path in ${jurisdiction}: ${reason}`, { jurisdiction });
  }
}

/** VG-CHANNEL-003: a stale recipe must never write. */
export class RecipeStale extends DomainError {
  readonly code = 'RECIPE_STALE';
  readonly classification: ErrorClassification = 'CANDIDATE_FAILURE';
  readonly retryable = false;

  constructor(recipeId: string, freshnessAt: string, now: string) {
    super(`RemovalRecipe ${recipeId} is stale (fresh as of ${freshnessAt}, now ${now})`, {
      recipeId,
    });
  }
}

export class RecipeUnsigned extends DomainError {
  readonly code = 'RECIPE_UNSIGNED';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(recipeId: string) {
    super(`RemovalRecipe ${recipeId} has no valid signature`, { recipeId });
  }
}

/** VG-CHANNEL-002: permission class unclear or prohibited means no write, ever. */
export class PermissionUnclear extends DomainError {
  readonly code = 'PERMISSION_UNCLEAR';
  readonly classification: ErrorClassification = 'CANDIDATE_FAILURE';
  readonly retryable = false;

  constructor(sourceId: string, permissionClass: string) {
    super(`Source ${sourceId} permission class '${permissionClass}' forbids automated writes`, {
      sourceId,
      permissionClass,
    });
  }
}

/** VG-ACTION-001: one idempotency key maps to at most one external effect. */
export class IdempotencyConflict extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(key: string, existingActionId: string) {
    super(`IdempotencyKey already bound to ExternalAction ${existingActionId}`, {
      existingActionId,
    });
    void key; // deliberately not echoed: keys may be tenant-derived
  }
}

/**
 * VG-ACTION-002: an external effect's result is unknown. Must reconcile, never
 * blindly retry — a blind retry can produce a duplicate certified letter.
 */
export class AmbiguousExternalEffect extends DomainError {
  readonly code = 'AMBIGUOUS_EXTERNAL_EFFECT';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(actionId: string) {
    super(`ExternalAction ${actionId} result is ambiguous; reconciliation required`, { actionId });
  }
}

/** VG-ACTION-005: effect budget exhausted for this subject/source/window. */
export class BudgetExceeded extends DomainError {
  readonly code = 'BUDGET_EXCEEDED';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(scope: string, limit: number) {
    super(`Effect budget exceeded for ${scope} (limit ${limit})`, { scope, limit: String(limit) });
  }
}

/** VG-SEC-001: untrusted remote content attempted to direct an action. */
export class TaintedContentRejected extends DomainError {
  readonly code = 'TAINTED_CONTENT_REJECTED';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(context: string) {
    super(`Tainted (untrusted) content cannot direct this action: ${context}`, { context });
  }
}

/** VG-EGRESS-001: default-deny egress for protected data classes. */
export class EgressDenied extends DomainError {
  readonly code = 'EGRESS_DENIED';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(egressClass: string, destination: string) {
    super(`Egress denied for ${egressClass} to ${destination}`, { egressClass, destination });
  }
}

/** VG-EVIDENCE-001: content-addressed artifact failed digest verification. */
export class DigestMismatch extends DomainError {
  readonly code = 'DIGEST_MISMATCH';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(expected: string, actual: string) {
    super(`Evidence digest mismatch (expected ${expected}, got ${actual})`, {});
  }
}

/** VG-TENANT-001: an operation crossed a tenant boundary. */
export class TenantViolation extends DomainError {
  readonly code = 'TENANT_VIOLATION';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(operation: string) {
    super(`Tenant boundary violated during ${operation}`, { operation });
  }
}

/**
 * VG-VERIFY-001 / VG-VERIFY-003: the observation that would prove removal came
 * from the acting path, or used a method other than the recipe's declared one.
 * This is the guard that stops removal theater.
 */
export class ObservationNotIndependent extends DomainError {
  readonly code = 'OBSERVATION_NOT_INDEPENDENT';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(actorIdentity: string) {
    super(
      `VerificationObservation actor '${actorIdentity}' is the acting identity; independent observation required`,
      {},
    );
  }
}

/** VG-VERIFY-002: the required observation window has not elapsed. */
export class ObservationWindowNotMet extends DomainError {
  readonly code = 'OBSERVATION_WINDOW_NOT_MET';
  readonly classification: ErrorClassification = 'CANDIDATE_FAILURE';
  readonly retryable = true;

  constructor(requiredMs: number, elapsedMs: number) {
    super(
      `Observation window not met: required ${requiredMs}ms, elapsed ${elapsedMs}ms`,
      { requiredMs: String(requiredMs), elapsedMs: String(elapsedMs) },
    );
  }
}

/** VG-VERIFY-003: observation method differs from the recipe's declared method. */
export class VerificationMethodMismatch extends DomainError {
  readonly code = 'VERIFICATION_METHOD_MISMATCH';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(required: string, actual: string) {
    super(`Verification method mismatch: recipe requires '${required}', got '${actual}'`, {
      required,
      actual,
    });
  }
}

/**
 * A legitimate human/identity/legal gate exists. NOT an error and NOT a failure:
 * it is the correct outcome when the system refuses to bypass a control
 * (VG-DISC-004, VG-AUTHZ-002, research brief §6).
 */
export class HumanGateRequired extends DomainError {
  readonly code = 'HUMAN_GATE_REQUIRED';
  readonly classification: ErrorClassification = 'CANDIDATE_FAILURE';
  readonly retryable = false;

  constructor(reason: string, gateKind: string) {
    super(`Human gate required (${gateKind}): ${reason}`, { gateKind });
  }
}

/** A value object was constructed with invalid input. */
export class InvalidValueObject extends DomainError {
  readonly code = 'INVALID_VALUE_OBJECT';
  readonly classification: ErrorClassification = 'SYSTEM_ERROR';
  readonly retryable = false;

  constructor(valueObject: string, reason: string) {
    super(`Invalid ${valueObject}: ${reason}`, { valueObject });
  }
}
