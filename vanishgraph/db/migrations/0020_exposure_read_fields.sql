-- 0020 — the fields SPEC-003 §5.5 requires that the delivered tables do not carry.
--
-- THREE GAPS, each with a different kind of fix.
--
-- 1. §5.5.1 reports `firstObservedAt` and `lastObservedAt` for every exposure, and `exposure` records only
--    `created_at`. They are not the same fact: `created_at` is when the ROW was written, while the
--    observation instants are when the record was SEEN at the source, which is what the route's `observedAt`
--    sort and `from`/`to` filter are about. Backfilled from the source record's `observed_at`, because until
--    this migration the only observation instant an exposure had was the one its source record carries.
--
-- 2. §5.5.3 returns `policyThresholdApplied` and evaluates T3 against "`Confidence` ≥ policy threshold"
--    (SPEC-001:115, SPEC-000:102). NO specification gives that threshold a value or a home: it is policy
--    data, and `jurisdiction_policy` is where versioned policy data lives. The column is NULLABLE and has no
--    DEFAULT on purpose — a threshold this node invented would be a legal parameter of the product chosen by
--    an implementer. A policy version that records no threshold is one whose T3 cannot be evaluated, and the
--    route refuses rather than substituting a number (see `exposure-queries.ts`).

ALTER TABLE exposure
  ADD COLUMN first_observed_at timestamptz,
  ADD COLUMN last_observed_at  timestamptz;

-- THE BACKFILL HAS TO SET THE TENANT, AND THAT IS NOT A FORMALITY. `exposure` has FORCE ROW LEVEL SECURITY
-- (SPEC-002 RLS-2), which applies to the table OWNER as well — so a plain `UPDATE … FROM source_record` under
-- the migrator's role sees `tenant_id = current_setting('app.tenant_id', true)::uuid` evaluated against an
-- unset setting, which is NULL, which is not true, which means NO ROWS. MEASURED: the first version of this
-- migration did exactly that, the backfill silently updated nothing, and the `SET NOT NULL` below failed with
-- "column first_observed_at of relation exposure contains null values" — the failure that revealed it.
--
-- The loop runs the same statement once per tenant with `app.tenant_id` set transaction-locally. It is
-- deliberately NOT `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` followed by a restore: that would open a
-- window in which the table is unprotected, and it would leave a migration that depends on remembering to
-- put the policy back.
DO $$
DECLARE
  tenant_row uuid;
BEGIN
  FOR tenant_row IN SELECT id FROM tenant LOOP
    PERFORM set_config('app.tenant_id', tenant_row::text, true);
    UPDATE exposure e
       SET first_observed_at = sr.observed_at,
           last_observed_at  = sr.observed_at
      FROM source_record sr
     WHERE sr.id = e.source_record_id;
  END LOOP;
  -- The setting is transaction-local, so it must not outlive this block: a later statement in the same
  -- migration would otherwise run with the LAST tenant's scope and quietly see only that tenant's rows.
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- Not-null only AFTER the backfill. An exposure cannot exist without the source record that produced it
-- (`source_record_id` is NOT NULL with a foreign key), so every row has an observation instant and none is
-- left NULL by the statement above.
ALTER TABLE exposure
  ALTER COLUMN first_observed_at SET NOT NULL,
  ALTER COLUMN last_observed_at  SET NOT NULL;

-- lastObservedAt cannot precede firstObservedAt. Stated in the database because the two are written by the
-- same command and a swap would otherwise be storable and report an exposure observed before it existed.
ALTER TABLE exposure
  ADD CONSTRAINT exposure_observation_order
    CHECK (last_observed_at >= first_observed_at);

-- §5.5.1 sorts and time-filters on `observedAt`, which is the last observation instant.
CREATE INDEX exposure_tenant_last_observed_at_idx ON exposure (tenant_id, last_observed_at DESC);

ALTER TABLE jurisdiction_policy
  ADD COLUMN match_confidence_threshold numeric(3,2);

ALTER TABLE jurisdiction_policy
  ADD CONSTRAINT jurisdiction_policy_threshold_range
    CHECK (match_confidence_threshold IS NULL
           OR (match_confidence_threshold >= 0 AND match_confidence_threshold <= 1));
