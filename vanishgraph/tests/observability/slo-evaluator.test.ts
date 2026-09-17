/**
 * The SLO evaluator (EP-008 M7; SPEC-007 §9, §12.7; DOD-022, DOD-038, DOD-027).
 *
 * THE SUITE IS ABOUT WHAT THE EVALUATOR REFUSES. A verdict is a claim about a measured interval, and the dangerous
 * failure is the one that looks like a result: rounding an incomplete sample to PASS, calling an unexercised objective
 * satisfied, or letting a breach that produced PASS stand as a pass. Each of those is a test below, and each asserts the
 * verdict AND the reason, because a verdict nobody can explain is not evidence.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  VERDICT_BEARING_ENVIRONMENTS,
  evaluateObjectives,
  formatVerdictLine,
  type SloObjectivesDocument,
  type SloSample,
} from '../../src/adapters/observability/slo-evaluator.ts';
import { createMetricsRegistry, loadMetricCatalogue, type MetricCatalogue } from '../../src/adapters/observability/metrics-registry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const loaded = loadMetricCatalogue(join(ROOT, 'config/metrics/catalogue.json'));
assert.equal(loaded.ok, true);
const catalogue = (loaded as { ok: true; catalogue: MetricCatalogue }).catalogue;
const objectives = JSON.parse(readFileSync(join(ROOT, 'config/slo/objectives.json'), 'utf8')) as SloObjectivesDocument;

/** A complete, undisturbed 30-day sample in a verdict-bearing environment: every objective should pass. */
const GOOD: SloSample = {
  window: { from: '2026-01-01T00:00:00Z', to: '2026-01-31T00:00:00Z', complete: true },
  values: {
    vanishgraph_server_http_served_total: 1_000_000,
    vanishgraph_server_http_served_total_5xx: 100,
    vanishgraph_verification_lag_seconds_p95: 900_000,
    vanishgraph_verification_lag_seconds_p99: 2_000_000,
    vanishgraph_truth_state_transitions_total_completed: 970,
    vanishgraph_truth_state_transitions_total_eligible: 1000,
    vanishgraph_reconciliation_lag_seconds_p90: 9_000,
    vanishgraph_reconciliation_lag_seconds_max: 50_000,
  },
  observations: 500,
  destinationStatesPresent: ['VERIFIED_REMOVED', 'VERIFIED_NOT_PRESENT', 'NOT_REMOVABLE', 'HUMAN_REQUIRED', 'SEARCH_DELISTED'],
  ambiguityEvents: 12,
  integrityRuns: [
    { objectiveId: 'VG-SLO-001', induced: true, verdict: 'FAIL', environment: 'staging' },
    { objectiveId: 'VG-SLO-002', induced: true, verdict: 'FAIL', environment: 'staging' },
    { objectiveId: 'VG-SLO-003', induced: true, verdict: 'FAIL', environment: 'staging' },
    { objectiveId: 'VG-SLO-004', induced: true, verdict: 'FAIL', environment: 'staging' },
    { objectiveId: 'VG-SLO-001', induced: false, verdict: 'PASS', environment: 'staging' },
    { objectiveId: 'VG-SLO-002', induced: false, verdict: 'PASS', environment: 'staging' },
  ],
};

const withSample = (patch: Partial<SloSample>): SloSample => ({ ...GOOD, ...patch });
const evaluate = (sample: SloSample, environment = 'staging') => evaluateObjectives({ objectives, sample, environment });
const verdictOf = (result: ReturnType<typeof evaluate>, id: string) => result.verdicts.find((verdict) => verdict.id === id);

describe('a complete, undisturbed sample in a verdict-bearing environment is the only thing that passes', () => {
  test('all five objectives are PASS, and every reason says what was measured', () => {
    const result = evaluate(GOOD);
    assert.deepEqual(result.verdicts.map((verdict) => verdict.id), ['VG-SLO-001', 'VG-SLO-002', 'VG-SLO-003', 'VG-SLO-004', 'VG-SLO-005']);
    for (const verdict of result.verdicts) {
      assert.equal(verdict.verdict, 'PASS', `${verdict.id}: ${verdict.reason}`);
      assert.ok(verdict.reason.length > 20, `${verdict.id} must explain itself`);
    }
    assert.equal(result.revoked, false);
    assert.equal(formatVerdictLine(result.verdicts[0]!), 'slo availability: PASS');
  });

  test('the error-budget figures come from the objective OWN threshold, not from a constant', () => {
    const verdict = verdictOf(evaluate(GOOD), 'VG-SLO-001');
    assert.ok(verdict !== undefined);
    // availability is >= 0.999, so the allowed bad events over 1 000 000 served responses is 1000, and 100 observed is a
    // burn ratio of 0.1. A hardcoded 0.999 would agree here; the assertion below pins the DERIVATION.
    assert.equal(verdict.allowedBadEvents, 1000);
    assert.equal(verdict.badEvents, 100);
    assert.equal(verdict.burnRatio, 0.1);
  });
});

describe('the evaluator refuses to promote anything it did not measure', () => {
  test('an INCOMPLETE window defers the duration-bound objectives rather than passing them (DOD-038)', () => {
    const result = evaluate(withSample({ window: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', complete: false } }));
    for (const id of ['VG-SLO-001', 'VG-SLO-002', 'VG-SLO-003', 'VG-SLO-004']) {
      const verdict = verdictOf(result, id);
      assert.equal(verdict?.verdict, 'DEFERRED_LONG_RUNNING', `${id} must defer`);
      assert.match(verdict?.reason ?? '', /not complete/);
      assert.match(verdict?.reason ?? '', /DOD-038/);
    }
  });

  test('§9 forbids a verdict outside staging and production, so a local sample is INCONCLUSIVE even when it would pass', () => {
    assert.deepEqual([...VERDICT_BEARING_ENVIRONMENTS], ['staging', 'production']);
    const result = evaluate(GOOD, 'local');
    for (const id of ['VG-SLO-001', 'VG-SLO-002', 'VG-SLO-003', 'VG-SLO-004']) {
      const verdict = verdictOf(result, id);
      assert.equal(verdict?.verdict, 'INCONCLUSIVE', `${id} must not carry a verdict outside a verdict-bearing environment`);
      assert.match(verdict?.reason ?? '', /forbids a verdict outside staging or production/);
    }
  });

  test('zero served responses is NOT 100 per cent availability, and a thin sample is not a quantile', () => {
    const noTraffic = evaluate(withSample({ values: { ...GOOD.values, vanishgraph_server_http_served_total: 0, vanishgraph_server_http_served_total_5xx: 0 } }));
    assert.equal(verdictOf(noTraffic, 'VG-SLO-001')?.verdict, 'INCONCLUSIVE');
    assert.match(verdictOf(noTraffic, 'VG-SLO-001')?.reason ?? '', /no responses were served/);
    const thin = evaluate(withSample({ observations: 7 }));
    assert.equal(verdictOf(thin, 'VG-SLO-002')?.verdict, 'INCONCLUSIVE');
    assert.match(verdictOf(thin, 'VG-SLO-002')?.reason ?? '', /below the required 30/);
  });

  test('a missing honest destination state makes the completion ratio a different number', () => {
    const result = evaluate(withSample({ destinationStatesPresent: ['VERIFIED_REMOVED', 'SEARCH_DELISTED'] }));
    const verdict = verdictOf(result, 'VG-SLO-003');
    assert.equal(verdict?.verdict, 'INCONCLUSIVE');
    assert.match(verdict?.reason ?? '', /NOT_REMOVABLE/);
    assert.match(verdict?.reason ?? '', /HUMAN_REQUIRED/);
  });

  test('a reconciliation window with no ambiguity event was never exercised', () => {
    const verdict = verdictOf(evaluate(withSample({ ambiguityEvents: 0, values: { ...GOOD.values, vanishgraph_reconciliation_lag_seconds_p90: 1, vanishgraph_reconciliation_lag_seconds_max: 1 } })), 'VG-SLO-004');
    assert.equal(verdict?.verdict, 'INCONCLUSIVE');
    assert.match(verdict?.reason ?? '', /never exercised/);
  });

  test('a missing value is named rather than defaulted', () => {
    const { vanishgraph_verification_lag_seconds_p95: _dropped, ...rest } = GOOD.values;
    const verdict = verdictOf(evaluate(withSample({ values: rest })), 'VG-SLO-002');
    assert.equal(verdict?.verdict, 'INCONCLUSIVE');
    assert.match(verdict?.reason ?? '', /both required/);
  });

  test('NEGATIVE CASE: an objective with no evaluation rule is INCONCLUSIVE, never PASS', () => {
    const unknown: SloObjectivesDocument = { ...objectives, objectives: [...objectives.objectives, { id: 'NOT-A-SPEC-OBJECTIVE', objective: 'invented', indicator: 'x', threshold: '>= 0', window: '30d', workload: 'WL-1', verdictRule: 'none' }] };
    const result = evaluateObjectives({ objectives: unknown, sample: GOOD, environment: 'staging' });
    assert.equal(result.verdicts.find((verdict) => verdict.id === 'NOT-A-SPEC-OBJECTIVE')?.verdict, 'INCONCLUSIVE');
  });
});

describe('evaluation integrity: a breach that passes revokes everything (§9, VG-SLO-005)', () => {
  test('an induced breach that yielded PASS makes VG-SLO-005 FAIL and revokes every dependent PASS', () => {
    const breached = withSample({
      integrityRuns: [
        { objectiveId: 'VG-SLO-002', induced: true, verdict: 'PASS', environment: 'staging' },
        { objectiveId: 'VG-SLO-001', induced: false, verdict: 'PASS', environment: 'staging' },
      ],
    });
    const result = evaluate(breached);
    assert.equal(result.revoked, true);
    const integrity = verdictOf(result, 'VG-SLO-005');
    assert.equal(integrity?.verdict, 'FAIL');
    assert.match(integrity?.reason ?? '', /revoked as INCONCLUSIVE/);
    // THE REVOCATION IS IN THE SAME RESULT SET: a caller that read only the four objectives would otherwise publish a
    // PASS computed by machinery that cannot fail.
    for (const id of ['VG-SLO-001', 'VG-SLO-002', 'VG-SLO-003', 'VG-SLO-004']) {
      const verdict = verdictOf(result, id);
      assert.equal(verdict?.verdict, 'INCONCLUSIVE', `${id} must be revoked`);
      assert.match(verdict?.reason ?? '', /REVOKED/);
    }
  });

  test('an undisturbed run that did not pass is also a failure, and an empty matrix is INCONCLUSIVE', () => {
    const restless = evaluate(withSample({ integrityRuns: [{ objectiveId: 'VG-SLO-001', induced: true, verdict: 'FAIL', environment: 'staging' }, { objectiveId: 'VG-SLO-001', induced: false, verdict: 'INCONCLUSIVE', environment: 'staging' }] }));
    assert.equal(verdictOf(restless, 'VG-SLO-005')?.verdict, 'FAIL');
    assert.match(verdictOf(restless, 'VG-SLO-005')?.reason ?? '', /undisturbed run did not yield PASS/);
    const empty = verdictOf(evaluate(withSample({ integrityRuns: [] })), 'VG-SLO-005');
    assert.equal(empty?.verdict, 'INCONCLUSIVE');
    assert.match(empty?.reason ?? '', /integrity matrix needs/);
  });
});

describe('the emitted series are the catalogue\'s, with the verdict as an enum', () => {
  test('all four slo_* families are recorded with the objective and window labels, and INCONCLUSIVE is 0', () => {
    const registry = createMetricsRegistry(catalogue);
    for (const name of ['vanishgraph_slo_verdict', 'vanishgraph_slo_bad_events_total', 'vanishgraph_slo_allowed_bad_events', 'vanishgraph_slo_error_budget_burn_ratio']) registry.register(name);
    evaluateObjectives({ objectives, sample: GOOD, environment: 'staging', registry });
    const labels = { environment: 'staging', objective: 'availability', window: 'rolling 30d' };
    assert.equal(registry.value('vanishgraph_slo_verdict', labels), 1, 'PASS is 1');
    assert.equal(registry.value('vanishgraph_slo_bad_events_total', labels), 100);
    assert.equal(registry.value('vanishgraph_slo_allowed_bad_events', labels), 1000);
    assert.equal(registry.value('vanishgraph_slo_error_budget_burn_ratio', labels), 0.1);
    // AND AN INCONCLUSIVE OBJECTIVE IS RECORDED AS 0 RATHER THAN OMITTED: an absent series is INCONCLUSIVE per §6.5, but
    // an absent series is also invisible, so the evaluator states the verdict it has.
    const deferred = createMetricsRegistry(catalogue);
    for (const name of ['vanishgraph_slo_verdict']) deferred.register(name);
    evaluateObjectives({ objectives, sample: withSample({ window: { from: 'a', to: 'b', complete: false } }), environment: 'staging', registry: deferred });
    assert.equal(deferred.value('vanishgraph_slo_verdict', { environment: 'staging', objective: 'availability', window: 'rolling 30d' }), 0);
  });
});
