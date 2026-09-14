/**
 * Database test harness.
 *
 * Every assertion in tests/db/** runs against a real PostgreSQL server provisioned by
 * `sh scripts/db-provision.sh` and migrated by `scripts/migrate.ts` (DOD-009). There is no
 * in-memory substitute anywhere in this directory: an in-memory database would change
 * transaction, RLS and privilege behaviour, which is exactly what these tests exist to prove.
 *
 * If the DSNs are missing the tests FAIL with a harness ERROR rather than skipping, because a
 * skipped isolation test is indistinguishable from a passing one in a summary line (DOD-006).
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseDsn, queryLines, runSql, withTenantSql, type Dsn } from '../../src/infrastructure/database/psql.ts';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';

function requireDsn(name: string): Dsn {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `harness ERROR: ${name} is not set. Run: sh scripts/db-provision.sh && . "$VG_DB_STATE_FILE" && export ${name}`,
    );
  }
  return parseDsn(value);
}

export function ownerDsn(): Dsn {
  return requireDsn('VG_TEST_DSN_OWNER');
}

export function appDsn(): Dsn {
  return requireDsn('VG_TEST_DSN_APP');
}

/**
 * Run SQL as a role with a transaction-local app.tenant_id.
 *
 * `withTenantSql` begins with `SELECT set_config('app.tenant_id', ...)`, and in an unaligned
 * tuples-only psql session that statement emits its own return value as the FIRST result row.
 * Measured here, not assumed: without stripping it, `asTenant(...)[0]` is always the tenant UUID
 * and every caller's real rows shift by one.
 *
 * The echo row is removed only when it exactly equals the tenant id we just set. A blanket
 * "drop the first row" would silently swallow a genuine first row for any query that legitimately
 * returns the tenant id, and a caller would then be asserting against shifted data.
 */
export function asTenant(dsn: Dsn, tenantId: string, sql: string): string[] {
  const rows = queryLines(dsn, withTenantSql(tenantId, sql));
  return rows[0] === tenantId ? rows.slice(1) : rows;
}

/** Run SQL with NO app.tenant_id set — the fail-closed path (RLS-3). */
export function withoutTenant(dsn: Dsn, sql: string): string[] {
  return queryLines(dsn, sql);
}

export function exec(dsn: Dsn, sql: string): { status: number | null; output: string } {
  return runSql(dsn, sql);
}

export function tenantScopedTables(): string[] {
  return readFileSync(join(PROJECT_ROOT, 'db', 'tenant-scoped-tables.txt'), 'utf8')
    .split('\n')
    .map((line) => line.split('#')[0]?.trim() ?? '')
    .filter((line) => line.length > 0);
}

export function firstLine(output: string): string {
  return output.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
}
