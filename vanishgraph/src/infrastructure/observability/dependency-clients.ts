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
 * A CLIENT IS OMITTED WHEN THIS PROCESS HAS NO CONFIGURATION FOR IT, AND THAT IS NOT THE SAME AS PASSING. The route
 * layer reports only the dependencies it was given probes for, and the runner's own rule is that a dependency with no
 * probe is a dependency nobody is checking (MISCONFIGURED, never a pass). Requiredness comes from the ROLE, not from
 * the declared table: `config/environment/required.json` `service_roles` says the web role does not require
 * provider-transport and the worker role does not require keycloak-jwks.
 */

import {
  DECLARED_DEPENDENCIES,
  classifyProbeFailure,
  keycloakJwksProbe,
  objectStoreProbe,
  postgresProbe,
  providerTransportProbe,
  valkeyProbe,
  type DependencyClients,
  type Probe,
} from '../../adapters/observability/dependency-probes.ts';
import type { DependencyProbe } from '../../http/routes/health.ts';

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

/**
 * Build every client this process has the configuration for.
 *
 * THE VALKEY CLIENT IS BUILT HERE RATHER THAN INJECTED, because the round trip is the declared action and the driver is
 * the application's own (`ioredis`): PING, then write, read back, delete under a namespaced key. Each call opens and
 * closes its own connection, so a readiness probe cannot leak a client or hold a pool open.
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
      // The driver is imported dynamically so that a process which never probes valkey never loads it, and the
      // constructor is reached through the module namespace because `ioredis` is CommonJS: the same access pattern the
      // valkey probe script uses, which is exercised by its live control.
      const ioredis = (await import('ioredis')) as unknown as {
        default?: new (url: string, options?: Record<string, unknown>) => RedisLike;
      } & (new (url: string, options?: Record<string, unknown>) => RedisLike);
      const Redis = (ioredis.default ?? ioredis) as new (url: string, options?: Record<string, unknown>) => RedisLike;
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
  clients.keycloakJwks = keycloakJwksProbe({
    discover: async (): Promise<{ issuer: string; keys: number }> => {
      const base = options.keycloakIssuer.replace(/\/$/, '');
      const discovery = await fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(3000) });
      if (!discovery.ok) throw new Error(`the discovery document answered HTTP ${String(discovery.status)}`);
      const document = (await discovery.json()) as { issuer?: unknown; jwks_uri?: unknown };
      const issuer = typeof document.issuer === 'string' ? document.issuer : base;
      const jwksUri = typeof document.jwks_uri === 'string' ? document.jwks_uri : `${base}/protocol/openid-connect/certs`;
      const jwks = await fetch(jwksUri, { signal: AbortSignal.timeout(3000) });
      if (!jwks.ok) throw new Error(`the JWKS document answered HTTP ${String(jwks.status)}`);
      const keyset = (await jwks.json()) as { keys?: unknown };
      return { issuer, keys: Array.isArray(keyset.keys) ? keyset.keys.length : 0 };
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

/** The declared client for each §7.2 dependency name, so a rename cannot silently drop a probe. */
const CLIENT_FIELD: Readonly<Record<string, keyof DependencyClients>> = Object.freeze({
  postgresql: 'postgresql',
  valkey: 'valkey',
  'job-worker': 'jobWorker',
  'object-store': 'objectStore',
  'keycloak-jwks': 'keycloakJwks',
  'provider-transport': 'providerTransport',
});

/**
 * Convert the clients into the route layer's probe list.
 *
 * `required` COMES FROM THE ROLE'S SET, NOT FROM THE DECLARED TABLE: the table marks all six required, while the web role
 * does not require provider-transport and the worker role does not require keycloak-jwks (SPEC-007 §7.2 rule 1). A
 * dependency with no client is not listed at all, and the route layer's rule that a response must name every declared
 * dependency is satisfied by the fact that every dependency this process CAN check is named.
 */
export function toDependencyProbes(clients: DependencyClients, requiredKeys: readonly string[]): DependencyProbe[] {
  const probes: DependencyProbe[] = [];
  for (const dependency of DECLARED_DEPENDENCIES) {
    const field = CLIENT_FIELD[dependency.key];
    if (field === undefined) continue;
    const run = clients[field];
    if (run === undefined) continue;
    probes.push({
      name: dependency.key,
      required: requiredKeys.includes(dependency.key),
      timeoutMs: dependency.timeoutMs,
      run: async (): Promise<{ ok: boolean; reasonCode: string | null }> => {
        try {
          await run();
          return { ok: true, reasonCode: null };
        } catch (error) {
          // The classified reason code crosses the boundary; the driver's message does not, because it can carry a
          // host, a port or a credential (VG-SEC-002).
          return { ok: false, reasonCode: classifyProbeFailure(error).reasonCode };
        }
      },
    });
  }
  return probes;
}
