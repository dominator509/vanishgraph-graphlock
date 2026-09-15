-- 0015 — the review state SPEC-003 §5.14 requires that SPEC-002 §2's DDL does not declare.
--
-- WHY THIS COLUMN EXISTS. SPEC-003 §5.14.1's success body is
--   {"appealEscalationId":…,"caseId":…,"kind":…,"requiresHumanReview":true,
--    "reviewState":"PENDING_COUNSEL_REVIEW","artifactIds":[…],"createdAt":…,"externalEffect":false}
-- and §5.14.2 is "list escalations WITH REVIEW STATE". The delivered `appeal_escalation` table has
-- `id, tenant_id, case_id, kind, requires_human_review, artifact_ids, created_at` — no review state.
-- As with §5.3 (migrations 0012–0014), a contract field with nowhere to live means the route either
-- silently drops it or reports a state it never stored. SPEC-003 §5.14.1 also says the API "records
-- `requiresHumanReview: true` and a `PENDING_COUNSEL_REVIEW` review state, and refuses to treat a
-- request as sendable while that state is pending", so the state is load-bearing for a refusal.
--
-- WHY THE CHECK PERMITS EXACTLY ONE VALUE, WHICH IS DELIBERATE AND NOT AN OVERSIGHT.
-- `PENDING_COUNSEL_REVIEW` is the ONLY review state any specification names: the token appears in
-- SPEC-003 §5.14.1 alone, and neither SPEC-001's `AppealEscalation` entity (`id, caseId, kind,
-- requiresHumanReview, artifactIds[]`) nor SPEC-002 mentions a review state at all. There is also no
-- /v1 route that changes it — counsel review is out-of-band by design (§10: no route by which a caller
-- or a model authors the reviewed content). So "the only state this system can record is pending" is
-- not a simplification; it is the current truth, and a CHECK that says so exactly:
--
--   * stops a later node from writing an unspecified state into a column that reports it to callers;
--   * makes the day a real counsel-review surface arrives a DELIBERATE migration that must name the new
--     tokens, rather than a silent INSERT that invents one;
--   * cannot over-constrain anything, because nothing can produce another value on this surface.
--
-- The alternative considered and rejected: no CHECK, or a CHECK over an invented set such as
-- `APPROVED`/`REJECTED`/`SENT`. Those would be this node inventing a review workflow, including its
-- outcome vocabulary, from a single example body.

ALTER TABLE appeal_escalation
  ADD COLUMN review_state text NOT NULL DEFAULT 'PENDING_COUNSEL_REVIEW';

ALTER TABLE appeal_escalation
  ADD CONSTRAINT appeal_escalation_review_state_closed
    CHECK (review_state = 'PENDING_COUNSEL_REVIEW');

COMMENT ON COLUMN appeal_escalation.review_state IS
  'Counsel-review state of this escalation. SPEC-003 §5.14.1 names exactly one value and no /v1 route '
  'changes it, so the CHECK admits exactly that value; a counsel-review surface must extend both.';
