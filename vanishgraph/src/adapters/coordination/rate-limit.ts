/**
 * The rate-limit counter binding (SPEC-005 §9 VG-AUTH-016; EP-006 M6).
 *
 * THE PORT AND THE DECISION LIVE IN THE APPLICATION LAYER (`application/security/rate-limit-policy.ts`); this file holds
 * only the implementation, because `src/http` may not import an adapter and a port declared here would force it to.
 *
 * THE PRODUCTION BINDING IS NOT WIRED, AND THAT IS RECORDED RATHER THAN IMPLIED. The implementation below is in process
 * memory: it is per replica and it resets on deploy, so in production it would be a limit that does not limit. The
 * coordination-store binding (Valkey) is what production needs and it is not written here; the contract suite asserts the
 * PORT's behaviour through this implementation, and the ledger row says which half is done.
 */

import type { RateLimitCounter } from '../../application/security/rate-limit-policy.ts';

/**
 * An in-memory counter, used by the contract suite.
 *
 * THE NAME SAYS WHAT IT IS so a reader cannot mistake it for the binding. It buckets by the hour, which is the window the
 * declared rules use; a production binding would carry the window in the key and expire it.
 */
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
