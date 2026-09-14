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
