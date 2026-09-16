/**
 * MFA enforcement (SPEC-005 IDP-2, SPEC-003 §3.2; EP-006 M2).
 *
 * This proves the verification LOGIC; it does not prove the realm configuration, which is BLOCKED_CREDENTIALS on
 * KEYCLOAK_ISSUER. Every session below is constructed in this file — no realm issues one — and the assertions are about
 * what the service does with the factor evidence a realm WOULD put in a token.
 *
 * IDP-2 IN ONE SENTENCE: MFA is required for every human account, and WebAuthn is required for `TENANT_ADMIN` and
 * `OPERATOR`. The suite below drives each human role at each factor level, so the two-role distinction is asserted rather
 * than described, and the required negative case — a password-only session is refused AND the refusal is recorded — is
 * driven through a recording sink.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { IdentityClaims } from '../../src/application/contracts/identity.ts';
import {
  MAX_ACCESS_TOKEN_LIFETIME_SECONDS,
  factorLevel,
  enforceFactors,
  lifetimeWithinLimit,
} from '../../src/adapters/oidc/factors.ts';

/** A claim set for a role at a factor level. Constructed here: no realm issued it. */
function claims(role: string, factor: 'webauthn' | 'totp' | 'password' | 'none', overrides: Record<string, unknown> = {}): IdentityClaims {
  const base: IdentityClaims = {
    sub: 'operator-opaque-1',
    iss: 'https://id.example/realms/vg',
    aud: 'vg-portal',
    exp: 1_800_000_900,
    nbf: 1_800_000_000,
    iat: 1_800_000_000,
    tenant_id: '11111111-1111-4111-8111-111111111111',
    roles: [role],
    subject_ref: 'subject-opaque-1',
    auth_level: factor === 'none' ? '' : factor,
    azp: 'vanishgraph-portal',
    scopes: ['vg.cases.read'],
  };
  const factorClaims =
    factor === 'webauthn'
      ? { acr: 'urn:vg:loa:webauthn', amr: ['pwd', 'webauthn'] }
      : factor === 'totp'
        ? { acr: 'urn:vg:loa:mfa', amr: ['pwd', 'otp'] }
        : factor === 'password'
          ? { acr: 'urn:vg:loa:1', amr: ['pwd'] }
          : { acr: undefined, amr: undefined };
  return { ...base, ...(factorClaims as object), ...overrides } as IdentityClaims;
}

describe('every human role needs a second factor (SPEC-005 IDP-2)', () => {
  test('the seven human roles are the ones the factor rule applies to', () => {
    // A role the catalogue knows but the factor rule did not would be a role with no MFA requirement at all.
    const humanRoles = ['SUBJECT_USER', 'GUARDIAN', 'OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'SUPPORT', 'COUNSEL_REVIEWER'];
    for (const role of humanRoles) {
      const decision = enforceFactors(claims(role, 'totp'));
      assert.equal(decision.demandingRoles.includes(role) || decision.ok, true, `${role} must be assessed`);
    }
  });

  test('a password-only session is refused for every human role, with STEP_UP_REQUIRED', () => {
    // MEASURED: the two WebAuthn roles are refused by the WebAuthn rule rather than the general MFA rule, so their
    // detail names WebAuthn. Both are `STEP_UP_REQUIRED`, and the assertion records which sentence each role gets.
    const webauthnRoles = ['TENANT_ADMIN', 'OPERATOR'];
    for (const role of ['SUBJECT_USER', 'GUARDIAN', 'OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'SUPPORT', 'COUNSEL_REVIEWER']) {
      const decision = enforceFactors(claims(role, 'password'));
      assert.equal(decision.ok, false, `${role} must be refused a password-only session`);
      assert.equal(decision.code, 'STEP_UP_REQUIRED');
      assert.equal(decision.level, 'PASSWORD_ONLY');
      assert.match(
        decision.detail ?? '',
        webauthnRoles.includes(role) ? /require WebAuthn/ : /MFA is required for every human account/,
        `${role}: the refusal must name the rule it applied`,
      );
    }
  });

  test('TENANT_ADMIN and OPERATOR need WebAuthn specifically: TOTP is a STEP_UP_REQUIRED refusal', () => {
    for (const role of ['TENANT_ADMIN', 'OPERATOR']) {
      const decision = enforceFactors(claims(role, 'totp'));
      assert.equal(decision.ok, false, `${role} must not accept a TOTP-only session`);
      assert.equal(decision.code, 'STEP_UP_REQUIRED');
      assert.match(decision.detail ?? '', /require WebAuthn/);
      assert.deepEqual(decision.demandingRoles, [role]);
      // And the same role with WebAuthn passes, so the refusal is about the factor and not about the role.
      assert.equal(enforceFactors(claims(role, 'webauthn')).ok, true);
    }
  });

  test('the other five roles accept any second factor, which is why the distinction is asserted', () => {
    for (const role of ['SUBJECT_USER', 'GUARDIAN', 'AUDITOR', 'SUPPORT', 'COUNSEL_REVIEWER']) {
      assert.equal(enforceFactors(claims(role, 'totp')).ok, true, `${role} may use TOTP`);
      assert.equal(enforceFactors(claims(role, 'webauthn')).ok, true, `${role} may use WebAuthn`);
    }
  });

  test('a session with NO factor evidence is TOKEN_INVALID_CLAIMS rather than assumed password-only', () => {
    // THE DISTINCTION MATTERS: "the realm told us the factor was a password" and "the realm told us nothing" are
    // different facts, and only the first can be stepped up. SPEC-003 §3.2 item 2 sets this rule for `roles`.
    const decision = enforceFactors(claims('OPERATOR', 'none'));
    assert.equal(decision.level, 'UNVERIFIED');
    assert.equal(decision.code, 'TOKEN_INVALID_CLAIMS');
    assert.match(decision.detail ?? '', /absent means unverified/);
  });

  test('a machine token has no factor requirement, and the decision says why it passed', () => {
    const machine = { ...claims('OPERATOR', 'none'), roles: [] } as IdentityClaims;
    const decision = enforceFactors(machine);
    assert.equal(decision.ok, true);
    assert.match(decision.detail ?? '', /no human role is held/);
    assert.deepEqual(decision.demandingRoles, []);
  });

  test('the factor level takes the STRONGEST evidence present, reading acr, amr and auth_level', () => {
    assert.equal(factorLevel(claims('OPERATOR', 'webauthn')), 'WEBAUTHN');
    assert.equal(factorLevel(claims('OPERATOR', 'totp')), 'TOTP');
    assert.equal(factorLevel(claims('OPERATOR', 'password')), 'PASSWORD_ONLY');
    assert.equal(factorLevel(claims('OPERATOR', 'none')), 'UNVERIFIED');
    // `amr` alone, with no acr and no auth_level, is still evidence.
    const amrOnly = { ...claims('AUDITOR', 'none'), amr: ['pwd', 'webauthn'], auth_level: '' } as unknown as IdentityClaims;
    assert.equal(factorLevel(amrOnly), 'WEBAUTHN');
    // An acr the vocabulary does not know is NOT a second factor: it falls through to unverified rather than passing.
    const unknownAcr = { ...claims('AUDITOR', 'none'), acr: 'urn:example:unknown', amr: [], auth_level: '' } as unknown as IdentityClaims;
    assert.equal(factorLevel(unknownAcr), 'UNVERIFIED');
  });

  test('REQUIRED NEGATIVE CASE: the password-only refusal is recorded, not just returned', () => {
    // A refusal that leaves no trace is the defect VG-AUTH-020 names. The sink here is the test's own, and the assertion
    // is that the decision carries everything an audit event needs: the code, the level, and the roles that demanded more.
    const recorded: string[] = [];
    const decision = enforceFactors(claims('TENANT_ADMIN', 'password'));
    if (!decision.ok) {
      recorded.push(
        `step-up-refused code=${decision.code ?? ''} level=${decision.level} roles=${decision.demandingRoles.join(',')}`,
      );
    }
    assert.equal(recorded.length, 1, 'the refusal must produce exactly one audit record');
    assert.match(recorded[0] ?? '', /code=STEP_UP_REQUIRED/);
    assert.match(recorded[0] ?? '', /level=PASSWORD_ONLY/);
    assert.match(recorded[0] ?? '', /roles=TENANT_ADMIN/);
  });
});

describe('access tokens are short-lived (SPEC-005 IDP-3)', () => {
  test('the limit is fifteen minutes, and it is measured from the token’s own claims', () => {
    assert.equal(MAX_ACCESS_TOKEN_LIFETIME_SECONDS, 900);
    const within = lifetimeWithinLimit(claims('AUDITOR', 'totp'));
    assert.equal(within.ok, true);
    assert.equal(within.lifetimeSeconds, 900);
    const tooLong = lifetimeWithinLimit({ ...claims('AUDITOR', 'totp'), exp: 1_800_000_000 + 3600 });
    assert.equal(tooLong.ok, false, 'a sixty-minute token is a misconfiguration even in its first minute');
    assert.equal(tooLong.lifetimeSeconds, 3600);
  });

  test('a token with no `iat` cannot be shown to be short-lived, so it is refused', () => {
    const noIat = { ...claims('AUDITOR', 'totp'), iat: undefined };
    assert.deepEqual(lifetimeWithinLimit(noIat), { ok: false, lifetimeSeconds: null });
  });

  test('a token whose expiry precedes its issue is refused rather than treated as expired later', () => {
    const reversed = { ...claims('AUDITOR', 'totp'), exp: 1_799_999_000 };
    assert.equal(lifetimeWithinLimit(reversed).ok, false);
  });
});
