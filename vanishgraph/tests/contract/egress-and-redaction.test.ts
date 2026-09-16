/**
 * Secret handling and DLP-before-egress (SPEC-005 §8, SPEC-006 §7.1/§9; EP-006 M8).
 *
 * The egress assertions are about what a DENIAL does not do: it makes no outbound attempt, and the attempt count is what
 * the suite reads rather than the caller's own report. The metric-label and log-field assertions are closed sets, because
 * both are egress paths nobody thinks of as one.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_EGRESS_CLASSES,
  DENIED_EGRESS_CLASSES,
  FORBIDDEN_LOG_FIELDS,
  PERMITTED_METRIC_LABELS,
  assertMetricLabels,
  assertNoSecretInLogFields,
  assertStaticSecretException,
  decideEgress,
  type DlpScrubber,
} from '../../src/application/security/egress-gate.ts';

const REQUEST = { egressClass: 'CONTROLLER_CORRESPONDENCE', destination: 'https://controller.example/request', payload: 'a redacted template', tenantId: 'tenant-1' };

/** A scrubber that reports what it removed. */
const workingScrubber: DlpScrubber = (payload) => ({
  scrubbed: payload.replaceAll('data.subject@example.com', '[EMAIL]'),
  redactionEvidenceId: 'redaction-1',
  removedClasses: ['a-email'],
});

describe('the egress gate denies by default for the four classes that may not leave (VG-EGRESS-001)', () => {
  test('the denied set is exactly the four the specification names', () => {
    assert.deepEqual([...DENIED_EGRESS_CLASSES].sort(), ['AUTH_SECRET', 'CUSTOMER_PII', 'HIGH_RISK_PII', 'IDENTITY_DOCUMENT']);
    for (const egressClass of DENIED_EGRESS_CLASSES) {
      const outcome = decideEgress({ ...REQUEST, egressClass }, workingScrubber);
      assert.equal(outcome.allow, false, `${egressClass} must be denied`);
      assert.equal(outcome.code, 'EGRESS_DENIED');
      // THE ATTEMPT COUNT IS THE ASSERTION: denied egress makes NO outbound request, and the caller's report is not the
      // evidence — this count is.
      assert.equal(outcome.outboundAttempts, 0);
      assert.match(outcome.detail, /no outbound request is made/);
    }
  });

  test('an UNDECLARED class is denied rather than defaulted', () => {
    const outcome = decideEgress({ ...REQUEST, egressClass: 'SOMETHING_NEW' }, workingScrubber);
    assert.equal(outcome.allow, false);
    assert.equal(outcome.code, 'EGRESS_DENIED');
    assert.match(outcome.detail, /not a declared egress class, and the default is deny/);
    assert.equal(outcome.outboundAttempts, 0);
  });

  test('the allowed classes each state why they are allowed, and one of them is admitted', () => {
    assert.ok(ALLOWED_EGRESS_CLASSES.length >= 3);
    for (const entry of ALLOWED_EGRESS_CLASSES) assert.ok(entry.reason.length > 10, `${entry.egressClass} needs a reason`);
    const outcome = decideEgress(REQUEST, workingScrubber);
    assert.equal(outcome.allow, true);
    assert.equal(outcome.outboundAttempts, 1, 'an admitted egress makes exactly one attempt');
    assert.equal(outcome.redactionEvidenceId, 'redaction-1');
  });

  test('an UNAVAILABLE scrubber denies egress (SPEC-006 §7.1 row 14)', () => {
    const outcome = decideEgress(REQUEST, () => undefined);
    assert.equal(outcome.allow, false);
    assert.equal(outcome.code, 'DLP_UNAVAILABLE');
    assert.equal(outcome.outboundAttempts, 0);
    assert.match(outcome.detail, /could not run, so egress is denied/);
  });

  test('a scrub with no redaction evidence id is refused, because the egress would not be auditable', () => {
    const outcome = decideEgress(REQUEST, (payload) => ({ scrubbed: payload, redactionEvidenceId: '   ', removedClasses: [] }));
    assert.equal(outcome.allow, false);
    assert.equal(outcome.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(outcome.outboundAttempts, 0);
  });

  test('DLP runs BEFORE the egress, and the scrubber is never consulted for a denied class', () => {
    let scrubCalls = 0;
    const counting: DlpScrubber = (payload) => {
      scrubCalls += 1;
      return { scrubbed: payload, redactionEvidenceId: 'r', removedClasses: [] };
    };
    decideEgress({ ...REQUEST, egressClass: 'CUSTOMER_PII' }, counting);
    assert.equal(scrubCalls, 0, 'a denied class must not reach the scrubber');
    decideEgress(REQUEST, counting);
    assert.equal(scrubCalls, 1, 'an allowed class is scrubbed before it leaves');
  });
});

describe('metric labels and log fields are closed sets (VG-ERR-070, SPEC-006 §8)', () => {
  test('the permitted labels are the five the requirement names, and nothing else is accepted', () => {
    assert.deepEqual([...PERMITTED_METRIC_LABELS], ['code', 'class', 'category', 'tenantId', 'reason']);
    assert.doesNotThrow(() => assertMetricLabels({ code: 'RATE_LIMITED', class: 'SYSTEM', category: 'auth', tenantId: 'tenant-1', reason: 'BUDGET_EXHAUSTED' }));
    for (const forbidden of ['caseId', 'subjectRef', 'actionId', 'displayRef', 'message', 'detail']) {
      assert.throws(() => assertMetricLabels({ [forbidden]: 'anything' }), /is not permitted/, `${forbidden} must be refused`);
    }
  });

  test('the reason label is an enum, never free text', () => {
    assert.doesNotThrow(() => assertMetricLabels({ reason: 'STEP_UP_REQUIRED' }));
    assert.throws(() => assertMetricLabels({ reason: 'the subject asked for it' }), /must be a declared enum value/);
    assert.throws(() => assertMetricLabels({ reason: 'lower_case' }), /must be a declared enum value/);
  });

  test('a forbidden log field is refused, and the list covers secrets and PII alike', () => {
    assert.ok(FORBIDDEN_LOG_FIELDS.includes('secret'));
    assert.ok(FORBIDDEN_LOG_FIELDS.includes('authorization'));
    assert.ok(FORBIDDEN_LOG_FIELDS.includes('identifierValue'));
    assert.doesNotThrow(() => assertNoSecretInLogFields({ code: 'RATE_LIMITED', correlationId: 'corr-1' }));
    for (const field of FORBIDDEN_LOG_FIELDS) {
      assert.throws(() => assertNoSecretInLogFields({ [field]: 'x' }), /may not be logged/, `${field} must be refused`);
    }
  });

  test('a static secret requires a live, owned, reasoned exception (VG-AUTH-011…013)', () => {
    // ABSENT: refused, so a caller cannot hold a static key without one.
    assert.throws(() => assertStaticSecretException(undefined, '2026-09-16T00:00:00Z'), /requires a recorded time-bounded exception/);
    // EXPIRED: refused, and the message says what to do instead.
    assert.throws(
      () => assertStaticSecretException({ reason: 'legacy provider', owner: 'ops', expiresAt: '2026-01-01T00:00:00Z' }, '2026-09-16T00:00:00Z'),
      /must be rotated to a workload identity/,
    );
    // UNOWNED OR UNREASONED: refused.
    assert.throws(
      () => assertStaticSecretException({ reason: '', owner: 'ops', expiresAt: '2027-01-01T00:00:00Z' }, '2026-09-16T00:00:00Z'),
      /must name an owner and a reason/,
    );
    // LIVE AND OWNED: accepted.
    assert.doesNotThrow(() =>
      assertStaticSecretException({ reason: 'legacy provider with no workload identity', owner: 'ops', expiresAt: '2027-01-01T00:00:00Z' }, '2026-09-16T00:00:00Z'),
    );
  });
});
