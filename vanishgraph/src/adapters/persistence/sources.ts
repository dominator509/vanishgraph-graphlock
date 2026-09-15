/**
 * The PostgreSQL source/recipe model (SPEC-003 §5.3).
 *
 * Implements `SourceQueries` from the application layer. The DTO TYPES come from the port, so a
 * handler that imports them never acquires a dependency on this file — which is what keeps
 * `src/http/**` free of adapter imports (ARCHITECTURE.md §2).
 *
 * TENANT SCOPING IS NOT DONE HERE. Every statement relies on RLS: the runner has already set
 * `app.tenant_id` and these tables carry FORCE RLS. No predicate below names `tenant_id` except the
 * one `INSERT` that must SUPPLY it, so if RLS were absent these tests would FAIL rather than pass
 * quietly. A `WHERE tenant_id = …` would be a second control that MASKS a broken policy, the opposite
 * of the defence in depth VG-TENANT-002 asks for. The one exception is deliberate and commented where
 * it appears: `declareSource` writes `current_setting('app.tenant_id', true)::uuid`, because the
 * policy's WITH CHECK is what then verifies it.
 *
 * EVERY GUARD IS EVALUATED IN THE TRANSACTION THAT ACTS ON IT. §5.3.10's enablement reads the recipe,
 * the source and the configured key under a row lock and writes in the same transaction, because a
 * permission downgrade landing between a check and a write would enable a recipe that no longer
 * qualifies — and the response would have said the guards passed.
 *
 * THE SIGNATURE IS VERIFIED BEFORE THE ROW EXISTS. §5.3.7 and VG-CHANNEL-003 refuse to store a recipe
 * the system cannot verify. `createRecipe` verifies first and inserts second; there is no path that
 * writes an unverified signature, and the stored `signature` bytes are therefore only ever reachable
 * through the verifying path. That is what makes §5.3.8's `signatureVerified` a reportable fact rather
 * than an assumption.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import type {
  CreateRecipeInput,
  DeclareSourceInput,
  EnablementOutcome,
  FreshnessState,
  GuardName,
  ListSourcesParams,
  Ported,
  RecipeFilters,
  RecipeGuardEvaluation,
  RecipeRow,
  RecipeVerificationKeys,
  SourceCatalogEntryRow,
  SourceDetail,
  SourceListRow,
  SourceQueries,
  Staleness,
} from '../../application/contracts/source-queries.ts';

/**
 * Whether the source's recorded permission is still inside its declared window.
 *
 * FAIL-CLOSED BY CONSTRUCTION: a NULL `permission_checked_at` (never checked) or a NULL
 * `permission_window_seconds` (no window declared) yields `STALE`, never `CURRENT`. SPEC-006 §5.3
 * row 7 defines staleness as "beyond its source-declared freshness window, **or freshness cannot be
 * established**" — the second clause is this CASE's ELSE branch. The opposite default would report
 * `CURRENT` for a source nobody has ever checked, which is the state that permits a write.
 */
const FRESHNESS_STATE_SQL = `
  CASE
    WHEN s.permission_checked_at IS NOT NULL
     AND s.permission_window_seconds IS NOT NULL
     AND s.permission_checked_at + make_interval(secs => s.permission_window_seconds) >= now()
    THEN 'CURRENT'
    ELSE 'STALE'
  END
`;

/**
 * §5.3.1's derived `writesEnabled`, and VG-API-027's acceptance criterion.
 *
 * All three conjuncts are required, and the recipe conjunct requires signed AND fresh AND enabled.
 * `WRITE_UNCLEAR` therefore cannot produce `true` even with a perfect recipe, with no override
 * (ADR-003) — the first conjunct is an equality, not a permission check that something could grant.
 *
 * The signature conjunct is `signature IS NOT NULL AND octet_length(signature) > 0`: the column is
 * NOT NULL in the schema, so the test is about which WRITE PATH produced the row. `createRecipe`
 * verifies before inserting, so a non-empty signature is only reachable through verification.
 */
const WRITES_ENABLED_SQL = `
  (
    s.permission_class = 'WRITE_PERMITTED'
    AND (${FRESHNESS_STATE_SQL}) = 'CURRENT'
    AND EXISTS (
      SELECT 1 FROM removal_recipe r
       WHERE r.source_id = s.id
         AND r.enabled
         AND r.freshness_at >= now()
         AND r.signature IS NOT NULL
         AND octet_length(r.signature) > 0
    )
  )
`;

/** The projection the source list, the source detail and both §5.3.4 responses share. */
const SOURCE_PROJECTION = `
  s.id::text             AS source_id,
  s.name                 AS name,
  s.class                AS class,
  s.jurisdiction         AS jurisdiction,
  s.permission_class::text AS permission_class,
  s.permission_checked_at AS permission_checked_at,
  ${FRESHNESS_STATE_SQL}  AS freshness_state,
  ${WRITES_ENABLED_SQL}   AS writes_enabled,
  s.controller_id::text   AS controller_id,
  s.row_version           AS row_version
`;

interface RawSourceRow {
  source_id: string;
  name: string;
  class: string;
  jurisdiction: string | null;
  permission_class: string;
  permission_checked_at: Date | null;
  freshness_state: string;
  writes_enabled: boolean;
  controller_id: string | null;
  row_version: number;
}

function toSourceRow(row: RawSourceRow): SourceListRow {
  return {
    sourceId: row.source_id,
    name: row.name,
    class: row.class,
    jurisdiction: row.jurisdiction,
    permissionClass: row.permission_class,
    freshnessAt: row.permission_checked_at === null ? null : row.permission_checked_at.toISOString(),
    freshnessState: row.freshness_state as FreshnessState,
    writesEnabled: row.writes_enabled,
    controllerId: row.controller_id,
    rowVersion: row.row_version,
  };
}

/**
 * The recipe signing keys, indexed by `signingKeyRef`.
 *
 * A malformed PEM is dropped at CONSTRUCTION with the reference named, so a deployment typo surfaces
 * at bootstrap rather than as a `422` on the first recipe submission — which would look like the
 * integrator's bug. Dropping rather than throwing keeps the process startable: a service that cannot
 * accept recipes can still serve every read, and refusing to start would take those down too.
 */
export function verificationKeysFrom(entries: Readonly<Record<string, string>>): {
  readonly keys: RecipeVerificationKeys;
  readonly rejected: readonly string[];
} {
  const publicKeysByRef = new Map<string, string>();
  const rejected: string[] = [];
  for (const [ref, pem] of Object.entries(entries)) {
    try {
      createPublicKey(pem);
      publicKeysByRef.set(ref, pem);
    } catch {
      rejected.push(ref);
    }
  }
  return { keys: { publicKeysByRef }, rejected };
}

/**
 * The bytes a recipe signature must cover.
 *
 * SPEC-003 §5.3.7 requires the API to verify the signature and does NOT state what is signed, so the
 * payload is defined here and recorded as an assumption (ASSUMPTIONS.md §3.14) rather than presented
 * as a specification requirement. The construction is a fixed-field-order JSON object with no
 * whitespace, which is stable across languages and cannot be reordered by a JSON serialiser:
 *
 *   * Field order is fixed and alphabetical, never the request body's order, so a signature cannot be
 *     made to verify against a differently-ordered but semantically identical body.
 *   * `signature` is excluded — a signature cannot cover itself.
 *   * `sourceId` IS included, so a signature captured from one source's recipe cannot be replayed onto
 *     another source's version.
 *   * `version` is EXCLUDED because the server assigns it under a lock after verification; including
 *     it would make the payload uncomputable by the caller whenever it guessed the next version wrong.
 *
 * Exported so a test (and, later, an integrator's client) can produce a verifiable signature without
 * reimplementing the rule.
 */
export function canonicalRecipePayload(input: {
  readonly sourceId: string;
  readonly channel: string;
  readonly verificationMethod: string;
  readonly signingKeyRef: string;
  readonly freshnessAt: string;
  readonly maxAttemptsPerWindow: number;
  readonly windowSeconds: number;
}): string {
  return JSON.stringify({
    channel: input.channel,
    freshnessAt: input.freshnessAt,
    maxAttemptsPerWindow: input.maxAttemptsPerWindow,
    signingKeyRef: input.signingKeyRef,
    sourceId: input.sourceId,
    verificationMethod: input.verificationMethod,
    windowSeconds: input.windowSeconds,
  });
}

/** Why a signature could not be accepted, for the two conditions that need different operator action. */
type SignatureVerdict = 'VERIFIED' | 'INVALID' | 'KEY_UNCONFIGURED';

/**
 * Verify a recipe signature against the key its `signingKeyRef` names.
 *
 * THE ALGORITHM COMES FROM THE KEY, NEVER FROM THE REQUEST. Reading an algorithm from the submitted
 * body is how `alg: none` and algorithm-confusion attacks arrive; `createPublicKey` reports the key's
 * own type and the mapping below is a closed set.
 *
 * An Ed25519 key needs no digest (the signature covers the message directly, so the API takes `null`);
 * an RSA key uses SHA-256. Any other key type is `INVALID`, not silently unverified.
 */
function verifyRecipeSignature(
  input: { readonly signingKeyRef: string; readonly signature: Buffer; readonly payload: string },
  keys: RecipeVerificationKeys,
): SignatureVerdict {
  const pem = keys.publicKeysByRef.get(input.signingKeyRef);
  if (pem === undefined) return 'KEY_UNCONFIGURED';
  try {
    const key = createPublicKey(pem);
    const algorithm = key.asymmetricKeyType === 'ed25519' ? null : key.asymmetricKeyType === 'rsa' ? 'sha256' : undefined;
    if (algorithm === undefined) return 'INVALID';
    return cryptoVerify(algorithm, Buffer.from(input.payload, 'utf8'), key, input.signature)
      ? 'VERIFIED'
      : 'INVALID';
  } catch {
    // A key that parsed at construction but fails here is unusable. INVALID rather than a throw: the
    // caller's submission is what is being answered, and a 500 would tell them to retry.
    return 'INVALID';
  }
}

function guardOrder(evaluation: RecipeGuardEvaluation): readonly (readonly [GuardName, boolean])[] {
  return [
    ['signatureVerified', evaluation.signatureVerified],
    ['fresh', evaluation.fresh],
    ['permissionClass', evaluation.permissionClass === 'WRITE_PERMITTED'],
    ['permissionFresh', evaluation.permissionFresh],
  ];
}

function firstFailingGuard(evaluation: RecipeGuardEvaluation): GuardName | null {
  for (const [name, passed] of guardOrder(evaluation)) {
    if (!passed) return name;
  }
  return null;
}

/** Whether a permission class is one the `permission_class` enum accepts. */
const PERMISSION_CLASSES: readonly string[] = ['READ_ONLY', 'WRITE_PERMITTED', 'WRITE_UNCLEAR', 'PROHIBITED'];

/**
 * The closed vocabulary of SYSTEM-computed `disabled_reason` values.
 *
 * Migration 0014 withdrew the equivalent CHECK constraint because the same column also carries an
 * operator's own reason from §5.3.10, and one constraint cannot bound both a closed token set and
 * caller input. The closed half is enforced HERE, where these values are produced, so a future edit
 * cannot invent a token that operators' dashboards do not know.
 */
export type SystemDisabledReason =
  | 'PERMISSION_UNCLEAR'
  | 'PERMISSION_STALE'
  | 'PERMISSION_DOWNGRADED'
  | 'FRESHNESS_EXPIRED'
  | 'SIGNATURE_INVALID';

/** Name the reason a permission change disabled a recipe, from the NEW permission state. */
function systemDisabledReason(permissionClass: string, freshnessState: string): SystemDisabledReason {
  // ORDER IS THE SEMANTICS, and it follows the least-informative-first rule: "unclear" is a stronger
  // statement than "not permitted" (ADR-003 treats WRITE_UNCLEAR as forbidden without override), and a
  // class that is not WRITE_PERMITTED at all is a downgrade rather than a freshness lapse. Only when
  // the class is still WRITE_PERMITTED can the cause be freshness, because that is the only remaining
  // way `permissionUsable` can be false.
  if (permissionClass === 'WRITE_UNCLEAR') return 'PERMISSION_UNCLEAR';
  if (permissionClass !== 'WRITE_PERMITTED') return 'PERMISSION_DOWNGRADED';
  return freshnessState === 'CURRENT' ? 'PERMISSION_DOWNGRADED' : 'PERMISSION_STALE';
}

export class PostgresSourceQueries implements SourceQueries {
  async listSources(tx: TenantTransaction, params: ListSourcesParams): Promise<readonly SourceListRow[]> {
    // `sort` is `name|freshnessAt` with a `name:asc` default (§5.3.1). The mapping is a closed set, so
    // an unparsed token cannot become a column name: the `strict.ts` parser has already refused
    // anything outside the declared list, and this lookup refuses again rather than interpolating.
    const [field = 'name', direction = 'asc'] = params.sort.split(':');
    const byFreshness = field === 'freshnessAt';
    const comparison = direction === 'asc' ? '>' : '<';
    const order = direction === 'asc' ? 'ASC' : 'DESC';

    /**
     * The ORDER BY / keyset expression, and the cast its bound value needs.
     *
     * The cast differs by column and BOTH halves must move together. `permission_checked_at` is
     * `timestamptz` and NULLABLE, so it is COALESCEd to the epoch — which is where `ORDER BY … ASC`
     * already puts a NULL (PostgreSQL's default is NULLS LAST for ASC) without relying on that default
     * being remembered. `name` is `text NOT NULL`, so it needs no COALESCE, and binding its cursor
     * value as `timestamptz` would raise `22P02` on the first request that continued a page.
     */
    const sortKey = byFreshness ? `COALESCE(s.permission_checked_at, 'epoch'::timestamptz)` : 's.name';
    const sortCast = byFreshness ? 'timestamptz' : 'text';

    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };

    const where: string[] = [];
    if (params.filters.class !== undefined) where.push(`s.class = ${bind(params.filters.class)}`);
    if (params.filters.jurisdiction !== undefined) {
      where.push(`s.jurisdiction = ${bind(params.filters.jurisdiction)}`);
    }
    if (params.filters.permissionClass !== undefined) {
      const classes =
        typeof params.filters.permissionClass === 'string'
          ? [params.filters.permissionClass]
          : params.filters.permissionClass;
      where.push(`s.permission_class::text = ANY(${bind([...classes])}::text[])`);
    }
    if (params.after !== undefined) {
      // Keyset with the id tiebreaker: two sources declared in the same millisecond share a sort
      // value, and without the id a page boundary between them repeats or skips one — silently
      // dropping a source from the catalogue an operator is reading.
      where.push(
        `(${sortKey}, s.id::text) ${comparison} (${bind(params.after.sortValue)}::${sortCast}, ${bind(params.after.id)})`,
      );
    }

    const limitParam = bind(params.limit + 1);
    const result = await tx.query<RawSourceRow>(
      `SELECT ${SOURCE_PROJECTION}
         FROM source s
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${sortKey} ${order}, s.id ${order}
        LIMIT ${limitParam}`,
      values,
    );
    return result.rows.map(toSourceRow);
  }

  async getSourceDetail(tx: TenantTransaction, sourceId: string): Promise<SourceDetail | undefined> {
    const base = await tx.query<RawSourceRow & {
      permission_evidence_url: string | null;
      permission_window_seconds: number | null;
      created_at: Date;
    }>(
      `SELECT ${SOURCE_PROJECTION},
              s.permission_evidence_url,
              s.permission_window_seconds,
              s.created_at
         FROM source s WHERE s.id = $1::uuid`,
      [sourceId],
    );
    const row = base.rows[0];
    // Absent and another tenant are INDISTINGUISHABLE by construction: RLS means another tenant's row
    // is not returned, so both reach this branch and produce one 404 body (SPEC-006 H-9).
    if (row === undefined) return undefined;

    // Recipe readiness in ONE statement. Three separate counts would each take their own snapshot
    // under READ COMMITTED, so a recipe enabled between them could be counted as both enabled and
    // disabled, and the readiness a caller reads is what decides whether they may act.
    const readiness = await tx.query<{
      total: number;
      enabled_count: number;
      unsigned_count: number;
      stale_count: number;
      disabled_count: number;
    }>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE r.enabled)::int AS enabled_count,
         count(*) FILTER (WHERE r.signature IS NULL OR octet_length(r.signature) = 0)::int AS unsigned_count,
         count(*) FILTER (WHERE r.freshness_at < now())::int AS stale_count,
         count(*) FILTER (WHERE NOT r.enabled)::int AS disabled_count
       FROM removal_recipe r WHERE r.source_id = $1::uuid`,
      [sourceId],
    );
    const shape = readiness.rows[0];

    return {
      ...toSourceRow(row),
      permissionEvidenceUrl: row.permission_evidence_url,
      permissionWindowSeconds: row.permission_window_seconds,
      createdAt: row.created_at.toISOString(),
      recipeReadiness: {
        total: shape?.total ?? 0,
        enabled: shape?.enabled_count ?? 0,
        unsigned: shape?.unsigned_count ?? 0,
        stale: shape?.stale_count ?? 0,
        disabled: shape?.disabled_count ?? 0,
      },
    };
  }

  async sourceExists(tx: TenantTransaction, sourceId: string): Promise<boolean> {
    const result = await tx.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM source s WHERE s.id = $1::uuid',
      [sourceId],
    );
    return result.rows[0]?.n !== '0';
  }

  async declareSource(
    tx: TenantTransaction,
    input: DeclareSourceInput,
  ): Promise<Ported<{ readonly sourceId: string; readonly createdAt: string }, 'ALREADY_DECLARED' | 'CONTROLLER_NOT_FOUND'>> {
    // The controller existence check is in the INSERT's SELECT, not a preceding statement, so a
    // controller deleted between a check and the insert cannot leave a source referencing nothing.
    // Under RLS the EXISTS sees only this tenant's controllers, so another tenant's controller id is
    // CONTROLLER_NOT_FOUND rather than a cross-tenant reference.
    const inserted = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO source
         (tenant_id, name, class, jurisdiction, controller_id, permission_class,
          permission_evidence_url, permission_checked_at, permission_window_seconds)
       SELECT current_setting('app.tenant_id', true)::uuid,
              $1, $2, $3, $4::uuid, $5::permission_class, $6, $7::timestamptz, $8
        WHERE $4::uuid IS NULL OR EXISTS (SELECT 1 FROM controller c WHERE c.id = $4::uuid)
       ON CONFLICT (tenant_id, name) DO NOTHING
       RETURNING id::text AS id, created_at`,
      [
        input.name,
        input.class,
        input.jurisdiction,
        input.controllerId,
        input.permissionClass,
        input.permissionEvidenceUrl,
        input.permissionCheckedAt,
        input.permissionWindowSeconds,
      ],
    );

    const row = inserted.rows[0];
    if (row !== undefined) return { ok: true, value: { sourceId: row.id, createdAt: row.created_at.toISOString() } };

    // Zero rows has two causes and they are NOT interchangeable, so they are separated by asking which
    // one holds. The duplicate is tested FIRST: when both hold, the name collision is the condition the
    // caller can fix without consulting anyone, and reporting the controller instead would send them to
    // fix a reference when the real blocker is that the source already exists.
    const duplicate = await tx.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM source s WHERE s.name = $1',
      [input.name],
    );
    return duplicate.rows[0]?.n !== '0'
      ? { ok: false, reason: 'ALREADY_DECLARED' }
      : { ok: false, reason: 'CONTROLLER_NOT_FOUND' };
  }

  async setPermissionClass(
    tx: TenantTransaction,
    sourceId: string,
    input: {
      readonly permissionClass: string;
      readonly permissionEvidenceUrl: string | null;
      readonly permissionCheckedAt: string | null;
      readonly reason: string;
      readonly expectedRowVersion: number;
    },
  ): Promise<Ported<{ readonly autoDisabledRecipeIds: readonly string[]; readonly source: SourceListRow }, 'NOT_FOUND' | 'PRECONDITION_FAILED'>> {
    // The row lock is taken FIRST and held to COMMIT, which is what makes the auto-disable below
    // atomic with the downgrade: without it, a concurrent enablement could pass its guards against the
    // OLD permission class and commit after this transaction, leaving an enabled recipe on a source
    // that may no longer be written to.
    const locked = await tx.query<{ row_version: number }>(
      'SELECT s.row_version FROM source s WHERE s.id = $1::uuid FOR UPDATE',
      [sourceId],
    );
    if (locked.rows[0] === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (locked.rows[0].row_version !== input.expectedRowVersion) {
      return { ok: false, reason: 'PRECONDITION_FAILED' };
    }

    const updated = await tx.query<RawSourceRow>(
      `UPDATE source s
          SET permission_class        = $2::permission_class,
              permission_evidence_url = $3,
              permission_checked_at   = $4::timestamptz,
              row_version             = s.row_version + 1
        WHERE s.id = $1::uuid
      RETURNING ${SOURCE_PROJECTION}`,
      [sourceId, input.permissionClass, input.permissionEvidenceUrl, input.permissionCheckedAt],
    );
    const row = updated.rows[0];
    if (row === undefined) return { ok: false, reason: 'NOT_FOUND' };

    // VG-CHANNEL-002: "stale or unclear permission ⇒ recipe auto-disables". The condition is computed
    // from the NEW row rather than from the request, and it is the PERMISSION that decides — not
    // `writesEnabled`, which additionally requires a signed, fresh, enabled recipe. Using
    // `writesEnabled` here would disable recipes on a permission REFRESH merely because some recipe
    // was stale or unsigned, which is not what §5.3.4 describes ("downgrading or un-refreshing
    // permission auto-disables affected recipes").
    //
    // A recipe already disabled is left alone: overwriting its `disabled_reason` would destroy the
    // record of why an operator turned it off.
    const permissionUsable =
      row.permission_class === 'WRITE_PERMITTED' && row.freshness_state === 'CURRENT';
    const autoDisabled = permissionUsable
      ? []
      : (
          await tx.query<{ id: string }>(
            `UPDATE removal_recipe r
                SET enabled         = false,
                    disabled_reason = $2,
                    enabled_at      = NULL,
                    row_version     = r.row_version + 1
              WHERE r.source_id = $1::uuid
                AND r.enabled
            RETURNING r.id::text AS id`,
            [sourceId, systemDisabledReason(row.permission_class, row.freshness_state)],
          )
        ).rows.map((r) => r.id);

    return { ok: true, value: { autoDisabledRecipeIds: autoDisabled, source: toSourceRow(row) } };
  }

  async listCatalogEntries(tx: TenantTransaction, sourceId: string): Promise<readonly SourceCatalogEntryRow[]> {
    const result = await tx.query<{
      id: string;
      source_id: string;
      category: string;
      coverage_notes: string;
      provenance: string;
      license: string;
      created_at: Date;
    }>(
      `SELECT e.id::text AS id, e.source_id::text AS source_id, e.category, e.coverage_notes,
              e.provenance, e.license, e.created_at
         FROM source_catalog_entry e
        WHERE e.source_id = $1::uuid
        ORDER BY e.category ASC, e.id ASC`,
      [sourceId],
    );
    return result.rows.map((row) => ({
      catalogEntryId: row.id,
      sourceId: row.source_id,
      category: row.category,
      coverageNotes: row.coverage_notes,
      provenance: row.provenance,
      license: row.license,
      declaredAt: row.created_at.toISOString(),
    }));
  }

  async appendCatalogEntry(
    tx: TenantTransaction,
    sourceId: string,
    input: { readonly category: string; readonly coverageNotes: string; readonly provenance: string; readonly license: string },
  ): Promise<Ported<{ readonly catalogEntryId: string; readonly declaredAt: string }, 'DUPLICATE' | 'NOT_FOUND'>> {
    if (!(await this.sourceExists(tx, sourceId))) return { ok: false, reason: 'NOT_FOUND' };

    // `ON CONFLICT DO NOTHING` against the unique index from migration 0013 is what makes
    // CATALOG_ENTRY_DUPLICATE atomic. A `SELECT` followed by an `INSERT` would let two concurrent
    // requests both observe "no entry" and both insert, which is the duplicate this code exists to
    // refuse — and `catches`-style checking of a unique-violation error would abort the transaction.
    const inserted = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO source_catalog_entry
         (tenant_id, source_id, category, coverage_notes, provenance, license)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1::uuid, $2, $3, $4, $5)
       ON CONFLICT (source_id, category) DO NOTHING
       RETURNING id::text AS id, created_at`,
      [sourceId, input.category, input.coverageNotes, input.provenance, input.license],
    );
    const row = inserted.rows[0];
    if (row !== undefined) {
      return { ok: true, value: { catalogEntryId: row.id, declaredAt: row.created_at.toISOString() } };
    }
    return { ok: false, reason: 'DUPLICATE' };
  }

  async createRecipe(
    tx: TenantTransaction,
    sourceId: string,
    input: CreateRecipeInput,
    keys: RecipeVerificationKeys,
  ): Promise<
    Ported<
      { readonly recipeId: string; readonly version: number; readonly createdAt: string },
      'VERSION_CONFLICT' | 'NOT_FOUND' | 'SIGNATURE_UNVERIFIABLE' | 'SIGNING_KEY_UNCONFIGURED'
    >
  > {
    // Lock the source row for the whole operation. Two effects, both needed: the source's existence is
    // established under the same lock the version assignment uses, and two concurrent createRecipe
    // calls for one source serialise instead of both reading the same `max(version)`.
    const locked = await tx.query<{ id: string }>(
      'SELECT s.id::text AS id FROM source s WHERE s.id = $1::uuid FOR UPDATE',
      [sourceId],
    );
    if (locked.rows[0] === undefined) return { ok: false, reason: 'NOT_FOUND' };

    // VERIFY FIRST. Nothing below this line runs for a signature that does not verify, so the INSERT
    // is unreachable without a verified signature (VG-CHANNEL-003, VG-API-028).
    const signature = Buffer.from(input.signature, 'base64url');
    const verdict = verifyRecipeSignature(
      {
        signingKeyRef: input.signingKeyRef,
        signature,
        payload: canonicalRecipePayload({ sourceId, ...input }),
      },
      keys,
    );
    if (verdict === 'KEY_UNCONFIGURED') return { ok: false, reason: 'SIGNING_KEY_UNCONFIGURED' };
    if (verdict === 'INVALID') return { ok: false, reason: 'SIGNATURE_UNVERIFIABLE' };

    const nextVersion = await tx.query<{ version: number }>(
      'SELECT COALESCE(max(r.version), 0) + 1 AS version FROM removal_recipe r WHERE r.source_id = $1::uuid',
      [sourceId],
    );
    const version = nextVersion.rows[0]?.version ?? 1;

    try {
      const inserted = await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO removal_recipe
           (tenant_id, source_id, version, signature, channel, verification_method, freshness_at,
            enabled, signing_key_ref, max_attempts_per_window, window_seconds)
         VALUES (current_setting('app.tenant_id', true)::uuid, $1::uuid, $2, $3, $4, $5, $6::timestamptz,
                 false, $7, $8, $9)
         RETURNING id::text AS id, created_at`,
        [
          sourceId,
          version,
          signature,
          input.channel,
          input.verificationMethod,
          input.freshnessAt,
          input.signingKeyRef,
          input.maxAttemptsPerWindow,
          input.windowSeconds,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) return { ok: false, reason: 'VERSION_CONFLICT' };
      // `enabled: false` is hard-coded above, not defaulted: §5.3.7 requires a new version to be
      // created disabled, and a schema default is a value a later migration could change without
      // anyone re-reading this milestone. Enabling is the separate guarded call (§5.3.10).
      return { ok: true, value: { recipeId: row.id, version, createdAt: row.created_at.toISOString() } };
    } catch (error) {
      // Only a unique violation is a version conflict. Catching the code rather than the message
      // matters: `23505` is the SQLSTATE for unique_violation, and matching prose would break under a
      // server locale change while still swallowing every other error class.
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505') {
        return { ok: false, reason: 'VERSION_CONFLICT' };
      }
      throw error;
    }
  }

  async listRecipes(
    tx: TenantTransaction,
    sourceId: string,
    params: { readonly sort: string; readonly filters: RecipeFilters },
  ): Promise<readonly RecipeRow[]> {
    const [field = 'version', direction = 'desc'] = params.sort.split(':');
    const sortColumn = field === 'freshnessAt' ? 'freshness_at' : 'version';
    const order = direction === 'asc' ? 'ASC' : 'DESC';

    const where: string[] = ['r.source_id = $1::uuid'];
    const values: unknown[] = [sourceId];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };
    if (params.filters.enabled !== undefined) {
      where.push(`r.enabled = ${bind(params.filters.enabled)}`);
    }
    if (params.filters.fresh !== undefined) {
      where.push(params.filters.fresh ? 'r.freshness_at >= now()' : 'r.freshness_at < now()');
    }

    const result = await tx.query<RawRecipeRow>(
      `SELECT ${RECIPE_PROJECTION}
         FROM removal_recipe r
        WHERE ${where.join(' AND ')}
        ORDER BY r.${sortColumn} ${order}, r.id ${order}`,
      values,
    );
    return result.rows.map(toRecipeRow);
  }

  async getRecipe(tx: TenantTransaction, recipeId: string): Promise<RecipeRow | undefined> {
    const result = await tx.query<RawRecipeRow>(
      `SELECT ${RECIPE_PROJECTION} FROM removal_recipe r WHERE r.id = $1::uuid`,
      [recipeId],
    );
    const row = result.rows[0];
    // LAST-DITCH PRECONDITION. §5.3.9's documented errors do not list a body-integrity failure, and a
    // recipe used to justify a past action must never be silently repairable (D4). The row is
    // returned exactly as stored; a caller that needs the authoritative bytes re-reads them through
    // the evidence path.
    return row === undefined ? undefined : toRecipeRow(row);
  }

  async setRecipeEnablement(
    tx: TenantTransaction,
    recipeId: string,
    input: { readonly enabled: boolean; readonly reason: string; readonly expectedRowVersion: number },
    keys: RecipeVerificationKeys,
  ): Promise<EnablementOutcome> {
    // The recipe row is locked first, and the SOURCE row inside the same statement, so a §5.3.4
    // permission change and an enablement here cannot interleave: whichever arrives second sees the
    // other's committed effect, and neither can pass guards against a state the other has replaced.
    const locked = await tx.query<{
      row_version: number;
      enabled: boolean;
      source_id: string;
      signature: Buffer | null;
      signing_key_ref: string | null;
      freshness_at: Date;
      verification_method: string;
      channel: string;
      max_attempts_per_window: number | null;
      window_seconds: number | null;
      source_permission_class: string;
      source_permission_checked_at: Date | null;
      source_permission_window_seconds: number | null;
    }>(
      `SELECT r.row_version, r.enabled, r.source_id::text AS source_id, r.signature,
              r.signing_key_ref, r.freshness_at, r.verification_method, r.channel,
              r.max_attempts_per_window, r.window_seconds,
              s.permission_class::text AS source_permission_class,
              s.permission_checked_at  AS source_permission_checked_at,
              s.permission_window_seconds AS source_permission_window_seconds
         FROM removal_recipe r
         JOIN source s ON s.id = r.source_id
        WHERE r.id = $1::uuid
          FOR UPDATE OF r, s`,
      [recipeId],
    );
    const row = locked.rows[0];
    if (row === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (row.row_version !== input.expectedRowVersion) return { ok: false, reason: 'PRECONDITION_FAILED' };

    const nowMs = Date.now();
    // A NULL budget or window means the row predates migration 0012 or was written outside the API.
    // The canonical payload cannot be reconstructed from NULLs, so the signature is reported as
    // UNVERIFIED rather than verified against a payload built from substituted zeros — substituting
    // would make an unverifiable row compare equal to a signature over different content.
    const claimable =
      row.signature !== null &&
      row.signing_key_ref !== null &&
      row.max_attempts_per_window !== null &&
      row.window_seconds !== null;
    const evaluation: RecipeGuardEvaluation = {
      // A LIVE re-verification, not a read of a stored flag. §5.3.10 reports what is true at
      // enablement time: a key rotated away since ingestion must fail here even though ingestion
      // succeeded, and a stored boolean could not express that.
      signatureVerified:
        claimable &&
        verifyRecipeSignature(
          {
            signingKeyRef: row.signing_key_ref as string,
            signature: row.signature as Buffer,
            payload: canonicalRecipePayload({
              sourceId: row.source_id,
              channel: row.channel,
              verificationMethod: row.verification_method,
              signingKeyRef: row.signing_key_ref as string,
              freshnessAt: row.freshness_at.toISOString(),
              maxAttemptsPerWindow: row.max_attempts_per_window as number,
              windowSeconds: row.window_seconds as number,
            }),
          },
          keys,
        ) === 'VERIFIED',
      fresh: row.freshness_at.getTime() >= nowMs,
      permissionClass: row.source_permission_class,
      // Same fail-closed rule as FRESHNESS_STATE_SQL: no window or no check means freshness cannot be
      // established, which is NOT fresh.
      permissionFresh:
        row.source_permission_checked_at !== null &&
        row.source_permission_window_seconds !== null &&
        row.source_permission_checked_at.getTime() + row.source_permission_window_seconds * 1000 >= nowMs,
    };

    const failing = firstFailingGuard(evaluation);

    // A DISABLE IS NEVER REFUSED BY A GUARD. Refusing to disable would be refusing to make the system
    // safe, and a guard that blocked it would turn a permission downgrade into a stuck enabled recipe.
    // Only ENABLEMENT is gated (§5.3.10), so a failing guard with `enabled: true` is the only refusal.
    if (input.enabled && failing !== null) {
      // The row is NOT touched. §5.3.10: "`enabled` stays `false`" — and if it was already true and a
      // guard has since lapsed, an enablement request must not silently flip it off either, because
      // that is a state change the caller did not ask for and is not told about.
      return { ok: false, reason: 'GUARD_FAILED', evaluation, failingGuard: failing };
    }

    const updated = await tx.query<{ enabled: boolean; enabled_at: Date | null }>(
      `UPDATE removal_recipe r
          SET enabled         = $2,
              enabled_at      = CASE WHEN $2 THEN now() ELSE NULL END,
              disabled_reason = CASE WHEN $2 THEN NULL ELSE $3 END,
              row_version     = r.row_version + 1
        WHERE r.id = $1::uuid
      RETURNING r.enabled, r.enabled_at`,
      [recipeId, input.enabled, input.reason],
    );
    const written = updated.rows[0];
    if (written === undefined) return { ok: false, reason: 'NOT_FOUND' };

    return {
      ok: true,
      enablement: {
        recipeId,
        enabled: written.enabled,
        enabledAt: written.enabled_at === null ? null : written.enabled_at.toISOString(),
        guardEvaluation: evaluation,
      },
    };
  }
}

/** The recipe projection, shared so a list row and a detail row cannot disagree. */
const RECIPE_PROJECTION = `
  r.id::text              AS recipe_id,
  r.source_id::text       AS source_id,
  r.version               AS version,
  r.channel               AS channel,
  r.verification_method   AS verification_method,
  r.enabled               AS enabled,
  r.freshness_at          AS freshness_at,
  (r.freshness_at < now()) AS is_stale,
  r.disabled_reason       AS disabled_reason,
  r.enabled_at            AS enabled_at,
  r.created_at            AS created_at,
  r.max_attempts_per_window AS max_attempts_per_window,
  r.window_seconds        AS window_seconds,
  r.signing_key_ref       AS signing_key_ref,
  r.row_version           AS row_version,
  (r.signature IS NOT NULL AND octet_length(r.signature) > 0) AS signature_present
`;

interface RawRecipeRow {
  recipe_id: string;
  source_id: string;
  version: number;
  channel: string;
  verification_method: string;
  enabled: boolean;
  freshness_at: Date;
  is_stale: boolean;
  disabled_reason: string | null;
  enabled_at: Date | null;
  created_at: Date;
  max_attempts_per_window: number | null;
  window_seconds: number | null;
  signing_key_ref: string | null;
  row_version: number;
  signature_present: boolean;
}

function toRecipeRow(row: RawRecipeRow): RecipeRow {
  return {
    recipeId: row.recipe_id,
    sourceId: row.source_id,
    version: row.version,
    channel: row.channel,
    verificationMethod: row.verification_method,
    // Reports the INGESTION result, which is a stored fact rather than an assumption: `createRecipe`
    // verifies before it inserts, so a non-empty signature is only reachable through verification.
    // §5.3.10's `guardEvaluation.signatureVerified` is where a live re-check is reported.
    signatureVerified: row.signature_present,
    enabled: row.enabled,
    freshnessAt: row.freshness_at.toISOString(),
    staleness: (row.is_stale ? 'STALE' : 'FRESH') as Staleness,
    disabledReason: row.disabled_reason,
    enabledAt: row.enabled_at === null ? null : row.enabled_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    maxAttemptsPerWindow: row.max_attempts_per_window,
    windowSeconds: row.window_seconds,
    signingKeyRef: row.signing_key_ref,
    rowVersion: row.row_version,
  };
}

/** Exported so the persistence tests can exercise the accepted class set without re-listing it. */
export const ACCEPTED_PERMISSION_CLASSES: readonly string[] = PERMISSION_CLASSES;
