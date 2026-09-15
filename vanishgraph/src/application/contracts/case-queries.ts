/**
 * Cases: list, detail, timeline, creation, guarded transition and human gates (SPEC-003 §5.7).
 *
 * A `RequestCase` IS THE DURABLE UNIT OF WORK. SPEC-001:82 gives it `id, subjectId, exposureId, sourceId,
 * truthState, authorityGrantId, policyDecisionId`; §5.7.1 creates it AT the exposure's current truth state and
 * "creation never advances it", which is why creation is not a transition and carries no transition code.
 *
 * READ ROUTES AND WRITE ROUTES IN ONE PORT, because they are one aggregate and a second read path would be a
 * second definition of `actionCount` (the number of `ExternalAction` rows) or of `nextDeadline`. §5.7.2 names
 * `actionCount` "for what it counts" and forbids any field that counts "removals" — a distinction that survives
 * only if one place computes it.
 *
 * `truthState` APPEARS ONLY AS OUTPUT. §5.7.4 takes `requestedTruthState`, which is a REQUEST for a guarded
 * transition; the handler validates it against the routeable set, and the guard list inside the domain command
 * decides. No route in this port writes a state the state machine did not produce.
 *
 * THE TIMELINE REPORTS WHAT EXISTS. §5.7.6 merges eight kinds of append-only row; every one of them is a row in
 * a table, and an entry's `truthStateAfter` is the state a TRANSITION moved into — `null` for the other seven,
 * because a deadline or an evidence capture does not change a truth state and reporting the case's current
 * state on those rows would claim a transition that never happened.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import type { TransitionRow } from './transition-queries.ts';

/** The policy decision a case carries, as §5.7.3 reports it. */
export interface CasePolicyDecision {
  readonly policyDecisionId: string;
  readonly jurisdiction: string;
  readonly legalBasis: string;
  readonly channel: string;
  readonly policyVersion: string;
  readonly decidedAt: string;
}

/** The recipe a case was authorised against, when one is recorded. */
export interface CaseRecipe {
  readonly recipeId: string;
  readonly version: number;
  readonly channel: string;
  readonly enabled: boolean;
  readonly freshnessAt: string;
  readonly fresh: boolean;
  /** Whether a signature is PRESENT. See `GuardsEvaluated.recipeSigned` for why this is not "verified". */
  readonly signaturePresent: boolean;
}

/** §5.7.2's `nextDeadline`: the soonest unsatisfied deadline, or `null`. */
export interface CaseNextDeadline {
  readonly deadlineId: string;
  readonly kind: string;
  readonly dueAt: string;
  readonly state: string;
}

/** A §5.7.2 list row. */
export interface CaseListRow {
  readonly caseId: string;
  readonly subjectRef: string;
  readonly sourceId: string;
  readonly exposureId: string;
  readonly truthState: string;
  /** The channel of the case's policy decision, or `null` before one exists. */
  readonly channel: string | null;
  readonly actionCount: number;
  readonly verificationCount: number;
  readonly nextDeadline: CaseNextDeadline | null;
  readonly updatedAt: string;
}

/** §5.7.3's detail. */
export interface CaseDetail extends CaseListRow {
  readonly truthStateChangedAt: string;
  /** The §2.7 ETag input. Never serialised into a body. */
  readonly rowVersionMs: number;
  readonly lastTransition: TransitionRow | null;
  readonly evidenceArtifactIds: readonly string[];
  readonly policyDecision: CasePolicyDecision | null;
  readonly recipe: CaseRecipe | null;
  readonly deadlines: readonly CaseNextDeadline[];
  readonly controllerResponses: { readonly count: number; readonly latestKind: string | null };
  readonly verificationObservations: { readonly count: number; readonly latestFinding: string | null };
  readonly externalActions: { readonly count: number; readonly latestOutcome: string | null };
}

/** One §5.7.6 timeline entry. */
export interface TimelineEntry {
  readonly at: string;
  readonly kind:
    | 'EXTERNAL_ACTION'
    | 'CONTROLLER_RESPONSE'
    | 'VERIFICATION_OBSERVATION'
    | 'TRANSITION'
    | 'EVIDENCE_ARTIFACT'
    | 'DEADLINE'
    | 'REAPPEARANCE'
    | 'HUMAN_GATE';
  readonly refId: string;
  readonly truthStateAfter: string | null;
  /** A short, non-PII description of what happened. */
  readonly summary: string;
  readonly correlationId: string;
}

/** §5.7.2's filters. */
export interface CaseFilters {
  readonly subjectId?: string;
  readonly sourceId?: string;
  readonly truthState?: string | readonly string[];
  readonly channel?: string;
  readonly authorityGrantState?: string | readonly string[];
  readonly from?: string;
  readonly to?: string;
}

export interface ListCasesParams {
  readonly limit: number;
  readonly sort: string;
  readonly filters: CaseFilters;
  readonly after?: { readonly sortValue: string; readonly id: string };
}

/**
 * §5.7.4's `guardsEvaluated`: the six facts the response reports about the transition it performed or refused.
 *
 * `recipeSigned` IS NOT "SIGNATURE PRESENT". §5.3.7 refuses to store a recipe whose signature it cannot verify,
 * and no production verification key exists while ADR-006 is open, so this field reports the outcome of a real
 * verification against the configured key map: `false` when no key is configured, because an unverifiable
 * signature is not a verified one.
 */
export interface GuardsEvaluated {
  readonly authorityValid: boolean;
  readonly policyDecisionComplete: boolean;
  readonly recipeSigned: boolean;
  readonly recipeFresh: boolean;
  readonly channelPermitted: boolean;
  readonly budgetAvailable: boolean;
}

/** What a guarded update asks for. `requestedTruthState` is a REQUEST, never an assignment. */
export interface GuardedUpdateRequest {
  readonly caseId: string;
  readonly expectedRowVersionMs: number;
  readonly requestedTruthState: string;
  readonly reasonCode: string;
  readonly reasonDetail: string;
  readonly evidenceArtifactIds: readonly string[];
  readonly correlationId: string;
  readonly nowMs: number;
  /** The in-force policy decision for the case's jurisdiction, when one is bound. */
  readonly decisionId: string | null;
}

/** The outcome of a §5.7.4 write. */
export type GuardedUpdateOutcome =
  | {
      readonly ok: true;
      readonly truthState: string;
      readonly transitionCode: string;
      readonly transitionId: string;
      readonly guardsEvaluated: GuardsEvaluated;
    }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' }
  | {
      readonly ok: false;
      readonly reason: 'PRECONDITION_FAILED';
      readonly currentRowVersionMs: number;
      readonly truthState: string;
    }
  | { readonly ok: false; readonly reason: 'TRANSITION_NOT_ROUTEABLE' }
  | {
      readonly ok: false;
      readonly reason: 'ILLEGAL_TRANSITION';
      readonly fromTruthState: string;
      readonly toTruthState: string;
    }
  | { readonly ok: false; readonly reason: 'GUARD_FAILED'; readonly guard: string }
  | { readonly ok: false; readonly reason: 'EVIDENCE_REQUIRED' }
  | { readonly ok: false; readonly reason: 'EVIDENCE_NOT_FOUND' }
  | { readonly ok: false; readonly reason: 'POLICY_DECISION_INCOMPLETE' }
  | { readonly ok: false; readonly reason: 'AUTHORITY_GRANT_SCOPE_INSUFFICIENT' };

/** Everything §5.7.1 needs. */
export interface CreateCaseRequest {
  readonly subjectId: string;
  readonly exposureId: string;
  readonly sourceId: string;
  readonly authorityGrantId: string;
  readonly policyDecisionId: string;
  readonly recipeId: string;
  readonly correlationId: string;
  readonly nowMs: number;
}

export type CreateCaseOutcome =
  | { readonly ok: true; readonly caseId: string; readonly truthState: string; readonly createdAt: string }
  | { readonly ok: false; readonly reason: 'EXPOSURE_NOT_FOUND' }
  | { readonly ok: false; readonly reason: 'CASE_ALREADY_EXISTS' }
  | { readonly ok: false; readonly reason: 'CASE_EXPOSURE_STATE_MISMATCH'; readonly exposureState: string }
  | { readonly ok: false; readonly reason: 'AUTHORITY_GRANT_SCOPE_INSUFFICIENT' }
  | { readonly ok: false; readonly reason: 'POLICY_DECISION_INCOMPLETE' }
  | { readonly ok: false; readonly reason: 'RECIPE_NOT_ENABLED' };

/** Everything §5.7.5 needs. */
export interface HumanGateRequest {
  readonly caseId: string;
  readonly expectedRowVersionMs: number;
  readonly gateKind: string;
  readonly detectedAt: string;
  readonly evidenceArtifactId: string | null;
  readonly attemptedBypass: boolean;
  readonly correlationId: string;
  readonly nowMs: number;
}

export type HumanGateOutcome =
  | {
      readonly ok: true;
      readonly truthState: string;
      readonly transitionCode: string;
      readonly gateId: string;
      readonly humanQueue: string;
      readonly serviceLevelDueAt: string;
    }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' }
  | {
      readonly ok: false;
      readonly reason: 'PRECONDITION_FAILED';
      readonly currentRowVersionMs: number;
      readonly truthState: string;
    }
  | { readonly ok: false; readonly reason: 'ILLEGAL_TRANSITION'; readonly fromTruthState: string }
  | { readonly ok: false; readonly reason: 'EVIDENCE_NOT_FOUND' }
  | { readonly ok: false; readonly reason: 'BYPASS_ATTEMPT_REFUSED' };

/** The read and write surface of §5.7. */
export interface CaseQueries {
  listCases(tx: TenantTransaction, params: ListCasesParams): Promise<readonly CaseListRow[]>;
  getCaseDetail(tx: TenantTransaction, caseId: string): Promise<CaseDetail | undefined>;
  caseRowVersion(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<{ readonly rowVersionMs: number; readonly truthState: string } | undefined>;
  listTimeline(tx: TenantTransaction, caseId: string): Promise<readonly TimelineEntry[]>;
  createCase(tx: TenantTransaction, request: CreateCaseRequest): Promise<CreateCaseOutcome>;
  guardedUpdate(tx: TenantTransaction, request: GuardedUpdateRequest): Promise<GuardedUpdateOutcome>;
  recordHumanGate(tx: TenantTransaction, request: HumanGateRequest): Promise<HumanGateOutcome>;
}

/**
 * THE STATES §5.7.4 MAY BE ASKED FOR. §5.7.4: "`requestedTruthState` is a *request for a guarded transition*,
 * not a state assignment. It is accepted only for the transitions the case's current state legally permits
 * (T5/T6/T7/T9/T10/T13/T15/T16/T19 as applicable)".
 *
 * The complement is §5.7.4's `422 TRANSITION_NOT_ROUTEABLE`, and the states it names are exactly the ones the
 * route cannot produce: `REQUEST_SUBMITTED` (only §5.8.2 execution, T8), `VERIFIED_REMOVED` (§5.10
 * observation, T14), `ACKNOWLEDGED` (§5.9 controller response, T11), `SEARCH_DELISTED` (T21), `REAPPEARED`
 * (T17/T20) and `DISCOVERED_CANDIDATE` (T1, an initial state). Stated as a set so the refusal and the licence
 * cannot drift apart.
 */
export const ROUTEABLE_CASE_TARGETS: readonly string[] = Object.freeze([
  'REQUEST_READY',
  'NOT_REMOVABLE',
  'HUMAN_REQUIRED',
]);

/**
 * WHERE A HUMAN GATE IS ROUTED, AND BY WHEN — AN IMPLEMENTATION CHOICE, RECORDED AS ONE.
 *
 * No specification enumerates a queue name or a service level: §5.7.5's response carries `humanQueue` and
 * `serviceLevelDueAt`, §5.7.5's request supplies neither, and neither SPEC-001 nor SPEC-002 mentions a queue
 * table. So these are operational parameters chosen here and recorded in `ASSUMPTIONS.md` §3.29 rather than
 * presented as spec-derived. TWO PROPERTIES keep that honest:
 *
 *   * The values are stored ON THE GATE ROW at the moment it is recorded, so a later change to this table
 *     cannot rewrite what an earlier gate was told — the same rule §5.13's deadlines follow.
 *   * The queue is derived from `gateKind` alone, so it cannot be influenced by request content. A caller
 *     cannot route its own gate to a faster queue, which is what makes the routing a control rather than a
 *     suggestion.
 *
 * The service levels are deliberately generous rather than tight: a wrong SLA is an operational nuisance,
 * while a wrong QUEUE means a human never sees the case. Only the second is a safety property here.
 */
export interface HumanGateRouting {
  readonly queue: string;
  readonly serviceLevelSeconds: number;
}

/** The seven gate kinds of §5.7.5's request, each mapped to a queue and a service level. */
export const HUMAN_GATE_ROUTING: Readonly<Record<string, HumanGateRouting>> = Object.freeze({
  CAPTCHA: { queue: 'IDENTITY_VERIFICATION', serviceLevelSeconds: 4 * 60 * 60 },
  OTP: { queue: 'IDENTITY_VERIFICATION', serviceLevelSeconds: 4 * 60 * 60 },
  PHONE_VERIFICATION: { queue: 'IDENTITY_VERIFICATION', serviceLevelSeconds: 4 * 60 * 60 },
  IDENTITY_DOCUMENT_UPLOAD: { queue: 'IDENTITY_VERIFICATION', serviceLevelSeconds: 24 * 60 * 60 },
  LEGAL_REVIEW: { queue: 'LEGAL_REVIEW', serviceLevelSeconds: 72 * 60 * 60 },
  PROVIDER_MANUAL_STEP: { queue: 'PROVIDER_OPERATIONS', serviceLevelSeconds: 24 * 60 * 60 },
  AUTHORITY_DEFECT: { queue: 'AUTHORITY_REMEDIATION', serviceLevelSeconds: 48 * 60 * 60 },
});

/** The routing for a gate kind, or `undefined` when the kind is not one §5.7.5 declares. */
export function routingFor(gateKind: string): HumanGateRouting | undefined {
  return HUMAN_GATE_ROUTING[gateKind];
}
