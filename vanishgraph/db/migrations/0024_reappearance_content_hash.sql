-- 0024 — `reappearance.content_hash`, the one field SPEC-003 §5.11.1 requires that the table has no column for.
--
-- §5.11.1's request is `{"priorRemovedEventId", "observedAt", "observationMethod", "contentHash",
-- "evidenceArtifactId"}` and the delivery has no column for `contentHash`. The value matters: it is the digest of
-- the content that was observed AGAIN, which is what lets a later reader confirm that the reappearance is the
-- same record coming back rather than a different record at the same URL — the distinction VG-REAPPEAR-002 is
-- about. The same shape and CHECK as `source_record.content_hash` (0003:47), so the two digests cannot be
-- spelled differently.
--
-- NULLABLE, because rows written before this migration recorded no digest and NULL states that rather than
-- inventing one. The write route (§5.11.1) requires it, so every row written from now on carries it.

ALTER TABLE reappearance
  ADD COLUMN content_hash char(64);

ALTER TABLE reappearance
  ADD CONSTRAINT reappearance_content_hash_shape
    CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');

-- The route's own lookup: "the prior removal event, for this exposure" resolves `prior_removed_event_id` and
-- checks that the audit row recorded the state being reappeared from.
CREATE INDEX reappearance_prior_event_idx ON reappearance (tenant_id, prior_removed_event_id);
