/**
 * The single application-layer port (SPEC-001 §5.1 rule 3).
 *
 * `enqueue(tx, job)` takes the CALLER'S transaction handle, never a fresh connection, so
 * a job is enqueued by the same transaction that performed the state transition requiring
 * it (ADR-016). That signature is the whole point: it makes enqueueing outside the
 * causing transaction impossible rather than merely discouraged, which removes the
 * dual-write inconsistency class an external orchestrator would have introduced.
 *
 * This is the only port the domain does not own. The domain declares *what must happen*;
 * the application decides *when*. It is declared here, in EP-002, rather than in the node
 * that implements it, so that port declaration stays in one place (SPEC-001 §5.1 rule 4).
 *
 * Declarations only: no implementation, and no runtime exports.
 */

import type { TenantId } from '../../domain/identifiers.ts';

/** The opaque handle of a transaction owned by the caller. */
export type TransactionHandle = unknown;

export interface JobDefinition {
  /** Stable job kind, for example `reobserve-exposure`. */
  readonly kind: string;
  readonly tenantId: TenantId;
  /** Opaque payload. Job payloads carry identifiers, never personal data. */
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  /** Earliest eligible run time. Used for deadlines and observation windows. */
  readonly runAtMs: number;
  /** Stable key making the job at-most-once, like an ExternalAction's key. */
  readonly idempotencyKey: string;
  /** Bounded retry budget. A job that exhausts it is reported, never dropped silently. */
  readonly maxAttempts: number;
}

export interface JobQueue {
  /**
   * Enqueue inside the caller's transaction. Must not open its own connection: a job
   * that commits while the transition rolls back is exactly the bug this signature
   * exists to prevent.
   */
  enqueue(tx: TransactionHandle, job: JobDefinition): Promise<void>;
  /** Cancel a not-yet-run job inside the same transaction. */
  cancel(tx: TransactionHandle, idempotencyKey: string): Promise<void>;
}
