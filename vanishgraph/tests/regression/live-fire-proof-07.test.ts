/**
 * LIVE-FIRE-PROOF-07 — Privacy preservation (VG-TENANT-001, VG-EGRESS-001/002, VG-SEC-002; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE, AND ITS TWO HALVES LIVE IN DIFFERENT PLACES. Tenant isolation is enforced at the DATABASE
 * layer (RLS), and egress is default-deny for `CUSTOMER_PII`, `HIGH_RISK_PII`, `IDENTITY_DOCUMENT` and `AUTH_SECRET`.
 * This suite asserts the EGRESS and DETECTION halves, which are pure domain and application decisions, and it asserts
 * THAT THE TENANT HALF EXISTS where it belongs rather than restating it here: a suite that claimed a database property
 * without a database would be exactly the kind of claim this node removes. The files it points at are checked to exist,
 * so the pointer cannot rot silently.
 *
 * THE REQUIRED NEGATIVE CASES:
 *   * an `IDENTITY_DOCUMENT` cannot reach any model or telemetry sink — asserted as a denial with zero outbound
 *     attempts and no redaction evidence, plus the metric-label set refusing a payload-shaped label;
 *   * the four protected classes are denied even when the scrubber is available and willing, because a protected class
 *     must not leave merely because a scrubber said it was clean.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DENIED_EGRESS_CLASSES,
  PERMITTED_METRIC_LABELS,
  assertMetricLabels,
  decideEgress,
  type DlpScrubber,
} from '../../src/application/security/egress-gate.ts';
import { DENY_BY_DEFAULT_EGRESS, containsApparentPii, requiresExplicitPolicy } from '../../src/domain/values.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** A scrubber that succeeds, so a denial cannot be attributed to DLP being unavailable. */
const willingScrubber: DlpScrubber = () => ({
  scrubbed: 'nothing sensitive left',
  redactionEvidenceId: 'redaction-1',
  removedClasses: [],
});

/** The refusal an operation produced, or `undefined` when it did not refuse. */
function refusalOf(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('LIVE-FIRE-PROOF-07: protected data does not leave, and tenant isolation has its own proof (VG-EGRESS-001)', () => {
  test('the deny-by-default set is exactly the four classes the specification names', () => {
    assert.deepEqual(
      [...DENIED_EGRESS_CLASSES].sort(),
      ['AUTH_SECRET', 'CUSTOMER_PII', 'HIGH_RISK_PII', 'IDENTITY_DOCUMENT'],
      'a fifth denial or a missing one changes what this outcome protects',
    );
    assert.deepEqual([...DENY_BY_DEFAULT_EGRESS].sort(), [...DENIED_EGRESS_CLASSES].sort(), 'the two declarations must agree');
    for (const egressClass of DENIED_EGRESS_CLASSES) {
      assert.equal(requiresExplicitPolicy(egressClass as never), true, `${egressClass} requires an explicit policy`);
    }
    assert.equal(requiresExplicitPolicy('OPAQUE_ID' as never), false, 'an opaque identifier needs no policy decision');
  });

  test('NEGATIVE CASE: an IDENTITY_DOCUMENT is denied with a WILLING scrubber, zero attempts and no evidence id', () => {
    // The scrubber is available and returns success; the class alone decides. A gate that let this through on the
    // strength of a scrub would make the four protected classes advisory.
    const outcome = decideEgress(
      {
        egressClass: 'IDENTITY_DOCUMENT',
        destination: 'https://example.invalid/model',
        payload: 'a scanned passport',
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
      willingScrubber,
    );
    assert.equal(outcome.allow, false);
    assert.equal(outcome.code, 'EGRESS_DENIED');
    assert.equal(outcome.outboundAttempts, 0, 'nothing may leave, so nothing may be attempted');
    assert.equal(outcome.redactionEvidenceId, undefined, 'and no redaction record may claim one did');
  });

  test('NEGATIVE CASE: every protected class is denied on the same terms, so none is a special case', () => {
    for (const egressClass of DENIED_EGRESS_CLASSES) {
      const outcome = decideEgress(
        { egressClass, destination: 'https://example.invalid/sink', payload: 'x', tenantId: 'tttttttt-tttt-4ttt-8ttt-tttttttttttt' },
        willingScrubber,
      );
      assert.equal(outcome.allow, false, `${egressClass} must be denied`);
      assert.equal(outcome.outboundAttempts, 0, `${egressClass} must produce no attempt`);
    }
  });

  test('NEGATIVE CASE: telemetry cannot carry a payload — the label set is closed and its values are enum-checked', () => {
    assert.ok(PERMITTED_METRIC_LABELS.length > 0, 'the permitted set must be declared');
    assert.throws(() => assertMetricLabels({ payload: 'a scanned passport' }), /label/i, 'a payload label is refused');
    assert.throws(() => assertMetricLabels({ identityDocument: 'x' }), /label/i, 'and so is a class-shaped one');
    // MEASURED on the same function in EP-007 M3: values are enum-checked, so a permitted label cannot smuggle free text.
    const freeText = Object.fromEntries(PERMITTED_METRIC_LABELS.map((label) => [label, 'free text']));
    assert.throws(() => assertMetricLabels(freeText), /declared enum value/);
  });

  test('the DETECTION the denial rests on: apparent personal data is caught, opaque identifiers are not', () => {
    // The two-way property: a detector that flagged everything would be ignored, and one that flagged nothing would make
    // the denial above decorative.
    assert.equal(containsApparentPii('write to alice@example.invalid about it'), true, 'an email address is apparent PII');
    assert.equal(containsApparentPii('+1 415 555 0132'), true, 'and so is a phone number');
    assert.equal(containsApparentPii('case 8f2c1a44-0000-4000-8000-000000000000'), false, 'an opaque identifier is not PII');
    assert.equal(containsApparentPii('a removal request was submitted'), false, 'and neither is ordinary text');
  });

  test('the TENANT half is asserted where it can be: the suites that own it exist, and none of that is claimed here', () => {
    // A pointer that is checkable, not a restatement. MEASURED during EP-006 M10 as well: a unit suite cannot prove a
    // database property, so this file says where the proof lives instead of implying it has one.
    for (const suite of ['tests/db/rls.test.ts', 'tests/integration/cross-tenant-both-layers.test.ts']) {
      assert.equal(existsSync(resolve(ROOT, suite)), true, `${suite} must exist: it is where tenant isolation is proven`);
    }
    const manifest = resolve(ROOT, '.agent/verification/EXPECTED_INTEGRATION_MANIFEST.txt');
    assert.equal(existsSync(manifest), true, 'and the integration manifest is what keeps it running');
  });
});
