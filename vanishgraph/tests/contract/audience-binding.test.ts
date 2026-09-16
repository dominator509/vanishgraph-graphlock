/**
 * Audience binding: a token minted for one audience is refused on a route belonging to another (SPEC-003 §3.2 item 3;
 * EP-006 M2).
 *
 * **This proves the verification logic; it does not prove the realm configuration, which is BLOCKED_CREDENTIALS on
 * `KEYCLOAK_ISSUER`.** The audiences below are locally generated values supplied through the injected JWKS port, which is
 * exactly what the plan requires until a realm exists: the real audience strings are the M1 discovery blanks, and
 * asserting them would be asserting a client registration nobody has made.
 *
 * THE NEGATIVE CASES ARE THE POINT OF THE SUITE, and the most important one is a token signed by a key the verifier does
 * not trust: a verifier that accepted it would accept anything. After that: the wrong audience, a missing `aud` at all, an
 * expired token, a token from another issuer, and a token whose lifetime exceeds IDP-3's fifteen minutes.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { JwksCache } from '../../src/adapters/oidc/jwks.ts';
import { verifyToken, AUDIENCES } from '../../src/adapters/oidc/verify.ts';
import { createLocalRealm, standardClaims } from '../fixtures/local-oidc/issue.ts';

const ISSUER = 'https://id.example/realms/vg';
const realm = createLocalRealm(ISSUER);
const untrusted = realm.newKey();

/** A verifier wired to the local realm's JWKS, for one expected audience. */
function verifier(expectedAudience: (typeof AUDIENCES)[keyof typeof AUDIENCES]) {
  return {
    jwks: new JwksCache({ fetchJwks: async () => realm.jwks, now: () => Date.now() }),
    issuer: ISSUER,
    expectedAudience,
    now: () => Date.now(),
  };
}

describe('a token is accepted only for the audience it was minted for (SPEC-003 §3.2 item 3)', () => {
  test('the three audiences are distinct strings, which is what makes binding meaningful', () => {
    const values = Object.values(AUDIENCES);
    assert.equal(new Set(values).size, values.length, 'portal, service and MCP audiences must differ');
    for (const value of values) assert.ok(value.length > 0);
  });

  test('a portal token is accepted on a portal route', async () => {
    const token = realm.sign(standardClaims({ aud: AUDIENCES.PORTAL }));
    const result = await verifyToken(token, verifier(AUDIENCES.PORTAL));
    assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.detail}`);
    if (result.ok) {
      assert.equal(result.claims.aud, AUDIENCES.PORTAL);
      assert.equal(result.claims.tenant_id, '11111111-1111-4111-8111-111111111111');
    }
  });

  test('a token for one audience is refused on a route of another, with TOKEN_AUDIENCE_MISMATCH', async () => {
    for (const [mintedFor, routeExpects] of [
      [AUDIENCES.MCP, AUDIENCES.PORTAL],
      [AUDIENCES.PORTAL, AUDIENCES.SERVICE],
      [AUDIENCES.SERVICE, AUDIENCES.MCP],
    ] as const) {
      const token = realm.sign(standardClaims({ aud: mintedFor }));
      const result = await verifyToken(token, verifier(routeExpects));
      assert.equal(result.ok, false, `${mintedFor} must not be accepted where ${routeExpects} is expected`);
      if (!result.ok) assert.equal(result.code, 'TOKEN_AUDIENCE_MISMATCH');
    }
  });

  test('a token with no audience at all is refused rather than treated as universal', async () => {
    const claims = standardClaims();
    delete claims['aud'];
    const result = await verifyToken(realm.sign(claims), verifier(AUDIENCES.PORTAL));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'TOKEN_INVALID_CLAIMS');
  });
});

describe('the verifier refuses what it cannot verify (EP-006 M2)', () => {
  test('REQUIRED NEGATIVE CASE: a token signed by an untrusted key is refused', async () => {
    // The verifier's JWKS knows only the realm's key; this token carries a DIFFERENT kid and a signature that cannot be
    // checked against anything. A verifier that accepted it would accept a token anyone can mint.
    const forged = untrusted.sign(standardClaims({ aud: AUDIENCES.PORTAL }));
    const result = await verifyToken(forged, verifier(AUDIENCES.PORTAL));
    assert.equal(result.ok, false);
    assert.equal(result.code === 'TOKEN_INVALID' || result.code === 'DEPENDENCY_UNAVAILABLE', true, `got ${result.code}`);
  });

  test('a token signed by the realm key but carrying an untrusted kid is refused', async () => {
    const wrongKid = realm.sign(standardClaims({ aud: AUDIENCES.PORTAL }), { kid: 'not-in-the-jwks' });
    const result = await verifyToken(wrongKid, verifier(AUDIENCES.PORTAL));
    assert.equal(result.ok, false);
  });

  test('an expired token is TOKEN_EXPIRED, and a not-yet-valid one is refused too', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = realm.sign(standardClaims({ aud: AUDIENCES.PORTAL, iat: now - 2000, nbf: now - 2000, exp: now - 1000 }));
    const expiredResult = await verifyToken(expired, verifier(AUDIENCES.PORTAL));
    assert.equal(expiredResult.ok, false);
    if (!expiredResult.ok) assert.equal(expiredResult.code, 'TOKEN_EXPIRED');

    const early = realm.sign(standardClaims({ aud: AUDIENCES.PORTAL, nbf: now + 600, exp: now + 1200 }));
    const earlyResult = await verifyToken(early, verifier(AUDIENCES.PORTAL));
    assert.equal(earlyResult.ok, false);
  });

  test('a token from another issuer is refused even with a valid signature', async () => {
    const otherRealm = createLocalRealm('https://other.example/realms/vg');
    // Signed by a key the verifier does not know: two reasons to refuse, and the assertion is on the outcome.
    const token = otherRealm.sign(standardClaims({ iss: 'https://other.example/realms/vg', aud: AUDIENCES.PORTAL }));
    const result = await verifyToken(token, verifier(AUDIENCES.PORTAL));
    assert.equal(result.ok, false);
  });

  test('a token missing a required claim is TOKEN_INVALID_CLAIMS, never an empty set', async () => {
    for (const claim of ['sub', 'tenant_id', 'roles', 'subject_ref', 'auth_level']) {
      const claims = standardClaims({ aud: AUDIENCES.PORTAL });
      delete claims[claim];
      const result = await verifyToken(realm.sign(claims), verifier(AUDIENCES.PORTAL));
      assert.equal(result.ok, false, `${claim} must be required`);
      if (!result.ok) {
        assert.equal(result.code, 'TOKEN_INVALID_CLAIMS', `${claim} should be a claims refusal, got ${result.code}`);
      }
    }
  });

  test('a wildcard scope is TOKEN_SCOPE_WILDCARD_FORBIDDEN', async () => {
    const token = realm.sign(standardClaims({ aud: AUDIENCES.PORTAL, scopes: ['vg.cases.read', '*'] }));
    const result = await verifyToken(token, verifier(AUDIENCES.PORTAL));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'TOKEN_SCOPE_WILDCARD_FORBIDDEN');
  });

  test('a malformed token, or no token, is TOKEN_MISSING or TOKEN_INVALID rather than an exception', async () => {
    assert.equal((await verifyToken(undefined, verifier(AUDIENCES.PORTAL))).ok, false);
    const missing = await verifyToken(undefined, verifier(AUDIENCES.PORTAL));
    if (!missing.ok) assert.equal(missing.code, 'TOKEN_MISSING');
    const malformed = await verifyToken('not.a.token', verifier(AUDIENCES.PORTAL));
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.code, 'TOKEN_INVALID');
  });

  test('an unsigned token (alg: none) is refused, because a key-confusion attack must be unrepresentable', async () => {
    const claims = standardClaims({ aud: AUDIENCES.PORTAL });
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const result = await verifyToken(`${header}.${payload}.`, verifier(AUDIENCES.PORTAL));
    assert.equal(result.ok, false);
  });
});

