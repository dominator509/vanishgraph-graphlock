-- Prior-schema seed for the upgrade matrix (MIG-2, DOD-016).
--
-- "Realistic" here means the row shapes a real deployment would already hold at the prior
-- version: two tenants, subjects with authority, a source catalogue entry, a signed recipe, a
-- source record, an exposure with basis, a policy version, a case, an external action, an
-- evidence artifact, a verification observation and audit rows. No apparent PII: identifiers
-- are opaque and payloads are opaque scalars (VG-SEC-002).
--
-- The whole file runs inside one transaction, so the deferred authority trigger sees subject
-- and grant together. Every statement sets app.tenant_id, because FORCE RLS applies to the
-- migration role too (RLS-4) — that is a feature being exercised here, not an inconvenience.

BEGIN;

SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true);
INSERT INTO tenant (id, name, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'tenant-alpha', 'ACTIVE'),
  ('22222222-2222-4222-8222-222222222222', 'tenant-beta', 'ACTIVE');

INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status) VALUES
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'subject-ref-alpha', 'US-CA', false, 'ACTIVE');
INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument) VALUES
  ('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'SELF', ARRAY['discovery','self_service_write'], now() - interval '1 day', now() + interval '30 days', false);

INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class, permission_checked_at) VALUES
  ('cccccccc-1111-4111-8111-cccccccccccc', '11111111-1111-4111-8111-111111111111', 'example-registry', 'REGISTRY', 'US-CA', 'WRITE_PERMITTED', now());
INSERT INTO source_catalog_entry (id, tenant_id, source_id, category, coverage_notes, provenance, license) VALUES
  ('dddddddd-1111-4111-8111-dddddddddddd', '11111111-1111-4111-8111-111111111111', 'cccccccc-1111-4111-8111-cccccccccccc', 'PEOPLE_REGISTRY', 'covers state-level records only', 'manual-review-2026', 'provider-terms-2026-01');
INSERT INTO removal_recipe (id, tenant_id, source_id, version, signature, channel, verification_method, freshness_at, enabled) VALUES
  ('eeeeeeee-1111-4111-8111-eeeeeeeeeeee', '11111111-1111-4111-8111-111111111111', 'cccccccc-1111-4111-8111-cccccccccccc', 1, 'sig:prior-release', 'OFFICIAL_SELF_SERVICE', 'independent-fetch', now() + interval '7 days', true);

INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted) VALUES
  ('ffffffff-1111-4111-8111-ffffffffffff', '11111111-1111-4111-8111-111111111111', 'cccccccc-1111-4111-8111-cccccccccccc', 'https://example.invalid/record/1', now() - interval '2 days', repeat('a', 64), false);
-- The confidence basis is the `{feature, weight}` shape SPEC-003 §5.5.1 and §5.5.3 use, and it was NOT that
-- until §5.5's read route rendered it. The original fixture wrote `["exact-name-match","state-match"]` — an
-- array of bare strings, which satisfies SPEC-002 §2 (the column's only constraint is that the array is
-- non-empty) and satisfies nothing in SPEC-003, whose `confidence.basis` is an array of objects and whose
-- §5.5.3 request requires `feature` and `weight` per entry. Measured consequence before this change: the
-- §5.5.1 list answered 500 for any tenant holding the seeded row, because the reader refuses a basis entry it
-- cannot render instead of inventing a weight for it (VG-IDENT-003: a score without its recorded basis is the
-- state the rule exists to prevent). The two specifications do not contradict each other — one constrains the
-- array, the other the element — so the fixture is what was wrong. Recorded in ASSUMPTIONS.md §3.28.
INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state) VALUES
  ('99999999-1111-4111-8111-999999999999', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'ffffffff-1111-4111-8111-ffffffffffff', 0.91,
   '[{"feature":"NAME_EXACT","weight":0.4},{"feature":"ADDRESS_MATCH","weight":0.31},{"feature":"AGE_BAND_MATCH","weight":0.2}]'::jsonb,
   'MATCH_CONFIRMED');

INSERT INTO jurisdiction_policy (id, tenant_id, jurisdiction, version, effective_from, rules, provenance) VALUES
  ('88888888-1111-4111-8111-888888888888', '11111111-1111-4111-8111-111111111111', 'US-CA', 1, now() - interval '90 days', ARRAY['CCPA_DELETE'], 'COUNSEL_REVIEWED');

INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, truth_state) VALUES
  ('77777777-1111-4111-8111-777777777777', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '99999999-1111-4111-8111-999999999999', 'cccccccc-1111-4111-8111-cccccccccccc', 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', 'MATCH_CONFIRMED');

INSERT INTO policy_decision (id, tenant_id, case_id, jurisdiction, legal_basis, channel, policy_version, reasons, decided_at) VALUES
  ('66666666-1111-4111-8111-666666666666', '11111111-1111-4111-8111-111111111111', '77777777-1111-4111-8111-777777777777', 'US-CA', 'CCPA_DELETE', 'OFFICIAL_SELF_SERVICE', 1, '["consumer-request-right"]'::jsonb, now() - interval '1 day');
UPDATE request_case SET policy_decision_id = '66666666-1111-4111-8111-666666666666', truth_state = 'REQUEST_READY'
 WHERE id = '77777777-1111-4111-8111-777777777777';

INSERT INTO external_action (id, tenant_id, case_id, channel, idempotency_key, attempt, status, submitted_at) VALUES
  ('55555555-1111-4111-8111-555555555555', '11111111-1111-4111-8111-111111111111', '77777777-1111-4111-8111-777777777777', 'OFFICIAL_SELF_SERVICE', 'case:77777777:self_service:v1', 1, 'SUBMITTED', now() - interval '20 hours');

INSERT INTO evidence_artifact (id, tenant_id, case_id, kind, digest, storage_ref, egress_class, redaction_state, captured_at) VALUES
  ('44444444-1111-4111-8111-444444444444', '11111111-1111-4111-8111-111111111111', '77777777-1111-4111-8111-777777777777', 'SUBMISSION_RECEIPT', repeat('b', 64), 's3://evidence/tenant-alpha/44444444', 'OPAQUE_ID', 'SCRUBBED', now() - interval '20 hours');

INSERT INTO verification_observation (id, tenant_id, case_id, method, observed_at, actor_identity, acting_identity, finding, evidence_id) VALUES
  ('33333333-1111-4111-8111-333333333333', '11111111-1111-4111-8111-111111111111', '77777777-1111-4111-8111-777777777777', 'independent-fetch', now() - interval '2 hours', 'observer-a', 'actor-a', 'PRESENT', '44444444-1111-4111-8111-444444444444');

INSERT INTO audit_event (tenant_id, actor, action, target_kind, target_id, correlation_id, payload) VALUES
  ('11111111-1111-4111-8111-111111111111', 'domain-command', 'RequestReady', 'RequestCase', '77777777-1111-4111-8111-777777777777', '11111111-2222-4111-8111-111111111111', '{"transitionId":"T5"}'::jsonb),
  ('11111111-1111-4111-8111-111111111111', 'domain-command', 'ActionSubmitted', 'ExternalAction', '55555555-1111-4111-8111-555555555555', '11111111-2222-4111-8111-111111111111', '{"transitionId":"T8"}'::jsonb);

-- A second tenant with its own subject, so cross-tenant isolation can be exercised on data
-- that looks like a real deployment rather than on a single row.
SELECT set_config('app.tenant_id', '22222222-2222-4222-8222-222222222222', true);
INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status) VALUES
  ('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'subject-ref-beta', 'US-NY', false, 'ACTIVE');
INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument) VALUES
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 'SELF', ARRAY['discovery'], now() - interval '1 day', now() + interval '30 days', false);
INSERT INTO audit_event (tenant_id, actor, action, target_kind, target_id, correlation_id, payload) VALUES
  ('22222222-2222-4222-8222-222222222222', 'domain-command', 'SubjectRegistered', 'ProtectedSubject', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', '22222222-3333-4222-8222-222222222222', '{}'::jsonb);

COMMIT;
