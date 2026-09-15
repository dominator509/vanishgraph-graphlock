/**
 * Exposures and match assessment against PostgreSQL (SPEC-003 §5.5.1–§5.5.4).
 *
 * THE ASSESSMENT ROUTES GO THROUGH THE DOMAIN COMMAND, NOT AROUND IT. §5.5.3 drives T3 and §5.5.4 drives
 * T4; both are guard-evaluated transitions, and SPEC-001 §4.3 SM-6 forbids assigning a truth state anywhere
 * but inside the machine. So this adapter loads the facts, calls `assessMatch` (the same command the domain
 * node ships and unit-tests), and writes exactly what the command returned: `applied.from`, `applied.to`,
 * `applied.id` and the command's own `AuditEvent`. A handler here that "decided" a state would be the defect
 * the M6 route rule names.
 *
 * THE BELOW-THRESHOLD PATH WRITES NO TRANSITION, BECAUSE NONE OCCURRED. §5.5.3: an inconclusive score
 * "leaves the exposure at `DISCOVERED_CANDIDATE` with the assessment recorded", and its response says
 * `belowThreshold: true` with no `transitionId`. That path therefore appends an audit row with the
 * assessment's basis and NO transition facts — the append path supports exactly that, and the column's
 * all-or-nothing CHECK makes a half-recorded transition unrepresentable.
 *
 * EVERY WRITE IS ONE TRANSACTION. The state change, the score, the assessment record and the audit row are
 * committed together or not at all (SM-2, SPEC-006 §7.1 row 11).
 */

import type {
  AssessmentOutcome,
  AssessmentResponse,
  ConfidenceBasisEntry,
  ConfidenceValue,
  DisproofOutcome,
  DisproofRequest,
  ExposureDeadline,
  ExposureDetail,
  ExposureFilters,
  ExposureListRow,
  ExposureQueries,
  ExternalActionSummary,
  ListExposuresParams,
  MatchAssessmentRequest,
  PolicyDecisionSummary,
  RecipeReadinessSummary,
} from '../../application/contracts/exposure-queries.ts';
import { SEARCH_ENGINE_SOURCE_CLASS } from '../../application/contracts/exposure-queries.ts';
import { assessMatch } from '../../domain/commands.ts';
import { createAuditEvent } from '../../domain/entities.ts';
import { TenantId } from '../../domain/identifiers.ts';
import type { TruthState } from '../../domain/truth-state.ts';
import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import { appendAuditEvents } from './audit-sink.ts';

interface RawExposureRow {
  readonly exposure_id: string;
  readonly subject_ref: string;
  readonly source_id: string;
  readonly source_record_id: string;
  readonly truth_state: string;
  readonly confidence: number;
  readonly confidence_basis: unknown;
  readonly case_ref: string | null;
  readonly first_observed_at: Date;
  readonly last_observed_at: Date;
  readonly updated_at: Date;
}

/**
 * The one projection every exposure read uses, so `confidence` cannot appear without its basis in one route
 * and with it in another.
 *
 * `confidence::float8` because `numeric` reaches the driver as a STRING — a `number` field carrying
 * `"0.91"` is the kind of type lie that survives until something does arithmetic on it.
 */
const EXPOSURE_PROJECTION = `
  e.id::text                AS exposure_id,
  e.subject_id::text        AS subject_ref,
  sr.source_id::text        AS source_id,
  e.source_record_id::text  AS source_record_id,
  e.truth_state::text       AS truth_state,
  e.confidence::float8      AS confidence,
  e.confidence_basis        AS confidence_basis,
  c.id::text                AS case_ref,
  e.first_observed_at       AS first_observed_at,
  e.last_observed_at        AS last_observed_at,
  e.updated_at              AS updated_at`;

const EXPOSURE_FROM = `
  FROM exposure e
  JOIN source_record sr ON sr.id = e.source_record_id
  LEFT JOIN request_case c ON c.exposure_id = e.id`;

/**
 * A confidence basis, validated on read rather than coerced.
 *
 * The column is `jsonb NOT NULL CHECK (jsonb_array_length(...) > 0)`, so it cannot be empty — but its
 * ELEMENTS are not constrained by the schema, and this port's type promises `{feature, weight}`. A row
 * whose basis does not have that shape is reported as corrupt data, loudly, instead of being flattened into
 * an empty array: a match whose basis silently disappears is precisely the state VG-IDENT-003 forbids.
 */
function toBasis(raw: unknown): readonly ConfidenceBasisEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`exposure.confidence_basis is not a non-empty array (got ${JSON.stringify(raw)})`);
  }
  return raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`exposure.confidence_basis entry is not an object: ${JSON.stringify(entry)}`);
    }
    const candidate = entry as { feature?: unknown; weight?: unknown };
    if (typeof candidate.feature !== 'string' || typeof candidate.weight !== 'number') {
      throw new Error(`exposure.confidence_basis entry is not {feature: string, weight: number}`);
    }
    return { feature: candidate.feature, weight: candidate.weight };
  });
}

function toConfidence(row: RawExposureRow): ConfidenceValue {
  return { value: row.confidence, basis: toBasis(row.confidence_basis) };
}

function toListRow(row: RawExposureRow): ExposureListRow {
  return {
    exposureId: row.exposure_id,
    subjectRef: row.subject_ref,
    sourceId: row.source_id,
    sourceRecordId: row.source_record_id,
    truthState: row.truth_state,
    confidence: toConfidence(row),
    caseRef: row.case_ref,
    firstObservedAt: row.first_observed_at.toISOString(),
    lastObservedAt: row.last_observed_at.toISOString(),
  };
}

/** The sortable columns, and the SQL each names. An unmapped field cannot reach SQL because §2.6 allowed it. */
const SORT_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  observedAt: 'e.last_observed_at',
  confidence: 'e.confidence',
  truthState: 'e.truth_state',
});

/** The cast a cursor value needs for each sort column, so the keyset comparison is typed like the column. */
const SORT_CASTS: Readonly<Record<string, string>> = Object.freeze({
  observedAt: 'timestamptz',
  confidence: 'numeric',
  truthState: 'text',
});

function toFilters(filters: ExposureFilters): { clause: string; values: unknown[] } {
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${String(values.length)}`;
  };
  const where: string[] = [];

  if (filters.subjectId !== undefined) where.push(`e.subject_id = ${bind(filters.subjectId)}::uuid`);
  if (filters.sourceId !== undefined) where.push(`sr.source_id = ${bind(filters.sourceId)}::uuid`);
  if (filters.truthState !== undefined) {
    const states = typeof filters.truthState === 'string' ? [filters.truthState] : filters.truthState;
    where.push(`e.truth_state::text = ANY(${bind([...states])}::text[])`);
  }
  if (filters.minConfidence !== undefined) {
    where.push(`e.confidence >= ${bind(filters.minConfidence)}::numeric`);
  }
  if (filters.from !== undefined) where.push(`e.last_observed_at >= ${bind(filters.from)}::timestamptz`);
  if (filters.to !== undefined) where.push(`e.last_observed_at < ${bind(filters.to)}::timestamptz`);

  return { clause: where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`, values };
}

interface AssessmentContext {
  readonly exposureId: string;
  readonly tenantId: string;
  readonly truthState: TruthState;
  readonly sourceRecordId: string;
  readonly sourceClass: string;
  readonly jurisdiction: string;
  readonly rowVersionMs: number;
  readonly confidence: number;
  readonly basis: readonly ConfidenceBasisEntry[];
  readonly threshold: number | null;
}

/** The in-force policy version for a jurisdiction and the threshold it records (never defaulted). */
async function thresholdFor(tx: TenantTransaction, jurisdiction: string): Promise<number | null> {
  const result = await tx.query<{ match_confidence_threshold: string | null }>(
    `SELECT p.match_confidence_threshold::text AS match_confidence_threshold
       FROM jurisdiction_policy p
      WHERE p.jurisdiction = $1
        AND p.effective_from <= now()
        AND (p.effective_to IS NULL OR p.effective_to > now())
      ORDER BY p.version DESC
      LIMIT 1`,
    [jurisdiction],
  );
  const raw = result.rows[0]?.match_confidence_threshold;
  if (raw === undefined || raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadAssessmentContext(
  tx: TenantTransaction,
  exposureId: string,
): Promise<AssessmentContext | undefined> {
  const result = await tx.query<{
    tenant_id: string;
    truth_state: string;
    source_record_id: string;
    source_class: string;
    jurisdiction: string;
    updated_at: Date;
    confidence: number;
    confidence_basis: unknown;
  }>(
    `SELECT e.tenant_id::text AS tenant_id,
            e.truth_state::text AS truth_state,
            e.source_record_id::text AS source_record_id,
            s.class AS source_class,
            ps.jurisdiction AS jurisdiction,
            e.updated_at AS updated_at,
            e.confidence::float8 AS confidence,
            e.confidence_basis AS confidence_basis
       FROM exposure e
       JOIN source_record sr ON sr.id = e.source_record_id
       JOIN source s ON s.id = sr.source_id
       JOIN protected_subject ps ON ps.id = e.subject_id
      WHERE e.id = $1::uuid`,
    [exposureId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    exposureId,
    tenantId: row.tenant_id,
    truthState: row.truth_state as TruthState,
    sourceRecordId: row.source_record_id,
    sourceClass: row.source_class,
    jurisdiction: row.jurisdiction,
    rowVersionMs: row.updated_at.getTime(),
    confidence: row.confidence,
    basis: toBasis(row.confidence_basis),
    threshold: await thresholdFor(tx, row.jurisdiction),
  };
}

async function evidenceExists(tx: TenantTransaction, evidenceArtifactId: string): Promise<boolean> {
  const result = await tx.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM evidence_artifact a WHERE a.id = $1::uuid) AS present`,
    [evidenceArtifactId],
  );
  return result.rows[0]?.present === true;
}

/** Write the score and state, and append the audit row — all in the caller's transaction. */
async function applyWrite(
  tx: TenantTransaction,
  args: {
    readonly exposureId: string;
    readonly truthState: TruthState;
    readonly confidence: ConfidenceValue;
    readonly correlationId: string;
    readonly nowMs: number;
  },
): Promise<void> {
  await tx.query(
    `UPDATE exposure
        SET truth_state = $2::truth_state,
            confidence = $3::numeric,
            confidence_basis = $4::jsonb,
            last_observed_at = GREATEST(last_observed_at, to_timestamp($5::bigint / 1000.0))
      WHERE id = $1::uuid`,
    [
      args.exposureId,
      args.truthState,
      args.confidence.value,
      JSON.stringify(args.confidence.basis),
      Math.trunc(args.nowMs),
    ],
  );
}

export class PostgresExposureQueries implements ExposureQueries {
  async listExposures(
    tx: TenantTransaction,
    params: ListExposuresParams,
  ): Promise<readonly ExposureListRow[]> {
    const [field = 'observedAt', direction = 'desc'] = params.sort.split(':');
    const sortColumn = SORT_COLUMNS[field] ?? SORT_COLUMNS['observedAt'];
    const cast = SORT_CASTS[field] ?? 'timestamptz';
    const comparison = direction === 'asc' ? '>' : '<';
    const order = direction === 'asc' ? 'ASC' : 'DESC';

    const { clause, values } = toFilters(params.filters);
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };

    const keyset =
      params.after === undefined
        ? ''
        : // ORDERING AND PAGINATION TRUNCATE TOGETHER. `observedAt` is a `timestamptz` written by `now()`
          // and therefore carries microseconds, while a cursor can only carry the milliseconds a JS `Date`
          // holds; without the same `date_trunc` on both sides the row that minted a cursor comes back on the
          // next page (or is skipped) — the defect `ASSUMPTIONS.md` §3.26 records. The other two sort columns
          // are exact already, and the expression is a no-op for them.
          `(${field === 'observedAt' ? `date_trunc('milliseconds', ${sortColumn})` : sortColumn}, e.id::text) ${comparison} (${bind(params.after.sortValue)}::${cast}, ${bind(params.after.id)}::text)`;

    const where = [clause.replace(/^WHERE /, ''), keyset].filter((part) => part.length > 0);
    const limitParam = bind(params.limit + 1);

    const result = await tx.query<RawExposureRow>(
      `SELECT ${EXPOSURE_PROJECTION}
       ${EXPOSURE_FROM}
       ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY ${field === 'observedAt' ? `date_trunc('milliseconds', ${sortColumn})` : sortColumn} ${order}, e.id ${order}
       LIMIT ${limitParam}`,
      values,
    );
    return result.rows.map(toListRow);
  }

  async exposureRowVersion(
    tx: TenantTransaction,
    exposureId: string,
  ): Promise<{ readonly rowVersionMs: number; readonly truthState: string } | undefined> {
    const result = await tx.query<{ updated_at: Date; truth_state: string }>(
      `SELECT e.updated_at AS updated_at, e.truth_state::text AS truth_state
         FROM exposure e WHERE e.id = $1::uuid`,
      [exposureId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { rowVersionMs: row.updated_at.getTime(), truthState: row.truth_state };
  }

  async getExposureDetail(
    tx: TenantTransaction,
    exposureId: string,
  ): Promise<ExposureDetail | undefined> {
    const base = await tx.query<RawExposureRow>(
      `SELECT ${EXPOSURE_PROJECTION} ${EXPOSURE_FROM} WHERE e.id = $1::uuid`,
      [exposureId],
    );
    const row = base.rows[0];
    // Absent and another tenant's exposure are indistinguishable by construction (RLS), so both reach this
    // branch and produce one 404 body (SPEC-006 H-9).
    if (row === undefined) return undefined;

    // `truthStateChangedAt` IS THE TRANSITION'S INSTANT, NOT `updated_at`. The 0006 trigger moves `updated_at`
    // on ANY update — a confidence write is not a state change — so reporting it here would say the state
    // changed when a score was corrected. The instant the current state came into effect is the `at` of the
    // transition that moved INTO it; rows that predate the transition spine fall back to `created_at`, which
    // is when their truth state was established.
    const changed = await tx.query<{ changed_at: Date }>(
      `SELECT COALESCE(
                (SELECT a.at FROM audit_event a
                  WHERE a.transition_code IS NOT NULL
                    AND a.to_truth_state::text = $2
                    AND ((a.target_kind = 'Exposure' AND a.target_id = $1::uuid)
                         OR a.case_id IN (SELECT c2.id FROM request_case c2 WHERE c2.exposure_id = $1::uuid))
                  ORDER BY a.at DESC, a.id DESC
                  LIMIT 1),
                e.created_at) AS changed_at
         FROM exposure e WHERE e.id = $1::uuid`,
      [exposureId, row.truth_state],
    );

    const caseId = row.case_ref;
    const policyDecision = caseId === null ? undefined : await this.#policyDecision(tx, caseId);
    const recipe = caseId === null ? undefined : await this.#recipe(tx, caseId);
    const deadlines = caseId === null ? [] : await this.#deadlines(tx, caseId);
    const actions = caseId === null ? undefined : await this.#externalActions(tx, caseId);
    const reappearance = await tx.query<{ prior_removed_event_id: string | null }>(
      `SELECT r.prior_removed_event_id::text AS prior_removed_event_id
         FROM reappearance r
        WHERE r.exposure_id = $1::uuid
        ORDER BY r.observed_at DESC
        LIMIT 1`,
      [exposureId],
    );

    return {
      ...toListRow(row),
      truthStateChangedAt: (changed.rows[0]?.changed_at ?? row.updated_at).toISOString(),
      rowVersionMs: row.updated_at.getTime(),
      policyDecision: policyDecision ?? null,
      recipeReadiness: recipe ?? null,
      deadlines,
      reappearanceOf: reappearance.rows[0]?.prior_removed_event_id ?? null,
      externalActions: actions ?? { count: 0, latestOutcome: null },
    };
  }

  async #policyDecision(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<PolicyDecisionSummary | undefined> {
    const result = await tx.query<{
      id: string;
      jurisdiction: string;
      legal_basis: string;
      channel: string;
      policy_version: number;
      decided_at: Date;
    }>(
      `SELECT d.id::text AS id, d.jurisdiction, d.legal_basis, d.channel, d.policy_version, d.decided_at
         FROM policy_decision d
         JOIN request_case c ON c.policy_decision_id = d.id
        WHERE c.id = $1::uuid`,
      [caseId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      policyDecisionId: row.id,
      jurisdiction: row.jurisdiction,
      legalBasis: row.legal_basis,
      channel: row.channel,
      // SPEC-003's examples render `policyVersion` as a date string while both version columns are integers
      // (ASSUMPTIONS §3.23). This route only REPORTS the value, so rendering the integer as its string form
      // satisfies the field without inventing a second version concept.
      policyVersion: String(row.policy_version),
      decidedAt: row.decided_at.toISOString(),
    };
  }

  async #recipe(tx: TenantTransaction, caseId: string): Promise<RecipeReadinessSummary | undefined> {
    const result = await tx.query<{
      id: string;
      version: number;
      enabled: boolean;
      freshness_at: Date;
      fresh: boolean;
    }>(
      `SELECT r.id::text AS id, r.version, r.enabled, r.freshness_at,
              (r.freshness_at > now()) AS fresh
         FROM removal_recipe r
        WHERE r.source_id = (SELECT c.source_id FROM request_case c WHERE c.id = $1::uuid)
        ORDER BY r.version DESC
        LIMIT 1`,
      [caseId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      recipeId: row.id,
      version: row.version,
      enabled: row.enabled,
      freshnessAt: row.freshness_at.toISOString(),
      fresh: row.fresh,
    };
  }

  async #deadlines(tx: TenantTransaction, caseId: string): Promise<readonly ExposureDeadline[]> {
    const result = await tx.query<{
      id: string;
      kind: string;
      due_at: Date;
      satisfied_by: string | null;
    }>(
      `SELECT d.id::text AS id, d.kind, d.due_at, d.satisfied_by
         FROM deadline d
        WHERE d.case_id = $1::uuid
        ORDER BY d.due_at ASC`,
      [caseId],
    );
    const now = Date.now();
    return result.rows.map((row) => ({
      deadlineId: row.id,
      kind: row.kind,
      dueAt: row.due_at.toISOString(),
      // The same three-way derivation §5.13 uses, applied to one row: satisfied, breached, or open. `WAIVED`
      // is unreachable here for the same reason `ASSUMPTIONS.md` §3.23 records — no route waives a deadline.
      state: row.satisfied_by !== null ? 'SATISFIED' : row.due_at.getTime() < now ? 'BREACHED' : 'OPEN',
    }));
  }

  async #externalActions(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<ExternalActionSummary> {
    const result = await tx.query<{ count: number; latest: string | null }>(
      `SELECT count(*)::int AS count,
              (SELECT a2.status FROM external_action a2
                WHERE a2.case_id = $1::uuid
                ORDER BY a2.created_at DESC, a2.id DESC
                LIMIT 1) AS latest
         FROM external_action a WHERE a.case_id = $1::uuid`,
      [caseId],
    );
    return { count: result.rows[0]?.count ?? 0, latestOutcome: result.rows[0]?.latest ?? null };
  }

  async recordMatchAssessment(
    tx: TenantTransaction,
    request: MatchAssessmentRequest,
  ): Promise<AssessmentOutcome> {
    const context = await loadAssessmentContext(tx, request.exposureId);
    if (context === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (context.rowVersionMs !== request.expectedRowVersionMs) {
      return {
        ok: false,
        reason: 'PRECONDITION_FAILED',
        currentRowVersionMs: context.rowVersionMs,
        truthState: context.truthState,
      };
    }
    // VG-IDENT-004: a record seen through a search-engine-class source cannot enter a removal path. Refused
    // BEFORE any write, and the class came from the source row rather than from the request.
    if (context.sourceClass === SEARCH_ENGINE_SOURCE_CLASS) {
      return { ok: false, reason: 'IDENTITY_CLASS_MISMATCH' };
    }
    if (request.evidenceArtifactId !== null && !(await evidenceExists(tx, request.evidenceArtifactId))) {
      return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }
    if (context.truthState !== 'DISCOVERED_CANDIDATE') {
      // §5.5.3: "409 ILLEGAL_TRANSITION (exposure not in DISCOVERED_CANDIDATE)". Named here rather than left
      // to the state machine's exception, so the response carries the state the caller can act on.
      return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: context.truthState };
    }
    if (context.threshold === null) {
      // The policy in force records no match threshold, so T3's guard cannot be evaluated. Refused rather
      // than evaluated against a number this node chose; see the port's header.
      return { ok: false, reason: 'THRESHOLD_UNRESOLVED', jurisdiction: context.jurisdiction };
    }

    const atThreshold = request.confidence.value >= context.threshold;
    const belowThreshold = !atThreshold && !request.humanReviewed;

    if (belowThreshold) {
      // No transition. The assessment is recorded as an audit row carrying its basis (a "recorded base",
      // which is the use SPEC-002 §1 permits `jsonb` for) and the score is stored on the exposure.
      await applyWrite(tx, {
        exposureId: request.exposureId,
        truthState: context.truthState,
        confidence: request.confidence,
        correlationId: request.correlationId,
        nowMs: request.nowMs,
      });
      const event = createAuditEvent({
        id: `AssessMatch:${request.correlationId}:${String(request.nowMs)}`,
        tenantId: new TenantId(context.tenantId),
        actor: 'domain-command',
        action: 'AssessMatch',
        targetKind: 'Exposure',
        targetId: request.exposureId,
        correlationId: request.correlationId,
        atMs: request.nowMs,
        payload: {
          confidence: request.confidence.value,
          basisEntries: request.confidence.basis.length,
          method: request.method,
          humanReviewed: request.humanReviewed,
          belowThreshold: true,
          policyThresholdApplied: context.threshold,
          evidenceArtifactId: request.evidenceArtifactId,
        },
      });
      await appendAuditEvents(tx, [event], { actorKind: 'SERVICE' });
      const response: AssessmentResponse = {
        exposureId: request.exposureId,
        truthState: context.truthState,
        confidence: request.confidence,
        policyThresholdApplied: context.threshold,
        belowThreshold: true,
        assessmentRecorded: true,
      };
      return { ok: true, response };
    }

    const result = assessMatch(
      {
        tenantId: new TenantId(context.tenantId),
        correlationId: request.correlationId,
        nowMs: request.nowMs,
      },
      {
        caseId: request.exposureId,
        targetKind: 'Exposure',
        from: context.truthState,
        matched: true,
        confidenceAtThreshold: atThreshold,
        confidenceBasisRecorded: request.confidence.basis.length > 0,
        humanApproved: request.humanReviewed,
        disproofRecorded: false,
      },
    );

    await applyWrite(tx, {
      exposureId: request.exposureId,
      truthState: result.to,
      confidence: request.confidence,
      correlationId: request.correlationId,
      nowMs: request.nowMs,
    });
    const ids = await appendAuditEvents(
      tx,
      [result.audit],
      { actorKind: 'SERVICE' },
      {
        transitionCode: result.transitionId,
        from: result.from,
        to: result.to,
        evidenceArtifactIds: request.evidenceArtifactId === null ? [] : [request.evidenceArtifactId],
      },
    );

    const response: AssessmentResponse = {
      exposureId: request.exposureId,
      truthState: result.to,
      confidence: request.confidence,
      policyThresholdApplied: context.threshold,
      transitionId: ids[0] ?? '',
    };
    return { ok: true, response };
  }

  async recordDisproof(tx: TenantTransaction, request: DisproofRequest): Promise<DisproofOutcome> {
    const context = await loadAssessmentContext(tx, request.exposureId);
    if (context === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (context.rowVersionMs !== request.expectedRowVersionMs) {
      return {
        ok: false,
        reason: 'PRECONDITION_FAILED',
        currentRowVersionMs: context.rowVersionMs,
        truthState: context.truthState,
      };
    }
    if (context.truthState !== 'DISCOVERED_CANDIDATE') {
      return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: context.truthState };
    }
    if (!(await evidenceExists(tx, request.evidenceArtifactId))) {
      return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }

    // T4's guard is `subjectMatchDisproved`, and the request IS the disproof record. The domain command is
    // still the thing that decides T4 — the fact is supplied, the transition is not.
    const result = assessMatch(
      {
        tenantId: new TenantId(context.tenantId),
        correlationId: request.correlationId,
        nowMs: request.nowMs,
      },
      {
        caseId: request.exposureId,
        targetKind: 'Exposure',
        from: context.truthState,
        matched: false,
        confidenceAtThreshold: false,
        confidenceBasisRecorded: context.basis.length > 0,
        humanApproved: false,
        disproofRecorded: true,
      },
    );

    await applyWrite(tx, {
      exposureId: request.exposureId,
      truthState: result.to,
      confidence: { value: context.confidence, basis: context.basis },
      correlationId: request.correlationId,
      nowMs: request.nowMs,
    });
    const ids = await appendAuditEvents(
      tx,
      [result.audit],
      { actorKind: 'SERVICE' },
      {
        transitionCode: result.transitionId,
        from: result.from,
        to: result.to,
        evidenceArtifactIds: [request.evidenceArtifactId],
      },
    );

    return {
      ok: true,
      response: {
        exposureId: request.exposureId,
        truthState: result.to,
        coverageBounds: request.coverageBounds,
        transitionId: ids[0] ?? '',
      },
    };
  }
}
