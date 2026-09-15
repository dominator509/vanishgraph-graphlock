/**
 * The read-model port the HTTP layer depends on (SPEC-003 §1, ARCHITECTURE.md §2).
 *
 * WHY THIS EXISTS: `src/http/**` must not import `src/adapters/**` (the code law, enforced by
 * `scripts/import-boundary.sh`). The subjects handlers need to read subjects, and reaching into the
 * PostgreSQL adapter to do it would weld the boundary to one storage technology — the exact coupling
 * that let the EP-016/EP-007 stack change leave the domain untouched, and that the code law exists to
 * preserve.
 *
 * So the boundary depends on THESE interfaces, `src/adapters/persistence/**` implements them, and the
 * composition root wires the two. A handler that needs a new read adds a method here and implements it
 * in the adapter; it never learns that SQL exists.
 *
 * WHAT DOES NOT BELONG HERE: anything that decides a truth state. These are READ models — queries
 * whose results are projected for a response. A state change is an application command, and SPEC-001
 * SM-6 puts the decision inside the domain's guard list.
 *
 * THE TENANT IS NOT A PARAMETER. Every method runs inside a `TenantTransaction` the runner has already
 * scoped with `app.tenant_id`, and the tables carry FORCE RLS. Passing a tenant here would invite a
 * second, application-level filter — which VG-TENANT-002 does not forbid, but which would MASK a
 * broken policy rather than complement it. The database is the control; this interface does not
 * duplicate it.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** The §5.1.2 subject list row. */
export interface SubjectListRow {
  readonly subjectId: string;
  readonly displayRef: string;
  readonly jurisdiction: string;
  readonly isMinor: boolean;
  /** `VALID|EXPIRED|REVOKED|NONE`. NOT a truth state: a subject has an authority state. */
  readonly authorityState: 'VALID' | 'EXPIRED' | 'REVOKED' | 'NONE';
  readonly caseCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The §5.1.3 subject detail. */
export interface SubjectDetail extends SubjectListRow {
  readonly aliasesCount: number;
  readonly identifiersCount: number;
  readonly openCaseCount: number;
  readonly authorityGrants: readonly { readonly authorityGrantId: string; readonly state: string }[];
  readonly locationHistory: readonly {
    readonly locationHistoryId: string;
    readonly jurisdiction: string;
    readonly from: string;
    readonly to: string | null;
    readonly provenance: string;
  }[];
}

/** The §5.1.6 alias row, masked by construction: there is no field for a revealed value. */
export interface AliasListRow {
  readonly aliasId: string;
  readonly valueMasked: string;
  readonly provenance: string;
  readonly method: string;
  readonly addedAt: string;
  readonly quarantined: boolean;
}

/** The §5.1.8 identifier row, masked by construction. */
export interface IdentifierListRow {
  readonly identifierId: string;
  readonly kind: string;
  readonly valueMasked: string;
  readonly provenance: string;
  readonly createdAt: string;
  readonly keyRef: string;
}

/** The §5.1.9 location-history row. */
export interface LocationHistoryRow {
  readonly locationHistoryId: string;
  readonly jurisdiction: string;
  readonly from: string;
  readonly to: string | null;
  readonly provenance: string;
}

/** The §5.2.2 authority-grant row: IDs and states only. */
export interface AuthorityGrantRow {
  readonly authorityGrantId: string;
  readonly subjectId: string;
  readonly kind: string;
  readonly scope: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly validNow: boolean;
}

export interface SubjectFilters {
  readonly jurisdiction?: string;
  readonly isMinor?: boolean;
  readonly authorityState?: string | readonly string[];
}

export interface ListSubjectsParams {
  readonly limit: number;
  readonly sort: string;
  readonly filters: SubjectFilters;
  readonly after?: { readonly sortValue: string; readonly id: string };
}

/**
 * The subject read model.
 *
 * A port rather than a concrete class, so the handler depends on behaviour it can be tested against
 * and the adapter can change without touching a route.
 */
export interface SubjectQueries {
  /** List subjects, keyset-paginated, fetching `limit + 1` rows so the caller learns `hasMore`. */
  listSubjects(tx: TenantTransaction, params: ListSubjectsParams): Promise<readonly SubjectListRow[]>;
  /** Detail, or `undefined` for both an absent and another tenant's subject (SPEC-006 H-9). */
  getSubjectDetail(tx: TenantTransaction, subjectId: string): Promise<SubjectDetail | undefined>;
  /** Whether the subject exists for this tenant, for the 404 path on a SUB-RESOURCE route. */
  subjectExists(tx: TenantTransaction, subjectId: string): Promise<boolean>;
  /** Aliases, masked: the interface has no field a revealed value could occupy. */
  listAliases(tx: TenantTransaction, subjectId: string): Promise<readonly AliasListRow[]>;
  /** Identifiers, masked. */
  listIdentifiers(tx: TenantTransaction, subjectId: string): Promise<readonly IdentifierListRow[]>;
  /** Location history intervals. */
  listLocationHistory(tx: TenantTransaction, subjectId: string): Promise<readonly LocationHistoryRow[]>;
  /** Authority grants for a subject, IDs and states only. */
  listAuthorityGrants(tx: TenantTransaction, subjectId: string): Promise<readonly AuthorityGrantRow[]>;
  /** Whether a jurisdiction has a policy row in force (SPEC-003 §5.1.10). */
  jurisdictionResolves(tx: TenantTransaction, jurisdiction: string): Promise<boolean>;
  /** Append a location interval; returns its id. */
  appendLocationHistory(
    tx: TenantTransaction,
    input: {
      readonly subjectId: string;
      readonly jurisdiction: string;
      readonly from: string;
      readonly to: string | null;
      readonly provenance: string;
    },
  ): Promise<{ readonly locationHistoryId: string }>;
  /**
   * Attach an alias, or quarantine it when the value matches several subjects (VG-IDENT-002).
   *
   * The ambiguity check and the insert happen INSIDE this method, in one transaction, so two
   * concurrent attaches of the same ambiguous value cannot both see "one match" and both attach.
   * Splitting the check from the insert at the handler level would reopen that window.
   */
  appendAlias(
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
  }>;
}
