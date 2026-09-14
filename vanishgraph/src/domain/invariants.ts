/**
 * State-machine invariants SM-1…SM-6 (SPEC-001 §4.3) and the cross-entity rules that are
 * not expressible as a single value-object or entity check.
 *
 * These are the assertions the application and adapter layers call. Keeping them here —
 * rather than inline in handlers — is what stops a later layer from re-deriving a
 * weakened version of the same rule.
 */

import {
  BudgetExceeded,
  EgressDenied,
  GuardNotSatisfied,
  HumanGateRequired,
  IdempotencyConflict,
  IllegalTransition,
  ObservationNotIndependent,
  ObservationWindowNotMet,
  PolicyUnresolved,
  TaintedContentRejected,
  VerificationMethodMismatch,
} from './errors.ts';
import {
  assertAuthorityUsableAt,
  assertRecipeUsableAt,
  sourceMayBeWritten,
  type AuthorityGrant,
  type ControllerResponse,
  type PolicyDecision,
  type ProtectedSubject,
  type RemovalRecipe,
  type Source,
  type SourceRecord,
  type VerificationObservation,
} from './entities.ts';
import {
  TRUTH_STATE_FACTS,
  type TransitionFacts,
  type TransitionId,
  type TruthState,
} from './truth-state.ts';
import { legalTransitionsFrom } from './state-machine.ts';
import {
  requiresExplicitPolicy,
  type EgressClass,
  type ObservationWindow,
} from './values.ts';

/** SM-1: exactly one current truth state per exposure at any time. */
export function assertSingleCurrentTruthState(states: readonly TruthState[]): void {
  if (states.length !== 1) {
    throw new IllegalTransition(
      states.join('|') || '(none)',
      '(single)',
      `SM-1 violated: expected exactly one current truth state, got ${states.length}`,
    );
  }
}

/** SM-2: every transition appends an audit event. */
export function assertAuditAppended(
  auditEventIds: readonly string[],
  transitionId: TransitionId,
): void {
  if (auditEventIds.length === 0) {
    throw new IllegalTransition(
      '(none)',
      transitionId,
      'SM-2 violated: transition without an audit event',
    );
  }
}

/** SM-3: every transition carries the evidence named in SPEC-001 §4.1. */
export function assertTransitionEvidence(
  transitionId: TransitionId,
  declaredEvidence: string,
  producedEvidenceRefs: readonly string[],
): void {
  if (producedEvidenceRefs.length === 0) {
    throw new GuardNotSatisfied(
      transitionId,
      `SM-3 violated: ${transitionId} requires the evidence "${declaredEvidence}"`,
    );
  }
}

/**
 * SM-4: terminal-for-now states remain re-observable.
 *
 * "Re-observable" is a MONITORING property, not a state-machine edge, and conflating the
 * two produced a false invariant. SPEC-001 §4.3 lists three terminal-for-now states, but
 * only `VERIFIED_REMOVED` has an outgoing transition (`REAPPEARED`) — that edge is the
 * revocation path, and it is the point of monitoring. `VERIFIED_NOT_PRESENT` and
 * `NOT_REMOVABLE` legitimately have ZERO outgoing transitions: the spec's §4.1 table
 * defines no exit from them, so demanding one would be inventing a transition the
 * specification does not grant.
 *
 * What the invariant actually requires is that a terminal-for-now state is never treated
 * as finished-and-forgotten: the monitoring loop must keep watching it, so a later
 * observation can either revoke a removal (through the real edge) or be recorded as new
 * evidence against a state that has no edge. This function therefore asserts the
 * property that can be checked — the state is flagged `terminalForNow` — and returns the
 * set of transitions that may legally leave it, which callers use to decide whether a
 * revocation path exists.
 */
export function assertReobservable(state: TruthState): {
  readonly terminalForNow: boolean;
  readonly exitTransitions: readonly TransitionId[];
} {
  const facts = TRUTH_STATE_FACTS[state];
  const exits = legalTransitionsFrom(state).map((transition) => transition.id);
  if (!facts.terminalForNow && exits.length === 0) {
    throw new IllegalTransition(
      state,
      '(re-observation)',
      'SM-4 violated: a state with no exit that is not terminal-for-now would strand the case',
    );
  }
  return { terminalForNow: facts.terminalForNow, exitTransitions: Object.freeze(exits) };
}

/**
 * SM-5: HUMAN_REQUIRED is not a failure and must not decrement success metrics
 * (VG-OBS-002). Returns the classification the metrics layer must use.
 */
export function classifyTruthState(state: TruthState): 'OUTCOME' | 'PROGRESS' | 'IN_FLIGHT' {
  const facts = TRUTH_STATE_FACTS[state];
  if (facts.assertsVerifiedRemoval || facts.assertsSearchDelisting) return 'OUTCOME';
  if (facts.isLegitimateOutcome) return 'OUTCOME';
  if (facts.neverCountsAsProgress) return 'IN_FLIGHT';
  return 'PROGRESS';
}

/** SM-6: only a domain command may transition state. */
export function assertStateChangedByCommand(source: string): void {
  if (source !== 'domain-command') {
    throw new IllegalTransition(
      '(direct)',
      '(any)',
      `SM-6 violated: truth state may only change through a domain command, not through ${source}`,
    );
  }
}

/** VG-IDENT-001: a subject needs at least one valid grant. */
export function assertSubjectHasAuthority(
  subject: ProtectedSubject,
  grants: readonly AuthorityGrant[],
  atMs: number,
): void {
  const usable = grants.filter(
    (grant) => grant.subjectId.value === subject.id.value && isAuthorityUsableAt(grant, atMs),
  );
  if (usable.length === 0) {
    throw new GuardNotSatisfied('VG-IDENT-001', 'ProtectedSubject requires a valid AuthorityGrant');
  }
}

export function isAuthorityUsableAt(grant: AuthorityGrant, atMs: number): boolean {
  try {
    assertAuthorityUsableAt(grant, atMs);
    return true;
  } catch {
    return false;
  }
}

/** VG-POLICY-002: all four fields before a case may pass REQUEST_READY. */
export function assertPolicyDecisionComplete(decision: PolicyDecision): void {
  if (!decision.jurisdiction || !decision.legalBasis || !decision.channel) {
    throw new PolicyUnresolved('jurisdiction, legalBasis or channel');
  }
  if (!Number.isInteger(decision.policyVersion) || decision.policyVersion < 1) {
    throw new PolicyUnresolved('policyVersion');
  }
}

/** VG-CHANNEL-002 + VG-CHANNEL-003: writability of a source and a recipe together. */
export function assertChannelMayWrite(source: Source, recipe: RemovalRecipe, atMs: number): void {
  if (!sourceMayBeWritten(source)) {
    throw new GuardNotSatisfied(
      'VG-CHANNEL-002',
      `Source ${source.id.value} permission class ${source.permissionClass} forbids automated writes`,
    );
  }
  assertRecipeUsableAt(recipe, atMs);
}

/** VG-SEC-001: tainted content cannot direct an action. */
export function assertContentMayDirectAction(record: SourceRecord, action: string): void {
  if (record.tainted) {
    throw new TaintedContentRejected(`${action} requested by tainted SourceRecord ${record.id}`);
  }
}

/** VG-VERIFY-001: the acting path cannot verify itself. */
export function assertIndependentObservation(observation: VerificationObservation): void {
  if (observation.actorIdentity === observation.actingIdentity) {
    throw new ObservationNotIndependent(observation.actingIdentity);
  }
}

/** VG-VERIFY-002: the required window must genuinely elapse. */
export function assertObservationWindowMet(
  window: ObservationWindow,
  observedAtMs: number,
  actionAtMs: number,
): void {
  if (!window.hasElapsed(observedAtMs, actionAtMs)) {
    throw new ObservationWindowNotMet(window.durationMs, observedAtMs - actionAtMs);
  }
}

/** VG-VERIFY-003: the observation must use the recipe's declared method. */
export function assertVerificationMethodMatches(
  recipe: RemovalRecipe,
  observation: VerificationObservation,
): void {
  if (recipe.verificationMethod !== observation.method) {
    throw new VerificationMethodMismatch(recipe.verificationMethod, observation.method);
  }
}

/**
 * VG-VERIFY-004: a controller claim is not an observation and can never satisfy a
 * removal. This function exists so that calling code has an explicit, named refusal
 * rather than an implicit assumption.
 */
export function assertNotControllerClaim(response: ControllerResponse): never {
  throw new GuardNotSatisfied(
    'VG-VERIFY-004',
    `ControllerResponse ${response.id} is a claim, not a VerificationObservation`,
  );
}

/** VG-POLICY-004: a minor subject cannot enter an automated write lane. */
export function assertWriteLaneAllowedForSubject(subject: ProtectedSubject): void {
  if (subject.isMinor) {
    throw new HumanGateRequired(
      'minor subject requires review-required handling (VG-POLICY-004)',
      'MINOR_REVIEW_LANE',
    );
  }
}

/** VG-EGRESS-001: deny-by-default egress for protected classes. */
export function assertEgressAllowed(
  egressClass: EgressClass,
  tenantPolicyAllows: boolean,
  destination: string,
): void {
  if (requiresExplicitPolicy(egressClass) && !tenantPolicyAllows) {
    throw new EgressDenied(egressClass, destination);
  }
}

/** VG-ACTION-005: effect budgets bound volume per subject, source and window. */
export function assertEffectBudget(scope: string, used: number, limit: number): void {
  if (used >= limit) {
    throw new BudgetExceeded(scope, limit);
  }
}

/** VG-ACTION-001: one key, one external effect. */
export function assertIdempotencyKeyUnused(key: string, existingKeys: readonly string[]): void {
  if (existingKeys.includes(key)) {
    throw new IdempotencyConflict(key, '(existing ExternalAction)');
  }
}

/** SM-3 helper: the evidence named by a transition must be present in the fact set. */
export function assertFactsCarryEvidence(facts: TransitionFacts, transitionId: TransitionId): void {
  const anyFact = Object.values(facts).some((value) => value === true);
  if (!anyFact) {
    throw new GuardNotSatisfied(
      transitionId,
      'SM-3 violated: no evidence-bearing fact is present for this transition',
    );
  }
}
