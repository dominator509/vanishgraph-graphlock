# SPEC-002 — Data Model, Row-Level Security, Retention, and Migrations

Status: SPECIFICATION (normative).
Depends on: SPEC-000 (vocabulary, truth states), SPEC-001 (entities, state machine).
Conflict resolution: SPEC-000 wins, then SPEC-001, then this file.

PostgreSQL is canonical (ADR-001). Tenant isolation is enforced at the database
layer, not only in application code. Application-layer authorization is defence
in depth, never the sole control (VG-TENANT-002).

---

## 1. Schema conventions

- Every tenant-scoped table: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
  `tenant_id uuid NOT NULL REFERENCES tenant(id)`, `created_at timestamptz NOT
  NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`.
- Table and column names are `snake_case` renderings of the SPEC-000 §4 canonical
  vocabulary. **No forbidden synonym may appear as a table or column name.**
- Enumerations are PostgreSQL `enum` types or `CHECK`-constrained text, never
  free-form strings. Truth states use a dedicated enum of exactly the eleven
  SPEC-000 §5 values.
- Raw PII lives only in `identifier` / `alias` (encrypted columns) and
  `evidence_artifact` (encrypted object storage). No other table stores subject
  PII in cleartext.
- `jsonb` is permitted only for recorded bases and provider payloads — never for
  values needing integrity (state, authority, digests).

## 2. Core DDL (normative subset)

```sql
CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Locked to SPEC-000 §5. Adding a member is a spec change + new epoch.
CREATE TYPE truth_state AS ENUM (
  'DISCOVERED_CANDIDATE','MATCH_CONFIRMED','REQUEST_READY','REQUEST_SUBMITTED',
  'ACKNOWLEDGED','VERIFIED_REMOVED','SEARCH_DELISTED','VERIFIED_NOT_PRESENT',
  'NOT_REMOVABLE','HUMAN_REQUIRED','REAPPEARED'
);

CREATE TYPE authority_kind   AS ENUM ('SELF','AGENT','PARENT_GUARDIAN','LEGAL_REPRESENTATIVE');
CREATE TYPE permission_class AS ENUM ('READ_ONLY','WRITE_PERMITTED','WRITE_UNCLEAR','PROHIBITED');
CREATE TYPE egress_class     AS ENUM ('NONE','OPAQUE_ID','CUSTOMER_PII','HIGH_RISK_PII','IDENTITY_DOCUMENT','AUTH_SECRET');

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
-- VG-IDENT-001 / VG-DATA-005: a subject cannot exist without authority.
-- A plain FK cannot express ">=1 row elsewhere", so a deferred constraint
-- trigger enforces it at commit time.
CREATE CONSTRAINT TRIGGER subject_requires_authority
  AFTER INSERT ON protected_subject DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_subject_has_authority();

CREATE TABLE authority_grant (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  subject_id        uuid NOT NULL REFERENCES protected_subject(id),
  kind              authority_kind NOT NULL,
  scope             text[] NOT NULL CHECK (array_length(scope,1) >= 1),
  evidence_id       uuid REFERENCES evidence_artifact(id),
  issued_at         timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  signed_instrument boolean NOT NULL DEFAULT false,
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

CREATE TABLE source (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  name                  text NOT NULL,
  class                 text NOT NULL,
  jurisdiction          text,
  permission_class      permission_class NOT NULL DEFAULT 'WRITE_UNCLEAR',
  permission_checked_at timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE removal_recipe (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  source_id           uuid NOT NULL REFERENCES source(id),
  version             integer NOT NULL,
  signature           bytea NOT NULL,
  channel             text NOT NULL,
  verification_method text NOT NULL,
  freshness_at        timestamptz NOT NULL,
  enabled             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version)
);

CREATE TABLE exposure (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  subject_id       uuid NOT NULL REFERENCES protected_subject(id),
  source_record_id uuid NOT NULL REFERENCES source_record(id),
  confidence       numeric(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- VG-IDENT-003 / VG-DATA-009: a score without basis is unrepresentable.
  confidence_basis jsonb NOT NULL CHECK (jsonb_array_length(confidence_basis) > 0),
  truth_state      truth_state NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE request_case (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  subject_id         uuid NOT NULL REFERENCES protected_subject(id),
  exposure_id        uuid NOT NULL REFERENCES exposure(id),
  source_id          uuid NOT NULL REFERENCES source(id),
  authority_grant_id uuid NOT NULL REFERENCES authority_grant(id),
  policy_decision_id uuid REFERENCES policy_decision(id),
  truth_state        truth_state NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE external_action (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  case_id         uuid NOT NULL REFERENCES request_case(id),
  channel         text NOT NULL,
  idempotency_key text NOT NULL,
  attempt         integer NOT NULL DEFAULT 1,
  status          text NOT NULL,
  ambiguous       boolean NOT NULL DEFAULT false,
  submitted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- VG-ACTION-001 / VG-DATA-007: one key, one external effect.
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE verification_observation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  case_id          uuid NOT NULL REFERENCES request_case(id),
  method           text NOT NULL,
  observed_at      timestamptz NOT NULL,
  actor_identity   text NOT NULL,
  acting_identity  text NOT NULL,     -- identity that performed the action
  finding          text NOT NULL CHECK (finding IN ('PRESENT','ABSENT','INCONCLUSIVE')),
  evidence_id      uuid NOT NULL REFERENCES evidence_artifact(id),
  -- VG-VERIFY-001 / VG-DATA-008: an actor may not verify its own effect.
  CHECK (actor_identity <> acting_identity)
);

CREATE TABLE evidence_artifact (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  case_id         uuid REFERENCES request_case(id),
  kind            text NOT NULL,
  digest          char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  storage_ref     text NOT NULL,
  egress_class    egress_class NOT NULL,
  redaction_state text NOT NULL CHECK (redaction_state IN ('NONE','SCRUBBED','DENIED')),
  captured_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_event (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  actor          text NOT NULL,
  action         text NOT NULL,
  target_kind    text NOT NULL,
  target_id      uuid,
  correlation_id uuid NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  at             timestamptz NOT NULL DEFAULT now()
);
-- VG-EVIDENCE-003 / VG-DATA-004: append-only by construction.
CREATE RULE audit_no_update AS ON UPDATE TO audit_event DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_event DO INSTEAD NOTHING;
```

Remaining tables — `location_history`, `source_catalog_entry`, `source_record`,
`controller`, `jurisdiction_policy`, `policy_decision`, `email_thread`,
`mail_piece`, `deadline`, `controller_response`, `appeal_escalation`,
`reappearance`, `provider_transport_run`, `repair_capsule` — follow these
conventions and are given in full in the EP-003 milestone bodies.

## 3. Row-level security

RLS is enabled on **every tenant-scoped table**, `FORCE`d for table owners, with
the tenant read from a transaction-local setting that the pool applies per
request. A missing setting yields **no rows**, never all rows.

```sql
ALTER TABLE protected_subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE protected_subject FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON protected_subject
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

- **RLS-1** The policy set is generated from one central table list, so a new
  table cannot silently miss isolation.
- **RLS-2** A test enumerates every table carrying `tenant_id` and asserts RLS is
  both *enabled* and *forced*. A missing policy fails the build.
- **RLS-3** `current_setting('app.tenant_id', true)` with no setting returns NULL;
  `tenant_id = NULL` is not true, so rows are filtered. This fail-closed path is
  deliberate and covered by a negative test.
- **RLS-4** The application connects as a role that is **not** the table owner and
  lacks `BYPASSRLS`. Migration and maintenance roles are separate credentials.
- **RLS-5** Cross-tenant reads and writes are proven impossible by a live test
  operating as a real tenant against real PostgreSQL (VG-TENANT-001).
- **RLS-6** `audit_event` is readable per tenant and writable only by the service
  role; the rules in §2 prevent modification by any role.

## 4. Encryption

- **Envelope encryption.** A per-tenant DEK is wrapped by a KMS KEK. Ciphertext
  rows store `key_version` so rotation does not require rewriting history.
- Encrypted at rest at minimum: `identifier.value_enc`, `alias.value_enc`,
  `evidence_artifact` payloads, and rendered `mail_piece` content.
- `value_hmac` is a keyed HMAC so equality lookup neither decrypts nor exposes
  low-entropy values to offline guessing.
- Provider credentials, session secrets, and KMS material are **never** stored in
  these tables (VG-SEC-002). The application database is not a secret store.
- Rotation, revocation, and crypto-shredding are real, exercised operations
  (EP-003 / EP-008 milestones), not described intentions.

## 5. Data classification and retention

| Class | Examples | Default retention | On subject erasure |
|---|---|---|---|
| `IDENTITY_DOCUMENT` | verification uploads | shortest viable; delete at decision | crypto-shred immediately |
| `HIGH_RISK_PII` | government IDs, precise address history | per jurisdiction policy | crypto-shred |
| `CUSTOMER_PII` | name, email, phone, aliases | active + policy window | crypto-shred |
| `OPAQUE_ID` | subject/case/exposure IDs | life of case + audit window | retained (not PII) |
| `EVIDENCE` | hashed artifacts proving an action | per legal-hold and audit policy | retained where needed to prove the action; PII minimised |
| `AUDIT` | append-only events | per compliance policy | retained; carries no raw PII |
| `TELEMETRY` | logs, metrics, traces | short (SPEC-007) | purged |

- **RET-1** Retention windows are **data** resolved from `jurisdiction_policy` —
  not hard-coded constants, and not prompt text.
- **RET-2** Erasure crypto-shreds DEK-wrapped PII and records an audit event while
  preserving audit integrity.
- **RET-3** Deletion must reach **backups**. Backup resurrection is a named threat
  (research brief §11). A restore must re-apply erasure tombstones *before*
  serving traffic; a restore that reintroduces erased PII is severity-1 and is
  covered by a real destructive test (DOD-036).
- **RET-4** Evidence proving a lawful action may outlive erasure only in
  minimised, non-identifying form with a counsel-reviewed basis.
- **RET-5** Retention and erasure are verified against real PostgreSQL, never a
  substitute (DOD-009).

## 6. Migrations

- The migration tool and its pinned version are fixed in EP-000 M1. Migrations
  are forward-only, numbered, and checksummed per file.
- **MIG-1** Every migration applies to an **empty** database (DOD-016).
- **MIG-2** Every migration applies to **each supported prior released schema**
  with logical data preservation, proven by before/after row and invariant checks.
- **MIG-3** Safe-migration rules: additive first; no destructive change in the
  same release that stops using a column; `NOT NULL` only with backfill then
  constraint validation; indexes built concurrently; enum extension additive and
  never reordering existing members.
- **MIG-4** A failed migration leaves a known state; retry and rollback are
  executed, not assumed.
- **MIG-5** The truth-state enum is append-only. Reordering or removing a member
  invalidates all prior evidence (VG-REL-004) and is prohibited.
- **MIG-6** RLS policies ship in the same migration as their table, so no table
  is ever unprotected between migrations.

## 7. Backup, restore, and disaster recovery

- Backup/restore, PITR, RPO, and RTO claims are valid only when executed against
  reconciled state (DOD-036). Untested backup claims in documentation are
  prohibited.
- A restore exercise must confirm: erasure tombstones re-applied, RLS intact,
  audit integrity intact, evidence digests verified, and no cross-tenant leakage
  after restore.
- Keys must be recoverable independently of the database. A backup without its
  KEK is not a backup; this is proven by a real restore.

## 8. Verification requirements for this specification

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-DATA-001 | RLS enabled and forced on every tenant-scoped table. | Enumeration test finds zero unprotected tables. | New table without RLS fails the test. |
| VG-DATA-002 | Cross-tenant read returns zero rows at the DB layer. | Live query as tenant A cannot see tenant B. | Direct SQL as A returns nothing for B's id. |
| VG-DATA-003 | Cross-tenant write rejected by `WITH CHECK`. | Insert claiming tenant B fails. | Insert attempt raises an error. |
| VG-DATA-004 | `audit_event` rejects UPDATE and DELETE. | Both are no-ops leaving rows unchanged. | Mutation leaves the row intact. |
| VG-DATA-005 | Subject cannot exist without valid authority. | Constraint trigger rejects an orphan subject. | Insert without a grant fails at commit. |
| VG-DATA-006 | Agent authority requires signed instrument + evidence. | CHECK enforced. | Unsigned agent grant insert fails. |
| VG-DATA-007 | `external_action` idempotency key unique per tenant. | Duplicate insert violates the constraint. | Second identical submission refused/reconciled. |
| VG-DATA-008 | Self-verification rejected. | CHECK enforced. | Observer equal to actor fails insert. |
| VG-DATA-009 | Confidence cannot be stored without basis. | CHECK enforced. | Empty basis array fails insert. |
| VG-DATA-010 | Migrations apply to empty and to each prior schema. | Executed evidence per version. | A missing version in the matrix fails the gate. |
| VG-DATA-011 | Restore re-applies erasure and preserves RLS. | Executed restore with post-state checks. | Restore reintroducing erased PII fails. |
| VG-DATA-012 | Alias quarantine consistent with subject linkage. | CHECK enforced. | Quarantined alias with a subject fails insert. |

## 9. Open items requiring human authority

- Cloud provider and KMS selection (ADR-006, `open` in `ASSUMPTIONS.md`) must be
  resolved in PREFLIGHT before encryption is implemented.
- Jurisdiction retention windows and erasure bases require counsel review
  (`LEGAL_REVIEW_REQUIRED.md`). This file defines the mechanism; it asserts no
  statutory period and no legal conclusion.
- Real PostgreSQL/Temporal/Valkey are `PROVISIONABLE_ENVIRONMENT` per
  `CAPABILITY_MATRIX.md`. Until provisioned, database-dependent requirements are
  `BLOCKED_ENVIRONMENT`, never PASS.
