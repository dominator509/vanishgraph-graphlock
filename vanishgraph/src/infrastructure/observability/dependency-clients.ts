/**
 * The six declared dependency clients, built from what this process was configured with (EP-010 M26; SPEC-007 §7.2).
 *
 * WHY THIS MODULE EXISTS. `src/adapters/observability/dependency-probes.ts` already implements every declared probe
 * action — postgres session-role verification, a valkey round trip, worker-heartbeat freshness, a SIGNED object-store
 * GetObject with digest verification, OIDC discovery plus JWKS, and provider-transport reachability. What was missing was
 * the COMPOSITION: `main.ts` wired three stub probes that returned `ok: false` unconditionally, so `/v1/ready` was
 * permanently 503 and `/v1/health` answered 503 because a REQUIRED dependency could never pass. This module builds the
 * real clients and converts them into the route layer's declared probe shape.
 *
 * A CLIENT IS OMITTED WHEN THIS PROCESS HAS NO CONFIGURATION FOR IT, AND THAT IS NOT THE SAME AS PASSING. A dependency
 * with no client is a dependency nobody is checking, so it is REPORTED as UNKNOWN/MISCONFIGURED rather than dropped -
 * `createProbeRunner` owns that rule and this module delegates to it instead of restating it. Requiredness comes from
 * the ROLE, not from the declared table: `config/environment/required.json` `service_roles` says the web role does not
 * require provider-transport and the worker role does not require keycloak-jwks.
 */

import {
  DECLARED_DEPENDENCIES,
  createProbeRunner,
  keycloakJwksProbe,
  objectStoreProbe,
  postgresProbe,
  providerTransportProbe,
  valkeyProbe,
  type DependencyClients,
  type DependencyKey,
  type Probe,
} from '../../adapters/observability/dependency-probes.ts';
import type { DependencyProbe } from '../../http/routes/health.ts';
import { httpsJwksFetcher, type FetchJwks } from '../../adapters/oidc/jwks.ts';

export interface ObjectStoreConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly probeKey: string;
  readonly expectedDigest: string;
}

export interface DependencyClientOptions {
  /** Runs one statement and resolves with the session role. Injected so this module owns no connection pool. */
  readonly querySessionRole: () => Promise<string>;
  /** The tenant-scoped application role the session must be using. */
  readonly expectedRole: string;
  readonly valkeyUrl: string;
  readonly keycloakIssuer: string;
  /**
   * The application's declared discovery-plus-JWKS fetch. Injected so a test can drive the probe without a network, and
   * defaulted to `httpsJwksFetcher()` so this module opens NO SECOND OUTBOUND PATH of its own.
   */
  readonly fetchJwks?: FetchJwks;
  /** Absent when no object-store configuration reached this process; the dependency is then simply not checked. */
  readonly objectStore?: ObjectStoreConfig;
  /** Absent when no official transport is declared for this deployment. */
  readonly providerTransport?: { readonly name: string; readonly reachability: () => Promise<{ readonly status: number }> };
  /** Absent when this process cannot read the queue's heartbeat store; the check is then not performed. */
  readonly freshHeartbeats?: (windowMs: number) => Promise<number>;
  readonly heartbeatWindowMs?: number;
}

/** How long a heartbeat may be absent before worker liveness is considered stale (SPEC-007 §7.2's freshness window). */
export const DEFAULT_HEARTBEAT_WINDOW_MS = 60_000;

/** The slice of the redis client this module uses, so the dynamic import can be typed without the driver's own types. */
interface RedisLike {
  connect(): Promise<void>;
  ping(): Promise<string>;
  set(key: string, value: string, mode: string, ttlMs: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

type RedisConstructor = new (url: string, options?: Record<string, unknown>) => RedisLike;

/**
 * THE VALKEY DRIVER IS LOADED ONCE, AND STARTUP AWAITS IT. MEASURED DEFECT THIS CORRECTS (EP-010 M27), and it was
 * invisible until the probe was exercised against a real dependency.
 *
 * The first version performed `await import('ioredis')` INSIDE the probe closure, so the MODULE LOAD was charged to the
 * dependency's declared §7.2 budget of 200 ms. Measured in a fresh process:
 *
 *     call 1: TOTAL 205.0 ms (import 176.0 ms, probe action 29.0 ms) -> TIMEOUT
 *     call 2: TOTAL  21.8 ms (import   0.2 ms, probe action 21.6 ms)
 *     call 3: TOTAL  15.5 ms (import   0.1 ms, probe action 15.3 ms)
 *
 * The consequence was measured too, and it is not subtle: `/v1/health` answered 503 with `dependencyState UNHEALTHY`,
 * `valkey=false` on the FIRST evaluation of roughly one boot in three, and `/v1/ready` answered READY a moment later -
 * because §7.2 does not retry a TIMEOUT. The dependency was never slow; loading the driver was. A readiness probe may
 * report a dependency that is genuinely too slow, and it may not report one that is fine.
 */
let valkeyDriverModule: Promise<RedisConstructor> | undefined;

function loadValkeyDriver(): Promise<RedisConstructor> {
  valkeyDriverModule ??= import('ioredis').then((ioredis) => {
    // The constructor is reached through the module namespace because `ioredis` is CommonJS: the same access pattern the
    // valkey probe script uses, which its live control exercises.
    const namespace = ioredis as unknown as { default?: RedisConstructor } & RedisConstructor;
    return namespace.default ?? namespace;
  });
  return valkeyDriverModule;
}

/**
 * Load every driver the declared probes need. THE COMPOSITION ROOT AWAITS THIS BEFORE IT LISTENS (main.ts), so no request
 * can ever be charged for a module load, and the first `/v1/health` measures the dependencies rather than the loader.
 * Idempotent: the promise is memoized, so a second call is the same load.
 */
export function warmUpDependencyClients(): Promise<void> {
  return loadValkeyDriver().then(() => undefined);
}

/**
 * Evaluate every composed probe once and DISCARD the verdict, so that the first request a client makes is not also the
 * first time this process has ever reached its dependencies. MEASURED, AND THE MEASUREMENT IS THE REASON THIS EXISTS.
 *
 * On a freshly booted artifact the FIRST evaluation cost 144-201 ms per dependency - the TLS handshakes, the pool's first
 * connection and the socket setup all happen while one event loop is busy with all of them - and the SECOND evaluation
 * cost 15-30 ms. SPEC-007 §7.2 gives each dependency its own hard budget (valkey 200 ms, postgresql and keycloak-jwks
 * 300 ms, object-store 400 ms), so the valkey probe's 200 ms was exceeded on the first evaluation of about one boot in
 * three, and `/v1/health` answered 503 UNHEALTHY with `valkey=false` on an idle, healthy Valkey while `/v1/ready`
 * answered READY a moment later.
 *
 * WHAT THIS DOES AND DOES NOT CHANGE. It removes COLD START from the readiness decision, and it does not hide a
 * dependency that is down: every probe still runs on every request, with its own budget and its own classification, and a
 * dependency that is unreachable then is reported then. A warm-up failure is NOT a verdict - the outcome is discarded on
 * purpose, because a boot-time failure that is never re-checked would be exactly the static answer VG-API-059 forbids.
 *
 * One dependency is warmed through a connection this process does not keep: the valkey probe opens and closes its own
 * connection per call, so the warm-up closes the one it opened and each later evaluation opens its own - measured at
 * 15-30 ms once the handshakes and the pool exist, which is the point.
 */
export async function warmUpDependencyProbes(probes: readonly DependencyProbe[]): Promise<void> {
  await Promise.all(
    probes.map(async (probe) => {
      try {
        await probe.run();
      } catch {
        // Swallowed BY DESIGN: the probe reports its own failure on the next request, and a boot that refuses to start
        // because a dependency is down could not report that dependency at all.
      }
    }),
  );
}

/**
 * Build every client this process has the configuration for.
 *
 * THE VALKEY CLIENT IS BUILT HERE RATHER THAN INJECTED, because the round trip is the declared action and the driver is
 * the application's own (`ioredis`): PING, then write, read back, delete under a namespaced key. Each call opens and
 * closes its own connection, so a readiness probe cannot leak a client or hold a pool open - and the connection itself is
 * measured at 5.6-21.5 ms, so it fits the declared budget with room to spare once the driver load is out of the way.
 */
export function createDependencyClients(options: DependencyClientOptions): DependencyClients {
  // BUILT BY ASSIGNMENT, NOT BY AN OBJECT LITERAL: `exactOptionalPropertyTypes` is on in this repository, and a literal
  // carrying `Probe | undefined` is not assignable to an optional `Probe`. Assigning only what exists also makes the
  // "omitted means not checked" rule structural rather than a convention.
  const clients: {
    postgresql?: Probe;
    valkey?: Probe;
    jobWorker?: Probe;
    objectStore?: Probe;
    keycloakJwks?: Probe;
    providerTransport?: Probe;
  } = {};

  clients.postgresql = postgresProbe({ querySessionRole: options.querySessionRole, expectedRole: options.expectedRole });
  clients.valkey = valkeyProbe({
    roundTrip: async (key: string): Promise<string> => {
      const Redis = await loadValkeyDriver();
      const client = new Redis(options.valkeyUrl, { lazyConnect: true, connectTimeout: 3000, maxRetriesPerRequest: 1, enableOfflineQueue: false });
      try {
        await client.connect();
        const pong = await client.ping();
        if (String(pong).toUpperCase() !== 'PONG') throw new Error('valkey did not answer PONG');
        const payload = key.split(':').pop() ?? '';
        await client.set(key, payload, 'PX', 10_000);
        const readBack = await client.get(key);
        await client.del(key);
        return readBack ?? '';
      } finally {
        try {
          await client.quit();
        } catch {
          client.disconnect();
        }
      }
    },
  });
  // THE JWKS PATH IS THE APPLICATION'S OWN RATHER THAN A THIRD ONE. The first version of this module fetched discovery
  // and JWKS with the platform `fetch` directly, and `tests/contract/ssrf-controls.test.ts` REFUSED it: the contract
  // allows exactly ONE module outside the SSRF guard to perform an outbound fetch and caps its recorded-exception list
  // at one entry, which is `src/adapters/oidc/jwks.ts`. Reusing `httpsJwksFetcher` also means the readiness probe and the
  // token verifier reach the issuer the same way, including `redirect: 'error'` - a redirect followed by a probe but not
  // by the verifier would be two different trust decisions for one URL. ROUTING THIS PATH THROUGH THE SSRF GUARD REMAINS
  // EP-006's RECORDED OPEN WORK, and this comment says so rather than implying the path is guarded.
  const fetchJwks = options.fetchJwks ?? httpsJwksFetcher();
  clients.keycloakJwks = keycloakJwksProbe({
    discover: async (): Promise<{ issuer: string; keys: number }> => {
      const document = await fetchJwks(options.keycloakIssuer);
      // The CONFIGURED issuer is reported, because the fetcher returns the keys and not the issuer document; the probe
      // then refuses anything that is not an HTTPS issuer and anything with no signing key.
      return { issuer: options.keycloakIssuer, keys: document.keys.length };
    },
  });

  if (options.objectStore !== undefined) {
    clients.objectStore = objectStoreProbe(options.objectStore);
  }
  if (options.providerTransport !== undefined) {
    clients.providerTransport = providerTransportProbe(options.providerTransport);
  }
  if (options.freshHeartbeats !== undefined) {
    clients.jobWorker = ((): (() => Promise<string>) => {
      const windowMs = options.heartbeatWindowMs ?? DEFAULT_HEARTBEAT_WINDOW_MS;
      return async (): Promise<string> => {
        const fresh = await (options.freshHeartbeats as (window: number) => Promise<number>)(windowMs);
        if (fresh < 1) throw new Error(`no worker heartbeat in the last ${String(windowMs)} ms`);
        return `${String(fresh)} worker heartbeat(s) inside the ${String(windowMs)} ms freshness window`;
      };
    })();
  }

  return clients;
}

/**
 * Convert the clients into the route layer's probe list.
 *
 * EVERY DECLARED DEPENDENCY IS ALWAYS PRESENT, AND THE FIRST VERSION OF THIS FUNCTION GOT THAT WRONG. It skipped a
 * dependency with no client, so an artifact booted without object-store or worker configuration answered `/v1/ready`
 * with FOUR checks where SPEC-007 §7.2 declares six - and §7.2's own rule is that a response names every declared
 * dependency and that `required: false` dependencies report their status rather than disappearing.
 *
 * THE MISSING-CLIENT RULE IS NOT RESTATED HERE. `createProbeRunner` already reports a dependency with no client as
 * UNKNOWN/MISCONFIGURED (dependency-probes.ts, `runProbe`: "A MISSING CLIENT IS A FAILURE, NOT A PASS"), so this
 * function delegates to the runner and keeps ONE implementation of that rule instead of two that can drift.
 *
 * `required` COMES FROM THE ROLE'S SET, NOT FROM THE DECLARED TABLE: the table marks all six required, while the web
 * role does not require provider-transport and the worker role does not require keycloak-jwks (§7.2 rule 1), so a
 * dependency this role does not require is reported and does not force NOT_READY.
 */
export function toDependencyProbes(clients: DependencyClients, requiredKeys: readonly DependencyKey[]): DependencyProbe[] {
  const runner = createProbeRunner({ clients, requiredKeys });
  return DECLARED_DEPENDENCIES.map((dependency) => ({
    name: dependency.key,
    required: requiredKeys.includes(dependency.key),
    timeoutMs: dependency.timeoutMs,
    run: async (): Promise<{ ok: boolean; reasonCode: string | null }> => {
      const result = await runner.probe(dependency.key);
      // The classified reason code crosses the boundary; the driver's message does not, because it can carry a host, a
      // port or a credential (VG-SEC-002).
      return result.status === 'PASS' ? { ok: true, reasonCode: null } : { ok: false, reasonCode: result.reasonCode };
    },
  }));
}
