/**
 * The primary effectiveness metric (SPEC-007 §6.3, §6.6; SPEC-003 §5.16.3; EP-008 M4(c); VG-OBS-002, DOD-022, DOD-037).
 *
 * ONE COMPUTATION, NOT TWO. §6.3 is explicit: "The metric plane and the API must use this one definition; a second,
 * divergent denominator definition anywhere is a defect." The API's figure is computed by
 * `src/adapters/persistence/coverage.ts` (the §5.16.3 route reads it), so THIS MODULE IMPORTS THAT COMPUTATION — the
 * Wilson interval, the ratio rule and the denominator definition string — instead of re-deriving them. Nothing here
 * recomputes a ratio. What this module adds is the part the API does not have: the four `component` values as a counter,
 * the ratio as a gauge labelled `ci` ∈ {point, lower, upper}, and the `no_data` state as an explicit status.
 *
 * THE FOUR COMPONENTS ARE MANDATORY AND TWO OF THEM ARE EXCLUSIONS. §6.3: "The exclusion components are mandatory so
 * exclusions are visible, never silent" and "HUMAN_REQUIRED and NOT_REMOVABLE outcomes are counted in the `excluded_*`
 * components and are never subtracted into an unlabelled residual". A denominator that quietly dropped them would read
 * as a smaller cohort and a HIGHER ratio for the same outcomes — the divergence §13.3 item 9 records as already having
 * happened once between two definitions of this metric.
 *
 * §6.6 BINDS THE INPUT, NOT JUST THE OUTPUT: every value here is derived from DOMAIN EVENTS. The caller passes counts the
 * domain already decided; this module has no way to increment anything from a page view, a UI action or an intention,
 * and a series that was never observed stays absent rather than becoming zero.
 */

import {
  DENOMINATOR_DEFINED_AS,
  figure,
  wilson,
} from '../persistence/coverage.ts';
import type { MetricsRegistry } from './metrics-registry.ts';

/** The four `component` values of §6.3, in the specification's order. */
export const EFFECTIVENESS_COMPONENTS = [
  'numerator',
  'denominator',
  'excluded_not_removable',
  'excluded_human_required',
] as const;

export type EffectivenessComponent = (typeof EFFECTIVENESS_COMPONENTS)[number];

/** The three `ci` values of §6.3: the point estimate and both ends, always emitted together. */
export const CONFIDENCE_INTERVAL_LABELS = ['point', 'lower', 'upper'] as const;

export const EFFECTIVENESS_EVENTS_METRIC = 'vanishgraph_removal_effectiveness_events_total';
export const EFFECTIVENESS_RATIO_METRIC = 'vanishgraph_removal_effectiveness_ratio';

/**
 * What the domain observed in the measurement interval, in the vocabulary of the §5.16.3 response.
 *
 * `acknowledged`, `requestSubmitted`, `searchDelisted` and `ambiguous` are disclosed by the API in
 * `excludedFromNumerator`; §6.3 states they are API response fields and NOT metric label values, so they are carried
 * here for the response-shaped figure and are deliberately not turned into components.
 */
export interface EffectivenessOutcomeSet {
  readonly eligibleConfirmedMatchDenominator: number;
  readonly verifiedRemovedNumerator: number;
  readonly excludedNotRemovable: number;
  readonly excludedHumanRequired: number;
  readonly acknowledged: number;
  readonly requestSubmitted: number;
  readonly searchDelisted: number;
  readonly ambiguous: number;
}

/** The metric-plane figure: the API's figure plus the `no_data` state the metric contract requires. */
export interface EffectivenessMetricFigure {
  readonly status: 'computed' | 'no_data';
  readonly verifiedRemovedNumerator: number;
  readonly eligibleConfirmedMatchDenominator: number;
  /** `null` when the denominator is zero — never `0`, which would read as "nothing was removed" (SPEC-003 §5.16.3). */
  readonly ratio: number | null;
  readonly confidenceInterval: { readonly level: number; readonly low: number; readonly high: number } | null;
  readonly denominatorDefinedAs: string;
  readonly components: Readonly<Record<EffectivenessComponent, number>>;
  readonly excludedFromNumerator: {
    readonly acknowledged: number;
    readonly requestSubmitted: number;
    readonly searchDelisted: number;
    readonly notRemovable: number;
    readonly humanRequired: number;
    readonly ambiguous: number;
  };
  /** Why the interval is absent, when it is. Always names the denominator. */
  readonly noDataReason: string | null;
}

function requireCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    // A negative or fractional event count is not a measurement. Refusing it here keeps a fabricated number out of the
    // figure rather than letting it reach a ratio that looks precise.
    throw new RangeError(`${field} must be a non-negative integer, received ${String(value)}`);
  }
  return value;
}

/**
 * Build the figure for one interval.
 *
 * THE API FIGURE AND THIS ONE COME FROM THE SAME `figure()` CALL, so the ratio and the interval cannot differ between the
 * published number and the metric series. The exclusions are added here because the API discloses them separately and the
 * metric contract makes them components.
 */
export function computeEffectivenessFigure(outcomes: EffectivenessOutcomeSet): EffectivenessMetricFigure {
  const denominator = requireCount(outcomes.eligibleConfirmedMatchDenominator, 'eligibleConfirmedMatchDenominator');
  const numerator = requireCount(outcomes.verifiedRemovedNumerator, 'verifiedRemovedNumerator');
  if (numerator > denominator) {
    // A numerator larger than its denominator is arithmetically possible and semantically impossible here: every
    // verified removal in the figure is a member of the cohort. Refusing it is the §6.3 rule that a removal counts at
    // most once per exposure per observation window.
    throw new RangeError(`the numerator ${String(numerator)} exceeds the denominator ${String(denominator)}: each exposure contributes at most once`);
  }
  const shared = figure(numerator, denominator);
  const noData = denominator === 0;
  return Object.freeze({
    status: noData ? ('no_data' as const) : ('computed' as const),
    verifiedRemovedNumerator: shared.verifiedRemovedNumerator,
    eligibleConfirmedMatchDenominator: shared.eligibleConfirmedMatchDenominator,
    ratio: shared.ratio,
    confidenceInterval: shared.confidenceInterval,
    denominatorDefinedAs: shared.denominatorDefinedAs,
    components: Object.freeze({
      numerator: shared.verifiedRemovedNumerator,
      denominator: shared.eligibleConfirmedMatchDenominator,
      excluded_not_removable: requireCount(outcomes.excludedNotRemovable, 'excludedNotRemovable'),
      excluded_human_required: requireCount(outcomes.excludedHumanRequired, 'excludedHumanRequired'),
    }),
    excludedFromNumerator: Object.freeze({
      acknowledged: requireCount(outcomes.acknowledged, 'acknowledged'),
      requestSubmitted: requireCount(outcomes.requestSubmitted, 'requestSubmitted'),
      searchDelisted: requireCount(outcomes.searchDelisted, 'searchDelisted'),
      notRemovable: requireCount(outcomes.excludedNotRemovable, 'excludedNotRemovable'),
      humanRequired: requireCount(outcomes.excludedHumanRequired, 'excludedHumanRequired'),
      ambiguous: requireCount(outcomes.ambiguous, 'ambiguous'),
    }),
    noDataReason: noData
      ? `the denominator is zero, so the interval is not computed and the series is reported as no_data with the denominator present (SPEC-007 §6.3); the cohort is defined as: ${DENOMINATOR_DEFINED_AS}`
      : null,
  });
}

/** The label set every effectiveness series shares. `component` and `ci` are added per series. */
export interface EffectivenessLabels {
  readonly environment: string;
  readonly tenant_class: string;
  readonly source_class: string;
  readonly window: string;
}

export interface EffectivenessEmission {
  readonly figure: EffectivenessMetricFigure;
  readonly counterSamples: number;
  readonly ratioSamples: number;
}

/**
 * Emit the figure into the registry: the four components and, when the figure is computed, the three `ci` series.
 *
 * A `no_data` FIGURE EMITS THE COUNTERS AND NO RATIO SERIES. Emitting a ratio of 0 there would publish "0% removed" for
 * an interval in which nothing was eligible — the bare percentage §6.3 forbids — so the ratio series is ABSENT and the
 * denominator is present, which is exactly what "reported as no_data with the denominator present" means as data.
 */
export function emitEffectiveness(
  registry: MetricsRegistry,
  labels: EffectivenessLabels,
  outcomes: EffectivenessOutcomeSet,
): EffectivenessEmission {
  const figureValue = computeEffectivenessFigure(outcomes);
  let counterSamples = 0;
  for (const component of EFFECTIVENESS_COMPONENTS) {
    registry.record(EFFECTIVENESS_EVENTS_METRIC, { ...labels, component }, figureValue.components[component]);
    counterSamples += 1;
  }
  let ratioSamples = 0;
  if (figureValue.ratio !== null && figureValue.confidenceInterval !== null) {
    const point = figureValue.ratio;
    const interval = figureValue.confidenceInterval;
    for (const [ci, value] of [['point', point], ['lower', interval.low], ['upper', interval.high]] as const) {
      registry.record(EFFECTIVENESS_RATIO_METRIC, { ...labels, ci }, value);
      ratioSamples += 1;
    }
  }
  return { figure: figureValue, counterSamples, ratioSamples };
}

/**
 * The alerting rule's arithmetic, exposed so a test can recompute it independently of the figure.
 *
 * This is the SAME `wilson` the API route uses; it is re-exported rather than re-implemented so a third copy of the
 * formula cannot appear in a dashboard or a recording rule without failing the parity test.
 */
export const wilsonIntervalForMetric = wilson;
