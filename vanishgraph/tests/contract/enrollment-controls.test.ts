/**
 * The anti-fraudulent-enrollment controls (SPEC-005 §3.1 VG-AUTHZ-010…014; EP-006 M4).
 *
 * Each control is asserted with the case it exists for — the enrollment that is about to be contested, the burst, the two
 * agents claiming one subject — and each refusal is asserted to ROUTE TO REVIEW with an audit record rather than to
 * refuse retryably: a caller that can retry until the counter resets has not been limited.
 *
 * The clock is the injected value in every case, so a cooling-off window is exercised without waiting.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COOLING_OFF_HOURS,
  DEFAULT_VELOCITY_LIMITS,
  checkVelocity,
  coolingOffDeadline,
  decideAgentEnrollment,
  kindRequiresCoolingOff,
  type AgentEnrollmentRequest,
} from '../../src/application/security/enrollment-controls.ts';
import { mintGrant, type AuthorityGrant } from '../../src/application/security/authority-service.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SUBJECT = 'subject-opaque-1';
const ENROLLED = '2026-09-16T00:00:00Z';

/** An agent enrollment that satisfies every control, so each test can change exactly one thing. */
function request(overrides: Partial<AgentEnrollmentRequest> = {}): AgentEnrollmentRequest {
  return {
    tenantId: TENANT,
    subjectRef: SUBJECT,
    agentRef: 'agent-opaque-1',
    enrolledAt: ENROLLED,
    instrumentArtifactId: 'instrument-1',
    signatureVerified: true,
    noticeArtifactId: 'notice-1',
    scope: ['vg.cases.read'],
    expiresAt: '2027-09-16T00:00:00Z',
    authorityGrantId: 'grant-agent-1',
    identityLevel: 'IAL2',
    existingGrants: [],
    ...overrides,
  };
}

/** An existing agent grant for the same subject, minted through the real mint so the shape is the domain's. */
function existingAgentGrant(): AuthorityGrant {
  return mintGrant({
    authorityGrantId: 'grant-agent-existing',
    tenantId: TENANT,
    subjectRef: SUBJECT,
    kind: 'AGENT',
    scope: ['vg.cases.read'],
    now: '2026-09-01T00:00:00Z',
    identityLevel: 'IAL2',
    evidenceArtifactId: 'instrument-existing',
    noticeArtifactId: 'notice-existing',
    coolingOffUntil: '2026-09-04T00:00:00Z',
    expiresAt: '2027-09-01T00:00:00Z',
  });
}

describe('agent enrollment requires evidence, a verified signature and a recorded notice (VG-AUTHZ-010/014)', () => {
  test('a complete enrollment proceeds and carries its cooling-off deadline', () => {
    const decision = decideAgentEnrollment(request());
    assert.equal(decision.ok, true);
    assert.equal(decision.coolingOffUntil, '2026-09-19T00:00:00Z', '72 hours after enrollment');
    assert.equal(decision.audit?.event, 'enrollment.notice_recorded');
    assert.match(decision.audit?.detail ?? '', /notice notice-1 recorded/);
  });

  test('a missing instrument, an UNVERIFIED instrument, and a missing notice are each refused', () => {
    const missingInstrument = decideAgentEnrollment(request({ instrumentArtifactId: null }));
    assert.equal(missingInstrument.code, 'AUTHORITY_EVIDENCE_REQUIRED');
    assert.match(missingInstrument.detail, /stored signed instrument/);

    // THE UNVERIFIED CASE IS SEPARATE FROM THE MISSING ONE: a stored instrument whose signature did not verify is not
    // evidence, and a check that only looked for presence would accept it.
    const unverified = decideAgentEnrollment(request({ signatureVerified: false }));
    assert.equal(unverified.code, 'AUTHORITY_EVIDENCE_REQUIRED');
    assert.match(unverified.detail, /did not verify/);

    const noNotice = decideAgentEnrollment(request({ noticeArtifactId: null }));
    assert.equal(noNotice.code, 'AUTHORITY_EVIDENCE_REQUIRED');
    assert.match(noNotice.detail, /recorded notice/);
  });

  test('the cooling-off deadline is computed from the injected clock value, not from the wall clock', () => {
    assert.equal(COOLING_OFF_HOURS, 72);
    assert.equal(coolingOffDeadline(ENROLLED), '2026-09-19T00:00:00Z');
    assert.equal(coolingOffDeadline('2026-12-31T12:00:00Z', 1), '2026-12-31T13:00:00Z');
    // A different enrollment time moves the deadline, so the computation reads its input.
    assert.notEqual(coolingOffDeadline('2026-09-17T00:00:00Z'), coolingOffDeadline(ENROLLED));
  });

  test('every kind except SELF carries a cooling-off period', () => {
    assert.equal(kindRequiresCoolingOff('SELF'), false);
    for (const kind of ['AGENT', 'PARENT_GUARDIAN', 'LEGAL_REPRESENTATIVE'] as const) {
      assert.equal(kindRequiresCoolingOff(kind), true, `${kind} must carry a cooling-off period`);
    }
  });
});

describe('velocity limits cover all three dimensions (VG-AUTHZ-011)', () => {
  const attempt = { tenantId: TENANT, subjectRef: SUBJECT, ipClass: 'class-a', paymentInstrumentRef: 'pi-1', at: ENROLLED };

  test('an attempt inside every limit is admitted with no audit record', () => {
    const decision = checkVelocity(attempt, { tenantAttemptsToday: 1, ipClassAttemptsToday: 1, paymentInstrumentAttemptsToday: 1 });
    assert.equal(decision.ok, true);
    assert.equal(decision.audit, undefined);
    assert.deepEqual(decision.breaches, []);
  });

  test('each dimension breaches on its own, and EVERY breach is reported rather than the first', () => {
    const tenantOnly = checkVelocity(attempt, { tenantAttemptsToday: 26, ipClassAttemptsToday: 1, paymentInstrumentAttemptsToday: 1 });
    assert.equal(tenantOnly.ok, false);
    assert.deepEqual(tenantOnly.breaches.map((breach) => breach.limit), ['perTenantPerDay']);

    const all = checkVelocity(attempt, { tenantAttemptsToday: 26, ipClassAttemptsToday: 6, paymentInstrumentAttemptsToday: 4 });
    assert.deepEqual(all.breaches.map((breach) => breach.limit).sort(), [
      'perIpClassPerDay',
      'perPaymentInstrumentPerDay',
      'perTenantPerDay',
    ]);
  });

  test('a breach ROUTES TO REVIEW and is audited, rather than refusing retryably', () => {
    const decision = checkVelocity(attempt, { tenantAttemptsToday: 26, ipClassAttemptsToday: 1, paymentInstrumentAttemptsToday: 1 });
    assert.equal(decision.route, 'REVIEW');
    assert.ok(decision.audit !== undefined);
    assert.equal(decision.audit?.event, 'enrollment.velocity_breach');
    assert.match(decision.audit?.detail ?? '', /perTenantPerDay 26>25/);
    assert.equal(decision.audit?.tenantId, TENANT);
    assert.equal(decision.audit?.subjectRef, SUBJECT);
    // A caller that retried until the counter reset would have been limited by nothing, which is why the route is REVIEW.
    assert.notEqual(decision.route, undefined);
  });

  test('the limits are declared values, not magic numbers at the call site', () => {
    assert.equal(DEFAULT_VELOCITY_LIMITS.perTenantPerDay, 25);
    assert.equal(DEFAULT_VELOCITY_LIMITS.perIpClassPerDay, 5);
    assert.equal(DEFAULT_VELOCITY_LIMITS.perPaymentInstrumentPerDay, 3);
    // A stricter limit changes the decision, so the parameter is read rather than ignored.
    const stricter = checkVelocity(
      attempt,
      { tenantAttemptsToday: 2, ipClassAttemptsToday: 1, paymentInstrumentAttemptsToday: 1 },
      { perTenantPerDay: 1, perIpClassPerDay: 5, perPaymentInstrumentPerDay: 3 },
    );
    assert.equal(stricter.ok, false);
  });

  test('the attempt record carries a coarse IP class, never an address', () => {
    // An IP is personal data; the type has no field for one, and this assertion states the property the type enforces.
    assert.equal('ipAddress' in attempt, false);
    assert.equal(typeof attempt.ipClass, 'string');
  });
});

describe('two agents claiming one subject is a conflict for a person (VG-AUTHZ-013)', () => {
  test('REQUIRED NEGATIVE CASE: a second active agent grant raises a conflict and routes to review', () => {
    const decision = decideAgentEnrollment(request({ existingGrants: [existingAgentGrant()] }));
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'STRICT_LANE_CONFLICT');
    assert.equal(decision.route, 'REVIEW');
    assert.match(decision.detail, /already hold this subject/);
    assert.equal(decision.audit?.event, 'enrollment.conflict');
  });

  test('a REVOKED or CONTESTED agent grant is not a conflict, because it holds nothing', () => {
    const revoked = { ...existingAgentGrant(), revokedAt: '2026-09-10T00:00:00Z' };
    assert.equal(decideAgentEnrollment(request({ existingGrants: [revoked] })).ok, true);
    const contested = { ...existingAgentGrant(), contestedAt: '2026-09-10T00:00:00Z' };
    assert.equal(decideAgentEnrollment(request({ existingGrants: [contested] })).ok, true);
  });

  test('a SELF or guardian grant is not an agent conflict', () => {
    const selfGrant = mintGrant({
      authorityGrantId: 'grant-self',
      tenantId: TENANT,
      subjectRef: SUBJECT,
      kind: 'SELF',
      scope: ['vg.cases.read'],
      now: ENROLLED,
      identityLevel: 'IAL2',
      evidenceArtifactId: null,
      noticeArtifactId: null,
      coolingOffUntil: null,
      expiresAt: '2027-09-16T00:00:00Z',
    });
    assert.equal(decideAgentEnrollment(request({ existingGrants: [selfGrant] })).ok, true);
  });
});
