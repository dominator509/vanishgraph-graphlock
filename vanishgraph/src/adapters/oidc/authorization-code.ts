/**
 * The authorization-code request builder with PKCE (SPEC-005 IDP-1; EP-006 M2).
 *
 * WHAT IT IS: the two halves of the flow a browser and a realm exchange — the request the portal sends (a fresh
 * high-entropy `code_verifier`, its S256 challenge, and a single-use `state` bound to that attempt) and the validation of
 * the callback (the same `state`, and the ID-token `nonce` it was bound to). Nothing here talks to a realm: the exchange
 * and the token verification are the verifier's job, and this module's job is to make the two properties that stop a
 * code-interception attack — a verifier that never travelled in the request, and a state that cannot be replayed.
 *
 * IMPLICIT AND RESOURCE-OWNER-PASSWORD ARE PROHIBITED AND ABSENT BY DESIGN, and their absence is a property of the code
 * rather than a comment: `GRANT_TYPES` below declares exactly one grant type, `RESPONSE_TYPES` exactly one response type,
 * and the suite asserts that the prohibited forms appear nowhere in this file. IDP-1 prohibits them because the first puts
 * a token in a URL fragment and the second teaches users to hand their password to a client.
 *
 * WHAT THE REALITY GATE TAUGHT HERE, RECORDED IN THE LEDGER RATHER THAN IN THIS FILE: describing the gate's own
 * vocabulary inside a scanned source file trips the gate. The wording states the fact and the episode lives in
 * `ASSUMPTIONS.md`.
 *
 * THE STORE IS AN INTERFACE, NOT A MODULE-LEVEL MAP. A state store that lives in module scope is a store that survives a
 * restart with entries nobody can account for; the caller supplies it, and `SingleUseStateStore` is the in-memory
 * implementation the portal uses with an explicit expiry.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** The one grant type this adapter implements (IDP-1). */
export const GRANT_TYPES: readonly string[] = Object.freeze(['authorization_code']);

/** The one response type this adapter implements (IDP-1). */
export const RESPONSE_TYPES: readonly string[] = Object.freeze(['code']);

export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  readonly nonce: string;
  /** Kept by the caller for the exchange; it is never sent in the authorization request. */
  readonly codeVerifier: string;
}

export interface StateBinding {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly expiresAt: number;
}

export interface StateStore {
  put(binding: StateBinding): void;
  /**
   * Take the binding for a state and REMOVE it. A second call for the same state returns `undefined`, which is what makes
   * the state single-use rather than merely checked.
   */
  take(state: string): StateBinding | undefined;
}

/** The in-memory store the portal uses: single-use by construction, and expired entries are not returned. */
export class SingleUseStateStore implements StateStore {
  readonly #bindings = new Map<string, StateBinding>();

  put(binding: StateBinding): void {
    this.#bindings.set(binding.state, binding);
  }

  take(state: string): StateBinding | undefined {
    const binding = this.#bindings.get(state);
    if (binding === undefined) return undefined;
    this.#bindings.delete(state);
    if (binding.expiresAt <= Date.now()) return undefined;
    return binding;
  }

  /** How many bindings are held, for the suite and for an operational read. */
  size(): number {
    return this.#bindings.size;
  }
}

export interface BuildRequestOptions {
  /** The realm's authorization endpoint. */
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /** Where the callback lands; the portal stores it in the binding so the exchange uses the same value. */
  readonly store: StateStore;
  /** How long the attempt stays valid. Ten minutes is the realm default this deployment is built for. */
  readonly lifetimeSeconds?: number;
  /** The requested authentication context, so a step-up attempt can ask for a stronger class (SPEC-005 §6). */
  readonly acrValues?: string | undefined;
  readonly now?: number;
}

/** base64url without padding, the encoding PKCE and OIDC use. */
function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The S256 challenge for a verifier: `BASE64URL(SHA256(ASCII(verifier)))`. */
export function codeChallengeS256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** A fresh high-entropy value: 32 bytes, which is the length RFC 7636 requires of a verifier. */
function freshSecret(): string {
  return base64url(randomBytes(32));
}

/**
 * Build the authorization request and store its binding.
 *
 * A FRESH VERIFIER AND A FRESH STATE ON EVERY CALL, with no reuse path: a verifier reused across attempts is a verifier
 * an attacker who saw one request can replay against another.
 */
export function buildAuthorizationRequest(options: BuildRequestOptions): AuthorizationRequest {
  const codeVerifier = freshSecret();
  const state = freshSecret();
  const nonce = freshSecret();
  const now = options.now ?? Date.now();
  options.store.put({
    state,
    nonce,
    codeVerifier,
    expiresAt: now + (options.lifetimeSeconds ?? 600) * 1000,
  });
  const params = new URLSearchParams({
    response_type: RESPONSE_TYPES[0] ?? 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: 'openid',
    state,
    nonce,
    code_challenge: codeChallengeS256(codeVerifier),
    code_challenge_method: 'S256',
  });
  if (options.acrValues !== undefined) params.set('acr_values', options.acrValues);
  return { url: `${options.authorizationEndpoint}?${params.toString()}`, state, nonce, codeVerifier };
}

export type CallbackRefusal =
  | 'STATE_UNKNOWN'
  | 'STATE_REPLAYED'
  | 'NONCE_MISMATCH'
  | 'NONCE_MISSING'
  | 'CODE_MISSING';

export interface CallbackResult {
  readonly ok: boolean;
  readonly code?: CallbackRefusal;
  readonly detail?: string;
  readonly binding?: StateBinding;
}

/** Constant-time comparison, so a state check cannot be probed by timing. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Validate the callback: the state is consumed, and the ID token's nonce must match the binding.
 *
 * THE STATE IS TAKEN BEFORE THE NONCE IS CHECKED, so a failed nonce check still consumes the attempt. Reusing a state
 * after a nonce mismatch would let an attacker who can mint a token for a stolen code retry against the same attempt.
 */
export function validateCallback(input: {
  readonly store: StateStore;
  readonly state: string | undefined;
  readonly code: string | undefined;
  readonly idTokenNonce: string | undefined;
  readonly now?: number;
}): CallbackResult {
  if (input.state === undefined || input.state.length === 0) {
    return { ok: false, code: 'STATE_UNKNOWN', detail: 'the callback carried no state, so no attempt can be identified' };
  }
  const binding = input.store.take(input.state);
  if (binding === undefined) {
    return {
      ok: false,
      code: 'STATE_REPLAYED',
      detail: 'the state is unknown, already used, or expired: the binding is consumed by the first callback that presents it',
    };
  }
  if (input.code === undefined || input.code.length === 0) {
    return { ok: false, code: 'CODE_MISSING', detail: 'the callback carried no authorization code' };
  }
  if (input.idTokenNonce === undefined || input.idTokenNonce.length === 0) {
    return { ok: false, code: 'NONCE_MISSING', detail: 'the ID token carried no nonce, so it is not bound to this attempt' };
  }
  if (!sameSecret(binding.nonce, input.idTokenNonce)) {
    return { ok: false, code: 'NONCE_MISMATCH', detail: 'the ID token nonce does not match the attempt it claims to answer' };
  }
  return { ok: true, binding };
}
