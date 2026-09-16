/**
 * Verification observations and reappearances (SPEC-003 §5.10, §5.11).
 *
 * 6 of the 78 routes: four reads sharing `vg.observations.read` and two writes sharing `vg.observations.write`.
 * Same structure as the rest of this boundary: `beginHandler` (registry entry, scopes, step-up, tenant-scoped
 * transaction) → strict query parsing → ONE port call → map and return.
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
 * THE TWO WRITES DRIVE T14 AND T17/T20, AND NEITHER DECIDES A STATE HERE. §5.10.1 and §5.11.1 call one port
 * method each; that method runs the domain command whose guard list decides, and a refusal leaves the state
 * where it was (VG-VERIFY-004: a failed verification never regresses into a success state). The handlers
 * validate the request, resolve the precondition, and map the outcome — nothing more.
 *
 * `reentry` IS REPORTED ON A REAPPEARANCE AND `transitionCode` IS NOT, on the READ routes, and the difference
 * is deliberate. §5.11.2 requires `reentry` on every row; it is a statement about the RULES the contract
 * declares for re-entry (SPEC-001 T18's guards), so it is the same for every row and reporting it is honest.
 * A read row's `transitionCode` and `priorTruthState` come from the transition record: the WRITE route
 * (§5.11.1) knows them directly because it just performed the transition, while a HISTORICAL row would have to
 * guess which of T17/T20 produced it, so the reads report only what the row records.
 */

import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { beginHandler, uuidParam } from './handler-context.ts';
import { parseQuery } from '../query/strict.ts';
import { REAPPEARANCES_QUERY } from '../query/filters.ts';
import { buildCollection } from '../dto/page.ts';
import { encodeCursor, decodeCursor, filterHashOf, peekCursor } from '../pagination/cursor.ts';
import { epochMillisFromIfMatch, etagFor, ifMatchHeader } from './preconditions.ts';
import { idempotentWrite } from './idempotent-write.ts';
import type {
  ObservationQueries,
  ReappearanceRow,
  ReappearanceWriteOutcome,
  VerificationWriteOutcome,
} from '../../application/contracts/observation-queries.ts';
import { isApiFinding, RE_ENTRY_STATE_SQL } from '../../application/contracts/observation-queries.ts';

export interface ObservationRouteOptions {
  /** The cursor signing secret (SPEC-003 §2.5). From configuration, never a constant. */
  readonly sessionSecret: string;
  /** The read model, injected as a PORT: the boundary must not import `src/adapters/**`. */
  readonly queries: ObservationQueries;
}

const REAPPEARANCES_ROUTE = '/v1/reappearances';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A bounded non-empty string body field, refused rather than truncated. */
function tokenBodyField(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

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
  // 5.10.1 POST /v1/cases/{caseId}/verification-observations — drives T14, or records a failed check.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/cases/:caseId/verification-observations', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');
    const expectedRowVersionMs = epochMillisFromIfMatch(ifMatchHeader(request));

    const body = (request.body ?? {}) as Record<string, unknown>;
    const observationMethod = tokenBodyField(body, 'observationMethod', 120);
    const actorIdentity = tokenBodyField(body, 'actorIdentity', 200);
    const observationPathId = tokenBodyField(body, 'observationPathId', 200);
    const actingPathId = tokenBodyField(body, 'actingPathId', 200);
    const observedAt = body['observedAt'];
    if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'observedAt' });
    }
    const finding = body['finding'];
    if (typeof finding !== 'string' || !isApiFinding(finding)) {
      // The wire vocabulary is CLOSED (§5.10.1 lists three tokens). A stored `PRESENT` echoed back by a caller
      // is not one of them, and accepting it would put a token on the wire that this API cannot accept twice.
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'finding' });
    }
    const evidenceRaw = body['evidenceArtifactId'];
    let evidenceArtifactId: string | null = null;
    if (evidenceRaw !== undefined) {
      if (typeof evidenceRaw !== 'string' || !UUID_SHAPE.test(evidenceRaw)) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'evidenceArtifactId' });
      }
      evidenceArtifactId = evidenceRaw;
    }
    const windowRaw = body['windowSatisfied'];
    if (typeof windowRaw !== 'object' || windowRaw === null) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'windowSatisfied' });
    }
    const requiredSeconds = (windowRaw as { requiredSeconds?: unknown }).requiredSeconds;
    if (typeof requiredSeconds !== 'number' || !Number.isInteger(requiredSeconds) || requiredSeconds <= 0) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'windowSatisfied' });
    }

    return idempotentWrite(h, async (tx) => {
      const outcome: VerificationWriteOutcome = await queries.recordVerificationObservation(tx, {
        caseId,
        expectedRowVersionMs,
        observationMethod,
        actorIdentity,
        observationPathId,
        actingPathId,
        observedAt,
        finding,
        evidenceArtifactId,
        // The REQUEST supplies the requirement; the port computes whether it was met. `elapsedSeconds` and `met`
        // in the body are deliberately NOT READ — a control a caller can waive with a boolean is not a control.
        requiredSeconds,
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
            throw apiError('ILLEGAL_TRANSITION', { fromTruthState: outcome.fromTruthState });
          case 'OBSERVATION_PATH_NOT_INDEPENDENT':
            throw apiError('OBSERVATION_PATH_NOT_INDEPENDENT', { field: 'observationPathId' });
          case 'OBSERVATION_WINDOW_NOT_MET':
            throw apiError(
              'OBSERVATION_WINDOW_NOT_MET',
              {
                requiredSeconds: outcome.requiredSeconds,
                ...(outcome.elapsedSeconds === null ? {} : { elapsedSeconds: outcome.elapsedSeconds }),
              },
              422,
            );
          case 'OBSERVATION_METHOD_MISMATCH':
            throw apiError(
              'OBSERVATION_METHOD_MISMATCH',
              { required: outcome.required, supplied: outcome.supplied },
              422,
            );
          case 'EVIDENCE_NOT_FOUND':
            throw apiError('EVIDENCE_NOT_FOUND', { field: 'evidenceArtifactId' }, 422);
        }
      }

      const current = await queries.caseRowVersion(tx, caseId);
      if (current !== undefined) reply.header('etag', etagFor(current.truthState, current.rowVersionMs));
      return { status: 200, body: outcome.response, resourceId: outcome.response.verificationObservationId };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.11.1 POST /v1/exposures/{exposureId}/reappearances — drives T17 or T20.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/exposures/:exposureId/reappearances', async (request, reply) => {
    const h = beginHandler(request, reply);
    const exposureId = uuidParam(request, 'exposureId');
    const expectedRowVersionMs = epochMillisFromIfMatch(ifMatchHeader(request));

    const body = (request.body ?? {}) as Record<string, unknown>;
    const priorRemovedRaw = body['priorRemovedEventId'];
    if (typeof priorRemovedRaw !== 'string' || priorRemovedRaw.length === 0) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'priorRemovedEventId' });
    }
    const observedAt = body['observedAt'];
    if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'observedAt' });
    }
    const observationMethod = tokenBodyField(body, 'observationMethod', 120);
    const contentHash = body['contentHash'];
    if (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(contentHash)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'contentHash' });
    }
    const evidenceArtifactId = body['evidenceArtifactId'];
    if (typeof evidenceArtifactId !== 'string' || !UUID_SHAPE.test(evidenceArtifactId)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'evidenceArtifactId' });
    }

    return idempotentWrite(h, async (tx) => {
      const outcome: ReappearanceWriteOutcome = await queries.recordReappearance(tx, {
        exposureId,
        expectedRowVersionMs,
        priorRemovedEventId: priorRemovedRaw,
        observedAt,
        observationMethod,
        contentHash,
        evidenceArtifactId,
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
          case 'REAPPEARANCE_WITHOUT_PRIOR_REMOVAL':
            // VG-REAPPEAR-001: a first-ever sighting is never labelled a reappearance. The observed state is
            // named so the caller learns the truth rather than the label they asked for.
            throw apiError('REAPPEARANCE_WITHOUT_PRIOR_REMOVAL', { fromTruthState: outcome.observedState });
          case 'PRIOR_REMOVED_EVENT_NOT_FOUND':
            throw apiError('PRIOR_REMOVED_EVENT_NOT_FOUND', { field: 'priorRemovedEventId' }, 422);
          case 'EVIDENCE_NOT_FOUND':
            throw apiError('EVIDENCE_NOT_FOUND', { field: 'evidenceArtifactId' }, 422);
          case 'ILLEGAL_TRANSITION':
            throw apiError('ILLEGAL_TRANSITION', { fromTruthState: outcome.fromTruthState });
        }
      }

      const current = await queries.exposureRowVersion(tx, exposureId);
      if (current !== undefined) reply.header('etag', etagFor(current.truthState, current.rowVersionMs));
      return { status: 201, body: outcome.response, resourceId: outcome.response.reappearanceId };
    });
  });

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
    // THE CURSOR IS READ BEFORE THE QUERY IS PARSED, so a continuation can inherit the time window its first
    // page used. The default window is resolved against the clock, so without this every second page hashed a
    // different filter and was refused INVALID_CURSOR (see cursor.ts). The signature is still verified by
    // peekCursor, and the binding check below still runs — a peek is not an authorisation.
    const rawQuery = request.query as Record<string, unknown>;
    const peeked =
      typeof rawQuery['cursor'] === 'string' ? peekCursor(rawQuery['cursor'], secret) : undefined;
    const parsed = parseQuery(
      rawQuery,
      REAPPEARANCES_QUERY,
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
              // The window this walk started with, so the next page applies the SAME one rather than a default
              // that has slid with the clock (the defect recorded in `cursor.ts`).
              ...(typeof parsed.filter['from'] === 'string' && typeof parsed.filter['to'] === 'string'
                ? {
                    timeRange: {
                      fromMs: Date.parse(parsed.filter['from']),
                      toMs: Date.parse(parsed.filter['to']),
                    },
                  }
                : {}),
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
