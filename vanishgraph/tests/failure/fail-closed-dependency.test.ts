/**
 * Forced failure: an unavailable dependency must fail CLOSED and leak nothing (DOD-014; SPEC-003 §5.17, SPEC-006 §7.1
 * row 22; EP-007 M3).
 *
 * THE FAILURE THIS FILE MAKES HAPPEN IS A DEAD DATABASE, and the two properties it asserts are the ones an outage would
 * otherwise destroy:
 *
 *   * **Readiness reports NOT READY.** `postgresReadinessProbe` runs a REAL query inside a real transaction, so an
 *     unreachable server yields `ok: false`. A probe that answered from configuration would report ready for a database
 *     that is down — the static-200 failure the readiness contract forbids.
 *   * **A tenant transaction REJECTS rather than resolving empty.** This is the dangerous conversion: a caller that
 *     receives `{ rows: [] }` from an unreachable server concludes "no such row" and the request becomes a 404 about a
 *     resource that exists. Nothing here may swallow a connection failure into an empty result.
 *
 * AND THE PROBE'S OWN REASON IS ASSERTED TO BE GENERIC. The adapter's comment records that a driver error can carry a
 * host, a port, a user name or a connection string, and that the probe's result reaches a `/ready` response body — so
 * the reason must be a sentence, never the error.
 *
 * NO DATABASE IS NEEDED AND NONE IS CONTACTED: the DSN points at a port nothing listens on (port 1), so every path here
 * is a real connection failure rather than a simulated one.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresTenantRunner, postgresReadinessProbe } from '../../src/adapters/persistence/postgres-runner.ts';
import { parseDsn } from '../../src/infrastructure/database/psql.ts';

const PASSWORD = 'not-a-real-password-shape';
/** Port 1 has no listener: connecting is refused immediately, which is the outage this suite needs. */
const DEAD = parseDsn(`postgres://vg_app:${PASSWORD}@127.0.0.1:1/vanishgraph_main`);
const TENANT = '11111111-1111-4111-8111-111111111111';

/** The refusal an operation produced, or `undefined` when it did not refuse. */
async function refusalOf(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('forced failure: an unreachable database fails closed (DOD-014)', () => {
  test('the readiness probe reports NOT ready, and its reason carries no host, port, user or password', async () => {
    const runner = new PostgresTenantRunner({ dsn: DEAD, maxConnections: 1 });
    try {
      const probe = await postgresReadinessProbe(runner);
      assert.equal(probe.name, 'postgres');
      assert.equal(probe.ok, false, 'a database that cannot be reached is NOT ready');
      assert.equal(typeof probe.reason, 'string');
      const reason = probe.reason ?? '';
      for (const leak of [PASSWORD, '127.0.0.1', 'vanishgraph_main', 'vg_app']) {
        assert.equal(reason.includes(leak), false, `the probe reason must not carry "${leak}": ${reason}`);
      }
      assert.ok(reason.length > 0, 'and it must still say something a reader can act on');
    } finally {
      await runner.close();
    }
  });

  test('a tenant transaction REJECTS; it never resolves with an empty result', async () => {
    // THE CONVERSION THAT WOULD BE A DEFECT: `{ rows: [] }` from a dead server reads as "no such row" downstream, and a
    // resource that exists becomes a 404 — or worse, an authorization decision is made on an empty read.
    const runner = new PostgresTenantRunner({ dsn: DEAD, maxConnections: 1 });
    try {
      const refusal = await refusalOf(async () =>
        runner.withTenantTransaction(TENANT, async () => {
          throw new Error('the callback must never run: there is no connection to run it on');
        }),
      );
      assert.ok(refusal instanceof Error, 'an unreachable database must raise, not resolve');
      assert.equal(refusal.message.includes(PASSWORD), false, 'and the failure must not echo the password');
    } finally {
      await runner.close();
    }
  });

  test('a capability transaction rejects on the same dependency, so the webhook path is not an exception', async () => {
    const runner = new PostgresTenantRunner({ dsn: DEAD, maxConnections: 1 });
    try {
      const refusal = await refusalOf(() =>
        runner.withCapabilityTransaction('token_hash', 'a'.repeat(64), async () => 'unreachable'),
      );
      assert.ok(refusal instanceof Error, 'the capability path must fail the same way the tenant path does');
    } finally {
      await runner.close();
    }
  });

  test('a failed connection does not poison the runner: the pool still answers and can be closed', async () => {
    // A pool that leaked a connection per failed attempt would exhaust itself under an outage, and the failure would
    // then look like a capacity problem. The counters are read rather than assumed.
    const runner = new PostgresTenantRunner({ dsn: DEAD, maxConnections: 2 });
    try {
      await refusalOf(() => runner.withTenantTransaction(TENANT, async () => 'no'));
      const stats = runner.poolStats();
      assert.equal(typeof stats.total, 'number');
      assert.equal(typeof stats.idle, 'number');
      assert.equal(typeof stats.waiting, 'number');
      assert.equal(stats.waiting, 0, 'nothing may be left waiting after a refusal');
    } finally {
      await runner.close();
    }
  });
});
