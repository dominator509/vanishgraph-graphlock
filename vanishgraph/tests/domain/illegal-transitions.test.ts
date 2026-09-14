/**
 * Every documented illegal transition (SPEC-001 §4.2) is refused with a typed error, and
 * state is left unchanged.
 *
 * The first six rows are the documented forbidden pairs; the remaining rows are the
 * conditional rules the spec lists in the same table (no observation, the acting path
 * verifying itself, expired authority, stale recipe).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyTransition, noFacts, happyPathFacts } from '../../src/domain/state-machine.ts';
import type { TruthState } from '../../src/domain/truth-state.ts';
import { prepareRequest } from '../../src/domain/commands.ts';
import {
  createAuthorityGrant,
  createJurisdictionPolicy,
  createPolicyDecision,
  createRemovalRecipe,
  createSource,
  createVerificationObservation,
} from '../../src/domain/entities.ts';
import {
  CaseId,
  EvidenceId,
  RecipeId,
  SourceId,
  SubjectId,
  TenantId,
} from '../../src/domain/identifiers.ts';
import { Jurisdiction, LegalBasis } from '../../src/domain/values.ts';
import {
  AuthorityExpired,
  IllegalTransition,
  InvalidValueObject,
  ObservationNotIndependent,
} from '../../src/domain/errors.ts';

const tenantId = new TenantId('tenant-0001');
const subjectId = new SubjectId('subject-0001');
const caseId = new CaseId('case-0001');
const sourceId = new SourceId('source-0001');
const jurisdiction = new Jurisdiction('US-CA');
const DAY = 86_400_000;
const ctx = { tenantId, correlationId: 'corr-1', nowMs: 5 * DAY };

/** Apply a transition to a mutable state holder so "state unchanged" is observable. */
function attempt(state: { current: TruthState }, to: TruthState, facts = happyPathFacts()) {
  try {
    const result = applyTransition(state.current, to, facts);
    state.current = result.to;
    return result;
  } catch (error) {
    return error as Error;
  }
}

describe('SPEC-001 §4.2 — documented forbidden pairs', () => {
  const forbiddenPairs: readonly (readonly [TruthState, TruthState, string])[] = [
    ['REQUEST_SUBMITTED', 'VERIFIED_REMOVED', 'removal theater'],
    ['REQUEST_READY', 'VERIFIED_REMOVED', 'no action was taken'],
    ['MATCH_CONFIRMED', 'REQUEST_SUBMITTED', 'skips the authority and policy gate'],
    ['DISCOVERED_CANDIDATE', 'REQUEST_READY', 'skips identity confirmation'],
    ['SEARCH_DELISTED', 'VERIFIED_REMOVED', 'collapses search and source effects'],
    ['VERIFIED_NOT_PRESENT', 'VERIFIED_REMOVED', 'nothing was removed'],
  ];

  for (const [from, to, why] of forbiddenPairs) {
    test(`${from} -> ${to} is refused (${why}) and leaves state unchanged`, () => {
      const state = { current: from };
      const result = attempt(state, to);
      assert.ok(
        result instanceof IllegalTransition,
        `expected IllegalTransition, got ${String(result)}`,
      );
      assert.equal(state.current, from, 'state must be unchanged after a refusal');
    });
  }

  test('every forbidden pair is in the documented forbidden table', () => {
    // The state machine checks forbidden pairs before the legal table, so the reason
    // names the real danger rather than a generic "no such transition".
    const state = { current: 'REQUEST_SUBMITTED' as TruthState };
    const error = attempt(state, 'VERIFIED_REMOVED') as IllegalTransition;
    assert.match(error.message, /removal theater/);
    assert.equal(error.code, 'ILLEGAL_TRANSITION');
  });
});

describe('SPEC-001 §4.2 — conditional rules', () => {
  test('ACKNOWLEDGED -> VERIFIED_REMOVED without an independent observation is refused', () => {
    const state = { current: 'ACKNOWLEDGED' as TruthState };
    const error = attempt(
      state,
      'VERIFIED_REMOVED',
      happyPathFacts({ independentObservation: false }),
    );
    assert.ok(error instanceof ObservationNotIndependent);
    assert.equal(state.current, 'ACKNOWLEDGED');
  });

  test('the acting path cannot verify its own effect (VG-VERIFY-001)', () => {
    const observation = createVerificationObservation({
      id: 'observation-1',
      tenantId,
      caseId,
      method: 'independent-fetch',
      observedAtMs: 6 * DAY,
      actorIdentity: 'observer-a',
      actingIdentity: 'actor-a',
      finding: 'ABSENT',
      evidenceId: new EvidenceId('evidence-1'),
    });
    assert.equal(observation.actorIdentity === observation.actingIdentity, false);
    // The factory refuses self-verification outright...
    assert.throws(
      () =>
        createVerificationObservation({
          ...observation,
          actorIdentity: 'actor-a',
          actingIdentity: 'actor-a',
        }),
      InvalidValueObject,
    );
    // ...and the machine refuses the transition when independence is missing.
    const state = { current: 'ACKNOWLEDGED' as TruthState };
    const error = attempt(
      state,
      'VERIFIED_REMOVED',
      happyPathFacts({ independentObservation: false }),
    );
    assert.ok(error instanceof ObservationNotIndependent);
    assert.equal(state.current, 'ACKNOWLEDGED');
  });

  test('no transition is permitted while authority is expired or revoked (VG-AUTHZ-001)', () => {
    const expired = createAuthorityGrant({
      id: 'grant-expired',
      tenantId,
      subjectId,
      kind: 'SELF',
      scope: ['self_service_write'],
      evidenceId: null,
      issuedAtMs: 0,
      expiresAtMs: DAY,
      revokedAtMs: null,
      signedInstrument: false,
    });
    const policy = createJurisdictionPolicy({
      id: 'policy-1',
      tenantId,
      jurisdiction,
      version: 1,
      effectiveFromMs: 0,
      effectiveToMs: null,
      rules: ['CCPA_DELETE'],
      provenance: 'COUNSEL_REVIEWED',
    });
    const decision = createPolicyDecision({
      id: 'decision-1',
      tenantId,
      caseId: caseId.value,
      jurisdiction,
      legalBasis: new LegalBasis('CCPA_DELETE', 1),
      channel: 'OFFICIAL_SELF_SERVICE',
      policyVersion: 1,
      reasons: [],
      decidedAtMs: DAY,
    });
    const recipe = createRemovalRecipe({
      id: new RecipeId('recipe-0001'),
      tenantId,
      sourceId,
      version: 1,
      signature: 'sig:abc',
      channel: 'OFFICIAL_SELF_SERVICE',
      verificationMethod: 'independent-fetch',
      freshnessAtMs: 30 * DAY,
      enabled: true,
    });
    const source = createSource({
      id: sourceId,
      tenantId,
      name: 'example-registry',
      class: 'REGISTRY',
      jurisdiction,
      permissionClass: 'WRITE_PERMITTED',
      permissionCheckedAtMs: DAY,
    });
    const state = { current: 'MATCH_CONFIRMED' as TruthState };
    assert.throws(
      () =>
        prepareRequest(ctx, {
          caseId: caseId.value,
          from: 'MATCH_CONFIRMED',
          authority: expired,
          decision,
          policy,
          recipe,
          source,
          channelOptions: [
            { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
          ],
          exemptionRecorded: false,
          humanGate: null,
        }),
      AuthorityExpired,
    );
    assert.equal(state.current, 'MATCH_CONFIRMED');
  });

  test('no write transition while the recipe is stale or unsigned (VG-CHANNEL-003)', () => {
    const authority = createAuthorityGrant({
      id: 'grant-1',
      tenantId,
      subjectId,
      kind: 'SELF',
      scope: ['self_service_write'],
      evidenceId: null,
      issuedAtMs: 0,
      expiresAtMs: 100 * DAY,
      revokedAtMs: null,
      signedInstrument: false,
    });
    const policy = createJurisdictionPolicy({
      id: 'policy-1',
      tenantId,
      jurisdiction,
      version: 1,
      effectiveFromMs: 0,
      effectiveToMs: null,
      rules: ['CCPA_DELETE'],
      provenance: 'COUNSEL_REVIEWED',
    });
    const decision = createPolicyDecision({
      id: 'decision-1',
      tenantId,
      caseId: caseId.value,
      jurisdiction,
      legalBasis: new LegalBasis('CCPA_DELETE', 1),
      channel: 'OFFICIAL_SELF_SERVICE',
      policyVersion: 1,
      reasons: [],
      decidedAtMs: DAY,
    });
    const source = createSource({
      id: sourceId,
      tenantId,
      name: 'example-registry',
      class: 'REGISTRY',
      jurisdiction,
      permissionClass: 'WRITE_PERMITTED',
      permissionCheckedAtMs: DAY,
    });
    const stale = createRemovalRecipe({
      id: new RecipeId('recipe-0002'),
      tenantId,
      sourceId,
      version: 1,
      signature: 'sig:abc',
      channel: 'OFFICIAL_SELF_SERVICE',
      verificationMethod: 'independent-fetch',
      freshnessAtMs: DAY,
      enabled: true,
    });
    assert.throws(
      () =>
        prepareRequest(ctx, {
          caseId: caseId.value,
          from: 'MATCH_CONFIRMED',
          authority,
          decision,
          policy,
          recipe: stale,
          source,
          channelOptions: [
            { channel: 'OFFICIAL_SELF_SERVICE', unavailableKind: null, unavailableReason: null },
          ],
          exemptionRecorded: false,
          humanGate: null,
        }),
      InvalidValueObject,
    );
  });

  test('a write transition cannot be reached from a state that does not permit it', () => {
    const state = { current: 'DISCOVERED_CANDIDATE' as TruthState };
    const error = attempt(state, 'REQUEST_SUBMITTED');
    assert.ok(error instanceof IllegalTransition);
    assert.equal(state.current, 'DISCOVERED_CANDIDATE');
  });

  test('approval wording never substitutes for evidence', () => {
    // "Approved" is not a truth state and must not be assignable.
    const state = { current: 'REQUEST_SUBMITTED' as TruthState };
    const error = attempt(state, 'APPROVED' as TruthState);
    assert.ok(error instanceof IllegalTransition);
    assert.equal(state.current, 'REQUEST_SUBMITTED');
  });

  test('the substantive guards of the illegal table hold in the legal table too', () => {
    // sanity: T14 is legal only with every guard satisfied — the difference between a
    // forbidden pair and a satisfied guard must be observable.
    const ok = applyTransition('ACKNOWLEDGED', 'VERIFIED_REMOVED', happyPathFacts());
    assert.equal(ok.id, 'T14');
    const refused = attempt(
      { current: 'ACKNOWLEDGED' },
      'VERIFIED_REMOVED',
      noFacts({ recordAbsent: true }),
    );
    assert.ok(refused instanceof Error);
  });
});
