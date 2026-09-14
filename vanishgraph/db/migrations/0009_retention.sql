-- 0009 — retention windows as data, and erasure tombstones (SPEC-002 §5, RET-1…RET-3).
--
-- RET-1: retention windows are DATA resolved from jurisdiction_policy, never hard-coded
-- constants. So this migration adds the columns and NO statutory period is seeded here or
-- asserted anywhere: which period a jurisdiction requires is a counsel question, recorded as
-- LEGAL_REVIEW_REQUIRED. A migration that baked in "7 years" would be inventing law.
--
-- RET-3: deletion must reach BACKUPS. A restore that reintroduces erased PII is severity-1.
-- The tombstone table is what makes that detectable and fixable: erasure is recorded as a
-- durable fact that survives a restore of the data it refers to, so a restored database can be
-- re-swept before it serves traffic.
--
-- Additive only (MIG-3): new nullable columns and a new table.

-- Retention windows per data class, resolved from policy rows (RET-1).
--
-- Nullable on purpose. A NULL window means "this policy version does not state a period for
-- this class", which must stay distinguishable from a stated period. Defaulting to a number
-- here would silently invent a legal position, so nothing is defaulted and the resolver
-- refuses an unresolvable class at runtime instead.
ALTER TABLE jurisdiction_policy
  ADD COLUMN retention_days_customer_pii    integer,
  ADD COLUMN retention_days_high_risk_pii   integer,
  ADD COLUMN retention_days_identity_document integer,
  ADD COLUMN retention_days_telemetry       integer,
  ADD COLUMN retention_days_evidence        integer,
  ADD COLUMN retention_days_audit           integer;

-- A stated retention window must be a positive number of days, and IDENTITY_DOCUMENT has the
-- shortest viable life (SPEC-002 §5): a document window may not exceed the customer window.
ALTER TABLE jurisdiction_policy
  ADD CONSTRAINT jurisdiction_policy_retention_positive CHECK (
    (retention_days_customer_pii      IS NULL OR retention_days_customer_pii      > 0) AND
    (retention_days_high_risk_pii     IS NULL OR retention_days_high_risk_pii     > 0) AND
    (retention_days_identity_document IS NULL OR retention_days_identity_document > 0) AND
    (retention_days_telemetry         IS NULL OR retention_days_telemetry         > 0) AND
    (retention_days_evidence          IS NULL OR retention_days_evidence          > 0) AND
    (retention_days_audit             IS NULL OR retention_days_audit             > 0)
  );

ALTER TABLE jurisdiction_policy
  ADD CONSTRAINT jurisdiction_policy_identity_shortest CHECK (
    retention_days_identity_document IS NULL OR
    retention_days_customer_pii IS NULL OR
    retention_days_identity_document <= retention_days_customer_pii
  );

-- Erasure tombstone (RET-2, RET-3).
--
-- Append-only, like audit_event: a tombstone that could be deleted would defeat its own purpose,
-- since the one thing an erasure record must survive is an attempt to undo it.
--
-- `subject_id` is retained although the subject's PII is destroyed. That is deliberate and is
-- the point of crypto-shredding: the identifier of the erased subject is not itself PII
-- (SPEC-002 §5 lists OPAQUE_ID as "retained (not PII)"), and keeping it is what lets a later
-- restore be re-swept for exactly the subjects that were erased.
CREATE TABLE erasure_tombstone (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  subject_id        uuid NOT NULL,
  -- When erasure was performed. Distinct from created_at so a replayed/backfilled tombstone
  -- records the original act rather than the row insert.
  erased_at         timestamptz NOT NULL,
  -- Why, from policy data: the legal basis in force at erasure time (RET-1, RET-4).
  legal_basis       text NOT NULL,
  -- Which key versions were destroyed. A restore can compare these against surviving key
  -- material to find backups that still hold recoverable PII (RET-3).
  shredded_key_versions integer[] NOT NULL,
  -- How many rows of each encrypted relation were made unrecoverable. Counts, never content.
  shredded_counts   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- `cardinality`, NOT `array_length`. MEASURED: array_length(ARRAY[]::integer[], 1) returns
  -- NULL rather than 0, so `array_length(...) >= 1` evaluates to NULL — and a CHECK constraint
  -- PASSES on NULL. With array_length this constraint was vacuously satisfied and an EMPTY
  -- version list was accepted, letting a tombstone claim erasure while naming no destroyed key.
  -- Found by this milestone's own test, not by inspection. cardinality() returns 0 for an empty
  -- array, so the check actually fires.
  CONSTRAINT erasure_tombstone_key_versions_present CHECK (cardinality(shredded_key_versions) >= 1),
  -- One erasure per subject per tenant: erasure is idempotent, and a second tombstone would
  -- misrepresent how many times the data was destroyed.
  CONSTRAINT erasure_tombstone_subject_once UNIQUE (tenant_id, subject_id)
);

CREATE INDEX erasure_tombstone_tenant_idx ON erasure_tombstone (tenant_id, erased_at);

CREATE RULE erasure_tombstone_no_update AS ON UPDATE TO erasure_tombstone DO INSTEAD NOTHING;
CREATE RULE erasure_tombstone_no_delete AS ON DELETE TO erasure_tombstone DO INSTEAD NOTHING;

CREATE FUNCTION erasure_tombstone_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'erasure_tombstone is append-only: TRUNCATE is refused (RET-2)';
END;
$$;

CREATE TRIGGER erasure_tombstone_no_truncate BEFORE TRUNCATE ON erasure_tombstone
  FOR EACH STATEMENT EXECUTE FUNCTION erasure_tombstone_no_truncate();

-- Wrapped data-encryption keys, one row per (tenant, key version) (SPEC-002 §4).
--
-- The DEK itself is NEVER stored in plaintext here: `wrapped_dek` is the DEK encrypted under the
-- KEK, and the KEK lives only in the KMS. Crypto-shredding destroys this row, which makes every
-- ciphertext under that version unrecoverable without touching the rows that hold it — that is
-- exactly the RET-2 property, and it is why shredding is an operation on keys rather than a
-- mass row deletion.
--
-- No KMS credential is stored: SPEC-002 §4 states the application database is not a secret store.
CREATE TABLE tenant_key (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  key_version   integer NOT NULL CHECK (key_version >= 1),
  wrapped_dek   bytea NOT NULL,
  -- Names the KEK that wraps this DEK, so a KEK rotation is traceable (ADR-006 remains OPEN).
  kek_ref       text NOT NULL,
  -- Which provider wrapped it. A local file-backed provider is TESTS ONLY and must never be
  -- selected in production (VG-SCOPE-020).
  provider      text NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ROTATED','SHREDDED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  rotated_at    timestamptz,
  shredded_at   timestamptz,

  CONSTRAINT tenant_key_version_once UNIQUE (tenant_id, key_version),
  -- A shredded key has no wrapped material left to leak. The column is emptied, not merely
  -- flagged, so a bug that ignores `status` still cannot recover the DEK.
  CONSTRAINT tenant_key_shredded_is_empty CHECK (
    (status = 'SHREDDED' AND shredded_at IS NOT NULL AND octet_length(wrapped_dek) = 0) OR
    (status <> 'SHREDDED' AND shredded_at IS NULL AND octet_length(wrapped_dek) > 0)
  )
);

CREATE INDEX tenant_key_active_idx ON tenant_key (tenant_id, key_version)
  WHERE status = 'ACTIVE';

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: erasure_tombstone
ALTER TABLE erasure_tombstone ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_tombstone FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON erasure_tombstone
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: tenant_key
ALTER TABLE tenant_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_key FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_key
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END
