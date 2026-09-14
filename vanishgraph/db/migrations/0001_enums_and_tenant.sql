-- 0001 — enums, the migration bookkeeping table, and the tenant isolation boundary.
--
-- SPEC-002 §2 (normative subset) and §6 (MIG-5: the truth-state enum is append-only).
-- The truth_state enum members are exactly the eleven SPEC-000 §5 states, in spec order.
-- Reordering or removing a member invalidates all prior evidence (VG-REL-004) and is
-- prohibited; later migrations may only append members.

CREATE TABLE IF NOT EXISTS schema_migration (
  version    integer     PRIMARY KEY,
  name       text        NOT NULL,
  checksum   char(64)    NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE truth_state AS ENUM (
  'DISCOVERED_CANDIDATE','MATCH_CONFIRMED','REQUEST_READY','REQUEST_SUBMITTED',
  'ACKNOWLEDGED','VERIFIED_REMOVED','SEARCH_DELISTED','VERIFIED_NOT_PRESENT',
  'NOT_REMOVABLE','HUMAN_REQUIRED','REAPPEARED'
);

CREATE TYPE authority_kind   AS ENUM ('SELF','AGENT','PARENT_GUARDIAN','LEGAL_REPRESENTATIVE');
CREATE TYPE permission_class AS ENUM ('READ_ONLY','WRITE_PERMITTED','WRITE_UNCLEAR','PROHIBITED');
CREATE TYPE egress_class     AS ENUM ('NONE','OPAQUE_ID','CUSTOMER_PII','HIGH_RISK_PII','IDENTITY_DOCUMENT','AUTH_SECRET');

-- The isolation boundary. Deliberately NOT tenant-scoped: it has no tenant_id column.
CREATE TABLE tenant (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  status     text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
