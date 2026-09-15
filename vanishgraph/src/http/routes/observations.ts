/**
 * Verification observations and reappearances (SPEC-003 §5.10.2, §5.10.3, §5.11.2, §5.11.3).
 *
 * 4 of the 78 routes, all reads sharing the `vg.observations.read` scope. Same structure as the rest of this
 * boundary: `beginHandler` (registry entry, scopes, step-up, tenant-scoped transaction) → strict query parsing
 * → ONE port call → map and return.
 *
 * THE OBSERVATION SIDE OF THE SYSTEM, WHICH IS WHY THE INDEPENDENCE FIELDS ARE FAIL-CLOSED. §5.10.3 returns
 * an independence attestation, and VG-VERIFY-001 makes independence the rule that separates a verified
 * removal from removal theater: an observation made along the acting path proves nothing. The attestation
 * therefore reports what the ROW records — both paths present and different, and two distinct identities —
 * rather than what the route would prefer. A row whose paths were never recorded (every row written before
 * migration 0018) reports `distinct: false`, because independence nobody attested must not be reported as
 * attested. The tests assert that direction with a row that has no paths, so the fail-closed branch is
 * exercised rather than assumed.
 *
 * `reentry` IS REPORTED AND `transitionCode` IS NOT, and the difference is deliberate. §5.11.2 requires
 * `reentry` on every row; it is a statement about the RULES the contract declares for re-entry (SPEC-001
 * T18's guards), so it is the same for every row and reporting it is honest. `transitionCode` and
 * `priorTruthState` come from the transition record, which has no storage the specifications permit
 * (`ASSUMPTIONS.md` §3.18) — and `REAPPEARED` has TWO inbound transitions (T17 and T20), so the prior state
 * cannot even be inferred from the row. §5.11.2/§5.11.3 state no field list, so nothing specified is omitted.
 *
 * NO HANDLER CONTAINS A TRUTH STATE. These routes report truth states the domain wrote — verbatim, never
 * renamed or collapsed (§7.3) — and none of them assigns one. §5.10.1 and §5.11.1, which do drive
 * transitions, are handled by a later milestone of this node.
 */

import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { beginHandler, uuidParam } from './handler-context.ts';
import { parseQuery } from '../query/strict.ts';
import { REAPPEARANCES_QUERY } from '../query/filters.ts';
import { buildCollection } from '../dto/page.ts';
import { encodeCursor, decodeCursor, filterHashOf } from '../pagination/cursor.ts';
import type { ObservationQueries, ReappearanceRow } from '../../application/contracts/observation-queries.ts';
import { RE_ENTRY_STATE_SQL } from '../../application/contracts/observation-queries.ts';

export interface ObservationRouteOptions {
  /** The cursor signing secret (SPEC-003 §2.5). From configuration, never a constant. */
  readonly sessionSecret: string;
  /** The read model, injected as a PORT: the boundary must not import `src/adapters/**`. */
  readonly queries: ObservationQueries;
}

const REAPPEARANCES_ROUTE = '/v1/reappearances';

/** The §5.11.2 filter shape. `from`/`to` come from the normalised filter, so both are always present. */
function reappearanceFilters(filter: Readonly<Record<string, unknown>>): {
  subjectId?: string;
  sourceId?: string;
  reEntryState?: string | readonly string[];
  fromMs: number;
  toMs: number;
} {
  const out: {
    subjectId?: string;
    sourceId?: string;
    reEntryState?: string | readonly string[];
    fromMs: number;
    toMs: number;
  } = { fromMs: Date.parse(String(filter['from'])), toMs: Date.parse(String(filter['to'])) };
  if (typeof filter['subjectId'] === 'string') out.subjectId = filter['subjectId'];
  if (typeof filter['sourceId'] === 'string') out.sourceId = filter['sourceId'];
  const state = filter['reEntryState'];
  if (typeof state === 'string' || Array.isArray(state)) out.reEntryState = state as string | readonly string[];
  return out;
}

export function observationRoutes(app: FastifyInstance, options: ObservationRouteOptions): void {
  const secret = options.sessionSecret;
  const queries = options.queries;

  // ---------------------------------------------------------------------------------------------
  // 5.10.2 GET /v1/cases/{caseId}/verification-observations — newest first, retained forever.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/cases/:caseId/verification-observations', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');

    return h.withTenant(async (tx) => {
      // The case's existence is asserted before listing, so an absent or another tenant's case is a 404 rather
      // than an empty list: an empty list is a true statement about a case that exists, and a misleading one
      // about a case the caller cannot see (SPEC-006 H-9).
      if (!(await queries.caseExists(tx, caseId))) throw apiError('RESOURCE_NOT_FOUND');
      const rows = await queries.listVerificationObservations(tx, caseId);
      // Not paginated: §5.10.2 declares no limit/cursor, and "retained forever" means the collection is
      // bounded by how many times the case was observed rather than by a page size.
      return reply.code(200).send({ data: rows });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.10.3 GET /v1/verification-observations/{verificationObservationId} — with its attestation.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/verification-observations/:verificationObservationId', async (request, reply) => {
    const h = beginHandler(request, reply);
    const verificationObservationId = uuidParam(request, 'verificationObservationId');

    return h.withTenant(async (tx) => {
      const row = await queries.getVerificationObservation(tx, verificationObservationId);
      if (row === undefined) throw apiError('RESOURCE_NOT_FOUND');
      return reply.code(200).send(row);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.11.2 GET /v1/reappearances — the tenant-wide monitoring list, keyset-paginated.
  // ---------------------------------------------------------------------------------------------
  app.get(REAPPEARANCES_ROUTE, async (request, reply) => {
    const h = beginHandler(request, reply);
    const parsed = parseQuery(request.query as Record<string, unknown>, REAPPEARANCES_QUERY);
    const filterHash = filterHashOf(parsed.filter);

    const after =
      parsed.cursor === undefined
        ? undefined
        : (() => {
            const decoded = decodeCursor(parsed.cursor, secret, {
              tenantId: h.context.tenantId.value,
              routeTemplate: REAPPEARANCES_ROUTE,
              filterHash,
              sort: parsed.sort,
            });
            return {
              sortValue: typeof decoded.keyset.sortValue === 'string' ? decoded.keyset.sortValue : '',
              id: decoded.keyset.id,
            };
          })();

    return h.withTenant(async (tx) => {
      const rows = await queries.listReappearances(tx, {
        limit: parsed.limit,
        sort: parsed.sort,
        filters: reappearanceFilters(parsed.filter),
        ...(after === undefined ? {} : { after }),
      });

      const collection = buildCollection(
        rows,
        { limit: parsed.limit, sort: parsed.sort, filter: parsed.filter },
        // `observedAt` is the only declared sort field, so the keyset value is always that instant.
        (last: ReappearanceRow) =>
          encodeCursor(
            {
              tenantId: h.context.tenantId.value,
              routeTemplate: REAPPEARANCES_ROUTE,
              filterHash,
              sort: parsed.sort,
              keyset: { sortValue: last.observedAt, id: last.reappearanceId },
              issuedAt: Math.floor(Date.now() / 1000),
            },
            secret,
          ),
      );
      return reply.code(200).send(collection);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.11.3 GET /v1/exposures/{exposureId}/reappearances — one exposure's history, OLDEST first.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/exposures/:exposureId/reappearances', async (request, reply) => {
    const h = beginHandler(request, reply);
    const exposureId = uuidParam(request, 'exposureId');

    return h.withTenant(async (tx) => {
      if (!(await queries.exposureExists(tx, exposureId))) throw apiError('RESOURCE_NOT_FOUND');
      const rows = await queries.listReappearancesForExposure(tx, exposureId);
      return reply.code(200).send({ data: rows });
    });
  });
}

/** Exported for the route-catalogue test, so it can assert this module covers its declared routes. */
export const OBSERVATION_ROUTE_TEMPLATES: readonly string[] = [
  '/v1/cases/:caseId/verification-observations',
  '/v1/verification-observations/:verificationObservationId',
  '/v1/reappearances',
  '/v1/exposures/:exposureId/reappearances',
];

/**
 * The `reEntryState` tokens this module accepts, re-exported so a test can assert the filter's vocabulary
 * matches the declared mapping without importing the adapter.
 */
export const RE_ENTRY_STATES: readonly string[] = Object.keys(RE_ENTRY_STATE_SQL);
