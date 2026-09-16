/**
 * Controller responses and email threads (SPEC-003 §5.9.1–§5.9.3).
 *
 * `CLAIMED_OUTCOME_IS_ALWAYS_FALSE`, AND THAT IS THE POINT OF THE GROUP. §5.9.1: "A `ControllerResponse` is a
 * claim, not an observation (SPEC-001 §3.4, VG-VERIFY-004). `claimedOutcome: "DELETED"` moves the case to
 * `ACKNOWLEDGED` and **never** to `VERIFIED_REMOVED` … the response carries `claimedOutcomeIsObservation: false`
 * so no consumer can collapse the two." The field is therefore a CONSTANT of the contract, reported on every
 * write and every list row, and it is not stored: a stored boolean could be flipped by a later writer, and the
 * one thing this field must never become is `true`.
 *
 * THE CLAIM'S VOCABULARY HAS ITS OWN COLUMN because the delivered one cannot hold it (migration `0025`):
 * `controller_response.claimed_outcome` is typed `truth_state` while the contract's tokens are
 * `DELETED | NOT_DELETED | UNSPECIFIED`, none of which is one of the eleven states. The typed column is left
 * NULL — a truth state in a claimed-outcome field is the collapse VG-VERIFY-004 forbids, and its own comment
 * says so. Recorded in `ASSUMPTIONS.md` §3.31.
 *
 * WHAT DRIVES WHICH TRANSITION. The request's `responseKind` decides the TARGET STATE, and SPEC-001 §4.1's
 * table decides which transition reaches it FROM THE CASE'S CURRENT STATE — the two are not the same question,
 * and the code is only fixed once the state is known:
 *
 *   | `responseKind` | target state | from `REQUEST_SUBMITTED` | from `ACKNOWLEDGED` |
 *   |---|---|---|---|
 *   | `ACKNOWLEDGEMENT`, `PARTIAL_ACTION`, `CLAIMED_DELETION` | `ACKNOWLEDGED` | T11 | (no row: already there) |
 *   | `REFUSAL` (with a recorded basis) | `NOT_REMOVABLE` | **T13** | **T15** |
 *   | `NO_RESPONSE_TIMEOUT` | `NOT_REMOVABLE` | **T13** | **T15** |
 *   | `CONTROLLER_DEMANDS_IDENTITY`, `CONTROLLER_DEMANDS_AUTHORITY` | `HUMAN_REQUIRED` | T12 | T16 |
 *
 * §5.9.1's prose says a REFUSAL "drives T15" and a timeout "drives T13"; that is true of the state each is
 * normally recorded from, and the TABLE is what decides — `REQUEST_SUBMITTED → NOT_REMOVABLE` is T13 (guard
 * `exemptionRecorded`) and `ACKNOWLEDGED → NOT_REMOVABLE` is T15 (guard `lawfulRefusalFinal`). MEASURED: a test
 * asserting T15 from `REQUEST_SUBMITTED` got T13, and the expectation was what was wrong, not the code. This
 * file therefore reports the code the machine produced and never a code chosen to match the prose.
 *
 * A CLAIMED DELETION REACHES `ACKNOWLEDGED` AND STOPS THERE. It is recorded with `claimedOutcome: "DELETED"`
 * and the case does not become `VERIFIED_REMOVED`: only an independent observation (§5.10.1) may do that, and
 * the response says `verificationRequired: true` so a client knows what is still owed.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** §5.9.1's `claimedOutcome` vocabulary, and the one place it is enumerated. */
export const CLAIMED_OUTCOMES: readonly string[] = Object.freeze(['DELETED', 'NOT_DELETED', 'UNSPECIFIED']);

/** §5.9.1's `responseKind` vocabulary. */
export const RESPONSE_KINDS: readonly string[] = Object.freeze([
  'ACKNOWLEDGEMENT',
  'REFUSAL',
  'CONTROLLER_DEMANDS_IDENTITY',
  'CONTROLLER_DEMANDS_AUTHORITY',
  'PARTIAL_ACTION',
  'CLAIMED_DELETION',
  'NO_RESPONSE_TIMEOUT',
]);

/** What a `responseKind` drives. Declared, so the licence and the refusal cannot drift apart. */
export const RESPONSE_KIND_OUTCOME: Readonly<Record<string, 'ACKNOWLEDGED' | 'HUMAN_GATE' | 'REFUSED'>> =
  Object.freeze({
    ACKNOWLEDGEMENT: 'ACKNOWLEDGED',
    PARTIAL_ACTION: 'ACKNOWLEDGED',
    CLAIMED_DELETION: 'ACKNOWLEDGED',
    REFUSAL: 'REFUSED',
    NO_RESPONSE_TIMEOUT: 'REFUSED',
    CONTROLLER_DEMANDS_IDENTITY: 'HUMAN_GATE',
    CONTROLLER_DEMANDS_AUTHORITY: 'HUMAN_GATE',
  });

/** One §5.9.2 list row. */
export interface ControllerResponseRow {
  readonly controllerResponseId: string;
  readonly caseId: string;
  readonly responseKind: string;
  /** The claim, or `null` when the response claimed nothing. */
  readonly claimedOutcome: string | null;
  /** ALWAYS `false` (VG-VERIFY-004) — the contract's own constant, reported on every row. */
  readonly claimedOutcomeIsObservation: false;
  readonly bodyRef: string;
  readonly receivedAt: string;
  readonly evidenceArtifactId: string | null;
  readonly refusalBasis: string | null;
}

/** Everything §5.9.1 needs. */
export interface ControllerResponseWriteRequest {
  readonly caseId: string;
  readonly expectedRowVersionMs: number;
  readonly responseKind: string;
  readonly claimedOutcome: string;
  readonly bodyRef: string;
  readonly receivedAt: string;
  readonly evidenceArtifactId: string | null;
  readonly refusalBasis: string | null;
  readonly correlationId: string;
  readonly nowMs: number;
}

export type ControllerResponseWriteOutcome =
  | {
      readonly ok: true;
      readonly response: {
        readonly controllerResponseId: string;
        readonly caseId: string;
        readonly truthState: string;
        readonly transitionCode: string;
        readonly transitionId: string;
        readonly claimedOutcome: string;
        readonly claimedOutcomeIsObservation: false;
        readonly verificationRequired: boolean;
      };
    }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' }
  | {
      readonly ok: false;
      readonly reason: 'PRECONDITION_FAILED';
      readonly currentRowVersionMs: number;
      readonly truthState: string;
    }
  | { readonly ok: false; readonly reason: 'ILLEGAL_TRANSITION'; readonly fromTruthState: string }
  | { readonly ok: false; readonly reason: 'REFUSAL_BASIS_REQUIRED' }
  | { readonly ok: false; readonly reason: 'HUMAN_STEP_REQUIRED' }
  | { readonly ok: false; readonly reason: 'EVIDENCE_NOT_FOUND' };

/** Everything §5.9.3 needs. */
export interface EmailThreadWriteRequest {
  readonly caseId: string;
  readonly direction: string;
  readonly messageIds: readonly string[];
  readonly receivedAt: string | null;
  readonly bodyRef: string | null;
  readonly subjectHash: string | null;
  readonly correlationId: string;
  readonly nowMs: number;
}

export type EmailThreadWriteOutcome =
  | {
      readonly ok: true;
      readonly response: {
        readonly emailThreadId: string;
        readonly caseId: string;
        readonly direction: string;
        readonly messageIds: readonly string[];
        readonly receivedAt: string | null;
        /**
         * ALWAYS `null` today, and that is a fact rather than an omission: §5.9.3 says recording a thread "may
         * derive a `Deadline` from the applicable policy version", and NO specification or table declares a
         * controller-response window. `jurisdiction_policy.rules` is a list of rule CODES, not durations, so
         * there is nothing to derive a `dueAt` from. The alternative — inventing a duration — is what §5.9.3's
         * own sentence forbids ("the API never hard-codes a deadline duration").
         */
        readonly deadlineDerived: null;
      };
    }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' }
  | { readonly ok: false; readonly reason: 'EMAIL_THREAD_DUPLICATE' };

export interface ControllerResponseQueries {
  /** §5.9.1 — record a response and drive T11, T12, T13 or T15. */
  recordControllerResponse(
    tx: TenantTransaction,
    request: ControllerResponseWriteRequest,
  ): Promise<ControllerResponseWriteOutcome>;
  /** §5.9.2 — a case's responses, newest first, all retained. */
  listControllerResponses(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<readonly ControllerResponseRow[]>;
  /** §5.9.3 — attach an email thread. */
  createEmailThread(
    tx: TenantTransaction,
    request: EmailThreadWriteRequest,
  ): Promise<EmailThreadWriteOutcome>;
  /** The §2.7 concurrency token for a case, or `undefined` when it does not exist. */
  caseRowVersion(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<{ readonly rowVersionMs: number; readonly truthState: string } | undefined>;
}
