/**
 * The Universal Removal State Machine engine (SPEC-001 §4).
 *
 * The table in `truth-state.ts` is the single source of truth. This module only
 * evaluates it. Adapters, HTTP handlers, and model output must never set a truth
 * state directly (SPEC-001 §4.3 SM-6) — they call these functions.
 *
 * Design notes that matter for correctness:
 *  - Forbidden pairs are checked BEFORE the legal table, so an attempt to jump
 *    from REQUEST_SUBMITTED to VERIFIED_REMOVED reports "removal theater", not a
 *    generic "no such transition". Diagnostic fidelity is a safety property here.
 *  - A failed guard never mutates anything. The function either returns a result
 *    or throws; there is no partial application.
 *  - `VERIFIED_REMOVED` gets a dedicated error when the only missing fact is
 *    independence, because that specific failure is the product's core risk.
 */

import {
  DomainError,
  GuardNotSatisfied,
  IllegalTransition,
  ObservationNotIndependent,
} from './errors.ts';
import {
  FORBIDDEN_TRANSITIONS,
  LEGAL_TRANSITIONS,
  type TransitionFacts,
  type TransitionId,
  type TransitionSpec,
  type TruthState,
  ALL_TRUTH_STATES,
} from './truth-state.ts';

export interface TransitionResult {
  readonly id: TransitionId;
  readonly from: TruthState | null;
  readonly to: TruthState;
  readonly evidence: string;
}

/** Initial states, i.e. transitions whose `from` is null (creation). */
export function initialStateSpecs(): readonly TransitionSpec[] {
  return LEGAL_TRANSITIONS.filter((t) => t.from === null);
}

/** Every transition whose `from` matches the current state. */
export function legalTransitionsFrom(from: TruthState): readonly TransitionSpec[] {
  return LEGAL_TRANSITIONS.filter((t) => t.from === from);
}

/** The spec for a specific pair, or undefined when the pair is not legal. */
export function findTransition(from: TruthState, to: TruthState): TransitionSpec | undefined {
  return LEGAL_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** The recorded reason a pair is forbidden, or undefined. */
export function forbiddenReason(from: TruthState, to: TruthState): string | undefined {
  return FORBIDDEN_TRANSITIONS.find((t) => t.from === from && t.to === to)?.reason;
}

/**
 * Attempt a transition. On success returns the applied transition; on refusal
 * throws a typed DomainError and changes nothing.
 */
export function applyTransition(
  from: TruthState,
  to: TruthState,
  facts: TransitionFacts,
): TransitionResult {
  const forbidden = forbiddenReason(from, to);
  if (forbidden !== undefined) {
    throw new IllegalTransition(from, to, forbidden);
  }

  const spec = findTransition(from, to);
  if (spec === undefined) {
    throw new IllegalTransition(
      from,
      to,
      'no such transition exists in the legal table (SPEC-001 4.1)',
    );
  }

  if (!spec.guard.satisfiedBy(facts)) {
    // Prefer the most specific diagnosis available for the highest-risk target.
    if (to === 'VERIFIED_REMOVED' && !facts.independentObservation) {
      throw new ObservationNotIndependent('acting-path');
    }
    throw new GuardNotSatisfied(spec.id, spec.guard.description);
  }

  return { id: spec.id, from: spec.from, to: spec.to, evidence: spec.evidence };
}

/**
 * Create an initial state (T1 or T2). Separated from `applyTransition` because
 * there is no prior state to move from, and conflating the two would let a caller
 * "transition" into an initial state from an arbitrary current one.
 */
export function applyInitialState(to: TruthState, facts: TransitionFacts): TransitionResult {
  const spec = initialStateSpecs().find((t) => t.to === to);
  if (spec === undefined) {
    throw new IllegalTransition('(none)', to, 'not a legal initial state (SPEC-001 4.1)');
  }
  if (!spec.guard.satisfiedBy(facts)) {
    throw new GuardNotSatisfied(spec.id, spec.guard.description);
  }
  return { id: spec.id, from: null, to: spec.to, evidence: spec.evidence };
}

/** Transitions whose guard is currently satisfied — the real, evidence-backed options. */
export function availableTransitions(
  from: TruthState,
  facts: TransitionFacts,
): readonly TransitionSpec[] {
  return legalTransitionsFrom(from).filter((t) => t.guard.satisfiedBy(facts));
}

/** True when `value` is a member of the canonical eleven states. */
export function isTruthState(value: unknown): value is TruthState {
  return typeof value === 'string' && (ALL_TRUTH_STATES as readonly string[]).includes(value);
}

/**
 * Invariant SM-1 helper: exactly one truth state per exposure at a time is a data
 * property, but the machine can assert that a proposed set is a single member.
 */
export function assertSingleState(states: readonly TruthState[]): void {
  if (states.length !== 1) {
    throw new IllegalTransition(
      states.join('|') || '(none)',
      '(single)',
      `SM-1 violated: expected exactly one current truth state, got ${states.length}`,
    );
  }
}

/** Build a fact set with everything false, overridden per test. Avoids fixtures
 *  that accidentally satisfy guards. */
export function noFacts(overrides: Partial<TransitionFacts> = {}): TransitionFacts {
  const base: TransitionFacts = {
    sourceRecordObserved: false,
    scanCoverageSufficient: false,
    confidenceAtThreshold: false,
    confidenceBasisRecorded: false,
    humanApprovedMatch: false,
    subjectMatchDisproved: false,
    authorityValid: false,
    policyDecisionComplete: false,
    recipeSignedAndFresh: false,
    channelPermitted: false,
    exemptionRecorded: false,
    lawfulRefusalFinal: false,
    freshAuthorityPolicyRecipe: false,
    humanGateDetected: false,
    idempotencyKeyAssigned: false,
    budgetAvailable: false,
    actionSubmitted: false,
    controllerResponded: false,
    independentObservation: false,
    observationWindowMet: false,
    verificationMethodMatches: false,
    recordAbsent: false,
    recordPresentAgain: false,
    searchEngineSource: false,
    delistingObserved: false,
  };
  return { ...base, ...overrides };
}

/** Facts sufficient for the happy path to VERIFIED_REMOVED, for tests. */
export function happyPathFacts(overrides: Partial<TransitionFacts> = {}): TransitionFacts {
  return noFacts({
    sourceRecordObserved: true,
    confidenceAtThreshold: true,
    confidenceBasisRecorded: true,
    authorityValid: true,
    policyDecisionComplete: true,
    recipeSignedAndFresh: true,
    channelPermitted: true,
    idempotencyKeyAssigned: true,
    budgetAvailable: true,
    controllerResponded: true,
    independentObservation: true,
    observationWindowMet: true,
    verificationMethodMatches: true,
    recordAbsent: true,
    ...overrides,
  });
}

export { DomainError };
