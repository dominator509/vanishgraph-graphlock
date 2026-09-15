/**
 * Exposures, match assessment, disproof and the transition history (SPEC-003 §5.5).
 *
 * FIVE ROUTES, AND THE ONE THAT MATTERS MOST IS THE HISTORY. §5.5.3 and §5.5.4 move an exposure's truth
 * state; §5.5.5 is where a reviewer reads back WHAT MOVED IT, with the transition code so legality can be
 * checked against SPEC-001 §4.1 "without inference". A system whose state changes cannot be read back is a
 * system that cannot show its work, which is the invariant SM-2 exists for.
 *
 * NO HANDLER HERE SETS A TRUTH STATE. §5.5.3/§5.5.4 call one port method each, and that method runs the
 * domain command whose guard list decides whether the transition happens (SM-6). The handlers validate the
 * request, resolve the precondition, and map the outcome.
 *
 * THE ORDER OF REFUSALS IS PART OF THE CONTRACT, and it is deliberate:
 *
 *   1. `428 PRECONDITION_REQUIRED` for a missing `If-Match`, before the body is looked at — a caller that
 *      cannot prove it read the current state has nothing to say yet.
 *   2. `412 PRECONDITION_FAILED` for a stale or malformed one.
 *   3. `404 RESOURCE_NOT_FOUND`, which is also what another tenant's exposure produces (SPEC-006 H-9).
 *   4. The domain's own refusals, each with the code §5.5.3 names for it.
 */

import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { beginHandler, uuidParam, type HandlerContext } from './handler-context.ts';
import { parseQuery } from '../query/strict.ts';
import { EXPOSURES_QUERY } from '../query/filters.ts';
import { buildCollection } from '../dto/page.ts';
import { encodeCursor, decodeCursor, filterHashOf, peekCursor } from '../pagination/cursor.ts';
import { epochMillisFromIfMatch, etagFor, ifMatchHeader } from './preconditions.ts';
import type {
  AssessmentOutcome,
  ConfidenceBasisEntry,
  DisproofOutcome,
  ExposureDetail,
  ExposureListRow,
  ExposureQueries,
} from '../../application/contracts/exposure-queries.ts';
import type { TransitionQueries } from '../../application/contracts/transition-queries.ts';
import { withIdempotency } from '../plugins/idempotency.ts';
import type { TenantTransaction } from '../plugins/tenancy.ts';

const EXPOSURES_ROUTE = '/v1/exposures';

export interface ExposureRouteOptions {
  /** The cursor signing secret (SPEC-003 §2.5). Comes from configuration, never a constant. */
  readonly sessionSecret: string;
  readonly queries: ExposureQueries;
  /** The §5.5.5 read model. Separate from `queries` because it reads the audit spine, not the aggregate. */
  readonly transitions: TransitionQueries;
}

/** §5.5.1's filters, mapped onto the port's shape. Unknown members cannot appear: `parseQuery` refused them. */
function exposureFilters(filter: Readonly<Record<string, unknown>>): Parameters<ExposureQueries['listExposures']>[1]['filters'] {
  const out: {
    subjectId?: string;
    sourceId?: string;
    truthState?: string | readonly string[];
    minConfidence?: number;
    from?: string;
    to?: string;
  } = {};
  if (typeof filter['subjectId'] === 'string') out.subjectId = filter['subjectId'];
  if (typeof filter['sourceId'] === 'string') out.sourceId = filter['sourceId'];
  const truthState = filter['truthState'];
  if (typeof truthState === 'string' || Array.isArray(truthState)) {
    out.truthState = truthState as string | readonly string[];
  }
  if (typeof filter['minConfidence'] === 'number') out.minConfidence = filter['minConfidence'];
  if (typeof filter['from'] === 'string') out.from = filter['from'];
  if (typeof filter['to'] === 'string') out.to = filter['to'];
  return out;
}

/** A confidence object exactly as §5.5.1 defines it: a score with a non-empty basis, or a refusal. */
function confidenceFrom(body: Record<string, unknown>): { value: number; basis: readonly ConfidenceBasisEntry[] } {
  const raw = body['confidence'];
  if (typeof raw !== 'object' || raw === null) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'confidence' });
  }
  const candidate = raw as { value?: unknown; basis?: unknown };
  // OUT OF RANGE IS ITS OWN CODE (§5.5.3 lists `422 CONFIDENCE_OUT_OF_RANGE`), because a score of 1.4 is a
  // different mistake from a score with no basis — the first is a number the domain cannot use, the second is
  // a claim that cannot be supported at all (VG-IDENT-003).
  if (typeof candidate.value !== 'number' || !Number.isFinite(candidate.value)) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'confidence.value' });
  }
  if (candidate.value < 0 || candidate.value > 1) {
    throw apiError('CONFIDENCE_OUT_OF_RANGE', { field: 'confidence.value' });
  }
  if (!Array.isArray(candidate.basis) || candidate.basis.length === 0) {
    // §5.5.1: "a score without `basis` is unrepresentable". A basis-less score is refused rather than stored
    // with an empty array, which the column's CHECK would refuse anyway.
    throw apiError('CONFIDENCE_BASIS_REQUIRED', { field: 'confidence.basis' });
  }
  const basis = candidate.basis.map((entry) => {
    const item = entry as { feature?: unknown; weight?: unknown };
    if (typeof item.feature !== 'string' || item.feature.length === 0 || typeof item.weight !== 'number') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'confidence.basis' });
    }
    return { feature: item.feature, weight: item.weight };
  });
  return { value: candidate.value, basis };
}

function tokenField(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

/**
 * A uuid body field, or `null` when absent.
 *
 * The evidence columns are `uuid`, so a wire-shaped id (`evd_01H…`) cannot be stored and is refused as a
 * malformed field rather than passed down to fail in SQL.
 */
function uuidField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

/** Run a §5.5 write under idempotency control: the port call runs only on a newly claimed key. */
async function idempotent(
  h: HandlerContext,
  work: (tx: TenantTransaction) => Promise<{ status: number; body: unknown; resourceId?: string | null }>,
): Promise<unknown> {
  return withIdempotency<unknown>(h.request, h.request.server.vgIdempotency, h.reply, () => h.withTenant(work));
}

/**
 * Map a §5.5 write outcome onto the wire.
 *
 * ONE PLACE, BOTH ROUTES: §5.5.3 and §5.5.4 refuse for the same reasons — a stale precondition, a wrong
 * current state, absent evidence, a search-engine class — and two copies of that mapping is how one route
 * comes to answer a code the other does not.
 */
function refusal(outcome: Exclude<AssessmentOutcome, { readonly ok: true }>): never {
  switch (outcome.reason) {
    case 'NOT_FOUND':
      throw apiError('RESOURCE_NOT_FOUND');
    case 'PRECONDITION_FAILED':
      // §2.7 requires the CURRENT ETag in a 412 body, so the caller can retry against a token rather than
      // re-reading the resource to discover it.
      throw apiError('PRECONDITION_FAILED', {
        currentEtag: etagFor(outcome.truthState, outcome.currentRowVersionMs),
      });
    case 'ILLEGAL_TRANSITION':
      // The state the exposure is actually in, which is what makes the refusal actionable.
      throw apiError('ILLEGAL_TRANSITION', { fromTruthState: outcome.fromTruthState });
    case 'EVIDENCE_NOT_FOUND':
      throw apiError('EVIDENCE_NOT_FOUND', { field: 'evidenceArtifactId' });
    case 'IDENTITY_CLASS_MISMATCH':
      throw apiError('IDENTITY_CLASS_MISMATCH', { field: 'exposureId' });
    case 'THRESHOLD_UNRESOLVED':
      // The policy version in force records no match threshold, so T3 cannot be evaluated. Refused with the
      // jurisdiction named rather than evaluated against a number the service chose for the caller.
      throw apiError('JURISDICTION_UNRESOLVED', { field: 'jurisdiction' });
  }
}

export function exposureRoutes(app: FastifyInstance, options: ExposureRouteOptions): void {
  const secret = options.sessionSecret;
  const queries = options.queries;
  const transitions = options.transitions;

  // ---------------------------------------------------------------------------------------------
  // 5.5.1 GET /v1/exposures — list, keyset-paginated.
  // ---------------------------------------------------------------------------------------------
  app.get(EXPOSURES_ROUTE, async (request, reply) => {
    const h = beginHandler(request, reply);
    // THE CURSOR IS READ BEFORE THE QUERY IS PARSED, so a continuation can inherit the time window its first
    // page used. The default window is resolved against the clock, so without this every second page hashed a
    // different filter and was refused INVALID_CURSOR (see cursor.ts). The signature is still verified by
    // peekCursor, and the binding check below still runs — a peek is not an authorisation.
    const rawQuery = request.query as Record<string, unknown>;
    const peeked =
      typeof rawQuery['cursor'] === 'string' ? peekCursor(rawQuery['cursor'], secret) : undefined;
    const parsed = parseQuery(
      rawQuery,
      EXPOSURES_QUERY,
      Date.now,
      peeked?.timeRange,
    );
    const filterHash = filterHashOf(parsed.filter);

    const after =
      parsed.cursor === undefined
        ? undefined
        : (() => {
            const decoded = decodeCursor(parsed.cursor, secret, {
              tenantId: h.context.tenantId.value,
              routeTemplate: EXPOSURES_ROUTE,
              filterHash,
              sort: parsed.sort,
            });
            return {
              sortValue: typeof decoded.keyset.sortValue === 'string' ? decoded.keyset.sortValue : '',
              id: decoded.keyset.id,
            };
          })();

    return h.withTenant(async (tx) => {
      const rows = await queries.listExposures(tx, {
        limit: parsed.limit,
        sort: parsed.sort,
        filters: exposureFilters(parsed.filter),
        ...(after === undefined ? {} : { after }),
      });

      const response = buildCollection(
        rows,
        { limit: parsed.limit, sort: parsed.sort, filter: parsed.filter },
        (last: ExposureListRow) =>
          encodeCursor(
            {
              tenantId: h.context.tenantId.value,
              routeTemplate: EXPOSURES_ROUTE,
              filterHash,
              sort: parsed.sort,
              // The keyset value is the SORT FIELD's value, which is what makes the next page a continuation
              // rather than a re-read: `observedAt` sorts on `lastObservedAt`, the other two on their own.
              // The window this walk started with, so the next page applies the SAME one.
              ...(typeof parsed.filter['from'] === 'string' && typeof parsed.filter['to'] === 'string'
                ? {
                    timeRange: {
                      fromMs: Date.parse(parsed.filter['from']),
                      toMs: Date.parse(parsed.filter['to']),
                    },
                  }
                : {}),
              keyset: { sortValue: sortValueOf(last, parsed.sort), id: last.exposureId },
              issuedAt: Math.floor(Date.now() / 1000),
            },
            secret,
          ),
      );
      return reply.code(200).send(response);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.5.2 GET /v1/exposures/{exposureId} — detail, with an ETag.
  // ---------------------------------------------------------------------------------------------
  app.get(`${EXPOSURES_ROUTE}/:exposureId`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const exposureId = uuidParam(request, 'exposureId');

    return h.withTenant(async (tx) => {
      const detail = await queries.getExposureDetail(tx, exposureId);
      if (detail === undefined) throw apiError('RESOURCE_NOT_FOUND');
      // §2.7's case-style ETag for a truth-state-bearing resource: `<truthState>:<updatedAtEpochMillis>`.
      reply.header('etag', etagFor(detail.truthState, detail.rowVersionMs));
      return reply.code(200).send(toDetailDto(detail));
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.5.3 POST /v1/exposures/{exposureId}/match-assessments — drives T3.
  // ---------------------------------------------------------------------------------------------
  app.post(`${EXPOSURES_ROUTE}/:exposureId/match-assessments`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const exposureId = uuidParam(request, 'exposureId');
    const expectedRowVersionMs = epochMillisFromIfMatch(ifMatchHeader(request));

    const body = (request.body ?? {}) as Record<string, unknown>;
    const confidence = confidenceFrom(body);
    const method = tokenField(body, 'method', 120);
    const humanReviewed = body['humanReviewed'];
    if (humanReviewed !== undefined && typeof humanReviewed !== 'boolean') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'humanReviewed' });
    }
    const evidenceArtifactId = body['evidenceArtifactId'] === undefined ? null : uuidField(body, 'evidenceArtifactId');

    return idempotent(h, async (tx) => {
      const outcome = await queries.recordMatchAssessment(tx, {
        exposureId,
        expectedRowVersionMs,
        confidence,
        method,
        humanReviewed: humanReviewed === true,
        evidenceArtifactId,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) refusal(outcome);

      // The ETag after the write is the NEW version, so a caller can chain a second write without re-reading.
      const current = await queries.exposureRowVersion(tx, exposureId);
      if (current !== undefined) reply.header('etag', etagFor(current.truthState, current.rowVersionMs));
      return { status: 200, body: outcome.response, resourceId: exposureId };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.5.4 POST /v1/exposures/{exposureId}/disproofs — drives T4.
  // ---------------------------------------------------------------------------------------------
  app.post(`${EXPOSURES_ROUTE}/:exposureId/disproofs`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const exposureId = uuidParam(request, 'exposureId');
    const expectedRowVersionMs = epochMillisFromIfMatch(ifMatchHeader(request));

    const body = (request.body ?? {}) as Record<string, unknown>;
    const disproofBasis = tokenField(body, 'disproofBasis', 120);
    const evidenceArtifactId = uuidField(body, 'evidenceArtifactId');
    const scanComplete = body['scanComplete'];
    if (typeof scanComplete !== 'boolean') throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'scanComplete' });
    const coverageBounds = coverageFrom(body);

    // §5.5.4: "If `scanComplete` is `false` or coverage is partial, the request is refused with
    // `422 COVERAGE_BOUNDS_REQUIRED`: absence may not be reported from an incomplete scan (VG-DISC-002)".
    // This is checked BEFORE the transaction: a refusal that depends only on the request needs no database.
    if (!scanComplete || coverageBounds.sourcesAttempted < coverageBounds.sourcesTotal) {
      throw apiError('COVERAGE_BOUNDS_REQUIRED', { field: 'coverageBounds' });
    }

    return idempotent(h, async (tx) => {
      const outcome: DisproofOutcome = await queries.recordDisproof(tx, {
        exposureId,
        expectedRowVersionMs,
        disproofBasis,
        evidenceArtifactId,
        scanComplete,
        coverageBounds,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) refusal(outcome);

      const current = await queries.exposureRowVersion(tx, exposureId);
      if (current !== undefined) reply.header('etag', etagFor(current.truthState, current.rowVersionMs));
      return { status: 200, body: outcome.response, resourceId: exposureId };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.5.5 GET /v1/exposures/{exposureId}/transitions — the append-only history.
  // ---------------------------------------------------------------------------------------------
  app.get(`${EXPOSURES_ROUTE}/:exposureId/transitions`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const exposureId = uuidParam(request, 'exposureId');

    return h.withTenant(async (tx) => {
      // The exposure must EXIST for the history to be a history of something: an unknown id and another
      // tenant's id both answer 404 rather than an empty list, which would claim the resource exists and has
      // no transitions (SPEC-006 H-9's "indistinguishable" rule cuts both ways).
      const detail = await queries.exposureRowVersion(tx, exposureId);
      if (detail === undefined) throw apiError('RESOURCE_NOT_FOUND');
      const rows = await transitions.listTransitionsForExposure(tx, exposureId);
      return reply.code(200).send({
        data: rows.map((row) => ({
          transitionId: row.transitionId,
          transitionCode: row.transitionCode,
          fromTruthState: row.fromTruthState,
          toTruthState: row.toTruthState,
          occurredAt: row.occurredAt,
          actorIdentity: row.actorIdentity,
          command: row.command,
          evidenceArtifactIds: [...row.evidenceArtifactIds],
          correlationId: row.correlationId,
        })),
      });
    });
  });
}

/** The keyset value for the applied sort field, taken from the row the cursor is minted on. */
function sortValueOf(row: ExposureListRow, sort: string): string {
  const [field = 'observedAt'] = sort.split(':');
  if (field === 'confidence') return String(row.confidence.value);
  if (field === 'truthState') return row.truthState;
  return row.lastObservedAt;
}

/**
 * `coverageBounds` in §5.5.4's request: two counts, both required, neither inferable.
 *
 * THE 422 OVERRIDE IS DELIBERATE. Both failures below are SEMANTIC — the request is well formed JSON and
 * cannot be honoured — and §5.5.4 lists `422 SCHEMA_VALIDATION_FAILED` beside its other 422 refusals. The same
 * distinction `src/http/routes/deadlines.ts` draws; without the override the envelope would answer 400, the
 * syntactic spelling, for a body whose *shape* is fine and whose *content* is impossible.
 */
function coverageFrom(body: Record<string, unknown>): {
  readonly sourcesAttempted: number;
  readonly sourcesTotal: number;
} {
  const raw = body['coverageBounds'];
  if (typeof raw !== 'object' || raw === null) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'coverageBounds' }, 422);
  }
  const candidate = raw as { sourcesAttempted?: unknown; sourcesTotal?: unknown };
  if (
    typeof candidate.sourcesAttempted !== 'number' ||
    typeof candidate.sourcesTotal !== 'number' ||
    !Number.isInteger(candidate.sourcesAttempted) ||
    !Number.isInteger(candidate.sourcesTotal) ||
    candidate.sourcesAttempted < 0 ||
    candidate.sourcesTotal < 1
  ) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'coverageBounds' }, 422);
  }
  return { sourcesAttempted: candidate.sourcesAttempted, sourcesTotal: candidate.sourcesTotal };
}

/**
 * The §5.5.2 response body.
 *
 * `rowVersionMs` is REMOVED, not renamed: §2.7 puts the concurrency token in the `ETag` header, and a body
 * copy would be a second way for a client to satisfy `If-Match` — one that keeps working after the header
 * format changes, which is how two tokens for one thing come to disagree.
 */
function toDetailDto(detail: ExposureDetail): Omit<ExposureDetail, 'rowVersionMs'> {
  const { rowVersionMs, ...rest } = detail;
  void rowVersionMs;
  return rest;
}
