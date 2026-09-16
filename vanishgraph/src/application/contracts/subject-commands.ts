/**
 * Subject creation and update (SPEC-003 §5.1.1, §5.1.4).
 *
 * A SEPARATE PORT FROM `SubjectQueries`, and the separation is the point: that interface documents itself as a
 * READ model ("WHAT DOES NOT BELONG HERE: anything that decides a truth state"), and these two methods WRITE. A
 * write hidden inside a read model is how a handler comes to believe that reading is free of consequence.
 *
 * NOTHING HERE DECIDES A TRUTH STATE. §5.1.1 creates a `ProtectedSubject` and its `AuthorityGrant`; §5.1.4
 * updates display fields. Neither moves a case, an exposure, or anything else, and neither takes a state as
 * input — the routes that own truth states go through the domain's transition commands.
 *
 * THE DOMAIN DECIDES, THIS PORT PERSISTS. `createAuthorityGrant`, `createProtectedSubject` and the
 * `registerSubject` command are called by the adapter, so the invariants they hold — a non-empty scope, an
 * expiry after issue, `AGENT` needing a signed instrument and a linked artifact (VG-AUTHZ-002), a subject that
 * cannot exist without a usable grant (VG-IDENT-001) — are enforced ONCE, in the domain, rather than restated in
 * SQL. A second copy of a rule is a second place for it to drift.
 *
 * THE REFUSALS THE CONTRACT NAMES, AND THE TWO READINGS IT DOES NOT FIX (recorded in ASSUMPTIONS §3.35):
 *
 *   * `403 IDENTITY_LEVEL_INSUFFICIENT` — SPEC-005 §4 maps `IAL2` to "REQUEST_READY and self-service writes",
 *     and creating a subject is the write that makes a subject exist at all. The rule applied is therefore
 *     `heldLevel >= IAL2`, which is the fail-closed reading: §11 item 10 says WHICH level a jurisdiction or
 *     subject class requires is a `PolicyDecision` question, so this route applies the floor the level table
 *     states and claims no more.
 *   * `403 SEPARATION_OF_DUTIES` — SPEC-005 `VG-AUTHZ-016` is "`TENANT_ADMIN` may not approve its own
 *     `AuthorityGrant`". At creation the subject does not exist yet, so "its own" can only mean an operator
 *     registering a subject that is itself: the refusal fires when a `TENANT_ADMIN` submits a `displayRef` equal
 *     to its own `subject_ref` claim. The decisive form of the rule (a grant minted for a subject the admin IS)
 *     belongs to §5.2.1, where the subject id exists and can be compared.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** The four grant kinds of SPEC-005 §3, verbatim. The database enum carries exactly these. */
export const AUTHORITY_KINDS = ['SELF', 'AGENT', 'PARENT_GUARDIAN', 'LEGAL_REPRESENTATIVE'] as const;

export type AuthorityKindName = (typeof AUTHORITY_KINDS)[number];

/** The SPEC-005 §4 identity levels, lowest first. */
export const IDENTITY_LEVELS = ['IAL0', 'IAL1', 'IAL2', 'IAL3'] as const;

export interface SubjectAuthorityInput {
  readonly kind: AuthorityKindName;
  readonly scope: readonly string[];
  /** `null` for a kind that needs none; required for `AGENT`, `PARENT_GUARDIAN`, `LEGAL_REPRESENTATIVE`. */
  readonly evidenceArtifactId: string | null;
  /** Epoch milliseconds. `null` when the request did not carry one, which is refused rather than defaulted. */
  readonly expiresAtMs: number | null;
}

export interface CreateSubjectRequest {
  readonly displayRef: string;
  readonly jurisdiction: string;
  readonly isMinor: boolean;
  readonly authority: SubjectAuthorityInput;
  /** The verified operator (`sub`). Never a `ProtectedSubject` (SPEC-003 §2.4). */
  readonly actorIdentity: string;
  /** The caller's own `subject_ref` claim, if any — the only input the separation-of-duties rule can read. */
  readonly actorSubjectRef: string;
  readonly authLevel: string;
  readonly correlationId: string;
  readonly nowMs: number;
}

/** The §5.1.1 success body. */
export interface CreatedSubject {
  readonly subjectId: string;
  readonly displayRef: string;
  readonly jurisdiction: string;
  readonly isMinor: boolean;
  readonly authorityGrantId: string;
  readonly createdAt: string;
  /** VG-POLICY-004: a minor subject is in the review-required lane from the moment it exists. */
  readonly strictLane: boolean;
}

export type CreateSubjectOutcome =
  | { readonly ok: true; readonly subject: CreatedSubject }
  | { readonly ok: false; readonly reason: 'AUTHORITY_EVIDENCE_REQUIRED' }
  | { readonly ok: false; readonly reason: 'AUTHORITY_WINDOW_INVALID' }
  | { readonly ok: false; readonly reason: 'EVIDENCE_NOT_FOUND' }
  | { readonly ok: false; readonly reason: 'SCHEMA_VALIDATION_FAILED'; readonly field: string }
  | {
      readonly ok: false;
      readonly reason: 'IDENTITY_LEVEL_INSUFFICIENT';
      readonly requiredLevel: string;
      readonly heldLevel: string;
    }
  | { readonly ok: false; readonly reason: 'SEPARATION_OF_DUTIES' };

/** The mutable fields of §5.1.4. `jurisdiction` is absent BY CONSTRUCTION — it is refused, not ignored. */
export interface SubjectPatch {
  readonly displayRef?: string;
  readonly isMinor?: boolean;
  readonly contactPreference?: {
    readonly channel: string;
    readonly contactRefId: string;
  };
}

export interface UpdateSubjectRequest {
  readonly subjectId: string;
  /** From the `If-Match` ETag, which is `<authorityState>:<updatedAtEpochMillis>` (SPEC-003 §2.7). */
  readonly expectedRowVersionMs: number;
  readonly patch: SubjectPatch;
  readonly correlationId: string;
  readonly nowMs: number;
}

/** The §5.1.4 success body: the §5.1.3 DTO's mutable part plus the lane flag. */
export interface UpdatedSubject {
  readonly subjectId: string;
  readonly displayRef: string;
  readonly jurisdiction: string;
  readonly isMinor: boolean;
  readonly strictLane: boolean;
  readonly updatedAt: string;
  readonly contactPreference: { readonly channel: string; readonly contactRefId: string } | null;
}

export type UpdateSubjectOutcome =
  | { readonly ok: true; readonly subject: UpdatedSubject }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' }
  | {
      readonly ok: false;
      readonly reason: 'PRECONDITION_FAILED';
      readonly currentRowVersionMs: number;
      readonly authorityState: string;
    }
  | { readonly ok: false; readonly reason: 'STRICT_LANE_CONFLICT' };

export interface SubjectCommands {
  /** §5.1.1 — create the subject and its authority grant in ONE transaction (VG-IDENT-001). */
  createSubject(tx: TenantTransaction, request: CreateSubjectRequest): Promise<CreateSubjectOutcome>;
  /** §5.1.4 — apply the mutable field subset, guarded by the row version. */
  updateSubject(tx: TenantTransaction, request: UpdateSubjectRequest): Promise<UpdateSubjectOutcome>;
  /** §5.2.1 — mint a further `AuthorityGrant` for an existing subject. */
  mintAuthorityGrant(tx: TenantTransaction, request: MintAuthorityRequest): Promise<MintAuthorityOutcome>;
  /** §5.2.3 — revoke a grant. Revocation takes effect at the next execution-time assertion; it rewrites no history. */
  revokeAuthorityGrant(
    tx: TenantTransaction,
    request: RevokeAuthorityRequest,
  ): Promise<RevokeAuthorityOutcome>;
}

/** The §5.2.1 request. */
export interface MintAuthorityRequest {
  readonly subjectId: string;
  readonly kind: AuthorityKindName;
  readonly scope: readonly string[];
  /** The SPEC-005 §4 token the request asserts, recorded and echoed. */
  readonly identityLevel: string;
  readonly evidenceArtifactId: string | null;
  /** Epoch milliseconds, or `null` when the request omitted it (which is refused, not defaulted). */
  readonly issuedAtMs: number | null;
  readonly expiresAtMs: number | null;
  readonly actorSubjectRef: string;
  readonly authLevel: string;
  readonly correlationId: string;
  readonly nowMs: number;
}

/** The §5.2.1 success body. */
export interface MintedAuthorityGrant {
  readonly authorityGrantId: string;
  readonly subjectId: string;
  readonly kind: string;
  readonly scope: readonly string[];
  readonly identityLevel: string;
  readonly evidenceArtifactId: string | null;
  /** The artifact's digest, so a caller can correlate the grant with the instrument it cites. */
  readonly evidenceDigest: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly validNow: boolean;
  readonly noticeSentAt: string | null;
}

export type MintAuthorityOutcome =
  | { readonly ok: true; readonly grant: MintedAuthorityGrant }
  | { readonly ok: false; readonly reason: 'SUBJECT_NOT_FOUND' }
  | { readonly ok: false; readonly reason: 'AUTHORITY_KIND_UNSUPPORTED' }
  | { readonly ok: false; readonly reason: 'AUTHORITY_EVIDENCE_REQUIRED' }
  | { readonly ok: false; readonly reason: 'AUTHORITY_WINDOW_INVALID' }
  | { readonly ok: false; readonly reason: 'EVIDENCE_NOT_FOUND' }
  | { readonly ok: false; readonly reason: 'SCHEMA_VALIDATION_FAILED'; readonly field: string }
  | {
      readonly ok: false;
      readonly reason: 'IDENTITY_LEVEL_INSUFFICIENT';
      readonly requiredLevel: string;
      readonly heldLevel: string;
    }
  | { readonly ok: false; readonly reason: 'SEPARATION_OF_DUTIES' }
  /**
   * No notification transport exists, so the notice SPEC-005 `VG-AUTHZ-014` requires cannot be sent or recorded.
   *
   * The route answers `503 DEPENDENCY_UNAVAILABLE` naming the transport rather than minting a grant whose required
   * notice never happened — the same shape §5.8.2 uses for a submission with no channel transport. `AGENT` is the
   * only kind this applies to: §5.2.1 makes `noticeSentAt` mandatory for `AGENT` alone.
   */
  | { readonly ok: false; readonly reason: 'NOTICE_TRANSPORT_UNAVAILABLE' };

/** The §5.2.3 request. */
export interface RevokeAuthorityRequest {
  readonly authorityGrantId: string;
  readonly reason: string;
  readonly evidenceArtifactId: string | null;
  readonly note: string | null;
  readonly correlationId: string;
  readonly nowMs: number;
}

export interface RevokedAuthorityGrant {
  readonly authorityGrantId: string;
  readonly revokedAt: string;
  readonly reason: string;
}

export type RevokeAuthorityOutcome =
  | { readonly ok: true; readonly grant: RevokedAuthorityGrant }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' }
  | { readonly ok: false; readonly reason: 'AUTHORITY_ALREADY_REVOKED'; readonly revokedAt: string }
  | { readonly ok: false; readonly reason: 'EVIDENCE_NOT_FOUND' };

/**
 * The SHAPE a revocation reason must have — and deliberately NOT a list of reasons.
 *
 * §5.2.3's example carries `"reason":"SUBJECT_WITHDREW"` and its error list names no "unknown reason" code, so no
 * specification enumerates the vocabulary. Publishing a list here would refuse a reason the contract permits, and
 * enumerating one in the database enum would do the same more permanently; the shape check refuses a typo or a
 * sentence while leaving the vocabulary where it belongs. Recorded in ASSUMPTIONS §3.36.
 */
export const REVOCATION_REASON_SHAPE = /^[A-Z][A-Z0-9_]{2,47}$/;

/** The identity level rank, or `-1` for a token outside SPEC-005 §4. */
export function identityLevelRank(level: string): number {
  return (IDENTITY_LEVELS as readonly string[]).indexOf(level);
}
