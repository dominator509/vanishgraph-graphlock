/**
 * Rate limits and the conservative discovery ceiling (SPEC-005 §9 VG-AUTH-016, VG-DISC-003; EP-006 M6).
 *
 * The assertions that matter here are about ORDER and about what a refusal does NOT do: the conservative ceiling is
 * checked before dispatch, a refused call consumes no budget, and every response — admitted or refused — carries the
 * three `RateLimit-*` headers, because a client that cannot see its remaining budget retries into a wall.
 *
 * THE PRODUCTION BINDING IS NOT WIRED, and the suite says so rather than implying it: the counter is an in-memory port
 * implementation, which is per-process and resets on deploy. The coordination-store binding remains open.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RATE_LIMIT_POLICY,
  DISCOVERY_SOURCE_CEILING,
  checkRateLimit,
  type RateLimitClass,
} from '../../src/application/security/rate-limit-policy.ts';
import { InMemoryRateLimitCounter } from '../../src/adapters/coordination/rate-limit.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ACTOR = 'operator-opaque-1';
const NOW = 1_800_000_000;

function key(rateClass: RateLimitClass, overrides: Record<string, unknown> = {}): Parameters<typeof checkRateLimit>[0] {
  return { tenantId: TENANT, actorIdentity: ACTOR, rateClass, ...overrides };
}

describe('every class has both a per-tenant and a per-identity ceiling (VG-AUTH-016)', () => {
  test('the four classes VG-AUTH-016 names are declared with both scopes', () => {
    for (const rateClass of ['discovery', 'write', 'verification', 'evidence_read'] as RateLimitClass[]) {
      assert.ok(DEFAULT_RATE_LIMIT_POLICY.perTenant[rateClass].limit > 0, `${rateClass} needs a tenant limit`);
      assert.ok(DEFAULT_RATE_LIMIT_POLICY.perIdentity[rateClass].limit > 0, `${rateClass} needs an identity limit`);
      // The identity ceiling is the tighter one: a single account must not be able to spend the tenant's whole budget.
      assert.ok(
        DEFAULT_RATE_LIMIT_POLICY.perIdentity[rateClass].limit < DEFAULT_RATE_LIMIT_POLICY.perTenant[rateClass].limit,
        `${rateClass}: the per-identity limit must be tighter than the per-tenant one`,
      );
    }
  });

  test('an admitted call consumes one unit and reports the headers', async () => {
    const counter = new InMemoryRateLimitCounter();
    const first = await checkRateLimit(key('write'), counter, NOW);
    assert.equal(first.allow, true);
    assert.equal(first.headers['RateLimit-Limit'], String(DEFAULT_RATE_LIMIT_POLICY.perIdentity.write.limit));
    // The LAST increment wins the headers, and the tightest ceiling is the identity one, so remaining falls from it.
    assert.equal(first.headers['RateLimit-Remaining'], String(DEFAULT_RATE_LIMIT_POLICY.perIdentity.write.limit - 1));
    const second = await checkRateLimit(key('write'), counter, NOW);
    assert.equal(second.headers['RateLimit-Remaining'], String(DEFAULT_RATE_LIMIT_POLICY.perIdentity.write.limit - 2));
    assert.ok(Number(second.headers['RateLimit-Reset']) > 0);
  });

  test('the ceiling refuses with RATE_LIMITED, a Retry-After, and NO state change', async () => {
    const counter = new InMemoryRateLimitCounter();
    const limit = DEFAULT_RATE_LIMIT_POLICY.perIdentity.discovery.limit;
    for (let call = 0; call < limit; call += 1) {
      assert.equal((await checkRateLimit(key('discovery'), counter, NOW)).allow, true, `call ${String(call)}`);
    }
    const before = await counter.read(`identity:${TENANT}:${ACTOR}:discovery`, 3600, NOW);
    const refused = await checkRateLimit(key('discovery'), counter, NOW);
    assert.equal(refused.allow, false);
    assert.equal(refused.code, 'RATE_LIMITED');
    assert.ok((refused.retryAfterSeconds ?? 0) > 0);
    assert.match(refused.detail ?? '', /refused before dispatch and nothing was counted for it/);
    assert.ok((refused.refusedBy ?? '').includes(`identity:${TENANT}:${ACTOR}:discovery`));
    // NOTHING WAS COUNTED FOR THE REFUSED CALL: a limiter that counted it would make Retry-After a lie.
    const after = await counter.read(`identity:${TENANT}:${ACTOR}:discovery`, 3600, NOW);
    assert.equal(after, before);
    // And a refused response still carries the three headers, so the client can see where it stands.
    assert.equal(refused.headers['RateLimit-Remaining'], '0');
    assert.equal(refused.headers['RateLimit-Limit'], String(limit));
  });

  test('the per-tenant ceiling can refuse while the identity has budget left', async () => {
    const counter = new InMemoryRateLimitCounter();
    const tenantLimit = DEFAULT_RATE_LIMIT_POLICY.perTenant.verification.limit;
    // Fill the TENANT bucket by using distinct actors, so no single identity reaches its own limit.
    for (let call = 0; call < tenantLimit; call += 1) {
      const decision = await checkRateLimit(key('verification', { actorIdentity: `actor-${String(call)}` }), counter, NOW);
      assert.equal(decision.allow, true, `call ${String(call)}`);
    }
    const refused = await checkRateLimit(key('verification', { actorIdentity: 'actor-fresh' }), counter, NOW);
    assert.equal(refused.allow, false);
    assert.ok((refused.refusedBy ?? '').startsWith(`tenant:${TENANT}`), `refused by ${String(refused.refusedBy)}`);
  });

  test('one tenant exhausting its budget does not refuse another', async () => {
    const counter = new InMemoryRateLimitCounter();
    const limit = DEFAULT_RATE_LIMIT_POLICY.perIdentity.discovery.limit;
    for (let call = 0; call < limit; call += 1) await checkRateLimit(key('discovery'), counter, NOW);
    assert.equal((await checkRateLimit(key('discovery'), counter, NOW)).allow, false);
    assert.equal((await checkRateLimit(key('discovery', { tenantId: OTHER_TENANT }), counter, NOW)).allow, true);
  });
});

describe('the conservative discovery ceiling is checked before dispatch (VG-DISC-003)', () => {
  test('the per-(tenantId, sourceId) ceiling is tighter than the identity limit and refuses on its own', async () => {
    const counter = new InMemoryRateLimitCounter();
    assert.ok(DISCOVERY_SOURCE_CEILING.limit < DEFAULT_RATE_LIMIT_POLICY.perIdentity.discovery.limit);
    for (let call = 0; call < DISCOVERY_SOURCE_CEILING.limit; call += 1) {
      const decision = await checkRateLimit(key('discovery', { sourceId: 'SOURCE_ALPHA' }), counter, NOW);
      assert.equal(decision.allow, true, `call ${String(call)}`);
    }
    const refused = await checkRateLimit(key('discovery', { sourceId: 'SOURCE_ALPHA' }), counter, NOW);
    assert.equal(refused.allow, false);
    assert.equal(refused.refusedBy, `source:${TENANT}:SOURCE_ALPHA`);
    // A DIFFERENT SOURCE HAS ITS OWN BUDGET: the ceiling is per source, not per tenant.
    assert.equal((await checkRateLimit(key('discovery', { sourceId: 'SOURCE_BETA' }), counter, NOW)).allow, true);
    // AND ANOTHER TENANT DOES NOT INHERIT THIS TENANT'S SPENT BUDGET.
    assert.equal((await checkRateLimit(key('discovery', { tenantId: OTHER_TENANT, sourceId: 'SOURCE_ALPHA' }), counter, NOW)).allow, true);
  });

  test('the ceiling applies only to discovery: a write is not counted against a source bucket', async () => {
    const counter = new InMemoryRateLimitCounter();
    for (let call = 0; call < DISCOVERY_SOURCE_CEILING.limit; call += 1) {
      await checkRateLimit(key('discovery', { sourceId: 'SOURCE_ALPHA' }), counter, NOW);
    }
    const write = await checkRateLimit(key('write', { sourceId: 'SOURCE_ALPHA' }), counter, NOW);
    assert.equal(write.allow, true);
    assert.equal(await counter.read(`source:${TENANT}:SOURCE_ALPHA`, 3600, NOW), DISCOVERY_SOURCE_CEILING.limit, 'the write did not touch the source bucket');
  });

  test('a refusal carries the ceiling it hit, so an operator can tell which budget ran out', async () => {
    const counter = new InMemoryRateLimitCounter();
    for (let call = 0; call < DISCOVERY_SOURCE_CEILING.limit; call += 1) {
      await checkRateLimit(key('discovery', { sourceId: 'SOURCE_ALPHA' }), counter, NOW);
    }
    const refused = await checkRateLimit(key('discovery', { sourceId: 'SOURCE_ALPHA' }), counter, NOW);
    assert.match(refused.detail ?? '', /source:.*SOURCE_ALPHA is at 5 of 5/);
    assert.equal(refused.headers['RateLimit-Remaining'], '0');
  });
});


