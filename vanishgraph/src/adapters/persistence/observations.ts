/**
 * The PostgreSQL observation and reappearance read models (SPEC-003 §5.10.2/§5.10.3, §5.11.2/§5.11.3).
 *
 * Implements `ObservationQueries` from the application layer. The DTO types come from the port, so a handler
 * that imports them never acquires a dependency on this file.
 *
 * READ-ONLY: this class issues only `SELECT`. The write paths for these aggregates (§5.10.1, §5.11.1) drive
 * domain transitions belong to a later milestone of this node — they need the transition record that
 * `ASSUMPTIONS.md` §3.18 records as unspecified.
 *
 * TENANT SCOPING IS NOT DONE HERE: every statement relies on RLS, and both tables carry FORCE RLS. One
 * consequence is deliberate and worth naming: `evidence_artifact` is joined for its id only, and RLS means a
 * reference to another tenant's artifact simply does not resolve — so a cross-tenant citation reads as an
 * absence rather than as a foreign row.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import type {
  ListReappearancesParams,
  ObservationQueries,
  ReappearanceRow,
  VerificationObservationRow,
} from '../../application/contracts/observation-queries.ts';
import { FINDING_TO_API, REENTRY_RULES, RE_ENTRY_STATE_SQL } from '../../application/contracts/observation-queries.ts';

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
}
