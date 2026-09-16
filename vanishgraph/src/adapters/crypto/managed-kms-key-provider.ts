/**
 * Managed-KMS `KeyProvider` — BLOCKED, and every operation refuses.
 *
 * ADR-006 (cloud/KMS selection) is still `OPEN`: the owner has not chosen a provider, and SPEC-002
 * §4 requires the KEK to live in a KMS. Until that decision is made there is nothing honest to
 * write here, because each candidate has a different API, a different key-reference format and a
 * different credential model.
 *
 * STATUS: `BLOCKED_CREDENTIALS` (ADR-006 open). This class is NOT a stub that returns a fake
 * wrapped key. A stub returning fabricated key material would be worse than no adapter at all:
 * ciphertext produced under it could never be unwrapped by any real KMS, and a test that passed
 * against it would prove nothing about the production path (DOD-010, DOD-027). Every method
 * throws `KeyProviderBlockedError`, which names the decision that unblocks it.
 *
 * DO NOT fill this in with a locally-generated key and call it a KMS. The local file-backed
 * provider exists for tests and is excluded from production (ADR-006 is OPEN; SPEC-002 §4); a second local
 * provider with a KMS-shaped class name would be indistinguishable from a real one during
 * configuration review, which is exactly the confusion that rule exists to prevent.
 *
 * There is no command in COMMANDS.md that selects this adapter, because there is no production
 * deployment yet. It is compiled, type-checked and covered by tests that assert it refuses.
 */

import type { KeyProvider, ValueHasher, WrappedKey } from '../../domain/ports/key-provider.ts';
import type { TenantId } from '../../domain/identifiers.ts';

export const KMS_ADAPTER_STATUS = 'BLOCKED_CREDENTIALS' as const;

/** The owner decision this adapter waits on, named so a blocker report can cite it. */
export const KMS_BLOCKING_DECISION = 'ADR-006 (cloud/KMS selection) is OPEN';

export class KeyProviderBlockedError extends Error {
  readonly status = KMS_ADAPTER_STATUS;
  constructor(operation: string) {
    super(
      `KMS key provider is ${KMS_ADAPTER_STATUS}: ${operation} is unavailable because ` +
        `${KMS_BLOCKING_DECISION}. Select a provider in DECISIONS.md ADR-006, then implement ` +
        'this adapter against its API. Do not substitute the local provider for a production claim.',
    );
    this.name = 'KeyProviderBlockedError';
  }
}

export class ManagedKmsKeyProvider implements KeyProvider, ValueHasher {
  async wrap(_tenantId: TenantId, _keyVersion: number): Promise<WrappedKey> {
    throw new KeyProviderBlockedError('wrap');
  }

  async unwrap(_tenantId: TenantId, _keyVersion: number, _ciphertext: Uint8Array): Promise<Uint8Array> {
    throw new KeyProviderBlockedError('unwrap');
  }

  async rotate(_tenantId: TenantId): Promise<WrappedKey> {
    throw new KeyProviderBlockedError('rotate');
  }

  async shred(_tenantId: TenantId, _keyVersion: number): Promise<readonly number[]> {
    throw new KeyProviderBlockedError('shred');
  }

  async hmac(_tenantId: TenantId, _value: string): Promise<Uint8Array> {
    throw new KeyProviderBlockedError('hmac');
  }
}
