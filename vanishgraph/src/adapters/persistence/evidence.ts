/**
 * Evidence artifacts against PostgreSQL (SPEC-003 §5.12.2, §5.12.5).
 *
 * THE TRACEABILITY QUERY IS A JOIN ON THE TRANSITION SPINE, not a second table. `audit_event.evidence_artifact_ids`
 * is the array the transition writer fills (migration `0019`), so "which transitions cited this artifact" is a
 * containment test on that column — and the GIN index that column already carries is what makes it a lookup rather
 * than a scan.
 *
 * THE CASE LIST CHECKS THE CASE FIRST. §5.12.5 is a sub-resource route: an artifact list for a case that does not
 * exist must be `404`, while an EMPTY list for a case that exists is a true statement about it (SPEC-006 H-9). The
 * port therefore returns `undefined` for the former and `[]` for the latter, and the route maps them differently —
 * the defect §3.32 item 5 records is exactly the opposite shape.
 */

import type {
  EvidenceArtifactDetail,
  EvidenceArtifactRow,
  EvidenceQueries,
} from '../../application/contracts/evidence-queries.ts';
import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

interface RawRow {
  id: string;
  kind: string;
  digest: string;
  storage_ref: string;
  redaction_state: string;
  captured_at: Date;
  created_at: Date;
  case_id: string | null;
}

function toRow(raw: RawRow): EvidenceArtifactRow {
  return {
    evidenceArtifactId: raw.id,
    kind: raw.kind,
    digest: raw.digest.trim(),
    storageRef: raw.storage_ref,
    redactionState: raw.redaction_state,
    capturedAt: raw.captured_at.toISOString(),
    createdAt: raw.created_at.toISOString(),
    linkedCaseIds: raw.case_id === null ? [] : [raw.case_id],
    // Nothing records either value. `null` is "not recorded", which is what the table says.
    sizeBytes: null,
    mediaType: null,
    immutable: true,
  };
}

export class PostgresEvidenceQueries implements EvidenceQueries {
  async getEvidenceArtifact(
    tx: TenantTransaction,
    evidenceArtifactId: string,
  ): Promise<EvidenceArtifactDetail | undefined> {
    const result = await tx.query<RawRow>(
      `SELECT e.id::text AS id, e.kind, e.digest::text AS digest, e.storage_ref, e.redaction_state,
              e.captured_at, e.created_at, e.case_id::text AS case_id
         FROM evidence_artifact e
        WHERE e.id = $1::uuid`,
      [evidenceArtifactId],
    );
    const raw = result.rows[0];
    if (raw === undefined) return undefined;

    // `= ANY(...)` on the array column, which the GIN index on `evidence_artifact_ids` serves. The id is passed as
    // a UUID and cast, so the comparison is on the array's own element type rather than on text.
    const transitions = await tx.query<{ id: string; case_id: string | null }>(
      `SELECT a.id::text AS id, a.case_id::text AS case_id
         FROM audit_event a
        WHERE a.evidence_artifact_ids IS NOT NULL
          AND $1::uuid = ANY (a.evidence_artifact_ids)
        ORDER BY a.at DESC, a.id DESC`,
      [evidenceArtifactId],
    );

    const caseIds = new Set<string>();
    if (raw.case_id !== null) caseIds.add(raw.case_id);
    for (const row of transitions.rows) {
      if (row.case_id !== null) caseIds.add(row.case_id);
    }

    return {
      ...toRow(raw),
      linkedTraceability: {
        // NO SOURCE EXISTS for this third of VG-EVIDENCE-002's chain: see the port's header. An empty list is the
        // honest answer, and a fabricated one would make a reviewer believe a chain was verified that was not.
        requirementIds: [],
        caseIds: [...caseIds],
        transitionIds: transitions.rows.map((row) => row.id),
      },
    };
  }

  async listCaseEvidenceArtifacts(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<readonly EvidenceArtifactRow[] | undefined> {
    const exists = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM request_case c WHERE c.id = $1::uuid`,
      [caseId],
    );
    // An empty list is a true statement about a case that exists, and a misleading one about a case the caller
    // cannot see — so existence is asserted directly rather than inferred from the artifact rows.
    if (Number(exists.rows[0]?.n ?? '0') === 0) return undefined;
    const rows = await tx.query<RawRow>(
      `SELECT e.id::text AS id, e.kind, e.digest::text AS digest, e.storage_ref, e.redaction_state,
              e.captured_at, e.created_at, e.case_id::text AS case_id
         FROM evidence_artifact e
        WHERE e.case_id = $1::uuid
        ORDER BY e.captured_at DESC, e.id DESC`,
      [caseId],
    );
    return rows.rows.map(toRow);
  }
}
