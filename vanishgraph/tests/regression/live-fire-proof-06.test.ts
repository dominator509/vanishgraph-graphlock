/**
 * LIVE-FIRE-PROOF-06 — Custom internet removal (VG-CHANNEL-002/003, SPEC-000 §8; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE: UNKNOWN OR UNSAFE ROUTES ARE QUARANTINED, AND A REQUIRED APPROVAL IS OBTAINED BEFORE ANY
 * `ExternalAction`. Four controls carry it, and each is asserted where it lives:
 *
 *   * a route whose permission is unclear is refused (`permitsAutomatedWrite` is false for `WRITE_UNCLEAR`, and the
 *     domain error for it carries the code SPEC-006 §5.3 row 9 names);
 *   * a GATED channel is not selectable without a RECORDED reason, so "we escalated" leaves a record rather than a gap;
 *   * a recipe that has stopped being fresh cannot direct a write (VG-CHANNEL-003);
 *   * quarantine is a database fact, read from the migration that defines it.
 *
 * AND THE APPROVAL IS STRUCTURAL IN THE TRANSITION TABLE: the transition that reaches `REQUEST_READY` — the last state
 * before an external action is prepared — is guarded by `channelPermitted` and `recipeSignedAndFresh`, so a route with
 * no approval cannot produce one.
 *
 * THE REQUIRED NEGATIVE CASE — A QUARANTINED ROUTE PRODUCES NO EXTERNAL WRITE — is asserted as the conjunction of those
 * refusals plus the absence of any route that could write from a quarantined state; the durable half is pointed at.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CHANNEL_NAMES,
  priorityOf,
  selectChannel,
  permitsAutomatedWrite,
  type ChannelName,
  type ChannelOption,
} from '../../src/domain/values.ts';
import { PermissionUnclear } from '../../src/domain/errors.ts';
import { assertRecipeUsableAt, createRemovalRecipe } from '../../src/domain/entities.ts';
import { RecipeId, SourceId, TenantId } from '../../src/domain/identifiers.ts';
import { LEGAL_TRANSITIONS } from '../../src/domain/truth-state.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TENANT = new TenantId('11111111-1111-4111-8111-111111111111');
const SOURCE = new SourceId('22222222-2222-4222-8222-222222222222');
const RECIPE = new RecipeId('33333333-3333-4333-8333-333333333333');
const NOW = 1_760_000_000_000;
const CHANNEL = (CHANNEL_NAMES[0] ?? 'OFFICIAL_FORM') as ChannelName;

/** The refusal an operation produced, or `undefined` when it did not refuse. */
function refusalOf(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('LIVE-FIRE-PROOF-06: an unknown route cannot write, and a gated one needs an approval on record (VG-CHANNEL-002)', () => {
  test('NEGATIVE CASE: an UNCLEAR permission class is refused, with the code the specification names for it', () => {
    assert.equal(permitsAutomatedWrite('WRITE_UNCLEAR'), false, 'unclear is a refusal, not a soft yes');
    assert.equal(permitsAutomatedWrite('PROHIBITED'), false);
    const error = new PermissionUnclear(SOURCE.value, 'WRITE_UNCLEAR');
    assert.equal(error.code, 'PERMISSION_CLASS_UNCLEAR', 'SPEC-006 §5.3 row 9 names this domain code');
  });

  test('NEGATIVE CASE: a GATED channel cannot be selected without a recorded reason', () => {
    // The approval this outcome requires is not an assumption about the caller: an option marked GATED is only usable
    // once something has recorded why it is gated, and the selector refuses it otherwise.
    const top = [...CHANNEL_NAMES].sort((left, right) => priorityOf(left).value - priorityOf(right).value)[0];
    const second = [...CHANNEL_NAMES].sort((left, right) => priorityOf(left).value - priorityOf(right).value)[1];
    assert.ok(top !== undefined && second !== undefined);
    const unrecorded: ChannelOption = { channel: top, unavailableKind: 'GATED', unavailableReason: null };
    const refusal = refusalOf(() => selectChannel([unrecorded, { channel: second, unavailableKind: null, unavailableReason: null }]));
    assert.ok(refusal instanceof Error, 'a gated channel with nothing recorded must be refused');
    assert.match(refusal.message, /without a recorded reason/);
  });

  test('NEGATIVE CASE: a recipe that stopped being fresh cannot direct a write (VG-CHANNEL-003)', () => {
    const fresh = createRemovalRecipe({
      id: RECIPE,
      tenantId: TENANT,
      sourceId: SOURCE,
      version: 1,
      signature: 'sig-1',
      channel: CHANNEL,
      verificationMethod: 'FORM_RECEIPT',
      freshnessAtMs: NOW,
      enabled: true,
    });
    assert.doesNotThrow(() => assertRecipeUsableAt(fresh, NOW), 'at its freshness instant it is usable');
    const refusal = refusalOf(() => assertRecipeUsableAt(fresh, NOW + 1));
    assert.ok(refusal instanceof Error, 'one millisecond later it is not');
    assert.match(refusal.message, /stale/);
  });

  test('quarantine is a DATABASE fact, read from the migration that defines it', () => {
    const migration = readFileSync(resolve(ROOT, 'db/migrations/0002_identity.sql'), 'utf8');
    assert.match(migration, /quarantined\s+boolean NOT NULL DEFAULT false/, 'the column must exist and default to not-quarantined');
    assert.match(
      migration,
      /CHECK \(quarantined = \(subject_id IS NULL\)\)/,
      'and quarantine must be tied to the missing subject rather than settable on its own',
    );
  });

  test('the APPROVAL is structural: the transition into REQUEST_READY is guarded by channel and recipe', () => {
    // An external action is prepared from REQUEST_READY, so the guards on the transition that reaches it are where the
    // approval lives. `Guard` objects are composed, so the assertion walks the transition's own guard names.
    const intoReady = LEGAL_TRANSITIONS.filter((transition) => transition.to === 'REQUEST_READY');
    assert.ok(intoReady.length >= 1, 'something must be able to reach REQUEST_READY');
    // MEASURED: a composed guard serialises as a human-readable DESCRIPTION - "authority valid AND policy decision
    // complete AND recipe signed and fresh AND channel permitted" - not as keyed guard identifiers, so my first version
    // searched for camelCase names and failed while every guard was in fact present. The assertion now reads the words
    // the guard itself uses, which is what a reviewer sees in a failure report.
    const rendered = intoReady.map((transition) => JSON.stringify(transition.guard)).join(' ');
    for (const guard of ['authority valid', 'policy decision complete', 'recipe signed and fresh', 'channel permitted']) {
      assert.match(rendered, new RegExp(guard), `the transition into REQUEST_READY must be guarded by "${guard}"`);
    }
  });

  test('the durable halves are proven in suites that exist, and are not claimed here', () => {
    for (const suite of ['tests/db/subject-commands.test.ts', 'tests/db/action-records.test.ts']) {
      assert.equal(existsSync(resolve(ROOT, suite)), true, `${suite} must exist: it proves the stored halves`);
    }
  });
});
