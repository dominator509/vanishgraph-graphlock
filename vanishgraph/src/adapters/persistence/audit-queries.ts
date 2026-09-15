/**
 * The PostgreSQL audit-stream read model (SPEC-003 §5.15).
 *
 * Implements `AuditQueries` from the application layer. The DTO types come from the port, so a handler that
 * imports them never acquires a dependency on this file.
 *
 * READ-ONLY BY CONSTRUCTION: this class issues only `SELECT`. The append path is
 * `src/adapters/persistence/audit-sink.ts`, and it is the only writer of `audit_event` in the codebase — which
 * is what makes "the append-only property is enforced by the absence of a mutation surface" true at the
 * adapter layer as well as at the route layer.
 *
 * TENANT SCOPING IS NOT DONE HERE: every statement relies on RLS, and `audit_event` carries FORCE RLS, so a
 * second application-level `WHERE tenant_id = …` would mask a broken policy rather than complement it.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import type {
  ActorKind,
  AuditEventRow,
  AuditOutcome,
  AuditQueries,
  ListAuditParams,
} from '../../application/contracts/audit-queries.ts';

interface RawAuditRow {
  id: string;
  tenant_id: string;
  actor: string;
  actor_kind: string;
  action: string;
  target_kind: string;
  target_id: string | null;
  correlation_id: string;
  payload: unknown;
  at: Date;
  request_id: string | null;
  outcome: string;
  refusal_code: string | null;
  traceparent: string | null;
}

/**
 * The projection every audit read shares.
 *
 * `payload` IS NOT SELECTED, AND THAT IS A CONTROL RATHER THAN AN OPTIMISATION. SPEC-003 §5.15.1 requires
 * that audit payloads "never contain raw PII, identifier values, secrets, tokens, signature material, or
 * request bodies (VG-SEC-002, §8.3)", and the DTO has no field for the payload. Fetching it would put it in
 * this process's memory for no caller, where a later edit could serialise it; not fetching it means no
 * handler can leak what it never received.
 */
const AUDIT_PROJECTION = `
  a.id::text            AS id,
  a.tenant_id::text     AS tenant_id,
  a.actor               AS actor,
  a.actor_kind          AS actor_kind,
  a.action              AS action,
  a.target_kind         AS target_kind,
  a.target_id::text     AS target_id,
  a.correlation_id::text AS correlation_id,
  a.at                  AS at,
  a.request_id::text    AS request_id,
  a.outcome             AS outcome,
  a.refusal_code        AS refusal_code,
  a.traceparent         AS traceparent
`;

function toRow(row: RawAuditRow): AuditEventRow {
  return {
    auditEventId: row.id,
    tenantId: row.tenant_id,
    actor: { kind: row.actor_kind as ActorKind, actorId: row.actor },
    action: row.action,
    target: { kind: row.target_kind, id: row.target_id },
    at: row.at.toISOString(),
    correlationId: row.correlation_id,
    requestId: row.request_id,
    outcome: row.outcome as AuditOutcome,
    refusalCode: row.refusal_code,
    traceparent: row.traceparent,
  };
}

export class PostgresAuditQueries implements AuditQueries {
  async listAuditEvents(tx: TenantTransaction, params: ListAuditParams): Promise<readonly AuditEventRow[]> {
    // `sort` is `at` (default `at:desc`) plus the `id` tiebreaker the schema also allows. The mapping is a
    // closed set, so an unparsed token cannot become a column name.
    const [field = 'at', direction = 'desc'] = params.sort.split(':');
    const sortColumn = field === 'id' ? 'a.id' : 'a.at';
    const comparison = direction === 'asc' ? '>' : '<';
    const order = direction === 'asc' ? 'ASC' : 'DESC';

    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };

    // The range is NOT optional: the route refuses an unbounded scan before reaching here, and building the
    // predicate unconditionally means this method cannot be called in a way that scans the whole stream.
    const where: string[] = [
      `a.at >= to_timestamp(${bind(params.filters.fromMs)}::bigint / 1000.0)`,
      `a.at < to_timestamp(${bind(params.filters.toMs)}::bigint / 1000.0)`,
    ];
    if (params.filters.actor !== undefined) where.push(`a.actor = ${bind(params.filters.actor)}`);
    if (params.filters.action !== undefined) {
      const actions =
        typeof params.filters.action === 'string' ? [params.filters.action] : params.filters.action;
      where.push(`a.action = ANY(${bind([...actions])}::text[])`);
    }
    if (params.filters.targetKind !== undefined) where.push(`a.target_kind = ${bind(params.filters.targetKind)}`);
    if (params.filters.targetId !== undefined) {
      where.push(`a.target_id = ${bind(params.filters.targetId)}::uuid`);
    }
    if (params.filters.correlationId !== undefined) {
      where.push(`a.correlation_id = ${bind(params.filters.correlationId)}::uuid`);
    }
    if (params.after !== undefined) {
      // Keyset with the id tiebreaker: several events can share one instant — a command emits one audit row,
      // but a batch or a burst can share a millisecond — and without the id a page boundary between them
      // repeats or skips a row, which in an audit trail is a row an auditor never sees.
      where.push(
        `(a.${field === 'id' ? 'id' : 'at'}, a.id) ${comparison} (${bind(params.after.sortValue)}::${field === 'id' ? 'bigint' : 'timestamptz'}, ${bind(params.after.id)}::bigint)`,
      );
    }

    const limitParam = bind(params.limit + 1);
    const result = await tx.query<RawAuditRow>(
      `SELECT ${AUDIT_PROJECTION}
         FROM audit_event a
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortColumn} ${order}, a.id ${order}
        LIMIT ${limitParam}`,
      values,
    );
    return result.rows.map(toRow);
  }

  async getAuditEvent(tx: TenantTransaction, auditEventId: string): Promise<AuditEventRow | undefined> {
    // `id` is `bigint`, so the parameter is cast to bigint rather than uuid. The route has already refused a
    // non-numeric id as 404, so a cast failure here would mean the guard had been bypassed.
    const result = await tx.query<RawAuditRow>(
      `SELECT ${AUDIT_PROJECTION} FROM audit_event a WHERE a.id = $1::bigint`,
      [auditEventId],
    );
    const row = result.rows[0];
    // Absent and another tenant's event are INDISTINGUISHABLE by construction: RLS means another tenant's row
    // is not returned, so both reach this branch and produce one 404 body (SPEC-006 H-9).
    return row === undefined ? undefined : toRow(row);
  }
}
