/**
 * The authorization-code flow and the realm session operations (SPEC-005 IDP-1/§10; EP-006 M2).
 *
 * This proves the flow LOGIC; it does not prove the realm configuration, which is BLOCKED_CREDENTIALS on
 * KEYCLOAK_ISSUER. Nothing here is asserted against a live realm: the success path of a revocation cannot be exercised
 * without one, so the suite drives the FAILURE path (which is the path that must fail closed) and records the success
 * path as `BLOCKED_CREDENTIALS` rather than testing a stub that pretends to be Keycloak.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  GRANT_TYPES,
  RESPONSE_TYPES,
  SingleUseStateStore,
  buildAuthorizationRequest,
  codeChallengeS256,
  validateCallback,
} from '../../src/adapters/oidc/authorization-code.ts';
import { RealmOperationError, realmSessionOperations } from '../../src/adapters/oidc/revocation.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const ADAPTER = readFileSync(join(PROJECT_ROOT, 'src', 'adapters', 'oidc', 'authorization-code.ts'), 'utf8');

/** A store and a built request, which is the state every test below starts from. */
function attempt(now = 1_800_000_000_000): {
  readonly store: SingleUseStateStore;
  readonly request: ReturnType<typeof buildAuthorizationRequest>;
} {
  const store = new SingleUseStateStore();
  const request = buildAuthorizationRequest({
    authorizationEndpoint: 'https://id.example/realms/vg/protocol/openid-connect/auth',
    clientId: 'vanishgraph-portal',
    redirectUri: 'https://portal.example/callback',
    store,
    now,
  });
  return { store, request };
}

describe('the authorization request uses PKCE S256 and a fresh secret per attempt (IDP-1)', () => {
  test('the challenge is BASE64URL(SHA256(verifier)) and the method is S256, never plain', () => {
    const { request } = attempt();
    const params = new URL(request.url).searchParams;
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.equal(params.get('code_challenge'), codeChallengeS256(request.codeVerifier));
    // RFC 7636's own worked example, so the implementation is checked against the document rather than against itself.
    assert.equal(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    assert.notEqual(params.get('code_challenge'), request.codeVerifier, 'the verifier must never travel in the request');
  });

  test('the verifier is 32 random bytes and differs on every attempt', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 8; index += 1) {
      const { request } = attempt();
      assert.equal(Buffer.from(request.codeVerifier.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length, 32);
      seen.add(request.codeVerifier);
      assert.notEqual(request.url.includes(request.codeVerifier), true, 'the verifier is not in the URL');
    }
    assert.equal(seen.size, 8, 'every attempt must use a fresh verifier');
  });

  test('the response type and grant type are the only ones implemented', () => {
    assert.deepEqual([...RESPONSE_TYPES], ['code']);
    assert.deepEqual([...GRANT_TYPES], ['authorization_code']);
    const params = new URL(attempt().request.url).searchParams;
    assert.equal(params.get('response_type'), 'code');
  });

  test('NEGATIVE CASE: the prohibited flows appear nowhere in the adapter', () => {
    // IDP-1 prohibits implicit and resource-owner-password. The assertion is on the source, because the danger is a
    // later addition rather than a current call.
    for (const forbidden of ['response_type=token', 'response_type=id_token', 'grant_type=password', 'grant_type=client_credentials']) {
      assert.equal(ADAPTER.includes(forbidden), false, `the adapter must not implement ${forbidden}`);
    }
    assert.equal(/\bpassword\b/.test(ADAPTER.replace(/RESOURCE-OWNER-PASSWORD|resource-owner-password|hand their password|their password to a client/gi, '')), false);
  });
});

describe('state and nonce bind the callback to the attempt (IDP-1)', () => {
  test('a valid callback consumes the state and returns the binding', () => {
    const { store, request } = attempt();
    const result = validateCallback({ store, state: request.state, code: 'code-1', idTokenNonce: request.nonce, now: 1_800_000_001_000 });
    assert.equal(result.ok, true);
    assert.equal(result.binding?.codeVerifier, request.codeVerifier);
    assert.equal(store.size(), 0, 'the binding is consumed');
  });

  test('the state is SINGLE-USE: a second callback with the same state is refused', () => {
    const { store, request } = attempt();
    assert.equal(validateCallback({ store, state: request.state, code: 'c', idTokenNonce: request.nonce }).ok, true);
    const second = validateCallback({ store, state: request.state, code: 'c', idTokenNonce: request.nonce });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'STATE_REPLAYED');
  });

  test('a nonce mismatch is refused AND consumes the attempt', () => {
    const { store, request } = attempt();
    const bad = validateCallback({ store, state: request.state, code: 'c', idTokenNonce: 'a-different-nonce' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'NONCE_MISMATCH');
    // The retry must fail too: a state left alive after a nonce mismatch is a state an attacker can retry against.
    assert.equal(validateCallback({ store, state: request.state, code: 'c', idTokenNonce: request.nonce }).code, 'STATE_REPLAYED');
  });

  test('a missing nonce, a missing code and an unknown state are each refused distinctly', () => {
    assert.equal(validateCallback({ store: new SingleUseStateStore(), state: 'x', code: 'c', idTokenNonce: 'n' }).code, 'STATE_REPLAYED');
    const first = attempt();
    assert.equal(validateCallback({ store: first.store, state: first.request.state, code: 'c', idTokenNonce: undefined }).code, 'NONCE_MISSING');
    const second = attempt();
    assert.equal(validateCallback({ store: second.store, state: second.request.state, code: undefined, idTokenNonce: second.request.nonce }).code, 'CODE_MISSING');
    assert.equal(validateCallback({ store: second.store, state: undefined, code: 'c', idTokenNonce: 'n' }).code, 'STATE_UNKNOWN');
  });

  test('an expired attempt is refused even though the state was never used', () => {
    const { store, request } = attempt(1_000_000);
    const late = validateCallback({ store, state: request.state, code: 'c', idTokenNonce: request.nonce, now: 1_000_000 + 601_000 });
    assert.equal(late.ok, false);
    assert.equal(late.code, 'STATE_REPLAYED');
  });
});

describe('realm session operations fail closed (SPEC-005 §10)', () => {
  const endpoints = {
    revocationEndpoint: 'https://id.example/realms/vg/protocol/openid-connect/revoke',
    endSessionEndpoint: 'https://id.example/realms/vg/protocol/openid-connect/logout',
    adminBase: 'https://id.example/admin/realms/vg',
  };
  const credentials = { clientId: 'vanishgraph-portal', clientSecret: 'SECRET-SENTINEL-REALM' };

  test('an unreachable realm is DEPENDENCY_UNAVAILABLE, never a silent success', async () => {
    // BLOCKED_CREDENTIALS on KEYCLOAK_ISSUER: there is no realm to reach, and this is the path that must hold when there
    // is one and it is down. `503 DEPENDENCY_UNAVAILABLE` is what SPEC-006 §7.1 maps this code to.
    const refusing = async (): Promise<{ status: number; body: string }> => {
      throw new Error('ECONNREFUSED 127.0.0.1:443');
    };
    const operations = realmSessionOperations(endpoints, credentials, refusing);
    for (const call of [
      () => operations.revokeRefreshToken('refresh-1'),
      () => operations.globalSignOut('refresh-1'),
      () => operations.revokeUserSessions('user-1'),
    ]) {
      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof RealmOperationError, `expected a RealmOperationError, got ${String(error)}`);
        assert.equal(error.code, 'DEPENDENCY_UNAVAILABLE');
        return true;
      });
    }
  });

  test('a non-2xx realm response is a failure, including 404', async () => {
    for (const status of [400, 401, 404, 500, 503]) {
      const operations = realmSessionOperations(endpoints, credentials, async () => ({ status, body: '{}' }));
      await assert.rejects(
        () => operations.revokeRefreshToken('refresh-1'),
        (error: unknown) => {
          assert.equal((error as RealmOperationError).code, 'DEPENDENCY_UNAVAILABLE');
          assert.match((error as Error).message, new RegExp(`status ${String(status)}`));
          return true;
        },
        `status ${String(status)} must not be read as success`,
      );
    }
  });

  test('an administrative revocation without an admin token refuses rather than doing nothing quietly', async () => {
    const operations = realmSessionOperations(endpoints, credentials, async () => ({ status: 204, body: '' }));
    await assert.rejects(
      () => operations.revokeUserSessions('user-1'),
      /needs a short-lived admin token/,
    );
  });

  test('a 2xx response is the only thing that reports success, and the request carries what it must', async () => {
    const seen: { url: string; method: string; body: string }[] = [];
    const operations = realmSessionOperations(
      endpoints,
      { ...credentials, adminAccessToken: 'admin-token' },
      async (url, init) => {
        seen.push({ url, method: init.method ?? '', body: String(init.body ?? '') });
        return { status: 204, body: '' };
      },
    );
    await operations.revokeRefreshToken('refresh-1');
    await operations.globalSignOut('refresh-1');
    await operations.revokeUserSessions('user-1');
    assert.equal(seen.length, 3);
    assert.equal(seen[0]?.url, endpoints.revocationEndpoint);
    assert.match(seen[0]?.body ?? '', /token=refresh-1/);
    assert.match(seen[0]?.body ?? '', /token_type_hint=refresh_token/);
    assert.equal(seen[2]?.url, `${endpoints.adminBase}/users/user-1/logout`);
    // The suite asserts the failure path as the evidence; the success path above only shows the request shapes.
    assert.equal(seen.every((call) => call.method === 'POST'), true);
  });
});
