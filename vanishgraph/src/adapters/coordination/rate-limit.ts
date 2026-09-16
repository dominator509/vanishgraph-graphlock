/**
 * Rate limits and the conservative discovery ceiling (SPEC-005 §9 VG-AUTH-016, VG-DISC-003; SPEC-003 §2.7; EP-006 M6).
 *
 * THE COUNTER IS A PORT, AND THE IN-MEMORY IMPLEMENTATION IS A TEST DOUBLE WITH A NAME THAT SAYS SO. The production
 * binding is the coordination store (Valkey) or the database, and neither is wired here: a limiter that lived in process
 * memory in production would reset on every deploy and be per-replica, which is a limit that does not limit. The port's
 * shape is what this milestone fixes and asserts.
 *
 * THE DECISION IS MADE BEFORE DISPATCH. VG-DISC-003 requires the per-`(tenantId, sourceId)` discovery ceiling to be
 * enforced CLIENT-SIDE BEFORE the call, so an over-budget request is refused rather than silently overrunning somebody
 * else's budget — that is why `check` returns a decision the caller must consult rather than a counter it increments after
 * the fact.
 *
 * EFFECT BUDGETS STAY AUTHORITATIVE IN THE DOMAIN (VG-ACTION-005). This layer is an ADDITIONAL CEILING and never a
 * substitute: a request that passes here can still be refused by the domain's budget, and nothing in this module may
 * report that a budget was available.
 */

export type RateLimitClass = 'discovery' | 'write' | 'verification' | 'evidence_read';

export interface RateLimitRule {
  readonly limit: number;
  /** The window the limit applies over, in seconds. */
  readonly windowSeconds: number;
}

/** The declared rules, per class, for the two scopes VG-AUTH-016 names. */
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

/** One counted call. */
export interface RateLimitKey {
  readonly tenantId: string;
  readonly actorIdentity: string;
  readonly rateClass: RateLimitClass;
  /** Present for the discovery ceiling, absent otherwise. */
  readonly sourceId?: string | undefined;
}

/** The counter store. `increment` returns the count AFTER the increment, and `read` never mutates. */
export interface RateLimitCounter {
  increment(bucket: string, windowSeconds: number, now: number): Promise<number>;
  read(bucket: string, windowSeconds: number, now: number): Promise<number>;
}

/** An in-memory counter, used by the contract suite. NOT a production binding: it is per-process and resets on deploy. */
export class InMemoryRateLimitCounter implements RateLimitCounter {
  readonly #buckets = new Map<string, number>();

  async increment(bucket: string, _windowSeconds: number, now: number): Promise<number> {
    const key = `${bucket}@${String(Math.floor(now / 3600))}`;
    const next = (this.#buckets.get(key) ?? 0) + 1;
    this.#buckets.set(key, next);
    return next;
  }

  async read(bucket: string, _windowSeconds: number, now: number): Promise<number> {
    return this.#buckets.get(`${bucket}@${String(Math.floor(now / 3600))}`) ?? 0;
  }
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
  /** The `Retry-After` a refusal carries, in seconds. */
  readonly retryAfterSeconds?: number;
  readonly headers: RateLimitHeaders;
  /** The bucket that refused, so an operator can see which ceiling was hit. */
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
 * THE ORDER MATTERS: the ceilings are read first and the counters incremented only if every one of them admits the call.
 * A limiter that incremented as it checked would consume the budget of a request it then refused, which turns a refusal
 * into a second penalty and makes `Retry-After` a lie.
 */
export async function checkRateLimit(
  key: RateLimitKey,
  counter: RateLimitCounter,
  now: number,
  policy: RateLimitPolicy = DEFAULT_RATE_LIMIT_POLICY,
): Promise<RateLimitDecision> {
  const tenantRule = policy.perTenant[key.rateClass];
  const identityRule = policy.perIdentity[key.rateClass];
  const checks: { readonly bucket: string; readonly rule: RateLimitRule; readonly used: number }[] = [
    { bucket: `tenant:${key.tenantId}:${key.rateClass}`, rule: tenantRule, used: await counter.read(`tenant:${key.tenantId}:${key.rateClass}`, tenantRule.windowSeconds, now) },
    // THE IDENTITY BUCKET IS KEYED BY TENANT TOO, AND MEASURED: keying it by the actor alone made one tenant's spent
    // budget refuse the same principal in ANOTHER tenant - a cross-tenant denial of service through a shared bucket,
    // which is the same class of defect as a cross-tenant read.
    { bucket: `identity:${key.tenantId}:${key.actorIdentity}:${key.rateClass}`, rule: identityRule, used: await counter.read(`identity:${key.tenantId}:${key.actorIdentity}:${key.rateClass}`, identityRule.windowSeconds, now) },
  ];
  if (key.rateClass === 'discovery' && key.sourceId !== undefined) {
    // THE CONSERVATIVE CEILING IS CHECKED HERE, BEFORE DISPATCH (VG-DISC-003).
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

  // ADMITTED: now the counters move, once each.
  let lastUsed = 0;
  let limit = tenantRule.limit;
  for (const check of checks) {
    lastUsed = await counter.increment(check.bucket, check.rule.windowSeconds, now);
    limit = check.rule.limit;
  }
  return { allow: true, headers: headers(limit, lastUsed, windowSecondsFor(key, policy), now) };
}

function windowSecondsFor(key: RateLimitKey, policy: RateLimitPolicy): number {
  return key.rateClass === 'discovery' && key.sourceId !== undefined
    ? DISCOVERY_SOURCE_CEILING.windowSeconds
    : policy.perIdentity[key.rateClass].windowSeconds;
}

/** The success path's headers, for a response that was admitted. */
export function rateLimitHeadersFor(decision: RateLimitDecision): RateLimitHeaders {
  return decision.headers;
}

