/**
 * The Postgres-native `JobQueue` adapter (ADR-016, SPEC-001 §5.1 rule 4).
 *
 * ADR-016 removed Temporal, so durable follow-up work lives in the same database as the state
 * that requires it. This adapter is that decision made concrete: `enqueue` writes a row through
 * the CALLER'S transaction, never a connection of its own.
 *
 * The property being protected is not "the row eventually appears" — it is "the row appears if
 * and only if the transition that caused it commits". That is why `enqueue` accepts a
 * `TransactionHandle` and why this file contains no `connect`, no pool and no retry loop: there
 * is deliberately no way to enqueue outside a transaction, so the dual-write class of
 * inconsistency an external orchestrator would have introduced cannot be expressed here.
 *
 * This is infrastructure, so it may import node builtins and drivers. Nothing in the domain may
 * import it (enforced by scripts/import-boundary.sh).
 */

import type {
  JobDefinition,
  JobQueue,
  TransactionHandle,
} from '../../application/ports/job-queue.ts';
import { runSql, type Dsn } from '../../infrastructure/database/psql.ts';

/**
 * The transaction handle this adapter requires.
 *
 * The port declares `TransactionHandle` as `unknown` on purpose: the application layer must not
 * depend on a driver. Narrowing happens here, and a handle that does not carry a live transaction
 * is REJECTED rather than quietly upgraded into a fresh connection. An adapter that silently
 * opened its own connection would make every rollback test pass for the wrong reason.
 */
export interface PostgresTransactionHandle {
  /** The open transaction's DSN. */
  readonly dsn: Dsn;
  /** Statements are appended here and executed as one transaction by the caller. */
  readonly statements: string[];
  /** Flipped when the caller commits or rolls back, so a stale handle is detectable. */
  closed: boolean;
}

export function isPostgresTransactionHandle(value: unknown): value is PostgresTransactionHandle {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PostgresTransactionHandle>;
  return (
    typeof candidate.dsn === 'object' &&
    candidate.dsn !== null &&
    Array.isArray(candidate.statements) &&
    typeof candidate.closed === 'boolean'
  );
}

function requireHandle(tx: TransactionHandle): PostgresTransactionHandle {  if (!isPostgresTransactionHandle(tx)) {
    throw new Error(
      'job queue ERROR: enqueue/cancel require a PostgresTransactionHandle from this adapter. ' +
        'Enqueueing outside the caller\'s transaction is exactly the dual-write bug ADR-016 ' +
        'removed, so it is refused rather than silently given a new connection.',
    );
  }
  if (tx.closed) {
    throw new Error(
      'job queue ERROR: the transaction handle is already closed. A job enqueued after COMMIT ' +
        'would run work whose transition may not have committed.',
    );
  }
  return tx;
}

/** SQL literal escaping for values that travel inside a generated statement. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function payloadLiteral(payload: JobDefinition['payload']): string {
  return `${literal(JSON.stringify(payload))}::jsonb`;
}

export class PostgresJobQueue implements JobQueue {
  /**
   * Enqueue inside the caller's transaction.
   *
   * `ON CONFLICT DO NOTHING` on `(tenant_id, idempotency_key)` is what makes the call
   * at-most-once: a replayed key is a no-op rather than a second job, matching how
   * `ExternalAction` treats its idempotency key (VG-ACTION-001). Two tenants may use the same
   * key string, because the constraint is tenant-scoped.
   */
  async enqueue(tx: TransactionHandle, job: JobDefinition): Promise<void> {
    const handle = requireHandle(tx);
    // `.value`, not `String(...)`: OpaqueId.toString() renders as "TenantId:<uuid>" for logs, and
    // using it here produced `invalid input syntax for type uuid: "TenantId:1111…"` against the
    // real database. The wire form of an identifier is its value, never its diagnostic form.
    handle.statements.push(
      `INSERT INTO job (tenant_id, kind, payload, run_at, idempotency_key, max_attempts)
       VALUES (${literal(job.tenantId.value)}, ${literal(job.kind)}, ${payloadLiteral(job.payload)},
               to_timestamp(${job.runAtMs / 1000}), ${literal(job.idempotencyKey)}, ${job.maxAttempts})
       ON CONFLICT ON CONSTRAINT job_tenant_idempotency_key DO NOTHING;`,
    );
  }

  /**
   * Cancel a not-yet-run job inside the same transaction.
   *
   * Only a PENDING job is cancelled; a RUNNING job is left alone by the WHERE clause rather than
   * silently reported as cancelled. Cancelling work that is already executing would claim a
   * guarantee the system cannot make.
   */
  async cancel(tx: TransactionHandle, idempotencyKey: string): Promise<void> {
    const handle = requireHandle(tx);
    handle.statements.push(
      `UPDATE job SET status = 'CANCELLED', completed_at = now()
        WHERE idempotency_key = ${literal(idempotencyKey)}
          AND tenant_id = current_setting('app.tenant_id', true)::uuid
          AND status = 'PENDING';`,
    );
  }
}

/**
 * Run a sequence of statements as ONE transaction on a DSN, scoped to a tenant.
 *
 * This is the caller-side half of the contract: the adapter only accumulates statements, and the
 * transaction boundary belongs to whoever owns the transition. Rollback is the default on any
 * error, which is what makes "a rolled-back transition leaves no job row" true by construction
 * rather than by the adapter remembering to clean up.
 *
 * `app.tenant_id` is set transaction-locally as the FIRST statement, because FORCE RLS applies to
 * every role including the table owner: without it the insert is refused with "new row violates
 * row-level security policy for table job". That refusal is correct behaviour, and it is also why
 * the tenant must be named here rather than inferred — a transaction with no tenant setting must
 * fail closed, not silently write to whichever tenant happened to be current.
 */
export function runTransaction(
  dsn: Dsn,
  tenantId: string,
  statements: readonly string[],
  options: { rollback?: boolean } = {},
): { status: number | null; output: string } {
  const body = statements.join('\n');
  const tail = options.rollback === true ? 'ROLLBACK;' : 'COMMIT;';
  const scope = `SELECT set_config('app.tenant_id', '${tenantId.replace(/'/g, "''")}', true);`;
  return runSql(dsn, `BEGIN;\n${scope}\n${body}\n${tail}`);
}
