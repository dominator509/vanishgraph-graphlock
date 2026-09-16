/**
 * Tenant entitlement: a scope set that was valid when issued and is no longer entitled is refused and audited
 * (SPEC-003 §3.3's last paragraph; SPEC-005 ROLE-1; EP-006 M3).
 *
 * THE CASE THIS EXISTS FOR: a token's scopes were correct when the realm issued them, and the tenant's entitlement changed
 * afterwards — a role removed, a source disabled, a grant revoked. The token is still cryptographically valid and its
 * scopes still look right, so nothing in the token can reveal the change. The application therefore re-asserts
 * entitlement on every request, and a mismatch is REFUSED rather than downgraded to the intersection: silently serving
 * the smaller set would let a revoked ability keep working for as long as the token lives.
 *
 * THE REFUSAL IS AUDITED, and the audit record is the point of the requirement: an entitlement change that silently
 * starts refusing requests is indistinguishable from a bug to the person it refuses.
 */

import type { IdentityClaims } from '../contracts/identity.ts';

/** What the tenant currently entitles, read from the tenant's own configuration rather than from the token. */
export interface TenantEntitlement {
  readonly tenantId: string;
  /** The roles the tenant currently grants the principal. */
  readonly roles: readonly string[];
  /** The scopes the tenant currently entitles, at most what the roles imply. */
  readonly scopes: readonly string[];
  /** When this entitlement was last changed, so a refusal can say whether it predates the token. */
  readonly changedAt: string;
}

export interface EntitlementDecision {
  readonly ok: boolean;
  readonly code?: 'ENTITLEMENT_CHANGED' | 'TENANT_MISMATCH';
  readonly detail?: string;
  /** The scopes the token holds that the tenant no longer entitles. Never served, only reported. */
  readonly withdrawnScopes: readonly string[];
}

/** The audit record the caller writes when the decision is a refusal. */
export interface EntitlementAuditRecord {
  readonly event: 'entitlement.refused';
  readonly actorRef: string;
  readonly tenantId: string;
  readonly code: 'ENTITLEMENT_CHANGED' | 'TENANT_MISMATCH';
  readonly withdrawnScopes: readonly string[];
  readonly entitlementChangedAt: string;
  readonly at: string;
}

export function checkEntitlement(
  claims: IdentityClaims,
  entitlement: TenantEntitlement | undefined,
  now: string,
): { readonly decision: EntitlementDecision; readonly audit?: EntitlementAuditRecord } {
  if (entitlement === undefined || entitlement.tenantId !== claims.tenant_id) {
    const decision: EntitlementDecision = {
      ok: false,
      code: 'TENANT_MISMATCH',
      detail:
        entitlement === undefined
          ? 'the tenant has no entitlement record, so the token cannot be re-asserted against one'
          : 'the token names a tenant the entitlement record does not',
      withdrawnScopes: [...(claims.scopes ?? [])],
    };
    return {
      decision,
      audit: {
        event: 'entitlement.refused',
        actorRef: claims.sub,
        tenantId: claims.tenant_id,
        code: 'TENANT_MISMATCH',
        withdrawnScopes: decision.withdrawnScopes,
        entitlementChangedAt: entitlement?.changedAt ?? 'unknown',
        at: now,
      },
    };
  }

  const held: readonly string[] = claims.scopes ?? [];
  const withdrawnScopes = held.filter((scope) => !entitlement.scopes.includes(scope));
  const rolesWithdrawn = claims.roles.filter((role) => !entitlement.roles.includes(role));
  if (withdrawnScopes.length === 0 && rolesWithdrawn.length === 0) {
    return { decision: { ok: true, withdrawnScopes: [] } };
  }
  const decision: EntitlementDecision = {
    ok: false,
    code: 'ENTITLEMENT_CHANGED',
    detail:
      `the token holds ${[...withdrawnScopes, ...rolesWithdrawn.map((role) => `role ${role}`)].join(', ')}, which this tenant no longer entitles; the entitlement changed at ${entitlement.changedAt}`,
    withdrawnScopes,
  };
  return {
    decision,
    audit: {
      event: 'entitlement.refused',
      actorRef: claims.sub,
      tenantId: claims.tenant_id,
      code: 'ENTITLEMENT_CHANGED',
      withdrawnScopes,
      entitlementChangedAt: entitlement.changedAt,
      at: now,
    },
  };
}

