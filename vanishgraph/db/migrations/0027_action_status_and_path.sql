-- 0027 — the two §5.8 fields that are a value the delivered CHECK cannot hold and an identity nothing records.
--
-- 1. `external_action.status` COULD NOT STORE `FAILED`. §5.8.3's reconciliation response reports
--    `actionOutcome: "FAILED"` when a reconciliation finds the effect ABSENT (`finding: "EFFECT_ABSENT"`), and
--    the delivered CHECK admits only `PREPARED | SUBMITTED | AMBIGUOUS | REFUSED`. This is the class
--    `ASSUMPTIONS.md` §3.19-bis lists: a CHECK that cannot hold a value the contract produces. `FAILED` is
--    WIDENED IN alongside the delivered tokens rather than replacing any of them, because a row written under
--    the old vocabulary must stay writable-by-repair and its meaning must not change.
--
-- 2. `external_action.acting_path_id` — the identity §5.8.4's independence rule is about. §5.8.4 refuses "an
--    observation path that is the same path or identity as the acting path" with
--    `422 OBSERVATION_PATH_NOT_INDEPENDENT` (VG-ACTION-003), and NOTHING recorded which path acted: the request
--    carries only `observationMethod`, so without this column the rule has nothing to compare against and the
--    API would either refuse every readback or accept every one while claiming an independence it never checked.
--    NULLABLE, because every action written before this migration recorded no path — and NULL means "not
--    recorded", which the port reports honestly rather than treating as independence.

ALTER TABLE external_action
  DROP CONSTRAINT external_action_status_check;
ALTER TABLE external_action
  ADD CONSTRAINT external_action_status_check
    CHECK (status IN ('PREPARED','SUBMITTED','AMBIGUOUS','REFUSED','FAILED'));

ALTER TABLE external_action
  ADD COLUMN acting_path_id text;

-- §5.8.3 looks an ambiguous action up by id and §5.8.5 reads the latest reconciliation for one.
CREATE INDEX external_action_ambiguous_idx
  ON external_action (tenant_id, case_id, created_at DESC)
  WHERE ambiguous;
