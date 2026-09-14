/**
 * Forward-only migration runner (SPEC-002 §6).
 *
 *   up [--up-to N] [--dir D]   apply pending migrations, one transaction per file
 *   status                     list applied versions with checksums and timestamps
 *   verify                     fail when a recorded checksum differs from the file on disk
 *   verify-rls                 enumerate tenant-scoped tables and assert RLS is enabled,
 *                              forced, and policied (RLS-2, VG-DATA-001)
 *
 * Each file is applied by `psql -1`, so a failure rolls the whole file back and the
 * bookkeeping row is written in the same transaction: a failed migration leaves a known
 * state (MIG-4). `--dir` exists so the gates can point the runner at a fixture directory to
 * prove failure and retry behaviour without touching db/migrations.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseDsn, queryLines, runSql, runSqlFile, type Dsn } from './psql.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const PRIVILEGES_FILE = join(PROJECT_ROOT, 'db', 'privileges.sql');

interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly path: string;
  readonly checksum: string;
  readonly singleTransaction: boolean;
}

function migrationFiles(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const sql = readFileSync(path, 'utf8');
      const version = Number.parseInt(name.slice(0, 4), 10);
      return {
        version,
        name,
        path,
        checksum: createHash('sha256').update(sql).digest('hex'),
        singleTransaction: !sql.startsWith('-- vg:no-transaction'),
      };
    });
}

function ensureBookkeeping(dsn: Dsn): void {
  const result = runSql(
    dsn,
    `CREATE TABLE IF NOT EXISTS schema_migration (
       version    integer     PRIMARY KEY,
       name       text        NOT NULL,
       checksum   char(64)    NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
       applied_at timestamptz NOT NULL DEFAULT now()
     );`,
  );
  if (result.status !== 0) {
    throw new Error(
      `harness ERROR: could not create the migration bookkeeping table:\n${result.output}`,
    );
  }
}

function appliedVersions(dsn: Dsn): Map<number, { name: string; checksum: string }> {
  const rows = queryLines(
    dsn,
    'SELECT version, name, checksum FROM schema_migration ORDER BY version;',
  );
  const applied = new Map<number, { name: string; checksum: string }>();
  for (const row of rows) {
    const [version, name, checksum] = row.split('|');
    if (version !== undefined && name !== undefined && checksum !== undefined) {
      applied.set(Number.parseInt(version, 10), { name, checksum });
    }
  }
  return applied;
}

function applyPrivileges(dsn: Dsn): void {
  // Best-effort after `up`: the privilege file references audit_event and schema_migration,
  // which do not exist before the first migration has run.
  runSql(dsn, readFileSync(PRIVILEGES_FILE, 'utf8'), { timeoutMs: 60_000 });
}

function up(dsn: Dsn, dir: string, upTo: number | null): number {
  ensureBookkeeping(dsn);
  const files = migrationFiles(dir);
  if (files.length === 0) {
    console.error(`migrate: FAIL - no migrations found in ${dir}`);
    return 1;
  }
  const applied = appliedVersions(dsn);
  let count = 0;
  for (const file of files) {
    if (upTo !== null && file.version > upTo) break;
    const existing = applied.get(file.version);
    if (existing !== undefined) {
      if (existing.checksum !== file.checksum) {
        console.error(
          `migrate: FAIL - ${file.name} was already applied with checksum ${existing.checksum} but the file now hashes to ${file.checksum}; migrations are immutable (DOD-040)`,
        );
        return 1;
      }
      continue;
    }
    process.stdout.write(`migrate: applying ${file.name}\n`);
    const result = runSqlFile(dsn, file.path, { singleTransaction: file.singleTransaction });
    if (result.status !== 0) {
      console.error(`migrate: FAIL - ${file.name} failed and was rolled back:\n${result.output}`);
      console.error(
        `migrate: database left at version ${[...applied.keys()].sort((a, b) => a - b).pop() ?? 0} (MIG-4: a known state)`,
      );
      return 1;
    }
    const record = runSql(
      dsn,
      `INSERT INTO schema_migration (version, name, checksum) VALUES (${file.version}, '${file.name}', '${file.checksum}');`,
    );
    if (record.status !== 0) {
      console.error(`migrate: FAIL - could not record ${file.name}:\n${record.output}`);
      return 1;
    }
    applied.set(file.version, { name: file.name, checksum: file.checksum });
    count += 1;
  }
  applyPrivileges(dsn);
  process.stdout.write(
    `migrate: applied ${count} migration(s); at version ${[...applied.keys()].sort((a, b) => a - b).pop() ?? 0}\n`,
  );
  console.log('migrate: ok');
  return 0;
}

function status(dsn: Dsn): number {
  ensureBookkeeping(dsn);
  const rows = queryLines(
    dsn,
    'SELECT version, name, checksum, applied_at FROM schema_migration ORDER BY version;',
  );
  if (rows.length === 0) {
    process.stdout.write('migrate: no migrations applied\n');
  }
  for (const row of rows) process.stdout.write(`migrate: applied ${row}\n`);
  console.log('migrate: ok');
  return 0;
}

function verify(dsn: Dsn, dir: string): number {
  ensureBookkeeping(dsn);
  const applied = appliedVersions(dsn);
  const files = new Map(migrationFiles(dir).map((file) => [file.version, file]));
  let problems = 0;
  for (const [version, record] of applied) {
    const file = files.get(version);
    if (file === undefined) {
      console.error(
        `migrate: FAIL - version ${version} (${record.name}) is applied but missing on disk`,
      );
      problems += 1;
      continue;
    }
    if (file.checksum !== record.checksum) {
      console.error(
        `migrate: FAIL - version ${version} (${record.name}) drifted: recorded ${record.checksum}, on disk ${file.checksum}`,
      );
      problems += 1;
    }
  }
  if (problems > 0) return 1;
  process.stdout.write(`migrate: verified ${applied.size} applied migration(s), no drift\n`);
  console.log('migrate: ok');
  return 0;
}

function verifyRls(dsn: Dsn): number {
  const rows = queryLines(
    dsn,
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN information_schema.columns col
         ON col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id'
      WHERE c.relkind = 'r' AND n.nspname = 'public'
      ORDER BY c.relname;`,
  );
  if (rows.length === 0) {
    console.error('rls coverage: FAIL - no tenant-scoped tables found; nothing was verified');
    return 1;
  }
  const problems: string[] = [];
  for (const row of rows) {
    const [table, enabled, forced, policies] = row.split('|');
    if (enabled !== 't' || forced !== 't' || Number.parseInt(policies ?? '0', 10) < 1) {
      problems.push(
        `${table}: enabled=${String(enabled)} forced=${String(forced)} policies=${String(policies)}`,
      );
    }
  }
  if (problems.length > 0) {
    console.error('rls coverage: FAIL - tenant-scoped tables without enforced isolation (VG-DATA-001):');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  process.stdout.write(
    `rls coverage: ${rows.length} tenant-scoped tables all enabled, forced and policied\n`,
  );
  return 0;
}

function parseArgs(argv: readonly string[]): {
  command: string;
  dsn: string | undefined;
  dir: string;
  upTo: number | null;
} {
  const [command = '', ...rest] = argv;
  let dsn = process.env['VG_TEST_DSN_OWNER'];
  let dir = join(PROJECT_ROOT, 'db', 'migrations');
  let upTo: number | null = null;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--dsn') dsn = rest[index + 1];
    else if (token === '--dir' && rest[index + 1] !== undefined) {
      dir = resolve(rest[index + 1] as string);
    } else if (token === '--up-to') upTo = Number.parseInt(rest[index + 1] ?? '', 10);
  }
  return { command, dsn, dir, upTo };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/infrastructure/database/migrate.ts')) {
  const { command, dsn, dir, upTo } = parseArgs(process.argv.slice(2));
  if (dsn === undefined || dsn.trim().length === 0) {
    console.error(
      'migrate: FAIL - no DSN; pass --dsn or export VG_TEST_DSN_OWNER (run sh scripts/db-provision.sh first)',
    );
    process.exit(1);
  }
  const parsed = parseDsn(dsn);
  if (command === 'up') process.exit(up(parsed, dir, upTo));
  if (command === 'status') process.exit(status(parsed));
  if (command === 'verify') process.exit(verify(parsed, dir));
  if (command === 'verify-rls') {
    const code = verifyRls(parsed);
    if (code === 0) console.log('rls coverage: ok');
    process.exit(code);
  }
  console.error('usage: migrate.ts up [--up-to N] [--dir D] | status | verify | verify-rls  [--dsn DSN]');
  process.exit(2);
}
