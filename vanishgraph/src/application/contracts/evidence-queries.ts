/**
 * Evidence artifacts, read model (SPEC-003 §5.12.2, §5.12.5).
 *
 * WHAT THIS PORT CAN HONESTLY REPORT, AND WHAT IT CANNOT.
 *
 * `linkedTraceability` IS RESOLVED FROM THE TRANSITION SPINE, NOT INVENTED. VG-EVIDENCE-002 requires the chain
 * requirement → case → artifact → digest to be resolvable. Two thirds of that chain exist here: `evidence_artifact`
 * carries the case, and `audit_event.evidence_artifact_ids` records which transitions produced or cited this
 * artifact (§5.5.5's history is built from those rows). **The requirement side has NO source**: no specification
 * declares a table or column mapping an artifact to a requirement id, and `REQUIREMENT_TRACEABILITY.csv` is a
 * verification-side artefact, not product data. So `requirementIds` is reported as an EMPTY LIST — the honest
 * value — rather than being filled from a file that is not part of the running system. Recorded in ASSUMPTIONS §3.38.
 *
 * `sizeBytes` AND `mediaType` ARE NOT STORED ANYWHERE. §5.12.1's upload row carries both, and `evidence_artifact`
 * has no column for either; the bytes live behind the `EvidenceStore` port, whose own declaration returns bytes
 * without metadata. Both are therefore reported as `null` — "not recorded" — rather than guessed from the digest or
 * the storage reference. Nothing here fabricates a size.
 *
 * `redactionState` IS REPORTED VERBATIM FROM THE COLUMN, and that column's vocabulary does not match the
 * contract's. MEASURED: the constraint is `CHECK (redaction_state IN ('NONE','SCRUBBED','DENIED'))` while
 * SPEC-003 §5.12.1 declares the values `UNREDACTED|DLP_SCRUBBED`. A translation table in a read route would hide
 * the disagreement and would be this node choosing a vocabulary on the specification's behalf; the route reports
 * what is stored, and ASSUMPTIONS §3.38 records that a client implementing the contract will not see contract
 * tokens until either the constraint or the contract changes.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** The §5.12.2/§5.12.5 row. */
export interface EvidenceArtifactRow {
  readonly evidenceArtifactId: string;
  readonly kind: string;
  readonly digest: string;
  readonly storageRef: string;
  /** Verbatim from the column; see the file header on the vocabulary conflict. */
  readonly redactionState: string;
  readonly capturedAt: string;
  readonly createdAt: string;
  readonly linkedCaseIds: readonly string[];
  /** Always `null`: nothing records a size. */
  readonly sizeBytes: number | null;
  /** Always `null`: nothing records a media type. */
  readonly mediaType: string | null;
  /**
   * `true` by contract and by the absence of any update path: VG-EVIDENCE-001 says there is no update, replace or
   * delete route for artifact content, and the route registry contains none. This is a statement about the API
   * surface, which is why it can be reported as a constant without reading a column.
   */
  readonly immutable: true;
}

/** The §5.12.2 detail: the row plus the traceability chain. */
export interface EvidenceArtifactDetail extends EvidenceArtifactRow {
  readonly linkedTraceability: {
    /** Empty, with a reason: see the file header. */
    readonly requirementIds: readonly string[];
    readonly caseIds: readonly string[];
    readonly transitionIds: readonly string[];
  };
}

export interface EvidenceQueries {
  /** One artifact with its traceability, or `undefined` for absent and another tenant's alike (SPEC-006 H-9). */
  getEvidenceArtifact(tx: TenantTransaction, evidenceArtifactId: string): Promise<EvidenceArtifactDetail | undefined>;
  /** §5.12.5 — the artifacts bound to a case. `undefined` when the case does not resolve. */
  listCaseEvidenceArtifacts(
    tx: TenantTransaction,
    caseId: string,
  ): Promise<readonly EvidenceArtifactRow[] | undefined>;
}
