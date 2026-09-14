-- 0010 — repair CHECK constraints that were vacuously satisfied on an empty array.
--
-- THE DEFECT. Four constraints written as `array_length(col, 1) >= 1` did not do what they said.
-- MEASURED in this repository's own PostgreSQL:
--
--     SELECT array_length(ARRAY[]::integer[], 1);          -- NULL, not 0
--     SELECT array_length(ARRAY[]::integer[], 1) >= 1;     -- NULL, not false
--
-- A CHECK constraint PASSES when its expression is NULL. So every one of those constraints
-- accepted an EMPTY array, which is precisely the case it existed to forbid. Proven by inserting
-- into the live database: `jurisdiction_policy.rules = ARRAY[]` and
-- `authority_grant.scope = ARRAY[]` were both ACCEPTED.
--
--     jurisdiction_policy.rules  (0004)  VG-POLICY-001  an incomplete policy decision
--     authority_grant.scope      (0002)  VG-AUTHZ-001   a grant with no scope authorises nothing
--     email_thread.message_ids   (0005)
--     erasure_tombstone.shredded_key_versions (0009, fixed there before it was committed)
--
-- `cardinality()` returns 0 for an empty array and is the correct function.
--
-- NOT affected: `jsonb_array_length` is safe — it returns 0 for `[]`, so
-- `exposure.exposure_confidence_basis_check` genuinely fires. Verified, not assumed, because
-- assuming it would have meant "fixing" a constraint that was already correct.
--
-- WHY A NEW MIGRATION. 0002, 0004 and 0005 are committed and each carries a recorded checksum in
-- `schema_migration`; editing them in place would make every existing database report drift
-- (MIG-5) and would rewrite history. A repair is therefore additive (MIG-3).

ALTER TABLE jurisdiction_policy DROP CONSTRAINT IF EXISTS jurisdiction_policy_rules_check;
ALTER TABLE jurisdiction_policy
  ADD CONSTRAINT jurisdiction_policy_rules_present CHECK (cardinality(rules) >= 1);

ALTER TABLE authority_grant DROP CONSTRAINT IF EXISTS authority_grant_scope_check;
ALTER TABLE authority_grant
  ADD CONSTRAINT authority_grant_scope_present CHECK (cardinality(scope) >= 1);

ALTER TABLE email_thread DROP CONSTRAINT IF EXISTS email_thread_message_ids_check;
ALTER TABLE email_thread
  ADD CONSTRAINT email_thread_message_ids_present CHECK (cardinality(message_ids) >= 1);

-- erasure_tombstone was created in 0009 with the correct function; re-assert it defensively so a
-- database that applied an early 0009 draft is brought to the same state.
ALTER TABLE erasure_tombstone DROP CONSTRAINT IF EXISTS erasure_tombstone_key_versions_present;
ALTER TABLE erasure_tombstone
  ADD CONSTRAINT erasure_tombstone_key_versions_present CHECK (cardinality(shredded_key_versions) >= 1);

-- Verify the repair took effect rather than assuming it. This runs against the real constraints
-- in the real database, not against the migration's own source text.
DO $$
DECLARE
  still_vacuous text;
  installed     integer;
BEGIN
  SELECT string_agg(format('%I.%I', conrelid::regclass, conname), ', ')
    INTO still_vacuous
    FROM pg_constraint
   WHERE pg_get_constraintdef(oid) LIKE '%array_length%'
     AND conrelid::regclass::text IN ('jurisdiction_policy', 'authority_grant', 'email_thread', 'erasure_tombstone');

  IF still_vacuous IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0010 left a vacuous array_length check in place: %', still_vacuous;
  END IF;

  SELECT count(*) INTO installed
    FROM pg_constraint
   WHERE conname IN (
           'jurisdiction_policy_rules_present',
           'authority_grant_scope_present',
           'email_thread_message_ids_present',
           'erasure_tombstone_key_versions_present'
         );

  IF installed <> 4 THEN
    RAISE EXCEPTION 'migration 0010 installed % of 4 repaired constraints', installed;
  END IF;

  -- Prove the repaired constraint actually refuses an empty array. The insert is expected to fail
  -- on the CHECK. FORCE RLS is active on jurisdiction_policy, so the tenant must be set or the
  -- insert fails on the policy instead of reaching the check — which would make this probe pass
  -- for the wrong reason. The two failures are therefore distinguished, not swallowed together.
  BEGIN
    PERFORM set_config('app.tenant_id', '00000000-0000-4000-8000-000000000000', true);
    INSERT INTO jurisdiction_policy
      (tenant_id, jurisdiction, version, effective_from, rules, provenance)
    VALUES
      ('00000000-0000-4000-8000-000000000000', 'ZZ-CHECK', 1, now(), ARRAY[]::text[], 'COUNSEL_REVIEWED');
    RAISE EXCEPTION 'the repaired rules constraint still accepts an empty array';
  EXCEPTION
    WHEN check_violation THEN NULL;
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'the empty-array probe was refused by row-level security before reaching the check constraint; the check was not exercised';
  END;
END;
$$;
