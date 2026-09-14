-- 0007 — assert the isolation invariant in the database itself (SPEC-002 RLS-1, RLS-2, MIG-6).
--
-- scripts/generate-rls.ts checks the source text; scripts/check-rls-coverage.sh checks a live
-- database. This migration makes the database refuse to be left in a state where a table with
-- a tenant_id column has no enforced policy, so the failure surfaces where the table is
-- created rather than in a later test run.

DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(format('%I', c.relname), ', ' ORDER BY c.relname)
    INTO offending
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r'
     AND n.nspname = 'public'
     AND EXISTS (
       SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'tenant_id'
     )
     AND (
       c.relrowsecurity IS NOT TRUE
       OR c.relforcerowsecurity IS NOT TRUE
       OR NOT EXISTS (
         SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = c.relname
       )
     );
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'RLS invariant violated for tenant-scoped tables: % (VG-DATA-001, RLS-2, MIG-6)', offending;
  END IF;
END;
$$;
