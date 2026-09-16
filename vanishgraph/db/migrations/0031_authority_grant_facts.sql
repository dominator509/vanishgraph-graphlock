-- 0031 — the two authority-grant facts §5.2.1's own request and response carry and the table had nowhere to keep.
--
-- 1. `identityLevel` IS IN THE REQUEST *AND* THE RESPONSE. §5.2.1 takes `"identityLevel": "IAL2"` (a SPEC-005 §4
--    token), and its success body returns it. `authority_grant` had no column for it, so the route would have had to
--    drop a field it had just validated — a caller would read back a grant whose recorded verification level is
--    simply absent. The column records what the REQUEST asserted, which is exactly what the response echoes; whether
--    that level was true of the data subject is not something this table can know and is not what the field means.
--
--    NULLABLE, because every grant created before this migration (and every SELF grant created by §5.1.1, whose
--    request carries no such field) genuinely has no recorded level. Defaulting to a token would fabricate a
--    verification.
--
-- 2. `noticeSentAt` IS REQUIRED NON-NULL FOR `AGENT` GRANTS BY §5.2.1's OWN TEXT ("`noticeSentAt` is required
--    non-null for `AGENT` grants: SPEC-005 `VG-AUTHZ-014` requires notice to the subject's verified contact channel
--    on agent enrollment, so a grant with no recorded notice fails acceptance"). The column exists so the fact has
--    somewhere to live, and it is NULLABLE because THIS REPOSITORY HAS NO NOTIFICATION TRANSPORT: §5.2.1's route
--    refuses to mint an `AGENT` grant at all (`503 DEPENDENCY_UNAVAILABLE` naming the missing transport) rather than
--    create one whose required notice was never sent, so no row here can carry a false instant.
--
--    DELIBERATELY NO CHECK TYING `AGENT` TO A NON-NULL `notice_sent_at`. Such a CHECK would be the correct
--    long-term rule, and it would also make §5.1.1's AGENT path unwritable — that route's own contract does not
--    require a notice, and its test creates an AGENT grant. The inconsistency is between the TWO contract sections,
--    not something a constraint should silently resolve; it is recorded in ASSUMPTIONS §3.36 and left visible.

ALTER TABLE authority_grant
  ADD COLUMN identity_level text,
  ADD COLUMN notice_sent_at timestamptz;

ALTER TABLE authority_grant
  ADD CONSTRAINT authority_grant_identity_level_shape
    CHECK (identity_level IS NULL OR identity_level IN ('IAL0', 'IAL1', 'IAL2', 'IAL3'));

-- §5.2.2 lists a subject's grants newest-first, which is the read this index serves.
CREATE INDEX authority_grant_subject_issued_idx ON authority_grant (tenant_id, subject_id, issued_at DESC);
