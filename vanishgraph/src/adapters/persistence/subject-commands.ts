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
}
