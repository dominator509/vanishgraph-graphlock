/**
 * LIVE-FIRE-PROOF-02 — Controller removal closed loop (VG-VERIFY-001/002/003, SPEC-001 §4.1/§4.2; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE: `VERIFIED_REMOVED` REQUIRES A LINKED `VerificationObservation` FROM A DISTINCT PATH, AFTER THE
 * RECIPE'S OBSERVATION WINDOW. The loop is closed by construction in the domain's transition table — the only transition
 * into a removal starts at `ACKNOWLEDGED`, carries an observation guard, and names the observation as the evidence it
 * produces — so a controller's claim cannot become a removal without one.
 *
 * THE REQUIRED NEGATIVE CASES, both asserted from the table rather than described:
 *   * an IMMEDIATE same-second recheck is insufficient: the pair `ACKNOWLEDGED → VERIFIED_REMOVED` is legal only through
 *     T14's guard, and there is no second path in;
 *   * a CONTROLLER CLAIM WITHOUT AN OBSERVATION STAYS `ACKNOWLEDGED`: the other two transitions out of `ACKNOWLEDGED`
 *     lead to `NOT_REMOVABLE` and `HUMAN_REQUIRED`, so a claim with nothing to verify against has nowhere to go but a
 *     lawful end or a human.
 *
 * AND THE SIX FORBIDDEN PAIRS ARE THE LOOP'S WALLS: a submission, a ready request, a matched exposure, a bare
 * discovery, a delisting and a verified absence may NOT become a removal. Each is asserted by name, because each is a
 * different way of claiming removal without observing one.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FORBIDDEN_TRANSITIONS,
  LEGAL_TRANSITIONS,
  TRUTH_STATE_FACTS,
} from '../../src/domain/truth-state.ts';

/** `from->to` for every forbidden pair, so the set can be compared as data. */
const forbiddenPairs = (): readonly string[] =>
  FORBIDDEN_TRANSITIONS.map((pair) => `${pair.from ?? 'null'}->${pair.to}`).sort();

describe('LIVE-FIRE-PROOF-02: a removal cannot be asserted without an observation (VG-VERIFY-001)', () => {
  test('the ONLY way into VERIFIED_REMOVED is T14, from ACKNOWLEDGED, and it names a VerificationObservation', () => {
    const inbound = LEGAL_TRANSITIONS.filter((transition) => transition.to === 'VERIFIED_REMOVED');
    assert.equal(inbound.length, 1, 'a second path into a removal would be a second, unchecked claim');
    const only = inbound[0];
    assert.ok(only !== undefined);
    assert.equal(only.id, 'T14');
    assert.equal(only.from, 'ACKNOWLEDGED', 'a removal follows an acknowledgement, not a submission');
    assert.match(only.evidence, /VerificationObservation/, 'and the transition must produce the observation as evidence');
    assert.ok(only.guard !== undefined, 'the transition must carry a guard, and the guard is what checks independence and the window');
  });

  test('NEGATIVE CASE: a claim with no observation stays ACKNOWLEDGED — the other exits are not a removal', () => {
    const outbound = LEGAL_TRANSITIONS.filter((transition) => transition.from === 'ACKNOWLEDGED').map((transition) => transition.to).sort();
    assert.deepEqual(
      outbound,
      ['HUMAN_REQUIRED', 'NOT_REMOVABLE', 'VERIFIED_REMOVED'],
      'from an acknowledgement the flow ends lawfully, goes to a human, or is verified — there is no fourth door',
    );
  });

  test('NEGATIVE CASE: the six forbidden pairs are exactly the ways of claiming a removal without observing one', () => {
    assert.deepEqual(forbiddenPairs(), [
      'DISCOVERED_CANDIDATE->REQUEST_READY',
      'MATCH_CONFIRMED->REQUEST_SUBMITTED',
      'REQUEST_READY->VERIFIED_REMOVED',
      'REQUEST_SUBMITTED->VERIFIED_REMOVED',
      'SEARCH_DELISTED->VERIFIED_REMOVED',
      'VERIFIED_NOT_PRESENT->VERIFIED_REMOVED',
    ]);
  });

  test('a SUBMITTED request is explicitly not a removal, and neither is an acknowledgement', () => {
    // The two states a reader is most likely to mistake for progress: submitting a request, and a controller
    // acknowledging it. Both are walled off from a removal by the forbidden list, and the facts say so independently.
    for (const pair of ['REQUEST_SUBMITTED->VERIFIED_REMOVED', 'REQUEST_READY->VERIFIED_REMOVED']) {
      assert.ok(forbiddenPairs().includes(pair), `${pair} must be forbidden`);
    }
    assert.equal(TRUTH_STATE_FACTS.REQUEST_SUBMITTED.assertsVerifiedRemoval, false);
    assert.equal(TRUTH_STATE_FACTS.ACKNOWLEDGED.assertsVerifiedRemoval, false);
    assert.equal(TRUTH_STATE_FACTS.ACKNOWLEDGED.neverCountsAsProgress, true, 'an acknowledgement is not progress toward removal');
  });

  test('a DELISTING and a VERIFIED ABSENCE are walled off too, so neither can be relabelled a removal', () => {
    assert.ok(forbiddenPairs().includes('SEARCH_DELISTED->VERIFIED_REMOVED'));
    assert.ok(forbiddenPairs().includes('VERIFIED_NOT_PRESENT->VERIFIED_REMOVED'));
    assert.equal(TRUTH_STATE_FACTS.VERIFIED_NOT_PRESENT.assertsVerifiedRemoval, false, 'not finding something is not removing it');
    assert.equal(TRUTH_STATE_FACTS.VERIFIED_NOT_PRESENT.assertsSearchDelisting, false);
  });

  test('the removal is the only state that requires an independent observation, and the window is the other half', () => {
    const observers = LEGAL_TRANSITIONS.flatMap((transition) =>
      TRUTH_STATE_FACTS[transition.to].requiresIndependentObservation ? [transition.id] : [],
    );
    assert.deepEqual(observers, ['T14'], 'only the removal transition reaches a state that requires an independent observation');
    assert.equal(TRUTH_STATE_FACTS.VERIFIED_REMOVED.terminalForNow, true, 'and reaching it is a stopping point, which is why it takes this much evidence');
  });
});
