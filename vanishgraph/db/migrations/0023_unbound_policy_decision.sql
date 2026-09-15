-- 0023 — `policy_decision.case_id` becomes NULLABLE, because SPEC-003 §5.7.1 requires a decision before its case.
--
-- THE CONFLICT. §5.7.1's request body is
-- `{"subjectId", "exposureId", "sourceId", "authorityGrantId", "policyDecisionId", "recipeId"}` — it CREATES the
-- case and names the decision that authorises it — and its refusal list includes
-- `422 POLICY_DECISION_INCOMPLETE (missing any of VG-POLICY-002's four fields)`. SPEC-002 §2 declares
-- `policy_decision.case_id uuid NOT NULL REFERENCES request_case(id)`, so under the delivered schema EVERY
-- decision already belongs to a case, and a decision offered at case creation can only belong to a case that
-- does not exist yet. The two cannot both be satisfied: either §5.7.1 cannot be implemented, or a decision may
-- exist before its case does.
--
-- WHICH SIDE MOVES, AND WHY IT IS THIS ONE. Widening a NOT NULL does not change the meaning of any stored value:
-- a decision with `case_id IS NULL` is simply one that has been resolved and not yet bound, and `createCase`
-- binds it in the same transaction that creates the case (asserted by `tests/db/case-lifecycle.test.ts`). The
-- alternative — making §5.7.1 accept a decision that belongs to a DIFFERENT case — would put a decision and a
-- case together that the policy engine never resolved as a pair, which is exactly the association
-- VG-POLICY-001/002 exist to keep truthful. Recorded in `ASSUMPTIONS.md` §3.29 with both citations.
--
-- The DEFERRABLE foreign key on `request_case.policy_decision_id` (0004) already allows the two rows to be
-- written in either order inside one transaction, so nothing else has to change.

ALTER TABLE policy_decision
  ALTER COLUMN case_id DROP NOT NULL;

-- A decision that HAS a case must still name a real one; the constraint is dropped and recreated because
-- PostgreSQL has no "ALTER CONSTRAINT" for a foreign key's nullability, and NOT NULL was the only thing that
-- made the reference total.
ALTER TABLE policy_decision
  DROP CONSTRAINT policy_decision_case_id_fkey;
ALTER TABLE policy_decision
  ADD CONSTRAINT policy_decision_case_id_fkey
    FOREIGN KEY (case_id) REFERENCES request_case(id) DEFERRABLE INITIALLY DEFERRED;

-- §5.6.2 lists a case's decisions newest-first, and §5.7.1 looks up an UNBOUND decision by id. The index serves
-- both: the bound side for the list, the partial side for the binding lookup.
CREATE INDEX policy_decision_case_decided_at_idx ON policy_decision (tenant_id, case_id, decided_at DESC);
CREATE INDEX policy_decision_unbound_idx ON policy_decision (tenant_id) WHERE case_id IS NULL;
