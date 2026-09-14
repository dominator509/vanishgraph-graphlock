/**
 * psql runner for the database gates and tests.
 *
 * Two deliberate properties:
 *
 *  1. **No piped stdio.** Output is redirected to a file by the shell
 *     (`sh -c '... > out 2>&1'`) and read back with `node:fs`, while the child's stdio is
 *     inherited. Piped stdio is unavailable in some confined environments, and a raw log
 *     file on disk is exactly the evidence DOD-025 asks for.
 *  2. **No secret in argv.** The DSN is parsed here and the password travels in
 *     `PGPASSWORD`, so credentials never appear in a process listing or a command log.
 *
 * This is infrastructure: it may import node builtins. Nothing in the domain may import it.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Dsn {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

/** Parse a postgres:// URL. Refuses anything else rather than guessing. */
export function parseDsn(value: string): Dsn {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`harness ERROR: not a valid DSN URL: ${value.replace(/:[^:@/]*@/, ':***@')}`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`harness ERROR: DSN must use postgres:// (got ${url.protocol}//)`);
  }
  const host = url.hostname;
  const port = url.port === '' ? '5432' : url.port;
  const database = url.pathname.replace(/^\//, '');
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (host === '' || database === '' || user === '') {
    throw new Error('harness ERROR: DSN must carry host, database and user');
  }
  return { host, port, database, user, password };
}

export interface SqlResult {
  readonly status: number | null;
  readonly output: string;
}

function psqlCommand(dsn: Dsn, args: readonly string[], outFile: string): string {
  const quoted = [
    'psql',
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-h',
    JSON.stringify(dsn.host),
    '-p',
    JSON.stringify(dsn.port),
    '-U',
    JSON.stringify(dsn.user),
    '-d',
    JSON.stringify(dsn.database),
    ...args,
  ].join(' ');
  return `${quoted} > ${JSON.stringify(outFile)} 2>&1`;
}

/** Run one SQL string. `ON_ERROR_STOP` is always on: a silent partial apply is a defect. */
export function runSql(dsn: Dsn, sql: string, options: { timeoutMs?: number } = {}): SqlResult {
  const dir = mkdtempSync(join(tmpdir(), 'vg-psql-'));
  const sqlFile = join(dir, 'statement.sql');
  const outFile = join(dir, 'output.txt');
  writeFileSync(sqlFile, sql, 'utf8');
  writeFileSync(outFile, '');
  try {
    const result = spawnSync(
      'sh',
      ['-c', psqlCommand(dsn, ['-f', JSON.stringify(sqlFile)], outFile)],
      {
        env: { ...process.env, PGPASSWORD: dsn.password },
        stdio: 'inherit',
        timeout: options.timeoutMs ?? 120_000,
      },
    );
    return { status: result.status, output: readFileSync(outFile, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a SQL file that already exists on disk (migration, seed, fixture). */
export function runSqlFile(
  dsn: Dsn,
  filePath: string,
  options: { singleTransaction?: boolean; timeoutMs?: number } = {},
): SqlResult {
  const dir = mkdtempSync(join(tmpdir(), 'vg-psql-'));
  const outFile = join(dir, 'output.txt');
  writeFileSync(outFile, '');
  try {
    const args =
      options.singleTransaction === false
        ? ['-f', JSON.stringify(filePath)]
        : ['-1', '-f', JSON.stringify(filePath)];
    const result = spawnSync('sh', ['-c', psqlCommand(dsn, args, outFile)], {
      env: { ...process.env, PGPASSWORD: dsn.password },
      stdio: 'inherit',
      timeout: options.timeoutMs ?? 300_000,
    });
    return { status: result.status, output: readFileSync(outFile, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a statement and return the non-empty output lines, trimmed. */
export function queryLines(dsn: Dsn, sql: string, options: { timeoutMs?: number } = {}): string[] {
  const result = runSql(dsn, `\\pset tuples_only on\n\\pset format unaligned\n${sql}`, options);
  if (result.status !== 0) {
    throw new Error(`harness ERROR: query failed (exit ${String(result.status)}):\n${result.output}`);
  }
  return result.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Wrap statements so they execute with a transaction-local tenant setting. */
export function withTenantSql(tenantId: string, sql: string): string {
  return `BEGIN;\nSELECT set_config('app.tenant_id', '${tenantId}', true);\n${sql}\nCOMMIT;\n`;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/infrastructure/database/psql.ts')) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'query' && rest[0] !== undefined && rest[1] !== undefined) {
    const result = runSql(parseDsn(rest[0]), rest[1]);
    process.stdout.write(result.output);
    process.exit(result.status ?? 1);
  }
  if (command === 'query-file' && rest[0] !== undefined && rest[1] !== undefined) {
    const result = runSqlFile(parseDsn(rest[0]), rest[1]);
    process.stdout.write(result.output);
    process.exit(result.status ?? 1);
  }
  console.error(
    'usage: node src/infrastructure/database/psql.ts query <dsn> <sql> | query-file <dsn> <file>',
  );
  process.exit(2);
}
