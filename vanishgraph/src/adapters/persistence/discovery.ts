/**
 * Candidate records against PostgreSQL (SPEC-003 §5.4.4, §5.4.5).
 *
 * THE ASSESSMENT STATE IS COMPUTED IN SQL, not filtered in JavaScript afterwards. Filtering after the fetch would
 * silently break pagination: a page of 25 rows could filter down to 3, `hasMore` would be minted from the unfiltered
 * tail, and a caller would walk a collection that skips rows. The CASE expression below is therefore shared by the
 * SELECT and the WHERE clause, from one constant.
 *
 * THE COVERAGE BOUNDS COME FROM `coverage_report`, which is the table of record §5.16 introduced. A subject with no
 * report gets `applies: false` and THREE NULLS rather than zeros: "nothing was attempted" is a measurement, and no
 * report is the absence of one (VG-DISC-002).
 */

import type {
  CandidateCoverage,
  CandidateRecordRow,
  DiscoveryQueries,
  ListCandidateRecordsParams,
  SourceRecordDetail,
} from '../../application/contracts/discovery-queries.ts';
import { SEARCH_ENGINE_SOURCE_CLASS } from '../../application/contracts/exposure-queries.ts';
import { maskRawRef } from '../masking.ts';
import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/**
 * The assessment state, derived from the exposure's truth state and the record's source class.
 *
 * `SEARCH_ENGINE` FIRST: VG-IDENT-004 makes a search hit never a subject match, so such a record is UNASSESSED and
 * carries no exposure whatever else is true of it. Everything at or past `MATCH_CONFIRMED` reports
 * `MATCH_CONFIRMED`, which is the widest statement the four-token vocabulary can make.
 */
const ASSESSMENT_CASE = `
  CASE
    WHEN s.class = '${SEARCH_ENGINE_SOURCE_CLASS}' THEN 'UNASSESSED'
    WHEN e.id IS NULL THEN 'UNASSESSED'
    WHEN e.truth_state = 'DISCOVERED_CANDIDATE' THEN 'UNASSESSED'
    ELSE 'MATCH_CONFIRMED'
  END`;

interface RawCandidate {
  id: string;
  source_id: string;
  observed_at: Date;
  content_hash: string;
  tainted: boolean;
  raw_ref: string;
  assessment_state: string;
  exposure_id: string | null;
  source_class: string;
}

export class PostgresDiscoveryQueries implements DiscoveryQueries {
  async listCandidateRecords(
    tx: TenantTransaction,
    params: ListCandidateRecordsParams,
  ): Promise<{ readonly rows: readonly CandidateRecordRow[]; readonly coverage: CandidateCoverage }> {
    const descending = params.sort.endsWith(':desc');
    const direction = descending ? 'DESC' : 'ASC';
    const comparison = descending ? '<' : '>';
    const byHash = params.sort.startsWith('contentHash');
    // §5.4.4's two sort fields, each with deterministic tiebreakers so two rows sharing a value still have ONE
    // order — without that, a page boundary between them can repeat or skip a row.
    const orderBy = byHash
      ? `sr.content_hash ${direction}, sr.observed_at ${direction}, sr.id ${direction}`
      : `sr.observed_at ${direction}, sr.id ${direction}`;
    const assessmentFilter = params.filters.assessmentState;
    const sourceFilter = params.filters.sourceId;

    // THE KEYSET CLAUSE AND ITS PARAMETERS ARE BUILT TOGETHER, and MEASURED: the first version always passed the
    // keyset parameters and only sometimes referenced them, so PostgreSQL refused the statement with
    // `could not determine data type of parameter $6` — a bind parameter that appears nowhere in the text has no
    // type to infer. The two branches below therefore differ in BOTH the clause and the array.
    const filterParams: readonly unknown[] = [
      params.subjectId,
      new Date(params.filters.fromMs),
      new Date(params.filters.toMs),
      sourceFilter,
      assessmentFilter === null ? null : [...assessmentFilter],
    ];
    const after = params.after;
    let keysetSql = '';
    let keysetParams: readonly unknown[] = [];
    if (after !== undefined) {
      if (byHash) {
        // The cursor carries the ORDERING TUPLE for this sort: `contentHash:observedAtMs`, minted by the route from
        // the row's own `cursorValue`. Comparing on the hash alone would be wrong — two records can share a hash.
        const [hash = '', ms = '0'] = String(after.sortValue).split(':');
        keysetSql = `AND (sr.content_hash, sr.observed_at, sr.id) ${comparison} ($6::text, to_timestamp($7::bigint / 1000.0), $8::uuid)`;
        keysetParams = [hash, Math.trunc(Number(ms)), after.id];
      } else {
        keysetSql = `AND (sr.observed_at, sr.id) ${comparison} (to_timestamp($6::bigint / 1000.0), $7::uuid)`;
        keysetParams = [Math.trunc(Number(after.sortValue)), after.id];
      }
    }
    const limitParam = `$${String(filterParams.length + keysetParams.length + 1)}`;

    const result = await tx.query<RawCandidate>(
      `SELECT sr.id::text AS id, sr.source_id::text AS source_id, sr.observed_at,
              sr.content_hash::text AS content_hash, sr.tainted, sr.raw_ref,
              ${ASSESSMENT_CASE} AS assessment_state,
              CASE WHEN s.class = '${SEARCH_ENGINE_SOURCE_CLASS}' THEN NULL ELSE e.id::text END AS exposure_id,
              s.class AS source_class
         FROM source_record sr
         JOIN source s ON s.id = sr.source_id
         -- AN INNER JOIN, AND THE SUBJECT FILTER LIVES IN IT. MEASURED DEFECT this corrects: with a LEFT JOIN the
         -- WHERE clause had no subject predicate at all, so the listing returned EVERY record in the tenant — the
         -- join condition only decided whether an exposure was attached. A record with no exposure cannot be
         -- attributed to a subject by anything this schema holds (the run link is exactly what §5.4.1 would add and
         -- no specification defines), so the honest answer is that it is not in this subject's list.
         JOIN exposure e ON e.source_record_id = sr.id AND e.subject_id = $1::uuid
        WHERE sr.observed_at >= $2::timestamptz AND sr.observed_at < $3::timestamptz
          AND ($4::uuid IS NULL OR sr.source_id = $4::uuid)
          AND ($5::text[] IS NULL OR (${ASSESSMENT_CASE}) = ANY ($5::text[]))
          ${keysetSql}
        ORDER BY ${orderBy}
        LIMIT ${limitParam}`,
      [...filterParams, ...keysetParams, params.limit + 1],
    );

    const coverage = await this.#coverageFor(tx, params.subjectId);
    return {
      rows: result.rows.map((row) => ({
        sourceRecordId: row.id,
        sourceId: row.source_id,
        observedAt: row.observed_at.toISOString(),
        contentHash: row.content_hash.trim(),
        taint: row.tainted ? 'TAINTED' : 'UNTAINTED',
        // Masked by construction: the returned value is built from the scheme and host alone, so a path cannot leak
        // through a projection mistake.
        rawRefMasked: maskRawRef(row.raw_ref),
        assessmentState: row.assessment_state,
        exposureId: row.exposure_id,
        // THE ORDERING TUPLE for the sort that was applied: the hash and the instant when sorting by hash (the
        // route renders it as `hash:ms`), the instant alone otherwise.
        cursorValue: byHash
          ? `${row.content_hash.trim()}:${String(row.observed_at.getTime())}`
          : row.observed_at.getTime(),
      })),
      coverage,
    };
  }

  async getSourceRecord(tx: TenantTransaction, sourceRecordId: string): Promise<SourceRecordDetail | undefined> {
    const result = await tx.query<RawCandidate>(
      `SELECT sr.id::text AS id, sr.source_id::text AS source_id, sr.observed_at,
              sr.content_hash::text AS content_hash, sr.tainted, sr.raw_ref,
              ${ASSESSMENT_CASE} AS assessment_state,
              CASE WHEN s.class = '${SEARCH_ENGINE_SOURCE_CLASS}' THEN NULL ELSE e.id::text END AS exposure_id,
              s.class AS source_class
         FROM source_record sr
         JOIN source s ON s.id = sr.source_id
         -- Not subject-scoped: §5.4.5 reads ONE record's metadata, and the record's own assessment is what its
         -- exposures say. A record observed for two subjects reports the first exposure's state, which is a
         -- limitation of a field that is not stored per subject — recorded in ASSUMPTIONS §3.39.
         LEFT JOIN exposure e ON e.source_record_id = sr.id
        WHERE sr.id = $1::uuid
        ORDER BY e.created_at ASC
        LIMIT 1`,
      [sourceRecordId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      sourceRecordId: row.id,
      sourceId: row.source_id,
      observedAt: row.observed_at.toISOString(),
      contentHash: row.content_hash.trim(),
      taint: row.tainted ? 'TAINTED' : 'UNTAINTED',
      taintReason: row.tainted ? 'UNTRUSTED_REMOTE_CONTENT' : null,
      rawRef: row.raw_ref,
      discoveryRunId: null,
      assessmentState: row.assessment_state,
    };
  }

  async #coverageFor(tx: TenantTransaction, subjectId: string): Promise<CandidateCoverage> {
    const result = await tx.query<{ sources_total: number; sources_attempted: number; complete: boolean }>(
      `SELECT r.sources_total, r.sources_attempted, r.complete
         FROM coverage_report r
        WHERE r.subject_id = $1::uuid
        ORDER BY r.generated_at DESC, r.id DESC
        LIMIT 1`,
      [subjectId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      // NO REPORT IS NOT A ZERO-COVERAGE REPORT. See the file header.
      return { applies: false, sourcesAttempted: null, sourcesTotal: null, complete: null };
    }
    return {
      applies: true,
      sourcesAttempted: row.sources_attempted,
      sourcesTotal: row.sources_total,
      complete: row.complete,
    };
  }
}
