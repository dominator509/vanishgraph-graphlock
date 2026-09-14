/**
 * An in-process `IdempotencyStore` for contract tests.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT — stated here because a test double that is mistaken for
 * evidence is worse than no double:
 *
 *   * It implements the SPEC-003 §4 BOUNDARY SEMANTICS faithfully, including the atomic claim, so the
 *     plugin's replay / conflict / in-flight logic can be exercised without PostgreSQL.
 *   * It proves NOTHING about durability or concurrency. It is a `Map` in one process, and its
 *     `begin` is atomic only because JavaScript runs it to completion without an await inside the
 *     critical section.
 *   * The DURABLE and CONCURRENT proofs live in `tests/db/idempotency-store.test.ts`, which runs the
 *     PostgreSQL adapter against real PostgreSQL under `gate-data`. That suite is the evidence for
 *     "two simultaneous requests produce exactly one effect".
 *
 * The FALLBACK in this node's M5 plan permitted a file-backed store with `flock`. That is NOT needed:
 * EP-003 completed, PostgreSQL is provisioned, and `tests/db/idempotency-store.test.ts` exercises the
 * real adapter against it. Choosing a weaker mechanism when the real one is available would trade
 * evidence for convenience.
 */

import type {
  BeginResult,
  IdempotencyRecord,
  IdempotencyScope,
  IdempotencyStore,
} from '../../src/domain/ports/idempotency-store.ts';

/** A stable string form of the scope, for use as a Map key. JSON, so no separator can collide. */
function scopeId(scope: IdempotencyScope): string {
  return JSON.stringify([
    scope.tenantId.value,
    scope.method,
    scope.routeTemplate,
    scope.idempotencyKey,
  ]);
}

interface Entry {
  state: 'IN_FLIGHT' | 'COMPLETED';
  fingerprint: string;
  record: IdempotencyRecord | undefined;
}

export interface RecordingIdempotencyStore extends IdempotencyStore {
  /** Every `begin` call in order, for assertions about what the plugin asked for. */
  readonly calls: readonly string[];
  /** The entries, so a test can inspect or corrupt state deliberately. */
  readonly entries: Map<string, Entry>;
  /** Force a scope into a state, to simulate a crash mid-effect. */
  forceState(scope: IdempotencyScope, entry: Entry): void;
}

export function recordingStore(): RecordingIdempotencyStore {
  const entries = new Map<string, Entry>();
  const calls: string[] = [];

  return {
    entries,
    calls,
    forceState(scope, entry) {
      entries.set(scopeId(scope), entry);
    },
    async begin(scope, fingerprint): Promise<BeginResult> {
      calls.push(`begin:${scope.idempotencyKey}`);
      const id = scopeId(scope);
      const existing = entries.get(id);

      if (existing === undefined) {
        // The atomic claim. No `await` between the read and the write, so two callers cannot both
        // observe absence — which is the property the PostgreSQL adapter gets from its constraint.
        entries.set(id, { state: 'IN_FLIGHT', fingerprint, record: undefined });
        return { state: 'NEW' };
      }
      if (existing.state === 'COMPLETED' && existing.record !== undefined) {
        return { state: 'COMPLETED', record: existing.record };
      }
      return { state: 'IN_FLIGHT' };
    },
    async complete(scope, record): Promise<void> {
      calls.push(`complete:${scope.idempotencyKey}`);
      const id = scopeId(scope);
      const existing = entries.get(id);
      if (existing === undefined) {
        // Completing a key nobody claimed is a wiring defect, and silently creating the row would
        // hide it.
        throw new Error('complete called for an unclaimed scope');
      }
      entries.set(id, { state: 'COMPLETED', fingerprint: existing.fingerprint, record });
    },
    async abandon(scope): Promise<void> {
      calls.push(`abandon:${scope.idempotencyKey}`);
      const id = scopeId(scope);
      const existing = entries.get(id);
      // Only an IN_FLIGHT row is released. A COMPLETED row must survive, or a retry would re-execute
      // an effect that already happened.
      if (existing !== undefined && existing.state === 'IN_FLIGHT') entries.delete(id);
    },
  };
}
