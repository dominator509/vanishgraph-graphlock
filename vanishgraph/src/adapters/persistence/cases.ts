/**
 * Cases against PostgreSQL (SPEC-003 §5.7.1–§5.7.6).
 *
 * THE GUARDED UPDATE AND THE HUMAN GATE BOTH GO THROUGH `prepareRequest`. §5.7.4's transitions (T5/T6/T7/T9/
 * T10/T13/T15/T16/T19) and §5.7.5's (T7/T9/T12/T16) are the same domain command with different inputs: a
 * writable channel selection produces T5, no lawful writable channel produces NOT_REMOVABLE, and a detected gate
 * produces HUMAN_REQUIRED. One command means one guard list, evaluated inside the transaction, and SM-6 holds —
 * this file never assigns a truth state it did not receive from the machine.
 *
 * CREATION IS NOT A TRANSITION, so it carries no transition code. §5.7.1: "A case is created at the exposure's
 * current truth state; creation never advances it." The audit row that records it therefore has
 * `transition_code IS NULL` — the spine's all-or-nothing CHECK makes a half-recorded transition
 * unrepresentable — and an action token this file declares, because NO specification names a command for
 * creating a case (checked against SPEC-001 §6's command table, which has eleven rows and none of them creates
 * one). `ASSUMPTIONS.md` §3.29 records that reading.
 *
 * THE TIMELINE IS A UNION OF ROWS THAT EXIST, ordered by their own instants. Every branch names a table and a
 * timestamp column; every entry names a row that exists. `truthStateAfter` is filled ONLY for
 * TRANSITION entries, because a deadline or an evidence capture does not move a truth state and reporting the
 * case's current state on those rows would claim a transition that never happened.
 */

import type {
  CaseDetail,
  CaseFilters,
  CaseListRow,
  CaseNextDeadline,
  CasePolicyDecision,
  CaseQueries,
  CaseRecipe,
  CreateCaseOutcome,
  CreateCaseRequest,
  GuardsEvaluated,
  GuardedUpdateOutcome,
  GuardedUpdateRequest,
  HumanGateOutcome,
  HumanGateRequest,
  ListCasesParams,
  TimelineEntry,
} from '../../application/contracts/case-queries.ts';
import { ROUTEABLE_CASE_TARGETS, routingFor } from '../../application/contracts/case-queries.ts';
import type { TransitionRow } from '../../application/contracts/transition-queries.ts';
import { prepareRequest, type PrepareRequestInput } from '../../domain/commands.ts';
import {
  createAuditEvent,
  createAuthorityGrant,
  createJurisdictionPolicy,
  createPolicyDecision,
  createRemovalRecipe,
  createSource,
  type AuthorityKind,
  type PolicyProvenance,
} from '../../domain/entities.ts';
import { DomainError, GuardNotSatisfied, IllegalTransition } from '../../domain/errors.ts';
import { RecipeId, SourceId, SubjectId, TenantId } from '../../domain/identifiers.ts';
import type { TruthState } from '../../domain/truth-state.ts';
import {
  Jurisdiction,
  LegalBasis,
  type ChannelName,
  type ChannelOption,
  type PermissionClass,
} from '../../domain/values.ts';
import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import { appendAuditEvents } from './audit-sink.ts';
import { AUTHORITY_STATE_SQL } from './subjects.ts';
import { canonicalRecipePayload, verifyRecipeSignature } from './sources.ts';
import type { RecipeVerificationKeys } from '../../application/contracts/source-queries.ts';

/**
 * The audit action for a case creation.
 *
 * DECLARED HERE BECAUSE NO SPECIFICATION NAMES IT. SPEC-001 §6 lists eleven domain commands and none creates a
 * `RequestCase`; §5.7.1 creates one without a transition. The audit trail still has to say what happened, so the
 * row carries this token and no transition code. `ASSUMPTIONS.md` §3.29 records the reading, including that a
 * later specification naming the operation should replace this constant rather than add a second one.
 */
export const CASE_CREATION_ACTION = 'CreateRequestCase';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one case projection every read uses, so a list row and a detail row cannot disagree about a count.
 *
 * `channel` comes from the case's policy decision rather than from a column, because a case has no channel of
 * its own: the channel IS the decision's. `nextDeadline` is computed in the same projection for the same reason
 * — "the soonest unsatisfied deadline" is one rule, not one per route.
 */
const CASE_PROJECTION = `
  c.id::text                AS case_id,
  c.subject_id::text        AS subject_ref,
  c.source_id::text         AS source_id,
  c.exposure_id::text       AS exposure_id,
  c.truth_state::text       AS truth_state,
  d.channel                 AS channel,
  (SELECT count(*) FROM external_action a WHERE a.case_id = c.id)::int            AS action_count,
  (SELECT count(*) FROM verification_observation v WHERE v.case_id = c.id)::int   AS verification_count,
  c.updated_at              AS updated_at,
  c.created_at              AS created_at`;

/** The soonest unsatisfied deadline, as a correlated subquery so both reads agree. */
const NEXT_DEADLINE_SQL = `
  (SELECT d2.id::text FROM deadline d2
    WHERE d2.case_id = c.id AND d2.satisfied_by IS NULL
    ORDER BY d2.due_at ASC, d2.id ASC LIMIT 1)              AS next_deadline_id,
  (SELECT d2.kind FROM deadline d2
    WHERE d2.case_id = c.id AND d2.satisfied_by IS NULL
    ORDER BY d2.due_at ASC, d2.id ASC LIMIT 1)              AS next_deadline_kind,
  (SELECT d2.due_at FROM deadline d2
    WHERE d2.case_id = c.id AND d2.satisfied_by IS NULL
    ORDER BY d2.due_at ASC, d2.id ASC LIMIT 1)              AS next_deadline_due_at`;

const CASE_FROM = `
  FROM request_case c
  LEFT JOIN policy_decision d ON d.id = c.policy_decision_id`;

interface RawCaseRow {
  readonly case_id: string;
  readonly subject_ref: string;
  readonly source_id: string;
  readonly exposure_id: string;
  readonly truth_state: string;
  readonly channel: string | null;
  readonly action_count: number;
  readonly verification_count: number;
  readonly updated_at: Date;
  readonly created_at: Date;
  readonly next_deadline_id: string | null;
  readonly next_deadline_kind: string | null;
  readonly next_deadline_due_at: Date | null;
}

function toNextDeadline(row: RawCaseRow, nowMs: number): CaseNextDeadline | null {
  if (row.next_deadline_id === null || row.next_deadline_kind === null || row.next_deadline_due_at === null) {
    return null;
  }
  return {
    deadlineId: row.next_deadline_id,
    kind: row.next_deadline_kind,
    dueAt: row.next_deadline_due_at.toISOString(),
    // Unsatisfied by the query's own predicate, so the state is OPEN or BREACHED — the same three-way
    // derivation §5.13 uses, with SATISFIED unreachable for a row this query returns.
    state: row.next_deadline_due_at.getTime() < nowMs ? 'BREACHED' : 'OPEN',
  };
}

function toListRow(row: RawCaseRow, nowMs: number): CaseListRow {
  return {
    caseId: row.case_id,
    subjectRef: row.subject_ref,
    sourceId: row.source_id,
    exposureId: row.exposure_id,
    truthState: row.truth_state,
    channel: row.channel,
    actionCount: row.action_count,
    verificationCount: row.verification_count,
    nextDeadline: toNextDeadline(row, nowMs),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The sortable columns, and the keyset cast each needs. */
const SORT_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  createdAt: 'c.created_at',
  updatedAt: 'c.updated_at',
  truthState: 'c.truth_state',
});

const SORT_CASTS: Readonly<Record<string, string>> = Object.freeze({
  createdAt: 'timestamptz',
  updatedAt: 'timestamptz',
  truthState: 'text',
});

function toFilters(filters: CaseFilters): { clause: string; values: unknown[] } {
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${String(values.length)}`;
  };
  const where: string[] = [];

  if (filters.subjectId !== undefined) where.push(`c.subject_id = ${bind(filters.subjectId)}::uuid`);
  if (filters.sourceId !== undefined) where.push(`c.source_id = ${bind(filters.sourceId)}::uuid`);
  if (filters.truthState !== undefined) {
    const states = typeof filters.truthState === 'string' ? [filters.truthState] : filters.truthState;
    where.push(`c.truth_state::text = ANY(${bind([...states])}::text[])`);
  }
  if (filters.channel !== undefined) where.push(`d.channel = ${bind(filters.channel)}`);
  if (filters.authorityGrantState !== undefined) {
    const states =
      typeof filters.authorityGrantState === 'string' ? [filters.authorityGrantState] : filters.authorityGrantState;
    // The SAME derivation the subject reads use, interpolated rather than restated; see `AUTHORITY_STATE_SQL`.
    where.push(`(${AUTHORITY_STATE_SQL}) = ANY(${bind([...states])}::text[])`);
  }
  if (filters.from !== undefined) where.push(`c.updated_at >= ${bind(filters.from)}::timestamptz`);
  if (filters.to !== undefined) where.push(`c.updated_at < ${bind(filters.to)}::timestamptz`);

  return { clause: where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`, values };
}

/** The context a guarded write needs: the case, its authority, its decision and its recipe. */
interface CaseContext {
  readonly caseId: string;
  readonly tenantId: string;
  readonly truthState: TruthState;
  readonly rowVersionMs: number;
  readonly updatedAt: Date;
  readonly subjectId: string;
  readonly sourceId: string;
  readonly exposureId: string;
  readonly authorityGrantId: string;
  readonly policyDecisionId: string | null;
  readonly recipeId: string | null;
  readonly authority: {
    readonly id: string;
    readonly kind: string;
    readonly scope: readonly string[];
    readonly issuedAtMs: number;
    readonly expiresAtMs: number | null;
    readonly revokedAtMs: number | null;
  } | null;
  readonly decision: {
    readonly id: string;
    readonly jurisdiction: string;
    readonly legalBasis: string;
    readonly channel: string;
    readonly version: number;
    readonly decidedAtMs: number;
    readonly reasons: readonly string[];
  } | null;
  readonly recipe: {
    readonly id: string;
    readonly sourceId: string;
    readonly version: number;
    readonly channel: string;
    readonly verificationMethod: string;
    readonly freshnessAtMs: number;
    readonly enabled: boolean;
    readonly signingKeyRef: string | null;
    readonly signature: Buffer | null;
    readonly maxAttemptsPerWindow: number | null;
    readonly windowSeconds: number | null;
  } | null;
  /** The source the case is about; the command re-asserts whether it may be written to. */
  readonly source: {
    readonly name: string;
    readonly class: string;
    readonly jurisdiction: string | null;
    readonly permissionClass: string;
    readonly permissionCheckedAtMs: number | null;
  } | null;
}

async function loadCaseContext(
  tx: TenantTransaction,
  caseId: string,
): Promise<CaseContext | undefined> {
  const base = await tx.query<{
    tenant_id: string;
    truth_state: string;
    updated_at: Date;
    subject_id: string;
    source_id: string;
    exposure_id: string;
    authority_grant_id: string;
    policy_decision_id: string | null;
    recipe_id: string | null;
  }>(
    `SELECT c.tenant_id::text AS tenant_id, c.truth_state::text AS truth_state, c.updated_at,
            c.subject_id::text AS subject_id, c.source_id::text AS source_id,
            c.exposure_id::text AS exposure_id, c.authority_grant_id::text AS authority_grant_id,
            c.policy_decision_id::text AS policy_decision_id, c.recipe_id::text AS recipe_id
       FROM request_case c WHERE c.id = $1::uuid`,
    [caseId],
  );
  const row = base.rows[0];
  if (row === undefined) return undefined;

  const grant =
    row.authority_grant_id === null
      ? undefined
      : (
          await tx.query<{
            id: string;
            kind: string;
            scope: string[];
            issued_at: Date;
            expires_at: Date | null;
            revoked_at: Date | null;
          }>(
            `SELECT g.id::text AS id, g.kind, g.scope, g.issued_at, g.expires_at, g.revoked_at
               FROM authority_grant g WHERE g.id = $1::uuid`,
            [row.authority_grant_id],
          )
        ).rows[0];

  const decision =
    row.policy_decision_id === null
      ? undefined
      : (
          await tx.query<{
            id: string;
            jurisdiction: string;
            legal_basis: string;
            channel: string;
            policy_version: number;
            decided_at: Date;
            reasons: unknown;
          }>(
            `SELECT d.id::text AS id, d.jurisdiction, d.legal_basis, d.channel, d.policy_version, d.decided_at, d.reasons
               FROM policy_decision d WHERE d.id = $1::uuid`,
            [row.policy_decision_id],
          )
        ).rows[0];

  const source = (
    await tx.query<{
      name: string;
      class: string;
      jurisdiction: string | null;
      permission_class: string;
      permission_checked_at: Date | null;
    }>(
      `SELECT s.name, s.class, s.jurisdiction, s.permission_class::text AS permission_class,
              s.permission_checked_at
         FROM source s WHERE s.id = $1::uuid`,
      [row.source_id],
    )
  ).rows[0];

  const recipe =
    row.recipe_id === null
      ? undefined
      : (
          await tx.query<{
            id: string;
            source_id: string;
            version: number;
            channel: string;
            verification_method: string;
            freshness_at: Date;
            enabled: boolean;
            signing_key_ref: string | null;
            signature: Buffer | null;
            max_attempts_per_window: number | null;
            window_seconds: number | null;
          }>(
            `SELECT r.id::text AS id, r.source_id::text AS source_id, r.version, r.channel,
                    r.verification_method, r.freshness_at, r.enabled, r.signing_key_ref, r.signature,
                    r.max_attempts_per_window, r.window_seconds
               FROM removal_recipe r WHERE r.id = $1::uuid`,
            [row.recipe_id],
          )
        ).rows[0];

  return {
    caseId,
    tenantId: row.tenant_id,
    truthState: row.truth_state as TruthState,
    rowVersionMs: row.updated_at.getTime(),
    updatedAt: row.updated_at,
    subjectId: row.subject_id,
    sourceId: row.source_id,
    exposureId: row.exposure_id,
    authorityGrantId: row.authority_grant_id,
    policyDecisionId: row.policy_decision_id,
    recipeId: row.recipe_id,
    authority:
      grant === undefined
        ? null
        : {
            id: grant.id,
            kind: grant.kind,
            scope: [...grant.scope],
            issuedAtMs: grant.issued_at.getTime(),
            expiresAtMs: grant.expires_at === null ? null : grant.expires_at.getTime(),
            revokedAtMs: grant.revoked_at === null ? null : grant.revoked_at.getTime(),
          },
    decision:
      decision === undefined
        ? null
        : {
            id: decision.id,
            jurisdiction: decision.jurisdiction,
            legalBasis: decision.legal_basis,
            channel: decision.channel,
            version: decision.policy_version,
            decidedAtMs: decision.decided_at.getTime(),
            // `reasons` is `jsonb NOT NULL DEFAULT '[]'`; the domain wants `readonly string[]`, and a row whose
            // reasons are not an array of strings would be reported as an empty list rather than as corrupt
            // data — the reasons are DISPLAY, not a control, so the fail-soft direction is the safe one here.
            reasons: Array.isArray(decision.reasons)
              ? decision.reasons.filter((entry): entry is string => typeof entry === 'string')
              : [],
          },
    recipe:
      recipe === undefined
        ? null
        : {
            id: recipe.id,
            sourceId: recipe.source_id,
            version: recipe.version,
            channel: recipe.channel,
            verificationMethod: recipe.verification_method,
            freshnessAtMs: recipe.freshness_at.getTime(),
            enabled: recipe.enabled,
            signingKeyRef: recipe.signing_key_ref,
            signature: recipe.signature,
            maxAttemptsPerWindow: recipe.max_attempts_per_window,
            windowSeconds: recipe.window_seconds,
          },
    source:
      source === undefined
        ? null
        : {
            name: source.name,
            class: source.class,
            jurisdiction: source.jurisdiction,
            permissionClass: source.permission_class,
            permissionCheckedAtMs:
              source.permission_checked_at === null ? null : source.permission_checked_at.getTime(),
          },
  };
}

export class PostgresCaseQueries implements CaseQueries {
  readonly #keys: RecipeVerificationKeys;

  /**
   * @param keys the recipe verification keys. §5.7.4 reports `guardsEvaluated.recipeSigned`, which is the
   *   outcome of verifying the recipe's signature against the key its `signingKeyRef` names — NOT the presence
   *   of a signature. An empty map (the state of every deployment while ADR-006 is open) therefore reports
   *   `false`, because an unverifiable signature is not a verified one.
   */
  constructor(options: { readonly recipeVerificationKeys: RecipeVerificationKeys }) {
    this.#keys = options.recipeVerificationKeys;
  }

  async listCases(tx: TenantTransaction, params: ListCasesParams): Promise<readonly CaseListRow[]> {
    const [field = 'updatedAt', direction = 'desc'] = params.sort.split(':');
    const sortColumn = SORT_COLUMNS[field] ?? SORT_COLUMNS['updatedAt'];
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
        : // Ordering and pagination truncate together: `created_at`/`updated_at` are `now()`-derived and carry
          // microseconds while a cursor can only carry milliseconds — the defect `ASSUMPTIONS.md` §3.26 records.
          `(${field === 'truthState' ? sortColumn : `date_trunc('milliseconds', ${sortColumn})`}, c.id::text) ${comparison} (${bind(params.after.sortValue)}::${cast}, ${bind(params.after.id)}::text)`;

    const where = [clause.replace(/^WHERE /, ''), keyset].filter((part) => part.length > 0);
    const limitParam = bind(params.limit + 1);
    const nowMs = Date.now();

    const result = await tx.query<RawCaseRow>(
      `SELECT ${CASE_PROJECTION}, ${NEXT_DEADLINE_SQL}
       ${CASE_FROM}
       ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY ${field === 'truthState' ? sortColumn : `date_trunc('milliseconds', ${sortColumn})`} ${order}, c.id ${order}
       LIMIT ${limitParam}`,
      values,
    );
    return result.rows.map((row) => toListRow(row, nowMs));
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

  async getCaseDetail(tx: TenantTransaction, caseId: string): Promise<CaseDetail | undefined> {
    const nowMs = Date.now();
    const base = await tx.query<RawCaseRow>(
      `SELECT ${CASE_PROJECTION}, ${NEXT_DEADLINE_SQL} ${CASE_FROM} WHERE c.id = $1::uuid`,
      [caseId],
    );
    const row = base.rows[0];
    // Absent and another tenant's case reach this same branch by construction (RLS), producing one 404 body.
    if (row === undefined) return undefined;

    // The instant the current state came into effect: the `at` of the transition that moved INTO it, falling
    // back to `created_at` for a case whose state was set at creation (§5.7.1) or before the spine existed.
    const changed = await tx.query<{ changed_at: Date }>(
      `SELECT COALESCE(
                (SELECT a.at FROM audit_event a
                  WHERE a.transition_code IS NOT NULL AND a.case_id = $1::uuid
                    AND a.to_truth_state::text = $2
                  ORDER BY a.at DESC, a.id DESC LIMIT 1),
                c.created_at) AS changed_at
         FROM request_case c WHERE c.id = $1::uuid`,
      [caseId, row.truth_state],
    );

    const last = await tx.query<RawTransitionRow>(
      `SELECT ${TRANSITION_PROJECTION}
         FROM audit_event a
        WHERE a.transition_code IS NOT NULL AND a.case_id = $1::uuid
        ORDER BY a.at DESC, a.id DESC LIMIT 1`,
      [caseId],
    );

    const evidence = await tx.query<{ id: string }>(
      `SELECT e.id::text AS id FROM evidence_artifact e WHERE e.case_id = $1::uuid ORDER BY e.captured_at ASC`,
      [caseId],
    );
    const deadlines = await tx.query<{
      id: string;
      kind: string;
      due_at: Date;
      satisfied_by: string | null;
    }>(
      `SELECT d.id::text AS id, d.kind, d.due_at, d.satisfied_by
         FROM deadline d WHERE d.case_id = $1::uuid ORDER BY d.due_at ASC, d.id ASC`,
      [caseId],
    );
    const responses = await tx.query<{ count: number; latest: string | null }>(
      `SELECT count(*)::int AS count,
              (SELECT r.kind FROM controller_response r WHERE r.case_id = $1::uuid
                ORDER BY r.received_at DESC, r.id DESC LIMIT 1) AS latest
         FROM controller_response r WHERE r.case_id = $1::uuid`,
      [caseId],
    );
    const observations = await tx.query<{ count: number; latest: string | null }>(
      `SELECT count(*)::int AS count,
              (SELECT v.finding FROM verification_observation v WHERE v.case_id = $1::uuid
                ORDER BY v.observed_at DESC, v.id DESC LIMIT 1) AS latest
         FROM verification_observation v WHERE v.case_id = $1::uuid`,
      [caseId],
    );
    const actions = await tx.query<{ count: number; latest: string | null }>(
      `SELECT count(*)::int AS count,
              (SELECT a.status FROM external_action a WHERE a.case_id = $1::uuid
                ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS latest
         FROM external_action a WHERE a.case_id = $1::uuid`,
      [caseId],
    );

    const context = await loadCaseContext(tx, caseId);

    return {
      ...toListRow(row, nowMs),
      truthStateChangedAt: (changed.rows[0]?.changed_at ?? row.created_at).toISOString(),
      rowVersionMs: row.updated_at.getTime(),
      lastTransition: last.rows[0] === undefined ? null : toTransitionRow(last.rows[0]),
      evidenceArtifactIds: evidence.rows.map((entry) => entry.id),
      policyDecision: context?.decision === null || context?.decision === undefined ? null : toPolicyDecision(context.decision),
      recipe: context?.recipe === null || context?.recipe === undefined ? null : toRecipe(context.recipe),
      deadlines: deadlines.rows.map((deadline) => ({
        deadlineId: deadline.id,
        kind: deadline.kind,
        dueAt: deadline.due_at.toISOString(),
        state:
          deadline.satisfied_by !== null
            ? 'SATISFIED'
            : deadline.due_at.getTime() < nowMs
              ? 'BREACHED'
              : 'OPEN',
      })),
      controllerResponses: {
        count: responses.rows[0]?.count ?? 0,
        latestKind: responses.rows[0]?.latest ?? null,
      },
      verificationObservations: {
        count: observations.rows[0]?.count ?? 0,
        latestMethod: observations.rows[0]?.latest ?? null,
      },
      externalActions: { count: actions.rows[0]?.count ?? 0, latestOutcome: actions.rows[0]?.latest ?? null },
    };
  }

  async listTimeline(tx: TenantTransaction, caseId: string): Promise<readonly TimelineEntry[]> {
    // EIGHT BRANCHES, ONE ORDER. Each names a table and ITS OWN instant; `truthStateAfter` is filled only by the
    // TRANSITION branch, because the other seven do not move a truth state.
    const result = await tx.query<{
      at: Date;
      kind: TimelineEntry['kind'];
      ref_id: string;
      truth_state_after: string | null;
      summary: string;
      correlation_id: string | null;
    }>(
      `WITH c AS (SELECT id, exposure_id, source_id FROM request_case WHERE id = $1::uuid)
       SELECT * FROM (
         SELECT a.created_at AS at, 'EXTERNAL_ACTION' AS kind, a.id::text AS ref_id,
                NULL::text AS truth_state_after,
                'ExternalAction ' || a.status || ' via ' || a.channel AS summary,
                NULL::text AS correlation_id
           FROM external_action a WHERE a.case_id = $1::uuid
         UNION ALL
         SELECT r.received_at, 'CONTROLLER_RESPONSE', r.id::text, NULL::text,
                'ControllerResponse ' || r.kind, NULL::text
           FROM controller_response r WHERE r.case_id = $1::uuid
         UNION ALL
         SELECT v.observed_at, 'VERIFICATION_OBSERVATION', v.id::text, NULL::text,
                'VerificationObservation ' || v.method || ' -> ' || v.finding, NULL::text
           FROM verification_observation v WHERE v.case_id = $1::uuid
         UNION ALL
         SELECT a.at, 'TRANSITION', a.id::text, a.to_truth_state::text,
                'Transition ' || a.transition_code || ' -> ' || a.to_truth_state::text,
                a.correlation_id::text
           FROM audit_event a WHERE a.case_id = $1::uuid AND a.transition_code IS NOT NULL
         UNION ALL
         SELECT e.captured_at, 'EVIDENCE_ARTIFACT', e.id::text, NULL::text,
                'EvidenceArtifact ' || e.kind, NULL::text
           FROM evidence_artifact e WHERE e.case_id = $1::uuid
         UNION ALL
         SELECT COALESCE(d.satisfied_at, d.due_at), 'DEADLINE', d.id::text, NULL::text,
                'Deadline ' || d.kind || ' due ' || to_char(d.due_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
                NULL::text
           FROM deadline d WHERE d.case_id = $1::uuid
         UNION ALL
         SELECT rp.observed_at, 'REAPPEARANCE', rp.id::text, NULL::text,
                'Reappearance observed', NULL::text
           FROM reappearance rp
          WHERE rp.exposure_id = (SELECT exposure_id FROM c)
         UNION ALL
         SELECT g.detected_at, 'HUMAN_GATE', g.id::text, NULL::text,
                'HumanGate ' || g.gate_kind || ' -> ' || g.human_queue, NULL::text
           FROM human_gate g WHERE g.case_id = $1::uuid
       ) entries
       ORDER BY at ASC, kind ASC, ref_id ASC`,
      [caseId],
    );
    return result.rows.map((row) => ({
      at: row.at.toISOString(),
      kind: row.kind,
      refId: row.ref_id,
      truthStateAfter: row.truth_state_after,
      summary: row.summary,
      correlationId: row.correlation_id ?? '',
    }));
  }

  async createCase(tx: TenantTransaction, request: CreateCaseRequest): Promise<CreateCaseOutcome> {
    const exposure = await tx.query<{
      truth_state: string;
      subject_id: string;
      source_id: string;
      tenant_id: string;
    }>(
      `SELECT e.truth_state::text AS truth_state, e.subject_id::text AS subject_id,
              sr.source_id::text AS source_id, e.tenant_id::text AS tenant_id
         FROM exposure e JOIN source_record sr ON sr.id = e.source_record_id
        WHERE e.id = $1::uuid`,
      [request.exposureId],
    );
    const exposureRow = exposure.rows[0];
    if (exposureRow === undefined) return { ok: false, reason: 'EXPOSURE_NOT_FOUND' };

    // §5.7.1: "A case is created at the exposure's current truth state". A request that names a different
    // subject or source than the exposure's is refused rather than silently corrected, because the case would
    // otherwise assert a match the exposure does not have.
    if (exposureRow.subject_id !== request.subjectId || exposureRow.source_id !== request.sourceId) {
      return { ok: false, reason: 'CASE_EXPOSURE_STATE_MISMATCH', exposureState: exposureRow.truth_state };
    }
    // `DISCOVERED_CANDIDATE` is not a matched state: a case exists to remove a confirmed match, and §5.7.1
    // refuses `CASE_EXPOSURE_STATE_MISMATCH` rather than opening work on an unassessed candidate.
    if (exposureRow.truth_state === 'DISCOVERED_CANDIDATE') {
      return { ok: false, reason: 'CASE_EXPOSURE_STATE_MISMATCH', exposureState: exposureRow.truth_state };
    }

    const grant = await tx.query<{ scope: string[]; revoked_at: Date | null; expires_at: Date | null }>(
      `SELECT g.scope, g.revoked_at, g.expires_at FROM authority_grant g
        WHERE g.id = $1::uuid AND g.subject_id = $2::uuid`,
      [request.authorityGrantId, request.subjectId],
    );
    const grantRow = grant.rows[0];
    if (grantRow === undefined) return { ok: false, reason: 'AUTHORITY_GRANT_SCOPE_INSUFFICIENT' };
    if (
      grantRow.revoked_at !== null ||
      (grantRow.expires_at !== null && grantRow.expires_at.getTime() <= request.nowMs) ||
      !grantRow.scope.includes('self_service_write')
    ) {
      return { ok: false, reason: 'AUTHORITY_GRANT_SCOPE_INSUFFICIENT' };
    }

    // THE EXISTING CASE IS CHECKED BEFORE THE DECISION, and the order is part of the answer a caller gets. A
    // second create for the same subject × source × exposure is refused `409 CASE_ALREADY_EXISTS`; checking the
    // decision first would answer `422 POLICY_DECISION_INCOMPLETE` instead, because the FIRST create bound that
    // decision to the case it created — a true statement about a different problem, and one that would send the
    // caller looking for a policy defect instead of noticing they already have a case.
    const existing = await tx.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM request_case c
          WHERE c.subject_id = $1::uuid AND c.source_id = $2::uuid AND c.exposure_id = $3::uuid
            AND c.truth_state NOT IN ('VERIFIED_REMOVED','VERIFIED_NOT_PRESENT','NOT_REMOVABLE')
       ) AS present`,
      [request.subjectId, request.sourceId, request.exposureId],
    );
    if (existing.rows[0]?.present === true) return { ok: false, reason: 'CASE_ALREADY_EXISTS' };

    const decision = await tx.query<{ ok: boolean }>(
      `SELECT (d.jurisdiction IS NOT NULL AND d.legal_basis IS NOT NULL AND d.channel IS NOT NULL
               AND d.policy_version IS NOT NULL) AS ok
         FROM policy_decision d WHERE d.id = $1::uuid AND d.case_id IS NULL`,
      [request.policyDecisionId],
    );
    // `case_id IS NULL` on purpose: a decision already bound to another case cannot authorise a second one
    // (VG-POLICY-002's four fields are NOT NULL by construction, so the predicate above is about existence).
    if (decision.rows[0] === undefined) return { ok: false, reason: 'POLICY_DECISION_INCOMPLETE' };

    const recipe = await tx.query<{ enabled: boolean; source_id: string }>(
      `SELECT r.enabled, r.source_id::text AS source_id FROM removal_recipe r WHERE r.id = $1::uuid`,
      [request.recipeId],
    );
    const recipeRow = recipe.rows[0];
    if (recipeRow === undefined || !recipeRow.enabled || recipeRow.source_id !== request.sourceId) {
      return { ok: false, reason: 'RECIPE_NOT_ENABLED' };
    }

    const inserted = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO request_case
         (tenant_id, subject_id, exposure_id, source_id, authority_grant_id, policy_decision_id, recipe_id, truth_state)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::truth_state)
       RETURNING id::text AS id, created_at`,
      [
        request.subjectId,
        request.exposureId,
        request.sourceId,
        request.authorityGrantId,
        request.policyDecisionId,
        request.recipeId,
        exposureRow.truth_state,
      ],
    );
    const created = inserted.rows[0];
    if (created === undefined) return { ok: false, reason: 'CASE_ALREADY_EXISTS' };

    // The decision becomes the case's, so the case can be read as a complete decision (VG-POLICY-002).
    await tx.query(`UPDATE policy_decision SET case_id = $1::uuid WHERE id = $2::uuid`, [
      created.id,
      request.policyDecisionId,
    ]);

    // An audit row WITHOUT transition facts: creation advances no truth state (§5.7.1), and the spine's CHECK
    // makes a transition row that names no transition unrepresentable.
    const event = createAuditEvent({
      id: `${CASE_CREATION_ACTION}:${request.correlationId}:${String(request.nowMs)}`,
      tenantId: new TenantId(exposureRow.tenant_id),
      actor: 'domain-command',
      action: CASE_CREATION_ACTION,
      targetKind: 'RequestCase',
      targetId: created.id,
      correlationId: request.correlationId,
      atMs: request.nowMs,
      payload: {
        subjectId: request.subjectId,
        exposureId: request.exposureId,
        sourceId: request.sourceId,
        authorityGrantId: request.authorityGrantId,
        policyDecisionId: request.policyDecisionId,
        recipeId: request.recipeId,
        truthStateAtCreation: exposureRow.truth_state,
      },
    });
    await appendAuditEvents(tx, [event], { actorKind: 'SERVICE' });

    return {
      ok: true,
      caseId: created.id,
      truthState: exposureRow.truth_state,
      createdAt: created.created_at.toISOString(),
    };
  }

  async guardedUpdate(tx: TenantTransaction, request: GuardedUpdateRequest): Promise<GuardedUpdateOutcome> {
    const context = await loadCaseContext(tx, request.caseId);
    if (context === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (context.rowVersionMs !== request.expectedRowVersionMs) {
      return {
        ok: false,
        reason: 'PRECONDITION_FAILED',
        currentRowVersionMs: context.rowVersionMs,
        truthState: context.truthState,
      };
    }
    if (!ROUTEABLE_CASE_TARGETS.includes(request.requestedTruthState)) {
      return { ok: false, reason: 'TRANSITION_NOT_ROUTEABLE' };
    }
    if (context.decision === null) return { ok: false, reason: 'POLICY_DECISION_INCOMPLETE' };
    if (context.authority === null) return { ok: false, reason: 'AUTHORITY_GRANT_SCOPE_INSUFFICIENT' };
    for (const artifactId of request.evidenceArtifactIds) {
      if (!(await this.#evidenceExists(tx, artifactId))) return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }

    const guards = await this.#evaluateGuards(tx, context, request.nowMs);
    // THE VERIFICATION RESULT GATES THE TRANSITION, rather than being reported beside it. The domain's
    // `prepareRequest` treats "enabled, signature present, fresh" as `recipeSignedAndFresh` — its
    // `assertRecipeUsableAt` cannot verify a signature because the command has no key map — so without this
    // check a case could reach REQUEST_READY on a recipe whose signature nobody verified. §5.3.7 refuses to
    // CREATE such a recipe; this is the same rule at the point of use, and it means a deployment with no
    // verification key (ADR-006 open) cannot prepare a request. That is the honest posture: VG-CHANNEL-003 says
    // an unverified recipe may not authorise a write.
    if (!guards.recipeSigned) return { ok: false, reason: 'GUARD_FAILED', guard: 'recipeSignedAndFresh' };
    const input = await this.#prepareInput(tx, context, request.requestedTruthState, {
      reasonCode: request.reasonCode,
      reasonDetail: request.reasonDetail,
    });

    let result;
    try {
      result = prepareRequest(
        { tenantId: new TenantId(context.tenantId), correlationId: request.correlationId, nowMs: request.nowMs },
        input,
      );
    } catch (error) {
      if (error instanceof IllegalTransition) {
        return {
          ok: false,
          reason: 'ILLEGAL_TRANSITION',
          fromTruthState: context.truthState,
          toTruthState: request.requestedTruthState,
        };
      }
      if (error instanceof GuardNotSatisfied) {
        // The machine names the guard it evaluated; that name is what §5.7.4's `422 GUARD_FAILED` asks for.
        return { ok: false, reason: 'GUARD_FAILED', guard: error.message };
      }
      if (error instanceof DomainError) {
        // Authority and recipe preconditions throw their own domain classes; each maps to the wire code the
        // contract names for it, and an unmapped one is a defect rather than a silent 500.
        return { ok: false, reason: 'GUARD_FAILED', guard: `${error.name}: ${error.message}` };
      }
      throw error;
    }

    // THE COMMAND DECIDED SOMETHING ELSE THAN THE CALLER ASKED FOR. `prepareRequest` produces the state the
    // guard facts justify, and a caller asking for NOT_REMOVABLE from a source that may lawfully be written to
    // would otherwise receive REQUEST_READY — a state it did not request, reported as success. The mismatch is
    // a failed guard on the REQUESTED transition, and nothing has been written at this point.
    if (result.to !== request.requestedTruthState) {
      return {
        ok: false,
        reason: 'GUARD_FAILED',
        guard:
          request.requestedTruthState === 'NOT_REMOVABLE'
            ? 'exemptionRecorded'
            : request.requestedTruthState === 'HUMAN_REQUIRED'
              ? 'humanGateDetected'
              : 'channelPermitted',
      };
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
        evidenceArtifactIds: request.evidenceArtifactIds,
        caseId: request.caseId,
      },
    );

    return {
      ok: true,
      truthState: result.to,
      transitionCode: result.transitionId,
      transitionId: ids[0] ?? '',
      guardsEvaluated: guards,
    };
  }

  async recordHumanGate(tx: TenantTransaction, request: HumanGateRequest): Promise<HumanGateOutcome> {
    const context = await loadCaseContext(tx, request.caseId);
    if (context === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (context.rowVersionMs !== request.expectedRowVersionMs) {
      return {
        ok: false,
        reason: 'PRECONDITION_FAILED',
        currentRowVersionMs: context.rowVersionMs,
        truthState: context.truthState,
      };
    }
    // §5.7.5: "any truthy bypass attempt, or any body containing a bypass artefact … the request is refused and
    // audited, no solver is invoked (VG-DISC-004)". Checked before anything is written.
    if (request.attemptedBypass) return { ok: false, reason: 'BYPASS_ATTEMPT_REFUSED' };
    if (request.evidenceArtifactId !== null && !(await this.#evidenceExists(tx, request.evidenceArtifactId))) {
      return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }
    const routing = routingFor(request.gateKind);
    // An unknown gate kind cannot be routed to a human, and storing it would create a gate nobody is told
    // about. It is refused as an illegal transition because the gate is what would have driven it.
    if (routing === undefined) return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: context.truthState };
    if (context.decision === null) return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: context.truthState };
    if (context.authority === null || context.recipe === null) {
      return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: context.truthState };
    }

    const detectedAtMs = Date.parse(request.detectedAt);
    const serviceLevelDueAt = new Date(detectedAtMs + routing.serviceLevelSeconds * 1000);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO human_gate
         (tenant_id, case_id, gate_kind, detected_at, evidence_artifact_id, attempted_bypass, human_queue, service_level_due_at)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1::uuid, $2, to_timestamp($3::bigint / 1000.0),
               $4::uuid, $5, $6, to_timestamp($7::bigint / 1000.0))
       RETURNING id::text AS id`,
      [
        request.caseId,
        request.gateKind,
        Math.trunc(detectedAtMs),
        request.evidenceArtifactId,
        request.attemptedBypass,
        routing.queue,
        Math.trunc(serviceLevelDueAt.getTime()),
      ],
    );
    const gateId = inserted.rows[0]?.id;
    if (gateId === undefined) return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: context.truthState };

    const input = await this.#prepareInput(tx, context, 'HUMAN_REQUIRED', {
      reasonCode: request.gateKind,
      reasonDetail: `${routing.queue}:${gateId}`,
    });

    let result;
    try {
      result = prepareRequest(
        { tenantId: new TenantId(context.tenantId), correlationId: request.correlationId, nowMs: request.nowMs },
        input,
      );
    } catch (error) {
      if (error instanceof DomainError) {
        // The gate row is already written and the transition is not: a human gate that could not move the case
        // still HAPPENED, and the row is the record of it. The refusal reports the state so the caller can see
        // the gate without the transition.
        return { ok: false, reason: 'ILLEGAL_TRANSITION', fromTruthState: context.truthState };
      }
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
    void ids;

    return {
      ok: true,
      truthState: result.to,
      transitionCode: result.transitionId,
      gateId,
      humanQueue: routing.queue,
      serviceLevelDueAt: serviceLevelDueAt.toISOString(),
    };
  }

  async #evidenceExists(tx: TenantTransaction, evidenceArtifactId: string): Promise<boolean> {
    if (!UUID_SHAPE.test(evidenceArtifactId)) return false;
    const result = await tx.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM evidence_artifact e WHERE e.id = $1::uuid) AS present`,
      [evidenceArtifactId],
    );
    return result.rows[0]?.present === true;
  }

  /** The six facts §5.7.4 reports, each computed from rows rather than asserted. */
  async #evaluateGuards(
    tx: TenantTransaction,
    context: CaseContext,
    nowMs: number,
  ): Promise<GuardsEvaluated> {
    const authority = context.authority;
    const authorityValid =
      authority !== null &&
      authority.revokedAtMs === null &&
      (authority.expiresAtMs === null || authority.expiresAtMs > nowMs) &&
      authority.scope.includes('self_service_write');

    const decision = context.decision;
    const policyDecisionComplete =
      decision !== null &&
      decision.jurisdiction.length > 0 &&
      decision.legalBasis.length > 0 &&
      decision.channel.length > 0 &&
      decision.version >= 1;

    const recipe = context.recipe;
    let recipeSigned = false;
    if (recipe !== null && recipe.signature !== null && recipe.signingKeyRef !== null) {
      const verdict = verifyRecipeSignature(
        {
          signingKeyRef: recipe.signingKeyRef,
          signature: recipe.signature,
          payload: canonicalRecipePayload({
            sourceId: recipe.sourceId,
            channel: recipe.channel,
            verificationMethod: recipe.verificationMethod,
            signingKeyRef: recipe.signingKeyRef,
            freshnessAt: new Date(recipe.freshnessAtMs).toISOString(),
            maxAttemptsPerWindow: recipe.maxAttemptsPerWindow ?? 0,
            windowSeconds: recipe.windowSeconds ?? 0,
          }),
        },
        this.#keys,
      );
      recipeSigned = verdict === 'VERIFIED';
    }
    const recipeFresh = recipe !== null && recipe.freshnessAtMs > nowMs;

    // The channel is permitted when the policy decision names a channel the source may be written to, which is
    // the same pair of facts §5.3.4 gates writes on: a `WRITE_PERMITTED` source and a decision whose channel is
    // a real removal channel rather than the NOT_REMOVABLE outcome.
    const source = await tx.query<{ permission_class: string }>(
      `SELECT s.permission_class::text AS permission_class FROM source s WHERE s.id = $1::uuid`,
      [context.sourceId],
    );
    const channelPermitted =
      source.rows[0]?.permission_class === 'WRITE_PERMITTED' &&
      decision !== null &&
      decision.channel !== 'NOT_REMOVABLE_OUTCOME';

    // VG-ACTION-005's budget: attempts inside the recipe's window for this subject × source.
    let budgetAvailable = true;
    if (recipe !== null && recipe.maxAttemptsPerWindow !== null && recipe.windowSeconds !== null) {
      const used = await tx.query<{ used: number }>(
        `SELECT count(*)::int AS used
           FROM external_action a
          WHERE a.case_id IN (SELECT c2.id FROM request_case c2 WHERE c2.subject_id = $1::uuid AND c2.source_id = $2::uuid)
            AND a.created_at > now() - make_interval(secs => $3::int)`,
        [context.subjectId, context.sourceId, recipe.windowSeconds],
      );
      budgetAvailable = (used.rows[0]?.used ?? 0) < recipe.maxAttemptsPerWindow;
    }

    return { authorityValid, policyDecisionComplete, recipeSigned, recipeFresh, channelPermitted, budgetAvailable };
  }

  /** Build the one command input that produces the requested state, from rows rather than from the request. */
  async #prepareInput(
    tx: TenantTransaction,
    context: CaseContext,
    requested: string,
    reason: { readonly reasonCode: string; readonly reasonDetail: string },
  ): Promise<PrepareRequestInput> {
    const authority = context.authority;
    const decision = context.decision;
    const recipe = context.recipe;
    const source = context.source;
    if (authority === null || decision === null || recipe === null || source === null) {
      throw new Error('prepareInput requires a case with an authority, a decision, a recipe and a source');
    }
    const tenantId = new TenantId(context.tenantId);

    // The policy version the decision was resolved against, loaded so the command can RE-ASSERT it at this
    // moment rather than remember it (VG-POLICY-001). A version that is no longer in force makes
    // `assertPolicyInForce` throw `GuardNotSatisfied`, which the caller reports as GUARD_FAILED.
    const policyRow = await tx.query<{
      id: string;
      jurisdiction: string;
      version: number;
      effective_from: Date;
      effective_to: Date | null;
      rules: string[];
      provenance: string;
    }>(
      `SELECT p.id::text AS id, p.jurisdiction, p.version, p.effective_from, p.effective_to, p.rules, p.provenance
         FROM jurisdiction_policy p WHERE p.jurisdiction = $1 AND p.version = $2`,
      [decision.jurisdiction, decision.version],
    );
    const policy = policyRow.rows[0];
    if (policy === undefined) {
      throw new GuardNotSatisfied(
        'ResolvePolicy',
        `policy version ${String(decision.version)} for ${decision.jurisdiction} is not recorded, so the decision cannot be re-asserted`,
      );
    }

    // The channel options ARE the decision's channel: §5.8.2 refuses a body naming a channel other than the
    // decision's, so a case may only be prepared for the channel its decision names. The option is marked
    // unavailable exactly when the source may not be written to, which is the fact T6/T10/T13/T15/T19's guard is
    // about — so a request for NOT_REMOVABLE from a writable source cannot produce one, and the caller is told
    // GUARD_FAILED rather than being handed a state it did not ask for.
    const channelOptions: readonly ChannelOption[] = [
      {
        channel: decision.channel as ChannelName,
        unavailableKind: source.permissionClass === 'WRITE_PERMITTED' ? null : 'UNLAWFUL',
        unavailableReason:
          source.permissionClass === 'WRITE_PERMITTED' ? null : 'source permission class does not permit writes',
      },
    ];

    return {
      caseId: context.caseId,
      from: context.truthState,
      authority: createAuthorityGrant({
        id: authority.id,
        tenantId,
        subjectId: new SubjectId(context.subjectId),
        kind: authority.kind as AuthorityKind,
        scope: authority.scope,
        evidenceId: null,
        issuedAtMs: authority.issuedAtMs,
        // The entity requires a NUMBER for expiry, while the column is nullable. A grant with no recorded expiry is
        // represented by Number.MAX_SAFE_INTEGER — the latest instant this runtime can express — rather than by
        // substituting the current time, which would make a live grant look expired.
        expiresAtMs: authority.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
        revokedAtMs: authority.revokedAtMs,
        signedInstrument: false,
      }),
      decision: createPolicyDecision({
        id: decision.id,
        tenantId,
        caseId: context.caseId,
        jurisdiction: new Jurisdiction(decision.jurisdiction),
        legalBasis: new LegalBasis(decision.legalBasis, decision.version),
        channel: decision.channel as ChannelName,
        policyVersion: decision.version,
        reasons: decision.reasons,
        decidedAtMs: decision.decidedAtMs,
      }),
      policy: createJurisdictionPolicy({
        id: policy.id,
        tenantId,
        jurisdiction: new Jurisdiction(policy.jurisdiction),
        version: policy.version,
        effectiveFromMs: policy.effective_from.getTime(),
        effectiveToMs: policy.effective_to === null ? null : policy.effective_to.getTime(),
        rules: [...policy.rules],
        provenance: policy.provenance as PolicyProvenance,
      }),
      recipe: createRemovalRecipe({
        id: new RecipeId(recipe.id),
        tenantId,
        sourceId: new SourceId(recipe.sourceId),
        version: recipe.version,
        // The column is `bytea`; the domain wants a non-empty string, so the bytes are rendered base64 — the
        // same value in a text form. A missing signature is refused by `assertRecipeUsableAt`.
        signature: recipe.signature === null ? '' : Buffer.from(recipe.signature).toString('base64'),
        channel: recipe.channel as ChannelName,
        verificationMethod: recipe.verificationMethod,
        freshnessAtMs: recipe.freshnessAtMs,
        enabled: recipe.enabled,
      }),
      source: createSource({
        id: new SourceId(context.sourceId),
        tenantId,
        name: source.name,
        class: source.class,
        jurisdiction: source.jurisdiction === null ? null : new Jurisdiction(source.jurisdiction),
        permissionClass: source.permissionClass as PermissionClass,
        permissionCheckedAtMs: source.permissionCheckedAtMs,
      }),
      channelOptions,
      humanGate:
        requested === 'HUMAN_REQUIRED'
          ? { gateKind: reason.reasonCode, reason: reason.reasonDetail }
          : null,
      exemptionRecorded: requested === 'NOT_REMOVABLE',
    };
  }
}

/** The transition projection, restated here so the case detail reads the spine the same way §5.5.5 does. */
const TRANSITION_PROJECTION = `
  a.id::text                        AS transition_id,
  a.transition_code                 AS transition_code,
  a.from_truth_state::text          AS from_truth_state,
  a.to_truth_state::text            AS to_truth_state,
  a.at                              AS occurred_at,
  a.actor                           AS actor_identity,
  a.action                          AS command,
  a.evidence_artifact_ids           AS evidence_artifact_ids,
  a.correlation_id::text            AS correlation_id`;

interface RawTransitionRow {
  readonly transition_id: string;
  readonly transition_code: string;
  readonly from_truth_state: string | null;
  readonly to_truth_state: string;
  readonly occurred_at: Date;
  readonly actor_identity: string;
  readonly command: string;
  readonly evidence_artifact_ids: readonly string[] | null;
  readonly correlation_id: string;
}

function toTransitionRow(row: RawTransitionRow): TransitionRow {
  return {
    transitionId: row.transition_id,
    transitionCode: row.transition_code,
    fromTruthState: row.from_truth_state,
    toTruthState: row.to_truth_state,
    occurredAt: row.occurred_at.toISOString(),
    actorIdentity: row.actor_identity,
    command: row.command,
    evidenceArtifactIds: row.evidence_artifact_ids ?? [],
    correlationId: row.correlation_id,
  };
}

function toPolicyDecision(decision: {
  readonly id: string;
  readonly jurisdiction: string;
  readonly legalBasis: string;
  readonly channel: string;
  readonly version: number;
  readonly decidedAtMs: number;
}): CasePolicyDecision {
  return {
    policyDecisionId: decision.id,
    jurisdiction: decision.jurisdiction,
    legalBasis: decision.legalBasis,
    channel: decision.channel,
    // SPEC-003's examples render `policyVersion` as a date string while both version columns are integers
    // (ASSUMPTIONS §3.23). §5.7 only REPORTS it, so rendering the integer as its string form satisfies the
    // field without inventing a second version concept.
    policyVersion: String(decision.version),
    decidedAt: new Date(decision.decidedAtMs).toISOString(),
  };
}

function toRecipe(recipe: {
  readonly id: string;
  readonly version: number;
  readonly channel: string;
  readonly enabled: boolean;
  readonly freshnessAtMs: number;
  readonly signature: Buffer | null;
}): CaseRecipe {
  return {
    recipeId: recipe.id,
    version: recipe.version,
    channel: recipe.channel,
    enabled: recipe.enabled,
    freshnessAt: new Date(recipe.freshnessAtMs).toISOString(),
    fresh: recipe.freshnessAtMs > Date.now(),
    signaturePresent: recipe.signature !== null && recipe.signature.length > 0,
  };
}
