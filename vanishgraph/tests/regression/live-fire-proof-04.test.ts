/**
 * LIVE-FIRE-PROOF-04 — Source and search separation (SPEC-000 §5.1, VG-REAPPEAR-001; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE: `SEARCH_DELISTED` and source removal are SEPARATE effects and SEPARATE states. A search result
 * that is delisted says something about a search index; it says nothing about the source of the record, and a system
 * that reported one as the other would tell a data subject their data was deleted when it was merely unlisted.
 *
 * THE REQUIRED NEGATIVE CASE: a delisted search result must never increment a source-removal count and must never render
 * as source deletion. Both halves are asserted here against the facts the domain encodes as DATA, so this suite does not
 * restate the rule in prose — it reads it.
 *
 * LAYER: the domain. These are the non-collapse rules as data (`TRUTH_STATE_FACTS`), and the states themselves
 * (`ALL_TRUTH_STATES`), which is where the separation is decided before any route or report can collapse it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_TRUTH_STATES, TRUTH_STATE_FACTS, type TruthState } from '../../src/domain/truth-state.ts';

/** Every state whose facts claim a verified removal — there must be exactly one. */
const removalClaimants = (): readonly TruthState[] =>
  ALL_TRUTH_STATES.filter((state) => TRUTH_STATE_FACTS[state].assertsVerifiedRemoval);

/** Every state whose facts claim a search delisting — there must be exactly one. */
const delistingClaimants = (): readonly TruthState[] =>
  ALL_TRUTH_STATES.filter((state) => TRUTH_STATE_FACTS[state].assertsSearchDelisting);

describe('LIVE-FIRE-PROOF-04: a delisting is not a removal (SPEC-000 §5.1)', () => {
  test('the eleven states are the canonical set, and the two claims live in exactly one state each', () => {
    assert.equal(ALL_TRUTH_STATES.length, 11, 'SPEC-000 §5 declares eleven states');
    assert.deepEqual(removalClaimants(), ['VERIFIED_REMOVED'], 'only VERIFIED_REMOVED asserts a removal');
    assert.deepEqual(delistingClaimants(), ['SEARCH_DELISTED'], 'only SEARCH_DELISTED asserts a delisting');
    assert.notEqual(removalClaimants()[0], delistingClaimants()[0], 'the two claims are different states');
  });

  test('SEARCH_DELISTED does NOT assert a verified removal — the separation itself', () => {
    const facts = TRUTH_STATE_FACTS.SEARCH_DELISTED;
    assert.equal(facts.assertsSearchDelisting, true, 'it does assert the delisting');
    assert.equal(facts.assertsVerifiedRemoval, false, 'and it must not assert a removal');
  });

  test('NEGATIVE CASE: a delisting never counts as removal progress, and no state claims both', () => {
    // MEASURED, AND IT CORRECTED THIS SUITE: `neverCountsAsProgress` is true for exactly REQUEST_SUBMITTED and
    // ACKNOWLEDGED — the two states that must never be shown as progress toward removal — and NOT for SEARCH_DELISTED,
    // which my first version asserted. The fact that keeps a delisting out of the removal count is the one below: the
    // count is driven by `assertsVerifiedRemoval`, and SEARCH_DELISTED is false there.
    const neverProgress = ALL_TRUTH_STATES.filter((state) => TRUTH_STATE_FACTS[state].neverCountsAsProgress);
    assert.deepEqual([...neverProgress].sort(), ['ACKNOWLEDGED', 'REQUEST_SUBMITTED']);
    assert.equal(
      TRUTH_STATE_FACTS.SEARCH_DELISTED.assertsVerifiedRemoval,
      false,
      'so a delisting cannot increment a source-removal count',
    );
    const both = ALL_TRUTH_STATES.filter(
      (state) => TRUTH_STATE_FACTS[state].assertsVerifiedRemoval && TRUTH_STATE_FACTS[state].assertsSearchDelisting,
    );
    assert.deepEqual(both, [], 'no state may claim both a removal and a delisting');
  });

  test('NEGATIVE CASE: VERIFIED_REMOVED does not assert a delisting either, so the confusion cannot run backwards', () => {
    const facts = TRUTH_STATE_FACTS.VERIFIED_REMOVED;
    assert.equal(facts.assertsVerifiedRemoval, true);
    assert.equal(facts.assertsSearchDelisting, false, 'a removal is not evidence that a search index dropped the page');
  });

  test('a removal is the only state requiring an independent observation, which is what stops it being asserted by a delisting', () => {
    const observers = ALL_TRUTH_STATES.filter((state) => TRUTH_STATE_FACTS[state].requiresIndependentObservation);
    assert.deepEqual(observers, ['VERIFIED_REMOVED'], 'reaching a removal requires an independent observation; nothing else does');
  });

  test('the vocabulary is closed: an ad-hoc word for "gone" is not a state', () => {
    // The collapse this prevents: a caller inventing DELISTED_AND_REMOVED, or reusing a synonym, to report one fact as two.
    // MEASURED: the domain exports the LIST, not a predicate — `isTruthState` is a private helper in
    // src/http/query/strict.ts — so membership is asserted against the list the rule is derived from. My first version
    // called the missing export and the module failed to load.
    const known = new Set<string>(ALL_TRUTH_STATES);
    for (const invented of ['DELISTED', 'REMOVED', 'SEARCH_REMOVED', 'INDEX_DELETED', 'DONE']) {
      assert.equal(known.has(invented), false, `${invented} must not be a truth state`);
    }
    for (const state of ALL_TRUTH_STATES) {
      assert.equal(known.has(state), true, `${state} must be recognised`);
    }
  });
});
