/**
 * Forced failure: a stale, unsigned or disabled recipe must fail CLOSED (DOD-014; SPEC-001 §3.4, SPEC-000 §8,
 * VG-CHANNEL-003; EP-007 M3).
 *
 * THE FAILURES THIS FILE MAKES HAPPEN ARE THE THREE WAYS A REMOVAL RECIPE STOPS BEING USABLE — disabled, unsigned, and
 * stale — plus the malformed inputs that must never become a recipe at all. The property asserted is that each one
 * REFUSES at the point of use: a recipe that is past its freshness instant cannot direct a write, because the write it
 * would direct is one nobody can currently justify.
 *
 * WHY ALL THREE AND NOT JUST "EXPIRED": they are separate facts with separate causes — a disabled recipe was turned off
 * deliberately, an unsigned one never had authority, a stale one had it and lost it — and a single "not usable" check
 * that conflated them would refuse for the wrong reason and hide which control fired.
 *
 * WHAT IT DOES NOT PROVE: that a signature is cryptographically valid. Verification needs a key set, and this
 * repository has none (`KeyProvider`/ADR-006 is open), so what is asserted is the PRESENCE line — an unsigned recipe is
 * refused — and not the mathematical one.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertRecipeUsableAt,
  createRemovalRecipe,
  type RemovalRecipe,
} from '../../src/domain/entities.ts';
import { RecipeId, SourceId, TenantId } from '../../src/domain/identifiers.ts';
import { CHANNEL_NAMES, type ChannelName } from '../../src/domain/values.ts';

const TENANT = new TenantId('11111111-1111-4111-8111-111111111111');
const SOURCE = new SourceId('22222222-2222-4222-8222-222222222222');
const RECIPE = new RecipeId('33333333-3333-4333-8333-333333333333');
const NOW = 1_760_000_000_000;
const CHANNEL = (CHANNEL_NAMES[0] ?? 'OFFICIAL_FORM') as ChannelName;

/** A usable recipe, so each case can break exactly one thing. */
function recipe(overrides: Partial<Parameters<typeof createRemovalRecipe>[0]> = {}): RemovalRecipe {
  return createRemovalRecipe({
    id: RECIPE,
    tenantId: TENANT,
    sourceId: SOURCE,
    version: 1,
    signature: 'sig-1',
    channel: CHANNEL,
    verificationMethod: 'FORM_RECEIPT',
    freshnessAtMs: NOW,
    enabled: true,
    ...overrides,
  });
}

/** The refusal an operation produced, or `undefined` when it did not refuse. */
function refusalOf(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('forced failure: a removal recipe that cannot be justified refuses (DOD-014)', () => {
  test('a DISABLED recipe is refused, and the refusal says it is disabled', () => {
    const refusal = refusalOf(() => assertRecipeUsableAt(recipe({ enabled: false }), NOW));
    assert.ok(refusal instanceof Error, 'a disabled recipe must be refused');
    assert.match(refusal.message, /disabled/);
  });

  test('an UNSIGNED recipe is refused, and the refusal says it is unsigned', () => {
    // The construction line refuses a blank signature, so the case is built by emptying it afterwards: a row written
    // before the rule existed, or one edited by hand, is exactly what this guard is for.
    const unsigned: RemovalRecipe = { ...recipe(), signature: '   ' };
    const refusal = refusalOf(() => assertRecipeUsableAt(unsigned, NOW));
    assert.ok(refusal instanceof Error, 'a blank signature must be refused at use');
    assert.match(refusal.message, /unsigned/);
  });

  test('a STALE recipe is refused one millisecond past its freshness instant, and admitted AT it', () => {
    // THE BOUNDARY IS THE ASSERTION: `atMs > freshnessAtMs` refuses, so the instant itself is still usable. A guard
    // that refused at equality would refuse a recipe that is fresh, and one that admitted past it would let a write be
    // directed by a recipe nobody has re-verified.
    const fresh = recipe();
    assert.doesNotThrow(() => assertRecipeUsableAt(fresh, NOW), 'the freshness instant itself is usable');
    const refusal = refusalOf(() => assertRecipeUsableAt(fresh, NOW + 1));
    assert.ok(refusal instanceof Error, 'one millisecond later it is stale');
    assert.match(refusal.message, /stale/);
  });

  test('the CONSTRUCTION line refuses malformed input rather than storing it', () => {
    assert.throws(() => recipe({ version: 0 }), /positive integer/, 'version 0 is not a version');
    assert.throws(() => recipe({ version: 1.5 }), /positive integer/, 'and neither is a fraction');
    assert.throws(() => recipe({ signature: '' }), /signature/, 'an empty signature cannot be stored');
    assert.throws(() => recipe({ verificationMethod: '  ' }), /verificationMethod/, 'nor an empty method');
  });

  test('the ORDER of the three refusals is fixed: disabled is reported before stale', () => {
    // A recipe that is both disabled and stale is refused for being disabled — the deliberate act — rather than being
    // reported as stale, which is the fact nobody chose. The order is asserted so it cannot drift silently.
    const both = { ...recipe({ enabled: false }), freshnessAtMs: NOW - 1 };
    const refusal = refusalOf(() => assertRecipeUsableAt(both, NOW));
    assert.ok(refusal instanceof Error);
    assert.match(refusal.message, /disabled/);
    assert.equal(refusal.message.includes('stale'), false, 'and it must not also claim staleness');
  });

  test('a usable recipe passes, so every refusal above is about the case it breaks', () => {
    const usable = recipe();
    assert.doesNotThrow(() => assertRecipeUsableAt(usable, NOW));
    assert.equal(usable.enabled, true);
    assert.equal(usable.signature, 'sig-1');
    assert.equal(usable.freshnessAtMs, NOW);
  });
});
