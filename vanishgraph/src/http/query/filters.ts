/**
 * The declared query surface of each collection route (SPEC-003 §2.6, §5).
 *
 * WHY THIS IS A TABLE rather than each route assembling its own schema: the filter surface is part of
 * the `/v1` CONTRACT, and a route that forgot to declare a parameter would refuse a legitimate filter
 * while a route that declared one too many would accept a parameter it ignores. Keeping the
 * declarations together makes a diff against SPEC-003 §5 readable, and lets a test compare the
 * declared sort fields against the specification.
 *
 * ROUTES APPEAR HERE ONLY ONCE THEIR HANDLER EXISTS. A schema for a route nothing implements would be
 * a declaration that the contract is satisfied when it is not; `gate-api.sh` reports the routes still
 * unimplemented, and this table is deliberately not a substitute for that.
 *
 * The time-filterable set follows SPEC-003 §5: audit, discovery runs, actions and observations are
 * time-ranged; subjects and sources are not.
 */

import type { QuerySchema } from './strict.ts';
import { DEFAULT_LIMIT } from '../dto/page.ts';

/** Parameters shared by every collection route (SPEC-003 §2.5). */
const PAGINATION: Readonly<Record<string, { type: 'integer' | 'string' }>> = {
  limit: { type: 'integer' },
  cursor: { type: 'string' },
};

const TIME_RANGE = {
  from: { type: 'timestamp' as const },
  to: { type: 'timestamp' as const },
};

/**
 * `GET /v1/subjects` (SPEC-003 §5.1.2).
 *
 * `sort` is `createdAt|displayRef` and `authorityState` is an enum — NOT a `truthState` filter,
 * because a subject has an authority state rather than a truth state. Conflating the two would let a
 * caller filter subjects by a concept subjects do not have.
 */
export const SUBJECTS_QUERY: QuerySchema = {
  paginated: true,
  parameters: {
    ...PAGINATION,
    jurisdiction: { type: 'string' },
    isMinor: { type: 'boolean' },
    authorityState: { type: 'enum', values: ['VALID', 'EXPIRED', 'REVOKED', 'NONE'] },
  },
  sortFields: ['createdAt', 'displayRef'],
  defaultSort: 'createdAt:desc',
  timeFilterable: false,
  truthStateFilterable: false,
};

/**
 * `GET /v1/exposures` (SPEC-003 §5.5.1).
 *
 * CORRECTED TO THE SPECIFICATION, and this declaration had drifted in four of its parts before its route
 * existed — the same defect class `ASSUMPTIONS.md` §3.26 item 2 records for `REAPPEARANCES_QUERY`. §5.5.1
 * gives `subjectId`, `sourceId`, `truthState`, `minConfidence`, `from`, `to` and
 * `sort ∈ observedAt|confidence|truthState` (default `observedAt:desc`). The declaration said `caseId`
 * (which §5.5.1 does not offer), made `minConfidence` an INTEGER (a confidence is 0.00–1.00),
 * allowed `createdAt` as a sort field (not a field of §5.5.1's row) and set `timeFilterable: false`
 * although the spec gives `from`/`to`. A declaration nothing enforces drifts; this one is now enforced by
 * the route that reads it.
 */
export const EXPOSURES_QUERY: QuerySchema = {
  paginated: true,
  parameters: {
    ...PAGINATION,
    subjectId: { type: 'string' },
    sourceId: { type: 'string' },
    minConfidence: { type: 'number', min: 0, max: 1 },
  },
  sortFields: ['observedAt', 'confidence', 'truthState'],
  defaultSort: 'observedAt:desc',
  timeFilterable: true,
  truthStateFilterable: true,
};

/**
 * `GET /v1/cases` (SPEC-003 §5.7.2).
 *
 * CORRECTED TO THE SPECIFICATION: §5.7.2 gives `subjectId`, `sourceId`, `truthState`, `channel`,
 * `authorityGrantState`, `from`, `to` and `sort ∈ createdAt|updatedAt|truthState` (default `updatedAt:desc`).
 * The declaration had `jurisdiction` (not offered), lacked `channel` and `authorityGrantState`, sorted on
 * `truthStateChangedAt` — which is not a column, so every documented sort would have answered
 * `INVALID_SORT_FIELD` while an undocumented one was accepted — defaulted to `createdAt:desc` rather than
 * `updatedAt:desc`, and set `timeFilterable: false` although the spec gives `from`/`to`.
 */
export const CASES_QUERY: QuerySchema = {
  paginated: true,
  parameters: {
    ...PAGINATION,
    subjectId: { type: 'string' },
    sourceId: { type: 'string' },
    channel: { type: 'string' },
    authorityGrantState: { type: 'enum', values: ['VALID', 'EXPIRED', 'REVOKED', 'NONE'] },
  },
  sortFields: ['createdAt', 'updatedAt', 'truthState'],
  defaultSort: 'updatedAt:desc',
  timeFilterable: true,
  truthStateFilterable: true,
};

/** `GET /v1/audit-events` (SPEC-003 §5.15.1) — time-ranged, and the widest filter surface. */
export const AUDIT_EVENTS_QUERY: QuerySchema = {
  paginated: true,
  parameters: {
    ...PAGINATION,
    ...TIME_RANGE,
    actor: { type: 'string' },
    action: { type: 'multi' },
    targetKind: { type: 'string' },
    targetId: { type: 'string' },
    correlationId: { type: 'string' },
  },
  sortFields: ['at', 'id'],
  defaultSort: 'at:desc',
  timeFilterable: true,
  // §5.15.1: "`from`, `to` (**required** on this route: an unbounded audit scan is refused with `400
  // TIME_RANGE_REQUIRED`; maximum span 90 days)". Both are declared here so the two refusals the registry
  // already enumerated are produced by the parser rather than by a handler that could forget them.
  requireTimeRange: true,
  timeRangeCollection: 'audit-events',
  maxSpanDays: 90,
  truthStateFilterable: false,
};

/** `GET /v1/coverage-reports` (SPEC-003 §5.16.1) — newest-first, filtered by subject or run. */
export const COVERAGE_REPORTS_QUERY: QuerySchema = {
  paginated: true,
  parameters: {
    ...PAGINATION,
    subjectId: { type: 'string' },
    discoveryRunId: { type: 'string' },
  },
  // §5.16.1: `sort ∈ generatedAt` (default `generatedAt:desc`). ONE sort field, so the allowlist is one long.
  sortFields: ['generatedAt'],
  defaultSort: 'generatedAt:desc',
  timeFilterable: true,
  truthStateFilterable: false,
};

/**
 * `GET /v1/metrics/removal-effectiveness` (SPEC-003 §5.16.3) — the primary metric.
 *
 * NOT PAGINATED, and that is the contract's shape: the response is one object with an `overall` figure, not a
 * collection, so `limit` and `cursor` are not declared and a caller who sends one is refused
 * `UNKNOWN_QUERY_PARAMETER` rather than silently ignored.
 *
 * `from`/`to` ARE MANDATORY — §5.16.3's error list starts with `400 TIME_RANGE_REQUIRED`, and VG-API-058's
 * negative case is a metric request without a range. `TIME_RANGE_TOO_WIDE` IS ALSO DECLARED BY §5.16.3, AND NO
 * BOUND IS APPLIED: §5.15.1 states its cap ("maximum span 90 days") and §5.16.3 states none, so a number here
 * would be a limit the API enforces that no specification authorises. Recorded in ASSUMPTIONS §3.34.
 */
export const REMOVAL_EFFECTIVENESS_QUERY: QuerySchema = {
  paginated: false,
  parameters: {
    subjectId: { type: 'string' },
    sourceId: { type: 'string' },
    groupBy: {
      type: 'enum',
      values: ['none', 'source', 'jurisdiction', 'channel'],
      invalidCode: 'INVALID_GROUP_BY',
      single: true,
    },
  },
  sortFields: [],
  defaultSort: 'from:desc',
  timeFilterable: true,
  requireTimeRange: true,
  timeRangeCollection: 'metrics/removal-effectiveness',
  truthStateFilterable: false,
};

/** `GET /v1/discovery-runs` (SPEC-003 §5.4.2). */
export const DISCOVERY_RUNS_QUERY: QuerySchema = {
  paginated: true,
  parameters: {
    ...PAGINATION,
    ...TIME_RANGE,
    subjectId: { type: 'string' },
    sourceId: { type: 'string' },
    status: { type: 'enum', values: ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'] },
  },
  sortFields: ['startedAt', 'createdAt'],
  defaultSort: 'startedAt:desc',
  timeFilterable: true,
  truthStateFilterable: false,
};

/** `GET /v1/reappearances` (SPEC-003 §5.11.2). */
/**
 * `GET /v1/reappearances` (SPEC-003 §5.11.2).
 *
 * CORRECTED TO THE SPECIFICATION, which is worth recording. This declaration existed BEFORE its route did,
 * and disagreed with §5.11.2 on three of its six parts: it declared `exposureId` where the spec says
 * `subjectId`, declared `sort ∈ detectedAt|createdAt` where the spec says `observedAt`, and had
 * `timeFilterable: false` although the spec gives `from`/`to`. A declaration nothing enforces drifts, and
 * this one had: the filter surface of a route nobody had implemented was wrong in a way no test could see,
 * because no test drove the route. The `sortFields` names matter most — `detectedAt` and `createdAt` are not
 * columns of `reappearance`, so a client following this declaration would have received
 * `INVALID_SORT_FIELD` for every documented field and `FILTER_TOO_BROAD`-free silence for the rest.
 */
export const REAPPEARANCES_QUERY: QuerySchema = {
  paginated: true,
  parameters: {
    ...PAGINATION,
    subjectId: { type: 'string' },
    sourceId: { type: 'string' },
    reEntryState: { type: 'enum', values: ['PENDING_REENTRY', 'REENTERED', 'NOT_REMOVABLE'] },
  },
  sortFields: ['observedAt'],
  defaultSort: 'observedAt:desc',
  timeFilterable: true,
  truthStateFilterable: false,
};

/** The default page size, re-exported so a route does not restate it. */
/** `GET /v1/sources` (SPEC-003 §5.3.1). */
export const SOURCES_QUERY: QuerySchema = {
  paginated: true,
  parameters: {
    ...PAGINATION,
    class: { type: 'string' },
    jurisdiction: { type: 'string' },
    permissionClass: {
      type: 'enum',
      values: ['READ_ONLY', 'WRITE_PERMITTED', 'WRITE_UNCLEAR', 'PROHIBITED'],
    },
  },
  sortFields: ['name', 'freshnessAt'],
  defaultSort: 'name:asc',
  timeFilterable: false,
  truthStateFilterable: false,
};

/**
 * `GET /v1/sources/{sourceId}/recipes` (SPEC-003 §5.3.8).
 *
 * NOT paginated, and that is the specification's choice rather than an omission: the route declares
 * no `limit`/`cursor` and a source's recipe versions are bounded by how many times its terms changed.
 * Declaring pagination here would accept parameters the spec does not offer.
 */
export const RECIPES_QUERY: QuerySchema = {
  paginated: false,
  parameters: {
    enabled: { type: 'boolean' },
    fresh: { type: 'boolean' },
  },
  sortFields: ['version', 'freshnessAt'],
  defaultSort: 'version:desc',
  timeFilterable: false,
  truthStateFilterable: false,
};

export { DEFAULT_LIMIT };
