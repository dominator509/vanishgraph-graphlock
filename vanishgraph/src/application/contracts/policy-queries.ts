/**
 * Policy decisions and jurisdiction policies (SPEC-003 §5.6.1–§5.6.4).
 *
 * `policyVersion` IS A LABEL ON THE WIRE AND AN ORDINAL IN THE SCHEMA. §5.6.1's request carries
 * `"policyVersion": "2026-01-15"` and takes it as INPUT that must MATCH; `jurisdiction_policy.version` is an
 * `integer` under `UNIQUE (tenant_id, jurisdiction, version)`. Migration `0028` adds the label alongside the
 * ordinal, and this port uses the LABEL on the wire and the ORDINAL for ordering and uniqueness. A decision
 * stores the label it resolved under (`policy_decision.version_label`), so a later edit to the policy row cannot
 * rewrite what the decision says it resolved against.
 *
 * THE LEGAL BASIS IS CHOSEN BY THE POLICY VERSION, AND A VERSION THAT DECLARES SEVERAL RULES IS REFUSED.
 * §5.6.1 refuses `422 LEGAL_BASIS_NOT_AUTHORABLE` any body that asserts a `legalBasis` of its own ("the API
 * additionally rejects any request body containing a `legalBasis` field the caller asserts rather than
 * references"), so the basis must come from policy data. NO specification maps a channel to a basis: the request
 * names a jurisdiction and a channel, and the policy version declares a RULE SET. A version that declares
 * exactly one rule names its basis unambiguously; a version that declares several does not, and the API refuses
 * `422 LEGAL_BASIS_NOT_IN_POLICY_VERSION` NAMING the rules rather than picking one — choosing would be the API
 * stating a legal conclusion of its own, which §5.6.1's closing paragraph forbids.
 *
 * THE EXEMPTION EVALUATION IS REPORTED AS NOT PERFORMED. §5.6.1's example shows
 * `exemptionEvaluation: {evaluated: true, exempt: false, checks: [...]}`, and no specification declares the check
 * list — `PUBLIC_RECORD` and `FCRA` appear only inside that example. So the response says
 * `{evaluated: false, exempt: null, checks: []}`: the field is present so a client can tell "not evaluated" from
 * "missing", and the API does not invent an exemption analysis it cannot perform.
 *
 * NO ROUTE HERE MOVES A TRUTH STATE. `resolvePolicy` returns a `CommandResult` with no transition (§5.6.1's
 * response carries no `truthState`), so a decision is recorded and audited without touching the state machine.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** One §5.6.1/§5.6.3 decision, as the wire reports it. */
export interface PolicyDecisionRow {
  readonly policyDecisionId: string;
  readonly caseId: string;
  readonly jurisdiction: string;
  readonly legalBasis: string;
  readonly channel: string;
  /** The LABEL, which is the date string §5.6.1's request and response carry. */
  readonly policyVersion: string | null;
  readonly reasons: readonly string[];
  readonly decidedAt: string;
  readonly exemptionEvaluation: {
    readonly evaluated: false;
    readonly exempt: null;
    readonly checks: readonly never[];
  };
}

/** One §5.6.4 jurisdiction-policy row. */
export interface JurisdictionPolicyRow {
  readonly policyVersion: string;
  readonly jurisdiction: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly inForce: boolean;
  readonly ruleCount: number;
  /**
   * A digest of the version's RULE SET, computed at read time.
   *
   * COMPUTED, not stored: a stored checksum can drift from the rules it digests, and the drift would be
   * invisible — the one thing a checksum must not do. It is a SHA-256 over the rules in their stored order, so
   * a reordering or an edit changes it, which is what "policyChecksum" is for in §5.6.4.
   */
  readonly policyChecksum: string;
}

/** One channel alternative the caller considered (§5.6.1's `channelAlternativesConsidered`). */
export interface ChannelAlternative {
  readonly channel: string;
  readonly unavailable: boolean;
  readonly reason: string | null;
}

/** Everything §5.6.1 needs. */
export interface ResolvePolicyRequest {
  readonly caseId: string;
  readonly expectedRowVersionMs: number;
  readonly jurisdiction: string;
  readonly requestedChannel: string;
  readonly policyVersionLabel: string | null;
  readonly alternatives: readonly ChannelAlternative[];
  readonly correlationId: string;
  readonly nowMs: number;
}

export type ResolvePolicyOutcome =
  | { readonly ok: true; readonly response: PolicyDecisionRow }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' }
  | {
      readonly ok: false;
      readonly reason: 'PRECONDITION_FAILED';
      readonly currentRowVersionMs: number;
      readonly truthState: string;
    }
  | { readonly ok: false; readonly reason: 'CASE_AUTHORITY_INVALID' }
  | { readonly ok: false; readonly reason: 'STRICT_LANE_REQUIRED' }
  | { readonly ok: false; readonly reason: 'JURISDICTION_UNRESOLVED' }
  | { readonly ok: false; readonly reason: 'POLICY_VERSION_SUPERSEDED'; readonly inForceLabel: string | null }
  | { readonly ok: false; readonly reason: 'POLICY_VERSION_UNNAMED' }
  | {
      readonly ok: false;
      readonly reason: 'LEGAL_BASIS_NOT_IN_POLICY_VERSION';
      readonly rules: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'CHANNEL_PRIORITY_VIOLATION';
      readonly availableHigherPriority: string;
    };

export interface ListPoliciesParams {
  readonly jurisdiction: string | null;
  readonly inForceOnMs: number;
  readonly includeSuperseded: boolean;
}

export interface PolicyQueries {
  resolvePolicyDecision(tx: TenantTransaction, request: ResolvePolicyRequest): Promise<ResolvePolicyOutcome>;
  /** §5.6.2 — a case's decisions, newest first, all versions retained. */
  listPolicyDecisions(tx: TenantTransaction, caseId: string): Promise<readonly PolicyDecisionRow[]>;
  /** §5.6.3 — one decision with its full reason list. */
  getPolicyDecision(tx: TenantTransaction, policyDecisionId: string): Promise<PolicyDecisionRow | undefined>;
  /** §5.6.4 — jurisdiction policy versions, in force or all. */
  listJurisdictionPolicies(
    tx: TenantTransaction,
    params: ListPoliciesParams,
  ): Promise<readonly JurisdictionPolicyRow[]>;
  /** The §2.7 concurrency token for a case, or `undefined` when it does not exist. */
  caseRowVersion(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<{ readonly rowVersionMs: number; readonly truthState: string } | undefined>;
}

/** The channel priority order the domain uses, re-exported so the route can name a violation's channel. */
export { CHANNEL_NAMES } from '../../domain/values.ts';
