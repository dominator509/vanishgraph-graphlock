/**
 * Controller responses and email threads against PostgreSQL (SPEC-003 §5.9.1–§5.9.3).
 *
 * THE RESPONSE WRITE GOES THROUGH THE DOMAIN COMMAND. `recordControllerResponse` decides T11/T12/T13/T15 from
 * the outcome the response kind implies, and this file supplies the facts it needs — the case's current state,
 * the evidence it cites, and whether the state can accept the transition at all. This file never assigns a truth
 * state the machine did not produce (SM-6).
 *
 * `claimedOutcomeIsObservation` IS NOT STORED. It is the contract's constant `false` (VG-VERIFY-004), returned
 * by the write and reported on every list row; a column could be flipped by a later writer, and the one value
 * this field must never take is `true`.
 *
 * THE CLAIM'S TOKEN GOES IN `claimed_outcome_token` (migration 0025) and NOT in the delivered
 * `controller_response.claimed_outcome`, which is typed `truth_state` and cannot hold `DELETED`, `NOT_DELETED`
 * or `UNSPECIFIED`. That column stays NULL, because a truth state in a claimed-outcome field would assert the
 * collapse VG-VERIFY-004 forbids.
 */

import { randomUUID } from 'node:crypto';

import type {
  ControllerResponseQueries,
  ControllerResponseRow,
  ControllerResponseWriteOutcome,
  ControllerResponseWriteRequest,
  EmailThreadWriteOutcome,
  EmailThreadWriteRequest,
} from '../../application/contracts/controller-response-queries.ts';
import { RESPONSE_KIND_OUTCOME } from '../../application/contracts/controller-response-queries.ts';
import { recordControllerResponse } from '../../domain/commands.ts';
import { createControllerResponse } from '../../domain/entities.ts';
import { DomainError, IllegalTransition } from '../../domain/errors.ts';
import { CaseId, TenantId } from '../../domain/identifiers.ts';
import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import { appendAuditEvents } from './audit-sink.ts';

export class PostgresControllerResponseQueries implements ControllerResponseQueries {
  async recordControllerResponse(
    tx: TenantTransaction,
    request: ControllerResponseWriteRequest,
  ): Promise<ControllerResponseWriteOutcome> {
    const base = await tx.query<{ tenant_id: string; truth_state: string; updated_at: Date }>(
      `SELECT c.tenant_id::text AS tenant_id, c.truth_state::text AS truth_state, c.updated_at
         FROM request_case c WHERE c.id = $1::uuid`,
      [request.caseId],
    );
    const row = base.rows[0];
    if (row === undefined) return { ok: false, reason: 'NOT_FOUND' };
    const rowVersionMs = row.updated_at.getTime();
    if (rowVersionMs !== request.expectedRowVersionMs) {
      return {
        ok: false,
        reason: 'PRECONDITION_FAILED',
        currentRowVersionMs: rowVersionMs,
        truthState: row.truth_state,
      };
    }
    if (request.evidenceArtifactId !== null) {
      const evidence = await tx.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM evidence_artifact e WHERE e.id = $1::uuid) AS present`,
        [request.evidenceArtifactId],
      );
      if (evidence.rows[0]?.present !== true) return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }

    const outcome = RESPONSE_KIND_OUTCOME[request.responseKind] ?? 'ACKNOWLEDGED';
    // §5.9.1 requires a lawful recorded basis for a REFUSAL — the controller's own reason. A
    // NO_RESPONSE_TIMEOUT is ALSO a not-removable outcome, and its basis is the timeout itself, which the SYSTEM
    // records: demanding one from the caller would ask them to explain an absence that is the explanation.
    // MEASURED: an earlier version refused both, so a timeout answered `422 REFUSAL_BASIS_REQUIRED`.
    if (request.responseKind === 'REFUSAL' && (request.refusalBasis === null || request.refusalBasis.length === 0)) {
      return { ok: false, reason: 'REFUSAL_BASIS_REQUIRED' };
    }
    const recordedBasis =
      request.refusalBasis ?? (request.responseKind === 'NO_RESPONSE_TIMEOUT' ? 'NO_RESPONSE_TIMEOUT' : null);

    const tenantId = new TenantId(row.tenant_id);
    const responseId = randomUUID();
    await tx.query(
      `INSERT INTO controller_response
         (id, tenant_id, case_id, kind, body_ref, received_at, claimed_outcome, claimed_outcome_token,
          evidence_artifact_id, refusal_basis)
       VALUES ($1::uuid, current_setting('app.tenant_id', true)::uuid, $2::uuid, $3, $4,
               to_timestamp($5::bigint / 1000.0), NULL, $6, $7::uuid, $8)`,
      [
        responseId,
        request.caseId,
        request.responseKind,
        request.bodyRef,
        Math.trunc(Date.parse(request.receivedAt)),
        request.claimedOutcome,
        request.evidenceArtifactId,
        // A timeout records its own basis when the caller supplied none: the fact IS the basis, and a refusal
        // with no reason is not operable.
        outcome === 'REFUSED' && request.refusalBasis === null ? 'NO_RESPONSE_TIMEOUT' : request.refusalBasis,
      ],
    );

    let result;
    try {
      result = recordControllerResponse(
        { tenantId, correlationId: request.correlationId, nowMs: request.nowMs },
        {
          caseId: request.caseId,
          // THE COMMAND'S `from` IS THE CASE'S CURRENT STATE, and the machine decides whether the pair is legal.
          // SPEC-003 §5.9.1 makes `REQUEST_READY` illegal ("where no action occurred") and SPEC-001 §4.1 has no
          // row from it, so the refusal comes from the table rather than from a list kept here.
          from: row.truth_state as 'REQUEST_SUBMITTED',
          response: createControllerResponse({
            id: responseId,
            tenantId,
            caseId: new CaseId(request.caseId),
            kind: request.responseKind,
            bodyRef: request.bodyRef,
            receivedAtMs: Date.parse(request.receivedAt),
            // The entity's `claimedOutcome` is a TRUTH STATE, and a claim is not one: NULL is the only honest
            // value, and the claim's own token lives in its own column.
            claimedOutcome: null,
          }),
          outcome,
          // A refusal is final only when the controller's basis is a lawful one; T15's guard is
          // `lawfulRefusalFinal`, and a refusal without a recorded basis does not satisfy it.
          lawfulRefusalFinal: recordedBasis !== null,
        },
      );
    } catch (error) {
      if (error instanceof IllegalTransition) {
        // `HUMAN_STEP_REQUIRED` is the contract's code for a demand the CURRENT STATE cannot accept (T12 exists
        // only from REQUEST_SUBMITTED and ACKNOWLEDGED); any other pair is a plain illegal transition.
        if (outcome === 'HUMAN_GATE') return { ok: false, reason: 'HUMAN_STEP_REQUIRED' };
        return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: row.truth_state };
      }
      if (error instanceof DomainError) return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: row.truth_state };
      throw error;
    }

    await tx.query(`UPDATE request_case SET truth_state = $2::truth_state WHERE id = $1::uuid`, [
      request.caseId,
      result.to,
    ]);
    const ids = await appendAuditEvents(
      tx,
      [result.audit],
      { actorKind: 'SERVICE' },
      {
        transitionCode: result.transitionId,
        from: result.from,
        to: result.to,
        evidenceArtifactIds: request.evidenceArtifactId === null ? [] : [request.evidenceArtifactId],
        caseId: request.caseId,
      },
    );

    return {
      ok: true,
      response: {
        controllerResponseId: responseId,
        caseId: request.caseId,
        truthState: result.to,
        transitionCode: result.transitionId,
        transitionId: ids[0] ?? '',
        claimedOutcome: request.claimedOutcome,
        claimedOutcomeIsObservation: false,
        // §5.9.1: an acknowledgement is not a removal, so an independent observation is still owed.
        verificationRequired: result.to === 'ACKNOWLEDGED',
      },
    };
  }

  async listControllerResponses(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<readonly ControllerResponseRow[]> {
    const result = await tx.query<{
      id: string;
      case_id: string;
      kind: string;
      claimed_outcome_token: string | null;
      body_ref: string;
      received_at: Date;
      evidence_artifact_id: string | null;
      refusal_basis: string | null;
    }>(
      `SELECT r.id::text AS id, r.case_id::text AS case_id, r.kind,
              r.claimed_outcome_token, r.body_ref, r.received_at, r.evidence_artifact_id::text AS evidence_artifact_id,
              r.refusal_basis
         FROM controller_response r
        WHERE r.case_id = $1::uuid
        ORDER BY r.received_at DESC, r.id DESC`,
      [caseId],
    );
    return result.rows.map((row) => ({
      controllerResponseId: row.id,
      caseId: row.case_id,
      responseKind: row.kind,
      claimedOutcome: row.claimed_outcome_token,
      claimedOutcomeIsObservation: false,
      bodyRef: row.body_ref,
      receivedAt: row.received_at.toISOString(),
      evidenceArtifactId: row.evidence_artifact_id,
      refusalBasis: row.refusal_basis,
    }));
  }

  async createEmailThread(
    tx: TenantTransaction,
    request: EmailThreadWriteRequest,
  ): Promise<EmailThreadWriteOutcome> {
    const exists = await tx.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM request_case c WHERE c.id = $1::uuid) AS present`,
      [request.caseId],
    );
    if (exists.rows[0]?.present !== true) return { ok: false, reason: 'NOT_FOUND' };

    // A duplicate is a thread that SHARES A MESSAGE ID with an existing one for this case. Stated as an overlap
    // query (`&&`) rather than an equality, because message ids arrive as a SET. The lookup is inside the
    // caller's transaction, which is the strongest guarantee this shape allows: no unique constraint can express
    // "no two rows may share an array element", and the migration records that rather than implying otherwise.
    const duplicate = await tx.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM email_thread t
          WHERE t.case_id = $1::uuid AND t.message_ids && $2::text[]
       ) AS present`,
      [request.caseId, [...request.messageIds]],
    );
    if (duplicate.rows[0]?.present === true) return { ok: false, reason: 'EMAIL_THREAD_DUPLICATE' };

    const threadId = randomUUID();
    await tx.query(
      `INSERT INTO email_thread
         (id, tenant_id, case_id, message_ids, direction, received_at, body_ref, subject_hash)
       VALUES ($1::uuid, current_setting('app.tenant_id', true)::uuid, $2::uuid, $3::text[], $4,
               $5::timestamptz, $6, $7)`,
      [
        threadId,
        request.caseId,
        [...request.messageIds],
        request.direction,
        request.receivedAt,
        request.bodyRef,
        request.subjectHash,
      ],
    );

    return {
      ok: true,
      response: {
        emailThreadId: threadId,
        caseId: request.caseId,
        direction: request.direction,
        messageIds: [...request.messageIds],
        receivedAt: request.receivedAt,
        // See the port: no specification declares a controller-response window, so there is nothing to derive
        // and the API does not hard-code one (§5.9.3's own sentence).
        deadlineDerived: null,
      },
    };
  }

  async caseRowVersion(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<{ readonly rowVersionMs: number; readonly truthState: string } | undefined> {
    const result = await tx.query<{ updated_at: Date; truth_state: string }>(
      `SELECT c.updated_at, c.truth_state::text AS truth_state FROM request_case c WHERE c.id = $1::uuid`,
      [caseId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { rowVersionMs: row.updated_at.getTime(), truthState: row.truth_state };
  }
}
