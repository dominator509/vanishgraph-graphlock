/**
 * Candidate records and source-record metadata (SPEC-003 §5.4.4, §5.4.5).
 *
 * WHY ONLY TWO OF §5.4's FIVE ROUTES HAVE A PORT. §5.4.1–§5.4.3 are about a `DiscoveryRun` — starting one, listing
 * them, reading one's coverage — and **`DiscoveryRun` is defined by NO specification in `.agent/specs`**: SPEC-001 §2
 * is the authoritative domain model and it lists `SourceRecord` and `Exposure` but no run, no run lifecycle and no
 * attempt record (verified by search: `DiscoveryRun` appears in no specification file). §5.4.2's own `runState`
 * vocabulary (`ACCEPTED|RUNNING|COMPLETED|COMPLETED_PARTIAL|FAILED|HUMAN_REQUIRED`) has no home, and the
 * `DISCOVERY_RUNS_QUERY` declaration in `filters.ts` still offers a DIFFERENT one (`PENDING|RUNNING|SUCCEEDED|
 * FAILED`, recorded in §3.34 item 7). Inventing the aggregate would be this node writing the domain on the
 * specification's behalf, so those three routes refuse and name the gap.
 *
 * THE TWO IMPLEMENTED ROUTES READ WHAT THE DOMAIN ACTUALLY MODELS. SPEC-001 §2 gives `SourceRecord` as "id, sourceId,
 * rawRef, observedAt, contentHash, taint" — which is exactly the `source_record` table — and an `Exposure` points at
 * a record through `sourceRecordId`. So a subject's candidate records and one record's metadata are derivable from
 * real rows, and that is what this port does.
 *
 * THREE FIELDS THE CONTRACT DECLARES AND THE DOMAIN DOES NOT HAVE, reported as `null` rather than invented:
 *
 *   * `discoveryRunId` — no column, no model (§5.4.1's blocker). A record that names no run reports `null`.
 *   * `taintReason` — `source_record.tainted` is a boolean and SPEC-001 §2 gives no reason vocabulary. When the
 *     record IS tainted the route reports §5.4.5's own token (`UNTRUSTED_REMOTE_CONTENT`, the only one its example
 *     shows, and the only reading of a `true` taint flag); when it is not, `null`.
 *   * `assessmentState` — DERIVED, not stored. `source_record` has no such column, and a second column beside the
 *     exposure's truth state would be a parallel source of truth for the same fact. The derivation is:
 *     a record with no exposure, or one whose exposure is still `DISCOVERED_CANDIDATE`, is `UNASSESSED`; a record
 *     whose exposure has moved past it is `MATCH_CONFIRMED`. **`MATCH_DISPROVED` and `QUARANTINED` are therefore
 *     UNREACHABLE**: no truth state corresponds to either (SPEC-000 §5 has eleven tokens and neither is among them),
 *     so no row can produce them, and the contract's four-token vocabulary is two tokens wider than the domain can
 *     express. Recorded in ASSUMPTIONS §3.39 rather than papered over with a column that nothing would write.
 *
 * THE SEARCH-ENGINE RULE IS ENFORCED HERE. §5.4.4: "a record from a search-engine class source can appear here only
 * with `assessmentState: "UNASSESSED"` and cannot carry an `exposureId`" (VG-IDENT-004 — `SEARCH_HIT` is never a
 * `SUBJECT_MATCH`). That is a property of the record's SOURCE class, so it is applied from `source.class` using the
 * same constant §5.5's adapter uses, not restated as a new string.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** The two tokens §5.4.5's example shows for `taint`. */
export type Taint = 'TAINTED' | 'UNTAINTED';

/** The §5.4.4 row. */
export interface CandidateRecordRow {
  readonly sourceRecordId: string;
  readonly sourceId: string;
  readonly observedAt: string;
  readonly contentHash: string;
  readonly taint: Taint;
  /** Masked: the scheme and host survive, the path does not (§5.4.4's example is `https://…/p/***`). */
  readonly rawRefMasked: string;
  readonly assessmentState: string;
  readonly exposureId: string | null;
  /**
   * The ORDERING TUPLE for the applied sort, stripped before the body is sent.
   *
   * A NUMBER for `observedAt` (epoch milliseconds), and a STRING of `contentHash:observedAtMs` for `contentHash` —
   * because ordering by hash alone is not a total order: two records can share a hash, and a keyset that compared
   * only the hash would repeat or skip one at a page boundary. The route renders whichever form the sort requires.
   */
  readonly cursorValue: number | string;
}

/** §5.4.4's mandatory coverage bounds. */
export interface CandidateCoverage {
  /**
   * Whether a coverage report exists for this subject.
   *
   * WHEN FALSE THE THREE COUNTS ARE `null`, NOT ZERO. A zero would read as "nothing was attempted", which is a
   * measurement; the truth is that no report exists, which is the absence of one — and VG-DISC-002 exists precisely
   * so a partial (or absent) discovery cannot present as "no exposure found".
   */
  readonly applies: boolean;
  readonly sourcesAttempted: number | null;
  readonly sourcesTotal: number | null;
  readonly complete: boolean | null;
}

export interface ListCandidateRecordsParams {
  readonly subjectId: string;
  readonly limit: number;
  readonly sort: string;
  readonly filters: {
    readonly sourceId: string | null;
    readonly assessmentState: readonly string[] | null;
    readonly fromMs: number;
    readonly toMs: number;
  };
  readonly after?: { readonly sortValue: string | number; readonly id: string };
}

/** The §5.4.5 detail. */
export interface SourceRecordDetail {
  readonly sourceRecordId: string;
  readonly sourceId: string;
  readonly observedAt: string;
  readonly contentHash: string;
  readonly taint: Taint;
  /** §5.4.5's own token when tainted; `null` when not. See the file header. */
  readonly taintReason: string | null;
  readonly rawRef: string;
  /** Always `null` today: no specification defines a discovery run, so nothing records one on a record. */
  readonly discoveryRunId: string | null;
  readonly assessmentState: string;
}

/** The assessment-state tokens §5.4.4 accepts as a filter, verbatim from the route. */
export const ASSESSMENT_STATES = ['UNASSESSED', 'MATCH_CONFIRMED', 'MATCH_DISPROVED', 'QUARANTINED'] as const;

/** The two of those four tokens this domain can actually produce. */
export const REACHABLE_ASSESSMENT_STATES = ['UNASSESSED', 'MATCH_CONFIRMED'] as const;

export interface DiscoveryQueries {
  /** §5.4.4 — a subject's candidate records, with the coverage bounds the listing must carry. */
  listCandidateRecords(
    tx: TenantTransaction,
    params: ListCandidateRecordsParams,
  ): Promise<{ readonly rows: readonly CandidateRecordRow[]; readonly coverage: CandidateCoverage }>;
  /** §5.4.5 — one record's metadata, or `undefined` for absent and another tenant's alike (SPEC-006 H-9). */
  getSourceRecord(tx: TenantTransaction, sourceRecordId: string): Promise<SourceRecordDetail | undefined>;
}
