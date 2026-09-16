/**
 * Realm-side session operations: refresh revocation, global sign-out, administrative revocation (SPEC-005 §10; EP-006 M2).
 *
 * THESE ARE REAL CALLS THAT FAIL CLOSED. Each one performs an HTTP request to the realm and reports success ONLY on the
 * realm's own response: a revocation that reported success because the request was queued, retried or swallowed would
 * leave a live refresh token in an attacker's hands while telling the operator the session was ended. When the realm is
 * unreachable the operation throws `DEPENDENCY_UNAVAILABLE`, which is the code SPEC-006 §7.1 maps to `503` — and the
 * suite drives exactly that path with a transport that refuses.
 *
 * UNTIL `KEYCLOAK_ISSUER` IS PROVISIONED, NOTHING HERE CAN BE EXERCISED AGAINST A REALM. The suite that drives it records
 * `BLOCKED_CREDENTIALS` on `KEYCLOAK_ISSUER` (probe: `sh scripts/probes/keycloak.sh`) and asserts the failure path
 * rather than the success path; asserting success would be asserting a realm that does not exist.
 */

import type { IdentityRefusal } from '../../application/contracts/identity.ts';

export interface RealmEndpoints {
  /** The realm's token endpoint, used for refresh-token revocation (RFC 7009). */
  readonly revocationEndpoint: string;
  /** The realm's logout endpoint, used for global sign-out. */
  readonly endSessionEndpoint: string;
  /** The admin API base, used for administrative revocation. */
  readonly adminBase: string;
}

export interface RealmCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  /** A short-lived administrative token. Passed per call: this module stores no credential. */
  readonly adminAccessToken?: string | undefined;
}

/** A failed realm operation, carrying the wire code the HTTP layer maps. */
export class RealmOperationError extends Error {
  readonly code: IdentityRefusal;

  constructor(code: IdentityRefusal, detail: string) {
    super(detail);
    this.name = 'RealmOperationError';
    this.code = code;
    this.detail = detail;
  }

  readonly detail: string;
}

export interface RealmTransport {
  (url: string, init: RequestInit): Promise<{ readonly status: number; readonly body: string }>;
}

export interface RealmSessionOperations {
  revokeRefreshToken(token: string): Promise<void>;
  globalSignOut(refreshToken: string): Promise<void>;
  revokeUserSessions(userId: string): Promise<void>;
}

const FORM = 'application/x-www-form-urlencoded';

/**
 * Build the operations over a transport.
 *
 * A NON-2XX RESPONSE IS A FAILURE, INCLUDING 404: a revocation endpoint that does not exist is a realm that cannot revoke,
 * and treating 404 as "already revoked" would report success for the one case where nothing was done.
 */
export function realmSessionOperations(
  endpoints: RealmEndpoints,
  credentials: RealmCredentials,
  transport: RealmTransport,
): RealmSessionOperations {
  async function call(what: string, url: string, init: RequestInit): Promise<void> {
    let response: { status: number; body: string };
    try {
      response = await transport(url, init);
    } catch (error) {
      throw new RealmOperationError(
        'DEPENDENCY_UNAVAILABLE',
        `${what} could not reach the realm: ${error instanceof Error ? error.message : 'unknown transport failure'}`,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RealmOperationError(
        'DEPENDENCY_UNAVAILABLE',
        `${what} was refused by the realm with status ${String(response.status)}; nothing was revoked`,
      );
    }
  }

  return {
    async revokeRefreshToken(token: string): Promise<void> {
      const body = new URLSearchParams({ token, token_type_hint: 'refresh_token' });
      await call('refresh-token revocation', endpoints.revocationEndpoint, {
        method: 'POST',
        headers: { 'content-type': FORM, authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}` },
        body: body.toString(),
      });
    },

    async globalSignOut(refreshToken: string): Promise<void> {
      const body = new URLSearchParams({ refresh_token: refreshToken, client_id: credentials.clientId });
      await call('global sign-out', endpoints.endSessionEndpoint, {
        method: 'POST',
        headers: { 'content-type': FORM },
        body: body.toString(),
      });
    },

    async revokeUserSessions(userId: string): Promise<void> {
      if (credentials.adminAccessToken === undefined || credentials.adminAccessToken.length === 0) {
        // AN ADMINISTRATIVE REVOCATION WITHOUT AN ADMINISTRATIVE TOKEN IS NOT A PARTIAL OPERATION: it is no operation,
        // and reporting success would leave every session of that user alive.
        throw new RealmOperationError(
          'DEPENDENCY_UNAVAILABLE',
          'administrative revocation needs a short-lived admin token and none was supplied',
        );
      }
      await call('administrative revocation', `${endpoints.adminBase}/users/${encodeURIComponent(userId)}/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credentials.adminAccessToken}` },
      });
    },
  };
}
