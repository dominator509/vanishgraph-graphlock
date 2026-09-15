/**
 * Append-only audit sink (SPEC-001 §5.1, VG-EVIDENCE-003) — declaration only.
 *
 * The domain owns this port because "append-only audit is a domain invariant": SPEC-001 SM-2 states that
 * no state change may be committed without its `AuditEvent`, so the requirement is part of what a legal
 * transition IS, not a logging preference. Which store performs the append is not a domain question, so
 * no table, driver or DSN appears here.
 *
 * PLACEMENT: SPEC-001 §5.1 rule 1 requires one file per port inside a `ports/` directory with
 * `ports/index.ts` as the barrel. This interface was originally declared INLINE in the barrel while
 * `KeyProvider` and `IdempotencyStore` each got their own file. It now lives here and is re-exported from
 * the barrel, so all three follow the same rule. Recorded in `ASSUMPTIONS.md` §3.12.
 *
 * THE CONTRACT HAS THREE CLAUSES AND ALL THREE ARE LOAD-BEARING:
 *
 *  1. **Append, never update.** The sink exposes no mutation. VG-EVIDENCE-003 and SPEC-002 §2 make
 *     `audit_event` append-only *by construction* in the database (`CREATE RULE … DO INSTEAD NOTHING`
 *     for UPDATE and DELETE), so this interface must not offer what the schema forbids.
 *  2. **All-or-nothing with the state change.** `append` must run in the SAME transaction as the state
 *     change it records. SPEC-006 §7.1 row 11 is explicit that the alternative — "commit state and log
 *     later" — is forbidden: an un-audited transition is a transition the system cannot justify.
 *  3. **Failure abandons the operation.** When the append cannot be performed, the caller must abandon
 *     the operation (SPEC-006 §5.3 row 22, `AUDIT_UNAVAILABLE`), never proceed. That is why `append`
 *     rejects rather than resolving with a status: there is no "appended, but badly" outcome a caller
 *     could act on, and a boolean or a partial-write result would invite one.
 *
 * A batch is taken rather than a single event because one command may emit several events for one
 * transition, and appending them separately would allow a transition recorded by its first event and not
 * its second — an audit trail that contradicts itself.
 */

import type { AuditEvent } from '../entities.ts';

/** Append-only event sink (VG-EVIDENCE-003). */
export interface AuditSink {
  /**
   * Append every event, or append none.
   *
   * MUST reject on failure. MUST run inside the caller's transaction when one exists, so a rolled-back
   * state change leaves no audit row and a committed state change cannot lack one (SM-2).
   */
  append(events: readonly AuditEvent[]): Promise<void>;
}
