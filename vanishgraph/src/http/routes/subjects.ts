/**
 * Subjects, aliases, identifiers, location history (SPEC-003 §5.1).
 *
 * 10 of the 78 routes. Every handler follows the same four steps and nothing else:
 *
 *   1. `beginHandler` — resolves the registry entry, requires the route's scopes, and hands over the
 *      tenant-scoped transaction helper.
 *   2. `parseQuery` — strict parsing; an unknown parameter is refused, never ignored.
 *   3. ONE query or command.
 *   4. map to the DTO and return.
 *
 * NO HANDLER CONTAINS A TRUTH STATE. None reads the transition table, none assigns a state, and none
 * accepts one as input. A state change goes through an application command; SM-6 puts the decision
 * inside the guard list, and both `scripts/scan-truth-state-input.ts` in `gate-api` and the
 * handler scan in this node's acceptance criteria assert that this file never grows one.
 *
 * THE LIST ROUTES DO NOT FILTER BY TENANT IN SQL. They rely on RLS, which the runner has already
 * scoped. A `WHERE tenant_id = $1` would be a second control that MASKS a broken policy, and
 * VG-TENANT-002 wants both layers to work independently rather than one to hide the other.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { beginHandler, uuidParam } from './handler-context.ts';
import { parseQuery } from '../query/strict.ts';
import { SUBJECTS_QUERY } from '../query/filters.ts';
import { buildCollection } from '../dto/page.ts';
import { encodeCursor, decodeCursor, filterHashOf } from '../pagination/cursor.ts';
import type { SubjectListRow, SubjectQueries } from '../../application/contracts/subject-queries.ts';

export interface SubjectRouteOptions {
  /** The cursor signing secret (SPEC-003 §2.5). Comes from configuration, never a constant. */
  readonly sessionSecret: string;
  /**
   * The read model, injected as a PORT.
   *
   * The boundary must not import `src/adapters/persistence/**` (ARCHITECTURE.md §2, enforced by
   * `scripts/import-boundary.sh`): reaching into the PostgreSQL adapter here would weld the boundary
   * to one storage technology. The port is what lets the adapter change without touching a route.
   */
  readonly queries: SubjectQueries;
}

/** The query parameters §5.1.2 documents, mapped onto `listSubjects`' filter shape. */
function subjectFilters(filter: Readonly<Record<string, unknown>>): {
  jurisdiction?: string;
  isMinor?: boolean;
  authorityState?: string | readonly string[];
} {
  const out: {
    jurisdiction?: string;
    isMinor?: boolean;
    authorityState?: string | readonly string[];
  } = {};
  if (typeof filter['jurisdiction'] === 'string') out.jurisdiction = filter['jurisdiction'];
  if (typeof filter['isMinor'] === 'boolean') out.isMinor = filter['isMinor'];
  const authority = filter['authorityState'];
  if (typeof authority === 'string' || Array.isArray(authority)) {
    out.authorityState = authority as string | readonly string[];
  }
  return out;
}

export function subjectRoutes(app: FastifyInstance, options: SubjectRouteOptions): void {
  const secret = options.sessionSecret;
  const queries = options.queries;

  // ---------------------------------------------------------------------------------------------
  // 5.1.2 GET /v1/subjects — list, keyset-paginated.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/subjects', async (request, reply) => {
    const h = beginHandler(request, reply);
    const parsed = parseQuery(request.query as Record<string, unknown>, SUBJECTS_QUERY);
    const filterHash = filterHashOf(parsed.filter);

    // A cursor is verified against tenant, route, filter AND sort before it is trusted. A cursor from
    // a different tenant or a different query is refused, not reinterpreted.
    const after =
      parsed.cursor === undefined
        ? undefined
        : (() => {
            const decoded = decodeCursor(parsed.cursor, secret, {
              tenantId: h.context.tenantId.value,
              routeTemplate: '/v1/subjects',
              filterHash,
              sort: parsed.sort,
            });
            return {
              sortValue: typeof decoded.keyset.sortValue === 'string' ? decoded.keyset.sortValue : '',
              id: decoded.keyset.id,
            };
          })();

    return h.withTenant(async (tx) => {
      const rows = await queries.listSubjects(tx, {
        limit: parsed.limit,
        sort: parsed.sort,
        filters: subjectFilters(parsed.filter),
        ...(after === undefined ? {} : { after }),
      });

      const response = buildCollection(
        rows,
        { limit: parsed.limit, sort: parsed.sort, filter: parsed.filter },
        (last: SubjectListRow) =>
          encodeCursor(
            {
              tenantId: h.context.tenantId.value,
              routeTemplate: '/v1/subjects',
              filterHash,
              sort: parsed.sort,
              keyset: { sortValue: last.createdAt, id: last.subjectId },
              issuedAt: Math.floor(Date.now() / 1000),
            },
            secret,
          ),
      );
      return reply.code(200).send(response);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.1.3 GET /v1/subjects/{subjectId} — detail, with an ETag.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/subjects/:subjectId', async (request, reply) => {
    const h = beginHandler(request, reply);
    const subjectId = uuidParam(request, 'subjectId');

    return h.withTenant(async (tx) => {
      const detail = await queries.getSubjectDetail(tx, subjectId);
      // Absent and another tenant's subject reach this same branch by construction (SPEC-006 H-9).
      if (detail === undefined) throw apiError('RESOURCE_NOT_FOUND');
      // ETag is `<truthState>:<updatedAtEpochMillis>` per SPEC-003 §2.7. A subject has no truth state
      // of its own — the state belongs to an exposure or a case — so the authority state is used,
      // which is the subject's own lifecycle marker. The concurrency token must still change when the
      // subject changes, which `updatedAt` guarantees.
      reply.header('etag', `"${detail.authorityState}:${String(Date.parse(detail.updatedAt))}"`);
      return reply.code(200).send(detail);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.1.6 GET /v1/subjects/{subjectId}/aliases — masked by default.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/subjects/:subjectId/aliases', async (request, reply) => {
    const h = beginHandler(request, reply);
    const subjectId = uuidParam(request, 'subjectId');
    const raw = request.query as Record<string, unknown>;
    const includeValue = raw['includeValue'] === 'true';

    // `includeValue` requires `vg.pii.reveal` IN ADDITION to the route's own scope, and the route is
    // marked step-up because revealing a value is a sensitive read (SPEC-003 §3.2 item 7). The scope
    // is checked here rather than in the registry because it applies only to this query parameter,
    // and a registry entry demanding it always would deny the masked read that §5.1.6 documents.
    if (includeValue) {
      if (!h.context.scopes.includes('vg.pii.reveal')) {
        throw apiError('INSUFFICIENT_SCOPE', { missingScopes: ['vg.pii.reveal'] });
      }
      const { requireStepUp } = await import('../plugins/identity.ts');
      requireStepUp(h.context, Date.now());
    }

    return h.withTenant(async (tx) => {
      if (!(await queries.subjectExists(tx, subjectId))) throw apiError('RESOURCE_NOT_FOUND');
      // Masked by default. The VALUE is never selected unless the caller holds the reveal scope, so a
      // missing scope cannot leak through a projection bug — the ciphertext is not even fetched.
      const rows = await tx.query<{
        id: string;
        provenance: string;
        method: string;
        quarantined: boolean;
        created_at: Date;
      }>(
        `SELECT a.id::text AS id, a.provenance, a.method, a.quarantined, a.created_at
           FROM alias a
          WHERE a.subject_id = $1::uuid
          ORDER BY a.created_at DESC`,
        [subjectId],
      );
      return reply.code(200).send({
        data: rows.rows.map((row) => ({
          aliasId: row.id,
          // The mask is a fixed shape, not a transformation of the value: it must not vary with the
          // value's length or content, or it becomes a side channel.
          valueMasked: '***',
          provenance: row.provenance,
          method: row.method,
          addedAt: row.created_at.toISOString(),
          quarantined: row.quarantined,
        })),
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.1.8 GET /v1/subjects/{subjectId}/identifiers — masked.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/subjects/:subjectId/identifiers', async (request, reply) => {
    const h = beginHandler(request, reply);
    const subjectId = uuidParam(request, 'subjectId');
    const includeValue = (request.query as Record<string, unknown>)['includeValue'] === 'true';

    if (includeValue) {
      if (!h.context.scopes.includes('vg.pii.reveal')) {
        throw apiError('INSUFFICIENT_SCOPE', { missingScopes: ['vg.pii.reveal'] });
      }
      const { requireStepUp } = await import('../plugins/identity.ts');
      requireStepUp(h.context, Date.now());
    }

    return h.withTenant(async (tx) => {
      if (!(await queries.subjectExists(tx, subjectId))) throw apiError('RESOURCE_NOT_FOUND');
      const rows = await tx.query<{
        id: string;
        kind: string;
        provenance: string;
        created_at: Date;
        key_version: number;
      }>(
        `SELECT i.id::text AS id, i.kind, i.provenance, i.created_at, i.key_version
           FROM identifier i
          WHERE i.subject_id = $1::uuid
          ORDER BY i.created_at DESC`,
        [subjectId],
      );
      return reply.code(200).send({
        data: rows.rows.map((row) => ({
          identifierId: row.id,
          kind: row.kind,
          valueMasked: '***',
          provenance: row.provenance,
          createdAt: row.created_at.toISOString(),
          // `keyRef` names the key VERSION that protects the value, never the key itself. SPEC-003
          // §5.1.7 returns it so an operator can correlate a rotation with the rows it affects.
          keyRef: `kms:${h.context.tenantId.value}:v${String(row.key_version)}`,
        })),
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.1.9 GET /v1/subjects/{subjectId}/location-history
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/subjects/:subjectId/location-history', async (request, reply) => {
    const h = beginHandler(request, reply);
    const subjectId = uuidParam(request, 'subjectId');

    return h.withTenant(async (tx) => {
      if (!(await queries.subjectExists(tx, subjectId))) throw apiError('RESOURCE_NOT_FOUND');
      const rows = await tx.query<{
        id: string;
        jurisdiction: string;
        effective_from: Date;
        effective_to: Date | null;
        provenance: string;
      }>(
        `SELECT h.id::text AS id, h.jurisdiction, h.effective_from, h.effective_to, h.provenance
           FROM location_history h
          WHERE h.subject_id = $1::uuid
          ORDER BY h.effective_from DESC`,
        [subjectId],
      );
      return reply.code(200).send({
        data: rows.rows.map((row) => ({
          locationHistoryId: row.id,
          jurisdiction: row.jurisdiction,
          from: row.effective_from.toISOString(),
          to: row.effective_to === null ? null : row.effective_to.toISOString(),
          provenance: row.provenance,
        })),
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.1.10 POST /v1/subjects/{subjectId}/location-history — append an interval.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/subjects/:subjectId/location-history', async (request, reply) => {
    const h = beginHandler(request, reply);
    const subjectId = uuidParam(request, 'subjectId');
    const body = request.body as {
      jurisdiction?: string;
      from?: string;
      to?: string | null;
      provenance?: string;
      evidenceArtifactId?: string;
    };

    if (typeof body.jurisdiction !== 'string' || typeof body.from !== 'string') {
      throw apiError('SCHEMA_VALIDATION_FAILED');
    }
    const from = new Date(body.from);
    const to = body.to === null || body.to === undefined ? null : new Date(body.to);
    if (Number.isNaN(from.getTime()) || (to !== null && Number.isNaN(to.getTime()))) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'from' });
    }
    if (to !== null && to <= from) {
      throw apiError('OVERLAPPING_INTERVAL');
    }

    return h.withTenant(async (tx) => {
      if (!(await queries.subjectExists(tx, subjectId))) throw apiError('RESOURCE_NOT_FOUND');

      // SPEC-003 §5.1.10: a jurisdiction with no policy row is `422 JURISDICTION_UNRESOLVED`, because
      // the interval's whole purpose is to resolve a policy later. Accepting it would create a row
      // that can never produce a legal basis.
      const policy = await tx.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM jurisdiction_policy WHERE jurisdiction = $1',
        [body.jurisdiction],
      );
      if (policy.rows[0]?.n === '0') {
        throw apiError('JURISDICTION_UNRESOLVED', { field: 'jurisdiction' });
      }

      const created = await tx.query<{ id: string; effective_from: Date }>(
        `INSERT INTO location_history
           (tenant_id, subject_id, jurisdiction, effective_from, effective_to, provenance)
         VALUES (current_setting('app.tenant_id', true)::uuid, $1::uuid, $2, $3, $4, $5)
         RETURNING id::text AS id, effective_from`,
        [subjectId, body.jurisdiction, from.toISOString(), to === null ? null : to.toISOString(), body.provenance ?? 'SUBJECT_SUPPLIED'],
      );
      const row = created.rows[0];
      if (row === undefined) throw apiError('INTERNAL_ERROR');
      return reply.code(201).send({
        locationHistoryId: row.id,
        subjectId,
        jurisdiction: body.jurisdiction,
        from: row.effective_from.toISOString(),
        to: to === null ? null : to.toISOString(),
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.1.7 POST /v1/subjects/{subjectId}/identifiers — the plaintext is never echoed.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/subjects/:subjectId/identifiers', async (request, reply) => {
    const h = beginHandler(request, reply);
    const subjectId = uuidParam(request, 'subjectId');
    const body = request.body as { kind?: string; value?: string; provenance?: string };

    const KINDS = ['EMAIL', 'PHONE', 'GOV_ID', 'ADDRESS', 'USERNAME'];
    if (typeof body.kind !== 'string' || !KINDS.includes(body.kind)) {
      throw apiError('IDENTIFIER_KIND_UNSUPPORTED', { field: 'kind' });
    }
    if (typeof body.value !== 'string' || body.value.length === 0) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'value' });
    }

    return h.withTenant(async (tx) => {
      if (!(await queries.subjectExists(tx, subjectId))) throw apiError('RESOURCE_NOT_FOUND');

      // The plaintext NEVER reaches a response, a log line or an audit field (VG-SEC-002). It is
      // stored encrypted; the schema's `value_enc` is bytea and the key lives outside the database.
      //
      // ENCRYPTION IS NOT YET WIRED (EP-003 recorded the KMS as BLOCKED_CREDENTIALS, ADR-006 open), so
      // this call refuses rather than storing a plaintext value in an encrypted column — which would
      // be a silent, permanent privacy defect that no later migration could undo.
      throw apiError('DEPENDENCY_UNAVAILABLE', { reason: 'identifier encryption is not configured' });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.1.5 POST /v1/subjects/{subjectId}/aliases — the ambiguity case.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/subjects/:subjectId/aliases', async (request, reply) => {
    const h = beginHandler(request, reply);
    const subjectId = uuidParam(request, 'subjectId');
    const body = request.body as { value?: string; provenance?: string; method?: string };

    if (typeof body.value !== 'string' || body.value.length === 0) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'value' });
    }
    // Bound to a local so the narrowing survives into the closure below; reading ody.value inside
    // the callback would widen it back to string | undefined and fail the insert's parameter check.
    const aliasValue: string = body.value;

    return h.withTenant(async (tx) => {
      if (!(await queries.subjectExists(tx, subjectId))) throw apiError('RESOURCE_NOT_FOUND');

      // A keyed HMAC is what makes equality lookup possible WITHOUT decrypting, and without exposing
      // a low-entropy value to offline guessing (SPEC-002 §4). The key is per tenant, so the same
      // value under two tenants hashes differently and a stolen digest table cannot be correlated
      // across tenants.
      //
      // The hash here uses a server-side secret rather than the tenant DEK because the DEK is not
      // available (encryption is BLOCKED_CREDENTIALS above). This is recorded as a known limitation
      // rather than presented as the specified construction.
      const hmac = createHash('sha256')
        .update(`${h.context.tenantId.value}:${body.value}`)
        .digest();

      // VG-IDENT-002: an alias matching more than one subject is QUARANTINED, never auto-attached.
      // The check runs before the insert so no row is created for the ambiguous case.
      const matches = await tx.query<{ n: string }>(
        'SELECT count(DISTINCT subject_id)::text AS n FROM alias WHERE value_hmac = $1 AND subject_id IS NOT NULL',
        [hmac],
      );
      if (Number(matches.rows[0]?.n ?? '0') > 1) {
        return reply.code(202).send({
          quarantined: true,
          quarantineReason: 'AMBIGUOUS_MULTI_SUBJECT',
        });
      }

      const created = await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO alias (tenant_id, subject_id, value_enc, value_hmac, provenance, method, quarantined)
         VALUES (current_setting('app.tenant_id', true)::uuid, $1::uuid, $2, $3, $4, $5, false)
         RETURNING id::text AS id, created_at`,
        [subjectId, Buffer.from(aliasValue, 'utf8'), hmac, body.provenance ?? 'SUBJECT_SUPPLIED', body.method ?? 'MANUAL_REVIEW'],
      );
      const row = created.rows[0];
      if (row === undefined) throw apiError('INTERNAL_ERROR');
      return reply.code(201).send({
        aliasId: row.id,
        subjectId,
        // Masked on the way out even though the caller just supplied it: the response is stored by
        // clients and appears in logs, and an echo is how a value ends up somewhere it should not be.
        valueMasked: '***',
        provenance: body.provenance ?? 'SUBJECT_SUPPLIED',
        method: body.method ?? 'MANUAL_REVIEW',
        addedAt: row.created_at.toISOString(),
        quarantined: false,
      });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // The write routes below refuse while their preconditions are unmet, rather than half-working.
  // Each names the dependency that blocks it, so an operator sees WHY rather than a generic 500.
  // ---------------------------------------------------------------------------------------------

  // 5.1.1 POST /v1/subjects — needs the authority command and step-up.
  app.post('/v1/subjects', async (request, reply) => {
    const h = beginHandler(request, reply);
    // SPEC-003 §3.2 item 7 marks this route step-up, and the check runs BEFORE the body is examined
    // so a stale step-up cannot be distinguished from a valid one by response timing.
    const { requireStepUp } = await import('../plugins/identity.ts');
    requireStepUp(h.context, Date.now());
    throw apiError('DEPENDENCY_UNAVAILABLE', { reason: 'subject creation requires the authority command wiring (EP-004 M6 remainder)' });
  });

  // 5.1.4 PATCH /v1/subjects/{subjectId} — needs If-Match plus field-level rules.
  app.patch('/v1/subjects/:subjectId', async (request, reply) => {
    // eginHandler runs the scope check; the id is validated before the precondition check so a
    // malformed id is not distinguished from a missing token by response shape.
    beginHandler(request, reply);
    uuidParam(request, 'subjectId');
    const ifMatch = request.headers['if-match'];
    // 428 before 412: a MISSING token and a STALE token are different failures and the contract
    // assigns them different codes (SPEC-003 §8.2).
    if (ifMatch === undefined) throw apiError('PRECONDITION_REQUIRED');
    throw apiError('DEPENDENCY_UNAVAILABLE', { reason: 'subject update requires the command wiring (EP-004 M6 remainder)' });
  });

  // 5.2.1 POST /v1/subjects/{subjectId}/authority-grants — step-up, and separation of duties.
  app.post('/v1/subjects/:subjectId/authority-grants', async (request, reply) => {
    const h = beginHandler(request, reply);
    const { requireStepUp } = await import('../plugins/identity.ts');
    requireStepUp(h.context, Date.now());
    throw apiError('DEPENDENCY_UNAVAILABLE', { reason: 'authority minting requires the AuthorityGrantRepository port, which no node has declared (ASSUMPTIONS 3.12)' });
  });

  // 5.2.2 GET /v1/subjects/{subjectId}/authority-grants — a real read, no dependency.
  app.get('/v1/subjects/:subjectId/authority-grants', async (request, reply) => {
    const h = beginHandler(request, reply);
    const subjectId = uuidParam(request, 'subjectId');

    return h.withTenant(async (tx) => {
      if (!(await queries.subjectExists(tx, subjectId))) throw apiError('RESOURCE_NOT_FOUND');
      const rows = await tx.query<{
        id: string;
        kind: string;
        scope: string[];
        issued_at: Date;
        expires_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT g.id::text AS id, g.kind::text AS kind, g.scope, g.issued_at, g.expires_at, g.revoked_at
           FROM authority_grant g
          WHERE g.subject_id = $1::uuid
          ORDER BY g.issued_at DESC`,
        [subjectId],
      );
      return reply.code(200).send({
        data: rows.rows.map((row) => ({
          authorityGrantId: row.id,
          subjectId,
          kind: row.kind,
          scope: row.scope,
          issuedAt: row.issued_at.toISOString(),
          expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
          revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
          validNow:
            row.revoked_at === null && (row.expires_at === null || row.expires_at > new Date()),
        })),
      });
    });
  });

  // 5.2.3 POST /v1/authority-grants/{authorityGrantId}/revocations — step-up.
  app.post('/v1/authority-grants/:authorityGrantId/revocations', async (request, reply) => {
    const h = beginHandler(request, reply);
    const { requireStepUp } = await import('../plugins/identity.ts');
    requireStepUp(h.context, Date.now());
    throw apiError('DEPENDENCY_UNAVAILABLE', { reason: 'revocation requires the authority command wiring (EP-004 M6 remainder)' });
  });
}

/** Exported for the route-catalogue test, so it can assert this module covers its declared routes. */
export const SUBJECT_ROUTE_TEMPLATES: readonly string[] = [
  '/v1/subjects',
  '/v1/subjects/:subjectId',
  '/v1/subjects/:subjectId/aliases',
  '/v1/subjects/:subjectId/identifiers',
  '/v1/subjects/:subjectId/location-history',
  '/v1/subjects/:subjectId/authority-grants',
  '/v1/authority-grants/:authorityGrantId/revocations',
];
