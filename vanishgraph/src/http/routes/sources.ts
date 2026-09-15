/**
 * Sources, catalogue entries, and removal recipes (SPEC-003 §5.3).
 *
 * 10 of the 78 routes. Every handler follows the same four steps and nothing else:
 *
 *   1. `beginHandler` — resolves the registry entry, requires the route's scopes, enforces its
 *      step-up, and hands over the tenant-scoped transaction helper.
 *   2. `parseQuery` (collections) or explicit body validation — strict; an unknown member or a token
 *      outside a closed vocabulary is refused, never ignored.
 *   3. ONE port call.
 *   4. map to the DTO and return.
 *
 * NO HANDLER CONTAINS A TRUTH STATE. A `Source` and a `RemovalRecipe` have no truth state: they are
 * catalogue and permission data. `writesEnabled` is a DERIVED report computed by the port from three
 * conditions, never a stored flag and never an input. The eleven canonical states belong to exposures
 * and cases, and `scripts/scan-truth-state-input.ts` in `gate-api` plus this node's handler scan
 * assert that this file never grows one.
 *
 * WHY THE GUARD EVALUATION IS NOT IN THIS FILE. §5.3.10 must report four guards and act on them, and
 * the four read the recipe, the source and the configured signing key. Evaluating them here would put
 * the reads in one transaction (`withTenant`) and the write in another, so a permission downgrade
 * landing between them would enable a recipe that no longer qualifies — while the response said the
 * guards passed. The port does both in one transaction; this file only maps the result.
 *
 * WHY THE VALIDATION IS IN THIS FILE RATHER THAN LEFT TO POSTGRESQL. `permission_class` is a database
 * enum and `channel` is checked by a domain rule, so an unknown token would arrive as `22P02 invalid
 * input value for enum` — which the error handler can only map to a generic failure. Refusing at the
 * boundary is what makes `RECIPE_CHANNEL_UNKNOWN` and `SCHEMA_VALIDATION_FAILED` reachable, and it
 * makes those refusals testable without a database.
 */

import type { FastifyInstance } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';
import { withIdempotency } from '../plugins/idempotency.ts';
import { beginHandler, uuidParam, type HandlerContext } from './handler-context.ts';
import type { TenantTransaction } from '../plugins/tenancy.ts';
import { parseQuery } from '../query/strict.ts';
import { RECIPES_QUERY, SOURCES_QUERY } from '../query/filters.ts';
import { buildCollection } from '../dto/page.ts';
import { encodeCursor, decodeCursor, filterHashOf } from '../pagination/cursor.ts';
import { CHANNEL_NAMES, PERMISSION_CLASSES, isPermissionClass } from '../../application/contracts/index.ts';
import type {
  RecipeRow,
  SourceDetail,
  SourceListRow,
  SourceQueries,
  RecipeVerificationKeys,
} from '../../application/contracts/source-queries.ts';

export interface SourceRouteOptions {
  /** The cursor signing secret (SPEC-003 §2.5). From configuration, never a constant. */
  readonly sessionSecret: string;
  /**
   * The read/write model, injected as a PORT.
   *
   * The boundary must not import `src/adapters/persistence/**` (ARCHITECTURE.md §2, enforced by
   * `scripts/import-boundary.sh`): reaching into the PostgreSQL adapter here would weld the boundary
   * to one storage technology.
   */
  readonly queries: SourceQueries;
  /**
   * The trusted recipe signing keys, by `signingKeyRef` (SPEC-003 §5.3.7, VG-CHANNEL-003).
   *
   * An EMPTY map is a legitimate configuration: every recipe submission is then refused with
   * `503 DEPENDENCY_UNAVAILABLE` naming the unconfigured reference, because a recipe the system cannot
   * verify must not be stored. That is the fail-closed direction, and it is the current state of this
   * deployment: ADR-006 (KMS selection) is OPEN, so no production key exists (ASSUMPTIONS §3.8).
   */
  readonly verificationKeys: RecipeVerificationKeys;
}

/**
 * The wire form of a source row.
 *
 * `rowVersion` is REMOVED, not merely redundant. It is the port's internal concurrency counter and it
 * reaches the caller through the `ETag` header, which is where SPEC-003 §2.7 puts it. Serialising it
 * into the body as well would create a second, unversioned way for a client to satisfy `If-Match` —
 * and a client reading a body field would keep working after the ETag format changed, so the two
 * would drift silently.
 */
function toSourceDto(row: SourceListRow): Omit<SourceListRow, 'rowVersion'> {
  return {
    sourceId: row.sourceId,
    name: row.name,
    class: row.class,
    jurisdiction: row.jurisdiction,
    permissionClass: row.permissionClass,
    freshnessAt: row.freshnessAt,
    freshnessState: row.freshnessState,
    writesEnabled: row.writesEnabled,
    controllerId: row.controllerId,
  };
}

/** The wire form of a source detail: the list DTO plus permission evidence and recipe readiness. */
function toSourceDetailDto(row: SourceDetail): Omit<SourceDetail, 'rowVersion'> {
  return {
    ...toSourceDto(row),
    permissionEvidenceUrl: row.permissionEvidenceUrl,
    permissionWindowSeconds: row.permissionWindowSeconds,
    createdAt: row.createdAt,
    recipeReadiness: row.recipeReadiness,
  };
}

/** The wire form of a recipe row; `rowVersion` reaches the caller through the `ETag` header only. */
function toRecipeDto(row: RecipeRow): Omit<RecipeRow, 'rowVersion'> {
  return {
    recipeId: row.recipeId,
    sourceId: row.sourceId,
    version: row.version,
    channel: row.channel,
    verificationMethod: row.verificationMethod,
    signatureVerified: row.signatureVerified,
    enabled: row.enabled,
    freshnessAt: row.freshnessAt,
    staleness: row.staleness,
    disabledReason: row.disabledReason,
    enabledAt: row.enabledAt,
    createdAt: row.createdAt,
    maxAttemptsPerWindow: row.maxAttemptsPerWindow,
    windowSeconds: row.windowSeconds,
    signingKeyRef: row.signingKeyRef,
  };
}

const SOURCE_ROUTE = '/v1/sources';

/** §5.3.1's `class` is a free token in the contract, so it is bounded but not enumerated. */
const MAX_TOKENS = { name: 200, class: 64, jurisdiction: 16, category: 120, notes: 4000, provenance: 200, license: 120, method: 120, keyRef: 200, reason: 120 } as const;

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

function optionalToken(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return token(value, field, max);
}

/** An RFC 3339 instant, refused unless it parses. The string is normalised to UTC ISO form. */
function instant(value: unknown, field: string): string {
  if (typeof value !== 'string') throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  return parsed.toISOString();
}

function optionalInstant(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return instant(value, field);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return positiveInteger(value, field);
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
 * The optimistic-concurrency token for a source row (SPEC-003 §2.7).
 *
 * The SHAPE is §2.7's — `"<state>:<counter>"`, quoted — but the state component is the permission
 * class rather than a truth state, because a source has no truth state (SPEC-000 §5 gives the eleven
 * states to exposures and cases). `rowVersion` is a monotonic column incremented on every mutation, so
 * the token changes even when the permission class does not: `"<class>:<updatedAt>"` would return the
 * same token for "WRITE_PERMITTED checked again", and a caller's stale precondition would then pass.
 */
function sourceEtag(row: SourceListRow): string {
  return `"${row.permissionClass}:${String(row.rowVersion)}"`;
}

/** The recipe equivalent: enablement state plus the row's own monotonic version. */
function recipeEtag(row: RecipeRow): string {
  return `"${row.enabled ? 'ENABLED' : 'DISABLED'}:${String(row.rowVersion)}"`;
}

/**
 * Read the row version out of an `If-Match` header.
 *
 * `*` IS REFUSED, deliberately. RFC 9110 gives it the meaning "any current representation", and §2.7
 * makes the header a PER-RESOURCE optimistic concurrency control. Accepting `*` would let a caller
 * skip the precondition entirely on exactly the two routes where it protects a permission downgrade
 * and a recipe enablement — the operations whose harm is a write against a source that may not be
 * written to. A malformed value is therefore `412 PRECONDITION_FAILED`, not a silent accept.
 */
function rowVersionFromIfMatch(header: string | undefined): number {
  if (header === undefined) throw apiError('PRECONDITION_REQUIRED');
  const match = /^"?[A-Z_]*:(\d{1,9})"?$/.exec(header.trim());
  const version = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(version)) {
    // The current ETag is not known here — the header was unparseable, not merely stale — so the body
    // names the failure instead of echoing a token. §2.7 requires the current ETag on a STALE value,
    // which the port produces below.
    throw apiError('PRECONDITION_FAILED');
  }
  return version;
}

/** §5.1.2's filter shape, mapped onto the port's. Unknown members cannot appear: `parseQuery` refused them. */function sourceFilters(filter: Readonly<Record<string, unknown>>): {
  class?: string;
  jurisdiction?: string;
  permissionClass?: string | readonly string[];
} {
  const out: {
    class?: string;
    jurisdiction?: string;
    permissionClass?: string | readonly string[];
  } = {};
  if (typeof filter['class'] === 'string') out.class = filter['class'];
  if (typeof filter['jurisdiction'] === 'string') out.jurisdiction = filter['jurisdiction'];
  const permission = filter['permissionClass'];
  if (typeof permission === 'string' || Array.isArray(permission)) {
    out.permissionClass = permission as string | readonly string[];
  }
  return out;
}

/**
 * Run a §5.3 write under idempotency control.
 *
 * The port call happens INSIDE `withIdempotency`'s `work`, so it only runs when the key was newly
 * claimed. A replayed request therefore performs no second write: it returns the stored response and a
 * `Idempotency-Replayed` header (SPEC-003 §4.3).
 */
async function idempotent<R>(
  h: HandlerContext,
  work: (tx: TenantTransaction) => Promise<{ status: number; body: unknown; resourceId?: string | null }>,
): Promise<R> {
  return withIdempotency<R>(h.request, h.request.server.vgIdempotency, h.reply, () => h.withTenant(work)) as Promise<R>;
}

/** Whether a declaration of this permission class must carry official-permission evidence (§5.3.2). */
function requiresEvidence(permissionClass: string): boolean {
  // Only the class that AUTHORISES automated writes requires evidence. Requiring it for READ_ONLY or
  // PROHIBITED would demand paperwork for declaring a source we will never write to, and a required
  // field that nobody can satisfy honestly is a field callers fill with a token that means nothing.
  return permissionClass === 'WRITE_PERMITTED';
}

export function sourceRoutes(app: FastifyInstance, options: SourceRouteOptions): void {
  const secret = options.sessionSecret;
  const queries = options.queries;
  const keys = options.verificationKeys;

  /** Read a source detail or refuse with §5.3.3's 404. */
  async function detailOr404(tx: TenantTransaction, sourceId: string) {
    const detail = await queries.getSourceDetail(tx, sourceId);
    // Absent and another tenant's source reach this same branch by construction (SPEC-006 H-9).
    if (detail === undefined) throw apiError('RESOURCE_NOT_FOUND');
    return detail;
  }

  // ---------------------------------------------------------------------------------------------
  // 5.3.1 GET /v1/sources — the declared catalogue, keyset-paginated.
  // ---------------------------------------------------------------------------------------------
  app.get(SOURCE_ROUTE, async (request, reply) => {
    const h = beginHandler(request, reply);
    const parsed = parseQuery(request.query as Record<string, unknown>, SOURCES_QUERY);
    const filterHash = filterHashOf(parsed.filter);
    const sortField = parsed.sort.split(':')[0] ?? 'name';

    const after =
      parsed.cursor === undefined
        ? undefined
        : (() => {
            const decoded = decodeCursor(parsed.cursor, secret, {
              tenantId: h.context.tenantId.value,
              routeTemplate: SOURCE_ROUTE,
              filterHash,
              sort: parsed.sort,
            });
            return {
              sortValue: typeof decoded.keyset.sortValue === 'string' ? decoded.keyset.sortValue : '',
              id: decoded.keyset.id,
            };
          })();

    return h.withTenant(async (tx) => {
      const rows = await queries.listSources(tx, {
        limit: parsed.limit,
        sort: parsed.sort,
        filters: sourceFilters(parsed.filter),
        ...(after === undefined ? {} : { after }),
      });

      // The builder runs over the PORT rows, so the lookahead row it removes and the cursor it mints
      // both come from the rows the database actually returned. The wire DTO is produced afterwards by
      // mapping `data`: mapping first would have hidden `rowVersion` from the cursor minter, and the
      // cursor needs the port's fields.
      const collection = buildCollection(
        rows,
        { limit: parsed.limit, sort: parsed.sort, filter: parsed.filter },
        // The keyset value must be the value of the SORTED column, not always `name`: a continuation
        // minted from the wrong column asks the next page to start after a value in a different
        // ordering, which silently repeats or skips rows.
        (last: SourceListRow) =>
          encodeCursor(
            {
              tenantId: h.context.tenantId.value,
              routeTemplate: SOURCE_ROUTE,
              filterHash,
              sort: parsed.sort,
              // A NULL `freshnessAt` sorts below every instant (the adapter's COALESCE), so the cursor
              // carries the epoch rather than an empty string — an empty string is not a timestamp and
              // would be refused by the next request's own parser.
              keyset: {
                sortValue: sortField === 'freshnessAt' ? (last.freshnessAt ?? '1970-01-01T00:00:00.000Z') : last.name,
                id: last.sourceId,
              },
              issuedAt: Math.floor(Date.now() / 1000),
            },
            secret,
          ),
      );
      return reply.code(200).send({ data: collection.data.map(toSourceDto), page: collection.page });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.3.2 POST /v1/sources — declare a source. Idempotency REQUIRED.
  // ---------------------------------------------------------------------------------------------
  app.post(SOURCE_ROUTE, async (request, reply) => {
    const h = beginHandler(request, reply);
    const body = request.body as Record<string, unknown>;

    const name = token(body['name'], 'name', MAX_TOKENS.name);
    const sourceClass = token(body['class'], 'class', MAX_TOKENS.class);
    const jurisdiction = optionalToken(body['jurisdiction'], 'jurisdiction', MAX_TOKENS.jurisdiction);
    const controllerId = optionalUuid(body['controllerId'], 'controllerId');
    const permissionClass = isPermissionClass(body['permissionClass'])
      ? body['permissionClass']
      : (() => {
          throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'permissionClass' });
        })();
    const permissionEvidenceUrl = optionalToken(body['permissionEvidenceUrl'], 'permissionEvidenceUrl', 2000);
    const permissionCheckedAt = optionalInstant(body['permissionCheckedAt'], 'permissionCheckedAt');
    const permissionWindowSeconds = optionalPositiveInteger(body['permissionWindowSeconds'], 'permissionWindowSeconds');

    // VG-CHANNEL-002: a WRITE_PERMITTED declaration is a data assertion about an official permission
    // record, and it is only checkable at execution time if the evidence and its check instant were
    // recorded. §5.3.2's `422 PERMISSION_EVIDENCE_REQUIRED` is that rule.
    if (requiresEvidence(permissionClass) && (permissionEvidenceUrl === null || permissionCheckedAt === null)) {
      throw apiError('PERMISSION_EVIDENCE_REQUIRED', { field: 'permissionEvidenceUrl' });
    }

    return idempotent(h, async (tx) => {
      const created = await queries.declareSource(tx, {
        name,
        class: sourceClass,
        jurisdiction,
        controllerId,
        permissionClass,
        permissionEvidenceUrl,
        permissionCheckedAt,
        permissionWindowSeconds,
      });
      if (!created.ok) {
        throw created.reason === 'ALREADY_DECLARED'
          ? apiError('SOURCE_ALREADY_DECLARED', { field: 'name' })
          : apiError('CONTROLLER_NOT_FOUND', { field: 'controllerId' });
      }

      const detail = await detailOr404(tx, created.value.sourceId);
      reply.header('location', `${SOURCE_ROUTE}/${created.value.sourceId}`);
      reply.header('etag', sourceEtag(detail));
      return {
        status: 201,
        body: { ...toSourceDetailDto(detail), declaredAt: created.value.createdAt },
        resourceId: created.value.sourceId,
      };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.3.3 GET /v1/sources/{sourceId} — detail incl. permission and recipe readiness.
  // ---------------------------------------------------------------------------------------------
  app.get(`${SOURCE_ROUTE}/:sourceId`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const sourceId = uuidParam(request, 'sourceId');

    return h.withTenant(async (tx) => {
      const detail = await detailOr404(tx, sourceId);
      reply.header('etag', sourceEtag(detail));
      return reply.code(200).send(toSourceDetailDto(detail));
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.3.4 PATCH /v1/sources/{sourceId}/permission-class — step-up, If-Match, idempotency REQUIRED.
  // ---------------------------------------------------------------------------------------------
  app.patch(`${SOURCE_ROUTE}/:sourceId/permission-class`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const sourceId = uuidParam(request, 'sourceId');
    // 428 before 412: a MISSING token and a STALE token are different failures and the contract
    // assigns them different codes (SPEC-003 §8.2).
    const expectedRowVersion = rowVersionFromIfMatch(
      Array.isArray(request.headers['if-match']) ? request.headers['if-match'][0] : request.headers['if-match'],
    );

    const body = request.body as Record<string, unknown>;
    const permissionClass = isPermissionClass(body['permissionClass'])
      ? body['permissionClass']
      : (() => {
          throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'permissionClass' });
        })();
    const permissionEvidenceUrl = optionalToken(body['permissionEvidenceUrl'], 'permissionEvidenceUrl', 2000);
    const permissionCheckedAt = optionalInstant(body['permissionCheckedAt'], 'permissionCheckedAt');
    const reason = token(body['reason'], 'reason', MAX_TOKENS.reason);

    // "Raising it to WRITE_PERMITTED requires evidence" (§5.3.4). LOWERING a class never does: a
    // caller tightening their own permission must not be blocked by paperwork.
    if (requiresEvidence(permissionClass) && (permissionEvidenceUrl === null || permissionCheckedAt === null)) {
      throw apiError('PERMISSION_EVIDENCE_REQUIRED', { field: 'permissionEvidenceUrl' });
    }

    return idempotent(h, async (tx) => {
      const result = await queries.setPermissionClass(tx, sourceId, {
        permissionClass,
        permissionEvidenceUrl,
        permissionCheckedAt,
        reason,
        expectedRowVersion,
      });
      if (!result.ok) {
        if (result.reason === 'NOT_FOUND') throw apiError('RESOURCE_NOT_FOUND');
        // §2.7 requires the CURRENT ETag in the body of a 412. The port reports only that the version
        // differed, so the current row is re-read to produce the token the loser must retry against.
        const current = await queries.getSourceDetail(tx, sourceId);
        if (current === undefined) throw apiError('RESOURCE_NOT_FOUND');
        reply.header('etag', sourceEtag(current));
        throw apiError('PRECONDITION_FAILED', { currentEtag: sourceEtag(current) });
      }

      reply.header('etag', sourceEtag(result.value.source));
      return {
        status: 200,
        // §5.3.4: the source DTO PLUS the ids of the recipes the change disabled. Naming them is the
        // contract's "disabling is never silent" — an empty array is a positive statement that nothing
        // was disabled, which is different from an omitted field.
        body: { ...toSourceDto(result.value.source), autoDisabledRecipeIds: [...result.value.autoDisabledRecipeIds] },
        resourceId: sourceId,
      };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.3.5 GET /v1/sources/{sourceId}/catalog-entries
  // ---------------------------------------------------------------------------------------------
  app.get(`${SOURCE_ROUTE}/:sourceId/catalog-entries`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const sourceId = uuidParam(request, 'sourceId');

    return h.withTenant(async (tx) => {
      if (!(await queries.sourceExists(tx, sourceId))) throw apiError('RESOURCE_NOT_FOUND');
      const rows = await queries.listCatalogEntries(tx, sourceId);
      return reply.code(200).send({ data: rows });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.3.6 POST /v1/sources/{sourceId}/catalog-entries — idempotency REQUIRED.
  // ---------------------------------------------------------------------------------------------
  app.post(`${SOURCE_ROUTE}/:sourceId/catalog-entries`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const sourceId = uuidParam(request, 'sourceId');
    const body = request.body as Record<string, unknown>;

    const category = token(body['category'], 'category', MAX_TOKENS.category);
    // VG-DISC-002: "a catalogue entry that cannot state what it does and does not cover" is refused.
    // The check is on the TRIMMED length so a body of spaces is refused rather than stored as a note
    // that exists and says nothing.
    const coverageNotesRaw = body['coverageNotes'];
    if (typeof coverageNotesRaw !== 'string' || coverageNotesRaw.trim().length === 0) {
      throw apiError('CATALOG_NOTES_REQUIRED', { field: 'coverageNotes' });
    }
    const coverageNotes = token(coverageNotesRaw, 'coverageNotes', MAX_TOKENS.notes);
    const provenance = token(body['provenance'], 'provenance', MAX_TOKENS.provenance);
    // LICENSE_POLICY: a catalogue entry without a recorded licence is incomplete.
    const licenseRaw = body['license'];
    if (typeof licenseRaw !== 'string' || licenseRaw.trim().length === 0) {
      throw apiError('LICENSE_UNRECORDED', { field: 'license' });
    }
    const license = token(licenseRaw, 'license', MAX_TOKENS.license);

    return idempotent(h, async (tx) => {
      const created = await queries.appendCatalogEntry(tx, sourceId, {
        category,
        coverageNotes,
        provenance,
        license,
      });
      if (!created.ok) {
        throw created.reason === 'DUPLICATE'
          ? apiError('CATALOG_ENTRY_DUPLICATE', { field: 'category', sourceId })
          : apiError('RESOURCE_NOT_FOUND');
      }
      return {
        status: 201,
        body: {
          catalogEntryId: created.value.catalogEntryId,
          sourceId,
          category,
          coverageNotes,
          provenance,
          license,
          declaredAt: created.value.declaredAt,
        },
        resourceId: created.value.catalogEntryId,
      };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.3.7 POST /v1/sources/{sourceId}/recipes — new version, verified, created DISABLED.
  // ---------------------------------------------------------------------------------------------
  app.post(`${SOURCE_ROUTE}/:sourceId/recipes`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const sourceId = uuidParam(request, 'sourceId');
    const body = request.body as Record<string, unknown>;

    // The channel vocabulary is the domain's, read from its single definition rather than restated:
    // a second list here is how the API comes to accept a channel the priority table does not rank.
    const channelRaw = body['channel'];
    if (typeof channelRaw !== 'string' || !(CHANNEL_NAMES as readonly string[]).includes(channelRaw)) {
      throw apiError('RECIPE_CHANNEL_UNKNOWN', { field: 'channel' });
    }
    const channel: string = channelRaw;
    // §5.3.7 requires a declared verification method: a recipe whose effect cannot be independently
    // observed is not a removal recipe, it is an assertion (VG-VERIFY-003). The refusal uses the code
    // §5.3.7 names for it rather than the generic schema failure — `RECIPE_VERIFICATION_METHOD_REQUIRED`
    // is the token an integrator can act on, and `SCHEMA_VALIDATION_FAILED` would tell them their JSON
    // was malformed when in fact a required member was absent.
    const methodRaw = body['verificationMethod'];
    if (typeof methodRaw !== 'string' || methodRaw.trim().length === 0) {
      throw apiError('RECIPE_VERIFICATION_METHOD_REQUIRED', { field: 'verificationMethod' });
    }
    const verificationMethod = token(methodRaw, 'verificationMethod', MAX_TOKENS.method);
    const signingKeyRef = token(body['signingKeyRef'], 'signingKeyRef', MAX_TOKENS.keyRef);
    const signatureRaw = body['signature'];
    if (typeof signatureRaw !== 'string' || signatureRaw.length === 0) {
      throw apiError('RECIPE_SIGNATURE_INVALID', { field: 'signature' });
    }
    const signature: string = signatureRaw;
    const freshnessAt = instant(body['freshnessAt'], 'freshnessAt');
    const maxAttemptsPerWindow = positiveInteger(body['maxAttemptsPerWindow'], 'maxAttemptsPerWindow');
    const windowSeconds = positiveInteger(body['windowSeconds'], 'windowSeconds');

    return idempotent(h, async (tx) => {
      const created = await queries.createRecipe(
        tx,
        sourceId,
        { channel, verificationMethod, signature, signingKeyRef, freshnessAt, maxAttemptsPerWindow, windowSeconds },
        keys,
      );
      if (!created.ok) {
        if (created.reason === 'SIGNING_KEY_UNCONFIGURED') {
          // NOT a signature failure. No key is configured for this reference, so the signature cannot
          // be checked at all — a deployment condition, not a bad submission. Reporting it as
          // RECIPE_SIGNATURE_INVALID would send an integrator hunting a bug in their signing code.
          throw apiError('DEPENDENCY_UNAVAILABLE', { reason: 'recipe signing key is not configured', ruleRef: signingKeyRef });
        }
        if (created.reason === 'SIGNATURE_UNVERIFIABLE') {
          throw apiError('RECIPE_SIGNATURE_INVALID', { field: 'signature' });
        }
        if (created.reason === 'VERSION_CONFLICT') {
          throw apiError('RECIPE_VERSION_CONFLICT', { sourceId });
        }
        throw apiError('RESOURCE_NOT_FOUND');
      }
      return {
        status: 201,
        body: {
          recipeId: created.value.recipeId,
          sourceId,
          version: created.value.version,
          channel,
          verificationMethod,
          signatureVerified: true,
          // §5.3.7: a new version is created disabled, and enabling is the separate guarded call.
          enabled: false,
          freshnessAt,
          createdAt: created.value.createdAt,
        },
        resourceId: created.value.recipeId,
      };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.3.8 GET /v1/sources/{sourceId}/recipes — every version, never deleted.
  // ---------------------------------------------------------------------------------------------
  app.get(`${SOURCE_ROUTE}/:sourceId/recipes`, async (request, reply) => {
    const h = beginHandler(request, reply);
    const sourceId = uuidParam(request, 'sourceId');
    const parsed = parseQuery(request.query as Record<string, unknown>, RECIPES_QUERY);

    return h.withTenant(async (tx) => {
      if (!(await queries.sourceExists(tx, sourceId))) throw apiError('RESOURCE_NOT_FOUND');
      const filters: { enabled?: boolean; fresh?: boolean } = {};
      if (typeof parsed.filter['enabled'] === 'boolean') filters.enabled = parsed.filter['enabled'];
      if (typeof parsed.filter['fresh'] === 'boolean') filters.fresh = parsed.filter['fresh'];

      const rows = (await queries.listRecipes(tx, sourceId, { sort: parsed.sort, filters })).map(toRecipeDto);
      // Superseded versions remain readable so a historical action stays explainable (VG-REAPPEAR-002),
      // which is also why this route is deliberately NOT paginated: every version is returned.
      return reply.code(200).send({ data: rows });
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.3.9 GET /v1/recipes/{recipeId} — recipe detail, with an ETag.
  // ---------------------------------------------------------------------------------------------
  app.get('/v1/recipes/:recipeId', async (request, reply) => {
    const h = beginHandler(request, reply);
    const recipeId = uuidParam(request, 'recipeId');

    return h.withTenant(async (tx) => {
      const recipe = await queries.getRecipe(tx, recipeId);
      if (recipe === undefined) throw apiError('RESOURCE_NOT_FOUND');
      reply.header('etag', recipeEtag(recipe));
      return reply.code(200).send(toRecipeDto(recipe));
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5.3.10 POST /v1/recipes/{recipeId}/enablement — every guard, or a named refusal.
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/recipes/:recipeId/enablement', async (request, reply) => {
    const h = beginHandler(request, reply);
    const recipeId = uuidParam(request, 'recipeId');
    const expectedRowVersion = rowVersionFromIfMatch(
      Array.isArray(request.headers['if-match']) ? request.headers['if-match'][0] : request.headers['if-match'],
    );

    const body = request.body as Record<string, unknown>;
    if (typeof body['enabled'] !== 'boolean') {
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'enabled' });
    }
    const enabled: boolean = body['enabled'];
    const reason = token(body['reason'], 'reason', MAX_TOKENS.reason);

    return idempotent(h, async (tx) => {
      const result = await queries.setRecipeEnablement(tx, recipeId, { enabled, reason, expectedRowVersion }, keys);
      if (!result.ok) {
        if (result.reason === 'NOT_FOUND') throw apiError('RESOURCE_NOT_FOUND');
        if (result.reason === 'PRECONDITION_FAILED') {
          const current = await queries.getRecipe(tx, recipeId);
          if (current === undefined) throw apiError('RESOURCE_NOT_FOUND');
          reply.header('etag', recipeEtag(current));
          throw apiError('PRECONDITION_FAILED', { currentEtag: recipeEtag(current) });
        }
        // §5.3.10: "a `false` anywhere is `409 RECIPE_GUARD_FAILED` with the failing guard named". The
        // name comes from the port's own evaluation, taken in the transaction that refused — not from a
        // re-read, which could name a guard that is no longer the one that failed. No ETag is set: a
        // guard refusal leaves the row untouched, so there is no new representation to advertise.
        throw apiError('RECIPE_GUARD_FAILED', {
          recipeId,
          guard: result.failingGuard,
          // Every entry is a §5.3.10 guard token with the boolean the port measured. No entry is prose
          // and none carries a request value; `permissionClass` is one of the four enum tokens.
          checks: [
            `signatureVerified=${String(result.evaluation.signatureVerified)}`,
            `fresh=${String(result.evaluation.fresh)}`,
            `permissionClass=${result.evaluation.permissionClass}`,
            `permissionFresh=${String(result.evaluation.permissionFresh)}`,
          ],
        });
      }

      // The ETag is read back rather than computed from `expectedRowVersion + 1`: the port's increment
      // is its own business, and a token derived from an assumption about it would drift the moment the
      // update changes shape.
      const after = await queries.getRecipe(tx, recipeId);
      if (after !== undefined) reply.header('etag', recipeEtag(after));
      return { status: 200, body: result.enablement, resourceId: recipeId };
    });
  });
}

/**
 * The four §5.3.10 guard names, in the specification's order.
 *
 * Exported so a test can assert the refusal's `checks` list covers exactly these, rather than the
 * route's literal strings drifting from the contract terms.
 */
export const RECIPE_GUARD_NAMES: readonly (
  | 'signatureVerified'
  | 'fresh'
  | 'permissionClass'
  | 'permissionFresh'
)[] = ['signatureVerified', 'fresh', 'permissionClass', 'permissionFresh'];

/** Exported for the route-catalogue test, so it can assert this module covers its declared routes. */
export const SOURCE_ROUTE_TEMPLATES: readonly string[] = [
  '/v1/sources',
  '/v1/sources/:sourceId',
  '/v1/sources/:sourceId/permission-class',
  '/v1/sources/:sourceId/catalog-entries',
  '/v1/sources/:sourceId/recipes',
  '/v1/recipes/:recipeId',
  '/v1/recipes/:recipeId/enablement',
];

/**
 * The permission classes this module accepts, re-exported so a test can assert the route's vocabulary
 * matches the domain's without importing the domain.
 */
export const ACCEPTED_PERMISSION_CLASSES: readonly string[] = PERMISSION_CLASSES;
