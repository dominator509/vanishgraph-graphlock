/**
 * The three effects a verified webhook delivery may produce (SPEC-003 §6.3).
 *
 * WHY THIS PORT EXISTS SEPARATELY FROM THE READ MODELS IT USES. A delivery has no bearer token, so its tenant is
 * discovered during the request rather than bound before it — which means the route cannot be handed a
 * `TenantTransaction` the way every other write route is. Something must open the transaction AFTER the capability
 * resolves, and that something must live outside `src/http` (the code law). This port is that boundary: each method
 * takes a TENANT and owns its own transaction, so the route never sees a connection and never chooses a tenant.
 *
 * ONE DELIVERY, ONE COMMAND. §6.3: each ingress "verifies, records an `AuditEvent`, and dispatches exactly one domain
 * command". The methods below are those dispatches, and none of them moves a truth state by itself — §5.9.1's command
 * does that through the guarded transition table, and the two transport facts deliberately cannot.
 */

export interface WebhookControllerResponseInput {
  readonly caseId: string;
  readonly responseKind: string;
  readonly claimedOutcome: string;
  readonly bodyRef: string;
  readonly receivedAt: string;
  readonly correlationId: string;
}

export type WebhookControllerResponseOutcome =
  | {
      readonly ok: true;
      readonly response: {
        readonly controllerResponseId: string;
        readonly truthState: string;
        readonly transitionCode: string;
      };
    }
  | { readonly ok: false; readonly reason: 'CASE_NOT_FOUND' }
  /**
   * The case cannot accept a response right now — §6.1's `409 WEBHOOK_CASE_STATE_CONFLICT`, "recorded as an audit row
   * and **not** applied as a transition". Forcing the write would be the defect the code names.
   */
  | { readonly ok: false; readonly reason: 'CASE_STATE_CONFLICT' };

export interface WebhookTransportFactInput {
  readonly providerTransportRunId: string;
  readonly providerEventKind: string;
  readonly providerReference: string | null;
  readonly correlationId: string;
}

export interface WebhookMailDeliveryInput {
  readonly mailPieceId: string;
  readonly deliveryStatus: string;
  readonly trackingId: string | null;
  readonly evidenceArtifactId: string | null;
  readonly correlationId: string;
}

export interface WebhookDeliveryCommands {
  /** §6.1 — dispatch `RecordControllerResponse` for a controller callback. */
  recordControllerResponse(
    tenantId: string,
    input: WebhookControllerResponseInput,
  ): Promise<WebhookControllerResponseOutcome>;
  /** §6.2 — record a provider transport fact. Never a transition, never an observation. */
  recordTransportFact(
    tenantId: string,
    input: WebhookTransportFactInput,
  ): Promise<{ readonly found: boolean }>;
  /** §6.3 — record a mail delivery fact. Never a transition: acknowledgment requires a `ControllerResponse` (T11). */
  recordMailDelivery(
    tenantId: string,
    input: WebhookMailDeliveryInput,
  ): Promise<{ readonly found: boolean; readonly refusal?: 'TRACKING_REQUIRED' }>;
  /**
   * Record the control fields a webhook body attempted to steer with (VG-SEC-001).
   *
   * One audit row per delivery, naming the FIELDS and never their values: the values are tainted input from outside,
   * and an audit payload carries opaque identifiers only.
   */
  auditIgnoredControlFields(
    tenantId: string,
    input: {
      readonly route: string;
      readonly fields: readonly string[];
      readonly correlationId: string;
    },
  ): Promise<void>;
}

/** §6.3's delivery statuses, verbatim from the contract's body and the column's CHECK. */
export const MAIL_DELIVERY_STATUSES = ['ACCEPTED', 'IN_TRANSIT', 'DELIVERED', 'RETURNED', 'UNKNOWN'] as const;

/** §6.2's provider event kinds, verbatim. */
export const PROVIDER_EVENT_KINDS = [
  'SUBMISSION_ACCEPTED',
  'SUBMISSION_REJECTED',
  'STATUS_CHANGED',
  'RATE_LIMITED',
] as const;
