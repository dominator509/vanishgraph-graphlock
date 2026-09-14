/**
 * State-machine conformance tests (SPEC-001 §4).
 *
 * These tests are the executable form of the specification. They cover:
 *   1. every legal transition T1..T21 succeeds with its guard satisfied
 *   2. every legal transition is refused when its guard is not satisfied
 *   3. every forbidden pair is refused with its specific reason
 *   4. the non-collapse rules of SPEC-000 §5.1
 *
 * A test suite that only covered the happy path would be non-discriminating
 * (DOD-018), which is why (2) and (3) are mandatory here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTransition,
  applyInitialState,
  availableTransitions,
  findTransition,
  forbiddenReason,
  initialStateSpecs,
  isTruthState,
  assertSingleState,
  happyPathFacts,
  noFacts,
  legalTransitionsFrom,
} from '../../src/domain/state-machine.ts';
import {
  ALL_TRUTH_STATES,
  FORBIDDEN_TRANSITIONS,
  LEGAL_TRANSITIONS,
  TRUTH_STATE_FACTS,
  type TransitionFacts,
} from '../../src/domain/truth-state.ts';
import {
  DomainError,
  GuardNotSatisfied,
  IllegalTransition,
  ObservationNotIndependent,
} from '../../src/domain/errors.ts';

describe('SPEC-000 §5 — the eleven truth states', () => {
  test('exactly eleven states exist and they are the canonical set', () => {
    assert.equal(ALL_TRUTH_STATES.length, 11);
    assert.equal(new Set(ALL_TRUTH_STATES).size, 11, 'states must be unique');
  });

  test('every state has recorded non-collapse facts', () => {
    for (const state of ALL_TRUTH_STATES) {
      assert.ok(TRUTH_STATE_FACTS[state], `missing facts for ${state}`);
    }
  });

  test('ONLY VERIFIED_REMOVED asserts a verified removal', () => {
    const asserting = ALL_TRUTH_STATES.filter((s) => TRUTH_STATE_FACTS[s].assertsVerifiedRemoval);
    assert.deepEqual(asserting, ['VERIFIED_REMOVED']);
  });

  test('ONLY SEARCH_DELISTED asserts search delisting, and it never means removal', () => {
    const delisting = ALL_TRUTH_STATES.filter((s) => TRUTH_STATE_FACTS[s].assertsSearchDelisting);
    assert.deepEqual(delisting, ['SEARCH_DELISTED']);
    assert.equal(
      TRUTH_STATE_FACTS.SEARCH_DELISTED.assertsVerifiedRemoval,
      false,
      'search delisting must never be reported as source removal (SPEC-000 5.1)',
    );
  });

  test('REQUEST_SUBMITTED and ACKNOWLEDGED never count as progress toward removal', () => {
    assert.equal(TRUTH_STATE_FACTS.REQUEST_SUBMITTED.neverCountsAsProgress, true);
    assert.equal(TRUTH_STATE_FACTS.ACKNOWLEDGED.neverCountsAsProgress, true);
  });

  test('HUMAN_REQUIRED and NOT_REMOVABLE are legitimate outcomes, not failures', () => {
    assert.equal(TRUTH_STATE_FACTS.HUMAN_REQUIRED.isLegitimateOutcome, true);
    assert.equal(TRUTH_STATE_FACTS.NOT_REMOVABLE.isLegitimateOutcome, true);
  });

  test('VERIFIED_REMOVED is the only state requiring an independent observation', () => {
    const requiring = ALL_TRUTH_STATES.filter(
      (s) => TRUTH_STATE_FACTS[s].requiresIndependentObservation,
    );
    assert.deepEqual(requiring, ['VERIFIED_REMOVED']);
  });

  test('isTruthState rejects non-members including ad-hoc success words', () => {
    assert.equal(isTruthState('VERIFIED_REMOVED'), true);
    for (const bad of ['DONE', 'COMPLETE', 'SUCCESS', 'REMOVED', 'verified_removed', '', null, 42]) {
      assert.equal(isTruthState(bad), false, `${String(bad)} must not be a truth state`);
    }
  });
});

/** Minimal facts that satisfy each transition's guard, keyed by transition id. */
const FACTS_FOR: Record<string, Partial<TransitionFacts>> = {
  T1: { sourceRecordObserved: true },
  T2: { scanCoverageSufficient: true },
  T3: { confidenceBasisRecorded: true, confidenceAtThreshold: true },
  T4: { subjectMatchDisproved: true },
  T5: {
    authorityValid: true,
    policyDecisionComplete: true,
    recipeSignedAndFresh: true,
    channelPermitted: true,
  },
  T6: { exemptionRecorded: true },
  T7: { humanGateDetected: true },
  T8: {
    authorityValid: true,
    idempotencyKeyAssigned: true,
    budgetAvailable: true,
    recipeSignedAndFresh: true,
    channelPermitted: true,
  },
  T9: { humanGateDetected: true },
  T10: { exemptionRecorded: true },
  T11: { controllerResponded: true },
  T12: { humanGateDetected: true },
  T13: { exemptionRecorded: true },
  T14: {
    independentObservation: true,
    observationWindowMet: true,
    verificationMethodMatches: true,
    recordAbsent: true,
  },
  T15: { lawfulRefusalFinal: true },
  T16: { humanGateDetected: true },
  T17: { recordPresentAgain: true },
  T18: {
    freshAuthorityPolicyRecipe: true,
    authorityValid: true,
    policyDecisionComplete: true,
    recipeSignedAndFresh: true,
  },
  T19: { exemptionRecorded: true },
  T20: { recordPresentAgain: true },
  T21: { searchEngineSource: true, delistingObserved: true },
};

describe('SPEC-001 §4.1 — every legal transition succeeds with its guard satisfied', () => {
  test('the table contains exactly 21 transitions, T1..T21', () => {
    assert.equal(LEGAL_TRANSITIONS.length, 21);
    const ids = LEGAL_TRANSITIONS.map((t) => t.id);
    assert.deepEqual(ids, Array.from({ length: 21 }, (_, i) => `T${i + 1}`));
  });

  for (const spec of LEGAL_TRANSITIONS) {
    test(`${spec.id}: ${spec.from ?? '(initial)'} -> ${spec.to} succeeds and yields evidence`, () => {
      const facts = noFacts(FACTS_FOR[spec.id] ?? {});
      const result =
        spec.from === null
          ? applyInitialState(spec.to, facts)
          : applyTransition(spec.from, spec.to, facts);

      assert.equal(result.id, spec.id);
      assert.equal(result.to, spec.to);
      assert.ok(result.evidence.length > 0, 'a transition must name its evidence');
    });

    test(`${spec.id}: refused when its guard is not satisfied`, () => {
      // Everything false: no guard in the table may be satisfied by an empty fact set.
      const bare = noFacts();
      assert.throws(
        () =>
          spec.from === null
            ? applyInitialState(spec.to, bare)
            : applyTransition(spec.from, spec.to, bare),
        // Any typed DomainError is an acceptable refusal. T14 additionally
        // prefers the specific ObservationNotIndependent diagnosis, which is
        // stricter than GuardNotSatisfied rather than a deviation from it.
        (err: unknown) => err instanceof DomainError,
        `${spec.id} must not fire with no facts`,
      );
    });
  }

  test('no guard is satisfied by an all-false fact set (guards are non-vacuous)', () => {
    const bare = noFacts();
    for (const spec of LEGAL_TRANSITIONS) {
      assert.equal(
        spec.guard.satisfiedBy(bare),
        false,
        `${spec.id} guard is vacuously true — it would fire without evidence`,
      );
    }
  });
});

describe('SPEC-001 §4.2 — forbidden transitions are refused with their reason', () => {
  test('the six documented forbidden pairs are all present in the table', () => {
    assert.equal(FORBIDDEN_TRANSITIONS.length, 6);
  });

  for (const forbidden of FORBIDDEN_TRANSITIONS) {
    test(`${forbidden.from} -> ${forbidden.to} is refused and names the danger`, () => {
      const reason = forbiddenReason(forbidden.from, forbidden.to);
      assert.equal(reason, forbidden.reason);

      assert.throws(
        () => applyTransition(forbidden.from, forbidden.to, happyPathFacts()),
        (err: unknown) => {
          assert.ok(err instanceof IllegalTransition, 'must be an IllegalTransition');
          assert.match(err.message, /Illegal transition/);
          assert.ok(
            err.message.includes(forbidden.reason),
            'the error must name the specific reason, not a generic message',
          );
          return true;
        },
        'must be refused even with every happy-path fact set true',
      );
    });
  }

  test('removal theater is refused even when every other fact is satisfied', () => {
    // This is the single most important negative test in the suite: a submitted
    // request plus a cooperative-looking world still cannot become "removed".
    assert.throws(
      () => applyTransition('REQUEST_SUBMITTED', 'VERIFIED_REMOVED', happyPathFacts()),
      IllegalTransition,
    );
  });

  test('an unlisted pair is refused as non-existent', () => {
    assert.throws(
      () => applyTransition('DISCOVERED_CANDIDATE', 'ACKNOWLEDGED', happyPathFacts()),
      (err: unknown) =>
        err instanceof IllegalTransition && /no such transition/.test(err.message),
    );
  });
});

describe('SPEC-001 §4.2 — the independent-observation guard', () => {
  test('T14 is refused with ObservationNotIndependent when only independence is missing', () => {
    const facts = noFacts({
      observationWindowMet: true,
      verificationMethodMatches: true,
      recordAbsent: true,
      independentObservation: false,
    });
    assert.throws(
      () => applyTransition('ACKNOWLEDGED', 'VERIFIED_REMOVED', facts),
      (err: unknown) => err instanceof ObservationNotIndependent,
      'self-verification must produce the specific independence error',
    );
  });

  test('T14 succeeds once the observation is independent', () => {
    const facts = noFacts({
      independentObservation: true,
      observationWindowMet: true,
      verificationMethodMatches: true,
      recordAbsent: true,
    });
    const result = applyTransition('ACKNOWLEDGED', 'VERIFIED_REMOVED', facts);
    assert.equal(result.to, 'VERIFIED_REMOVED');
    assert.equal(result.evidence, 'VerificationObservation');
  });

  test('a missing window is refused even when the observation is independent', () => {
    const facts = noFacts({
      independentObservation: true,
      observationWindowMet: false,
      verificationMethodMatches: true,
      recordAbsent: true,
    });
    assert.throws(
      () => applyTransition('ACKNOWLEDGED', 'VERIFIED_REMOVED', facts),
      GuardNotSatisfied,
    );
  });
});

describe('SPEC-001 §4.3 — state machine invariants', () => {
  test('SM-1: exactly one current truth state may be asserted', () => {
    assert.doesNotThrow(() => assertSingleState(['MATCH_CONFIRMED']));
    assert.throws(() => assertSingleState([]));
    assert.throws(() => assertSingleState(['MATCH_CONFIRMED', 'VERIFIED_REMOVED']));
  });

  test('SM-2/SM-3: every transition names evidence, so audit has something to record', () => {
    for (const spec of LEGAL_TRANSITIONS) {
      assert.ok(spec.evidence.trim().length > 0, `${spec.id} must name required evidence`);
    }
  });

  test('SM-4: a verified removal is revocable by REAPPEARED', () => {
    const spec = findTransition('VERIFIED_REMOVED', 'REAPPEARED');
    assert.ok(spec, 'monitoring is pointless if removal can never be revisited');
    assert.equal(spec.id, 'T17');
  });

  test('SM-6: state cannot be set arbitrarily — only listed transitions apply', () => {
    for (const from of ALL_TRUTH_STATES) {
      for (const to of ALL_TRUTH_STATES) {
        const legal = findTransition(from, to);
        const forbidden = forbiddenReason(from, to);
        if (legal === undefined && forbidden === undefined) {
          assert.throws(
            () => applyTransition(from, to, happyPathFacts()),
            IllegalTransition,
            `${from} -> ${to} is not in the table and must be refused`,
          );
        }
      }
    }
  });

  test('initial states are exactly T1 and T2', () => {
    const initials = initialStateSpecs().map((s) => `${s.id}:${s.to}`);
    assert.deepEqual(initials, ['T1:DISCOVERED_CANDIDATE', 'T2:VERIFIED_NOT_PRESENT']);
  });
});

describe('availableTransitions reports only evidence-backed options', () => {
  test('a fully-satisfied REQUEST_READY offers submission, human gate and non-removability', () => {
    const facts = noFacts({
      authorityValid: true,
      policyDecisionComplete: true,
      recipeSignedAndFresh: true,
      channelPermitted: true,
      idempotencyKeyAssigned: true,
      budgetAvailable: true,
      humanGateDetected: true,
      exemptionRecorded: true,
    });
    const targets = availableTransitions('REQUEST_READY', facts)
      .map((t) => t.to)
      .sort();
    assert.deepEqual(targets, ['HUMAN_REQUIRED', 'NOT_REMOVABLE', 'REQUEST_SUBMITTED']);
  });

  test('with nothing satisfied, no transition is offered', () => {
    assert.equal(availableTransitions('MATCH_CONFIRMED', noFacts()).length, 0);
    assert.equal(legalTransitionsFrom('MATCH_CONFIRMED').length, 4);
  });
});
