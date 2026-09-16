/**
 * Policy decisions and jurisdiction policies (SPEC-003 §5.6).
 *
 * FOUR ROUTES, AND ONE OF THEM IS THE ONLY WAY A LEGAL BASIS ENTERS THE SYSTEM. §5.6.1 resolves a decision from
 * versioned policy data; §5.6.4 is read-only "with no write counterpart on `/v1`", because "policy data is
 * authored through an out-of-band, human-reviewed change process with its own review and evidence; there is no
 * route by which an API caller or a model can author a jurisdiction rule or a legal basis (VG-POLICY-001, §10)".
 * That is why this file has no route that creates or edits a policy version, and why §5.6.1 REFUSES a body that
 * asserts a `legalBasis` of its own (`422 LEGAL_BASIS_NOT_AUTHORABLE`) instead of accepting it.
 *
 * `policyVersion` IS A DATE STRING on the wire and an ordinal in the schema; `policy-queries.ts` records the
 * reading, and this file passes the label through untouched.
 *
 * NO HANDLER HERE MOVES A TRUTH STATE. §5.6.1's response carries no `truthState`, and the port's command returns
 * no transition: a decision is recorded and audited without touching the state machine.
 */

import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { beginHandler, uuidParam } from './handler-context.ts';
import { epochMillisFromIfMatch, ifMatchHeader } from './preconditions.ts';
import { idempotentWrite } from './idempotent-write.ts';
import type { PolicyQueries, ResolvePolicyOutcome } from '../../application/contracts/policy-queries.ts';
import { CHANNEL_NAMES } from '../../application/contracts/policy-queries.ts';

const CHANNELS: readonly string[] = CHANNEL_NAMES;
const JURISDICTION_SHAPE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
const VERSION_LABEL_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export interface PolicyRouteOptions {
  readonly queries: PolicyQueries;
}

function tokenBodyField(body: Record<string, unknown>, field: string, max = 200): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

export function policyRoutes(app: FastifyInstance, options: PolicyRouteOptions): void {
  const queries = options.queries;

  // ---------------------------------------------------------------------------------------------
  // 5.6.1 POST /v1/cases/{caseId}/policy-decisions — resolve a decision from versioned policy data.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/cases/:caseId/policy-decisions', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');
    const expectedRowVersionMs = epochMillisFromIfMatch(ifMatchHeader(request));

    const body = (request.body ?? {}) as Record<string, unknown>;
    // THE CALLER MAY NOT ASSERT A LEGAL BASIS (VG-POLICY-001). Checked first, because it is the one field whose
    // presence changes what the request MEANS rather than what it contains.
    if (body['legalBasis'] !== undefined) {
      throw apiError('LEGAL_BASIS_NOT_AUTHORABLE', { field: 'legalBasis' }, 422);
    }
    const jurisdiction = tokenBodyField(body, 'jurisdiction', 6);
    if (!JURISDICTION_SHAPE.test(jurisdiction)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'jurisdiction' });
    }
    const requestedChannel = tokenBodyField(body, 'requestedChannel', 40);
    if (!CHANNELS.includes(requestedChannel)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'requestedChannel' });
    }
    const versionRaw = body['policyVersion'];
    // §5.6.1's request carries the version as a DATE STRING. A value in another shape is refused rather than
    // coerced: the label is matched against policy data, and a guess would resolve against the wrong version.
    let policyVersionLabel: string | null = null;
    if (versionRaw !== undefined) {
      if (typeof versionRaw !== 'string' || !VERSION_LABEL_SHAPE.test(versionRaw)) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'policyVersion' });
      }
      policyVersionLabel = versionRaw;
    }
    const alternativesRaw = body['channelAlternativesConsidered'];
    const alternatives: { channel: string; unavailable: boolean; reason: string | null }[] = [];
    if (alternativesRaw !== undefined) {
      if (!Array.isArray(alternativesRaw)) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'channelAlternativesConsidered' });
      }
      for (const entry of alternativesRaw) {
        if (typeof entry !== 'object' || entry === null) {
          throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'channelAlternativesConsidered' });
        }
        const candidate = entry as { channel?: unknown; unavailable?: unknown; reason?: unknown };
        if (typeof candidate.channel !== 'string' || !CHANNELS.includes(candidate.channel)) {
          throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'channelAlternativesConsidered' });
        }
        if (typeof candidate.unavailable !== 'boolean') {
          throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'channelAlternativesConsidered' });
        }
        const reason = candidate.reason === undefined ? null : candidate.reason;
        if (reason !== null && typeof reason !== 'string') {
          throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'channelAlternativesConsidered' });
        }
        // VG-CHANNEL-001: an unavailable channel MUST carry a reason. Refused here rather than passed to the
        // engine, so the caller learns which field is wrong.
        if (candidate.unavailable && (reason === null || reason.length === 0)) {
          throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'channelAlternativesConsidered.reason' });
        }
        alternatives.push({ channel: candidate.channel, unavailable: candidate.unavailable, reason });
      }
    }

    return idempotentWrite(h, async (tx) => {
      const outcome: ResolvePolicyOutcome = await queries.resolvePolicyDecision(tx, {
        caseId,
        expectedRowVersionMs,
        jurisdiction,
        requestedChannel,
        policyVersionLabel,
        alternatives,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'NOT_FOUND':
            throw apiError('RESOURCE_NOT_FOUND');
          case 'PRECONDITION_FAILED':
            throw apiError('PRECONDITION_FAILED', {
              currentEtag: `${outcome.truthState}:${String(outcome.currentRowVersionMs)}`,
            });
          case 'CASE_AUTHORITY_INVALID':
            throw apiError('CASE_AUTHORITY_INVALID', { field: 'caseId' });
          case 'STRICT_LANE_REQUIRED':
            throw apiError('STRICT_LANE_REQUIRED', { field: 'caseId' }, 422);
          case 'JURISDICTION_UNRESOLVED':
            throw apiError('JURISDICTION_UNRESOLVED', { field: 'jurisdiction' }, 422);
          case 'POLICY_VERSION_SUPERSEDED':
            throw apiError(
              'POLICY_VERSION_SUPERSEDED',
              {
                policyVersion: String(outcome.inForceLabel ?? ''),
                field: 'policyVersion',
              },
              409,
            );
          case 'POLICY_VERSION_UNNAMED':
            throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'policyVersion' }, 422);
          case 'LEGAL_BASIS_NOT_IN_POLICY_VERSION':
            // The rules the version DOES declare are named, so the caller learns what the version authorises
            // rather than only that their request failed.
            throw apiError(
              'LEGAL_BASIS_NOT_IN_POLICY_VERSION',
              { field: 'policyVersion', ruleRef: outcome.rules.join(',') },
              422,
            );
          case 'CHANNEL_PRIORITY_VIOLATION':
            throw apiError(
              'CHANNEL_PRIORITY_VIOLATION',
              { field: 'requestedChannel', ruleRef: outcome.availableHigherPriority },
              409,
            );
        }
      }
      reply.header('location', `/v1/policy-decisions/${outcome.response.policyDecisionId}`);
      return { status: 201, body: outcome.response, resourceId: outcome.response.policyDecisionId };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.6.2 GET /v1/cases/{caseId}/policy-decisions — newest first, all versions retained.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/cases/:caseId/policy-decisions', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');

    return h.withTenant(async (tx) => {
      const version = await queries.caseRowVersion(tx, caseId);
      if (version === undefined) throw apiError('RESOURCE_NOT_FOUND');
      const rows = await queries.listPolicyDecisions(tx, caseId);
      // Not paginated: §5.6.2 declares no limit/cursor, and "all versions retained" bounds the collection by how
      // many times a decision was resolved rather than by a page size.
      return reply.code(200).send({ data: rows.map((row) => ({ ...row })) });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.6.3 GET /v1/policy-decisions/{policyDecisionId} — one decision with its full reason list.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/policy-decisions/:policyDecisionId', async (request, reply) => {
    const h = beginHandler(request, reply);
    const policyDecisionId = uuidParam(request, 'policyDecisionId');

    return h.withTenant(async (tx) => {
      const row = await queries.getPolicyDecision(tx, policyDecisionId);
      if (row === undefined) throw apiError('RESOURCE_NOT_FOUND');
      return reply.code(200).send(row);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.6.4 GET /v1/jurisdiction-policies — READ-ONLY, with no write counterpart anywhere on /v1.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/jurisdiction-policies', async (request, reply) => {
    const h = beginHandler(request, reply);
    const raw = request.query as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (key !== 'jurisdiction' && key !== 'inForceOn' && key !== 'includeSuperseded') {
        throw apiError('UNKNOWN_QUERY_PARAMETER', { field: key });
      }
    }
    const jurisdictionRaw = raw['jurisdiction'];
    let jurisdiction: string | null = null;
    if (jurisdictionRaw !== undefined) {
      if (typeof jurisdictionRaw !== 'string' || !JURISDICTION_SHAPE.test(jurisdictionRaw)) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'jurisdiction' });
      }
      jurisdiction = jurisdictionRaw;
    }
    const inForceOnRaw = raw['inForceOn'];
    let inForceOnMs = Date.now();
    if (inForceOnRaw !== undefined) {
      // §5.6.4 declares `inForceOn` as an RFC 3339 date.
      if (typeof inForceOnRaw !== 'string' || Number.isNaN(Date.parse(inForceOnRaw))) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'inForceOn' });
      }
      inForceOnMs = Date.parse(inForceOnRaw);
    }
    const includeRaw = raw['includeSuperseded'];
    if (includeRaw !== undefined && includeRaw !== 'true' && includeRaw !== 'false') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'includeSuperseded' });
    }

    return h.withTenant(async (tx) => {
      const rows = await queries.listJurisdictionPolicies(tx, {
        jurisdiction,
        inForceOnMs,
        includeSuperseded: includeRaw === 'true',
      });
      // NOT paginated, and the page object is absent rather than empty: §5.6.4's body is `{"data":[...]}` with no
      // `page`, because a jurisdiction's policy versions are bounded by how often counsel revised them.
      return reply.code(200).send({ data: rows.map((row) => ({ ...row })) });
    });
  });
}
