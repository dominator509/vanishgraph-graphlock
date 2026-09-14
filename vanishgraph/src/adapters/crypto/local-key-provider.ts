/**
 * Local file-backed `KeyProvider` — TESTS AND LOCAL DEVELOPMENT ONLY.
 *
 * ============================ READ THIS BEFORE USING IT ============================
 * This provider keeps key material in a process-local map and wraps DEKs with a KEK derived
 * from a file on disk. It is NOT a KMS:
 *
 *   * there is no HSM, no hardware root of trust, and no key custody separation;
 *   * the KEK sits in the same filesystem as the database it protects, so an attacker who
 *     obtains the host obtains both;
 *   * there is no audit of key use, no access policy, and no attestation.
 *
 * It exists so that the encryption, rotation and crypto-shred MECHANICS can be executed against
 * real PostgreSQL in tests (RET-5). It must never be selected in a production configuration
 * (VG-SCOPE-020). The KMS adapter that would be production-appropriate is UNIMPLEMENTED and
 * recorded BLOCKED_CREDENTIALS, because ADR-006 (cloud/KMS selection) is still OPEN.
 * ==================================================================================
 *
 * The cryptographic primitives are real: AES-256-GCM from node:crypto, with a fresh random IV
 * per operation and the tenant id plus key version bound in as additional authenticated data.
 * A test provider that used fake crypto would prove nothing about the mechanism it exists to
 * exercise, so the primitives are genuine even though the key custody is not.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { KeyProvider, ValueHasher, WrappedKey } from '../../domain/ports/key-provider.ts';
import { TenantId } from '../../domain/identifiers.ts';

const DEK_BYTES = 32;
const KEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Binds ciphertext to its tenant and version so a blob cannot be replayed under another key. */
function aad(tenantId: string, keyVersion: number): Buffer {
  return Buffer.from(`vg:${tenantId}:${keyVersion}`, 'utf8');
}

export class LocalKeyProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalKeyProviderError';
  }
}

/**
 * An in-memory, genuinely-encrypting key provider for tests.
 *
 * Construct with a fixed `kekSeed` to make a run reproducible; omit it to generate one.
 */
export class LocalFileKeyProvider implements KeyProvider, ValueHasher {
  private readonly kek: Buffer;
  /** tenant -> version -> plaintext DEK. Never persisted; this is what `shred` destroys. */
  private readonly deks = new Map<string, Map<number, Buffer>>();
  /** tenant -> the version currently used for new writes. */
  private readonly active = new Map<string, number>();
  private readonly rotated = new Map<string, number[]>();
  private readonly shredded = new Map<string, number[]>();
  /** Records every operation, so tests can assert that shredding really touched the key store. */
  readonly operations: string[] = [];

  constructor(options: { kekSeed?: Uint8Array } = {}) {
    this.kek = options.kekSeed === undefined
      ? randomBytes(KEK_BYTES)
      : Buffer.from(options.kekSeed);
    if (this.kek.length !== KEK_BYTES) {
      throw new LocalKeyProviderError(`KEK must be ${DEK_BYTES} bytes, got ${this.kek.length}`);
    }
  }

  private tenantKey(tenantId: TenantId): string {
    return tenantId.value;
  }

  private versionMap(tenantId: TenantId): Map<number, Buffer> {
    const key = this.tenantKey(tenantId);
    let map = this.deks.get(key);
    if (map === undefined) {
      map = new Map();
      this.deks.set(key, map);
    }
    return map;
  }

  async wrap(tenantId: TenantId, keyVersion: number): Promise<WrappedKey> {
    const map = this.versionMap(tenantId);
    const existing = map.get(keyVersion);
    let dek = existing;

    if (dek === undefined) {
      // A shredded version must not be silently recreated: that would resurrect data whose
      // erasure was already recorded on a tombstone.
      if (this.shredded.get(this.tenantKey(tenantId))?.includes(keyVersion) === true) {
        throw new LocalKeyProviderError(
          `key version ${keyVersion} for tenant ${tenantId.value} was shredded and must not be recreated (RET-2)`,
        );
      }
      dek = randomBytes(DEK_BYTES);
      map.set(keyVersion, dek);
      this.operations.push(`wrap:${tenantId.value}:${keyVersion}`);
    }

    this.active.set(this.tenantKey(tenantId), keyVersion);
    const wrapped = this.wrapDek(dek, tenantId, keyVersion);

    // Verify the round trip before handing the wrapped form out. A provider that produced
    // wrapped material it could not itself unwrap would make every row written under this
    // version permanently unreadable, and the failure would surface only at read time — long
    // after the ciphertext was committed. Checking here turns that into a write-time error.
    const roundTripped = this.unwrapDek(wrapped, tenantId, keyVersion);
    if (!roundTripped.equals(dek)) {
      throw new LocalKeyProviderError(
        `wrap/unwrap round trip mismatch for tenant ${tenantId.value} version ${keyVersion}`,
      );
    }

    return {
      tenantId,
      keyVersion,
      wrapped,
      kekRef: 'local-file-kek-v1',
      provider: 'local-file',
    };
  }

  private wrapDek(dek: Buffer, tenantId: TenantId, keyVersion: number): Uint8Array {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    cipher.setAAD(aad(tenantId.value, keyVersion));
    const body = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  /**
   * Decrypt `wrapped` back to the DEK.
   *
   * Used by `wrap` to verify the round trip. A real KMS provider would call its API here; this
   * one holds the KEK locally, which is the property that makes it tests-only (VG-SCOPE-020).
   */
  private unwrapDek(wrapped: Uint8Array, tenantId: TenantId, keyVersion: number): Buffer {
    const buf = Buffer.from(wrapped);
    if (buf.length <= IV_BYTES + TAG_BYTES) {
      throw new LocalKeyProviderError('wrapped key is truncated');
    }
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAAD(aad(tenantId.value, keyVersion));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      // Fail closed: an authentication failure throws rather than yielding partial plaintext.
      throw new LocalKeyProviderError(
        `key unwrap failed for tenant ${tenantId.value} version ${keyVersion}: wrong key or tampered material`,
      );
    }
  }

  /** Encrypt a value under a tenant's key version. Used to produce real ciphertext rows. */
  encrypt(tenantId: TenantId, keyVersion: number, plaintext: Uint8Array): Uint8Array {
    const dek = this.deks.get(this.tenantKey(tenantId))?.get(keyVersion);
    if (dek === undefined) {
      throw new LocalKeyProviderError(
        `no key material for tenant ${tenantId.value} version ${keyVersion}: it was never wrapped or was shredded`,
      );
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(aad(tenantId.value, keyVersion));
    const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  /**
   * Decrypt a value under a tenant's key version.
   *
   * Fails closed by construction: after `shred` the DEK is gone from the key map, so this throws
   * even though the ciphertext bytes are untouched. That is the whole mechanism of
   * crypto-shredding, and it is why the retention suite can assert unrecoverability while the
   * row is still physically present.
   */
  async unwrap(tenantId: TenantId, keyVersion: number, ciphertext: Uint8Array): Promise<Uint8Array> {
    const dek = this.deks.get(this.tenantKey(tenantId))?.get(keyVersion);
    if (dek === undefined) {
      throw new LocalKeyProviderError(
        `cannot decrypt for tenant ${tenantId.value} version ${keyVersion}: key material is gone (shredded or never created)`,
      );
    }
    const buf = Buffer.from(ciphertext);
    if (buf.length <= IV_BYTES + TAG_BYTES) {
      throw new LocalKeyProviderError('ciphertext is truncated');
    }
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(aad(tenantId.value, keyVersion));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new LocalKeyProviderError(
        `decryption failed for tenant ${tenantId.value} version ${keyVersion}: wrong key, wrong tenant, or tampered ciphertext`,
      );
    }
  }

  async rotate(tenantId: TenantId): Promise<WrappedKey> {
    const next = (this.active.get(this.tenantKey(tenantId)) ?? 0) + 1;
    const previous = this.active.get(this.tenantKey(tenantId));
    if (previous !== undefined) {
      const list = this.rotated.get(this.tenantKey(tenantId)) ?? [];
      list.push(previous);
      this.rotated.set(this.tenantKey(tenantId), list);
    }
    this.operations.push(`rotate:${tenantId.value}:${next}`);
    return this.wrap(tenantId, next);
  }

  async shred(tenantId: TenantId, keyVersion: number): Promise<readonly number[]> {
    const map = this.deks.get(this.tenantKey(tenantId));
    // Idempotent: a retried erasure must not fail.
    if (map?.has(keyVersion) === true) {
      map.delete(keyVersion);
    }
    const list = this.shredded.get(this.tenantKey(tenantId)) ?? [];
    if (!list.includes(keyVersion)) list.push(keyVersion);
    this.shredded.set(this.tenantKey(tenantId), list);
    this.operations.push(`shred:${tenantId.value}:${keyVersion}`);

    // A shredded version must not remain the active one, or new writes would target a dead key.
    if (this.active.get(this.tenantKey(tenantId)) === keyVersion) {
      this.active.delete(this.tenantKey(tenantId));
    }
    return [...list];
  }

  /** Test-only introspection: is any key material still held for this version? */
  hasKeyMaterial(tenantId: TenantId, keyVersion: number): boolean {
    return this.deks.get(this.tenantKey(tenantId))?.has(keyVersion) === true;
  }

  async hmac(tenantId: TenantId, value: string): Promise<Uint8Array> {
    // Keyed per tenant, so the same value under two tenants yields different digests and a
    // stolen digest table cannot be matched across tenants.
    const map = this.versionMap(tenantId);
    const version = this.active.get(this.tenantKey(tenantId)) ?? 1;
    let dek = map.get(version);
    if (dek === undefined) {
      dek = randomBytes(DEK_BYTES);
      map.set(version, dek);
    }
    return createHmac('sha256', dek).update(value, 'utf8').digest();
  }
}

/** Constant-time comparison for hashes, so a lookup cannot be used as a timing oracle. */
export function hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
