-- 0025 — the fields SPEC-003 §5.9 requires, and a CHECK that was vacuously satisfied.
--
-- 1. `controller_response.claimed_outcome_token`. §5.9.1's request and response carry
--    `claimedOutcome` ∈ `DELETED | NOT_DELETED | UNSPECIFIED`, and the delivered column is typed `truth_state` —
--    the enum of the eleven canonical states, NONE of which is any of those three tokens. The delivered column
--    also cannot be "fixed" by widening: a truth state in the claimed-outcome field is exactly the collapse
--    VG-VERIFY-004 forbids (a CLAIM is not an OBSERVATION), and its own comment says so ("claimed_outcome is a
--    CLAIM. Nothing in this schema may move a case to a [truth state]") while its TYPE is a truth state. So the
--    claim's vocabulary gets its own column, CHECKed to the three tokens the contract declares.
--
--    `claimed_outcome` (truth_state) is LEFT IN PLACE and is never populated by the API: it cannot hold any of
--    the three tokens, and writing a truth state there would assert the very thing the field must not assert.
--    A NULL there means "no truth state is claimed", which is the only honest value. Recorded in
--    `ASSUMPTIONS.md` §3.31.
--
-- 2. `evidence_artifact_id` and `refusal_basis`, both named by §5.9.1's request (and `refusalBasis` is required
--    for a REFUSAL, refused with `422 REFUSAL_BASIS_REQUIRED` when it is absent).
--
-- 3. `email_thread.body_ref` and `.subject_hash`, named by §5.9.3's request.
--
-- A CHECK I EXPECTED TO REPAIR AND DID NOT FIND: `email_thread.message_ids` was declared in 0004 as
-- `CHECK (array_length(message_ids, 1) >= 1)`, which is NULL — and therefore passing — for an empty array, the
-- vacuous-array class `ASSUMPTIONS.md` §3.6 records. Reading 0010 shows it was ALREADY repaired there
-- (`0010_repair_vacuous_array_checks.sql:37-39` drops it and adds `email_thread_message_ids_present` with
-- `cardinality()`), so this migration adds nothing for it. Recorded because the first draft of this file
-- asserted a fifth instance of that class without checking the repairs list — the rule being that a claimed
-- defect must be verified against the schema, not inferred from the original CREATE TABLE.

ALTER TABLE controller_response
  ADD COLUMN claimed_outcome_token text,
  ADD COLUMN evidence_artifact_id  uuid REFERENCES evidence_artifact(id),
  ADD COLUMN refusal_basis         text;

ALTER TABLE controller_response
  ADD CONSTRAINT controller_response_claimed_outcome_tokens
    CHECK (claimed_outcome_token IS NULL
           OR claimed_outcome_token IN ('DELETED', 'NOT_DELETED', 'UNSPECIFIED'));

-- A refusal must name its basis; the API refuses the request before this point, and the constraint states the
-- same rule where the row is written so a direct INSERT cannot produce a refusal nobody can explain.
ALTER TABLE controller_response
  ADD CONSTRAINT controller_response_refusal_basis
    CHECK (kind <> 'REFUSAL' OR (refusal_basis IS NOT NULL AND length(refusal_basis) > 0));

ALTER TABLE email_thread
  ADD COLUMN body_ref     text,
  ADD COLUMN subject_hash text;

-- §5.9.3 refuses a duplicate thread, and "duplicate" means one that shares a message id with an existing thread
-- for the case. `&&` is the array-overlap operator, so the lookup needs a GIN index to stay bounded. NOTE: this
-- index makes the LOOKUP fast; it cannot make the RULE atomic, because no unique constraint can express "no two
-- rows may share an array element". The check runs inside the caller's transaction, which is the strongest
-- guarantee the relational model offers for this shape — recorded rather than papered over.
CREATE INDEX email_thread_message_ids_idx ON email_thread USING gin (message_ids);

-- §5.9.2 lists a case's responses newest-first.
CREATE INDEX controller_response_case_received_idx ON controller_response (tenant_id, case_id, received_at DESC);
