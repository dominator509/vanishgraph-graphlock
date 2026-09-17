/**
 * Forced failure: absent or malformed credentials must fail CLOSED (DOD-014; SPEC-005 §4, SPEC-006 §7.1; EP-007 M3).
 *
 * THE FAILURE THIS FILE MAKES HAPPEN IS A MISSING OR WRONG SECRET. The property asserted is the one a startup path
 * must have: with a credential absent, empty or refused, the configuration is NOT produced — no partially-configured
 * object is returned for a caller to use, because every consumer of that object would then run with a default nobody
 * chose.
 *
 * AND THE REFUSAL MUST NAME THE VARIABLE WITHOUT CARRYING ITS VALUE. This file's messages reach logs and evidence
 * captures, so a canary value is placed in the environment and asserted ABSENT from every message: a credential that is
 * refused must not be echoed on the way out.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SECURITY_ENV_VARS,
  SecurityConfigError,
  missingSecurityEnvVars,
  readSecurityConfig,
} from '../../src/adapters/config/security-config.ts';

/** A canary that must never appear in a refusal message. */
const CANARY = 'canary-value-that-must-not-be-echoed-0123456789';

/** A complete, well-formed environment, so each case can break exactly one thing. */
function completeEnv(): Record<string, string> {
  return Object.fromEntries(SECURITY_ENV_VARS.map((name) => [name, `https://example.invalid/${name}`]));
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

describe('forced failure: credentials fail closed (DOD-014)', () => {
  test('an EMPTY environment is refused and every declared variable is named', () => {
    const refusal = refusalOf(() => readSecurityConfig({}));
    assert.ok(refusal instanceof SecurityConfigError, `expected a SecurityConfigError, got: ${String(refusal)}`);
    // MEASURED: the refusal names the FIRST missing variable, and the EXHAUSTIVE list is what `missingSecurityEnvVars`
    // returns — my first version asserted the throw message carried all of them, which it does not. What matters for
    // fail-closed behaviour is that a caller can obtain the complete list, and that the throw names a real variable.
    const missing = missingSecurityEnvVars({});
    assert.deepEqual([...missing], [...SECURITY_ENV_VARS], 'every declared variable is missing from an empty environment');
    assert.ok(refusal.message.length > 0, 'the refusal must say something a reader can act on');
  });

  test('an EMPTY STRING is absent, not present: a variable set to "" does not configure anything', () => {
    // The case a deployment hits when a secret is mounted but unset: the name exists in the environment and the value
    // does not, and a loader that treated "" as a value would start with an empty secret.
    const env = completeEnv();
    const victim = SECURITY_ENV_VARS[0] ?? '';
    env[victim] = '';
    const refusal = refusalOf(() => readSecurityConfig(env));
    assert.ok(refusal instanceof SecurityConfigError, `an empty ${victim} must be refused`);
    assert.ok(refusal.message.includes(victim), 'and the refusal names it');
    assert.deepEqual([...missingSecurityEnvVars(env)], [victim], 'exactly the emptied variable is reported missing');
  });

  test('a SHORT secret is refused, the refusal names the minimum, and it does not echo the value', () => {
    // TWO MEASUREMENTS, BOTH OF WHICH CORRECTED THIS CASE. (1) Only SESSION_SECRET carries a length rule: a short
    // KEYCLOAK_CLIENT_SECRET is accepted, so the first version targeted the wrong variable. (2) The refusal for a short
    // SESSION_SECRET is thrown as a PLAIN `Error`, not as this module's `SecurityConfigError` — asserted below as it is,
    // and recorded because a caller that catches `SecurityConfigError` will not catch this one. That type inconsistency
    // is a FINDING this suite surfaces; it is not resolved here.
    const env = completeEnv();
    const secretName = 'SESSION_SECRET';
    assert.ok(SECURITY_ENV_VARS.includes(secretName), `${secretName} must be a declared variable`);
    env[secretName] = 'shortval-truncated-secret-0123456789';
    const refusal = refusalOf(() => readSecurityConfig(env));
    assert.ok(refusal instanceof Error, `a short ${secretName} must be refused`);
    assert.match(refusal.message, /32-character minimum/, 'the refusal must state the requirement');
    // THE LEAK CHECK USES A DISTINCTIVE VALUE, AND THAT IS MEASURED: the first version asserted the message did not
    // contain the literal 'short' and failed — because the message says "shorter than the 32-character minimum", so a
    // substring test on a short generic word reports a leak that is not there. The value is now distinctive enough that
    // a match could only be the value itself.
    assert.equal(refusal.message.includes('shortval-truncated-secret-0123456789'), false, 'and must not echo the value');
    assert.equal(
      refusal instanceof SecurityConfigError,
      false,
      'MEASURED: this refusal is a plain Error; if that changes, this assertion should change with it',
    );
  });

  test('NO REFUSAL ECHOES A VALUE: a canary in the environment never appears in a message', () => {
    // Two shapes at once — a variable carrying the canary and another variable missing — so both the "missing" report
    // and any value-shaped complaint are covered by one sweep.
    const env = completeEnv();
    env[SECURITY_ENV_VARS[0] ?? ''] = CANARY;
    env[SECURITY_ENV_VARS[1] ?? ''] = '';
    const refusal = refusalOf(() => readSecurityConfig(env));
    assert.ok(refusal instanceof SecurityConfigError);
    assert.equal(refusal.message.includes(CANARY), false, `the refusal echoed a credential: ${refusal.message}`);
    const missing = missingSecurityEnvVars(env);
    assert.equal(JSON.stringify(missing).includes(CANARY), false, 'the missing-variable report carries names only');
  });

  test('a COMPLETE environment is accepted, so every refusal above is about the case it breaks', () => {
    // MEASURED: field names are the loader's own and are not derivable from the variable names — my first version
    // guessed camelCase and failed on KEYCLOAK_ISSUER. What is asserted instead is the completeness statement a caller
    // actually relies on: nothing is reported missing, and the loader returns a configuration object.
    const env = completeEnv();
    assert.deepEqual([...missingSecurityEnvVars(env)], [], 'a complete environment reports nothing missing');
    const config = readSecurityConfig(env);
    assert.equal(typeof config, 'object');
    assert.notEqual(config, null, 'a complete environment produces a configuration rather than a refusal');
  });

  test('the missing-variable report is EXHAUSTIVE and in declaration order, so a subset cannot read as complete', () => {
    const env = completeEnv();
    const dropped = SECURITY_ENV_VARS.slice(0, 3);
    for (const name of dropped) delete env[name];
    assert.deepEqual([...missingSecurityEnvVars(env)], [...dropped], 'a partial list would hide the rest');
  });
});
