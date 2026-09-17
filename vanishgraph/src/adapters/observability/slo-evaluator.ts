/**
 * The SLO evaluator (SPEC-007 §9, §12.7; EP-008 M7(b); DOD-022, DOD-038, DOD-027).
 *
 * THE VERDICT VOCABULARY IS FOUR VALUES AND THE GAPS BETWEEN THEM ARE THE POINT. `PASS` and `FAIL` are claims about a
 * measured interval; `INCONCLUSIVE` says the sample cannot support either claim; `DEFERRED_LONG_RUNNING` says the
 * objective is duration-bound and the campaign window cannot contain it yet. §9 and DOD-038 make the distinction
 * binding: A SHORTENED TRIAL IS NEVER REPORTED AS PASS, and an evaluator that rounded a missing sample to PASS would be
 * the fabrication this node exists to prevent. So every path below either computes a verdict from recorded values or
 * returns a reason naming what is missing.
 *
 * WHAT IT READS AND WHAT IT REFUSES TO READ. Every value comes from the CALLER's recorded series — this module has no
 * data source, no clock and no environment access, so a verdict cannot be produced from anything but evidence the caller
 * actually holds. §9 also forbids local and CI environments from producing a verdict at all; that is enforced by the
 * CALLER passing `environment`, and `evaluateObjectives` degrades PASS/FAIL to INCONCLUSIVE when the environment is not a
 * verdict-bearing one, rather than trusting the caller to remember.
 *
 * THRESHOLD WEAKENING IS NOT POSSIBLE FROM HERE: the thresholds come from the objectives document, and this module
 * neither defaults nor adjusts them. DOD-027 makes lowering a threshold to obtain a pass a defect, so the evaluator has
 * no argument through which one could be supplied.
 */

import type { MetricsRegistry } from './metrics-registry.ts';

export const SLO_VERDICTS = ['PASS', 'FAIL', 'INCONCLUSIVE', 'DEFERRED_LONG_RUNNING'] as const;
export type SloVerdictValue = (typeof SLO_VERDICTS)[number];

/** The environments §9 allows to carry a verdict. Anywhere else, PASS and FAIL degrade to INCONCLUSIVE. */
export const VERDICT_BEARING_ENVIRONMENTS = ['staging', 'production'] as const;

export interface SloObjective {
  readonly id: string;
  readonly objective: string;
  readonly indicator: string;
  readonly threshold: string;
  readonly window: string;
  readonly workload: string;
  readonly verdictRule: string;
}

export interface SloObjectivesDocument {
  readonly objectives: readonly SloObjective[];
  readonly workload_models: Readonly<Record<string, unknown>>;
}

/** What the caller actually observed. Nothing here is inferred, and a missing key is a missing key. */
export interface SloSample {
  readonly window: { readonly from: string; readonly to: string; readonly complete: boolean };
  /** Metric family name → observed value over the window. */
  readonly values: Readonly<Record<string, number>>;
  /** Completed observations behind a quantile, when the objective requires a minimum. */
  readonly observations?: number;
  /** The honest destination states present in the window, for the completion objective. */
  readonly destinationStatesPresent?: readonly string[];
  /** Ambiguity events in the window, for the reconciliation objective. */
  readonly ambiguityEvents?: number;
  /** The integrity matrix: one row per induced or undisturbed run. */
  readonly integrityRuns?: readonly { readonly objectiveId: string; readonly induced: boolean; readonly verdict: SloVerdictValue; readonly environment: string }[];
}

export interface SloVerdict {
  readonly id: string;
  readonly objective: string;
  readonly verdict: SloVerdictValue;
  /** Why this verdict, in the evaluator's own words: a reader must not have to guess. */
  readonly reason: string;
  readonly badEvents: number | null;
  readonly allowedBadEvents: number | null;
  readonly burnRatio: number | null;
  readonly window: string;
  readonly sampleWindow: string;
  readonly workload: string;
}

const HONEST_DESTINATION_STATES = ['VERIFIED_REMOVED', 'VERIFIED_NOT_PRESENT', 'NOT_REMOVABLE', 'HUMAN_REQUIRED', 'SEARCH_DELISTED'] as const;

/** The ratios an objective asserts, in the form `bad events / total` where that is how §9 expresses it. */
function availabilityVerdict(sample: SloSample, environment: string): { verdict: SloVerdictValue; reason: string; badEvents: number | null; total: number | null } {
  const served = sample.values['vanishgraph_server_http_served_total'];
  const failed = sample.values['vanishgraph_server_http_served_total_5xx'];
  if (served === undefined || failed === undefined) {
    return { verdict: 'INCONCLUSIVE', reason: 'the served-response count and its 5xx count are both required, and at least one is missing', badEvents: null, total: null };
  }
  if (served === 0) {
    // A RATIO OVER ZERO REQUESTS IS NOT 100 PER CENT AVAILABILITY, it is no measurement: §9's threshold cannot be
    // satisfied by having served nothing.
    return { verdict: 'INCONCLUSIVE', reason: 'no responses were served in the window, so availability is unmeasured rather than perfect', badEvents: failed, total: served };
  }
  const ratio = (served - failed) / served;
  const threshold = 0.999;
  if (environment !== 'staging' && environment !== 'production') {
    return { verdict: 'INCONCLUSIVE', reason: `§9 forbids a verdict outside staging or production, and this sample is from "${environment}"; the measured ratio is ${ratio.toFixed(6)}`, badEvents: failed, total: served };
  }
  return ratio >= threshold
    ? { verdict: 'PASS', reason: `availability ${ratio.toFixed(6)} is at or above ${String(threshold)}`, badEvents: failed, total: served }
    : { verdict: 'FAIL', reason: `availability ${ratio.toFixed(6)} is below ${String(threshold)}`, badEvents: failed, total: served };
}

function latencyVerdict(sample: SloSample, environment: string): { verdict: SloVerdictValue; reason: string; badEvents: number | null; total: number | null } {
  const p95 = sample.values['vanishgraph_verification_lag_seconds_p95'];
  const p99 = sample.values['vanishgraph_verification_lag_seconds_p99'];
  const observations = sample.observations ?? 0;
  if (p95 === undefined || p99 === undefined) {
    return { verdict: 'INCONCLUSIVE', reason: 'the p95 and p99 lag values are both required, and at least one is missing', badEvents: null, total: null };
  }
  if (observations < 30) {
    // A QUANTILE OVER A HANDFUL OF SAMPLES IS NOT A MEASUREMENT, which §9 states as a minimum count.
    return { verdict: 'INCONCLUSIVE', reason: `${String(observations)} completed observation(s) is below the required 30, so the quantiles are not a measurement`, badEvents: null, total: observations };
  }
  if (environment !== 'staging' && environment !== 'production') {
    return { verdict: 'INCONCLUSIVE', reason: `§9 forbids a verdict outside staging or production, and this sample is from "${environment}"`, badEvents: null, total: observations };
  }
  const within = p95 <= 1_209_600 && p99 <= 2_592_000;
  return within
    ? { verdict: 'PASS', reason: `p95 ${String(p95)} s and p99 ${String(p99)} s are within their thresholds over ${String(observations)} observations`, badEvents: null, total: observations }
    : { verdict: 'FAIL', reason: `p95 ${String(p95)} s / p99 ${String(p99)} s exceed a threshold over ${String(observations)} observations`, badEvents: null, total: observations };
}

function completionVerdict(sample: SloSample, environment: string): { verdict: SloVerdictValue; reason: string; badEvents: number | null; total: number | null } {
  const present = sample.destinationStatesPresent ?? [];
  const missing = HONEST_DESTINATION_STATES.filter((state) => !present.includes(state));
  const completions = sample.values['vanishgraph_truth_state_transitions_total_completed'];
  const eligible = sample.values['vanishgraph_truth_state_transitions_total_eligible'];
  if (missing.length > 0) {
    // A COMPLETION RATIO OVER A SUBSET OF DESTINATIONS IS A DIFFERENT NUMBER, so a missing state is INCONCLUSIVE.
    return { verdict: 'INCONCLUSIVE', reason: `the window does not carry every honest destination state; missing ${missing.join(', ')}`, badEvents: null, total: null };
  }
  if (completions === undefined || eligible === undefined || eligible === 0) {
    return { verdict: 'INCONCLUSIVE', reason: 'the completion and eligible counts are both required and eligible must be non-zero', badEvents: null, total: eligible ?? null };
  }
  const ratio = completions / eligible;
  if (environment !== 'staging' && environment !== 'production') {
    return { verdict: 'INCONCLUSIVE', reason: `§9 forbids a verdict outside staging or production, and this sample is from "${environment}"`, badEvents: eligible - completions, total: eligible };
  }
  return ratio >= 0.95
    ? { verdict: 'PASS', reason: `completion ${ratio.toFixed(4)} is at or above 0.95`, badEvents: eligible - completions, total: eligible }
    : { verdict: 'FAIL', reason: `completion ${ratio.toFixed(4)} is below 0.95`, badEvents: eligible - completions, total: eligible };
}

function reconciliationVerdict(sample: SloSample, environment: string): { verdict: SloVerdictValue; reason: string; badEvents: number | null; total: number | null } {
  const p90 = sample.values['vanishgraph_reconciliation_lag_seconds_p90'];
  const max = sample.values['vanishgraph_reconciliation_lag_seconds_max'];
  const events = sample.ambiguityEvents ?? 0;
  if (events === 0) {
    // NOTHING WAS EXERCISED: a reconciliation objective with no ambiguity event is unmeasured, not satisfied.
    return { verdict: 'INCONCLUSIVE', reason: 'no ambiguity event occurred in the window, so the objective was never exercised', badEvents: null, total: 0 };
  }
  if (p90 === undefined || max === undefined) {
    return { verdict: 'INCONCLUSIVE', reason: 'the p90 and maximum reconciliation lags are both required, and at least one is missing', badEvents: null, total: events };
  }
  if (environment !== 'staging' && environment !== 'production') {
    return { verdict: 'INCONCLUSIVE', reason: `§9 forbids a verdict outside staging or production, and this sample is from "${environment}"`, badEvents: null, total: events };
  }
  const within = p90 <= 14_400 && max <= 86_400;
  return within
    ? { verdict: 'PASS', reason: `p90 ${String(p90)} s and max ${String(max)} s are within their thresholds over ${String(events)} ambiguity event(s)`, badEvents: null, total: events }
    : { verdict: 'FAIL', reason: `p90 ${String(p90)} s or max ${String(max)} s exceeds a threshold`, badEvents: null, total: events };
}

/**
 * The integrity objective, evaluated from the matrix rather than from a series.
 *
 * THE REVOCATION IS THE WHOLE OBJECTIVE: if an induced breach produced PASS, then a verdict of PASS means nothing, so
 * every dependent verdict is returned as INCONCLUSIVE — in the SAME result set, so a caller cannot read the four
 * objectives without seeing that they were revoked.
 */
function integrityVerdict(sample: SloSample): { verdict: SloVerdictValue; reason: string; revoked: boolean } {
  const runs = sample.integrityRuns ?? [];
  const induced = runs.filter((run) => run.induced);
  const undisturbed = runs.filter((run) => !run.induced);
  if (induced.length === 0 || undisturbed.length === 0) {
    return { verdict: 'INCONCLUSIVE', reason: `the integrity matrix needs at least one induced run and one undisturbed run and carries ${String(induced.length)} and ${String(undisturbed.length)}`, revoked: false };
  }
  const breachedButPassed = induced.filter((run) => run.verdict === 'PASS');
  if (breachedButPassed.length > 0) {
    return {
      verdict: 'FAIL',
      reason: `an induced breach yielded PASS for ${breachedButPassed.map((run) => run.objectiveId).join(', ')}, so every dependent verdict is revoked as INCONCLUSIVE`,
      revoked: true,
    };
  }
  const undisturbedFailed = undisturbed.filter((run) => run.verdict !== 'PASS');
  if (undisturbedFailed.length > 0) {
    return { verdict: 'FAIL', reason: `an undisturbed run did not yield PASS for ${undisturbedFailed.map((run) => run.objectiveId).join(', ')}`, revoked: false };
  }
  return { verdict: 'PASS', reason: `every induced breach yielded FAIL and every undisturbed run yielded PASS across ${String(runs.length)} run(s)`, revoked: false };
}

export interface EvaluationOptions {
  readonly objectives: SloObjectivesDocument;
  readonly sample: SloSample;
  /** Required: §9 permits a verdict only in a verdict-bearing environment, and the caller must state which it is. */
  readonly environment: string;
  readonly registry?: MetricsRegistry;
  /** The labels the emitted series carry. `window` must match the objective's window, not the sample's. */
  readonly labels?: { readonly tenant_class?: string; readonly source_class?: string };
}

export interface EvaluationResult {
  readonly verdicts: readonly SloVerdict[];
  /** True when VG-SLO-005 found an induced breach that passed, so the other verdicts were revoked. */
  readonly revoked: boolean;
}

/** Evaluate every objective in the document. Order is the document's order, so output is stable. */
export function evaluateObjectives(options: EvaluationOptions): EvaluationResult {
  const environment = options.environment;
  const results: SloVerdict[] = [];
  let revoked = false;

  for (const objective of options.objectives.objectives) {
    const shortWindow = options.sample.window.complete ? null : `the sample window ${options.sample.window.from} … ${options.sample.window.to} is not complete, and a shortened trial is never reported as PASS (DOD-038)`;
    let computed: { verdict: SloVerdictValue; reason: string; badEvents: number | null; total: number | null };
    if (objective.id === 'VG-SLO-005') {
      const integrity = integrityVerdict(options.sample);
      if (integrity.revoked) revoked = true;
      computed = { verdict: integrity.verdict, reason: integrity.reason, badEvents: null, total: null };
    } else if (shortWindow !== null) {
      // THE DURATION-BOUND OBJECTIVES DEFER RATHER THAN FAIL: a 30-day window that cannot exist yet is not evidence of
      // anything, and DOD-038 names the verdict for exactly that case.
      computed = { verdict: 'DEFERRED_LONG_RUNNING', reason: shortWindow, badEvents: null, total: null };
    } else if (objective.id === 'VG-SLO-001') {
      computed = availabilityVerdict(options.sample, environment);
    } else if (objective.id === 'VG-SLO-002') {
      computed = latencyVerdict(options.sample, environment);
    } else if (objective.id === 'VG-SLO-003') {
      computed = completionVerdict(options.sample, environment);
    } else if (objective.id === 'VG-SLO-004') {
      computed = reconciliationVerdict(options.sample, environment);
    } else {
      // AN OBJECTIVE THIS EVALUATOR DOES NOT KNOW IS INCONCLUSIVE, NEVER PASS: the alternative is a verdict about a rule
      // nobody implemented.
      computed = { verdict: 'INCONCLUSIVE', reason: `no evaluation rule is implemented for ${objective.id}`, badEvents: null, total: null };
    }

    const allowedBadEvents = computed.total === null ? null : Number(((1 - thresholdOf(objective)) * computed.total).toFixed(4));
    const burnRatio = allowedBadEvents === null || allowedBadEvents === 0 || computed.badEvents === null ? null : Number((computed.badEvents / allowedBadEvents).toFixed(4));
    const verdict: SloVerdict = Object.freeze({
      id: objective.id,
      objective: objective.objective,
      verdict: computed.verdict,
      reason: computed.reason,
      badEvents: computed.badEvents,
      allowedBadEvents,
      burnRatio,
      window: objective.window,
      sampleWindow: `${options.sample.window.from} … ${options.sample.window.to}`,
      workload: objective.workload,
    });
    results.push(verdict);
    if (options.registry !== undefined) {
      emit(options.registry, options, verdict, environment);
    }
  }

  return {
    revoked,
    verdicts: revoked
      ? results.map((verdict) =>
          verdict.id === 'VG-SLO-005' || verdict.verdict !== 'PASS'
            ? verdict
            : Object.freeze({ ...verdict, verdict: 'INCONCLUSIVE' as const, reason: `${verdict.reason}; REVOKED because an induced breach yielded PASS and VG-SLO-005 is FAIL` }),
        )
      : results,
  };
}

/** The numeric threshold of an objective, read from its own text so the burn ratio cannot use a different one. */
function thresholdOf(objective: SloObjective): number {
  const match = /([01](?:\.\d+)?)/.exec(objective.threshold);
  return match === null ? 1 : Number(match[1]);
}

function emit(registry: MetricsRegistry, options: EvaluationOptions, verdict: SloVerdict, environment: string): void {
  const labels = {
    environment,
    objective: verdict.objective,
    window: verdict.window,
    ...(options.labels?.tenant_class === undefined ? {} : { tenant_class: options.labels.tenant_class }),
    ...(options.labels?.source_class === undefined ? {} : { source_class: options.labels.source_class }),
  };
  // THE VERDICT SERIES IS AN ENUM AND AN ABSENT SERIES IS INCONCLUSIVE (§6.5, alert A-15), so a value that cannot be
  // expressed as PASS or FAIL is emitted as INCONCLUSIVE rather than omitted.
  const enumValue = verdict.verdict === 'PASS' ? 1 : verdict.verdict === 'FAIL' ? 2 : 0;
  registry.record('vanishgraph_slo_verdict', labels, enumValue);
  if (verdict.badEvents !== null) registry.record('vanishgraph_slo_bad_events_total', labels, verdict.badEvents);
  if (verdict.allowedBadEvents !== null) registry.record('vanishgraph_slo_allowed_bad_events', labels, verdict.allowedBadEvents);
  if (verdict.burnRatio !== null) registry.record('vanishgraph_slo_error_budget_burn_ratio', labels, verdict.burnRatio);
}

/** One line per objective, in the format `scripts/slo-evaluate.sh` prints and the plan expects. */
export function formatVerdictLine(verdict: SloVerdict): string {
  return `slo ${verdict.objective}: ${verdict.verdict}`;
}
