import type { TenantId } from '../../domain/identifiers.ts';

/**
 * The per-request context handed to application commands (SPEC-003 §2.4, §3.2 item 6).
 *
 * WHAT MUST NOT BE IN HERE, and why that is the point of the file:
 *
 *   * **No `tenantId` a caller can influence.** It comes from the verified token and nowhere else
 *     (VG-API-004). A body, query-string or path `tenantId` is rejected by strict schema parsing
 *     and never reaches this object.
 *   * **No bypass field.** There is no `isAdmin`, no `skipScopeCheck`, no `system` flag. A field
 *     like that is how a scope check acquires an "except for internal callers" branch, and that
 *     branch is the vulnerability. Authority is expressed only as `roles` and `scopes`, both
 *     checked against the route's declared requirements.
 *   * **No token, no raw claims, no authorisation header.** The context is what a command may rely
 *     on; carrying the credential forward would invite a later caller to re-read it.
 *
 * `requestId` is present and is one of exactly TWO sanctioned uses of the word "request" on the /v1
 * surface (SPEC-003 §7.3): it is standard HTTP call tracing, carries no domain meaning, and is not
 * a synonym for `RequestCase`. The vocabulary gate (VG-API-068) allows `X-Request-Id` and
 * `requestId` by exact name and rejects any other `request*` identifier.
 */

/** A clock port so a command's time is injected rather than read ambiently. */
export interface Clock {
  nowMs(): number;
}

export interface RequestContext {
  /**
   * From the verified token only. Never from a body, query string, or path (VG-API-004).
   *
   * Carries the BRANDED domain type rather than a bare string. SPEC-001 §2 makes identifiers opaque
   * branded values so a CaseId cannot be passed where a TenantId is expected; carrying a plain
   * string here would force every consumer to rebuild the brand, and a consumer that rebuilt it
   * WRONG (or skipped validation) would inject an unvalidated tenant into a scoped query. The
   * application layer may import the domain (ARCHITECTURE.md §2), so the brand is available here.
   */
  readonly tenantId: TenantId;
  /** The human operator (SPEC-005 IDP-4 `sub`). Never a `ProtectedSubject`. */
  readonly actorIdentity: string;
  /**
   * SPEC-005 §2 role names, verbatim: `SUBJECT_USER`, `GUARDIAN`, `OPERATOR`, `TENANT_ADMIN`,
   * `AUDITOR`, `SUPPORT`, `COUNSEL_REVIEWER`. Roles confer no privilege beyond their scopes
   * (SPEC-003 §3.2 item 6), so a role never authorises an effect by itself.
   */
  readonly roles: readonly string[];
  /** The closed §3.3 scope vocabulary held by this caller. */
  readonly scopes: readonly string[];
  /** SPEC-005 §4 level token (`IAL0`–`IAL3`). */
  readonly authLevel: string;
  /**
   * The token's `auth_time` in epoch seconds, used for the 5-minute step-up window of SPEC-005 §6.
   * Absent when the token did not carry one, which makes a step-up route refuse rather than assume
   * a fresh authentication.
   */
  readonly authTimeSeconds: number | undefined;
  /** Joins a client-visible failure to an audit row without exchanging PII (VG-API-003). */
  readonly correlationId: string;
  /** The HTTP invocation id. Sanctioned tracing name, no domain meaning (SPEC-003 §7.3). */
  readonly requestId: string;
  /** The `subject_ref` claim: the human operator's own subject reference, if any. */
  readonly subjectRef: string;
  readonly clock: Clock;
}

/**
 * The five SPEC-005 §2 role names this service recognises.
 *
 * SPEC-003 §14 R-1 records that an earlier draft invented `vg_analyst`, `vg_operator`,
 * `vg_reviewer`, `vg_auditor` and `vg_tenant_admin`. Those names exist in NO specification and must
 * not appear in code: a token carrying one would grant nothing, and a route checking for one would
 * deny every legitimate caller.
 */
export const ROLES = {
  SUBJECT_USER: 'SUBJECT_USER',
  GUARDIAN: 'GUARDIAN',
  OPERATOR: 'OPERATOR',
  TENANT_ADMIN: 'TENANT_ADMIN',
  AUDITOR: 'AUDITOR',
  SUPPORT: 'SUPPORT',
  COUNSEL_REVIEWER: 'COUNSEL_REVIEWER',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES: readonly Role[] = Object.values(ROLES);

/**
 * The 5-minute step-up window (SPEC-005 §6).
 *
 * `auth_level` alone is not enough: a token asserting a high level but minted hours ago is a stale
 * step-up, and SPEC-005 VG-AUTH-005 requires it be refused rather than silently downgraded.
 */
export const STEP_UP_WINDOW_SECONDS = 5 * 60;

/** Whether `authTime` is inside the step-up window relative to `nowMs`. */
export function isStepUpFresh(
  authTimeSeconds: number | undefined,
  nowMs: number,
  windowSeconds: number = STEP_UP_WINDOW_SECONDS,
): boolean {
  if (authTimeSeconds === undefined) return false;
  const ageSeconds = Math.floor(nowMs / 1000) - authTimeSeconds;
  // A clock skew that makes the token look FUTURE-dated is not a fresh step-up; it is an anomaly.
  if (ageSeconds < -30) return false;
  return ageSeconds <= windowSeconds;
}

/**
 * Whether every required scope is held.
 *
 * Set semantics, not substring matching: a scope `vg.subjects.read` must not be satisfied by a
 * hypothetical `vg.subjects.readonly`. Exact membership is the only safe comparison for a closed
 * capability vocabulary.
 */
export function holdsAllScopes(held: readonly string[], required: readonly string[]): boolean {
  const set = new Set(held);
  return required.every((scope) => set.has(scope));
}

/** Whether the caller holds at least one of the listed roles. An empty list requires none. */
export function holdsAnyRole(held: readonly string[], required: readonly string[]): boolean {
  if (required.length === 0) return true;
  const set = new Set(held);
  return required.some((role) => set.has(role));
}

/** Whether every listed role is held. Used where several roles must be present at once. */
export function holdsAllRoles(held: readonly string[], required: readonly string[]): boolean {
  const set = new Set(held);
  return required.every((role) => set.has(role));
}
