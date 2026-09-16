/**
 * Authority verified AT EXECUTION TIME against real PostgreSQL (EP-006 M10; SPEC-005 §3 VG-AUTHZ-005/006/010/012,
 * SPEC-000 VG-AUTHZ-001, SPEC-006 VG-ERR-029).
 *
 * WHAT THIS SUITE PROVES, AND WHY IT NEEDS A DATABASE. `verifyAtExecutionTime` takes a READER rather than a grant, so a
 * caller cannot hand it authority it read earlier in the request. That shape is only half the property: the other half
 * is that the read it performs runs INSIDE the write transaction and therefore sees a revocation or an expiry that
 * COMMITTED after the request started. This suite writes real rows, commits a revocation from a SECOND CONNECTION, and
 * then asks the real `PostgresAuthorityGrantRepository` — the adapter M4 recorded as `BLOCKED_CREDENTIALS` and which
 * did not exist until M10 — what it sees. An in-memory double cannot fail this way, which is why the contract suite's
 * version of the same rule is not a substitute for it.
 *
 * EVERY REFUSAL IS PAIRED WITH ITS MUTATION CHECK (DOD-018). For the revocation and the expiry the check is EXECUTED,
 * not described: the grant read before the concurrent commit is still accepted by the same function, so an
 * implementation that used the earlier read would have proceeded. A refusal that cannot be made to disappear by
 * removing the re-read would prove nothing about the re-read.
 *
 * WHAT IT DOES NOT PROVE: that any HTTP route reaches this adapter (§5.2.1's handler runs against `SubjectCommands`,
 * and no composition root wires this adapter yet — recorded in ASSUMPTIONS §3.56), and that a revoke cannot be
 * overwritten (the port's conditional update is asserted in `tests/contract/authority-repository.test.ts` and again
 * here through the durability of the first instant).
 *
 * FIXTURE DISCIPLINE: this suite's own tenants, per run (ASSUMPTIONS §3.27). The `external_action` table is asserted to
 * still hold NOTHING for the tenant after each refusal, which is the "no external effect" half of VG-AUTH-024.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import {
  AuthorityError,
  mintGrant,
  verifyAtExecutionTime,
  type AuthorityGrant,
} from '../../src/application/security/authority-service.ts';
import {
  PostgresAuthorityGrantRepository,
  authorityTransactionHandle,
} from '../../src/adapters/persistence/authority-repository.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { appDsn, asTenant, exec, ownerDsn } from '../db/harness.ts';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RUN = randomUUID().slice(0, 8);

let runner: PostgresTenantRunner;
const repository = new PostgresAuthorityGrantRepository();

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** The `vg_count=` marker in a labelled count — a MARKER, never a positional guess. */
function countOf(lines: readonly string[]): string {
  const marker = /vg_count=(\d+)/.exec(lines.join('\n'));
  assert.ok(marker !== null, `no vg_count marker in: ${lines.join(' | ')}`);
  return marker[1] ?? '';
}

/** How many external effects this tenant has on record. Must be zero after every refusal below. */
function externalActions(tenantId: string): string {
  return countOf(
    asTenant(appDsn(), tenantId, "SELECT 'vg_count=' || count(*)::text FROM external_action;"),
  );
}

/**
 * A subject with the bootstrap grant VG-IDENT-001 requires at COMMIT.
 *
 * The deferred constraint trigger makes "a subject with no grant" unrepresentable, so the fixture writes both in ONE
 * transaction. The bootstrap grant is `SELF` and is NOT the grant the tests act on: each test mints its own, so a test
 * that revokes or expires one cannot disturb another.
 */
function newSubject(tenantId: string): string {
  const subjectId = randomUUID();
  const grantId = randomUUID();
  const created = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${tenantId}', true);`,
      `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
         VALUES ('${subjectId}', '${tenantId}', 'aae-${RUN}-${subjectId.slice(0, 8)}', 'US-CA', false, 'ACTIVE');`,
      `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at)
         VALUES ('${grantId}', '${tenantId}', '${subjectId}', 'SELF', ARRAY['discovery'], now() - interval '1 day',
                 now() + interval '30 days');`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(created.status, 0, `subject fixture failed: ${created.output}`);
  return subjectId;
}

/** One evidence artifact, for the notice FK an `AGENT` grant requires. */
function newArtifact(tenantId: string): string {
  const id = randomUUID();
  const digest = createHash('sha256').update(`authority-execution:${RUN}:${id}`, 'utf8').digest('hex');
  const created = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${tenantId}', true);`,
      `INSERT INTO evidence_artifact (id, tenant_id, case_id, kind, digest, storage_ref, egress_class,
                                      redaction_state, captured_at)
         VALUES ('${id}', '${tenantId}', NULL, 'SIGNED_INSTRUMENT', '${digest}', 's3://evidence/${RUN}/${id}',
                 'NONE', 'NONE', now());`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(created.status, 0, `artifact fixture failed: ${created.output}`);
  return id;
}

/** A `SELF` grant built by the real domain factory, so the fixture cannot hold a shape `mintGrant` would refuse. */
function selfGrant(tenantId: string, subjectId: string, overrides: Partial<Parameters<typeof mintGrant>[0]> = {}): AuthorityGrant {
  return mintGrant({
    tenantId,
    subjectRef: subjectId,
    kind: 'SELF',
    scope: ['discovery', 'discovery.write'],
    now: iso(0),
    identityLevel: 'IAL2',
    evidenceArtifactId: null,
    noticeArtifactId: null,
    coolingOffUntil: null,
    authorityGrantId: randomUUID(),
    expiresAt: iso(30 * 24 * 60 * 60 * 1000),
    ...overrides,
  });
}

/** Insert a grant through the adapter inside its own committed transaction. */
async function store(tenantId: string, grant: AuthorityGrant): Promise<void> {
  const result = await runner.withTenantTransaction(tenantId, async (tx) => {
    const handle = authorityTransactionHandle(tenantId, tx);
    return repository.insert(handle, grant);
  });
  assert.equal(result, 'inserted', `the grant fixture must be stored: ${grant.authorityGrantId}`);
}

/** Run an owner-side statement in its own committed transaction, scoped to a tenant (FORCE RLS applies to the owner). */
function commitAsOwner(tenantId: string, statement: string): void {
  const result = exec(
    ownerDsn(),
    `BEGIN;\nSELECT set_config('app.tenant_id', '${tenantId}', true);\n${statement}\nCOMMIT;`,
  );
  assert.equal(result.status, 0, `owner statement failed: ${result.output}`);
}

/** The execution-time check, reading through the adapter inside the caller's transaction. */
function verifyInside(handle: ReturnType<typeof authorityTransactionHandle>, tenantId: string) {
  return (grantId: string): Promise<AuthorityGrant | undefined> =>
    repository.readForUpdate(handle, tenantId, grantId);
}

/** The refusal an operation produced, or `undefined` when it did not refuse. */
async function refusalOf(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

before(async () => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'authority-execution-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'authority-execution-b-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);
});

after(async () => {
  await runner.close();
});

describe('the durable adapter round-trips the facts execution time reads (VG-AUTHZ-005)', () => {
  test('a SELF grant survives the store and comes back field for field', async () => {
    const subjectId = newSubject(TENANT_A);
    const grant = selfGrant(TENANT_A, subjectId);
    await store(TENANT_A, grant);

    const read = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      repository.readForUpdate(authorityTransactionHandle(TENANT_A, tx), TENANT_A, grant.authorityGrantId),
    );
    assert.ok(read !== undefined, 'the stored grant must be readable');
    assert.deepEqual(read, grant, 'every domain field must survive the round trip');
    // `issuedAt` is compared as the ISO string the domain compares lexicographically, not as a Date.
    assert.equal(read.issuedAt, grant.issuedAt);
    assert.equal(read.revokedAt, null);
    assert.equal(read.contestedAt, null);
    assert.equal(read.coolingOffUntil, null);
  });

  test('an AGENT grant’s derived signed_instrument and its notice FK are stored, and the read reports the notice', async () => {
    const subjectId = newSubject(TENANT_A);
    const instrument = newArtifact(TENANT_A);
    const notice = newArtifact(TENANT_A);
    const grant = mintGrant({
      tenantId: TENANT_A,
      subjectRef: subjectId,
      kind: 'AGENT',
      scope: ['discovery.write'],
      now: iso(0),
      identityLevel: 'IAL2',
      evidenceArtifactId: instrument,
      noticeArtifactId: notice,
      coolingOffUntil: iso(60 * 1000),
      authorityGrantId: randomUUID(),
      expiresAt: iso(30 * 24 * 60 * 60 * 1000),
    });
    await store(TENANT_A, grant);

    // `signed_instrument` is DERIVED by the adapter from `evidenceArtifactId` (see its class comment). It is read back
    // here with a direct query because the domain type has no such field: without this assertion the derivation would
    // be unobservable, and `AGENT` grants would fail the schema's own CHECK if it were wrong.
    const signed = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT 'vg_signed=' || signed_instrument::text FROM authority_grant WHERE id = '${grant.authorityGrantId}';`,
    );
    assert.match(signed.join(' '), /vg_signed=true/, `signed_instrument must be derived as true: ${signed.join(' | ')}`);

    const read = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      repository.readForUpdate(authorityTransactionHandle(TENANT_A, tx), TENANT_A, grant.authorityGrantId),
    );
    assert.equal(read?.noticeArtifactId, notice, 'the notice artefact must round-trip');
    assert.equal(read?.evidenceArtifactId, instrument);
    assert.equal(read?.coolingOffUntil, grant.coolingOffUntil, 'the cooling-off window must round-trip');
  });

  test('a second insert of the same id reports already-present and does not rewrite the first row', async () => {
    const subjectId = newSubject(TENANT_A);
    const grant = selfGrant(TENANT_A, subjectId);
    await store(TENANT_A, grant);

    const second = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      repository.insert(authorityTransactionHandle(TENANT_A, tx), { ...grant, scope: ['something.else'] }),
    );
    assert.equal(second, 'already-present');

    const read = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      repository.readForUpdate(authorityTransactionHandle(TENANT_A, tx), TENANT_A, grant.authorityGrantId),
    );
    assert.deepEqual(read?.scope, [...grant.scope], 'the stored scope must be the FIRST one, not the retry’s');
  });
});

describe('the execution-time read happens INSIDE the write transaction (VG-AUTHZ-005, VG-AUTH-024)', () => {
  test('an active grant verifies, so every refusal below is about the change and not about the fixture', async () => {
    const subjectId = newSubject(TENANT_A);
    const grant = selfGrant(TENANT_A, subjectId);
    await store(TENANT_A, grant);

    const verified = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      verifyAtExecutionTime(
        grant.authorityGrantId,
        iso(0),
        verifyInside(authorityTransactionHandle(TENANT_A, tx), TENANT_A),
      ),
    );
    assert.equal(verified.authorityGrantId, grant.authorityGrantId);
    assert.equal(verified.revokedAt, null);
    assert.equal(externalActions(TENANT_A), '0', 'the control case writes no external effect either');
  });

  test('a revocation COMMITTED by another connection after the request-start read refuses the write', async () => {
    const subjectId = newSubject(TENANT_A);
    const grant = selfGrant(TENANT_A, subjectId);
    await store(TENANT_A, grant);

    // 1. THE REQUEST-START READ, in its own transaction, which ENDS before the revocation commits.
    const requestStartRead = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      repository.readForUpdate(authorityTransactionHandle(TENANT_A, tx), TENANT_A, grant.authorityGrantId),
    );
    assert.ok(requestStartRead !== undefined, 'the grant must exist at request start');
    assert.equal(requestStartRead.revokedAt, null, 'and must be unrevoked at request start');

    // 2. THE REVOCATION COMMITS, from a different connection, while no request transaction is open.
    commitAsOwner(
      TENANT_A,
      `UPDATE authority_grant SET revoked_at = now() WHERE id = '${grant.authorityGrantId}' AND tenant_id = '${TENANT_A}';`,
    );

    // 3. THE WRITE TRANSACTION. The check re-reads and must refuse what the request-start read allowed.
    const refusal = await refusalOf(() =>
      runner.withTenantTransaction(TENANT_A, async (tx) =>
        verifyAtExecutionTime(
          grant.authorityGrantId,
          iso(0),
          verifyInside(authorityTransactionHandle(TENANT_A, tx), TENANT_A),
        ),
      ),
    );
    assert.ok(refusal instanceof AuthorityError, `expected an AuthorityError, got: ${String(refusal)}`);
    assert.equal(refusal.code, 'AUTHORITY_REVOKED');

    // 4. THE MUTATION CHECK, EXECUTED RATHER THAN DESCRIBED. The SAME function, given the grant read BEFORE the
    //    revocation, accepts it — so an implementation that skipped the re-read would have written. Without this the
    //    refusal above could be explained by anything that changed in the fixture, including the grant not existing.
    const stale = await verifyAtExecutionTime(grant.authorityGrantId, iso(0), async () => requestStartRead);
    assert.equal(stale.revokedAt, null, 'the pre-revocation value is still acceptable, which is the defect being tested for');

    assert.equal(externalActions(TENANT_A), '0', 'a refused write must leave no external effect (VG-AUTH-024)');
  });

  test('a grant that EXPIRES while the request is in flight refuses the write (VG-ERR-029)', async () => {
    const subjectId = newSubject(TENANT_A);
    // THE WINDOW IS SHORT AND LEGAL, AND IT HAS TO BE: `expires_at > issued_at` is a table CHECK (migration 0002), so
    // MEASURED — an UPDATE that moves `expires_at` into the past is refused with `authority_grant_check`, i.e. a grant
    // can never be STORED already expired. The time-shifted-grant scenario is therefore the clock advancing past a
    // stored instant, which is also what actually happens to a request in flight.
    const grant = selfGrant(TENANT_A, subjectId, { expiresAt: iso(1_200) });
    await store(TENANT_A, grant);

    const requestStartRead = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      repository.readForUpdate(authorityTransactionHandle(TENANT_A, tx), TENANT_A, grant.authorityGrantId),
    );
    assert.ok(requestStartRead !== undefined);
    assert.ok(requestStartRead.expiresAt > iso(0), 'the grant is unexpired at request start');

    // WAIT OUT THE WINDOW rather than mocking a clock: the `now` the write transaction passes is the same wall clock the
    // rest of the process reads, and the assertion below confirms the wait actually crossed the stored instant.
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    assert.ok(iso(0) > grant.expiresAt, 'the clock must genuinely be past the stored expiry before the write');

    const refusal = await refusalOf(() =>
      runner.withTenantTransaction(TENANT_A, async (tx) =>
        verifyAtExecutionTime(
          grant.authorityGrantId,
          iso(0),
          verifyInside(authorityTransactionHandle(TENANT_A, tx), TENANT_A),
        ),
      ),
    );
    assert.ok(refusal instanceof AuthorityError, `expected an AuthorityError, got: ${String(refusal)}`);
    assert.equal(refusal.code, 'AUTHORITY_EXPIRED');

    // THE MUTATION CHECK, EXECUTED: the SAME grant, evaluated at the instant the request started, is still valid — so an
    // implementation that read the grant once at request start would have written.
    const stale = await verifyAtExecutionTime(grant.authorityGrantId, grant.issuedAt, async () => requestStartRead);
    assert.equal(stale.revokedAt, null, 'the request-start value is still acceptable at the request-start instant');

    assert.equal(externalActions(TENANT_A), '0');
  });

  test('a contested grant refuses its next write, and the contest survives a round trip (VG-AUTHZ-012)', async () => {
    const subjectId = newSubject(TENANT_A);
    const grant = selfGrant(TENANT_A, subjectId);
    await store(TENANT_A, grant);

    const contestedAt = iso(0);
    const contested = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      repository.contest(authorityTransactionHandle(TENANT_A, tx), TENANT_A, grant.authorityGrantId, contestedAt),
    );
    assert.equal(contested, 'contested');

    // A SECOND CONTEST DOES NOT REWRITE THE FIRST INSTANT. The port cannot report "already contested at another
    // instant" (see the adapter), so the observable property asserted here is the one that matters: history is intact.
    const again = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      repository.contest(
        authorityTransactionHandle(TENANT_A, tx),
        TENANT_A,
        grant.authorityGrantId,
        iso(60 * 60 * 1000),
      ),
    );
    assert.equal(again, 'contested', 'the postcondition is "contested"; the first instant must not move');
    const stored = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      repository.readForUpdate(authorityTransactionHandle(TENANT_A, tx), TENANT_A, grant.authorityGrantId),
    );
    assert.equal(stored?.contestedAt, contestedAt, 'the FIRST contest instant is the fact');

    const refusal = await refusalOf(() =>
      runner.withTenantTransaction(TENANT_A, async (tx) =>
        verifyAtExecutionTime(
          grant.authorityGrantId,
          iso(0),
          verifyInside(authorityTransactionHandle(TENANT_A, tx), TENANT_A),
        ),
      ),
    );
    assert.ok(refusal instanceof AuthorityError, `expected an AuthorityError, got: ${String(refusal)}`);
    assert.equal(refusal.code, 'AUTHORITY_REVOKED', 'a contest suspends write capability, which the service reports as a suspension');
    assert.equal(externalActions(TENANT_A), '0');
  });

  test('a cooling-off window refuses the first external write and lapses on its own (VG-AUTHZ-010)', async () => {
    const subjectId = newSubject(TENANT_A);
    const grant = selfGrant(TENANT_A, subjectId, { coolingOffUntil: iso(60 * 60 * 1000) });
    await store(TENANT_A, grant);

    const inside = await refusalOf(() =>
      runner.withTenantTransaction(TENANT_A, async (tx) =>
        verifyAtExecutionTime(
          grant.authorityGrantId,
          iso(0),
          verifyInside(authorityTransactionHandle(TENANT_A, tx), TENANT_A),
        ),
      ),
    );
    assert.ok(inside instanceof AuthorityError, `expected an AuthorityError, got: ${String(inside)}`);
    assert.equal(inside.code, 'AUTHORITY_GRANT_INVALID');

    // AFTER the window, the SAME row verifies: the deadline is a real instant read from the row, not a flag the
    // adapter sets. The instant is passed to the function rather than waited for, which is what the `now` parameter is.
    const lapsed = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      verifyAtExecutionTime(
        grant.authorityGrantId,
        iso(2 * 60 * 60 * 1000),
        verifyInside(authorityTransactionHandle(TENANT_A, tx), TENANT_A),
      ),
    );
    assert.equal(lapsed.authorityGrantId, grant.authorityGrantId);
    assert.equal(externalActions(TENANT_A), '0');
  });

  test('the execution-time read LOCKS the row, so a revoke cannot commit between it and the write', async () => {
    const subjectId = newSubject(TENANT_A);
    const grant = selfGrant(TENANT_A, subjectId);
    await store(TENANT_A, grant);

    const locked = await runner.withTenantTransaction(TENANT_A, async (tx) => {
      const handle = authorityTransactionHandle(TENANT_A, tx);
      await repository.readForUpdate(handle, TENANT_A, grant.authorityGrantId);
      // ANOTHER CONNECTION TRIES TO REVOKE WHILE THIS TRANSACTION HOLDS THE ROW. `lock_timeout` makes the outcome
      // deterministic rather than a race: if the row is locked, PostgreSQL refuses the wait with 55P03 (measured here);
      // a test that merely measured elapsed time would be flaky, and one that omitted the timeout would HANG.
      const blocked = exec(
        appDsn(),
        [
          'BEGIN;',
          "SET LOCAL lock_timeout = '250ms';",
          `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
          `UPDATE authority_grant SET revoked_at = now() WHERE id = '${grant.authorityGrantId}' AND tenant_id = '${TENANT_A}';`,
          'COMMIT;',
        ].join('\n'),
      );
      return blocked;
    });
    assert.notEqual(locked.status, 0, 'the concurrent revoke must NOT succeed while the read holds the row');
    assert.match(
      locked.output,
      /lock timeout|canceling statement due to lock timeout|55P03/i,
      `expected a lock timeout, got:\n${locked.output}`,
    );
    assert.equal(externalActions(TENANT_A), '0');
  });

  test('another tenant’s handle sees no grant for the same id (VG-TENANT-002, second layer)', async () => {
    const subjectId = newSubject(TENANT_A);
    const grant = selfGrant(TENANT_A, subjectId);
    await store(TENANT_A, grant);

    const crossTenant = await runner.withTenantTransaction(TENANT_B, async (tx) =>
      repository.readForUpdate(authorityTransactionHandle(TENANT_B, tx), TENANT_B, grant.authorityGrantId),
    );
    assert.equal(crossTenant, undefined, 'the row-level policy must hide tenant A’s grant from tenant B');

    // THE NON-VACUITY CONTROL: the SAME id read under its own tenant returns the row, so the `undefined` above is a
    // refusal rather than a typo in the id.
    const own = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      repository.readForUpdate(authorityTransactionHandle(TENANT_A, tx), TENANT_A, grant.authorityGrantId),
    );
    assert.equal(own?.authorityGrantId, grant.authorityGrantId);
  });
});

describe('the adapter refuses a transaction it cannot prove is bound', () => {
  test('a handle from another implementation is refused rather than given a connection', async () => {
    const subjectId = newSubject(TENANT_A);
    const grant = selfGrant(TENANT_A, subjectId);
    await store(TENANT_A, grant);
    // The port declares the handle opaque, so a foreign handle is exactly what another implementation would pass.
    const refusal = await refusalOf(() => repository.readForUpdate({ id: 'foreign' }, TENANT_A, grant.authorityGrantId));
    assert.ok(refusal instanceof Error);
    assert.match(refusal.message, /requires a PostgresAuthorityTransactionHandle/);
  });

  test('a tenant that is not the transaction’s tenant is refused, not answered "no such grant"', async () => {
    const subjectId = newSubject(TENANT_A);
    const grant = selfGrant(TENANT_A, subjectId);
    await store(TENANT_A, grant);
    const refusal = await refusalOf(() =>
      runner.withTenantTransaction(TENANT_A, async (tx) =>
        repository.readForUpdate(authorityTransactionHandle(TENANT_A, tx), TENANT_B, grant.authorityGrantId),
      ),
    );
    assert.ok(refusal instanceof Error, 'a mismatched tenant must be a loud error, not an empty read');
    assert.match(refusal.message, /bound to tenant/);
  });

  test('a handle used after its transaction ended cannot read authority', async () => {
    const subjectId = newSubject(TENANT_A);
    const grant = selfGrant(TENANT_A, subjectId);
    await store(TENANT_A, grant);

    const escaped = await runner.withTenantTransaction(TENANT_A, async (tx) =>
      authorityTransactionHandle(TENANT_A, tx),
    );
    const refusal = await refusalOf(() => repository.readForUpdate(escaped, TENANT_A, grant.authorityGrantId));
    assert.ok(refusal instanceof Error, 'a handle whose transaction has ended must not read');
    // THE EXACT REFUSAL, MEASURED RATHER THAN ACCEPTED AS A FAMILY OF MESSAGES: the live-binding check reports the
    // reverted setting, which is the evidence that it detected the end of the transaction rather than a driver error.
    assert.match(refusal.message, /no longer bound to tenant/);
    assert.match(refusal.message, /app\.tenant_id is ""/);
  });
});
