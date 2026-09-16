/**
 * The `SecretResolver` port (SPEC-005 §8 VG-AUTH-011…015; SPEC-006 §7.1 row 16; EP-006 M8).
 *
 * **A FAILED RESOLUTION HAS ONE OUTCOME AND NO ALTERNATIVES.** The result union has `ok: false` with a code and NO value
 * field at all — a caller cannot fall back because there is nothing to fall back TO. That is deliberate: every fallback
 * (plaintext, `.env`, empty, cached) is a path where a credential the deployment did not intend to use gets used, and the
 * failure is exactly the moment somebody is tempted to add one.
 *
 * RESOLUTION IS BY REFERENCE. The port takes a reference — a name the deployment configured — rather than a value or a
 * path, so a caller cannot ask for "the secret in this file"; the adapter decides what a reference resolves to, and the
 * deployment's configuration is the only thing that can name one.
 */

/** How a secret is held. A static key is the exception, not the norm (VG-AUTH-011…013). */
export type SecretHolding = 'WORKLOAD_IDENTITY' | 'STATIC';

export interface SecretReference {
  /** The deployment's name for the secret, never a value. */
  readonly reference: string;
  readonly holding: SecretHolding;
  /** Required for a static key: the recorded, time-bounded exception. */
  readonly exception?: { readonly reason: string; readonly owner: string; readonly expiresAt: string } | undefined;
}

/** The identity asking for the secret. Recorded with every access (VG-AUTH-013). */
export interface WorkloadIdentity {
  readonly workload: string;
  readonly environment: string;
  readonly provider?: string | undefined;
}

export type SecretResolution =
  | { readonly ok: true; readonly reference: string; readonly value: string; readonly expiresAt: string | null }
  | { readonly ok: false; readonly code: 'DEPENDENCY_UNAVAILABLE' | 'SECRET_NOT_CONFIGURED' | 'STATIC_EXCEPTION_REQUIRED'; readonly detail: string };

export interface SecretResolver {
  resolve(reference: SecretReference, identity: WorkloadIdentity): Promise<SecretResolution>;
}

/** The audit row every access produces, whether it succeeded or not. */
export interface SecretAccessLog {
  readonly reference: string;
  readonly workload: string;
  readonly environment: string;
  readonly outcome: 'resolved' | 'refused';
  readonly code?: string;
  readonly at: string;
}
