-- 0017 — the five fields SPEC-003 §5.15.1 reports that SPEC-001's `AuditEvent` does not have.
--
-- WHY THESE EXIST. SPEC-001:96 defines `AuditEvent` as `id, tenantId, actor, action, target, at,
-- correlationId`, and §5.15.1's success body reports those seven PLUS:
--
--   {"actor":{"kind":"HUMAN|SERVICE|SYSTEM","actorId":"…"}, …,"requestId":"…",
--    "outcome":"SUCCEEDED|REFUSED","refusalCode":null,"traceparent":"…"}
--
-- so `actor.kind`, `requestId`, `outcome`, `refusalCode` and `traceparent` have nowhere to live.
--
-- WHY THE DOMAIN ENTITY IS NOT THE PLACE FOR THEM. Three of the five are TRANSPORT facts about the request
-- that produced the event — `requestId` is the correlation plugin's identifier for it, `traceparent` is the
-- W3C trace context, and `refusalCode` names how the request was refused — and they are known to the APPEND
-- path, not to the domain's reasoning. Adding them to `AuditEvent` would put HTTP transport metadata inside
-- the entity whose value is that it is pure, and would require the domain to carry a trace context it has no
-- use for. So the entity keeps SPEC-001's seven fields and the append path supplies the rest.
--
-- `actor_kind` AND `outcome` ARE THE TWO THAT ARE NOT PURELY TRANSPORT, and they are still recorded here
-- rather than in the entity, for a stated reason: `actor_kind`'s vocabulary (`HUMAN|SERVICE|SYSTEM`) appears
-- in NO normative table anywhere — only inside §5.15.1's example body — so extending the domain entity with
-- it would be this node inventing a domain attribute from one example. `outcome` DOES have a normative
-- source (SPEC-007 §285: `SUCCEEDED`, `REFUSED`, `FAILED`, `AMBIGUOUS`, `GATED`), and its five tokens are
-- admitted below rather than §5.15.1's two, because the narrower example is a subset and a CHECK built from
-- it would reject the three values SPEC-007 defines. Both are recorded in ASSUMPTIONS.md §3.25.

-- Every append today comes from a domain command, whose actor is the constant `domain-command` — a SERVICE
-- actor. The default states that truth rather than guessing at it, and the append path can override it.
ALTER TABLE audit_event
  ADD COLUMN actor_kind text NOT NULL DEFAULT 'SERVICE';

ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_actor_kind_closed
    CHECK (actor_kind IN ('HUMAN', 'SERVICE', 'SYSTEM'));

-- SPEC-007 §285's enum, all five tokens. `NOT NULL DEFAULT 'SUCCEEDED'` because §5.15.1 reports an outcome
-- for every event: a NULL would make the DTO unable to answer for rows that exist, and every event the
-- system writes today is the record of a command that returned.
ALTER TABLE audit_event
  ADD COLUMN outcome text NOT NULL DEFAULT 'SUCCEEDED';

ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_outcome_closed
    CHECK (outcome IN ('SUCCEEDED', 'REFUSED', 'FAILED', 'AMBIGUOUS', 'GATED'));

-- The request that produced the event. Nullable: an event appended by a job or a migration has no HTTP
-- request behind it, and a fabricated id would be worse than an admitted absence.
ALTER TABLE audit_event
  ADD COLUMN request_id uuid;

ALTER TABLE audit_event
  ADD COLUMN refusal_code text;

-- The W3C trace context, constrained to its actual shape (`version-traceid-spanid-flags`, lowercase hex).
-- A CHECK rather than free text because the column's only purpose is to join an audit row to a trace, and a
-- malformed value joins to nothing while looking as though it should.
ALTER TABLE audit_event
  ADD COLUMN traceparent text;

ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_traceparent_shape
    CHECK (traceparent IS NULL OR traceparent ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');

-- 90 days is SPEC-003 §5.15.1's maximum audit scan span. It is enforced at the query layer (see
-- `maxSpanDays` in `src/http/query/strict.ts`) rather than here, because a span is a property of a REQUEST
-- and not of a row; this index is what makes a bounded scan cheap, which is the reason the bound exists.
CREATE INDEX audit_event_tenant_at_idx ON audit_event (tenant_id, at DESC);
