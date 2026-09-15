-- 0019 — the transition spine: typed transition facts on `audit_event`.
--
-- THE CONFLICT THIS RESOLVES. SPEC-003 §5.5.5 requires, per transition, `transitionCode` (`T3`),
-- `fromTruthState`, `toTruthState`, `actorIdentity`, `command`, `evidenceArtifactIds[]` and
-- `correlationId`; §5.7.3's `lastTransition` and §5.7.6's `TRANSITION` timeline entries need the same
-- facts, and nine write bodies return `transitionId`/`transitionCode`. Four of those facts have no home:
--
--   * SPEC-001:96 gives `AuditEvent` exactly seven fields — `id, tenantId, actor, action, target, at,
--     correlationId` — so the transition CODE and the from/to truth states are not fields of the entity.
--   * SPEC-002:26-27 permits `jsonb` "only for recorded bases and provider payloads — never for values
--     needing integrity (state, authority, digests)". A transition's from/to truth states ARE state, so
--     `audit_event.payload` — where `.agent/execplans/EP-003-node.md:132` resolved the transition record
--     to live, and where its seed writes `'{"transitionId":"T5"}'` — is the one place SPEC-002 §1 rules
--     out.
--
-- WHY COLUMNS ON `audit_event` AND NOT A SEPARATE `transition` TABLE. EP-003's own decision is that
-- `audit_event` IS the append-only record of a transition ("SPEC-002 defines no separate transition table,
-- and `audit_event` is the append-only record of the T14 transition"). Adding columns keeps that decision
-- intact and buys three properties a second table would have to re-earn:
--
--   1. **Append-only by construction, already.** SPEC-002 §2 installs
--      `CREATE RULE audit_no_update/audit_no_delete … DO INSTEAD NOTHING`, so a transition fact written
--      here cannot be rewritten or erased by any role, including the owner. A new table would need its own
--      rules, and a mistake in them would be a mutable history of state changes.
--   2. **Atomic with the audit row.** SM-2 makes the audit row and the state change one commit. Keeping
--      the transition facts in that same row means there is no second write that can be lost, and no
--      ordering in which a transition exists without the audit record that justifies it.
--   3. **Isolated already.** The row carries `tenant_id` under FORCE RLS with the generated
--      `tenant_isolation` policy, so no new entry in `db/tenant-scoped-tables.txt` and no new policy that
--      could silently miss isolation (SPEC-002 RLS-1/RLS-2).
--
-- The types do the integrity work: from/to are the `truth_state` enum of exactly the eleven SPEC-000 §5
-- values (SPEC-002 §1 requires exactly that), so a value outside the closed set cannot be stored and needs
-- no application check. `evidence_artifact_ids` is `uuid[]` rather than `text[]` so a fabricated id cannot
-- enter a column whose whole purpose is to name evidence that exists.

ALTER TABLE audit_event
  ADD COLUMN transition_code     text,
  ADD COLUMN from_truth_state    truth_state,
  ADD COLUMN to_truth_state      truth_state,
  ADD COLUMN evidence_artifact_ids uuid[],
  ADD COLUMN case_id             uuid REFERENCES request_case(id);

-- `case_id` NAMES THE CASE A TRANSITION BELONGS TO, which is not always the resource the command acted on.
-- The seed (`db/seed/prior_release.sql:57`) shows the convention for `target_kind`/`target_id`: T5 is
-- recorded against `RequestCase`, T8 against `ExternalAction`, a registration against `ProtectedSubject`.
-- That is the honest record of WHAT WAS ACTED ON, and it is deliberately left alone. But §5.7.3's
-- `lastTransition` and §5.7.6's timeline are reads of a CASE, and a T8 whose target is an external action
-- would be missing from them if the only way to find a case's transitions were `target_kind = 'RequestCase'`.
-- So the case is recorded separately, as a typed FK, and every read of a case's history is exact rather than
-- a scan over targets that happen to name it. T1/T2/T3/T4 have no case yet — a case is created at the
-- exposure's current truth state (§5.7.1), which is `MATCH_CONFIRMED` after T3 — so this column is nullable
-- and NULL there is the fact, not a gap.

-- The code is SPEC-001 §4.1's row label. The pattern admits exactly T1–T21: a reader may check legality
-- against the table without inference (§5.5.5), and that only holds if the column cannot hold `T22`.
ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_transition_code_shape
    CHECK (transition_code IS NULL OR transition_code ~ '^T([1-9]|1[0-9]|2[01])$');

-- COMPLETE OR ABSENT. A row either records no transition facts at all (an audit row that is not a state
-- change — the append path writes those too) or it records a code and the state it moved INTO. The
-- from-state may be NULL for T1/T2, which are initial states rather than transitions, so it is deliberately
-- not required: `from_truth_state IS NULL` means "this was the first state", and that is a fact, not a gap.
ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_transition_complete
    CHECK (
      (transition_code IS NULL AND from_truth_state IS NULL
        AND to_truth_state IS NULL AND evidence_artifact_ids IS NULL AND case_id IS NULL)
      OR (transition_code IS NOT NULL AND to_truth_state IS NOT NULL)
    );

-- An empty array is not "no evidence": it would satisfy NOT NULL while naming nothing, which is exactly
-- the vacuous-array defect `ASSUMPTIONS.md` §3.6 records four earlier constraints committing. NULL means
-- not recorded; `cardinality() >= 1` means recorded. (`array_length(col, 1) >= 1` is NULL for an empty
-- array and would let it through — that is why this uses `cardinality`.)
ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_transition_evidence_nonempty
    CHECK (evidence_artifact_ids IS NULL OR cardinality(evidence_artifact_ids) >= 1);

-- Per-resource history reads (§5.5.5 by exposure, §5.7.6's timeline by case) scan one target in time
-- order. 0017 added `(tenant_id, at DESC)` for the tenant-wide §5.15 list; these are the narrower ones.
CREATE INDEX audit_event_target_at_idx ON audit_event (tenant_id, target_kind, target_id, at);
CREATE INDEX audit_event_case_at_idx ON audit_event (tenant_id, case_id, at) WHERE case_id IS NOT NULL;
