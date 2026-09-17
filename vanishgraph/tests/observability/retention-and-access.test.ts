/**
 * Retention, deletion and access control for observability data (SPEC-007 §11; EP-008 M8(c); DOD-012, DOD-037).
 *
 * THIS SUITE AND `scripts/retention-config-guard.sh` CHECK THE SAME RULES ON PURPOSE — the guard is the STAGE that runs
 * alone and writes its own evidence, and this is the PERMANENT REGRESSION NET that runs in the unit stage on every
 * change. The guard's check lives inside a script written to an evidence directory and cannot be imported, so the rules
 * are re-derived here; any rule added to one belongs in the other.
 *
 * WHAT IT CANNOT PROVE, AND SAYS SO: the DELETION PROPAGATION rows — a seeded expired record absent after the expiry
 * job runs, a sealed rewrite refused at run time — need a partitioned telemetry store, which this environment does not
 * have. The suite therefore asserts the rules the CONFIGURATION states, and the last test asserts that the environment
 * records the propagation as BLOCKED rather than leaving a reader to assume the job ran.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadMetricCatalogue, type MetricCatalogue } from '../../src/adapters/observability/metrics-registry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CONFIG_PATH = join(ROOT, 'config/observability/retention.json');

interface RetentionClass {
  readonly data_class: string;
  readonly hot: string;
  readonly cold: string | null;
  readonly deletion: string;
  readonly note?: string;
}
interface RetentionDocument {
  readonly classes: readonly RetentionClass[];
  readonly deletion: { readonly mechanism: string; readonly sealed_partition_rewrite: string; readonly counter: string; readonly counter_labels: readonly string[]; readonly outcomes: readonly string[]; readonly log_rule: string; readonly dry_run_rule: string };
  readonly access: { readonly raw_telemetry_read_requires: readonly string[]; readonly tenant_scoping: string; readonly audit_rule: string };
}

const document = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as RetentionDocument;
const loaded = loadMetricCatalogue(join(ROOT, 'config/metrics/catalogue.json'));
assert.equal(loaded.ok, true);
const catalogue = (loaded as { ok: true; catalogue: MetricCatalogue }).catalogue;

/** §11.1's windows, in days, held here rather than read from the file so a file that lost a class cannot validate itself. */
const SECTION_11_1: readonly { readonly data_class: string; readonly hot_days: number; readonly cold_days: number | null }[] = [
  { data_class: 'TRACE', hot_days: 7, cold_days: 30 },
  { data_class: 'LOG', hot_days: 30, cold_days: 90 },
  { data_class: 'LOG_SECURITY', hot_days: 400, cold_days: 400 },
  { data_class: 'METRIC', hot_days: 15, cold_days: 390 },
  { data_class: 'EXEMPLAR', hot_days: 3, cold_days: null },
  { data_class: 'ERROR_REPORT', hot_days: 90, cold_days: null },
  { data_class: 'ALERT_HISTORY', hot_days: 390, cold_days: null },
  { data_class: 'SLO_VERDICT', hot_days: 390, cold_days: null },
];
const EVIDENCE_STORE_CLASSES = ['REDACTION_EVIDENCE', 'DEBUG_BUNDLE'];
const UNBOUNDED = /^(|0|-1|infinite|infinity|forever|unlimited|never|none|null)$/i;

const days = (text: string | null): number | null => {
  if (typeof text !== 'string') return null;
  const match = /^(\d+)\s*(h|d|months?|mo|y)?$/i.exec(text.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? 'd').toLowerCase();
  if (unit === 'h') return value / 24;
  if (unit.startsWith('month') || unit === 'mo') return value * 30;
  if (unit === 'y') return value * 365;
  return value;
};

const byName = new Map(document.classes.map((entry) => [entry.data_class, entry]));

describe('every signal class has an explicit window and none of them is unbounded', () => {
  test('the §11.1 classes carry the windows §11.1 gives them', () => {
    for (const required of SECTION_11_1) {
      const entry = byName.get(required.data_class);
      assert.ok(entry !== undefined, `${required.data_class} must be configured`);
      assert.equal(days(entry.hot), required.hot_days, `${required.data_class} hot window`);
      if (required.cold_days !== null) assert.equal(days(entry.cold), required.cold_days, `${required.data_class} cold window`);
    }
  });

  test('redaction evidence and debug bundles follow the EVIDENCE STORE policy rather than a second number invented here', () => {
    for (const dataClass of EVIDENCE_STORE_CLASSES) {
      const entry = byName.get(dataClass);
      assert.ok(entry !== undefined, `${dataClass} must be configured`);
      // §11.1 defers these to the evidence store, and VG-EVIDENCE-003 makes that store append-only: a second retention
      // number here would be a second policy for the same artifacts.
      assert.equal(entry?.deletion, 'EVIDENCE_STORE_POLICY', `${dataClass} must defer to the evidence store policy`);
    }
  });

  test('NEGATIVE CONTROL: an unbounded window is refused in every form the guard screens for', () => {
    for (const value of ['', '0', '-1', 'infinite', 'forever', 'unlimited', 'never']) {
      assert.equal(UNBOUNDED.test(value.trim()), true, `${value} must be recognised as unbounded`);
    }
    assert.equal(UNBOUNDED.test('400d'), false);
    // AND THE SHIPPED FILE CARRIES NO SUCH VALUE, which is the assertion that matters.
    for (const entry of document.classes) {
      for (const field of ['hot', 'cold'] as const) {
        const value = entry[field];
        if (typeof value === 'string') assert.equal(UNBOUNDED.test(value.trim()), false, `${entry.data_class}.${field}`);
      }
    }
  });

  test('the security subset is longer than the ordinary logs and names the selectors that define it', () => {
    const log = days(byName.get('LOG')?.hot ?? null);
    const security = days(byName.get('LOG_SECURITY')?.hot ?? null);
    assert.ok(log !== null && security !== null && security > log, 'security-relevant logs must be retained longer');
    const note = byName.get('LOG_SECURITY')?.note ?? '';
    for (const selector of ['ERROR', 'FATAL', 'CrossTenantAccessRefused', 'EgressDenied', 'StaleRecipeRefused', 'DuplicateEffectDetected']) {
      assert.match(note, new RegExp(selector), `the security subset must name the selector ${selector}`);
    }
  });
});

describe('deletion propagates by whole-partition drop only, and it is never silent', () => {
  test('the mechanism, the sealed-partition rule and the log rule are stated', () => {
    assert.equal(document.deletion.mechanism, 'WHOLE_PARTITION_DROP');
    assert.equal(document.deletion.sealed_partition_rewrite, 'REFUSED');
    assert.match(document.deletion.log_rule, /INFO/);
    // A DELETION AT DEBUG WOULD BE INVISIBLE IN PRACTICE, and a retention job nobody can see is indistinguishable from
    // one that stopped running — which is how a window silently becomes infinite.
    assert.match(document.deletion.log_rule, /NEVER REPORTED AT DEBUG/);
    assert.match(document.deletion.dry_run_rule, /dry-run plan/i, 'the fallback validates a plan, so the plan must be required');
  });

  test('the counter and its outcome vocabulary are ones the metric catalogue can actually record', () => {
    const family = catalogue.byName.get(document.deletion.counter);
    assert.ok(family !== undefined, `${document.deletion.counter} must be a registered family`);
    for (const label of document.deletion.counter_labels) {
      assert.ok(family?.labels.includes(label), `${document.deletion.counter} must declare the label ${label}`);
    }
    const declared = catalogue.perFamilyLabelValueSets[document.deletion.counter]?.['outcome'] ?? catalogue.labelValueSets['outcome'] ?? [];
    for (const outcome of document.deletion.outcomes) {
      assert.ok(declared.includes(outcome), `${outcome} is not in the bounded set for ${document.deletion.counter}, so the outcome could never be recorded`);
    }
    // AND THE THREE OUTCOMES ARE EXACTLY THE THREE §11.2 NAMES, so a deletion cannot happen without one of them.
    assert.deepEqual([...document.deletion.outcomes].sort(), ['FAILED', 'PARTITION_DROPPED', 'REFUSED_SEALED_REWRITE']);
  });
});

describe('raw telemetry reads are authenticated, tenant-scoped and audited', () => {
  test('the three conditions are stated, the cross-tenant answer is absence, and the audit carries no contents', () => {
    assert.ok(document.access.raw_telemetry_read_requires.length >= 3);
    const joined = document.access.raw_telemetry_read_requires.join(' ').toLowerCase();
    assert.match(joined, /authenticated/);
    assert.match(joined, /role/);
    assert.match(joined, /mfa/);
    // ABSENCE, NOT AN ERROR: a distinguishable refusal tells the caller that another tenant's data exists.
    assert.match(document.access.tenant_scoping, /NOTHING/);
    assert.match(document.access.tenant_scoping, /EVIDENCE_READBACK/);
    assert.match(document.access.audit_rule, /ACTOR/i);
    assert.match(document.access.audit_rule, /PURPOSE CODE/i);
    assert.match(document.access.audit_rule, /QUERY SCOPE/i);
    assert.match(document.access.audit_rule, /RESULT COUNT/i);
    assert.match(document.access.audit_rule, /NO RESULT CONTENTS/i);
    assert.match(document.access.audit_rule, /failure rather than a warning/i);
  });
});

describe('what this environment cannot execute is recorded, not implied', () => {
  test('the propagation rows are BLOCKED_ENVIRONMENT with their attempt log, and no deletion is claimed', () => {
    const attemptLog = join(ROOT, '.agent/evidence/EP-008/retention/provisioning-attempts.txt');
    assert.equal(existsSync(attemptLog), true, 'the provisioning attempt log must exist');
    const log = readFileSync(attemptLog, 'utf8');
    for (const variable of ['TRACE_BACKEND_URL', 'LOG_STORE_URL', 'PROMETHEUS_URL']) {
      assert.match(log, new RegExp(variable), `${variable} must be named in the attempt log`);
    }
    assert.match(log, /BLOCKED_ENVIRONMENT/, 'the unexecuted propagation must be labelled, not omitted');
    // AND NO EXPIRY JOB EXISTS TO RUN: if one is ever added, this assertion is where the claim changes.
    assert.equal(existsSync(join(ROOT, 'scripts/retention-expire.sh')), false);
  });
});
