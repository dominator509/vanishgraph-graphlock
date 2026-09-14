/**
 * Value-object tests (SPEC-001 §2).
 *
 * These assert the "unrepresentable rather than validated later" property: an
 * invalid value must be impossible to construct, not merely detected downstream.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  Confidence,
  IdempotencyKey,
  EvidenceDigest,
  ObservationWindow,
  permitsAutomatedWrite,
  requiresExplicitPolicy,
  DENY_BY_DEFAULT_EGRESS,
  type PermissionClass,
  type EgressClass,
} from '../../src/domain/values.ts';
import { InvalidValueObject } from '../../src/domain/errors.ts';

describe('Confidence (VG-IDENT-003)', () => {
  test('a score with a basis is constructible', () => {
    const c = new Confidence(0.82, ['exact-name-match', 'state-match', 'age-band-match']);
    assert.equal(c.value, 0.82);
    assert.equal(c.basis.length, 3);
  });

  test('a score with NO basis is unrepresentable', () => {
    assert.throws(() => new Confidence(0.9, []), InvalidValueObject);
  });

  test('a score with a blank basis entry is refused', () => {
    assert.throws(() => new Confidence(0.9, ['  ']), InvalidValueObject);
  });

  test('out-of-range and non-finite values are refused', () => {
    for (const bad of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => new Confidence(bad, ['x']), InvalidValueObject);
    }
  });

  test('boundary values 0 and 1 are accepted', () => {
    assert.equal(new Confidence(0, ['none']).value, 0);
    assert.equal(new Confidence(1, ['certain']).value, 1);
  });

  test('basis is frozen against later mutation', () => {
    const basis = ['a', 'b'];
    const c = new Confidence(0.5, basis);
    basis.push('c');
    assert.equal(c.basis.length, 2, 'caller mutation must not alter the value object');
    assert.throws(() => {
      (c.basis as string[]).push('d');
    });
  });

  test('equality is by value including basis', () => {
    assert.ok(new Confidence(0.5, ['a']).equals(new Confidence(0.5, ['a'])));
    assert.equal(new Confidence(0.5, ['a']).equals(new Confidence(0.5, ['b'])), false);
    assert.equal(new Confidence(0.5, ['a']).equals(new Confidence(0.6, ['a'])), false);
  });

  test('atLeast compares against the policy threshold', () => {
    assert.equal(new Confidence(0.8, ['x']).atLeast(0.75), true);
    assert.equal(new Confidence(0.7, ['x']).atLeast(0.75), false);
  });
});

describe('IdempotencyKey (VG-ACTION-001)', () => {
  test('a normal key is accepted', () => {
    assert.equal(new IdempotencyKey('case-123:mail:v1').value, 'case-123:mail:v1');
  });

  test('empty and blank keys are refused', () => {
    for (const bad of ['', '   ']) {
      assert.throws(() => new IdempotencyKey(bad), InvalidValueObject);
    }
  });

  test('untrimmed keys are refused, because keys are compared exactly', () => {
    assert.throws(() => new IdempotencyKey(' key '), InvalidValueObject);
  });

  test('over-long keys are refused', () => {
    assert.throws(() => new IdempotencyKey('k'.repeat(201)), InvalidValueObject);
  });
});

describe('EvidenceDigest (VG-EVIDENCE-001)', () => {
  test('a valid SHA-256 hex digest is accepted', () => {
    const d = new EvidenceDigest('a'.repeat(64));
    assert.equal(d.value.length, 64);
  });

  test('malformed digests are refused', () => {
    for (const bad of [
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64), // uppercase is not the canonical form
      'g'.repeat(64), // non-hex
      '',
      'sha256:' + 'a'.repeat(64),
    ]) {
      assert.throws(() => new EvidenceDigest(bad), InvalidValueObject, `should refuse ${bad}`);
    }
  });
});

describe('ObservationWindow (VG-VERIFY-002)', () => {
  test('a positive duration with a method is accepted', () => {
    const w = new ObservationWindow(86_400_000, 'independent-fetch');
    assert.equal(w.durationMs, 86_400_000);
    assert.equal(w.method, 'independent-fetch');
  });

  test('non-positive or non-integer durations are refused', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new ObservationWindow(bad, 'm'), InvalidValueObject);
    }
  });

  test('a window with no method is refused', () => {
    assert.throws(() => new ObservationWindow(1000, ''), InvalidValueObject);
  });

  test('elapsed time is evaluated against the start, not assumed', () => {
    const w = new ObservationWindow(1000, 'm');
    assert.equal(w.hasElapsed(1000, 0), true);
    assert.equal(w.hasElapsed(999, 0), false, 'the window must not be satisfiable early');
  });
});

describe('PermissionClass (VG-CHANNEL-002, TOS_AUTOMATION_MATRIX)', () => {
  test('only WRITE_PERMITTED allows an automated write', () => {
    assert.equal(permitsAutomatedWrite('WRITE_PERMITTED'), true);
  });

  test('WRITE_UNCLEAR is treated exactly like PROHIBITED', () => {
    // An unclear permission is not a permission. This is the rule that stops the
    // product from "trying harder" against an unknown ToS position.
    for (const cls of ['WRITE_UNCLEAR', 'PROHIBITED', 'READ_ONLY'] as PermissionClass[]) {
      assert.equal(permitsAutomatedWrite(cls), false, `${cls} must not permit a write`);
    }
  });
});

describe('EgressClass (VG-EGRESS-001, DATA_EGRESS_MATRIX)', () => {
  test('the four protected classes are deny-by-default', () => {
    assert.deepEqual(
      [...DENY_BY_DEFAULT_EGRESS].sort(),
      ['AUTH_SECRET', 'CUSTOMER_PII', 'HIGH_RISK_PII', 'IDENTITY_DOCUMENT'],
    );
  });

  test('protected classes require an explicit tenant policy', () => {
    for (const cls of DENY_BY_DEFAULT_EGRESS) {
      assert.equal(requiresExplicitPolicy(cls), true);
    }
  });

  test('opaque ids and nothing-at-all do not require a policy decision', () => {
    assert.equal(requiresExplicitPolicy('OPAQUE_ID' satisfies EgressClass), false);
    assert.equal(requiresExplicitPolicy('NONE' satisfies EgressClass), false);
  });
});
