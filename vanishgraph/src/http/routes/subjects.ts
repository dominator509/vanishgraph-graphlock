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
import { epochMillisFromIfMatch, ifMatchHeader } from './preconditions.ts';
import { idempotentWrite } from './idempotent-write.ts';
import { parseQuery } from '../query/strict.ts';
import { SUBJECTS_QUERY } from '../query/filters.ts';
import { buildCollection } from '../dto/page.ts';
import { encodeCursor, decodeCursor, filterHashOf } from '../pagination/cursor.ts';
import type { SubjectListRow, SubjectQueries } from '../../application/contracts/subject-queries.ts';
import type {
  CreateSubjectOutcome,
  MintAuthorityOutcome,
  SubjectCommands,
  SubjectPatch,
} from '../../application/contracts/subject-commands.ts';
import { AUTHORITY_KINDS, IDENTITY_LEVELS, REVOCATION_REASON_SHAPE } from '../../application/contracts/subject-commands.ts';

/** SPEC-003 §5.1.10's jurisdiction shape, and §5.1.1's: a two-letter region, optionally with a subdivision. */
const JURISDICTION_SHAPE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

/** A body field that must be a non-empty string of bounded length. */
function requiredText(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

/** An optional RFC 3339 instant from the body, or `null` when it is absent. */
function optionalInstant(body: Record<string, unknown>, field: string): number | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return Date.parse(value);
}

/**
 * §5.1.6/§5.1.8 `includeValue=true` is REFUSED, never silently downgraded to a masked read.
 *
 * MEASURED DEFECT this corrects: both routes accepted `includeValue=true`, `beginHandler` correctly required
 * `vg.pii.reveal` and a fresh step-up for it (the registry's `conditional` entry), and then the handler returned
 * `valueMasked` with NO error — a caller that had satisfied both gates received a response that looked like a
 * reveal and was not one. That is the "parameter accepted and then ignored" class §2.6's strict parsing exists to
 * prevent, and on these two routes it is worse than a typo: an operator would conclude the value is unavailable
 * rather than that the request was unanswerable.
 *
 * WHY REFUSE RATHER THAN DECRYPT. Revealing a value requires DECRYPTION, and this repository has no durable key
 * provider: ADR-006's managed KMS is open (its adapter raises `KeyProviderBlockedError` on every operation), the
 * `KeyProvider` PORT has no encrypt operation at all (only `wrap`/`unwrap`/`rotate`/`shred`/`hmac`), the only
 * adapter that can encrypt, `LocalFileKeyProvider`, holds its DEKs in an in-process Map and is TESTS-AND-LOCAL-ONLY
 * by VG-SCOPE-020, and NO CODE ANYWHERE WRITES `tenant_key` — measured by searching `src/**` for the table name,
 * which appears only in the port's own doc comment. Returning a mask for a reveal request would be the dishonest
 * option; returning the plaintext is impossible; so the request is refused and the reason is named.
 */
function refuseUnsupportedReveal(request: { readonly query: unknown }): void {
  const raw = request.query as Record<string, unknown>;
  const value = raw['includeValue'];
  if (value === undefined) return;
  if (value !== 'true' && value !== 'false') {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'includeValue' });
  }
  if (value === 'false') return;
  throw apiError('DEPENDENCY_UNAVAILABLE', {
    reason:
      'value reveal requires decryption and no durable key provider is configured (ADR-006 open; no code writes tenant_key)',
  });
}

/** Map §5.2.1's refusals onto the wire codes the contract names. */
function mintRefusal(outcome: Exclude<MintAuthorityOutcome, { ok: true }>): ReturnType<typeof apiError> {
  switch (outcome.reason) {
    case 'SUBJECT_NOT_FOUND':
      return apiError('RESOURCE_NOT_FOUND');
    case 'AUTHORITY_KIND_UNSUPPORTED':
      return apiError('AUTHORITY_KIND_UNSUPPORTED', { field: 'kind' }, 422);
    case 'AUTHORITY_EVIDENCE_REQUIRED':
      return apiError('AUTHORITY_EVIDENCE_REQUIRED', { field: 'evidenceArtifactId' }, 422);
    case 'AUTHORITY_WINDOW_INVALID':
      return apiError('AUTHORITY_WINDOW_INVALID', { field: 'expiresAt' }, 422);
    case 'EVIDENCE_NOT_FOUND':
      return apiError('EVIDENCE_NOT_FOUND', { field: 'evidenceArtifactId' }, 422);
    case 'SCHEMA_VALIDATION_FAILED':
      return apiError('SCHEMA_VALIDATION_FAILED', { field: outcome.field }, 422);
    case 'IDENTITY_LEVEL_INSUFFICIENT':
      return apiError(
        'IDENTITY_LEVEL_INSUFFICIENT',
        { required: outcome.requiredLevel, supplied: outcome.heldLevel },
        403,
      );
    case 'SEPARATION_OF_DUTIES':
      return apiError('SEPARATION_OF_DUTIES', { field: 'subjectId' }, 403);
    case 'NOTICE_TRANSPORT_UNAVAILABLE':
      // §5.2.1 makes `noticeSentAt` mandatory for AGENT grants and SPEC-005 VG-AUTHZ-014 requires the notice, while
      // no notification transport exists in this repository. The effect is refused by name rather than half-done —
      // the same shape §5.8.2 uses for a submission with no channel transport. This is the ONLY kind affected.
      return apiError('DEPENDENCY_UNAVAILABLE', { reason: 'no notification transport is configured (VG-AUTHZ-014)' });
  }
}

/** Map §5.1.1's refusals onto the wire codes the contract names. */
function createSubjectRefusal(outcome: Exclude<CreateSubjectOutcome, { ok: true }>): ReturnType<typeof apiError> {
  switch (outcome.reason) {
    case 'AUTHORITY_EVIDENCE_REQUIRED':
      return apiError('AUTHORITY_EVIDENCE_REQUIRED', { field: 'authorityGrant.evidenceArtifactId' }, 422);
    case 'AUTHORITY_WINDOW_INVALID':
      return apiError('AUTHORITY_WINDOW_INVALID', { field: 'authorityGrant.expiresAt' }, 422);
    case 'EVIDENCE_NOT_FOUND':
      return apiError('EVIDENCE_NOT_FOUND', { field: 'authorityGrant.evidenceArtifactId' }, 422);
    case 'SCHEMA_VALIDATION_FAILED':
      return apiError('SCHEMA_VALIDATION_FAILED', { field: outcome.field }, 422);
    case 'IDENTITY_LEVEL_INSUFFICIENT':
      return apiError(
        'IDENTITY_LEVEL_INSUFFICIENT',
        { required: outcome.requiredLevel, supplied: outcome.heldLevel },
        403,
      );
    case 'SEPARATION_OF_DUTIES':
      return apiError('SEPARATION_OF_DUTIES', { field: 'displayRef' }, 403);
  }
}

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
  /**
   * The write model (§5.1.1, §5.1.4), injected as its own port.
   *
   * Separate from `queries` because that interface is a READ model, and a write hidden inside a read model is how
   * a handler comes to believe reading has no consequence.
   */
  readonly commands: SubjectCommands;
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


/**
 * Refuse a body field the route does not declare (SPEC-003 §10, VG-API-074).
 *
 * MEASURED DEFECT this corrects, found by the black-box suite: a creation body carrying `bypassHumanGate: true` was
 * ACCEPTED and the subject was created, because the handler reads the fields it knows and never looks at the rest.
 * The field had no effect — nothing acted on it — but "the API ignores what it does not understand" is exactly the
 * rule §2.6 refuses to apply to QUERY parameters ("a typo cannot silently widen a result set"), and §10's non-goals
 * name these four fields by hand (`bypassHumanGate`, `force`, `skipVerification`, `overridePolicy`). A caller that
 * sends one must be told it means nothing here, not left to believe it worked.
 *
 * THE BODY IS NOT ECHOED. The refusal names the FIELD and never its value, because a body carries personal data and
 * §8.3 keeps request values out of responses.
 */
function rejectUndeclaredBodyFields(body: Record<string, unknown>, declared: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!declared.includes(key)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: key });
    }
  }
}

export function subjectRoutes(app: FastifyInstance, options: SubjectRouteOptions): void {
  const secret = options.sessionSecret;
  const queries = options.queries;
  const commands = options.commands;

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
    // The reveal gates ran in `beginHandler` (scope + step-up). A caller that satisfied them is REFUSED rather than
    // handed a mask: see `refuseUnsupportedReveal`.
    refuseUnsupportedReveal(request);

    // The `vg.pii.reveal` scope and the step-up for `includeValue=true` are enforced by
    // `beginHandler` from the registry's `conditional` entry, so this handler does not restate them.
    // Keeping the rule in ONE place is what stops a second copy drifting from the contract — and the
    // earlier duplicated version DID drift: the registry demanded the scope unconditionally and
    // refused the masked read that §5.1.6 documents as the default.
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
    // Same rule as §5.1.6: the gates ran, and a reveal that cannot be performed is refused, not masked.
    refuseUnsupportedReveal(request);

    // `includeValue`'s extra scope and step-up are enforced by `beginHandler` from the registry's
    // `conditional` entry; see the §5.1.6 comment above.
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
      // stored encrypted; the schema's `value_enc` is bytea and the key must live outside the database.
      //
      // REFUSED, AND THE REASON IS THE MEASURED BLOCKER rather than "not configured". Three facts, each read from
      // the code rather than assumed: (1) ADR-006's managed KMS is OPEN and `ManagedKmsKeyProvider` raises
      // `KeyProviderBlockedError` on wrap/unwrap/rotate/shred/hmac; (2) the `KeyProvider` PORT cannot encrypt a
      // value at all — it declares `wrap`/`unwrap`/`rotate`/`shred`/`hmac`, and the only `encrypt` in this
      // repository is a method on the concrete `LocalFileKeyProvider` that the port does not expose; (3) that local
      // provider keeps its DEKs in an in-process `Map` and is tests-and-local-only by VG-SCOPE-020, and no code
      // anywhere writes `tenant_key`, so ciphertext written today could not be decrypted after a restart.
      //
      // Writing the caller's value through (3) would therefore create a permanent privacy defect: a stored
      // identifier nobody can ever read, in a column whose whole purpose is lawful retrieval. The honest states are
      // "refused, here is why" and "no row created", and the database suite asserts both.
      throw apiError('DEPENDENCY_UNAVAILABLE', {
        reason:
          'identifier capture requires a durable key provider: ADR-006 (managed KMS) is open, the KeyProvider port exposes no encrypt operation, and no code persists tenant_key',
      });
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

  // 5.1.1 POST /v1/subjects — create the subject and its authority grant in one transaction.
  app.post('/v1/subjects', async (request, reply) => {
    const h = beginHandler(request, reply);
    const body = (request.body ?? {}) as Record<string, unknown>;
    // DECLARED FIELDS ONLY. §5.1.1's request is exactly these four; anything else is a misunderstanding of the
    // contract, and §10 names four of the shapes it must never be.
    rejectUndeclaredBodyFields(body, ['displayRef', 'jurisdiction', 'isMinor', 'authorityGrant']);

    const displayRef = requiredText(body, 'displayRef', 64);
    const jurisdiction = requiredText(body, 'jurisdiction', 6);
    if (!JURISDICTION_SHAPE.test(jurisdiction)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'jurisdiction' });
    }
    const isMinorRaw = body['isMinor'];
    if (isMinorRaw !== undefined && typeof isMinorRaw !== 'boolean') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'isMinor' });
    }
    const grantRaw = body['authorityGrant'];
    if (typeof grantRaw !== 'object' || grantRaw === null || Array.isArray(grantRaw)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'authorityGrant' });
    }
    const grant = grantRaw as Record<string, unknown>;
    const kind = requiredText(grant, 'kind', 32);
    if (!(AUTHORITY_KINDS as readonly string[]).includes(kind)) {
      // §5.1.1 names AUTHORITY_GRANT_INVALID for a grant it cannot accept; an unrecognised kind is that, and
      // reporting it as a schema failure would hide that the caller sent a KIND the contract does not have.
      throw apiError('AUTHORITY_GRANT_INVALID', { field: 'authorityGrant.kind' });
    }
    const scopeRaw = grant['scope'];
    if (!Array.isArray(scopeRaw) || scopeRaw.some((entry) => typeof entry !== 'string')) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'authorityGrant.scope' });
    }
    const evidenceRaw = grant['evidenceArtifactId'];
    if (evidenceRaw !== undefined && evidenceRaw !== null && typeof evidenceRaw !== 'string') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'authorityGrant.evidenceArtifactId' });
    }
    const expiresRaw = grant['expiresAt'];
    let expiresAtMs: number | null = null;
    if (expiresRaw !== undefined) {
      if (typeof expiresRaw !== 'string' || Number.isNaN(Date.parse(expiresRaw))) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'authorityGrant.expiresAt' });
      }
      expiresAtMs = Date.parse(expiresRaw);
    }

    return idempotentWrite(h, async (tx) => {
      const outcome = await commands.createSubject(tx, {
        displayRef,
        jurisdiction,
        isMinor: isMinorRaw === true,
        authority: {
          kind: kind as (typeof AUTHORITY_KINDS)[number],
          scope: scopeRaw as readonly string[],
          evidenceArtifactId: typeof evidenceRaw === 'string' ? evidenceRaw : null,
          expiresAtMs,
        },
        actorIdentity: h.context.actorIdentity,
        actorSubjectRef: h.context.subjectRef,
        authLevel: h.context.authLevel,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) throw createSubjectRefusal(outcome);
      reply.header('location', `/v1/subjects/${outcome.subject.subjectId}`);
      return { status: 201, body: outcome.subject, resourceId: outcome.subject.subjectId };
    });
  });

  // 5.1.4 PATCH /v1/subjects/{subjectId} — mutable fields only, guarded by the row version.
  app.patch('/v1/subjects/:subjectId', async (request, reply) => {
    const h = beginHandler(request, reply);
    const subjectId = uuidParam(request, 'subjectId');
    const expectedRowVersionMs = epochMillisFromIfMatch(ifMatchHeader(request));
    const body = (request.body ?? {}) as Record<string, unknown>;

    // `jurisdiction` IS NOT PATCHABLE HERE, and it is refused rather than ignored: §5.1.4 states that a
    // jurisdiction change invalidates existing PolicyDecision rows (VG-POLICY-002) and must go through §5.1.10
    // plus a fresh decision. Silently dropping the field would leave a caller believing the jurisdiction moved.
    if (body['jurisdiction'] !== undefined) {
      throw apiError('FIELD_NOT_PATCHABLE', { field: 'jurisdiction' });
    }
    // The patch is built as a whole rather than field by field: `SubjectPatch`'s members are readonly, which makes
    // "assign each field as it is parsed" a type error — and the error is the useful kind, because it forces the
    // patch to be one value whose members are known to have been validated together.
    const displayRefPatch = body['displayRef'] === undefined ? undefined : requiredText(body, 'displayRef', 64);
    let isMinorPatch: boolean | undefined;
    if (body['isMinor'] !== undefined) {
      if (typeof body['isMinor'] !== 'boolean') throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'isMinor' });
      isMinorPatch = body['isMinor'];
    }
    let contactPatch: { channel: string; contactRefId: string } | undefined;
    const contactRaw = body['contactPreference'];
    if (contactRaw !== undefined) {
      if (typeof contactRaw !== 'object' || contactRaw === null || Array.isArray(contactRaw)) {
        throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'contactPreference' });
      }
      const contact = contactRaw as Record<string, unknown>;
      contactPatch = {
        channel: requiredText(contact, 'channel', 32),
        contactRefId: requiredText(contact, 'contactRefId', 64),
      };
    }
    const patch: SubjectPatch = {
      ...(displayRefPatch === undefined ? {} : { displayRef: displayRefPatch }),
      ...(isMinorPatch === undefined ? {} : { isMinor: isMinorPatch }),
      ...(contactPatch === undefined ? {} : { contactPreference: contactPatch }),
    };

    return idempotentWrite(h, async (tx) => {
      const outcome = await commands.updateSubject(tx, {
        subjectId,
        expectedRowVersionMs,
        patch,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'NOT_FOUND':
            throw apiError('RESOURCE_NOT_FOUND');
          case 'PRECONDITION_FAILED':
            throw apiError('PRECONDITION_FAILED', {
              currentEtag: `${outcome.authorityState}:${String(outcome.currentRowVersionMs)}`,
            });
          case 'STRICT_LANE_CONFLICT':
            throw apiError('STRICT_LANE_CONFLICT', { field: 'isMinor' });
        }
      }
      return { status: 200, body: outcome.subject, resourceId: subjectId };
    });
  });

  // 5.2.1 POST /v1/subjects/{subjectId}/authority-grants — mint a further grant. Step-up is enforced by
  // `beginHandler` from the registry's `stepUp: true`, before the body is read.
  app.post('/v1/subjects/:subjectId/authority-grants', async (request, reply) => {
    const h = beginHandler(request, reply);
    const subjectId = uuidParam(request, 'subjectId');
    const body = (request.body ?? {}) as Record<string, unknown>;

    const kind = requiredText(body, 'kind', 32);
    if (!(AUTHORITY_KINDS as readonly string[]).includes(kind)) {
      throw apiError('AUTHORITY_KIND_UNSUPPORTED', { field: 'kind' }, 422);
    }
    const scopeRaw = body['scope'];
    if (!Array.isArray(scopeRaw) || scopeRaw.length === 0 || scopeRaw.some((entry) => typeof entry !== 'string')) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'scope' });
    }
    const identityLevel = requiredText(body, 'identityLevel', 8);
    if (!(IDENTITY_LEVELS as readonly string[]).includes(identityLevel)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'identityLevel' });
    }
    const evidenceRaw = body['evidenceArtifactId'];
    if (evidenceRaw !== undefined && evidenceRaw !== null && typeof evidenceRaw !== 'string') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'evidenceArtifactId' });
    }
    const issuedAtMs = optionalInstant(body, 'issuedAt');
    const expiresAtMs = optionalInstant(body, 'expiresAt');

    return idempotentWrite(h, async (tx) => {
      const outcome = await commands.mintAuthorityGrant(tx, {
        subjectId,
        kind: kind as (typeof AUTHORITY_KINDS)[number],
        scope: scopeRaw as readonly string[],
        identityLevel,
        evidenceArtifactId: typeof evidenceRaw === 'string' ? evidenceRaw : null,
        issuedAtMs,
        expiresAtMs,
        actorSubjectRef: h.context.subjectRef,
        authLevel: h.context.authLevel,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) throw mintRefusal(outcome);
      reply.header('location', `/v1/authority-grants/${outcome.grant.authorityGrantId}`);
      return { status: 201, body: outcome.grant, resourceId: outcome.grant.authorityGrantId };
    });
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

  // 5.2.3 POST /v1/authority-grants/{authorityGrantId}/revocations — step-up, and no history rewritten.
  app.post('/v1/authority-grants/:authorityGrantId/revocations', async (request, reply) => {
    const h = beginHandler(request, reply);
    const authorityGrantId = uuidParam(request, 'authorityGrantId');
    const body = (request.body ?? {}) as Record<string, unknown>;

    const reason = requiredText(body, 'reason', 48);
    if (!REVOCATION_REASON_SHAPE.test(reason)) {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'reason' });
    }
    const evidenceRaw = body['evidenceArtifactId'];
    if (evidenceRaw !== undefined && evidenceRaw !== null && typeof evidenceRaw !== 'string') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'evidenceArtifactId' });
    }
    const noteRaw = body['note'];
    if (noteRaw !== undefined && typeof noteRaw !== 'string') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'note' });
    }

    return idempotentWrite(h, async (tx) => {
      const outcome = await commands.revokeAuthorityGrant(tx, {
        authorityGrantId,
        reason,
        evidenceArtifactId: typeof evidenceRaw === 'string' ? evidenceRaw : null,
        // The note is NOT persisted: `authority_grant` has no note column, and §5.2.3's response does not return
        // it. It is accepted, shape-checked, and deliberately not carried into the audit payload — a free-text note
        // is the one field in this request that could contain personal data, and SPEC-003 §8.3 forbids that in an
        // audit payload. Recorded in ASSUMPTIONS §3.36.
        note: typeof noteRaw === 'string' ? noteRaw : null,
        correlationId: h.context.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'NOT_FOUND':
            throw apiError('RESOURCE_NOT_FOUND');
          case 'AUTHORITY_ALREADY_REVOKED':
            throw apiError('AUTHORITY_ALREADY_REVOKED', { reason: outcome.revokedAt }, 409);
          case 'EVIDENCE_NOT_FOUND':
            throw apiError('EVIDENCE_NOT_FOUND', { field: 'evidenceArtifactId' }, 422);
        }
      }
      return { status: 201, body: outcome.grant, resourceId: authorityGrantId };
    });
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
