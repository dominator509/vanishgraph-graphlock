/**
 * Just-in-time `SUPPORT` access and progressive lockout (SPEC-005 §2 ROLE-2/3/4, §9 VG-AUTH-016…019, §10 VG-AUTH-028;
 * EP-006 M6).
 *
 * **STANDING ACCESS DOES NOT EXIST AS A STATE.** The lifecycle is `REQUESTED → ACTIVE → EXPIRED|REVOKED`, and there is no
 * value a caller can set that means "support, indefinitely". That is the difference between a time box and a promise:
 * ROLE-2 requires just-in-time, ≤60-minute, single-tenant, reason-bearing access, and a state machine that cannot express
 * anything else is how the requirement survives a later edit.
 *
 * THE CLOCK IS INJECTED AND REQUIRED. Expiry is evaluated against it on every check, so a session that has expired is
 * refused even if nothing has swept it — and an unavailable clock refuses, because "I cannot tell whether this session is
 * still live" is not a reason to allow it.
 *
 * IMPERSONATION IS NOT A FLAG TO CHECK; IT IS AN OPERATION THAT DOES NOT EXIST. Support sees the redacted diagnostic
 * view, and this module has no function that returns another subject's record — so ROLE-3 is enforced by the absence of
 * the capability rather than by a check somebody must remember.
 */

import type { Clock } from './step-up-policy.ts';

/** The maximum lifetime of a support session (ROLE-2: ≤60 minutes). */
export const MAX_SUPPORT_SESSION_MINUTES = 60;

export type SupportSessionState = 'REQUESTED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED';

/** The states the lifecycle permits. `STANDING` is absent, and the test asserts that absence. */
export const SUPPORT_SESSION_STATES: readonly SupportSessionState[] = Object.freeze(['REQUESTED', 'ACTIVE', 'EXPIRED', 'REVOKED']);

export interface SupportSession {
  readonly sessionId: string;
  /** ONE tenant, fixed at entry: support cannot look across tenants in a session (ROLE-2). */
  readonly tenantId: string;
  readonly actorIdentity: string;
  /** Required and non-empty: an unexplained break-glass session is refused at entry. */
  readonly reason: string;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly state: SupportSessionState;
}

export interface AuditEvent {
  readonly event:
    | 'support.session.requested'
    | 'support.session.entered'
    | 'support.session.exited'
    | 'support.session.expired'
    | 'support.pii_read'
    | 'support.session.refused'
    | 'auth.lockout_escalated';
  readonly actorIdentity: string;
  readonly tenantId: string;
  readonly detail: string;
  readonly at: number;
}

export class SupportAccessError extends Error {
  readonly code: 'SUPPORT_SESSION_REQUIRED' | 'SUPPORT_SESSION_EXPIRED' | 'SUPPORT_REASON_REQUIRED' | 'TENANT_MISMATCH' | 'DEPENDENCY_UNAVAILABLE';

  constructor(code: SupportAccessError['code'], message: string) {
    super(message);
    this.name = 'SupportAccessError';
    this.code = code;
  }
}

/**
 * Open a support session.
 *
 * THE LIFETIME IS CAPPED RATHER THAN VALIDATED: a caller asking for four hours gets sixty minutes, not a refusal and not
 * four hours. A cap is what ROLE-2 states, and a session that silently outlived its request would be the standing access
 * the role prohibits.
 */
export function openSupportSession(input: {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly actorIdentity: string;
  readonly reason: string;
  readonly requestedMinutes?: number;
  readonly clock: Clock;
}): { readonly session: SupportSession; readonly audit: readonly AuditEvent[] } {
  const now = input.clock();
  if (now === undefined) {
    throw new SupportAccessError('DEPENDENCY_UNAVAILABLE', 'the clock is unavailable, so a time box cannot be established');
  }
  if (input.reason.trim().length === 0) {
    throw new SupportAccessError('SUPPORT_REASON_REQUIRED', 'a support session requires a non-empty reason (ROLE-2)');
  }
  const minutes = Math.min(input.requestedMinutes ?? MAX_SUPPORT_SESSION_MINUTES, MAX_SUPPORT_SESSION_MINUTES);
  const session: SupportSession = {
    sessionId: input.sessionId,
    tenantId: input.tenantId,
    actorIdentity: input.actorIdentity,
    reason: input.reason,
    grantedAt: now,
    expiresAt: now + minutes * 60,
    state: 'REQUESTED',
  };
  return {
    session,
    audit: [
      { event: 'support.session.requested', actorIdentity: input.actorIdentity, tenantId: input.tenantId, detail: `reason: ${input.reason}`, at: now },
    ],
  };
}

/** Enter: the step-up and MFA gates run before this, and entry is audited (ROLE-2). */
export function enterSupportSession(session: SupportSession, clock: Clock): { readonly session: SupportSession; readonly audit: AuditEvent } {
  const now = requireNow(clock);
  if (session.expiresAt <= now) {
    throw new SupportAccessError('SUPPORT_SESSION_EXPIRED', `the session expired at ${String(session.expiresAt)}`);
  }
  return {
    session: { ...session, state: 'ACTIVE' },
    audit: { event: 'support.session.entered', actorIdentity: session.actorIdentity, tenantId: session.tenantId, detail: `session ${session.sessionId}`, at: now },
  };
}

function requireNow(clock: Clock): number {
  const now = clock();
  if (now === undefined) {
    throw new SupportAccessError('DEPENDENCY_UNAVAILABLE', 'the clock is unavailable, so the session’s liveness cannot be established');
  }
  return now;
}

/** Whether a session is live at the injected time. Expiry is evaluated here, not by a sweeper that may not have run. */
export function isLive(session: SupportSession, clock: Clock): boolean {
  const now = clock();
  if (now === undefined) return false;
  return session.state === 'ACTIVE' && session.expiresAt > now;
}

/**
 * Authorise a read of PII-class data, appending the audit event ROLE-2 requires for EVERY such read.
 *
 * THE TENANT IS CHECKED AGAINST THE SESSION'S OWN, so a session for tenant A cannot read tenant B even when the caller
 * presents the right session id — and the refusal carries no detail about tenant B.
 */
export function authorisePiiRead(
  session: SupportSession,
  request: { readonly tenantId: string; readonly fieldClass: string },
  clock: Clock,
): AuditEvent {
  const now = requireNow(clock);
  if (!isLive(session, clock)) {
    throw new SupportAccessError('SUPPORT_SESSION_REQUIRED', 'no ACTIVE support session is live for this request (ROLE-2)');
  }
  if (request.tenantId !== session.tenantId) {
    throw new SupportAccessError('TENANT_MISMATCH', 'the session is scoped to one tenant and this request is for another');
  }
  return {
    event: 'support.pii_read',
    actorIdentity: session.actorIdentity,
    tenantId: session.tenantId,
    detail: `field class ${request.fieldClass}`,
    at: now,
  };
}

/** Exit: the session is revoked and the exit is audited. */
export function exitSupportSession(session: SupportSession, clock: Clock): { readonly session: SupportSession; readonly audit: AuditEvent } {
  const now = requireNow(clock);
  return {
    session: { ...session, state: 'REVOKED' },
    audit: { event: 'support.session.exited', actorIdentity: session.actorIdentity, tenantId: session.tenantId, detail: `session ${session.sessionId}`, at: now },
  };
}

/** The redacted diagnostic view support sees, INSTEAD of the subject's record (ROLE-3: no impersonation). */
export interface DiagnosticView {
  readonly subjectRefPresent: boolean;
  readonly displayRef: string | null;
  readonly identifierValues: null;
  readonly note: string;
}

/**
 * The diagnostic view.
 *
 * IT HAS NO FUNCTION THAT RETURNS IDENTIFIER VALUES, and `identifierValues` is typed `null` rather than optional: a
 * caller cannot ask for them because there is nothing to ask. Support sees WHETHER a subject exists and its opaque
 * reference, which is what a diagnostic question needs.
 */
export function diagnosticView(subject: { readonly subjectRef: string; readonly displayRef: string } | undefined): DiagnosticView {
  if (subject === undefined) {
    return {
      subjectRefPresent: false,
      displayRef: null,
      identifierValues: null,
      note: 'no subject with that reference exists in this tenant',
    };
  }
  return {
    subjectRefPresent: true,
    displayRef: subject.displayRef,
    identifierValues: null,
    note: 'diagnostic view: identifier values are not available to SUPPORT, and impersonation is prohibited (ROLE-3)',
  };
}

/**
 * Enumeration inhibition (VG-AUTH-027): the response for a subject that does not exist and the response for one the caller
 * may not see are THE SAME VALUE, so no endpoint confirms whether a named person is a customer.
 */
export const ENUMERATION_NEUTRAL_RESPONSE = Object.freeze({ status: 404, code: 'RESOURCE_NOT_FOUND' });

export function responseForSubjectProbe(exists: boolean, authorised: boolean): { readonly status: number; readonly code: string } {
  // The three cases collapse to one answer: absent, present-but-unauthorised, and present-and-authorised differ only in
  // what an AUTHORISED caller receives, and an unauthorised one cannot tell the first two apart.
  if (!exists || !authorised) return { ...ENUMERATION_NEUTRAL_RESPONSE };
  return { status: 200, code: 'OK' };
}

/** Progressive lockout: escalating delay, then a refusal, with an alert (VG-AUTH-019). */
export interface LockoutPolicy {
  readonly delaysSeconds: readonly number[];
  readonly refusalThreshold: number;
}

export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = Object.freeze({ delaysSeconds: [1, 2, 5, 15, 60], refusalThreshold: 6 });

export interface LockoutDecision {
  readonly allow: boolean;
  /** The delay to apply before answering, in seconds. */
  readonly delaySeconds: number;
  /** The alert the caller emits through the SPEC-007 path (VG-AUTH-019). */
  readonly alert?: AuditEvent;
}

export function lockoutFor(
  actorIdentity: string,
  tenantId: string,
  consecutiveFailures: number,
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
  at = 0,
): LockoutDecision {
  if (consecutiveFailures < policy.refusalThreshold) {
    // ZERO FAILURES MEANS NO DELAY, AND MEASURED: the first version clamped the index with `Math.max(0, n - 1)`, which
    // returned the FIRST delay for zero failures — a one-second penalty for a request that had not failed. Past the end
    // of the ladder the last delay holds rather than dropping back to zero.
    const delaySeconds =
      consecutiveFailures <= 0
        ? 0
        : (policy.delaysSeconds[consecutiveFailures - 1] ??
          policy.delaysSeconds[policy.delaysSeconds.length - 1] ??
          0);
    return { allow: true, delaySeconds };
  }
  return {
    allow: false,
    delaySeconds: policy.delaysSeconds[policy.delaysSeconds.length - 1] ?? 0,
    alert: {
      event: 'auth.lockout_escalated',
      actorIdentity,
      tenantId,
      detail: `${String(consecutiveFailures)} consecutive authorization failures`,
      at,
    },
  };
}

/**
 * ROLE-4: no role may disable, truncate or delete audit. The check is stated here so a caller cannot implement an
 * exception, and it takes the ROLE rather than trusting a caller's intent.
 */
export function assertAuditImmutability(role: string, operation: 'disable' | 'truncate' | 'delete'): void {
  throw new Error(
    `role ${role} attempted to ${operation} audit: SPEC-005 §2 ROLE-4 forbids any role disabling, truncating or deleting the audit stream, and there is no exception to grant`,
  );
}
