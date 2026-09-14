/**
 * At-most-once execution (SPEC-001 §5.1, VG-ACTION-001; SPEC-003 §4).
 *
 * PLACEMENT: SPEC-001 §5.1's binding table puts `IdempotencyStore` in `src/domain/ports/` because
 * "at-most-once is a domain invariant (VG-ACTION-001)". This node's M5 plan text contradicted itself
 * — it named `src/domain/ports/idempotency-store.ts` and then said "the port is declared in the
 * application layer". The specification wins: a domain invariant belongs to the domain, and a port
 * that lived in the application layer would make the invariant an orchestration detail.
 *
 * PORT DECLARATION GAP, recorded: SPEC-001 §5 lists this port and `AuthorityGrantRepository`, and
 * EP-002 — which owns port declaration (SPEC-001 §5.1 rule 4) — declared neither. EP-002 is closed, so
 * this node declares `IdempotencyStore` once, here, rather than re-declaring it later.
 * `AuthorityGrantRepository` remains undeclared and is noted in ASSUMPTIONS.md.
 *
 * WHY THE PORT IS SHAPED THIS WAY. The three operations are deliberately NOT a single
 * `checkAndSet`, because the caller must be able to act BETWEEN `begin` and `complete`:
 *
 *     const { state, record } = await store.begin(scopeKey);
 *     if (state === 'COMPLETED') return replay(record);
 *     if (state === 'IN_FLIGHT') return conflict();
 *     const result = await doTheWork();       // exactly one caller reaches here
 *     await store.complete(scopeKey, record);
 *
 * A combined operation would have to hold a database transaction open across the work, which for an
 * external effect means holding it across a network call to a third party. That is how a connection
 * pool is exhausted by a slow provider.
 *
 * `abandon` is the counterpart of `begin`: a request that fails BEFORE producing an effect must
 * release the key, or a transient error would leave the key permanently in flight and the caller
 * could never retry. A request that fails AFTER the effect is a different case and must NOT abandon —
 * that is an ambiguous outcome, and SPEC-003 §4.5 makes it a reconciliation, not a retry.
 */

import type { TenantId } from '../identifiers.ts';

/**
 * The uniqueness scope (SPEC-003 §4.2): `(tenantId, method, routeTemplate, idempotencyKey)`.
 *
 * A structural key rather than a string, so a caller cannot build one by concatenation and get the
 * separator wrong — `("a", "b:c")` and `("a:b", "c")` would collide in a naive join, letting one
 * route's key shadow another's.
 */
export interface IdempotencyScope {
  readonly tenantId: TenantId;
  readonly method: string;
  /** The route TEMPLATE, e.g. `/v1/cases/{caseId}/external-actions`, not the resolved path. */
  readonly routeTemplate: string;
  /** The caller-supplied key, already validated for shape at the boundary. */
  readonly idempotencyKey: string;
}

/** What a completed key recorded (SPEC-003 §4.2). */
export interface IdempotencyRecord {
  /** The ORIGINAL response status, replayed verbatim on a repeat. */
  readonly responseStatus: number;
  /** The ORIGINAL response body, replayed verbatim. Stored as text, not a parsed object: a reparse
   * could reorder keys and change the bytes a client sees. */
  readonly responseBody: string;
  /** SHA-256 of the canonicalised request body. A different fingerprint is a conflict. */
  readonly fingerprint: string;
  /** The id of the resource the first request produced, for the conflict body. */
  readonly resourceId: string | null;
  /** SPEC-003 §4.2 stores `traceparent`; it is the tracing join, not a decision input. */
  readonly traceparent: string | null;
  readonly completedAtMs: number;
}

/** The state a scope key is in. */
export type IdempotencyState = 'NEW' | 'IN_FLIGHT' | 'COMPLETED';

export interface BeginResult {
  readonly state: IdempotencyState;
  /** Present when `state` is `COMPLETED`. */
  readonly record?: IdempotencyRecord;
}

export interface IdempotencyStore {
  /**
   * Claim the key, or report what already happened.
   *
   * MUST be atomic: two simultaneous requests with the same key must produce exactly one `NEW` and
   * one `IN_FLIGHT`, never two `NEW`s. That is the whole point of the port, and an implementation
   * that reads then writes without a constraint is not an implementation of it.
   *
   * `NEW` also CLAIMS the key (it becomes in flight) — the name is about what the caller learns, not
   * about a lock-free read.
   */
  begin(scope: IdempotencyScope, fingerprint: string): Promise<BeginResult>;

  /** Record the completed outcome. After this, `begin` returns `COMPLETED` with this record. */
  complete(scope: IdempotencyScope, record: IdempotencyRecord): Promise<void>;

  /**
   * Release a key whose request failed BEFORE producing an effect.
   *
   * Returns the key to `NEW` so the caller can retry. Must NOT be called after an effect has
   * occurred: that case is ambiguous (SPEC-003 §4.5) and must go through reconciliation.
   */
  abandon(scope: IdempotencyScope): Promise<void>;
}
