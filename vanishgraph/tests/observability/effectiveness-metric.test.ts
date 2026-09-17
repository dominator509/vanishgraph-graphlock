/**
 * The primary effectiveness metric (EP-008 M4(c)(d); SPEC-007 §6.3, §6.6; SPEC-003 §5.16.3; VG-OBS-002).
 *
 * THE ARITHMETIC IS RECOMPUTED HERE, INDEPENDENTLY OF THE MODULE, FROM A RAW EVENT LIST. §6.3's figure is the published
 * number, so a test that trusted the module's own arithmetic would be the "asserts only its own arithmetic" defect this
 * repository has already withdrawn a suite for. The tally below is written from the definitions in the specification
 * text, and the Wilson interval is recomputed from the formula rather than from the module's helper.
 *
 * THE PARITY ASSERTION IS THE ONE THAT MATTERS MOST. §6.3: "The metric plane and the API must use this one definition; a
 * second, divergent denominator definition anywhere is a defect", and §13.3 item 9 records that a divergence of exactly
 * this kind already produced two different published effectiveness numbers from one dataset. So this suite asserts that
 * the metric plane's figure and the API route's figure are the SAME FUNCTION on the same inputs, including at the
 * boundaries (0/0, 0/N, N/N).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';

import {
  CONFIDENCE_INTERVAL_LABELS,
  EFFECTIVENESS_COMPONENTS,
  EFFECTIVENESS_EVENTS_METRIC,
  EFFECTIVENESS_RATIO_METRIC,
  computeEffectivenessFigure,
  emitEffectiveness,
  wilsonIntervalForMetric,
  type EffectivenessOutcomeSet,
} from '../../src/adapters/observability/effectiveness-metric.ts';
import { createMetricsRegistry, loadMetricCatalogue, type MetricCatalogue } from '../../src/adapters/observability/metrics-registry.ts';
import { DENOMINATOR_DEFINED_AS, figure, wilson } from '../../src/adapters/persistence/coverage.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const loaded = loadMetricCatalogue(join(ROOT, 'config/metrics/catalogue.json'));
assert.equal(loaded.ok, true);
const catalogue = (loaded as { ok: true; catalogue: MetricCatalogue }).catalogue;

const LABELS = { environment: 'local', tenant_class: 'TEST', source_class: 'PEOPLE_SEARCH', window: '28d' };

/** One row of the raw event list the tally is computed from: what the domain actually recorded for one exposure. */
interface ExposureEvent {
  readonly reachedMatchConfirmed: boolean;
  readonly policyDecisionComplete: boolean;
  readonly recipeFreshAndEnabled: boolean;
  readonly closedAs: 'VERIFIED_REMOVED' | 'ACKNOWLEDGED' | 'REQUEST_SUBMITTED' | 'SEARCH_DELISTED' | 'NOT_REMOVABLE' | 'HUMAN_REQUIRED' | 'AMBIGUOUS' | 'OPEN';
  readonly hasDistinctPathObservation: boolean;
}

/**
 * The tally, written from §6.3's definitions and NOT from the module: the denominator is exposures at MATCH_CONFIRMED or
 * beyond in the interval that carry a complete policy decision and an enabled fresh recipe; the numerator is the
 * denominator members that reached VERIFIED_REMOVED through a distinct path.
 */
function tally(events: readonly ExposureEvent[]): EffectivenessOutcomeSet {
  let denominator = 0;
  let numerator = 0;
  let notRemovable = 0;
  let humanRequired = 0;
  const excluded = { acknowledged: 0, requestSubmitted: 0, searchDelisted: 0, ambiguous: 0 };
  for (const event of events) {
    const eligible = event.reachedMatchConfirmed && event.policyDecisionComplete && event.recipeFreshAndEnabled;
    if (eligible) denominator += 1;
    if (event.closedAs === 'VERIFIED_REMOVED') {
      if (eligible && event.hasDistinctPathObservation) numerator += 1;
      continue;
    }
    if (event.closedAs === 'NOT_REMOVABLE') notRemovable += 1;
    if (event.closedAs === 'HUMAN_REQUIRED') humanRequired += 1;
    if (event.closedAs === 'ACKNOWLEDGED') excluded.acknowledged += 1;
    if (event.closedAs === 'REQUEST_SUBMITTED') excluded.requestSubmitted += 1;
    if (event.closedAs === 'SEARCH_DELISTED') excluded.searchDelisted += 1;
    if (event.closedAs === 'AMBIGUOUS') excluded.ambiguous += 1;
  }
  return {
    eligibleConfirmedMatchDenominator: denominator,
    verifiedRemovedNumerator: numerator,
    excludedNotRemovable: notRemovable,
    excludedHumanRequired: humanRequired,
    ...excluded,
  };
}

/** The Wilson score interval, recomputed from the formula with the standard 95% quantile. */
function wilsonFromFormula(numerator: number, denominator: number): { level: number; low: number; high: number } | null {
  if (denominator <= 0) return null;
  const z = 1.959963984540054;
  const p = numerator / denominator;
  const denominatorTerm = 1 + (z * z) / denominator;
  const centre = (p + (z * z) / (2 * denominator)) / denominatorTerm;
  const spread = (z * Math.sqrt((p * (1 - p)) / denominator + (z * z) / (4 * denominator * denominator))) / denominatorTerm;
  const round4 = (value: number): number => Number(value.toFixed(4));
  return { level: 0.95, low: round4(Math.max(0, centre - spread)), high: round4(Math.min(1, centre + spread)) };
}

const WORKLOAD: readonly ExposureEvent[] = [
  { reachedMatchConfirmed: true, policyDecisionComplete: true, recipeFreshAndEnabled: true, closedAs: 'VERIFIED_REMOVED', hasDistinctPathObservation: true },
  { reachedMatchConfirmed: true, policyDecisionComplete: true, recipeFreshAndEnabled: true, closedAs: 'VERIFIED_REMOVED', hasDistinctPathObservation: true },
  { reachedMatchConfirmed: true, policyDecisionComplete: true, recipeFreshAndEnabled: true, closedAs: 'VERIFIED_REMOVED', hasDistinctPathObservation: true },
  { reachedMatchConfirmed: true, policyDecisionComplete: true, recipeFreshAndEnabled: true, closedAs: 'ACKNOWLEDGED', hasDistinctPathObservation: false },
  { reachedMatchConfirmed: true, policyDecisionComplete: true, recipeFreshAndEnabled: true, closedAs: 'NOT_REMOVABLE', hasDistinctPathObservation: false },
  { reachedMatchConfirmed: true, policyDecisionComplete: true, recipeFreshAndEnabled: true, closedAs: 'HUMAN_REQUIRED', hasDistinctPathObservation: false },
  { reachedMatchConfirmed: true, policyDecisionComplete: true, recipeFreshAndEnabled: true, closedAs: 'SEARCH_DELISTED', hasDistinctPathObservation: false },
  // AND THREE THAT ARE NOT IN THE COHORT AT ALL: no policy decision, no fresh recipe, or never confirmed. They must not
  // appear in the denominator, and a metric that counted them would report a lower ratio for the same removals.
  { reachedMatchConfirmed: true, policyDecisionComplete: false, recipeFreshAndEnabled: true, closedAs: 'VERIFIED_REMOVED', hasDistinctPathObservation: true },
  { reachedMatchConfirmed: true, policyDecisionComplete: true, recipeFreshAndEnabled: false, closedAs: 'OPEN', hasDistinctPathObservation: false },
  { reachedMatchConfirmed: false, policyDecisionComplete: true, recipeFreshAndEnabled: true, closedAs: 'OPEN', hasDistinctPathObservation: false },
  // A removal observed through the ACTING path is a violation, not a numerator member (VG-VERIFY-001).
  { reachedMatchConfirmed: true, policyDecisionComplete: true, recipeFreshAndEnabled: true, closedAs: 'VERIFIED_REMOVED', hasDistinctPathObservation: false },
];

describe('the figure is recomputed independently from the raw events, and the exclusions are non-suppressed', () => {
  test('the ratio, the interval and the four components match an independent tally of the same workload', () => {
    const outcomes = tally(WORKLOAD);
    assert.equal(outcomes.eligibleConfirmedMatchDenominator, 8, 'the cohort excludes the three ineligible exposures');
    assert.equal(outcomes.verifiedRemovedNumerator, 3, 'the acting-path removal is not a numerator member');
    const metric = computeEffectivenessFigure(outcomes);
    assert.equal(metric.status, 'computed');
    assert.equal(metric.eligibleConfirmedMatchDenominator, 8);
    assert.equal(metric.verifiedRemovedNumerator, 3);
    assert.equal(metric.ratio, Number((3 / 8).toFixed(4)));
    assert.deepEqual(metric.confidenceInterval, wilsonFromFormula(3, 8));
    assert.deepEqual(metric.components, { numerator: 3, denominator: 8, excluded_not_removable: 1, excluded_human_required: 1 });
    // NON-SUPPRESSED: the exclusion components are present even though they are non-zero, and they are the tallied values
    // rather than a residual.
    assert.equal(metric.components.excluded_not_removable, outcomes.excludedNotRemovable);
    assert.equal(metric.components.excluded_human_required, outcomes.excludedHumanRequired);
    assert.equal(metric.excludedFromNumerator.acknowledged, 1);
    assert.equal(metric.excludedFromNumerator.searchDelisted, 1);
    assert.equal(metric.excludedFromNumerator.notRemovable, 1);
    assert.equal(metric.excludedFromNumerator.humanRequired, 1);
  });

  test('the exclusions are emitted even when they are ZERO, because a suppressed zero and a missing series look alike', () => {
    const metric = computeEffectivenessFigure(tally([{ reachedMatchConfirmed: true, policyDecisionComplete: true, recipeFreshAndEnabled: true, closedAs: 'VERIFIED_REMOVED', hasDistinctPathObservation: true }]));
    assert.equal(metric.components.excluded_not_removable, 0);
    assert.equal(metric.components.excluded_human_required, 0);
    assert.equal(Object.keys(metric.components).length, 4);
    assert.deepEqual([...EFFECTIVENESS_COMPONENTS], ['numerator', 'denominator', 'excluded_not_removable', 'excluded_human_required']);
  });
});

describe('the metric plane and the API use ONE computation and ONE denominator definition (§6.3, §13.3 item 9)', () => {
  test('the metric figure equals the API figure for every boundary, including a zero denominator', () => {
    for (const [numerator, denominator] of [[0, 0], [0, 10], [10, 10], [3, 7], [1, 3]] as const) {
      const outcomes: EffectivenessOutcomeSet = {
        eligibleConfirmedMatchDenominator: denominator,
        verifiedRemovedNumerator: numerator,
        excludedNotRemovable: 0,
        excludedHumanRequired: 0,
        acknowledged: 0,
        requestSubmitted: 0,
        searchDelisted: 0,
        ambiguous: 0,
      };
      const metric = computeEffectivenessFigure(outcomes);
      const api = figure(numerator, denominator);
      assert.equal(metric.ratio, api.ratio, `${String(numerator)}/${String(denominator)}: the two planes must not disagree`);
      assert.deepEqual(metric.confidenceInterval, api.confidenceInterval);
      assert.equal(metric.denominatorDefinedAs, api.denominatorDefinedAs);
      assert.equal(metric.denominatorDefinedAs, DENOMINATOR_DEFINED_AS, 'one definition, imported rather than restated');
    }
  });

  test('the metric module re-exports the API interval helper rather than re-implementing it', () => {
    // IMPORTED STATICALLY FOR A REASON WORTH RECORDING: the first version of this case used a dynamic import INSIDE a
    // non-async callback, and Node's type stripping rejected the file outright (ERR_INVALID_TYPESCRIPT_SYNTAX) — the
    // suite failed to load rather than failing a case, which is worth knowing about a runner that strips rather than
    // compiles.
    assert.equal(wilsonIntervalForMetric, wilson);
  });

  test('the ratio is null when the denominator is zero, never 0, and the series is reported as no_data with the denominator present', () => {
    const metric = computeEffectivenessFigure({ eligibleConfirmedMatchDenominator: 0, verifiedRemovedNumerator: 0, excludedNotRemovable: 2, excludedHumanRequired: 1, acknowledged: 0, requestSubmitted: 0, searchDelisted: 0, ambiguous: 0 });
    assert.equal(metric.status, 'no_data');
    assert.equal(metric.ratio, null, 'a bare 0 would read as "nothing was removed"');
    assert.equal(metric.confidenceInterval, null);
    assert.equal(metric.eligibleConfirmedMatchDenominator, 0, 'the denominator is present even when it is zero');
    assert.match(metric.noDataReason ?? '', /denominator is zero/);
    assert.match(metric.noDataReason ?? '', /MATCH_CONFIRMED/);
    // AND NOTHING IS DIVIDED BY ZERO ON THE WAY: a NaN ratio would serialise as null in JSON and hide the arithmetic.
    assert.equal(Number.isNaN(metric.ratio as unknown as number), false);
  });
});

describe('the emitted series carry the four components and the three interval values (§6.3)', () => {
  test('a computed figure emits four counter samples and three ratio samples, all with the declared labels', () => {
    const registry = createMetricsRegistry(catalogue);
    registry.register(EFFECTIVENESS_EVENTS_METRIC);
    registry.register(EFFECTIVENESS_RATIO_METRIC);
    const emission = emitEffectiveness(registry, LABELS, tally(WORKLOAD));
    assert.equal(emission.counterSamples, 4);
    assert.equal(emission.ratioSamples, 3);
    const counters = registry.samples().filter((sample) => sample.name === EFFECTIVENESS_EVENTS_METRIC);
    const ratios = registry.samples().filter((sample) => sample.name === EFFECTIVENESS_RATIO_METRIC);
    assert.deepEqual(counters.map((sample) => sample.labels['component']).sort(), [...EFFECTIVENESS_COMPONENTS].sort());
    assert.deepEqual(ratios.map((sample) => sample.labels['ci']).sort(), [...CONFIDENCE_INTERVAL_LABELS].sort());
    assert.equal(registry.value(EFFECTIVENESS_EVENTS_METRIC, { ...LABELS, component: 'denominator' }), 8);
    assert.equal(registry.value(EFFECTIVENESS_RATIO_METRIC, { ...LABELS, ci: 'point' }), Number((3 / 8).toFixed(4)));
    // THE INTERVAL BRACKETS THE POINT ESTIMATE, which is the property a reader assumes without checking.
    const lower = registry.value(EFFECTIVENESS_RATIO_METRIC, { ...LABELS, ci: 'lower' }) ?? 0;
    const upper = registry.value(EFFECTIVENESS_RATIO_METRIC, { ...LABELS, ci: 'upper' }) ?? 0;
    assert.ok(lower <= (emission.figure.ratio ?? 0) && (emission.figure.ratio ?? 0) <= upper, `${String(lower)} <= point <= ${String(upper)}`);
  });

  test('a no_data figure emits the four counters and NO ratio series at all', () => {
    const registry = createMetricsRegistry(catalogue);
    registry.register(EFFECTIVENESS_EVENTS_METRIC);
    registry.register(EFFECTIVENESS_RATIO_METRIC);
    const emission = emitEffectiveness(registry, LABELS, { eligibleConfirmedMatchDenominator: 0, verifiedRemovedNumerator: 0, excludedNotRemovable: 0, excludedHumanRequired: 0, acknowledged: 3, requestSubmitted: 1, searchDelisted: 0, ambiguous: 0 });
    assert.equal(emission.counterSamples, 4);
    assert.equal(emission.ratioSamples, 0);
    assert.equal(registry.samples().filter((sample) => sample.name === EFFECTIVENESS_RATIO_METRIC).length, 0, 'no ratio series may be published for an interval with no denominator');
    assert.equal(registry.value(EFFECTIVENESS_EVENTS_METRIC, { ...LABELS, component: 'denominator' }), 0);
  });

  test('the metric labels are exactly the §6.3 sets: four ci values and a component enum of four', () => {
    assert.deepEqual(catalogue.byName.get(EFFECTIVENESS_EVENTS_METRIC)?.labels, ['environment', 'tenant_class', 'source_class', 'window', 'component']);
    assert.deepEqual(catalogue.byName.get(EFFECTIVENESS_RATIO_METRIC)?.labels, ['environment', 'tenant_class', 'source_class', 'window', 'ci']);
    assert.deepEqual(catalogue.labelValueSets['component'], [...EFFECTIVENESS_COMPONENTS]);
    assert.deepEqual(catalogue.labelValueSets['ci'], [...CONFIDENCE_INTERVAL_LABELS]);
  });

  test('the API-only exclusions are NOT metric components, as §6.3 requires', () => {
    const components = catalogue.labelValueSets['component'] ?? [];
    for (const apiOnly of ['acknowledged', 'requestSubmitted', 'searchDelisted', 'ambiguous']) {
      assert.equal(components.includes(apiOnly), false, `${apiOnly} is an API response field and must not become a metric label value`);
    }
    // AND THE RESPONSE STILL DISCLOSES THEM, so nothing is lost by keeping them out of the series.
    const metric = computeEffectivenessFigure(tally(WORKLOAD));
    assert.equal(typeof metric.excludedFromNumerator.acknowledged, 'number');
    assert.equal(typeof metric.excludedFromNumerator.ambiguous, 'number');
  });
});

describe('a figure that cannot be true is refused rather than published (§6.3)', () => {
  test('a negative or fractional count is refused', () => {
    const base = tally(WORKLOAD);
    assert.throws(() => computeEffectivenessFigure({ ...base, verifiedRemovedNumerator: -1 }), RangeError);
    assert.throws(() => computeEffectivenessFigure({ ...base, eligibleConfirmedMatchDenominator: 2.5 }), RangeError);
    assert.throws(() => computeEffectivenessFigure({ ...base, excludedNotRemovable: Number.NaN }), RangeError);
  });

  test('a numerator larger than its denominator is refused: each exposure contributes at most once', () => {
    assert.throws(
      () => computeEffectivenessFigure({ eligibleConfirmedMatchDenominator: 2, verifiedRemovedNumerator: 3, excludedNotRemovable: 0, excludedHumanRequired: 0, acknowledged: 0, requestSubmitted: 0, searchDelisted: 0, ambiguous: 0 }),
      RangeError,
    );
  });
});
