/**
 * The PostgreSQL deadline model (SPEC-003 §5.13).
 *
 * Implements `DeadlineQueries` from the application layer. The DTO types come from the port, so a handler
 * that imports them never acquires a dependency on this file.
 *
 * THE PROVENANCE JOIN IS THE POINT OF THIS FILE. §5.13.1 requires every deadline to name the policy version
 * and rule code it derives from (VG-POLICY-001: deadlines come from versioned data, never a code constant).
 * The version and the rule live on the case's `PolicyDecision`, so every read here joins through it. A case
 * with no policy decision therefore has deadlines whose provenance cannot be named, and `createDeadline`
 * refuses that case with `NO_PROVENANCE` rather than writing a row the contract says cannot exist — see the
 * route for the wire code it maps to.
 *
 * TENANT SCOPING IS NOT DONE HERE: every statement relies on RLS, and `deadline` carries FORCE RLS. The one
 * `INSERT` supplies the tenant from `current_setting('app.tenant_id', true)`, which the policy's WITH CHECK
 * then verifies.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';
import type {
  CaseDeadlineContext,
  CreateDeadlineInput,
  DeadlineProvenance,
  DeadlineQueries,
  DeadlineRow,
  DeadlineState,
  SatisfyDeadlineInput,
} from '../../application/contracts/deadline-queries.ts';
// The derivation and the overdue calculation are IMPORTED, not re-implemented: they are rules about the
// contract's vocabulary, the contract file owns them, and a second copy here is a second definition that
// could drift from the one `tests/contract` asserts.
import {
  deriveState,
  overdueSeconds,
} from '../../application/contracts/deadline-queries.ts';

/**
 * The policy version as the WIRE renders it.
 *
 * `jurisdiction_policy.version` and `policy_decision.policy_version` are both `integer` (migration 0004),
 * while SPEC-003's examples show `"2026-01-15"`. No specification states the version's type or format —
 * SPEC-001 §3.3 gives `JurisdictionPolicy` a bare `version` field — so the wire form is the stored number
 * rendered as a string, and the example's date-looking value is an EXAMPLE whose format the data model does
 * not share. Recorded in `ASSUMPTIONS.md` §3.23 rather than silently substituted: a caller comparing
 * against the example would see `"1"`, and that is worth knowing.
 */
function wireVersion(value: number): string {
  return String(value);
}

interface RawDeadlineRow {
  id: string;
  case_id: string;
  kind: string;
  due_at: Date;
  satisfied_at: Date | null;
  policy_version: number | null;
  legal_basis: string | null;
}

export class PostgresDeadlineQueries implements DeadlineQueries {
  /** Delegates to the contract's single definition — see deriveState in the port for why it lives there. */
  deriveState(satisfiedAtMs: number | null, dueAtMs: number, nowMs: number): DeadlineState {
    return deriveState(satisfiedAtMs, dueAtMs, nowMs);
  }

  async caseDeadlineContext(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<CaseDeadlineContext | undefined> {
    // A LEFT JOIN, because a case without a policy decision must still be FOUND — its absence of provenance
    // is a different fact from its absence of existence, and the route reports them differently.
    const result = await tx.query<{
      id: string;
      truth_state: string;
      updated_at: Date;
      policy_version: number | null;
      legal_basis: string | null;
    }>(
      `SELECT c.id::text AS id, c.truth_state::text AS truth_state, c.updated_at,
              d.policy_version, d.legal_basis
         FROM request_case c
         LEFT JOIN policy_decision d ON d.id = c.policy_decision_id
        WHERE c.id = $1::uuid`,
      [caseId],
    );
    const row = result.rows[0];
    // Absent and another tenant's case are INDISTINGUISHABLE by construction: RLS means another tenant's
    // row is not returned, so both reach this branch and produce one 404 body (SPEC-006 H-9).
    if (row === undefined) return undefined;

    const provenance: DeadlineProvenance | undefined =
      row.policy_version === null || row.legal_basis === null
        ? undefined
        : { policyVersion: wireVersion(row.policy_version), ruleCode: row.legal_basis };

    return {
      caseId: row.id,
      truthState: row.truth_state,
      updatedAtMs: row.updated_at.getTime(),
      provenance,
    };
  }

  async evidenceExists(tx: TenantTransaction, evidenceArtifactId: string): Promise<boolean> {
    // Reads `evidence_artifact` under RLS, so another tenant's artifact is NOT evidence for this case —
    // which is what makes `422 EVIDENCE_NOT_FOUND` the right answer for a cross-tenant reference rather
    // than a cross-tenant citation.
    const result = await tx.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM evidence_artifact e WHERE e.id = $1::uuid',
      [evidenceArtifactId],
    );
    return result.rows[0]?.n !== '0';
  }

  async listDeadlines(tx: TenantTransaction, caseId: string, nowMs: number): Promise<readonly DeadlineRow[]> {
    const result = await tx.query<RawDeadlineRow>(
      `SELECT d.id::text AS id, d.case_id::text AS case_id, d.kind, d.due_at, d.satisfied_at,
              p.policy_version, p.legal_basis
         FROM deadline d
         LEFT JOIN policy_decision p ON p.case_id = d.case_id
        WHERE d.case_id = $1::uuid
        ORDER BY d.due_at ASC, d.id ASC`,
      [caseId],
    );

    return result.rows.map((row) => {
      const satisfiedAtMs = row.satisfied_at === null ? null : row.satisfied_at.getTime();
      const dueAtMs = row.due_at.getTime();
      // A deadline whose case has no policy decision would report a provenance the contract says every
      // deadline has. Rather than fabricate one, the fields are rendered as the empty string — which is a
      // visible absence — and the situation is refused at CREATION (`NO_PROVENANCE`), so a row in this
      // state can only come from outside the API. Recorded in `ASSUMPTIONS.md` §3.23.
      const provenance: DeadlineProvenance =
        row.policy_version === null || row.legal_basis === null
          ? { policyVersion: '', ruleCode: '' }
          : { policyVersion: wireVersion(row.policy_version), ruleCode: row.legal_basis };

      return {
        deadlineId: row.id,
        caseId: row.case_id,
        kind: row.kind,
        dueAt: row.due_at.toISOString(),
        derivedFrom: provenance,
        state: deriveState(satisfiedAtMs, dueAtMs, nowMs),
        satisfiedAt: row.satisfied_at === null ? null : row.satisfied_at.toISOString(),
        overdueSeconds: overdueSeconds(satisfiedAtMs, dueAtMs, nowMs),
      };
    });
  }

  async createDeadline(
    tx: TenantTransaction,
    caseId: string,
    input: CreateDeadlineInput,
  ): Promise<
    | { readonly ok: true; readonly value: { readonly deadlineId: string } }
    | { readonly ok: false; readonly reason: 'CASE_NOT_FOUND' | 'EVIDENCE_NOT_FOUND' | 'NO_PROVENANCE' }
  > {
    const context = await this.caseDeadlineContext(tx, caseId);
    if (context === undefined) return { ok: false, reason: 'CASE_NOT_FOUND' };
    // Refused BEFORE the insert: a deadline whose policy version and rule code cannot be named is one
    // §5.13.1's "every deadline names the policy version and rule code it was derived from" forbids, and
    // writing it would make that sentence false for a row the API created.
    if (context.provenance === undefined) return { ok: false, reason: 'NO_PROVENANCE' };
    if (!(await this.evidenceExists(tx, input.evidenceArtifactId))) {
      return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }

    const inserted = await tx.query<{ id: string }>(
      // `derivation_ref` keeps its `policy:%` form (its CHECK requires it), naming the policy version the
      // deadline derives from — which is SPEC-001 §3.4's `Deadline.source`. §5.13.2's out-of-band `source`
      // goes in `derivation_input`, so the two facts stay distinguishable: this deadline derives from the
      // policy version AND was dated by the controller.
      `INSERT INTO deadline
         (tenant_id, case_id, kind, due_at, derivation_ref, derivation_input, evidence_artifact_id)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1::uuid, $2, to_timestamp($3::bigint / 1000.0),
               $4, $5, $6::uuid)
       RETURNING id::text AS id`,
      [
        caseId,
        input.kind,
        Math.trunc(input.dueAtMs),
        input.derivationRef,
        input.source,
        input.evidenceArtifactId,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) return { ok: false, reason: 'CASE_NOT_FOUND' };
    return { ok: true, value: { deadlineId: row.id } };
  }

  async satisfyDeadline(
    tx: TenantTransaction,
    deadlineId: string,
    input: SatisfyDeadlineInput,
  ): Promise<
    | { readonly ok: true; readonly value: { readonly deadlineId: string; readonly satisfiedAt: string } }
    | { readonly ok: false; readonly reason: 'NOT_FOUND' | 'ALREADY_SATISFIED' | 'EVIDENCE_NOT_FOUND' }
  > {
    // The row is LOCKED before the already-satisfied check, so two concurrent satisfactions cannot both
    // observe an unsatisfied row and both write — which would make the second one silently overwrite the
    // first satisfier and destroy the answer to "who met this deadline".
    const locked = await tx.query<{ satisfied_at: Date | null }>(
      'SELECT d.satisfied_at FROM deadline d WHERE d.id = $1::uuid FOR UPDATE',
      [deadlineId],
    );
    const existing = locked.rows[0];
    if (existing === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (existing.satisfied_at !== null) return { ok: false, reason: 'ALREADY_SATISFIED' };

    if (!(await this.evidenceExists(tx, input.evidenceArtifactId))) {
      return { ok: false, reason: 'EVIDENCE_NOT_FOUND' };
    }

    const updated = await tx.query<{ satisfied_at: Date }>(
      `UPDATE deadline d
          SET satisfied_at         = to_timestamp($2::bigint / 1000.0),
              satisfied_by         = $3,
              evidence_artifact_id = $4::uuid
        WHERE d.id = $1::uuid
      RETURNING d.satisfied_at`,
      [deadlineId, Math.trunc(input.satisfiedAtMs), input.satisfiedBy, input.evidenceArtifactId],
    );
    const written = updated.rows[0];
    if (written === undefined) return { ok: false, reason: 'NOT_FOUND' };
    return { ok: true, value: { deadlineId, satisfiedAt: written.satisfied_at.toISOString() } };
  }
}
