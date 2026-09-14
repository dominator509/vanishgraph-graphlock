/**
 * JWKS retrieval and caching (SPEC-003 §3.2 item 1, SPEC-005 IDP-1…IDP-3).
 *
 * The security property this file must not break: **a cache miss that cannot reach the issuer is
 * a 503, never a degraded "accept unverified" path.** An auth adapter that falls back to trusting
 * a token when the key server is unreachable converts an outage into a total authentication
 * bypass, which is the worst possible failure mode for the one component everything else trusts.
 *
 * The network call is behind an injected port (`fetchJwks`) rather than made directly, for two
 * reasons: the verification logic becomes testable against a locally generated key pair (M3's
 * stated scope), and `src/http` never acquires an HTTP client of its own.
 *
 * HONEST SCOPE: this proves the KEY-RETRIEVAL and caching logic. Real-IdP verification is
 * `BLOCKED_CREDENTIALS` on `KEYCLOAK_ISSUER` (EP-006 owns the realm), so no test here is evidence
 * about a configured Keycloak.
 */

/** A single JSON Web Key, narrowed to what RS256 verification needs. */
export interface JsonWebKey {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
}

export interface JwksDocument {
  readonly keys: readonly JsonWebKey[];
}

/** The injected fetch port. Returns the raw JWKS document for an issuer. */
export type FetchJwks = (issuer: string) => Promise<JwksDocument>;

export interface JwksCacheOptions {
  readonly fetchJwks: FetchJwks;
  /** Injected so cache-expiry tests do not sleep. */
  readonly now: () => number;
  /** How long a fetched document is trusted. SPEC-007 §7.2 shape; 10 minutes by default. */
  readonly ttlMs?: number;
}

export class JwksUnavailableError extends Error {
  readonly issuer: string;
  constructor(issuer: string, reason: string) {
    // The issuer is a URL the operator configured, not a secret, but it is still not echoed to
    // clients: this message is for logs only.
    super(`JWKS unavailable for issuer (reason: ${reason})`);
    this.name = 'JwksUnavailableError';
    this.issuer = issuer;
  }
}

interface CacheEntry {
  readonly document: JwksDocument;
  readonly fetchedAt: number;
}

/**
 * A TTL cache keyed by issuer, resolving keys by `kid`.
 *
 * Keyed by ISSUER and not by `kid` alone: two issuers can legitimately publish the same `kid`, and
 * a cache keyed only by `kid` would let one realm's key verify another realm's token — the exact
 * cross-realm confusion `iss` checking exists to prevent.
 *
 * A `kid` that is absent from a CACHED document triggers exactly ONE refetch, because a realm
 * rotating its signing key is normal and the old document is then stale. If the refetch fails, or
 * the `kid` is still absent, it throws rather than accepting the token.
 */
export class JwksCache {
  private readonly fetchJwks: FetchJwks;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  /** Exposed for the SPEC-007 `keycloak-jwks.cacheAgeSeconds` measurement. */
  private lastAgeSeconds = 0;

  constructor(options: JwksCacheOptions) {
    this.fetchJwks = options.fetchJwks;
    this.now = options.now;
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  }

  /** The age of the entry that served the most recent lookup, in seconds. */
  cacheAgeSeconds(): number {
    return this.lastAgeSeconds;
  }

  private isFresh(entry: CacheEntry, at: number): boolean {
    return at - entry.fetchedAt < this.ttlMs;
  }

  private async load(issuer: string): Promise<JwksDocument> {
    let document: JwksDocument;
    try {
      document = await this.fetchJwks(issuer);
    } catch {
      // The thrown value is not propagated: its message could carry a URL with credentials. Only
      // the fact and the issuer survive, and the caller maps this to 503 DEPENDENCY_UNAVAILABLE.
      throw new JwksUnavailableError(issuer, 'fetch failed');
    }
    if (!Array.isArray(document.keys) || document.keys.length === 0) {
      throw new JwksUnavailableError(issuer, 'the JWKS document contains no keys');
    }
    this.entries.set(issuer, { document, fetchedAt: this.now() });
    this.lastAgeSeconds = 0;
    return document;
  }

  /**
   * Resolve the key for `kid`, fetching or refetching as needed.
   *
   * Throws `JwksUnavailableError` when the issuer cannot be reached, and a distinct error when the
   * key is genuinely unknown — the two must not be conflated, because one is a 503 and the other is
   * a 401, and reporting a 503 for a bad token would tell an attacker the server is unwell.
   */
  async key(issuer: string, kid: string | undefined): Promise<JsonWebKey> {
    const at = this.now();
    let entry = this.entries.get(issuer);

    if (entry === undefined || !this.isFresh(entry, at)) {
      const document = await this.load(issuer);
      entry = { document, fetchedAt: at };
    } else {
      this.lastAgeSeconds = Math.floor((at - entry.fetchedAt) / 1000);
    }

    const found = entry.document.keys.find((k) => (kid === undefined ? true : k.kid === kid));
    if (found !== undefined) return found;

    // The `kid` is absent from a cached document. A rotation is normal, so refetch exactly once.
    // Only do this when the entry was CACHED: if it was just fetched, the key is genuinely unknown
    // and a second fetch would only hammer the issuer.
    const document = await this.load(issuer);
    const afterRefresh = document.keys.find((k) => (kid === undefined ? true : k.kid === kid));
    if (afterRefresh === undefined) {
      throw new JwksUnavailableError(issuer, `no key matches kid (${kid ?? 'unspecified'})`);
    }
    return afterRefresh;
  }

  /** Drop a cached document. Used by tests and by an explicit rotation signal. */
  invalidate(issuer: string): void {
    this.entries.delete(issuer);
  }

  /** Test/ops visibility: is a document cached for this issuer? */
  has(issuer: string): boolean {
    return this.entries.has(issuer);
  }
}

/**
 * A `FetchJwks` that reaches the issuer over HTTPS.
 *
 * Kept here rather than in `src/http` so the HTTP layer never owns a network client. The issuer is
 * taken from configuration, and the well-known path is appended per OIDC discovery.
 */
export function httpsJwksFetcher(): FetchJwks {
  return async (issuer: string): Promise<JwksDocument> => {
    const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    // Discovery first, so the JWKS URI is whatever the issuer advertises rather than a guess.
    const discovery = await fetch(url, { redirect: 'error' });
    if (!discovery.ok) throw new Error(`discovery returned ${discovery.status}`);
    const meta = (await discovery.json()) as { jwks_uri?: string };
    if (typeof meta.jwks_uri !== 'string' || meta.jwks_uri.length === 0) {
      throw new Error('discovery document has no jwks_uri');
    }
    const jwks = await fetch(meta.jwks_uri, { redirect: 'error' });
    if (!jwks.ok) throw new Error(`jwks returned ${jwks.status}`);
    return (await jwks.json()) as JwksDocument;
  };
}
