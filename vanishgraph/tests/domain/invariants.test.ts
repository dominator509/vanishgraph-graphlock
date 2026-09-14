/**
 * Invariant tests (SPEC-001 §4.3 and the cross-entity rules).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAuditAppended,
  assertChannelMayWrite,
  assertContentMayDirectAction,
  assertEffectBudget,
  assertEgressAllowed,
  assertFactsCarryEvidence,
  assertIdempotencyKeyUnused,
  assertIndependentObservation,
  assertNotControllerClaim,
  assertObservationWindowMet,
  assertPolicyDecisionComplete,
  assertReobservable,
  assertSingleCurrentTruthState,
  assertStateChangedByCommand,
  assertSubjectHasAuthority,
  assertTransitionEvidence,
  assertVerificationMethodMatches,
  assertWriteLaneAllowedForSubject,
  classifyTruthState,
  isAuthorityUsableAt,
} from '../../src/domain/invariants.ts';
import {
  createAuthorityGrant,
  createControllerResponse,
  createPolicyDecision,
  createProtectedSubject,
  createRemovalRecipe,
  createSource,
  createSourceRecord,
  createVerificationObservation,
} from '../../src/domain/entities.ts';
import {
  CaseId,
  EvidenceId,
  RecipeId,
  SourceId,
  SubjectId,
  TenantId,
} from '../../src/domain/identifiers.ts';
import {
  EvidenceDigest,
  Jurisdiction,
  LegalBasis,
  ObservationWindow,
} from '../../src/domain/values.ts';
import { noFacts } from '../../src/domain/state-machine.ts';
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
} from '../../src/domain/errors.ts';

const tenantId = new TenantId('tenant-0001');
const subjectId = new SubjectId('subject-0001');
const caseId = new CaseId('case-0001');
const sourceId = new SourceId('source-0001');
const digest = new EvidenceDigest('c'.repeat(64));
const jurisdiction = new Jurisdiction('US-CA');
const DAY = 86_400_000;

function grant(overrides: Record<string, unknown> = {}) {
  return createAuthorityGrant({
    id: 'grant-0001',
    tenantId,
    subjectId,
    kind: 'SELF',
    scope: ['self_service_write'],
    evidenceId: null,
    issuedAtMs: 0,
    expiresAtMs: 100 * DAY,
    revokedAtMs: null,
    signedInstrument: false,
    ...overrides,
  });
}

function recipe(overrides: Record<string, unknown> = {}) {
  return createRemovalRecipe({
    id: new RecipeId('recipe-0001'),
    tenantId,
    sourceId,
    version: 1,
    signature: 'sig:abc',
    channel: 'OFFICIAL_SELF_SERVICE',
    verificationMethod: 'independent-fetch',
    freshnessAtMs: 30 * DAY,
    enabled: true,
    ...overrides,
  });
}

function source(permissionClass: 'WRITE_PERMITTED' | 'WRITE_UNCLEAR') {
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

function observation(overrides: Record<string, unknown> = {}) {
  return createVerificationObservation({
    id: 'observation-1',
    tenantId,
    caseId,
    method: 'independent-fetch',
    observedAtMs: 2 * DAY,
    actorIdentity: 'observer-a',
    actingIdentity: 'actor-a',
    finding: 'ABSENT',
    evidenceId: new EvidenceId('evidence-1'),
    ...overrides,
  });
}

describe('SM-1 … SM-6 (SPEC-001 §4.3)', () => {
  test('SM-1: exactly one current truth state is required', () => {
    assert.equal(assertSingleCurrentTruthState(['MATCH_CONFIRMED']), undefined);
    assert.throws(() => assertSingleCurrentTruthState([]), IllegalTransition);
    assert.throws(
      () => assertSingleCurrentTruthState(['MATCH_CONFIRMED', 'VERIFIED_REMOVED']),
      IllegalTransition,
    );
  });

  test('SM-2: a transition without an audit event is refused', () => {
    assert.equal(assertAuditAppended(['audit-1'], 'T3'), undefined);
    assert.throws(() => assertAuditAppended([], 'T3'), IllegalTransition);
  });

  test('SM-3: a transition must carry its declared evidence', () => {
    assert.equal(assertTransitionEvidence('T1', 'SourceRecord', ['record-1']), undefined);
    assert.throws(() => assertTransitionEvidence('T1', 'SourceRecord', []), GuardNotSatisfied);
    assert.throws(() => assertFactsCarryEvidence(noFacts(), 'T8'), GuardNotSatisfied);
    assert.equal(assertFactsCarryEvidence(noFacts({ recordAbsent: true }), 'T14'), undefined);
  });

  test('SM-4: terminal-for-now states stay re-observable', () => {
    // All three spec-named terminal-for-now states are flagged as such, so the monitoring
    // loop keeps watching them.
    for (const state of ['VERIFIED_REMOVED', 'VERIFIED_NOT_PRESENT', 'NOT_REMOVABLE'] as const) {
      const result = assertReobservable(state);
      assert.equal(result.terminalForNow, true, `${state} must be terminal-for-now`);
    }

    // Only VERIFIED_REMOVED has a revocation edge. SPEC-001 §4.1 grants no exit from
    // VERIFIED_NOT_PRESENT or NOT_REMOVABLE, and inventing one would be a fabricated
    // transition, so those two are asserted to have zero exits.
    assert.deepEqual(assertReobservable('VERIFIED_REMOVED').exitTransitions, ['T17']);
    assert.deepEqual(assertReobservable('VERIFIED_NOT_PRESENT').exitTransitions, []);
    assert.deepEqual(assertReobservable('NOT_REMOVABLE').exitTransitions, []);

    // A non-terminal state with no exit would strand a case: that is the property the
    // assertion genuinely guards.
    assert.equal(assertReobservable('REQUEST_READY').terminalForNow, false);
    assert.ok(assertReobservable('REQUEST_READY').exitTransitions.length > 0);
  });

  test('SM-5: HUMAN_REQUIRED and NOT_REMOVABLE are outcomes, never failures', () => {
    assert.equal(classifyTruthState('HUMAN_REQUIRED'), 'OUTCOME');
    assert.equal(classifyTruthState('NOT_REMOVABLE'), 'OUTCOME');
    assert.equal(classifyTruthState('VERIFIED_REMOVED'), 'OUTCOME');
    assert.equal(classifyTruthState('REQUEST_SUBMITTED'), 'IN_FLIGHT');
    assert.equal(classifyTruthState('ACKNOWLEDGED'), 'IN_FLIGHT');
    assert.equal(classifyTruthState('REQUEST_READY'), 'PROGRESS');
  });

  test('SM-6: only a domain command may change state', () => {
    assert.equal(assertStateChangedByCommand('domain-command'), undefined);
    for (const source of ['http-handler', 'adapter', 'model-output']) {
      assert.throws(() => assertStateChangedByCommand(source), IllegalTransition);
    }
  });
});

describe('authority, subject and channel rules', () => {
  test('VG-IDENT-001: a subject with no usable grant is refused', () => {
    const subject = createProtectedSubject({
      id: subjectId,
      tenantId,
      displayRef: 'subject-ref-0001',
      jurisdiction,
      isMinor: false,
      status: 'ACTIVE',
      authority: grant(),
      atMs: DAY,
    });
    assert.equal(assertSubjectHasAuthority(subject, [grant()], DAY), undefined);
    assert.throws(() => assertSubjectHasAuthority(subject, [], DAY), GuardNotSatisfied);
    assert.throws(
      () => assertSubjectHasAuthority(subject, [grant({ expiresAtMs: DAY })], 2 * DAY),
      GuardNotSatisfied,
    );
    assert.equal(isAuthorityUsableAt(grant(), DAY), true);
    assert.equal(isAuthorityUsableAt(grant({ revokedAtMs: DAY }), 2 * DAY), false);
  });

  test('VG-POLICY-002: an incomplete decision is refused', () => {
    const complete = createPolicyDecision({
      id: 'decision-1',
      tenantId,
      caseId: caseId.value,
      jurisdiction,
      legalBasis: new LegalBasis('CCPA_DELETE', 1),
      channel: 'OFFICIAL_SELF_SERVICE',
      policyVersion: 1,
      reasons: [],
      decidedAtMs: DAY,
    });
    assert.equal(assertPolicyDecisionComplete(complete), undefined);
    assert.throws(
      () => assertPolicyDecisionComplete({ ...complete, policyVersion: 0 }),
      PolicyUnresolved,
    );
  });

  test('VG-CHANNEL-002/003: unclear permission or stale recipe cannot write', () => {
    assert.equal(assertChannelMayWrite(source('WRITE_PERMITTED'), recipe(), DAY), undefined);
    assert.throws(
      () => assertChannelMayWrite(source('WRITE_UNCLEAR'), recipe(), DAY),
      GuardNotSatisfied,
    );
    assert.throws(
      () =>
        assertChannelMayWrite(source('WRITE_PERMITTED'), recipe({ freshnessAtMs: DAY }), 2 * DAY),
      Error,
    );
  });

  test('VG-SEC-001: tainted content cannot direct an action', () => {
    const tainted = createSourceRecord({
      id: 'record-1',
      tenantId,
      sourceId,
      rawRef: 'https://example.invalid/1',
      observedAtMs: DAY,
      contentHash: digest,
      tainted: true,
    });
    assert.throws(
      () => assertContentMayDirectAction(tainted, 'an external write'),
      TaintedContentRejected,
    );
    assert.equal(assertContentMayDirectAction({ ...tainted, tainted: false }, 'a read'), undefined);
  });

  test('VG-POLICY-004: a minor subject is routed to review', () => {
    const minor = createProtectedSubject({
      id: subjectId,
      tenantId,
      displayRef: 'subject-ref-0002',
      jurisdiction,
      isMinor: true,
      status: 'ACTIVE',
      authority: grant(),
      atMs: DAY,
    });
    assert.throws(() => assertWriteLaneAllowedForSubject(minor), HumanGateRequired);
  });
});

describe('verification, egress, budget and idempotency rules', () => {
  test('VG-VERIFY-001/002/003: independence, window and method are all required', () => {
    assert.equal(assertIndependentObservation(observation()), undefined);
    // The entity factory refuses self-verification at construction, so the invariant is
    // asserted against a structurally identical record to prove the assertion itself.
    assert.throws(
      () => assertIndependentObservation({ ...observation(), actingIdentity: 'observer-a' }),
      ObservationNotIndependent,
    );

    const window = new ObservationWindow(DAY, 'independent-fetch');
    assert.equal(assertObservationWindowMet(window, 2 * DAY, DAY), undefined);
    assert.throws(() => assertObservationWindowMet(window, DAY + 1, DAY), ObservationWindowNotMet);

    assert.equal(assertVerificationMethodMatches(recipe(), observation()), undefined);
    assert.throws(
      () => assertVerificationMethodMatches(recipe(), observation({ method: 'source-api' })),
      VerificationMethodMismatch,
    );
  });

  test('VG-VERIFY-004: a controller claim is not an observation', () => {
    const claim = createControllerResponse({
      id: 'response-1',
      tenantId,
      caseId,
      kind: 'EMAIL',
      bodyRef: 'enc:body/1',
      receivedAtMs: DAY,
      claimedOutcome: 'VERIFIED_REMOVED',
    });
    assert.throws(() => assertNotControllerClaim(claim), GuardNotSatisfied);
  });

  test('VG-EGRESS-001: protected classes are denied without an explicit policy', () => {
    assert.throws(() => assertEgressAllowed('CUSTOMER_PII', false, 'telemetry'), EgressDenied);
    assert.equal(assertEgressAllowed('CUSTOMER_PII', true, 'telemetry'), undefined);
    assert.equal(assertEgressAllowed('OPAQUE_ID', false, 'telemetry'), undefined);
  });

  test('VG-ACTION-005 and VG-ACTION-001: budget and key rules', () => {
    assert.equal(assertEffectBudget('subject-0001/source-0001/30d', 2, 5), undefined);
    assert.throws(() => assertEffectBudget('subject-0001/source-0001/30d', 5, 5), BudgetExceeded);
    assert.equal(assertIdempotencyKeyUnused('k1', ['k2']), undefined);
    assert.throws(() => assertIdempotencyKeyUnused('k1', ['k1']), IdempotencyConflict);
  });
});
