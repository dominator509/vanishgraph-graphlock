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
  ChannelPriority,
  CHANNEL_NAMES,
  priorityOf,
  selectChannel,
  rejectedChannels,
  Jurisdiction,
  LegalBasis,
  Money,
  assertTruthState,
  assertPermissionClass,
  assertEgressClass,
  containsApparentPii,
  type PermissionClass,
  type EgressClass,
} from '../../src/domain/values.ts';
import { ALL_TRUTH_STATES } from '../../src/domain/truth-state.ts';
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

  test('over-long keys are refused at the SPEC-003 §4.2 bound of 255', () => {
    // The bound was 200 here until EP-004 M5, which was NARROWER than the contract: a caller
    // following SPEC-003 §4.2 could send a 255-character key and have construction fail inside the
    // domain, producing a 500 for input the contract declared valid. The test asserted the
    // implementation's value rather than the specification's.
    assert.throws(() => new IdempotencyKey('k'.repeat(256)), InvalidValueObject);
    // And the maximum the contract permits is accepted, which is the half that was missing.
    assert.equal(new IdempotencyKey('k'.repeat(255)).value.length, 255);
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

describe('ChannelPriority (VG-CHANNEL-001, SPEC-000 §8)', () => {
  test('priorities are exactly 1..8', () => {
    for (const bad of [0, 9, 1.5, Number.NaN, -1]) {
      assert.throws(() => new ChannelPriority(bad), InvalidValueObject);
    }
    assert.equal(new ChannelPriority(1).value, 1);
    assert.equal(new ChannelPriority(8).value, 8);
  });

  test('priority order matches SPEC-000 §8 exactly', () => {
    assert.equal(CHANNEL_NAMES.length, 8);
    assert.equal(new ChannelPriority(1).channelName(), 'OFFICIAL_SELF_SERVICE');
    assert.equal(new ChannelPriority(5).channelName(), 'SEARCH_ENGINE_REMOVAL');
    assert.equal(new ChannelPriority(8).channelName(), 'NOT_REMOVABLE_OUTCOME');
    assert.equal(priorityOf('CERTIFIED_MAIL').value, 6);
  });

  test('the highest-priority lawful channel is selected', () => {
    const options = [
      { channel: 'CERTIFIED_MAIL' as const, unavailableKind: null, unavailableReason: null },
      {
        channel: 'OFFICIAL_SELF_SERVICE' as const,
        unavailableKind: null,
        unavailableReason: null,
      },
    ];
    const selected = selectChannel(options);
    assert.equal(selected.channel, 'OFFICIAL_SELF_SERVICE');
    assert.deepEqual(rejectedChannels(options, selected), []);
  });

  test('a lower-priority choice requires every higher one recorded with a reason', () => {
    assert.throws(
      () =>
        selectChannel([
          {
            channel: 'OFFICIAL_SELF_SERVICE',
            unavailableKind: 'GATED',
            unavailableReason: '   ',
          },
          { channel: 'CERTIFIED_MAIL', unavailableKind: null, unavailableReason: null },
        ]),
      InvalidValueObject,
    );
    const options = [
      {
        channel: 'OFFICIAL_SELF_SERVICE' as const,
        unavailableKind: 'GATED' as const,
        unavailableReason: 'HumanGate: identity verification required',
      },
      { channel: 'CERTIFIED_MAIL' as const, unavailableKind: null, unavailableReason: null },
    ];
    const selected = selectChannel(options);
    assert.equal(selected.channel, 'CERTIFIED_MAIL');
    assert.equal(rejectedChannels(options, selected).length, 1);
  });

  test('no available channel is a modelling error, not a forced write', () => {
    assert.throws(
      () =>
        selectChannel([
          {
            channel: 'OFFICIAL_SELF_SERVICE',
            unavailableKind: 'UNLAWFUL',
            unavailableReason: 'exempt public record',
          },
        ]),
      InvalidValueObject,
    );
  });
});

describe('Jurisdiction (SPEC-001 §2)', () => {
  test('uppercase ISO 3166-2 codes are accepted', () => {
    assert.equal(new Jurisdiction('US').country(), 'US');
    assert.equal(new Jurisdiction('US-CA').value, 'US-CA');
    assert.equal(new Jurisdiction('DE-BE').value, 'DE-BE');
  });

  test('lowercase, malformed, and empty codes are refused', () => {
    for (const bad of ['us', 'usa', 'U', 'US-', '-CA', '', '12']) {
      assert.throws(() => new Jurisdiction(bad), InvalidValueObject, `should refuse ${bad}`);
    }
  });
});

describe('LegalBasis (VG-POLICY-001)', () => {
  test('a basis always carries its policy version', () => {
    const basis = new LegalBasis('CCPA_DELETE', 7);
    assert.equal(basis.code, 'CCPA_DELETE');
    assert.equal(basis.policyVersion, 7);
  });

  test('free-text and unversioned bases are unrepresentable', () => {
    for (const bad of ['ccpa delete', 'ccpa', 'delete request', '']) {
      assert.throws(() => new LegalBasis(bad, 1), InvalidValueObject, `should refuse ${bad}`);
    }
    for (const badVersion of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new LegalBasis('CCPA_DELETE', badVersion), InvalidValueObject);
    }
  });
});

describe('Money (SPEC-001 §2 — no float arithmetic)', () => {
  test('integer minor units are accepted and add exactly', () => {
    const a = new Money(1250, 'USD');
    assert.equal(a.add(new Money(750, 'USD')).minorUnits, 2000);
    assert.equal(a.multiply(3).minorUnits, 3750);
    assert.equal(a.isZero(), false);
    assert.equal(new Money(0, 'USD').isZero(), true);
  });

  test('float amounts, bad currencies, and mixed currencies are refused', () => {
    for (const bad of [12.5, Number.NaN, Number.POSITIVE_INFINITY, 0.1 + 0.2]) {
      assert.throws(() => new Money(bad, 'USD'), InvalidValueObject, `should refuse ${bad}`);
    }
    for (const badCurrency of ['usd', 'US', 'USDD', '']) {
      assert.throws(() => new Money(100, badCurrency), InvalidValueObject);
    }
    assert.throws(() => new Money(100, 'USD').add(new Money(100, 'EUR')), InvalidValueObject);
    assert.throws(() => new Money(100, 'USD').multiply(1.5), InvalidValueObject);
  });
});

describe('runtime membership guards (SPEC-001 §8.1)', () => {
  test('assertTruthState accepts exactly the eleven canonical states', () => {
    for (const state of ALL_TRUTH_STATES) {
      assert.equal(assertTruthState(state), state);
    }
  });

  test('assertTruthState refuses ad-hoc status vocabulary', () => {
    for (const bad of ['DONE', 'COMPLETE', 'SUCCESS', 'REMOVED', 'done', '', 42, null]) {
      assert.throws(
        () => assertTruthState(bad),
        InvalidValueObject,
        `should refuse ${String(bad)}`,
      );
    }
  });

  test('assertPermissionClass and assertEgressClass refuse unknown members', () => {
    assert.equal(assertPermissionClass('WRITE_UNCLEAR'), 'WRITE_UNCLEAR');
    assert.equal(assertEgressClass('HIGH_RISK_PII'), 'HIGH_RISK_PII');
    for (const bad of ['write_permitted', 'ALLOWED', '', undefined]) {
      assert.throws(() => assertPermissionClass(bad), InvalidValueObject);
      assert.throws(() => assertEgressClass(bad), InvalidValueObject);
    }
  });
});

describe('containsApparentPii (VG-SEC-002 guard)', () => {
  test('apparent personal data is detected', () => {
    assert.equal(containsApparentPii('jane.doe@example.com'), true);
    assert.equal(containsApparentPii('call +1 415 555 0123'), true);
    assert.equal(containsApparentPii('ssn 123-45-6789'), true);
  });

  test('opaque identifiers and ordinary text are not flagged', () => {
    assert.equal(containsApparentPii('subject-0001'), false);
    assert.equal(containsApparentPii('case-2026-000123'), false);
    assert.equal(containsApparentPii('REQUEST_SUBMITTED'), false);
  });
});
