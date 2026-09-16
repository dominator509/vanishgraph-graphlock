/**
 * External actions, reconciliations, readbacks and mail pieces (SPEC-003 §5.8).
 *
 * SIX ROUTES, AND ONE OF THEM CANNOT DO WHAT IT IS NAMED FOR YET. §5.8.2 submits a removal request through a
 * channel; NO channel transport exists in this repository, so a real submission is refused
 * `503 DEPENDENCY_UNAVAILABLE` naming the unconfigured channel, and the route's `dryRun` path — which §5.8.2
 * defines as guard evaluation and payload validation with no effect and no state change — is implemented in
 * full and answers `200`. That is stated here, in `action-queries.ts` and in the ledger rather than left for a
 * reader to infer from the code.
 *
 * THE OTHER FIVE ARE COMPLETE: the list, the detail, the mail-piece list, the reconciliation write (which never
 * regresses a state and never invents one, VG-ACTION-002/004) and the readback request (which records a REQUEST
 * for evidence and never evidence itself, VG-ACTION-003).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { beginHandler, uuidParam } from './handler-context.ts';
import { epochMillisFromIfMatch, ifMatchHeader } from './preconditions.ts';
import { idempotentWrite } from './idempotent-write.ts';
import type {
  ActionQueries,
  ExecuteActionOutcome,
  ReadbackOutcome,
  ReconciliationOutcome,
} from '../../application/contracts/action-queries.ts';
import {
  READBACK_METHODS,
  RECONCILIATION_FINDINGS,
  RECONCILIATION_METHODS,
} from '../../application/contracts/action-queries.ts';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS: readonly string[] = Object.freeze([
  'OFFICIAL_SELF_SERVICE',
  'PRIVACY_EMAIL',
  'CERTIFIED_MAIL',
  'CENTRALIZED_GOVERNMENT',
  'AUTHORIZED_AGENT',
  'SEARCH_ENGINE_DELISTING',
]);

export interface ActionRouteOptions {
  readonly sessionSecret: string;
  readonly queries: ActionQueries;
}

function tokenBodyField(body: Record<string, unknown>, field: string, max = 200): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

export function actionRoutes(app: FastifyInstance, options: ActionRouteOptions): void {
  const secret = options.sessionSecret;
  const queries = options.queries;

  // ---------------------------------------------------------------------------------------------
  // 5.8.1 GET /v1/cases/{caseId}/external-actions — list, keyset-paginated.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/cases/:caseId/external-actions', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');
    // §5.8.1 is paginated (`page` is in its example) and declares no filter surface, so the parser is given a
    // schema with only the pagination controls: a parameter nobody declared is refused, never ignored.
    const raw = request.query as Record<string, unknown>;
    const limitRaw = raw['limit'];
    const limit = limitRaw === undefined ? 25 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'limit' });
    }
    const cursorRaw = raw['cursor'];
    const cursor = typeof cursorRaw === 'string' ? cursorRaw : undefined;
    for (const key of Object.keys(raw)) {
      if (key !== 'limit' && key !== 'cursor') throw apiError('UNKNOWN_QUERY_PARAMETER', { field: key });
    }

    return h.withTenant(async (tx) => {
      // THE CASE IS ASSERTED DIRECTLY. An empty list is a true statement about a case that exists, and a
      // misleading one about a case the caller cannot see (SPEC-006 H-9). MEASURED: an earlier version inferred
      // existence from a non-empty action list and answered 404 for a case that exists with no actions yet.
      if (!(await queries.caseExists(tx, caseId))) throw apiError('RESOURCE_NOT_FOUND');

      const after =
        cursor === undefined
          ? undefined
          : (() => {
              const decoded = decodeActionCursor(cursor, secret, caseId);
              return { sortValue: decoded.sortValue, id: decoded.id };
            })();
      const rows = await queries.listActions(tx, {
        caseId,
        limit,
        ...(after === undefined ? {} : { after }),
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return reply.code(200).send({
        // cursorValue is the route's own keyset input and is NOT part of §5.8.1's body.
        data: page.map(({ cursorValue, ...row }) => {
          void cursorValue;
          return row;
        }),
        page: {
          limit,
          hasMore,
          nextCursor:
            hasMore && last !== undefined
              ? encodeActionCursor(
                  // The ORDERING KEY, never submittedAt: that column is nullable and the order is by
                  // created_at, so a prepared-but-unsubmitted action would mint a cursor with an empty
                  // timestamp and the next page would fail to parse it.
                  { caseId, sortValue: last.cursorValue, id: last.externalActionId },
                  secret,
                )
              : null,
        },
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.8.5 GET /v1/external-actions/{externalActionId} — detail, with an ETag.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/external-actions/:externalActionId', async (request, reply) => {
    const h = beginHandler(request, reply);
    const externalActionId = uuidParam(request, 'externalActionId');

    return h.withTenant(async (tx) => {
      const detail = await queries.getActionDetail(tx, externalActionId);
      if (detail === undefined) throw apiError('RESOURCE_NOT_FOUND');
      // §5.8.5 returns an ETag; §2.7's shape for a resource without a truth state of its own is the row's own
      // creation instant, which is what this route reports.
      reply.header('etag', `"${String(detail.rowVersionMs)}"`);
      const { rowVersionMs, cursorValue, ...body } = detail;
      void rowVersionMs;
      void cursorValue;
      return reply.code(200).send(body);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.8.6 GET /v1/cases/{caseId}/mail-pieces — list, keyset-paginated.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/cases/:caseId/mail-pieces', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');
    const raw = request.query as Record<string, unknown>;
    const limitRaw = raw['limit'];
    const limit = limitRaw === undefined ? 25 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'limit' });
    }
    const cursorRaw = raw['cursor'];
    const cursor = typeof cursorRaw === 'string' ? cursorRaw : undefined;
    for (const key of Object.keys(raw)) {
      if (key !== 'limit' && key !== 'cursor') throw apiError('UNKNOWN_QUERY_PARAMETER', { field: key });
    }

    return h.withTenant(async (tx) => {
      // The same direct existence check as the action list, for the same measured reason.
      if (!(await queries.caseExists(tx, caseId))) throw apiError('RESOURCE_NOT_FOUND');

      const after =
        cursor === undefined
          ? undefined
          : (() => {
              const decoded = decodeActionCursor(cursor, secret, caseId);
              return { sortValue: decoded.sortValue, id: decoded.id };
            })();
      const rows = await queries.listMailPieces(tx, {
        caseId,
        limit,
        ...(after === undefined ? {} : { after }),
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return reply.code(200).send({
        // cursorValue is the route's own keyset input and is NOT part of §5.8.1's body.
        data: page.map(({ cursorValue, ...row }) => {
          void cursorValue;
          return row;
        }),
        page: {
          limit,
          hasMore,
          nextCursor:
            hasMore && last !== undefined
              ? encodeActionCursor(
                  // The ordering key again: sentAt is null for a piece that was prepared and never sent.
                  { caseId, sortValue: last.cursorValue, id: last.mailPieceId },
                  secret,
                )
              : null,
        },
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.8.2 POST /v1/cases/{caseId}/external-actions — the effect route.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/cases/:caseId/external-actions', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');
    const expectedRowVersionMs = epochMillisFromIfMatch(ifMatchHeader(request));

    const body = (request.body ?? {}) as Record<string, unknown>;
    const channel = tokenBodyField(body, 'channel', 60);
    if (!CHANNELS.includes(channel)) throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'channel' });
    const recipeId = tokenBodyField(body, 'recipeId', 64);
    if (!UUID_SHAPE.test(recipeId)) throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'recipeId' });
    const recipeVersion = body['recipeVersion'];
    if (typeof recipeVersion !== 'number' || !Number.isInteger(recipeVersion) || recipeVersion < 1) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'recipeVersion' });
    }
    const authorityGrantId = tokenBodyField(body, 'authorityGrantId', 64);
    const policyDecisionId = tokenBodyField(body, 'policyDecisionId', 64);
    const idempotencyKey = tokenBodyField(body, 'idempotencyKey', 255);
    const templateRef = body['templateRef'];
    let templateVersion: number | null = null;
    let templateHash: string | null = null;
    if (templateRef !== undefined) {
      if (typeof templateRef !== 'object' || templateRef === null) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'templateRef' });
      }
      const candidate = templateRef as { templateVersion?: unknown; templateHash?: unknown };
      if (typeof candidate.templateVersion !== 'string' || typeof candidate.templateHash !== 'string') {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'templateRef' });
      }
      // `templateVersion` is `"v7"` in §5.8.2's example and an INTEGER column here: the digits are extracted and
      // a value that is not a version is refused rather than guessed at.
      const digits = /^v?(\d+)$/.exec(candidate.templateVersion);
      if (digits?.[1] === undefined || !/^[0-9a-f]{64}$/i.test(candidate.templateHash)) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'templateRef' });
      }
      templateVersion = Number(digits[1]);
      templateHash = candidate.templateHash.toLowerCase();
    }
    const payloadRaw = body['payloadFields'];
    if (payloadRaw !== undefined && (typeof payloadRaw !== 'object' || payloadRaw === null)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'payloadFields' });
    }
    const payloadFields: Record<string, string> = {};
    for (const [key, value] of Object.entries((payloadRaw ?? {}) as Record<string, unknown>)) {
      if (typeof value !== 'string') throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'payloadFields' });
      payloadFields[key] = value;
    }
    const dryRun = body['dryRun'];
    if (dryRun !== undefined && typeof dryRun !== 'boolean') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'dryRun' });
    }

    return idempotentWrite(h, async (tx) => {
      const outcome: ExecuteActionOutcome = await queries.executeAction(tx, {
        caseId,
        expectedRowVersionMs,
        channel,
        recipeId,
        recipeVersion,
        authorityGrantId,
        policyDecisionId,
        idempotencyKey,
        templateVersion,
        templateHash,
        payloadFields,
        dryRun: dryRun === true,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'NOT_FOUND':
            throw apiError('RESOURCE_NOT_FOUND');
          case 'PRECONDITION_FAILED':
            throw apiError('PRECONDITION_FAILED', {
              currentEtag: `"${String(outcome.currentRowVersionMs)}"`,
            });
          case 'ILLEGAL_TRANSITION':
            throw apiError('ILLEGAL_TRANSITION', { fromTruthState: outcome.fromTruthState });
          case 'CHANNEL_TRANSPORT_UNCONFIGURED':
            // THE HONEST ANSWER FOR EVERY CHANNEL TODAY: there is no transport in this repository. A 503 that
            // names the channel is the only response that does not claim a submission that never happened.
            throw apiError('DEPENDENCY_UNAVAILABLE', { ruleRef: outcome.channel });
          case 'PAYLOAD_FIELD_NOT_ALLOWLISTED':
            throw apiError('PAYLOAD_FIELD_NOT_ALLOWLISTED', { field: outcome.field }, 422);
          case 'TEMPLATE_HASH_REQUIRED':
            throw apiError('TEMPLATE_HASH_REQUIRED', { field: 'templateRef' }, 422);
          case 'HUMAN_GATE_OPEN':
            throw apiError('HUMAN_GATE_OPEN', { field: 'caseId' }, 422);
          case 'EFFECT_BUDGET_EXCEEDED':
            throw apiError(
              'EFFECT_BUDGET_EXCEEDED',
              { limit: outcome.limit, reason: String(outcome.used) },
              409,
            );
          case 'AUTHORITY_INVALID':
            throw apiError('AUTHORITY_INVALID', { field: 'authorityGrantId' });
          case 'RECIPE_DISABLED':
            throw apiError('RECIPE_DISABLED', { field: 'recipeId' });
          case 'RECIPE_STALE':
            throw apiError('RECIPE_STALE', { field: 'recipeId' });
          case 'SOURCE_PERMISSION_UNCLEAR':
            throw apiError('SOURCE_PERMISSION_UNCLEAR', { field: 'channel' });
          case 'CHANNEL_PRIORITY_VIOLATION':
            throw apiError('CHANNEL_PRIORITY_VIOLATION', { field: 'channel' });
        }
      }
      return outcome.response.dryRun
        ? { status: 200, body: outcome.response, resourceId: caseId }
        : { status: 201, body: outcome.response, resourceId: caseId };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.8.3 POST /v1/external-actions/{externalActionId}/reconciliations
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/external-actions/:externalActionId/reconciliations', async (request, reply) => {
    const h = beginHandler(request, reply);
    const externalActionId = uuidParam(request, 'externalActionId');

    const body = (request.body ?? {}) as Record<string, unknown>;
    const method = tokenBodyField(body, 'reconciliationMethod', 60);
    if (!RECONCILIATION_METHODS.includes(method)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'reconciliationMethod' });
    }
    const finding = tokenBodyField(body, 'finding', 40);
    if (!RECONCILIATION_FINDINGS.includes(finding)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'finding' });
    }
    const observedAt = body['observedAt'];
    if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'observedAt' });
    }
    const evidenceRaw = body['evidenceArtifactId'];
    let evidenceArtifactId: string | null = null;
    if (evidenceRaw !== undefined) {
      if (typeof evidenceRaw !== 'string' || !UUID_SHAPE.test(evidenceRaw)) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'evidenceArtifactId' });
      }
      evidenceArtifactId = evidenceRaw;
    }
    const noteRaw = body['note'];
    let note: string | null = null;
    if (noteRaw !== undefined) {
      if (typeof noteRaw !== 'string' || noteRaw.length > 1000) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'note' });
      }
      note = noteRaw;
    }

    return idempotentWrite(h, async (tx) => {
      const outcome: ReconciliationOutcome = await queries.recordReconciliation(tx, {
        externalActionId,
        method,
        finding,
        observedAt,
        evidenceArtifactId,
        note,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'NOT_FOUND':
            throw apiError('RESOURCE_NOT_FOUND');
          case 'ACTION_NOT_AMBIGUOUS':
            throw apiError('ACTION_NOT_AMBIGUOUS', { field: 'externalActionId' });
          case 'ILLEGAL_TRANSITION':
            throw apiError('ILLEGAL_TRANSITION', { fromTruthState: outcome.fromTruthState });
          case 'EVIDENCE_NOT_FOUND':
            throw apiError('EVIDENCE_NOT_FOUND', { field: 'evidenceArtifactId' }, 422);
        }
      }
      return { status: 200, body: outcome.response, resourceId: externalActionId };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.8.4 POST /v1/external-actions/{externalActionId}/readback
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/external-actions/:externalActionId/readback', async (request, reply) => {
    const h = beginHandler(request, reply);
    const externalActionId = uuidParam(request, 'externalActionId');

    const body = (request.body ?? {}) as Record<string, unknown>;
    const observationMethod = tokenBodyField(body, 'observationMethod', 60);
    if (!READBACK_METHODS.includes(observationMethod)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'observationMethod' });
    }
    const requestedAt = body['requestedAt'];
    if (typeof requestedAt !== 'string' || Number.isNaN(Date.parse(requestedAt))) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'requestedAt' });
    }

    return idempotentWrite(h, async (tx) => {
      const outcome: ReadbackOutcome = await queries.requestReadback(tx, {
        externalActionId,
        observationMethod,
        requestedAt,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) {
        if (outcome.reason === 'NOT_FOUND') throw apiError('RESOURCE_NOT_FOUND');
        // VG-ACTION-003: the observation path must differ from the one that acted.
        throw apiError('OBSERVATION_PATH_NOT_INDEPENDENT', { field: 'observationMethod' }, 422);
      }
      reply.header('location', `/v1/external-actions/${externalActionId}`);
      return { status: 202, body: outcome.response, resourceId: outcome.response.readbackRequestId };
    });
  });
}

/**
 * The list cursors, signed with the session secret.
 *
 * A LOCAL, MINIMAL CURSOR rather than the shared keyset module: §5.8.1's and §5.8.6's pages carry no filter
 * surface (§5.8.1 declares no query parameters at all), so there is no filter hash to bind and no sort to bind —
 * only the case and the position. Reusing the general cursor here would mean inventing a filter set for routes
 * that have none, and the general module's bindings exist to catch exactly that kind of invention.
 */
function encodeActionCursor(payload: { caseId: string; sortValue: string; id: string }, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function decodeActionCursor(
  cursor: string,
  secret: string,
  caseId: string,
): { readonly sortValue: string; readonly id: string } {
  const parts = cursor.split('.');
  const body = parts[0];
  const signature = parts[1];
  if (body === undefined || signature === undefined) throw apiError('INVALID_CURSOR');
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const provided = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    throw apiError('INVALID_CURSOR');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw apiError('INVALID_CURSOR');
  }
  const candidate = parsed as { caseId?: unknown; sortValue?: unknown; id?: unknown };
  if (
    typeof candidate.caseId !== 'string' ||
    candidate.caseId !== caseId ||
    typeof candidate.sortValue !== 'string' ||
    typeof candidate.id !== 'string'
  ) {
    // A cursor from another case is refused rather than reinterpreted: it is a continuation of a DIFFERENT query.
    throw apiError('INVALID_CURSOR');
  }
  return { sortValue: candidate.sortValue, id: candidate.id };
}
