-- 0028 — the policy version LABEL the contract carries, and a place for an exemption evaluation.
--
-- 1. `policyVersion` IS A DATE STRING IN THE CONTRACT AND AN INTEGER IN THE SCHEMA. SPEC-003 §5.6.1's request
--    carries `"policyVersion": "2026-01-15"` and its response echoes it; §5.6.3 and §5.6.4 render it the same
--    way. `jurisdiction_policy.version` and `policy_decision.policy_version` are `integer` under
--    `UNIQUE (tenant_id, jurisdiction, version)`, and §5.6.1 takes the version as INPUT that must MATCH — so
--    either the contract's flow is unrepresentable, or a version has a LABEL alongside its ordinal.
--
--    `version_label` is that label, and it is the one the API uses on the wire. This is additive and it does not
--    change what `version` means: the integer stays the row's ordinal (its uniqueness key, its ordering, and what
--    `policy_decision.policy_version` references), while the label is the human-facing version identifier the
--    contract's bodies carry. A version with no label is one nobody has named yet, and §5.6.1 refuses to resolve
--    against it rather than guessing a date.
--
--    BACKFILL: every existing row gets its `effective_from` date, which is the only date the row carries and
--    which is exactly what a policy version label means. Recorded as a reading in `ASSUMPTIONS.md` §3.33 — a row
--    that had a different label in the outside world cannot be recovered from this schema, and inventing one
--    would be worse than deriving it from the row's own effective date.
--
-- 2. `policy_decision.version_label` is stored ON THE DECISION, not joined at read time: a decision records the
--    version it was resolved under, and a later edit to the policy row's label must not rewrite what the
--    decision says it resolved against. History that can be rewritten is not history.
--
-- 3. `policy_decision.exemption_evaluation` is where §5.6.1's `exemptionEvaluation` would live. NO specification
--    declares the check list — `{check: "PUBLIC_RECORD"|"FCRA", result: "NOT_EXEMPT"}` appears only inside the
--    contract's example body — so the API reports `evaluated: false` with an empty check list and does NOT
--    invent one; the column exists (nullable) so the node that owns the exemption logic has somewhere to write.

ALTER TABLE jurisdiction_policy
  ADD COLUMN version_label text;

UPDATE jurisdiction_policy
   SET version_label = to_char(effective_from, 'YYYY-MM-DD')
 WHERE version_label IS NULL;

ALTER TABLE jurisdiction_policy
  ADD CONSTRAINT jurisdiction_policy_version_label_shape
    CHECK (version_label IS NULL OR version_label ~ '^\d{4}-\d{2}-\d{2}$');

-- The label resolves to a version within one jurisdiction. NOT unique, and the resolution is deterministic:
-- §5.6.1's lookup takes the HIGHEST `version` for a label, so two rows sharing a label resolve to the newer one
-- rather than failing the query. A unique index would have been the tighter rule, but adding it to a table with
-- existing rows can fail the migration, and a migration that fails on real data is worse than a documented
-- resolution order.
CREATE INDEX jurisdiction_policy_label_idx ON jurisdiction_policy (tenant_id, jurisdiction, version_label);

ALTER TABLE policy_decision
  ADD COLUMN version_label text,
  ADD COLUMN exemption_evaluation jsonb;

UPDATE policy_decision d
   SET version_label = p.version_label
  FROM jurisdiction_policy p
 WHERE p.jurisdiction = d.jurisdiction AND p.version = d.policy_version AND d.version_label IS NULL;

ALTER TABLE policy_decision
  ADD CONSTRAINT policy_decision_version_label_shape
    CHECK (version_label IS NULL OR version_label ~ '^\d{4}-\d{2}-\d{2}$');

-- §5.6.2 lists a case's decisions newest-first with all versions retained.
CREATE INDEX policy_decision_case_decided_idx ON policy_decision (tenant_id, case_id, decided_at DESC);
