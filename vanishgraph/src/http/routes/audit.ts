/**
 * The audit stream (SPEC-003 §5.15).
 *
 * 2 of the 78 routes, both reads. §5.15.1 states the group's defining property as a property of the API:
 * "There is **no** `POST`, `PATCH`, `PUT`, or `DELETE` audit route anywhere on `/v1`: the append-only property
 * is enforced by the absence of a mutation surface as well as by storage (VG-EVIDENCE-003)." This module
 * therefore registers exactly two `GET`s, and `tests/contract/audit-routes.test.ts` asserts that the registry
 * contains no mutating audit route — so a future edit that added one would fail a test rather than pass a
 * review.
 *
 * THE TWO TIME-RANGE REFUSALS ARE DECLARED, NOT HAND-CHECKED. §5.15.1 requires `from` and `to` ("an unbounded
 * audit scan is refused with `400 TIME_RANGE_REQUIRED`") and caps the span at 90 days. Both live on
 * `AUDIT_EVENTS_QUERY` as `requireTimeRange`/`maxSpanDays`, so `parseQuery` produces them before a handler
 * runs and `page.filter` cannot advertise a range the route then refuses. Until this round, registry rows
 * existed for both codes and **no code path threw either**.
 *
 * WHAT IS NOT REPORTED, AND WHY THAT IS THE HONEST CHOICE. The DTO has no `payload` field, and the adapter does
 * not SELECT the payload column. §5.15.1 requires that audit payloads never carry PII, identifier values,
 * secrets, tokens or request bodies (VG-SEC-002, §8.3); a route that returned the payload would make that
 * promise the caller's to keep. The bytes are not fetched, so no handler can leak them.
 *
 * NO HANDLER CONTAINS A TRUTH STATE, and none could: an audit event is the record of a decision, never a
 * decision. The only state this module reads is the truth state that produced an event, and it is not read at
 * all — `truthState` appears nowhere in this file.
 */

import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { beginHandler } from './handler-context.ts';
import { parseQuery } from '../query/strict.ts';
import { AUDIT_EVENTS_QUERY } from '../query/filters.ts';
import { buildCollection } from '../dto/page.ts';
import { encodeCursor, decodeCursor, filterHashOf } from '../pagination/cursor.ts';
import { isAuditEventId, type AuditEventRow, type AuditQueries } from '../../application/contracts/audit-queries.ts';

export interface AuditRouteOptions {
  /** The cursor signing secret (SPEC-003 §2.5). From configuration, never a constant. */
  readonly sessionSecret: string;
  /** The read model, injected as a PORT: the boundary must not import `src/adapters/**`. */
  readonly queries: AuditQueries;
}

const AUDIT_ROUTE = '/v1/audit-events';

/**
 * The route's query parameters, mapped onto the port's filter shape.
 *
 * `from`/`to` are read from the NORMALISED filter, where `parseQuery` has already proved them present and
 * inside the 90-day cap — so this function cannot build a filter with an absent bound, and the adapter's
 * unconditional range predicate is safe.
 */
function auditFilters(filter: Readonly<Record<string, unknown>>): {
  actor?: string;
  action?: string | readonly string[];
  targetKind?: string;
  targetId?: string;
  correlationId?: string;
  fromMs: number;
  toMs: number;
} {
  const fromMs = Date.parse(String(filter['from']));
  const toMs = Date.parse(String(filter['to']));
  // A defensive refusal rather than a silent `NaN`: reaching here with an unparseable bound would mean
  // `parseQuery` had stopped validating, and a NaN bound would make the SQL predicate match nothing — a
  // failure that looks like an empty audit trail rather than like a bug.
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw apiError('TIME_RANGE_REQUIRED', { collection: 'audit-events' });

  const out: {
    actor?: string;
    action?: string | readonly string[];
    targetKind?: string;
    targetId?: string;
    correlationId?: string;
    fromMs: number;
    toMs: number;
  } = { fromMs, toMs };
  if (typeof filter['actor'] === 'string') out.actor = filter['actor'];
  if (typeof filter['action'] === 'string' || Array.isArray(filter['action'])) {
    out.action = filter['action'] as string | readonly string[];
  }
  if (typeof filter['targetKind'] === 'string') out.targetKind = filter['targetKind'];
  if (typeof filter['targetId'] === 'string') out.targetId = filter['targetId'];
  if (typeof filter['correlationId'] === 'string') out.correlationId = filter['correlationId'];
  return out;
}

export function auditRoutes(app: FastifyInstance, options: AuditRouteOptions): void {
  const secret = options.sessionSecret;
  const queries = options.queries;

  // ---------------------------------------------------------------------------------------------
  // 5.15.1 GET /v1/audit-events — the bounded, paginated audit stream.
  // ---------------------------------------------------------------------------------------------
  app.get(AUDIT_ROUTE, async (request, reply) => {
    const h = beginHandler(request, reply);
    const parsed = parseQuery(request.query as Record<string, unknown>, AUDIT_EVENTS_QUERY);
    const filterHash = filterHashOf(parsed.filter);
    // The schema's sort fields are `at` and `id`; the keyset value comes from whichever was chosen, so a
    // continuation never asks the next page to start after a value from a different ordering.
    const sortField = parsed.sort.split(':')[0] ?? 'at';

    const after =
      parsed.cursor === undefined
        ? undefined
        : (() => {
            const decoded = decodeCursor(parsed.cursor, secret, {
              tenantId: h.context.tenantId.value,
              routeTemplate: AUDIT_ROUTE,
              filterHash,
              sort: parsed.sort,
            });
            return {
              sortValue: typeof decoded.keyset.sortValue === 'string' ? decoded.keyset.sortValue : '',
              id: decoded.keyset.id,
            };
          })();

    return h.withTenant(async (tx) => {
      const rows = await queries.listAuditEvents(tx, {
        limit: parsed.limit,
        sort: parsed.sort,
        filters: auditFilters(parsed.filter),
        ...(after === undefined ? {} : { after }),
      });

      const collection = buildCollection(
        rows,
        { limit: parsed.limit, sort: parsed.sort, filter: parsed.filter },
        (last: AuditEventRow) =>
          encodeCursor(
            {
              tenantId: h.context.tenantId.value,
              routeTemplate: AUDIT_ROUTE,
              filterHash,
              sort: parsed.sort,
              keyset: {
                sortValue: sortField === 'id' ? last.auditEventId : last.at,
                id: last.auditEventId,
              },
              issuedAt: Math.floor(Date.now() / 1000),
            },
            secret,
          ),
      );
      return reply.code(200).send(collection);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.15.2 GET /v1/audit-events/{auditEventId} — one event.
  // ---------------------------------------------------------------------------------------------
  app.get(`${AUDIT_ROUTE}/:auditEventId`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const params = request.params as Record<string, string>;
    const raw = params['auditEventId'];
    // A malformed id is reported as NOT FOUND rather than as a validation error, for the same reason
    // `/v1/subjects/{subjectId}` does it: SPEC-006 H-9 requires absent and other-tenant resources to be
    // indistinguishable, and a distinct "malformed id" response would tell a prober what shape an id has.
    if (raw === undefined || !isAuditEventId(raw)) throw apiError('RESOURCE_NOT_FOUND');

    return h.withTenant(async (tx) => {
      const row = await queries.getAuditEvent(tx, raw);
      if (row === undefined) throw apiError('RESOURCE_NOT_FOUND');
      return reply.code(200).send(row);
    });
  });
}

/** Exported for the route-catalogue test, so it can assert this module covers its declared routes. */
export const AUDIT_ROUTE_TEMPLATES: readonly string[] = [`${AUDIT_ROUTE}/:auditEventId`];
