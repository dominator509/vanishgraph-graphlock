/**
 * The health surface, asserted as SPEC-003 §5.17.1-4 and SPEC-007 §7.1-§7.4 declare it (EP-010 M17).
 *
 * WHY THIS FILE EXISTS SEPARATELY. The four routes were reshaped in M15 and the running service will feed them the
 * composer's single readiness decision rather than six independent probes. Neither of those was covered by a test that
 * asserts the DECLARED BODIES: the existing suites assert the readiness DECISION (readiness-fail-closed) and the
 * socket boundary (http-request-boundary), and the boundary test was itself asserting the `status` field that
 * SPEC-003 §5.17.1 forbids. These tests drive the route layer directly, with an injected decision, so every field the
 * specification names is asserted where it is rendered.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED HERE: that the six probes are wired in production. `main.ts` still supplies stub
 * probes; that is a separate step, and a test that quietly stubbed them would make the surface look healthier than the
 * service is.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { healthRoutes, type HealthDependencies, type ReadinessDecisionLike } from '../../src/http/routes/health.ts';

const DECLARED = ['postgresql', 'valkey', 'job-worker', 'object-store', 'keycloak-jwks', 'provider-transport'] as const;

const NOW = new Date('2026-02-14T09:31:07.412Z');
const STARTED = new Date('2026-02-14T09:30:00.000Z');

/** A decision in the composer's current shape, with dependencies optionally failing. */
function decision(options: { readonly failing?: readonly string[]; readonly optional?: readonly string[] } = {}): ReadinessDecisionLike {
  const failing = new Set(options.failing ?? []);
  const optional = new Set(options.optional ?? []);
  const checks = DECLARED.map((name) => ({
    name,
    required: !optional.has(name),
    ok: !failing.has(name),
    latencyMs: 3,
    reasonCode: failing.has(name) ? 'CONNECTION_REFUSED' : null,
  }));
  // THE FIXTURE FOLLOWS THE COMPOSER'S OWN RULE, MEASURED FROM IT RATHER THAN GUESSED:
  // `failedChecks = checks.filter((check) => check.required && check.status !== 'PASS')` (dependency-probes.ts). An
  // optional failure is reported in `checks` and is NOT a failed check, so a fixture that put it in `failedChecks`
  // would have contradicted §7.2 rule 1 and made these tests assert the wrong verdict.
  const failedChecks = checks.filter((check) => check.required && !check.ok).map((check) => check.name);
  return { dependencyState: failedChecks.length === 0 ? 'READY' : 'NOT_READY', failedChecks, checks };
}

async function app(deps: Partial<HealthDependencies>) {
  const server = Fastify();
  await server.register(healthRoutes, {
    deps: { probes: [], now: () => NOW, startedAt: STARTED, ...deps },
  });
  return server;
}

describe('GET /v1/ready is the body SPEC-003 §5.17.2 and SPEC-007 §7.1 declare', () => {
  test('READY: 200, dependencyState READY, and every declared dependency named with its own verdict', async () => {
    const server = await app({ decision: async () => decision() });
    const response = await server.inject({ method: 'GET', url: '/v1/ready' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.dependencyState, 'READY');
    assert.equal(body.service, 'vanishgraph-api');
    assert.deepEqual(body.failedChecks, []);
    assert.deepEqual(
      body.checks.map((check: { name: string }) => check.name).sort(),
      [...DECLARED].sort(),
      'rule 4: an omitted dependency is indistinguishable from a healthy one',
    );
    for (const check of body.checks) {
      assert.equal(typeof check.reachable, 'boolean', `${check.name} must report reachable as a boolean`);
      assert.equal(check.status, 'PASS');
      assert.equal(typeof check.required, 'boolean');
    }
    await server.close();
  });

  test('a REQUIRED dependency failing is 503 with the failure NAMED, and the other checks still reported', async () => {
    const server = await app({ decision: async () => decision({ failing: ['postgresql'] }) });
    const response = await server.inject({ method: 'GET', url: '/v1/ready' });
    assert.equal(response.statusCode, 503, '§7.3: any required failure is 503 on the first failing evaluation');
    const body = response.json();
    assert.equal(body.dependencyState, 'NOT_READY');
    assert.deepEqual(body.failedChecks, [{ name: 'postgresql', reason: 'CONNECTION_REFUSED', state: 'FAIL' }]);
    assert.equal(body.checks.length, DECLARED.length, 'a response that stops at the first failure cannot say whether one dependency is down or five');
    assert.equal(body.checks.find((check: { name: string }) => check.name === 'postgresql').reachable, false);
    await server.close();
  });

  test('an OPTIONAL dependency failing is REPORTED and does not block (§7.2 rule 1)', async () => {
    const server = await app({ decision: async () => decision({ failing: ['job-worker'], optional: ['job-worker'] }) });
    const response = await server.inject({ method: 'GET', url: '/v1/ready' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.dependencyState, 'READY');
    assert.deepEqual(body.failedChecks, []);
    assert.equal(body.checks.find((check: { name: string }) => check.name === 'job-worker').status, 'FAIL', 'not required must never become not observed');
    await server.close();
  });

  test('the decision is RECONCILED: NOT_READY with no visibly failing required check still answers 503 and names it', async () => {
    // The decision is what the metrics and the ReadinessChanged record were made from. If it says NOT_READY and the
    // check list does not show why, answering READY would contradict the series an operator alerts on.
    const server = await app({
      decision: async () => ({ dependencyState: 'NOT_READY', failedChecks: [{ name: 'valkey', reason: 'TIMEOUT' }], checks: decision().checks }),
    });
    const response = await server.inject({ method: 'GET', url: '/v1/ready' });
    assert.equal(response.statusCode, 503);
    const body = response.json();
    assert.deepEqual(body.failedChecks, [{ name: 'valkey', reason: 'TIMEOUT', state: 'FAIL' }]);
    await server.close();
  });
});

describe('the other three routes are the bodies their owners declare', () => {
  test('/v1/health is an aggregate dependency state and carries NO `status` field', async () => {
    const server = await app({ decision: async () => decision() });
    const response = await server.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.dependencyState, 'HEALTHY');
    assert.equal(body.service, 'vanishgraph-api');
    assert.equal(body.apiVersion, 'v1');
    assert.equal('status' in body, false, 'SPEC-003 §5.17.1 forbids `status` here in as many words');
    assert.deepEqual(body.degraded, []);
    assert.equal(body.dependencies.length, DECLARED.length);
    await server.close();
  });

  test('/v1/health is 503 UNHEALTHY when a required dependency is unreachable, and DEGRADED (200) for an optional one', async () => {
    const unhealthy = await app({ decision: async () => decision({ failing: ['object-store'] }) });
    const first = await unhealthy.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(first.statusCode, 503);
    assert.equal(first.json().dependencyState, 'UNHEALTHY');
    await unhealthy.close();

    const degraded = await app({ decision: async () => decision({ failing: ['provider-transport'], optional: ['provider-transport'] }) });
    const second = await degraded.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(second.statusCode, 200, 'an optional dependency down is not an outage');
    assert.equal(second.json().dependencyState, 'DEGRADED');
    assert.deepEqual(second.json().degraded, ['provider-transport']);
    await degraded.close();
  });

  test('/v1/live answers ALIVE and evaluates NOTHING (§7.3: liveness must not depend on a dependency)', async () => {
    let calls = 0;
    const server = await app({ decision: async () => { calls += 1; return decision({ failing: [...DECLARED] }); } });
    const response = await server.inject({ method: 'GET', url: '/v1/live' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.dependencyState, 'ALIVE');
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.equal(calls, 0, 'liveness touching a dependency is how a dependency incident becomes a restart loop');
    await server.close();
  });

  test('/v1/startup reports the three resolved flags, and NOT_STARTED names what is unresolved', async () => {
    const started = await app({ decision: async () => decision(), startup: { configurationResolved: true, migrationApplied: true, resourceAttributesResolved: true } });
    const first = await started.inject({ method: 'GET', url: '/v1/startup' });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().dependencyState, 'STARTED');
    assert.deepEqual(first.json().failedChecks, []);
    await started.close();

    const pending = await app({ decision: async () => decision(), startup: { configurationResolved: false, migrationApplied: true, resourceAttributesResolved: false } });
    const second = await pending.inject({ method: 'GET', url: '/v1/startup' });
    assert.equal(second.statusCode, 503);
    const body = second.json();
    assert.equal(body.dependencyState, 'NOT_STARTED');
    assert.deepEqual(body.failedChecks.map((entry: { name: string }) => entry.name), ['configuration', 'resource-attributes']);
    await pending.close();
  });
});
