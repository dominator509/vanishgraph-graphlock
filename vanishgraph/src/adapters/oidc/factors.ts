/**
 * Authentication-factor enforcement: MFA and access-token lifetime (SPEC-005 IDP-2/IDP-3; SPEC-003 §3.2; EP-006 M2).
 *
 * WHAT THIS MODULE PROVES AND WHAT IT CANNOT. It reads the factor evidence a REALM puts in a token and decides whether the
 * session satisfies IDP-2. It does not make a realm require MFA: realm configuration, enrolment and the actual
 * second-factor ceremony are `BLOCKED_CREDENTIALS` on `KEYCLOAK_ISSUER`, and no assertion here claims otherwise.
 *
 * THE EVIDENCE IS THE TOKEN'S OWN `amr`/`acr`, AND THE CONTRACT'S CLAIM NAME IS `auth_level`. MEASURED: SPEC-005 IDP-4
 * fixes the wire claim as `auth_level`, while the plan's M2 text lists camelCase names (`authTime`, `acr`,
 * `tenantId`) that SPEC-003 §3.2 item 2 states appear NOWHERE in the contract — the same correction EP-004 M3 already
 * made for `tenant_id`. So this module reads the standard OIDC `acr` and `amr` claims where the realm supplies them AND
 * the contract's `auth_level`, and it treats the strongest evidence present as the session's factor level. A token with
 * none of them is a session with NO proven factor, which is refused for every human role rather than assumed to be
 * password-only: "absent means unverified" is the rule SPEC-003 §3.2 item 2 sets for `roles`, and the same reasoning
 * applies to a claim that asserts a second factor.
 *
 * WEBAUTHN IS REQUIRED FOR TWO ROLES, NOT PREFERRED. IDP-2 makes WebAuthn "preferred and required for `TENANT_ADMIN` and
 * `OPERATOR`", so those two are refused a TOTP-only session with `STEP_UP_REQUIRED` while every other human role is
 * refused only if it has no second factor at all.
 */

import type { IdentityClaims } from '../../application/contracts/identity.ts';

/** The factor levels a token can evidence, strongest first. */
export type FactorLevel = 'WEBAUTHN' | 'TOTP' | 'PASSWORD_ONLY' | 'UNVERIFIED';

/** The additional claims this module reads, beyond SPEC-005 IDP-4's required set. */
export interface FactorClaims {
  /** The standard OIDC authentication context class reference, when the realm supplies it. */
  readonly acr?: string | undefined;
  /** The standard OIDC authentication methods references, when the realm supplies them. */
  readonly amr?: readonly string[] | undefined;
}

/** The roles that require WebAuthn specifically (IDP-2). */
export const WEBAUTHN_REQUIRED_ROLES: readonly string[] = Object.freeze(['TENANT_ADMIN', 'OPERATOR']);

/** The roles that require a second factor of any kind (IDP-2: MFA is required for every human account). */
const HUMAN_ROLES: readonly string[] = Object.freeze([
  'SUBJECT_USER',
  'GUARDIAN',
  'OPERATOR',
  'TENANT_ADMIN',
  'AUDITOR',
  'SUPPORT',
  'COUNSEL_REVIEWER',
]);

/** The `amr` values that evidence WebAuthn, and those that evidence a second factor but not WebAuthn. */
const WEBAUTHN_AMR = ['webauthn', 'hwk', 'fido2', 'passkey'];
const SECOND_FACTOR_AMR = ['otp', 'totp', 'mfa', 'sms', 'phone', 'hotp'];

function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The factor level a session evidences.
 *
 * `acr` IS READ AS WELL AS `amr`, because a realm may express the level either way and a check that read only one of them
 * would refuse a correctly configured session. The strongest evidence present wins; nothing here infers a factor from
 * the absence of a claim.
 */
export function factorLevel(claims: IdentityClaims & FactorClaims): FactorLevel {
  const amr = (claims.amr ?? []).map(fold);
  const acr = fold(claims.acr ?? '');
  const level = fold(claims.auth_level ?? '');
  const all = [...amr, acr, level];
  if (all.some((value) => WEBAUTHN_AMR.some((marker) => value.includes(marker)))) return 'WEBAUTHN';
  if (all.some((value) => SECOND_FACTOR_AMR.some((marker) => value.includes(marker)))) return 'TOTP';
  if (all.some((value) => value.includes('pwd') || value.includes('password') || value.includes('single'))) {
    return 'PASSWORD_ONLY';
  }
  // NOTHING CLAIMED A FACTOR: that is unverified, not password-only, and it is refused for every human role.
  return 'UNVERIFIED';
}

export interface FactorDecision {
  readonly ok: boolean;
  /** The wire code for a refusal: `STEP_UP_REQUIRED` for a factor gap, `TOKEN_INVALID_CLAIMS` for no evidence at all. */
  readonly code?: 'STEP_UP_REQUIRED' | 'TOKEN_INVALID_CLAIMS';
  readonly detail?: string;
  readonly level: FactorLevel;
  /** The roles in the token that demanded more than the session evidenced. */
  readonly demandingRoles: readonly string[];
}

/**
 * Whether a session satisfies IDP-2 for the roles it holds.
 *
 * A MACHINE TOKEN IS OUT OF SCOPE HERE and is not silently passed: a token with no human role at all has nothing for
 * IDP-2 to require, and the caller decides what to do with it (SPEC-005 IDP-5 governs machine identity). This function
 * therefore reports `ok: true` for such a token WITHOUT claiming a factor, and the detail says so.
 */
export function enforceFactors(claims: IdentityClaims & FactorClaims): FactorDecision {
  const level = factorLevel(claims);
  const humanRoles = claims.roles.filter((role) => HUMAN_ROLES.includes(role));
  if (humanRoles.length === 0) {
    return {
      ok: true,
      level,
      demandingRoles: [],
      detail: 'no human role is held, so IDP-2 has no factor requirement to apply to this session',
    };
  }
  if (level === 'UNVERIFIED') {
    return {
      ok: false,
      code: 'TOKEN_INVALID_CLAIMS',
      level,
      demandingRoles: humanRoles,
      detail:
        'the token carries no factor evidence at all (no acr, no amr, and no auth_level): absent means unverified, and an unverified session is not a password-only session that can be stepped up',
    };
  }
  const needingWebauthn = humanRoles.filter((role) => WEBAUTHN_REQUIRED_ROLES.includes(role));
  if (needingWebauthn.length > 0 && level !== 'WEBAUTHN') {
    return {
      ok: false,
      code: 'STEP_UP_REQUIRED',
      level,
      demandingRoles: needingWebauthn,
      detail: `${needingWebauthn.join(', ')} require WebAuthn (SPEC-005 IDP-2); this session evidences ${level}`,
    };
  }
  if (level === 'PASSWORD_ONLY') {
    return {
      ok: false,
      code: 'STEP_UP_REQUIRED',
      level,
      demandingRoles: humanRoles,
      detail: 'MFA is required for every human account (SPEC-005 IDP-2); this session evidences a password factor only',
    };
  }
  return { ok: true, level, demandingRoles: [] };
}

/** The maximum access-token lifetime IDP-3 permits. */
export const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;

/**
 * Whether the token's own claims show a lifetime within IDP-3's limit.
 *
 * IT USES `iat`, NOT THE CURRENT CLOCK, and that is the difference between a property of the TOKEN and a property of the
 * moment: a token minted with a 60-minute lifetime is a misconfiguration even if it is checked one second after issue,
 * and measuring `exp - now` would pass for the first fifteen minutes of a badly configured realm.
 */
export function lifetimeWithinLimit(claims: IdentityClaims): { readonly ok: boolean; readonly lifetimeSeconds: number | null } {
  if (claims.iat === undefined || claims.exp === undefined) return { ok: false, lifetimeSeconds: null };
  const lifetimeSeconds = claims.exp - claims.iat;
  return { ok: lifetimeSeconds > 0 && lifetimeSeconds <= MAX_ACCESS_TOKEN_LIFETIME_SECONDS, lifetimeSeconds };
}
