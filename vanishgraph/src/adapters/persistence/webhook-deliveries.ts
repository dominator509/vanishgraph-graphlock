/**
 * The three webhook effects against PostgreSQL (SPEC-003 §6.1–§6.3).
 *
 * EACH METHOD OWNS ITS TRANSACTION, because the delivery's tenant is only known once the capability has resolved —
 * see the port's header. The audit row is written INSIDE the same transaction as the effect it describes: SPEC-006
 * §7.1 row 11 names "commit state and log later" as forbidden, and a delivery whose effect committed without its
 * audit row is a change the system cannot justify.
 *
 * WHAT THESE METHODS DO NOT DO: they never write `truth_state`. §5.9.1's command does that through the guarded
 * transition table, and the two transport facts update a status column that carries no state meaning.
 */

import type {
  WebhookControllerResponseInput,
  WebhookControllerResponseOutcome,
  WebhookDeliveryCommands,
  WebhookMailDeliveryInput,
  WebhookTransportFactInput,
} from '../../application/contracts/webhook-deliveries.ts';
import { appendAuditEvents } from './audit-sink.ts';
import { createAuditEvent } from '../../domain/entities.ts';
import { TenantId } from '../../domain/identifiers.ts';
import type { TenantTransactionRunner } from '../../http/plugins/tenancy.ts';
import { PostgresControllerResponseQueries } from './controller-responses.ts';
import { randomUUID } from 'node:crypto';

/** A PostgreSQL CHECK violation (`23514`), which for the mail path means the tracking-id rule. */
function isCheckViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23514';
}

export class PostgresWebhookDeliveryCommands implements WebhookDeliveryCommands {
  readonly #runner: TenantTransactionRunner;
  readonly #controllerResponses: PostgresControllerResponseQueries;

  constructor(options: {
    readonly runner: TenantTransactionRunner;
    readonly controllerResponses: PostgresControllerResponseQueries;
  }) {
    this.#runner = options.runner;
    this.#controllerResponses = options.controllerResponses;
  }

  async recordControllerResponse(
    tenantId: string,
    input: WebhookControllerResponseInput,
  ): Promise<WebhookControllerResponseOutcome> {
    return this.#runner.withTenantTransaction(tenantId, async (tx) => {
      // THE ROW VERSION IS READ FIRST, because §5.9.1's command is guarded by it. A webhook arriving for a case that
      // moved since the controller was told about it must not overwrite the newer state, and reading the version
      // inside this same transaction is what makes the comparison meaningful.
      const version = await this.#controllerResponses.caseRowVersion(tx, input.caseId);
      if (version === undefined) return { ok: false, reason: 'CASE_NOT_FOUND' };
      const outcome = await this.#controllerResponses.recordControllerResponse(tx, {
        caseId: input.caseId,
        expectedRowVersionMs: version.rowVersionMs,
        responseKind: input.responseKind,
        claimedOutcome: input.claimedOutcome,
        bodyRef: input.bodyRef,
        receivedAt: input.receivedAt,
        // NOT from the body: a webhook that could name its own evidence artifact or refusal basis would be asserting
        // a fact this system is supposed to establish (VG-SEC-001).
        evidenceArtifactId: null,
        refusalBasis: null,
        correlationId: input.correlationId,
        nowMs: Date.now(),
      });
      if (!outcome.ok) return { ok: false, reason: 'CASE_STATE_CONFLICT' };
      await this.#audit(tx, tenantId, {
        action: 'WebhookControllerResponse',
        targetKind: 'ControllerResponse',
        targetId: outcome.response.controllerResponseId,
        correlationId: input.correlationId,
        payload: {
          responseKind: input.responseKind,
          // The CLAIM is recorded as a claim. §6.1: a controller saying "DELETED" must never be stored in a field a
          // later reader could mistake for an observation.
          claimedOutcome: input.claimedOutcome,
          claimedOutcomeIsObservation: false,
          transitionCode: outcome.response.transitionCode,
        },
      });
      return {
        ok: true,
        response: {
          controllerResponseId: outcome.response.controllerResponseId,
          truthState: outcome.response.truthState,
          transitionCode: outcome.response.transitionCode,
        },
      };
    });
  }

  async recordTransportFact(
    tenantId: string,
    input: WebhookTransportFactInput,
  ): Promise<{ readonly found: boolean }> {
    return this.#runner.withTenantTransaction(tenantId, async (tx) => {
      // THE OUTCOME COLUMN IS FREE TEXT, so a provider event kind is stored as what it is rather than mapped onto a
      // vocabulary no specification defines. `RETURNING id` is how "found" is answered: an UPDATE that matched
      // nothing returns no row, which is the honest signal that the transport run is not this tenant's.
      const updated = await tx.query<{ id: string }>(
        `UPDATE provider_transport_run
            SET outcome = $2
          WHERE id = $1::uuid
        RETURNING id::text AS id`,
        [input.providerTransportRunId, input.providerEventKind],
      );
      const found = updated.rows[0] !== undefined;
      // AUDITED EITHER WAY. A provider fact for a run this tenant does not hold is a delivery worth a row: it is how
      // an operator learns that a provider is sending events for something this system never sent.
      await this.#audit(tx, tenantId, {
        action: found ? 'WebhookProviderTransportFact' : 'WebhookProviderTransportFactUnmatched',
        targetKind: 'ProviderTransportRun',
        targetId: input.providerTransportRunId,
        correlationId: input.correlationId,
        payload: {
          providerEventKind: input.providerEventKind,
          providerReference: input.providerReference,
          applied: found,
          // §6.3: this route can never satisfy independent readback (VG-ACTION-003).
          truthStateChanged: false,
        },
      });
      return { found };
    });
  }

  async recordMailDelivery(tenantId: string, input: WebhookMailDeliveryInput): Promise<{ readonly found: boolean; readonly refusal?: 'TRACKING_REQUIRED' }> {
    return this.#runner.withTenantTransaction(tenantId, async (tx) => {
      // The evidence artifact is set only when the caller supplied one, and `COALESCE` keeps the existing value
      // otherwise: a delivery event that carries no evidence must not ERASE the evidence a previous one recorded.
      // `tracking_id` is preserved the same way.
      //
      // MEASURED CONSTRAINT: `mail_piece_check` is `CHECK (delivery_status <> 'DELIVERED' OR tracking_id IS NOT
      // NULL)` — a DELIVERED event with no tracking id and none stored is refused BY THE DATABASE. That refusal is
      // translated into a named outcome rather than surfacing as a 500: the constraint is the product rule, and a
      // caller needs to be told which field is missing.
      let updated: { rows: { id: string; delivery_status: string }[] };
      try {
        updated = await tx.query<{ id: string; delivery_status: string }>(
          `UPDATE mail_piece
              SET delivery_status = $2,
                  tracking_id = COALESCE($3, tracking_id),
                  delivery_evidence_artifact_id = COALESCE($4::uuid, delivery_evidence_artifact_id)
            WHERE id = $1::uuid
          RETURNING id::text AS id, delivery_status`,
          [input.mailPieceId, input.deliveryStatus, input.trackingId, input.evidenceArtifactId],
        );
      } catch (error) {
        if (isCheckViolation(error)) return { found: false, refusal: 'TRACKING_REQUIRED' as const };
        throw error;
      }
      const row = updated.rows[0];
      const found = row !== undefined;
      await this.#audit(tx, tenantId, {
        action: found ? 'WebhookMailDelivery' : 'WebhookMailDeliveryUnmatched',
        targetKind: 'MailPiece',
        targetId: input.mailPieceId,
        correlationId: input.correlationId,
        payload: {
          deliveryStatus: input.deliveryStatus,
          applied: found,
          // §6.3/VG-ACTION-004: delivery is a transport fact. Acknowledgment requires a ControllerResponse (T11).
          truthStateChanged: false,
        },
      });
      return { found };
    });
  }

  async auditIgnoredControlFields(
    tenantId: string,
    input: { readonly route: string; readonly fields: readonly string[]; readonly correlationId: string },
  ): Promise<void> {
    await this.#runner.withTenantTransaction(tenantId, async (tx) => {
      await this.#audit(tx, tenantId, {
        action: 'IGNORED_CONTROL_FIELD',
        targetKind: 'WebhookDelivery',
        targetId: null,
        correlationId: input.correlationId,
        payload: {
          route: input.route,
          // THE FIELD NAMES, never the values: tainted input from outside the system, and an audit payload carries
          // opaque identifiers only (§8.3). A tainted `legalBasis: "CCPA"` is recorded as the word `legalBasis`.
          fields: input.fields.join(','),
          ignoredCount: input.fields.length,
        },
      });
    });
  }

  async #audit(
    tx: Parameters<Parameters<TenantTransactionRunner['withTenantTransaction']>[1]>[0],
    tenantId: string,
    input: {
      readonly action: string;
      readonly targetKind: string;
      readonly targetId: string | null;
      readonly correlationId: string;
      readonly payload: Readonly<Record<string, string | number | boolean | null>>;
    },
  ): Promise<void> {
    await appendAuditEvents(
      tx,
      [
        createAuditEvent({
          id: randomUUID(),
          tenantId: new TenantId(tenantId),
          // A webhook is machine input: the actor is the provider, and this system's append is a SERVICE append. A
          // HUMAN actor kind here would be a claim that a person submitted the delivery.
          actor: `webhook:${input.action}`,
          action: input.action,
          targetKind: input.targetKind,
          targetId: input.targetId,
          correlationId: input.correlationId,
          atMs: Date.now(),
          payload: input.payload,
        }),
      ],
      { actorKind: 'SERVICE' },
    );
  }
}
