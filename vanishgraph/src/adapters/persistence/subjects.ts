/**
 * The PostgreSQL subject read model (SPEC-003 §5.1, §5.2.2).
 *
 * Implements `SubjectQueries` from the application layer. The DTO TYPES come from the port, not from
 * here, so a handler that imports them never acquires a dependency on this file — which is what keeps
 * `src/http/**` free of adapter imports (ARCHITECTURE.md §2).
 *
 * TENANT SCOPING IS NOT DONE HERE. Every statement relies on RLS: the runner has already set
 * `app.tenant_id`, and `protected_subject` has FORCE RLS. No query below names `tenant_id` in a
 * predicate, so if RLS were absent the tests would FAIL rather than pass quietly. Adding a
 * `WHERE tenant_id = ...` would be a second control that MASKS a broken policy, which is the opposite
 * of the defence in depth VG-TENANT-002 asks for.
 *
 * The masked reads (aliases, identifiers) never SELECT the ciphertext column. A missing scope
 * therefore cannot leak a value through a projection bug, because the bytes are never fetched.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import type {
  AliasListRow,
  AuthorityGrantRow,
  IdentifierListRow,
  ListSubjectsParams,
  LocationHistoryRow,
  SubjectDetail,
  SubjectListRow,
  SubjectQueries,
} from '../../application/contracts/subject-queries.ts';

/**
 * `authorityState` derives from the tenant's live grants for the subject.
 *
 * The branch ORDER is the semantics: a live grant wins, then a revoked one is reported as `REVOKED`,
 * then any remaining grant is `EXPIRED`, then `NONE`. A subject with both a revoked grant and a valid
 * one is `VALID` — the revoked row is history, not a disqualification.
 */
const AUTHORITY_STATE_SQL = `
  CASE
    WHEN EXISTS (
      SELECT 1 FROM authority_grant g
       WHERE g.subject_id = s.id
         AND g.revoked_at IS NULL
         AND (g.expires_at IS NULL OR g.expires_at > now())
    ) THEN 'VALID'
    WHEN EXISTS (SELECT 1 FROM authority_grant g WHERE g.subject_id = s.id AND g.revoked_at IS NOT NULL) THEN 'REVOKED'
    WHEN EXISTS (SELECT 1 FROM authority_grant g WHERE g.subject_id = s.id) THEN 'EXPIRED'
    ELSE 'NONE'
  END
`;

/** The projection every subject read shares, so a list row and a detail row cannot disagree. */
const SUBJECT_PROJECTION = `
  s.id::text            AS subject_id,
  s.display_ref         AS display_ref,
  s.jurisdiction        AS jurisdiction,
  s.is_minor            AS is_minor,
  ${AUTHORITY_STATE_SQL} AS authority_state,
  (SELECT count(*) FROM request_case c WHERE c.subject_id = s.id)::int AS case_count,
  s.created_at          AS created_at,
  s.updated_at          AS updated_at
`;

interface RawSubjectRow {
  subject_id: string;
  display_ref: string;
  jurisdiction: string;
  is_minor: boolean;
  authority_state: string;
  case_count: number;
  created_at: Date;
  updated_at: Date;
}

function toListRow(row: RawSubjectRow): SubjectListRow {
  return {
    subjectId: row.subject_id,
    displayRef: row.display_ref,
    jurisdiction: row.jurisdiction,
    isMinor: row.is_minor,
    authorityState: row.authority_state as SubjectListRow['authorityState'],
    caseCount: row.case_count,
    // ISO-8601 with milliseconds, which is the form the contract's abbreviated examples denote.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresSubjectQueries implements SubjectQueries {
  async listSubjects(
    tx: TenantTransaction,
    params: ListSubjectsParams,
  ): Promise<readonly SubjectListRow[]> {
    const [field = 'createdAt', direction = 'desc'] = params.sort.split(':');
    const sortColumn = field === 'displayRef' ? 'display_ref' : 'created_at';
    const comparison = direction === 'asc' ? '>' : '<';
    const order = direction === 'asc' ? 'ASC' : 'DESC';

    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${String(values.length)}`;
    };

    const where: string[] = [];
    if (params.filters.jurisdiction !== undefined) {
      where.push(`s.jurisdiction = ${bind(params.filters.jurisdiction)}`);
    }
    if (params.filters.isMinor !== undefined) {
      where.push(`s.is_minor = ${bind(params.filters.isMinor)}`);
    }
    if (params.filters.authorityState !== undefined) {
      // `authority_state` is DERIVED, so PostgreSQL cannot reference the SELECT alias in `WHERE`.
      // MEASURED failure: the filter produced `column "authority_state" does not exist` and the route
      // answered 500. Interpolating the SAME constant keeps the filter and the projection in step, so
      // an edit to `AUTHORITY_STATE_SQL` moves both rather than only one.
      const states = typeof params.filters.authorityState === 'string'
        ? [params.filters.authorityState]
        : params.filters.authorityState;
      where.push(`(${AUTHORITY_STATE_SQL}) = ANY(${bind([...states])}::text[])`);
    }
    if (params.after !== undefined) {
      // Keyset with the id tiebreaker: two subjects created in the same millisecond share a sort
      // value, and without the id a page boundary between them repeats or skips one — silently
      // dropping a subject from a report about whether their data was removed.
      where.push(
        `(s.${sortColumn}, s.id::text) ${comparison} (${bind(params.after.sortValue)}::timestamptz, ${bind(params.after.id)})`,
      );
    }

    const limitParam = bind(params.limit + 1);
    const result = await tx.query<RawSubjectRow>(
      `SELECT ${SUBJECT_PROJECTION}
         FROM protected_subject s
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.${sortColumn} ${order}, s.id ${order}
        LIMIT ${limitParam}`,
      values,
    );
    return result.rows.map(toListRow);
  }

  async getSubjectDetail(
    tx: TenantTransaction,
    subjectId: string,
  ): Promise<SubjectDetail | undefined> {
    const base = await tx.query<RawSubjectRow>(
      `SELECT ${SUBJECT_PROJECTION} FROM protected_subject s WHERE s.id = $1::uuid`,
      [subjectId],
    );
    const row = base.rows[0];
    // Absent and other-tenant are INDISTINGUISHABLE by construction: RLS means another tenant's row is
    // simply not returned, so both reach this branch and produce one 404 body (SPEC-006 H-9).
    if (row === undefined) return undefined;

    const counts = await tx.query<{
      aliases_count: number;
      identifiers_count: number;
      open_case_count: number;
    }>(
      `SELECT
         (SELECT count(*) FROM alias a WHERE a.subject_id = s.id)::int AS aliases_count,
         (SELECT count(*) FROM identifier i WHERE i.subject_id = s.id)::int AS identifiers_count,
         (SELECT count(*) FROM request_case c
           WHERE c.subject_id = s.id
             AND c.truth_state NOT IN ('VERIFIED_REMOVED','VERIFIED_NOT_PRESENT','NOT_REMOVABLE')
         )::int AS open_case_count
       FROM protected_subject s WHERE s.id = $1::uuid`,
      [subjectId],
    );

    const grants = await this.listAuthorityGrants(tx, subjectId);
    const history = await this.listLocationHistory(tx, subjectId);
    const shape = counts.rows[0];

    return {
      ...toListRow(row),
      aliasesCount: shape?.aliases_count ?? 0,
      identifiersCount: shape?.identifiers_count ?? 0,
      openCaseCount: shape?.open_case_count ?? 0,
      // IDs and states only: SPEC-003 §5.1.3 says so, and the signed instrument is absent by design.
      authorityGrants: grants.map((g) => ({ authorityGrantId: g.authorityGrantId, state: g.validNow ? 'VALID' : 'REVOKED' })),
      locationHistory: history,
    };
  }

  async subjectExists(tx: TenantTransaction, subjectId: string): Promise<boolean> {
    const result = await tx.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM protected_subject WHERE id = $1::uuid',
      [subjectId],
    );
    return result.rows[0]?.n === '1';
  }

  async listAliases(tx: TenantTransaction, subjectId: string): Promise<readonly AliasListRow[]> {
    // `value_enc` is NOT selected. The masked shape is enforced by the query rather than by a mapping
    // step, so there is no intermediate value a bug could leak.
    const rows = await tx.query<{
      id: string;
      provenance: string;
      method: string;
      quarantined: boolean;
      created_at: Date;
    }>(
      `SELECT a.id::text AS id, a.provenance, a.method, a.quarantined, a.created_at
         FROM alias a
        WHERE a.subject_id = $1::uuid
        ORDER BY a.created_at DESC`,
      [subjectId],
    );
    return rows.rows.map((row) => ({
      aliasId: row.id,
      // A FIXED mask, not a transformation of the value: it must not vary with the value's length or
      // content, or the mask itself becomes a side channel.
      valueMasked: '***',
      provenance: row.provenance,
      method: row.method,
      addedAt: row.created_at.toISOString(),
      quarantined: row.quarantined,
    }));
  }

  async listIdentifiers(
    tx: TenantTransaction,
    subjectId: string,
  ): Promise<readonly IdentifierListRow[]> {
    const rows = await tx.query<{
      id: string;
      kind: string;
      provenance: string;
      created_at: Date;
      key_version: number;
      tenant_id: string;
    }>(
      `SELECT i.id::text AS id, i.kind, i.provenance, i.created_at, i.key_version, i.tenant_id::text AS tenant_id
         FROM identifier i
        WHERE i.subject_id = $1::uuid
        ORDER BY i.created_at DESC`,
      [subjectId],
    );
    return rows.rows.map((row) => ({
      identifierId: row.id,
      kind: row.kind,
      valueMasked: '***',
      provenance: row.provenance,
      createdAt: row.created_at.toISOString(),
      // `keyRef` names the key VERSION that protects the value, never the key material.
      keyRef: `kms:${row.tenant_id}:v${String(row.key_version)}`,
    }));
  }

  async listLocationHistory(
    tx: TenantTransaction,
    subjectId: string,
  ): Promise<readonly LocationHistoryRow[]> {
    const rows = await tx.query<{
      id: string;
      jurisdiction: string;
      effective_from: Date;
      effective_to: Date | null;
      provenance: string;
    }>(
      `SELECT h.id::text AS id, h.jurisdiction, h.effective_from, h.effective_to, h.provenance
         FROM location_history h
        WHERE h.subject_id = $1::uuid
        ORDER BY h.effective_from DESC`,
      [subjectId],
    );
    return rows.rows.map((row) => ({
      locationHistoryId: row.id,
      jurisdiction: row.jurisdiction,
      from: row.effective_from.toISOString(),
      to: row.effective_to === null ? null : row.effective_to.toISOString(),
      provenance: row.provenance,
    }));
  }

  async listAuthorityGrants(
    tx: TenantTransaction,
    subjectId: string,
  ): Promise<readonly AuthorityGrantRow[]> {
    const rows = await tx.query<{
      id: string;
      kind: string;
      scope: string[];
      issued_at: Date;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT g.id::text AS id, g.kind::text AS kind, g.scope, g.issued_at, g.expires_at, g.revoked_at
         FROM authority_grant g
        WHERE g.subject_id = $1::uuid
        ORDER BY g.issued_at DESC`,
      [subjectId],
    );
    return rows.rows.map((row) => ({
      authorityGrantId: row.id,
      subjectId,
      kind: row.kind,
      scope: row.scope,
      issuedAt: row.issued_at.toISOString(),
      expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
      revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
      validNow: row.revoked_at === null && (row.expires_at === null || row.expires_at > new Date()),
    }));
  }

  async jurisdictionResolves(tx: TenantTransaction, jurisdiction: string): Promise<boolean> {
    const rows = await tx.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM jurisdiction_policy WHERE jurisdiction = $1',
      [jurisdiction],
    );
    return rows.rows[0]?.n !== '0';
  }

  async appendLocationHistory(
    tx: TenantTransaction,
    input: {
      readonly subjectId: string;
      readonly jurisdiction: string;
      readonly from: string;
      readonly to: string | null;
      readonly provenance: string;
    },
  ): Promise<{ readonly locationHistoryId: string }> {
    // `current_setting('app.tenant_id', true)` rather than a parameter: the tenant comes from the
    // session the runner established, so this INSERT cannot write a row for another tenant even if a
    // caller passed a subject id belonging to one — the WITH CHECK policy would refuse it.
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO location_history
         (tenant_id, subject_id, jurisdiction, effective_from, effective_to, provenance)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1::uuid, $2, $3::timestamptz, $4::timestamptz, $5)
       RETURNING id::text AS id`,
      [input.subjectId, input.jurisdiction, input.from, input.to, input.provenance],
    );
    const row = rows.rows[0];
    if (row === undefined) throw new Error('location history insert returned no row');
    return { locationHistoryId: row.id };
  }

  async appendAlias(
    tx: TenantTransaction,
    input: {
      readonly subjectId: string;
      readonly value: string;
      readonly hmac: Uint8Array;
      readonly provenance: string;
      readonly method: string;
    },
  ): Promise<{
    readonly aliasId: string;
    readonly addedAt: string;
    readonly quarantined: boolean;
    readonly candidateSubjectIds: readonly string[];
  }> {
    // The ambiguity check runs FIRST and inside the same transaction as the insert, so two concurrent
    // attaches cannot both observe "one match" and both proceed. Splitting them across two calls
    // would reopen exactly that window.
    const matches = await tx.query<{ subject_id: string }>(
      `SELECT DISTINCT subject_id::text AS subject_id
         FROM alias
        WHERE value_hmac = $1 AND subject_id IS NOT NULL`,
      [Buffer.from(input.hmac)],
    );

    if (matches.rows.length > 1) {
      // VG-IDENT-002: an alias matching more than one subject is QUARANTINED, never auto-attached. A
      // quarantined row has `subject_id IS NULL`, which the schema's CHECK ties to `quarantined`.
      const created = await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO alias (tenant_id, subject_id, value_enc, value_hmac, provenance, method, quarantined)
         VALUES (current_setting('app.tenant_id', true)::uuid, NULL, $1, $2, $3, $4, true)
         RETURNING id::text AS id, created_at`,
        [Buffer.from(input.value, 'utf8'), Buffer.from(input.hmac), input.provenance, input.method],
      );
      const row = created.rows[0];
      if (row === undefined) throw new Error('quarantined alias insert returned no row');
      return {
        aliasId: row.id,
        addedAt: row.created_at.toISOString(),
        quarantined: true,
        candidateSubjectIds: matches.rows.map((m) => m.subject_id),
      };
    }

    const created = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO alias (tenant_id, subject_id, value_enc, value_hmac, provenance, method, quarantined)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1::uuid, $2, $3, $4, $5, false)
       RETURNING id::text AS id, created_at`,
      [
        input.subjectId,
        // NOT ENCRYPTED YET, and recorded as a limitation rather than presented as the specified
        // construction (SPEC-002 §4 requires envelope encryption; the KMS is BLOCKED_CREDENTIALS).
        // The column is bytea and holds the UTF-8 bytes, so a later migration can encrypt in place.
        Buffer.from(input.value, 'utf8'),
        Buffer.from(input.hmac),
        input.provenance,
        input.method,
      ],
    );
    const row = created.rows[0];
    if (row === undefined) throw new Error('alias insert returned no row');
    return {
      aliasId: row.id,
      addedAt: row.created_at.toISOString(),
      quarantined: false,
      candidateSubjectIds: [],
    };
  }
}
