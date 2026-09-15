/**
 * Deadlines (SPEC-003 §5.13).
 *
 * 3 of the 78 routes. Same four steps as the rest of this boundary: `beginHandler` (registry entry, scopes,
 * step-up, tenant-scoped transaction) → validate against a CLOSED vocabulary → ONE port call → map and
 * return.
 *
 * DEADLINES ARE DERIVED FROM VERSIONED DATA, NEVER HARD-CODED (SPEC-001 §3.4, VG-POLICY-001), and §5.13.1
 * turns that into an obligation the response carries: "Every deadline names the policy version and rule
 * code it was derived from." Two consequences shape this file:
 *
 *   * **A deadline is refused if its provenance cannot be named.** `createDeadline` reports
 *     `NO_PROVENANCE` for a case with no `PolicyDecision`, and this module maps that to
 *     `422 JURISDICTION_UNRESOLVED` — the code the specification already uses for "no policy resolves",
 *     and the only one in the closed set that fits. Writing the row without provenance would make §5.13.1's
 *     sentence false for a row this API created.
 *   * **`state` is DERIVED on every read, never stored.** Three of its four values change with the clock, so
 *     a stored copy would go wrong without anyone writing to it. `WAIVED` is admitted by the contract and
 *     unreachable here: no §5.13 route waives a deadline and no specification defines a waiver record.
 *
 * NO HANDLER CONTAINS A TRUTH STATE. §5.13.3 says satisfying a deadline "is not a removal outcome and
 * produces no truth-state change by itself", and nothing in §5.13 creates one. The only `truthState` in this
 * file is the one §2.7 puts in an ETag.
 */

import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { withIdempotency } from '../plugins/idempotency.ts';
import { beginHandler, uuidParam, type HandlerContext } from './handler-context.ts';
import type { TenantTransaction } from '../plugins/tenancy.ts';
import {
  DEADLINE_KINDS,
  DEADLINE_SOURCES,
  isDeadlineKind,
  isDeadlineSource,
  type DeadlineQueries,
} from '../../application/contracts/deadline-queries.ts';

export interface DeadlineRouteOptions {
  /** The model, injected as a PORT: the boundary must not import `src/adapters/**`. */
  readonly queries: DeadlineQueries;
  /** Injectable so a test can pin "now" for the derived state; production passes the real clock. */
  readonly now?: () => number;
}

const MAX = { satisfiedBy: 200 } as const;

function token(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

function uuidValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

function instant(value: unknown, field: string): number {
  if (typeof value !== 'string') throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  return parsed;
}

/**
 * The §2.7 ETag for a case: `"<truthState>:<updatedAtEpochMillis>"`.
 *
 * The same shape and the same reasoning as §5.14's, and it is why `request_case` needs no `row_version`:
 * the pair (truth state, `updated_at`) already changes on every committed mutation. A second counter for one
 * resource would be two tokens for one thing.
 */
function caseEtag(context: { readonly truthState: string; readonly updatedAtMs: number }): string {
  return `"${context.truthState}:${String(context.updatedAtMs)}"`;
}

function updatedAtFromIfMatch(header: string | undefined): number {
  if (header === undefined) throw apiError('PRECONDITION_REQUIRED');
  const match = /^"?[A-Z_]*:(\d{1,15})"?$/.exec(header.trim());
  const value = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(value)) throw apiError('PRECONDITION_FAILED');
  return value;
}

async function idempotent(
  h: HandlerContext,
  work: (tx: TenantTransaction) => Promise<{ status: number; body: unknown; resourceId?: string | null }>,
): Promise<unknown> {
  return withIdempotency<unknown>(h.request, h.request.server.vgIdempotency, h.reply, () => h.withTenant(work));
}

export function deadlineRoutes(app: FastifyInstance, options: DeadlineRouteOptions): void {
  const queries = options.queries;
  // ONE clock read per request, captured here rather than read inside the derivation: `overdueSeconds` and
  // `state` must agree, and two `Date.now()` calls could straddle a due instant and report an OPEN deadline
  // with a non-zero overdue count.
  const now = options.now ?? Date.now;

  // ---------------------------------------------------------------------------------------------
  // 5.13.1 GET /v1/cases/{caseId}/deadlines — with their policy provenance and derived state.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/cases/:caseId/deadlines', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');

    return h.withTenant(async (tx) => {
      // The case's existence is asserted before listing, so an absent or another tenant's case is a 404
      // rather than an empty list — an empty list is a true statement about a case that exists, and a
      // misleading one about a case the caller cannot see (SPEC-006 H-9).
      if ((await queries.caseDeadlineContext(tx, caseId)) === undefined) throw apiError('RESOURCE_NOT_FOUND');
      const rows = await queries.listDeadlines(tx, caseId, now());
      return reply.code(200).send({ data: rows });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.13.2 POST /v1/cases/{caseId}/deadlines — step-up not required; If-Match; idempotency REQUIRED.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/cases/:caseId/deadlines', async (request, reply) => {
    const h = beginHandler(request, reply);
    const caseId = uuidParam(request, 'caseId');
    const expectedUpdatedAtMs = updatedAtFromIfMatch(
      Array.isArray(request.headers['if-match']) ? request.headers['if-match'][0] : request.headers['if-match'],
    );

    const body = request.body as Record<string, unknown>;

    if (!isDeadlineKind(body['kind'])) {
      // A closed set, and the SEMANTIC spelling of the schema code (422): the body is well-formed JSON with
      // a present `kind`; what fails is that the value is not in the vocabulary.
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'kind', allowedFields: [...DEADLINE_KINDS] }, 422);
    }
    const kind = body['kind'];

    // §5.13.2 names `DEADLINE_SOURCE_REQUIRED`, so a missing or unknown `source` uses that code rather than
    // a generic schema failure: the token is one an integrator can act on, and §5.13.2 asks for it by name.
    if (!isDeadlineSource(body['source'])) {
      throw apiError('DEADLINE_SOURCE_REQUIRED', { field: 'source', allowedFields: [...DEADLINE_SOURCES] });
    }
    const source = body['source'];

    const dueAtMs = instant(body['dueAt'], 'dueAt');
    const nowMs = now();
    // A deadline that has already passed is not a deadline; recording one would create a row that is
    // BREACHED the instant it exists, which is a data-entry error rather than a fact about the world.
    if (dueAtMs <= nowMs) throw apiError('DEADLINE_IN_PAST', { field: 'dueAt' });

    const evidenceArtifactId = uuidValue(body['evidenceArtifactId'], 'evidenceArtifactId');

    return idempotent(h, async (tx) => {
      const context = await queries.caseDeadlineContext(tx, caseId);
      if (context === undefined) throw apiError('RESOURCE_NOT_FOUND');
      if (context.updatedAtMs !== expectedUpdatedAtMs) {
        reply.header('etag', caseEtag(context));
        throw apiError('PRECONDITION_FAILED', { currentEtag: caseEtag(context) });
      }

      const created = await queries.createDeadline(tx, caseId, {
        kind,
        dueAtMs,
        source,
        evidenceArtifactId,
        // `deadline.derivation_ref`'s CHECK requires `policy:%`, and §5.13.1 requires the version to be
        // nameable. The version comes from the case's own decision, so the reference names the policy the
        // case was actually authorised under rather than whichever version happens to be in force now.
        derivationRef: `policy:${context.provenance?.policyVersion ?? ''}`,
      });
      if (!created.ok) {
        if (created.reason === 'EVIDENCE_NOT_FOUND') throw apiError('EVIDENCE_NOT_FOUND', { field: 'evidenceArtifactId' });
        if (created.reason === 'NO_PROVENANCE') {
          // The only code in the closed set that means "no policy resolves for this request", which is
          // exactly the situation: without a decision there is no version or rule to name.
          throw apiError('JURISDICTION_UNRESOLVED', { caseId });
        }
        throw apiError('RESOURCE_NOT_FOUND');
      }

      // Read BACK rather than echo the request: the response must report the row, including the provenance
      // and derived state the port computed, so a later change to the derivation cannot leave the response
      // describing something the database does not hold.
      const rows = await queries.listDeadlines(tx, caseId, nowMs);
      const createdRow = rows.find((row) => row.deadlineId === created.value.deadlineId);
      if (createdRow === undefined) throw apiError('INTERNAL_ERROR');

      reply.header('location', `/v1/cases/${caseId}/deadlines`);
      return { status: 201, body: createdRow, resourceId: created.value.deadlineId };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.13.3 POST /v1/deadlines/{deadlineId}/satisfaction — idempotency REQUIRED, no If-Match.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/deadlines/:deadlineId/satisfaction', async (request, reply) => {
    const h = beginHandler(request, reply);
    const deadlineId = uuidParam(request, 'deadlineId');

    const body = request.body as Record<string, unknown>;
    const satisfiedAtMs = instant(body['satisfiedAt'], 'satisfiedAt');
    const satisfiedBy = token(body['satisfiedBy'], 'satisfiedBy', MAX.satisfiedBy);
    const evidenceArtifactId = uuidValue(body['evidenceArtifactId'], 'evidenceArtifactId');

    return idempotent(h, async (tx) => {
      const result = await queries.satisfyDeadline(tx, deadlineId, {
        satisfiedAtMs,
        satisfiedBy,
        evidenceArtifactId,
      });
      if (!result.ok) {
        // `deadlineId` is NOT in `DETAILS_ALLOWLIST`, so it is not echoed: the caller supplied it and
        // already knows it, and adding an allowlist key for a value the request carried would widen the
        // closed `details` set for no diagnostic gain.
        if (result.reason === 'ALREADY_SATISFIED') throw apiError('DEADLINE_ALREADY_SATISFIED', { field: 'satisfiedAt' });
        if (result.reason === 'EVIDENCE_NOT_FOUND') throw apiError('EVIDENCE_NOT_FOUND', { field: 'evidenceArtifactId' });
        throw apiError('RESOURCE_NOT_FOUND');
      }

      // §5.13.3's success body names exactly three fields. `state` is reported as SATISFIED because that is
      // what the write established and what the derivation will return afterwards — reporting a derived
      // value from a re-read here would be a second query for a fact this transaction just set.
      return {
        status: 200,
        body: {
          deadlineId: result.value.deadlineId,
          state: 'SATISFIED',
          satisfiedAt: result.value.satisfiedAt,
        },
        resourceId: result.value.deadlineId,
      };
    });
  });
}

/** Exported for the route-catalogue test, so it can assert this module covers its declared routes. */
export const DEADLINE_ROUTE_TEMPLATES: readonly string[] = [
  '/v1/cases/:caseId/deadlines',
  '/v1/deadlines/:deadlineId/satisfaction',
];
