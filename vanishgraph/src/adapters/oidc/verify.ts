/**
 * OIDC access-token verification (SPEC-003 §3.2, SPEC-005 IDP-1…IDP-6, IDP-4).
 *
 * CLAIM NAMES ARE SNAKE_CASE, and that is not a style choice. SPEC-003 §3.2 item 2 states the API
 * "reads `tenant_id`, `roles`, `subject_ref`, and `auth_level` and does not invent parallel
 * camelCase claims", and SPEC-003 §14 R-1 records that this file originally did invent them
 * (`tenantId`, `scopes`, `authTime`, `acr`) and was corrected. Those camelCase names appear nowhere
 * below; a token carrying them is missing the real claims and is refused.
 *
 * FOUR REFUSALS THAT MUST NOT BE CONFLATED, because each maps to a different wire code and getting
 * them wrong either locks out legitimate callers or admits illegitimate ones:
 *
 *   1. **A missing required claim is `TOKEN_INVALID_CLAIMS`, never an empty set.** SPEC-003 §3.2
 *      item 2: "A token missing `roles` is `401 TOKEN_INVALID_CLAIMS` — never treated as an empty
 *      role set, because 'absent means none' and 'absent means unverified' are different failures
 *      and only one of them is safe." A missing `tenant_id` is the same class, and there is no
 *      "all tenants" token.
 *   2. **A wildcard scope is `TOKEN_SCOPE_WILDCARD_FORBIDDEN`.** A `*` scope is how a token silently
 *      becomes an all-tenant, all-capability credential.
 *   3. **A wrong audience is `TOKEN_AUDIENCE_MISMATCH`.** Portal, service and MCP tokens carry
 *      distinct `aud`, which is what stops an MCP token being replayed against a portal route.
 *   4. **An unreachable key server is a 503, never an acceptance.** See `jwks.ts`.
 *
 * HONEST SCOPE LIMIT: the tests exercise this against a LOCALLY generated key pair and a locally
 * signed token. That proves the verification LOGIC — signature, claims, audience, scope refusal —
 * and proves nothing about a configured Keycloak realm. Real-IdP verification is
 * `BLOCKED_CREDENTIALS` on `KEYCLOAK_ISSUER`; EP-006 owns the realm.
 */

import { createPublicKey, createVerify } from 'node:crypto';

import type { JwksCache, JsonWebKey } from './jwks.ts';
import type {
  IdentityClaims,
  IdentityRefusal,
  IdentityResult,
} from '../../application/contracts/identity.ts';

/** The audiences a token may be issued for. Distinct by design (SPEC-003 §3.2 item 3). */
export const AUDIENCES = {
  PORTAL: 'vanishgraph-portal',
  SERVICE: 'vanishgraph-service',
  MCP: 'vanishgraph-mcp',
} as const;

export type Audience = (typeof AUDIENCES)[keyof typeof AUDIENCES];

/**
 * The claim, refusal and result shapes are the APPLICATION CONTRACT's, aliased here so existing
 * callers keep working. The adapter does not declare its own: a second declaration is how the wire
 * codes drift apart from the ones the boundary maps.
 */
export type VerifiedClaims = IdentityClaims;
export type TokenRefusal = IdentityRefusal;
export type VerifyResult = IdentityResult;

export interface VerifyOptions {
  readonly jwks: JwksCache;
  readonly issuer: string;
  /** The audience THIS route set expects. A token for another audience is refused. */
  readonly expectedAudience: Audience;
  readonly now: () => number;
  /** Clock skew tolerance in seconds for `exp`/`nbf`. */
  readonly clockToleranceSeconds?: number;
}

/** Algorithms accepted. `none` and HMAC are excluded so a key-confusion attack is unrepresentable. */
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512'] as const;

interface DecodedToken {
  readonly header: { alg?: string; kid?: string; typ?: string };
  readonly payload: Record<string, unknown>;
  readonly signingInput: string;
  readonly signature: Buffer;
}

/**
 * Decode a compact JWS WITHOUT verifying it.
 *
 * Splitting is not verification: everything read here is untrusted until `verifySignature` passes,
 * and the function deliberately does no claim checks so a caller cannot mistake decoding for
 * validation.
 */
function decode(token: string): DecodedToken | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) return undefined;

  try {
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as DecodedToken['header'];
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
    const signature = Buffer.from(signaturePart, 'base64url');
    if (signature.length === 0) return undefined;
    return { header, payload, signingInput: `${headerPart}.${payloadPart}`, signature };
  } catch {
    return undefined;
  }
}

function jwkToKey(jwk: JsonWebKey): ReturnType<typeof createPublicKey> {
  // Only RSA public keys are accepted. `createPublicKey` throws on anything malformed, and that
  // throw is caught by the caller and mapped to TOKEN_INVALID rather than escaping.
  return createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' } as never);
}

function verifySignature(decoded: DecodedToken, jwk: JsonWebKey): boolean {
  const algorithm = decoded.header.alg;
  if (algorithm === undefined || !(ALLOWED_ALGORITHMS as readonly string[]).includes(algorithm)) {
    return false;
  }
  const key = jwkToKey(jwk);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(decoded.signingInput);
  verifier.end();
  // `verify` returning false is a normal outcome; a throw would mean malformed key material, which
  // is equally a refusal. Both are reported as an invalid signature.
  try {
    return verifier.verify(key, decoded.signature);
  } catch {
    return false;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Accept a claim that is either a single string or an array of strings, as JWT permits. */
function asStringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value.length > 0 ? [value] : undefined;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as string[];
  }
  return undefined;
}

/**
 * Verify a compact JWS and return its claims, or the single wire code that explains the refusal.
 *
 * Order matters and is chosen so the most specific diagnosis wins: signature before claims (an
 * unsigned token tells us nothing about its claims), issuer before audience (a token from another
 * realm is not a "wrong audience" token), and claims before scopes.
 */
export async function verifyToken(token: string | undefined, options: VerifyOptions): Promise<VerifyResult> {
  if (token === undefined || token.trim().length === 0) {
    return { ok: false, code: 'TOKEN_MISSING', detail: 'no bearer token presented' };
  }

  const decoded = decode(token);
  if (decoded === undefined) {
    return { ok: false, code: 'TOKEN_INVALID', detail: 'not a three-part compact JWS' };
  }

  // 1. Signature. The key is fetched by the issuer the TOKEN names, then the issuer claim is checked
  //    against configuration: fetching by the configured issuer alone would let a token from
  //    another realm be verified with our key if it names our `kid`.
  const tokenIssuer = asString(decoded.payload['iss']);
  if (tokenIssuer === undefined) {
    return { ok: false, code: 'TOKEN_INVALID_CLAIMS', detail: 'iss is missing' };
  }
  if (tokenIssuer !== options.issuer) {
    return { ok: false, code: 'TOKEN_INVALID', detail: 'iss does not match the configured issuer' };
  }

  let jwk: JsonWebKey;
  try {
    jwk = await options.jwks.key(tokenIssuer, decoded.header.kid);
  } catch {
    // An unreachable or incomplete key set is a DEPENDENCY failure, not a bad token. Reporting 401
    // here would tell a caller their credential is wrong while the server is simply unwell.
    return { ok: false, code: 'DEPENDENCY_UNAVAILABLE', detail: 'signing key set unavailable' };
  }

  if (!verifySignature(decoded, jwk)) {
    return { ok: false, code: 'TOKEN_INVALID', detail: 'signature verification failed' };
  }

  // 2. Temporal bounds, with the configured tolerance.
  const nowSeconds = Math.floor(options.now() / 1000);
  const skew = options.clockToleranceSeconds ?? 30;
  const exp = asNumber(decoded.payload['exp']);
  if (exp === undefined) {
    return { ok: false, code: 'TOKEN_INVALID_CLAIMS', detail: 'exp is missing' };
  }
  if (nowSeconds > exp + skew) {
    return { ok: false, code: 'TOKEN_EXPIRED', detail: 'exp has passed' };
  }
  const nbf = asNumber(decoded.payload['nbf']);
  if (nbf !== undefined && nowSeconds + skew < nbf) {
    return { ok: false, code: 'TOKEN_INVALID', detail: 'nbf is in the future' };
  }

  // 3. Audience binding (SPEC-003 §3.2 item 3).
  const audValues = asStringArray(decoded.payload['aud']);
  if (audValues === undefined) {
    return { ok: false, code: 'TOKEN_INVALID_CLAIMS', detail: 'aud is missing' };
  }
  if (!audValues.includes(options.expectedAudience)) {
    return { ok: false, code: 'TOKEN_AUDIENCE_MISMATCH', detail: 'aud does not include this route set audience' };
  }

  // 4. Required claims (SPEC-005 IDP-4). Each absence is TOKEN_INVALID_CLAIMS, never a default.
  const sub = asString(decoded.payload['sub']);
  if (sub === undefined) return { ok: false, code: 'TOKEN_INVALID_CLAIMS', detail: 'sub is missing' };

  const tenantId = asString(decoded.payload['tenant_id']);
  if (tenantId === undefined) {
    // SPEC-005 IDP-4: a token lacking `tenant_id` is rejected outright. There is no all-tenants
    // token, so this must never fall back to a wildcard or an empty string.
    return { ok: false, code: 'TOKEN_INVALID_CLAIMS', detail: 'tenant_id is missing' };
  }

  const roles = asStringArray(decoded.payload['roles']);
  if (roles === undefined) {
    // SPEC-003 §3.2 item 2: absent is NOT an empty set. "Absent means none" and "absent means
    // unverified" are different failures and only one of them is safe.
    return { ok: false, code: 'TOKEN_INVALID_CLAIMS', detail: 'roles is missing or not a string array' };
  }

  const subjectRef = asString(decoded.payload['subject_ref']);
  if (subjectRef === undefined) {
    return { ok: false, code: 'TOKEN_INVALID_CLAIMS', detail: 'subject_ref is missing' };
  }

  const authLevel = asString(decoded.payload['auth_level']);
  if (authLevel === undefined) {
    return { ok: false, code: 'TOKEN_INVALID_CLAIMS', detail: 'auth_level is missing' };
  }

  // 5. Scope shape. `scopes` is optional (a token may derive scopes from roles), but when present
  //    a wildcard is refused outright (SPEC-003 §3.2 item 9).
  const scopes = asStringArray(decoded.payload['scopes']);
  if (scopes !== undefined && scopes.some((s) => s === '*' || s.includes('*'))) {
    return { ok: false, code: 'TOKEN_SCOPE_WILDCARD_FORBIDDEN', detail: 'a wildcard scope is present' };
  }

  return {
    ok: true,
    claims: {
      sub,
      iss: tokenIssuer,
      aud: options.expectedAudience,
      exp,
      nbf,
      iat: asNumber(decoded.payload['iat']),
      tenant_id: tenantId,
      roles,
      subject_ref: subjectRef,
      auth_level: authLevel,
      azp: asString(decoded.payload['azp']),
      scopes,
    },
  };
}

/**
 * Extract a bearer token from the `Authorization` header.
 *
 * BEARER ONLY (SPEC-003 §3.2 item 1): query-string tokens, cookies, `X-Api-Key` and
 * `Authorization: Basic` are not accepted on any `/v1` route. This function therefore reads exactly
 * one header and one scheme, and returns undefined for everything else rather than trying harder —
 * a fallback lookup is how a "temporary" query-string token becomes permanent.
 */
export function bearerFrom(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(value.trim());
  return match?.[1];
}
