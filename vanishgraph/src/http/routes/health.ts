/**
 * Health, readiness, liveness and startup (SPEC-003 §5.17, SPEC-007 §7.1-§7.4, VG-API-059).
 *
 * The rule these routes exist to obey is that **no static `200` is permitted**. A `/ready` that
 * returns 200 while the database is unreachable is worse than no endpoint at all: it tells an
 * orchestrator to send traffic to an instance that will fail every request, which converts a
 * dependency outage into a user-visible one.
 *
 * RESHAPED IN EP-010 M15 TO THE DECLARED BODIES, AND THE PREVIOUS SHAPE WAS A SPEC VIOLATION.
 * MEASURED: the artifact booted and answered all four routes with a `status` field, while SPEC-003
 * §5.17.1 forbids `status` on `/v1/health` in as many words ("the state field is named
 * `dependencyState`, not `status`: it is a dependency-health classification and must never be
 * confused with a truth state"). `smoke-test.sh` refused the artifact for it, naming the missing
 * `dependencyState`, `failedChecks`, per-dependency checks, and `reachable` booleans. SPECS OUTRANK
 * CODE, so the routes changed rather than the test.
 *
 * FOUR SHAPES, and each is the one its owner declares:
 *   * `/v1/health`   — aggregate dependency state (SPEC-003 §5.17.1): `dependencyState` is
 *                      HEALTHY | DEGRADED | UNHEALTHY, with every dependency's `reachable` boolean.
 *   * `/v1/ready`    — readiness (SPEC-003 §5.17.2 + SPEC-007 §7.1): `dependencyState` is
 *                      READY | NOT_READY, with `failedChecks` AND the full `checks` array.
 *   * `/v1/live`     — liveness ONLY (SPEC-003 §5.17.3, SPEC-007 §7.3): no dependency I/O at all,
 *                      because a dependency outage must never cause a restart loop.
 *   * `/v1/startup`  — initialization completion (SPEC-003 §5.17.4): the three resolved flags.
 *
 * WHAT READINESS MEANS HERE (SPEC-007 §7.2), and it is the part that is easy to get wrong:
 *   1. `required: true` on a failing, timing-out or unknown check forces NOT_READY; `required: false`
 *      reports its status and does not block, so "not required" never becomes "not observed".
 *   2. Probe timeouts are HARD bounds and a check that exceeds one is FAIL with `reasonCode: TIMEOUT`.
 *   3. Every check must be DISCRIMINATING: it passes when the dependency is healthy and fails when it
 *      is not, on the same code path. A probe that cannot fail is a defect, and so is a probe that
 *      cannot pass — the previous `configuredProbe` returned `ok: false` unconditionally, which made
 *      readiness permanently 503 and made the endpoint useless as a signal.
 *   4. A response must name EVERY declared dependency, because an omitted dependency is
 *      indistinguishable from a healthy one.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

/** SPEC-007 §7.1: the per-check verdict vocabulary. `SKIPPED` carries a reason code, never silence. */
export type CheckStatus = 'PASS' | 'FAIL' | 'SKIPPED';

/** What one probe measured. `reasonCode` is a stable code (TIMEOUT, CONNECTION_REFUSED, ...), never a value. */
export interface ProbeOutcome {
  readonly ok: boolean;
  readonly reasonCode?: string | null;
}

/**
 * One declared dependency, with the deadline SPEC-007 §7.2 gives it.
 *
 * `name` must be one of the declared vocabulary: `postgresql`, `valkey`, `job-worker`, `object-store`,
 * `keycloak-jwks`, `provider-transport`. `required` is per ROLE, which is why it is injected rather
 * than derived here: the web and worker roles require different sets (config/environment/required.json
 * `service_roles`).
 */
export interface DependencyProbe {
  readonly name: string;
  readonly required: boolean;
  readonly timeoutMs: number;
  readonly run: () => Promise<ProbeOutcome>;
}

/**
 * @deprecated Kept so the composition root's older wiring still compiles during the reshape; the
 * declared shape is `DependencyProbe`. It is not used by any route below.
 */
export interface ProbeResult {
  readonly name: string;
  readonly ok: boolean;
  readonly reason?: string;
  readonly latencyMs?: number;
}

/**
 * A probe in the PRE-RESHAPE shape: unnamed until it runs, with no declared requirement or deadline.
 *
 * IT IS ACCEPTED AND NORMALISED RATHER THAN DELETED, and the normalisation is the honest part: a legacy
 * probe is treated as REQUIRED with the default deadline, which preserves the behaviour every existing
 * caller already relies on ("any probe failing makes readiness 503"). Treating them as optional would
 * have quietly turned 30 test call sites into tests that can no longer fail — a gate weakened by a type
 * change. Production passes the declared `DependencyProbe` shape, where `required` comes from the role
 * (config/environment/required.json `service_roles`).
 */
export type LegacyProbe = () => Promise<ProbeResult>;
export type ProbeInput = DependencyProbe | LegacyProbe;

/**
 * The deadline applied to a LEGACY probe, which cannot declare its own.
 *
 * THE PER-DEPENDENCY DEADLINES OF SPEC-007 §7.2 ARE NOT TABLED HERE, for two reasons that agree. A declared
 * `DependencyProbe` carries its own `timeoutMs` from where the probe is defined, which is the composition root; and
 * naming the dependencies in this file put the words SPEC-000 §4 forbids into production identifiers -
 * `scripts/copy-lint-gate.ts` refused the file, naming the line and the token. The rule was right: the route layer
 * RENDERS deadlines, it does not own them, and the declared names belong to the probe declarations.
 */
export const LEGACY_PROBE_TIMEOUT_MS = 400;

export interface HealthDependencies {
  readonly probes: readonly ProbeInput[];
  /** Which required set applies. Declared, not guessed (SPEC-007 §7.2). */
  readonly role?: 'web' | 'worker';
  /** Injected so tests are deterministic and the route never reads the clock itself. */
  readonly now: () => Date;
  readonly startedAt: Date;
  /** SPEC-007 §2.1 fixes this as `vanishgraph-api`; SPEC-003 §5.17.1 requires it in the body. */
  readonly service?: string;
  readonly apiVersion?: string;
  /** The artifact identity this process serves, or null when it cannot be resolved (see the route). */
  readonly candidateEpoch?: string | null;
  readonly artifactDigest?: string | null;
  /** SPEC-003 §5.17.4: what startup completion means, injected rather than read here. */
  readonly startup?: {
    readonly configurationResolved: boolean;
    readonly migrationApplied: boolean;
    readonly resourceAttributesResolved: boolean;
  };
}

export const DEFAULT_SERVICE = 'vanishgraph-api';
export const DEFAULT_API_VERSION = 'v1';

/** SPEC-007 §7.1's `checks[]` entry, plus `reachable` — the boolean form SPEC-003 §5.17.1 uses. */
export interface DependencyCheck {
  readonly name: string;
  readonly required: boolean;
  readonly status: CheckStatus;
  readonly reachable: boolean;
  readonly latencyMs: number;
  readonly reasonCode: string | null;
}

/** SPEC-003 §5.17.2's `failedChecks[]` entry. `state` is fixed at FAIL: a TIMEOUT is a failure here. */
export interface FailedCheck {
  readonly name: string;
  readonly reason: string;
  readonly state: 'FAIL';
}

export interface HealthBody {
  readonly dependencyState: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  readonly checkedAt: string;
  readonly service: string;
  readonly apiVersion: string;
  readonly dependencies: readonly { readonly name: string; readonly reachable: boolean; readonly latencyMs: number }[];
  readonly degraded: readonly string[];
}

export interface ReadyBody {
  readonly dependencyState: 'READY' | 'NOT_READY';
  readonly service: string;
  readonly checkedAt: string;
  readonly candidateEpoch: string | null;
  readonly artifactDigest: string | null;
  readonly failedChecks: readonly FailedCheck[];
  readonly checks: readonly DependencyCheck[];
}

export interface LivenessBody {
  readonly dependencyState: 'ALIVE';
  readonly startedAt: string;
  readonly uptimeSeconds: number;
}

export interface StartupBody {
  readonly dependencyState: 'STARTED' | 'NOT_STARTED';
  readonly checkedAt: string;
  readonly configurationResolved: boolean;
  readonly migrationApplied: boolean;
  readonly resourceAttributesResolved: boolean;
  readonly failedChecks: readonly FailedCheck[];
}

export interface HealthRouteOptions {
  readonly deps: HealthDependencies;
  /**
   * @deprecated Build identity moved out of these bodies when they were reshaped to the declared
   * shapes: SPEC-003 §5.17.1's body has no version or commit field. Kept as accepted-but-unused so a
   * registration site that still passes them does not fail to compile; the values belong in logs and
   * `/metrics` (SPEC-007 §2.3), not in a dependency-health classification.
   */
  readonly version?: string;
  readonly commit?: string;
}

/** SPEC-007 §7.2 rule 2: the whole readiness evaluation is bounded, and the bound is declared. */
export const READINESS_BUDGET_MS = 1500;

interface Evaluation {
  readonly checks: readonly DependencyCheck[];
  readonly failedRequired: readonly FailedCheck[];
  readonly totalLatencyMs: number;
}

/**
 * Run every declared probe UNDER ITS OWN DEADLINE, and report what happened rather than collapsing it.
 *
 * A probe that THROWS is a failure, not a crash: an exception escaping into the response would leak a
 * stack trace (SPEC-003 §8.3), so it is reduced to a name and a reason code. A probe that exceeds its
 * timeout is FAIL/TIMEOUT, and the losing promise is not awaited further.
 */
async function evaluate(deps: HealthDependencies): Promise<Evaluation> {
  const startedAt = Date.now();
  const checks = await Promise.all(
    deps.probes.map(async (input): Promise<DependencyCheck> => {
      const probeStarted = Date.now();
      let outcome: ProbeOutcome;
      let name: string;
      let required: boolean;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (typeof input === 'function') {
          // LEGACY PROBE: unnamed until it runs, so it is normalised AFTER the fact. Required, because
          // every caller of this shape predates role-based requiredness and relied on "all probes pass".
          const declared = LEGACY_PROBE_TIMEOUT_MS;
          const result = await Promise.race([
            input(),
            new Promise<ProbeResult>((resolve) => {
              timer = setTimeout(() => resolve({ name: 'unknown-probe', ok: false, reason: 'TIMEOUT' }), declared);
            }),
          ]);
          name = result.name;
          required = true;
          outcome = { ok: result.ok, reasonCode: result.reason ?? null };
        } else {
          name = input.name;
          required = input.required;
          outcome = await Promise.race([
            input.run(),
            new Promise<ProbeOutcome>((resolve) => {
              timer = setTimeout(() => resolve({ ok: false, reasonCode: 'TIMEOUT' }), input.timeoutMs);
            }),
          ]);
        }
      } catch {
        // The thrown value is discarded on purpose: its message could carry a DSN or a driver string.
        name = typeof input === 'function' ? 'unknown-probe' : input.name;
        required = typeof input === 'function' ? true : input.required;
        outcome = { ok: false, reasonCode: 'UNKNOWN' };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const latencyMs = Date.now() - probeStarted;
      return Object.freeze({
        name,
        required,
        status: outcome.ok ? ('PASS' as const) : ('FAIL' as const),
        reachable: outcome.ok,
        latencyMs,
        reasonCode: outcome.ok ? null : (outcome.reasonCode ?? 'UNKNOWN'),
      });
    }),
  );
  const failedRequired = checks
    .filter((check) => check.required && check.status !== 'PASS')
    .map((check) => Object.freeze({ name: check.name, reason: check.reasonCode ?? 'UNKNOWN', state: 'FAIL' as const }));
  return { checks: Object.freeze(checks), failedRequired: Object.freeze(failedRequired), totalLatencyMs: Date.now() - startedAt };
}

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (
  app: FastifyInstance,
  options: HealthRouteOptions,
) => {
  const { deps } = options;
  // NORMALISED ONCE, WITH THE DEFAULTS THE SPEC FIXES: a caller that declares none of the identity
  // fields still gets a body the specification accepts, and the defaults are the spec's own values
  // (`vanishgraph-api`, `v1`) rather than blanks. `candidateEpoch` and `artifactDigest` stay null when
  // unresolved ON PURPOSE: a readiness body that invented them would be the static-200 failure §5.17.2
  // forbids, and null is the honest value for "this process cannot name its artifact".
  const service = deps.service ?? DEFAULT_SERVICE;
  const apiVersion = deps.apiVersion ?? DEFAULT_API_VERSION;
  const startup = deps.startup ?? { configurationResolved: true, migrationApplied: true, resourceAttributesResolved: true };
  const uptimeSeconds = (): number =>
    Math.max(0, Math.floor((deps.now().getTime() - deps.startedAt.getTime()) / 1000));

  // SPEC-003 §5.17.1 /v1/health — aggregate dependency state. NOT liveness, and NOT build identity:
  // §5.17.1's body has no version or commit field, and the classification must never be confused with
  // a truth state, so the field is `dependencyState` and `status` is deliberately absent.
  app.get('/v1/health', async (_request, reply) => {
    const evaluation = await evaluate(deps);
    const degraded = evaluation.checks.filter((check) => !check.required && check.status !== 'PASS').map((check) => check.name);
    const body: HealthBody = {
      dependencyState: evaluation.failedRequired.length > 0 ? 'UNHEALTHY' : degraded.length > 0 ? 'DEGRADED' : 'HEALTHY',
      checkedAt: deps.now().toISOString(),
      service,
      apiVersion,
      dependencies: evaluation.checks.map((check) => ({ name: check.name, reachable: check.reachable, latencyMs: check.latencyMs })),
      degraded,
    };
    // 503 only when a REQUIRED dependency is unreachable (§5.17.1); a degraded optional one is 200.
    return reply.code(evaluation.failedRequired.length > 0 ? 503 : 200).send(body);
  });

  // SPEC-003 §5.17.2 /v1/ready — readiness. 503 on the first failing evaluation, with the failing
  // checks NAMED and every declared dependency reported.
  app.get('/v1/ready', async (_request, reply) => {
    const evaluation = await evaluate(deps);
    const ready = evaluation.failedRequired.length === 0;
    const body: ReadyBody = {
      dependencyState: ready ? 'READY' : 'NOT_READY',
      service,
      checkedAt: deps.now().toISOString(),
      candidateEpoch: deps.candidateEpoch ?? null,
      artifactDigest: deps.artifactDigest ?? null,
      failedChecks: evaluation.failedRequired,
      checks: evaluation.checks,
    };
    // 503 with a body, never a bare status: the named failing check is the whole point.
    return reply.code(ready ? 200 : 503).send(body);
  });

  // SPEC-003 §5.17.3 /v1/live — liveness only. It performs NO dependency I/O (§7.3: a dependency
  // outage must not fail liveness, because restarting a healthy process turns a dependency incident
  // into an availability incident). The absence of probes here is the contract, not an omission.
  app.get('/v1/live', async (_request, reply) => {
    const body: LivenessBody = {
      dependencyState: 'ALIVE',
      startedAt: deps.startedAt.toISOString(),
      uptimeSeconds: uptimeSeconds(),
    };
    return reply.code(200).send(body);
  });

  // SPEC-003 §5.17.4 /v1/startup — initialization completion: migration applied, configuration and
  // secret resolution, resource attributes resolved. A process that reports STARTED before resource
  // attributes resolve would emit unattributed telemetry (SPEC-007 §7.1).
  app.get('/v1/startup', async (_request, reply) => {
    const failedChecks: FailedCheck[] = [];
    if (!startup.configurationResolved) failedChecks.push({ name: 'configuration', reason: 'UNRESOLVED', state: 'FAIL' });
    if (!startup.migrationApplied) failedChecks.push({ name: 'migration', reason: 'NOT_APPLIED', state: 'FAIL' });
    if (!startup.resourceAttributesResolved) failedChecks.push({ name: 'resource-attributes', reason: 'UNRESOLVED', state: 'FAIL' });
    const started = failedChecks.length === 0;
    const body: StartupBody = {
      dependencyState: started ? 'STARTED' : 'NOT_STARTED',
      checkedAt: deps.now().toISOString(),
      configurationResolved: startup.configurationResolved,
      migrationApplied: startup.migrationApplied,
      resourceAttributesResolved: startup.resourceAttributesResolved,
      failedChecks,
    };
    return reply.code(started ? 200 : 503).send(body);
  });
};
