/**
 * Appeal escalations (SPEC-003 §5.14).
 *
 * 3 of the 78 routes. Every handler follows the same four steps as the rest of this boundary:
 *
 *   1. `beginHandler` — resolves the registry entry, requires the route's scopes, enforces its step-up
 *      (the registry marks §5.14.1 `stepUp: true`, per SPEC-003 §3.3's `vg.appeal.write` row: "Create an
 *      `AppealEscalation` (also requires step-up)"), and hands over the tenant-scoped transaction helper.
 *   2. Validate the body against a CLOSED vocabulary.
 *   3. ONE port call.
 *   4. Map to the DTO and return.
 *
 * THIS GROUP IS COUNSEL-REVIEW TERRITORY, AND THE CODE SAYS SO RATHER THAN IMPLYING IT. SPEC-003 §5.14.1
 * is explicit that "appeal and escalation content is counsel-review territory, not an API decision", that
 * "legal sufficiency of an escalation, its citations, and the applicable regulatory window are not
 * adjudicated here", and that the API "records `requiresHumanReview: true` and a `PENDING_COUNSEL_REVIEW`
 * review state, and refuses to treat a request as sendable while that state is pending". Three
 * consequences are structural, not stylistic:
 *
 *   * **No handler accepts a legal theory, a citation, or a destination.** The request body carries a kind,
 *     a review flag, artifact ids and a template reference. There is no field for argument text and no
 *     field for a recipient address — §10 forbids a `/v1` route that authors reviewed content, and a route
 *     that accepted an argument would be authoring it.
 *   * **`requiresHumanReview: false` is REFUSED, not honoured**, with `422 HUMAN_REVIEW_REQUIRED`. All four
 *     kinds §5.14.1 accepts are appeal/escalation content, so all four mandate review; a caller cannot
 *     waive a control by asserting a boolean. A flag a caller may set to `false` to skip review is not a
 *     control.
 *   * **`externalEffect` is reported as the literal `false`** and is not read from or written to the row.
 *     §5.14.1 states the reason itself: creating the record "does not send anything", and any sending is a
 *     separate §5.8.2 action with its own `IdempotencyKey`. There is no route here that sends, so there is
 *     no code path that could make the value true.
 *
 * NO HANDLER CONTAINS A TRUTH STATE. An `AppealEscalation` does not move a case's truth state, so no
 * handler assigns one and none reads the transition table. The only `truthState` in this file is the one
 * §2.7 puts in an ETag, and it is read solely to build and verify that token.
 */

import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { withIdempotency } from '../plugins/idempotency.ts';
import { beginHandler, uuidParam, type HandlerContext } from './handler-context.ts';
import type { TenantTransaction } from '../plugins/tenancy.ts';
import {
  APPEAL_KINDS,
  isAppealKind,
  type AppealQueries,
} from '../../application/contracts/appeal-queries.ts';

export interface AppealRouteOptions {
  /** The model, injected as a PORT: the boundary must not import `src/adapters/**`. */
  readonly queries: AppealQueries;
}

/** Bounded token limits, so a value cannot be oversized or forge a log line. */
const MAX = { templateVersion: 32, templateHash: 128 } as const;

/** A bounded, printable token. Refuses control characters so a value cannot forge a log line. */
function token(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

/** A UUID-shaped opaque id, or `null`. Refused here so a malformed reference is a 422, not a 404. */
function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

/**
 * The §2.7 ETag for a case-scoped resource: `"<truthState>:<updatedAtEpochMillis>"`.
 *
 * THIS IS THE SPECIFICATION'S OWN SHAPE, taken verbatim from §2.7, and it is why `request_case` needs no
 * `row_version` column: the pair (truth state, `updated_at`) already changes on every committed mutation,
 * and `updated_at` is maintained by the trigger in migration 0006. The `sources`/`recipes` groups use a
 * `rowVersion` because they have no truth state to anchor on; a case has one, so the specified form fits
 * and inventing a second counter here would create two tokens for one resource.
 */
function caseEtag(precondition: { readonly truthState: string; readonly updatedAtMs: number }): string {
  return `"${precondition.truthState}:${String(precondition.updatedAtMs)}"`;
}

/**
 * Read the `updatedAt` half out of an `If-Match` header.
 *
 * The truth-state half is NOT compared from the header: the header's job is to detect a stale
 * representation, and `updated_at` is monotonic per mutation, so comparing it alone is sufficient and
 * comparing a parsed state token would add a second way to fail. A malformed value is
 * `412 PRECONDITION_FAILED` — never a silent accept — because §2.7 makes this a per-resource optimistic
 * concurrency control and `*` must not be allowed to skip it.
 */
function updatedAtFromIfMatch(header: string | undefined): number {
  if (header === undefined) throw apiError('PRECONDITION_REQUIRED');
  const match = /^"?[A-Z_]*:(\d{1,15})"?$/.exec(header.trim());
  const value = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(value)) {
    // The header is unparseable rather than merely stale, so the current token is not echoed here. §2.7
    // requires the CURRENT ETag on a STALE value, which the comparison below produces.
    throw apiError('PRECONDITION_FAILED');
  }
  return value;
}

/** Run a §5.14.1 write under idempotency control: the port call runs only on a newly claimed key. */
async function idempotent(
  h: HandlerContext,
  work: (tx: TenantTransaction) => Promise<{ status: number; body: unknown; resourceId?: string | null }>,
): Promise<unknown> {
  return withIdempotency<unknown>(h.request, h.request.server.vgIdempotency, h.reply, () => h.withTenant(work));
}

export function appealRoutes(app: FastifyInstance, options: AppealRouteOptions): void {
  const queries = options.queries;

  // ---------------------------------------------------------------------------------------------
  // 5.14.1 POST /v1/cases/{caseId}/appeal-escalations — step-up, If-Match, idempotency REQUIRED.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/cases/:caseId/appeal-escalations', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');
    const expectedUpdatedAtMs = updatedAtFromIfMatch(
      Array.isArray(request.headers['if-match']) ? request.headers['if-match'][0] : request.headers['if-match'],
    );

    const body = request.body as Record<string, unknown>;

    if (!isAppealKind(body['kind'])) {
      // A closed set: an unrecognised kind must not be stored, because §5.14.2 returns it and a caller
      // would then branch on a token no specification defines.
      //
      // The SEMANTIC spelling of `SCHEMA_VALIDATION_FAILED` (422), not the syntactic one (400): the body is
      // well formed JSON with a present `kind`; what fails is that the value is not in the vocabulary. §8.2
      // declares the code under both statuses and SPEC-006 §6.2 calls the 422 spelling "semantic", which is
      // exactly this case — and `apiError`'s third argument exists for it.
      throw apiError(
        'SCHEMA_VALIDATION_FAILED',
        { field: 'kind', allowedFields: [...APPEAL_KINDS] },
        422,
      );
    }
    const kind = body['kind'];

    // A CONTROL A CALLER CAN WAIVE IS NOT A CONTROL. Every kind §5.14.1 accepts is appeal or escalation
    // content, which SPEC-003 §5.14.1 places in "counsel-review territory", so review is mandatory for all
    // four and `false` is refused rather than honoured.
    if (body['requiresHumanReview'] !== true) {
      throw apiError('HUMAN_REVIEW_REQUIRED', { field: 'requiresHumanReview', ruleRef: 'VG-CHANNEL-001' });
    }

    const rawArtifacts = body['artifactIds'];
    if (!Array.isArray(rawArtifacts) || rawArtifacts.length === 0) {
      // §5.14.1: "422 ARTIFACT_REQUIRED (zero artifacts)". An escalation asserting a legal position with
      // nothing attached is the one thing counsel review cannot work from.
      throw apiError('ARTIFACT_REQUIRED', { field: 'artifactIds' });
    }
    const artifactIds = rawArtifacts.map((value, index) => {
      const id = optionalUuid(value, `artifactIds[${String(index)}]`);
      if (id === null) throw apiError('SCHEMA_VALIDATION_FAILED', { field: `artifactIds[${String(index)}]` });
      return id;
    });

    const templateVersion = token(body['templateVersion'], 'templateVersion', MAX.templateVersion);
    // A hash is required because §5.14.1 refuses without one: the point of recording it is that the
    // escalation's wording is pinned to a reviewed version, and an unpinned escalation cannot be shown to
    // have been reviewed at all. The refusal uses the code §5.14.1 names for it — `TEMPLATE_HASH_REQUIRED`
    // is the token an integrator can act on, and `SCHEMA_VALIDATION_FAILED` would tell them their JSON was
    // malformed when in fact a required member was absent.
    const templateHashRaw = body['templateHash'];
    if (typeof templateHashRaw !== 'string' || templateHashRaw.trim().length === 0) {
      throw apiError('TEMPLATE_HASH_REQUIRED', { field: 'templateHash' });
    }
    const templateHash = token(templateHashRaw, 'templateHash', MAX.templateHash);
    const recipientControllerId = optionalUuid(body['recipientControllerId'], 'recipientControllerId');

    return idempotent(h, async (tx) => {
      const precondition = await queries.casePrecondition(tx, caseId);
      if (precondition === undefined) throw apiError('RESOURCE_NOT_FOUND');

      if (precondition.updatedAtMs !== expectedUpdatedAtMs) {
        reply.header('etag', caseEtag(precondition));
        throw apiError('PRECONDITION_FAILED', { currentEtag: caseEtag(precondition) });
      }

      const created = await queries.createAppealEscalation(tx, caseId, {
        kind,
        requiresHumanReview: true,
        artifactIds,
        templateVersion,
        templateHash,
        recipientControllerId,
      });
      if (!created.ok) {
        throw created.reason === 'WINDOW_CLOSED'
          ? apiError('APPEAL_WINDOW_CLOSED', { caseId })
          : apiError('RESOURCE_NOT_FOUND');
      }

      const row = await queries.getAppealEscalation(tx, created.value.appealEscalationId);
      if (row === undefined) throw apiError('INTERNAL_ERROR');

      // The ETag is READ BACK rather than derived from the request: creating an escalation does not move
      // the case's truth state, so the case token is unchanged, and reporting the pre-write token would be
      // a guess about a row this transaction did not modify.
      const after = await queries.casePrecondition(tx, caseId);
      if (after !== undefined) reply.header('etag', caseEtag(after));

      return {
        status: 201,
        body: {
          appealEscalationId: row.appealEscalationId,
          caseId: row.caseId,
          kind: row.kind,
          // `requiresHumanReview` is echoed as the STORED value, not as the request's `true`: the response
          // reports the row, so a later schema default could not make the two disagree silently.
          requiresHumanReview: row.requiresHumanReview,
          reviewState: row.reviewState,
          artifactIds: [...row.artifactIds],
          createdAt: row.createdAt,
          // §5.14.1: creating the record does not send anything. Hard-coded because there is no code path
          // in this module that sends, so no other value is reachable.
          externalEffect: false,
        },
        resourceId: row.appealEscalationId,
      };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.14.2 GET /v1/cases/{caseId}/appeal-escalations — list with review state.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/cases/:caseId/appeal-escalations', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');

    return h.withTenant(async (tx) => {
      // The case's existence is asserted before listing, so an absent or another tenant's case is a 404
      // rather than an empty list. An empty list is a true statement about a case that exists and has no
      // escalations; it is a misleading one about a case the caller cannot see (SPEC-006 H-9).
      if ((await queries.casePrecondition(tx, caseId)) === undefined) throw apiError('RESOURCE_NOT_FOUND');
      const rows = await queries.listAppealEscalations(tx, caseId);
      return reply.code(200).send({ data: rows });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.14.3 GET /v1/appeal-escalations/{appealEscalationId} — one escalation.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/appeal-escalations/:appealEscalationId', async (request, reply) => {
    const h = beginHandler(request, reply);
    const appealEscalationId = uuidParam(request, 'appealEscalationId');

    return h.withTenant(async (tx) => {
      const row = await queries.getAppealEscalation(tx, appealEscalationId);
      if (row === undefined) throw apiError('RESOURCE_NOT_FOUND');
      return reply.code(200).send(row);
    });
  });
}

/** Exported for the route-catalogue test, so it can assert this module covers its declared routes. */
export const APPEAL_ROUTE_TEMPLATES: readonly string[] = [
  '/v1/cases/:caseId/appeal-escalations',
  '/v1/appeal-escalations/:appealEscalationId',
];
