/**
 * The observation and reappearance read models (SPEC-003 §5.10.2/§5.10.3, §5.11.2/§5.11.3).
 *
 * ONE PORT FOR FOUR ROUTES because they share one scope (`vg.observations.read`) and one subject: what the
 * system OBSERVED, as opposed to what it decided. §5.10's rows are verification observations and §5.11's are
 * reappearances, and both are the evidence side of VG-VERIFY-001 — "the acting path cannot verify itself".
 *
 * `ActorDistinct` AND `Distinct` ARE THE POINT OF §5.10.3, AND BOTH ARE FAIL-CLOSED. Independence is what
 * separates a verified removal from removal theater, so the attestation reports what the ROW attests rather
 * than what the route would like to be true:
 *
 *   * `actorDistinct` compares `actor_identity` with `acting_identity`. The table carries
 *     `CHECK (actor_identity <> acting_identity)` (migration 0004), so this is true for every storable row —
 *     and it is still COMPUTED rather than hard-coded, so a row written outside the constraint's reach would
 *     be reported honestly instead of being asserted independent.
 *   * `distinct` compares the two PATHS and requires BOTH to be present. A row whose paths were never
 *     recorded (every row written before migration 0018) reports `false`: independence that nobody attested
 *     must not be reported as attested, and the fail-closed direction is the only safe one for this field.
 *
 * THE TRANSITION-DERIVED FIELDS ARE ABSENT, ON PURPOSE. §5.11.1's WRITE example reports `priorTruthState` and
 * `transitionCode`, and neither is derivable from a `reappearance` row: `REAPPEARED` has TWO inbound
 * transitions (T17 from `VERIFIED_REMOVED` and T20 from `SEARCH_DELISTED`), so the prior state depends on
 * which one occurred, and the transition record has no storage the specifications permit
 * (`ASSUMPTIONS.md` §3.18). §5.11.2 and §5.11.3 state no field list, so nothing specified is being omitted:
 * the reads report the row's own facts. `reentry` IS reported, because it is a statement about the RULES the
 * contract declares for re-entry (SPEC-001 T18's guards), not about a transition row.
 *
 * THE TENANT IS NOT A PARAMETER: every method runs inside a `TenantTransaction` already scoped with
 * `app.tenant_id`, and both tables carry FORCE RLS.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/**
 * The declared re-entry rules, from SPEC-001 T18 (`REAPPEARED` → `REQUEST_READY`).
 *
 * T18's guard is `all(freshAuthorityPolicyRecipe, authorityValid, policyDecisionComplete,
 * recipeSignedAndFresh)`, which is what the three "fresh" booleans report: re-entry from `REAPPEARED` needs a
 * NEW authority, policy decision and recipe rather than the ones the earlier removal used. They are CONSTANTS
 * of the contract — the same for every reappearance — and are reported per row because §5.11.2 requires
 * `reentry` on every row, so a client reading one row learns the rule without a second request.
 */
export interface ReentryRules {
  readonly requiresFreshAuthority: boolean;
  readonly requiresFreshPolicyDecision: boolean;
  readonly requiresFreshRecipe: boolean;
  /**
   * Whether the prior removal's evidence survives the reappearance.
   *
   * `true`, because nothing removes it: the reappearance links `prior_removed_event_id` and the audit trail
   * is append-only (VG-EVIDENCE-003), which is what VG-REAPPEAR-002 means by "historical actions remain
   * explainable". It is a statement about the SCHEMA rather than about a guard, which is why T18's guard list
   * does not contain it.
   */
  readonly preservesPriorEvidence: boolean;
}

/** The one value every row reports, since the rules are the contract's. */
export const REENTRY_RULES: ReentryRules = Object.freeze({
  requiresFreshAuthority: true,
  requiresFreshPolicyDecision: true,
  requiresFreshRecipe: true,
  preservesPriorEvidence: true,
});

/** §5.10.3's independence attestation. */
export interface Independence {
  readonly actingPathId: string | null;
  readonly observationPathId: string | null;
  readonly distinct: boolean;
  readonly actorDistinct: boolean;
}

/**
 * The finding vocabulary the API reports, and the mapping onto the column's.
 *
 * THE TWO VOCABULARIES DIFFER, and the read route translates rather than exposing the difference:
 * `verification_observation.finding` is `CHECK (finding IN ('PRESENT','ABSENT','INCONCLUSIVE'))`
 * (migration 0004:143), while SPEC-003 §5.10.1's request takes
 * `RECORD_ABSENT|RECORD_PRESENT|INDETERMINATE`. A client that WRITES with one vocabulary and READS another
 * would have to know both, so the read reports the API's tokens — the same ones the write route accepts.
 *
 * The mapping is 1:1 and both sides are named by a specification, so this is a translation rather than an
 * invention. `toApiFinding` REFUSES an unmapped stored value instead of passing it through: a passthrough would
 * put a token on the wire that the API's own write route cannot accept, and a test asserts the mapping is
 * total over the column's declared set so a new token fails there rather than in a response.
 */
export const FINDING_TO_API: Readonly<Record<string, string>> = Object.freeze({
  PRESENT: 'RECORD_PRESENT',
  ABSENT: 'RECORD_ABSENT',
  INCONCLUSIVE: 'INDETERMINATE',
});

/** The column's declared finding vocabulary, so the mapping's totality can be asserted. */
export const STORED_FINDINGS: readonly string[] = Object.keys(FINDING_TO_API);

/**
 * A §5.10.2/§5.10.3 row.
 *
 * `evidenceArtifactId` is NOT nullable: the column is `uuid NOT NULL`, and reporting a null an API client must
 * handle would describe a state the database cannot store.
 */
export interface VerificationObservationRow {
  readonly verificationObservationId: string;
  readonly caseId: string;
  /** The stored method, reported VERBATIM — the column has no CHECK and the seed's token is not the API's. */
  readonly method: string;
  readonly observedAt: string;
  readonly actorIdentity: string;
  readonly actingIdentity: string;
  /** The API's finding token, via `FINDING_TO_API`. */
  readonly finding: string;
  readonly evidenceArtifactId: string;
  readonly independence: Independence;
}

/** A §5.11.2/§5.11.3 row. Both evidence and prior-event references are NOT NULL in the schema. */
export interface ReappearanceRow {
  readonly reappearanceId: string;
  readonly exposureId: string;
  readonly priorRemovedEventId: string;
  readonly observedAt: string;
  readonly evidenceArtifactId: string;
  readonly observationMethod: string | null;
  /** The exposure's truth state NOW, taken verbatim — never a state inferred from this row. */
  readonly exposureTruthState: string;
  readonly reentry: ReentryRules;
}

/**
 * The `reEntryState` filter's three tokens, mapped onto the exposure's truth state.
 *
 * A READING, recorded in `ASSUMPTIONS.md` §3.26 because SPEC-003 §5.11.2 names the three tokens without
 * defining them. The partition is "has re-entry happened yet": a reappearance still waiting to re-enter is
 * `REAPPEARED`; one whose case was resolved as non-removable is `NOT_REMOVABLE`; anything else means re-entry
 * has produced progress, which is `REENTERED`.
 */
export const RE_ENTRY_STATE_SQL: Readonly<Record<string, string>> = Object.freeze({
  PENDING_REENTRY: `(e.truth_state = 'REAPPEARED')`,
  NOT_REMOVABLE: `(e.truth_state = 'NOT_REMOVABLE')`,
  REENTERED: `(e.truth_state NOT IN ('REAPPEARED', 'NOT_REMOVABLE'))`,
});

export interface ReappearanceFilters {
  readonly subjectId?: string;
  readonly sourceId?: string;
  readonly reEntryState?: string | readonly string[];
  readonly fromMs: number;
  readonly toMs: number;
}

export interface ListReappearancesParams {
  readonly limit: number;
  readonly sort: string;
  readonly filters: ReappearanceFilters;
  readonly after?: { readonly sortValue: string; readonly id: string };
}

export interface ObservationQueries {
  /** Whether the case exists for this tenant, for the 404 path on a case sub-resource route. */
  caseExists(tx: TenantTransaction, caseId: string): Promise<boolean>;
  /** §5.10.2 — observations for a case, newest first, retained forever. */
  listVerificationObservations(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<readonly VerificationObservationRow[]>;
  /** §5.10.3 — one observation, `undefined` for absent and another tenant's alike (SPEC-006 H-9). */
  getVerificationObservation(
    tx: TenantTransaction,
    verificationObservationId: string,
  ): Promise<VerificationObservationRow | undefined>;
  /** Whether the exposure exists for this tenant. */
  exposureExists(tx: TenantTransaction, exposureId: string): Promise<boolean>;
  /** §5.11.2 — the tenant-wide list, keyset-paginated, fetching `limit + 1` so the caller learns `hasMore`. */
  listReappearances(
    tx: TenantTransaction,
    params: ListReappearancesParams,
  ): Promise<readonly ReappearanceRow[]>;
  /** §5.11.3 — one exposure's reappearance history, OLDEST first. */
  listReappearancesForExposure(
    tx: TenantTransaction,
    exposureId: string,
  ): Promise<readonly ReappearanceRow[]>;
}
