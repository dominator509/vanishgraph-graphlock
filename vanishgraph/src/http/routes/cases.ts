/**
 * Cases: list, detail, timeline, creation, guarded transition and human gates (SPEC-003 §5.7).
 *
 * THE SIX ROUTES SPLIT INTO TWO KINDS OF WORK, and the split is the point:
 *
 *   * §5.7.2/§5.7.3/§5.7.6 READ. They report what the tables hold — counts, the last transition, the merged
 *     timeline — and no handler in this file derives a truth state from anything.
 *   * §5.7.1/§5.7.4/§5.7.5 CHANGE. Each calls one port method, and that method runs one domain command or one
 *     insert. `requestedTruthState` is validated against `ROUTEABLE_CASE_TARGETS` here and then HANDED TO THE
 *     COMMAND, which evaluates the SPEC-001 §4.1 guard list and either applies the transition or refuses. This
 *     file never chooses a state, which is what SM-6 requires and what the handler scan in `gate-api` asserts.
 *
 * §5.7.4's `requestedTruthState` IS NOT AN ASSIGNMENT, and the refusals say so: a target outside the routeable
 * set is `422 TRANSITION_NOT_ROUTEABLE`, a target the current state cannot reach is `409 ILLEGAL_TRANSITION`
 * (with both states named), and a target whose guard fails is `422 GUARD_FAILED` naming the guard.
 */

import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { beginHandler, uuidParam } from './handler-context.ts';
import { parseQuery } from '../query/strict.ts';
import { CASES_QUERY } from '../query/filters.ts';
import { buildCollection } from '../dto/page.ts';
import { encodeCursor, decodeCursor, filterHashOf, peekCursor } from '../pagination/cursor.ts';
import { epochMillisFromIfMatch, etagFor, ifMatchHeader } from './preconditions.ts';
import { idempotentWrite } from './idempotent-write.ts';
import type {
  CaseListRow,
  CaseQueries,
  CreateCaseOutcome,
  GuardedUpdateOutcome,
  HumanGateOutcome,
} from '../../application/contracts/case-queries.ts';
import type { TransitionQueries } from '../../application/contracts/transition-queries.ts';
import { ALL_TRUTH_STATES } from '../../application/contracts/index.ts';
import { ROUTEABLE_CASE_TARGETS } from '../../application/contracts/case-queries.ts';

const CASES_ROUTE = '/v1/cases';

export interface CaseRouteOptions {
  readonly sessionSecret: string;
  readonly queries: CaseQueries;
  /** The spine, for callers that need a case's history rather than its latest entry. */
  readonly transitions: TransitionQueries;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidBodyField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

/** §5.7.2's filters, mapped onto the port's shape. Unknown members cannot appear: `parseQuery` refused them. */
function caseFilters(filter: Readonly<Record<string, unknown>>): Parameters<CaseQueries['listCases']>[1]['filters'] {
  const out: {
    subjectId?: string;
    sourceId?: string;
    truthState?: string | readonly string[];
    channel?: string;
    authorityGrantState?: string | readonly string[];
    from?: string;
    to?: string;
  } = {};
  if (typeof filter['subjectId'] === 'string') out.subjectId = filter['subjectId'];
  if (typeof filter['sourceId'] === 'string') out.sourceId = filter['sourceId'];
  const truthState = filter['truthState'];
  if (typeof truthState === 'string' || Array.isArray(truthState)) {
    out.truthState = truthState as string | readonly string[];
  }
  if (typeof filter['channel'] === 'string') out.channel = filter['channel'];
  const authority = filter['authorityGrantState'];
  if (typeof authority === 'string' || Array.isArray(authority)) {
    out.authorityGrantState = authority as string | readonly string[];
  }
  if (typeof filter['from'] === 'string') out.from = filter['from'];
  if (typeof filter['to'] === 'string') out.to = filter['to'];
  return out;
}

/** The keyset value for the applied sort field. */
function sortValueOf(row: CaseListRow, sort: string): string {
  const [field = 'updatedAt'] = sort.split(':');
  if (field === 'truthState') return row.truthState;
  if (field === 'createdAt') return row.updatedAt;
  return row.updatedAt;
}

export function caseRoutes(app: FastifyInstance, options: CaseRouteOptions): void {
  const secret = options.sessionSecret;
  const queries = options.queries;

  // ---------------------------------------------------------------------------------------------
  // 5.7.2 GET /v1/cases — list, keyset-paginated.
  // ---------------------------------------------------------------------------------------------
  app.get(CASES_ROUTE, async (request, reply) => {
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
      CASES_QUERY,
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
              routeTemplate: CASES_ROUTE,
              filterHash,
              sort: parsed.sort,
            });
            return {
              sortValue: typeof decoded.keyset.sortValue === 'string' ? decoded.keyset.sortValue : '',
              id: decoded.keyset.id,
            };
          })();

    return h.withTenant(async (tx) => {
      const rows = await queries.listCases(tx, {
        limit: parsed.limit,
        sort: parsed.sort,
        filters: caseFilters(parsed.filter),
        ...(after === undefined ? {} : { after }),
      });

      const response = buildCollection(
        rows,
        { limit: parsed.limit, sort: parsed.sort, filter: parsed.filter },
        (last: CaseListRow) =>
          encodeCursor(
            {
              tenantId: h.context.tenantId.value,
              routeTemplate: CASES_ROUTE,
              filterHash,
              sort: parsed.sort,
              // The window this walk started with, so the next page applies the SAME one.
              ...(typeof parsed.filter['from'] === 'string' && typeof parsed.filter['to'] === 'string'
                ? {
                    timeRange: {
                      fromMs: Date.parse(parsed.filter['from']),
                      toMs: Date.parse(parsed.filter['to']),
                    },
                  }
                : {}),
              keyset: { sortValue: sortValueOf(last, parsed.sort), id: last.caseId },
              issuedAt: Math.floor(Date.now() / 1000),
            },
            secret,
          ),
      );
      return reply.code(200).send(response);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.7.1 POST /v1/cases — create the durable case for one subject × source × exposure.
  // ---------------------------------------------------------------------------------------------
  app.post(CASES_ROUTE, async (request, reply) => {
    const h = beginHandler(request, reply);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const subjectId = uuidBodyField(body, 'subjectId');
    const exposureId = uuidBodyField(body, 'exposureId');
    const sourceId = uuidBodyField(body, 'sourceId');
    const authorityGrantId = uuidBodyField(body, 'authorityGrantId');
    const policyDecisionId = uuidBodyField(body, 'policyDecisionId');
    const recipeId = uuidBodyField(body, 'recipeId');

    return idempotentWrite(h, async (tx) => {
      const outcome: CreateCaseOutcome = await queries.createCase(tx, {
        subjectId,
        exposureId,
        sourceId,
        authorityGrantId,
        policyDecisionId,
        recipeId,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'EXPOSURE_NOT_FOUND':
            throw apiError('RESOURCE_NOT_FOUND');
          case 'CASE_ALREADY_EXISTS':
            // "same subject × source × exposure with a live case" (§5.7.1). A conflict, not a validation error:
            // the request is well formed and the world is not in the state it assumes.
            throw apiError('CASE_ALREADY_EXISTS', { field: 'exposureId' });
          case 'CASE_EXPOSURE_STATE_MISMATCH':
            throw apiError('CASE_EXPOSURE_STATE_MISMATCH', { fromTruthState: outcome.exposureState });
          case 'AUTHORITY_GRANT_SCOPE_INSUFFICIENT':
            throw apiError('AUTHORITY_GRANT_SCOPE_INSUFFICIENT', { field: 'authorityGrantId' });
          case 'POLICY_DECISION_INCOMPLETE':
            throw apiError('POLICY_DECISION_INCOMPLETE', { field: 'policyDecisionId' });
          case 'RECIPE_NOT_ENABLED':
            throw apiError('RECIPE_NOT_ENABLED', { field: 'recipeId' });
        }
      }

      const detail = await queries.getCaseDetail(tx, outcome.caseId);
      reply.header('location', `${CASES_ROUTE}/${outcome.caseId}`);
      if (detail !== undefined) reply.header('etag', etagFor(detail.truthState, detail.rowVersionMs));
      return {
        status: 201,
        body: {
          caseId: outcome.caseId,
          subjectId,
          exposureId,
          sourceId,
          truthState: outcome.truthState,
          authorityGrantId,
          policyDecisionId,
          recipeId,
          createdAt: outcome.createdAt,
          deadlines: detail?.deadlines ?? [],
        },
        resourceId: outcome.caseId,
      };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.7.3 GET /v1/cases/{caseId} — detail, with an ETag.
  // ---------------------------------------------------------------------------------------------
  app.get(`${CASES_ROUTE}/:caseId`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');

    return h.withTenant(async (tx) => {
      const detail = await queries.getCaseDetail(tx, caseId);
      if (detail === undefined) throw apiError('RESOURCE_NOT_FOUND');
      reply.header('etag', etagFor(detail.truthState, detail.rowVersionMs));
      return reply.code(200).send(toDetailDto(detail));
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.7.4 PATCH /v1/cases/{caseId} — a guarded transition, never an assignment.
  // ---------------------------------------------------------------------------------------------
  app.patch(`${CASES_ROUTE}/:caseId`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');
    const expectedRowVersionMs = epochMillisFromIfMatch(ifMatchHeader(request));

    const body = (request.body ?? {}) as Record<string, unknown>;
    const requestedTruthState = body['requestedTruthState'];
    if (typeof requestedTruthState !== 'string' || requestedTruthState.length === 0) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'requestedTruthState' });
    }
    // §5.7.4's LICENCE IS CHECKED HERE, BEFORE THE TRANSACTION, because it depends on nothing but the request: a
    // state that is not one of the eleven canon is `400 INVALID_TRUTH_STATE`, and one that is but is reachable
    // only through its own effect or observation route is `422 TRANSITION_NOT_ROUTEABLE`. Answering either
    // without opening a transaction keeps a refusal cheap, and the port re-checks the same set so a non-HTTP
    // caller is protected too.
    if (!(ALL_TRUTH_STATES as readonly string[]).includes(requestedTruthState)) {
      throw apiError('INVALID_TRUTH_STATE', { field: 'requestedTruthState' });
    }
    if (!ROUTEABLE_CASE_TARGETS.includes(requestedTruthState)) {
      throw apiError('TRANSITION_NOT_ROUTEABLE', { field: 'requestedTruthState' });
    }
    const reason = body['reason'];
    if (typeof reason !== 'object' || reason === null) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'reason' });
    }
    const reasonFields = reason as { code?: unknown; detail?: unknown };
    if (typeof reasonFields.code !== 'string' || typeof reasonFields.detail !== 'string') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'reason' });
    }
    const artifactIds = body['evidenceArtifactIds'];
    if (artifactIds !== undefined && !Array.isArray(artifactIds)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'evidenceArtifactIds' });
    }
    const evidenceArtifactIds = (artifactIds ?? []).map((entry) => {
      if (typeof entry !== 'string' || !UUID_SHAPE.test(entry)) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'evidenceArtifactIds' });
      }
      return entry;
    });

    return idempotentWrite(h, async (tx) => {
      const outcome: GuardedUpdateOutcome = await queries.guardedUpdate(tx, {
        caseId,
        expectedRowVersionMs,
        requestedTruthState,
        reasonCode: reasonFields.code as string,
        reasonDetail: reasonFields.detail as string,
        evidenceArtifactIds,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
        decisionId: null,
      });
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'NOT_FOUND':
            throw apiError('RESOURCE_NOT_FOUND');
          case 'PRECONDITION_FAILED':
            throw apiError('PRECONDITION_FAILED', {
              currentEtag: etagFor(outcome.truthState, outcome.currentRowVersionMs),
            });
          case 'TRANSITION_NOT_ROUTEABLE':
            throw apiError('TRANSITION_NOT_ROUTEABLE', { field: 'requestedTruthState' });
          case 'ILLEGAL_TRANSITION':
            throw apiError('ILLEGAL_TRANSITION', {
              fromTruthState: outcome.fromTruthState,
              toTruthState: outcome.toTruthState,
            });
          case 'GUARD_FAILED':
            throw apiError('GUARD_FAILED', { guard: outcome.guard }, 422);
          case 'EVIDENCE_REQUIRED':
            throw apiError('EVIDENCE_REQUIRED', { field: 'evidenceArtifactIds' }, 422);
          case 'EVIDENCE_NOT_FOUND':
            throw apiError('EVIDENCE_NOT_FOUND', { field: 'evidenceArtifactIds' }, 422);
          case 'POLICY_DECISION_INCOMPLETE':
            throw apiError('POLICY_DECISION_INCOMPLETE', { field: 'policyDecisionId' }, 422);
          case 'AUTHORITY_GRANT_SCOPE_INSUFFICIENT':
            throw apiError('AUTHORITY_GRANT_SCOPE_INSUFFICIENT', { field: 'authorityGrantId' });
        }
      }

      const current = await queries.caseRowVersion(tx, caseId);
      if (current !== undefined) reply.header('etag', etagFor(current.truthState, current.rowVersionMs));
      return {
        status: 200,
        body: {
          caseId,
          truthState: outcome.truthState,
          transitionCode: outcome.transitionCode,
          guardsEvaluated: outcome.guardsEvaluated,
          transitionId: outcome.transitionId,
        },
        resourceId: caseId,
      };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.7.5 POST /v1/cases/{caseId}/human-gates — record a gate and drive HUMAN_REQUIRED.
  // ---------------------------------------------------------------------------------------------
  app.post(`${CASES_ROUTE}/:caseId/human-gates`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');
    const expectedRowVersionMs = epochMillisFromIfMatch(ifMatchHeader(request));

    const body = (request.body ?? {}) as Record<string, unknown>;
    const gateKind = body['gateKind'];
    const detectedAt = body['detectedAt'];
    if (typeof gateKind !== 'string' || gateKind.length === 0) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'gateKind' });
    }
    if (typeof detectedAt !== 'string' || Number.isNaN(Date.parse(detectedAt))) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'detectedAt' });
    }
    const evidenceRaw = body['evidenceArtifactId'];
    let evidenceArtifactId: string | null = null;
    if (evidenceRaw !== undefined) {
      if (typeof evidenceRaw !== 'string' || !UUID_SHAPE.test(evidenceRaw)) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'evidenceArtifactId' });
      }
      evidenceArtifactId = evidenceRaw;
    }
    const attemptedBypass = body['attemptedBypass'];
    if (attemptedBypass !== undefined && typeof attemptedBypass !== 'boolean') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'attemptedBypass' });
    }
    // VG-DISC-004: a bypass attempt is refused BEFORE the body is used for anything. Checked here as well as in
    // the port so the request never opens a transaction when it is refused for this reason.
    if (attemptedBypass === true) {
      throw apiError('BYPASS_ATTEMPT_REFUSED', { field: 'attemptedBypass' });
    }

    return idempotentWrite(h, async (tx) => {
      const outcome: HumanGateOutcome = await queries.recordHumanGate(tx, {
        caseId,
        expectedRowVersionMs,
        gateKind,
        detectedAt,
        evidenceArtifactId,
        // The route refused `true` above, so this is `false` or absent by construction. The port re-checks it
        // rather than trusting the handler, and passing the narrowed value keeps that check reachable from any
        // other caller.
        attemptedBypass: attemptedBypass ?? false,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'NOT_FOUND':
            throw apiError('RESOURCE_NOT_FOUND');
          case 'PRECONDITION_FAILED':
            throw apiError('PRECONDITION_FAILED', {
              currentEtag: etagFor(outcome.truthState, outcome.currentRowVersionMs),
            });
          case 'ILLEGAL_TRANSITION':
            // Includes an unknown gate kind: a gate that cannot be routed to a human is one nobody is told
            // about, so it is refused rather than stored.
            throw apiError('ILLEGAL_TRANSITION', { fromTruthState: outcome.fromTruthState });
          case 'EVIDENCE_NOT_FOUND':
            throw apiError('EVIDENCE_NOT_FOUND', { field: 'evidenceArtifactId' }, 422);
          case 'BYPASS_ATTEMPT_REFUSED':
            throw apiError('BYPASS_ATTEMPT_REFUSED', { field: 'attemptedBypass' });
        }
      }

      const current = await queries.caseRowVersion(tx, caseId);
      if (current !== undefined) reply.header('etag', etagFor(current.truthState, current.rowVersionMs));
      return {
        status: 200,
        body: {
          caseId,
          truthState: outcome.truthState,
          transitionCode: outcome.transitionCode,
          gateId: outcome.gateId,
          humanQueue: outcome.humanQueue,
          serviceLevelDueAt: outcome.serviceLevelDueAt,
        },
        resourceId: outcome.gateId,
      };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.7.6 GET /v1/cases/{caseId}/timeline — the merged, chronological, append-only view.
  // ---------------------------------------------------------------------------------------------
  app.get(`${CASES_ROUTE}/:caseId/timeline`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');

    return h.withTenant(async (tx) => {
      // The case must exist for the timeline to be a timeline of something: an unknown id and another tenant's
      // id both answer 404 rather than an empty list, which would claim the case exists and has no history.
      const version = await queries.caseRowVersion(tx, caseId);
      if (version === undefined) throw apiError('RESOURCE_NOT_FOUND');
      const entries = await queries.listTimeline(tx, caseId);
      return reply.code(200).send({ data: entries.map((entry) => ({ ...entry })) });
    });
  });
}

/**
 * The §5.7.3 body: `rowVersionMs` REMOVED, not renamed.
 *
 * §2.7 puts the concurrency token in the `ETag` header, and a body copy would be a second way for a client to
 * satisfy `If-Match` — one that keeps working after the header format changes, which is how two tokens for one
 * thing come to disagree.
 */
function toDetailDto(detail: Awaited<ReturnType<CaseQueries['getCaseDetail']>> & object): unknown {
  const { rowVersionMs, ...rest } = detail as { rowVersionMs: number } & Record<string, unknown>;
  void rowVersionMs;
  return rest;
}
