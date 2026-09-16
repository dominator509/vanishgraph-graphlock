/**
 * The authority-grant repository port's contract (SPEC-005 VG-AUTHZ-005, VG-TENANT-002; EP-006 M4).
 *
 * THE PORT'S INVARIANTS ARE ASSERTED THROUGH THE IN-MEMORY IMPLEMENTATION, AND THAT IS WHAT THIS SUITE PROVES: the
 * tenant scoping a caller cannot bypass, the conditional revocation that reports a lost race instead of overwriting
 * history, and the reader `verifyAtExecutionTime` requires.
 *
 * IT DOES NOT PROVE PERSISTENCE. No Postgres adapter exists in this repository, and the suite says so rather than
 * implying that a database round-trip has been exercised: the column-level behaviour of a real adapter — and RLS as the
 * second enforcement layer — remain `BLOCKED_PREREQUISITE` on the adapter and on `DATABASE_URL`.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryAuthorityGrantRepository,
  type TransactionHandle,
} from '../../src/domain/ports/authority-repository.ts';
import { mintGrant, verifyAtExecutionTime } from '../../src/application/security/authority-service.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const SUBJECT = 'subject-opaque-1';
const NOW = '2026-09-16T00:00:00Z';
const TX: TransactionHandle = { id: 'tx-1' };

function grant(tenantId = TENANT, authorityGrantId = 'grant-1'): ReturnType<typeof mintGrant> {
  return mintGrant({
    authorityGrantId,
    tenantId,
    subjectRef: SUBJECT,
    kind: 'SELF',
    scope: ['vg.cases.read'],
    now: NOW,
    identityLevel: 'IAL2',
    evidenceArtifactId: null,
    noticeArtifactId: null,
    coolingOffUntil: null,
    expiresAt: '2027-09-16T00:00:00Z',
  });
}

describe('the port is tenant-scoped by shape, not by a check the caller remembers (VG-TENANT-002)', () => {
  test('a grant stored under one tenant is invisible under another', async () => {
    const repository = new InMemoryAuthorityGrantRepository();
    repository.seed(grant(TENANT));
    assert.ok(await repository.readForUpdate(TX, TENANT, 'grant-1') !== undefined);
    // THE TENANT IS A PARAMETER, so this is the only way to ask: a cross-tenant read is a call nobody can make.
    assert.equal(await repository.readForUpdate(TX, OTHER_TENANT, 'grant-1'), undefined);
  });

  test('the subject listing is confined to its tenant', async () => {
    const repository = new InMemoryAuthorityGrantRepository();
    repository.seed(grant(TENANT, 'grant-1'));
    repository.seed(grant(OTHER_TENANT, 'grant-2'));
    const listed = await repository.listForSubject(TX, TENANT, SUBJECT);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.authorityGrantId, 'grant-1');
  });
});

describe('the conditional writes report a lost race instead of overwriting history', () => {
  test('inserting the same grant twice reports already-present and keeps the first row', async () => {
    const repository = new InMemoryAuthorityGrantRepository();
    assert.equal(await repository.insert(TX, grant()), 'inserted');
    assert.equal(await repository.insert(TX, grant()), 'already-present');
    assert.equal(repository.all().length, 1);
    assert.equal(repository.all()[0]?.revokedAt, null);
  });

  test('a revocation expecting null succeeds once, and the second call reports already-revoked', async () => {
    const repository = new InMemoryAuthorityGrantRepository();
    await repository.insert(TX, grant());
    assert.equal(await repository.revoke(TX, TENANT, 'grant-1', null, NOW), 'revoked');
    // The caller that read `null` and lost the race must not overwrite the timestamp: history is not rewritten.
    assert.equal(await repository.revoke(TX, TENANT, 'grant-1', null, '2026-09-17T00:00:00Z'), 'already-revoked');
    assert.equal(repository.all()[0]?.revokedAt, NOW);
  });

  test('a revocation of an absent grant, or in another tenant, is not-found', async () => {
    const repository = new InMemoryAuthorityGrantRepository();
    await repository.insert(TX, grant());
    assert.equal(await repository.revoke(TX, TENANT, 'grant-missing', null, NOW), 'not-found');
    assert.equal(await repository.revoke(TX, OTHER_TENANT, 'grant-1', null, NOW), 'not-found');
    assert.equal(repository.all()[0]?.revokedAt, null, 'nothing was revoked');
  });

  test('a contest is recorded, and it suspends the grant at execution time', async () => {
    const repository = new InMemoryAuthorityGrantRepository();
    await repository.insert(TX, grant());
    assert.equal(await repository.contest(TX, TENANT, 'grant-1', NOW), 'contested');
    assert.equal(await repository.contest(TX, OTHER_TENANT, 'grant-1', NOW), 'not-found');
    await assert.rejects(
      () => verifyAtExecutionTime('grant-1', NOW, (id) => repository.readForUpdate(TX, TENANT, id)),
      /was contested at/,
    );
  });
});

describe('the reader the execution-time check requires is the port’s own', () => {
  test('verifyAtExecutionTime works through the port and refuses once the stored row expires', async () => {
    const repository = new InMemoryAuthorityGrantRepository();
    repository.seed({ ...grant(), expiresAt: '2026-09-16T00:30:00Z' });
    const read = (id: string): Promise<ReturnType<typeof mintGrant> | undefined> => repository.readForUpdate(TX, TENANT, id);
    // Valid at the earlier read, expired at execution time: the port re-reads rather than trusting a cached value.
    assert.ok((await read('grant-1')) !== undefined, 'the request read it');
    await assert.rejects(() => verifyAtExecutionTime('grant-1', '2026-09-16T01:00:00Z', read), /expired at/);
  });
});
