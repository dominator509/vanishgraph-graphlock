-- 0004 — policy and action aggregates (SPEC-001 §3.3/§3.4, SPEC-002 §2).
--
-- Two cycles are broken here: request_case.policy_decision_id and policy_decision.case_id
-- reference each other. request_case is created first without the FK, then the FK is added
-- as DEFERRABLE INITIALLY DEFERRED so a case and its decision can be inserted in one
-- transaction while a dangling reference still fails at commit.
--
-- verification_observation.evidence_id and reappearance.evidence_id/prior_removed_event_id
-- are completed in 0005 for the same reason.

CREATE TABLE controller (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN
                 ('PLATFORM','PUBLISHER','REGISTRY','GOVERNMENT_AGENCY','OTHER_CONTROLLER')),
  jurisdiction text,
  contact_refs text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- VG-POLICY-001: jurisdiction rules live in versioned data, and the provenance column can
-- only be COUNSEL_REVIEWED or OPERATOR_ENTERED. Model output has no representation.
CREATE TABLE jurisdiction_policy (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  jurisdiction   text NOT NULL,
  version        integer NOT NULL CHECK (version >= 1),
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  rules          text[] NOT NULL CHECK (array_length(rules,1) >= 1),
  provenance     text NOT NULL CHECK (provenance IN ('COUNSEL_REVIEWED','OPERATOR_ENTERED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, jurisdiction, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE request_case (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  subject_id         uuid NOT NULL REFERENCES protected_subject(id),
  exposure_id        uuid NOT NULL REFERENCES exposure(id),
  source_id          uuid NOT NULL REFERENCES source(id),
  authority_grant_id uuid NOT NULL REFERENCES authority_grant(id),
  policy_decision_id uuid,                  -- FK added below (cycle)
  truth_state        truth_state NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy_decision (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  case_id        uuid NOT NULL REFERENCES request_case(id),
  jurisdiction   text NOT NULL,
  legal_basis    text NOT NULL,
  channel        text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version >= 1),
  -- VG-POLICY-002 / VG-DATA-013: all four fields are NOT NULL by construction.
  reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE request_case ADD CONSTRAINT request_case_policy_decision_id_fkey
  FOREIGN KEY (policy_decision_id) REFERENCES policy_decision(id) DEFERRABLE INITIALLY DEFERRED;

-- VG-ACTION-001 / VG-DATA-007: one key, one external effect.
CREATE TABLE external_action (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  case_id         uuid NOT NULL REFERENCES request_case(id),
  channel         text NOT NULL,
  idempotency_key text NOT NULL,
  attempt         integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status          text NOT NULL CHECK (status IN ('PREPARED','SUBMITTED','AMBIGUOUS','REFUSED')),
  ambiguous       boolean NOT NULL DEFAULT false,
  submitted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  -- VG-ACTION-002 / VG-DATA-015: an ambiguous result must be reconcilable, never silent.
  CHECK (status <> 'AMBIGUOUS' OR ambiguous)
);

CREATE TABLE email_thread (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  case_id     uuid NOT NULL REFERENCES request_case(id),
  message_ids text[] NOT NULL CHECK (array_length(message_ids,1) >= 1),
  direction   text NOT NULL CHECK (direction IN ('OUTBOUND','INBOUND')),
  received_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail_piece (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  case_id          uuid NOT NULL REFERENCES request_case(id),
  template_version integer NOT NULL CHECK (template_version >= 1),
  template_hash    char(64) NOT NULL CHECK (template_hash ~ '^[0-9a-f]{64}$'),
  transport_name   text NOT NULL,   -- SPEC-001 §3.4 `provider`; see the §4 deviation table
  tracking_id      text,
  delivery_status  text NOT NULL CHECK (delivery_status IN
                     ('NOT_SENT','SENT','DELIVERED','RETURNED','UNKNOWN')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- VG-ACTION-004: a delivered piece without tracking is not evidence.
  CHECK (delivery_status <> 'DELIVERED' OR tracking_id IS NOT NULL)
);

CREATE TABLE deadline (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  case_id        uuid NOT NULL REFERENCES request_case(id),
  kind           text NOT NULL,
  due_at         timestamptz NOT NULL,
  -- SPEC-001 §3.4 `source`; the value must name a policy version, never a hard-coded period.
  derivation_ref text NOT NULL CHECK (derivation_ref LIKE 'policy:%'),
  satisfied_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- VG-VERIFY-004: claimed_outcome is a CLAIM. Nothing in this schema may move a case to a
-- truth state because a controller said so; only verification_observation can support T14.
CREATE TABLE controller_response (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  case_id         uuid NOT NULL REFERENCES request_case(id),
  kind            text NOT NULL,
  body_ref        text NOT NULL,
  received_at     timestamptz NOT NULL,
  claimed_outcome truth_state,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_observation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  case_id         uuid NOT NULL REFERENCES request_case(id),
  method          text NOT NULL,
  observed_at     timestamptz NOT NULL,
  actor_identity  text NOT NULL,
  acting_identity text NOT NULL,     -- identity that performed the action
  finding         text NOT NULL CHECK (finding IN ('PRESENT','ABSENT','INCONCLUSIVE')),
  evidence_id     uuid NOT NULL,     -- FK added in 0005 (cycle)
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- VG-VERIFY-001 / VG-DATA-008: an actor may not verify its own effect.
  CHECK (actor_identity <> acting_identity)
);

CREATE TABLE appeal_escalation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  case_id               uuid NOT NULL REFERENCES request_case(id),
  kind                  text NOT NULL,
  requires_human_review boolean NOT NULL DEFAULT true CHECK (requires_human_review IS TRUE),
  artifact_ids          uuid[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reappearance (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant(id),
  exposure_id            uuid NOT NULL REFERENCES exposure(id),
  prior_removed_event_id bigint NOT NULL,  -- FK added in 0005 (audit_event)
  observed_at            timestamptz NOT NULL,
  evidence_id            uuid NOT NULL,    -- FK added in 0005 (cycle)
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: appeal_escalation
ALTER TABLE appeal_escalation ENABLE ROW LEVEL SECURITY;
ALTER TABLE appeal_escalation FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON appeal_escalation
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: controller
ALTER TABLE controller ENABLE ROW LEVEL SECURITY;
ALTER TABLE controller FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON controller
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: controller_response
ALTER TABLE controller_response ENABLE ROW LEVEL SECURITY;
ALTER TABLE controller_response FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON controller_response
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: deadline
ALTER TABLE deadline ENABLE ROW LEVEL SECURITY;
ALTER TABLE deadline FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON deadline
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: email_thread
ALTER TABLE email_thread ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_thread FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON email_thread
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: external_action
ALTER TABLE external_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_action FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON external_action
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: jurisdiction_policy
ALTER TABLE jurisdiction_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction_policy FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON jurisdiction_policy
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: mail_piece
ALTER TABLE mail_piece ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_piece FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON mail_piece
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: policy_decision
ALTER TABLE policy_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_decision FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON policy_decision
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: reappearance
ALTER TABLE reappearance ENABLE ROW LEVEL SECURITY;
ALTER TABLE reappearance FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON reappearance
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: request_case
ALTER TABLE request_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_case FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON request_case
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END

-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)
-- table: verification_observation
ALTER TABLE verification_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_observation FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON verification_observation
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- RLS-GENERATED-END
