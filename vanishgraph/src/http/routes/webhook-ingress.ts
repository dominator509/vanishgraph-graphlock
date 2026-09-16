/**
 * Webhook ingress (SPEC-003 §6.1–§6.3).
 *
 * THE ONLY SURFACE WITH NO BEARER TOKEN, so every step is ordered for a reason:
 *
 *   1. RESOLVE THE CAPABILITY (the path token, or the advertised key id) — the one lookup that runs before a tenant
 *      is known.
 *   2. VERIFY the signature over the RAW bytes (§6.1), before anything is parsed.
 *   3. CLAIM the delivery — nonce and event id (§6.2) — BEFORE the effect, so a replay is refused rather than undone.
 *   4. TAINT-SCAN the parsed body (§6.3): control fields are IGNORED and audited, never applied.
 *   5. DISPATCH exactly one command.
 *   6. RECORD THE RESPONSE against the event id, so a redelivery returns the SAME answer.
 *
 * A WEBHOOK NEVER SETS A TRUTH STATE DIRECTLY. The two transport routes return `truthStateChanged: false`
 * unconditionally, and 6.1 reports `claimedOutcomeIsObservation: false`: a controller claiming "DELETED" is a CLAIM,
 * and collapsing it into `VERIFIED_REMOVED` is the error this product exists to prevent (VG-VERIFY-004).
 *
 * CONTROL FIELDS ARE IGNORED, NOT REJECTED. §6.3 says a field naming a channel, legal basis, truth state, budget or
 * idempotency key "is ignored and its presence is audited as `IGNORED_CONTROL_FIELD`". Rejecting the delivery would
 * let a sender deny service by including a field a provider template happened to carry; applying it would let
 * tainted input steer the system. The route strips them, records one audit row naming the FIELDS, and processes the
 * delivery as if they had not been sent.
 *
 * THE REPLAY ANSWER IS A HEADER, NOT A DIFFERENT BODY. §6.2: a repeated event id "returns the stored original
 * response with `200` and `X-VG-Webhook-Replayed: true`". A consumer that ignores headers must still see exactly what
 * the first delivery answered, which is why the stored status and body are reproduced rather than regenerated.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ReplayStore } from '../../application/contracts/replay-store.ts';
import type { WebhookBinding, WebhookBindingQueries } from '../../application/contracts/webhook-bindings.ts';
import type { WebhookDeliveryCommands } from '../../application/contracts/webhook-deliveries.ts';
import {
  MAIL_DELIVERY_STATUSES,
  PROVIDER_EVENT_KINDS,
} from '../../application/contracts/webhook-deliveries.ts';
import { capabilityTokenHash } from '../../application/contracts/webhook-bindings.ts';
import { verifyWebhook } from '../webhooks/verify.ts';
import { rawBodyPlugin } from '../plugins/raw-body.ts';
import { apiError } from '../plugins/error-handler.ts';
import { ReplayUnavailableError } from '../../application/contracts/replay-store.ts';
import type { TenantTransactionRunner } from '../plugins/tenancy.ts';

/** The fields §6.3 forbids a webhook body from steering with. The list is closed on purpose. */
export const IGNORED_CONTROL_FIELDS = [
  'channel',
  'requestedChannel',
  'legalBasis',
  'truthState',
  'budget',
  'budgetOverride',
  'rateLimitPerSourcePerMinute',
  'idempotencyKey',
] as const;

/** §6.1's `responseKind` tokens, verbatim. */
export const CONTROLLER_RESPONSE_KINDS = [
  'ACKNOWLEDGEMENT',
  'REFUSAL',
  'CONTROLLER_DEMANDS_IDENTITY',
  'CONTROLLER_DEMANDS_AUTHORITY',
  'PARTIAL_ACTION',
  'CLAIMED_DELETION',
] as const;

/** §6.1's `claimedOutcome` tokens, verbatim. */
export const CLAIMED_OUTCOMES = ['DELETED', 'NOT_DELETED', 'UNSPECIFIED'] as const;

export interface WebhookRouteOptions {
  readonly bindings: WebhookBindingQueries;
  readonly replay: ReplayStore;
  readonly deliveries: WebhookDeliveryCommands;
  readonly runner: TenantTransactionRunner;
  /** Resolves a secret NAME to its material, outside the database (VG-SEC-002). */
  readonly resolveSecret: (secretName: string) => Promise<string>;
}

/** The two outcomes of the shared pipeline: proceed with a verified body, or reproduce a stored response. */
type PipelineResult =
  | {
      readonly kind: 'proceed';
      readonly binding: WebhookBinding;
      readonly body: Record<string, unknown>;
      readonly eventId: string;
      readonly keyId: string;
    }
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown };

/** Strip and report the control fields. Returns the body the route is allowed to read. */
export function taintScan(body: Record<string, unknown>): {
  readonly clean: Record<string, unknown>;
  readonly ignored: readonly string[];
} {
  const clean: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if ((IGNORED_CONTROL_FIELDS as readonly string[]).includes(key)) {
      ignored.push(key);
      continue;
    }
    clean[key] = value;
  }
  return { clean, ignored };
}

function requiredString(body: Record<string, unknown>, field: string, max = 200): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  }
  return value;
}

function optionalString(body: Record<string, unknown>, field: string, max = 200): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  return value;
}

function oneOf(value: string, permitted: readonly string[], field: string): string {
  if (!permitted.includes(value)) throw apiError('SCHEMA_VALIDATION_FAILED', { field });
  return value;
}

export function webhookIngressRoutes(app: FastifyInstance, options: WebhookRouteOptions): void {
  const { bindings, replay, deliveries } = options;

  // THE CAPTURE IS INSTALLED ON THIS PLUGIN'S OWN INSTANCE, with the routes it serves. Fastify encapsulates hooks per
  // registration, so a capture registered at the root would not cover routes registered here and vice versa — the
  // same encapsulation that made a root-level `setErrorHandler` miss sibling routes (EP-004 M2's note).
  rawBodyPlugin(app, { prefixes: ['/v1/webhooks/'] });

  /**
   * Steps 1–4, shared by all three routes.
   *
   * Extracted because a route that reordered them, or skipped the taint scan, would be a defect no test of the other
   * two would catch. Each route passes its OWN resolver, which is where the kind check lives: a mail-provider key
   * cannot resolve on the provider-callback route, because that route's resolver refuses anything but its kind.
   */
  async function pipeline(
    request: FastifyRequest,
    routeLabel: string,
    resolveBinding: () => Promise<WebhookBinding | undefined>,
  ): Promise<PipelineResult> {
    // 1. THE CAPABILITY, before any tenant is bound.
    const binding = await resolveBinding();
    if (binding === undefined) throw apiError('WEBHOOK_BINDING_NOT_FOUND');

    // 2. VERIFY, over the raw bytes. Nothing has been parsed at this point.
    //
    //    A SECRET THAT CANNOT BE RESOLVED IS A REFUSAL, NOT A 500. In this composition no secret store is configured,
    //    so every delivery reaches this branch; the honest answer is `503` with a reason that names the missing
    //    piece, because a webhook whose shared secret cannot be resolved cannot be verified — and accepting it
    //    unverified is the one thing the signature exists to prevent.
    let secret: string;
    try {
      secret = await options.resolveSecret(binding.secretName);
    } catch (error) {
      throw apiError('DEPENDENCY_UNAVAILABLE', {
        reason: error instanceof Error ? error.message : 'the webhook secret could not be resolved',
      });
    }
    const verified = await verifyWebhook({
      headers: request.headers as Record<string, string | undefined>,
      rawBody: request.rawWebhookBody,
      nowMs: Date.now(),
      // The key the delivery ADVERTISES is checked against the binding that was just resolved, so a header cannot
      // select a different secret than the capability did.
      resolveKey: async (keyId) => (keyId === request.headers['x-vg-key-id'] ? { secret } : { unknown: true }),
    });
    if (!verified.ok) {
      switch (verified.code) {
        case 'PAYLOAD_TOO_LARGE':
          throw apiError('PAYLOAD_TOO_LARGE');
        case 'WEBHOOK_KEY_UNKNOWN':
          throw apiError('WEBHOOK_KEY_UNKNOWN');
        case 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW':
          throw apiError('WEBHOOK_TIMESTAMP_OUT_OF_WINDOW', { reason: verified.detail });
        case 'WEBHOOK_NONCE_MISSING':
          throw apiError('WEBHOOK_NONCE_MISSING', { reason: verified.detail });
        case 'WEBHOOK_SIGNATURE_INVALID':
          throw apiError('WEBHOOK_SIGNATURE_INVALID');
        case 'MISSING_REQUIRED_HEADER':
          throw apiError('MISSING_REQUIRED_HEADER', { field: verified.field });
      }
    }

    // 3. CLAIM THE DELIVERY. A store failure is a REFUSAL, never an accepted delivery (§6.2).
    let decision;
    try {
      decision = await replay.begin({
        providerKeyId: verified.keyId,
        nonce: verified.nonce,
        eventId: verified.eventId,
        nowMs: Date.now(),
      });
    } catch (error) {
      if (error instanceof ReplayUnavailableError) {
        throw apiError('DEPENDENCY_UNAVAILABLE', { reason: error.message });
      }
      throw error;
    }
    if (decision.kind === 'NONCE_REPLAY') throw apiError('WEBHOOK_NONCE_REPLAY');
    if (decision.kind === 'EVENT_REPLAY') {
      return { kind: 'replay', status: decision.storedStatus, body: decision.storedBody };
    }

    // 4. TAINT SCAN. The body is parsed only now, after the signature proved who sent it.
    const parsed = (request.body ?? {}) as Record<string, unknown>;
    const { clean, ignored } = taintScan(parsed);
    if (ignored.length > 0) {
      await deliveries.auditIgnoredControlFields(binding.tenantId, {
        route: routeLabel,
        fields: ignored,
        correlationId: request.correlationId,
      });
    }
    return { kind: 'proceed', binding, body: clean, eventId: verified.eventId, keyId: verified.keyId };
  }

  /** Record the response against the event id, so a redelivery reproduces it. */
  async function recordResponse(keyId: string, eventId: string, status: number, body: unknown): Promise<void> {
    try {
      await replay.complete({ providerKeyId: keyId, eventId, status, body, nowMs: Date.now() });
    } catch (error) {
      if (error instanceof ReplayUnavailableError) {
        throw apiError('DEPENDENCY_UNAVAILABLE', { reason: error.message });
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 6.1 POST /v1/webhooks/controller-callbacks/{controllerCallbackToken}
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/webhooks/controller-callbacks/:controllerCallbackToken', async (request, reply) => {
    const token = (request.params as Record<string, string>)['controllerCallbackToken'] ?? '';
    const result = await pipeline(request, 'controller-callbacks', async () => {
      const binding = await bindings.resolveControllerToken(options.runner, capabilityTokenHash(token));
      return binding?.kind === 'CONTROLLER_CALLBACK' ? binding : undefined;
    });
    if (result.kind === 'replay') {
      reply.header('x-vg-webhook-replayed', 'true');
      return reply.code(result.status).send(result.body);
    }
    const caseId = result.binding.caseId;
    if (caseId === null) throw apiError('WEBHOOK_BINDING_NOT_FOUND');

    const responseKind = oneOf(
      requiredString(result.body, 'responseKind', 48),
      CONTROLLER_RESPONSE_KINDS,
      'responseKind',
    );
    const claimedOutcome = oneOf(
      requiredString(result.body, 'claimedOutcome', 24),
      CLAIMED_OUTCOMES,
      'claimedOutcome',
    );
    const bodyRef = requiredString(result.body, 'bodyRef', 128);
    const receivedAt = optionalString(result.body, 'receivedAt', 40) ?? new Date().toISOString();

    const outcome = await deliveries.recordControllerResponse(result.binding.tenantId, {
      caseId,
      responseKind,
      claimedOutcome,
      bodyRef,
      receivedAt,
      correlationId: request.correlationId,
    });
    if (!outcome.ok) {
      // A case whose state cannot accept a response is §6.1's conflict: audited by the adapter, and NOT applied as a
      // transition.
      throw apiError('WEBHOOK_CASE_STATE_CONFLICT', { field: 'caseId' });
    }

    const responseBody = {
      accepted: true,
      controllerResponseId: outcome.response.controllerResponseId,
      caseId,
      truthStateAfter: outcome.response.truthState,
      // ALWAYS false: a claim is not an observation (VG-VERIFY-004), and this field exists so no downstream consumer
      // can collapse the two silently.
      claimedOutcomeIsObservation: false,
      verificationRequired: true,
    };
    await recordResponse(result.keyId, result.eventId, 202, responseBody);
    return reply.code(202).send(responseBody);
  });

  // ---------------------------------------------------------------------------------------------
  // 6.2 POST /v1/webhooks/provider-callbacks/{providerKeyId}
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/webhooks/provider-callbacks/:providerKeyId', async (request, reply) => {
    const advertised = (request.params as Record<string, string>)['providerKeyId'] ?? '';
    const result = await pipeline(request, 'provider-callbacks', async () => {
      const binding = await bindings.resolveProviderKey(options.runner, advertised);
      return binding?.kind === 'PROVIDER_CALLBACK' ? binding : undefined;
    });
    if (result.kind === 'replay') {
      reply.header('x-vg-webhook-replayed', 'true');
      return reply.code(result.status).send(result.body);
    }

    const providerTransportRunId = requiredString(result.body, 'providerTransportRunId', 64);
    const providerEventKind = oneOf(
      requiredString(result.body, 'providerEventKind', 48),
      PROVIDER_EVENT_KINDS,
      'providerEventKind',
    );
    const providerReference = optionalString(result.body, 'providerReference', 128);
    const applied = await deliveries.recordTransportFact(result.binding.tenantId, {
      providerTransportRunId,
      providerEventKind,
      providerReference,
      correlationId: request.correlationId,
    });
    if (!applied.found) throw apiError('WEBHOOK_ACTION_NOT_FOUND', { field: 'providerTransportRunId' });

    const responseBody = {
      accepted: true,
      providerTransportRunId,
      recordedAs: 'PROVIDER_TRANSPORT_FACT',
      // ALWAYS false: a provider's own report is not an observation and cannot satisfy independent readback
      // (VG-ACTION-003), so this route can never move a case.
      truthStateChanged: false,
    };
    await recordResponse(result.keyId, result.eventId, 202, responseBody);
    return reply.code(202).send(responseBody);
  });

  // ---------------------------------------------------------------------------------------------
  // 6.3 POST /v1/webhooks/mail-tracking/{mailProviderKeyId}
  // ---------------------------------------------------------------------------------------------
  app.post('/v1/webhooks/mail-tracking/:mailProviderKeyId', async (request, reply) => {
    const advertised = (request.params as Record<string, string>)['mailProviderKeyId'] ?? '';
    const result = await pipeline(request, 'mail-tracking', async () => {
      const binding = await bindings.resolveProviderKey(options.runner, advertised);
      return binding?.kind === 'MAIL_TRACKING' ? binding : undefined;
    });
    if (result.kind === 'replay') {
      reply.header('x-vg-webhook-replayed', 'true');
      return reply.code(result.status).send(result.body);
    }

    const mailPieceId = requiredString(result.body, 'mailPieceId', 64);
    const deliveryStatus = oneOf(
      requiredString(result.body, 'deliveryStatus', 24),
      MAIL_DELIVERY_STATUSES,
      'deliveryStatus',
    );
    const trackingId = optionalString(result.body, 'trackingId', 128);
    const rawBodyRef = optionalString(result.body, 'rawBodyRef', 64);
    const applied = await deliveries.recordMailDelivery(result.binding.tenantId, {
      mailPieceId,
      deliveryStatus,
      trackingId,
      evidenceArtifactId: rawBodyRef,
      correlationId: request.correlationId,
    });
    if (applied.refusal === 'TRACKING_REQUIRED') {
      // The DATABASE refused it: `mail_piece_check` requires a tracking id for DELIVERED. §6.3 has no code for this,
      // so the refusal is reported as a malformed delivery naming the missing field rather than as a server fault —
      // inventing a wire code the contract does not define would be worse than reusing the one it does.
      throw apiError('SCHEMA_VALIDATION_FAILED', { field: 'trackingId' }, 422);
    }
    if (!applied.found) throw apiError('WEBHOOK_MAIL_PIECE_NOT_FOUND', { field: 'mailPieceId' });

    const responseBody = {
      accepted: true,
      mailPieceId,
      deliveryStatus,
      // ALWAYS false: delivery is a transport fact, and acknowledgment requires a ControllerResponse (T11).
      truthStateChanged: false,
    };
    await recordResponse(result.keyId, result.eventId, 202, responseBody);
    return reply.code(202).send(responseBody);
  });
}
