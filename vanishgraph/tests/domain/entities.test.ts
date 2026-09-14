/**
 * Entity invariant tests (SPEC-001 §3).
 *
 * Each test asserts an invariant from the spec's own invariant column, using the real
 * factory: the point is that an invalid entity cannot be constructed at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAuthorityUsableAt,
  assertRecipeUsableAt,
  assertStrictLaneForMinor,
  assertUntainted,
  createAlias,
  createAppealEscalation,
  createAuditEvent,
  createAuthorityGrant,
  createControllerResponse,
  createDeadline,
  createEvidenceArtifact,
  createExposure,
  createExternalAction,
  createIdentifier,
  createJurisdictionPolicy,
  createMailPiece,
  createPolicyDecision,
  createProtectedSubject,
  createProviderTransportRun,
  createReappearance,
  createRemovalRecipe,
  createRepairCapsule,
  createSource,
  createSourceRecord,
  createVerificationObservation,
  mailCanReachAcknowledged,
  sourceMayBeWritten,
} from '../../src/domain/entities.ts';
import {
  ActionId,
  CaseId,
  EvidenceId,
  ExposureId,
  RecipeId,
  SourceId,
  SubjectId,
  TenantId,
} from '../../src/domain/identifiers.ts';
import {
  Confidence,
  EvidenceDigest,
  IdempotencyKey,
  Jurisdiction,
  LegalBasis,
} from '../../src/domain/values.ts';
import {
  AuthorityExpired,
  HumanGateRequired,
  InvalidValueObject,
} from '../../src/domain/errors.ts';

const tenantId = new TenantId('tenant-0001');
const subjectId = new SubjectId('subject-0001');
const caseId = new CaseId('case-0001');
const sourceId = new SourceId('source-0001');
const digest = new EvidenceDigest('a'.repeat(64));
const jurisdiction = new Jurisdiction('US-CA');
const DAY = 86_400_000;

function selfGrant(
  overrides: Partial<Parameters<typeof createAuthorityGrant>[0]> = {},
): ReturnType<typeof createAuthorityGrant> {
  return createAuthorityGrant({
    id: 'grant-0001',
    tenantId,
    subjectId,
    kind: 'SELF',
    scope: ['discovery', 'self_service_write'],
    evidenceId: null,
    issuedAtMs: 0,
    expiresAtMs: 10 * DAY,
    revokedAtMs: null,
    signedInstrument: false,
    ...overrides,
  });
}

describe('Tenant and ProtectedSubject (VG-IDENT-001, VG-POLICY-004)', () => {
  test('a subject requires a matching, valid AuthorityGrant', () => {
    const subject = createProtectedSubject({
      id: subjectId,
      tenantId,
      displayRef: 'subject-ref-0001',
      jurisdiction,
      isMinor: false,
      status: 'ACTIVE',
      authority: selfGrant(),
      atMs: DAY,
    });
    assert.deepEqual([...subject.authorityGrantIds], ['grant-0001']);
  });

  test('a grant for another subject does not authorise this subject', () => {
    assert.throws(
      () =>
        createProtectedSubject({
          id: new SubjectId('subject-0002'),
          tenantId,
          displayRef: 'subject-ref-0002',
          jurisdiction,
          isMinor: false,
          status: 'ACTIVE',
          authority: selfGrant(),
          atMs: DAY,
        }),
      Error,
    );
  });

  test('an expired grant refuses subject creation (VG-AUTHZ-001)', () => {
    assert.throws(
      () =>
        createProtectedSubject({
          id: subjectId,
          tenantId,
          displayRef: 'subject-ref-0001',
          jurisdiction,
          isMinor: false,
          status: 'ACTIVE',
          authority: selfGrant({ expiresAtMs: DAY }),
          atMs: 2 * DAY,
        }),
      AuthorityExpired,
    );
  });

  test('a raw name is not an acceptable displayRef', () => {
    assert.throws(
      () =>
        createProtectedSubject({
          id: subjectId,
          tenantId,
          displayRef: 'jane.doe@example.com',
          jurisdiction,
          isMinor: false,
          status: 'ACTIVE',
          authority: selfGrant(),
          atMs: DAY,
        }),
      InvalidValueObject,
    );
  });

  test('a minor subject cannot enter an automated write lane (VG-POLICY-004)', () => {
    const minor = createProtectedSubject({
      id: subjectId,
      tenantId,
      displayRef: 'subject-ref-0003',
      jurisdiction,
      isMinor: true,
      status: 'ACTIVE',
      authority: selfGrant(),
      atMs: DAY,
    });
    assert.throws(() => assertStrictLaneForMinor(minor), HumanGateRequired);
  });
});

describe('AuthorityGrant (VG-AUTHZ-002)', () => {
  test('an AGENT grant requires a signed instrument and evidence', () => {
    assert.throws(
      () => selfGrant({ kind: 'AGENT', signedInstrument: false, evidenceId: null }),
      InvalidValueObject,
    );
    const signed = selfGrant({ kind: 'AGENT', signedInstrument: true, evidenceId: 'evidence-1' });
    assert.equal(signed.signedInstrument, true);
  });

  test('expiry must follow issuance and scope must be non-empty', () => {
    assert.throws(() => selfGrant({ issuedAtMs: 10, expiresAtMs: 10 }), InvalidValueObject);
    assert.throws(() => selfGrant({ scope: [] }), InvalidValueObject);
  });

  test('a revoked grant is refused even before it expires', () => {
    const revoked = selfGrant({ revokedAtMs: DAY });
    assert.throws(() => assertAuthorityUsableAt(revoked, 2 * DAY), AuthorityExpired);
    assert.equal(assertAuthorityUsableAt(revoked, DAY - 1), undefined);
  });
});

describe('Alias and Identifier (VG-IDENT-002, VG-SEC-002)', () => {
  test('quarantine is exactly the absence of a subject link', () => {
    const quarantined = createAlias({
      id: 'alias-1',
      tenantId,
      subjectId: null,
      valueEncRef: 'enc:alias/1',
      valueHmac: 'hmac-1',
      provenance: 'discovery:source-0001',
      method: 'exact-name',
      addedAtMs: DAY,
    });
    assert.equal(quarantined.quarantined, true);
    const attached = createAlias({
      id: 'alias-2',
      tenantId,
      subjectId: subjectId.value,
      valueEncRef: 'enc:alias/2',
      valueHmac: 'hmac-2',
      provenance: 'subject:self-declared',
      method: 'exact-name',
      addedAtMs: DAY,
    });
    assert.equal(attached.quarantined, false);
  });

  test('cleartext values cannot enter through the encrypted reference', () => {
    assert.throws(
      () =>
        createIdentifier({
          id: 'identifier-1',
          tenantId,
          subjectId,
          kind: 'EMAIL',
          valueEncRef: 'jane.doe@example.com',
          keyVersion: 1,
          provenance: 'subject:self-declared',
        }),
      InvalidValueObject,
    );
    const identifier = createIdentifier({
      id: 'identifier-2',
      tenantId,
      subjectId,
      kind: 'EMAIL',
      valueEncRef: 'enc:tenant-0001/identifier-2',
      keyVersion: 3,
      provenance: 'subject:self-declared',
    });
    assert.equal(identifier.keyVersion, 3);
  });
});

describe('Source, RemovalRecipe, SourceRecord (VG-CHANNEL-002/003, VG-SEC-001)', () => {
  test('WRITE_UNCLEAR and PROHIBITED both forbid writes', () => {
    const unclear = createSource({
      id: sourceId,
      tenantId,
      name: 'example-registry',
      class: 'REGISTRY',
      jurisdiction,
      permissionClass: 'WRITE_UNCLEAR',
      permissionCheckedAtMs: DAY,
    });
    assert.equal(sourceMayBeWritten(unclear), false);
    const permitted = createSource({
      id: sourceId,
      tenantId,
      name: 'example-registry',
      class: 'REGISTRY',
      jurisdiction,
      permissionClass: 'WRITE_PERMITTED',
      permissionCheckedAtMs: DAY,
    });
    assert.equal(sourceMayBeWritten(permitted), true);
  });

  test('a stale or disabled recipe cannot write (VG-CHANNEL-003)', () => {
    const recipe = createRemovalRecipe({
      id: new RecipeId('recipe-0001'),
      tenantId,
      sourceId,
      version: 3,
      signature: 'sig:abc',
      channel: 'OFFICIAL_SELF_SERVICE',
      verificationMethod: 'independent-fetch',
      freshnessAtMs: 10 * DAY,
      enabled: true,
    });
    assert.equal(assertRecipeUsableAt(recipe, DAY), undefined);
    assert.throws(() => assertRecipeUsableAt(recipe, 11 * DAY), InvalidValueObject);
    assert.throws(
      () => assertRecipeUsableAt({ ...recipe, enabled: false }, DAY),
      InvalidValueObject,
    );
  });

  test('tainted remote content cannot direct an action (VG-SEC-001)', () => {
    const record = createSourceRecord({
      id: 'record-1',
      tenantId,
      sourceId,
      rawRef: 'https://example.invalid/profile/1',
      observedAtMs: DAY,
      contentHash: digest,
      tainted: true,
    });
    assert.throws(() => assertUntainted(record, 'an external write'), InvalidValueObject);
    assert.equal(assertUntainted({ ...record, tainted: false }, 'a read'), undefined);
  });
});

describe('Exposure, policy and evidence (VG-IDENT-003, VG-POLICY-001/002, VG-EVIDENCE-001)', () => {
  test('an exposure always carries a confidence with a basis', () => {
    const exposure = createExposure({
      id: new ExposureId('exposure-1'),
      tenantId,
      subjectId,
      sourceRecordId: 'record-1',
      confidence: new Confidence(0.91, ['exact-name-match', 'state-match']),
      truthState: 'MATCH_CONFIRMED',
      caseId: null,
    });
    assert.equal(exposure.confidence.basis.length, 2);
  });

  test('a jurisdiction policy cannot be authored by model output (VG-POLICY-001)', () => {
    assert.throws(
      () =>
        createJurisdictionPolicy({
          id: 'policy-1',
          tenantId,
          jurisdiction,
          version: 1,
          effectiveFromMs: 0,
          effectiveToMs: null,
          rules: ['statutory-window:45d'],
          provenance: 'MODEL_OUTPUT' as never,
        }),
      InvalidValueObject,
    );
  });

  test('a PolicyDecision requires all four fields and a matching policy version', () => {
    const basis = new LegalBasis('CCPA_DELETE', 7);
    const decision = createPolicyDecision({
      id: 'decision-1',
      tenantId,
      caseId: caseId.value,
      jurisdiction,
      legalBasis: basis,
      channel: 'OFFICIAL_SELF_SERVICE',
      policyVersion: 7,
      reasons: ['consumer-request-right'],
      decidedAtMs: DAY,
    });
    assert.equal(decision.legalBasis.code, 'CCPA_DELETE');
    assert.throws(
      () =>
        createPolicyDecision({
          id: 'decision-2',
          tenantId,
          caseId: caseId.value,
          jurisdiction,
          legalBasis: basis,
          channel: 'OFFICIAL_SELF_SERVICE',
          policyVersion: 8,
          reasons: [],
          decidedAtMs: DAY,
        }),
      InvalidValueObject,
    );
  });

  test('an audit payload carrying apparent PII is refused (VG-SEC-002)', () => {
    assert.throws(
      () =>
        createAuditEvent({
          id: 'audit-1',
          tenantId,
          actor: 'domain-command',
          action: 'SubjectRegistered',
          targetKind: 'ProtectedSubject',
          targetId: subjectId.value,
          correlationId: 'corr-1',
          atMs: DAY,
          payload: { note: 'jane.doe@example.com' },
        }),
      InvalidValueObject,
    );
    const event = createAuditEvent({
      id: 'audit-2',
      tenantId,
      actor: 'domain-command',
      action: 'SubjectRegistered',
      targetKind: 'ProtectedSubject',
      targetId: subjectId.value,
      correlationId: 'corr-1',
      atMs: DAY,
      payload: { displayRef: 'subject-ref-0001' },
    });
    assert.equal(event.action, 'SubjectRegistered');
  });
});

describe('Action aggregate (VG-ACTION-001/002/004, VG-VERIFY-001/004, VG-REAPPEAR-001)', () => {
  test('an ExternalAction always names exactly one idempotency key', () => {
    const action = createExternalAction({
      id: new ActionId('action-1'),
      tenantId,
      caseId,
      channel: 'CERTIFIED_MAIL',
      idempotencyKey: new IdempotencyKey('case-0001:certified_mail:v1'),
      attempt: 1,
      status: 'SUBMITTED',
      ambiguous: false,
      submittedAtMs: DAY,
    });
    assert.equal(action.idempotencyKey.value, 'case-0001:certified_mail:v1');
  });

  test('an ambiguous status forces reconciliation', () => {
    assert.throws(
      () =>
        createExternalAction({
          id: new ActionId('action-2'),
          tenantId,
          caseId,
          channel: 'CERTIFIED_MAIL',
          idempotencyKey: new IdempotencyKey('k2'),
          attempt: 1,
          status: 'AMBIGUOUS',
          ambiguous: false,
          submittedAtMs: null,
        }),
      InvalidValueObject,
    );
  });

  test('mail without tracking cannot reach ACKNOWLEDGED (VG-ACTION-004)', () => {
    const piece = createMailPiece({
      id: 'mail-1',
      tenantId,
      caseId,
      templateVersion: 4,
      templateHash: digest,
      transportName: 'certified-mail-transport',
      trackingId: null,
      deliveryStatus: 'SENT',
    });
    assert.equal(mailCanReachAcknowledged(piece), false);
    assert.equal(mailCanReachAcknowledged({ ...piece, trackingId: 'track-1' }), true);
  });

  test('a deadline must derive from a policy version', () => {
    assert.throws(
      () =>
        createDeadline({
          id: 'deadline-1',
          tenantId,
          caseId,
          kind: 'STATUTORY_RESPONSE',
          dueAtMs: 45 * DAY,
          derivationRef: '45',
          satisfiedAtMs: null,
        }),
      InvalidValueObject,
    );
  });

  test('an appeal always requires human review', () => {
    assert.throws(
      () =>
        createAppealEscalation({
          id: 'appeal-1',
          tenantId,
          caseId,
          kind: 'REGULATOR_COMPLAINT',
          requiresHumanReview: false,
          artifactIds: [],
        }),
      InvalidValueObject,
    );
  });

  test('a controller response is a claim and carries no observation', () => {
    const response = createControllerResponse({
      id: 'response-1',
      tenantId,
      caseId,
      kind: 'EMAIL',
      bodyRef: 'enc:body/1',
      receivedAtMs: DAY,
      claimedOutcome: 'VERIFIED_REMOVED',
    });
    assert.equal(response.claimedOutcome, 'VERIFIED_REMOVED');
  });

  test('the acting path cannot verify itself (VG-VERIFY-001)', () => {
    assert.throws(
      () =>
        createVerificationObservation({
          id: 'observation-1',
          tenantId,
          caseId,
          method: 'independent-fetch',
          observedAtMs: 2 * DAY,
          actorIdentity: 'actor-a',
          actingIdentity: 'actor-a',
          finding: 'ABSENT',
          evidenceId: new EvidenceId('evidence-2'),
        }),
      InvalidValueObject,
    );
  });

  test('Reappearance requires a prior VERIFIED_REMOVED (VG-REAPPEAR-001)', () => {
    assert.throws(
      () =>
        createReappearance({
          id: 'reappearance-1',
          tenantId,
          exposureId: new ExposureId('exposure-1'),
          priorRemovedEventId: 'audit-9',
          priorState: 'ACKNOWLEDGED',
          observedAtMs: 3 * DAY,
          evidenceId: new EvidenceId('evidence-3'),
        }),
      InvalidValueObject,
    );
  });
});

describe('Operations entities (ADR-004, VG-EGRESS-002)', () => {
  test('only official transports are representable', () => {
    assert.throws(
      () =>
        createProviderTransportRun({
          id: 'run-1',
          tenantId,
          transportName: 'unofficial-transport',
          authMode: 'COOKIE_REUSE' as never,
          egressClass: 'NONE',
          startedAtMs: DAY,
          outcome: 'SUBMITTED',
          costRef: null,
        }),
      InvalidValueObject,
    );
  });

  test('a repair capsule refuses apparent PII before egress (VG-EGRESS-002)', () => {
    assert.throws(
      () =>
        createRepairCapsule({
          id: 'capsule-1',
          tenantId,
          fingerprint: 'fp-1',
          sanitizedEvidence: 'contact jane.doe@example.com failed',
          expected: 'submission accepted',
          actual: 'timeout',
          prRef: null,
        }),
      InvalidValueObject,
    );
  });

  test('an evidence artifact is content-addressed', () => {
    const artifact = createEvidenceArtifact({
      id: new EvidenceId('evidence-4'),
      tenantId,
      caseId: caseId.value,
      kind: 'SUBMISSION_RECEIPT',
      digest,
      storageRef: 's3://evidence/tenant-0001/evidence-4',
      egressClass: 'OPAQUE_ID',
      redactionState: 'SCRUBBED',
      capturedAtMs: DAY,
    });
    assert.equal(artifact.digest.value, digest.value);
  });
});
