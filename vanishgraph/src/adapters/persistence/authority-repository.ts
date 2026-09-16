/**
 * The Postgres `AuthorityGrantRepository` adapter (EP-006 M4's named deliverable, completed in M10).
 *
 * WHY THIS FILE EXISTED AS A GAP UNTIL NOW: the port (`src/domain/ports/authority-repository.ts`) was written in M4 and
 * exercised through an in-memory implementation, with the Postgres binding recorded as `BLOCKED_CREDENTIALS`
 * (`DATABASE_URL`) and `BLOCKED_PREREQUISITE` (EP-003). EP-003 has since provisioned the database and the migrations
 * are at version 0034, so that block no longer applies and the durable half is written here instead of remaining a
 * recorded promise. The M10 integration suite (`tests/integration/authority-at-execution.test.ts`) runs THIS adapter
 * against real rows, which is the proof M4 could not obtain.
 *
 * THE ONE PROPERTY THIS FILE EXISTS TO PRESERVE is that `readForUpdate` reads inside the CALLER'S transaction. The
 * handle carries a live `TenantTransaction`, so there is no `connect`, no pool and no way to read a grant outside the
 * transaction the write will use: an adapter that opened its own connection would make VG-AUTHZ-005's execution-time
 * check read a snapshot the write cannot see, which is precisely the defect the port's shape was designed to make
 * unrepresentable.
 *
 * TWO GUARDS THAT ARE NOT DECORATION, EACH WITH ITS MEASURED REASON:
 *
 *  1. **The handle must be this adapter's.** A handle from another implementation (the in-memory double, a future
 *     adapter) carries no live transaction here, so an operation is REFUSED rather than given a fresh connection. The
 *     same rule `src/adapters/queue/postgres-job-queue.ts` applies, for the same reason.
 *  2. **The tenant passed to a method must equal the transaction's tenant, and the LIVE session setting is checked to
 *     confirm it.** The port makes the tenant a parameter so a caller cannot read a grant by id alone; that guard is
 *     worthless if the adapter will happily read tenant A's grant through a transaction bound to tenant B (RLS would
 *     return nothing, so the caller would see "no such grant" instead of its own bug). The check runs as
 *     `SELECT current_setting('app.tenant_id', true)`, and it closes a second hole as well: `set_config(..., true)`
 *     reverts at COMMIT (measured — see `postgres-runner.ts`), so a handle used AFTER its transaction ended no longer
 *     matches and is refused instead of silently running on a connection the pool has taken back. The cost is one extra
 *     round trip per operation, which is the price of not reading another tenant's authority facts by accident.
 *
 * IDS THAT ARE NOT UUIDS ARE "NO SUCH GRANT", NOT DRIVER ERRORS. `authority_grant.id` and `.subject_id` are `uuid`, and
 * passing a malformed string as a `uuid` parameter raises `22P02` — a 500 from a read that should be a not-found. The
 * adapter validates the shape first and reports absence, because an id that is not a UUID cannot name a grant. The
 * columns are NOT cast to `text` in the predicates (`id::text = $2`), which would defeat the primary-key index and make
 * `SELECT ... FOR UPDATE` lock every row it scanned.
 *
 * WHAT THE ADAPTER DELIBERATELY DOES NOT WRITE: `notice_sent_at`. The domain grant carries `noticeArtifactId` (which
 * artefact the notice was) but no instant at which it was sent, and this repository has no notification transport — so
 * writing `now()` would fabricate the very notification VG-AUTHZ-014 requires. The column stays NULL and the gap stays
 * visible.
 *
 * This is an adapter: it may import drivers through the transaction handle, and it may import the domain port's types.
 * Nothing in the domain may import it (`scripts/import-boundary.sh`).
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import type {
  AuthorityGrant,
  AuthorityKind,
} from '../../application/security/authority-service.ts';
import type {
  AuthorityGrantRepository,
  TransactionHandle,
} from '../../domain/ports/authority-repository.ts';

/**
 * The handle this adapter requires.
 *
 * It SATISFIES the port's `TransactionHandle` (`{ id: string }`) while carrying what the adapter actually needs, which
 * is the port's intent: the handle is opaque to the application layer and concrete only here.
 */
export interface PostgresAuthorityTransactionHandle extends TransactionHandle {
  readonly id: string;
  /** The tenant the transaction was opened for, as the runner that opened it was told. */
  readonly tenantId: string;
  /** The live transaction. Its `query` runs on the connection holding `app.tenant_id` for this tenant. */
  readonly transaction: TenantTransaction;
  /** A discriminator, so a handle from another implementation is detectable rather than assumed compatible. */
  readonly origin: 'postgres-authority-repository';
}

/** Build a handle for a transaction the caller has open. `tenantId` must be the tenant the runner bound. */
export function authorityTransactionHandle(
  tenantId: string,
  transaction: TenantTransaction,
): PostgresAuthorityTransactionHandle {
  return {
    id: `authority-tx:${tenantId}`,
    tenantId,
    transaction,
    origin: 'postgres-authority-repository',
  };
}

export function isPostgresAuthorityTransactionHandle(
  value: unknown,
): value is PostgresAuthorityTransactionHandle {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PostgresAuthorityTransactionHandle>;
  return (
    candidate.origin === 'postgres-authority-repository' &&
    typeof candidate.id === 'string' &&
    typeof candidate.tenantId === 'string' &&
    typeof candidate.transaction === 'object' &&
    candidate.transaction !== null &&
    typeof candidate.transaction.query === 'function'
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string can name a `uuid` column. */
function isUuid(value: string): boolean {
  return UUID.test(value);
}

function requireHandle(
  transaction: TransactionHandle,
  tenantId: string,
): PostgresAuthorityTransactionHandle {
  if (!isPostgresAuthorityTransactionHandle(transaction)) {
    throw new Error(
      'authority repository ERROR: this operation requires a PostgresAuthorityTransactionHandle from this adapter. ' +
        'A grant read outside the caller’s transaction would see a snapshot the write cannot act on, which is the ' +
        'defect VG-AUTHZ-005 exists to prevent, so it is refused rather than given a fresh connection.',
    );
  }
  if (transaction.tenantId !== tenantId) {
    throw new Error(
      `authority repository ERROR: the transaction is bound to tenant ${transaction.tenantId} but the call names ` +
        `${tenantId}. A cross-tenant read would be answered "no such grant" by row-level security, hiding the caller's ` +
        'own defect, so it is refused here instead.',
    );
  }
  return transaction;
}

/**
 * Confirm the live session is still bound to the handle's tenant.
 *
 * `current_setting('app.tenant_id', true)` returns the value the transaction set, `''` after the transaction ended
 * (`set_config(..., true)` reverts, measured in `postgres-runner.ts`), or NULL when it was never set. Only an exact
 * match proceeds.
 */
async function assertLiveBinding(handle: PostgresAuthorityTransactionHandle): Promise<void> {
  const { rows } = await handle.transaction.query<{ tenant: string | null }>(
    "SELECT current_setting('app.tenant_id', true) AS tenant",
  );
  const live = rows[0]?.tenant ?? null;
  if (live !== handle.tenantId) {
    throw new Error(
      `authority repository ERROR: the transaction is no longer bound to tenant ${handle.tenantId} ` +
        `(app.tenant_id is ${live === null ? 'NULL' : `"${live}"`}). The transaction has ended or was opened for ` +
        'another tenant, and a grant read or write must happen inside the transaction that owns it.',
    );
  }
}

/** A timestamp column as it arrives from the driver, in either of the two shapes a driver may hand back. */
type TimestampColumn = Date | string | null;

interface GrantRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly subject_id: string;
  readonly kind: string;
  readonly scope: readonly string[] | null;
  readonly issued_at: Date | string;
  readonly expires_at: Date | string;
  readonly revoked_at: TimestampColumn;
  readonly evidence_id: string | null;
  readonly identity_level: string | null;
  readonly contested_at: TimestampColumn;
  readonly cooling_off_until: TimestampColumn;
  readonly notice_artifact_id: string | null;
}

/**
 * The selected columns, named once.
 *
 * `notice_sent_at` is intentionally absent: the domain grant has no field for it (see the file header), and selecting a
 * column nothing maps would invite a later reader to assume it is carried.
 */
const COLUMNS = [
  'id',
  'tenant_id',
  'subject_id',
  'kind',
  'scope',
  'issued_at',
  'expires_at',
  'revoked_at',
  'evidence_id',
  'identity_level',
  'contested_at',
  'cooling_off_until',
  'notice_artifact_id',
].join(', ');

/** A required timestamp, normalised to the ISO-8601 UTC form the domain compares lexicographically. */
function toIso(value: Date | string, where: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`authority repository ERROR: ${where} is not a timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

/** A nullable timestamp, normalised the same way, `null` preserved. */
function toIsoOrNull(value: TimestampColumn, where: string): string | null {
  return value === null ? null : toIso(value, where);
}

function toGrant(row: GrantRow): AuthorityGrant {
  if (row.scope === null) {
    // The schema forbids it (`cardinality(scope) >= 1`, migration 0010). Reported rather than defaulted: a grant read
    // back with an empty scope would authorise nothing and look like a policy decision.
    throw new Error(`authority repository ERROR: grant ${row.id} has no scope; the schema forbids an empty scope`);
  }
  return {
    authorityGrantId: row.id,
    tenantId: row.tenant_id,
    // THE SUBJECT REFERENCE IS THE SUBJECT ID, rendered as text. This is the convention the other persistence adapters
    // already use (`subject_id::text AS subject_ref` in `cases.ts` and `exposures.ts`), so a grant's binding and a
    // case's binding name the same subject the same way.
    subjectRef: row.subject_id,
    kind: row.kind as AuthorityKind,
    scope: [...row.scope],
    issuedAt: toIso(row.issued_at, `grant ${row.id} issued_at`),
    expiresAt: toIso(row.expires_at, `grant ${row.id} expires_at`),
    revokedAt: toIsoOrNull(row.revoked_at, `grant ${row.id} revoked_at`),
    evidenceArtifactId: row.evidence_id,
    // A NULL `identity_level` becomes the EMPTY STRING and never a token. Migration 0031 is explicit that defaulting it
    // to a level would fabricate a verification: `IAL0` is a level a subject can hold, so writing it here would claim
    // the subject holds it. `mintGrant` refuses an empty level for `SELF`, which is the fail-closed direction.
    identityLevel: row.identity_level ?? '',
    noticeArtifactId: row.notice_artifact_id,
    coolingOffUntil: toIsoOrNull(row.cooling_off_until, `grant ${row.id} cooling_off_until`),
    contestedAt: toIsoOrNull(row.contested_at, `grant ${row.id} contested_at`),
  };
}

export class PostgresAuthorityGrantRepository implements AuthorityGrantRepository {
  /**
   * Read a grant for update, INSIDE the transaction.
   *
   * `FOR UPDATE` is deliberate: it takes a row lock, so a concurrent `revoke` that has not yet committed cannot slip
   * between this read and the write the caller is about to perform. A revoke that HAS committed before this statement
   * is visible to it under READ COMMITTED, which is what makes the execution-time refusal in the M10 integration suite
   * a fact about the database rather than about the test's ordering.
   */
  async readForUpdate(
    transaction: TransactionHandle,
    tenantId: string,
    authorityGrantId: string,
  ): Promise<AuthorityGrant | undefined> {
    const handle = requireHandle(transaction, tenantId);
    if (!isUuid(authorityGrantId)) return undefined;
    await assertLiveBinding(handle);
    const { rows } = await handle.transaction.query<GrantRow>(
      `SELECT ${COLUMNS} FROM authority_grant WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, authorityGrantId],
    );
    const row = rows[0];
    return row === undefined ? undefined : toGrant(row);
  }

  /** The grants held for one subject in one tenant, newest issue first. */
  async listForSubject(
    transaction: TransactionHandle,
    tenantId: string,
    subjectRef: string,
  ): Promise<readonly AuthorityGrant[]> {
    const handle = requireHandle(transaction, tenantId);
    if (!isUuid(subjectRef)) return [];
    await assertLiveBinding(handle);
    const { rows } = await handle.transaction.query<GrantRow>(
      `SELECT ${COLUMNS} FROM authority_grant
        WHERE tenant_id = $1 AND subject_id = $2
        ORDER BY issued_at DESC, id`,
      [tenantId, subjectRef],
    );
    return rows.map(toGrant);
  }

  /**
   * Insert a grant. Reports `already-present` for an id that exists, rather than replacing the row.
   *
   * WHERE THE ROW-LEVEL SECURITY REFUSAL LANDS: `INSERT` under a transaction bound to another tenant fails the policy's
   * `WITH CHECK`, which the driver raises as an error. That is the correct outcome — the write does not happen — and
   * this method does not catch it, because reporting `already-present` for a refusal would turn a security control into
   * a silent no-op.
   *
   * A COLLISION ON THE PRIMARY KEY IS REPORTED AS `already-present` EVEN WHEN THE EXISTING ROW BELONGS TO ANOTHER
   * TENANT, and that is a privacy choice rather than sloppiness: telling the two cases apart would let a caller use a
   * write as an existence oracle across tenants, which SPEC-006 H-9 forbids for reads and which is no better here.
   *
   * `signed_instrument` IS DERIVED, NOT PASSED. The domain grant has no such field; what it has is
   * `evidenceArtifactId`, which `mintGrant` requires for every kind that needs an instrument (`AGENT`,
   * `PARENT_GUARDIAN`, `LEGAL_REPRESENTATIVE`). Recording the column as "an evidence artefact was supplied" is exactly
   * what the domain asserted, and it is what the schema's `kind <> 'AGENT' OR (signed_instrument AND evidence_id IS NOT
   * NULL)` constraint requires for an `AGENT` grant to be storable at all.
   */
  async insert(
    transaction: TransactionHandle,
    grant: AuthorityGrant,
  ): Promise<'inserted' | 'already-present'> {
    const handle = requireHandle(transaction, grant.tenantId);
    if (!isUuid(grant.authorityGrantId) || !isUuid(grant.subjectRef)) {
      throw new Error(
        `authority repository ERROR: grant ${grant.authorityGrantId} names a subject (${grant.subjectRef}) or an id ` +
          'that is not a UUID, so it cannot be stored; refusing rather than letting the driver raise a type error.',
      );
    }
    await assertLiveBinding(handle);
    const { rows } = await handle.transaction.query<{ id: string }>(
      `INSERT INTO authority_grant
         (id, tenant_id, subject_id, kind, scope, evidence_id, issued_at, expires_at, revoked_at,
          signed_instrument, identity_level, contested_at, cooling_off_until, notice_artifact_id)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7::timestamptz, $8::timestamptz, $9::timestamptz,
               $10, $11, $12::timestamptz, $13::timestamptz, $14)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        grant.authorityGrantId,
        grant.tenantId,
        grant.subjectRef,
        grant.kind,
        [...grant.scope],
        grant.evidenceArtifactId,
        grant.issuedAt,
        grant.expiresAt,
        grant.revokedAt,
        grant.evidenceArtifactId !== null,
        // `''` is written as NULL: the empty string is this adapter's rendering of "no level recorded", and storing the
        // empty string would fail the column's own `identity_level IN ('IAL0','IAL1','IAL2','IAL3')` check.
        grant.identityLevel.length === 0 ? null : grant.identityLevel,
        grant.contestedAt,
        grant.coolingOffUntil,
        grant.noticeArtifactId,
      ],
    );
    return rows.length > 0 ? 'inserted' : 'already-present';
  }

  /**
   * Record a revocation, conditionally on the grant not already carrying one.
   *
   * `expectedRevokedAt` is typed `null` by the port, so `revoked_at IS NULL` IS the expectation and there is no second
   * value to compare against: a caller that read `null` and finds a timestamp has lost a race, and the update matches
   * no row rather than overwriting the earlier instant (VG-REAPPEAR-002: history is never rewritten).
   */
  async revoke(
    transaction: TransactionHandle,
    tenantId: string,
    authorityGrantId: string,
    expectedRevokedAt: null,
    revokedAt: string,
  ): Promise<'revoked' | 'already-revoked' | 'not-found'> {
    const handle = requireHandle(transaction, tenantId);
    if (expectedRevokedAt !== null) {
      throw new Error(
        'authority repository ERROR: revoke is conditional on the grant carrying no revocation, so the only accepted ' +
          'expectation is null; a non-null expectation cannot be evaluated by this statement.',
      );
    }
    if (!isUuid(authorityGrantId)) return 'not-found';
    await assertLiveBinding(handle);
    const updated = await handle.transaction.query<{ id: string }>(
      `UPDATE authority_grant SET revoked_at = $3::timestamptz
        WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [tenantId, authorityGrantId, revokedAt],
    );
    if (updated.rows.length > 0) return 'revoked';
    const existing = await handle.transaction.query<{ revoked_at: TimestampColumn }>(
      'SELECT revoked_at FROM authority_grant WHERE tenant_id = $1 AND id = $2',
      [tenantId, authorityGrantId],
    );
    return existing.rows.length === 0 ? 'not-found' : 'already-revoked';
  }

  /**
   * Record a subject's contest (VG-AUTHZ-012), conditionally, exactly as `revoke` is.
   *
   * THE PORT CANNOT EXPRESS "already contested at a different instant", AND THIS ADAPTER DOES NOT INVENT ONE. A second
   * contest with a different instant leaves the FIRST instant in place (history is not rewritten) and reports
   * `contested`, because after the call the grant is contested — which is the postcondition the caller acts on. A
   * contest that finds no row reports `not-found`, and a contest of an already-contested grant with the SAME instant is
   * a retry and reports the same value. The asymmetry with `revoke`'s `already-revoked` is the port's, not this
   * adapter's, and it is recorded here rather than smoothed over.
   */
  async contest(
    transaction: TransactionHandle,
    tenantId: string,
    authorityGrantId: string,
    contestedAt: string,
  ): Promise<'contested' | 'not-found'> {
    const handle = requireHandle(transaction, tenantId);
    if (!isUuid(authorityGrantId)) return 'not-found';
    await assertLiveBinding(handle);
    const updated = await handle.transaction.query<{ id: string }>(
      `UPDATE authority_grant SET contested_at = $3::timestamptz
        WHERE tenant_id = $1 AND id = $2 AND contested_at IS NULL
        RETURNING id`,
      [tenantId, authorityGrantId, contestedAt],
    );
    if (updated.rows.length > 0) return 'contested';
    const existing = await handle.transaction.query<{ contested_at: TimestampColumn }>(
      'SELECT contested_at FROM authority_grant WHERE tenant_id = $1 AND id = $2',
      [tenantId, authorityGrantId],
    );
    return existing.rows.length === 0 ? 'not-found' : 'contested';
  }
}
