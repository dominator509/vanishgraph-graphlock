/**
 * Tenant isolation against real PostgreSQL (SPEC-002 §3, VG-DATA-001/002/003, RLS-2/3/4).
 *
 * These are the tests that must never be satisfied by a substitute: RLS behaviour depends on
 * session settings, table ownership and forced policies, none of which an in-memory database
 * reproduces (DOD-009, DOD-010).
 *
 * Fixture basis: db/seed/prior_release.sql seeds tenant alpha with one protected_subject and two
 * audit_event rows, and tenant beta with one protected_subject and one audit_event row. The
 * exact counts below are assertions about that seed, so a seed edit that silently changes the
 * fixture shape is a red build rather than a quietly weaker test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  TENANT_A,
  TENANT_B,
  appDsn,
  asTenant,
  exec,
  ownerDsn,
  tenantScopedTables,
  withoutTenant,
} from './harness.ts';

/**
 * libpq renders a boolean selected in a tuples-only session as `true`/`false` (measured here),
 * while psql's aligned output uses `t`/`f`. Accepting both keeps this test about the RLS posture
 * rather than about a client formatting detail — and never about which way the default falls: an
 * unrecognised value is `false`, so an unexpected rendering makes the test fail rather than pass.
 */
function isTrueRendering(value: string | undefined): boolean {
  return value === 'true' || value === 't';
}

describe('every tenant-scoped table is isolated (VG-DATA-001, RLS-2)', () => {
  test('RLS is enabled, forced and policied on every table carrying tenant_id', () => {
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT c.relname, c.relrowsecurity::text, c.relforcerowsecurity::text,
              (SELECT count(*) FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = c.relname)::text
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN information_schema.columns col
           ON col.table_schema = 'public' AND col.table_name = c.relname
          AND col.column_name = 'tenant_id'
        WHERE c.relkind = 'r' AND n.nspname = 'public'
        ORDER BY c.relname;`,
    );
    assert.ok(rows.length >= 20, `expected the tenant-scoped inventory, saw ${rows.length} rows`);
    const unprotected = rows
      .map((row) => row.split('|'))
      .filter(([table, enabled, forced, policies]) =>
        table === undefined ||
        !isTrueRendering(enabled) ||
        !isTrueRendering(forced) ||
        Number(policies) < 1,
      );
    assert.deepEqual(unprotected, [], `unprotected tables: ${JSON.stringify(unprotected)}`);
  });

  test('the central list matches the live inventory exactly', () => {
    const rows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN information_schema.columns col
           ON col.table_schema = 'public' AND col.table_name = c.relname
          AND col.column_name = 'tenant_id'
        WHERE c.relkind = 'r' AND n.nspname = 'public'
        ORDER BY c.relname;`,
    );
    assert.deepEqual([...rows].sort(), [...tenantScopedTables()].sort());
  });

  test('the runtime role is not the owner and cannot bypass RLS (RLS-4)', () => {
    const [owner] = asTenant(
      ownerDsn(),
      TENANT_A,
      "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'protected_subject';",
    );
    assert.equal(owner, 'vg_owner');
    const [bypass] = asTenant(
      ownerDsn(),
      TENANT_A,
      "SELECT rolbypassrls::text FROM pg_roles WHERE rolname = 'vg_app';",
    );
    assert.equal(isTrueRendering(bypass), false, `vg_app must not bypass RLS, saw ${String(bypass)}`);
  });
});

describe('cross-tenant behaviour (VG-DATA-002, VG-DATA-003, RLS-3)', () => {
  test('a cross-tenant read returns zero rows at the database layer', () => {
    const seenAsA = asTenant(appDsn(), TENANT_A, 'SELECT count(*)::text FROM protected_subject;');
    const seenAsB = asTenant(appDsn(), TENANT_B, 'SELECT count(*)::text FROM protected_subject;');
    assert.equal(seenAsA[0], '1', 'tenant A sees exactly its own subject');
    assert.equal(seenAsB[0], '1', 'tenant B sees exactly its own subject');

    const crossRead = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT count(*)::text FROM protected_subject WHERE tenant_id = '${TENANT_B}';`,
    );
    assert.equal(crossRead[0], '0', 'a direct cross-tenant predicate must return nothing');
  });

  test('a cross-tenant write is rejected by WITH CHECK', () => {
    const attempt = exec(
      appDsn(),
      `BEGIN;
       SELECT set_config('app.tenant_id', '${TENANT_A}', true);
       INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
       VALUES ('deadbeef-0000-4000-8000-00000000dead', '${TENANT_B}', 'subject-ref-evil', 'US-CA', false, 'ACTIVE');
       COMMIT;`,
    );
    assert.notEqual(attempt.status, 0, 'the insert must fail');
    assert.match(
      attempt.output,
      /row-level security|violates row-level security policy/i,
      `expected an RLS refusal, got:\n${attempt.output}`,
    );
  });

  test('an unset tenant setting fails closed, not open (RLS-3)', () => {
    const rows = withoutTenant(appDsn(), 'SELECT count(*)::text FROM protected_subject;');
    assert.equal(rows[0], '0', 'no app.tenant_id must return no rows, never all rows');
    const ownerRows = withoutTenant(ownerDsn(), 'SELECT count(*)::text FROM protected_subject;');
    assert.equal(
      ownerRows[0],
      '0',
      'FORCE RLS applies to the owner too: an unset setting returns nothing for every role',
    );
  });

  test('the audit log is tenant-scoped for reads (RLS-6)', () => {
    const asA = asTenant(appDsn(), TENANT_A, 'SELECT count(*)::text FROM audit_event;');
    const asB = asTenant(appDsn(), TENANT_B, 'SELECT count(*)::text FROM audit_event;');
    assert.ok(Number(asA[0]) >= 2, `tenant A should see its own audit rows, saw ${String(asA[0])}`);
    assert.equal(asB[0], '1', 'tenant B must not see tenant A audit rows');
  });
});
