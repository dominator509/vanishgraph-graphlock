/**
 * Controller responses and email threads (SPEC-003 §5.9).
 *
 * THREE ROUTES, AND THE FIRST ONE IS THE ONE THAT MATTERS: §5.9.1 records what a CONTROLLER SAYS, and the whole
 * group exists because a controller's claim is not evidence of removal (VG-VERIFY-004). The handler therefore
 * never reports a removal outcome from this route, `claimedOutcomeIsObservation` is the contract's constant
 * `false`, and a `CLAIMED_DELETION` reaches `ACKNOWLEDGED` with `verificationRequired: true` — the state that
 * says an independent observation is still owed.
 *
 * NO HANDLER HERE DECIDES A STATE. §5.9.1 calls one port method, which runs the domain command; the handler
 * validates the request, resolves the precondition and maps the outcome. §5.9.3 writes a record and derives
 * nothing.
 */

import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { beginHandler, uuidParam } from './handler-context.ts';
import { epochMillisFromIfMatch, etagFor, ifMatchHeader } from './preconditions.ts';
import { idempotentWrite } from './idempotent-write.ts';
import type {
  ControllerResponseQueries,
  ControllerResponseWriteOutcome,
  EmailThreadWriteOutcome,
} from '../../application/contracts/controller-response-queries.ts';
import {
  CLAIMED_OUTCOMES,
  RESPONSE_KINDS,
} from '../../application/contracts/controller-response-queries.ts';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A message id, per RFC 5322's `msg-id` shape: `<local@domain>`.
 *
 * §5.9.3 refuses a malformed id with `422 MESSAGE_ID_MALFORMED`, and the shape is checked rather than assumed
 * because the id is the KEY a duplicate thread is detected by: an id that is not in canonical form would make
 * two threads look distinct when they are the same message.
 */
const MESSAGE_ID_SHAPE = /^<[^<>@\s]+@[^<>@\s]+>$/;

export interface ControllerResponseRouteOptions {
  readonly queries: ControllerResponseQueries;
}

function tokenBodyField(body: Record<string, unknown>, field: string, max = 200): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

export function controllerResponseRoutes(
  app: FastifyInstance,
  options: ControllerResponseRouteOptions,
): void {
  const queries = options.queries;

  // ---------------------------------------------------------------------------------------------
  // 5.9.1 POST /v1/cases/{caseId}/controller-responses — T11, T12, T13 or T15.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/cases/:caseId/controller-responses', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');
    const expectedRowVersionMs = epochMillisFromIfMatch(ifMatchHeader(request));

    const body = (request.body ?? {}) as Record<string, unknown>;
    const responseKind = tokenBodyField(body, 'responseKind');
    if (!RESPONSE_KINDS.includes(responseKind)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'responseKind' });
    }
    const claimedOutcome = tokenBodyField(body, 'claimedOutcome');
    if (!CLAIMED_OUTCOMES.includes(claimedOutcome)) {
      // §5.9.1's own code for a claim the contract cannot express. `VERIFIED_REMOVED` here is the collapse this
      // code exists to refuse: a controller cannot report the system's truth state to it.
      throw apiError('CLAIMED_OUTCOME_UNSUPPORTED', { field: 'claimedOutcome' });
    }
    const bodyRef = tokenBodyField(body, 'bodyRef', 500);
    const receivedAt = body['receivedAt'];
    if (typeof receivedAt !== 'string' || Number.isNaN(Date.parse(receivedAt))) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'receivedAt' });
    }
    const evidenceRaw = body['evidenceArtifactId'];
    let evidenceArtifactId: string | null = null;
    if (evidenceRaw !== undefined) {
      if (typeof evidenceRaw !== 'string' || !UUID_SHAPE.test(evidenceRaw)) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'evidenceArtifactId' });
      }
      evidenceArtifactId = evidenceRaw;
    }
    const refusalRaw = body['refusalBasis'];
    let refusalBasis: string | null = null;
    if (refusalRaw !== undefined) {
      if (typeof refusalRaw !== 'string' || refusalRaw.length === 0 || refusalRaw.length > 500) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'refusalBasis' });
      }
      refusalBasis = refusalRaw;
    }

    return idempotentWrite(h, async (tx) => {
      const outcome: ControllerResponseWriteOutcome = await queries.recordControllerResponse(tx, {
        caseId,
        expectedRowVersionMs,
        responseKind,
        claimedOutcome,
        bodyRef,
        receivedAt,
        evidenceArtifactId,
        refusalBasis,
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
          case 'REFUSAL_BASIS_REQUIRED':
            throw apiError('REFUSAL_BASIS_REQUIRED', { field: 'refusalBasis' }, 422);
          case 'HUMAN_STEP_REQUIRED':
            // The response demands an identity or legal step the case's state cannot accept as a gate.
            throw apiError('HUMAN_STEP_REQUIRED', { fromTruthState: 'unavailable' }, 422);
          case 'EVIDENCE_NOT_FOUND':
            throw apiError('EVIDENCE_NOT_FOUND', { field: 'evidenceArtifactId' }, 422);
        }
      }

      const current = await queries.caseRowVersion(tx, caseId);
      if (current !== undefined) reply.header('etag', etagFor(current.truthState, current.rowVersionMs));
      return { status: 200, body: outcome.response, resourceId: outcome.response.controllerResponseId };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.9.2 GET /v1/cases/{caseId}/controller-responses — newest first, all retained.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/cases/:caseId/controller-responses', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');

    return h.withTenant(async (tx) => {
      const version = await queries.caseRowVersion(tx, caseId);
      // Absent and another tenant's case both answer 404 rather than an empty list: an empty list is a true
      // statement about a case that exists, and a misleading one about a case the caller cannot see.
      if (version === undefined) throw apiError('RESOURCE_NOT_FOUND');
      const rows = await queries.listControllerResponses(tx, caseId);
      // Not paginated: §5.9.2 declares no limit/cursor, and "all retained" bounds the collection by how many
      // times the controller answered rather than by a page size.
      return reply.code(200).send({ data: rows.map((row) => ({ ...row })) });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.9.3 POST /v1/cases/{caseId}/email-threads — threading for deadlines.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/cases/:caseId/email-threads', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');

    const body = (request.body ?? {}) as Record<string, unknown>;
    const direction = tokenBodyField(body, 'direction', 20);
    if (direction !== 'OUTBOUND' && direction !== 'INBOUND') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'direction' });
    }
    const rawIds = body['messageIds'];
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'messageIds' });
    }
    const messageIds = rawIds.map((entry) => {
      if (typeof entry !== 'string' || !MESSAGE_ID_SHAPE.test(entry)) {
        throw apiError('MESSAGE_ID_MALFORMED', { field: 'messageIds' }, 422);
      }
      return entry;
    });
    const receivedRaw = body['receivedAt'];
    let receivedAt: string | null = null;
    if (receivedRaw !== undefined) {
      if (typeof receivedRaw !== 'string' || Number.isNaN(Date.parse(receivedRaw))) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'receivedAt' });
      }
      receivedAt = receivedRaw;
    }
    const bodyRefRaw = body['bodyRef'];
    let bodyRef: string | null = null;
    if (bodyRefRaw !== undefined) {
      if (typeof bodyRefRaw !== 'string' || bodyRefRaw.length === 0 || bodyRefRaw.length > 500) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'bodyRef' });
      }
      bodyRef = bodyRefRaw;
    }
    const subjectHashRaw = body['subjectHash'];
    let subjectHash: string | null = null;
    if (subjectHashRaw !== undefined) {
      if (typeof subjectHashRaw !== 'string' || !/^[0-9a-f]{64}$/i.test(subjectHashRaw)) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'subjectHash' });
      }
      subjectHash = subjectHashRaw;
    }

    return idempotentWrite(h, async (tx) => {
      const outcome: EmailThreadWriteOutcome = await queries.createEmailThread(tx, {
        caseId,
        direction,
        messageIds,
        receivedAt,
        bodyRef,
        subjectHash,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) {
        if (outcome.reason === 'NOT_FOUND') throw apiError('RESOURCE_NOT_FOUND');
        throw apiError('EMAIL_THREAD_DUPLICATE', { field: 'messageIds' });
      }
      reply.header('location', `/v1/cases/${caseId}/email-threads/${outcome.response.emailThreadId}`);
      return { status: 201, body: outcome.response, resourceId: outcome.response.emailThreadId };
    });
  });
}
