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

/** `GET /v1/exposures` (SPEC-003 §5.5.1) — the first route that filters on truth state. */
export const EXPOSURES_QUERY: QuerySchema = {
  paginated: true,
  parameters: {
    ...PAGINATION,
    subjectId: { type: 'string' },
    sourceId: { type: 'string' },
    caseId: { type: 'string' },
    minConfidence: { type: 'integer' },
  },
  sortFields: ['observedAt', 'createdAt', 'confidence'],
  defaultSort: 'observedAt:desc',
  timeFilterable: false,
  truthStateFilterable: true,
};

/** `GET /v1/cases` (SPEC-003 §5.7.2). */
export const CASES_QUERY: QuerySchema = {
  paginated: true,
  parameters: {
    ...PAGINATION,
    subjectId: { type: 'string' },
    sourceId: { type: 'string' },
    jurisdiction: { type: 'string' },
  },
  sortFields: ['createdAt', 'updatedAt', 'truthStateChangedAt'],
  defaultSort: 'createdAt:desc',
  timeFilterable: false,
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
export const REAPPEARANCES_QUERY: QuerySchema = {
  paginated: true,
  parameters: {
    ...PAGINATION,
    exposureId: { type: 'string' },
    sourceId: { type: 'string' },
  },
  sortFields: ['detectedAt', 'createdAt'],
  defaultSort: 'detectedAt:desc',
  timeFilterable: false,
  truthStateFilterable: false,
};

/** The default page size, re-exported so a route does not restate it. */
export { DEFAULT_LIMIT };
