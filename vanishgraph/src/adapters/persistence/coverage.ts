/**
 * Coverage reports and removal effectiveness against PostgreSQL (SPEC-003 §5.16.1–§5.16.3).
 *
 * `checkedFraction` IS COMPUTED HERE, NOT READ. The table stores `sources_attempted` and `sources_total` and no
 * fraction, because a stored ratio can drift from the counts it was derived from and the drift is invisible —
 * which is the one thing a ratio must never do when SPEC-000 §7.4 forbids returning a percentage without its
 * denominator. The denominator is returned beside it from the same row.
 *
 * THE METRIC IS COMPUTED FROM THE TRANSITION SPINE. `audit_event.to_truth_state` and `at` say what happened and
 * when; `exposure.truth_state` says only where the exposure is NOW. An interval metric built on the current column
 * would attribute every removal to whatever window the query happens to run in. The one place current state is
 * read is the disclosure of what was NOT removed (`acknowledged`, `request_submitted`, and the rest), and that is
 * exactly what those fields mean.
 *
 * THE WILSON INTERVAL IS COMPUTED IN TYPESCRIPT, not in SQL: it needs a square root and an inverse normal
 * quantile, and `z` for 0.95 is a constant. Stating it here rather than burying it in a query makes the method
 * inspectable, and the method is a DECLARED choice — no specification names one (ASSUMPTIONS §3.34).
 */

import type {
  CoverageListFilters,
  CoverageQueries,
  CoverageReportDetail,
  CoverageReportSummaryRow,
  CoverageSkippedSource,
  CoverageUncheckedSource,
  EffectivenessExclusions,
  EffectivenessFigure,
  EffectivenessGroup,
  EffectivenessParams,
  ListCoverageReportsParams,
  RemovalEffectiveness,
} from '../../application/contracts/coverage-queries.ts';
import { EFFECTIVENESS_CAVEATS } from '../../application/contracts/coverage-queries.ts';
import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** The two-sided 95% normal quantile, for the Wilson interval. */
const Z_95 = 1.959963984540054;

/** Round to four decimals, the precision §5.16.3's example shows for a ratio. */
export function round4(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * The Wilson score interval for a proportion.
 *
 * Chosen over the normal approximation because it stays inside [0, 1] at the extremes, which is where this metric
 * lives: a service with no verified removals in a window has a numerator of 0, and the normal approximation would
 * report a NEGATIVE lower bound — a confidence interval that cannot be true.
 */
export function wilson(
  numerator: number,
  denominator: number,
): { readonly level: number; readonly low: number; readonly high: number } | null {
  if (denominator <= 0) return null;
  const p = numerator / denominator;
  const z2 = Z_95 * Z_95;
  const denominatorTerm = 1 + z2 / denominator;
  const centre = (p + z2 / (2 * denominator)) / denominatorTerm;
  const spread =
    (Z_95 * Math.sqrt((p * (1 - p)) / denominator + z2 / (4 * denominator * denominator))) / denominatorTerm;
  return {
    level: 0.95,
    low: round4(Math.max(0, centre - spread)),
    high: round4(Math.min(1, centre + spread)),
  };
}

export const DENOMINATOR_DEFINED_AS =
  'exposures whose transition into MATCH_CONFIRMED falls in the interval and whose case carries a policy ' +
  'decision (a resolved legal basis and channel), counted once per exposure';

export function figure(numerator: number, denominator: number): EffectivenessFigure {
  return {
    eligibleConfirmedMatchDenominator: denominator,
    verifiedRemovedNumerator: numerator,
    ratio: denominator === 0 ? null : round4(numerator / denominator),
    confidenceInterval: wilson(numerator, denominator),
    denominatorDefinedAs: DENOMINATOR_DEFINED_AS,
  };
}

/**
 * The cohort, as one SQL fragment shared by the overall count and every grouped count.
 *
 * `policy_decision` is an INNER JOIN because "eligible for a lawful channel" is the one property this schema can
 * evidence: a case with no resolved policy has no legal basis and no channel, and counting it as eligible would
 * put exposures that were never authorable into a denominator about authorable ones.
 */
const ELIGIBLE_CTE = `
WITH cohort AS (
  SELECT DISTINCT ON (a.target_id) a.target_id AS exposure_id, a.case_id
    FROM audit_event a
   WHERE a.to_truth_state = 'MATCH_CONFIRMED'
     AND a.target_kind = 'Exposure'
     AND a.target_id IS NOT NULL
     AND a.at >= $1::timestamptz AND a.at < $2::timestamptz
   ORDER BY a.target_id, a.at ASC
),
eligible AS (
  -- THE SOURCE IS REACHED THROUGH THE RECORD, not from the exposure: exposure carries source_record_id and no
  -- source_id, so a join on the exposure would name a column that does not exist (MEASURED — the first version of
  -- this query failed with "column e.source_id does not exist").
  SELECT c.exposure_id, c.case_id, sr.source_id, s.jurisdiction, pd.channel
    FROM cohort c
    JOIN request_case rc ON rc.id = c.case_id
    JOIN policy_decision pd ON pd.id = rc.policy_decision_id
    LEFT JOIN exposure e ON e.id = c.exposure_id
    LEFT JOIN source_record sr ON sr.id = e.source_record_id
    LEFT JOIN source s ON s.id = sr.source_id
   WHERE ($3::uuid IS NULL OR e.subject_id = $3::uuid)
     AND ($4::uuid IS NULL OR sr.source_id = $4::uuid)
),
state AS (
  SELECT el.exposure_id, x.truth_state::text AS truth_state
    FROM eligible el JOIN exposure x ON x.id = el.exposure_id
),
removed AS (
  SELECT DISTINCT a.target_id AS exposure_id
    FROM audit_event a
   WHERE a.to_truth_state = 'VERIFIED_REMOVED'
     AND a.target_kind = 'Exposure'
     AND a.at <= $2::timestamptz
),
ambiguous AS (
  SELECT DISTINCT el.exposure_id
    FROM eligible el JOIN external_action xa ON xa.case_id = el.case_id
   WHERE xa.ambiguous
)`;

const OVERALL_SQL = `${ELIGIBLE_CTE}
SELECT
  (SELECT count(*) FROM eligible) AS denominator,
  (SELECT count(*) FROM eligible el
    WHERE EXISTS (SELECT 1 FROM removed r WHERE r.exposure_id = el.exposure_id)) AS numerator,
  (SELECT count(*) FROM state WHERE truth_state = 'ACKNOWLEDGED')      AS acknowledged,
  (SELECT count(*) FROM state WHERE truth_state = 'REQUEST_SUBMITTED') AS request_submitted,
  (SELECT count(*) FROM state WHERE truth_state = 'SEARCH_DELISTED')   AS search_delisted,
  (SELECT count(*) FROM state WHERE truth_state = 'NOT_REMOVABLE')     AS not_removable,
  (SELECT count(*) FROM state WHERE truth_state = 'HUMAN_REQUIRED')    AS human_required,
  (SELECT count(*) FROM ambiguous)                                     AS ambiguous`;

/** The group expressions §5.16.3's `groupBy` accepts. A whitelist, so no caller text reaches the query. */
const GROUP_EXPRESSION: Readonly<Record<'source' | 'jurisdiction' | 'channel', string>> = {
  source: 'el.source_id::text',
  jurisdiction: 'el.jurisdiction',
  channel: 'el.channel',
};

interface OverallRow {
  denominator: string;
  numerator: string;
  acknowledged: string;
  request_submitted: string;
  search_delisted: string;
  not_removable: string;
  human_required: string;
  ambiguous: string;
}

function toExclusions(row: OverallRow): EffectivenessExclusions {
  return {
    acknowledged: Number(row.acknowledged),
    requestSubmitted: Number(row.request_submitted),
    searchDelisted: Number(row.search_delisted),
    notRemovable: Number(row.not_removable),
    humanRequired: Number(row.human_required),
    ambiguous: Number(row.ambiguous),
  };
}

function toSkipped(value: unknown): readonly CoverageSkippedSource[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      sourceId: typeof entry['sourceId'] === 'string' ? entry['sourceId'] : '',
      sourceName: typeof entry['sourceName'] === 'string' ? entry['sourceName'] : '',
      reason: typeof entry['reason'] === 'string' ? entry['reason'] : '',
    }));
}

function toUnchecked(value: unknown): readonly CoverageUncheckedSource[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      sourceId: typeof entry['sourceId'] === 'string' ? entry['sourceId'] : '',
      sourceName: typeof entry['sourceName'] === 'string' ? entry['sourceName'] : '',
    }));
}

export class PostgresCoverageQueries implements CoverageQueries {
  async listCoverageReports(
    tx: TenantTransaction,
    params: ListCoverageReportsParams,
  ): Promise<readonly CoverageReportSummaryRow[]> {
    const filters: CoverageListFilters = params.filters;
    const descending = params.sort.endsWith(':desc');
    const comparison = descending ? '<' : '>';
    const direction = descending ? 'DESC' : 'ASC';
    const after = params.after;
    const result = await tx.query<{
      id: string;
      generated_at: Date;
      subject_id: string | null;
      discovery_run_id: string | null;
      catalogue_id: string | null;
      sources_total: number;
      sources_attempted: number;
      sources_succeeded: number;
      unchecked_count: number;
    }>(
      `SELECT r.id::text AS id, r.generated_at, r.subject_id::text AS subject_id,
              r.discovery_run_id::text AS discovery_run_id, r.catalogue_id,
              r.sources_total, r.sources_attempted, r.sources_succeeded,
              jsonb_array_length(r.unchecked_remainder) AS unchecked_count
         FROM coverage_report r
        WHERE r.generated_at >= $1::timestamptz AND r.generated_at < $2::timestamptz
          AND ($3::uuid IS NULL OR r.subject_id = $3::uuid)
          AND ($4::uuid IS NULL OR r.discovery_run_id = $4::uuid)
          ${
            after === undefined
              ? ''
              : `AND (r.generated_at, r.id) ${comparison} ($5::timestamptz, $6::uuid)`
          }
        ORDER BY r.generated_at ${direction}, r.id ${direction}
        LIMIT $${after === undefined ? '5' : '7'}`,
      after === undefined
        ? [
            new Date(filters.fromMs),
            new Date(filters.toMs),
            filters.subjectId,
            filters.discoveryRunId,
            // ONE ROW MORE THAN ASKED FOR, and that extra row is how `hasMore` is known rather than guessed
            // (SPEC-003 §2.5). MEASURED DEFECT this fixes: the first version of this query asked for exactly
            // `limit` rows, so `buildCollection` never saw an extra row and `hasMore` was ALWAYS false — a walk
            // that stops after one page while rows remain, which is precisely the silent truncation §2.5's page
            // object exists to prevent.
            params.limit + 1,
          ]
        : [
            new Date(filters.fromMs),
            new Date(filters.toMs),
            filters.subjectId,
            filters.discoveryRunId,
            new Date(after.sortValue),
            after.id,
            params.limit + 1,
          ],
    );

    return result.rows.map((row) => ({
      coverageReportId: row.id,
      generatedAt: row.generated_at.toISOString(),
      subjectId: row.subject_id,
      discoveryRunId: row.discovery_run_id,
      catalogueId: row.catalogue_id,
      sourcesTotal: row.sources_total,
      sourcesAttempted: row.sources_attempted,
      sourcesSucceeded: row.sources_succeeded,
      uncheckedRemainderCount: row.unchecked_count,
      cursorValue: row.generated_at.getTime(),
    }));
  }

  async getCoverageReport(
    tx: TenantTransaction,
    coverageReportId: string,
  ): Promise<CoverageReportDetail | undefined> {
    const result = await tx.query<{
      id: string;
      generated_at: Date;
      subject_id: string | null;
      discovery_run_id: string | null;
      catalogue_id: string | null;
      sources_total: number;
      sources_attempted: number;
      sources_succeeded: number;
      sources_skipped: unknown;
      unchecked_remainder: unknown;
      complete: boolean;
      caveats: string[];
    }>(
      `SELECT r.id::text AS id, r.generated_at, r.subject_id::text AS subject_id,
              r.discovery_run_id::text AS discovery_run_id, r.catalogue_id,
              r.sources_total, r.sources_attempted, r.sources_succeeded,
              r.sources_skipped, r.unchecked_remainder, r.complete, r.caveats
         FROM coverage_report r
        WHERE r.id = $1::uuid`,
      [coverageReportId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      coverageReportId: row.id,
      generatedAt: row.generated_at.toISOString(),
      scope: { subjectId: row.subject_id, catalogueId: row.catalogue_id },
      discoveryRunId: row.discovery_run_id,
      sourcesTotal: row.sources_total,
      sourcesAttempted: row.sources_attempted,
      sourcesSucceeded: row.sources_succeeded,
      sourcesSkipped: toSkipped(row.sources_skipped),
      uncheckedRemainder: toUnchecked(row.unchecked_remainder),
      // Derived, so it cannot contradict the counts returned beside it. A source count of zero reports 0, not
      // NaN: a report over an empty catalogue checked all of nothing, and `NaN` on the wire is not JSON.
      checkedFraction: row.sources_total === 0 ? 0 : round4(row.sources_attempted / row.sources_total),
      complete: row.complete,
      caveats: Array.isArray(row.caveats) ? row.caveats : [],
    };
  }

  async removalEffectiveness(tx: TenantTransaction, params: EffectivenessParams): Promise<RemovalEffectiveness> {
    const overall = await tx.query<OverallRow>(OVERALL_SQL, [
      new Date(params.fromMs),
      new Date(params.toMs),
      params.subjectId,
      params.sourceId,
    ]);
    const row = overall.rows[0];
    if (row === undefined) {
      // Unreachable with the aggregate query above (it always returns exactly one row), and refused rather than
      // papered over with zeros: a metric that reports 0/0 because a query returned nothing would be a rate
      // invented by the absence of data.
      throw new Error('coverage: the effectiveness aggregate returned no row');
    }

    let groups: readonly EffectivenessGroup[] = [];
    if (params.groupBy !== 'none') {
      const expression = GROUP_EXPRESSION[params.groupBy];
      const grouped = await tx.query<{ key: string | null; denominator: string; numerator: string }>(
        `${ELIGIBLE_CTE}
         SELECT ${expression} AS key,
                count(*) AS denominator,
                count(*) FILTER (
                  WHERE EXISTS (SELECT 1 FROM removed r WHERE r.exposure_id = el.exposure_id)
                ) AS numerator
           FROM eligible el
          GROUP BY 1
          ORDER BY 1 NULLS LAST`,
        [new Date(params.fromMs), new Date(params.toMs), params.subjectId, params.sourceId],
      );
      groups = grouped.rows.map((group) => ({
        kind: params.groupBy as 'source' | 'jurisdiction' | 'channel',
        key: group.key,
        ...figure(Number(group.numerator), Number(group.denominator)),
      }));
    }

    return {
      interval: { from: new Date(params.fromMs).toISOString(), to: new Date(params.toMs).toISOString() },
      overall: figure(Number(row.numerator), Number(row.denominator)),
      excludedFromNumerator: toExclusions(row),
      groups,
      caveats: [...EFFECTIVENESS_CAVEATS],
    };
  }
}
