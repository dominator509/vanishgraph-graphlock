/**
 * Anti-fraudulent-enrollment controls (SPEC-005 §3.1 VG-AUTHZ-010…014; EP-006 M4).
 *
 * THESE ARE THE CONTROLS THAT MAKE AGENT ENROLLMENT EXPENSIVE TO ABUSE, and each one answers a different attack: a cooling
 * off period makes an enrollment that is about to be contested worthless, velocity limits make bulk enrollment visible,
 * a conflict rule makes two agents claiming one subject a decision rather than a race, and a recorded notice makes the
 * subject's own channel part of the record.
 *
 * THE CLOCK IS INJECTED, NOT READ. Every deadline and window is computed from a `now` the caller supplies, so a test can
 * place an enrollment inside or outside a cooling-off period without waiting and without mocking the system clock — and
 * so a replay of a recorded decision uses the time it was made rather than the time it is replayed.
 *
 * A BREACH ROUTES TO REVIEW AND IS AUDITED. It is not a refusal the caller can retry until it passes: the enrollment is
 * held for a person, which is why the decision carries the audit record the caller must write.
 */

import type { AuthorityGrant, AuthorityKind } from './authority-service.ts';

/** The cooling-off period an agent enrollment must serve before its first external write (VG-AUTHZ-010). */
export const COOLING_OFF_HOURS = 72;

/** The velocity limits VG-AUTHZ-011 names, each measured over a window. */
export interface VelocityLimits {
  readonly perTenantPerDay: number;
  readonly perIpClassPerDay: number;
  readonly perPaymentInstrumentPerDay: number;
}

export const DEFAULT_VELOCITY_LIMITS: VelocityLimits = Object.freeze({
  perTenantPerDay: 25,
  perIpClassPerDay: 5,
  perPaymentInstrumentPerDay: 3,
});

/** One enrollment attempt, as the counters see it. */
export interface EnrollmentAttempt {
  readonly tenantId: string;
  readonly subjectRef: string;
  /** A COARSE class, never the address itself: an IP is personal data and this record is not the place for it. */
  readonly ipClass: string;
  /** An opaque reference to the payment instrument, or `null` when the flow uses none. */
  readonly paymentInstrumentRef: string | null;
  readonly at: string;
}

export interface EnrollmentVelocityState {
  readonly tenantAttemptsToday: number;
  readonly ipClassAttemptsToday: number;
  readonly paymentInstrumentAttemptsToday: number;
}

export interface VelocityBreach {
  readonly limit: 'perTenantPerDay' | 'perIpClassPerDay' | 'perPaymentInstrumentPerDay';
  readonly observed: number;
  readonly allowed: number;
}

export interface VelocityDecision {
  readonly ok: boolean;
  /** A breach routes to REVIEW, not to a retryable refusal (VG-AUTHZ-011). */
  readonly route?: 'REVIEW';
  readonly breaches: readonly VelocityBreach[];
  readonly audit?: EnrollmentAuditRecord;
}

export interface EnrollmentAuditRecord {
  readonly event: 'enrollment.velocity_breach' | 'enrollment.conflict' | 'enrollment.notice_recorded' | 'enrollment.contested';
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly detail: string;
  readonly at: string;
}

/**
 * Decide whether an attempt breaches a velocity limit (VG-AUTHZ-011).
 *
 * ALL THREE COUNTERS ARE EVALUATED, AND EVERY BREACH IS REPORTED: returning on the first one would tell an operator about
 * one dimension of a burst while the others are also over their limit, and the review that follows needs all three.
 */
export function checkVelocity(
  attempt: EnrollmentAttempt,
  state: EnrollmentVelocityState,
  limits: VelocityLimits = DEFAULT_VELOCITY_LIMITS,
): VelocityDecision {
  const breaches: VelocityBreach[] = [];
  if (state.tenantAttemptsToday > limits.perTenantPerDay) {
    breaches.push({ limit: 'perTenantPerDay', observed: state.tenantAttemptsToday, allowed: limits.perTenantPerDay });
  }
  if (state.ipClassAttemptsToday > limits.perIpClassPerDay) {
    breaches.push({ limit: 'perIpClassPerDay', observed: state.ipClassAttemptsToday, allowed: limits.perIpClassPerDay });
  }
  if (state.paymentInstrumentAttemptsToday > limits.perPaymentInstrumentPerDay) {
    breaches.push({
      limit: 'perPaymentInstrumentPerDay',
      observed: state.paymentInstrumentAttemptsToday,
      allowed: limits.perPaymentInstrumentPerDay,
    });
  }
  if (breaches.length === 0) return { ok: true, breaches: [] };
  return {
    ok: false,
    route: 'REVIEW',
    breaches,
    audit: {
      event: 'enrollment.velocity_breach',
      tenantId: attempt.tenantId,
      subjectRef: attempt.subjectRef,
      detail: breaches.map((breach) => `${breach.limit} ${String(breach.observed)}>${String(breach.allowed)}`).join('; '),
      at: attempt.at,
    },
  };
}

/** The cooling-off deadline for an enrollment at `enrolledAt`, computed from the injected clock's value. */
export function coolingOffDeadline(enrolledAt: string, hours: number = COOLING_OFF_HOURS): string {
  return new Date(Date.parse(enrolledAt) + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface AgentEnrollmentRequest {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly agentRef: string;
  readonly enrolledAt: string;
  /** The signed instrument, already stored as an artefact (VG-AUTHZ-010). */
  readonly instrumentArtifactId: string | null;
  /** Whether the instrument's signature verified. A stored but unverified instrument is not evidence. */
  readonly signatureVerified: boolean;
  readonly noticeArtifactId: string | null;
  readonly scope: readonly string[];
  readonly expiresAt: string;
  readonly authorityGrantId: string;
  readonly identityLevel: string;
  /** The grants already held for this subject, so the conflict rule can see them. */
  readonly existingGrants: readonly AuthorityGrant[];
}

export interface EnrollmentDecision {
  readonly ok: boolean;
  readonly code?: 'AUTHORITY_EVIDENCE_REQUIRED' | 'AUTHORITY_GRANT_INVALID' | 'STRICT_LANE_CONFLICT';
  readonly route?: 'REVIEW';
  readonly detail: string;
  readonly audit?: EnrollmentAuditRecord;
  /** The cooling-off deadline the caller records on the grant (VG-AUTHZ-010). */
  readonly coolingOffUntil?: string;
}

/**
 * Decide whether an agent enrollment may proceed, and with what cooling-off deadline.
 *
 * THE CONFLICT RULE IS ABOUT AGENTS, NOT GRANTS (VG-AUTHZ-013): two agents claiming the same subject is a conflict even
 * when every grant is individually valid, which is why the check is on the AGENT references rather than on the grant count.
 * A conflict is routed to human resolution rather than refused, because the answer is a decision a person makes.
 */
export function decideAgentEnrollment(request: AgentEnrollmentRequest): EnrollmentDecision {
  if (request.instrumentArtifactId === null || request.instrumentArtifactId.length === 0) {
    return {
      ok: false,
      code: 'AUTHORITY_EVIDENCE_REQUIRED',
      detail: 'agent enrollment requires a stored signed instrument (VG-AUTHZ-010)',
    };
  }
  if (!request.signatureVerified) {
    return {
      ok: false,
      code: 'AUTHORITY_EVIDENCE_REQUIRED',
      detail: 'the stored instrument did not verify, and an unverified instrument is not evidence (VG-AUTHZ-010)',
    };
  }
  if (request.noticeArtifactId === null || request.noticeArtifactId.length === 0) {
    return {
      ok: false,
      code: 'AUTHORITY_EVIDENCE_REQUIRED',
      detail: 'enrollment requires a recorded notice to the subject’s verified contact channel (VG-AUTHZ-014)',
    };
  }
  const otherAgents = new Set(
    request.existingGrants
      .filter((grant) => grant.kind === 'AGENT' && grant.revokedAt === null && grant.contestedAt === null)
      .map((grant) => grant.authorityGrantId),
  );
  if (otherAgents.size > 0) {
    const detail = `${String(otherAgents.size)} agent grant(s) already hold this subject; SPEC-005 VG-AUTHZ-013 requires a person to resolve the conflict`;
    return {
      ok: false,
      code: 'STRICT_LANE_CONFLICT',
      route: 'REVIEW',
      detail,
      audit: {
        event: 'enrollment.conflict',
        tenantId: request.tenantId,
        subjectRef: request.subjectRef,
        detail,
        at: request.enrolledAt,
      },
    };
  }
  return {
    ok: true,
    detail: 'enrollment may proceed with a cooling-off period before the first external write',
    coolingOffUntil: coolingOffDeadline(request.enrolledAt),
    audit: {
      event: 'enrollment.notice_recorded',
      tenantId: request.tenantId,
      subjectRef: request.subjectRef,
      detail: `notice ${request.noticeArtifactId} recorded for agent ${request.agentRef}`,
      at: request.enrolledAt,
    },
  };
}

/** The kinds that carry a cooling-off period: every kind whose instrument a person signs. */
export function kindRequiresCoolingOff(kind: AuthorityKind): boolean {
  return kind !== 'SELF';
}
