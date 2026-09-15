/**
 * The PostgreSQL appeal-escalation model (SPEC-003 §5.14).
 *
 * Implements `AppealQueries` from the application layer. The DTO TYPES come from the port, so a handler
 * that imports them never acquires a dependency on this file — which keeps `src/http/**` free of adapter
 * imports (ARCHITECTURE.md §2).
 *
 * TENANT SCOPING IS NOT DONE HERE. Every statement relies on RLS: the runner has already set
 * `app.tenant_id`, and these tables carry FORCE RLS. The two `INSERT`s supply the tenant from
 * `current_setting('app.tenant_id', true)`, which the policy's WITH CHECK then verifies — so a sink that
 * tried to write another tenant's row would be refused by the database rather than by this code.
 *
 * `externalEffect: false` IS NOT A COLUMN, AND THAT IS DELIBERATE. SPEC-003 §5.14.1 returns it on the
 * created record to state that "creating the record does not send anything"; sending is a separate §5.8.2
 * action with its own idempotency key. So the value is a property of the CREATION EVENT, always false at
 * creation, and never a property of the row that could later become true — storing it would create a
 * column whose true value would mean "this escalation was sent", which is exactly the fact §5.14.1 says
 * lives in `external_action` instead. The route returns the literal `false`; see `routes/appeals.ts`.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import type {
  AppealEscalationRow,
  AppealQueries,
  CasePrecondition,
  CreateAppealInput,
  ReviewState,
} from '../../application/contracts/appeal-queries.ts';

interface RawAppealRow {
  id: string;
  case_id: string;
  kind: string;
  requires_human_review: boolean;
  review_state: string;
  artifact_ids: string[] | null;
  created_at: Date;
}

function toRow(row: RawAppealRow): AppealEscalationRow {
  return {
    appealEscalationId: row.id,
    caseId: row.case_id,
    kind: row.kind,
    requiresHumanReview: row.requires_human_review,
    // The column's CHECK admits exactly one value, so this cast cannot invent a state. It is written as
    // a cast rather than a default so that a schema change adding a token fails the type here instead of
    // silently reporting the new token as PENDING_COUNSEL_REVIEW.
    reviewState: row.review_state as ReviewState,
    // `artifact_ids` is `text[]` and NOT NULL in the schema, but a defensive `?? []` is avoided on
    // purpose: an absent array would mean the row cannot answer §5.14.1's `artifactIds`, and returning an
    // empty list would say "this escalation cites no artifacts" — a different and false statement.
    artifactIds: row.artifact_ids ?? [],
    createdAt: row.created_at.toISOString(),
  };
}

const APPEAL_PROJECTION = `
  e.id::text            AS id,
  e.case_id::text       AS case_id,
  e.kind                AS kind,
  e.requires_human_review AS requires_human_review,
  e.review_state        AS review_state,
  e.artifact_ids        AS artifact_ids,
  e.created_at          AS created_at
`;

export class PostgresAppealQueries implements AppealQueries {
  async casePrecondition(tx: TenantTransaction, caseId: string): Promise<CasePrecondition | undefined> {
    // `truth_state` and `updated_at` are selected TOGETHER, in one statement, because §2.7's ETag is
    // `"<truthState>:<updatedAtEpochMillis>"` and reading them separately would let the two halves come
    // from different row versions — a precondition checked against a token the resource never had.
    const result = await tx.query<{ id: string; truth_state: string; updated_at: Date }>(
      `SELECT c.id::text AS id, c.truth_state::text AS truth_state, c.updated_at
         FROM request_case c WHERE c.id = $1::uuid`,
      [caseId],
    );
    const row = result.rows[0];
    // Absent and another tenant's case are INDISTINGUISHABLE by construction: RLS means another tenant's
    // row is not returned, so both reach this branch and produce one 404 body (SPEC-006 H-9).
    if (row === undefined) return undefined;
    return { caseId: row.id, truthState: row.truth_state, updatedAtMs: row.updated_at.getTime() };
  }

  async appealWindowClosed(tx: TenantTransaction, caseId: string, nowMs: number): Promise<boolean> {
    const result = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM deadline d
        WHERE d.case_id = $1::uuid
          AND d.kind = 'APPEAL_WINDOW'
          AND d.due_at < to_timestamp($2::bigint / 1000.0)`,
      [caseId, Math.trunc(nowMs)],
    );
    // A case with NO APPEAL_WINDOW deadline is NOT refused: there is no window to have closed, and
    // refusing would make every escalation on such a case fail with an error SPEC-003 §5.14.1 does not
    // describe. A case with one whose `due_at` has passed IS refused.
    return result.rows[0]?.n !== '0';
  }

  async listAppealEscalations(tx: TenantTransaction, caseId: string): Promise<readonly AppealEscalationRow[]> {
    const result = await tx.query<RawAppealRow>(
      `SELECT ${APPEAL_PROJECTION}
         FROM appeal_escalation e
        WHERE e.case_id = $1::uuid
        ORDER BY e.created_at DESC, e.id DESC`,
      [caseId],
    );
    return result.rows.map(toRow);
  }

  async getAppealEscalation(
    tx: TenantTransaction,
    appealEscalationId: string,
  ): Promise<AppealEscalationRow | undefined> {
    const result = await tx.query<RawAppealRow>(
      `SELECT ${APPEAL_PROJECTION} FROM appeal_escalation e WHERE e.id = $1::uuid`,
      [appealEscalationId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRow(row);
  }

  async createAppealEscalation(
    tx: TenantTransaction,
    caseId: string,
    input: CreateAppealInput,
  ): Promise<
    | { readonly ok: true; readonly value: { readonly appealEscalationId: string; readonly createdAt: string } }
    | { readonly ok: false; readonly reason: 'CASE_NOT_FOUND' | 'WINDOW_CLOSED' }
  > {
    // The case's existence is established by the INSERT's SELECT rather than by a preceding statement, so
    // a case deleted between a check and the insert cannot leave an escalation pointing at nothing. Under
    // RLS the lookup sees only this tenant's cases, so another tenant's case id is CASE_NOT_FOUND rather
    // than a cross-tenant reference.
    //
    // The window check runs BEFORE the insert and in the same transaction: an escalation created after its
    // window closed is exactly what APPEAL_WINDOW_CLOSED exists to refuse, and checking it afterwards would
    // mean deleting a row the caller was told was created.
    const windowClosed = await this.appealWindowClosed(tx, caseId, Date.now());
    if (windowClosed) {
      const exists = await tx.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM request_case c WHERE c.id = $1::uuid',
        [caseId],
      );
      // Window-closed is only reported for a case that EXISTS: reporting it for an absent case would
      // confirm the window's existence to a caller who cannot see the case at all (SPEC-006 H-9).
      if (exists.rows[0]?.n !== '0') return { ok: false, reason: 'WINDOW_CLOSED' };
    }

    const inserted = await tx.query<{ id: string; created_at: Date }>(
      // `$4::uuid[]` and NOT `text[]`. MEASURED: the column is `uuid[]`, and binding a JS string array as
      // `text[]` fails at runtime with `column "artifact_ids" is of type uuid[] but expression is of type
      // text[]` — which surfaced as a 500, because a query error class the handler does not map becomes
      // INTERNAL_ERROR. `information_schema.columns.data_type` reports only `ARRAY` for any array, so the
      // element type has to be read from `udt_name`; the cast is written to the element type explicitly so
      // a future mismatch fails here rather than in a response.
      //
      // The boundary has already refused anything that is not UUID-shaped (`optionalUuid`), so this cast
      // cannot fail on caller input — and if it ever did, the refusal would be the correct outcome.
      `INSERT INTO appeal_escalation
         (tenant_id, case_id, kind, requires_human_review, artifact_ids)
       SELECT current_setting('app.tenant_id', true)::uuid, $1::uuid, $2, $3, $4::uuid[]
        WHERE EXISTS (SELECT 1 FROM request_case c WHERE c.id = $1::uuid)
       RETURNING id::text AS id, created_at`,
      [caseId, input.kind, input.requiresHumanReview, [...input.artifactIds]],
    );
    const row = inserted.rows[0];
    if (row === undefined) return { ok: false, reason: 'CASE_NOT_FOUND' };

    // `review_state` is NOT set here. The column's DEFAULT is 'PENDING_COUNSEL_REVIEW' and its CHECK
    // admits only that value, so naming it in the INSERT would add a second place the value is written —
    // and a second place is where the two can disagree. The database states the invariant once.
    return { ok: true, value: { appealEscalationId: row.id, createdAt: row.created_at.toISOString() } };
  }
}

/**
 * The review state a newly created escalation carries.
 *
 * Exported so the route returns the SAME value the database default records, from one definition. If the
 * two ever diverge, the response would report a state the row does not have — and §5.14.1's refusal to
 * treat a pending escalation as sendable is decided on the stored value.
 */
export const CREATED_REVIEW_STATE: ReviewState = 'PENDING_COUNSEL_REVIEW';
