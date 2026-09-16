/**
 * The API-boundary authorization gate: scopes and roles checked BEFORE any domain work (SPEC-003 §3.2 item 5;
 * SPEC-005 ROLE-1; EP-006 M3).
 *
 * IT IS A PURE FUNCTION OVER A REGISTRY ENTRY AND A VERIFIED TOKEN, and that shape is the guarantee: the caller has to
 * pass the decision to reach the handler, and the suite asserts that a refused request dispatches nothing by counting the
 * domain calls on the refused path. A gate that ran after the handler would be a gate that reports a refusal for work it
 * already did.
 *
 * A WILDCARD SCOPE IS REFUSED EVERYWHERE, BEFORE ANYTHING ELSE LOOKS AT IT. `*` is how a token silently becomes
 * everything, and SPEC-003 §3.2 item 9 fixes the code as `401 TOKEN_SCOPE_WILDCARD_FORBIDDEN`; the check runs first so a
 * wildcard cannot be evaluated as "satisfies every required scope", which is exactly what a set-membership test would say.
 */

import type { IdentityClaims } from '../../application/contracts/identity.ts';
import { MACHINE_FORBIDDEN_SCOPES, isScope } from '../../application/security/scope-catalogue.ts';
import { authorize } from '../../application/security/authorization-matrix.ts';

/** What a route declares it needs. The EP-004 registry carries these per operation. */
export interface RouteRequirement {
  readonly routeId: string;
  readonly requiredScopes: readonly string[];
  /** The role the matrix cell names, when the route names one. */
  readonly requiredRole?: string | undefined;
  readonly resource?: string | undefined;
  readonly action?: string | undefined;
}

export type GateRefusalCode =
  | 'TOKEN_SCOPE_WILDCARD_FORBIDDEN'
  | 'INSUFFICIENT_SCOPE'
  | 'INSUFFICIENT_ROLE'
  | 'TOKEN_INVALID_CLAIMS';

export interface GateDecision {
  readonly ok: boolean;
  readonly code?: GateRefusalCode | 'RESOURCE_NOT_FOUND' | 'SEPARATION_OF_DUTIES_REQUIRED';
  readonly detail?: string;
}

/** Whether the token is a machine token (no human role at all). */
function isMachineToken(claims: IdentityClaims): boolean {
  return claims.roles.length === 0;
}

/**
 * Decide whether a verified token may reach a route's handler.
 *
 * THE SCOPE CHECK USES EXACT MEMBERSHIP, NEVER A PREFIX OR A PATTERN: `vg.subjects.read` does not satisfy
 * `vg.subjects.write`, and no scope satisfies another by being longer or shorter. A prefix rule is how `vg.evidence.read`
 * quietly grows into `vg.evidence.read_content`.
 */
export function gateRoute(requirement: RouteRequirement, claims: IdentityClaims): GateDecision {
  const held = claims.scopes ?? [];

  // 1. THE WILDCARD, FIRST.
  if (held.includes('*')) {
    return {
      ok: false,
      code: 'TOKEN_SCOPE_WILDCARD_FORBIDDEN',
      detail: 'the token carries a wildcard scope: SPEC-003 §3.2 item 9 refuses it outright rather than expanding it',
    };
  }

  // 2. SCOPES THE VOCABULARY DOES NOT KNOW ARE NOT SCOPES. A token asserting one is not thereby powerful.
  for (const scope of held) {
    if (!isScope(scope)) {
      return { ok: false, code: 'TOKEN_INVALID_CLAIMS', detail: `the token carries "${scope}", which is not in the closed scope vocabulary` };
    }
  }

  // 3. A MACHINE TOKEN MAY NOT HOLD THE FORBIDDEN SCOPES, whatever the route asks for.
  if (isMachineToken(claims)) {
    for (const scope of held) {
      if (MACHINE_FORBIDDEN_SCOPES.includes(scope)) {
        return {
          ok: false,
          code: 'TOKEN_INVALID_CLAIMS',
          detail: `a machine token may not hold ${scope}: SPEC-003 §3.2 item 9 forbids it by name`,
        };
      }
    }
  }

  // 4. EVERY REQUIRED SCOPE MUST BE HELD EXACTLY.
  const missing = requirement.requiredScopes.filter((scope) => !held.includes(scope));
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'INSUFFICIENT_SCOPE',
      detail: `the token does not hold ${missing.join(', ')}, which ${requirement.routeId} requires`,
    };
  }

  // 5. THE ROLE, THROUGH THE MATRIX. A route that names a resource and action is decided by the matrix, so a role's
  //    prohibitions apply at the boundary rather than only inside the handler.
  if (requirement.requiredRole !== undefined && !claims.roles.includes(requirement.requiredRole)) {
    return {
      ok: false,
      code: 'INSUFFICIENT_ROLE',
      detail: `${requirement.routeId} requires the ${requirement.requiredRole} role`,
    };
  }
  if (requirement.resource !== undefined && requirement.action !== undefined) {
    const decisions = claims.roles.map((role) =>
      authorize({
        role,
        resource: requirement.resource ?? '',
        action: requirement.action ?? '',
        tenantId: claims.tenant_id,
        // The route's own tenant resolution runs before this gate; a same-tenant read is the only one that reaches here,
        // and the gate re-asserts it rather than trusting the caller's earlier check (VG-AUTHZ-004).
        resourceTenantId: claims.tenant_id,
      }),
    );
    if (decisions.length === 0) {
      return { ok: false, code: 'INSUFFICIENT_ROLE', detail: `${requirement.routeId} requires a human role and the token holds none` };
    }
    if (!decisions.some((decision) => decision.decision === 'ALLOW')) {
      return {
        ok: false,
        code: 'INSUFFICIENT_ROLE',
        detail: decisions.map((decision) => decision.reason).join('; '),
      };
    }
  }

  // 6. AN EXTERNAL EFFECT NEEDS MORE THAN A ROLE. `vg.actions.execute` is gated by VG-AUTHZ-015 (grant + decision +
  //    recipe + budget); this gate refuses the EFFECT here and leaves the specific 409/422 to the domain, which is where
  //    the four conditions live. Refusing here when the token holds the scope would double-report the same failure with
  //    a less specific code.
  return { ok: true };
}

