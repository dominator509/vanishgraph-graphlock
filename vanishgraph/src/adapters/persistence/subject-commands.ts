/**
 * Subject creation and update against PostgreSQL (SPEC-003 §5.1.1, §5.1.4).
 *
 * THE DOMAIN COMMAND IS CALLED, NOT REIMPLEMENTED. `createAuthorityGrant`, `createProtectedSubject` and
 * `registerSubject` hold the invariants VG-IDENT-001 and VG-AUTHZ-002 name, and every one of them throws a
 * `DomainError` this file maps to the contract's refusal rather than to a 500. A validation restated in SQL would
 * be a second copy of a rule, and the second copy is the one that drifts.
 *
 * THE SUBJECT ROW IS INSERTED BEFORE THE GRANT, and a DEFERRED trigger is what makes that order legal: VG-IDENT-001
 * requires a subject to have a usable grant AT COMMIT, so an intermediate state with a subject and no grant is
 * permitted inside the transaction and refused at its end. MEASURED on the §5.6 fixture: a subject whose only grant
 * is revoked cannot be committed at all, which is the schema enforcing the rule rather than a comment describing it.
 *
 * THE UPDATE READS THE ROW `FOR UPDATE`. Two concurrent PATCHes with the same `If-Match` would otherwise both
 * compare against the same version and both write, which is the lost update the precondition exists to prevent.
 */

import { randomUUID } from 'node:crypto';

import type {
  CreateSubjectOutcome,
  CreateSubjectRequest,
  MintAuthorityOutcome,
  MintAuthorityRequest,
  RevokeAuthorityOutcome,
  RevokeAuthorityRequest,
  SubjectCommands,
  SubjectPatch,
  UpdateSubjectOutcome,
  UpdateSubjectRequest,
} from '../../application/contracts/subject-commands.ts';
import { identityLevelRank } from '../../application/contracts/subject-commands.ts';
import { registerSubject } from '../../domain/commands.ts';
import { createAuditEvent, createAuthorityGrant, createProtectedSubject } from '../../domain/entities.ts';
import { DomainError } from '../../domain/errors.ts';
import { SubjectId, TenantId } from '../../domain/identifiers.ts';
import { Jurisdiction } from '../../domain/values.ts';
import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import { appendAuditEvents } from './audit-sink.ts';

/**
 * The level §5.1.1 requires of its caller.
 *
 * SPEC-005 §4 gives `IAL2` the row "REQUEST_READY and self-service writes", and creating a subject is the write
 * that makes a subject exist. This is a FLOOR read off the level table, not a jurisdiction-specific requirement:
 * §11 item 10 puts those in a `PolicyDecision`, which this route does not decide.
 */
const REQUIRED_CREATION_LEVEL = 'IAL2';

/** The state classification §5.1.4 needs: is an automated lane already in flight for this subject? */
function authorityStateSql(subjectColumn: string): string {
  return `CASE
            WHEN EXISTS (
              SELECT 1 FROM authority_grant g
               WHERE g.subject_id = ${subjectColumn} AND g.revoked_at IS NOT NULL
            ) THEN 'REVOKED'
            WHEN EXISTS (
              SELECT 1 FROM authority_grant g
               WHERE g.subject_id = ${subjectColumn} AND g.expires_at <= now()
            ) THEN 'EXPIRED'
            WHEN EXISTS (
              SELECT 1 FROM authority_grant g
               WHERE g.subject_id = ${subjectColumn} AND g.revoked_at IS NULL AND g.expires_at > now()
            ) THEN 'VALID'
            ELSE 'NONE'
          END`;
}

interface SubjectRow {
  id: string;
  display_ref: string;
  jurisdiction: string;
  is_minor: boolean;
  updated_at: Date;
  authority_state: string;
  contact_channel: string | null;
  contact_ref_id: string | null;
}

export class PostgresSubjectCommands implements SubjectCommands {
  async createSubject(tx: TenantTransaction, request: CreateSubjectRequest): Promise<CreateSubjectOutcome> {
    // ---------------------------------------------------------------------------------------------
    // The refusals that need no database, checked in the order the contract lists them.
    // ---------------------------------------------------------------------------------------------
    const held = identityLevelRank(request.authLevel);
    const required = identityLevelRank(REQUIRED_CREATION_LEVEL);
    if (held < required) {
      return {
        ok: false,
        reason: 'IDENTITY_LEVEL_INSUFFICIENT',
        requiredLevel: REQUIRED_CREATION_LEVEL,
        heldLevel: request.authLevel,
      };
    }
    // VG-AUTHZ-016. At creation the subject does not exist, so "the admin's own grant" can only be a subject the
    // admin is registering as itself — the comparison this route can actually make. See the port's doc comment.
    if (
      request.actorSubjectRef.length > 0 &&
      request.actorSubjectRef === request.displayRef &&
      request.authority.kind === 'SELF'
    ) {
      return { ok: false, reason: 'SEPARATION_OF_DUTIES' };
    }
    if (request.authority.kind !== 'SELF' && request.authority.evidenceArtifactId === null) {
      // SPEC-005 §3 requires evidence for AGENT / PARENT_GUARDIAN / LEGAL_REPRESENTATIVE (VG-AUTHZ-002).
      return { ok: false, reason: 'AUTHORITY_EVIDENCE_REQUIRED' };
    }
    if (request.authority.scope.length === 0) {
      // The domain refuses an empty scope ("scope must contain at least one entry"); refusing it here names the
      // FIELD, so the caller is told which part of the body is wrong rather than receiving a generic failure.
      return { ok: false, reason: 'SCHEMA_VALIDATION_FAILED', field: 'authorityGrant.scope' };
    }
    if (request.authority.expiresAtMs === null || request.authority.expiresAtMs <= request.nowMs) {
      return { ok: false, reason: 'AUTHORITY_WINDOW_INVALID' };
    }

    if (request.authority.evidenceArtifactId !== null) {
      const artifact = await tx.query<{ id: string }>(
        `SELECT e.id::text AS id FROM evidence_artifact e WHERE e.id = $1::uuid`,
        [request.authority.evidenceArtifactId],
      );
      if (artifact.rows[0] === undefined) return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }

    const tenantRow = await tx.query<{ tenant_id: string }>(
      `SELECT current_setting('app.tenant_id', true)::text AS tenant_id`,
    );
    const tenantId = new TenantId(tenantRow.rows[0]?.tenant_id ?? '');

    // ---------------------------------------------------------------------------------------------
    // The domain builds the two entities and the command, so every invariant is the domain's.
    // ---------------------------------------------------------------------------------------------
    const subjectId = randomUUID();
    const grantId = randomUUID();
    const issuedAtMs = Math.trunc(request.nowMs);
    let grant;
    let subject;
    try {
      grant = createAuthorityGrant({
        id: grantId,
        tenantId,
        subjectId: new SubjectId(subjectId),
        kind: request.authority.kind,
        scope: request.authority.scope,
        evidenceId: request.authority.evidenceArtifactId,
        issuedAtMs,
        expiresAtMs: Math.trunc(request.authority.expiresAtMs),
        revokedAtMs: null,
        // A SELF grant's evidence IS the completed identity verification, which this request carries as its
        // authenticated level rather than as an artifact. Every other kind was refused above without an artifact.
        signedInstrument: request.authority.kind !== 'SELF',
      });
      subject = createProtectedSubject({
        id: new SubjectId(subjectId),
        tenantId,
        displayRef: request.displayRef,
        // The domain's own value object, so the ISO 3166-2 shape is validated in ONE place — the route checks the
        // same pattern, and if the two ever disagree the domain's is the one that decides.
        jurisdiction: new Jurisdiction(request.jurisdiction),
        isMinor: request.isMinor,
        status: 'ACTIVE',
        authority: grant,
        atMs: issuedAtMs,
      });    } catch (error) {
      if (error instanceof DomainError) {
        // The shapes the domain refuses after the checks above are a displayRef carrying apparent PII (VG-SEC-002)
        // and an expiry not after the issue instant. Reported as a malformed request naming the field, rather than
        // as an authority-window failure for a display-ref defect — MEASURED correction: the first version of this
        // branch returned AUTHORITY_WINDOW_INVALID for BOTH, which would have told a caller their dates were wrong
        // when their label was.
        return {
          ok: false,
          reason: 'SCHEMA_VALIDATION_FAILED',
          field: error.message.includes('expiresAt') ? 'authorityGrant.expiresAt' : 'displayRef',
        };
      }
      throw error;
    }
    const result = registerSubject(
      { tenantId, correlationId: request.correlationId, nowMs: issuedAtMs },
      { subject, grant },
    );

    const created = await tx.query<{ created_at: Date }>(
      `INSERT INTO protected_subject
         (id, tenant_id, display_ref, jurisdiction, is_minor, status)
       VALUES ($1::uuid, current_setting('app.tenant_id', true)::uuid, $2, $3, $4, 'ACTIVE')
       RETURNING created_at`,
      [subjectId, request.displayRef, request.jurisdiction, request.isMinor],
    );
    await tx.query(
      `INSERT INTO authority_grant
         (id, tenant_id, subject_id, kind, scope, evidence_id, issued_at, expires_at, revoked_at, signed_instrument)
       VALUES ($1::uuid, current_setting('app.tenant_id', true)::uuid, $2::uuid, $3::authority_kind, $4::text[],
               $5::uuid, to_timestamp($6::bigint / 1000.0), to_timestamp($7::bigint / 1000.0), NULL, $8)`,
      [
        grantId,
        subjectId,
        request.authority.kind,
        [...request.authority.scope],
        request.authority.evidenceArtifactId,
        issuedAtMs,
        Math.trunc(request.authority.expiresAtMs),
        request.authority.kind !== 'SELF',
      ],
    );
    await appendAuditEvents(tx, [result.audit], { actorKind: 'SERVICE' });

    return {
      ok: true,
      subject: {
        subjectId,
        displayRef: request.displayRef,
        jurisdiction: request.jurisdiction,
        isMinor: request.isMinor,
        authorityGrantId: grantId,
        createdAt: (created.rows[0]?.created_at ?? new Date(issuedAtMs)).toISOString(),
        // VG-POLICY-004: a minor subject is in the review-required lane from creation.
        strictLane: request.isMinor,
      },
    };
  }

  async updateSubject(tx: TenantTransaction, request: UpdateSubjectRequest): Promise<UpdateSubjectOutcome> {
    // FOR UPDATE: the version read and the write must be one atomic step, or two callers holding the same ETag
    // both pass the comparison and the second overwrites the first.
    const current = await tx.query<SubjectRow>(
      `SELECT s.id::text AS id, s.display_ref, s.jurisdiction, s.is_minor, s.updated_at,
              ${authorityStateSql('s.id')} AS authority_state,
              s.contact_channel, s.contact_ref_id
         FROM protected_subject s
        WHERE s.id = $1::uuid
          FOR UPDATE`,
      [request.subjectId],
    );
    const row = current.rows[0];
    if (row === undefined) return { ok: false, reason: 'NOT_FOUND' };

    const rowVersionMs = row.updated_at.getTime();
    if (rowVersionMs !== request.expectedRowVersionMs) {
      return {
        ok: false,
        reason: 'PRECONDITION_FAILED',
        currentRowVersionMs: rowVersionMs,
        authorityState: row.authority_state,
      };
    }

    const patch: SubjectPatch = request.patch;
    // VG-POLICY-004 / §5.1.4: moving a subject INTO the review-required lane is refused while an automated lane is
    // already in flight, because the work already dispatched cannot be recalled by a flag. MEASURED definition of
    // "in flight": a case of this subject at REQUEST_SUBMITTED or ACKNOWLEDGED — past the point where a channel was
    // addressed and before an outcome is recorded.
    if (patch.isMinor === true && row.is_minor === false) {
      const inFlight = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM request_case c
          WHERE c.subject_id = $1::uuid
            AND c.truth_state IN ('REQUEST_SUBMITTED', 'ACKNOWLEDGED')`,
        [request.subjectId],
      );
      if (Number(inFlight.rows[0]?.n ?? '0') > 0) return { ok: false, reason: 'STRICT_LANE_CONFLICT' };
    }

    const displayRef = patch.displayRef ?? row.display_ref;
    const isMinor = patch.isMinor ?? row.is_minor;
    const contactChannel = patch.contactPreference?.channel ?? row.contact_channel;
    const contactRefId = patch.contactPreference?.contactRefId ?? row.contact_ref_id;

    let updated: { updated_at: Date } | undefined;
    try {
      const result = await tx.query<{ updated_at: Date }>(
        `UPDATE protected_subject
            SET display_ref = $2, is_minor = $3, contact_channel = $4, contact_ref_id = $5, updated_at = now()
          WHERE id = $1::uuid
        RETURNING updated_at`,
        [request.subjectId, displayRef, isMinor, contactChannel, contactRefId],
      );
      updated = result.rows[0];
    } catch (error) {
      if (error instanceof DomainError) return { ok: false, reason: 'NOT_FOUND' };
      throw error;
    }
    if (updated === undefined) return { ok: false, reason: 'NOT_FOUND' };

    // The update carries NO transition: §5.1.4 changes display fields, and an audit row that claimed a state move
    // would be a state move. The event is built by the domain's own factory, so the payload rules (opaque scalars,
    // no apparent PII — VG-SEC-002) are the domain's and not restated here.
    const tenantNow = await tx.query<{ tenant_id: string }>(
      `SELECT current_setting('app.tenant_id', true)::text AS tenant_id`,
    );
    await appendAuditEvents(
      tx,
      [
        createAuditEvent({
          id: randomUUID(),
          tenantId: new TenantId(tenantNow.rows[0]?.tenant_id ?? ''),
          // The operator's own identifier, which this port does not receive: see the note in ASSUMPTIONS §3.35.
          // `SERVICE` is the honest actor KIND for a request whose human identity the command layer does not
          // carry, and the metadata below records it as a service append rather than inventing a human.
          actor: 'service:subjects.write',
          action: 'UpdateProtectedSubject',
          targetKind: 'ProtectedSubject',
          targetId: request.subjectId,
          correlationId: request.correlationId,
          atMs: request.nowMs,
          payload: {
            // The FIELD NAMES that changed, never their values: a contact reference is opaque but a display ref is
            // a caller-chosen label, and an audit payload carries identifiers only.
            fields: Object.keys(patch).sort().join(','),
            strictLane: isMinor,
          },
        }),
      ],
      { actorKind: 'SERVICE' },
    );

    return {
      ok: true,
      subject: {
        subjectId: request.subjectId,
        displayRef,
        jurisdiction: row.jurisdiction,
        isMinor,
        strictLane: isMinor,
        updatedAt: updated.updated_at.toISOString(),
        contactPreference:
          contactChannel === null || contactRefId === null
            ? null
            : { channel: contactChannel, contactRefId },
      },
    };
  }

  async mintAuthorityGrant(tx: TenantTransaction, request: MintAuthorityRequest): Promise<MintAuthorityOutcome> {
    // THE NOTICE IS CHECKED FIRST, because it is the one refusal that is about the REPOSITORY rather than the
    // request: SPEC-005 VG-AUTHZ-014 requires notice to the subject's verified contact channel on agent enrollment
    // and §5.2.1 makes `noticeSentAt` mandatory in the response, while no notification transport exists here.
    // Minting the grant anyway would create authority whose required notice never happened, which is precisely the
    // state a compliance record must not contain.
    if (request.kind === 'AGENT') return { ok: false, reason: 'NOTICE_TRANSPORT_UNAVAILABLE' };

    const held = identityLevelRank(request.authLevel);
    const asserted = identityLevelRank(request.identityLevel);
    if (asserted < 0) return { ok: false, reason: 'SCHEMA_VALIDATION_FAILED', field: 'identityLevel' };
    // A caller may not assert a verification level it does not itself hold — the same floor §5.1.1 applies, and the
    // only reading of IDENTITY_LEVEL_INSUFFICIENT this node can evidence (ASSUMPTIONS §3.36).
    if (held < asserted) {
      return {
        ok: false,
        reason: 'IDENTITY_LEVEL_INSUFFICIENT',
        requiredLevel: request.identityLevel,
        heldLevel: request.authLevel,
      };
    }
    // VG-AUTHZ-016 AT THE MOMENT IT IS DECISIVE: the subject exists here, so a TENANT_ADMIN minting a grant for the
    // subject it IS can be compared directly — the check §5.1.1 could only approximate.
    if (request.actorSubjectRef.length > 0 && request.actorSubjectRef === request.subjectId) {
      return { ok: false, reason: 'SEPARATION_OF_DUTIES' };
    }
    if (request.kind !== 'SELF' && request.evidenceArtifactId === null) {
      return { ok: false, reason: 'AUTHORITY_EVIDENCE_REQUIRED' };
    }
    if (request.scope.length === 0) {
      return { ok: false, reason: 'SCHEMA_VALIDATION_FAILED', field: 'scope' };
    }
    const issuedAtMs = request.issuedAtMs ?? Math.trunc(request.nowMs);
    if (request.expiresAtMs === null || request.expiresAtMs <= issuedAtMs || request.expiresAtMs <= request.nowMs) {
      // §5.2.1's own wording: "expiresAt ≤ issuedAt or already past".
      return { ok: false, reason: 'AUTHORITY_WINDOW_INVALID' };
    }

    const subject = await tx.query<{ id: string }>(
      `SELECT s.id::text AS id FROM protected_subject s WHERE s.id = $1::uuid`,
      [request.subjectId],
    );
    if (subject.rows[0] === undefined) return { ok: false, reason: 'SUBJECT_NOT_FOUND' };

    let evidenceDigest: string | null = null;
    if (request.evidenceArtifactId !== null) {
      const artifact = await tx.query<{ digest: string }>(
        `SELECT e.digest::text AS digest FROM evidence_artifact e WHERE e.id = $1::uuid`,
        [request.evidenceArtifactId],
      );
      const row = artifact.rows[0];
      if (row === undefined) return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
      evidenceDigest = row.digest;
    }

    const tenantRow = await tx.query<{ tenant_id: string }>(
      `SELECT current_setting('app.tenant_id', true)::text AS tenant_id`,
    );
    const tenantId = new TenantId(tenantRow.rows[0]?.tenant_id ?? '');
    const grantId = randomUUID();
    // The domain builds the grant first, so its invariants (non-empty scope, expiry after issue, AGENT needing an
    // instrument) are enforced before any row exists.
    let grant;
    try {
      grant = createAuthorityGrant({
        id: grantId,
        tenantId,
        subjectId: new SubjectId(request.subjectId),
        kind: request.kind,
        scope: request.scope,
        evidenceId: request.evidenceArtifactId,
        issuedAtMs: Math.trunc(issuedAtMs),
        expiresAtMs: Math.trunc(request.expiresAtMs),
        revokedAtMs: null,
        signedInstrument: request.kind !== 'SELF',
      });
    } catch (error) {
      if (error instanceof DomainError) {
        return { ok: false, reason: 'SCHEMA_VALIDATION_FAILED', field: 'scope' };
      }
      throw error;
    }

    await tx.query(
      `INSERT INTO authority_grant
         (id, tenant_id, subject_id, kind, scope, evidence_id, issued_at, expires_at, revoked_at,
          signed_instrument, identity_level, notice_sent_at)
       VALUES ($1::uuid, current_setting('app.tenant_id', true)::uuid, $2::uuid, $3::authority_kind, $4::text[],
               $5::uuid, to_timestamp($6::bigint / 1000.0), to_timestamp($7::bigint / 1000.0), NULL, $8, $9, NULL)`,
      [
        grant.id,
        request.subjectId,
        request.kind,
        [...grant.scope],
        request.evidenceArtifactId,
        Math.trunc(issuedAtMs),
        Math.trunc(request.expiresAtMs),
        request.kind !== 'SELF',
        request.identityLevel,
      ],
    );
    await appendAuditEvents(
      tx,
      [
        createAuditEvent({
          id: randomUUID(),
          tenantId,
          actor: 'service:authority.write',
          action: 'MintAuthorityGrant',
          targetKind: 'AuthorityGrant',
          targetId: grantId,
          correlationId: request.correlationId,
          atMs: request.nowMs,
          payload: {
            subjectId: request.subjectId,
            kind: request.kind,
            identityLevel: request.identityLevel,
            // The ARTIFACT ID, never its digest or content: an audit payload carries opaque identifiers only.
            evidenceArtifactId: request.evidenceArtifactId,
          },
        }),
      ],
      { actorKind: 'SERVICE' },
    );

    return {
      ok: true,
      grant: {
        authorityGrantId: grantId,
        subjectId: request.subjectId,
        kind: request.kind,
        scope: [...grant.scope],
        identityLevel: request.identityLevel,
        evidenceArtifactId: request.evidenceArtifactId,
        evidenceDigest,
        issuedAt: new Date(Math.trunc(issuedAtMs)).toISOString(),
        expiresAt: new Date(Math.trunc(request.expiresAtMs)).toISOString(),
        revokedAt: null,
        validNow: true,
        // ALWAYS null, and that is the honest value: no notice was sent, because none can be. The route refuses
        // AGENT before reaching here, so this field is null on every kind that has no notice requirement.
        noticeSentAt: null,
      },
    };
  }

  async revokeAuthorityGrant(
    tx: TenantTransaction,
    request: RevokeAuthorityRequest,
  ): Promise<RevokeAuthorityOutcome> {
    // FOR UPDATE: two concurrent revocations must not both read "not revoked" and both write a revocation with a
    // different instant — §5.2.3's 409 exists because the FIRST revocation is the one that took effect.
    const current = await tx.query<{ id: string; revoked_at: Date | null }>(
      `SELECT g.id::text AS id, g.revoked_at
         FROM authority_grant g
        WHERE g.id = $1::uuid
          FOR UPDATE`,
      [request.authorityGrantId],
    );
    const row = current.rows[0];
    if (row === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (row.revoked_at !== null) {
      return { ok: false, reason: 'AUTHORITY_ALREADY_REVOKED', revokedAt: row.revoked_at.toISOString() };
    }
    if (request.evidenceArtifactId !== null) {
      const artifact = await tx.query<{ id: string }>(
        `SELECT e.id::text AS id FROM evidence_artifact e WHERE e.id = $1::uuid`,
        [request.evidenceArtifactId],
      );
      if (artifact.rows[0] === undefined) return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }

    const updated = await tx.query<{ revoked_at: Date }>(
      `UPDATE authority_grant SET revoked_at = now() WHERE id = $1::uuid RETURNING revoked_at`,
      [request.authorityGrantId],
    );
    const revokedAt = updated.rows[0]?.revoked_at;
    if (revokedAt === undefined) return { ok: false, reason: 'NOT_FOUND' };

    const tenantRow = await tx.query<{ tenant_id: string }>(
      `SELECT current_setting('app.tenant_id', true)::text AS tenant_id`,
    );
    // NO TRANSITION and no rewrite: §5.2.3 states that revocation "never rewrites history: existing ExternalAction
    // rows and their evidence are retained (VG-REAPPEAR-002)", and it takes effect at the next execution-time
    // assertion rather than by moving any state here.
    await appendAuditEvents(
      tx,
      [
        createAuditEvent({
          id: randomUUID(),
          tenantId: new TenantId(tenantRow.rows[0]?.tenant_id ?? ''),
          actor: 'service:authority.write',
          action: 'RevokeAuthorityGrant',
          targetKind: 'AuthorityGrant',
          targetId: request.authorityGrantId,
          correlationId: request.correlationId,
          atMs: request.nowMs,
          payload: {
            reason: request.reason,
            evidenceArtifactId: request.evidenceArtifactId,
          },
        }),
      ],
      { actorKind: 'SERVICE' },
    );

    return {
      ok: true,
      grant: {
        authorityGrantId: request.authorityGrantId,
        revokedAt: revokedAt.toISOString(),
        reason: request.reason,
      },
    };
  }
}
