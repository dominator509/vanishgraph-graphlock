/**
 * The `AuthorityGrant` lifecycle (SPEC-005 §3/§3.1/§4/§10; SPEC-000 VG-AUTHZ-001…003; EP-006 M4).
 *
 * THE BINDING RULES ARE THE POINT, AND EACH IS A SEPARATE FUNCTION BECAUSE EACH ANSWERS A DIFFERENT QUESTION. "May this
 * role write a grant" is the M3 matrix. "Does this grant cover this scope" is `assertScope`. "Is it still valid at the
 * moment of the write" is `verifyAtExecutionTime`. "Is it about this subject" is `assertSubjectBinding`. Folding them
 * together is how one of them gets lost in a refactor — and the one that gets lost is always the one that reads the grant
 * too early.
 *
 * EXECUTION-TIME VERIFICATION READS THE GRANT INSIDE THE TRANSACTION (VG-AUTHZ-005), and the signature says so: the
 * reader is passed in rather than the grant, so a caller CANNOT hand this function a grant it read earlier in the request.
 * A time-shifted-grant test proves the difference — a grant valid at request start and expired at write time must refuse
 * at write time — and that test is impossible to write against an API that only accepts a pre-read grant.
 *
 * THE VOCABULARY DECISION, RECORDED RATHER THAN ASSUMED. SPEC-005 §3 names the kinds `SELF`, `AGENT`, `PARENT_GUARDIAN`,
 * `LEGAL_REPRESENTATIVE`; SPEC-003 §5.2.1 shows the wire enum as `SELF|AGENT|GUARDIAN|DEPENDENT`. The SPEC-005 set is the
 * canonical domain enum here, an explicit two-way mapping exists for the wire enum, and an unmapped wire value is a
 * REFUSAL rather than a default — a daemon that mapped an unknown kind to `SELF` would silently grant a subject's own
 * authority to an agent's request.
 */

export type AuthorityKind = 'SELF' | 'AGENT' | 'PARENT_GUARDIAN' | 'LEGAL_REPRESENTATIVE';

/** The wire enum SPEC-003 §5.2.1 shows. It is NOT the canonical set, and the difference is recorded in the mapping. */
export type WireAuthorityKind = 'SELF' | 'AGENT' | 'GUARDIAN' | 'DEPENDENT';

const WIRE_TO_DOMAIN: Readonly<Record<WireAuthorityKind, AuthorityKind>> = Object.freeze({
  SELF: 'SELF',
  AGENT: 'AGENT',
  GUARDIAN: 'PARENT_GUARDIAN',
  DEPENDENT: 'LEGAL_REPRESENTATIVE',
});

const DOMAIN_TO_WIRE: Readonly<Record<AuthorityKind, WireAuthorityKind>> = Object.freeze({
  SELF: 'SELF',
  AGENT: 'AGENT',
  PARENT_GUARDIAN: 'GUARDIAN',
  LEGAL_REPRESENTATIVE: 'DEPENDENT',
});

/** A refusal whose `code` is the SPEC-003 §8.2 wire code the HTTP layer returns. */
export class AuthorityError extends Error {
  readonly code:
    | 'AUTHORITY_GRANT_INVALID'
    | 'AUTHORITY_SCOPE_VIOLATION'
    | 'AUTHORITY_EXPIRED'
    | 'AUTHORITY_REVOKED'
    | 'AUTHORITY_SUBJECT_MISMATCH'
    | 'AUTHORITY_EVIDENCE_REQUIRED'
    | 'AUTHORITY_KIND_UNSUPPORTED'
    | 'AUTHORITY_ALREADY_REVOKED';

  constructor(code: AuthorityError['code'], message: string) {
    super(message);
    this.name = 'AuthorityError';
    this.code = code;
  }
}

/** The grant as the domain holds it. `expiresAt` and `revokedAt` are the two fields execution time re-reads. */
export interface AuthorityGrant {
  readonly authorityGrantId: string;
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly kind: AuthorityKind;
  readonly scope: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  /** The signed instrument, for the kinds that require one. `null` for `SELF`. */
  readonly evidenceArtifactId: string | null;
  /** The identity level the subject recorded, for `SELF` (SPEC-005 §4). */
  readonly identityLevel: string;
  /** The notice artefact recorded at enrollment (VG-AUTHZ-014). */
  readonly noticeArtifactId: string | null;
  /** The cooling-off deadline before the first external write (VG-AUTHZ-010). `null` when none applies. */
  readonly coolingOffUntil: string | null;
  /** Set when the subject contests the grant (VG-AUTHZ-012): write capability is suspended immediately. */
  readonly contestedAt: string | null;
}

/** The minimum identity level `SELF` requires (SPEC-005 §4: IAL1 is the floor for a self-service grant). */
export const SELF_MINIMUM_IDENTITY_LEVEL = 'IAL1';

/** The kinds that require a signed instrument, and what is missing when it is absent. */
const EVIDENCE_REQUIRED: Readonly<Record<AuthorityKind, string | null>> = Object.freeze({
  SELF: null,
  AGENT: 'a stored signed instrument and a verified agent identity',
  PARENT_GUARDIAN: 'relationship evidence and a minor-status determination',
  LEGAL_REPRESENTATIVE: 'a court instrument, counsel-reviewed before activation',
});

/** Wire to domain. An unmapped value is REFUSED, never defaulted. */
export function kindFromWire(value: string): AuthorityKind {
  const mapped = WIRE_TO_DOMAIN[value as WireAuthorityKind];
  if (mapped === undefined) {
    throw new AuthorityError(
      'AUTHORITY_KIND_UNSUPPORTED',
      `"${value}" is not a wire authority kind: SPEC-003 §5.2.1 declares SELF, AGENT, GUARDIAN and DEPENDENT, and an unmapped value is refused rather than defaulted`,
    );
  }
  return mapped;
}

/** Domain to wire. Total by construction, and the test asserts both directions agree. */
export function kindToWire(kind: AuthorityKind): WireAuthorityKind {
  return DOMAIN_TO_WIRE[kind];
}

/** Whether the grant covers a scope. VG-AUTHZ-004: an action outside `scope[]` is refused even when the grant is valid. */
export function assertScope(grant: AuthorityGrant, requiredScope: string): void {
  if (!grant.scope.includes(requiredScope)) {
    throw new AuthorityError(
      'AUTHORITY_SCOPE_VIOLATION',
      `grant ${grant.authorityGrantId} does not cover ${requiredScope}; it covers ${grant.scope.join(', ') || '(nothing)'}`,
    );
  }
}

/** VG-AUTHZ-008: a grant used for a different subject in the same tenant is refused. */
export function assertSubjectBinding(grant: AuthorityGrant, subjectRef: string): void {
  if (grant.subjectRef !== subjectRef) {
    throw new AuthorityError(
      'AUTHORITY_SUBJECT_MISMATCH',
      `grant ${grant.authorityGrantId} is bound to another subject in this tenant`,
    );
  }
}

/** A reader that takes a grant id and returns the grant, or `undefined`. Supplied per call, never cached. */
export type ReadGrantInTransaction = (authorityGrantId: string) => Promise<AuthorityGrant | undefined>;

/**
 * VG-AUTHZ-005: read the grant INSIDE the write transaction and evaluate expiry and revocation there.
 *
 * THE PARAMETER IS `readGrant`, NOT A GRANT: a caller cannot pass what it read earlier in the request, so "the grant was
 * valid when the request started" is not an argument this function can be given. That is the whole reason for the shape.
 */
export async function verifyAtExecutionTime(
  authorityGrantId: string,
  now: string,
  readGrant: ReadGrantInTransaction,
): Promise<AuthorityGrant> {
  const grant = await readGrant(authorityGrantId);
  if (grant === undefined) {
    throw new AuthorityError('AUTHORITY_GRANT_INVALID', `grant ${authorityGrantId} does not exist at execution time`);
  }
  if (grant.revokedAt !== null) {
    throw new AuthorityError('AUTHORITY_REVOKED', `grant ${grant.authorityGrantId} was revoked at ${grant.revokedAt}`);
  }
  if (grant.expiresAt <= now) {
    throw new AuthorityError('AUTHORITY_EXPIRED', `grant ${grant.authorityGrantId} expired at ${grant.expiresAt}`);
  }
  if (grant.contestedAt !== null) {
    // VG-AUTHZ-012: a contest suspends write capability IMMEDIATELY, and the suspension is not a warning.
    throw new AuthorityError(
      'AUTHORITY_REVOKED',
      `grant ${grant.authorityGrantId} was contested at ${grant.contestedAt}, which suspends its write capability`,
    );
  }
  if (grant.coolingOffUntil !== null && grant.coolingOffUntil > now) {
    throw new AuthorityError(
      'AUTHORITY_GRANT_INVALID',
      `grant ${grant.authorityGrantId} is inside its cooling-off period until ${grant.coolingOffUntil} (VG-AUTHZ-010)`,
    );
  }
  return grant;
}

/**
 * VG-AUTHZ-007: with several grants, the effective scope is the MOST RESTRICTIVE applicable one.
 *
 * THE INTERSECTION, NOT THE UNION, and the direction matters: two grants minted for different purposes do not add up to a
 * third capability nobody granted.
 */
export function effectiveScope(grants: readonly AuthorityGrant[], requiredScope: string): readonly string[] {
  const applicable = grants.filter((grant) => grant.scope.includes(requiredScope));
  if (applicable.length === 0) {
    throw new AuthorityError(
      'AUTHORITY_SCOPE_VIOLATION',
      `no grant covers ${requiredScope}, so the effective scope does not include it`,
    );
  }
  return applicable
    .map((grant) => grant.scope)
    .reduce((narrowest, scope) => scope.filter((candidate) => narrowest.includes(candidate)));
}

/** The evidence a kind requires, or `null` when it requires none. */
export function requiredEvidence(kind: AuthorityKind): string | null {
  return EVIDENCE_REQUIRED[kind];
}

export interface MintInput {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly kind: AuthorityKind;
  readonly scope: readonly string[];
  readonly now: string;
  readonly identityLevel: string;
  readonly evidenceArtifactId: string | null;
  readonly noticeArtifactId: string | null;
  readonly coolingOffUntil: string | null;
  /** The id the store assigns; supplied by the caller so this function stays pure. */
  readonly authorityGrantId: string;
  readonly expiresAt: string;
}

/**
 * Mint a grant, refusing every condition the specification names.
 *
 * NOTHING IS WRITTEN HERE: the function validates and returns the grant the caller stores, so a refusal cannot leave a row
 * behind. `noticeArtifactId` is required for every non-`SELF` kind (VG-AUTHZ-014/VG-AUTH-032), because enrollment without
 * a recorded notice is the defect that requirement exists for.
 */
export function mintGrant(input: MintInput): AuthorityGrant {
  const missing = requiredEvidence(input.kind);
  if (missing !== null && (input.evidenceArtifactId === null || input.evidenceArtifactId.length === 0)) {
    throw new AuthorityError(
      'AUTHORITY_EVIDENCE_REQUIRED',
      `a ${input.kind} grant requires ${missing}; none was recorded, and this is a refusal rather than a warning`,
    );
  }
  if (input.kind === 'SELF' && input.identityLevel < SELF_MINIMUM_IDENTITY_LEVEL) {
    throw new AuthorityError(
      'AUTHORITY_GRANT_INVALID',
      `a SELF grant requires identity level ${SELF_MINIMUM_IDENTITY_LEVEL} or above; the subject records ${input.identityLevel}`,
    );
  }
  if (input.kind !== 'SELF' && (input.noticeArtifactId === null || input.noticeArtifactId.length === 0)) {
    throw new AuthorityError(
      'AUTHORITY_EVIDENCE_REQUIRED',
      `enrolling a ${input.kind} grant requires a recorded notice to the subject’s verified contact channel (VG-AUTHZ-014)`,
    );
  }
  if (input.scope.length === 0) {
    throw new AuthorityError('AUTHORITY_GRANT_INVALID', 'a grant with no scope grants nothing and is refused');
  }
  if (input.expiresAt <= input.now) {
    throw new AuthorityError('AUTHORITY_GRANT_INVALID', `expiresAt ${input.expiresAt} is not after ${input.now}`);
  }
  return {
    authorityGrantId: input.authorityGrantId,
    tenantId: input.tenantId,
    subjectRef: input.subjectRef,
    kind: input.kind,
    scope: [...input.scope],
    issuedAt: input.now,
    expiresAt: input.expiresAt,
    revokedAt: null,
    evidenceArtifactId: input.evidenceArtifactId,
    identityLevel: input.identityLevel,
    noticeArtifactId: input.noticeArtifactId,
    coolingOffUntil: input.coolingOffUntil,
    contestedAt: null,
  };
}

/**
 * Revoke a grant (VG-AUTHZ-006).
 *
 * REVOKING AN ALREADY-REVOKED GRANT IS REFUSED RATHER THAN IDEMPOTENT, because the second call's timestamp would RE-WRITE
 * history: the first revocation is the fact, and a later one would move it. And this function does not touch submitted
 * actions: revocation halts in-flight work before its NEXT external write, and already-submitted actions are never
 * retried and their history is never rewritten (VG-REAPPEAR-002).
 */
export function revokeGrant(grant: AuthorityGrant, now: string): AuthorityGrant {
  if (grant.revokedAt !== null) {
    throw new AuthorityError(
      'AUTHORITY_ALREADY_REVOKED',
      `grant ${grant.authorityGrantId} was already revoked at ${grant.revokedAt}; a second revocation would rewrite history`,
    );
  }
  return { ...grant, revokedAt: now };
}

/** Contest a grant (VG-AUTHZ-012): the subject's own act, and it suspends write capability immediately. */
export function contestGrant(grant: AuthorityGrant, now: string): AuthorityGrant {
  return { ...grant, contestedAt: now };
}
