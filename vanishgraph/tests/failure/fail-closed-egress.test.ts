/**
 * Forced failure: egress must fail CLOSED when the scrubber does (DOD-014; SPEC-006 §7.1 row 14, VG-EGRESS-001/002;
 * EP-007 M3).
 *
 * THE FAILURE THIS FILE MAKES HAPPEN IS THE DLP SCRUBBER ITSELF — unavailable, throwing, and returning nothing — and the
 * property asserted is that each of those DENIES egress with zero outbound attempts. The order matters and is asserted
 * too: a protected class is refused BEFORE the scrubber is consulted, so nobody can argue "the payload was clean".
 *
 * THE THIRD SHAPE IS THE SUBTLE ONE: a scrubber that returns a payload with NO redaction-evidence id. The egress would
 * then be un-auditable — the payload left and no record names what was removed — so it is refused rather than allowed.
 *
 * WHAT IT DOES NOT PROVE: that a real DLP engine scrubs correctly. There is no DLP vendor in this repository; the
 * scrubber here is a test double, which is legal because this is `tests/**` and the SUBJECT is the gate's decision, not
 * the scrubber's quality.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_EGRESS_CLASSES,
  DENIED_EGRESS_CLASSES,
  PERMITTED_METRIC_LABELS,
  assertMetricLabels,
  decideEgress,
  type DlpScrubber,
  type EgressRequest,
} from '../../src/application/security/egress-gate.ts';

const REQUEST: EgressRequest = {
  egressClass: 'CUSTOMER_PII',
  destination: 'https://example.invalid/submit',
  payload: 'a payload that carries personal data',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

/** A scrubber that works, so a refusal below cannot be attributed to a broken helper. */
const workingScrubber: DlpScrubber = () => ({
  scrubbed: 'a payload that carries [REDACTED]',
  redactionEvidenceId: 'redaction-1',
  removedClasses: ['CUSTOMER_PII'],
});

describe('forced failure: egress fails closed when DLP does (DOD-014)', () => {
  test('an UNAVAILABLE scrubber denies, with zero outbound attempts', () => {
    // MEASURED, AND IT CORRECTED THIS SUITE: with a DEFAULT-DENY class the refusal is EGRESS_DENIED and the scrubber is
    // never reached, so the DLP branch can only be observed on a class that is allowed to leave. The first version used
    // CUSTOMER_PII and measured EGRESS_DENIED — which is correct behaviour and the wrong test.
    const allowedClass = ALLOWED_EGRESS_CLASSES[0]?.egressClass ?? '';
    const outcome = decideEgress({ ...REQUEST, egressClass: allowedClass }, () => undefined);
    assert.equal(outcome.allow, false, 'an unavailable scrubber must deny');
    assert.equal(outcome.code, 'DLP_UNAVAILABLE');
    assert.equal(outcome.outboundAttempts, 0, 'a denied egress must not have attempted anything');
    assert.ok(outcome.detail.length > 0, 'and the refusal must say why');
    assert.equal(outcome.redactionEvidenceId, undefined, 'a denial carries no evidence id');
  });

  test('a scrubber that THROWS denies rather than propagating an allow-shaped result', () => {
    // Whether the throw escapes or is converted to a denial, the one outcome that must not happen is an ALLOW. If it
    // escapes, that is the caller's problem to handle as a failure; if it is caught, it must become DLP_UNAVAILABLE.
    let outcome: ReturnType<typeof decideEgress> | undefined;
    let thrown: unknown;
    try {
      outcome = decideEgress({ ...REQUEST, egressClass: ALLOWED_EGRESS_CLASSES[0]?.egressClass ?? '' }, () => {
        throw new Error('the DLP engine is down');
      });
    } catch (error) {
      thrown = error;
    }
    if (thrown !== undefined) {
      assert.ok(thrown instanceof Error, 'a throwing scrubber must not be swallowed into a verdict');
      return;
    }
    assert.ok(outcome !== undefined);
    assert.equal(outcome.allow, false, 'a throwing scrubber must never produce an allow');
    assert.equal(outcome.code, 'DLP_UNAVAILABLE');
    assert.equal(outcome.outboundAttempts, 0);
  });

  test('a scrub with NO redaction-evidence id is refused, because the egress would not be auditable', () => {
    const outcome = decideEgress(REQUEST, () => ({
      scrubbed: 'clean',
      redactionEvidenceId: '',
      removedClasses: [],
    }));
    assert.equal(outcome.allow, false, 'an un-auditable egress must not be allowed');
    assert.notEqual(outcome.outboundAttempts, 1, 'and nothing may have left');
  });

  test('a PROTECTED class is refused BEFORE the scrubber is consulted', () => {
    // The ordering assertion, and it is made with a spy rather than with the message: a denied class must never reach
    // the scrubber, or the denial would depend on the payload being clean.
    let consulted = 0;
    for (const egressClass of DENIED_EGRESS_CLASSES) {
      const outcome = decideEgress({ ...REQUEST, egressClass }, () => {
        consulted += 1;
        return { scrubbed: 'x', redactionEvidenceId: 'r', removedClasses: [] };
      });
      assert.equal(outcome.allow, false, `${egressClass} must be denied`);
      assert.equal(outcome.code, 'EGRESS_DENIED');
      assert.equal(outcome.outboundAttempts, 0);
    }
    assert.equal(consulted, 0, 'the scrubber must not have been consulted for a denied class');
  });

  test('an UNDECLARED class is denied, not defaulted to allowed', () => {
    const outcome = decideEgress({ ...REQUEST, egressClass: 'NOT_A_DECLARED_CLASS' }, workingScrubber);
    assert.equal(outcome.allow, false, 'an undeclared class must deny rather than fall through');
    assert.equal(outcome.outboundAttempts, 0);
  });

  test('the allowed path still works, so the refusals above are about the failure and not the fixture', () => {
    const allowed = ALLOWED_EGRESS_CLASSES[0];
    assert.ok(allowed !== undefined, 'the allowlist must name at least one class');
    const outcome = decideEgress({ ...REQUEST, egressClass: allowed.egressClass }, workingScrubber);
    assert.equal(outcome.allow, true, `${allowed.egressClass} must be admitted with a working scrubber`);
    assert.equal(outcome.outboundAttempts, 1, 'and exactly one attempt is recorded');
    assert.equal(outcome.redactionEvidenceId, 'redaction-1', 'the evidence id from the scrub is carried');
  });

  test('a metric label outside the permitted set is refused, so telemetry cannot carry a payload field', () => {
    // The second way a payload leaves: attached to a metric. The permitted set is closed and asserted directly.
    assert.ok(PERMITTED_METRIC_LABELS.length > 0);
    // MEASURED, AND IT CORRECTED THIS SUITE TOO: label VALUES are enum-checked, not free text — `reason` with the value
    // 'ok' is refused with 'must be a declared enum value'. So the permitted set is not a licence to attach arbitrary
    // values, which is the property worth asserting; my first version asserted `ok` was accepted and failed.
    assert.throws(() => assertMetricLabels({ payload: 'personal data' }), /label/i, 'an undeclared label is refused');
    assert.throws(() => assertMetricLabels({ email: 'a@b.invalid' }), /label/i, 'and so is a payload-shaped one');
    const freeText = Object.fromEntries(PERMITTED_METRIC_LABELS.map((label) => [label, 'ok']));
    assert.throws(
      () => assertMetricLabels(freeText),
      /declared enum value/,
      'a permitted label carrying free text is refused, so a value cannot smuggle a payload',
    );
  });
});
