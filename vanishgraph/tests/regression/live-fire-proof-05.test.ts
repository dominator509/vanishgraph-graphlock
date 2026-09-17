/**
 * LIVE-FIRE-PROOF-05 — Reappearance monitoring (VG-REAPPEAR-001/002, SPEC-000 §5; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE: `REAPPEARED` LINKS TO THE PRIOR REMOVAL and re-enters the flow with the history preserved. A
 * reappearance is a statement about a specific earlier `VERIFIED_REMOVED` — the page came back after we saw it go — so
 * it can only be reached FROM a state that already asserted a removal, and it must lead back into the working flow
 * rather than jumping straight to another removal.
 *
 * THE REQUIRED NEGATIVE CASE: A FIRST-EVER DISCOVERY IS NEVER LABELLED `REAPPEARED`. That is asserted structurally, from
 * the transition table: no transition into `REAPPEARED` starts from `null` (creation) or from any state other than the
 * two that can legitimately precede it, so there is no path by which a new find can be called a reappearance.
 *
 * LAYER: the domain. The transition table and the state facts are where both properties live; a route or a report can
 * only render what this table permits.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_TRUTH_STATES,
  LEGAL_TRANSITIONS,
  TRUTH_STATE_FACTS,
  type TransitionSpec,
} from '../../src/domain/truth-state.ts';

/** Every legal transition whose destination is the given state. */
const transitionsInto = (state: string): readonly TransitionSpec[] =>
  LEGAL_TRANSITIONS.filter((transition) => transition.to === state);

/** Every legal transition whose origin is the given state. */
const transitionsOutOf = (state: string): readonly TransitionSpec[] =>
  LEGAL_TRANSITIONS.filter((transition) => transition.from === state);

describe('LIVE-FIRE-PROOF-05: a reappearance links to a prior removal (VG-REAPPEAR-001)', () => {
  test('REAPPEARED is reachable ONLY from a verified removal or a delisting, and from no other state', () => {
    const sources = transitionsInto('REAPPEARED')
      .map((transition) => transition.from)
      .sort();
    assert.deepEqual(
      sources,
      ['SEARCH_DELISTED', 'VERIFIED_REMOVED'],
      'a reappearance follows a removal or a delisting, and nothing else',
    );
  });

  test('NEGATIVE CASE: no transition into REAPPEARED starts from creation, so a first find is never a reappearance', () => {
    // `from: null` is a creation transition (T1/T2). A reappearance must never be one: the label asserts a history that
    // a first discovery does not have.
    const creations = LEGAL_TRANSITIONS.filter((transition) => transition.from === null).map((transition) => transition.to);
    assert.deepEqual([...creations].sort(), ['DISCOVERED_CANDIDATE', 'VERIFIED_NOT_PRESENT'], 'only two states may be created');
    assert.equal(creations.includes('REAPPEARED'), false, 'REAPPEARED must not be creatable');
    assert.equal(
      transitionsInto('REAPPEARED').some((transition) => transition.from === null),
      false,
      'and no transition into it may claim creation',
    );
  });

  test('REAPPEARED RE-ENTERS the flow: it is not a terminal state and it leads back to work, not to a removal', () => {
    assert.equal(TRUTH_STATE_FACTS.REAPPEARED.terminalForNow, false, 'a reappearance re-opens the case rather than closing it');
    assert.equal(TRUTH_STATE_FACTS.REAPPEARED.assertsVerifiedRemoval, false, 'and it asserts no removal of its own');
    const destinations = transitionsOutOf('REAPPEARED')
      .map((transition) => transition.to)
      .sort();
    assert.deepEqual(
      destinations,
      ['NOT_REMOVABLE', 'REQUEST_READY'],
      'from a reappearance the flow goes back to requesting removal or to a lawful end, never straight to a removal',
    );
    assert.equal(destinations.includes('VERIFIED_REMOVED'), false, 'a reappearance cannot assert a new removal by itself');
  });

  test('every transition carries a guard and named evidence, so a reappearance cannot be recorded without them', () => {
    // The history-preservation half: the transition that records a reappearance must produce evidence, which is what a
    // later reader follows back to the removal it links to.
    for (const transition of transitionsInto('REAPPEARED')) {
      assert.ok(transition.guard !== undefined, `${transition.id} must carry a guard`);
      assert.ok(transition.evidence.trim().length > 0, `${transition.id} must name the evidence it produces`);
    }
    const ids = LEGAL_TRANSITIONS.map((transition) => transition.id);
    assert.equal(new Set(ids).size, ids.length, 'transition ids are unique, so evidence can be cited by id');
    assert.equal(LEGAL_TRANSITIONS.length, 21, 'SPEC-001 §4.1 declares twenty-one transitions');
  });

  test('the removal that a reappearance links to is the only state that asserts removal, so the link is unambiguous', () => {
    const removalStates = ALL_TRUTH_STATES.filter((state) => TRUTH_STATE_FACTS[state].assertsVerifiedRemoval);
    assert.deepEqual(removalStates, ['VERIFIED_REMOVED']);
    assert.equal(TRUTH_STATE_FACTS.VERIFIED_REMOVED.terminalForNow, true, 'the removal is a stopping point, which is why a return is notable');
  });
});
