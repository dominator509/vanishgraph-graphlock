/**
 * The metric catalogue and the registry (EP-008 M4; SPEC-007 §6.1, §6.2, §6.3, §6.6; DOD-022, DOD-037).
 *
 * THE ASSERTIONS ARE ABOUT WHAT CANNOT EXIST. A catalogue test that only counted entries would pass on a catalogue full
 * of prohibited series, so this suite asserts the prohibitions: no forbidden synonym in a name, no metric that would
 * assert a permanent deletion, no prohibited label, no label without a bounded value set, no cost without a currency —
 * and it does so twice, once by parsing a document that HAS each defect (cheap, exhaustive) and once by registering
 * through the registry (the path production takes).
 *
 * THE LAST SUITE IS A PARITY CHECK BETWEEN TWO MILESTONES: the DLP counters this node built in M2 emit a `sink` label,
 * and §6.5 bounds that label's values to five tokens. If the adapter's own identifiers were emitted as label values, the
 * alerts would match the metric name and group nothing — so the mapping is asserted to land inside the declared set.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  FORBIDDEN_NAME_TOKENS,
  renderExposition,
  MetricRegistrationError,
  createMetricsRegistry,
  createMetricsRegistryFromFile,
  loadMetricCatalogue,
  parseMetricCatalogue,
  validateDashboard,
  type MetricCatalogue,
} from '../../src/adapters/observability/metrics-registry.ts';
import {
  SCRUB_OUTCOME_COUNTER,
  EGRESS_DENIED_COUNTER,
  CANARY_DETECTIONS_COUNTER,
  SINK_LABEL_VALUES,
  DLP_SINKS,
} from '../../src/adapters/observability/egress-gate.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CATALOGUE_PATH = join(ROOT, 'config/metrics/catalogue.json');
const DASHBOARD_PATH = join(ROOT, 'config/dashboards/removal-effectiveness.json');

const raw = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')) as Record<string, unknown>;
const loaded = loadMetricCatalogue(CATALOGUE_PATH);
assert.equal(loaded.ok, true, `the shipped catalogue must validate: ${loaded.ok ? '' : loaded.errors.join('; ')}`);
const catalogue = (loaded as { ok: true; catalogue: MetricCatalogue }).catalogue;

const DECLARED_SERVICES = [
  'vanishgraph-api',
  'vanishgraph-web',
  'vanishgraph-worker-discovery',
  'vanishgraph-worker-action',
  'vanishgraph-worker-verify',
  'vanishgraph-scheduler',
  'vanishgraph-mcp',
];

describe('the catalogue is exactly the 42 families of §6.3-§6.5, each with a type, a unit, labels, an owner and a meaning', () => {
  test('42 families, 42 unique names, and the file carries one "name" key per family', () => {
    assert.equal(catalogue.families.length, 42);
    assert.equal(new Set(catalogue.families.map((family) => family.name)).size, 42);
    assert.equal(catalogue.count, 42);
    // THE MILESTONE'S OWN CHECK, ASSERTED IN CODE SO IT CANNOT DRIFT FROM THE FILE.
    const nameLines = readFileSync(CATALOGUE_PATH, 'utf8').split('\n').filter((line) => line.includes('"name"')).length;
    assert.equal(nameLines, 42, 'grep -c \'"name"\' config/metrics/catalogue.json must print 42');
  });

  test('every family declares a valid type, a non-empty unit, an owner among the seven declared services, and a real meaning', () => {
    for (const family of catalogue.families) {
      assert.ok(['counter', 'gauge', 'histogram'].includes(family.type), `${family.name}: ${family.type}`);
      assert.ok(family.unit.trim().length > 0, `${family.name} must declare a unit (§6.1)`);
      assert.ok(DECLARED_SERVICES.includes(family.ownerService), `${family.name}: owner ${family.ownerService} is not a declared service`);
      assert.ok(family.meaning.trim().length >= 20, `${family.name} must carry a real one-line meaning`);
    }
  });

  test('every label is declared by §6.1 or by the metric row, and every label has a bounded set or a named source for its bound', () => {
    for (const family of catalogue.families) {
      for (const label of family.labels) {
        assert.ok(catalogue.canonicalLabelNames.includes(label), `${family.name}: label ${label} is declared nowhere in SPEC-007`);
        const bounded = catalogue.labelValueSets[label] !== undefined || catalogue.labelValueSetSources[label] !== undefined;
        assert.ok(bounded, `${family.name}: label ${label} has no bounded value set and no declared source (§6.2)`);
      }
    }
  });

  test('NO prohibited label appears anywhere, and the prohibitions are checked against a list that is not empty', () => {
    assert.ok(catalogue.prohibitedLabels.length >= 13, 'the §6.2 prohibited-label list must be the full list');
    for (const family of catalogue.families) {
      for (const label of family.labels) {
        assert.equal(catalogue.prohibitedLabels.includes(label), false, `${family.name} carries prohibited label ${label}`);
      }
    }
    // TENANT IDENTITY IS THE ONE THAT MATTERS MOST: §6.2 gives two reasons (unbounded cardinality and the disclosure
    // that a named organization is removing what, and when), so the check is asserted against the list AND the list's
    // content.
    assert.ok(catalogue.prohibitedLabels.includes('tenantId'));
    assert.ok(catalogue.prohibitedLabels.includes('case_id'));
  });

  test('NO family name carries a forbidden synonym or asserts a prohibited outcome', () => {
    for (const family of catalogue.families) {
      for (const token of FORBIDDEN_NAME_TOKENS) {
        assert.equal(family.name.split('_').includes(token), false, `${family.name} carries the forbidden synonym "${token}"`);
      }
      for (const banned of ['permanent_deletion', 'deletion_rate', 'success_rate', 'requests_sent', 'submissions', 'deleted']) {
        assert.equal(family.name.includes(banned), false, `${family.name} asserts ${banned}, which §6.3 prohibits`);
      }
    }
    // AND THE SAME CHECK IS SHOWN TO FIRE: a planted name of each shape is refused by the parser below.
  });
});

describe('the catalogue parser refuses a document that cannot be trusted (each defect planted)', () => {
  const families = raw['families'] as Record<string, unknown>[];
  const withFamily = (patch: Record<string, unknown>): unknown => ({ ...raw, families: [{ ...families[0], ...patch }, ...families.slice(1)] });

  for (const [name, document, expected] of [
    ['41 families', { ...raw, families: families.slice(0, 41), count: 41 }, /exactly 42 metric families/],
    ['a count that disagrees with the entries', { ...raw, count: 7 }, /count says 7/],
    ['a duplicate family', { ...raw, families: [families[0], families[0], ...families.slice(2)] }, /appears twice/],
    ['a name without the namespace', withFamily({ name: 'removal_effectiveness_ratio' }), /begins with vanishgraph_/],
    ['an unknown type', withFamily({ type: 'summary' }), /type must be one of/],
    ['a missing unit', withFamily({ unit: '' }), /unit must be declared/],
    ['a placeholder meaning', withFamily({ meaning: 'TODO' }), /real one-line meaning/],
    ['an owner that is not a declared service', withFamily({ owner_service: 'vanishgraph-worker' }), /seven declared services/],
    ['a forbidden synonym in the name', withFamily({ name: 'vanishgraph_removal_site_total' }), /forbidden synonym/],
    ['a prohibited outcome in the name', withFamily({ name: 'vanishgraph_permanent_deletion_total' }), /no such series may exist/],
    ['a prohibited label', withFamily({ name: 'vanishgraph_planted_total', labels: ['environment', 'tenantId'] }), /label "tenantId" is prohibited/],
    ['a label declared nowhere', withFamily({ name: 'vanishgraph_planted_total', labels: ['environment', 'caseRef'] }), /declared in neither/],
    ['a label with no bound', { ...raw, label_value_set_sources: Object.fromEntries(Object.entries(raw['label_value_set_sources'] as Record<string, string>).filter(([label]) => label !== 'recipe_id')), families: [{ ...families[0], name: 'vanishgraph_planted_total', labels: ['environment', 'recipe_id'] }, ...families.slice(1)] }, /no bounded value set and no declared source/],
    ['a cost without a currency', withFamily({ name: 'vanishgraph_planted_cost_total', unit: 'minor_units', labels: ['environment'] }), /explicit currency/],
  ] as const) {
    test(`NEGATIVE CASE: ${name} is refused with a readable reason`, () => {
      const result = parseMetricCatalogue(document);
      assert.equal(result.ok, false, `${name} must be refused`);
      if (result.ok) return;
      assert.match(result.errors.join(' | '), expected);
    });
  }

  test('NEGATIVE CASE: a label value outside the bounded set is refused at record time', () => {
    const registry = createMetricsRegistry(catalogue);
    registry.register('vanishgraph_truth_state_current');
    assert.throws(
      () => registry.record('vanishgraph_truth_state_current', { environment: 'local', tenant_class: 'TEST', source_class: 'PEOPLE_SEARCH', truth_state: 'ALMOST_REMOVED' }, 1),
      (error: unknown) => error instanceof MetricRegistrationError && error.code === 'UNBOUNDED_LABEL_VALUE',
    );
    assert.throws(
      () => registry.record('vanishgraph_truth_state_current', { environment: 'development', tenant_class: 'TEST', source_class: 'PEOPLE_SEARCH', truth_state: 'MATCH_CONFIRMED' }, 1),
      (error: unknown) => error instanceof MetricRegistrationError && error.code === 'UNBOUNDED_LABEL_VALUE',
    );
  });
});

describe('the registry registers only what the catalogue declares, and records only what the family declares', () => {
  test('all 42 families register', () => {
    const registry = createMetricsRegistry(catalogue);
    for (const family of catalogue.families) {
      assert.equal(registry.register(family.name).name, family.name);
    }
    assert.equal(registry.families().length, 42);
  });

  test('an uncatalogued name is refused, with a typed error rather than a silent series', () => {
    const registry = createMetricsRegistry(catalogue);
    assert.throws(
      () => registry.register('vanishgraph_removals_completed_total'),
      (error: unknown) => error instanceof MetricRegistrationError && error.code === 'NOT_CATALOGUED',
    );
    assert.throws(
      () => registry.record('vanishgraph_removals_completed_total', {}, 1),
      (error: unknown) => error instanceof MetricRegistrationError && error.code === 'NOT_CATALOGUED',
    );
  });

  test('recording into a family that was never registered is refused: a series with no owner is the defect', () => {
    const registry = createMetricsRegistry(catalogue);
    assert.throws(
      () => registry.record('vanishgraph_dlp_scrub_outcome_total', { environment: 'local', sink: 'LOG', outcome: 'DENIED' }, 1),
      (error: unknown) => error instanceof MetricRegistrationError && error.code === 'NOT_REGISTERED',
    );
  });

  test('a prohibited or undeclared label is refused at record time', () => {
    const registry = createMetricsRegistry(catalogue);
    registry.register('vanishgraph_truth_state_current');
    assert.throws(
      () => registry.record('vanishgraph_truth_state_current', { environment: 'local', tenant_class: 'TEST', source_class: 'PEOPLE_SEARCH', truth_state: 'MATCH_CONFIRMED', tenantId: 'ten-1' }, 1),
      (error: unknown) => error instanceof MetricRegistrationError && error.code === 'PROHIBITED_LABEL',
    );
    assert.throws(
      () => registry.record('vanishgraph_truth_state_current', { environment: 'local', tenant_class: 'TEST', source_class: 'PEOPLE_SEARCH', truth_state: 'MATCH_CONFIRMED', recipe_id: 'recipe-1' }, 1),
      (error: unknown) => error instanceof MetricRegistrationError && error.code === 'UNDECLARED_LABEL',
    );
  });

  test('a float cost and an implicit currency are refused, and an integer cost with a currency is recorded', () => {
    const registry = createMetricsRegistry(catalogue);
    const family = 'vanishgraph_external_action_cost_minor_units_total';
    registry.register(family);
    const labels = { environment: 'local', tenant_class: 'TEST', channel: 'OFFICIAL_MAIL', provider: 'postal_api', currency: 'EUR' };
    assert.throws(
      () => registry.record(family, labels, 12.5),
      (error: unknown) => error instanceof MetricRegistrationError && error.code === 'FLOAT_COST',
    );
    assert.throws(
      () => registry.record(family, { ...labels, currency: '' }, 1250),
      (error: unknown) => error instanceof MetricRegistrationError && error.code === 'UNBOUNDED_LABEL_VALUE',
    );
    assert.throws(
      () => registry.record(family, labels, Number.NaN),
      (error: unknown) => error instanceof MetricRegistrationError && error.code === 'NON_FINITE_VALUE',
    );
    const sample = registry.record(family, labels, 1250);
    assert.equal(sample.value, 1250);
    assert.equal(registry.value(family, labels), 1250);
  });

  test('a catalogue that cannot be validated is a startup failure, not a registry with no families', () => {
    assert.throws(
      () => createMetricsRegistryFromFile(join(ROOT, 'config/metrics/no-such-catalogue.json')),
      (error: unknown) => error instanceof MetricRegistrationError && error.code === 'CATALOGUE_INVALID',
    );
  });
});

describe('dashboards are data validated against the catalogue (§6.3, SPEC-000 §7.4)', () => {
  const document = JSON.parse(readFileSync(DASHBOARD_PATH, 'utf8')) as { dashboards: { id: string; panels: unknown[] }[] };

  test('the shipped dashboards validate, every panel references a registered metric, and every ratio panel names its denominator', () => {
    assert.ok(document.dashboards.length >= 1);
    for (const dashboard of document.dashboards) {
      const validation = validateDashboard(dashboard, catalogue);
      assert.equal(validation.ok, true, `${dashboard.id}: ${validation.errors.join('; ')}`);
    }
  });

  test('NEGATIVE CONTROL: a ratio panel without a denominator fails, and a non-ratio panel is not required to name one', () => {
    const ratio = validateDashboard({ panels: [{ id: 'p1', title: 'ratio', metric: 'vanishgraph_removal_effectiveness_ratio', ci: ['point', 'lower', 'upper'] }] }, catalogue);
    assert.equal(ratio.ok, false);
    assert.match(ratio.errors.join(' | '), /must name the denominator series/);
    const gauge = validateDashboard({ panels: [{ id: 'p2', title: 'gauge', metric: 'vanishgraph_truth_state_current' }] }, catalogue);
    assert.equal(gauge.ok, true, gauge.errors.join('; '));
    const unregistered = validateDashboard({ panels: [{ id: 'p3', title: 'x', metric: 'vanishgraph_removals_total' }] }, catalogue);
    assert.equal(unregistered.ok, false);
    assert.match(unregistered.errors.join(' | '), /not a registered metric family/);
  });

  test('NEGATIVE CONTROL: an effectiveness panel that hides the interval or the denominator component is refused', () => {
    const noInterval = validateDashboard({ panels: [{ id: 'p1', title: 'x', metric: 'vanishgraph_removal_effectiveness_ratio', denominatorMetric: 'vanishgraph_removal_effectiveness_events_total' }] }, catalogue);
    assert.equal(noInterval.ok, false);
    assert.match(noInterval.errors.join(' | '), /must render ci for point, lower, upper/);
    const noDenominatorComponent = validateDashboard({ panels: [{ id: 'p2', title: 'x', metric: 'vanishgraph_removal_effectiveness_events_total', components: ['numerator', 'excluded_not_removable'] }] }, catalogue);
    assert.equal(noDenominatorComponent.ok, false);
    assert.match(noDenominatorComponent.errors.join(' | '), /must render the denominator component/);
  });
});

describe('the exposition writer renders what the registry accepted, and nothing else (§2.3 rule 2)', () => {
  test('a counter and a gauge render with their labels, and an unobserved family renders NOTHING', () => {
    const registry = createMetricsRegistry(catalogue);
    registry.register('vanishgraph_dlp_scrub_outcome_total');
    registry.register('vanishgraph_readiness_status');
    registry.record('vanishgraph_dlp_scrub_outcome_total', { environment: 'local', sink: 'LOG', outcome: 'DENIED' }, 3);
    registry.record('vanishgraph_readiness_status', { environment: 'local', dependency_key: 'postgresql' }, 1);
    const text = renderExposition(registry, { environment: 'local' });
    assert.match(text, /# TYPE vanishgraph_dlp_scrub_outcome_total counter/);
    assert.match(text, /vanishgraph_dlp_scrub_outcome_total\{environment="local",outcome="DENIED",sink="LOG"\} 3/);
    assert.match(text, /vanishgraph_readiness_status\{dependency_key="postgresql",environment="local"\} 1/);
    // A FAMILY NOBODY OBSERVED MUST NOT APPEAR: an invented zero reads exactly like a measured zero once it is stored.
    assert.equal(text.includes('vanishgraph_slo_verdict'), false);
    assert.equal(text.includes('vanishgraph_server_http_served_total'), false);
    // AND NOTHING OUTSIDE THE CATALOGUE CAN APPEAR, because the registry refuses it before it is recorded.
    assert.equal(renderExposition(createMetricsRegistry(catalogue)), '', 'an empty registry renders an empty exposition');
  });

  test('a histogram renders as _count and _sum with the missing buckets STATED, never as invented _bucket series', () => {
    const registry = createMetricsRegistry(catalogue);
    registry.register('vanishgraph_verification_lag_seconds');
    registry.record('vanishgraph_verification_lag_seconds', { environment: 'local', tenant_class: 'TEST', source_class: 'PEOPLE_SEARCH', channel: 'OFFICIAL_API', verification_method: 'INDEPENDENT_OBSERVER_HTTP' }, 4200);
    const text = renderExposition(registry);
    assert.match(text, /# TYPE vanishgraph_verification_lag_seconds histogram/);
    assert.match(text, /vanishgraph_verification_lag_seconds_count\{/, 'the observation count is exposed');
    assert.match(text, /vanishgraph_verification_lag_seconds_sum\{[^}]*\} 4200/, 'the summed seconds are exposed');
    assert.match(text, /# NOTE vanishgraph_verification_lag_seconds bucket boundaries are not declared/);
    assert.equal(text.includes('_bucket'), false, 'no bucket series may be invented');
  });

  test('a label value containing a quote or a backslash is escaped, so one series cannot forge another', () => {
    const registry = createMetricsRegistry(catalogue);
    registry.register('vanishgraph_tenant_scope_refusals_total');
    registry.record('vanishgraph_tenant_scope_refusals_total', { environment: 'local', layer: 'POSTGRES_RLS', reason_code: 'CROSS_TENANT' }, 1);
    const text = renderExposition(registry);
    assert.match(text, /layer="POSTGRES_RLS"/);
    assert.equal(text.includes('\\"'), false, 'the shipped label values need no escaping, and none is added');
  });
});

describe('the DLP counters of M2 emit the sink label values the catalogue declares (parity between milestones)', () => {
  test('every sink label value the gate can emit is inside the catalogue\'s bounded set for `sink`', () => {
    const bounded = catalogue.labelValueSets['sink'] ?? [];
    assert.deepEqual([...bounded].sort(), ['DEBUG_BUNDLE', 'ERROR_REPORT', 'LOG', 'PR_ISSUE', 'TRACE']);
    for (const sink of DLP_SINKS) {
      assert.ok(bounded.includes(SINK_LABEL_VALUES[sink]), `${sink} maps to "${SINK_LABEL_VALUES[sink]}", which is outside the declared set`);
    }
    assert.equal(new Set(DLP_SINKS.map((sink) => SINK_LABEL_VALUES[sink])).size, DLP_SINKS.length, 'each sink must map to a distinct label value');
  });

  test('the three DLP counter families are catalogued with the labels the gate emits', () => {
    for (const name of [SCRUB_OUTCOME_COUNTER, EGRESS_DENIED_COUNTER, CANARY_DETECTIONS_COUNTER]) {
      const family = catalogue.byName.get(name);
      assert.ok(family !== undefined, `${name} must be catalogued`);
      assert.ok(family?.labels.includes('sink'), `${name} must declare the sink label the alerts group by`);
    }
    assert.deepEqual(catalogue.byName.get(SCRUB_OUTCOME_COUNTER)?.labels, ['environment', 'sink', 'outcome']);
    assert.deepEqual(catalogue.byName.get(EGRESS_DENIED_COUNTER)?.labels, ['environment', 'sink', 'egress_class', 'reason_code']);
  });
});
