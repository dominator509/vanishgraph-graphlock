/**
 * The readiness contract the HTTP layer consumes (SPEC-007 §7.3-§7.4; SPEC-003 §5.17; EP-008 M5(b)).
 *
 * WHY THIS FILE CARRIES NO PROBE AND NO LOGGER. `scripts/import-boundary.sh` refuses `src/http` importing anything from
 * `src/adapters` or `src/infrastructure`, and it is right to: the route layer must not reach into infrastructure. The
 * first version of this file imported the probe runner, the metrics registry and the structured logger directly, and the
 * boundary check refused it — MEASURED, and recorded here rather than worked around by relaxing the check (DOD-027).
 *
 * So the split is: THIS file declares what the route layer needs — a decision and the port that produces it — and
 * `src/infrastructure/observability/compose-telemetry.ts` implements that port over the real probes, the real registry
 * and the real logger. The route layer therefore sees a shape it can render, and the probe wiring stays in the
 * composition root where the architecture puts it.
 */

import type { HealthDependencies, ProbeResult } from './routes/health.ts';

/** One dependency's verdict, as the route layer renders it. */
export interface ReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly reasonCode: string | null;
}

/** The readiness decision, with the failing checks named (§7.3: never collapsed into a boolean). */
export interface ReadinessDecision {
  readonly dependencyState: 'READY' | 'NOT_READY';
  readonly failedChecks: readonly string[];
  readonly checks: readonly ReadinessCheck[];
  readonly budgetExceeded: boolean;
  readonly totalLatencyMs: number;
}

/** What the composition root provides. One method, so a test can drive the route layer with any implementation. */
export interface ReadinessDecisionPort {
  decide(): Promise<ReadinessDecision>;
}

/**
 * The `ReadinessChanged` record of §7.3, as data.
 *
 * IT IS PRODUCED HERE, FROM A TRANSITION, AND WRITTEN BY THE COMPOSITION ROOT: this module decides WHAT the record says
 * and the root owns HOW it is logged, which keeps the logger out of the route layer while keeping the rule — one record
 * per transition to unready, at `ERROR`, naming the failing `dependencyKey` and its `reasonCode` — in one place.
 */
export interface ReadinessChangedRecord {
  readonly event: 'ReadinessChanged';
  readonly severity: 'ERROR';
  readonly dependencyKey: string;
  readonly reasonCode: string;
  readonly message: string;
}

/** The transition rule, pure: a record exactly when the verdict CHANGES to unready. */
export function readinessTransitionRecord(
  previous: ReadinessDecision['dependencyState'] | null,
  decision: ReadinessDecision,
): ReadinessChangedRecord | null {
  if (previous === null || previous === decision.dependencyState || decision.dependencyState !== 'NOT_READY') return null;
  const firstFailed = decision.checks.find((check) => check.name === decision.failedChecks[0]);
  return Object.freeze({
    event: 'ReadinessChanged' as const,
    severity: 'ERROR' as const,
    dependencyKey: firstFailed?.name ?? 'overall',
    reasonCode: firstFailed?.reasonCode ?? 'UNKNOWN',
    message: `readiness changed to NOT_READY: ${decision.failedChecks.join(', ')}`,
  });
}

/**
 * Translate a decision into the probe list the §5.17 routes already accept.
 *
 * EVERY DECLARED DEPENDENCY BECOMES A PROBE ENTRY, including the ones that passed, because §7.4 step 3 reads
 * `failedChecks` AND the full `checks` array: a response that lists only failures cannot distinguish one dependency down
 * from five.
 */
export function toHealthDependencies(
  decision: ReadinessDecision,
  options: { readonly now: () => Date; readonly startedAt: Date; readonly decide: () => Promise<ReadinessDecision> },
): HealthDependencies {
  const probes = decision.checks.map(
    (check) =>
      async (): Promise<ProbeResult> => ({
        name: check.name,
        ok: check.ok,
        latencyMs: check.latencyMs,
        ...(check.reasonCode === null ? {} : { reason: check.reasonCode }),
      }),
  );
  return { probes, now: options.now, startedAt: options.startedAt };
}
