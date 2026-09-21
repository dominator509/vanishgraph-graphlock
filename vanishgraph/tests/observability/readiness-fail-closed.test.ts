/**
 * Readiness fail-closed behaviour (EP-008 M5; SPEC-007 §7.1-§7.4; VG-OPS-001, DOD-014, DOD-037).
 *
 * WHAT THIS SUITE PROVES, AND WHAT IT DELIBERATELY DOES NOT CLAIM. It proves the DECISION: one failing required
 * dependency makes the process unready on the first evaluation with no grace period, liveness stays independent of every
 * dependency, a failure is classified into the catalogue's closed reason-code enum, the counters and the
 * `ReadinessChanged` inputs are produced, and the negative case — a STATIC handler that always answers ready — is caught
 * by the same assertion that catches a real failure. What it does NOT prove is that a real dependency's probe
 * discriminates when that dependency is stopped: that requires provisioned dependencies, and it is what
 * `scripts/induced-failure-readiness.sh` runs per dependency against the real services, recording ERROR for any
 * dependency this environment cannot provision (DOD-033). The probes are PORTS here, so a suite in a pure test root can
 * drive the decision without a database, and the stage drives the same code against the real thing.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import {
  DECLARED_DEPENDENCIES,
  DEPENDENCY_KEYS,
  DEPENDENCY_PROBE_REASON_CODES,
  ProbeUnavailableError,
  READINESS_BUDGET_MS,
  classifyProbeFailure,
  createProbeRunner,
  jobWorkerProbe,
  keycloakJwksProbe,
  objectStoreProbeUnavailable,
  postgresProbe,
  probePayloadDigest,
  providerTransportProbe,
  valkeyProbe,
  type DependencyClients,
  type ProbeResult,
} from '../../src/adapters/observability/dependency-probes.ts';
import { createMetricsRegistry, loadMetricCatalogue, type MetricCatalogue } from '../../src/adapters/observability/metrics-registry.ts';
import { loadTelemetryAllowlist, type TelemetryAllowlist } from '../../src/adapters/observability/telemetry-allowlist.ts';
import { readinessTransitionRecord, toHealthDependencies } from '../../src/http/health-routes.ts';
import { composeReadiness } from '../../src/infrastructure/observability/compose-telemetry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const loaded = loadMetricCatalogue(join(ROOT, 'config/metrics/catalogue.json'));
assert.equal(loaded.ok, true);
const catalogue = (loaded as { ok: true; catalogue: MetricCatalogue }).catalogue;

/** All six probes wired to pass, so a case can fail exactly one of them. */
function passingClients(): Record<keyof DependencyClients, () => Promise<string>> {
  return {
    postgresql: async () => 'postgresql session role verified as vg_app',
    valkey: async () => 'valkey PING and write/read/delete round trip verified',
    jobWorker: async () => '1 worker heartbeat(s) inside the 60000 ms freshness window',
    objectStore: async () => 'HeadBucket and signed GetObject verified',
    keycloakJwks: async () => 'issuer https://keycloak.example/realms/vanishgraph advertises 2 signing key(s)',
    providerTransport: async () => 'postal_api reachable, HTTP 405',
  };
}

function registryWithReadinessFamilies(): ReturnType<typeof createMetricsRegistry> {
  const registry = createMetricsRegistry(catalogue);
  for (const name of [
    'vanishgraph_readiness_status',
    'vanishgraph_dependency_probe_failures_total',
    'vanishgraph_dependency_probe_duration_seconds',
  ]) {
    registry.register(name);
  }
  return registry;
}

const failing = (code: string, message: string): (() => Promise<string>) => async () => {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  throw error;
};

/** Every dependency failing with a different classified cause, so a full evaluation can be checked end to end. */
function failingClientsForEveryDependency(): Record<keyof DependencyClients, () => Promise<string>> {
  return {
    postgresql: failing('28P01', 'password authentication failed'),
    valkey: failing('ECONNREFUSED', 'valkey refused the connection'),
    jobWorker: failing('EHOSTUNREACH', 'the job worker heartbeat store is unreachable'),
    objectStore: failing('ENOTFOUND', 'the object store host did not resolve'),
    keycloakJwks: failing('CERT_HAS_EXPIRED', 'the discovery certificate expired'),
    providerTransport: failing('ETIMEDOUT', 'the provider transport timed out'),
  };
}

describe('the declared dependencies are §7.2\'s six, and the reason codes are the catalogue\'s closed set', () => {
  test('six dependencies, each with a declared action and a hard timeout', () => {
    assert.equal(DECLARED_DEPENDENCIES.length, 6);
    assert.deepEqual([...DEPENDENCY_KEYS], ['postgresql', 'valkey', 'job-worker', 'object-store', 'keycloak-jwks', 'provider-transport']);
    for (const dependency of DECLARED_DEPENDENCIES) {
      assert.ok(dependency.action.length > 40, `${dependency.key} must name its declared action, not just a name`);
      assert.ok(dependency.timeoutMs > 0 && dependency.timeoutMs <= READINESS_BUDGET_MS, `${dependency.key} timeout`);
      assert.equal(dependency.required, true);
    }
    // THE CATALOGUE CARRIES ONE EXTRA VALUE, AND §6.5 ASKS FOR IT: "One series per declared dependency plus an overall
    // series". The extra token is the overall series; the runner's probeable keys are the six.
    assert.deepEqual(catalogue.labelValueSets['dependency_key'], [...DEPENDENCY_KEYS, 'overall'], 'the catalogue must name the six keys plus the overall-series token');
  });

  test('the reason-code enum equals the catalogue\'s declared set for the probe-failure counter', () => {
    const declared = catalogue.byName.get('vanishgraph_dependency_probe_failures_total');
    assert.ok(declared !== undefined);
    assert.deepEqual(declared?.labels, ['environment', 'dependency_key', 'reason_code']);
    // THE CATALOGUE DOES NOT CARRY THE ENUM VALUES PER LABEL for this family, so the enum is asserted against the metric's
    // own §6.5 row: the eight codes §6.5 declares, in the order it declares them.
    assert.deepEqual([...DEPENDENCY_PROBE_REASON_CODES], ['TIMEOUT', 'CONNECT_REFUSED', 'AUTH_FAILED', 'DNS_FAILED', 'TLS_FAILED', 'HTTP_5XX', 'MISCONFIGURED', 'UNKNOWN']);
  });

  test('the per-probe timeouts sum ABOVE the total budget, and the runner surfaces the breach instead of hiding it', () => {
    const sum = DECLARED_DEPENDENCIES.reduce((total, dependency) => total + dependency.timeoutMs, 0);
    // MEASURED: §7.2 declares these six timeouts (2400 ms in total, after the provider-transport amendment measured below)
    // total readiness budget. A run in which several dependencies hang cannot satisfy both, so the breach is reported.
    assert.equal(sum, 2400);
    assert.ok(sum > READINESS_BUDGET_MS, 'if this ever stops being true, the finding below is resolved and must be re-read');
  });
});

describe('the decision is fail-closed on the FIRST failing evaluation (§7.3)', () => {
  test('all six passing is READY, with every check named and no reason code', async () => {
    const runner = createProbeRunner({ clients: passingClients() });
    const evaluation = await runner.evaluate();
    assert.equal(evaluation.dependencyState, 'READY');
    assert.deepEqual(evaluation.failedChecks, []);
    assert.equal(evaluation.checks.length, 6);
    for (const check of evaluation.checks) {
      assert.equal(check.status, 'PASS', `${check.name}: ${check.detail}`);
      assert.equal(check.reasonCode, null);
      assert.equal(typeof check.latencyMs, 'number');
    }
    assert.equal(evaluation.budgetExceeded, false);
  });

  for (const key of DEPENDENCY_KEYS) {
    test(`${key} failing alone makes the process NOT_READY and names it in failedChecks`, async () => {
      const clients = passingClients();
      const target = key === 'job-worker' ? 'jobWorker' : key === 'keycloak-jwks' ? 'keycloakJwks' : key === 'provider-transport' ? 'providerTransport' : key === 'object-store' ? 'objectStore' : key;
      (clients as unknown as Record<string, unknown>)[target] = failing('ECONNREFUSED', `${key} refused the connection`);
      const runner = createProbeRunner({ clients });
      const evaluation = await runner.evaluate();
      assert.equal(evaluation.dependencyState, 'NOT_READY', `${key} must make the process unready`);
      assert.deepEqual([...evaluation.failedChecks], [key]);
      const check = evaluation.checks.find((candidate) => candidate.name === key);
      assert.equal(check?.status, 'FAIL');
      assert.equal(check?.reasonCode, 'CONNECT_REFUSED', 'the failure must be classified by cause, not merely reported');
      // AND THE OTHER FIVE ARE STILL EVALUATED: a readiness response that stops at the first failure cannot say whether
      // one dependency is down or five are.
      assert.equal(evaluation.checks.filter((candidate) => candidate.status === 'PASS').length, 5);
    });
  }

  test('MISSING CLIENT: a dependency with no probe wired is UNKNOWN, never a pass', async () => {
    const clients = passingClients() as Partial<DependencyClients>;
    delete (clients as Record<string, unknown>)['valkey'];
    const runner = createProbeRunner({ clients });
    const evaluation = await runner.evaluate();
    assert.equal(evaluation.dependencyState, 'NOT_READY');
    const valkey = evaluation.checks.find((check) => check.name === 'valkey');
    assert.equal(valkey?.status, 'UNKNOWN');
    assert.equal(valkey?.reasonCode, 'MISCONFIGURED');
    assert.match(valkey?.detail ?? '', /no probe is wired/);
  });

  test('AN OPTIONAL DEPENDENCY THAT FAILS IS REPORTED AND DOES NOT BLOCK READINESS (SPEC-007 §7.2 rule 1)', async () => {
    // THE WEB ROLE'S REQUIRED SET, from config/environment/required.json `service_roles.web`: `provider-transport` is
    // NOT required for this role. Before EP-010 M16 the runner used the declared table's all-true value, so a failing
    // provider transport made the whole verdict NOT_READY - and rule 1 says a `required: false` dependency must still be
    // VISIBLE without blocking. That is why the failure is asserted twice below: reported, and not blocking.
    const clients = passingClients();
    clients.providerTransport = failing('ENOTFOUND', 'no provider transport is reachable');
    const runner = createProbeRunner({ clients, requiredKeys: ['postgresql', 'valkey', 'object-store', 'keycloak-jwks'] });
    const evaluation = await runner.evaluate();
    const optional = evaluation.checks.find((check) => check.name === 'provider-transport');
    assert.equal(optional?.required, false, 'the web role does not require this dependency');
    assert.equal(optional?.status, 'FAIL', 'and its failure is still REPORTED, so "not required" never becomes "not observed"');
    assert.equal(evaluation.dependencyState, 'READY', 'a dependency the role does not need must not block readiness');
    assert.deepEqual([...evaluation.failedChecks], [], 'and it must not appear among the failed checks');

    // THE SAME FAILURE DOES BLOCK WHEN THE ROLE REQUIRES IT: the worker role requires provider-transport, so the
    // identical client failure is NOT_READY. One probe, two roles, two verdicts - which is the whole point.
    const worker = createProbeRunner({ clients, requiredKeys: ['postgresql', 'valkey', 'object-store', 'provider-transport'] });
    const workerEvaluation = await worker.evaluate();
    assert.equal(workerEvaluation.dependencyState, 'NOT_READY');
    assert.deepEqual([...workerEvaluation.failedChecks], ['provider-transport']);
  });

  test('liveness is independent of every dependency (§7.3: a restart loop is not a remedy)', async () => {
    const clients = passingClients();
    for (const key of Object.keys(clients) as (keyof DependencyClients)[]) {
      (clients as unknown as Record<string, unknown>)[key] = failing('ECONNREFUSED', 'every dependency is down');
    }
    const runner = createProbeRunner({ clients });
    const evaluation = await runner.evaluate();
    assert.equal(evaluation.dependencyState, 'NOT_READY');
    assert.deepEqual([...evaluation.failedChecks].sort(), [...DEPENDENCY_KEYS].sort());
    // THE LIVENESS ANSWER IS UNCHANGED AND TOUCHES NOTHING: if liveness failed here, an orchestrator would restart a
    // healthy process because a database is down.
    assert.equal(runner.live().status, 'PASS');
    assert.match(runner.live().detail, /does not evaluate any dependency/);
  });

  test('the metrics carry the catalogue\'s labels, and a failure increments by its classified reason', async () => {
    const registry = registryWithReadinessFamilies();
    const clients = passingClients();
    clients.postgresql = failing('28P01', 'password authentication failed');
    const runner = createProbeRunner({ clients, registry });
    const evaluation = await runner.evaluate();
    assert.equal(evaluation.dependencyState, 'NOT_READY');
    assert.equal(registry.value('vanishgraph_readiness_status', { environment: 'local', dependency_key: 'postgresql' }), 0);
    assert.equal(registry.value('vanishgraph_readiness_status', { environment: 'local', dependency_key: 'valkey' }), 1);
    assert.equal(registry.value('vanishgraph_dependency_probe_failures_total', { environment: 'local', dependency_key: 'postgresql', reason_code: 'AUTH_FAILED' }), 1);
    // A GAP, RECORDED RATHER THAN ASSERTED AWAY: the catalogue declares `reason_code`'s bound as coming from each
    // metric's own §6.5 row, and the REGISTRY CANNOT SEE THAT — it enforces bounded sets for labels that carry one
    // (`label_value_sets`) and names the source for the four whose bound lives elsewhere, so an out-of-enum reason code
    // is NOT refused at record time today. The runner therefore cannot emit one (its codes are the constant asserted
    // above, and no probe path constructs another), and the missing enforcement is recorded here and in the M5 evidence
    // for whichever milestone closes it rather than being papered over with an assertion that passes either way.
    const codes = new Set<string>(DEPENDENCY_PROBE_REASON_CODES);
    for (const check of (await createProbeRunner({ clients: failingClientsForEveryDependency() }).evaluate()).checks) {
      assert.ok(check.reasonCode === null || codes.has(check.reasonCode), `${check.name} produced a code outside the declared enum`);
    }
  });

  test('NEGATIVE CASE (SPEC-007 §7.4 step 3): a STATIC handler that always answers READY fails the same assertion', async () => {
    const clients = passingClients();
    clients.valkey = failing('ECONNREFUSED', 'valkey is stopped');
    const evaluation = await createProbeRunner({ clients }).evaluate();
    // The discriminating assertion a §7.4 run makes: the readiness verdict must agree with the probe results.
    const assertReadinessAgreesWithProbes = (decided: string, checks: readonly ProbeResult[]): void => {
      const failingRequired = checks.filter((check) => check.required && check.status !== 'PASS');
      assert.equal(decided, failingRequired.length === 0 ? 'READY' : 'NOT_READY', `a verdict of ${decided} contradicts ${String(failingRequired.length)} failing required probe(s)`);
    };
    assertReadinessAgreesWithProbes(evaluation.dependencyState, evaluation.checks);
    // A handler that always returns 200 IS the static handler this negative case is about, and the assertion above
    // rejects it. Without this case, a green §7.4 procedure would not distinguish a real check from a fabricated one.
    assert.throws(() => assertReadinessAgreesWithProbes('READY', evaluation.checks), /contradicts 1 failing required probe/);
  });
});

describe('the readiness composition: one ReadinessChanged ERROR per transition, through the real logger (§7.3)', () => {
  const allowlist = (() => {
    const result = loadTelemetryAllowlist(join(ROOT, 'config/telemetry/allowlist.json'));
    assert.equal(result.ok, true);
    return (result as { ok: true; allowlist: TelemetryAllowlist }).allowlist;
  })();

  test('the transition rule is pure: no record on the first evaluation, none while unready, none on recovery', () => {
    const decision = (state: 'READY' | 'NOT_READY', failed: string[] = []) => ({
      dependencyState: state,
      failedChecks: failed,
      checks: failed.map((name) => ({ name, ok: false, latencyMs: 1, reasonCode: 'CONNECT_REFUSED' })),
      budgetExceeded: false,
      totalLatencyMs: 1,
    });
    assert.equal(readinessTransitionRecord(null, decision('NOT_READY', ['valkey'])), null, 'the first evaluation is not a transition');
    assert.equal(readinessTransitionRecord('READY', decision('READY')), null);
    assert.equal(readinessTransitionRecord('NOT_READY', decision('NOT_READY', ['valkey'])), null, 'a steadily unready instance must not write one record per evaluation');
    assert.equal(readinessTransitionRecord('NOT_READY', decision('READY')), null, 'recovery is not an ERROR record');
    const record = readinessTransitionRecord('READY', decision('NOT_READY', ['valkey', 'postgresql']));
    assert.equal(record?.event, 'ReadinessChanged');
    assert.equal(record?.severity, 'ERROR');
    assert.equal(record?.dependencyKey, 'valkey', 'the record names the FIRST failing dependency');
    assert.equal(record?.reasonCode, 'CONNECT_REFUSED');
    assert.match(record?.message ?? '', /NOT_READY: valkey, postgresql/);
  });

  test('the composition writes exactly one ERROR record across ready, unready, still-unready and recovered', async () => {
    const lines: string[] = [];
    // THE PROBE SET IS SNAPSHOTTED AT CONSTRUCTION, so the failure is induced behind a mutable flag rather than by
    // replacing the function: the runner holds the probe it was given, which is what keeps the probe set fixed for the
    // life of the process. MEASURED: the first version of this test replaced `clients.valkey` after construction and the
    // verdict stayed READY, which is the snapshot behaving as designed rather than a defect.
    let valkeyDown = false;
    const clients = passingClients();
    clients.valkey = async () => {
      if (valkeyDown) throw Object.assign(new Error('valkey refused the connection'), { code: 'ECONNREFUSED' });
      return 'valkey PING and write/read/delete round trip verified';
    };
    const composition = composeReadiness({
      allowlist,
      clients,
      service: 'vanishgraph-api',
      candidateEpoch: 'GENERATION',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      correlationId: 'corr-7Q2F4M8ZC1',
      tenantId: 'ten-4KQ7',
      sink: (line) => lines.push(line),
      now: () => new Date('2026-02-14T09:31:07.412Z'),
    });

    const ready = await composition.port.decide();
    assert.equal(ready.dependencyState, 'READY');
    assert.deepEqual(lines, [], 'a ready instance writes no readiness record');

    // INDUCE THE FAILURE AT THE PORT: valkey stops answering, which is §7.4 step 2 for that dependency.
    valkeyDown = true;
    const unready = await composition.port.decide();
    assert.equal(unready.dependencyState, 'NOT_READY');
    assert.deepEqual([...unready.failedChecks], ['valkey']);
    assert.equal(composition.records.length, 1);
    assert.equal(lines.length, 1, '§7.3: one structured record on the transition to unready');
    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    assert.equal(parsed['event'], 'ReadinessChanged');
    assert.equal(parsed['severity'], 'ERROR', 'failures are never reported at INFO');
    assert.equal(parsed['dependencyKey'], 'valkey');
    assert.equal(parsed['reasonCode'], 'CONNECT_REFUSED');
    assert.equal(parsed['correlationId'], 'corr-7Q2F4M8ZC1');
    assert.equal(parsed['tenantId'], 'ten-4KQ7');

    // STILL UNREADY: no second record. The stream must let an operator tell one outage from a flap.
    await composition.port.decide();
    assert.equal(composition.records.length, 1);
    assert.equal(lines.length, 1);

    // REMEDIATED: ready again, and recovery adds no ERROR record.
    valkeyDown = false;
    const recovered = await composition.port.decide();
    assert.equal(recovered.dependencyState, 'READY');
    assert.equal(composition.records.length, 1);
    assert.equal(lines.length, 1);
  });

  test('the health-dependency adapter names every declared dependency, so a response can never list only failures', async () => {
    const clients = passingClients();
    clients.postgresql = failing('28P01', 'password authentication failed');
    const composition = composeReadiness({
      allowlist,
      clients,
      service: 'vanishgraph-api',
      candidateEpoch: 'GENERATION',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      correlationId: 'corr-1',
      tenantId: 'ten-1',
      sink: () => undefined,
      now: () => new Date('2026-02-14T09:31:07.412Z'),
    });
    const decision = await composition.port.decide();
    const deps = toHealthDependencies(decision, { now: () => new Date('2026-02-14T09:31:07.412Z'), startedAt: new Date('2026-02-14T09:30:00.000Z'), decide: () => composition.port.decide() });
    assert.equal(deps.probes.length, 6, 'all six declared dependencies, not only the failing one');
    // THE SHAPE IS A UNION SINCE EP-010 M15: a declared DependencyProbe carries its own name, requirement and
    // deadline, while a legacy probe is a bare function that names itself only when it runs. Both are accepted, so
    // the adapter may emit either; the assertions below are unchanged.
    const results = await Promise.all(
      deps.probes.map((probe) => (typeof probe === 'function' ? probe() : probe.run().then((outcome) => ({ name: probe.name, ok: outcome.ok, reason: outcome.reasonCode ?? undefined })))),
    );
    assert.deepEqual(results.map((result) => result.name).sort(), [...DEPENDENCY_KEYS].sort());
    const failedProbe = results.find((result) => result.name === 'postgresql');
    assert.equal(failedProbe?.ok, false);
    assert.equal(failedProbe?.reason, 'AUTH_FAILED', 'the reason is the classified cause and carries no DSN');
  });
});

describe('each probe performs its DECLARED action, and the ones that cannot run say so', () => {
  test('postgresql: the session role is verified, and a role that bypasses row-level security is a failure', async () => {
    const good = await postgresProbe({ querySessionRole: async () => 'vg_app', expectedRole: 'vg_app' })();
    assert.match(good, /vg_app/);
    await assert.rejects(
      postgresProbe({ querySessionRole: async () => 'vg_owner', expectedRole: 'vg_app' })(),
      (error: unknown) => error instanceof ProbeUnavailableError && error.reasonCode === 'AUTH_FAILED' && /row-level security/.test(error.message),
    );
  });

  test('valkey: a round trip that does not return what was written is a failure, not a pass', async () => {
    const payloadSeen: string[] = [];
    const good = await valkeyProbe({ roundTrip: async (key) => { payloadSeen.push(key); return key.split(':').pop() ?? ''; } })();
    assert.match(good, /round trip verified/);
    await assert.rejects(valkeyProbe({ roundTrip: async () => 'something-else' })(), ProbeUnavailableError);
  });

  test('job-worker: freshness is the check, and zero fresh heartbeats is the induced failure of §7.4', async () => {
    assert.match(await jobWorkerProbe({ freshHeartbeats: async () => 3, windowMs: 60_000 })(), /3 worker heartbeat/);
    await assert.rejects(jobWorkerProbe({ freshHeartbeats: async () => 0, windowMs: 60_000 })(), /no worker heartbeat/);
  });

  test('keycloak-jwks: a non-HTTPS issuer and an empty key set are both failures, and no token is minted', async () => {
    assert.match(await keycloakJwksProbe({ discover: async () => ({ issuer: 'https://keycloak.example/realms/v', keys: 2 }) })(), /2 signing key/);
    await assert.rejects(keycloakJwksProbe({ discover: async () => ({ issuer: 'http://keycloak.example', keys: 2 }) })(), /not an HTTPS issuer/);
    await assert.rejects(keycloakJwksProbe({ discover: async () => ({ issuer: 'https://keycloak.example', keys: 0 }) })(), /no signing key/);
  });

  test('provider-transport: a 5xx is a failure and the check is a reachability probe, never a form write', async () => {
    assert.match(await providerTransportProbe({ reachability: async () => ({ status: 405 }), name: 'postal_api' })(), /HTTP 405/);
    await assert.rejects(providerTransportProbe({ reachability: async () => ({ status: 503 }), name: 'postal_api' })(), /HTTP 503/);
  });

  test('object-store: the probe refuses to pretend, and says which declared action it cannot perform', async () => {
    await assert.rejects(
      objectStoreProbeUnavailable(),
      (error: unknown) => error instanceof ProbeUnavailableError && error.reasonCode === 'MISCONFIGURED' && /SIGNED GetObject|signing/.test(error.message),
    );
    const runner = createProbeRunner({ clients: { ...passingClients(), objectStore: objectStoreProbeUnavailable } });
    const evaluation = await runner.evaluate();
    assert.equal(evaluation.dependencyState, 'NOT_READY', 'an unwired object-store probe must make the process unready, not silently pass');
  });

  test('the failure classifier maps transport causes to the declared enum, including an unknown one', () => {
    assert.equal(classifyProbeFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).reasonCode, 'CONNECT_REFUSED');
    assert.equal(classifyProbeFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).reasonCode, 'DNS_FAILED');
    assert.equal(classifyProbeFailure(Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' })).reasonCode, 'TLS_FAILED');
    assert.equal(classifyProbeFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).reasonCode, 'TIMEOUT');
    assert.equal(classifyProbeFailure(new Error('the endpoint answered HTTP 502')).reasonCode, 'HTTP_5XX');
    assert.equal(classifyProbeFailure(new Error('something nobody classified')).reasonCode, 'UNKNOWN');
    assert.equal(classifyProbeFailure(new ProbeUnavailableError('unwired', 'MISCONFIGURED')).reasonCode, 'MISCONFIGURED');
  });

  test('the probe payload digest is a real digest, so a signed read is verified rather than merely attempted', () => {
    assert.match(probePayloadDigest('probe-payload'), /^[0-9a-f]{64}$/);
    assert.notEqual(probePayloadDigest('probe-payload'), probePayloadDigest('probe-payload-2'));
  });
});

describe('the readiness budget is never extended (§7.2): a probe that would start past it is NOT run, and it FAILS', () => {
  test('with time advanced past the budget, the remaining probes are refused as TIMEOUT and the verdict is NOT_READY', async () => {
    // A DRIVEN CLOCK, so the breach is produced deterministically instead of by waiting 1.5 seconds. Each probe advances
    // the clock by 400 ms, so the fifth and sixth probes are past the 1500 ms budget when their turn comes.
    let clock = 0;
    const clients = passingClients();
    for (const key of Object.keys(clients) as (keyof DependencyClients)[]) {
      clients[key] = async () => {
        clock += 400;
        return 'probe passed';
      };
    }
    const registry = registryWithReadinessFamilies();
    const runner = createProbeRunner({ clients, registry, now: () => clock });
    const evaluation = await runner.evaluate();
    const ran = evaluation.checks.filter((check) => check.detail === 'probe passed');
    const unrun = evaluation.checks.filter((check) => check.status === 'TIMEOUT' && check.detail.includes('budget was already spent'));
    assert.equal(ran.length + unrun.length, 6, 'every declared dependency is accounted for, run or refused');
    assert.ok(unrun.length >= 1, 'the breach must leave at least one probe unrun');
    for (const check of unrun) {
      assert.equal(check.reasonCode, 'TIMEOUT', 'an unchecked dependency is not a healthy one');
      assert.match(check.detail, /forbids extending the budget/);
      // AND IT IS RECORDED AS A FAILURE SERIES, so the probe-failure counter moves for a dependency nobody checked.
      assert.equal(registry.value('vanishgraph_dependency_probe_failures_total', { environment: 'local', dependency_key: check.name, reason_code: 'TIMEOUT' }), 1);
    }
    assert.equal(evaluation.dependencyState, 'NOT_READY', 'a budget breach can never be READY');
    assert.equal(evaluation.budgetExceeded, true);
  });
});
