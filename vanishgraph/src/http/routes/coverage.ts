/**
 * Coverage reports and removal effectiveness (SPEC-003 §5.16.1–§5.16.3).
 *
 * WHAT THESE ROUTES REFUSE TO SAY. §5.16.3's rules are all disclosure rules, and they are enforced here as
 * structure rather than as prose:
 *
 *   * the response contains NO field named `removed`, `permanentDeletion`, `successRate` or `requestsSent`
 *     (§10, §7.3) — asserted by a test that walks every key of the body, because a field added by a later
 *     milestone is exactly how that rule would be broken;
 *   * `acknowledged`, `requestSubmitted` and `searchDelisted` are reported in `excludedFromNumerator`;
 *   * `notRemovable` and `humanRequired` are disclosed in the same response, not omitted to improve the rate;
 *   * `ratio` is returned together with its numerator and denominator, and as `null` — never `0` — when the
 *     denominator is zero, because "no confirmed match was eligible" and "nothing was removed" are different
 *     statements about the service;
 *   * the interval is always returned, and `from`/`to` are MANDATORY (VG-API-058's negative case).
 *
 * THE CAVEAT LIST IS NOT DECORATION. `ACKNOWLEDGED_IS_NOT_REMOVAL`, `SEARCH_DELISTED_IS_NOT_SOURCE_DELETION` and
 * `HUMAN_REQUIRED_IS_NOT_FAILURE` are the three misreadings this metric invites, and §5.16.3 names them: the
 * response carries all three on EVERY call, including a call whose exclusions are all zero, because a reader who
 * sees `humanRequired: 0` still needs to know that a non-zero value would not have been a failure.
 */

import type { FastifyInstance } from 'fastify';

import type {
  CoverageReportSummaryRow,
  CoverageQueries,
} from '../../application/contracts/coverage-queries.ts';
import { buildCollection } from '../dto/page.ts';
import { apiError } from '../plugins/error-handler.ts';
import { decodeCursor, encodeCursor, filterHashOf, peekCursor } from '../pagination/cursor.ts';
import { COVERAGE_REPORTS_QUERY, REMOVAL_EFFECTIVENESS_QUERY } from '../query/filters.ts';
import { parseQuery } from '../query/strict.ts';
import { beginHandler, uuidParam } from './handler-context.ts';

export interface CoverageRouteOptions {
  readonly queries: CoverageQueries;
  readonly sessionSecret: string;
}

const COVERAGE_REPORTS_ROUTE = '/v1/coverage-reports';

export function coverageRoutes(app: FastifyInstance, options: CoverageRouteOptions): void {
  const secret = options.sessionSecret;
  const queries = options.queries;

  // ---------------------------------------------------------------------------------------------
  // 5.16.1 GET /v1/coverage-reports — list, keyset-paginated.
  // ---------------------------------------------------------------------------------------------
  app.get(COVERAGE_REPORTS_ROUTE, async (request, reply) => {
    const h = beginHandler(request, reply);
    // The cursor is read before the query is parsed so a continuation keeps the window its first page used — the
    // default window is resolved against the clock, and a moving window is what made every second page fail
    // `INVALID_CURSOR` (see `cursor.ts`). A peek is not an authorisation: the bindings are re-checked below.
    const rawQuery = request.query as Record<string, unknown>;
    const peeked = typeof rawQuery['cursor'] === 'string' ? peekCursor(rawQuery['cursor'], secret) : undefined;
    const parsed = parseQuery(rawQuery, COVERAGE_REPORTS_QUERY, Date.now, peeked?.timeRange);
    const filterHash = filterHashOf(parsed.filter);

    const fromMs = Date.parse(String(parsed.filter['from']));
    const toMs = Date.parse(String(parsed.filter['to']));
    const subjectId = typeof parsed.filter['subjectId'] === 'string' ? parsed.filter['subjectId'] : null;
    const discoveryRunId =
      typeof parsed.filter['discoveryRunId'] === 'string' ? parsed.filter['discoveryRunId'] : null;

    const after =
      parsed.cursor === undefined
        ? undefined
        : (() => {
            const decoded = decodeCursor(parsed.cursor, secret, {
              tenantId: h.context.tenantId.value,
              routeTemplate: COVERAGE_REPORTS_ROUTE,
              filterHash,
              sort: parsed.sort,
            });
            return {
              sortValue: typeof decoded.keyset.sortValue === 'number' ? decoded.keyset.sortValue : 0,
              id: decoded.keyset.id,
            };
          })();

    return h.withTenant(async (tx) => {
      const rows = await queries.listCoverageReports(tx, {
        limit: parsed.limit,
        sort: parsed.sort,
        filters: { subjectId, discoveryRunId, fromMs, toMs },
        ...(after === undefined ? {} : { after }),
      });

      const response = buildCollection(
        rows,
        { limit: parsed.limit, sort: parsed.sort, filter: parsed.filter },
        (last: CoverageReportSummaryRow) =>
          encodeCursor(
            {
              tenantId: h.context.tenantId.value,
              routeTemplate: COVERAGE_REPORTS_ROUTE,
              filterHash,
              sort: parsed.sort,
              timeRange: { fromMs, toMs },
              // The ORDERING key's own value, never the rendered ISO string: a cursor minted from the display form
              // is a different value from the one the query compares, which is the defect ASSUMPTIONS §3.32
              // item 4 records.
              keyset: { sortValue: last.cursorValue, id: last.coverageReportId },
              issuedAt: Math.floor(Date.now() / 1000),
            },
            secret,
          ),
      );

      return reply.code(200).send({
        // `cursorValue` is the route's own keyset input and is not part of §5.16.1's row.
        data: response.data.map(({ cursorValue, ...row }) => {
          void cursorValue;
          return row;
        }),
        page: response.page,
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.16.2 GET /v1/coverage-reports/{coverageReportId} — the full report, naming what was NOT checked.
  // ---------------------------------------------------------------------------------------------
  app.get(`${COVERAGE_REPORTS_ROUTE}/:coverageReportId`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const coverageReportId = uuidParam(request, 'coverageReportId');

    return h.withTenant(async (tx) => {
      const report = await queries.getCoverageReport(tx, coverageReportId);
      if (report === undefined) throw apiError('RESOURCE_NOT_FOUND');
      // The report is returned as stored, including `uncheckedRemainder` and `complete`. Nothing here suppresses
      // an empty-result reading: a partial report that named no unchecked remainder cannot exist, because the
      // table refuses to store one.
      return reply.code(200).send(report);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.16.3 GET /v1/metrics/removal-effectiveness — the primary metric, with its disclosures.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/metrics/removal-effectiveness', async (request, reply) => {
    const h = beginHandler(request, reply);
    const parsed = parseQuery(request.query as Record<string, unknown>, REMOVAL_EFFECTIVENESS_QUERY);

    const fromMs = Date.parse(String(parsed.filter['from']));
    const toMs = Date.parse(String(parsed.filter['to']));
    const subjectId = typeof parsed.filter['subjectId'] === 'string' ? parsed.filter['subjectId'] : null;
    const sourceId = typeof parsed.filter['sourceId'] === 'string' ? parsed.filter['sourceId'] : null;
    const groupByRaw = parsed.filter['groupBy'];
    const groupBy =
      groupByRaw === 'source' || groupByRaw === 'jurisdiction' || groupByRaw === 'channel' ? groupByRaw : 'none';

    return h.withTenant(async (tx) => {
      const metric = await queries.removalEffectiveness(tx, { fromMs, toMs, subjectId, sourceId, groupBy });
      return reply.code(200).send({
        interval: metric.interval,
        overall: metric.overall,
        excludedFromNumerator: metric.excludedFromNumerator,
        // `groups` is present only when it was asked for. An always-present empty array would read as "no groups
        // matched", which is a different statement from "no breakdown was requested".
        ...(groupBy === 'none' ? {} : { groups: metric.groups }),
        caveats: metric.caveats,
      });
    });
  });
}
