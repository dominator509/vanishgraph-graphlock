/**
 * Health, readiness, liveness and startup (SPEC-003 §5.17, VG-API-059).
 *
 * The rule these routes exist to obey is that **no static `200` is permitted**. A `/ready` that
 * returns 200 while the database is unreachable is worse than no endpoint at all: it tells an
 * orchestrator to send traffic to an instance that will fail every request, which converts a
 * dependency outage into a user-visible one.
 *
 * So readiness is computed from injected probes. Each probe reports a real check it performed,
 * and readiness is 503 with the failed check NAMED when any probe fails. The probe set is
 * injected rather than imported, which keeps this route testable with a deliberately failing
 * probe and keeps `src/http` from reaching into infrastructure.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

/** The outcome of one dependency probe. */
export interface ProbeResult {
  /** The dependency's stable name, e.g. `postgres`. Never a value or a connection string. */
  readonly name: string;
  readonly ok: boolean;
  /** Present when `ok` is false. Must contain no credential, host or DSN (VG-SEC-002). */
  readonly reason?: string;
  /** Optional measured latency, for operators. */
  readonly latencyMs?: number;
}

export interface HealthDependencies {
  /** Probes that must all pass for readiness. An empty list means "nothing to check". */
  readonly probes: readonly (() => Promise<ProbeResult>)[];
  /** Injected so tests are deterministic and the route never reads the clock itself. */
  readonly now: () => Date;
  /** The process start time, for the startup report. */
  readonly startedAt: Date;
}

/**
 * SPEC-003 §5.17.1: process liveness and build identity.
 *
 * Deliberately NOT a dependency check: `/health` answers "is this process running and which
 * build is it", which is why it can return 200 during a dependency outage. `/ready` is the one
 * that must fail.
 */
export interface HealthBody {
  readonly status: 'ok';
  readonly version: string;
  readonly commit: string;
  readonly startedAt: string;
  readonly uptimeSeconds: number;
}

/**
 * The readiness body. `checks` names every probe and its outcome, so an operator sees which
 * dependency failed rather than only that something did.
 */
export interface ReadyBody {
  readonly status: 'ready' | 'not_ready';
  readonly checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly latencyMs?: number;
    readonly reason?: string;
  }[];
}

export interface LivenessBody {
  readonly status: 'alive';
  readonly uptimeSeconds: number;
}

export interface StartupBody {
  readonly status: 'started' | 'starting';
  readonly startedAt: string;
  readonly uptimeSeconds: number;
}

export interface HealthRouteOptions {
  readonly deps: HealthDependencies;
  /** Build identity, injected so the route does not read the environment itself. */
  readonly version: string;
  readonly commit: string;
}

/**
 * Run every probe, naming failures rather than collapsing them.
 *
 * A probe that THROWS is a failure, not a crash: an exception escaping into the response would
 * leak a stack trace (SPEC-003 §8.3), so it is caught and reduced to a name and a reason.
 */
async function runProbes(deps: HealthDependencies): Promise<ReadyBody['checks']> {
  const results = await Promise.all(
    deps.probes.map(async (probe) => {
      const started = Date.now();
      try {
        const result = await probe();
        const latencyMs = Date.now() - started;
        return result.ok
          ? { name: result.name, ok: true, latencyMs }
          : { name: result.name, ok: false, latencyMs, reason: result.reason ?? 'check failed' };
      } catch {
        // The thrown value is discarded on purpose: its message could carry a DSN or a driver
        // string. Only the fact of failure crosses the boundary.
        return {
          name: 'unknown-probe',
          ok: false,
          latencyMs: Date.now() - started,
          reason: 'probe threw; see server logs',
        };
      }
    }),
  );
  return results;
}

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (
  app: FastifyInstance,
  options: HealthRouteOptions,
) => {
  const { deps, version, commit } = options;
  const uptimeSeconds = (): number =>
    Math.max(0, Math.floor((deps.now().getTime() - deps.startedAt.getTime()) / 1000));

  // 5.17.1 GET /v1/health — liveness and build identity. Not a dependency check.
  app.get('/v1/health', async (_request, reply) => {
    const body: HealthBody = {
      status: 'ok',
      version,
      commit,
      startedAt: deps.startedAt.toISOString(),
      uptimeSeconds: uptimeSeconds(),
    };
    return reply.code(200).send(body);
  });

  // 5.17.2 GET /v1/ready — readiness. 503 when any probe fails, with the check named.
  app.get('/v1/ready', async (_request, reply) => {
    const checks = await runProbes(deps);
    const ready = checks.length > 0 && checks.every((c) => c.ok);
    const body: ReadyBody = { status: ready ? 'ready' : 'not_ready', checks };
    // 503 with a body, never a bare status: the named failing check is the whole point.
    return reply.code(ready ? 200 : 503).send(body);
  });

  // 5.17.3 GET /v1/live — liveness only. Answers whether the event loop is turning.
  app.get('/v1/live', async (_request, reply) => {
    const body: LivenessBody = { status: 'alive', uptimeSeconds: uptimeSeconds() };
    return reply.code(200).send(body);
  });

  // 5.17.4 GET /v1/startup — has bootstrap completed. Same probes as readiness, reported as a
  // startup verdict so an orchestrator can distinguish "still starting" from "running but unwell".
  app.get('/v1/startup', async (_request, reply) => {
    const checks = await runProbes(deps);
    const started = checks.length > 0 && checks.every((c) => c.ok);
    const body: StartupBody & { readonly checks: ReadyBody['checks'] } = {
      status: started ? 'started' : 'starting',
      startedAt: deps.startedAt.toISOString(),
      uptimeSeconds: uptimeSeconds(),
      checks,
    };
    return reply.code(started ? 200 : 503).send(body);
  });
};
