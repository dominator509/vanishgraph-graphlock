/**
 * The PostgreSQL observation and reappearance models (SPEC-003 §5.10.1–§5.10.3, §5.11.1–§5.11.3).
 *
 * Implements `ObservationQueries` from the application layer. The DTO types come from the port, so a handler
 * that imports them never acquires a dependency on this file.
 *
 * THE TWO WRITES GO THROUGH THE DOMAIN COMMANDS. §5.10.1 drives T14 through `recordVerification`, and §5.11.1
 * drives T17/T20 through `detectReappearance`; both are guard-evaluated transitions, and SPEC-001 §4.3 SM-6
 * forbids assigning a truth state anywhere but inside the machine. This file loads the facts the commands need
 * — the case's state, the recipe's verification method, the action's instant and actor, the exposure's prior
 * removal event — and writes exactly what the commands returned.
 *
 * THE ACTION'S INSTANT AND ACTOR COME FROM THE AUDIT SPINE, not from the request. §5.10.1's independence and
 * window guards are about the ACTING path: the request supplies the observer's identity and the acting PATH,
 * and this file reads the actor and instant of the case's T8 transition — the row that recorded the external
 * effect — so "the acting path cannot verify itself" (VG-VERIFY-001) is checked against what happened rather
 * than against what the caller says happened.
 *
 * TENANT SCOPING IS NOT DONE HERE: every statement relies on RLS, and every table carries FORCE RLS. One
 * consequence is deliberate and worth naming: `evidence_artifact` is read for its id only, and RLS means a
 * reference to another tenant's artifact simply does not resolve — so a cross-tenant citation reads as an
 * absence rather than as a foreign row.
 */

import { randomUUID as cryptoRandom } from 'node:crypto';

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import type {
  ListReappearancesParams,
  ObservationQueries,
  ReappearanceRow,
  ReappearanceWriteOutcome,
  ReappearanceWriteRequest,
  VerificationObservationRow,
  VerificationWriteOutcome,
  VerificationWriteRequest,
  VerificationWriteResponse,
} from '../../application/contracts/observation-queries.ts';
import {
  API_TO_FINDING,
  FINDING_TO_API,
  REENTRY_RULES,
  RE_ENTRY_STATE_SQL,
} from '../../application/contracts/observation-queries.ts';
import { detectReappearance, recordVerification } from '../../domain/commands.ts';
import { createVerificationObservation } from '../../domain/entities.ts';
import { DomainError } from '../../domain/errors.ts';
import { CaseId, EvidenceId, TenantId } from '../../domain/identifiers.ts';
import { ObservationWindow } from '../../domain/values.ts';
import { appendAuditEvents } from './audit-sink.ts';

/**
 * Translate a stored finding into the API's token, refusing an unmapped value.
 *
 * A PASSTHROUGH WOULD BE WORSE THAN A REFUSAL: the API's write route (§5.10.1) accepts only
 * `RECORD_ABSENT|RECORD_PRESENT|INDETERMINATE`, so echoing a stored `PRESENT` would put a token on the wire
 * that this same API cannot accept back. An unmapped value therefore fails loudly here rather than confusing a
 * client, and `tests/contract/observation-routes.test.ts` asserts the mapping is total over the column's
 * declared set so a new token fails a test rather than a request.
 */
function toApiFinding(stored: string): string {
  const mapped = FINDING_TO_API[stored];
  if (mapped === undefined) {
    throw new Error(
      `unmapped stored finding ${JSON.stringify(stored)}; FINDING_TO_API must cover the column's CHECK`,
    );
  }
  return mapped;
}

interface RawObservationRow {
  id: string;
  case_id: string;
  method: string;
  observed_at: Date;
  actor_identity: string;
  acting_identity: string;
  finding: string;
  evidence_id: string;
  acting_path_id: string | null;
  observation_path_id: string | null;
}

function toObservationRow(row: RawObservationRow): VerificationObservationRow {
  return {
    verificationObservationId: row.id,
    caseId: row.case_id,
    method: row.method,
    observedAt: row.observed_at.toISOString(),
    actorIdentity: row.actor_identity,
    actingIdentity: row.acting_identity,
    finding: toApiFinding(row.finding),
    evidenceArtifactId: row.evidence_id,
    independence: {
      actingPathId: row.acting_path_id,
      observationPathId: row.observation_path_id,
      // BOTH PATHS MUST BE PRESENT to attest distinctness. A row from before migration 0018 has neither, and
      // reporting `true` for it would attest an independence nobody recorded — which is exactly the
      // removal-theater failure VG-VERIFY-001 exists to prevent.
      distinct:
        row.acting_path_id !== null &&
        row.observation_path_id !== null &&
        row.acting_path_id !== row.observation_path_id,
      // COMPUTED, not hard-coded, even though `CHECK (actor_identity <> acting_identity)` makes it true for
      // every storable row. A constant would be a claim about the schema; this is a claim about the row.
      actorDistinct: row.actor_identity !== row.acting_identity,
    },
  };
}

interface RawReappearanceRow {
  id: string;
  exposure_id: string;
  prior_removed_event_id: string;
  observed_at: Date;
  evidence_id: string;
  observation_method: string | null;
  truth_state: string;
}

function toReappearanceRow(row: RawReappearanceRow): ReappearanceRow {
  return {
    reappearanceId: row.id,
    exposureId: row.exposure_id,
    priorRemovedEventId: row.prior_removed_event_id,
    observedAt: row.observed_at.toISOString(),
    evidenceArtifactId: row.evidence_id,
    observationMethod: row.observation_method,
    // The EXPOSURE's state, taken verbatim. `truthState` is never renamed, localised or collapsed (§7.3), and
    // it is read from the exposure rather than inferred from this row because a reappearance is a fact about
    // the past while the truth state is the exposure's present.
    exposureTruthState: row.truth_state,
    reentry: REENTRY_RULES,
  };
}

/**
 * The reappearance projection.
 *
 * `INNER JOIN exposure` because every reappearance is OF an exposure: `exposure_id` is NOT NULL with a
 * foreign key, so a missing exposure would mean the constraint had been dropped. The join also supplies the
 * truth state §5.11.2's `reEntryState` filter partitions on.
 */
const REAPPEARANCE_PROJECTION = `
  r.id::text                     AS id,
  r.exposure_id::text            AS exposure_id,
  r.prior_removed_event_id::text AS prior_removed_event_id,
  r.observed_at                  AS observed_at,
  r.evidence_id::text            AS evidence_id,
  r.observation_method           AS observation_method,
  e.truth_state::text            AS truth_state
`;

export class PostgresObservationQueries implements ObservationQueries {
  async caseExists(tx: TenantTransaction, caseId: string): Promise<boolean> {
    const result = await tx.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM request_case c WHERE c.id = $1::uuid',
      [caseId],
    );
    return result.rows[0]?.n !== '0';
  }

  async exposureExists(tx: TenantTransaction, exposureId: string): Promise<boolean> {
    const result = await tx.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM exposure e WHERE e.id = $1::uuid',
      [exposureId],
    );
    return result.rows[0]?.n !== '0';
  }

  async listVerificationObservations(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<readonly VerificationObservationRow[]> {
    // `evidence_id` is rendered from the FK column rather than joined: the id is all the DTO reports, and a
    // join to `evidence_artifact` would fetch columns no caller receives.
    const result = await tx.query<RawObservationRow>(
      `SELECT v.id::text AS id, v.case_id::text AS case_id, v.method, v.observed_at,
              v.actor_identity, v.acting_identity, v.finding, v.evidence_id::text AS evidence_id,
              v.acting_path_id, v.observation_path_id
         FROM verification_observation v
        WHERE v.case_id = $1::uuid
        ORDER BY v.observed_at DESC, v.id DESC`,
      [caseId],
    );
    return result.rows.map(toObservationRow);
  }

  async getVerificationObservation(
    tx: TenantTransaction,
    verificationObservationId: string,
  ): Promise<VerificationObservationRow | undefined> {
    const result = await tx.query<RawObservationRow>(
      `SELECT v.id::text AS id, v.case_id::text AS case_id, v.method, v.observed_at,
              v.actor_identity, v.acting_identity, v.finding, v.evidence_id::text AS evidence_id,
              v.acting_path_id, v.observation_path_id
         FROM verification_observation v
        WHERE v.id = $1::uuid`,
      [verificationObservationId],
    );
    const row = result.rows[0];
    // Absent and another tenant's observation are INDISTINGUISHABLE by construction: RLS means another
    // tenant's row is not returned, so both reach this branch and produce one 404 body (SPEC-006 H-9).
    return row === undefined ? undefined : toObservationRow(row);
  }

  async listReappearances(
    tx: TenantTransaction,
    params: ListReappearancesParams,
  ): Promise<readonly ReappearanceRow[]> {
    // `observedAt` is the only sort field §5.11.2 declares, so only the DIRECTION varies. The field token is
    // still parsed and discarded rather than ignored, so a caller sending `sort=createdAt:asc` is refused by
    // the query parser before reaching here (`strict.ts` checks it against the declared allowlist).
    const [, direction = 'desc'] = params.sort.split(':');
    const comparison = direction === 'asc' ? '>' : '<';
    const order = direction === 'asc' ? 'ASC' : 'DESC';

    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };

    const where: string[] = [
      `r.observed_at >= to_timestamp(${bind(params.filters.fromMs)}::bigint / 1000.0)`,
      `r.observed_at < to_timestamp(${bind(params.filters.toMs)}::bigint / 1000.0)`,
    ];
    // `subjectId` filters through the EXPOSURE, which is where the subject link lives: `reappearance` carries
    // `exposure_id` and the exposure carries `subject_id`, so the filter is a join condition rather than a
    // column on this table.
    if (params.filters.subjectId !== undefined) {
      where.push(`e.subject_id = ${bind(params.filters.subjectId)}::uuid`);
    }
    if (params.filters.sourceId !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM source_record sr WHERE sr.id = e.source_record_id AND sr.source_id = ${bind(params.filters.sourceId)}::uuid)`,
      );
    }
    if (params.filters.reEntryState !== undefined) {
      const states =
        typeof params.filters.reEntryState === 'string' ? [params.filters.reEntryState] : params.filters.reEntryState;
      // Each token contributes its own predicate, OR-ed together. The predicates come from the DECLARED
      // mapping in the port, so the filter and the meaning of the three tokens have one definition.
      const predicates = [...states].map((state) => RE_ENTRY_STATE_SQL[state] ?? 'false');
      where.push(`(${predicates.join(' OR ')})`);
    }
    if (params.after !== undefined) {
      // MEASURED DEFECT this fixes, and it is a property of the DRIVER rather than of this query: `pg` returns a
      // `timestamptz` as a JS `Date`, which has MILLISECOND precision, while PostgreSQL stores MICROSECONDS. A
      // cursor minted from a row at `…:00.123456` therefore carried `…:00.123Z`, and the next page's predicate
      // `observed_at > '…:00.123'` was TRUE for the very row that minted it — the row came back TWICE, and at a
      // different boundary the same mismatch would SKIP one. Found by the pagination walk in
      // `tests/db/observation-reads.test.ts`, which is why that test asserts each row is seen exactly once
      // rather than merely that each page is non-empty.
      //
      // The fix truncates BOTH sides to milliseconds, and the ORDER BY is truncated the same way so ordering and
      // pagination agree — if they disagreed, a row could be ordered into one page and filtered out of the next.
      // Rows inside one millisecond are separated by the id tiebreaker, which is what it is for.
      where.push(
        `(date_trunc('milliseconds', r.observed_at), r.id::text) ${comparison} (${bind(params.after.sortValue)}::timestamptz, ${bind(params.after.id)})`,
      );
    }

    const limitParam = bind(params.limit + 1);
    const result = await tx.query<RawReappearanceRow>(
      `SELECT ${REAPPEARANCE_PROJECTION}
         FROM reappearance r
         JOIN exposure e ON e.id = r.exposure_id
        WHERE ${where.join(' AND ')}
        ORDER BY date_trunc('milliseconds', r.observed_at) ${order}, r.id ${order}
        LIMIT ${limitParam}`,
      values,
    );
    return result.rows.map(toReappearanceRow);
  }

  async listReappearancesForExposure(
    tx: TenantTransaction,
    exposureId: string,
  ): Promise<readonly ReappearanceRow[]> {
    // OLDEST FIRST, as §5.11.3 requires: this is a HISTORY, and a history read newest-first makes a client
    // reverse it to answer "what happened, in order".
    const result = await tx.query<RawReappearanceRow>(
      `SELECT ${REAPPEARANCE_PROJECTION}
         FROM reappearance r
         JOIN exposure e ON e.id = r.exposure_id
        WHERE r.exposure_id = $1::uuid
        ORDER BY r.observed_at ASC, r.id ASC`,
      [exposureId],
    );
    return result.rows.map(toReappearanceRow);
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

  async exposureRowVersion(
    tx: TenantTransaction,
    exposureId: string,
  ): Promise<{ readonly rowVersionMs: number; readonly truthState: string } | undefined> {
    const result = await tx.query<{ updated_at: Date; truth_state: string }>(
      `SELECT e.updated_at, e.truth_state::text AS truth_state FROM exposure e WHERE e.id = $1::uuid`,
      [exposureId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { rowVersionMs: row.updated_at.getTime(), truthState: row.truth_state };
  }

  // -----------------------------------------------------------------------------------------------
  // §5.10.1 — an independent re-observation.
  // -----------------------------------------------------------------------------------------------
  async recordVerificationObservation(
    tx: TenantTransaction,
    request: VerificationWriteRequest,
  ): Promise<VerificationWriteOutcome> {
    const context = await loadVerificationContext(tx, request.caseId);
    if (context === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (context.rowVersionMs !== request.expectedRowVersionMs) {
      return {
        ok: false,
        reason: 'PRECONDITION_FAILED',
        currentRowVersionMs: context.rowVersionMs,
        truthState: context.truthState,
      };
    }
    // T14 moves ACKNOWLEDGED → VERIFIED_REMOVED. Any other state is one of §5.10.1's explicitly illegal pairs
    // (`REQUEST_SUBMITTED` and `VERIFIED_NOT_PRESENT` → `VERIFIED_REMOVED` are forbidden by SPEC-001 §4.2), and
    // it is reported as an illegal transition with the state named rather than as a guard failure.
    if (context.truthState !== 'ACKNOWLEDGED') {
      return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: context.truthState };
    }
    if (request.evidenceArtifactId !== null && !(await evidenceExists(tx, request.evidenceArtifactId))) {
      return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }

    // INDEPENDENCE, AGAINST WHAT HAPPENED. The observer must be a different identity from the one that acted,
    // and must observe along a different path (VG-VERIFY-001). The acting identity and the action's instant come
    // from the case's T8 audit row; when there is none, independence cannot be attested and the request is
    // refused rather than assumed.
    if (context.actingIdentity === null || context.actionAtMs === null) {
      return { ok: false, reason: 'OBSERVATION_PATH_NOT_INDEPENDENT' };
    }
    if (request.observationPathId === request.actingPathId) {
      return { ok: false, reason: 'OBSERVATION_PATH_NOT_INDEPENDENT' };
    }
    if (request.actorIdentity === context.actingIdentity) {
      return { ok: false, reason: 'OBSERVATION_PATH_NOT_INDEPENDENT' };
    }

    // VG-VERIFY-003: the recipe declares HOW removal is verified, and an observation by another method cannot
    // prove it. A case with no recipe has no declared method, which is reported as a mismatch with the required
    // value named as unrecorded — never as an assumed match.
    const requiredMethod = context.recipeVerificationMethod ?? 'UNRECORDED';
    if (request.observationMethod !== requiredMethod) {
      return {
        ok: false,
        reason: 'OBSERVATION_METHOD_MISMATCH',
        required: requiredMethod,
        supplied: request.observationMethod,
      };
    }

    const observedAtMs = Date.parse(request.observedAt);
    const elapsedSeconds = Math.floor((observedAtMs - context.actionAtMs) / 1000);
    const window = new ObservationWindow(request.requiredSeconds * 1000, request.observationMethod);
    const met = window.hasElapsed(observedAtMs, context.actionAtMs);
    const storedFinding = API_TO_FINDING[request.finding] ?? 'INCONCLUSIVE';

    // VG-VERIFY-002: absence may not be reported before the window has elapsed. Refused BEFORE the row is
    // written, so a premature claim leaves no observation behind. A NON-absence finding is recorded whatever the
    // window says: a record still present is a fact, not a claim of removal.
    if (storedFinding === 'ABSENT' && !met) {
      return {
        ok: false,
        reason: 'OBSERVATION_WINDOW_NOT_MET',
        requiredSeconds: request.requiredSeconds,
        elapsedSeconds,
      };
    }

    const observationId = cryptoRandom();
    const tenantId = new TenantId(context.tenantId);
    await tx.query(
      `INSERT INTO verification_observation
         (id, tenant_id, case_id, method, observed_at, actor_identity, acting_identity, finding, evidence_id,
          acting_path_id, observation_path_id)
       VALUES ($1::uuid, current_setting('app.tenant_id', true)::uuid, $2::uuid, $3,
               to_timestamp($4::bigint / 1000.0), $5, $6, $7, $8::uuid, $9, $10)`,
      [
        observationId,
        request.caseId,
        request.observationMethod,
        Math.trunc(observedAtMs),
        request.actorIdentity,
        context.actingIdentity,
        storedFinding,
        request.evidenceArtifactId,
        request.actingPathId,
        request.observationPathId,
      ],
    );

    const observation = createVerificationObservation({
      id: observationId,
      tenantId,
      caseId: new CaseId(request.caseId),
      method: request.observationMethod,
      observedAtMs,
      actorIdentity: request.actorIdentity,
      actingIdentity: context.actingIdentity,
      finding: storedFinding,
      // The column is `uuid NOT NULL`, so an observation with no artifact records the CASE's id: the evidence
      // slot always names a row that exists rather than a sentinel, and `evidenceArtifactId` in the response
      // reports whether a citation was supplied.
      evidenceId: new EvidenceId(request.evidenceArtifactId ?? request.caseId),
    });

    const result = recordVerification(
      { tenantId, correlationId: request.correlationId, nowMs: request.nowMs },
      {
        caseId: request.caseId,
        from: 'ACKNOWLEDGED',
        observation,
        window,
        actionAtMs: context.actionAtMs,
        recipeVerificationMethod: requiredMethod,
        recordAbsent: storedFinding === 'ABSENT',
      },
    );

    const failed = 'refused' in result;
    let transitionId: string | null = null;
    if (failed) {
      // The observation HAPPENED and is recorded; the case does not move. §5.10.1's second success body says so
      // plainly (`verificationFailed: true`, `transitionCode: null`), and VG-VERIFY-004 forbids regressing or
      // inventing a state to accommodate it. The audit row carries no transition code, because none occurred.
      await appendAuditEvents(tx, [result.audit], { actorKind: 'SERVICE' });
    } else {
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
      transitionId = ids[0] ?? null;
    }

    const response: VerificationWriteResponse = {
      verificationObservationId: observationId,
      caseId: request.caseId,
      truthState: failed ? context.truthState : result.to,
      transitionCode: failed ? null : result.transitionId,
      transitionId,
      observationMethod: request.observationMethod,
      actingPathId: request.actingPathId,
      observationPathId: request.observationPathId,
      // The COMPUTED window, not the caller's claim. `requiredSeconds` is the caller's requirement; whether it
      // was met is a fact about two instants.
      windowSatisfied: { requiredSeconds: request.requiredSeconds, elapsedSeconds, met },
      verificationLagSeconds: elapsedSeconds,
      evidenceArtifactId: request.evidenceArtifactId,
      finding: request.finding,
      verificationFailed: failed,
      // FALSE, and stated as a fact rather than as a constant. This route only runs for an ACKNOWLEDGED case (the
      // state check above refuses everything else), so a record still present is what that state EXPECTS rather
      // than a contradiction of a claimed removal. The field is carried because §5.10.1's response carries it,
      // and a future route that runs against a state claiming removal would have to compute it from that state.
      reappearanceSuspected: false,
    };
    return { ok: true, response };
  }

  // -----------------------------------------------------------------------------------------------
  // §5.11.1 — a reappearance.
  // -----------------------------------------------------------------------------------------------
  async recordReappearance(
    tx: TenantTransaction,
    request: ReappearanceWriteRequest,
  ): Promise<ReappearanceWriteOutcome> {
    const exposure = await tx.query<{
      truth_state: string;
      updated_at: Date;
      case_id: string | null;
    }>(
      `SELECT e.truth_state::text AS truth_state, e.updated_at,
              (SELECT c.id::text FROM request_case c WHERE c.exposure_id = e.id
                ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS case_id
         FROM exposure e WHERE e.id = $1::uuid`,
      [request.exposureId],
    );
    const row = exposure.rows[0];
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

    // VG-REAPPEAR-001: a first-ever sighting is NEVER labelled as a reappearance. The refusal names the state the
    // exposure is actually in, so the caller learns the truth rather than the label they asked for.
    if (row.truth_state !== 'VERIFIED_REMOVED' && row.truth_state !== 'SEARCH_DELISTED') {
      return { ok: false, reason: 'REAPPEARANCE_WITHOUT_PRIOR_REMOVAL', observedState: row.truth_state };
    }

    const priorEventId = parsePriorRemovedEventId(request.priorRemovedEventId);
    if (priorEventId === null) return { ok: false, reason: 'PRIOR_REMOVED_EVENT_NOT_FOUND' };
    // The referenced row must be the transition that ESTABLISHED the state being reappeared from: `T14` for
    // VERIFIED_REMOVED, `T21` for SEARCH_DELISTED. A row that exists but recorded something else is not this
    // reappearance's prior event, and linking to it would make the history say the wrong thing.
    const expectedCode = row.truth_state === 'VERIFIED_REMOVED' ? 'T14' : 'T21';
    const prior = await tx.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM audit_event a
          WHERE a.id = $1::bigint AND a.transition_code = $2
            AND a.to_truth_state::text = $3
            AND (a.case_id IN (SELECT c.id FROM request_case c WHERE c.exposure_id = $4::uuid)
                 OR (a.target_kind = 'Exposure' AND a.target_id = $4::uuid))
       ) AS present`,
      [priorEventId, expectedCode, row.truth_state, request.exposureId],
    );
    if (prior.rows[0]?.present !== true) return { ok: false, reason: 'PRIOR_REMOVED_EVENT_NOT_FOUND' };

    if (!(await evidenceExists(tx, request.evidenceArtifactId))) {
      return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }

    const observedAtMs = Date.parse(request.observedAt);
    const reappearanceId = cryptoRandom();
    await tx.query(
      `INSERT INTO reappearance
         (id, tenant_id, exposure_id, prior_removed_event_id, observed_at, content_hash, evidence_id, observation_method)
       VALUES ($1::uuid, current_setting('app.tenant_id', true)::uuid, $2::uuid, $3::bigint,
               to_timestamp($4::bigint / 1000.0), $5, $6::uuid, $7)`,
      [
        reappearanceId,
        request.exposureId,
        priorEventId,
        Math.trunc(observedAtMs),
        request.contentHash,
        request.evidenceArtifactId,
        request.observationMethod,
      ],
    );

    const tenantId = new TenantId(
      (
        await tx.query<{ tenant_id: string }>(
          `SELECT e.tenant_id::text AS tenant_id FROM exposure e WHERE e.id = $1::uuid`,
          [request.exposureId],
        )
      ).rows[0]?.tenant_id ?? '',
    );

    let result;
    try {
      result = detectReappearance(
        { tenantId, correlationId: request.correlationId, nowMs: request.nowMs },
        {
          exposureId: request.exposureId,
          caseId: row.case_id,
          from: row.truth_state as 'VERIFIED_REMOVED' | 'SEARCH_DELISTED',
          priorRemovedEventId: String(priorEventId),
          recordPresentAgain: true,
        },
      );
    } catch (error) {
      if (error instanceof DomainError) {
        return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: row.truth_state };
      }
      throw error;
    }

    await tx.query(`UPDATE exposure SET truth_state = $2::truth_state WHERE id = $1::uuid`, [
      request.exposureId,
      result.to,
    ]);
    await appendAuditEvents(
      tx,
      [result.audit],
      { actorKind: 'SERVICE' },
      {
        transitionCode: result.transitionId,
        from: result.from,
        to: result.to,
        evidenceArtifactIds: [request.evidenceArtifactId],
        ...(row.case_id === null ? {} : { caseId: row.case_id }),
      },
    );

    return {
      ok: true,
      response: {
        reappearanceId,
        exposureId: request.exposureId,
        priorRemovedEventId: String(priorEventId),
        priorTruthState: row.truth_state,
        truthState: result.to,
        transitionCode: result.transitionId,
        observedAt: new Date(observedAtMs).toISOString(),
        reentry: REENTRY_RULES,
      },
    };
  }
}

/** Whether an evidence artifact resolves for this tenant (RLS makes another tenant's an absence). */
async function evidenceExists(tx: TenantTransaction, evidenceArtifactId: string): Promise<boolean> {
  const result = await tx.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM evidence_artifact e WHERE e.id = $1::uuid) AS present`,
    [evidenceArtifactId],
  );
  return result.rows[0]?.present === true;
}

/**
 * The prior removal event, from either accepted form.
 *
 * `TR-<digits>` is the form SPEC-003 §5.11.1's example uses; the bare digits are what §5.11.2 and §5.11.3
 * RENDER, because this API returns identifiers as their underlying keys (the same reading `ASSUMPTIONS.md` §3.27
 * records for `transitionId`). Accepting both is what keeps a caller from having to know which form it is
 * holding, and the value is returned as digits so the stored bigint and the response agree.
 */
function parsePriorRemovedEventId(value: string): string | null {
  const match = /^(?:TR-)?(\d{1,19})$/.exec(value.trim());
  if (match?.[1] === undefined) return null;
  const parsed = BigInt(match[1]);
  // A bigint column accepts up to 2^63-1; a larger value would fail in SQL with a type error whose message names
  // the column rather than the caller's input.
  return parsed <= 9223372036854775807n ? match[1] : null;
}

interface VerificationContext {
  readonly tenantId: string;
  readonly truthState: string;
  readonly rowVersionMs: number;
  readonly recipeVerificationMethod: string | null;
  readonly actingIdentity: string | null;
  readonly actionAtMs: number | null;
}

/** The facts §5.10.1's guards need, including the acting identity and instant read from the audit spine. */
async function loadVerificationContext(
  tx: TenantTransaction,
  caseId: string,
): Promise<VerificationContext | undefined> {
  const base = await tx.query<{
    tenant_id: string;
    truth_state: string;
    updated_at: Date;
    verification_method: string | null;
  }>(
    `SELECT c.tenant_id::text AS tenant_id, c.truth_state::text AS truth_state, c.updated_at,
            r.verification_method
       FROM request_case c
       LEFT JOIN removal_recipe r ON r.id = c.recipe_id
      WHERE c.id = $1::uuid`,
    [caseId],
  );
  const row = base.rows[0];
  if (row === undefined) return undefined;

  // The T8 row is the record of the external effect: its `actor` is the identity that acted, and its `at` is
  // when. Newest first, because a case can be submitted more than once after a reappearance.
  const action = await tx.query<{ actor: string; at: Date }>(
    `SELECT a.actor, a.at FROM audit_event a
      WHERE a.case_id = $1::uuid AND a.transition_code = 'T8'
      ORDER BY a.at DESC, a.id DESC LIMIT 1`,
    [caseId],
  );
  const actionRow = action.rows[0];

  return {
    tenantId: row.tenant_id,
    truthState: row.truth_state,
    rowVersionMs: row.updated_at.getTime(),
    recipeVerificationMethod: row.verification_method,
    actingIdentity: actionRow?.actor ?? null,
    actionAtMs: actionRow?.at.getTime() ?? null,
  };
}
