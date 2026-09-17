/**
 * The alert catalogue as a contract (SPEC-007 §8, §12.6; EP-008 M6; DOD-037).
 *
 * THIS SUITE AND `scripts/alert-catalogue-guard.sh` CHECK THE SAME INVARIANTS ON PURPOSE, AND THE DUPLICATION IS STATED
 * RATHER THAN HIDDEN: the guard is the STAGE — it runs on its own, prints a sentinel and writes its own evidence — and
 * this suite is the PERMANENT REGRESSION NET that runs in the unit stage on every change. The guard's check lives inside
 * a script written to an evidence directory, so it cannot be imported; re-deriving the invariants here is the price of
 * having both, and any rule added to one must be added to the other.
 *
 * EVERY RULE BELOW IS ASSERTED TWICE: once against the SHIPPED catalogue, and once against a DOCUMENT THAT HAS THE
 * DEFECT, because a rule that never refuses anything is not a rule. That is the same standard the metric catalogue suite
 * applies, and it is what makes the negative controls below worth reading.
 *
 * WHAT THIS SUITE DOES NOT CLAIM: no alert has been demonstrated firing, and none has been demonstrated resolving. §8
 * requires exactly that proof and it needs an expression evaluator and a series store, neither of which exists in this
 * repository. The last test asserts that the catalogue says so in its own data, so the absence cannot be quietly
 * forgotten.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadMetricCatalogue, type MetricCatalogue } from '../../src/adapters/observability/metrics-registry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CATALOGUE_PATH = join(ROOT, 'config/alerts/catalogue.json');

interface AlertRow {
  readonly id: string;
  readonly name: string;
  readonly expr: string;
  readonly threshold: string;
  readonly for: string;
  readonly severity: 'critical' | 'warning';
  readonly routing: string;
  readonly runbook: string;
}

interface AlertCatalogue {
  readonly alerts: readonly AlertRow[];
  readonly required_critical_set: readonly string[];
  readonly routing_lanes: Readonly<Record<string, string>>;
  readonly coverage_rule_1_conflicts: { readonly ids_marked_warning_by_the_table_but_required_critical_by_rule_1: readonly string[] };
}

const catalogue = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8')) as AlertCatalogue;
const loaded = loadMetricCatalogue(join(ROOT, 'config/metrics/catalogue.json'));
assert.equal(loaded.ok, true);
const metrics = (loaded as { ok: true; catalogue: MetricCatalogue }).catalogue;

/** The ids §8 declares, in the order it declares them. */
const DECLARED_IDS = [
  'A-01', 'A-01b', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06', 'A-06b', 'A-06c', 'A-07',
  'A-07b', 'A-08', 'A-09', 'A-09b', 'A-10', 'A-11', 'A-12', 'A-13', 'A-14', 'A-15',
];
const LANES = ['page', 'page-security', 'ticket', 'advisory'];
const PLACEHOLDER = /^(|tbd|todo|tba|n\/?a|placeholder|xxx+|-\?*)$/i;
const SUCCESS_VOCABULARY = /(removal confirmed|success rate|successful removal|all clear|good news|celebrat)/i;
const COMPARATOR = /[><=]|absent\(/;

/** The invariants, as one function over a document, so a mutated document can be put through exactly the same rules. */
function violations(document: AlertCatalogue): string[] {
  const problems: string[] = [];
  const alerts = document.alerts ?? [];
  if (alerts.length !== 20) problems.push(`expected 20 rows and found ${String(alerts.length)}`);
  const ids = alerts.map((alert) => alert.id);
  for (const id of DECLARED_IDS) if (!ids.includes(id)) problems.push(`${id} is declared and missing`);
  for (const id of ids) if (!DECLARED_IDS.includes(id)) problems.push(`${id} is not a declared alert`);
  if (new Set(ids).size !== ids.length) problems.push('two rows share an id');
  for (const alert of alerts) {
    for (const field of ['id', 'name', 'expr', 'threshold', 'for', 'severity', 'routing', 'runbook'] as const) {
      const value = alert[field];
      if (typeof value !== 'string' || PLACEHOLDER.test(value.trim())) problems.push(`${alert.id}: ${field} is missing or a placeholder`);
    }
    if (!LANES.includes(alert.routing)) problems.push(`${alert.id}: routing ${alert.routing} is not a declared lane`);
    if (!['critical', 'warning'].includes(alert.severity)) problems.push(`${alert.id}: severity ${alert.severity} is not critical or warning`);
    // A FIRING CONDITION MAY LIVE IN EITHER COLUMN, because §8's table puts eight of them in the threshold column.
    if (!COMPARATOR.test(alert.expr) && !COMPARATOR.test(alert.threshold)) problems.push(`${alert.id}: no firing condition is stated`);
    if (SUCCESS_VOCABULARY.test(alert.name) || SUCCESS_VOCABULARY.test(alert.expr)) problems.push(`${alert.id}: success vocabulary`);
    for (const name of alert.expr.match(/vanishgraph_[a-z0-9_]+/g) ?? []) {
      const base = name.replace(/_(bucket|sum|count)$/, '');
      if (!metrics.byName.has(name) && !metrics.byName.has(base)) problems.push(`${alert.id}: unregistered metric ${name}`);
    }
    const path = join(ROOT, alert.runbook);
    if (!existsSync(path)) problems.push(`${alert.id}: runbook ${alert.runbook} does not exist`);
    else if (statSync(path).size < 500) problems.push(`${alert.id}: runbook ${alert.runbook} is effectively empty`);
  }
  const recorded = document.coverage_rule_1_conflicts?.ids_marked_warning_by_the_table_but_required_critical_by_rule_1 ?? [];
  for (const id of document.required_critical_set ?? []) {
    if (!ids.includes(id)) problems.push(`coverage rule 1 names ${id} and no row carries it`);
    const row = alerts.find((alert) => alert.id === id);
    if (row !== undefined && row.severity !== 'critical' && !recorded.includes(id)) problems.push(`${id}: rule 1 and the table disagree and the disagreement is not recorded`);
  }
  return problems;
}

const mutate = (patch: Partial<AlertCatalogue>): AlertCatalogue => ({ ...catalogue, ...patch });
const withRow = (patch: Partial<AlertRow>): AlertCatalogue => ({
  ...catalogue,
  alerts: catalogue.alerts.map((alert, index) => (index === 0 ? { ...alert, ...patch } : alert)),
});

describe('the shipped alert catalogue satisfies every rule §8 states', () => {
  test('20 rows, the declared ids, and no placeholder in any field', () => {
    assert.deepEqual(violations(catalogue), []);
    assert.equal(catalogue.alerts.length, 20);
    assert.deepEqual([...catalogue.alerts.map((alert) => alert.id)].sort(), [...DECLARED_IDS].sort());
  });

  test('every row carries a firing condition, a lane, a severity and a runbook that exists and is not empty', () => {
    for (const alert of catalogue.alerts) {
      assert.ok(COMPARATOR.test(alert.expr) || COMPARATOR.test(alert.threshold), `${alert.id} states no condition`);
      assert.ok(LANES.includes(alert.routing), `${alert.id} routing`);
      assert.ok(statSync(join(ROOT, alert.runbook)).size >= 500, `${alert.id} runbook`);
    }
    assert.deepEqual(Object.keys(catalogue.routing_lanes).sort(), [...LANES].sort(), 'the four lanes §8 defines');
  });

  test('the six ids where coverage rule 1 and the §8 table disagree are RECORDED, not silently resolved', () => {
    const recorded = catalogue.coverage_rule_1_conflicts.ids_marked_warning_by_the_table_but_required_critical_by_rule_1;
    const warnings = catalogue.alerts.filter((alert) => catalogue.required_critical_set.includes(alert.id) && alert.severity !== 'critical').map((alert) => alert.id);
    assert.deepEqual([...warnings].sort(), ['A-02', 'A-03', 'A-06', 'A-07', 'A-09', 'A-10']);
    assert.deepEqual([...recorded].sort(), [...warnings].sort(), 'the recorded list must name exactly the rows that disagree');
  });

  test('no alert is phrased or annotated as success (§8 coverage rule 2)', () => {
    for (const alert of catalogue.alerts) {
      assert.equal(SUCCESS_VOCABULARY.test(alert.name), false, `${alert.id} name reads as good news`);
      assert.equal(SUCCESS_VOCABULARY.test(alert.expr), false, `${alert.id} expression reads as good news`);
    }
  });
});

describe('every rule is shown to REFUSE a document that has the defect', () => {
  for (const [name, document, expected] of [
    ['a placeholder threshold', withRow({ threshold: 'TBD' }), /threshold is missing or a placeholder/],
    ['a missing id', mutate({ alerts: catalogue.alerts.slice(0, 19) }), /expected 20 rows|A-15 is declared and missing/],
    ['an id §8 does not declare', withRow({ id: 'A-99' }), /A-99 is not a declared alert/],
    ['a duplicate id', mutate({ alerts: [catalogue.alerts[0], ...catalogue.alerts.slice(0, 19)] as readonly AlertRow[] }), /share an id/],
    ['an undeclared routing lane', withRow({ routing: 'email' }), /routing email is not a declared lane/],
    ['an unregistered metric in the expression', withRow({ expr: 'sum(increase(vanishgraph_removals_completed_total[5m])) > 0' }), /unregistered metric vanishgraph_removals_completed_total/],
    ['a runbook that does not exist', withRow({ runbook: 'docs/runbooks/alerts/no-such-runbook.md' }), /does not exist/],
    ['no firing condition at all', withRow({ expr: 'vanishgraph_readiness_status', threshold: 'see dashboard' }), /no firing condition is stated/],
    ['success vocabulary', withRow({ name: 'All clear: removal confirmed' }), /success vocabulary/],
    ['an unrecorded rule-1 disagreement', mutate({ coverage_rule_1_conflicts: { ids_marked_warning_by_the_table_but_required_critical_by_rule_1: [] } }), /disagree and the disagreement is not recorded/],
    ['a rule-1 id with no row', mutate({ required_critical_set: [...catalogue.required_critical_set, 'A-99'] }), /rule 1 names A-99 and no row carries it/],
  ] as const) {
    test(`NEGATIVE CASE: ${name} is refused`, () => {
      const problems = violations(document);
      assert.ok(problems.length >= 1, `${name} must be refused`);
      assert.match(problems.join(' | '), expected);
    });
  }
});

describe('the catalogue says what has not been proven', () => {
  test('the induction is NOT RUN, and the reason is a property of this repository rather than of the catalogue', () => {
    // NO EXPRESSION EVALUATOR, NO SERIES STORE, NO LOADED RULES: the proof §8 asks for cannot be produced here, and the
    // suite asserts the ABSENCE rather than letting a reader assume the alerts were fired somewhere. If an evaluator is
    // ever added, this test is where the claim changes.
    assert.equal(existsSync(join(ROOT, 'src/adapters/observability/alert-evaluator.ts')), false);
    const readme = readFileSync(join(ROOT, 'OPERATIONS.md'), 'utf8');
    assert.match(readme, /no alert/i, 'OPERATIONS.md must not describe alerting as working');
  });
});
