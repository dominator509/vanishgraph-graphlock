/**
 * The rate-limit PORT and its decision (SPEC-005 §9 VG-AUTH-016, VG-DISC-003; EP-006 M6).
 *
 * THE PORT LIVES IN THE APPLICATION LAYER BECAUSE THE HTTP LAYER MUST NOT IMPORT AN ADAPTER. MEASURED: the first version
 * of this code put both the port and the in-memory implementation in `src/adapters/coordination/rate-limit.ts`, and the
 * rate-limit plugin — which lives in `src/http` — imported it, so `import-boundary.sh` failed with "http must not import
 * adapters or infrastructure". The layer law is not a formality: it is what stops the HTTP layer acquiring a concrete
 * storage dependency, and the fix is the correct shape rather than an exemption.
 *
 * THE DECISION IS MADE BEFORE DISPATCH. VG-DISC-003 requires the per-`(tenantId, sourceId)` discovery ceiling to be
 * enforced before the call, so `checkRateLimit` returns a decision the caller must consult rather than a counter it
 * increments afterwards.
 *
 * EFFECT BUDGETS STAY AUTHORITATIVE IN THE DOMAIN (VG-ACTION-005). This layer is an ADDITIONAL CEILING and never a
 * substitute: nothing here reports that a budget was available.
 */

export type RateLimitClass = 'discovery' | 'write' | 'verification' | 'evidence_read';

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitPolicy {
  readonly perTenant: Readonly<Record<RateLimitClass, RateLimitRule>>;
  readonly perIdentity: Readonly<Record<RateLimitClass, RateLimitRule>>;
}

export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = Object.freeze({
  perTenant: {
    discovery: { limit: 60, windowSeconds: 3600 },
    write: { limit: 120, windowSeconds: 3600 },
    verification: { limit: 240, windowSeconds: 3600 },
    evidence_read: { limit: 600, windowSeconds: 3600 },
  },
  perIdentity: {
    discovery: { limit: 10, windowSeconds: 3600 },
    write: { limit: 30, windowSeconds: 3600 },
    verification: { limit: 60, windowSeconds: 3600 },
    evidence_read: { limit: 120, windowSeconds: 3600 },
  },
});

/** The conservative per-source discovery ceiling (VG-DISC-003), measured per `(tenantId, sourceId)`. */
export const DISCOVERY_SOURCE_CEILING: RateLimitRule = Object.freeze({ limit: 5, windowSeconds: 3600 });

export interface RateLimitKey {
  readonly tenantId: string;
  readonly actorIdentity: string;
  readonly rateClass: RateLimitClass;
  readonly sourceId?: string | undefined;
}

/** The counter port. `increment` returns the count AFTER the increment; `read` never mutates. */
export interface RateLimitCounter {
  increment(bucket: string, windowSeconds: number, now: number): Promise<number>;
  read(bucket: string, windowSeconds: number, now: number): Promise<number>;
}

export interface RateLimitHeaders {
  readonly 'RateLimit-Limit': string;
  readonly 'RateLimit-Remaining': string;
  readonly 'RateLimit-Reset': string;
}

export interface RateLimitDecision {
  readonly allow: boolean;
  readonly code?: 'RATE_LIMITED';
  readonly detail?: string;
  readonly retryAfterSeconds?: number;
  readonly headers: RateLimitHeaders;
  readonly refusedBy?: string;
}

function headers(limit: number, used: number, windowSeconds: number, now: number): RateLimitHeaders {
  return {
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': String(Math.max(0, limit - used)),
    'RateLimit-Reset': String(windowSeconds - (now % windowSeconds)),
  };
}

/**
 * Check a request against every ceiling that applies and RETURN A DECISION WITHOUT COUNTING WHEN REFUSED.
 *
 * THE CEILINGS ARE READ FIRST and the counters incremented only if every one admits the call: a limiter that incremented
 * as it checked would consume the budget of a request it then refused, turning a refusal into a second penalty and making
 * `Retry-After` a lie.
 *
 * THE IDENTITY BUCKET IS KEYED BY TENANT TOO. MEASURED: keying it by the actor alone made one tenant's spent budget
 * refuse the same principal in ANOTHER tenant — a cross-tenant denial of service through a shared bucket.
 */
export async function checkRateLimit(
  key: RateLimitKey,
  counter: RateLimitCounter,
  now: number,
  policy: RateLimitPolicy = DEFAULT_RATE_LIMIT_POLICY,
): Promise<RateLimitDecision> {
  const tenantRule = policy.perTenant[key.rateClass];
  const identityRule = policy.perIdentity[key.rateClass];
  const tenantBucket = `tenant:${key.tenantId}:${key.rateClass}`;
  const identityBucket = `identity:${key.tenantId}:${key.actorIdentity}:${key.rateClass}`;
  const checks: { readonly bucket: string; readonly rule: RateLimitRule; readonly used: number }[] = [
    { bucket: tenantBucket, rule: tenantRule, used: await counter.read(tenantBucket, tenantRule.windowSeconds, now) },
    { bucket: identityBucket, rule: identityRule, used: await counter.read(identityBucket, identityRule.windowSeconds, now) },
  ];
  if (key.rateClass === 'discovery' && key.sourceId !== undefined) {
    const bucket = `source:${key.tenantId}:${key.sourceId}`;
    checks.push({ bucket, rule: DISCOVERY_SOURCE_CEILING, used: await counter.read(bucket, DISCOVERY_SOURCE_CEILING.windowSeconds, now) });
  }

  for (const check of checks) {
    if (check.used >= check.rule.limit) {
      return {
        allow: false,
        code: 'RATE_LIMITED',
        detail: `${check.bucket} is at ${String(check.used)} of ${String(check.rule.limit)} in this window; the call is refused before dispatch and nothing was counted for it`,
        retryAfterSeconds: check.rule.windowSeconds - (now % check.rule.windowSeconds),
        headers: headers(check.rule.limit, check.used, check.rule.windowSeconds, now),
        refusedBy: check.bucket,
      };
    }
  }

  let lastUsed = 0;
  let lastRule: RateLimitRule = identityRule;
  for (const check of checks) {
    lastUsed = await counter.increment(check.bucket, check.rule.windowSeconds, now);
    lastRule = check.rule;
  }
  return { allow: true, headers: headers(lastRule.limit, lastUsed, lastRule.windowSeconds, now) };
}
