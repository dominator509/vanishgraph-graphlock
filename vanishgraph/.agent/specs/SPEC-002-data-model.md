# SPEC-002 Data Model

PostgreSQL is the transactional source of truth with tenant isolation and row-level authorization. Evidence is encrypted, content-addressed, retention-bounded, and stored separately from ordinary profile fields.

Required records include tenant_id, protected_subject_id, authority_scope, provenance, confidence, policy_version, recipe_version, idempotency_key, status, created_at, updated_at, and audit_digest where applicable. High-risk identifiers and evidence use KMS-backed envelope encryption. Backups inherit deletion policy.

Acceptance requires empty-database migration, supported upgrade migration, independent readback, restart durability, cross-tenant denial, and deletion reconciliation evidence.
