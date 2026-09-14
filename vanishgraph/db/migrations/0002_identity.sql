-- 0002 — identity aggregate (SPEC-001 §3.1, SPEC-002 §2).
--
-- VG-IDENT-001: a ProtectedSubject cannot exist without a valid AuthorityGrant. A plain FK
-- cannot express "at least one row elsewhere", so a deferred constraint trigger enforces it
-- at commit time, which is what makes the rule true even when the subject and the grant are
-- inserted in the same transaction.
--
-- authority_grant.evidence_id is created without its foreign key: evidence_artifact is
-- created in 0005 and references request_case, which references authority_grant. The cycle is
-- closed in 0005 with DEFERRABLE INITIALLY DEFERRED foreign keys.

CREATE TABLE protected_subject (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  display_ref   text NOT NULL,              -- opaque label, never a raw name
  jurisdiction  text NOT NULL,              -- ISO 3166-2
  is_minor      boolean NOT NULL DEFAULT false,
  status        text NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED','ERASED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE authority_grant (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  subject_id        uuid NOT NULL REFERENCES protected_subject(id),
  kind              authority_kind NOT NULL,
  scope             text[] NOT NULL CHECK (array_length(scope,1) >= 1),
  evidence_id       uuid,                    -- FK added in 0005 (cycle)
  issued_at         timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  signed_instrument boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at),
  -- VG-AUTHZ-002 / VG-DATA-006
  CHECK (kind <> 'AGENT' OR (signed_instrument AND evidence_id IS NOT NULL))
);

CREATE TABLE alias (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  subject_id   uuid REFERENCES protected_subject(id),   -- NULL => quarantined
  value_enc    bytea NOT NULL,
  value_hmac   bytea NOT NULL,        -- equality lookup without decrypting
  provenance   text NOT NULL,
  method       text NOT NULL,
  quarantined  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- VG-IDENT-002 / VG-DATA-012
  CHECK (quarantined = (subject_id IS NULL)),
  UNIQUE (tenant_id, value_hmac, subject_id)
);

-- SPEC-002 §1: raw PII lives only in identifier/alias (encrypted columns) and
-- evidence_artifact (encrypted object storage). key_version makes rotation possible without
-- rewriting history (SPEC-002 §4). No cryptographic operation is implemented in this node.
CREATE TABLE identifier (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  subject_id  uuid NOT NULL REFERENCES protected_subject(id),
  kind        text NOT NULL,
  value_enc   bytea NOT NULL,
  value_hmac  bytea NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  provenance  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- SPEC-001 §3.1 names these fields `from`/`to`; `from` is a reserved SQL keyword, so the
-- columns are effective_from/effective_to (recorded in the EP-003 §4 deviation table).
CREATE TABLE location_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  subject_id     uuid NOT NULL REFERENCES protected_subject(id),
  jurisdiction   text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  provenance     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- VG-DATA-005: a subject cannot exist without valid authority, enforced at commit.
--
-- TENANT SCOPE, and why this is not a plain SELECT.
--
-- This is a DEFERRED constraint trigger: it fires at COMMIT, by which point the transaction's
-- `app.tenant_id` reflects only the LAST value the transaction happened to set. A multi-tenant
-- transaction (load a subject for tenant A, then switch to tenant B, then commit) therefore
-- validates tenant A's subject while the session is pointed at tenant B — and under FORCE RLS
-- the grant row is invisible, so a perfectly valid subject is rejected. That was observed
-- directly: the prior-release seed failed with
--   "ProtectedSubject ... requires a valid AuthorityGrant at commit (VG-IDENT-001)"
-- even though the grant was inserted in the same transaction.
--
-- The fix is to scope the lookup to the SUBJECT'S OWN tenant rather than the session's, by
-- setting app.tenant_id to NEW.tenant_id for the duration of this check and restoring the
-- previous setting afterwards. `SET LOCAL` is transaction-scoped, so the restoration uses
-- set_config(..., true) rather than SET LOCAL to stay inside the trigger's own scope.
--
-- SECURITY: the function must be able to see the grant row regardless of the caller's session
-- tenant, which is exactly what re-pointing the setting achieves. It does NOT widen what the
-- caller can read: the function returns only NULL or raises, and reads no row into the caller's
-- result set.
CREATE FUNCTION assert_subject_has_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_tenant text := current_setting('app.tenant_id', true);
  has_authority   boolean;
BEGIN
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);

  SELECT EXISTS (
    SELECT 1 FROM authority_grant g
     WHERE g.subject_id = NEW.id
       AND g.tenant_id  = NEW.tenant_id
       AND g.revoked_at IS NULL
       AND g.expires_at > now()
  ) INTO has_authority;

  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);

  IF NOT has_authority THEN
    RAISE EXCEPTION
      'ProtectedSubject % requires a valid AuthorityGrant at commit (VG-IDENT-001, VG-DATA-005)',
      NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER subject_requires_authority
  AFTER INSERT ON protected_subject DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_subject_has_authority();

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: alias
ALTER TABLE alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE alias FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON alias
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: authority_grant
ALTER TABLE authority_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE authority_grant FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON authority_grant
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: identifier
ALTER TABLE identifier ENABLE ROW LEVEL SECURITY;
ALTER TABLE identifier FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON identifier
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: location_history
ALTER TABLE location_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_history FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON location_history
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: protected_subject
ALTER TABLE protected_subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE protected_subject FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON protected_subject
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END
