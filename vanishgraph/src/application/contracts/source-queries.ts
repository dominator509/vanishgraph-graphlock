/**
 * The source/recipe read-and-declare model the HTTP layer depends on (SPEC-003 §5.3,
 * ARCHITECTURE.md §2).
 *
 * WHY THIS EXISTS: exactly as with `subject-queries.ts`. `src/http/**` must not import
 * `src/adapters/**`, so the §5.3 handlers depend on THIS interface and the composition root wires the
 * PostgreSQL implementation in. A handler that needs a new read adds a method here.
 *
 * WHY THE GUARD EVALUATION LIVES HERE RATHER THAN IN THE HANDLER. VG-CHANNEL-002 and VG-CHANNEL-003
 * are the rules that decide whether a source may be written to and whether a recipe may be enabled,
 * and §5.3.10 requires the response to report every guard. Those guards read several tables at once
 * (source, removal_recipe, and the configured signing key), and they must be read in the SAME
 * transaction that performs the enablement — otherwise a concurrent permission downgrade between the
 * check and the write would enable a recipe that no longer qualifies. So the read and the write are
 * one port method, not two calls a handler sequences.
 *
 * NOTHING HERE DECIDES A TRUTH STATE. A `Source` and a `RemovalRecipe` have no truth state: they are
 * catalogue and permission data, and `writesEnabled` is a DERIVED report about them, never an input.
 * The eleven canonical states belong to exposures and cases (SPEC-000 §5, SPEC-001 SM-6) and no field
 * in this file accepts or assigns one.
 *
 * THE TENANT IS NOT A PARAMETER. Every method runs inside a `TenantTransaction` the runner has already
 * scoped with `app.tenant_id`, and the tables carry FORCE RLS. A second, application-level
 * `WHERE tenant_id = …` would MASK a broken policy rather than complement it (VG-TENANT-002).
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** Whether a source's recorded permission is still inside its declared freshness window. */
export type FreshnessState = 'CURRENT' | 'STALE';

/** Whether a recipe version's `freshnessAt` instant has passed. */
export type Staleness = 'FRESH' | 'STALE';

/** The four guards §5.3.10 reports, in the order the specification lists them. */
export type GuardName = 'signatureVerified' | 'fresh' | 'permissionClass' | 'permissionFresh';

/**
 * The §5.3.1 source row.
 *
 * `writesEnabled` is DERIVED and never stored: §5.3.1 defines it as `permissionClass =
 * WRITE_PERMITTED` AND current freshness AND at least one recipe that is signed, fresh and enabled.
 * A stored copy would go stale the moment any of those three changed, and the stale copy is the one
 * a caller would act on.
 */
export interface SourceListRow {
  readonly sourceId: string;
  readonly name: string;
  readonly class: string;
  readonly jurisdiction: string | null;
  readonly permissionClass: string;
  /**
   * RFC 3339 UTC. This is the source's PERMISSION freshness — `source.permission_checked_at` — not a
   * separate column. SPEC-001 §3.2 names the field `freshnessAt` on `Source`; SPEC-002 §2 stores it as
   * `permission_checked_at`, and VG-CHANNEL-002 defines the freshness that matters as the
   * permission/TOS check. `null` when the permission has never been checked.
   */
  readonly freshnessAt: string | null;
  readonly freshnessState: FreshnessState;
  readonly writesEnabled: boolean;
  readonly controllerId: string | null;
  /** The `If-Match` concurrency token for this row (§5.3.4). */
  readonly rowVersion: number;
}

/** The §5.3.3 source detail: the list row plus permission evidence and recipe readiness. */
export interface SourceDetail extends SourceListRow {
  readonly permissionEvidenceUrl: string | null;
  readonly permissionWindowSeconds: number | null;
  readonly createdAt: string;
  readonly recipeReadiness: {
    readonly total: number;
    readonly enabled: number;
    readonly unsigned: number;
    readonly stale: number;
    readonly disabled: number;
  };
}

/** The §5.3.5 catalogue-entry row. */
export interface SourceCatalogEntryRow {
  readonly catalogEntryId: string;
  readonly sourceId: string;
  readonly category: string;
  readonly coverageNotes: string;
  readonly provenance: string;
  readonly license: string;
  readonly declaredAt: string;
}

/**
 * A §5.3.8 recipe row.
 *
 * `signatureVerified` is reported as a fact about what was checked at INGESTION (§5.3.7 stores only a
 * recipe whose signature verified), not as a live re-check; §5.3.10's `guardEvaluation` is where a
 * live re-check is reported. The signature BYTES are deliberately not a field here: a handler cannot
 * leak what the port never returns.
 */
export interface RecipeRow {
  readonly recipeId: string;
  readonly sourceId: string;
  readonly version: number;
  readonly channel: string;
  readonly verificationMethod: string;
  readonly signatureVerified: boolean;
  readonly enabled: boolean;
  readonly freshnessAt: string;
  readonly staleness: Staleness;
  readonly disabledReason: string | null;
  readonly enabledAt: string | null;
  readonly createdAt: string;
  readonly maxAttemptsPerWindow: number | null;
  readonly windowSeconds: number | null;
  readonly signingKeyRef: string | null;
  readonly rowVersion: number;
}

/** The §5.3.10 guard report, field names exactly as the specification's `guardEvaluation` object. */
export interface RecipeGuardEvaluation {
  readonly signatureVerified: boolean;
  readonly fresh: boolean;
  readonly permissionClass: string;
  readonly permissionFresh: boolean;
}

/** The §5.3.10 success payload. */
export interface RecipeEnablement {
  readonly recipeId: string;
  readonly enabled: boolean;
  readonly enabledAt: string | null;
  readonly guardEvaluation: RecipeGuardEvaluation;
}

/** A decline that is a legal outcome of the port call rather than an exception. */
export type Ported<T, R> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: R };

/**
 * The §5.3.10 outcome.
 *
 * `GUARD_FAILED` carries the evaluation AND the first failing guard name, because §5.3.10 requires a
 * refusal "with the failing guard named". Returning a bare reason would force the route to re-read the
 * recipe in a SECOND transaction to name it — and between the two the guard could have changed, so the
 * response would name a guard that is no longer the one that failed.
 */
export type EnablementOutcome =
  | { readonly ok: true; readonly enablement: RecipeEnablement }
  // One member per reason, so `reason === 'GUARD_FAILED'` NARROWS to the member carrying the
  // evaluation. A single member with a union of reasons would leave the route unable to read
  // `failingGuard` after excluding the other two, which is how a guard refusal would end up reported
  // without the guard name §5.3.10 requires.
  | { readonly ok: false; readonly reason: 'NOT_FOUND' }
  | { readonly ok: false; readonly reason: 'PRECONDITION_FAILED' }
  | {
      readonly ok: false;
      readonly reason: 'GUARD_FAILED';
      readonly evaluation: RecipeGuardEvaluation;
      readonly failingGuard: GuardName;
    };

export interface SourceFilters {
  readonly class?: string;
  readonly jurisdiction?: string;
  readonly permissionClass?: string | readonly string[];
}

export interface ListSourcesParams {
  readonly limit: number;
  readonly sort: string;
  readonly filters: SourceFilters;
  readonly after?: { readonly sortValue: string; readonly id: string };
}

export interface RecipeFilters {
  readonly enabled?: boolean;
  readonly fresh?: boolean;
}

export interface DeclareSourceInput {
  readonly name: string;
  readonly class: string;
  readonly jurisdiction: string | null;
  readonly controllerId: string | null;
  readonly permissionClass: string;
  readonly permissionEvidenceUrl: string | null;
  readonly permissionCheckedAt: string | null;
  readonly permissionWindowSeconds: number | null;
}

export interface CatalogEntryInput {
  readonly category: string;
  readonly coverageNotes: string;
  readonly provenance: string;
  readonly license: string;
}

export interface CreateRecipeInput {
  readonly channel: string;
  readonly verificationMethod: string;
  /** base64url. Verified before the row is written; an unverifiable recipe is never stored. */
  readonly signature: string;
  readonly signingKeyRef: string;
  readonly freshnessAt: string;
  readonly maxAttemptsPerWindow: number;
  readonly windowSeconds: number;
}

export interface RecipeVerificationKeys {
  /**
   * The trusted verification keys, by `signingKeyRef`.
   *
   * A `signingKeyRef` that is absent from this map is NOT a verification failure: it means no key was
   * configured for that reference, so the signature cannot be checked at all. The two conditions get
   * different responses because they need different operator actions — one is a bad submission, the
   * other is an unconfigured deployment, and conflating them would send an integrator hunting a bug in
   * their signing code.
   *
   * Values are SPKI PEM public keys. An Ed25519 or RSA key both work; the algorithm is read from the
   * key, never from the request, because a caller-supplied algorithm is how `alg: none` arrives.
   */
  readonly publicKeysByRef: ReadonlyMap<string, string>;
}

/** The source catalogue and recipe read/write model (SPEC-003 §5.3). */
export interface SourceQueries {
  /** §5.3.1 — keyset-paginated, fetching `limit + 1` rows so the caller learns `hasMore`. */
  listSources(tx: TenantTransaction, params: ListSourcesParams): Promise<readonly SourceListRow[]>;
  /** §5.3.3 — `undefined` for both an absent and another tenant's source (SPEC-006 H-9). */
  getSourceDetail(tx: TenantTransaction, sourceId: string): Promise<SourceDetail | undefined>;
  /** Existence for the 404 path on a sub-resource route. */
  sourceExists(tx: TenantTransaction, sourceId: string): Promise<boolean>;
  /**
   * §5.3.2 — declare a source.
   *
   * `CONTROLLER_NOT_FOUND` is checked in the same statement as the insert, so a controller deleted
   * between a check and an insert cannot leave a source pointing at nothing.
   */
  declareSource(
    tx: TenantTransaction,
    input: DeclareSourceInput,
  ): Promise<Ported<{ readonly sourceId: string; readonly createdAt: string }, 'ALREADY_DECLARED' | 'CONTROLLER_NOT_FOUND'>>;
  /**
   * §5.3.4 — record a permission-class change or freshness refresh, and auto-disable what it breaks.
   *
   * VG-CHANNEL-002 requires the auto-disable to be part of the SAME transaction as the downgrade: a
   * committed downgrade with a rolled-back disable would leave recipes enabled against a source that
   * may not be written to. The disabled ids are returned so the response can name them — "disabling is
   * never silent" (§5.3.4).
   */
  setPermissionClass(
    tx: TenantTransaction,
    sourceId: string,
    input: {
      readonly permissionClass: string;
      readonly permissionEvidenceUrl: string | null;
      readonly permissionCheckedAt: string | null;
      readonly reason: string;
      readonly expectedRowVersion: number;
    },
  ): Promise<
    Ported<
      {
        readonly autoDisabledRecipeIds: readonly string[];
        readonly source: SourceListRow;
      },
      'NOT_FOUND' | 'PRECONDITION_FAILED'
    >
  >;
  /** §5.3.5 — catalogue entries for a source. */
  listCatalogEntries(tx: TenantTransaction, sourceId: string): Promise<readonly SourceCatalogEntryRow[]>;
  /** §5.3.6 — add a catalogue entry. A duplicate `(source, category)` is a conflict, not a second row. */
  appendCatalogEntry(
    tx: TenantTransaction,
    sourceId: string,
    input: CatalogEntryInput,
  ): Promise<Ported<{ readonly catalogEntryId: string; readonly declaredAt: string }, 'DUPLICATE' | 'NOT_FOUND'>>;
  /**
   * §5.3.7 — create a new recipe version, DISABLED, after verifying its signature.
   *
   * The version number is assigned by the server as `max(version) + 1` under a row lock on the source,
   * so two concurrent creations cannot both read the same maximum and race for one version number.
   * `VERSION_CONFLICT` remains the outcome when the assignment nevertheless collides, because a
   * serialization failure must surface as a conflict rather than as a retry that silently renumbers.
   */
  createRecipe(
    tx: TenantTransaction,
    sourceId: string,
    input: CreateRecipeInput,
    keys: RecipeVerificationKeys,
  ): Promise<
    Ported<
      { readonly recipeId: string; readonly version: number; readonly createdAt: string },
      'VERSION_CONFLICT' | 'NOT_FOUND' | 'SIGNATURE_UNVERIFIABLE' | 'SIGNING_KEY_UNCONFIGURED'
    >
  >;
  /** §5.3.8 — recipe versions, never deleted, so historical actions stay explainable. */
  listRecipes(
    tx: TenantTransaction,
    sourceId: string,
    params: { readonly sort: string; readonly filters: RecipeFilters },
  ): Promise<readonly RecipeRow[]>;
  /** §5.3.9 — recipe detail, `undefined` for absent and other-tenant alike. */
  getRecipe(tx: TenantTransaction, recipeId: string): Promise<RecipeRow | undefined>;
  /**
   * §5.3.10 — enable or disable a recipe version, reporting every guard.
   *
   * A disable request is never refused by a guard: refusing to disable would be refusing to make the
   * system safe. Guards gate ENABLEMENT only.
   */
  setRecipeEnablement(
    tx: TenantTransaction,
    recipeId: string,
    input: {
      readonly enabled: boolean;
      readonly reason: string;
      readonly expectedRowVersion: number;
    },
    keys: RecipeVerificationKeys,
  ): Promise<EnablementOutcome>;
}
