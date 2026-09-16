/**
 * The `/v1` client the portal build resolves (SPEC-003 §2.5/§2.7/§8.1; EP-005 M5).
 *
 * IT IS THE REAL CLIENT, NOT A STUB WITH A FIXTURE MODE. The plan's fallback is explicit about this: "Do not stub a
 * fetch layer that returns fabricated success shapes in a production build — the production build must resolve the real
 * client, and the fixtures must be test-only (DOD-020)". So there is no `if (import.meta.env.DEV)` branch returning
 * sample rows, and no fixture module is reachable from `main.tsx`. On a machine with no API the surfaces render the
 * error state, which is TRUE of that machine.
 *
 * WHAT IT REQUIRES RATHER THAN DEFAULTS, AND WHY EACH ONE IS A RULE:
 *
 *   * A POST NEEDS AN `Idempotency-Key`. VG-ACTION-001 makes at-most-once the default, and a key generated inside this
 *     client would be a NEW key on every retry — which is the same as no key at all. The caller passes one it can reuse,
 *     so a retry after a failed response carries the key that makes it safe.
 *   * A CONDITIONAL WRITE NEEDS AN `If-Match`. SPEC-003's §5.5.3 and §5.14.1 both require it; sending the write without
 *     one would rely on the server's 428 to discover it, which turns a client bug into a failed user action.
 *   * NO AUTHORIZATION HEADER IS INVENTED. The token comes from an injected provider; when none is configured the
 *     request goes out without one and the API answers 401, which the surface renders as access-denied. Fabricating a
 *     header would make an unauthenticated build look authenticated.
 *
 * THE BASE URL IS SAME-ORIGIN BY DEFAULT (`/v1`). ADR-007 fixed a static bundle that talks to the API over the network,
 * and where the API lives is a deployment concern (a reverse proxy, a same-origin path) rather than a build-time
 * constant; the override exists for a deployment that mounts it elsewhere and for tests.
 */

import { ApiError, TransportFailure, isErrorEnvelope } from './errors.ts';

/** A response body with the validator that proves it is the shape the caller expects. */
export interface ResponseResult<T> {
  readonly body: T;
  readonly etag: string | null;
  readonly status: number;
}

export interface PortalClientOptions {
  /** Where `/v1` is mounted. Defaults to the same origin's `/v1`. */
  readonly baseUrl?: string;
  /** The transport. Tests inject one; production uses the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Supplies a bearer token, or `null` when the deployment has no identity provider configured. */
  readonly getAccessToken?: () => Promise<string | null>;
}

export interface PostOptions {
  /** Required: see the header. A retry MUST reuse the same key. */
  readonly idempotencyKey: string;
  /** Required for a conditional write; omitted only for a create that has no version to match. */
  readonly ifMatch?: string;
  readonly body?: unknown;
}

export class PortalClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #getAccessToken: (() => Promise<string | null>) | undefined;

  constructor(options: PortalClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? '/v1';
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#getAccessToken = options.getAccessToken;
  }

  async get<T>(path: string, validate: (body: unknown) => T): Promise<ResponseResult<T>> {
    return this.#send('GET', path, undefined, validate);
  }

  async post<T>(path: string, options: PostOptions, validate: (body: unknown) => T): Promise<ResponseResult<T>> {
    if (options.idempotencyKey.trim().length === 0) {
      throw new Error('PortalClient: a POST requires a non-empty Idempotency-Key (VG-ACTION-001)');
    }
    return this.#send('POST', path, options, validate);
  }

  async #send<T>(
    method: 'GET' | 'POST',
    path: string,
    options: PostOptions | undefined,
    validate: (body: unknown) => T,
  ): Promise<ResponseResult<T>> {
    const headers = new Headers({ accept: 'application/json' });
    if (options?.body !== undefined) headers.set('content-type', 'application/json');
    if (options !== undefined) headers.set('idempotency-key', options.idempotencyKey);
    if (options?.ifMatch !== undefined) headers.set('if-match', options.ifMatch);
    if (this.#getAccessToken !== undefined) {
      const token = await this.#getAccessToken();
      if (token !== null) headers.set('authorization', `Bearer ${token}`);
    }

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      throw new TransportFailure(
        response.status,
        `the API returned a body that is not JSON (${String(response.status)})`,
      );
    }

    if (!response.ok) {
      // THE ENVELOPE IS THE CONTRACT. A non-2xx without it is a contract violation, and reporting it as an `ApiError`
      // would invent a code and a correlation identifier the server never sent.
      if (!isErrorEnvelope(parsed)) {
        throw new TransportFailure(
          response.status,
          `the API returned ${String(response.status)} without the §8.1 error envelope`,
        );
      }
      throw new ApiError(response.status, parsed.error);
    }

    return { body: validate(parsed), etag: response.headers.get('etag'), status: response.status };
  }
}

/**
 * The client the application uses, constructed once at module scope.
 *
 * IT HAS NO TOKEN PROVIDER YET, and that is recorded rather than hidden: Keycloak is unprovisioned
 * (`KEYCLOAK_ISSUER` is one of the three provisioning actions in NEXT_ACTION.md), so requests are unauthenticated and
 * the API answers 401. When the identity provider is wired, the provider function is passed HERE — one place, at the
 * composition root, rather than a token read inside a surface.
 */
export const portalClient = new PortalClient();
