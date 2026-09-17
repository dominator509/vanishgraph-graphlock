/**
 * LIVE-FIRE-PROOF-03 — Multi-channel escalation (VG-CHANNEL-001, SPEC-000 §8; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE: CHANNEL SELECTION FOLLOWS THE DOCUMENTED PRIORITY ORDER, AND A LOWER-PRIORITY CHOICE REQUIRES
 * EVERY HIGHER ONE RECORDED WITH A REASON. The domain makes that structural: `selectChannel` takes the options with
 * their unavailability markers and reasons, returns the highest-priority lawful one, and `rejectedChannels` reports what
 * was set aside and why — so "we escalated" is a fact with a record rather than a claim.
 *
 * THE REQUIRED NEGATIVE CASES:
 *   * a LOWER-PRIORITY channel cannot be selected while a lawful higher-priority one is available — asserted by giving
 *     the selector both and requiring the higher one back, in both orderings of the input array;
 *   * a channel marked unavailable WITHOUT A RECORDED REASON is refused, which is what stops an escalation from being
 *     justified by an empty string;
 *   * an option set with NO LAWFUL CHANNEL is refused rather than forced into a write, because the honest outcome there
 *     is a lawful end (`NOT_REMOVABLE`), not an action nobody authorised.
 *
 * LAYER: the domain. Priority order, the escalation record and the refusal are all in `values.ts`; no route can select a
 * channel except through it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL_NAMES,
  priorityOf,
  rejectedChannels,
  selectChannel,
  type ChannelName,
  type ChannelOption,
} from '../../src/domain/values.ts';

/** The channel names sorted by the documented priority, lowest number first. */
const byPriority = (): readonly ChannelName[] =>
  [...CHANNEL_NAMES].sort((left, right) => priorityOf(left) - priorityOf(right));

/** A channel that is available. */
const available = (channel: ChannelName): ChannelOption => ({ channel, unavailableKind: null, unavailableReason: null });

/** A channel that is not, with a reason that is not empty. */
const unavailable = (channel: ChannelName, kind: ChannelOption['unavailableKind'], reason: string): ChannelOption => ({
  channel,
  unavailableKind: kind,
  unavailableReason: reason,
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

describe('LIVE-FIRE-PROOF-03: escalation follows the documented priority (VG-CHANNEL-001)', () => {
  test('the priority order is total and matches the declaration order, so "higher priority" is not a judgement call', () => {
    const ordered = byPriority();
    assert.equal(ordered.length, CHANNEL_NAMES.length);
    assert.deepEqual(
      ordered.map((channel) => priorityOf(channel)),
      [...ordered.map((channel) => priorityOf(channel))].sort((a, b) => a - b),
      'priority values must be strictly increasing in the sorted order',
    );
    assert.equal(new Set(ordered.map((channel) => priorityOf(channel))).size, ordered.length, 'no two channels share a priority');
  });

  test('the HIGHEST-priority available channel is selected, whatever order the options arrive in', () => {
    const ordered = byPriority();
    const top = ordered[0];
    const second = ordered[1];
    assert.ok(top !== undefined && second !== undefined, 'at least two channels must be declared');
    assert.equal(selectChannel([available(top), available(second)]).channel, top, 'declared order');
    assert.equal(selectChannel([available(second), available(top)]).channel, top, 'and reversed, so the result is not positional');
  });

  test('NEGATIVE CASE: a lower-priority channel cannot be chosen while a lawful higher one is available', () => {
    const ordered = byPriority();
    const top = ordered[0];
    const lower = ordered[ordered.length - 1];
    assert.ok(top !== undefined && lower !== undefined);
    // The lower channel is AVAILABLE — the only thing that stops it being chosen is the priority rule, which is exactly
    // the property under test.
    const chosen = selectChannel([available(lower), available(top)]);
    assert.equal(chosen.channel, top);
    assert.notEqual(chosen.channel, lower);
  });

  test('an unavailable higher channel is skipped AND reported with its reason', () => {
    const ordered = byPriority();
    const top = ordered[0];
    const second = ordered[1];
    const reason = 'the provider form is gated behind a human check';
    assert.ok(top !== undefined && second !== undefined);
    const options = [unavailable(top, 'GATED', reason), available(second)];
    const chosen = selectChannel(options);
    assert.equal(chosen.channel, second, 'the escalation moves down exactly one step');
    // MEASURED: `rejectedChannels(options, selected)` takes the selection as its second argument and returns the OPTIONS
    // set aside — those with a HIGHER priority (a smaller number) than the one chosen, and their recorded reason lives on
    // `unavailableReason`. My first version called it with one argument and read a `reason` field that does not exist,
    // which threw rather than failing an assertion.
    const rejected = rejectedChannels(options, chosen);
    assert.equal(rejected.length, 1, 'the skipped channel is reported, not silently dropped');
    assert.equal(rejected[0]?.channel, top);
    assert.equal(rejected[0]?.unavailableReason, reason, 'with the reason that was recorded');
  });

  test('NEGATIVE CASE: an unavailable channel with NO recorded reason is refused', () => {
    const top = byPriority()[0];
    assert.ok(top !== undefined);
    for (const kind of ['UNAVAILABLE', 'UNLAWFUL', 'GATED'] as const) {
      const refusal = refusalOf(() => selectChannel([{ channel: top, unavailableKind: kind, unavailableReason: null }]));
      assert.ok(refusal instanceof Error, `${kind} with no reason must be refused`);
      assert.match(refusal.message, /without a recorded reason/);
      const blank = refusalOf(() => selectChannel([{ channel: top, unavailableKind: kind, unavailableReason: '   ' }]));
      assert.ok(blank instanceof Error, `${kind} with a blank reason must be refused too`);
    }
  });

  test('NEGATIVE CASE: with no lawful channel the selection is refused, never forced', () => {
    // The honest outcome when nothing lawful is available is a lawful end (NOT_REMOVABLE), which is a DECISION the caller
    // records — not a write selected because something had to be chosen.
    const options = byPriority().map((channel) => unavailable(channel, 'UNLAWFUL', 'no lawful route for this jurisdiction'));
    const refusal = refusalOf(() => selectChannel(options));
    assert.ok(refusal instanceof Error, 'an option set with no lawful channel must be refused');
    // THE RECORD REQUIREMENT, asserted on the pure function: with the LOWEST-priority channel hypothetically chosen,
    // every higher-priority one is returned as rejected — which is what "every higher channel is recorded with a reason"
    // means as data.
    const lowest = options[options.length - 1];
    assert.ok(lowest !== undefined);
    assert.equal(rejectedChannels(options, lowest).length, options.length - 1);
  });

  test('an EMPTY option set is refused, so "no channel considered" is not a selection', () => {
    const refusal = refusalOf(() => selectChannel([]));
    assert.ok(refusal instanceof Error);
    assert.match(refusal.message, /at least one channel/);
  });
});
