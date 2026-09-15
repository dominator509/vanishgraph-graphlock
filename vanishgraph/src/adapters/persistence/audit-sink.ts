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
import { ALL_TRUTH_STATES, type TransitionId, type TruthState } from '../../domain/truth-state.ts';
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
 * WHERE THE TRANSITION FACTS ARE STORED, AND WHY THEY ARE COLUMNS RATHER THAN `payload` ENTRIES.
 *
 * `ASSUMPTIONS.md` §3.18 records the conflict: SPEC-001:96 gives `AuditEvent` exactly seven fields — `id,
 * tenantId, actor, action, target, at, correlationId` — so the transition CODE and the from/to truth
 * states are not fields of the entity, and SPEC-002:26-27 permits `jsonb` "only for recorded bases and
 * provider payloads — never for values needing integrity (state, authority, digests)", which rules out
 * `audit_event.payload` for a transition's from/to truth states.
 *
 * The resolution, recorded as a reading in `ASSUMPTIONS.md` §3.27: migration `0019` adds
 * `transition_code`, `from_truth_state`, `to_truth_state` and `evidence_artifact_ids` to `audit_event`.
 * That keeps EP-003's own decision intact — `audit_event` IS the append-only record of a transition, not a
 * separate table — and it satisfies SPEC-002 §1 rather than working around it: the states are typed with
 * the `truth_state` enum of exactly the eleven SPEC-000 §5 values, and `jsonb` keeps its permitted use.
 * The append-only rules and the FORCE RLS policy that already protect the audit row protect these columns
 * too, which a new table would have had to re-earn.
 *
 * The transition code is supplied by the CALLER (the application service that ran the command), because
 * the domain's `TransitionCommandResult` is where `transitionId`, `from`, `to` and the evidence belong —
 * `buildAudit` in `src/domain/commands.ts` puts the command's own payload into the audit row and knows
 * nothing about the transition it produced.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A dash-less 32-hex identifier: the form the correlation plugin mints.
 *
 * MEASURED DEFECT this corrects. `installCorrelation` generates `randomUUID().replace(/-/g, '')` and honours a
 * W3C `traceparent`'s 32-hex trace id, so **every** request's `correlationId` is dash-less. The audit sink
 * required a canonical UUID and refused anything else, so the FIRST write route to append an audit row
 * answered `500` with "correlationId … is not a UUID". Every effect-bearing route in the service would have
 * done the same; §5.5.3's assessment is simply the first one implemented.
 *
 * THE TWO FORMS ARE THE SAME 128 BITS. Inserting the dashes is a FORMAT conversion of the value the caller
 * supplied, not a substitute for it — which is what the refusal was protecting against — and the stored column
 * is then joinable to the `correlationId` the caller was given, which is the only thing that column is for.
 * Any OTHER shape is still refused: a fabricated or truncated id would break that join silently, and in an
 * append-only trail that is unfixable.
 */
const HEX32_SHAPE = /^[0-9a-f]{32}$/i;

/** The canonical UUID text for an identifier that is already one of the two accepted forms. */
function canonicalUuid(value: string): string | undefined {
  if (UUID_SHAPE.test(value)) return value;
  if (!HEX32_SHAPE.test(value)) return undefined;
  const hex = value.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The W3C trace context shape: `version-traceid-spanid-flags`, lowercase hex. */
const TRACEPARENT_SHAPE = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/**
 * The observability metadata §5.15.1 reports about the REQUEST that produced a batch of audit events.
 *
 * WHY THIS IS A PARAMETER AND NOT A DOMAIN FIELD. `actorKind`, `outcome`, `requestId`, `refusalCode` and
 * `traceparent` are not part of SPEC-001:96's `AuditEvent` (`id, tenantId, actor, action, target, at,
 * correlationId`), and three of them are TRANSPORT facts about the request — its correlation identifier, its
 * W3C trace context, and how it was refused. Knowing them is the append path's business, not the domain's, so
 * they are supplied here rather than added to the entity; `ASSUMPTIONS.md` §3.25 records the reading,
 * including that `actor.kind`'s vocabulary has no normative source while `outcome`'s does (SPEC-007 §285).
 *
 * ONE BATCH, ONE OUTCOME: a command that succeeds emits several events, all of them SUCCEEDED, and a refused
 * command's events are all REFUSED. Per-event overrides would let one transition's audit rows disagree about
 * whether the transition happened.
 */
export interface AuditMetadata {
  readonly actorKind?: 'HUMAN' | 'SERVICE' | 'SYSTEM';
  readonly outcome?: 'SUCCEEDED' | 'REFUSED' | 'FAILED' | 'AMBIGUOUS' | 'GATED';
  /** The id of the HTTP request that produced the event, when there was one. */
  readonly requestId?: string;
  /** The wire code of the refusal, when the request was refused. */
  readonly refusalCode?: string;
  /** The W3C trace context, when the caller supplied or the service generated one. */
  readonly traceparent?: string;
}

/**
 * The transition a single audit row records (SPEC-001 §4.1, SPEC-003 §5.5.5).
 *
 * ONE TRANSITION, ONE ROW. The domain builds exactly one `AuditEvent` per command (`CommandResult.audit`),
 * and §5.5.5's history lists one entry per transition, so `appendAuditEvents` refuses a batch of more than
 * one event when the caller supplies a transition: writing the same transition code onto several rows
 * would make one state change appear as several in the history, and §5.5.5 is the read a reviewer uses to
 * check legality.
 */
export interface AuditTransition {
  /** SPEC-001 §4.1's row label, `T1`–`T21`. */
  readonly transitionCode: TransitionId;
  /** `null` for T1/T2, which establish an initial state rather than moving between states. */
  readonly from: TruthState | null;
  readonly to: TruthState;
  /**
   * Evidence artifacts this transition produced or cited.
   *
   * An EMPTY LIST IS STORED AS SQL NULL, because the column's CHECK refuses an empty array: `'{}'` would
   * claim evidence was recorded while naming none, which is the vacuous-array defect `ASSUMPTIONS.md` §3.6
   * records. A transition whose SPEC-001 §4.1 evidence is a record ("coverage bounds + scan evidence",
   * "gate record") rather than an artifact legitimately has no artifact id, and NULL is what that is.
   */
  readonly evidenceArtifactIds: readonly string[];
  /**
   * The case this transition belongs to, when one exists.
   *
   * NOT the same thing as the audit row's `targetId`, which names what the command ACTED ON — an external
   * action for T8, an exposure for T3. §5.7.3's `lastTransition` and §5.7.6's timeline read a case's
   * history, so the case is recorded separately and a T8 is not lost from the case it belongs to. Omitted
   * for T1–T4, which occur before any case exists (§5.7.1 creates the case at the exposure's current state).
   */
  readonly caseId?: string;
}

/** SPEC-001 §4.1's code shape: exactly T1–T21, the same set the column's CHECK admits. */
const TRANSITION_CODE_SHAPE = /^T([1-9]|1[0-9]|2[01])$/;

/** The eleven SPEC-000 §5 tokens, as a set, so an unknown state is refused before the enum sees it. */
const TRUTH_STATES: ReadonlySet<string> = new Set<string>(ALL_TRUTH_STATES);
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
 *
 * RETURNS THE ROW IDS, in event order, because §5.5.3/§5.5.4 and every other write route report
 * `transitionId` — the `TR-…` instance, which is `audit_event.id` rendered as text. Returning them from the
 * INSERT is the only way a response can name the row that was just written rather than a row it hopes was
 * written; a caller that does not need them ignores the value.
 */
export async function appendAuditEvents(
  tx: TenantTransaction,
  events: readonly AuditEvent[],
  metadata: AuditMetadata = {},
  transition?: AuditTransition,
): Promise<readonly string[]> {
  if (metadata.requestId !== undefined && !UUID_SHAPE.test(metadata.requestId)) {
    throw new AuditUnavailableError(
      `requestId ${JSON.stringify(metadata.requestId)} is not a UUID; the column is uuid and a fabricated one would not join to the request it names`
    );
  }
  if (metadata.traceparent !== undefined && !TRACEPARENT_SHAPE.test(metadata.traceparent)) {
    throw new AuditUnavailableError(
      `traceparent ${JSON.stringify(metadata.traceparent)} is not a W3C trace context; the column's CHECK would refuse it`
    );
  }

  if (transition !== undefined) {
    // One row per transition, and the batch must be exactly that row. See `AuditTransition`.
    if (events.length !== 1) {
      throw new AuditUnavailableError(
        `a transition names ${String(events.length)} audit events; a transition is recorded by exactly one row, and writing the same code onto several would make one state change appear as several in the §5.5.5 history`,
      );
    }
    if (!TRANSITION_CODE_SHAPE.test(transition.transitionCode)) {
      throw new AuditUnavailableError(
        `transitionCode ${JSON.stringify(transition.transitionCode)} is not a SPEC-001 §4.1 code (T1–T21)`,
      );
    }
    if (!TRUTH_STATES.has(transition.to)) {
      // The column is the `truth_state` enum, so this would fail at the database with a type error whose
      // message names the column rather than the caller's mistake. Refusing here names the value.
      throw new AuditUnavailableError(`to ${JSON.stringify(transition.to)} is not a SPEC-000 §5 truth state`);
    }
    if (transition.from !== null && !TRUTH_STATES.has(transition.from)) {
      throw new AuditUnavailableError(
        `from ${JSON.stringify(transition.from)} is not a SPEC-000 §5 truth state`,
      );
    }
    for (const artifactId of transition.evidenceArtifactIds) {
      // `evidence_artifact_ids` is `uuid[]`: a wire-shaped or fabricated id cannot be stored, and
      // substituting one would make the transition cite evidence that is not the evidence it cited.
      if (!UUID_SHAPE.test(artifactId)) {
        throw new AuditUnavailableError(
          `evidence artifact id ${JSON.stringify(artifactId)} is not a UUID; the column is uuid[] and an unstoreable id would silently drop the citation`,
        );
      }
    }
    if (transition.caseId !== undefined && !UUID_SHAPE.test(transition.caseId)) {
      throw new AuditUnavailableError(
        `caseId ${JSON.stringify(transition.caseId)} is not a UUID; the column is a foreign key and a fabricated case would attach the transition to the wrong history`,
      );
    }
  }

  const insertedIds: string[] = [];

  for (const event of events) {
    const storedCorrelationId = canonicalUuid(event.correlationId);
    if (storedCorrelationId === undefined) {
      // `correlation_id` is `uuid` in the schema. A value in neither accepted form cannot be stored, and
      // substituting one would silently break the join between an audit row and the request that caused it —
      // the single thing that column exists for. So it is refused loudly rather than written as NULL. A first
      // version of this file bound `null` here while its own comment condemned exactly that; the comment was
      // right and the code was wrong. A second version refused the service's OWN dash-less correlation ids;
      // see `canonicalUuid`.
      throw new AuditUnavailableError(
        `correlationId ${JSON.stringify(event.correlationId)} is neither a UUID nor a 32-hex trace id; the column is uuid and substituting one would break the audit join`,
      );
    }
    if (event.targetId !== null && !UUID_SHAPE.test(event.targetId)) {
      // Same reasoning for the target: a fabricated target id would attach the audit row to the wrong
      // resource, which in an append-only trail is unfixable.
      throw new AuditUnavailableError(
        `targetId ${JSON.stringify(event.targetId)} is not a UUID; a fabricated target would attach the audit row to the wrong resource`,
      );
    }

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO audit_event
         (tenant_id, actor, action, target_kind, target_id, correlation_id, payload, at,
          actor_kind, outcome, request_id, refusal_code, traceparent,
          transition_code, from_truth_state, to_truth_state, evidence_artifact_ids, case_id)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1, $2, $3, $4::uuid, $5::uuid, $6::jsonb,
               to_timestamp($7::bigint / 1000.0), coalesce($8, 'SERVICE'), coalesce($9, 'SUCCEEDED'),
               $10::uuid, $11, $12,
               $13, $14::truth_state, $15::truth_state, $16::uuid[], $17::uuid)
       RETURNING id::text AS id`,
      [
        event.actor,
        event.action,
        event.targetKind,
        event.targetId,
        storedCorrelationId,
        JSON.stringify(toAuditPayload(event.payload)),
        Math.trunc(event.atMs),
        // `null` here lets the column's DEFAULT apply, rather than this function writing a value it guessed.
        // `coalesce($8, 'SERVICE')` in the statement above is what makes an explicit SQL NULL fall back to the
        // default: naming the column in an INSERT bypasses its DEFAULT, so without the coalesce a batch that
        // supplied no metadata would write NULL into a NOT NULL column.
        metadata.actorKind ?? null,
        metadata.outcome ?? null,
        metadata.requestId ?? null,
        metadata.refusalCode ?? null,
        metadata.traceparent ?? null,
        transition?.transitionCode ?? null,
        transition?.from ?? null,
        transition?.to ?? null,
        // An empty list becomes SQL NULL; see `AuditTransition.evidenceArtifactIds` for why the column's
        // CHECK refuses `'{}'` rather than accepting it as "no evidence".
        transition === undefined || transition.evidenceArtifactIds.length === 0
          ? null
          : [...transition.evidenceArtifactIds],
        transition?.caseId ?? null,
      ],
    );
    const rowId = inserted.rows[0]?.id;
    // A `RETURNING` clause on an INSERT that reported no row means the write did not happen as asked. Refusing
    // here keeps the caller from reporting a `transitionId` for a row it cannot name.
    if (rowId === undefined) {
      throw new AuditUnavailableError('the audit INSERT returned no row id');
    }
    insertedIds.push(rowId);
  }

  return insertedIds;
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
