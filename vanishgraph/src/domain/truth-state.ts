/**
 * The eleven product truth states (SPEC-000 §5) and the closed transition table
 * (SPEC-001 §4.1 / §4.2).
 *
 * These states are NOT progress indicators and are NOT interchangeable.
 * Collapsing any two is a fabrication defect under DOD-027. In particular:
 *   REQUEST_SUBMITTED is not removal.
 *   ACKNOWLEDGED      is not removal.
 *   SEARCH_DELISTED   is not source deletion.
 * Only VERIFIED_REMOVED asserts a verified removal, and it requires an
 * independent observation (VG-VERIFY-001).
 */

export type TruthState =
  | 'DISCOVERED_CANDIDATE'
  | 'MATCH_CONFIRMED'
  | 'REQUEST_READY'
  | 'REQUEST_SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'VERIFIED_REMOVED'
  | 'SEARCH_DELISTED'
  | 'VERIFIED_NOT_PRESENT'
  | 'NOT_REMOVABLE'
  | 'HUMAN_REQUIRED'
  | 'REAPPEARED';

/** The canonical state list, in SPEC-000 §5 order. Exactly eleven members. */
export const ALL_TRUTH_STATES = [
  'DISCOVERED_CANDIDATE',
  'MATCH_CONFIRMED',
  'REQUEST_READY',
  'REQUEST_SUBMITTED',
  'ACKNOWLEDGED',
  'VERIFIED_REMOVED',
  'SEARCH_DELISTED',
  'VERIFIED_NOT_PRESENT',
  'NOT_REMOVABLE',
  'HUMAN_REQUIRED',
  'REAPPEARED',
] as const satisfies readonly TruthState[];

export interface TruthStateFacts {
  /** True only for VERIFIED_REMOVED. Nothing else may count as a removal. */
  readonly assertsVerifiedRemoval: boolean;
  /** True only for SEARCH_DELISTED. Never implies source deletion. */
  readonly assertsSearchDelisting: boolean;
  /** True when the state is a legitimate stopping point that remains re-observable. */
  readonly terminalForNow: boolean;
  /** True when the state is a legitimate product outcome, not an error. */
  readonly isLegitimateOutcome: boolean;
  /** True when reaching this state required an independent observation. */
  readonly requiresIndependentObservation: boolean;
  /** True when the state must never be reported as progress toward removal. */
  readonly neverCountsAsProgress: boolean;
}

/**
 * Non-collapse rules encoded as data, so tests assert on facts rather than on
 * prose. SPEC-000 §5.1 is binding.
 */
export const TRUTH_STATE_FACTS: Readonly<Record<TruthState, TruthStateFacts>> = Object.freeze({
  DISCOVERED_CANDIDATE: {
    assertsVerifiedRemoval: false,
    assertsSearchDelisting: false,
    terminalForNow: false,
    isLegitimateOutcome: false,
    requiresIndependentObservation: false,
    neverCountsAsProgress: false,
  },
  MATCH_CONFIRMED: {
    assertsVerifiedRemoval: false,
    assertsSearchDelisting: false,
    terminalForNow: false,
    isLegitimateOutcome: false,
    requiresIndependentObservation: false,
    neverCountsAsProgress: false,
  },
  REQUEST_READY: {
    assertsVerifiedRemoval: false,
    assertsSearchDelisting: false,
    terminalForNow: false,
    isLegitimateOutcome: false,
    requiresIndependentObservation: false,
    neverCountsAsProgress: false,
  },
  REQUEST_SUBMITTED: {
    assertsVerifiedRemoval: false,
    assertsSearchDelisting: false,
    terminalForNow: false,
    isLegitimateOutcome: false,
    requiresIndependentObservation: false,
    // A submitted request is the single most commonly misrepresented state.
    neverCountsAsProgress: true,
  },
  ACKNOWLEDGED: {
    assertsVerifiedRemoval: false,
    assertsSearchDelisting: false,
    terminalForNow: false,
    isLegitimateOutcome: false,
    requiresIndependentObservation: false,
    neverCountsAsProgress: true,
  },
  VERIFIED_REMOVED: {
    assertsVerifiedRemoval: true,
    assertsSearchDelisting: false,
    terminalForNow: true,
    isLegitimateOutcome: true,
    requiresIndependentObservation: true,
    neverCountsAsProgress: false,
  },
  SEARCH_DELISTED: {
    assertsVerifiedRemoval: false,
    assertsSearchDelisting: true,
    terminalForNow: false,
    isLegitimateOutcome: true,
    requiresIndependentObservation: false,
    neverCountsAsProgress: false,
  },
  VERIFIED_NOT_PRESENT: {
    assertsVerifiedRemoval: false,
    assertsSearchDelisting: false,
    terminalForNow: true,
    isLegitimateOutcome: true,
    requiresIndependentObservation: false,
    neverCountsAsProgress: false,
  },
  NOT_REMOVABLE: {
    assertsVerifiedRemoval: false,
    assertsSearchDelisting: false,
    terminalForNow: true,
    // A lawful exemption is a correct answer, not a failure to be hidden.
    isLegitimateOutcome: true,
    requiresIndependentObservation: false,
    neverCountsAsProgress: false,
  },
  HUMAN_REQUIRED: {
    assertsVerifiedRemoval: false,
    assertsSearchDelisting: false,
    terminalForNow: true,
    isLegitimateOutcome: true,
    requiresIndependentObservation: false,
    // Must not be reported as failure, nor silently suppressed (VG-OBS-002).
    neverCountsAsProgress: false,
  },
  REAPPEARED: {
    assertsVerifiedRemoval: false,
    assertsSearchDelisting: false,
    terminalForNow: false,
    isLegitimateOutcome: false,
    requiresIndependentObservation: false,
    neverCountsAsProgress: false,
  },
});

export type TransitionId =
  | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8' | 'T9' | 'T10' | 'T11'
  | 'T12' | 'T13' | 'T14' | 'T15' | 'T16' | 'T17' | 'T18' | 'T19' | 'T20' | 'T21';

/** Facts the machine needs in order to evaluate the guards of SPEC-001 §4.1. */
export interface TransitionFacts {
  // Discovery / matching
  readonly sourceRecordObserved: boolean;
  readonly scanCoverageSufficient: boolean;
  readonly confidenceAtThreshold: boolean;
  readonly confidenceBasisRecorded: boolean;
  readonly humanApprovedMatch: boolean;
  readonly subjectMatchDisproved: boolean;
  // Authority / policy / channel
  readonly authorityValid: boolean;
  readonly policyDecisionComplete: boolean;
  readonly recipeSignedAndFresh: boolean;
  readonly channelPermitted: boolean;
  readonly exemptionRecorded: boolean;
  readonly lawfulRefusalFinal: boolean;
  readonly freshAuthorityPolicyRecipe: boolean;
  // Gates
  readonly humanGateDetected: boolean;
  // Action
  readonly idempotencyKeyAssigned: boolean;
  readonly budgetAvailable: boolean;
  readonly actionSubmitted: boolean;
  // Controller
  readonly controllerResponded: boolean;
  // Verification
  readonly independentObservation: boolean;
  readonly observationWindowMet: boolean;
  readonly verificationMethodMatches: boolean;
  readonly recordAbsent: boolean;
  readonly recordPresentAgain: boolean;
  // Search track
  readonly searchEngineSource: boolean;
  readonly delistingObserved: boolean;
}

/** A guard is a named predicate over observed facts. */
export interface Guard {
  readonly description: string;
  readonly satisfiedBy: (f: TransitionFacts) => boolean;
}

const all =
  (...guards: readonly Guard[]): Guard => ({
    description: guards.map((g) => g.description).join(' AND '),
    satisfiedBy: (f) => guards.every((g) => g.satisfiedBy(f)),
  });

const anyOf =
  (...guards: readonly Guard[]): Guard => ({
    description: `(${guards.map((g) => g.description).join(' OR ')})`,
    satisfiedBy: (f) => guards.some((g) => g.satisfiedBy(f)),
  });

export const GUARDS = {
  sourceRecordObserved: { description: 'source record observed', satisfiedBy: (f: TransitionFacts) => f.sourceRecordObserved },
  scanCoverageSufficient: { description: 'scan coverage sufficient', satisfiedBy: (f: TransitionFacts) => f.scanCoverageSufficient },
  confidenceBasisRecorded: { description: 'confidence basis recorded', satisfiedBy: (f: TransitionFacts) => f.confidenceBasisRecorded },
  confidenceAtThreshold: { description: 'confidence at or above threshold', satisfiedBy: (f: TransitionFacts) => f.confidenceAtThreshold },
  humanApprovedMatch: { description: 'human approved the match', satisfiedBy: (f: TransitionFacts) => f.humanApprovedMatch },
  subjectMatchDisproved: { description: 'subject match disproved', satisfiedBy: (f: TransitionFacts) => f.subjectMatchDisproved },
  authorityValid: { description: 'authority valid', satisfiedBy: (f: TransitionFacts) => f.authorityValid },
  policyDecisionComplete: { description: 'policy decision complete', satisfiedBy: (f: TransitionFacts) => f.policyDecisionComplete },
  recipeSignedAndFresh: { description: 'recipe signed and fresh', satisfiedBy: (f: TransitionFacts) => f.recipeSignedAndFresh },
  channelPermitted: { description: 'channel permitted', satisfiedBy: (f: TransitionFacts) => f.channelPermitted },
  exemptionRecorded: { description: 'exemption recorded', satisfiedBy: (f: TransitionFacts) => f.exemptionRecorded },
  lawfulRefusalFinal: { description: 'lawful refusal is final', satisfiedBy: (f: TransitionFacts) => f.lawfulRefusalFinal },
  freshAuthorityPolicyRecipe: { description: 'fresh authority, policy and recipe', satisfiedBy: (f: TransitionFacts) => f.freshAuthorityPolicyRecipe },
  humanGateDetected: { description: 'human gate detected', satisfiedBy: (f: TransitionFacts) => f.humanGateDetected },
  idempotencyKeyAssigned: { description: 'idempotency key assigned', satisfiedBy: (f: TransitionFacts) => f.idempotencyKeyAssigned },
  budgetAvailable: { description: 'effect budget available', satisfiedBy: (f: TransitionFacts) => f.budgetAvailable },
  controllerResponded: { description: 'controller responded', satisfiedBy: (f: TransitionFacts) => f.controllerResponded },
  independentObservation: { description: 'independent observation', satisfiedBy: (f: TransitionFacts) => f.independentObservation },
  observationWindowMet: { description: 'observation window met', satisfiedBy: (f: TransitionFacts) => f.observationWindowMet },
  verificationMethodMatches: { description: 'verification method matches recipe', satisfiedBy: (f: TransitionFacts) => f.verificationMethodMatches },
  recordAbsent: { description: 'record no longer present', satisfiedBy: (f: TransitionFacts) => f.recordAbsent },
  recordPresentAgain: { description: 'record observed again', satisfiedBy: (f: TransitionFacts) => f.recordPresentAgain },
  searchEngineSource: { description: 'source is a search engine', satisfiedBy: (f: TransitionFacts) => f.searchEngineSource },
  delistingObserved: { description: 'delisting observed', satisfiedBy: (f: TransitionFacts) => f.delistingObserved },
} as const satisfies Record<string, Guard>;

export interface TransitionSpec {
  readonly id: TransitionId;
  /** `null` means the state is an initial state (creation), not a transition. */
  readonly from: TruthState | null;
  readonly to: TruthState;
  readonly guard: Guard;
  /** Evidence that must be produced by this transition (SPEC-001 §4.1). */
  readonly evidence: string;
}

/**
 * The complete legal transition table. Any pair not present here is illegal.
 * Order matches SPEC-001 §4.1 exactly.
 */
export const LEGAL_TRANSITIONS: readonly TransitionSpec[] = Object.freeze([
  { id: 'T1', from: null, to: 'DISCOVERED_CANDIDATE', guard: GUARDS.sourceRecordObserved, evidence: 'SourceRecord + observation' },
  { id: 'T2', from: null, to: 'VERIFIED_NOT_PRESENT', guard: GUARDS.scanCoverageSufficient, evidence: 'coverage bounds + scan evidence' },
  {
    id: 'T3',
    from: 'DISCOVERED_CANDIDATE',
    to: 'MATCH_CONFIRMED',
    guard: all(GUARDS.confidenceBasisRecorded, anyOf(GUARDS.confidenceAtThreshold, GUARDS.humanApprovedMatch)),
    evidence: 'match basis record',
  },
  { id: 'T4', from: 'DISCOVERED_CANDIDATE', to: 'VERIFIED_NOT_PRESENT', guard: GUARDS.subjectMatchDisproved, evidence: 'disproof record' },
  {
    id: 'T5',
    from: 'MATCH_CONFIRMED',
    to: 'REQUEST_READY',
    guard: all(GUARDS.authorityValid, GUARDS.policyDecisionComplete, GUARDS.recipeSignedAndFresh, GUARDS.channelPermitted),
    evidence: 'PolicyDecision',
  },
  { id: 'T6', from: 'MATCH_CONFIRMED', to: 'NOT_REMOVABLE', guard: GUARDS.exemptionRecorded, evidence: 'exemption basis' },
  { id: 'T7', from: 'MATCH_CONFIRMED', to: 'HUMAN_REQUIRED', guard: GUARDS.humanGateDetected, evidence: 'gate classification' },
  {
    id: 'T8',
    from: 'REQUEST_READY',
    to: 'REQUEST_SUBMITTED',
    guard: all(GUARDS.authorityValid, GUARDS.idempotencyKeyAssigned, GUARDS.budgetAvailable, GUARDS.recipeSignedAndFresh, GUARDS.channelPermitted),
    evidence: 'ExternalAction',
  },
  { id: 'T9', from: 'REQUEST_READY', to: 'HUMAN_REQUIRED', guard: GUARDS.humanGateDetected, evidence: 'gate record' },
  { id: 'T10', from: 'REQUEST_READY', to: 'NOT_REMOVABLE', guard: GUARDS.exemptionRecorded, evidence: 'basis' },
  { id: 'T11', from: 'REQUEST_SUBMITTED', to: 'ACKNOWLEDGED', guard: GUARDS.controllerResponded, evidence: 'ControllerResponse' },
  { id: 'T12', from: 'REQUEST_SUBMITTED', to: 'HUMAN_REQUIRED', guard: GUARDS.humanGateDetected, evidence: 'gate record' },
  { id: 'T13', from: 'REQUEST_SUBMITTED', to: 'NOT_REMOVABLE', guard: GUARDS.exemptionRecorded, evidence: 'refusal basis' },
  {
    id: 'T14',
    from: 'ACKNOWLEDGED',
    to: 'VERIFIED_REMOVED',
    guard: all(GUARDS.independentObservation, GUARDS.observationWindowMet, GUARDS.verificationMethodMatches, GUARDS.recordAbsent),
    evidence: 'VerificationObservation',
  },
  { id: 'T15', from: 'ACKNOWLEDGED', to: 'NOT_REMOVABLE', guard: GUARDS.lawfulRefusalFinal, evidence: 'refusal basis' },
  { id: 'T16', from: 'ACKNOWLEDGED', to: 'HUMAN_REQUIRED', guard: GUARDS.humanGateDetected, evidence: 'gate record' },
  { id: 'T17', from: 'VERIFIED_REMOVED', to: 'REAPPEARED', guard: GUARDS.recordPresentAgain, evidence: 'Reappearance + evidence' },
  {
    id: 'T18',
    from: 'REAPPEARED',
    to: 'REQUEST_READY',
    guard: all(GUARDS.freshAuthorityPolicyRecipe, GUARDS.authorityValid, GUARDS.policyDecisionComplete, GUARDS.recipeSignedAndFresh),
    evidence: 'new PolicyDecision',
  },
  { id: 'T19', from: 'REAPPEARED', to: 'NOT_REMOVABLE', guard: GUARDS.exemptionRecorded, evidence: 'basis' },
  { id: 'T20', from: 'SEARCH_DELISTED', to: 'REAPPEARED', guard: GUARDS.recordPresentAgain, evidence: 'search observation' },
  {
    id: 'T21',
    from: 'MATCH_CONFIRMED',
    to: 'SEARCH_DELISTED',
    guard: all(GUARDS.searchEngineSource, GUARDS.delistingObserved),
    evidence: 'search observation',
  },
]);

/**
 * Forbidden transitions with the reason each is forbidden (SPEC-001 §4.2).
 * These are checked *before* the legal table so the error message names the real
 * danger rather than a generic "no such transition".
 */
export interface ForbiddenTransition {
  readonly from: TruthState;
  readonly to: TruthState;
  readonly reason: string;
}

export const FORBIDDEN_TRANSITIONS: readonly ForbiddenTransition[] = Object.freeze([
  {
    from: 'REQUEST_SUBMITTED',
    to: 'VERIFIED_REMOVED',
    reason: 'no acknowledgment or observation exists; this is removal theater (VG-VERIFY-004)',
  },
  {
    from: 'REQUEST_READY',
    to: 'VERIFIED_REMOVED',
    reason: 'no external action was taken',
  },
  {
    from: 'MATCH_CONFIRMED',
    to: 'REQUEST_SUBMITTED',
    reason: 'skips the authority, policy and recipe gate (VG-AUTHZ-001, VG-POLICY-002)',
  },
  {
    from: 'DISCOVERED_CANDIDATE',
    to: 'REQUEST_READY',
    reason: 'skips identity confirmation (VG-IDENT-004)',
  },
  {
    from: 'SEARCH_DELISTED',
    to: 'VERIFIED_REMOVED',
    reason: 'collapses search delisting into source removal (SPEC-000 5.1)',
  },
  {
    from: 'VERIFIED_NOT_PRESENT',
    to: 'VERIFIED_REMOVED',
    reason: 'nothing was removed; no listing was ever confirmed',
  },
]);
