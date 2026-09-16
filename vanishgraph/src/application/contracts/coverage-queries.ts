/**
 * Coverage reports and the removal-effectiveness metric (SPEC-003 §5.16.1–§5.16.3).
 *
 * WHAT THIS PORT IS FOR. §5.16.2 is the contract's statement of VG-DISC-002: a coverage report must name what was
 * NOT checked — `sourcesSkipped` with a reason per source, a required `uncheckedRemainder`, and a
 * `checkedFraction` returned beside its `sourcesTotal` — because "a partial report cannot state or imply 'no
 * exposure found'" (SPEC-000 §7.1, §7.4). §5.16.3 is the product's primary metric, and every one of its rules is
 * a disclosure rule: acknowledged, requestSubmitted and searchDelisted are excluded from the numerator, the
 * denominator and the interval are named, notRemovable and humanRequired are disclosed in the same response, and
 * no field called `removed`, `successRate` or `requestsSent` exists anywhere.
 *
 * THE COUNTS ARE DERIVED FROM THE TRANSITION SPINE, NOT FROM CURRENT STATE. An exposure's `truth_state` column
 * says where it IS; the metric needs what happened INSIDE an interval, which is what `audit_event`'s
 * `to_truth_state` and `at` record. A metric computed from current state would silently move an exposure into a
 * window it was never removed in — and the ratio would change when nothing about the interval did.
 *
 * THREE THINGS NO SPECIFICATION FIXES, SO THEY ARE DECLARED READINGS (recorded in ASSUMPTIONS §3.34):
 *
 *   1. **The cohort.** "eligibleConfirmedMatchDenominator" is defined here as exposures whose transition INTO
 *      `MATCH_CONFIRMED` falls inside the requested interval AND whose case carries a policy decision — a
 *      resolved legal basis and channel is the only evidence this schema holds that a lawful channel was
 *      available. The numerator is the cohort members whose transition into `VERIFIED_REMOVED` occurred at or
 *      before the interval's upper bound, which is a CAUSAL order (a match can only be removed after it is
 *      confirmed) and may therefore reach past the interval for a match confirmed on its last day. That
 *      asymmetry is stated in `denominatorDefinedAs` and in the response's caveats rather than smoothed over.
 *   2. **`ambiguous`.** §5.16.3 lists an `ambiguous` count among the exclusions, and NO truth state is named
 *      `AMBIGUOUS` — the eleven tokens do not include one, and an ambiguity is a property of an external action
 *      (`external_action.ambiguous`, VG-ACTION-002). It is therefore counted as cohort members having at least
 *      one ambiguous action, which is the only reading this schema supports. A member can appear both here and
 *      in a truth-state bucket; the counts are DISCLOSURES, not a partition, and pretending otherwise would
 *      require inventing a precedence no specification states.
 *   3. **The interval statistics.** No specification names a method. The interval is the Wilson score interval at
 *      the level §5.16.3's example shows (0.95), which is the standard choice for a proportion near 0 or 1 and
 *      the one that behaves when the numerator is 0 — where a normal approximation would produce a negative
 *      lower bound and a confidence interval that cannot be true.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** The reason tokens §5.16.2 permits for a skipped source. */
export const COVERAGE_SKIP_REASONS = [
  'RATE_LIMITED',
  'HUMAN_REQUIRED',
  'PROHIBITED',
  'NOT_IN_CATALOGUE',
  'SOURCE_ERROR',
  'ROBOTS_DISALLOWED',
] as const;

export type CoverageSkipReason = (typeof COVERAGE_SKIP_REASONS)[number];

/** One `sourcesSkipped` entry: a source that was attempted or declared, and why nothing came of it. */
export interface CoverageSkippedSource {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly reason: string;
}

/** One `uncheckedRemainder` entry: a declared source the run never reached. */
export interface CoverageUncheckedSource {
  readonly sourceId: string;
  readonly sourceName: string;
}

/** The §5.16.1 list row. `uncheckedRemainderCount` is the count, because the list carries summaries. */
export interface CoverageReportSummaryRow {
  readonly coverageReportId: string;
  readonly generatedAt: string;
  readonly subjectId: string | null;
  readonly discoveryRunId: string | null;
  readonly catalogueId: string | null;
  readonly sourcesTotal: number;
  readonly sourcesAttempted: number;
  readonly sourcesSucceeded: number;
  readonly uncheckedRemainderCount: number;
  /**
   * The keyset value: `generated_at` in epoch milliseconds.
   *
   * The ORDERING key, and a route-only field. `generatedAt` is rendered as an ISO string for the body, and a
   * cursor minted from the rendered form would be a different value from the one the ordering compares — the
   * defect recorded in ASSUMPTIONS §3.32 item 4, where a list's cursor came from a nullable display field while
   * the query ordered by another column.
   */
  readonly cursorValue: number;
}

/** The §5.16.2 detail. */
export interface CoverageReportDetail {
  readonly coverageReportId: string;
  readonly generatedAt: string;
  readonly scope: { readonly subjectId: string | null; readonly catalogueId: string | null };
  readonly discoveryRunId: string | null;
  readonly sourcesTotal: number;
  readonly sourcesAttempted: number;
  readonly sourcesSucceeded: number;
  readonly sourcesSkipped: readonly CoverageSkippedSource[];
  /**
   * "required, non-empty-when-partial". A database CHECK refuses a row that is not complete and names nothing
   * here, so this field cannot be empty on a partial report even if a future writer forgets the rule.
   */
  readonly uncheckedRemainder: readonly CoverageUncheckedSource[];
  readonly checkedFraction: number;
  readonly complete: boolean;
  readonly caveats: readonly string[];
}

/** The filters §5.16.1 declares. */
export interface CoverageListFilters {
  readonly subjectId: string | null;
  readonly discoveryRunId: string | null;
  readonly fromMs: number;
  readonly toMs: number;
}

export interface ListCoverageReportsParams {
  readonly limit: number;
  readonly sort: string;
  readonly filters: CoverageListFilters;
  readonly after?: { readonly sortValue: number; readonly id: string };
}

/** The exclusion counts §5.16.3 discloses beside the ratio. */
export interface EffectivenessExclusions {
  readonly acknowledged: number;
  readonly requestSubmitted: number;
  readonly searchDelisted: number;
  readonly notRemovable: number;
  readonly humanRequired: number;
  readonly ambiguous: number;
}

export interface EffectivenessFigure {
  readonly eligibleConfirmedMatchDenominator: number;
  readonly verifiedRemovedNumerator: number;
  /**
   * `null` when the denominator is zero, never `0`.
   *
   * A ratio with no denominator is undefined, not zero: reporting `0` would read as "nothing was removed" when
   * the truth is "no confirmed match was eligible", and those are different statements about the service.
   */
  readonly ratio: number | null;
  readonly confidenceInterval: { readonly level: number; readonly low: number; readonly high: number } | null;
  readonly denominatorDefinedAs: string;
}

export interface EffectivenessGroup extends EffectivenessFigure {
  /** The group's value, or `null` for a group whose key is not recorded on every member. */
  readonly key: string | null;
  readonly kind: 'source' | 'jurisdiction' | 'channel';
}

export interface RemovalEffectiveness {
  readonly interval: { readonly from: string; readonly to: string };
  readonly overall: EffectivenessFigure;
  readonly excludedFromNumerator: EffectivenessExclusions;
  /** Present only when `groupBy` is not `none`. */
  readonly groups: readonly EffectivenessGroup[];
  readonly caveats: readonly string[];
}

export interface EffectivenessParams {
  readonly fromMs: number;
  readonly toMs: number;
  readonly subjectId: string | null;
  readonly sourceId: string | null;
  readonly groupBy: 'none' | 'source' | 'jurisdiction' | 'channel';
}

export interface CoverageQueries {
  /** §5.16.1 — coverage reports, newest first, keyset-paginated. */
  listCoverageReports(
    tx: TenantTransaction,
    params: ListCoverageReportsParams,
  ): Promise<readonly CoverageReportSummaryRow[]>;
  /** §5.16.2 — one report, naming what was not checked. */
  getCoverageReport(tx: TenantTransaction, coverageReportId: string): Promise<CoverageReportDetail | undefined>;
  /** §5.16.3 — independently verified removals ÷ eligible confirmed matches, with its exclusions. */
  removalEffectiveness(tx: TenantTransaction, params: EffectivenessParams): Promise<RemovalEffectiveness>;
}

/** The caveat tokens §5.16.3 always returns, and the one place they are stated. */
export const EFFECTIVENESS_CAVEATS = [
  'ACKNOWLEDGED_IS_NOT_REMOVAL',
  'SEARCH_DELISTED_IS_NOT_SOURCE_DELETION',
  'HUMAN_REQUIRED_IS_NOT_FAILURE',
] as const;
