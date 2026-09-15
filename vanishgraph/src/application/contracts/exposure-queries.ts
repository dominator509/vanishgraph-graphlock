/**
 * Exposures and match assessment (SPEC-003 §5.5.1–§5.5.4).
 *
 * WHAT AN EXPOSURE IS. SPEC-001:70: "`Exposure` | id, subjectId, sourceRecordId, confidence, truthState,
 * caseId | confidence with basis; one current truth state". It is the point where a PERMITTED READ PATH
 * observed a record that may match the protected subject (T1), and it is the only place a match is ever
 * asserted — §5.4.2's discovery route returns candidate records and "never a matched-subject assertion",
 * because `SEARCH_HIT` is not `SUBJECT_MATCH` (VG-IDENT-004).
 *
 * THE FOUR ROUTES AND THE ONE THING THEY SHARE. §5.5.1/§5.5.2 read; §5.5.3/§5.5.4 are guarded
 * assessments that drive T3 and T4. All four are about the SAME state machine row, so all four go through
 * one port: a second read path would be a second definition of `confidence` (specifically of whether the
 * basis travels with the score), and VG-IDENT-003 exists because a score without its basis is how a
 * threshold decision becomes unsupportable.
 *
 * `confidence` IS ALWAYS AN OBJECT, NEVER A NUMBER, and the row type says so. SPEC-003 §5.5.1: "a score
 * without `basis` is unrepresentable". The column pair that backs it is `confidence` +
 * `confidence_basis jsonb NOT NULL CHECK (jsonb_array_length(confidence_basis) > 0)` (migration 0003), so
 * the database refuses an empty basis as well as this port.
 *
 * THE THRESHOLD COMES FROM POLICY DATA, AND A POLICY THAT RECORDS NONE IS NOT A THRESHOLD OF ONE.
 * §5.5.3 evaluates T3's guard (`Confidence` ≥ policy threshold, SPEC-001:115) and returns
 * `policyThresholdApplied`. No specification gives that number a value, so it is read from the in-force
 * `jurisdiction_policy` row for the subject's jurisdiction — the versioned policy data SPEC-000 §3 makes
 * authoritative — and when that row records no threshold the assessment is REFUSED with
 * `JURISDICTION_UNRESOLVED` rather than evaluated against a number chosen here. A fabricated threshold
 * would be an implementer picking a legal parameter of the product.
 *
 * THE TENANT IS NOT A PARAMETER: every method runs inside a `TenantTransaction` scoped with `app.tenant_id`,
 * and every table read carries FORCE RLS.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** One feature in a confidence basis (SPEC-003 §5.5.1's `{feature, weight}`). */
export interface ConfidenceBasisEntry {
  readonly feature: string;
  readonly weight: number;
}

/** A score WITH its basis. The basis is non-empty by construction (§5.5.1, VG-IDENT-003). */
export interface ConfidenceValue {
  readonly value: number;
  readonly basis: readonly ConfidenceBasisEntry[];
}

/** A §5.5.1 list row. */
export interface ExposureListRow {
  readonly exposureId: string;
  readonly subjectRef: string;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly truthState: string;
  readonly confidence: ConfidenceValue;
  /** The live case for this exposure, or `null` when none exists (§5.7.1 creates at most one). */
  readonly caseRef: string | null;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

/** The policy decision summary §5.5.2 reports, or `null` when the case has none yet. */
export interface PolicyDecisionSummary {
  readonly policyDecisionId: string;
  readonly jurisdiction: string;
  readonly legalBasis: string;
  readonly channel: string;
  readonly policyVersion: string;
  readonly decidedAt: string;
}

/**
 * What §5.5.2 says about the case's recipe.
 *
 * `signed` is deliberately ABSENT. Verifying a recipe signature needs a public key for the recipe's
 * `signingKeyRef`, and no production key exists (ADR-006 OPEN), so a `signed` boolean here would be either
 * a claim the service cannot support or a constant. §5.3.7's recipe route reports verification honestly by
 * refusing when no key is configured; this summary reports only what the row carries.
 */
export interface RecipeReadinessSummary {
  readonly recipeId: string;
  readonly version: number;
  readonly enabled: boolean;
  readonly freshnessAt: string;
  /** Whether `freshness_at` is still in the future, computed at read time. */
  readonly fresh: boolean;
}

/** A deadline attached to the exposure's case (§5.5.2's `deadlines`). */
export interface ExposureDeadline {
  readonly deadlineId: string;
  readonly kind: string;
  readonly dueAt: string;
  readonly state: string;
}

/** The external-action summary §5.5.2 reports: a count and the most recent outcome. */
export interface ExternalActionSummary {
  readonly count: number;
  readonly latestOutcome: string | null;
}

/** §5.5.2's detail: the list row plus the case's policy, recipe, deadlines, reappearance and actions. */
export interface ExposureDetail extends ExposureListRow {
  /** The instant the current truth state came into effect. */
  readonly truthStateChangedAt: string;
  /** The row's own version, used for the §2.7 `ETag`. Never serialised into a body. */
  readonly rowVersionMs: number;
  readonly policyDecision: PolicyDecisionSummary | null;
  readonly recipeReadiness: RecipeReadinessSummary | null;
  readonly deadlines: readonly ExposureDeadline[];
  /** The prior removal event this exposure reappeared from, or `null` (§5.5.2). */
  readonly reappearanceOf: string | null;
  readonly externalActions: ExternalActionSummary;
}

/** §5.5.1's filters. A member absent from the query is absent here, never defaulted. */
export interface ExposureFilters {
  readonly subjectId?: string;
  readonly sourceId?: string;
  readonly truthState?: string | readonly string[];
  readonly minConfidence?: number;
  readonly from?: string;
  readonly to?: string;
}

export interface ListExposuresParams {
  readonly limit: number;
  readonly sort: string;
  readonly filters: ExposureFilters;
  readonly after?: { readonly sortValue: string; readonly id: string };
}

/** The outcome of an assessment write. Every refusal names a condition, never a silent no-op. */
export type AssessmentOutcome =
  | { readonly ok: true; readonly response: AssessmentResponse }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' }
  | {
      readonly ok: false;
      readonly reason: 'PRECONDITION_FAILED';
      readonly currentRowVersionMs: number;
      readonly truthState: string;
    }
  | { readonly ok: false; readonly reason: 'ILLEGAL_TRANSITION'; readonly fromTruthState: string }
  | { readonly ok: false; readonly reason: 'EVIDENCE_NOT_FOUND' }
  | { readonly ok: false; readonly reason: 'IDENTITY_CLASS_MISMATCH' }
  | { readonly ok: false; readonly reason: 'THRESHOLD_UNRESOLVED'; readonly jurisdiction: string };

/**
 * §5.5.3's success body.
 *
 * A below-threshold assessment is a 200 with `belowThreshold: true`, `assessmentRecorded: true` and NO
 * `transitionId`, because no transition occurred — §5.5.3 says the response "says so plainly", and a
 * `transitionId` field here would be the response failing to say it.
 */
export interface AssessmentResponse {
  readonly exposureId: string;
  readonly truthState: string;
  readonly confidence: ConfidenceValue;
  readonly policyThresholdApplied: number;
  readonly transitionId?: string;
  readonly belowThreshold?: boolean;
  readonly assessmentRecorded?: boolean;
}

/** §5.5.4's success body. */
export interface DisproofResponse {
  readonly exposureId: string;
  readonly truthState: string;
  readonly coverageBounds: { readonly sourcesAttempted: number; readonly sourcesTotal: number };
  readonly transitionId?: string;
}

/** Everything a §5.5.3 write needs, with the precondition already reduced to the row version it expects. */
export interface MatchAssessmentRequest {
  readonly exposureId: string;
  readonly expectedRowVersionMs: number;
  readonly confidence: ConfidenceValue;
  readonly method: string;
  readonly humanReviewed: boolean;
  readonly evidenceArtifactId: string | null;
  readonly correlationId: string;
  readonly nowMs: number;
}

/** Everything a §5.5.4 write needs. */
export interface DisproofRequest {
  readonly exposureId: string;
  readonly expectedRowVersionMs: number;
  readonly disproofBasis: string;
  readonly evidenceArtifactId: string;
  readonly scanComplete: boolean;
  readonly coverageBounds: { readonly sourcesAttempted: number; readonly sourcesTotal: number };
  readonly correlationId: string;
  readonly nowMs: number;
}

export type DisproofOutcome =
  | { readonly ok: true; readonly response: DisproofResponse }
  | Exclude<AssessmentOutcome, { readonly ok: true }>;

/**
 * The source class SPEC-003 §5.5.3 names in `409 IDENTITY_CLASS_MISMATCH`: "a search-engine-class source
 * record cannot enter a removal path" (VG-IDENT-004).
 *
 * NO SPECIFICATION ENUMERATES THE CLASS VOCABULARY — `source.class` is free text (migration 0003) and the
 * only token anywhere is the prose phrase "search-engine-class". So the comparison is against the one token
 * the contract names, stated once here rather than spelled inline at each check, and it is compared exactly:
 * a class of `SEARCH_ENGINE_ADS` is a different class until a specification says otherwise.
 */
export const SEARCH_ENGINE_SOURCE_CLASS = 'SEARCH_ENGINE';

/** The read and write surface of §5.5. */
export interface ExposureQueries {
  listExposures(tx: TenantTransaction, params: ListExposuresParams): Promise<readonly ExposureListRow[]>;
  getExposureDetail(tx: TenantTransaction, exposureId: string): Promise<ExposureDetail | undefined>;
  /** The §2.7 ETag precondition value for one exposure, or `undefined` when it does not exist. */
  exposureRowVersion(
    tx: TenantTransaction,
    exposureId: string,
  ): Promise<{ readonly rowVersionMs: number; readonly truthState: string } | undefined>;
  recordMatchAssessment(tx: TenantTransaction, request: MatchAssessmentRequest): Promise<AssessmentOutcome>;
  recordDisproof(tx: TenantTransaction, request: DisproofRequest): Promise<DisproofOutcome>;
}
