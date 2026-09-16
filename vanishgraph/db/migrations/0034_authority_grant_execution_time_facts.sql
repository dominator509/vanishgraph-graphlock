-- 0034 — the three facts an authority grant's EXECUTION-TIME check reads and the table had nowhere to keep.
--
-- WHY THIS MIGRATION EXISTS, WITH THE MEASURED GAP. `verifyAtExecutionTime` (EP-006 M4) refuses a grant whose
-- `contestedAt` is set (VG-AUTHZ-012) or whose `coolingOffUntil` is still in the future (VG-AUTHZ-010), and
-- `mintGrant` requires a `noticeArtifactId` for every non-`SELF` kind (VG-AUTHZ-014 / VG-AUTH-032). None of those three
-- facts had a column: measured against the live schema at version 0033, `authority_grant` carried
-- (id, tenant_id, subject_id, kind, scope, evidence_id, issued_at, expires_at, revoked_at, signed_instrument,
-- created_at, identity_level, notice_sent_at) and nothing else. A durable adapter could therefore persist a grant and
-- read it back with `contestedAt = null` and `coolingOffUntil = null` — that is, a CONTESTED grant would pass the
-- execution-time check after a restart, and the control M10 exists to prove would be blind to the two facts it reads.
-- The adapter could not have been written honestly without these columns, so they are added here rather than
-- approximated by the adapter (a nullable column read as a fabricated instant is exactly the fabrication DOD-016
-- forbids).
--
-- ALL THREE ARE NULLABLE WITH NO DEFAULT, and that is the point rather than an oversight:
--   * `contested_at`   — NULL means "the subject has not contested this grant", which is the honest state of every
--                        grant that exists today. A default of `now()` would suspend every grant in the database.
--   * `cooling_off_until` — NULL means "no cooling-off period applies", which is true of every `SELF` grant: §3.1 puts
--                        the cooling-off period on AGENT enrollment. A default would invent a suspension window.
--   * `notice_artifact_id` — NULL means "no notice artefact was recorded", which is true of every `SELF` grant and,
--                        today, of every AGENT grant too: this repository has no notification transport, so §5.2.1's
--                        route refuses to mint an AGENT grant at all (503 DEPENDENCY_UNAVAILABLE) rather than create one
--                        whose required notice was never sent (0031's comment records the same reasoning for
--                        `notice_sent_at`).
--
-- THE FOREIGN KEY IS IMMEDIATE, NOT DEFERRED. `notice_artifact_id` references `evidence_artifact`, which does NOT
-- reference `authority_grant` (it references `request_case`, which does) — so unlike the four cycle-closing keys in
-- 0005 there is no ordering problem, and a notice artefact that does not exist must fail at the statement rather than
-- at COMMIT. `notice_sent_at` (0031) remains the separate fact of WHEN a notice was sent; this column records WHICH
-- artefact it was, and the two are allowed to disagree because the spec does not tie them.
--
-- NO CHECK TIES `contested_at` TO A NON-NULL COLUMN, and none ties the three together. The temptation is a CHECK
-- requiring `contested_at IS NULL OR kind = 'AGENT'`: §3.1's contest is an agent-grant mechanism (VG-AUTHZ-012), so such
-- a CHECK would look correct — and it would also make VG-AUTHZ-009's disputed-grant path unwritable for the
-- `PARENT_GUARDIAN` and `LEGAL_REPRESENTATIVE` kinds, which §3.1's dispute rules also reach. The schema records the
-- fact; which kinds may carry it is a policy question the specification answers in prose, and a constraint is the wrong
-- place to resolve prose (0031 recorded the same decision about `notice_sent_at`).
--
-- WHAT THIS MIGRATION DOES NOT DO: it does not backfill, it does not rewrite any existing row, and it adds no route.
-- The write path for `contested_at` is the adapter's `contest`, and no HTTP route reaches it yet.

ALTER TABLE authority_grant
  ADD COLUMN contested_at       timestamptz,
  ADD COLUMN cooling_off_until  timestamptz,
  ADD COLUMN notice_artifact_id uuid;

ALTER TABLE authority_grant
  ADD CONSTRAINT authority_grant_notice_artifact_fkey
    FOREIGN KEY (notice_artifact_id) REFERENCES evidence_artifact(id);

-- The same shape `expires_at > issued_at` already has: a suspension window that ends before the grant was issued is a
-- data error, not a policy choice. The CHECK says nothing about how long the window may be, because §3.1 does not.
ALTER TABLE authority_grant
  ADD CONSTRAINT authority_grant_cooling_off_after_issue
    CHECK (cooling_off_until IS NULL OR cooling_off_until > issued_at);

-- A revocation and a contest are both instants on the grant's own timeline, and neither may precede the issue.
ALTER TABLE authority_grant
  ADD CONSTRAINT authority_grant_contested_after_issue
    CHECK (contested_at IS NULL OR contested_at >= issued_at);

-- The suspension lookup VG-AUTHZ-012 implies: "which grants for this subject are currently suspended". Partial, because
-- the overwhelmingly common value is NULL and an index over it would be mostly dead weight.
CREATE INDEX authority_grant_contested_idx
  ON authority_grant (tenant_id, subject_id)
  WHERE contested_at IS NOT NULL;
