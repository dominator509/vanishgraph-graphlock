/**
 * Disposable PostgreSQL provisioning for the database gates.
 *
 * Primary path: a Docker container running a pinned `postgres:16` image on a free host
 * port, with two roles and four isolated databases. Secondary path: an isolated database on
 * an explicitly supplied `DATABASE_URL`. If neither is possible the command fails with a
 * `BLOCKED_ENVIRONMENT` message and the provisioning log as evidence — never a pass and
 * never a candidate failure (DOD-032, DOD-033).
 *
 * Shape created (SPEC-002 RLS-4):
 *   vg_owner  owns the schema objects and runs migrations; subject to FORCE RLS.
 *   vg_app    runtime role: no ownership, no BYPASSRLS, no TRUNCATE.
 *   postgres  the container superuser, used only to create roles and databases.
 *
 * Databases: <prefix>_main (integration), <prefix>_empty (MIG-1), <prefix>_prior (MIG-2),
 * <prefix>_failure (MIG-4).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parseDsn, queryLines, runSql, type Dsn } from './psql.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const STATE_FILE = process.env['VG_DB_STATE_FILE'] ?? join(tmpdir(), 'vanishgraph-db.env');
const CONTAINER_NAME = process.env['VG_DB_CONTAINER'] ?? 'vanishgraph-ep003-postgres';
const DB_PREFIX = 'vanishgraph';
const IMAGE = process.env['VG_POSTGRES_IMAGE'] ?? 'postgres:16';
const DATABASES = [
  `${DB_PREFIX}_main`,
  `${DB_PREFIX}_empty`,
  `${DB_PREFIX}_prior`,
  `${DB_PREFIX}_failure`,
] as const;

interface ProvisionState {
  readonly mode: 'docker' | 'external';
  readonly containerId: string;
  readonly host: string;
  readonly port: string;
  readonly superUser: string;
  readonly superPassword: string;
  readonly ownerPassword: string;
  readonly appPassword: string;
}

function log(line: string): void {
  process.stdout.write(`db provision: ${line}\n`);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function docker(args: readonly string[], timeoutMs = 120_000) {
  return spawnSync('docker', [...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function dockerDaemonReachable(): boolean {
  const result = docker(['version', '--format', '{{.Server.Version}}'], 20_000);
  return result.status === 0 && (result.stdout ?? '').trim().length > 0;
}

function freePort(): string {
  const result = spawnSync(
    'node',
    [
      '-e',
      'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});',
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  const port = (result.stdout ?? '').trim();
  if (port === '') throw new Error('harness ERROR: could not allocate a local port');
  return port;
}

function provisionDocker(reuse: boolean): ProvisionState {
  const running = docker(['inspect', '-f', '{{.State.Running}}', CONTAINER_NAME], 30_000);
  if (running.status === 0 && (running.stdout ?? '').includes('true') && reuse) {
    const previous = readState();
    log(`reusing running container ${CONTAINER_NAME} on port ${previous.port}`);
    return previous;
  }
  if (running.status === 0) {
    docker(['rm', '-f', CONTAINER_NAME], 60_000);
  }
  const port = freePort();
  const superPassword = randomBytes(18).toString('hex');
  const created = docker([
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '-e',
    `POSTGRES_PASSWORD=${superPassword}`,
    '-p',
    `127.0.0.1:${port}:5432`,
    IMAGE,
  ]);
  if (created.status !== 0) {
    throw new Error(`BLOCKED_ENVIRONMENT: docker run failed: ${(created.stderr ?? '').trim()}`);
  }
  const containerId = (created.stdout ?? '').trim();
  log(`container ${containerId.slice(0, 12)} started from ${IMAGE} on 127.0.0.1:${port}`);
  return {
    mode: 'docker',
    containerId,
    host: '127.0.0.1',
    port,
    superUser: 'postgres',
    superPassword,
    ownerPassword: randomBytes(18).toString('hex'),
    appPassword: randomBytes(18).toString('hex'),
  };
}

function provisionExternal(): ProvisionState {
  const url = process.env['DATABASE_URL'] ?? '';
  if (url === '') {
    throw new Error(
      'BLOCKED_ENVIRONMENT: the Docker daemon is unreachable and DATABASE_URL is not set, ' +
        'so no PostgreSQL can be provisioned',
    );
  }
  const dsn = parseDsn(url);
  log(`using the explicitly supplied DATABASE_URL (${dsn.host}:${dsn.port}/${dsn.database})`);
  return {
    mode: 'external',
    containerId: '',
    host: dsn.host,
    port: dsn.port,
    superUser: dsn.user,
    superPassword: dsn.password,
    ownerPassword: randomBytes(18).toString('hex'),
    appPassword: randomBytes(18).toString('hex'),
  };
}

function superDsn(state: ProvisionState, database = 'postgres'): Dsn {
  return {
    host: state.host,
    port: state.port,
    database,
    user: state.superUser,
    password: state.superPassword,
  };
}

function waitForReady(state: ProvisionState): void {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const probe = runSql(superDsn(state), 'SELECT 1;', { timeoutMs: 15_000 });
    if (probe.status === 0) {
      log(`server ready after ${attempt} probe(s)`);
      return;
    }
    sleepMs(1_000);
  }
  throw new Error('BLOCKED_ENVIRONMENT: the PostgreSQL server did not become ready within 60s');
}

function createRolesAndDatabases(state: ProvisionState): void {
  const roles = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vg_owner') THEN
    CREATE ROLE vg_owner LOGIN PASSWORD '${state.ownerPassword}' NOSUPERUSER NOCREATEDB NOBYPASSRLS;
  ELSE
    ALTER ROLE vg_owner PASSWORD '${state.ownerPassword}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vg_app') THEN
    CREATE ROLE vg_app LOGIN PASSWORD '${state.appPassword}' NOSUPERUSER NOCREATEDB NOBYPASSRLS;
  ELSE
    ALTER ROLE vg_app PASSWORD '${state.appPassword}';
  END IF;
END;
$$;
`;
  const roleSetup = runSql(superDsn(state), roles, { timeoutMs: 60_000 });
  if (roleSetup.status !== 0) {
    throw new Error(`BLOCKED_ENVIRONMENT: role setup failed:\n${roleSetup.output}`);
  }
  log('roles vg_owner and vg_app present (no BYPASSRLS)');
  for (const database of DATABASES) {
    const exists = queryLines(
      superDsn(state),
      `SELECT 1 FROM pg_database WHERE datname = '${database}';`,
    );
    if (exists.length === 0) {
      const created = runSql(superDsn(state), `CREATE DATABASE ${database} OWNER vg_owner;`, {
        timeoutMs: 60_000,
      });
      if (created.status !== 0) {
        throw new Error(`BLOCKED_ENVIRONMENT: could not create ${database}:\n${created.output}`);
      }
      log(`created database ${database} owned by vg_owner`);
    } else {
      log(`database ${database} already exists`);
    }
  }
}

function dsnFor(state: ProvisionState, role: 'vg_owner' | 'vg_app', database: string): string {
  const password = role === 'vg_owner' ? state.ownerPassword : state.appPassword;
  return `postgres://${role}:${password}@${state.host}:${state.port}/${database}`;
}

function writeState(state: ProvisionState): void {
  const lines = [
    '# Generated by src/infrastructure/database/provision.ts.',
    '# Disposable local credentials. Never commit this file: it lives outside the',
    '# repository and holds the only copy of the generated passwords (VG-SEC-002).',
    `export VG_DB_STATE_FILE=${JSON.stringify(STATE_FILE)}`,
    `export VG_DB_MODE=${state.mode}`,
    `export VG_DB_HOST=${state.host}`,
    `export VG_DB_PORT=${state.port}`,
    `export VG_DB_SUPER_USER=${state.superUser}`,
    `export VG_DB_SUPER_PASSWORD=${JSON.stringify(state.superPassword)}`,
    `export VG_DB_CONTAINER_ID=${JSON.stringify(state.containerId)}`,
    `export VG_DB_CONTAINER_NAME=${JSON.stringify(CONTAINER_NAME)}`,
    `export VG_TEST_DSN_OWNER=${JSON.stringify(dsnFor(state, 'vg_owner', `${DB_PREFIX}_main`))}`,
    `export VG_TEST_DSN_APP=${JSON.stringify(dsnFor(state, 'vg_app', `${DB_PREFIX}_main`))}`,
    `export VG_EMPTY_DSN_OWNER=${JSON.stringify(dsnFor(state, 'vg_owner', `${DB_PREFIX}_empty`))}`,
    `export VG_PRIOR_DSN_OWNER=${JSON.stringify(dsnFor(state, 'vg_owner', `${DB_PREFIX}_prior`))}`,
    `export VG_FAILURE_DSN_OWNER=${JSON.stringify(dsnFor(state, 'vg_owner', `${DB_PREFIX}_failure`))}`,
    '',
  ];
  writeFileSync(STATE_FILE, lines.join('\n'), { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
}

function readState(): ProvisionState {
  const content = readFileSync(STATE_FILE, 'utf8');
  /**
   * Read one exported variable.
   *
   * Values are written in two shapes: the DSNs are JSON-quoted (they contain characters a
   * shell would otherwise interpret), while MODE and CONTAINER_ID are bare tokens. Parsing
   * every value as JSON therefore failed on `docker` with "Unexpected token 'd'", which
   * broke both re-provisioning and teardown. The shape is detected rather than assumed.
   */
  const read = (name: string): string => {
    const match = content.match(new RegExp(`^export ${name}=(.*)$`, 'm'));
    if (match?.[1] === undefined) throw new Error(`harness ERROR: state file lacks ${name}`);
    const raw = match[1].trim();
    if (raw.startsWith('"')) {
      return JSON.parse(raw) as string;
    }
    return raw.replace(/^'|'$/g, '');
  };
  const owner = parseDsn(read('VG_TEST_DSN_OWNER'));
  const app = parseDsn(read('VG_TEST_DSN_APP'));
  // The superuser password MUST round-trip through the state file. Without it the reuse
  // path sends an empty password, `waitForReady` never succeeds, and provisioning stalls
  // for its full 60-attempt budget — which is exactly what happened before this field was
  // persisted. An empty value is a corrupt state file, not a usable one.
  const superPassword = read('VG_DB_SUPER_PASSWORD');
  if (superPassword === '') {
    throw new Error(
      'harness ERROR: the state file carries no superuser password; it is stale or corrupt. ' +
        'Run the teardown command and provision again.',
    );
  }
  return {
    mode: read('VG_DB_MODE') === 'external' ? 'external' : 'docker',
    containerId: read('VG_DB_CONTAINER_ID'),
    host: read('VG_DB_HOST'),
    port: read('VG_DB_PORT'),
    superUser: read('VG_DB_SUPER_USER'),
    superPassword,
    ownerPassword: owner.password,
    appPassword: app.password,
  };
}

export function provision(): number {
  let state: ProvisionState;
  try {
    state = dockerDaemonReachable() ? provisionDocker(existsSync(STATE_FILE)) : provisionExternal();
    waitForReady(state);
    createRolesAndDatabases(state);
    writeState(state);
  } catch (error) {
    console.error(`db provision: FAIL - ${(error as Error).message}`);
    console.error(
      'db provision: classified BLOCKED_ENVIRONMENT; the log above is the evidence (DOD-033)',
    );
    return 1;
  }

  for (const database of DATABASES) {
    const privileges = runSql(
      {
        host: state.host,
        port: state.port,
        database,
        user: 'vg_owner',
        password: state.ownerPassword,
      },
      readFileSync(join(PROJECT_ROOT, 'db', 'privileges.sql'), 'utf8'),
      { timeoutMs: 60_000 },
    );
    if (privileges.status !== 0) {
      console.error(`db provision: FAIL - privileges failed on ${database}:\n${privileges.output}`);
      return 1;
    }
  }

  mkdirSync(join(PROJECT_ROOT, '.agent', 'evidence', 'db'), { recursive: true });
  writeFileSync(
    join(PROJECT_ROOT, '.agent', 'evidence', 'db', 'provisioning.txt'),
    [
      `mode: ${state.mode}`,
      `container: ${state.containerId === '' ? '(none)' : state.containerId.slice(0, 12)}`,
      `image: ${IMAGE}`,
      `host: ${state.host}`,
      `port: ${state.port}`,
      `databases: ${DATABASES.join(', ')}`,
      'roles: vg_owner (owner/migrator), vg_app (runtime, no BYPASSRLS)',
      'passwords: recorded only in the state file outside the repository',
      '',
    ].join('\n'),
  );
  log(`state file written to ${STATE_FILE} (mode 0600, outside the repository)`);
  log(`databases: ${DATABASES.join(', ')}`);
  console.log('db provision: ok');
  return 0;
}

/**
 * Read only what teardown needs: the mode and the container identity.
 *
 * Teardown deliberately does NOT go through `readState()`. A state file written by an older
 * revision can lack a field the current provisioner requires (for example the superuser
 * password added here), and if teardown demanded the full record it would be unable to remove
 * the very container that the bad state file describes — leaving a resource nothing can
 * clean up. Teardown is a cleanup path and must stay usable on the least information.
 */
function readTeardownIdentity(): { mode: 'docker' | 'external'; containerId: string } {
  const content = readFileSync(STATE_FILE, 'utf8');
  const read = (name: string): string => {
    const match = content.match(new RegExp(`^export ${name}=(.*)$`, 'm'));
    if (match?.[1] === undefined) return '';
    const raw = match[1].trim();
    return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  };
  const containerId = read('VG_DB_CONTAINER_ID');
  const mode = read('VG_DB_MODE') === 'external' ? 'external' : 'docker';
  return { mode, containerId };
}

export function teardown(): number {
  if (!existsSync(STATE_FILE)) {
    console.log('db teardown: nothing to tear down (no state file)');
    console.log('db teardown: ok');
    return 0;
  }
  const state = readTeardownIdentity();
  if (state.mode === 'docker') {
    const removed = docker(['rm', '-f', CONTAINER_NAME], 60_000);
    if (removed.status !== 0) {
      console.error(`db teardown: FAIL - docker rm failed: ${(removed.stderr ?? '').trim()}`);
      return 1;
    }
    const still = docker(
      ['ps', '-a', '--filter', `name=^/${CONTAINER_NAME}$`, '--format', '{{.Names}}'],
      30_000,
    );
    if ((still.stdout ?? '').trim().length > 0) {
      console.error('db teardown: FAIL - the container is still present after removal');
      return 1;
    }
    log(`container ${CONTAINER_NAME} removed; no container remains`);
  } else {
    log('external DATABASE_URL mode: databases are left in place; the operator owns them');
  }
  mkdirSync(join(PROJECT_ROOT, '.agent', 'evidence', 'db'), { recursive: true });
  writeFileSync(
    join(PROJECT_ROOT, '.agent', 'evidence', 'db', 'teardown.txt'),
    [
      `mode: ${state.mode}`,
      `container: ${state.containerId === '' ? '(none)' : state.containerId.slice(0, 12)}`,
      `removed_at: ${new Date().toISOString()}`,
      state.mode === 'docker' ? 'container_absent: true' : 'container_absent: not-applicable',
      '',
    ].join('\n'),
  );
  rmSync(STATE_FILE, { force: true });
  log('state file removed');
  console.log('db teardown: ok');
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/infrastructure/database/provision.ts')) {
  const command = process.argv[2];
  if (command === 'provision') process.exit(provision());
  if (command === 'teardown') process.exit(teardown());
  console.error('usage: node src/infrastructure/database/provision.ts provision|teardown');
  process.exit(2);
}
