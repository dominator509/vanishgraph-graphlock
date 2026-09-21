/**
 * The composition root's dependency clients and the probe list it hands the route layer
 * (EP-010 M27; SPEC-007 §7.2, VG-API-059, DOD-037).
 *
 * WHY THIS SUITE EXISTS, AND IT IS A REGRESSION SUITE RATHER THAN A COVERAGE EXERCISE. The first version of
 * `toDependencyProbes` SKIPPED a dependency whose client this process had no configuration for. The consequence was
 * measured, not theorised: an artifact booted without object-store, worker-heartbeat and provider-transport
 * configuration answered `/v1/ready` with FOUR checks where SPEC-007 §7.2 declares six, and §7.2's own rule is that the
 * response names every declared dependency and that a `required: false` dependency reports its status instead of
 * disappearing. No test covered the conversion, so nothing caught it; `scripts/smoke-test.sh` did, one stage later.
 *
 * WHAT THE ASSERTIONS PIN: the probe list is EXACTLY the declared dependency set, in the declared order, whatever the
 * process was configured with; a dependency with no client is REPORTED as a failure with the catalogue's MISCONFIGURED
 * code rather than omitted; `required` comes from the ROLE's set and not from the declared table, which marks all six
 * required; the per-dependency timeout is the declared §7.2 timeout; and a probe that hangs is classified TIMEOUT rather
 * than passing or throwing out of the conversion.
 *
 * WHAT IT DOES NOT CLAIM: nothing here touches a real PostgreSQL, Valkey, MinIO or Keycloak. The clients are PORTS at
 * this level and the discrimination of each probe against a STOPPED dependency is what
 * `scripts/induced-failure-readiness.sh` measures per dependency (DOD-033).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  DECLARED_DEPENDENCIES,
  DEPENDENCY_KEYS,
  type DependencyClients,
} from '../../src/adapters/observability/dependency-probes.ts';
import { createDependencyClients, toDependencyProbes, warmUpDependencyClients } from '../../src/infrastructure/observability/dependency-clients.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** The web role's required set, from config/environment/required.json `service_roles.web`. */
const WEB_REQUIRED = ['postgresql', 'valkey', 'object-store', 'keycloak-jwks'] as const;

/** The minimum configuration the two always-present clients need. No probe action runs here. */
function baseOptions(): Parameters<typeof createDependencyClients>[0] {
  return {
    querySessionRole: async (): Promise<string> => 'vg_app',
    expectedRole: 'vg_app',
    valkeyUrl: 'redis://127.0.0.1:56379',
    keycloakIssuer: 'https://issuer.invalid/realms/master',
  };
}

describe('the composition root reports every declared dependency', () => {
  test('an unconfigured process still yields exactly the six declared probes, in the declared order', () => {
    // THE REGRESSION: an empty client set is the state that produced a four-check readiness body.
    const probes = toDependencyProbes({}, WEB_REQUIRED);
    assert.deepEqual(
      probes.map((probe) => probe.name),
      [...DEPENDENCY_KEYS],
    );
    assert.equal(probes.length, 6);
  });

  test('a dependency with no client is reported as a failure, never as an omission and never as a pass', async () => {
    const probes = toDependencyProbes({}, WEB_REQUIRED);
    for (const probe of probes) {
      const outcome = await probe.run();
      assert.equal(outcome.ok, false, `${probe.name} reported a pass with no client configured`);
      // MISCONFIGURED is the catalogue's declared code for "the probe could not be performed", and it is what the
      // adapter's own `runProbe` returns for a missing client; a conversion that invented a code here would drift.
      assert.equal(outcome.reasonCode, 'MISCONFIGURED');
    }
  });

  test('requiredness is the role set, not the declared table, which marks all six required', () => {
    const probes = toDependencyProbes({}, WEB_REQUIRED);
    const required = probes.filter((probe) => probe.required).map((probe) => probe.name);
    assert.deepEqual(required, [...WEB_REQUIRED]);
    const optional = probes.filter((probe) => !probe.required).map((probe) => probe.name);
    // §7.2 rule 1: a dependency this role does not require is STILL REPORTED, and does not force NOT_READY.
    assert.deepEqual(optional, ['job-worker', 'provider-transport']);
    for (const name of optional) {
      const declared = DECLARED_DEPENDENCIES.find((dependency) => dependency.key === name);
      assert.equal(declared?.required, true, `${name} is not marked required in the declared table, so this test proves nothing`);
    }
  });

  test('each probe carries the declared §7.2 timeout for its dependency', () => {
    const probes = toDependencyProbes({}, WEB_REQUIRED);
    for (const probe of probes) {
      const declared = DECLARED_DEPENDENCIES.find((dependency) => dependency.key === probe.name);
      assert.equal(probe.timeoutMs, declared?.timeoutMs);
    }
  });

  test('a configured client that answers is a pass, and one that throws is a classified failure', async () => {
    const clients: DependencyClients = {
      postgresql: async (): Promise<string> => 'session role vg_app',
      valkey: async (): Promise<string> => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:56379'), { code: 'ECONNREFUSED' });
      },
    };
    const probes = toDependencyProbes(clients, WEB_REQUIRED);
    const byName = new Map(probes.map((probe) => [probe.name, probe]));
    assert.deepEqual(await byName.get('postgresql')?.run(), { ok: true, reasonCode: null });
    assert.deepEqual(await byName.get('valkey')?.run(), { ok: false, reasonCode: 'CONNECT_REFUSED' });
    // The dependencies with no client are unaffected by the two that have one.
    assert.deepEqual(await byName.get('object-store')?.run(), { ok: false, reasonCode: 'MISCONFIGURED' });
  });

  test('a probe that hangs is classified TIMEOUT by the declared timeout rather than passing', async () => {
    // valkey is the shortest declared timeout (200 ms), and §7.2 does not retry a TIMEOUT.
    const probes = toDependencyProbes({ valkey: async (): Promise<string> => new Promise<string>(() => {}) }, WEB_REQUIRED);
    const valkey = probes.find((probe) => probe.name === 'valkey');
    assert.ok(valkey !== undefined);
    const outcome = await valkey.run();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, 'TIMEOUT');
  });
});

describe('the valkey driver load is not charged to the dependency budget', () => {
  test('the driver is loaded ONCE, by the memoized loader, and not inside the probe closure', () => {
    // WHY A STRUCTURAL ASSERTION RATHER THAN A TIMING ONE. The defect was that `await import('ioredis')` sat INSIDE the
    // round-trip closure the §7.2 200 ms budget covers: measured in a fresh process, the first call took 205.0 ms of which
    // 176.0 ms was the import, so `/v1/health` answered 503 UNHEALTHY with valkey=false on about one boot in three while
    // Valkey was idle and healthy. A timing assertion here would be flaky and would not say where the load is; this says
    // exactly that, and it fails if the import moves back into the timed action.
    const raw = readFileSync(join(ROOT, 'src', 'infrastructure', 'observability', 'dependency-clients.ts'), 'utf8');
    // COMMENTS ARE STRIPPED BEFORE COUNTING, because the explanation of this defect necessarily contains the very call
    // it is about - the first version of this test counted the sentence and failed on prose.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const dynamicImports = source.match(/import\(/g) ?? [];
    assert.equal(dynamicImports.length, 1, 'the driver must be loaded in exactly one place');
    const loader = source.indexOf('function loadValkeyDriver');
    const load = source.indexOf("import('ioredis')");
    const roundTrip = source.indexOf('roundTrip: async');
    assert.ok(loader >= 0, 'the memoized loader is missing');
    assert.ok(load > loader, 'the driver load must be inside loadValkeyDriver');
    assert.ok(roundTrip > load, 'the driver load must come BEFORE the round-trip closure, not inside it');
    assert.match(source, /valkeyDriverModule \?\?=/, 'the load must be memoized so a second call is the same load');
  });

  test('the warm-up is idempotent and resolves, and startup awaits it before listening', async () => {
    await warmUpDependencyClients();
    await warmUpDependencyClients();
    // The composition root is what makes it effective: an unawaited warm-up would leave the same race in place.
    const main = readFileSync(join(ROOT, 'src', 'infrastructure', 'main.ts'), 'utf8');
    assert.match(main, /await warmUpDependencyClients\(\);/, 'main.ts must await the warm-up');
    const warmIndex = main.indexOf('await warmUpDependencyClients();');
    const listenIndex = main.indexOf('await listen(app');
    assert.ok(warmIndex >= 0 && listenIndex > warmIndex, 'the warm-up must happen BEFORE the process listens');
  });
});

describe('createDependencyClients builds only what this process was configured with', () => {
  test('the two always-present clients exist, and the three conditional ones do not', () => {
    const clients = createDependencyClients(baseOptions());
    assert.equal(typeof clients.postgresql, 'function');
    assert.equal(typeof clients.valkey, 'function');
    assert.equal(typeof clients.keycloakJwks, 'function');
    // NO CONFIGURATION REACHED THIS PROCESS for these three, and the probe list above proves that is still REPORTED.
    assert.equal(clients.objectStore, undefined);
    assert.equal(clients.jobWorker, undefined);
    assert.equal(clients.providerTransport, undefined);
  });

  test('each conditional client appears exactly when its configuration does', () => {
    const clients = createDependencyClients({
      ...baseOptions(),
      objectStore: {
        endpoint: 'http://127.0.0.1:59000',
        bucket: 'vanishgraph-probe',
        region: 'us-east-1',
        accessKeyId: 'a',
        secretAccessKey: 'b',
        probeKey: 'readiness/probe-object',
        expectedDigest: '0'.repeat(64),
      },
      providerTransport: { name: 'stripe', reachability: async () => ({ status: 200 }) },
      freshHeartbeats: async (): Promise<number> => 1,
    });
    assert.equal(typeof clients.objectStore, 'function');
    assert.equal(typeof clients.providerTransport, 'function');
    assert.equal(typeof clients.jobWorker, 'function');
  });

  test('a stale heartbeat store is a failure rather than a pass with zero heartbeats', async () => {
    const clients = createDependencyClients({ ...baseOptions(), freshHeartbeats: async (): Promise<number> => 0 });
    const probes = toDependencyProbes(clients, WEB_REQUIRED);
    const jobWorker = probes.find((probe) => probe.name === 'job-worker');
    assert.ok(jobWorker !== undefined);
    const outcome = await jobWorker.run();
    assert.equal(outcome.ok, false, 'a worker with no fresh heartbeat was reported as reachable');
    assert.equal(jobWorker.required, false);
  });

  test('the keycloak probe reaches the issuer through the INJECTED JWKS fetch, not a path of its own', async () => {
    // WHY THIS IS PINNED: the first version of this module fetched discovery and JWKS with the platform `fetch`, and
    // `tests/contract/ssrf-controls.test.ts` refused it - the contract allows exactly ONE outbound fetch outside the SSRF
    // guard. This test proves the probe uses the injected port, so the module has no second path to be refused for.
    const asked: string[] = [];
    const clients = createDependencyClients({
      ...baseOptions(),
      fetchJwks: async (issuer: string) => {
        asked.push(issuer);
        return { keys: [{ kty: 'RSA' }] };
      },
    });
    const keycloak = toDependencyProbes(clients, WEB_REQUIRED).find((probe) => probe.name === 'keycloak-jwks');
    assert.ok(keycloak !== undefined);
    assert.deepEqual(await keycloak.run(), { ok: true, reasonCode: null });
    assert.deepEqual(asked, ['https://issuer.invalid/realms/master']);
  });

  test('an issuer with no signing key is a failure rather than a pass', async () => {
    const clients = createDependencyClients({ ...baseOptions(), fetchJwks: async () => ({ keys: [] }) });
    const keycloak = toDependencyProbes(clients, WEB_REQUIRED).find((probe) => probe.name === 'keycloak-jwks');
    assert.ok(keycloak !== undefined);
    const outcome = await keycloak.run();
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, 'MISCONFIGURED');
  });
});
