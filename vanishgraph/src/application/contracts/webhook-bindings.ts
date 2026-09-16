/**
 * Webhook capability resolution (SPEC-003 §6.1/§6.2/§6.3).
 *
 * The ingress is the only surface with no bearer token, so this is the one place where a REQUEST resolves its own
 * tenant. §6.1 says the path token is "an opaque, single-purpose capability resolved to one `(tenantId, caseId,
 * controllerId)` binding, rotated and revocable per controller; it is not a bearer credential and confers no scope";
 * §6.2 and §6.3 resolve an advertised key id the same way and answer `404 WEBHOOK_BINDING_NOT_FOUND` for an unknown
 * or retired one.
 *
 * A NON-ACTIVE BINDING IS NOT FOUND — the same answer for "never existed", "retired" and "revoked", because §6 lists
 * one code for all three and telling a prober which of the three applies would let them distinguish a rotated
 * capability from a wrong one.
 */

import type { TenantTransactionRunner } from '../../http/plugins/tenancy.ts';

/** What a resolved capability says. Never the token, never the secret. */
export interface WebhookBinding {
  readonly tenantId: string;
  readonly kind: 'CONTROLLER_CALLBACK' | 'PROVIDER_CALLBACK' | 'MAIL_TRACKING';
  /** The case a controller callback is bound to. `null` for the provider kinds. */
  readonly caseId: string | null;
  readonly controllerId: string | null;
  /** The name a `SecretResolver` resolves to the shared secret. Never the secret itself. */
  readonly secretName: string;
}

export interface WebhookBindingQueries {
  /**
   * Resolve a controller-callback capability token.
   *
   * TAKES THE RUNNER, NOT A TRANSACTION, and that is the whole shape of the problem: this lookup ESTABLISHES the
   * tenant for the rest of the delivery, so it cannot run inside a tenant-scoped transaction. The adapter opens a
   * capability-scoped one (see `withCapabilityTransaction`), and the route then opens a tenant-scoped transaction
   * for the work — two transactions, in that order, because the first produces what the second is scoped to.
   */
  resolveControllerToken(runner: TenantTransactionRunner, tokenHash: string): Promise<WebhookBinding | undefined>;
  /** Resolve an advertised provider key id, for §6.2 and §6.3. Any tenant: the row names it. */
  resolveProviderKey(runner: TenantTransactionRunner, providerKeyId: string): Promise<WebhookBinding | undefined>;
}
