/**
 * External actions, reconciliations, readbacks and mail pieces (SPEC-003 §5.8.1–§5.8.6).
 *
 * THE ROUTE THAT WRITES TO THE OUTSIDE WORLD CANNOT DO SO YET, AND THIS PORT SAYS SO PLAINLY. §5.8.2 is
 * VG-ACTION-001's route: it submits a removal request through a channel. NO channel transport exists in this
 * repository — there is no provider adapter, no certified-mail API, no SMTP binding — so a real submission is
 * refused with `503 DEPENDENCY_UNAVAILABLE` naming the unconfigured transport, exactly as §5.3.7 refuses to
 * create a recipe whose signature it cannot verify while ADR-006 is open. **What IS implemented is the whole
 * route except the effect**: guard evaluation (authority, recipe, source permission, channel, budget, open human
 * gate), payload-field allowlisting, template-hash requirement, idempotency, and the `dryRun` path, which
 * §5.8.2 defines as "guard evaluation and payload validation are performed and reported, and no external effect
 * is produced and no state changes". A dry run is a real, contract-complete outcome; a submission is not, and
 * pretending otherwise would be the one thing this repository must never do.
 *
 * THE IDEMPOTENCY FINGERPRINT IS COMPUTED, NOT STORED. §5.8.1 requires a one-way digest of the key "so a list
 * response cannot be used to replay or forge a key". The key itself is stored (§4 needs it), so the digest is a
 * pure function of it; a stored digest could drift from the value it digests, and the drift would be invisible.
 *
 * `readbackState` IS DERIVED FROM THE READBACK RECORDS, not stored on the action: §5.8.5 reports it with
 * `readbackAt` and `readbackEvidenceArtifactId`, which are the readback row's own facts. An action with no
 * readback row reports `PENDING` — §5.8.2's response says `readbackRequired: true`, and "required but not yet
 * requested" is what PENDING means.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** §5.8.3's `finding` vocabulary, and the one place it is enumerated. */
export const RECONCILIATION_FINDINGS: readonly string[] = Object.freeze([
  'EFFECT_CONFIRMED',
  'EFFECT_ABSENT',
  'INDETERMINATE',
]);

/** §5.8.3's `reconciliationMethod` vocabulary. */
export const RECONCILIATION_METHODS: readonly string[] = Object.freeze([
  'PROVIDER_API_LOOKUP',
  'MAIL_TRACKING_LOOKUP',
  'CONTROLLER_CONTACT_CONFIRMATION',
]);

/** §5.8.4's `observationMethod` vocabulary. */
export const READBACK_METHODS: readonly string[] = Object.freeze([
  'PROVIDER_API',
  'INDEPENDENT_FETCH_DIFFERENT_EGRESS',
  'SECOND_CONTROLLER_CHANNEL',
]);

/**
 * The mail delivery vocabulary, mapped onto the contract's.
 *
 * §5.8.6 renders `ACCEPTED | IN_TRANSIT | DELIVERED | RETURNED | UNKNOWN`; the delivered CHECK admitted
 * `NOT_SENT | SENT | DELIVERED | RETURNED | UNKNOWN`, and migration `0027`-era `0026` widened it to admit both
 * sets, because rows written under the old vocabulary exist and are not rewritable-by-meaning. The three shared
 * tokens map to themselves; `SENT` is `IN_TRANSIT` (dispatched, not yet delivered); and `NOT_SENT` is `UNKNOWN`,
 * which is §5.8.6's OWN rule for a piece with no tracking or evidence — a prepared piece has no delivery
 * evidence, so reporting it as anything else would synthesise a status, which that paragraph forbids.
 */
export const MAIL_DELIVERY_STATUS: Readonly<Record<string, string>> = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  RETURNED: 'RETURNED',
  UNKNOWN: 'UNKNOWN',
  SENT: 'IN_TRANSIT',
  NOT_SENT: 'UNKNOWN',
});

/** One §5.8.1 list row. */
export interface ActionListRow {
  readonly externalActionId: string;
  readonly caseId: string;
  readonly channel: string;
  readonly recipeId: string | null;
  readonly recipeVersion: number | null;
  readonly attempt: number;
  /** `SUBMITTED | AMBIGUOUS | REFUSED | FAILED | PREPARED`, verbatim from the row. */
  readonly actionOutcome: string;
  /** A ONE-WAY digest of the idempotency key, never the key. */
  readonly idempotencyKeyFingerprint: string;
  readonly submittedAt: string | null;
  readonly readbackState: string;
  readonly mailPieceId: string | null;
  /**
   * The list's ORDERING KEY, for the route's cursor. Stripped before the body is sent, because §5.8.1's body has
   * no such field — the same treatment `rowVersionMs` gets on detail routes.
   *
   * NOT `submittedAt`: that column is nullable while the ordering is by `created_at`, so a cursor built from it
   * would carry an empty string for a prepared-but-never-submitted action and fail to parse on the next page.
   * MEASURED on the mail-piece list, whose pieces have no `sent_at` at all.
   */
  readonly cursorValue: string;
}

/** §5.8.5's detail. */
export interface ActionDetail extends ActionListRow {
  /** The §2.7 ETag input. Never serialised into a body. */
  readonly rowVersionMs: number;
  readonly caseTruthState: string;
  readonly recipeSnapshot: {
    readonly recipeId: string;
    readonly version: number;
    readonly verificationMethod: string;
    /** `null` when the recipe cannot be resolved any more. */
    readonly channel: string | null;
  } | null;
  readonly templateSnapshot: {
    readonly templateVersion: number | null;
    readonly templateHash: string | null;
  };
  readonly readback: {
    readonly state: string;
    readonly readbackAt: string | null;
    readonly readbackEvidenceArtifactId: string | null;
  };
  readonly ambiguity: {
    readonly ambiguous: boolean;
    readonly reconciledAt: string | null;
    readonly finding: string | null;
    readonly method: string | null;
  };
  readonly mailPiece: MailPieceRow | null;
}

/** One §5.8.6 mail-piece row. */
export interface MailPieceRow {
  readonly mailPieceId: string;
  readonly caseId: string;
  readonly templateVersion: number;
  readonly templateHash: string;
  readonly provider: string;
  readonly trackingId: string | null;
  readonly deliveryStatus: string;
  readonly deliveryEvidenceArtifactId: string | null;
  readonly sentAt: string | null;
  /** The ordering key (`created_at`), for the route's cursor. Stripped before the body is sent. */
  readonly cursorValue: string;
}

/** Everything §5.8.2 needs. */
export interface ExecuteActionRequest {
  readonly caseId: string;
  readonly expectedRowVersionMs: number;
  readonly channel: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly authorityGrantId: string;
  readonly policyDecisionId: string;
  readonly idempotencyKey: string;
  readonly templateVersion: number | null;
  readonly templateHash: string | null;
  readonly payloadFields: Readonly<Record<string, string>>;
  readonly dryRun: boolean;
  readonly correlationId: string;
  readonly nowMs: number;
}

/** The six guards §5.8.2 evaluates, each computed from rows. */
export interface ActionGuards {
  readonly authorityValid: boolean;
  readonly recipeSignedAndFresh: boolean;
  readonly recipeEnabled: boolean;
  readonly channelMatchesDecision: boolean;
  readonly sourceWritable: boolean;
  readonly budgetAvailable: boolean;
  readonly humanGateOpen: boolean;
}

export type ExecuteActionOutcome =
  | {
      readonly ok: true;
      readonly response: {
        readonly dryRun: true;
        readonly guardsEvaluated: ActionGuards;
        readonly payloadFieldsAccepted: readonly string[];
        readonly wouldTransitionTo: string | null;
        readonly templateHashRequired: boolean;
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
  | { readonly ok: false; readonly reason: 'CHANNEL_TRANSPORT_UNCONFIGURED'; readonly channel: string }
  | { readonly ok: false; readonly reason: 'PAYLOAD_FIELD_NOT_ALLOWLISTED'; readonly field: string }
  | { readonly ok: false; readonly reason: 'TEMPLATE_HASH_REQUIRED' }
  | { readonly ok: false; readonly reason: 'HUMAN_GATE_OPEN' }
  | { readonly ok: false; readonly reason: 'EFFECT_BUDGET_EXCEEDED'; readonly used: number; readonly limit: number }
  | { readonly ok: false; readonly reason: 'AUTHORITY_INVALID' }
  | { readonly ok: false; readonly reason: 'RECIPE_DISABLED' }
  | { readonly ok: false; readonly reason: 'RECIPE_STALE' }
  | { readonly ok: false; readonly reason: 'SOURCE_PERMISSION_UNCLEAR' }
  | { readonly ok: false; readonly reason: 'CHANNEL_PRIORITY_VIOLATION' };

/** Everything §5.8.3 needs. */
export interface ReconciliationRequest {
  readonly externalActionId: string;
  readonly method: string;
  readonly finding: string;
  readonly observedAt: string;
  readonly evidenceArtifactId: string | null;
  readonly note: string | null;
  readonly correlationId: string;
  readonly nowMs: number;
}

export type ReconciliationOutcome =
  | {
      readonly ok: true;
      readonly response: {
        readonly externalActionId: string;
        readonly actionOutcome: string;
        readonly caseId: string;
        readonly truthState: string | null;
        readonly truthStateUnchanged: string | null;
        readonly transitionCode: string | null;
        readonly readbackRequired: boolean;
        readonly divergenceRecorded: boolean;
        readonly reissueAllowed: boolean;
        readonly requiresNewIdempotencyKey: boolean;
        readonly escalatedTo: string | null;
      };
    }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' }
  | { readonly ok: false; readonly reason: 'ACTION_NOT_AMBIGUOUS'; readonly actionOutcome: string }
  | { readonly ok: false; readonly reason: 'ILLEGAL_TRANSITION'; readonly fromTruthState: string }
  | { readonly ok: false; readonly reason: 'EVIDENCE_NOT_FOUND' };

/** Everything §5.8.4 needs. */
export interface ReadbackRequest {
  readonly externalActionId: string;
  readonly observationMethod: string;
  readonly requestedAt: string;
  readonly correlationId: string;
  readonly nowMs: number;
}

export type ReadbackOutcome =
  | {
      readonly ok: true;
      readonly response: {
        readonly externalActionId: string;
        readonly readbackState: string;
        readonly observationMethod: string;
        readonly readbackRequestId: string;
        readonly independenceCheckedAgainst: string | null;
      };
    }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' }
  | {
      readonly ok: false;
      readonly reason: 'OBSERVATION_PATH_NOT_INDEPENDENT';
      readonly actingPathId: string;
    };

export interface ActionQueries {
  /**
   * Whether the case exists for this tenant, for the 404 path on its action and mail-piece sub-resources.
   *
   * NOT inferred from the action list: a case with no actions and an absent case are different answers, and a
   * route that used an empty list as its existence test answered 404 for a case that exists (MEASURED).
   */
  caseExists(tx: TenantTransaction, caseId: string): Promise<boolean>;
  listActions(
    tx: TenantTransaction,
    params: {
      readonly caseId: string;
      readonly limit: number;
      readonly after?: { readonly sortValue: string; readonly id: string };
    },
  ): Promise<readonly ActionListRow[]>;
  getActionDetail(tx: TenantTransaction, externalActionId: string): Promise<ActionDetail | undefined>;
  actionRowVersion(
    tx: TenantTransaction,
    externalActionId: string,
  ): Promise<{ readonly rowVersionMs: number } | undefined>;
  listMailPieces(
    tx: TenantTransaction,
    params: {
      readonly caseId: string;
      readonly limit: number;
      readonly after?: { readonly sortValue: string; readonly id: string };
    },
  ): Promise<readonly MailPieceRow[]>;
  executeAction(tx: TenantTransaction, request: ExecuteActionRequest): Promise<ExecuteActionOutcome>;
  recordReconciliation(
    tx: TenantTransaction,
    request: ReconciliationRequest,
  ): Promise<ReconciliationOutcome>;
  requestReadback(tx: TenantTransaction, request: ReadbackRequest): Promise<ReadbackOutcome>;
}
