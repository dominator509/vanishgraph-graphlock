/**
 * The deadline model the HTTP layer depends on (SPEC-003 §5.13, ARCHITECTURE.md §2).
 *
 * WHY THIS EXISTS, as with the other contract files: `src/http/**` must not import `src/adapters/**`, so
 * the §5.13 handlers depend on THIS interface and the composition root wires the PostgreSQL
 * implementation in.
 *
 * DEADLINES ARE DERIVED FROM VERSIONED DATA, NEVER HARD-CODED (SPEC-001 §3.4, VG-POLICY-001). SPEC-003
 * §5.13.1 states the consequence as a rule rather than a nicety: "Every deadline names the policy version
 * and rule code it was derived from." So `derivedFrom` is not decoration — it is the evidence that a
 * duration came from policy data. This port therefore reads it from the case's own `PolicyDecision`, which
 * is the versioned record that made the case actionable, rather than from a code constant:
 *
 *   * `policyVersion` ← `policy_decision.policy_version` — the version in force when the case was decided;
 *   * `ruleCode`      ← `policy_decision.legal_basis` — the policy RULE the deadline derives from
 *                        (VG-POLICY-001's rules are legal-basis tokens; the seeded policy's `rules` array
 *                        is `['CCPA_DELETE']`, which is the same token space);
 *
 * WHERE THE SPECIFICATION DOES NOT SAY. SPEC-003 §5.13.1 names `derivedFrom{policyVersion, ruleCode}`
 * without saying which record supplies them. Reading them from the case's `PolicyDecision` is the only
 * source of versioned policy data already bound to the case, and it needs no new column; the alternative
 * would be a second policy lookup whose result could disagree with the decision the case was actually
 * authorised under. Recorded in `ASSUMPTIONS.md` §3.23.
 *
 * `state` IS DERIVED, NOT STORED, for the same reason `writesEnabled` is derived in §5.3: three of its four
 * values change with the clock, so a stored copy would go wrong without anyone writing to it. `WAIVED` is
 * unreachable — no route waives a deadline and no specification defines a waiver — and is recorded as such
 * rather than given a column nothing writes.
 *
 * NOTHING HERE DECIDES A TRUTH STATE. §5.13.3 says satisfying a deadline "is not a removal outcome and
 * produces no truth-state change by itself", so no method assigns one. The `truthState` this port reads
 * exists only to build the §2.7 case ETag.
 *
 * THE TENANT IS NOT A PARAMETER: every method runs inside a `TenantTransaction` already scoped with
 * `app.tenant_id`, and `deadline` carries FORCE RLS.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** The five deadline kinds §5.13.1 accepts, in the specification's order. */
export const DEADLINE_KINDS = [
  'CONTROLLER_RESPONSE',
  'APPEAL_WINDOW',
  'VERIFICATION_WINDOW',
  'MAIL_RESPONSE',
  'REGULATOR_ESCALATION',
] as const;

export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

export function isDeadlineKind(value: unknown): value is DeadlineKind {
  return typeof value === 'string' && (DEADLINE_KINDS as readonly string[]).includes(value);
}

/**
 * The out-of-band inputs §5.13.2 may record.
 *
 * A closed set of ONE, because `CONTROLLER_STATED_DATE` is the only token any specification names. NULL —
 * meaning "derived from policy alone" — is the absence of an input, not a third member.
 */
export const DEADLINE_SOURCES = ['CONTROLLER_STATED_DATE'] as const;
export type DeadlineSource = (typeof DEADLINE_SOURCES)[number];

export function isDeadlineSource(value: unknown): value is DeadlineSource {
  return typeof value === 'string' && (DEADLINE_SOURCES as readonly string[]).includes(value);
}

/** The derived states §5.13.1 reports. `WAIVED` is admitted by the contract and unreachable here. */
export type DeadlineState = 'OPEN' | 'SATISFIED' | 'BREACHED' | 'WAIVED';

/**
 * The §5.13.1 `state`, derived from the two instants the deadline table stores.
 *
 * IT LIVES HERE, IN THE CONTRACT, rather than in the adapter, for two reasons. It is a rule about the
 * CONTRACT's vocabulary — which of the four tokens a given pair of instants produces — so it belongs with
 * the type that declares them; and keeping it here means `tests/contract` can assert it without a database,
 * while the adapter delegates to this one definition instead of holding a second copy that could drift.
 *
 * ORDER IS THE SEMANTICS: a satisfied deadline is SATISFIED whatever the clock says. A deadline met LATE is
 * still met, and reporting it BREACHED afterwards would rewrite history. Only an unsatisfied deadline can be
 * BREACHED, and only once its due instant has passed.
 *
 * `WAIVED` IS UNREACHABLE AND THAT IS THE HONEST ANSWER: producing it would need a waiver fact no
 * specification defines and no `/v1` route records. The union admits the token because §5.13.1 lists it;
 * this function can never return it, and a test asserts that across a grid of inputs. A caller seeing one
 * would be reading a row written outside the API — which is exactly the case a derived field must not
 * fabricate.
 */
export function deriveState(
  satisfiedAtMs: number | null,
  dueAtMs: number,
  nowMs: number,
): DeadlineState {
  if (satisfiedAtMs !== null) return 'SATISFIED';
  return dueAtMs < nowMs ? 'BREACHED' : 'OPEN';
}

/**
 * `overdueSeconds`: how late an UNSATISFIED deadline is, and 0 otherwise. Never negative.
 *
 * A satisfied deadline reports 0 because it is no longer overdue — the field answers "how overdue is this",
 * not "how late was it met", and those are different questions with different data (the second would need
 * the due instant and the satisfaction instant compared, which `state` already conveys).
 */
export function overdueSeconds(
  satisfiedAtMs: number | null,
  dueAtMs: number,
  nowMs: number,
): number {
  if (satisfiedAtMs !== null) return 0;
  return Math.max(0, Math.floor((nowMs - dueAtMs) / 1000));
}

/** The policy provenance §5.13.1 reports on every deadline. */
export interface DeadlineProvenance {
  readonly policyVersion: string;
  readonly ruleCode: string;
}

/** One §5.13.1 row. */
export interface DeadlineRow {
  readonly deadlineId: string;
  readonly caseId: string;
  readonly kind: string;
  readonly dueAt: string;
  readonly derivedFrom: DeadlineProvenance;
  readonly state: DeadlineState;
  readonly satisfiedAt: string | null;
  readonly overdueSeconds: number;
}

/** The case facts §5.13.2's `If-Match` needs, plus the policy provenance every deadline must carry. */
export interface CaseDeadlineContext {
  readonly caseId: string;
  readonly truthState: string;
  readonly updatedAtMs: number;
  /** `undefined` when the case has no policy decision, which makes a deadline's provenance unnameable. */
  readonly provenance: DeadlineProvenance | undefined;
}

export interface CreateDeadlineInput {
  readonly kind: DeadlineKind;
  readonly dueAtMs: number;
  readonly source: DeadlineSource;
  readonly evidenceArtifactId: string;
  /** `policy:<version>`, which is what `deadline.derivation_ref`'s CHECK requires. */
  readonly derivationRef: string;
}

export interface SatisfyDeadlineInput {
  readonly satisfiedAtMs: number;
  readonly satisfiedBy: string;
  readonly evidenceArtifactId: string;
}

/**
 * The deadline model.
 *
 * `createDeadline` and `satisfyDeadline` return DISCRIMINATED reasons rather than throwing, so the two
 * refusals that need data (`EVIDENCE_NOT_FOUND`, `DEADLINE_ALREADY_SATISFIED`) stay distinguishable from a
 * genuine fault. The decisionless refusals — a missing `source`, a past `dueAt` — belong at the boundary,
 * where they refuse before a transaction is opened and are testable without a database.
 */
export interface DeadlineQueries {
  /** The case's truth state, `updatedAt` and policy provenance; `undefined` for absent or another tenant. */
  caseDeadlineContext(tx: TenantTransaction, caseId: string): Promise<CaseDeadlineContext | undefined>;
  /** Whether an evidence artifact exists in this tenant, for `422 EVIDENCE_NOT_FOUND`. */
  evidenceExists(tx: TenantTransaction, evidenceArtifactId: string): Promise<boolean>;
  /** §5.13.1 — deadlines for a case, soonest first, with their derived state. */
  listDeadlines(tx: TenantTransaction, caseId: string, nowMs: number): Promise<readonly DeadlineRow[]>;
  /** §5.13.2 — record an out-of-band deadline. */
  createDeadline(
    tx: TenantTransaction,
    caseId: string,
    input: CreateDeadlineInput,
  ): Promise<
    | { readonly ok: true; readonly value: { readonly deadlineId: string } }
    | { readonly ok: false; readonly reason: 'CASE_NOT_FOUND' | 'EVIDENCE_NOT_FOUND' | 'NO_PROVENANCE' }
  >;
  /** §5.13.3 — mark a deadline satisfied. */
  satisfyDeadline(
    tx: TenantTransaction,
    deadlineId: string,
    input: SatisfyDeadlineInput,
  ): Promise<
    | {
        readonly ok: true;
        readonly value: { readonly deadlineId: string; readonly satisfiedAt: string };
      }
    | { readonly ok: false; readonly reason: 'NOT_FOUND' | 'ALREADY_SATISFIED' | 'EVIDENCE_NOT_FOUND' }
  >;
  /**
   * Derive the §5.13.1 `state` for a row.
   *
   * Exported as a METHOD rather than inlined in the query so the derivation is one definition the route
   * and the tests share, and so the unreachability of `WAIVED` is visible at the single place a state is
   * produced.
   */
  deriveState(satisfiedAtMs: number | null, dueAtMs: number, nowMs: number): DeadlineState;
}
