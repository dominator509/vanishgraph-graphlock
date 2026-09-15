/**
 * The transition read model (SPEC-003 §5.5.5, §5.7.3's `lastTransition`, §5.7.6's `TRANSITION` entries).
 *
 * WHAT A TRANSITION IS, HERE. SPEC-001 §4.1 defines twenty-one transitions, each with a guard list and the
 * evidence it must produce; §4.3 SM-2 requires that every transition appends an `AuditEvent`, and
 * `.agent/execplans/EP-003-node.md:132` resolved the transition record to that append-only row rather than to
 * a separate table. Migration `0019` then gave the row the four facts SPEC-001:96's seven-field `AuditEvent`
 * cannot carry — `transition_code`, `from_truth_state`, `to_truth_state`, `evidence_artifact_ids` — as TYPED
 * columns, because SPEC-002:26-27 forbids `jsonb` for "values needing integrity (state, authority, digests)"
 * and a transition's from/to states are state. The reading is recorded in `ASSUMPTIONS.md` §3.27.
 *
 * SO THIS PORT READS ONE TABLE AND FOUR COLUMNS, and every field it reports is either a typed column of the
 * audit row or a value derived from one:
 *
 *   | §5.5.5 field | source |
 *   |---|---|
 *   | `transitionId` | `audit_event.id` — the `TR-…` instance, which the audit-sink header already records as the row id |
 *   | `transitionCode` | `transition_code` |
 *   | `fromTruthState` | `from_truth_state` (NULL for T1/T2, whose from-state is "none") |
 *   | `toTruthState` | `to_truth_state` |
 *   | `occurredAt` | `at` |
 *   | `actorIdentity` | `actor` |
 *   | `command` | `action`, which `buildAudit` sets to the `DomainCommandName` |
 *   | `evidenceArtifactIds` | `evidence_artifact_ids` |
 *   | `correlationId` | `correlation_id` |
 *
 * A ROW WITH NO `transition_code` IS NOT A TRANSITION and is never returned: the append path writes audit
 * rows for non-transition content too, and §5.5.5's history is a history of STATE CHANGES. The filter is
 * stated in SQL rather than left to the caller so no route can report an audit row as a transition.
 *
 * AN EXPOSURE'S HISTORY INCLUDES ITS CASE'S TRANSITIONS, because they are one story. §5.5.3 drives T3 on the
 * exposure, §5.7.1 creates the case at the exposure's current state, and every later transition is recorded
 * against the case — so a history that stopped at the exposure's own rows would end at `MATCH_CONFIRMED` and
 * report a removal that had happened as one that had not. The UNION is stated once, in the adapter, and
 * ordered oldest-first: a history read newest-first makes every caller reverse it to answer "what happened,
 * in order".
 *
 * THE TENANT IS NOT A PARAMETER: both tables carry FORCE RLS and every method runs inside a
 * `TenantTransaction` already scoped with `app.tenant_id`.
 */

import type { TenantTransaction } from '../../http/plugins/tenancy.ts';

/** One SPEC-001 §4.1 transition, as §5.5.5 reports it. */
export interface TransitionRow {
  /** `audit_event.id`, rendered as text: SPEC-003's `TR-…` instance. */
  readonly transitionId: string;
  /** SPEC-001 §4.1's row label (`T3`), so a reader can check legality without inference. */
  readonly transitionCode: string;
  /** The state moved out of; `null` for an initial state (T1/T2). */
  readonly fromTruthState: string | null;
  /** The state moved into. */
  readonly toTruthState: string;
  /** RFC 3339 instant. */
  readonly occurredAt: string;
  /** Who acted: `audit_event.actor`. */
  readonly actorIdentity: string;
  /** The command that caused it: `audit_event.action`. */
  readonly command: string;
  /** Evidence artifacts the transition produced or cited; empty when none was recorded. */
  readonly evidenceArtifactIds: readonly string[];
  /** The request that caused it. */
  readonly correlationId: string;
}

/**
 * `occurredAt` IS MILLISECOND-EXACT, which is why this history can be ordered and cursor-paginated without
 * the µs/ms trap `ASSUMPTIONS.md` §3.26 records: the append path writes `to_timestamp(atMs / 1000.0)` from an
 * INTEGER millisecond value, so no sub-millisecond digit exists to be lost when a `Date` carries the value
 * back to the wire. `audit-queries.ts` relies on the same property for `audit_event.at`.
 */

/** Read-only access to the transition spine. */
export interface TransitionQueries {
  /** Every transition recorded against an exposure OR against a case derived from it (§5.5.5), oldest first. */
  listTransitionsForExposure(
    tx: TenantTransaction,
    exposureId: string,
  ): Promise<readonly TransitionRow[]>;

  /** Every transition recorded against one case (§5.7.6's `TRANSITION` entries), oldest first. */
  listTransitionsForCase(tx: TenantTransaction, caseId: string): Promise<readonly TransitionRow[]>;

  /** The most recent transition for a case, or `undefined` when none is recorded (§5.7.3's `lastTransition`). */
  lastTransitionForCase(tx: TenantTransaction, caseId: string): Promise<TransitionRow | undefined>;
}
