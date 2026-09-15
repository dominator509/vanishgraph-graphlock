/**
 * The appeal-escalation model the HTTP layer depends on (SPEC-003 §5.14, ARCHITECTURE.md §2).
 *
 * WHY THIS EXISTS, as with `subject-queries.ts` and `source-queries.ts`: `src/http/**` must not import
 * `src/adapters/**`, so the §5.14 handlers depend on THIS interface and the composition root wires the
 * PostgreSQL implementation in.
 *
 * WHAT §5.14 IS, in the specification's own terms: it "serves SPEC-000 §8 priority 7 / VG-CHANNEL-001",
 * and its content is "counsel-review territory, not an API decision". That shapes the port rather than
 * decorating it — the API records that an escalation exists and that counsel must look at it, and it
 * refuses to treat one as sendable while that review is pending. Nothing here decides legal sufficiency,
 * and no method accepts a citation, a legal theory, or a sending destination: those are exactly the
 * fields §10 says no `/v1` route may take.
 *
 * NOTHING HERE DECIDES A TRUTH STATE. An `AppealEscalation` does not move a case's truth state — §5.14.1
 * says creating the record "does not send anything", and sending is a separate §5.8.2 action with its own
 * idempotency key. So this port has no transition to record and no `truthState` to assign. The `truthState`
 * it reads off the case exists only to build the §2.7 ETag.
 *
 * THE TENANT IS NOT A PARAMETER. Every method runs inside a `TenantTransaction` the runner already scoped
 * with `app.tenant_id`, and the tables carry FORCE RLS. A second, application-level `WHERE tenant_id = …`
 * would MASK a broken policy rather than complement it (VG-TENANT-002).
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** The review states the API can record. Exactly the one SPEC-003 §5.14.1 names. */
export type ReviewState = 'PENDING_COUNSEL_REVIEW';

/** The four kinds §5.14.1 accepts, in the specification's order. */
export const APPEAL_KINDS = [
  'CONTROLLER_APPEAL',
  'REGULATOR_COMPLAINT',
  'ATTORNEY_LETTER',
  'PROVIDER_ESCALATION',
] as const;

export type AppealKind = (typeof APPEAL_KINDS)[number];

/** Whether a kind is one the closed set accepts. */
export function isAppealKind(value: unknown): value is AppealKind {
  return typeof value === 'string' && (APPEAL_KINDS as readonly string[]).includes(value);
}

/** One §5.14.2/§5.14.3 row. */
export interface AppealEscalationRow {
  readonly appealEscalationId: string;
  readonly caseId: string;
  readonly kind: string;
  readonly requiresHumanReview: boolean;
  readonly reviewState: ReviewState;
  readonly artifactIds: readonly string[];
  readonly createdAt: string;
}

/**
 * The case facts §5.14.1 needs before it may create an escalation.
 *
 * `truthState` and `updatedAtMs` are read together because they are the two components of the §2.7 ETag
 * this route's `If-Match` is checked against — read separately they could come from different row
 * versions, and the precondition would then be checked against a token the resource never had.
 */
export interface CasePrecondition {
  readonly caseId: string;
  readonly truthState: string;
  readonly updatedAtMs: number;
}

export interface CreateAppealInput {
  readonly kind: AppealKind;
  readonly requiresHumanReview: boolean;
  readonly artifactIds: readonly string[];
  readonly templateVersion: string;
  readonly templateHash: string;
  readonly recipientControllerId: string | null;
}

/**
 * The appeal-escalation model.
 *
 * A port rather than a concrete class so the handler depends on behaviour it can be tested against — and
 * so the `tests/contract` suite can assert the REFUSALS without a database, which is where the interesting
 * rules are.
 */
export interface AppealQueries {
  /** The case's current truth state and `updatedAt`, for the `If-Match` precondition. `undefined` if absent. */
  casePrecondition(tx: TenantTransaction, caseId: string): Promise<CasePrecondition | undefined>;
  /**
   * Whether the case's appeal window has closed.
   *
   * SPEC-003 §5.14.1 lists `409 APPEAL_WINDOW_CLOSED` without defining the window. The reading taken here:
   * a case with an `APPEAL_WINDOW` deadline whose `due_at` has passed has a closed window, and a case with
   * NO such deadline has no window to close and is therefore not refused. Inverting the second half would
   * make every escalation on a case that never had a deadline fail, which the specification's error list
   * does not describe.
   */
  appealWindowClosed(tx: TenantTransaction, caseId: string, nowMs: number): Promise<boolean>;
  /** §5.14.2 — escalations for a case, newest first. */
  listAppealEscalations(tx: TenantTransaction, caseId: string): Promise<readonly AppealEscalationRow[]>;
  /** §5.14.3 — one escalation, `undefined` for absent and another tenant's alike (SPEC-006 H-9). */
  getAppealEscalation(tx: TenantTransaction, appealEscalationId: string): Promise<AppealEscalationRow | undefined>;
  /**
   * §5.14.1 — create the escalation record, and NOTHING else.
   *
   * The two refusals this method can return are the ones that need data: the case being absent, and its
   * window having closed. Everything else §5.14.1 refuses (a missing template hash, zero artifacts, a
   * review flag the kind mandates) is decisionless validation and belongs at the boundary, where it is
   * testable without a database and refuses before any transaction is opened.
   */
  createAppealEscalation(
    tx: TenantTransaction,
    caseId: string,
    input: CreateAppealInput,
  ): Promise<
    | { readonly ok: true; readonly value: { readonly appealEscalationId: string; readonly createdAt: string } }
    | { readonly ok: false; readonly reason: 'CASE_NOT_FOUND' | 'WINDOW_CLOSED' }
  >;
}
