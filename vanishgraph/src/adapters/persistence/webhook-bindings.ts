/**
 * Webhook capability resolution against PostgreSQL (SPEC-003 §6.1/§6.2/§6.3, migration `0032`).
 *
 * THE LOOKUP IS TWO STATEMENTS IN ONE TRANSACTION, and that is not an optimisation: `set_config(..., true)` is
 * transaction-local, so the capability value and the SELECT that depends on it must share a transaction. A pooled
 * connection would otherwise keep this delivery's capability for the next request — the same hazard
 * `withTenantTransaction` documents for `app.tenant_id`, with the same consequence.
 *
 * A NON-ACTIVE BINDING IS `undefined`, deliberately conflating three cases. §6 lists ONE code for an unknown key, a
 * retired key and a revoked capability (`404 WEBHOOK_BINDING_NOT_FOUND`), and answering "revoked" differently from
 * "unknown" would tell a prober that a token once existed.
 */

import type { WebhookBinding, WebhookBindingQueries } from '../../application/contracts/webhook-bindings.ts';
import type { TenantTransactionRunner } from '../../http/plugins/tenancy.ts';

interface RawBinding {
  tenant_id: string;
  kind: 'CONTROLLER_CALLBACK' | 'PROVIDER_CALLBACK' | 'MAIL_TRACKING';
  case_id: string | null;
  controller_id: string | null;
  secret_name: string | null;
}

function toBinding(row: RawBinding): WebhookBinding {
  return {
    tenantId: row.tenant_id,
    kind: row.kind,
    caseId: row.case_id,
    controllerId: row.controller_id,
    // A provider row always has a secret name (the table's CHECK enforces it); a controller callback's secret comes
    // from the same column, so an absent name would be a schema violation rather than a runtime surprise.
    secretName: row.secret_name ?? '',
  };
}

const SELECT_COLUMNS = `b.tenant_id::text AS tenant_id, b.kind, b.case_id::text AS case_id,
                        b.controller_id::text AS controller_id, b.secret_name`;

export class PostgresWebhookBindingQueries implements WebhookBindingQueries {
  async resolveControllerToken(
    runner: TenantTransactionRunner,
    tokenHash: string,
  ): Promise<WebhookBinding | undefined> {
    return runner.withCapabilityTransaction('token_hash', tokenHash, async (tx) => {
      const result = await tx.query<RawBinding>(
        `SELECT ${SELECT_COLUMNS}
           FROM webhook_binding b
          WHERE b.kind = 'CONTROLLER_CALLBACK' AND b.token_hash = $1 AND b.status = 'ACTIVE'`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toBinding(row);
    });
  }

  async resolveProviderKey(
    runner: TenantTransactionRunner,
    providerKeyId: string,
  ): Promise<WebhookBinding | undefined> {
    return runner.withCapabilityTransaction('provider_key', providerKeyId, async (tx) => {
      const result = await tx.query<RawBinding>(
        `SELECT ${SELECT_COLUMNS}
           FROM webhook_binding b
          WHERE b.provider_key_id = $1 AND b.status = 'ACTIVE'
            AND b.kind IN ('PROVIDER_CALLBACK','MAIL_TRACKING')`,
        [providerKeyId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toBinding(row);
    });
  }
}

