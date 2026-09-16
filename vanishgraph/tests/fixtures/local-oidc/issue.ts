/**
 * A LOCAL OIDC REALM FOR THE VERIFICATION TESTS (EP-006 M2).
 *
 * **This proves the verification logic; it does not prove the realm configuration, which is BLOCKED_CREDENTIALS on
 * `KEYCLOAK_ISSUER`.** Every token here is minted in this process from a key pair this process generated, and the
 * verifier is pointed at the matching JWKS document. Nothing about a real realm — its key rotation, its audience
 * registration, its MFA policy — is exercised, and no assertion built on this fixture may claim otherwise.
 *
 * IT SIGNS WITH `node:crypto`, NOT A LIBRARY. The project already carries `jose` for the verifier path, but a fixture
 * that uses the same library as the code under test can agree with it about a mistake; signing with the platform's own
 * RSA-SHA256 and letting the verifier be the thing under test keeps the two sides independent.
 */

import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

// The project's own JWKS types, so the fixture cannot drift from what the verifier fetches.
import type { JwksDocument, JsonWebKey } from '../../../src/adapters/oidc/jwks.ts';

export interface LocalRealm {
  readonly issuer: string;
  readonly kid: string;
  /** The JWKS document the verifier fetches. */
  readonly jwks: JwksDocument;
  /** Mint a token. The claims given here are the claims the verifier will read. */
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): string;
  /** Public key material, so a test can mint a token nothing trusts. */
  readonly publicJwk: JsonWebKey;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build a realm whose tokens are signed by a key this test owns.
 *
 * A SECOND, UNRELATED KEY IS ALSO RETURNED by `newKey()`, because the assertion that matters most for a verifier is what
 * it does with a token signed by a key it does not trust — and a fixture that could only produce trusted tokens could not
 * drive that case at all.
 */
export function createLocalRealm(issuer = 'https://id.example/realms/vg'): LocalRealm & {
  newKey(): { sign(claims: Record<string, unknown>, header?: Record<string, unknown>): string; jwks: JwksDocument };
} {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'local-key-1';
  const publicJwk = { ...(publicKey.export({ format: 'jwk' }) as unknown as JsonWebKey), kid, alg: 'RS256', use: 'sig' } as JsonWebKey;

  const signWith = (key: KeyObject, headerKid: string) =>
    (claims: Record<string, unknown>, header: Record<string, unknown> = {}): string => {
      const headerPart = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: headerKid, ...header }));
      const payloadPart = base64url(JSON.stringify(claims));
      const signingInput = `${headerPart}.${payloadPart}`;
      const signature = createSign('RSA-SHA256').update(signingInput).sign(key);
      return `${signingInput}.${base64url(signature)}`;
    };

  return {
    issuer,
    kid,
    jwks: { keys: [publicJwk] },
    publicJwk,
    sign: signWith(privateKey, kid),
    newKey() {
      const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const otherKid = 'untrusted-key-1';
      const otherJwk = { ...(other.publicKey.export({ format: 'jwk' }) as unknown as JsonWebKey), kid: otherKid, alg: 'RS256', use: 'sig' } as JsonWebKey;
      return { sign: signWith(other.privateKey, otherKid), jwks: { keys: [otherJwk] } };
    },
  };
}

/** The claim set SPEC-005 IDP-4 requires, with the audience and lifetime a caller chooses. */
export function standardClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'operator-opaque-1',
    iss: 'https://id.example/realms/vg',
    aud: 'vg-portal',
    exp: now + 900,
    nbf: now - 5,
    iat: now,
    tenant_id: '11111111-1111-4111-8111-111111111111',
    roles: ['AUDITOR'],
    subject_ref: 'subject-opaque-1',
    auth_level: 'webauthn',
    azp: 'vanishgraph-portal',
    scopes: ['vg.cases.read'],
    ...overrides,
  };
}

