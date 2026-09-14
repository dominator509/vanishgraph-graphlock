-- Role-scoped privileges. Applied by provisioning, not by a migration: roles and grants are
-- cluster objects, not schema-versioned ones, and a migration naming a role would fail on any
-- deployment that names its roles differently.
--
-- SPEC-002 RLS-4: the runtime role is not the table owner and lacks BYPASSRLS.
-- SPEC-002 RLS-6 / VG-DATA-004: audit_event is insert-only for every role.
--
-- ORDERING: this file is applied twice by design — once by provisioning against a database
-- that has no tables yet, and again by the migration runner after `up`. The guards below are
-- what make the first application succeed: `REVOKE ... ON audit_event` is a hard error when
-- the table does not exist, whereas the ALTER DEFAULT PRIVILEGES and schema grants are not.
-- The existence check is explicit rather than relying on error tolerance, so a genuine
-- privilege failure can never be mistaken for a missing table.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vg_app, vg_owner;

-- Everything is readable and writable by the runtime role...
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vg_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vg_app;

-- ...except the append-only audit log and the migration bookkeeping. Both are created by the
-- first migration, so each revoke is conditional on the object existing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'audit_event') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM vg_app;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'schema_migration') THEN
    REVOKE ALL ON schema_migration FROM vg_app;
  END IF;
END;
$$;

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM vg_app;

-- Tables created later by the migration role default to the same posture.
ALTER DEFAULT PRIVILEGES FOR ROLE vg_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vg_app;
ALTER DEFAULT PRIVILEGES FOR ROLE vg_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vg_app;
