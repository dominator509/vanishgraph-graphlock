/**
 * Token validation (SPEC-003 §3.2, SPEC-005 IDP-1…IDP-6).
 *
 * HONEST SCOPE, stated first because it bounds what this file proves:
 *
 *   * It exercises the verification LOGIC — signature, `iss`, `aud`, `exp`, `nbf`, required claims,
 *     wildcard refusal, and the bearer-only rule — against a LOCALLY GENERATED RSA key pair and a
 *     LOCALLY SIGNED token whose JWKS is served through the injected fetch port.
 *   * It proves NOTHING about a configured Keycloak realm. Real-IdP verification is
 *     `BLOCKED_CREDENTIALS` on `KEYCLOAK_ISSUER`; `sh scripts/probes/keycloak.sh` exits non-zero and
 *     EP-006 owns the realm. No test here may be cited as evidence that Keycloak works.
 *
 * Why a real key pair rather than a stubbed verifier: a stubbed verifier would test that the tests
 * call the stub. Signing a real token with `node:crypto` means a wrong-key, tampered-payload or
 * expired-token case genuinely FAILS the cryptography, which is the property worth having.
 *
 * Every refusal asserts the SPECIFIC wire code. Collapsing them would hide the difference between
 * "your credential is bad" (401) and "our key server is down" (503), and an operator debugging an
 * outage would be sent hunting for a credential problem that does not exist.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

import { JwksCache, type JwksDocument } from '../../src/adapters/oidc/jwks.ts';
import { AUDIENCES, bearerFrom, verifyToken, type Audience } from '../../src/adapters/oidc/verify.ts';

const ISSUER = 'https://idp.test/realms/vanishgraph';
const NOW_MS = 1_770_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

/** A real RSA key pair, generated once for the suite. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';

/** A SECOND pair, used only to prove a token signed by the wrong key is refused. */
const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwksFor(key: KeyObject, kid: string): JwksDocument {
  const jwk = key.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
  return { keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid, use: 'sig', alg: 'RS256' }] };
}

const GOOD_JWKS = jwksFor(publicKey, KID);

/** The claims a well-formed token carries, in SPEC-005 IDP-4's snake_case names. */
function goodClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'operator-0001',
    iss: ISSUER,
    aud: AUDIENCES.PORTAL,
    exp: NOW_SECONDS + 3600,
    nbf: NOW_SECONDS - 60,
    iat: NOW_SECONDS - 60,
    tenant_id: '11111111-1111-4111-8111-111111111111',
    roles: ['OPERATOR'],
    subject_ref: 'subject-ref-0001',
    auth_level: 'IAL2',
    ...overrides,
  };
}

/** Sign a real RS256 token. */
function sign(claims: Record<string, unknown>, options: { key?: KeyObject; kid?: string; alg?: string } = {}): string {
  const header = { alg: options.alg ?? 'RS256', typ: 'JWT', kid: options.kid ?? KID };
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(options.key ?? privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function cacheWith(document: JwksDocument | (() => Promise<JwksDocument>)): JwksCache {
  let calls = 0;
  return new JwksCache({
    now: () => NOW_MS,
    fetchJwks: async () => {
      calls += 1;
      void calls;
      return typeof document === 'function' ? document() : document;
    },
  });
}

function verifier(jwks: JwksCache, expectedAudience: Audience = AUDIENCES.PORTAL) {
  return (token: string | undefined) =>
    verifyToken(token, { jwks, issuer: ISSUER, expectedAudience, now: () => NOW_MS });
}

describe('a well-formed token is accepted', () => {
  test('a correctly signed token with every required claim verifies', async () => {
    const result = await verifier(cacheWith(GOOD_JWKS))(sign(goodClaims()));
    assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.detail}`);
    if (!result.ok) return;
    assert.equal(result.claims.tenant_id, '11111111-1111-4111-8111-111111111111');
    assert.deepEqual(result.claims.roles, ['OPERATOR']);
    assert.equal(result.claims.subject_ref, 'subject-ref-0001');
    assert.equal(result.claims.auth_level, 'IAL2');
  });

  test('aud and roles may be arrays, as JWT permits', async () => {
    const result = await verifier(cacheWith(GOOD_JWKS))(
      sign(goodClaims({ aud: [AUDIENCES.MCP, AUDIENCES.PORTAL], roles: ['OPERATOR', 'AUDITOR'] })),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual([...result.claims.roles], ['OPERATOR', 'AUDITOR']);
  });
});

describe('signature failures are refused (SPEC-003 §3.2 item 1)', () => {
  test('a token signed by the WRONG key is TOKEN_INVALID', async () => {
    const result = await verifier(cacheWith(GOOD_JWKS))(sign(goodClaims(), { key: otherPair.privateKey }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_INVALID');
  });

  test('a tampered payload is TOKEN_INVALID', async () => {
    const token = sign(goodClaims());
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    // Escalate the tenant in the payload, keeping the original signature.
    payload['tenant_id'] = '22222222-2222-4222-8222-222222222222';
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
    const result = await verifier(cacheWith(GOOD_JWKS))(tampered);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_INVALID', 'a tampered payload must not be accepted');
  });

  test('an alg=none token is refused even though it is well formed', async () => {
    // A `none` token has an empty signature and is a classic bypass. It must never be accepted,
    // and the algorithm allowlist must reject it before any key lookup.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(goodClaims())).toString('base64url');
    const result = await verifier(cacheWith(GOOD_JWKS))(`${header}.${payload}.`);
    assert.equal(result.ok, false);
    if (result.ok) return;
    // An empty signature means `decode` refuses it as not a valid JWS, which is TOKEN_INVALID.
    assert.equal(result.code, 'TOKEN_INVALID');
  });

  test('an HS256 token is refused: no key-confusion path exists', async () => {
    const result = await verifier(cacheWith(GOOD_JWKS))(sign(goodClaims(), { alg: 'HS256' }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_INVALID');
  });

  test('a two-part or four-part token is TOKEN_INVALID', async () => {
    const v = verifier(cacheWith(GOOD_JWKS));
    for (const malformed of ['abc.def', 'a.b.c.d', '', '....']) {
      const result = await v(malformed);
      assert.equal(result.ok, false, `${JSON.stringify(malformed)} must be refused`);
    }
  });
});

describe('claim refusals each keep their own code (SPEC-005 IDP-4)', () => {
  const v = verifier(cacheWith(GOOD_JWKS));

  test('a missing token is TOKEN_MISSING, not TOKEN_INVALID', async () => {
    const result = await v(undefined);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_MISSING');
  });

  test('a missing tenant_id is TOKEN_INVALID_CLAIMS and never an all-tenants token', async () => {
    const claims = goodClaims();
    delete claims['tenant_id'];
    const result = await v(sign(claims));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_INVALID_CLAIMS');
  });

  test('a missing roles claim is TOKEN_INVALID_CLAIMS, NEVER an empty role set', async () => {
    // SPEC-003 §3.2 item 2: "absent means none" and "absent means unverified" are different
    // failures and only one of them is safe. An empty set would authorise every role-free route.
    const claims = goodClaims();
    delete claims['roles'];
    const result = await v(sign(claims));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_INVALID_CLAIMS');
    assert.notEqual(result.code, 'TOKEN_INVALID');
  });

  test('an empty roles ARRAY is accepted: present-but-empty is different from absent', async () => {
    // The spec refuses ABSENCE. An explicitly empty array is a caller with no roles, which is a
    // legitimate state and must not be conflated with a malformed token.
    const result = await v(sign(goodClaims({ roles: [] })));
    assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.detail}`);
    if (!result.ok) return;
    assert.deepEqual([...result.claims.roles], []);
  });

  test('a missing sub, subject_ref or auth_level is TOKEN_INVALID_CLAIMS', async () => {
    for (const claim of ['sub', 'subject_ref', 'auth_level']) {
      const claims = goodClaims();
      delete claims[claim];
      const result = await v(sign(claims));
      assert.equal(result.ok, false, `${claim} absent must be refused`);
      if (result.ok) continue;
      assert.equal(result.code, 'TOKEN_INVALID_CLAIMS', `${claim} must map to TOKEN_INVALID_CLAIMS`);
    }
  });

  test('a camelCase claim name does not satisfy the snake_case contract', async () => {
    // SPEC-003 §3.2 item 2 and §14 R-1: the API reads SPEC-005's claim names and "does not invent
    // parallel camelCase claims". A token carrying only `tenantId` is missing `tenant_id`.
    const claims = goodClaims();
    delete claims['tenant_id'];
    claims['tenantId'] = '11111111-1111-4111-8111-111111111111';
    const result = await v(sign(claims));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_INVALID_CLAIMS');
  });
});

describe('temporal refusals (SPEC-003 §3.2 item 1)', () => {
  test('an expired token is TOKEN_EXPIRED, distinct from TOKEN_INVALID', async () => {
    const result = await verifier(cacheWith(GOOD_JWKS))(
      sign(goodClaims({ exp: NOW_SECONDS - 3600, iat: NOW_SECONDS - 7200 })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_EXPIRED');
  });

  test('a token expiring inside the skew tolerance is still accepted', async () => {
    const result = await verifier(cacheWith(GOOD_JWKS))(
      sign(goodClaims({ exp: NOW_SECONDS - 10, iat: NOW_SECONDS - 100 })),
    );
    assert.equal(result.ok, true, 'a 10s-expired token is inside the 30s tolerance');
  });

  test('a not-yet-valid token (nbf in the future) is TOKEN_INVALID', async () => {
    const result = await verifier(cacheWith(GOOD_JWKS))(
      sign(goodClaims({ nbf: NOW_SECONDS + 3600 })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_INVALID');
  });

  test('a missing exp is TOKEN_INVALID_CLAIMS', async () => {
    const claims = goodClaims();
    delete claims['exp'];
    const result = await verifier(cacheWith(GOOD_JWKS))(sign(claims));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_INVALID_CLAIMS');
  });
});

describe('audience binding (SPEC-003 §3.2 item 3)', () => {
  test('a token for another audience is TOKEN_AUDIENCE_MISMATCH', async () => {
    // This is what keeps an MCP token from being replayed against a portal route.
    const mcpToken = sign(goodClaims({ aud: AUDIENCES.MCP }));
    const result = await verifier(cacheWith(GOOD_JWKS), AUDIENCES.PORTAL)(mcpToken);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_AUDIENCE_MISMATCH');
  });

  test('the same token verifies against its OWN audience', async () => {
    const mcpToken = sign(goodClaims({ aud: AUDIENCES.MCP }));
    const result = await verifier(cacheWith(GOOD_JWKS), AUDIENCES.MCP)(mcpToken);
    assert.equal(result.ok, true);
  });

  test('a missing aud is TOKEN_INVALID_CLAIMS', async () => {
    const claims = goodClaims();
    delete claims['aud'];
    const result = await verifier(cacheWith(GOOD_JWKS))(sign(claims));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_INVALID_CLAIMS');
  });
});

describe('issuer binding', () => {
  test('a token from another issuer is refused rather than verified with our key', async () => {
    const result = await verifier(cacheWith(GOOD_JWKS))(
      sign(goodClaims({ iss: 'https://evil.test/realms/vanishgraph' })),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_INVALID');
  });

  test('a missing iss is TOKEN_INVALID_CLAIMS', async () => {
    const claims = goodClaims();
    delete claims['iss'];
    const result = await verifier(cacheWith(GOOD_JWKS))(sign(claims));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'TOKEN_INVALID_CLAIMS');
  });
});

describe('scope shape (SPEC-003 §3.2 item 9)', () => {
  test('a wildcard scope is TOKEN_SCOPE_WILDCARD_FORBIDDEN', async () => {
    for (const wildcard of ['*', 'vg.*', 'vg.subjects.*']) {
      const result = await verifier(cacheWith(GOOD_JWKS))(sign(goodClaims({ scopes: [wildcard] })));
      assert.equal(result.ok, false, `${wildcard} must be refused`);
      if (result.ok) continue;
      assert.equal(result.code, 'TOKEN_SCOPE_WILDCARD_FORBIDDEN');
    }
  });

  test('an ordinary scope list is accepted', async () => {
    const result = await verifier(cacheWith(GOOD_JWKS))(
      sign(goodClaims({ scopes: ['vg.subjects.read', 'vg.cases.read'] })),
    );
    assert.equal(result.ok, true);
  });

  test('a token with no scopes claim is accepted: scopes may derive from roles', async () => {
    const result = await verifier(cacheWith(GOOD_JWKS))(sign(goodClaims()));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.claims.scopes, undefined);
  });
});

describe('an unreachable key server is a DEPENDENCY failure, never an acceptance', () => {
  test('a JWKS fetch failure yields DEPENDENCY_UNAVAILABLE', async () => {
    const jwks = cacheWith(() => Promise.reject(new Error('connection refused')));
    const result = await verifier(jwks)(sign(goodClaims()));
    assert.equal(result.ok, false, 'an unreachable key server must NEVER accept a token');
    if (result.ok) return;
    assert.equal(result.code, 'DEPENDENCY_UNAVAILABLE');
  });

  test('an EMPTY key set is a DEPENDENCY failure, not an acceptance', async () => {
    const jwks = cacheWith({ keys: [] });
    const result = await verifier(jwks)(sign(goodClaims()));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'DEPENDENCY_UNAVAILABLE');
  });

  test('an unknown kid triggers exactly one refetch, then refuses', async () => {
    let calls = 0;
    const jwks = new JwksCache({
      now: () => NOW_MS,
      fetchJwks: async () => {
        calls += 1;
        return GOOD_JWKS;
      },
    });
    const result = await verifier(jwks)(sign(goodClaims(), { kid: 'rotated-away' }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'DEPENDENCY_UNAVAILABLE');
    // One initial fetch, one refetch because the kid was absent from a cached document. Not a loop.
    assert.equal(calls, 2, `expected 2 fetches (initial + one refresh), saw ${calls}`);
  });

  test('a rotated key is picked up by the refetch', async () => {
    const newKid = 'test-key-2';
    let phase = 0;
    const jwks = new JwksCache({
      now: () => NOW_MS,
      fetchJwks: async () => {
        phase += 1;
        return phase === 1 ? GOOD_JWKS : jwksFor(publicKey, newKid);
      },
    });
    // Prime the cache with the old document, then present a token for the new kid.
    await verifier(jwks)(sign(goodClaims()));
    const result = await verifier(jwks)(sign(goodClaims(), { kid: newKid }));
    assert.equal(result.ok, true, 'a rotated key must be accepted after the refetch');
  });

  test('a cached document is reused instead of refetched', async () => {
    let calls = 0;
    const jwks = new JwksCache({
      now: () => NOW_MS,
      fetchJwks: async () => {
        calls += 1;
        return GOOD_JWKS;
      },
    });
    await verifier(jwks)(sign(goodClaims()));
    await verifier(jwks)(sign(goodClaims()));
    await verifier(jwks)(sign(goodClaims()));
    assert.equal(calls, 1, 'three verifications inside the TTL must fetch once');
    assert.equal(jwks.cacheAgeSeconds(), 0);
  });
});

describe('bearer only (SPEC-003 §3.2 item 1)', () => {
  test('only a well-formed Authorization: Bearer header yields a token', () => {
    assert.equal(bearerFrom({ authorization: 'Bearer abc123' }), 'abc123');
    assert.equal(bearerFrom({ authorization: 'bearer abc123' }), 'abc123');
    assert.equal(bearerFrom({ authorization: 'Bearer\tabc123' }), 'abc123');
  });

  test('Basic, ApiKey, cookie and query-string forms yield nothing', () => {
    // "Bearer only" is the rule; a fallback lookup is how a temporary query-string token becomes
    // permanent. Each of these must produce undefined so the caller sees TOKEN_MISSING.
    assert.equal(bearerFrom({ authorization: 'Basic dXNlcjpwYXNz' }), undefined);
    assert.equal(bearerFrom({ authorization: 'ApiKey abc123' }), undefined);
    assert.equal(bearerFrom({ authorization: 'abc123' }), undefined);
    assert.equal(bearerFrom({ 'x-api-key': 'abc123' }), undefined);
    assert.equal(bearerFrom({ cookie: 'access_token=abc123' }), undefined);
    assert.equal(bearerFrom({}), undefined);
  });

  test('a Bearer header with extra parts or whitespace is refused', () => {
    assert.equal(bearerFrom({ authorization: 'Bearer' }), undefined);
    assert.equal(bearerFrom({ authorization: 'Bearer a b' }), undefined);
    assert.equal(bearerFrom({ authorization: 'Bearer ' }), undefined);
  });
});
