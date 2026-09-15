-- 0021 — give the observation instants a default, because a direct INSERT must still be possible.
--
-- WHAT WENT WRONG IN 0020. It added `first_observed_at` / `last_observed_at` as NOT NULL *without* a default,
-- which is a shape that forbids the very statement the project's own fixture uses: `db/seed/prior_release.sql`
-- inserts an exposure without naming them, and after 0020 that INSERT fails with a not-null violation on a
-- fresh provision. The live database did not reveal it because provisioning is idempotent and does not
-- re-seed a running container — the defect would have appeared on the next clean environment, which is the
-- worst place to find it.
--
-- The default is `now()`, which is the truth for a row inserted with no observation instant of its own: the
-- row was observed as of when it was written. It is NOT a substitute for the real value — the §5.5 assessment
-- path sets `last_observed_at` from the instant it recorded — and it is deliberately the same instant the
-- table's `created_at` already carries, so the two cannot disagree about a row that has no better information.

ALTER TABLE exposure
  ALTER COLUMN first_observed_at SET DEFAULT now(),
  ALTER COLUMN last_observed_at  SET DEFAULT now();
