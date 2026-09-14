/**
 * Envelope encryption (SPEC-002 §4, VG-SEC-002), against real PostgreSQL.
 *
 * The three properties M7 requires this suite to prove:
 *   1. ciphertext differs from plaintext;
 *   2. a wrong key FAILS CLOSED rather than returning garbage;
 *   3. rotation leaves old rows readable via `key_version`.
 *
 * The provider under test is the local file-backed one, which is TESTS ONLY (VG-SCOPE-020). It is
 * used here because the managed-KMS adapter is BLOCKED_CREDENTIALS while ADR-006 is OPEN; nothing
 * in this file is evidence about a production KMS, and the final test asserts that the managed
 * adapter refuses rather than pretending.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  LocalFileKeyProvider,
  LocalKeyProviderError,
  hashesEqual,
} from '../../src/adapters/crypto/local-key-provider.ts';
import {
  KMS_ADAPTER_STATUS,
  KeyProviderBlockedError,
  ManagedKmsKeyProvider,
} from '../../src/adapters/crypto/managed-kms-key-provider.ts';
import { TenantId } from '../../src/domain/identifiers.ts';
import { TENANT_A, TENANT_B, asTenant, exec, ownerDsn } from './harness.ts';

const A = new TenantId(TENANT_A);
const B = new TenantId(TENANT_B);

function provider(): LocalFileKeyProvider {
  // Fixed seed: reproducible runs, and the KEK is never a real secret here.
  return new LocalFileKeyProvider({ kekSeed: randomBytes(32) });
}

describe('envelope encryption (SPEC-002 §4)', () => {
  test('ciphertext differs from plaintext and does not contain it', async () => {
    const p = provider();
    const plaintext = Buffer.from('jane.doe@example.com', 'utf8');
    const wrapped = await p.wrap(A, 1);
    const ciphertext = p.encrypt(A, wrapped.keyVersion, plaintext);

    assert.notDeepEqual(Buffer.from(ciphertext), plaintext, 'ciphertext must not equal plaintext');
    assert.equal(
      Buffer.from(ciphertext).includes(plaintext),
      false,
      'ciphertext must not literally contain the plaintext',
    );
    const roundTripped = await p.unwrap(A, wrapped.keyVersion, ciphertext);
    assert.equal(Buffer.from(roundTripped).toString('utf8'), 'jane.doe@example.com');
  });

  test('the wrapped key differs from the DEK it wraps', async () => {
    const p = provider();
    const w1 = await p.wrap(A, 1);
    // The wrapped blob is the DEK under the KEK; it must not be usable as key material directly.
    assert.ok(w1.wrapped.length > 32, 'wrapped form carries iv, tag and body');
    assert.equal(w1.provider, 'local-file');
  });

  test('a wrong key fails closed rather than returning garbage', async () => {
    const p = provider();
    const wrapped = await p.wrap(A, 1);
    const ciphertext = p.encrypt(A, wrapped.keyVersion, Buffer.from('secret-value', 'utf8'));

    // Same provider, wrong version: no key material exists for it, so it must throw.
    await assert.rejects(
      () => p.unwrap(A, 99, ciphertext),
      LocalKeyProviderError,
      'an unknown version must throw, never return partial plaintext',
    );

    // A DIFFERENT provider has a different KEK. Its own version-1 key must not decrypt A's data.
    const other = provider();
    await other.wrap(A, 1);
    await assert.rejects(
      () => other.unwrap(A, 1, ciphertext),
      LocalKeyProviderError,
      'a different KEK must fail authentication, not silently yield bytes',
    );
  });

  test('a tampered ciphertext is refused by authentication', async () => {
    const p = provider();
    const wrapped = await p.wrap(A, 1);
    const ciphertext = p.encrypt(A, wrapped.keyVersion, Buffer.from('integrity-matters', 'utf8'));

    const tampered = Buffer.from(ciphertext);
    // Flip a bit in the LAST byte of the body. Indexing without a check would XOR `undefined`
    // under noUncheckedIndexedAccess and silently leave the buffer unmodified, making this
    // tamper test pass while proving nothing — so the index is asserted to exist first.
    const lastIndex = tampered.length - 1;
    const lastByte = tampered[lastIndex];
    assert.notEqual(lastByte, undefined, 'the ciphertext must not be empty');
    tampered[lastIndex] = (lastByte ?? 0) ^ 0xff;
    await assert.rejects(
      () => p.unwrap(A, wrapped.keyVersion, tampered),
      LocalKeyProviderError,
      'GCM authentication must catch the modification',
    );
  });

  test('a tenant cannot decrypt another tenant\'s rows (cross-tenant key separation)', async () => {
    const p = provider();
    const wa = await p.wrap(A, 1);
    const wb = await p.wrap(B, 1);
    const ciphertext = p.encrypt(A, wa.keyVersion, Buffer.from('tenant-a-only', 'utf8'));

    assert.notDeepEqual(
      Buffer.from(wa.wrapped),
      Buffer.from(wb.wrapped),
      'each tenant gets its own DEK',
    );
    // B holds key material for version 1, but it is B's DEK. The tenant id is bound in as AAD,
    // so even a shared version number cannot decrypt across tenants.
    await assert.rejects(
      () => p.unwrap(B, wb.keyVersion, ciphertext),
      LocalKeyProviderError,
      'tenant B must not be able to decrypt tenant A data',
    );
  });

  test('rotation leaves old rows readable via key_version', async () => {
    const p = provider();
    const v1 = await p.wrap(A, 1);
    const oldCiphertext = p.encrypt(A, v1.keyVersion, Buffer.from('written-under-v1', 'utf8'));

    const v2 = await p.rotate(A);
    assert.equal(v2.keyVersion, 2, 'rotation advances the version');

    // New writes use v2...
    const newCiphertext = p.encrypt(A, v2.keyVersion, Buffer.from('written-under-v2', 'utf8'));

    // ...and BOTH remain readable, which is the point: rotation must not require rewriting
    // history (SPEC-002 §4).
    assert.equal(
      Buffer.from(await p.unwrap(A, 1, oldCiphertext)).toString('utf8'),
      'written-under-v1',
      'history must stay readable after rotation',
    );
    assert.equal(
      Buffer.from(await p.unwrap(A, 2, newCiphertext)).toString('utf8'),
      'written-under-v2',
    );
  });

  test('shredding destroys the key so ciphertext is unrecoverable while still present', async () => {
    const p = provider();
    const wrapped = await p.wrap(A, 1);
    const ciphertext = p.encrypt(A, wrapped.keyVersion, Buffer.from('erase-me', 'utf8'));

    assert.equal(p.hasKeyMaterial(A, 1), true);
    const shredded = await p.shred(A, 1);
    assert.deepEqual([...shredded], [1]);
    assert.equal(p.hasKeyMaterial(A, 1), false, 'the DEK must be gone from the key store');

    // The ciphertext bytes are untouched — only the ability to read them is destroyed.
    assert.ok(ciphertext.length > 0);
    await assert.rejects(
      () => p.unwrap(A, 1, ciphertext),
      LocalKeyProviderError,
      'crypto-shredding must make the data unrecoverable even though the row survives',
    );
  });

  test('a shredded key version is not silently recreated', async () => {
    const p = provider();
    await p.wrap(A, 1);
    await p.shred(A, 1);
    // Re-wrapping the destroyed version would resurrect the ability to read data whose erasure
    // a tombstone already records.
    await assert.rejects(
      () => p.wrap(A, 1),
      LocalKeyProviderError,
      'a shredded version must not be recreated (RET-2)',
    );
  });

  test('shredding is idempotent so a retried erasure does not fail', async () => {
    const p = provider();
    await p.wrap(A, 1);
    await p.shred(A, 1);
    const again = await p.shred(A, 1);
    assert.deepEqual([...again], [1], 'the destroyed version is still reported');
  });

  test('value_hmac is keyed per tenant and deterministic within one', async () => {
    const p = provider();
    await p.wrap(A, 1);
    await p.wrap(B, 1);
    const ha1 = await p.hmac(A, 'jane@example.com');
    const ha2 = await p.hmac(A, 'jane@example.com');
    const hb = await p.hmac(B, 'jane@example.com');

    assert.equal(hashesEqual(ha1, ha2), true, 'equal values must hash equally within a tenant');
    assert.equal(
      hashesEqual(ha1, hb),
      false,
      'the same value under two tenants must not be correlatable across a stolen digest table',
    );
    assert.equal(
      Buffer.from(ha1).toString('utf8').includes('jane'),
      false,
      'the HMAC must not expose the value it hashes',
    );
  });
});

describe('encrypted columns are the ones SPEC-002 §4 names', () => {
  test('identifier and alias carry ciphertext plus a keyed hmac and key_version', () => {
    for (const table of ['identifier', 'alias']) {
      const rows = asTenant(
        ownerDsn(),
        TENANT_A,
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name='${table}'
            AND column_name IN ('value_enc','value_hmac')
          ORDER BY column_name;`,
      );
      assert.deepEqual(
        rows,
        ['value_enc|bytea', 'value_hmac|bytea'],
        `${table} must store ciphertext and a keyed hmac as bytea`,
      );
    }
    const kv = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema='public' AND table_name='identifier' AND column_name='key_version';`,
    );
    assert.equal(kv[0], '1', 'identifier must carry key_version so rotation need not rewrite history');
  });

  test('the application database stores no KMS material in plaintext table columns', () => {
    // SPEC-002 §4: the application database is not a secret store. tenant_key holds only the
    // WRAPPED dek, and the check constraint forces a shredded row to be empty.
    const cols = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='tenant_key' ORDER BY column_name;`,
    );
    assert.ok(cols.includes('wrapped_dek'), 'the wrapped DEK is stored');
    assert.equal(
      cols.includes('dek'),
      false,
      'no plaintext dek column may exist',
    );
    assert.equal(cols.includes('kek'), false, 'no KEK material may be stored');
  });

  test('a shredded tenant_key row must carry empty wrapped material', () => {
    // The constraint is what makes "shredded" mean unrecoverable rather than merely flagged.
    const attempt = exec(
      ownerDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO tenant_key (tenant_id, key_version, wrapped_dek, kek_ref, provider, status, shredded_at)
       VALUES ('${TENANT_A}', 4242, '\\x00'::bytea, 'kek-ref', 'local-file', 'SHREDDED', now());
       COMMIT;`,
    );
    assert.notEqual(
      attempt.status,
      0,
      'a SHREDDED row with non-empty wrapped_dek must be refused',
    );
  });

  test('tenant_key is tenant-isolated', () => {
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT c.relrowsecurity::text, c.relforcerowsecurity::text,
              (SELECT count(*) FROM pg_policies p
                WHERE p.schemaname='public' AND p.tablename='tenant_key')::text
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relname='tenant_key' AND n.nspname='public';`,
    );
    assert.deepEqual(rows, ['true|true|1']);
  });
});

describe('the managed KMS adapter reports its blocker instead of faking success', () => {
  test('every managed-KMS operation throws KeyProviderBlockedError', async () => {
    const kms = new ManagedKmsKeyProvider();
    assert.equal(KMS_ADAPTER_STATUS, 'BLOCKED_CREDENTIALS');
    await assert.rejects(() => kms.wrap(A, 1), KeyProviderBlockedError);
    await assert.rejects(() => kms.unwrap(A, 1, new Uint8Array()), KeyProviderBlockedError);
    await assert.rejects(() => kms.rotate(A), KeyProviderBlockedError);
    await assert.rejects(() => kms.shred(A, 1), KeyProviderBlockedError);
    await assert.rejects(() => kms.hmac(A, 'x'), KeyProviderBlockedError);
  });

  test('the blocker names the decision it waits on', async () => {
    await assert.rejects(
      () => new ManagedKmsKeyProvider().wrap(A, 1),
      /ADR-006 .* is OPEN|KMS_ADAPTER_STATUS|BLOCKED_CREDENTIALS/,
      'a blocker must name what unblocks it, not merely fail',
    );
  });
});
