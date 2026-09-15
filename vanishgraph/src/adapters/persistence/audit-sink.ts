/**
 * The PostgreSQL audit sink (SPEC-001 §5.1, VG-EVIDENCE-003, SPEC-002 §2).
 *
 * Implements `AuditSink` from the domain. Before this file existed, **nothing in this codebase had ever
 * written an `audit_event` row.** Verified with a working search: `INSERT INTO audit_event` matches
 * nothing else under `src/` (positive control — `IdempotencyStore` matches 17 times in the same tree).
 * The only audit rows in existence were the ones `db/seed/prior_release.sql` inserts. Every route that
 * changes a truth state depends on this file, because SM-2 says a state change may not be committed
 * without its `AuditEvent`.
 *
 * ONE INSERT STATEMENT, IN ONE PLACE. Both entry points below funnel into `appendAuditEvents`, which uses
 * bind parameters through `TenantTransaction.query`. A first version of this file also carried a
 * standalone path that built the INSERT as text for `psql -f` and escaped the values by hand; that was two
 * spellings of the same statement, and the escaping one was the untested copy. It is gone. The only
 * difference between the two entry points is WHO OWNS THE TRANSACTION, which is the only difference that
 * matters for SM-2.
 *

 * WHAT IS NOT PERSISTED, STATED PLAINLY. The domain mints `AuditEvent.id` as
 * `` `${command}:${correlationId}:${nowMs}` `` (`src/domain/commands.ts`), and `audit_event.id` is
 * `bigint` with a default, so **the database assigns the row id and the domain's id string is not
 * stored.** That is not a loss for the contract: SPEC-003 §5.15's `auditEventId` and §5.5.5's
 * `transitionId` (the `TR-…` instance) both name the audit ROW, so they are that bigint rendered as a
 * string, while the domain's transition code (`T5`) is stored in `payload.transitionId` exactly as the
 * seed writes it. A caller that needs to correlate a response with a log line has `correlationId`.
 */

import { parseDsn, type Dsn } from '../../infrastructure/database/psql.ts';
import type { AuditEvent } from '../../domain/entities.ts';
import type { AuditSink } from '../../domain/ports/index.ts';
import type { EventPayloadValue } from '../../domain/events.ts';
import type { TenantTransaction, TenantTransactionRunner } from '../../http/plugins/tenancy.ts';

/** Raised when the audit append cannot be performed. The caller must abandon the operation. */
export class AuditUnavailableError extends Error {
  /** The wire code SPEC-006 §6.2 gives for a failed audit append. */
  readonly code = 'AUDIT_UNAVAILABLE' as const;
  constructor(reason: string) {
    super(`audit append failed: ${reason}`);
    this.name = 'AuditUnavailableError';
  }
}

/**
 * WHY THERE IS NO `transitionPayload` HELPER HERE, and why the transition record has no
 * spec-consistent home yet. This is a finding, not an omission, and it is recorded in
 * `ASSUMPTIONS.md` §3.18 with these citations:
 *
 *   * SPEC-001:96 gives `AuditEvent` exactly seven fields — `id, tenantId, actor, action, target, at,
 *     correlationId`. The transition CODE is not among them, and neither is `fromTruthState` nor
 *     `toTruthState`.
 *   * SPEC-001:155 (SM-2): "Every transition appends an `AuditEvent` (append-only)." So the audit row is
 *     where a transition is recorded, but the row's declared fields cannot carry what SPEC-003 §5.5.5
 *     asks a reader to see.
 *   * SPEC-002:26-27: "`jsonb` is permitted only for recorded bases and provider payloads — **never for
 *     values needing integrity (state, authority, digests)**."
 *   * SPEC-003 §5.5.5 requires, per transition: `transitionCode` ("T3"), `fromTruthState`,
 *     `toTruthState`, `actorIdentity`, `command`, `evidenceArtifactIds[]` and `correlationId`.
 *
 * A transition's `from`/`to` truth states ARE state values needing integrity, so putting them in
 * `audit_event.payload` — which is what `EP-003-node.md:132` chose and `EP-003-node.md:2182`'s seed
 * demonstrates — is the one place SPEC-002 §1 rules out. A helper that produced that shape would be this
 * node building the forbidden thing deliberately, and it would be the audit spine of the whole system:
 * every write route's `transitionId`, §5.5.5's history and §5.7.6's timeline all read it.
 *
 * The two spec-consistent ways out both belong to the specification owner, not to this node:
 * (a) a typed transition table (typed columns, CHECK-constrained states, no jsonb) added to SPEC-002 §2;
 * (b) amended SPEC-003 DTOs that stop requiring transition history.
 * Until one is chosen, §5.5.5, §5.7.3's `lastTransition` and §5.7.6's `TRANSITION` timeline entries have
 * no storage the specifications permit.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function asScalar(key: string, value: unknown): EventPayloadValue {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    return value as EventPayloadValue;
  }
  // A nested object or array would enter the audit trail as structured data that SPEC-003 §8.3's
  // prohibition ("no request body, no PII") was never checked against, and a reader would have to guess
  // its shape. Refusing keeps the audit payload's shape a closed set.
  throw new AuditUnavailableError(
    `payload.${key} is ${kind}; audit payloads carry opaque scalars only (VG-EVIDENCE-003, SPEC-003 §8.3)`,
  );
}

/** Render a payload object as the scalar map the column accepts, refusing anything non-scalar. */
export function toAuditPayload(
  payload: Readonly<Record<string, unknown>>,
): Record<string, EventPayloadValue> {
  const out: Record<string, EventPayloadValue> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = asScalar(key, value);
  }
  return out;
}

/**
 * Append audit events inside an EXISTING tenant transaction.
 *
 * THIS IS THE FORM A STATE-CHANGING HANDLER MUST USE, so the transition and its audit row share one
 * commit. SPEC-006 §7.1 row 11 names the alternative — "commit state and log later" — as forbidden, and
 * the harm is concrete: a committed transition without its audit row is a state the system cannot
 * justify, and no later reconciliation recovers the fact because the fact IS the audit row.
 *
 * No `tenant_id` is bound: the row's tenant comes from `current_setting('app.tenant_id')`, which the
 * tenancy plugin already set with `SET LOCAL`, and the FORCE RLS `WITH CHECK` verifies it. A sink that
 * tried to write another tenant's audit row is therefore refused by the database rather than by this code
 * — which is the point of having the policy.
 */
export async function appendAuditEvents(
  tx: TenantTransaction,
  events: readonly AuditEvent[],
): Promise<void> {
  for (const event of events) {
    if (!UUID_SHAPE.test(event.correlationId)) {
      // `correlation_id` is `uuid` in the schema. A non-UUID value cannot be stored, and substituting one
      // would silently break the join between an audit row and the request that caused it — the single
      // thing that column exists for. So it is refused loudly rather than written as NULL. A first version
      // of this file bound `null` here while its own comment condemned exactly that; the comment was
      // right and the code was wrong.
      throw new AuditUnavailableError(
        `correlationId ${JSON.stringify(event.correlationId)} is not a UUID; the column is uuid and substituting one would break the audit join`,
      );
    }
    if (event.targetId !== null && !UUID_SHAPE.test(event.targetId)) {
      // Same reasoning for the target: a fabricated target id would attach the audit row to the wrong
      // resource, which in an append-only trail is unfixable.
      throw new AuditUnavailableError(
        `targetId ${JSON.stringify(event.targetId)} is not a UUID; a fabricated target would attach the audit row to the wrong resource`,
      );
    }

    await tx.query(
      `INSERT INTO audit_event
         (tenant_id, actor, action, target_kind, target_id, correlation_id, payload, at)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1, $2, $3, $4::uuid, $5::uuid, $6::jsonb,
               to_timestamp($7::bigint / 1000.0))`,
      [
        event.actor,
        event.action,
        event.targetKind,
        event.targetId,
        event.correlationId,
        JSON.stringify(toAuditPayload(event.payload)),
        Math.trunc(event.atMs),
      ],
    );
  }
}

/**
 * A standalone audit sink, for callers that hold no transaction.
 *
 * WHEN TO USE WHICH, because the difference is the whole of SM-2: a handler that changes state must call
 * `appendAuditEvents(tx, …)` with its own transaction. This class satisfies the PORT for a caller that has
 * none — recording that content was downloaded, for instance — and it opens one transaction per batch so
 * the batch is atomic in itself. It is deliberately NOT wired into any write route: a sink that owns its
 * transaction cannot be atomic with someone else's state change, and offering it there would make the
 * forbidden "commit state, log later" ordering look supported.
 */
export class PostgresAuditSink implements AuditSink {
  readonly #runner: TenantTransactionRunner;

  constructor(options: { readonly runner: TenantTransactionRunner }) {
    this.#runner = options.runner;
  }

  /**
   * Construct from a DSN, for the composition root and for a probe.
   *
   * Imports the runner lazily so this module does not create an import cycle with the persistence layer
   * that the routes are wired through.
   */
  static async fromDsn(dsn: string): Promise<PostgresAuditSink> {
    const { PostgresTenantRunner } = await import('./postgres-runner.ts');
    const parsed: Dsn = parseDsn(dsn);
    return new PostgresAuditSink({ runner: new PostgresTenantRunner({ dsn: parsed, maxConnections: 2 }) });
  }

  async append(events: readonly AuditEvent[]): Promise<void> {
    if (events.length === 0) return;

    // One tenant per batch, taken from the events themselves. A batch spanning two tenants is refused
    // rather than split: `app.tenant_id` holds a single value per transaction, so splitting is the only
    // correct behaviour and doing it silently would hide a caller trying to append across the isolation
    // boundary — which VG-TENANT-002 wants failing as two independent controls, not one.
    const tenants = new Set(events.map((event) => event.tenantId.value));
    if (tenants.size !== 1) {
      throw new AuditUnavailableError(
        `a batch spans ${String(tenants.size)} tenants; one transaction carries one app.tenant_id`,
      );
    }
    const tenantId = events[0]?.tenantId.value;
    if (tenantId === undefined) throw new AuditUnavailableError('no tenant on the first event');

    // The SAME append the transactional path uses, inside a transaction this class owns. Bind parameters
    // throughout: there is no inlined or hand-escaped SQL in this file.
    await this.#runner.withTenantTransaction(tenantId, (tx) => appendAuditEvents(tx, events));
  }
}
