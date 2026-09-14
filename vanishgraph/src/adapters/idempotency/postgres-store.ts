/**
 * The PostgreSQL idempotency store (SPEC-003 §4.2).
 *
 * ATOMICITY COMES FROM A UNIQUE CONSTRAINT, not from read-then-write. `begin` is a single
 * `INSERT ... ON CONFLICT DO NOTHING`:
 *
 *   * the row is inserted as IN_FLIGHT;
 *   * if the constraint rejects it, the row already existed, so the existing row is read and its
 *     state decides the answer.
 *
 * That is what makes two simultaneous requests produce exactly one `NEW`: the database serialises
 * them on the index, and the loser sees `IN_FLIGHT` rather than also starting the work. A
 * read-then-write implementation has a window between the two statements in which both callers read
 * `NEW`, and no amount of application-level care closes it.
 *
 * WHY THIS LIVES IN `src/adapters/` AND NOT IN THE DOMAIN: the port is a domain declaration because
 * at-most-once is a domain invariant; THIS file knows about tables, UUID casts and `ON CONFLICT`,
 * which is infrastructure knowledge. The domain must not acquire it.
 */

import type { Dsn } from '../../infrastructure/database/psql.ts';
import { queryLines, runSql } from '../../infrastructure/database/psql.ts';
import type {
  BeginResult,
  IdempotencyRecord,
  IdempotencyScope,
  IdempotencyStore,
} from '../../domain/ports/idempotency-store.ts';

/**
 * Strip anything credential-shaped from a diagnostic string.
 *
 * A psql error can echo the connection context. The store logs its failures, and a connection string
 * in a log line is a credential disclosed (VG-SEC-002), so passwords are masked before the message
 * travels any further.
 */
function redact(output: string): string {
  return output
    .replace(/postgres(?:ql)?:\/\/[^\s]*/gi, '[redacted-dsn]')
    .replace(/password=[^\s]*/gi, 'password=[redacted]')
    .slice(0, 400);
}

/** Escape a value for inclusion in a generated statement. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Wrap statements so they run inside a transaction scoped to the caller's tenant.
 *
 * WHY THIS IS NOT OPTIONAL: `http_idempotency` has FORCE RLS, and FORCE applies to the table OWNER
 * too (SPEC-002 RLS-4). A statement issued without `app.tenant_id` is refused with "new row violates
 * row-level security policy" — MEASURED while building this adapter, where every store operation
 * failed until the tenant was set.
 *
 * `set_config(..., true)` makes the setting TRANSACTION-LOCAL, so it cannot leak to the next statement
 * on a pooled connection. That matters more here than almost anywhere: a leaked tenant setting would
 * let one tenant's claim collide with another's, which is a cross-tenant information leak through the
 * conflict body.
 */
function scopedSql(tenantId: string, statements: readonly string[]): string {
  return [
    'BEGIN;',
    `SELECT set_config('app.tenant_id', ${literal(tenantId)}, true);`,
    ...statements,
    'COMMIT;',
  ].join('\n');
}

/** The table the store owns. Created by migration 0011. */
export const IDEMPOTENCY_TABLE = 'http_idempotency';

export class IdempotencyStoreError extends Error {
  readonly code = 'DEPENDENCY_UNAVAILABLE' as const;
  constructor(reason: string) {
    // The DSN and any driver detail are deliberately absent: this message reaches a log line, and a
    // connection string in a log is a credential disclosed (VG-SEC-002).
    super(`idempotency store unavailable: ${reason}`);
    this.name = 'IdempotencyStoreError';
  }
}

function scopePredicate(scope: IdempotencyScope): string {
  return (
    `tenant_id = ${literal(scope.tenantId.value)}` +
    ` AND method = ${literal(scope.method)}` +
    ` AND route_template = ${literal(scope.routeTemplate)}` +
    ` AND idempotency_key = ${literal(scope.idempotencyKey)}`
  );
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly dsn: Dsn;
  private readonly now: () => number;

  constructor(options: { dsn: Dsn; now?: () => number }) {
    this.dsn = options.dsn;
    this.now = options.now ?? Date.now;
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** The current row, or undefined. Read with a labelled projection so parsing is unambiguous. */
  private async read(scope: IdempotencyScope): Promise<BeginResult> {
    const rows = queryLines(
      this.dsn,
      scopedSql(scope.tenantId.value, [`SELECT 'vg_state=' || state || '|' ||
              COALESCE(response_status::text, '') || '|' ||
              COALESCE(response_body, '') || '|' ||
              fingerprint || '|' ||
              COALESCE(resource_id::text, '') || '|' ||
              COALESCE(traceparent, '') || '|' ||
              COALESCE((EXTRACT(EPOCH FROM completed_at) * 1000)::bigint::text, '0')
         FROM ${IDEMPOTENCY_TABLE}
        WHERE ${scopePredicate(scope)};`]),
    );
    // The `set_config` statement in `scopedSql` emits its own return value as the FIRST line, so a
    // naive `rows[0]` parses the tenant UUID as the state. MEASURED: this produced
    // "unrecognised stored state (11111111-1111-4111-8111-111111111111)" for every operation. The
    // labelled row is selected explicitly instead of by position — the same echo-row trap that bit
    // `asTenant` in EP-003 M5, which is why the label is matched rather than an index assumed.
    const line = rows.find((r) => r.startsWith('vg_state='));
    if (line === undefined) return { state: 'NEW' };

    const parts = line.replace(/^vg_state=/, '').split('|');
    const state = parts[0];
    if (state === 'IN_FLIGHT') return { state: 'IN_FLIGHT' };
    if (state !== 'COMPLETED') {
      // An unrecognised state is a corrupt row, and guessing would be worse than refusing.
      throw new IdempotencyStoreError(`unrecognised stored state (${String(state)})`);
    }
    return {
      state: 'COMPLETED',
      record: {
        responseStatus: Number(parts[1] ?? '0'),
        responseBody: parts[2] ?? '',
        fingerprint: parts[3] ?? '',
        resourceId: (parts[4] ?? '').length > 0 ? (parts[4] as string) : null,
        traceparent: (parts[5] ?? '').length > 0 ? (parts[5] as string) : null,
        completedAtMs: Number(parts[6] ?? '0'),
      },
    };
  }

  async begin(scope: IdempotencyScope, fingerprint: string): Promise<BeginResult> {
    // ONE statement, so the database is the arbiter. `ON CONFLICT DO NOTHING` reports zero rows
    // affected when the key already existed, which is the signal to go and read what happened.
    const insert = runSql(
      this.dsn,
      scopedSql(scope.tenantId.value, [
        `INSERT INTO ${IDEMPOTENCY_TABLE}
           (tenant_id, method, route_template, idempotency_key, state, fingerprint, created_at, expires_at)
         VALUES (${literal(scope.tenantId.value)}, ${literal(scope.method)},
                 ${literal(scope.routeTemplate)}, ${literal(scope.idempotencyKey)},
                 'IN_FLIGHT', ${literal(fingerprint)}, ${literal(this.nowIso())},
                 ${literal(new Date(this.now() + 24 * 60 * 60 * 1000).toISOString())})
         ON CONFLICT (tenant_id, method, route_template, idempotency_key) DO NOTHING
         RETURNING state;`,
      ]),
    );
    if (insert.status !== 0) {
      // The underlying psql output is included, with any password masked. An earlier version reported
      // only "begin failed", which cost a full debug cycle to trace: the real message was an RLS
      // refusal, and hiding it made a specific, actionable fault look like a generic one.
      throw new IdempotencyStoreError(`begin failed: ${redact(insert.output)}`);
    }

    // DID THIS CALL PERFORM THE INSERT? `RETURNING` answers it unambiguously: the statement returns a
    // row only when it actually inserted, and returns nothing when ON CONFLICT DO NOTHING suppressed
    // it.
    //
    // MEASURED DEFECT this replaces: an earlier version inferred the answer by comparing the STORED
    // fingerprint against this call's. That cannot distinguish the inserter from a concurrent caller
    // with the same body — both match — so a two-caller race reported `IN_FLIGHT + IN_FLIGHT` and
    // NEITHER request proceeded, and a 20-caller race reported zero claims. An effect-bearing request
    // would have returned 409 forever rather than executing once.
    const claimed = insert.output.includes('IN_FLIGHT');

    const current = await this.read(scope);
    if (current.state === 'COMPLETED') return current;
    if (claimed) return { state: 'NEW' };
    // The row existed and is in flight, and this call did not insert it: another request holds it.
    return { state: 'IN_FLIGHT' };
  }

  async complete(scope: IdempotencyScope, record: IdempotencyRecord): Promise<void> {
    const result = runSql(
      this.dsn,
      scopedSql(scope.tenantId.value, [
        `UPDATE ${IDEMPOTENCY_TABLE}
            SET state = 'COMPLETED',
                response_status = ${record.responseStatus},
                response_body = ${literal(record.responseBody)},
                resource_id = ${record.resourceId === null ? 'NULL' : literal(record.resourceId)},
                traceparent = ${record.traceparent === null ? 'NULL' : literal(record.traceparent)},
                completed_at = ${literal(new Date(record.completedAtMs).toISOString())}
          WHERE ${scopePredicate(scope)};`,
      ]),
    );
    if (result.status !== 0) {
      throw new IdempotencyStoreError(`complete failed: ${redact(result.output)}`);
    }
  }

  async abandon(scope: IdempotencyScope): Promise<void> {
    // Only an IN_FLIGHT row is removed. A COMPLETED row must survive: deleting it would let a retry
    // re-execute an effect that already happened.
    const result = runSql(
      this.dsn,
      scopedSql(scope.tenantId.value, [
        `DELETE FROM ${IDEMPOTENCY_TABLE}
          WHERE ${scopePredicate(scope)} AND state = 'IN_FLIGHT';`,
      ]),
    );
    if (result.status !== 0) {
      throw new IdempotencyStoreError(`abandon failed: ${redact(result.output)}`);
    }
  }
}
