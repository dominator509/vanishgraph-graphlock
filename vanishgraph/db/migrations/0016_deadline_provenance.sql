-- 0016 — the three §5.13 fields SPEC-002's `deadline` table does not declare.
--
-- WHY THESE EXIST. SPEC-003 §5.13.2 accepts `source` and `evidenceArtifactId`; §5.13.3 accepts
-- `satisfiedBy` and `evidenceArtifactId`; §5.13.1 reports `derivedFrom{policyVersion, ruleCode}` and
-- `state`. The delivered `deadline` table is
--   id, tenant_id, case_id, kind, due_at, derivation_ref, satisfied_at, created_at
-- so the reviewable facts (which out-of-band input produced the date, who satisfied it, which artifact
-- evidences it) have nowhere to live, and a route would have to discard them silently. As with §5.3
-- (0012–0014) and §5.14 (0015), each column below is NAMED BY A SPECIFICATION SENTENCE.

-- §5.13.2's `source`. NOT NAMED `source`, DELIBERATELY.
--
-- SPEC-001 §3.4 gives `Deadline` a field called `source`, and EP-003's column-mapping table
-- (`.agent/execplans/EP-003-node.md:130`) resolves it to `derivation_ref` with the note: "`source` would
-- read as a `Source` reference; the field means 'the policy version this deadline derives from'". A second
-- column called `source` in the same table would therefore give one word two meanings, one of them
-- already spoken for. §5.13.2's `source` is a different fact — the out-of-band INPUT the date came from —
-- so it gets a name that says so.
--
-- THE CHECK ADMITS EXACTLY ONE VALUE, for the same reason 0015's review-state CHECK does:
-- `CONTROLLER_STATED_DATE` is the only token any specification names (§5.13.2's request example), and no
-- other document defines a vocabulary for this field. NULL means "no out-of-band input"; the alternative,
-- a NOT NULL column, would require inventing a token for every policy-derived deadline.
ALTER TABLE deadline
  ADD COLUMN derivation_input text;

ALTER TABLE deadline
  ADD CONSTRAINT deadline_derivation_input_closed
    CHECK (derivation_input IS NULL OR derivation_input = 'CONTROLLER_STATED_DATE');

-- §5.13.3's `satisfiedBy`. Nullable because an unsatisfied deadline has no satisfier, and NOT defaulted to
-- a sentinel: a placeholder actor would make "who satisfied this" unanswerable for exactly the rows that
-- answer it.
ALTER TABLE deadline
  ADD COLUMN satisfied_by text;

-- §5.13.2's and §5.13.3's `evidenceArtifactId`. A real FK, because both routes must raise
-- `422 EVIDENCE_NOT_FOUND` for a reference that does not resolve — and a foreign key is what makes that
-- checkable at the database rather than trusted from a route that already forgot once. Nullable: a
-- deadline recorded without an artifact is legal (neither route's error list makes the field mandatory),
-- and `ON DELETE RESTRICT` is the default, so an artifact cited by a deadline cannot be removed from under
-- it.
ALTER TABLE deadline
  ADD COLUMN evidence_artifact_id uuid REFERENCES evidence_artifact(id);

-- WHY THERE IS NO `state` COLUMN. §5.13.1's `state` is `OPEN|SATISFIED|BREACHED|WAIVED`, and three of the
-- four are DERIVABLE from data this table already has: `satisfied_at IS NOT NULL` ⇒ SATISFIED;
-- otherwise `due_at < now()` ⇒ BREACHED; otherwise OPEN. A stored copy would be a second source of truth
-- for a value that changes with the clock — it would go wrong without anyone writing to it, which is the
-- worst property a denormalisation can have.
--
-- WAIVED is the exception, and it is UNREACHABLE rather than unsupported: no /v1 route waives a deadline
-- (§5.13 has three routes and none of them does), and no specification defines a waiver record. So the
-- response type admits the token and the API can never produce it — recorded in ASSUMPTIONS.md §3.23
-- rather than papered over with a column nothing writes.
