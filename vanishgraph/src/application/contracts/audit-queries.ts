/**
 * The audit-stream read model the HTTP layer depends on (SPEC-003 §5.15, ARCHITECTURE.md §2).
 *
 * READ-ONLY, AND STRUCTURALLY SO. §5.15.1 states it as a property of the API rather than of a handler: "There
 * is **no** `POST`, `PATCH`, `PUT`, or `DELETE` audit route anywhere on `/v1`: the append-only property is
 * enforced by the absence of a mutation surface as well as by storage (VG-EVIDENCE-003)." So this port has no
 * write method, and the two methods it has are both reads. The append path is `AuditSink`
 * (`src/domain/ports/audit-sink.ts`) and is reached only from the code that performs a state change.
 *
 * WHY THE ACTOR IS AN OBJECT. §5.15.1 reports `actor: {kind, actorId}`, and the kind's vocabulary
 * (`HUMAN|SERVICE|SYSTEM`) appears in NO normative table — only inside that example body — while SPEC-007 §285
 * DOES normatively define `outcome` (`SUCCEEDED, REFUSED, FAILED, AMBIGUOUS, GATED`). Both are recorded in
 * `ASSUMPTIONS.md` §3.25, including why the five-token outcome set is admitted rather than §5.15.1's two.
 *
 * `auditEventId` IS A `bigint` RENDERED AS A STRING, and it is not opaque in the way the contract's `aud_01H…`
 * example suggests: `audit_event.id` is `bigint` (migration 0005), so the wire value is a decimal string and
 * the detail route must parse it as one. A UUID-shaped parameter parser would reject every real id. Recorded
 * rather than silently reshaping the id space.
 *
 * THE TENANT IS NOT A PARAMETER: every method runs inside a `TenantTransaction` already scoped with
 * `app.tenant_id`, and `audit_event` carries FORCE RLS.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** The actor classes §5.15.1's example names. */
export type ActorKind = 'HUMAN' | 'SERVICE' | 'SYSTEM';

/** SPEC-007 §285's outcome enum — the normative source, all five tokens. */
export type AuditOutcome = 'SUCCEEDED' | 'REFUSED' | 'FAILED' | 'AMBIGUOUS' | 'GATED';

/** One §5.15.1 row. */
export interface AuditEventRow {
  /** The `bigint` row id as a decimal string — see the note above on why it is not a UUID. */
  readonly auditEventId: string;
  readonly tenantId: string;
  readonly actor: { readonly kind: ActorKind; readonly actorId: string };
  readonly action: string;
  readonly target: { readonly kind: string; readonly id: string | null };
  readonly at: string;
  readonly correlationId: string;
  readonly requestId: string | null;
  readonly outcome: AuditOutcome;
  readonly refusalCode: string | null;
  readonly traceparent: string | null;
}

/** The §5.15.1 filters. `fromMs`/`toMs` are always present: the route requires a range. */
export interface AuditFilters {
  readonly actor?: string;
  readonly action?: string | readonly string[];
  readonly targetKind?: string;
  readonly targetId?: string;
  readonly correlationId?: string;
  readonly fromMs: number;
  readonly toMs: number;
}

export interface ListAuditParams {
  readonly limit: number;
  readonly sort: string;
  readonly filters: AuditFilters;
  /** Keyset continuation. `sortValue` is the `at` instant; `id` breaks ties between equal instants. */
  readonly after?: { readonly sortValue: string; readonly id: string };
}

export interface AuditQueries {
  /** §5.15.1 — the bounded, keyset-paginated audit stream, fetching `limit + 1` so the caller learns `hasMore`. */
  listAuditEvents(tx: TenantTransaction, params: ListAuditParams): Promise<readonly AuditEventRow[]>;
  /** §5.15.2 — one event, `undefined` for absent and another tenant's alike (SPEC-006 H-9). */
  getAuditEvent(tx: TenantTransaction, auditEventId: string): Promise<AuditEventRow | undefined>;
}

/**
 * Whether a path segment can be an audit event id.
 *
 * A `bigint` is all decimal digits, so anything else cannot match a row — and refusing it as a malformed
 * request rather than as a missing resource would leak that the id space is numeric. The route therefore
 * treats an unparseable id as `404`, exactly as `/v1/subjects/{subjectId}` treats a malformed UUID.
 */
export function isAuditEventId(value: string): boolean {
  return /^[0-9]{1,19}$/.test(value);
}
