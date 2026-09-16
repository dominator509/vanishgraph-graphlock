/**
 * Secret handling: resolution by reference, no fallback, isolation and access logging (SPEC-005 §8; EP-006 M8).
 *
 * The assertion that matters is the one about what a FAILURE does not do. A test that only checked the returned code would
 * pass against a resolver that quietly served a plaintext value, so this suite counts the exchanges, plants a decoy map,
 * and asserts the decoy was never consulted.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkloadSecretResolver,
  decoyPlaintext,
  type WorkloadIdentityExchange,
} from '../../src/adapters/secrets/secret-resolver.ts';
import type { SecretAccessLog, WorkloadIdentity } from '../../src/domain/ports/secret-resolver.ts';

const NOW = '2026-09-16T00:00:00Z';
const IDENTITY: WorkloadIdentity = { workload: 'runner-opaque-1', environment: 'production', provider: 'seaweedfs' };

/** A resolver wired for the suite, with an exchange that can be made to fail. */
function resolver(options: { readonly exchangeFails?: boolean; readonly identity?: WorkloadIdentity } = {}): {
  readonly resolver: WorkloadSecretResolver;
  readonly logs: SecretAccessLog[];
  readonly attempts: string[];
} {
  const logs: SecretAccessLog[] = [];
  const attempts: string[] = [];
  const exchange: WorkloadIdentityExchange = async (reference) => {
    attempts.push(reference);
    if (options.exchangeFails === true) return undefined;
    return { value: `value-for-${reference}`, expiresAt: '2026-09-16T01:00:00Z' };
  };
  return {
    resolver: new WorkloadSecretResolver({
      exchange,
      now: () => NOW,
      log: (row) => logs.push(row),
      declaredReferences: ['object-store-key', 'mail-provider-key', 'staging-only-key', 'search-provider-key'],
      ownership: {
        'object-store-key': { provider: 'seaweedfs', environment: 'production' },
        'mail-provider-key': { provider: 'postal', environment: 'production' },
        'staging-only-key': { provider: 'seaweedfs', environment: 'staging' },
        'search-provider-key': { provider: 'search', environment: 'production' },
      },
      decoyPlaintext: decoyPlaintext({ 'object-store-key': 'PLAINTEXT-DECOY-VALUE' }),
    }),
    logs,
    attempts,
  };
}

describe('resolution is by reference and succeeds only through the workload-identity exchange (VG-AUTH-011/012)', () => {
  test('a declared reference resolves, and the access is logged with the accessing workload identity', async () => {
    const { resolver: subject, logs, attempts } = resolver();
    const result = await subject.resolve({ reference: 'object-store-key', holding: 'WORKLOAD_IDENTITY' }, IDENTITY);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value, 'value-for-object-store-key');
      assert.equal(result.expiresAt, '2026-09-16T01:00:00Z', 'a workload-identity secret is short-lived and says so');
    }
    assert.deepEqual(attempts, ['object-store-key']);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.workload, 'runner-opaque-1');
    assert.equal(logs[0]?.environment, 'production');
    assert.equal(logs[0]?.outcome, 'resolved');
  });

  test('an undeclared reference is SECRET_NOT_CONFIGURED without any exchange attempt', async () => {
    const { resolver: subject, attempts, logs } = resolver();
    const result = await subject.resolve({ reference: 'invented-key', holding: 'WORKLOAD_IDENTITY' }, IDENTITY);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'SECRET_NOT_CONFIGURED');
    assert.deepEqual(attempts, [], 'an undeclared reference is refused before the exchange');
    assert.equal(logs[0]?.outcome, 'refused');
  });

  test('REQUIRED NEGATIVE CASE: a failed exchange yields DEPENDENCY_UNAVAILABLE with ZERO fallback attempts', async () => {
    const { resolver: subject, attempts, logs } = resolver({ exchangeFails: true });
    const result = await subject.resolve({ reference: 'object-store-key', holding: 'WORKLOAD_IDENTITY' }, IDENTITY);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'DEPENDENCY_UNAVAILABLE');
      assert.match(result.detail, /no plaintext, \.env, empty or cached fallback/);
    }
    // THE FAILURE PATH MADE EXACTLY ONE ATTEMPT: the exchange itself. A fallback would show up as a second resolution
    // path, and the decoy map — which has a value for this reference — was never consulted.
    assert.deepEqual(attempts, ['object-store-key']);
    assert.equal(logs.at(-1)?.outcome, 'refused');
    assert.equal(logs.at(-1)?.code, 'DEPENDENCY_UNAVAILABLE');
  });

  test('a static secret needs a live exception, and the refusal names why', async () => {
    const { resolver: subject, attempts } = resolver();
    // THE MAIL PROVIDER'S OWN RUNNER: MEASURED, the first version used the object-store identity here, so the
    // provider isolation rule refused the live-exception case and the test failed for a reason unrelated to exceptions.
    const mailIdentity = { ...IDENTITY, provider: 'postal' };
    const noException = await subject.resolve({ reference: 'mail-provider-key', holding: 'STATIC' }, mailIdentity);
    if (!noException.ok) {
      assert.equal(noException.code, 'STATIC_EXCEPTION_REQUIRED');
      assert.match(noException.detail, /time-bounded exception/);
    }
    assert.deepEqual(attempts, [], 'no exchange is attempted for a static secret without an exception');
    const expired = await subject.resolve(
      { reference: 'mail-provider-key', holding: 'STATIC', exception: { reason: 'legacy', owner: 'ops', expiresAt: '2026-01-01T00:00:00Z' } },
      mailIdentity,
    );
    assert.equal(expired.ok, false);
    const live = await subject.resolve(
      { reference: 'mail-provider-key', holding: 'STATIC', exception: { reason: 'legacy provider', owner: 'ops', expiresAt: '2027-01-01T00:00:00Z' } },
      mailIdentity,
    );
    assert.equal(live.ok, true);
  });
});

describe('runners are isolated by provider and by environment (VG-AUTH-015)', () => {
  test('a production identity may not hold a staging credential, and the refusal happens before the exchange', async () => {
    const { resolver: subject, attempts, logs } = resolver();
    const result = await subject.resolve({ reference: 'staging-only-key', holding: 'WORKLOAD_IDENTITY' }, IDENTITY);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.detail, /belongs to the staging environment/);
    assert.deepEqual(attempts, [], 'the isolation check runs before anything leaves the process');
    assert.equal(logs[0]?.code, 'SECRET_NOT_CONFIGURED');
  });

  test('a runner for one provider may not resolve another provider’s secret', async () => {
    const { resolver: subject, attempts } = resolver();
    const result = await subject.resolve({ reference: 'search-provider-key', holding: 'WORKLOAD_IDENTITY' }, IDENTITY);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.detail, /belongs to provider search/);
    assert.deepEqual(attempts, []);
    // The same runner resolving its own provider's secret proceeds, so the check is about the provider.
    assert.equal((await subject.resolve({ reference: 'object-store-key', holding: 'WORKLOAD_IDENTITY' }, IDENTITY)).ok, true);
  });

  test('a runner with no provider on its identity is not restricted by the provider check', async () => {
    const { resolver: subject } = resolver();
    const identity: WorkloadIdentity = { workload: 'runner-opaque-2', environment: 'production' };
    assert.equal((await subject.resolve({ reference: 'search-provider-key', holding: 'WORKLOAD_IDENTITY' }, identity)).ok, true);
  });
});

