-- 0018 — the fields SPEC-003 §5.10.3 and §5.11 require that the delivered tables do not carry.
--
-- WHY THESE EXIST. §5.10.3 returns "the observation plus
-- `independence: {"actingPathId":"path_01","observationPathId":"path_02","distinct":true,"actorDistinct":true}`",
-- and §5.10.1's request supplies `observationPathId` and `actingPathId`. The delivered
-- `verification_observation` table has `actor_identity` and `acting_identity` only, so the PATHS the
-- independence attestation is about have nowhere to live — and independence of the observing path is the
-- rule that stops removal theater (VG-VERIFY-001), so an attestation that cannot name the two paths is an
-- assertion rather than a fact. §5.11.1's request also supplies `observationMethod`, which
-- `reappearance` has no column for.

ALTER TABLE verification_observation
  ADD COLUMN acting_path_id      text,
  ADD COLUMN observation_path_id text;

-- VG-VERIFY-001: the observing path must DIFFER from the acting path. The table already carries
-- `CHECK (actor_identity <> acting_identity)` for the identities, and this is the same rule for the paths —
-- stated in the database so a row attesting an observation made along the acting path cannot be stored.
-- Nullable, because a row written before this migration recorded no paths: NULL means "not recorded", and
-- the read model reports `distinct: false` for it rather than claiming an independence nobody attested.
ALTER TABLE verification_observation
  ADD CONSTRAINT verification_observation_paths_differ
    CHECK (
      acting_path_id IS NULL
      OR observation_path_id IS NULL
      OR acting_path_id <> observation_path_id
    );

-- The method the re-observation used. No specification enumerates a vocabulary for this field (the §5.11.1
-- example's `SCHEDULED_RE_OBSERVATION` is the only token anywhere), so it is stored as bounded text rather
-- than behind a CHECK built from a single example — building the CHECK from one example is what
-- `ASSUMPTIONS.md` §3.25 records as a reading for `audit_event.actor_kind`, and here the field's VALUE is
-- not reported in a refusal, so a widish column is the smaller commitment.
ALTER TABLE reappearance
  ADD COLUMN observation_method text;

ALTER TABLE reappearance
  ADD CONSTRAINT reappearance_observation_method_bounded
    CHECK (observation_method IS NULL OR (length(observation_method) BETWEEN 1 AND 120));

-- A tenant-wide reappearance list (§5.11.2) filters and sorts on `observed_at`, so the index is what makes
-- that scan bounded rather than sequential.
CREATE INDEX reappearance_tenant_observed_at_idx ON reappearance (tenant_id, observed_at DESC);
