/**
 * The transition read model against PostgreSQL (SPEC-003 §5.5.5, §5.7.3, §5.7.6).
 *
 * ONE PROJECTION, THREE QUERIES. Every read below selects the same columns through `TRANSITION_PROJECTION`
 * and maps them through the same `toTransitionRow`, so a field cannot be reported from one route and omitted
 * from another. The only differences are the predicate and the direction.
 *
 * WHY AN EXPOSURE'S HISTORY NEEDS A UNION, AND WHY THE CASE IS A COLUMN. `audit_event.target_id` names the
 * resource the command acted on — the exposure for T1/T3/T4 (§5.5's assessment routes act on an exposure)
 * and, for a T8, the external action, exactly as the seed records it. An exposure's history that selected
 * only `target_kind = 'Exposure'` would stop at `MATCH_CONFIRMED` and report an exposure as never requested,
 * never acknowledged and never verified, which is the opposite of what a history is for; a case's history
 * that selected only `target_kind = 'RequestCase'` would lose its T8. So migration 0019 records `case_id` on
 * the transition row, and both reads use it: an exposure reaches its cases through `request_case.exposure_id`
 * and a case is matched by the FK directly. Both tables are under FORCE RLS, so neither join can cross a
 * tenant boundary even if the ids were guessed.
 *
 * `transition_code IS NOT NULL` IS THE DEFINITION OF A TRANSITION ROW. The append path also writes audit rows
 * for non-transition content (the port's own documentation says so), and those rows carry no code and no
 * states. Including them would make §5.5.5's history a list of audit rows; excluding them is what makes it a
 * list of state changes.
 *
 * OLDEST FIRST, and there is no `LIMIT`: a transition history for one resource is bounded by the twenty-one
 * transitions SPEC-001 §4.1 defines, and a caller that paginated it would be paginating a page.
 */

import type {
  TransitionQueries,
  TransitionRow,
} from '../../application/contracts/transition-queries.ts';
import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

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

function toTransitionRow(row: RawTransitionRow): TransitionRow {
  return {
    transitionId: row.transition_id,
    transitionCode: row.transition_code,
    fromTruthState: row.from_truth_state,
    toTruthState: row.to_truth_state,
    // `at` is written from an integer millisecond value, so this rendering is exact rather than truncated —
    // see the note in the port. `toISOString()` also normalises the driver's `Date` to the RFC 3339 instant
    // §5.5.5's example shows.
    occurredAt: row.occurred_at.toISOString(),
    actorIdentity: row.actor_identity,
    command: row.command,
    // SQL NULL and `'{}'` both mean "no artifact id recorded" here. The column's CHECK refuses an empty
    // array, so NULL is what the append path stores for a transition whose evidence is a record rather than
    // an artifact; the wire contract shows a list, and an empty list is the honest rendering of both.
    evidenceArtifactIds: row.evidence_artifact_ids ?? [],
    correlationId: row.correlation_id,
  };
}

export class PostgresTransitionQueries implements TransitionQueries {
  async listTransitionsForExposure(
    tx: TenantTransaction,
    exposureId: string,
  ): Promise<readonly TransitionRow[]> {
    const result = await tx.query<RawTransitionRow>(
      `SELECT ${TRANSITION_PROJECTION}
         FROM audit_event a
        WHERE a.transition_code IS NOT NULL
          AND (
            (a.target_kind = 'Exposure' AND a.target_id = $1::uuid)
            OR a.case_id IN (SELECT c.id FROM request_case c WHERE c.exposure_id = $1::uuid)
          )
        ORDER BY a.at ASC, a.id ASC`,
      [exposureId],
    );
    return result.rows.map(toTransitionRow);
  }

  async listTransitionsForCase(tx: TenantTransaction, caseId: string): Promise<readonly TransitionRow[]> {
    const result = await tx.query<RawTransitionRow>(
      `SELECT ${TRANSITION_PROJECTION}
         FROM audit_event a
        WHERE a.transition_code IS NOT NULL
          AND a.case_id = $1::uuid
        ORDER BY a.at ASC, a.id ASC`,
      [caseId],
    );
    return result.rows.map(toTransitionRow);
  }

  async lastTransitionForCase(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<TransitionRow | undefined> {
    // Newest first, ONE row. `id DESC` breaks a tie between two transitions recorded in the same millisecond,
    // which is what makes "the last transition" a fact rather than a coin toss.
    const result = await tx.query<RawTransitionRow>(
      `SELECT ${TRANSITION_PROJECTION}
         FROM audit_event a
        WHERE a.transition_code IS NOT NULL
          AND a.case_id = $1::uuid
        ORDER BY a.at DESC, a.id DESC
        LIMIT 1`,
      [caseId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toTransitionRow(row);
  }
}
