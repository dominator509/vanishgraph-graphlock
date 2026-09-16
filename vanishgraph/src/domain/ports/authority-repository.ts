/**
 * The authority-grant repository port (SPEC-005 §3/VG-AUTHZ-005; EP-006 M4).
 *
 * THE PORT EXISTS SO `verifyAtExecutionTime` CAN RE-READ INSIDE THE TRANSACTION. Its `readForUpdate` takes a transaction
 * handle and is the only reader the execution-time check accepts, which is what makes "the grant was valid when the
 * request started" unrepresentable rather than merely discouraged.
 *
 * EVERY METHOD IS TENANT-SCOPED, AND THE TENANT IS A PARAMETER RATHER THAN A FIELD ON THE GRANT. A caller cannot read a
 * grant by id alone, so a cross-tenant read is not a check somebody has to remember — it is a call nobody can make. The
 * adapter implements it under row-level security, and this port's shape is the first of the two layers VG-TENANT-002
 * requires.
 *
 * THE ADAPTER WAS WRITTEN IN EP-006 M10, AFTER THE EP-003 DATABASE MADE ITS RECORDED BLOCK OBSOLETE.
 * `src/adapters/persistence/authority-repository.ts` implements this port against PostgreSQL, and
 * `tests/integration/authority-at-execution.test.ts` runs it against real rows — including a revocation committed by
 * another connection between the request-start read and the write. Until M10 this comment said no such file existed and
 * that the contract below was exercised only through an in-memory implementation; that is no longer true, and the
 * in-memory implementation remains here for the contract suite, where the port's SHAPE is what is under test.
 */

import type { AuthorityGrant } from '../../application/security/authority-service.ts';

/** An opaque transaction handle. The port does not know what it is; the adapter does. */
export interface TransactionHandle {
  readonly id: string;
}

export interface AuthorityGrantRepository {
  /** Read a grant for update, INSIDE the transaction. The only reader the execution-time check accepts. */
  readForUpdate(
    transaction: TransactionHandle,
    tenantId: string,
    authorityGrantId: string,
  ): Promise<AuthorityGrant | undefined>;

  /** The grants held for one subject in one tenant. Used by the enrollment conflict rule (VG-AUTHZ-013). */
  listForSubject(
    transaction: TransactionHandle,
    tenantId: string,
    subjectRef: string,
  ): Promise<readonly AuthorityGrant[]>;

  /**
   * Insert a grant. `mint` does not write, so this is the write.
   *
   * IT REFUSES A GRANT THAT ALREADY EXISTS, because a second insert of the same id is a retry of a write that already
   * happened: the adapter reports the conflict and the caller decides, rather than the port silently replacing a row.
   */
  insert(transaction: TransactionHandle, grant: AuthorityGrant): Promise<'inserted' | 'already-present'>;

  /**
   * Record a revocation. The previous `revokedAt` is an argument, so the update is conditional: a caller that read
   * `null` and finds a timestamp has lost a race, and the adapter reports it rather than overwriting history.
   */
  revoke(
    transaction: TransactionHandle,
    tenantId: string,
    authorityGrantId: string,
    expectedRevokedAt: null,
    revokedAt: string,
  ): Promise<'revoked' | 'already-revoked' | 'not-found'>;

  /** Record a subject's contest (VG-AUTHZ-012). Same conditional shape, for the same reason. */
  contest(
    transaction: TransactionHandle,
    tenantId: string,
    authorityGrantId: string,
    contestedAt: string,
  ): Promise<'contested' | 'not-found'>;
}

/**
 * An in-memory implementation, used by the contract suite.
 *
 * IT EXISTS TO ASSERT THE PORT'S INVARIANTS, NOT TO SERVE PRODUCTION, and it says so in its name: `InMemory` is a
 * deliberate marker so a reader cannot mistake it for the persistence binding. It enforces the tenant scoping the port
 * requires — a grant stored under one tenant is invisible under another — which is the invariant a Postgres adapter would
 * enforce twice (here and in RLS).
 */
export class InMemoryAuthorityGrantRepository implements AuthorityGrantRepository {
  readonly #rows = new Map<string, AuthorityGrant>();

  /** Preload a grant, as a previous request would have left it. */
  seed(grant: AuthorityGrant): void {
    this.#rows.set(`${grant.tenantId}:${grant.authorityGrantId}`, grant);
  }

  /** Every row, for a test that needs to assert nothing was written. */
  all(): readonly AuthorityGrant[] {
    return [...this.#rows.values()];
  }

  async readForUpdate(
    _transaction: TransactionHandle,
    tenantId: string,
    authorityGrantId: string,
  ): Promise<AuthorityGrant | undefined> {
    return this.#rows.get(`${tenantId}:${authorityGrantId}`);
  }

  async listForSubject(
    _transaction: TransactionHandle,
    tenantId: string,
    subjectRef: string,
  ): Promise<readonly AuthorityGrant[]> {
    return [...this.#rows.values()].filter((grant) => grant.tenantId === tenantId && grant.subjectRef === subjectRef);
  }

  async insert(_transaction: TransactionHandle, grant: AuthorityGrant): Promise<'inserted' | 'already-present'> {
    const key = `${grant.tenantId}:${grant.authorityGrantId}`;
    if (this.#rows.has(key)) return 'already-present';
    this.#rows.set(key, grant);
    return 'inserted';
  }

  async revoke(
    _transaction: TransactionHandle,
    tenantId: string,
    authorityGrantId: string,
    expectedRevokedAt: null,
    revokedAt: string,
  ): Promise<'revoked' | 'already-revoked' | 'not-found'> {
    const key = `${tenantId}:${authorityGrantId}`;
    const existing = this.#rows.get(key);
    if (existing === undefined) return 'not-found';
    if (existing.revokedAt !== expectedRevokedAt) return 'already-revoked';
    this.#rows.set(key, { ...existing, revokedAt });
    return 'revoked';
  }

  async contest(
    _transaction: TransactionHandle,
    tenantId: string,
    authorityGrantId: string,
    contestedAt: string,
  ): Promise<'contested' | 'not-found'> {
    const key = `${tenantId}:${authorityGrantId}`;
    const existing = this.#rows.get(key);
    if (existing === undefined) return 'not-found';
    this.#rows.set(key, { ...existing, contestedAt });
    return 'contested';
  }
}
