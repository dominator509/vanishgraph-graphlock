/**
 * The application contract barrel (SPEC-001 §5, SPEC-003 §1).
 *
 * WHY THIS FILE EXISTS, beyond tidiness: `src/http/**` must not import `src/domain/**` directly
 * (ARCHITECTURE.md §2, enforced by `scripts/import-boundary.sh`). The HTTP layer needs the closed
 * truth-state vocabulary to validate a filter token, and the vocabulary is a DOMAIN concept — so the
 * application layer re-exports it and the boundary depends on the contract rather than reaching
 * through the layer beneath.
 *
 * That indirection is not ceremony. It is what lets the domain change shape (a state added, a guard
 * tightened) without an HTTP file needing to know where the domain's modules live, and it is the same
 * reason `identity.ts` lives here rather than in the adapter.
 *
 * WHAT IS DELIBERATELY NOT RE-EXPORTED: the transition table, the guard implementations, and the
 * entity classes. A handler that could read `LEGAL_TRANSITIONS` would be a handler that decides a
 * transition, and SPEC-001 SM-6 puts that decision in a guarded command. The vocabulary is a
 * vocabulary; the machinery stays inside the domain.
 */

export type { Clock, RequestContext } from './request-context.ts';
export {
  ALL_ROLES,
  ROLES,
  STEP_UP_WINDOW_SECONDS,
  holdsAllRoles,
  holdsAllScopes,
  holdsAnyRole,
  isStepUpFresh,
  type Role,
} from './request-context.ts';

export type {
  IdentityClaims,
  IdentityRefusal,
  IdentityResult,
  VerifyIdentity,
} from './identity.ts';
export { bearerFrom } from './identity.ts';

/**
 * The eleven canonical truth states (SPEC-000 §5).
 *
 * Re-exported so the HTTP layer can validate a `truthState` filter token WITHOUT importing the
 * domain directly. A filter must accept exactly these tokens and refuse everything else, and reading
 * the list from its single definition is what keeps the API from accepting a token the state machine
 * would reject.
 */
export { ALL_TRUTH_STATES, type TruthState } from '../../domain/truth-state.ts';

/**
 * The at-most-once port (SPEC-001 §5.1, VG-ACTION-001).
 *
 * Re-exported for the same reason as the truth-state vocabulary: `src/http/**` may not import
 * `src/domain/**` directly (ARCHITECTURE.md §2), and the idempotency plugin needs these types. The
 * DECLARATION stays in the domain, where the invariant lives; the boundary depends on the contract.
 */
export type {
  BeginResult,
  IdempotencyRecord,
  IdempotencyScope,
  IdempotencyState,
  IdempotencyStore,
} from '../../domain/ports/idempotency-store.ts';

/**
 * The tenant identifier, exported as BOTH a type and a sanctioned factory.
 *
 * The type alone is not enough: the identity plugin must MINT a tenant from the verified `tenant_id`
 * claim, and `src/http/**` may not import `src/domain/**` to reach the class (ARCHITECTURE.md §2).
 *
 * `tenantIdFrom` is the boundary's only constructor, so the brand's validation lives in exactly one
 * place — the domain's `TenantId` — and the boundary never re-implements it. The CLASS is deliberately
 * not re-exported under its own name: `new TenantId(...)` in a handler would be a second construction
 * site, and a second site is where validation gets loosened.
 */
import { TenantId as DomainTenantId } from '../../domain/identifiers.ts';
export type { TenantId } from '../../domain/identifiers.ts';

/** Build a validated tenant identifier from a token claim. Throws on a malformed value. */
export function tenantIdFrom(claim: string): DomainTenantId {
  return new DomainTenantId(claim);
}
