/**
 * JIT `SUPPORT` access, enumeration inhibition and progressive lockout (SPEC-005 §2/§9/§10; EP-006 M6).
 *
 * The clock is the injected value in every case, so a sixty-minute box is exercised without waiting. The suite asserts the
 * ABSENCE of standing access as a property of the state set rather than as a behaviour, because a state machine that
 * cannot express "indefinitely" is what keeps ROLE-2 true after the next edit.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LOCKOUT_POLICY,
  ENUMERATION_NEUTRAL_RESPONSE,
  MAX_SUPPORT_SESSION_MINUTES,
  SUPPORT_SESSION_STATES,
  SupportAccessError,
  assertAuditImmutability,
  authorisePiiRead,
  diagnosticView,
  enterSupportSession,
  exitSupportSession,
  isLive,
  lockoutFor,
  openSupportSession,
  responseForSubjectProbe,
} from '../../src/application/security/support-access-service.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000;
const clock = (): number => NOW;
const at = (seconds: number) => (): number => NOW + seconds;

function open(overrides: Record<string, unknown> = {}): ReturnType<typeof openSupportSession> {
  return openSupportSession({
    sessionId: 'session-1',
    tenantId: TENANT,
    actorIdentity: 'support-opaque-1',
    reason: 'diagnosing a failed verification for case cas_1',
    clock,
    ...overrides,
  });
}

describe('a support session is a time box with no standing state (ROLE-2, VG-AUTH-028)', () => {
  test('STANDING IS NOT A STATE: the declared lifecycle is exactly four values and none of them is permanent', () => {
    assert.deepEqual([...SUPPORT_SESSION_STATES], ['REQUESTED', 'ACTIVE', 'EXPIRED', 'REVOKED']);
    assert.equal((SUPPORT_SESSION_STATES as readonly string[]).includes('STANDING'), false);
    assert.equal(MAX_SUPPORT_SESSION_MINUTES, 60);
  });

  test('entry is audited, the requested lifetime is CAPPED rather than refused, and a reason is required', () => {
    const { session, audit } = open({ requestedMinutes: 240 });
    assert.equal(session.expiresAt - session.grantedAt, 60 * 60, 'four hours becomes sixty minutes');
    assert.equal(session.state, 'REQUESTED');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.event, 'support.session.requested');
    assert.match(audit[0]?.detail ?? '', /diagnosing a failed verification/);
    assert.throws(() => open({ reason: '   ' }), (error: unknown) => {
      assert.ok(error instanceof SupportAccessError);
      assert.equal(error.code, 'SUPPORT_REASON_REQUIRED');
      return true;
    });
  });

  test('entry produces an ACTIVE session and an audit row; expiry is evaluated on every check', () => {
    const { session } = open();
    const entered = enterSupportSession(session, clock);
    assert.equal(entered.session.state, 'ACTIVE');
    assert.equal(entered.audit.event, 'support.session.entered');
    assert.equal(isLive(entered.session, clock), true);
    // EXACTLY AT THE BOUNDARY the session is over: `expiresAt <= now` is not live, so 60 minutes + 1 second is out.
    assert.equal(isLive(entered.session, at(3600)), false);
    assert.equal(isLive(entered.session, at(3599)), true);
  });

  test('a session past its box is refused, even though nothing swept it', () => {
    const { session } = open();
    const entered = enterSupportSession(session, clock).session;
    const read = { tenantId: TENANT, fieldClass: 'identifier.value' };
    assert.doesNotThrow(() => authorisePiiRead(entered, read, at(1800)));
    assert.throws(() => authorisePiiRead(entered, read, at(3601)), (error: unknown) => {
      assert.ok(error instanceof SupportAccessError);
      assert.equal(error.code, 'SUPPORT_SESSION_REQUIRED');
      return true;
    });
  });

  test('a session for tenant A cannot read tenant B, and the refusal says nothing about tenant B', () => {
    const entered = enterSupportSession(open().session, clock).session;
    assert.throws(
      () => authorisePiiRead(entered, { tenantId: OTHER_TENANT, fieldClass: 'identifier.value' }, clock),
      (error: unknown) => {
        assert.ok(error instanceof SupportAccessError);
        assert.equal(error.code, 'TENANT_MISMATCH');
        assert.equal(error.message.includes(OTHER_TENANT), false, 'the refusal must not confirm the other tenant');
        return true;
      },
    );
  });

  test('EVERY PII-class read appends its own audit event, and exit appends the exit', () => {
    const entered = enterSupportSession(open().session, clock).session;
    const first = authorisePiiRead(entered, { tenantId: TENANT, fieldClass: 'identifier.value' }, clock);
    const second = authorisePiiRead(entered, { tenantId: TENANT, fieldClass: 'contact.email' }, clock);
    assert.equal(first.event, 'support.pii_read');
    assert.match(first.detail, /identifier\.value/);
    assert.match(second.detail, /contact\.email/);
    const exited = exitSupportSession(entered, clock);
    assert.equal(exited.session.state, 'REVOKED');
    assert.equal(exited.audit.event, 'support.session.exited');
    // And a revoked session cannot read afterwards.
    assert.throws(() => authorisePiiRead(exited.session, { tenantId: TENANT, fieldClass: 'identifier.value' }, clock), /no ACTIVE support session/);
  });

  test('an unavailable clock refuses rather than assuming a session is live', () => {
    const unavailable = (): number | undefined => undefined;
    assert.throws(() => open({ clock: unavailable }), /clock is unavailable/);
    const entered = enterSupportSession(open().session, clock).session;
    assert.equal(isLive(entered, unavailable), false, 'an unestablishable time is not live');
    assert.throws(() => authorisePiiRead(entered, { tenantId: TENANT, fieldClass: 'x' }, unavailable), /liveness cannot be established/);
  });
});

describe('impersonation does not exist as a capability (ROLE-3)', () => {
  test('the diagnostic view carries no identifier values, by type as well as by behaviour', () => {
    const present = diagnosticView({ subjectRef: 'sub_1', displayRef: 'ref-opaque-1' });
    assert.equal(present.subjectRefPresent, true);
    assert.equal(present.displayRef, 'ref-opaque-1');
    assert.equal(present.identifierValues, null);
    assert.match(present.note, /impersonation is prohibited/);
    const absent = diagnosticView(undefined);
    assert.equal(absent.subjectRefPresent, false);
    assert.equal(absent.identifierValues, null);
    // There is no export of the subject's record from this module, which is the property the test can assert.
    assert.equal(Object.keys(present).includes('record'), false);
  });

  test('ROLE-4: no role may disable, truncate or delete audit, and there is no exception to grant', () => {
    for (const role of ['TENANT_ADMIN', 'OPERATOR', 'AUDITOR', 'SUPPORT']) {
      for (const operation of ['disable', 'truncate', 'delete'] as const) {
        assert.throws(() => assertAuditImmutability(role, operation), /ROLE-4 forbids any role/);
      }
    }
  });
});

describe('enumeration is inhibited (VG-AUTH-027)', () => {
  test('absent and present-but-unauthorised are the SAME response', () => {
    const absent = responseForSubjectProbe(false, true);
    const unauthorised = responseForSubjectProbe(true, false);
    assert.deepEqual(absent, unauthorised);
    assert.deepEqual(absent, { ...ENUMERATION_NEUTRAL_RESPONSE });
    // An authorised caller can still read, so the inhibition is not a blanket refusal.
    assert.equal(responseForSubjectProbe(true, true).status, 200);
  });

  test('no response confirms whether a named person is a customer', () => {
    // The only distinguishing information is what an AUTHORISED caller receives, which is the resource itself.
    const codes = [responseForSubjectProbe(false, true).code, responseForSubjectProbe(true, false).code];
    assert.deepEqual([...new Set(codes)], ['RESOURCE_NOT_FOUND']);
  });
});

describe('progressive lockout escalates and then refuses (VG-AUTH-019)', () => {
  test('the delay grows with consecutive failures and is zero at the first', () => {
    assert.equal(lockoutFor('actor', TENANT, 0).delaySeconds, 0);
    assert.equal(lockoutFor('actor', TENANT, 1).delaySeconds, 1);
    assert.equal(lockoutFor('actor', TENANT, 2).delaySeconds, 2);
    assert.equal(lockoutFor('actor', TENANT, 3).delaySeconds, 5);
    assert.equal(lockoutFor('actor', TENANT, 4).delaySeconds, 15);
    for (let failures = 1; failures < DEFAULT_LOCKOUT_POLICY.refusalThreshold; failures += 1) {
      assert.equal(lockoutFor('actor', TENANT, failures).allow, true, `${String(failures)} failures are still allowed with a delay`);
    }
  });

  test('past the threshold the request is REFUSED and an alert is emitted', () => {
    const decision = lockoutFor('actor-opaque-1', TENANT, DEFAULT_LOCKOUT_POLICY.refusalThreshold, DEFAULT_LOCKOUT_POLICY, NOW);
    assert.equal(decision.allow, false);
    assert.equal(decision.alert?.event, 'auth.lockout_escalated');
    assert.equal(decision.alert?.actorIdentity, 'actor-opaque-1');
    assert.equal(decision.alert?.tenantId, TENANT);
    assert.match(decision.alert?.detail ?? '', /consecutive authorization failures/);
  });
});
