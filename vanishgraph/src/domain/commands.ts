/**
 * Domain commands (SPEC-001 §6).
 *
 * Each command validates its preconditions, applies EXACTLY ONE transition through
 * `applyTransition`/`applyInitialState`, and returns the emitted events plus an
 * `AuditEvent` (SM-2). No command assigns a truth state directly (SM-6), performs I/O,
 * reads a clock, or generates randomness: everything it needs is passed in, which is what
 * makes the whole layer testable without infrastructure.
 *
 * Refusal is a first-class result, not an exception everywhere it is a legitimate product
 * answer: `recordVerification` returning a refusal (state unchanged, `VerificationFailed`
 * emitted) is the honest outcome when the observation is not independent or the window
 * has not elapsed. Guard violations that indicate a programming error still throw typed
 * domain errors.
 *
 * SPEC GAP, recorded rather than papered over: SPEC-001 §6 lists eleven commands and none
 * owns transition T21 (`MATCH_CONFIRMED` → `SEARCH_DELISTED`). T21 therefore remains
 * reachable only through the state-machine API until a spec revision names its owning
 * command. No twelfth command is invented.
 */

import {
  GuardNotSatisfied,
  IdempotencyConflict,
  IllegalTransition,
} from './errors.ts';
import {
  applyInitialState,
  applyTransition,
  legalTransitionsFrom,
  noFacts,
} from './state-machine.ts';
import {
  TRUTH_STATE_FACTS,
  type TransitionFacts,
  type TransitionId,
  type TruthState,
} from './truth-state.ts';
import {
  assertAuthorityUsableAt,
  assertRecipeUsableAt,
  sourceMayBeWritten,
  createAuditEvent,
  type Alias,
  type AuditEvent,
  type AuthorityGrant,
  type ControllerResponse,
  type ExternalAction,
  type JurisdictionPolicy,
  type PolicyDecision,
  type ProtectedSubject,
  type RemovalRecipe,
  type Source,
  type SourceRecord,
  type VerificationObservation,
} from './entities.ts';
import {
  domainEvent,
  type DomainEvent,
  type DomainEventName,
  type EventPayloadValue,
} from './events.ts';
import type { TenantId } from './identifiers.ts';
import {
  selectChannel,
  type ChannelOption,
  type ObservationWindow,
} from './values.ts';

export type DomainCommandName =
  | 'RegisterSubject'
  | 'AttachAlias'
  | 'RecordSourceRecord'
  | 'AssessMatch'
  | 'ResolvePolicy'
  | 'PrepareRequest'
  | 'ExecuteAction'
  | 'RecordControllerResponse'
  | 'RecordVerification'
  | 'DetectReappearance'
  | 'RequestHumanGate';

/**
 * The events each command may emit. Nothing outside this map may be emitted by a command,
 * which is what makes the event stream auditable against SPEC-001 §7.
 */
export const COMMAND_EVENTS: Readonly<Record<DomainCommandName, readonly DomainEventName[]>> =
  Object.freeze({
    RegisterSubject: ['SubjectRegistered'],
    AttachAlias: ['AliasAttached', 'AliasQuarantined'],
    RecordSourceRecord: ['SourceRecordObserved'],
    AssessMatch: ['MatchConfirmed', 'MatchDisproved'],
    ResolvePolicy: ['PolicyResolved'],
    PrepareRequest: ['RequestReady', 'NotRemovable', 'HumanRequired'],
    ExecuteAction: ['ActionSubmitted', 'ActionAmbiguous', 'BudgetExceeded', 'HumanRequired'],
    RecordControllerResponse: ['Acknowledged', 'HumanRequired', 'Refused'],
    RecordVerification: ['VerifiedRemoved', 'VerificationFailed'],
    DetectReappearance: ['Reappeared'],
    RequestHumanGate: ['HumanRequired'],
  });

export interface CommandContext {
  readonly tenantId: TenantId;
  readonly correlationId: string;
  readonly nowMs: number;
}

export interface CommandResult {
  readonly command: DomainCommandName;
  readonly tenantId: TenantId;
  readonly correlationId: string;
  readonly events: readonly DomainEvent[];
  readonly audit: AuditEvent;
  /** SM-5: HUMAN_REQUIRED and NOT_REMOVABLE are legitimate outcomes, not failures. */
  readonly isLegitimateOutcome: boolean;
  readonly createdIds: Readonly<Record<string, string>>;
}

export interface TransitionCommandResult extends CommandResult {
  readonly from: TruthState | null;
  readonly to: TruthState;
  readonly transitionId: TransitionId;
  readonly evidence: string;
}

export interface RefusalResult extends CommandResult {
  readonly refused: true;
  readonly currentTruthState: TruthState;
  readonly refusalReason: string;
  readonly guard: string;
}

const ACTOR = 'domain-command';

function legitimateOutcome(state: TruthState): boolean {
  return TRUTH_STATE_FACTS[state].isLegitimateOutcome;
}

function buildAudit(
  ctx: CommandContext,
  command: DomainCommandName,
  targetKind: string,
  targetId: string | null,
  payload: Readonly<Record<string, EventPayloadValue>>,
): AuditEvent {
  return createAuditEvent({
    id: `${command}:${ctx.correlationId}:${ctx.nowMs}`,
    tenantId: ctx.tenantId,
    actor: ACTOR,
    action: command,
    targetKind,
    targetId,
    correlationId: ctx.correlationId,
    atMs: ctx.nowMs,
    payload: { command, ...payload },
  });
}

function buildEvents(
  ctx: CommandContext,
  names: readonly DomainEventName[],
  payload: Readonly<Record<string, EventPayloadValue>>,
): readonly DomainEvent[] {
  return Object.freeze(
    names.map((name) =>
      domainEvent({
        eventId: `${name}:${ctx.correlationId}:${ctx.nowMs}`,
        name,
        tenantId: ctx.tenantId,
        correlationId: ctx.correlationId,
        occurredAtMs: ctx.nowMs,
        payload,
      }),
    ),
  );
}

interface TransitionArgs {
  readonly ctx: CommandContext;
  readonly command: DomainCommandName;
  readonly caseId: string;
  readonly from: TruthState | null;
  readonly to: TruthState;
  readonly facts: TransitionFacts;
  readonly eventNames: readonly DomainEventName[];
  readonly payload: Readonly<Record<string, EventPayloadValue>>;
  /** Extra audit-only fields (for example a human-readable gate reason). */
  readonly auditExtra?: Readonly<Record<string, EventPayloadValue>>;
  readonly createdIds?: Readonly<Record<string, string>>;
  /**
   * The kind of entity the audit row's `targetId` names.
   *
   * DEFAULTS TO `RequestCase`, which is what most transitions act on, and is overridden where a transition
   * acts on something else: T1 acts on a source record, T3/T4 on an exposure. The seed states the convention
   * (`db/seed/prior_release.sql`: T5 against `RequestCase`, T8 against `ExternalAction`, a registration
   * against `ProtectedSubject`), and it matters because the target is what an audit reader — and
   * `transition-queries.ts` — uses to find a resource's history. A T3 written as `RequestCase` with an
   * exposure id would be a history entry attached to a case that does not exist yet (`ASSUMPTIONS.md` §3.27).
   */
  readonly targetKind?: string;
}

function transition(args: TransitionArgs): TransitionCommandResult {
  const applied =
    args.from === null
      ? applyInitialState(args.to, args.facts)
      : applyTransition(args.from, args.to, args.facts);
  return Object.freeze({
    command: args.command,
    tenantId: args.ctx.tenantId,
    correlationId: args.ctx.correlationId,
    from: applied.from,
    to: applied.to,
    transitionId: applied.id,
    evidence: applied.evidence,
    events: buildEvents(args.ctx, args.eventNames, args.payload),
    audit: buildAudit(args.ctx, args.command, args.targetKind ?? 'RequestCase', args.caseId, {
      ...args.payload,
      ...(args.auditExtra ?? {}),
    }),
    isLegitimateOutcome: legitimateOutcome(applied.to),
    createdIds: Object.freeze({ ...(args.createdIds ?? {}) }),
  });
}

interface RefusalArgs {
  readonly ctx: CommandContext;
  readonly command: DomainCommandName;
  readonly caseId: string;
  readonly currentTruthState: TruthState;
  readonly refusalReason: string;
  readonly guard: string;
  readonly eventNames: readonly DomainEventName[];
  readonly payload: Readonly<Record<string, EventPayloadValue>>;
}

function refusal(args: RefusalArgs): RefusalResult {
  return Object.freeze({
    command: args.command,
    tenantId: args.ctx.tenantId,
    correlationId: args.ctx.correlationId,
    events: buildEvents(args.ctx, args.eventNames, args.payload),
    audit: buildAudit(args.ctx, args.command, 'RequestCase', args.caseId, args.payload),
    isLegitimateOutcome: legitimateOutcome(args.currentTruthState),
    createdIds: Object.freeze({}),
    refused: true,
    currentTruthState: args.currentTruthState,
    refusalReason: args.refusalReason,
    guard: args.guard,
  });
}

// ---------------------------------------------------------------------------
// RegisterSubject, AttachAlias, RecordSourceRecord
// ---------------------------------------------------------------------------

/** VG-IDENT-001: no subject without a verified, unexpired AuthorityGrant. */
export function registerSubject(
  ctx: CommandContext,
  input: { readonly subject: ProtectedSubject; readonly grant: AuthorityGrant },
): CommandResult {
  assertAuthorityUsableAt(input.grant, ctx.nowMs);
  if (input.grant.subjectId.value !== input.subject.id.value) {
    throw new GuardNotSatisfied('RegisterSubject', 'grant subject must match the subject');
  }
  const payload = { subjectId: input.subject.id.value, authorityGrantId: input.grant.id };
  return Object.freeze({
    command: 'RegisterSubject',
    tenantId: ctx.tenantId,
    correlationId: ctx.correlationId,
    events: buildEvents(ctx, COMMAND_EVENTS.RegisterSubject, payload),
    audit: buildAudit(ctx, 'RegisterSubject', 'ProtectedSubject', input.subject.id.value, payload),
    isLegitimateOutcome: true,
    createdIds: Object.freeze({
      subjectId: input.subject.id.value,
      authorityGrantId: input.grant.id,
    }),
  });
}

/** VG-IDENT-002: an ambiguous alias is quarantined, never auto-attached. */
export function attachAlias(
  ctx: CommandContext,
  input: { readonly alias: Alias; readonly ambiguous: boolean },
): CommandResult {
  const quarantined = input.ambiguous || input.alias.quarantined;
  const names: readonly DomainEventName[] = quarantined
    ? COMMAND_EVENTS.AttachAlias.filter((name) => name === 'AliasQuarantined')
    : COMMAND_EVENTS.AttachAlias.filter((name) => name === 'AliasAttached');
  const payload = {
    aliasId: input.alias.id,
    quarantined,
    reason: input.ambiguous ? 'ambiguous-match-two-subjects' : null,
  };
  return Object.freeze({
    command: 'AttachAlias',
    tenantId: ctx.tenantId,
    correlationId: ctx.correlationId,
    events: buildEvents(ctx, names, payload),
    audit: buildAudit(ctx, 'AttachAlias', 'Alias', input.alias.id, payload),
    isLegitimateOutcome: true,
    createdIds: Object.freeze({ aliasId: input.alias.id }),
  });
}

/** T1: a candidate exists only when a permitted read path observed the record. */
export function recordSourceRecord(
  ctx: CommandContext,
  input: { readonly record: SourceRecord; readonly permittedReadPath: boolean },
): TransitionCommandResult {
  const payload = {
    sourceRecordId: input.record.id,
    sourceId: input.record.sourceId.value,
    tainted: input.record.tainted,
  };
  return transition({
    ctx,
    command: 'RecordSourceRecord',
    caseId: input.record.id,
    from: null,
    to: 'DISCOVERED_CANDIDATE',
    facts: noFacts({ sourceRecordObserved: input.permittedReadPath }),
    eventNames: COMMAND_EVENTS.RecordSourceRecord,
    payload,
    createdIds: { sourceRecordId: input.record.id },
    // T1 acts on a SOURCE RECORD, and the audit row says so. Until this was explicit the row claimed
    // `RequestCase` with a source-record id, which named an entity that does not exist.
    targetKind: 'SourceRecord',
  });
}

// ---------------------------------------------------------------------------
// AssessMatch, ResolvePolicy
// ---------------------------------------------------------------------------

export interface MatchAssessment {
  /**
   * The resource the assessment is about, and what its audit row names.
   *
   * §5.5.3/§5.5.4 assess an EXPOSURE, and T3/T4 happen before any case exists — §5.7.1 creates the case at
   * the exposure's current truth state, which is `MATCH_CONFIRMED` only after T3. The field keeps the name
   * `caseId` because that is what this interface has always called its target; `targetKind` is what makes
   * the audit row honest.
   */
  readonly caseId: string;
  readonly targetKind?: 'Exposure' | 'RequestCase';
  readonly from: TruthState;
  readonly matched: boolean;
  readonly confidenceAtThreshold: boolean;
  readonly confidenceBasisRecorded: boolean;
  readonly humanApproved: boolean;
  readonly disproofRecorded: boolean;
}

/** T3 (match confirmed) or T4 (match disproved → VERIFIED_NOT_PRESENT). */
export function assessMatch(
  ctx: CommandContext,
  input: MatchAssessment,
): TransitionCommandResult {
  if (input.matched) {
    return transition({
      ctx,
      command: 'AssessMatch',
      caseId: input.caseId,
      from: input.from,
      to: 'MATCH_CONFIRMED',
      facts: noFacts({
        confidenceAtThreshold: input.confidenceAtThreshold,
        confidenceBasisRecorded: input.confidenceBasisRecorded,
        humanApprovedMatch: input.humanApproved,
      }),
      eventNames: ['MatchConfirmed'],
      payload: { caseId: input.caseId, humanApproved: input.humanApproved },
      ...(input.targetKind === undefined ? {} : { targetKind: input.targetKind }),
    });
  }
  return transition({
    ctx,
    command: 'AssessMatch',
    caseId: input.caseId,
    from: input.from,
    to: 'VERIFIED_NOT_PRESENT',
    facts: noFacts({ subjectMatchDisproved: input.disproofRecorded }),
    eventNames: ['MatchDisproved'],
    payload: { caseId: input.caseId, disproofRecorded: input.disproofRecorded },
    ...(input.targetKind === undefined ? {} : { targetKind: input.targetKind }),
  });
}

/** VG-POLICY-001/002: a legal basis must exist in the policy version in force. */
export function assertPolicyInForce(
  policy: JurisdictionPolicy,
  decision: PolicyDecision,
  atMs: number,
): true {
  if (!policy.jurisdiction.equals(decision.jurisdiction)) {
    throw new GuardNotSatisfied('ResolvePolicy', 'policy jurisdiction must match the decision');
  }
  if (policy.version !== decision.policyVersion) {
    throw new GuardNotSatisfied(
      'ResolvePolicy',
      `policy version ${policy.version} is not the decision version ${decision.policyVersion}`,
    );
  }
  if (
    atMs < policy.effectiveFromMs ||
    (policy.effectiveToMs !== null && atMs >= policy.effectiveToMs)
  ) {
    throw new GuardNotSatisfied(
      'ResolvePolicy',
      `policy version ${policy.version} is not in force at ${atMs}`,
    );
  }
  if (!policy.rules.includes(decision.legalBasis.code)) {
    throw new GuardNotSatisfied(
      'ResolvePolicy',
      `legal basis ${decision.legalBasis.code} does not exist in policy version ${policy.version} (VG-POLICY-001)`,
    );
  }
  return true;
}

export function resolvePolicy(
  ctx: CommandContext,
  input: {
    readonly caseId: string;
    readonly decision: PolicyDecision;
    readonly policy: JurisdictionPolicy;
  },
): CommandResult {
  assertPolicyInForce(input.policy, input.decision, ctx.nowMs);
  const payload = {
    caseId: input.caseId,
    jurisdiction: input.decision.jurisdiction.value,
    legalBasis: input.decision.legalBasis.code,
    channel: input.decision.channel,
    policyVersion: input.decision.policyVersion,
  };
  return Object.freeze({
    command: 'ResolvePolicy',
    tenantId: ctx.tenantId,
    correlationId: ctx.correlationId,
    events: buildEvents(ctx, COMMAND_EVENTS.ResolvePolicy, payload),
    audit: buildAudit(ctx, 'ResolvePolicy', 'PolicyDecision', input.decision.id, payload),
    isLegitimateOutcome: true,
    createdIds: Object.freeze({ policyDecisionId: input.decision.id }),
  });
}

// ---------------------------------------------------------------------------
// PrepareRequest
// ---------------------------------------------------------------------------

export interface PrepareRequestInput {
  readonly caseId: string;
  /**
   * The state the case is in NOW.
   *
   * NOT restricted to `MATCH_CONFIRMED | REAPPEARED` any more, and that was a real gap rather than a widening
   * for convenience: SPEC-003 §5.7.4 accepts a guarded-transition request "only for the transitions the case's
   * current state legally permits (T5/T6/T7/T9/T10/T13/T15/T16/T19 as applicable)", so a case at `REQUEST_READY`
   * asking for `NOT_REMOVABLE` (T10) or `HUMAN_REQUIRED` (T9), and one at `ACKNOWLEDGED` asking for T15/T16, are
   * all lawful requests this command could not express. The MACHINE still decides: `applyTransition` looks the
   * pair up in SPEC-001 §4.1 and throws `IllegalTransition` for anything that is not a row there, so a caller
   * cannot use this parameter to reach a state the table does not permit.
   */
  readonly from: TruthState;
  readonly authority: AuthorityGrant;
  readonly decision: PolicyDecision;
  readonly policy: JurisdictionPolicy;
  readonly recipe: RemovalRecipe;
  readonly source: Source;
  readonly channelOptions: readonly ChannelOption[];
  readonly exemptionRecorded: boolean;
  readonly humanGate: { readonly gateKind: string; readonly reason: string } | null;
}

/**
 * T5/T18 (REQUEST_READY), T6/T19 (NOT_REMOVABLE), T7 (HUMAN_REQUIRED) for a confirmed
 * match. Authority, policy and recipe are re-asserted at this moment, not remembered.
 */
export function prepareRequest(
  ctx: CommandContext,
  input: PrepareRequestInput,
): TransitionCommandResult {
  assertAuthorityUsableAt(input.authority, ctx.nowMs);
  assertRecipeUsableAt(input.recipe, ctx.nowMs);
  assertPolicyInForce(input.policy, input.decision, ctx.nowMs);

  const unavailable: ChannelOption[] = [];
  for (const option of input.channelOptions) {
    if (option.unavailableKind !== null) unavailable.push(option);
  }
  let channelPermitted = false;
  let selected: ChannelOption | null = null;
  try {
    selected = selectChannel(input.channelOptions);
    channelPermitted =
      selected.channel !== 'NOT_REMOVABLE_OUTCOME' && sourceMayBeWritten(input.source);
  } catch {
    channelPermitted = false;
  }

  const payload = {
    caseId: input.caseId,
    authorityGrantId: input.authority.id,
    policyDecisionId: input.decision.id,
    recipeId: input.recipe.id.value,
    channel: selected === null ? null : selected.channel,
    channelsConsidered: input.channelOptions.length,
    channelsUnavailable: unavailable.length,
  };

  const guardFacts = {
    authorityValid: true,
    policyDecisionComplete: true,
    recipeSignedAndFresh: true,
    channelPermitted,
    freshAuthorityPolicyRecipe: input.from === 'REAPPEARED',
  };

  if (input.humanGate !== null) {
    return transition({
      ctx,
      command: 'PrepareRequest',
      caseId: input.caseId,
      from: input.from,
      to: 'HUMAN_REQUIRED',
      facts: noFacts({ ...guardFacts, humanGateDetected: true }),
      eventNames: ['HumanRequired'],
      payload: { ...payload, gateKind: input.humanGate.gateKind },
    });
  }
  if (!channelPermitted) {
    return transition({
      ctx,
      command: 'PrepareRequest',
      caseId: input.caseId,
      from: input.from,
      to: 'NOT_REMOVABLE',
      facts: noFacts({ ...guardFacts, exemptionRecorded: true }),
      eventNames: ['NotRemovable'],
      payload: {
        ...payload,
        basis: input.exemptionRecorded ? 'exemption-recorded' : 'no-lawful-writable-channel',
      },
    });
  }
  return transition({
    ctx,
    command: 'PrepareRequest',
    caseId: input.caseId,
    from: input.from,
    to: 'REQUEST_READY',
    facts: noFacts(guardFacts),
    eventNames: ['RequestReady'],
    payload,
  });
}

// ---------------------------------------------------------------------------
// ExecuteAction
// ---------------------------------------------------------------------------

export interface ExecuteActionInput {
  readonly caseId: string;
  readonly action: ExternalAction;
  readonly existingIdempotencyKeys: readonly string[];
  readonly budgetAvailable: boolean;
  readonly outcome:
    | { readonly kind: 'ACCEPTED'; readonly receiptRef: string }
    | { readonly kind: 'REFUSED'; readonly reason: string }
    | { readonly kind: 'AMBIGUOUS'; readonly detail: string }
    | { readonly kind: 'HUMAN_GATE'; readonly gateKind: string; readonly reason: string };
}

/**
 * T8 with VG-ACTION-001 (one key, one effect), VG-ACTION-002 (ambiguity reconciles),
 * VG-ACTION-005 (effect budget) and T9 (a gate found at execution time).
 */
export function executeAction(
  ctx: CommandContext,
  input: ExecuteActionInput,
): TransitionCommandResult | RefusalResult {
  if (input.existingIdempotencyKeys.includes(input.action.idempotencyKey.value)) {
    throw new IdempotencyConflict(input.action.idempotencyKey.value, input.action.id.value);
  }
  const payload = {
    caseId: input.caseId,
    actionId: input.action.id.value,
    channel: input.action.channel,
    attempt: input.action.attempt,
    outcome: input.outcome.kind,
  };
  if (!input.budgetAvailable) {
    return refusal({
      ctx,
      command: 'ExecuteAction',
      caseId: input.caseId,
      currentTruthState: 'REQUEST_READY',
      refusalReason: 'effect budget exhausted for this subject, source and window (VG-ACTION-005)',
      guard: 'budgetAvailable',
      eventNames: ['BudgetExceeded'],
      payload,
    });
  }
  const facts = noFacts({
    authorityValid: true,
    idempotencyKeyAssigned: true,
    budgetAvailable: true,
    recipeSignedAndFresh: true,
    channelPermitted: true,
    humanGateDetected: input.outcome.kind === 'HUMAN_GATE',
  });
  if (input.outcome.kind === 'HUMAN_GATE') {
    return transition({
      ctx,
      command: 'ExecuteAction',
      caseId: input.caseId,
      from: 'REQUEST_READY',
      to: 'HUMAN_REQUIRED',
      facts,
      eventNames: ['HumanRequired'],
      payload: { ...payload, gateKind: input.outcome.gateKind },
    });
  }
  const eventNames: readonly DomainEventName[] =
    input.outcome.kind === 'AMBIGUOUS'
      ? ['ActionSubmitted', 'ActionAmbiguous']
      : ['ActionSubmitted'];
  return transition({
    ctx,
    command: 'ExecuteAction',
    caseId: input.caseId,
    from: 'REQUEST_READY',
    to: 'REQUEST_SUBMITTED',
    facts,
    eventNames,
    payload,
    createdIds: { actionId: input.action.id.value },
  });
}

// ---------------------------------------------------------------------------
// RecordControllerResponse
// ---------------------------------------------------------------------------

export interface ControllerResponseInput {
  readonly caseId: string;
  readonly from: 'REQUEST_SUBMITTED';
  readonly response: ControllerResponse;
  readonly outcome: 'ACKNOWLEDGED' | 'HUMAN_GATE' | 'REFUSED';
  readonly lawfulRefusalFinal: boolean;
}

/**
 * T11/T12/T13. A controller response is a claim, never an observation: this command can
 * reach ACKNOWLEDGED, and can never reach VERIFIED_REMOVED (VG-VERIFY-004).
 */
export function recordControllerResponse(
  ctx: CommandContext,
  input: ControllerResponseInput,
): TransitionCommandResult {
  const payload = {
    caseId: input.caseId,
    responseId: input.response.id,
    kind: input.response.kind,
  };
  if (input.outcome === 'HUMAN_GATE') {
    return transition({
      ctx,
      command: 'RecordControllerResponse',
      caseId: input.caseId,
      from: input.from,
      to: 'HUMAN_REQUIRED',
      facts: noFacts({ humanGateDetected: true }),
      eventNames: ['HumanRequired'],
      payload,
    });
  }
  if (input.outcome === 'REFUSED') {
    return transition({
      ctx,
      command: 'RecordControllerResponse',
      caseId: input.caseId,
      from: input.from,
      to: 'NOT_REMOVABLE',
      facts: noFacts({ exemptionRecorded: true, lawfulRefusalFinal: input.lawfulRefusalFinal }),
      eventNames: ['Refused', 'NotRemovable'],
      payload,
    });
  }
  return transition({
    ctx,
    command: 'RecordControllerResponse',
    caseId: input.caseId,
    from: input.from,
    to: 'ACKNOWLEDGED',
    facts: noFacts({ controllerResponded: true }),
    eventNames: ['Acknowledged'],
    payload,
  });
}

// ---------------------------------------------------------------------------
// RecordVerification
// ---------------------------------------------------------------------------

export interface VerificationInput {
  readonly caseId: string;
  readonly from: 'ACKNOWLEDGED';
  readonly observation: VerificationObservation;
  readonly window: ObservationWindow;
  readonly actionAtMs: number;
  readonly recipeVerificationMethod: string;
  readonly recordAbsent: boolean;
}

/**
 * T14, or an honest refusal. Both outcomes are real: a refused verification leaves the
 * case at ACKNOWLEDGED and emits VerificationFailed (VG-VERIFY-004 — a failed
 * verification never regresses into a success state).
 */
export function recordVerification(
  ctx: CommandContext,
  input: VerificationInput,
): TransitionCommandResult | RefusalResult {
  const payload = {
    caseId: input.caseId,
    observationId: input.observation.id,
    method: input.observation.method,
    finding: input.observation.finding,
  };
  const facts = noFacts({
    independentObservation: input.observation.actorIdentity !== input.observation.actingIdentity,
    observationWindowMet: input.window.hasElapsed(input.observation.observedAtMs, input.actionAtMs),
    verificationMethodMatches: input.observation.method === input.recipeVerificationMethod,
    recordAbsent: input.recordAbsent && input.observation.finding === 'ABSENT',
  });
  const satisfied =
    facts.independentObservation &&
    facts.observationWindowMet &&
    facts.verificationMethodMatches &&
    facts.recordAbsent;
  if (!satisfied) {
    return refusal({
      ctx,
      command: 'RecordVerification',
      caseId: input.caseId,
      currentTruthState: input.from,
      refusalReason:
        'the observation does not satisfy T14 (independence, window, method and absence must all hold)',
      guard: 'T14',
      eventNames: ['VerificationFailed'],
      payload,
    });
  }
  return transition({
    ctx,
    command: 'RecordVerification',
    caseId: input.caseId,
    from: input.from,
    to: 'VERIFIED_REMOVED',
    facts,
    eventNames: ['VerifiedRemoved'],
    payload,
    createdIds: { evidenceId: input.observation.evidenceId.value },
  });
}

// ---------------------------------------------------------------------------
// DetectReappearance, RequestHumanGate
// ---------------------------------------------------------------------------

/** T17 (from VERIFIED_REMOVED) or T20 (from SEARCH_DELISTED) (VG-REAPPEAR-001). */
export function detectReappearance(
  ctx: CommandContext,
  input: {
    readonly caseId: string;
    readonly from: 'VERIFIED_REMOVED' | 'SEARCH_DELISTED';
    readonly priorRemovedEventId: string;
    readonly recordPresentAgain: boolean;
  },
): TransitionCommandResult {
  return transition({
    ctx,
    command: 'DetectReappearance',
    caseId: input.caseId,
    from: input.from,
    to: 'REAPPEARED',
    facts: noFacts({ recordPresentAgain: input.recordPresentAgain }),
    eventNames: ['Reappeared'],
    payload: { caseId: input.caseId, priorRemovedEventId: input.priorRemovedEventId },
  });
}

/** Any transition into HUMAN_REQUIRED that the state machine permits from `from`. */
export function requestHumanGate(
  ctx: CommandContext,
  input: {
    readonly caseId: string;
    readonly from: TruthState;
    readonly gateKind: string;
    /** Human-readable detail. Recorded in the audit event, PII-checked there. */
    readonly reason: string;
  },
): TransitionCommandResult {
  const spec = legalTransitionsFrom(input.from).find((s) => s.to === 'HUMAN_REQUIRED');
  if (spec === undefined) {
    throw new IllegalTransition(
      input.from,
      'HUMAN_REQUIRED',
      `no HUMAN_REQUIRED transition exists from ${input.from} (SPEC-001 4.1)`,
    );
  }
  return transition({
    ctx,
    command: 'RequestHumanGate',
    caseId: input.caseId,
    from: input.from,
    to: 'HUMAN_REQUIRED',
    facts: noFacts({ humanGateDetected: true }),
    eventNames: ['HumanRequired'],
    payload: { caseId: input.caseId, gateKind: input.gateKind },
    auditExtra: { reason: input.reason },
  });
}
