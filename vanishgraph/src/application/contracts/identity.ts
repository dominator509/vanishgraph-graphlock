/**
 * The identity contract between the HTTP boundary and whatever verifies tokens
 * (SPEC-003 §3.1, SPEC-005 IDP-1…IDP-6).
 *
 * WHY THIS FILE EXISTS: `src/http/**` must not import `src/adapters/**` (ARCHITECTURE.md §2, enforced
 * by `scripts/import-boundary.sh`). The identity plugin needs the RESULT SHAPE of verification and
 * the bearer-extraction rule, and neither is adapter-specific: any verifier — OIDC, mTLS, a test
 * double — produces the same shape. Putting them here keeps the HTTP layer depending on a contract
 * rather than on a concrete implementation, which is what lets EP-006 replace the verifier without
 * touching a route.
 *
 * The refusal codes are the WIRE codes of SPEC-003 §8.2. They live here as a union so a verifier
 * cannot invent one, and the plugin forwards whichever it receives unchanged — collapsing them would
 * report "our key server is down" as "your credential is bad", which sends an operator hunting for a
 * credential problem that does not exist.
 */

/** The claim set a verified token yields, in SPEC-005 IDP-4's snake_case names. */
export interface IdentityClaims {
  /** The human operator. Never a `ProtectedSubject` (SPEC-005 IDP-4). */
  readonly sub: string;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly nbf: number | undefined;
  readonly iat: number | undefined;
  /** SPEC-005 IDP-4 name. Absent means unverified, and there is no all-tenants token. */
  readonly tenant_id: string;
  readonly roles: readonly string[];
  readonly subject_ref: string;
  readonly auth_level: string;
  readonly azp: string | undefined;
  /** Optional: scopes may be absent when they derive from roles. */
  readonly scopes: readonly string[] | undefined;
}

/** Why a token was refused. Each maps to exactly one SPEC-003 §8.2 wire code. */
export type IdentityRefusal =
  | 'TOKEN_MISSING'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID_CLAIMS'
  | 'TOKEN_AUDIENCE_MISMATCH'
  | 'TOKEN_SCOPE_WILDCARD_FORBIDDEN'
  | 'DEPENDENCY_UNAVAILABLE';

/** The outcome of verifying a presented token. */
export type IdentityResult =
  | { readonly ok: true; readonly claims: IdentityClaims }
  | { readonly ok: false; readonly code: IdentityRefusal; readonly detail: string };

/**
 * Extract a bearer token from request headers.
 *
 * BEARER ONLY (SPEC-003 §3.2 item 1): query-string tokens, cookies, `X-Api-Key` and
 * `Authorization: Basic` are not accepted on any `/v1` route. This reads exactly one header and one
 * scheme and returns undefined for everything else rather than trying harder — a fallback lookup is
 * how a "temporary" query-string token becomes permanent.
 */
export function bearerFrom(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(value.trim());
  return match?.[1];
}

/** The verifier port. Implemented by the OIDC adapter, replaced by a double in tests. */
export type VerifyIdentity = (token: string | undefined) => Promise<IdentityResult>;
