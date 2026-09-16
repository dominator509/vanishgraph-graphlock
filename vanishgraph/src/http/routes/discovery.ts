/**
 * Discovery runs and candidate records (SPEC-003 §5.4).
 *
 * TWO ROUTES READ, THREE REFUSE, AND EACH REFUSAL NAMES A SPECIFICATION GAP RATHER THAN AN UNBUILT PIECE.
 *
 * §5.4.1–§5.4.3 are about a `DiscoveryRun`: starting one (with a declared surface, a budget and a mode), listing
 * runs, and reading one run's coverage. **No specification defines that aggregate.** SPEC-001 §2 is the
 * authoritative domain model and lists `SourceRecord` and `Exposure` and no run; a search of `.agent/specs` finds
 * `DiscoveryRun` in NO file, so there is no lifecycle, no attempt record, and no table to write. The three refusals
 * say exactly that — "a `DiscoveryRun` is defined by no specification" is a different message to an operator than a
 * bare dependency name, and it is the true one. §5.4.2 and §5.4.3 additionally disagree with the DECLARATION that
 * already exists for them (`DISCOVERY_RUNS_QUERY` offers `status ∈ PENDING|RUNNING|SUCCEEDED|FAILED` where §5.4.2
 * says `runState ∈ ACCEPTED|RUNNING|COMPLETED|COMPLETED_PARTIAL|FAILED|HUMAN_REQUIRED`), which is what a
 * declaration nothing enforces does over time (ASSUMPTIONS §3.34 item 7).
 *
 * §5.4.4 AND §5.4.5 READ WHAT IS MODELLED. A subject's candidate records come from `source_record` joined to that
 * subject's exposures, and the coverage block §5.4.4 makes mandatory comes from `coverage_report` — a report that
 * exists yields its counts, and NO report yields `applies: false` with three nulls rather than zeros, because
 * "nothing was attempted" is a measurement and no report is the absence of one (VG-DISC-002).
 *
 * VG-IDENT-004 IS ENFORCED IN THE ADAPTER, not described here: a record from a search-engine class source is
 * `UNASSESSED` and carries no `exposureId`, because a search hit is never a subject match.
 */

import type { FastifyInstance } from 'fastify';

import type { DiscoveryQueries } from '../../application/contracts/discovery-queries.ts';
import type { SubjectQueries } from '../../application/contracts/subject-queries.ts';
import { apiError } from '../plugins/error-handler.ts';
import { buildCollection } from '../dto/page.ts';
import { decodeCursor, encodeCursor, filterHashOf, peekCursor } from '../pagination/cursor.ts';
import { CANDIDATE_RECORDS_QUERY } from '../query/filters.ts';
import { parseQuery } from '../query/strict.ts';
import { beginHandler, uuidParam } from './handler-context.ts';

export interface DiscoveryRouteOptions {
  readonly queries: DiscoveryQueries;
  /** The subject read model, for the 404 path §5.4.4 needs: a subject that does not resolve is not an empty list. */
  readonly subjects: SubjectQueries;
  readonly sessionSecret: string;
}

const CANDIDATE_RECORDS_ROUTE = '/v1/subjects/:subjectId/candidate-records';

/** The gap every refusing route in this group names. */
const DISCOVERY_RUN_GAP =
  'no specification defines a DiscoveryRun: SPEC-001 §2, the authoritative domain model, lists SourceRecord and Exposure and no run, and the identifier appears in no specification file';

export function discoveryRoutes(app: FastifyInstance, options: DiscoveryRouteOptions): void {
  const queries = options.queries;
  const subjects = options.subjects;
  const secret = options.sessionSecret;

  // ---------------------------------------------------------------------------------------------
  // 5.4.1 POST /v1/discovery-runs — REFUSED: the aggregate does not exist.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/discovery-runs', async (request, reply) => {
    const h = beginHandler(request, reply);
    return h.withTenant(async () => {
      void reply;
      throw apiError('DEPENDENCY_UNAVAILABLE', { reason: DISCOVERY_RUN_GAP });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.4.2 GET /v1/discovery-runs — REFUSED: nothing to list.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/discovery-runs', async (request, reply) => {
    const h = beginHandler(request, reply);
    return h.withTenant(async () => {
      void reply;
      throw apiError('DEPENDENCY_UNAVAILABLE', { reason: DISCOVERY_RUN_GAP });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.4.3 GET /v1/discovery-runs/{discoveryRunId} — REFUSED: nothing to read.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/discovery-runs/:discoveryRunId', async (request, reply) => {
    const h = beginHandler(request, reply);
    uuidParam(request, 'discoveryRunId');
    return h.withTenant(async () => {
      void reply;
      throw apiError('DEPENDENCY_UNAVAILABLE', { reason: DISCOVERY_RUN_GAP });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.4.4 GET /v1/subjects/{subjectId}/candidate-records — candidate records, never exposures.
  // ---------------------------------------------------------------------------------------------
  app.get(CANDIDATE_RECORDS_ROUTE, async (request, reply) => {
    const h = beginHandler(request, reply);
    const subjectId = uuidParam(request, 'subjectId');
    const rawQuery = request.query as Record<string, unknown>;
    // Read before parsing so a continuation keeps the window its first page used (`cursor.ts`).
    const peeked = typeof rawQuery['cursor'] === 'string' ? peekCursor(rawQuery['cursor'], secret) : undefined;
    const parsed = parseQuery(rawQuery, CANDIDATE_RECORDS_QUERY, Date.now, peeked?.timeRange);
    const filterHash = filterHashOf(parsed.filter);

    const fromMs = Date.parse(String(parsed.filter['from']));
    const toMs = Date.parse(String(parsed.filter['to']));
    const sourceId = typeof parsed.filter['sourceId'] === 'string' ? parsed.filter['sourceId'] : null;
    const stateRaw = parsed.filter['assessmentState'];
    const assessmentState =
      stateRaw === undefined ? null : Array.isArray(stateRaw) ? (stateRaw as string[]) : [String(stateRaw)];

    const after =
      parsed.cursor === undefined
        ? undefined
        : (() => {
            const decoded = decodeCursor(parsed.cursor, secret, {
              tenantId: h.context.tenantId.value,
              // The TEMPLATE, not the concrete path: §5.4.4's route is per subject, and a cursor minted for one
              // subject must not be replayable against another.
              routeTemplate: CANDIDATE_RECORDS_ROUTE,
              filterHash,
              sort: parsed.sort,
            });
            return { sortValue: decoded.keyset.sortValue ?? 0, id: decoded.keyset.id };
          })();

    return h.withTenant(async (tx) => {
      // The subject is asserted directly: an empty list is a true statement about a subject that exists, and a
      // misleading one about a subject the caller cannot see (SPEC-006 H-9).
      if (!(await subjects.subjectExists(tx, subjectId))) throw apiError('RESOURCE_NOT_FOUND');

      const { rows, coverage } = await queries.listCandidateRecords(tx, {
        subjectId,
        limit: parsed.limit,
        sort: parsed.sort,
        filters: { sourceId, assessmentState, fromMs, toMs },
        ...(after === undefined ? {} : { after }),
      });

      const response = buildCollection(
        rows,
        { limit: parsed.limit, sort: parsed.sort, filter: parsed.filter },
        (last) =>
          encodeCursor(
            {
              tenantId: h.context.tenantId.value,
              routeTemplate: CANDIDATE_RECORDS_ROUTE,
              filterHash,
              sort: parsed.sort,
              timeRange: { fromMs, toMs },
              // The ORDERING key's own value.
              keyset: { sortValue: last.cursorValue, id: last.sourceRecordId },
              issuedAt: Math.floor(Date.now() / 1000),
            },
            secret,
          ),
      );

      return reply.code(200).send({
        // `cursorValue` is the route's keyset input and is not part of §5.4.4's row.
        data: response.data.map(({ cursorValue, ...row }) => {
          void cursorValue;
          return row;
        }),
        page: response.page,
        // MANDATORY for a discovery-derived listing: a partial run must not present as "no exposure found"
        // (VG-DISC-002, SPEC-000 §7.1/§7.4).
        coverage,
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.4.5 GET /v1/source-records/{sourceRecordId} — metadata and taint provenance.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/source-records/:sourceRecordId', async (request, reply) => {
    const h = beginHandler(request, reply);
    const sourceRecordId = uuidParam(request, 'sourceRecordId');

    return h.withTenant(async (tx) => {
      const record = await queries.getSourceRecord(tx, sourceRecordId);
      if (record === undefined) throw apiError('RESOURCE_NOT_FOUND');
      // `taint` is REPORTED, never softened: tainted remote content cannot direct actions (VG-SEC-001), and the API
      // surfaces the flag so a portal cannot present tainted content as trusted.
      return reply.code(200).send(record);
    });
  });
}
