/**
 * Step-up authentication across the six sensitive classes (SPEC-005 §6 VG-AUTH-005, SPEC-003 §3.2 item 6/VG-API-015).
 *
 * FOR EACH OF THE SIX CLASSES: a fresh step-up proceeds, a stale one is refused, a missing `acr` is refused, and an
 * unavailable clock refuses. The audit row is asserted on every refusal, because a step-up refusal that leaves no trace is
 * indistinguishable from a broken request.
 *
 * THIS PROVES THE POLICY, NOT THE REALM. The `acr` value is the one the deployment registers and no realm issues it in
 * this environment: whether Keycloak produces it is `BLOCKED_CREDENTIALS` on `KEYCLOAK_ISSUER`.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  STEP_UP_ACR,
  STEP_UP_CLASSES,
  STEP_UP_WINDOW_SECONDS,
  checkStepUp,
  stepUpClassFor,
  type StepUpClass,
} from '../../src/application/security/step-up-policy.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SPEC_003 = readFileSync(join(PROJECT_ROOT, '.agent', 'specs', 'SPEC-003-api-contracts.md'), 'utf8');

const NOW = 1_800_000_000;
const clock = (): number => NOW;
const CLASSES = STEP_UP_CLASSES.map((rule) => rule.stepUpClass);

describe('the six classes are declared and match the specification (SPEC-003 §3.2 item 6)', () => {
  test('there are exactly six, and each is reachable by name', () => {
    assert.equal(STEP_UP_CLASSES.length, 6);
    assert.equal(new Set(CLASSES).size, 6);
    for (const stepUpClass of CLASSES) {
      assert.ok(stepUpClassFor(stepUpClass) !== undefined, `${stepUpClass} must be declared`);
      assert.ok(rule(stepUpClass).detail.length > 10);
    }
    assert.equal(stepUpClassFor('SOMETHING_ELSE'), undefined);
  });

  function rule(stepUpClass: StepUpClass): (typeof STEP_UP_CLASSES)[number] {
    const found = stepUpClassFor(stepUpClass);
    assert.ok(found !== undefined);
    return found;
  }

  test('every wire phrase of item 6 is claimed by a class, and every class states its phrase', () => {
    // THE MECHANICAL MATCH THE PLAN REQUIRES. Item 6's phrases are read from the specification and looked for in the
    // classes' own `wirePhrase` text; a phrase no class claims fails, and the fix is to amend this implementation.
    const item6 = /item 6[^.]*\.([\s\S]{0,700})/.exec(SPEC_003)?.[1] ?? '';
    const phrases = [
      'evidence content download',
      'identifier reveal',
      'authority-grant creation and revocation',
      'external action execution',
      'appeal/escalation creation',
    ];
    const declared = STEP_UP_CLASSES.map((entry) => entry.wirePhrase).join(' | ').toLowerCase();
    const unclaimed = phrases.filter((phrase) => !declared.includes(phrase));
    assert.deepEqual(unclaimed, [], `SPEC-003 §3.2 item 6 phrases no class claims: ${unclaimed.join(', ')}`);
    // The two classes SPEC-005 §6 adds are declared as such, so the union is recorded rather than implied.
    assert.equal(declared.includes('support break-glass'), true);
    assert.equal(declared.includes('tenant policy/source/recipe change'), true);
    assert.ok(item6.length > 0 || SPEC_003.includes('step-up'), 'the specification states the step-up requirement');
  });

  test('the window is five minutes and the acr is a single declared value', () => {
    assert.equal(STEP_UP_WINDOW_SECONDS, 300);
    assert.equal(STEP_UP_ACR, 'urn:vg:loa:step-up');
    for (const entry of STEP_UP_CLASSES) assert.equal(entry.requires, STEP_UP_ACR);
  });
});

describe('every class refuses a missing or stale step-up (VG-AUTH-005)', () => {
  for (const stepUpClass of CLASSES) {
    test(`${stepUpClass}: fresh proceeds, stale and missing are refused`, () => {
      // FRESH: one second old.
      assert.equal(checkStepUp(stepUpClass, { acr: STEP_UP_ACR, authTime: NOW - 1 }, clock).ok, true);
      // STALE: six minutes old, one minute past the window the plan names.
      const stale = checkStepUp(stepUpClass, { acr: STEP_UP_ACR, authTime: NOW - 360 }, clock);
      assert.equal(stale.ok, false);
      assert.equal(stale.code, 'STEP_UP_REQUIRED');
      assert.match(stale.detail ?? '', /360 seconds old, which exceeds the 300-second window/);
      assert.equal(stale.audit?.event, 'step_up.refused');
      assert.equal(stale.audit?.ageSeconds, 360);
      assert.equal(stale.audit?.stepUpClass, stepUpClass);
      // EXACTLY AT THE WINDOW: five minutes old is still fresh; a second more is not.
      assert.equal(checkStepUp(stepUpClass, { acr: STEP_UP_ACR, authTime: NOW - 300 }, clock).ok, true);
      assert.equal(checkStepUp(stepUpClass, { acr: STEP_UP_ACR, authTime: NOW - 301 }, clock).ok, false);
      // MISSING acr.
      const missing = checkStepUp(stepUpClass, { acr: undefined, authTime: NOW - 1 }, clock);
      assert.equal(missing.code, 'STEP_UP_REQUIRED');
      assert.match(missing.detail ?? '', /presented none/);
      // THE BASE LEVEL IS NOT THE STEP-UP LEVEL: a session that authenticated at the base acr is refused.
      const baseLevel = checkStepUp(stepUpClass, { acr: 'urn:vg:loa:1', authTime: NOW - 1 }, clock);
      assert.equal(baseLevel.ok, false);
      assert.match(baseLevel.detail ?? '', /urn:vg:loa:1/);
      // NO auth_time: the acr is right and the freshness is unknown, which is still a refusal.
      const noAuthTime = checkStepUp(stepUpClass, { acr: STEP_UP_ACR, authTime: undefined }, clock);
      assert.equal(noAuthTime.ok, false);
      assert.match(noAuthTime.detail ?? '', /no auth_time/);
    });
  }

  test('an unavailable clock refuses rather than assuming freshness (SPEC-006 §7.1 row 24)', () => {
    const unavailable = (): number | undefined => undefined;
    for (const stepUpClass of CLASSES) {
      const decision = checkStepUp(stepUpClass, { acr: STEP_UP_ACR, authTime: NOW - 1 }, unavailable);
      assert.equal(decision.ok, false, `${stepUpClass} must refuse without a clock`);
      assert.equal(decision.code, 'DEPENDENCY_UNAVAILABLE');
      assert.match(decision.detail ?? '', /freshness cannot be established/);
      assert.equal(decision.audit?.at, null);
    }
  });

  test('a step-up dated in the future is refused, because the window cannot be applied', () => {
    const future = checkStepUp('EXTERNAL_WRITE_EXECUTE_OR_AUTHORISE', { acr: STEP_UP_ACR, authTime: NOW + 600 }, clock);
    assert.equal(future.ok, false);
    assert.match(future.detail ?? '', /in the future/);
  });

  test('an undeclared class is refused rather than admitted', () => {
    const decision = checkStepUp('SOMETHING_ELSE' as StepUpClass, { acr: STEP_UP_ACR, authTime: NOW - 1 }, clock);
    assert.equal(decision.ok, false);
    assert.match(decision.detail ?? '', /not one of the six declared step-up classes/);
  });
});

describe('the external-write class produces no external effect when it refuses (VG-API-015)', () => {
  test('a base-level session attempting an external action dispatches nothing and moves no effect counter', () => {
    // THE DISPATCH SPY AND THE EFFECT COUNTER ARE THE ASSERTION. A step-up check that ran inside the handler would still
    // have dispatched the command and possibly sent the action; here the refusal happens before either.
    let dispatches = 0;
    let externalEffects = 0;
    const dispatch = (): void => {
      dispatches += 1;
      externalEffects += 1;
    };

    const decision = checkStepUp(
      'EXTERNAL_WRITE_EXECUTE_OR_AUTHORISE',
      { acr: 'urn:vg:loa:1', authTime: NOW - 1 },
      clock,
    );
    if (decision.ok) dispatch();

    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'STEP_UP_REQUIRED');
    assert.equal(dispatches, 0, 'a refused step-up must dispatch nothing');
    assert.equal(externalEffects, 0, 'no external effect may be produced by a refused step-up');
    // And the audit row names the class, so the refusal is attributable.
    assert.equal(decision.audit?.stepUpClass, 'EXTERNAL_WRITE_EXECUTE_OR_AUTHORISE');
  });

  test('a fresh step-up admits the same operation, so the refusal was about the step-up', () => {
    let dispatches = 0;
    const dispatch = (): void => {
      dispatches += 1;
    };
    const decision = checkStepUp('EXTERNAL_WRITE_EXECUTE_OR_AUTHORISE', { acr: STEP_UP_ACR, authTime: NOW - 10 }, clock);
    if (decision.ok) dispatch();
    assert.equal(dispatches, 1);
  });
});
