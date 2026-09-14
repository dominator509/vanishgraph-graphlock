/**
 * Domain command tests (SPEC-001 §6, §7).
 *
 * Each command is asserted to apply exactly one transition, emit only events declared for
 * it, and produce an audit event. Refusals are asserted to leave the state untouched.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMAND_EVENTS,
  assertPolicyInForce,
  assessMatch,
  attachAlias,
  detectReappearance,
  executeAction,
  prepareRequest,
  recordControllerResponse,
  recordSourceRecord,
  recordVerification,
  registerSubject,
  requestHumanGate,
  resolvePolicy,
  type CommandResult,
  type RefusalResult,
  type TransitionCommandResult,
} from '../../src/domain/commands.ts';
import {
  createAlias,
  createAuditEvent,
  createAuthorityGrant,
  createControllerResponse,
  createExternalAction,
  createJurisdictionPolicy,
  createPolicyDecision,
  createProtectedSubject,
  createRemovalRecipe,
  createSource,
  createSourceRecord,
  createVerificationObservation,
} from '../../src/domain/entities.ts';
import { DOMAIN_EVENT_NAMES } from '../../src/domain/events.ts';
import {
  ActionId,
  CaseId,
  EvidenceId,
  RecipeId,
  SourceId,
  SubjectId,
  TenantId,
} from '../../src/domain/identifiers.ts';
import {
  EvidenceDigest,
  IdempotencyKey,
  Jurisdiction,
  LegalBasis,
  ObservationWindow,
} from '../../src/domain/values.ts';
import {
  AuthorityExpired,
  IdempotencyConflict,
  IllegalTransition,
  InvalidValueObject,
} from '../../src/domain/errors.ts';

const tenantId = new TenantId('tenant-0001');
const subjectId = new SubjectId('subject-0001');
const caseId = new CaseId('case-0001');
const sourceId = new SourceId('source-0001');
const digest = new EvidenceDigest('b'.repeat(64));
const jurisdiction = new Jurisdiction('US-CA');
const DAY = 86_400_000;
const ctx = { tenantId, correlationId: 'corr-0001', nowMs: 5 * DAY };

function grant(overrides: Record<string, unknown> = {}) {
  return createAuthorityGrant({
    id: 'grant-0001',
    tenantId,
    subjectId,
    kind: 'SELF',
    scope: ['discovery', 'self_service_write'],
    evidenceId: null,
    issuedAtMs: 0,
    expiresAtMs: 100 * DAY,
    revokedAtMs: null,
    signedInstrument: false,
    ...overrides,
  });
}

function subject(authority = grant()) {
  return createProtectedSubject({
    id: subjectId,
    tenantId,
    displayRef: 'subject-ref-0001',
    jurisdiction,
    isMinor: false,
    status: 'ACTIVE',
    authority,
    atMs: DAY,
  });
}

function policy() {
  return createJurisdictionPolicy({
    id: 'policy-1',
    tenantId,
    jurisdiction,
    version: 7,
    effectiveFromMs: 0,
    effectiveToMs: null,
    rules: ['CCPA_DELETE'],
    provenance: 'COUNSEL_REVIEWED',
  });
}

function decision() {
  return createPolicyDecision({
    id: 'decision-1',
    tenantId,
    caseId: caseId.value,
    jurisdiction,
    legalBasis: new LegalBasis('CCPA_DELETE', 7),
    channel: 'OFFICIAL_SELF_SERVICE',
    policyVersion: 7,
    reasons: ['consumer-request-right'],
    decidedAtMs: DAY,
  });
}

function recipe(overrides: Record<string, unknown> = {}) {
  return createRemovalRecipe({
    id: new RecipeId('recipe-0001'),
    tenantId,
    sourceId,
    version: 3,
    signature: 'sig:abc',
    channel: 'OFFICIAL_SELF_SERVICE',
    verificationMethod: 'independent-fetch',
    freshnessAtMs: 30 * DAY,
    enabled: true,
    ...overrides,
  });
}

function source(permissionClass: 'WRITE_PERMITTED' | 'WRITE_UNCLEAR' = 'WRITE_PERMITTED') {
  return createSource({
    id: sourceId,
    tenantId,
    name: 'example-registry',
    class: 'REGISTRY',
    jurisdiction,
    permissionClass,
    permissionCheckedAtMs: DAY,
  });
}

function action(overrides: Record<string, unknown> = {}) {
  return createExternalAction({
    id: new ActionId('action-0001'),
    tenantId,
    caseId,
    channel: 'OFFICIAL_SELF_SERVICE',
    idempotencyKey: new IdempotencyKey('case-0001:self_service:v1'),
    attempt: 1,
    status: 'SUBMITTED',
    ambiguous: false,
    submittedAtMs: ctx.nowMs,
    ...overrides,
  });
}

function prepared(): TransitionCommandResult {
  return prepareRequest(ctx, {
    caseId: caseId.value,
    from: 'MATCH_CONFIRMED',
    authority: grant(),
    decision: decision(),
    policy: policy(),
    recipe: recipe(),
    source: source(),
    channelOptions: [
      { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
    ],
    exemptionRecorded: false,
    humanGate: null,
  });
}

describe('every command emits only declared events (SPEC-001 §6, §7)', () => {
  test('the command→event map is a subset of the canonical event catalogue', () => {
    for (const [command, names] of Object.entries(COMMAND_EVENTS)) {
      assert.ok(names.length > 0, `${command} must emit something`);
      for (const name of names) {
        assert.ok(
          (DOMAIN_EVENT_NAMES as readonly string[]).includes(name),
          `${command} declares undeclared event ${name}`,
        );
      }
    }
  });
});

describe('RegisterSubject and AttachAlias (VG-IDENT-001/002)', () => {
  test('a registered subject emits SubjectRegistered and an audit event', () => {
    const result = registerSubject(ctx, { subject: subject(), grant: grant() });
    assert.deepEqual(
      result.events.map((e) => e.name),
      ['SubjectRegistered'],
    );
    assert.equal(result.audit.action, 'RegisterSubject');
    assert.equal(result.audit.correlationId, 'corr-0001');
    assert.equal(result.isLegitimateOutcome, true);
  });

  test('registration with an expired grant is refused (VG-AUTHZ-001)', () => {
    assert.throws(
      () =>
        registerSubject(ctx, {
          subject: subject(grant({ expiresAtMs: DAY })),
          grant: grant({ expiresAtMs: DAY }),
        }),
      AuthorityExpired,
    );
  });

  test('an ambiguous alias is quarantined, never attached', () => {
    const alias = createAlias({
      id: 'alias-1',
      tenantId,
      subjectId: null,
      valueEncRef: 'enc:alias/1',
      valueHmac: 'hmac-1',
      provenance: 'discovery:source-0001',
      method: 'exact-name',
      addedAtMs: DAY,
    });
    const result = attachAlias(ctx, { alias, ambiguous: true });
    assert.deepEqual(
      result.events.map((e) => e.name),
      ['AliasQuarantined'],
    );
    assert.equal(result.events[0]?.payload['quarantined'], true);
  });
});

describe('RecordSourceRecord and AssessMatch (T1, T3, T4)', () => {
  test('T1 requires a permitted read path', () => {
    const record = createSourceRecord({
      id: 'record-1',
      tenantId,
      sourceId,
      rawRef: 'https://example.invalid/profile/1',
      observedAtMs: DAY,
      contentHash: digest,
      tainted: false,
    });
    const result = recordSourceRecord(ctx, { record, permittedReadPath: true });
    assert.equal(result.transitionId, 'T1');
    assert.equal(result.to, 'DISCOVERED_CANDIDATE');
    assert.throws(() => recordSourceRecord(ctx, { record, permittedReadPath: false }), Error);
  });

  test('T3 needs a basis and either the threshold or a human approval', () => {
    const base = {
      caseId: caseId.value,
      from: 'DISCOVERED_CANDIDATE' as const,
      matched: true,
      confidenceAtThreshold: false,
      confidenceBasisRecorded: true,
      humanApproved: false,
      disproofRecorded: false,
    };
    assert.throws(() => assessMatch(ctx, base), Error);
    const approved = assessMatch(ctx, { ...base, humanApproved: true });
    assert.equal(approved.to, 'MATCH_CONFIRMED');
    assert.equal(approved.events[0]?.name, 'MatchConfirmed');
  });

  test('T4 records a disproof as VERIFIED_NOT_PRESENT, never as a removal', () => {
    const result = assessMatch(ctx, {
      caseId: caseId.value,
      from: 'DISCOVERED_CANDIDATE',
      matched: false,
      confidenceAtThreshold: false,
      confidenceBasisRecorded: false,
      humanApproved: false,
      disproofRecorded: true,
    });
    assert.equal(result.to, 'VERIFIED_NOT_PRESENT');
    assert.equal(result.events[0]?.name, 'MatchDisproved');
    assert.equal(result.isLegitimateOutcome, true);
  });
});

describe('ResolvePolicy and PrepareRequest (VG-POLICY-001/002, T5, T6, T7)', () => {
  test('a legal basis absent from the policy version in force is refused', () => {
    // The shared fixtures agree by construction, so the ACCEPT path is asserted first.
    assert.equal(assertPolicyInForce(policy(), decision(), ctx.nowMs), true);

    // A basis that the policy version does not contain must be refused (VG-POLICY-001).
    const absentBasis = createPolicyDecision({
      id: 'decision-absent',
      tenantId,
      caseId: caseId.value,
      jurisdiction,
      legalBasis: new LegalBasis('GDPR_ERASURE', 7),
      channel: 'OFFICIAL_SELF_SERVICE',
      policyVersion: 7,
      reasons: ['not-in-this-policy'],
      decidedAtMs: DAY,
    });
    assert.throws(() => assertPolicyInForce(policy(), absentBasis, ctx.nowMs), Error);

    // A policy version that does not match the decision is refused.
    const wrongVersion = createJurisdictionPolicy({
      id: 'policy-2',
      tenantId,
      jurisdiction,
      version: 8,
      effectiveFromMs: 0,
      effectiveToMs: null,
      rules: ['CCPA_DELETE'],
      provenance: 'COUNSEL_REVIEWED',
    });
    assert.throws(() => assertPolicyInForce(wrongVersion, decision(), ctx.nowMs), Error);

    // A policy that is not yet in force, or has lapsed, is refused.
    const lapsed = createJurisdictionPolicy({
      id: 'policy-3',
      tenantId,
      jurisdiction,
      version: 7,
      effectiveFromMs: 0,
      effectiveToMs: DAY,
      rules: ['CCPA_DELETE'],
      provenance: 'COUNSEL_REVIEWED',
    });
    assert.throws(() => assertPolicyInForce(lapsed, decision(), ctx.nowMs), Error);

    const resolved = resolvePolicy(ctx, {
      caseId: caseId.value,
      decision: decision(),
      policy: policy(),
    });
    assert.deepEqual(
      resolved.events.map((e) => e.name),
      ['PolicyResolved'],
    );
  });

  test('T5 reaches REQUEST_READY only with authority, policy, recipe and channel', () => {
    const result = prepared();
    assert.equal(result.transitionId, 'T5');
    assert.equal(result.to, 'REQUEST_READY');
    assert.equal(result.events[0]?.name, 'RequestReady');
    assert.equal(result.isLegitimateOutcome, false);
  });

  test('a stale recipe cannot reach REQUEST_READY (VG-CHANNEL-003)', () => {
    assert.throws(
      () =>
        prepareRequest(ctx, {
          caseId: caseId.value,
          from: 'MATCH_CONFIRMED',
          authority: grant(),
          decision: decision(),
          policy: policy(),
          recipe: recipe({ freshnessAtMs: DAY }),
          source: source(),
          channelOptions: [
            { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
          ],
          exemptionRecorded: false,
          humanGate: null,
        }),
      InvalidValueObject,
    );
  });

  test('WRITE_UNCLEAR produces NOT_REMOVABLE, never a write (VG-CHANNEL-002)', () => {
    const result = prepareRequest(ctx, {
      caseId: caseId.value,
      from: 'MATCH_CONFIRMED',
      authority: grant(),
      decision: decision(),
      policy: policy(),
      recipe: recipe(),
      source: source('WRITE_UNCLEAR'),
      channelOptions: [
        { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
      ],
      exemptionRecorded: false,
      humanGate: null,
    });
    assert.equal(result.to, 'NOT_REMOVABLE');
    assert.equal(result.events[0]?.name, 'NotRemovable');
    assert.equal(result.isLegitimateOutcome, true);
  });

  test('a human gate produces HUMAN_REQUIRED (T7), not a failure', () => {
    const result = prepareRequest(ctx, {
      caseId: caseId.value,
      from: 'MATCH_CONFIRMED',
      authority: grant(),
      decision: decision(),
      policy: policy(),
      recipe: recipe(),
      source: source(),
      channelOptions: [
        {
          channel: 'OFFICIAL_SELF_SERVICE',
          unavailableKind: 'GATED',
          unavailableReason: 'identity',
        },
      ],
      exemptionRecorded: false,
      humanGate: { gateKind: 'IDENTITY_VERIFICATION', reason: 'self-service requires proof' },
    });
    assert.equal(result.transitionId, 'T7');
    assert.equal(result.to, 'HUMAN_REQUIRED');
    assert.equal(result.isLegitimateOutcome, true);
  });

  test('T18 from REAPPEARED needs fresh authority, policy and recipe', () => {
    const result = prepareRequest(ctx, {
      caseId: caseId.value,
      from: 'REAPPEARED',
      authority: grant(),
      decision: decision(),
      policy: policy(),
      recipe: recipe(),
      source: source(),
      channelOptions: [
        { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
      ],
      exemptionRecorded: false,
      humanGate: null,
    });
    assert.equal(result.transitionId, 'T18');
    assert.equal(result.to, 'REQUEST_READY');
  });
});

describe('ExecuteAction (VG-ACTION-001/002/005, T8, T9)', () => {
  test('T8 submits exactly once and emits ActionSubmitted', () => {
    const result = executeAction(ctx, {
      caseId: caseId.value,
      action: action(),
      existingIdempotencyKeys: [],
      budgetAvailable: true,
      outcome: { kind: 'ACCEPTED', receiptRef: 'receipt-1' },
    }) as TransitionCommandResult;
    assert.equal(result.transitionId, 'T8');
    assert.equal(result.to, 'REQUEST_SUBMITTED');
    assert.deepEqual(
      result.events.map((e) => e.name),
      ['ActionSubmitted'],
    );
    // NON-COLLAPSE (SPEC-000 §5.1): a submitted action is not a removal. TypeScript
    // proves this comparison is always false, which is the property itself — the
    // assertion is written over the widened string type so the *runtime* claim is still
    // stated and still checked, rather than being quietly dropped by the compiler.
    assert.notEqual(result.to as string, 'VERIFIED_REMOVED');
  });

  test('a replayed key is refused, so one key yields one effect', () => {
    assert.throws(
      () =>
        executeAction(ctx, {
          caseId: caseId.value,
          action: action(),
          existingIdempotencyKeys: ['case-0001:self_service:v1'],
          budgetAvailable: true,
          outcome: { kind: 'ACCEPTED', receiptRef: 'receipt-1' },
        }),
      IdempotencyConflict,
    );
  });

  test('an ambiguous outcome reconciles instead of silently retrying', () => {
    const result = executeAction(ctx, {
      caseId: caseId.value,
      action: action({ status: 'AMBIGUOUS', ambiguous: true }),
      existingIdempotencyKeys: [],
      budgetAvailable: true,
      outcome: { kind: 'AMBIGUOUS', detail: 'timeout after send' },
    }) as TransitionCommandResult;
    assert.deepEqual(
      result.events.map((e) => e.name),
      ['ActionSubmitted', 'ActionAmbiguous'],
    );
  });

  test('an exhausted budget refuses the write and emits BudgetExceeded', () => {
    const result = executeAction(ctx, {
      caseId: caseId.value,
      action: action(),
      existingIdempotencyKeys: [],
      budgetAvailable: false,
      outcome: { kind: 'ACCEPTED', receiptRef: 'receipt-1' },
    }) as RefusalResult;
    assert.equal(result.refused, true);
    assert.equal(result.currentTruthState, 'REQUEST_READY');
    assert.deepEqual(
      result.events.map((e) => e.name),
      ['BudgetExceeded'],
    );
  });
});

describe('RecordControllerResponse and RecordVerification (T11, T14, VG-VERIFY-004)', () => {
  test('T11 acknowledges a claim and never asserts removal', () => {
    const response = createControllerResponse({
      id: 'response-1',
      tenantId,
      caseId,
      kind: 'EMAIL',
      bodyRef: 'enc:body/1',
      receivedAtMs: ctx.nowMs,
      claimedOutcome: 'VERIFIED_REMOVED',
    });
    const result = recordControllerResponse(ctx, {
      caseId: caseId.value,
      from: 'REQUEST_SUBMITTED',
      response,
      outcome: 'ACKNOWLEDGED',
      lawfulRefusalFinal: false,
    });
    assert.equal(result.to, 'ACKNOWLEDGED');
    // NON-COLLAPSE (SPEC-000 §5.1): an acknowledgment is not a deletion. See the note in
    // the ExecuteAction test for why this is compared over the widened string type.
    assert.notEqual(result.to as string, 'VERIFIED_REMOVED');
    assert.equal(result.isLegitimateOutcome, false);
  });

  test('T14 requires independence, the window, the method and absence', () => {
    const observation = createVerificationObservation({
      id: 'observation-1',
      tenantId,
      caseId,
      method: 'independent-fetch',
      observedAtMs: 6 * DAY,
      actorIdentity: 'observer-a',
      actingIdentity: 'actor-a',
      finding: 'ABSENT',
      evidenceId: new EvidenceId('evidence-1'),
    });
    const base = {
      caseId: caseId.value,
      from: 'ACKNOWLEDGED' as const,
      observation,
      window: new ObservationWindow(DAY, 'independent-fetch'),
      actionAtMs: 5 * DAY,
      recipeVerificationMethod: 'independent-fetch',
      recordAbsent: true,
    };
    const verified = recordVerification(ctx, base) as TransitionCommandResult;
    assert.equal(verified.transitionId, 'T14');
    assert.equal(verified.to, 'VERIFIED_REMOVED');
    assert.equal(verified.isLegitimateOutcome, true);

    const tooEarly = recordVerification(ctx, { ...base, actionAtMs: 6 * DAY - 1 }) as RefusalResult;
    assert.equal(tooEarly.refused, true);
    assert.equal(tooEarly.currentTruthState, 'ACKNOWLEDGED');
    assert.deepEqual(
      tooEarly.events.map((e) => e.name),
      ['VerificationFailed'],
    );

    const wrongMethod = recordVerification(ctx, {
      ...base,
      recipeVerificationMethod: 'source-api',
    }) as RefusalResult;
    assert.equal(wrongMethod.refused, true);
  });

  test('a controller claim cannot verify anything', () => {
    const claim = createControllerResponse({
      id: 'response-2',
      tenantId,
      caseId,
      kind: 'EMAIL',
      bodyRef: 'enc:body/2',
      receivedAtMs: ctx.nowMs,
      claimedOutcome: 'VERIFIED_REMOVED',
    });
    // The verifying command accepts only a VerificationObservation, so a claim is not
    // even representable as verification input.
    assert.throws(
      () =>
        recordVerification(ctx, {
          caseId: caseId.value,
          from: 'ACKNOWLEDGED',
          observation: claim as never,
          window: new ObservationWindow(DAY, 'independent-fetch'),
          actionAtMs: 0,
          recipeVerificationMethod: 'independent-fetch',
          recordAbsent: true,
        }),
      Error,
    );
  });
});

describe('DetectReappearance and RequestHumanGate (T17, T20, HUMAN_REQUIRED)', () => {
  test('T17 links a reappearance to the prior removal event', () => {
    const result = detectReappearance(ctx, {
      caseId: caseId.value,
      from: 'VERIFIED_REMOVED',
      priorRemovedEventId: 'VerifiedRemoved:corr-0001:432000000',
      recordPresentAgain: true,
    });
    assert.equal(result.transitionId, 'T17');
    assert.equal(result.to, 'REAPPEARED');
    assert.equal(
      result.events[0]?.payload['priorRemovedEventId'],
      'VerifiedRemoved:corr-0001:432000000',
    );
  });

  test('T20 treats a returning search result as REAPPEARED, not as source removal', () => {
    const result = detectReappearance(ctx, {
      caseId: caseId.value,
      from: 'SEARCH_DELISTED',
      priorRemovedEventId: 'VerifiedRemoved:corr-0001:432000000',
      recordPresentAgain: true,
    });
    assert.equal(result.transitionId, 'T20');
    assert.equal(result.to, 'REAPPEARED');
  });

  test('a human gate is raised from every state that permits it', () => {
    for (const from of [
      'MATCH_CONFIRMED',
      'REQUEST_READY',
      'REQUEST_SUBMITTED',
      'ACKNOWLEDGED',
    ] as const) {
      const result = requestHumanGate(ctx, {
        caseId: caseId.value,
        from,
        gateKind: 'IDENTITY_VERIFICATION',
        reason: 'human step required',
      });
      assert.equal(result.to, 'HUMAN_REQUIRED');
      assert.equal(result.isLegitimateOutcome, true);
    }
    assert.throws(
      () =>
        requestHumanGate(ctx, {
          caseId: caseId.value,
          from: 'VERIFIED_NOT_PRESENT',
          gateKind: 'IDENTITY_VERIFICATION',
          reason: 'not permitted from a terminal-for-now state',
        }),
      IllegalTransition,
    );
  });
});

describe('command results are auditable facts (SM-2)', () => {
  test('every command result carries an audit event with the correlation id', () => {
    const results: CommandResult[] = [
      registerSubject(ctx, { subject: subject(), grant: grant() }),
      prepared(),
      detectReappearance(ctx, {
        caseId: caseId.value,
        from: 'VERIFIED_REMOVED',
        priorRemovedEventId: 'audit-1',
        recordPresentAgain: true,
      }),
    ];
    for (const result of results) {
      assert.equal(result.audit.correlationId, ctx.correlationId);
      assert.equal(result.audit.tenantId.value, tenantId.value);
      assert.ok(result.audit.id.length > 0);
      assert.equal(createAuditEvent({ ...result.audit }).action, result.audit.action);
    }
  });
});
