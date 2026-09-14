/**
 * Key management port (SPEC-002 §4, VG-SEC-002) — declaration only.
 *
 * The domain owns this port because *what must be encrypted, and when key material must be
 * destroyed*, is a domain rule: PII must be unrecoverable after erasure (RET-2) and secrets must
 * never live in the application database (VG-SEC-002). Which KMS performs the wrapping is not a
 * domain question, so no managed-KMS detail appears here.
 *
 * PLACEMENT DEVIATION (recorded, not silent): EP-003 M7's change list named
 * `src/domain/key-provider.ts`. SPEC-001 §5.1 rule 1 requires one file per port inside a `ports/`
 * **directory** with `ports/index.ts` as the barrel, and this port is not in that table's
 * exception list. The execplan was followed on intent and corrected on placement, because a
 * second, differently-shaped port location would drift as later nodes execute.
 *
 * Nothing here may acquire an implementation: an implementation in this file would put key
 * material inside the layer whose whole value is that it is pure and testable.
 */

import type { TenantId } from '../identifiers.ts';

/**
 * A wrapped data-encryption key.
 *
 * `wrapped` is the DEK encrypted under a KEK. The plaintext DEK must never leave the provider,
 * and must never be persisted — only this wrapped form may be stored (`tenant_key.wrapped_dek`).
 */
export interface WrappedKey {
  readonly tenantId: TenantId;
  /** Version of the DEK, recorded on every ciphertext row so rotation need not rewrite history. */
  readonly keyVersion: number;
  /** The DEK encrypted under the KEK. Opaque to the domain. */
  readonly wrapped: Uint8Array;
  /** Names the KEK that wrapped it, so a KEK rotation is traceable. */
  readonly kekRef: string;
  /** Which provider produced it. A local file provider is TESTS ONLY (VG-SCOPE-020). */
  readonly provider: string;
}

/**
 * Envelope encryption operations.
 *
 * Every method takes a tenant because keys are per tenant: one tenant's key must never decrypt
 * another tenant's rows, so cross-tenant decryption is impossible rather than merely refused.
 */
export interface KeyProvider {
  /**
   * Wrap a newly generated DEK for a tenant, or return the existing active one.
   *
   * Idempotent for an ACTIVE version: calling it twice must not orphan the first DEK, because
   * ciphertext already written under it would become undecryptable.
   */
  wrap(tenantId: TenantId, keyVersion: number): Promise<WrappedKey>;

  /**
   * Unwrap a DEK and decrypt `ciphertext`.
   *
   * MUST fail closed. A wrong, rotated-away or shredded key throws; it must never return
   * partial, truncated, or garbage plaintext, because a caller that receives bytes it believes
   * are plaintext cannot tell that decryption silently failed.
   */
  unwrap(tenantId: TenantId, keyVersion: number, ciphertext: Uint8Array): Promise<Uint8Array>;

  /**
   * Produce a new active version for a tenant.
   *
   * Existing rows keep their old `key_version` and stay readable: rotation must not require
   * rewriting history (SPEC-002 §4).
   */
  rotate(tenantId: TenantId): Promise<WrappedKey>;

  /**
   * Destroy key material for a tenant version, making every ciphertext under it unrecoverable.
   *
   * This is the erasure mechanism (RET-2): erasure destroys keys rather than relying on row
   * deletion, so a surviving backup copy of the rows is still unreadable. Returns the versions
   * destroyed so the caller can record them on an `erasure_tombstone` (RET-3).
   *
   * Shredding is idempotent — shredding an already-shredded version is not an error, because a
   * retried erasure must not fail.
   */
  shred(tenantId: TenantId, keyVersion: number): Promise<readonly number[]>;
}

/**
 * A keyed HMAC over a value, for equality lookup.
 *
 * SPEC-002 §4: `value_hmac` lets the system answer "is this identifier already known?" without
 * decrypting, and without exposing low-entropy values to offline guessing — which is why it is
 * a keyed HMAC and not a bare hash.
 */
export interface ValueHasher {
  /** Must be deterministic for a tenant so lookups match, and keyed so a dump is not guessable. */
  hmac(tenantId: TenantId, value: string): Promise<Uint8Array>;
}
