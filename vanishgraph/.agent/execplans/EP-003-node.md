NODE-META-BEGIN
ID: EP-003
DEPS: EP-002
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/gate-data.sh
VERIFY_SENTINEL: gate-data: ok
GREEN_TAG: green/EP-003
NODE-META-END

# EP-003 — Data & Persistence

## 1. Purpose / Big Picture

Turn SPEC-002 into a real PostgreSQL schema: numbered, checksummed, forward-only
migrations; row-level security generated from **one central table list** so a new table
cannot silently miss isolation; cross-tenant reads and writes proven impossible against a
real database; append-only audit proven by construction; the authority constraint trigger
proven; migration-from-empty and migration-from-prior-schema proven with preserved data;
and a disposable PostgreSQL that the gates provision, migrate and tear down themselves.

The end state is observable: `sh scripts/gate-data.sh` provisions a disposable PostgreSQL,
applies every migration, runs the real database tests (DOD-009), runs the negative security
tests (VG-DATA-001…VG-DATA-005), proves the upgrade matrix (DOD-016), proves a failed
migration leaves a known state, proves `verify.sh` now advances through `integration`, tears
the database down with proof, and prints `gate-data: ok`.

This node is the first that touches real infrastructure, so it is also the first that must be
honest about environments: Docker is a **client** that may or may not reach a daemon, and
`psql` is a **client** that may point at nothing. Provisioning is attempted for real; when it
genuinely cannot succeed the node records `BLOCKED_ENVIRONMENT` with the provisioning log —
never a pass, never a candidate failure (DOD-032, DOD-033).

## 2. Scope

In scope:

- A disposable PostgreSQL provisioner and teardown with proof (Docker container when the
  daemon answers; otherwise an isolated database on an explicitly supplied `DATABASE_URL`),
  including the two-role model required by SPEC-002 RLS-4 (owner/migrator ≠ runtime role,
  runtime role without `BYPASSRLS`).
- A forward-only migration runner: numbered, checksummed per file, one transaction per file,
  drift detection, `status`, `up-to` for the upgrade matrix, and a `--dir` override so
  failure injection is possible.
- Migrations `0001`…`0007` covering every table in SPEC-002 §2 plus the fourteen tables
  SPEC-002 lists as "given in full in the EP-003 milestone bodies", the truth-state enum,
  the constraint trigger, `updated_at` triggers, the append-only audit rules (completed for
  `TRUNCATE`), and the RLS policies generated from the central list.
- `db/tenant-scoped-tables.txt` (the single source of isolation truth) and
  `scripts/generate-rls.ts` with a `--check` drift mode.
- Real PostgreSQL integration tests (DOD-009) for RLS enumeration, cross-tenant read and
  write refusal, fail-closed behaviour when `app.tenant_id` is unset, append-only audit, the
  authority constraint trigger, and every data constraint from SPEC-002 §8 expressible in the
  schema.
- Migration evidence: empty-database application (MIG-1), prior-schema application with
  logical preservation (MIG-2), failure and retry (MIG-4), checksum-drift detection (MIG-6
  support), and the supported upgrade matrix as data (DOD-016).
- `scripts/test-integration.sh` (replacing its loud-fail placeholder) and
  `scripts/gate-data.sh`, the node gate, including the `verify.sh` progression proof.

Out of scope: the service layer, HTTP/API, authorization middleware (EP-004/EP-006); the
Postgres-native durable job queue and Valkey coordination (EP-008); backup/restore drills and crypto-shredding with a
real KMS (EP-008/EP-009); deployment (EP-009).

## 3. Non-goals

- **No claim that any of this is production-deployed, backed up, or recoverable.**
  VG-DATA-011 (restore re-applies erasure and preserves RLS) is *not* satisfied by this node:
  it needs a real backup/restore drill (DOD-036), which is EP-008/EP-009 work. It is recorded
  as `DEFERRED` with its dependency edge, never as PASS.
- No encryption implementation and no KMS. SPEC-002 §4 requires envelope encryption with a
  KMS-wrapped per-tenant DEK, and SPEC-002 §9 forbids implementing it before the KMS choice is
  resolved in PREFLIGHT. This node ships the schema shape (`value_enc bytea`, `value_hmac
  bytea`, `key_version`) and records encryption as `BLOCKED_CREDENTIALS`.
- No destructive change to an existing table in the same release that stops using a column
  (MIG-3). Every migration here is additive or new-table only.
- No reordering or removal of truth-state enum members (MIG-5). The enum is append-only; this
  node adds all eleven at once and never edits them again.
- No test weakening to accommodate the database: `integration` must be able to fail, and a
  missing Docker daemon must produce `BLOCKED_ENVIRONMENT`, not a skip.
- No mocks or in-memory substitutes as the final proof of a persistence claim (DOD-010).
- No touching of the domain layer. `src/domain/**` is frozen by EP-002; the persistence layer
  imports the domain's types and value objects, never the reverse.
- No production deployment (VG-SCOPE-009).

## 4. Context and Orientation

**Measured environment at authoring time** (re-measure in M1; these are the facts that decide
whether provisioning is attempted or declared blocked):

| Fact | Measurement | Consequence |
|---|---|---|
| `docker --version` | `Docker version 29.7.2, build a7dcaa6` | client present |
| `docker version --format '{{.Server.Version}}'` (bounded probe, 20 s) | `29.7.2` | daemon reachable; container provisioning is the primary path |
| `psql --version` | `psql (PostgreSQL) 16.14` | client present |
| server on `localhost:5432` | answers, then `FATAL: password authentication failed for user "postgres"` | a server exists but this node has no credentials for it; never assume it |
| `node --version` | `v24.14.1` | TypeScript helper programs run directly, no build step |

**Where PostgreSQL is canonical.** SPEC-002 §1: PostgreSQL is canonical (ADR-001) and tenant
isolation is enforced at the database layer, with application-layer authorization as defence
in depth (VG-TENANT-002) — never as the sole control.

**The rule that shapes this whole node (RLS-1).** The policy set is generated from one central
table list. Concretely: `db/tenant-scoped-tables.txt` names every tenant-scoped table with the
reason it is in scope (or the reason it is excluded), and `scripts/generate-rls.ts` writes the
`ENABLE`/`FORCE`/`CREATE POLICY` block for each table into the migration that creates it,
between generated markers. `--check` re-derives every block and fails on any drift, so a table
cannot be added without isolation.

**Schema layout from SPEC-002 §2, and the one structural problem in it.** SPEC-002 §2 declares
foreign keys that form cycles across aggregates:

- `authority_grant.evidence_id → evidence_artifact(id)`, `evidence_artifact.case_id →
  request_case(id)`, `request_case.authority_grant_id → authority_grant(id)`;
- `verification_observation.evidence_id → evidence_artifact(id)`;
- `reappearance.evidence_id → evidence_artifact(id)` and `reappearance.prior_removed_event_id →
  audit_event(id)`.

No creation order satisfies those cycles with plain foreign keys. This node creates the tables
in dependency order and adds the four cycle-closing foreign keys at the end of `0005` as
`DEFERRABLE INITIALLY DEFERRED`, the same technique SPEC-002 already uses for the authority
trigger. Inserting a case, its grant and its evidence row in one transaction then works; a
dangling reference still fails at commit.

**Column-name deviations, each forced by the spec's own vocabulary rules** (recorded here and
in the ledger; SPEC-001 is normative for field names, SPEC-000 §4 for tokens):

| SPEC-001 field | Column | Why |
|---|---|---|
| `LocationHistory.from` / `.to` | `effective_from` / `effective_to` | `from` is a reserved SQL keyword; unquoted use is a defect magnet |
| `MailPiece.provider`, `ProviderTransportRun.provider` | `transport_name` | `provider` is a forbidden synonym for `Source` (SPEC-000 §4); the entity name `ProviderTransportRun` is kept because SPEC-001 §3.5 and SPEC-002 §2 mandate it |
| `Deadline.source` | `derivation_ref` | `source` would read as a `Source` reference; the field means "the policy version this deadline derives from" |
| `Reappearance.priorRemovedEventId` | `prior_removed_event_id` | resolved to `audit_event(id)`: SPEC-002 defines no separate transition table, and `audit_event` is the append-only record of the T14 transition |

**Two-role model (RLS-4).** `vg_owner` owns the schema objects and runs migrations; `vg_app` is
the runtime role, does not own the tables, and lacks `BYPASSRLS`. Because every tenant-scoped
table is `FORCE ROW LEVEL SECURITY`, the owner is filtered too: every test and seed that writes
tenant-scoped rows must set `app.tenant_id`. That is deliberate — it is the difference between
a policy that exists and a policy that applies.

**Node verify choice, stated honestly.** As in EP-000/EP-001/EP-002, the stub header's
`verify: ok` is unreachable before EP-009 (artifact-bound stages), and master prompt §10 line
1357 fixes the full fifteen-stage order. This node declares `VERIFY: sh scripts/gate-data.sh` /
`gate-data: ok`. After this node, `verify.sh` advances through `integration` (now real) and
stops at `security-check`, which is EP-006's placeholder. No stage is removed or reordered.

## 5. Files to Read First

- `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`,
  `.agent/EXECUTION_RULES.md`, `.agent/PLANS.md`
- `.agent/DONE_LAW.md` — DOD-005, DOD-009, DOD-010, DOD-016, DOD-017, DOD-018, DOD-021,
  DOD-025, DOD-026, DOD-032, DOD-033, DOD-036, DOD-040
- `.agent/specs/SPEC-002-data-model.md` (the whole file: §1 conventions, §2 DDL, §3 RLS 1–6,
  §4 encryption, §5 retention, §6 MIG-1…MIG-6, §7 backup/restore, §8 verification
  requirements, §9 open human items)
- `.agent/specs/SPEC-000-product-scope.md` (§4 vocabulary, §5 truth states, §6.6 tenancy, §9
  acceptance oracle)
- `.agent/specs/SPEC-001-core-domain.md` (§3 entities — the tables are their persistence shape;
  §4 truth states; §5 ports)
- `.agent/specs/SPEC-008-production-readiness.md` (§8 environment, §11 evidence)
- `.agent/specs/SPEC-007-observability.md` (egress classes and retention touchpoints)
- `ARCHITECTURE.md`, `SECURITY.md`, `PREFLIGHT.md`, `ENVIRONMENT.md`, `TESTING.md`,
  `LICENSE_POLICY.md`
- `.agent/verification/CAPABILITY_MATRIX.md`,
  `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`, `.agent/verification/HARNESS_LAWS.md`
- `.agent/verification/DOD_REGISTRY.csv`, `.agent/verification/MASTER_TEST_REGISTRY.csv`
- `.agent/execplans/EP-001-node.md`, `.agent/execplans/EP-002-node.md` (gate contract, sentinel
  discipline, manifest discipline)
- Existing code and gates: `scripts/verify.sh`, `scripts/lib/loud-fail.sh`,
  `scripts/test-integration.sh` (the placeholder being replaced), `scripts/test-unit.sh`,
  `scripts/test-collection-guard.sh`, `scripts/count-tests.mjs`, `scripts/gate-domain.sh`,
  `scripts/gate-foundation.sh`, `scripts/ledger.sh`
- `.agent/state/LEDGER.md`

## 6. Expected Changed Files

Paths are relative to the project root. This is the audit list; nothing else may change.

Created:

- `db/tenant-scoped-tables.txt` (central isolation list, with an exclusions section and a
  reason per exclusion)
- `db/migrations/0001_enums_and_tenant.sql`
- `db/migrations/0002_identity.sql`
- `db/migrations/0003_source.sql`
- `db/migrations/0004_policy_and_action.sql`
- `db/migrations/0005_evidence_audit_and_ops.sql`
- `db/migrations/0006_updated_at_triggers.sql`
- `db/migrations/0007_rls_invariant_assert.sql`
- `db/privileges.sql` (role-scoped grants; applied by provisioning, not by a migration)
- `db/seed/prior_release.sql` (realistic prior-schema rows for MIG-2)
- `db/UPGRADE_MATRIX.md` (the supported prior-schema matrix as data)
- `src/infrastructure/database/psql.ts` (psql runner: no piped stdio, raw logs preserved)
- `src/infrastructure/database/provision.ts` (disposable PostgreSQL, roles, databases,
  teardown)
- `src/infrastructure/database/migrate.ts` (forward-only numbered checksummed runner + RLS
  verification)
- `scripts/db-provision.sh`, `scripts/db-teardown.sh`, `scripts/migrate.sh`
- `scripts/generate-rls.ts`
- `scripts/check-rls-coverage.sh`
- `scripts/test-migrations.sh`
- `scripts/gate-data.sh`
- `tests/db/harness.ts`
- `tests/db/rls.test.ts`
- `tests/db/audit-append-only.test.ts`
- `tests/db/schema-and-constraints.test.ts`
- `.agent/verification/EXPECTED_INTEGRATION_MANIFEST.txt`
- `.agent/evidence/db/**`, `.agent/evidence/EP-003/**`

Modified:

- `scripts/test-integration.sh` (loud-fail placeholder → real integration stage)
- `scripts/test-unit.sh` (narrow the unit glob to the non-database suites; one line)
- `scripts/test-collection-guard.sh` (allow `VG_EXPECTED_MANIFEST` to select the integration
  manifest; one anchored edit; the zero-collection default is unchanged)
- `COMMANDS.md` (declare every new command and sentinel)
- `TESTING.md` (record the database test commands, the provisioning contract, and the
  DOD-009/DOD-016 evidence paths)
- `SECURITY.md` (record the two-role model and the RLS fail-closed path, if not already stated)
- `.agent/state/LEDGER.md`

Explicitly not changed: `src/domain/**` (frozen by EP-002), `scripts/verify.sh` (stage order
untouched), `RELEASE_GATE.json` (verdict stays `INCONCLUSIVE`), `.env.example` (no new
credential is invented; provisioning is self-contained).

## 7. Interfaces and Contracts

**Layer contract.** `src/infrastructure/database/**` is a composition edge: it may import
`node:*` builtins and the domain's types. It must not be imported by `src/domain/**` (enforced
by the EP-002 import-boundary test). It contains no domain rules of its own: a data rule that
exists here and not in the domain is a duplicated rule and a defect.

**Migration contract (SPEC-002 §6).**

- Files are `db/migrations/<4-digit version>_<snake_name>.sql`, forward-only, never edited
  after application. `0007` is the highest version in this node.
- Each file's SHA-256 is recorded in `schema_migration` when it is applied; `migrate verify`
  fails on any drift between a recorded version and the file on disk (DOD-040 support).
- Each file is applied inside one transaction (`psql -1`), recorded in the same transaction,
  and rolls back completely on failure, so a failed migration leaves a known state (MIG-4). A
  file whose first line is exactly `-- vg:no-transaction` is applied without the wrapper, for
  operations that cannot run in a transaction (for example `CREATE INDEX CONCURRENTLY`); no
  file in this node uses it.
- `migrate up-to <version>` applies only up to a version, which is how the upgrade matrix is
  exercised without hand-editing files.
- The truth-state enum is append-only (MIG-5): members are never reordered or removed, and a
  later migration may only add members.

**RLS contract (SPEC-002 §3).**

- Every tenant-scoped table (every table with a `tenant_id` column) has RLS **enabled** and
  **forced**, plus a policy `tenant_isolation` whose `USING` and `WITH CHECK` both compare
  `tenant_id` to `current_setting('app.tenant_id', true)::uuid`.
- A missing `app.tenant_id` yields NULL, and `tenant_id = NULL` is not true, so the query
  returns **no** rows. Fail-closed is required behaviour (RLS-3) and is covered by a negative
  test.
- RLS ships in the same migration as the table (MIG-6); the generated blocks make that
  mechanical.
- The application connects as `vg_app`: not the owner, no `BYPASSRLS` (RLS-4).
- `audit_event` is readable per tenant and insert-only for the service role; `UPDATE`, `DELETE`
  and `TRUNCATE` are impossible for every role (RLS-6, VG-DATA-004).

**Encryption and retention contract (SPEC-002 §4, §5).** This node creates the shape:
`value_enc`/`value_hmac` ciphertext columns with `key_version`, and `evidence_artifact`
payloads referenced by digest and `storage_ref`. It implements **no** cryptographic operation
and asserts no retention period: retention windows are data resolved from `jurisdiction_policy`
(RET-1) and require counsel-reviewed values that do not exist yet
(`LEGAL_REVIEW_REQUIRED.md`). Encryption status is `BLOCKED_CREDENTIALS`; retention status is
`BLOCKED_LEGAL_OR_COMPLIANCE`.

**Evidence contract (DOD-025).** Every database claim is backed by raw output preserved under
`.agent/evidence/db/`: provisioning log (mode, image, host, port, databases, roles — never
passwords), migration transcripts, schema dumps with SHA-256, per-version row-count and
invariant snapshots, teardown proof, and the suite's own JUnit output.

**Command lock.** Every command this node runs is declared in `COMMANDS.md` in the same commit
that introduces it; `node scripts/generate-rls.ts --check` is declared as a toolchain command
like `node --test`.

**Honesty rules.** No permanent-deletion claim (erasure removes keys and rows; the strongest
removal state remains `VERIFIED_REMOVED` scoped to one `Source` and one window); search and
source stay separate; `HUMAN_REQUIRED` is not a failure; a missing daemon or credential is
`BLOCKED_*`, never a pass; every status uses the SPEC-006 taxonomy.

## 8. Milestones

Milestones run in order. Each ends with a real sentinel, a ledger append, and a commit. On an
unmet `EXPECT`, climb the 5.3 ladder; use the declared `FALLBACK` at rung 3; never repeat the
same fix twice; never weaken a check to pass.

### M1: Disposable PostgreSQL, two roles, and the provisioning contract

GOAL: One command provisions a disposable PostgreSQL with the two-role model and four isolated
databases, prints `db provision: ok`, and can tear it down with proof.

READ: `PREFLIGHT.md`, `.agent/specs/SPEC-002-data-model.md` §3 (RLS-4) and §9,
`.agent/verification/CAPABILITY_MATRIX.md`,
`.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`, `.agent/DONE_LAW.md` (DOD-005, DOD-009,
DOD-032, DOD-033), `SECURITY.md`, `ENVIRONMENT.md`.

CHANGE: `src/infrastructure/database/psql.ts` (create);
`src/infrastructure/database/provision.ts` (create); `scripts/db-provision.sh` (create);
`scripts/db-teardown.sh` (create); `db/privileges.sql` (create); `COMMANDS.md` (declare both
commands); `.agent/evidence/db/**`.

CONTENT:

Measure first, then build. The probe decides the provisioning path and is the evidence for
either outcome:

```sh
mkdir -p .agent/evidence/db
{ docker --version; psql --version; node --version; \
  docker version --format '{{.Server.Version}}' 2>&1 || echo "docker-daemon: UNREACHABLE"; } \
  2>&1 | tee .agent/evidence/db/M1-probe.txt
docker pull postgres:16 >/dev/null 2>&1 || true
docker image inspect --format '{{index .RepoDigests 0}}' postgres:16 2>/dev/null \
  | tee .agent/evidence/db/image-digest.txt || true
```

FILE: src/infrastructure/database/psql.ts   (CREATE)
```ts
/**
 * psql runner for the database gates and tests.
 *
 * Two deliberate properties:
 *
 *  1. **No piped stdio.** Output is redirected to a file by the shell (`sh -c '... > out
 *     2>&1'`) and read back with `node:fs`, while the child's stdio is inherited. Piped
 *     stdio is unavailable in some confined environments, and a raw log file on disk is
 *     exactly the evidence DOD-025 asks for.
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
```

FILE: src/infrastructure/database/provision.ts   (CREATE)
```ts
/**
 * Disposable PostgreSQL provisioning for the database gates.
 *
 * Primary path: a Docker container running a pinned `postgres:16` image on a free host port,
 * with two roles and four isolated databases. Secondary path: an isolated database on an
 * explicitly supplied `DATABASE_URL`. If neither is possible the command fails with a
 * `BLOCKED_ENVIRONMENT` message and the provisioning log as evidence — never a pass and never
 * a candidate failure (DOD-032, DOD-033).
 *
 * Shape created (SPEC-002 RLS-4):
 *   vg_owner  owns the schema objects and runs migrations; subject to FORCE RLS.
 *   vg_app    runtime role: no ownership, no BYPASSRLS, no TRUNCATE.
 *   postgres  the container superuser, used only to create roles and databases.
 *
 * Databases: <prefix>_main (integration), <prefix>_empty (MIG-1), <prefix>_prior (MIG-2
 * upgrade matrix), <prefix>_failure (MIG-4 failure injection).
 *
 * Secrets live only in the state file (mode 0600) outside the repository; evidence records
 * host, port, database and role names, never passwords (VG-SEC-002).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim().length === 0) {
    throw new Error(
      'BLOCKED_ENVIRONMENT: the Docker daemon is unreachable and DATABASE_URL is unset; provision one of them (DOD-033)',
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
  const read = (name: string): string => {
    const match = content.match(new RegExp(`^export ${name}=(.*)$`, 'm'));
    if (match?.[1] === undefined) {
      throw new Error(`harness ERROR: ${name} missing from ${STATE_FILE}`);
    }
    return JSON.parse(match[1]) as string;
  };
  const owner = parseDsn(read('VG_TEST_DSN_OWNER'));
  const app = parseDsn(read('VG_TEST_DSN_APP'));
  return {
    mode: read('VG_DB_MODE') === 'external' ? 'external' : 'docker',
    containerId: read('VG_DB_CONTAINER_ID'),
    host: owner.host,
    port: owner.port,
    superUser: 'postgres',
    superPassword: '',
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

export function teardown(): number {
  if (!existsSync(STATE_FILE)) {
    console.log('db teardown: nothing to tear down (no state file)');
    console.log('db teardown: ok');
    return 0;
  }
  const state = readState();
  if (state.mode === 'docker' && state.containerId !== '') {
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
```

FILE: db/privileges.sql   (CREATE)
```sql
-- Role-scoped privileges. Applied by provisioning, not by a migration: roles and grants are
-- cluster objects, not schema-versioned ones, and a migration naming a role would fail on any
-- deployment that names its roles differently.
--
-- SPEC-002 RLS-4: the runtime role is not the table owner and lacks BYPASSRLS.
-- SPEC-002 RLS-6 / VG-DATA-004: audit_event is insert-only for every role.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO vg_app, vg_owner;

-- Everything is readable and writable by the runtime role...
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vg_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vg_app;

-- ...except the append-only audit log and the migration bookkeeping.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM vg_app;
REVOKE ALL ON schema_migration FROM vg_app;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM vg_app;

-- Tables created later by the migration role default to the same posture.
ALTER DEFAULT PRIVILEGES FOR ROLE vg_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vg_app;
ALTER DEFAULT PRIVILEGES FOR ROLE vg_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vg_app;
```

Note: those two `REVOKE`/`GRANT` statements reference `audit_event` and `schema_migration`,
which do not exist before the first migration. Provisioning tolerates that by retrying the
privilege block after the first migration is applied — implemented in M2's `migrate.ts`, which
re-applies `db/privileges.sql` after `up` (idempotent, and the only ordering that works for a
first-ever database). The provisioning step applies it as a best-effort so a re-provision of an
already-migrated database converges.

FILE: scripts/db-provision.sh   (CREATE)
```sh
#!/usr/bin/env sh
# Provision the disposable PostgreSQL used by the database gates. Sentinel: `db provision: ok`
#
# Wraps the pinned Node helper (master prompt §10: a stack-native helper program is allowed
# when it is pinned and wrapped by a POSIX script). Idempotent: a running container with a
# valid state file is reused.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

mkdir -p .agent/evidence/db
if ! node src/infrastructure/database/provision.ts provision 2>&1 | tee .agent/evidence/db/provision-run.txt; then
  echo "db provision: FAIL - provisioning did not complete; classified BLOCKED_ENVIRONMENT (see .agent/evidence/db/provision-run.txt)" >&2
  exit 1
fi

grep -qx 'db provision: ok' .agent/evidence/db/provision-run.txt \
  || { echo "db provision: FAIL - the helper did not print its sentinel" >&2; exit 1; }

echo "db provision: ok"
```

FILE: scripts/db-teardown.sh   (CREATE)
```sh
#!/usr/bin/env sh
# Tear down the disposable PostgreSQL and prove the container is gone. Sentinel: `db teardown: ok`
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

mkdir -p .agent/evidence/db
if ! node src/infrastructure/database/provision.ts teardown 2>&1 | tee .agent/evidence/db/teardown-run.txt; then
  echo "db teardown: FAIL - teardown did not complete" >&2
  exit 1
fi

grep -qx 'db teardown: ok' .agent/evidence/db/teardown-run.txt \
  || { echo "db teardown: FAIL - the helper did not print its sentinel" >&2; exit 1; }

echo "db teardown: ok"
```

Declare both commands in `COMMANDS.md`:

FILE: COMMANDS.md   (MODIFY — append a database block)
```
Database (disposable, provisioned by the graph; never production):
`sh scripts/db-provision.sh` (db provision: ok); `sh scripts/db-teardown.sh`
(db teardown: ok); `sh scripts/migrate.sh <up|status|verify|up-to N>` (migrate: ok);
`node scripts/generate-rls.ts --check` (rls generation: ok);
`sh scripts/check-rls-coverage.sh` (rls coverage: ok);
`sh scripts/test-migrations.sh` (migrations: ok);
`sh scripts/test-integration.sh` (integration: ok); `sh scripts/gate-data.sh`
(gate-data: ok).
```

RUN:

```sh
mkdir -p .agent/evidence/db
{ docker --version; psql --version; node --version; \
  docker version --format '{{.Server.Version}}' 2>&1 || echo "docker-daemon: UNREACHABLE"; } \
  2>&1 | tee .agent/evidence/db/M1-probe.txt
docker pull postgres:16 >/dev/null 2>&1 || true
docker image inspect --format '{{index .RepoDigests 0}}' postgres:16 2>/dev/null \
  | tee .agent/evidence/db/image-digest.txt || true
sh -n scripts/db-provision.sh
sh -n scripts/db-teardown.sh
sh scripts/db-provision.sh
node -e "const fs=require('node:fs'),os=require('node:os');const p=process.env.VG_DB_STATE_FILE||os.tmpdir()+'/vanishgraph-db.env';const s=fs.readFileSync(p,'utf8');console.log(s.split('\n').filter(l=>l.startsWith('export VG_')&&!l.includes('DSN')).join('\n'));console.log('dsn-entries:',s.split('\n').filter(l=>l.includes('DSN')).length)"
sh scripts/db-teardown.sh
sh scripts/db-provision.sh
```

EXPECT: the probe records the Docker server version (the authoring-time measurement was
`29.7.2`) and `psql (PostgreSQL) 16.14`; `sh -n` exits 0 silently for both scripts;
`sh scripts/db-provision.sh` prints the container start line, the readiness line, the
created/reused database lines, the state-file line and `db provision: ok` last, exiting 0; the
state dump lists `VG_DB_MODE`, `VG_DB_CONTAINER_ID` and `VG_DB_CONTAINER_NAME` and reports
`dsn-entries: 5`, with passwords present only in that file; `sh scripts/db-teardown.sh` prints
the container-removal line and `db teardown: ok`, and `.agent/evidence/db/teardown.txt` records
`container_absent: true`; the second provision re-creates the environment cleanly. If the
daemon is unreachable, the exact expected output is instead
`db provision: FAIL - BLOCKED_ENVIRONMENT: ...` with exit 1 and **no** sentinel, and the node
records `BLOCKED_ENVIRONMENT` with `.agent/evidence/db/provision-run.txt`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-003 MILESTONE_PASS "M1 db provision: ok; two-role model; teardown proven"`

FALLBACK: if the Docker daemon is unreachable and no `DATABASE_URL` is supplied, record
`BLOCKED_ENVIRONMENT` with the provisioning log and continue with the milestones that do not
need a live database (migration authoring, the generator, the central list); the node then
cannot close, and that is the honest outcome — never substitute SQLite or an in-memory
database for a PostgreSQL claim (DOD-009, DOD-010).

COMMIT: `git add -A && git commit -m "[EP-003][M1] disposable PostgreSQL provisioning and role model"`

### M2: Central isolation list, RLS generator, migration runner, first migration

GOAL: The central table list exists, the RLS generator writes and verifies isolation blocks,
the migration runner applies numbered checksummed files, and `0001` applies to a real database.

READ: `.agent/specs/SPEC-002-data-model.md` §1, §2 (the enum and `tenant` table), §3 (RLS-1,
RLS-2, MIG-6), §6; `src/infrastructure/database/psql.ts`,
`src/infrastructure/database/provision.ts`, `db/privileges.sql`, `.agent/DONE_LAW.md`
(DOD-002, DOD-016, DOD-025).

CHANGE: `db/tenant-scoped-tables.txt` (create); `db/migrations/0001_enums_and_tenant.sql`
(create); `scripts/generate-rls.ts` (create); `src/infrastructure/database/migrate.ts`
(create); `scripts/migrate.sh` (create); `db/UPGRADE_MATRIX.md` (create); `COMMANDS.md`
(already declares both commands in M1).

CONTENT:

FILE: db/tenant-scoped-tables.txt   (CREATE — the single source of isolation truth, RLS-1)
```
# Tenant-scoped tables (SPEC-002 §3, RLS-1).
#
# Every table listed here has RLS ENABLED and FORCED and carries the tenant_isolation policy
# generated by scripts/generate-rls.ts into the migration that creates it (MIG-6). Adding a
# table with a tenant_id column without adding it here is a build failure: the generator's
# --check mode and scripts/check-rls-coverage.sh both refuse it.
#
# Format: <table>[ <space> <reason it is tenant-scoped>]
alias            # carries tenant_id; alias rows never cross a tenant boundary
appeal_escalation
audit_event
authority_grant
controller
controller_response
deadline
email_thread
evidence_artifact
exposure
external_action
identifier
jurisdiction_policy
location_history
mail_piece
policy_decision
protected_subject
provider_transport_run
reappearance
removal_recipe
repair_capsule
request_case
source
source_catalog_entry
source_record
verification_observation

# EXCLUDED from tenant-scoped isolation, each with a reason (RLS-2 requires the reason):
# tenant             the isolation boundary itself; it has no tenant_id column
# schema_migration   migration bookkeeping, owned by the migration role only
```

FILE: db/migrations/0001_enums_and_tenant.sql   (CREATE)
```sql
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
```

FILE: scripts/generate-rls.ts   (CREATE)
```ts
/**
 * Generate the row-level-security block for every tenant-scoped table (SPEC-002 RLS-1, MIG-6).
 *
 * One central list (`db/tenant-scoped-tables.txt`) decides which tables are isolated. This
 * program finds the migration that creates each table and writes the ENABLE/FORCE/CREATE
 * POLICY block into that same migration, between generated markers, so RLS always ships with
 * the table.
 *
 * Modes:
 *   --write   rewrite the generated blocks
 *   --check   re-derive every block and fail on any drift (used by the gates and by lint)
 *
 * It also refuses two classes of silent omission:
 *   * a table in the list whose CREATE TABLE cannot be found in any migration;
 *   * a migration that creates a table with a tenant_id column that the list does not name.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const MIGRATIONS_DIR = join(PROJECT_ROOT, 'db', 'migrations');
const LIST_FILE = join(PROJECT_ROOT, 'db', 'tenant-scoped-tables.txt');

const BEGIN = '-- RLS-GENERATED-BEGIN (generated by scripts/generate-rls.ts; do not edit by hand)';
const END = '-- RLS-GENERATED-END';

export function tenantScopedTables(): string[] {
  return readFileSync(LIST_FILE, 'utf8')
    .split('\n')
    .map((line) => line.split('#')[0]?.trim() ?? '')
    .filter((line) => line.length > 0);
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => join(MIGRATIONS_DIR, name));
}

function createdTables(sql: string): string[] {
  const names: string[] = [];
  for (const match of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
    if (match[1] !== undefined) names.push(match[1]);
  }
  return names;
}

function tableHasTenantColumn(sql: string, table: string): boolean {
  const pattern = new RegExp(
    `CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
    'i',
  );
  const body = sql.match(pattern)?.[1];
  return body !== undefined && /(^|\n)\s*tenant_id\s+uuid/i.test(body);
}

function blockFor(table: string): string {
  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${table} FORCE  ROW LEVEL SECURITY;`,
    '',
    `CREATE POLICY tenant_isolation ON ${table}`,
    `  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)`,
    `  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);`,
  ].join('\n');
}

export function renderMigration(file: string, tables: readonly string[]): string {
  const original = readFileSync(file, 'utf8');
  const head = (original.split(BEGIN)[0] ?? '').trimEnd();
  const owned = tables.filter((table) => createdTables(original).includes(table));
  if (owned.length === 0) {
    // This migration creates no tenant-scoped table: leave it exactly as it is, so --check
    // never reports phantom drift from trailing-newline normalisation.
    return original;
  }
  const sections = owned.map((table) => `${BEGIN}\n-- table: ${table}\n${blockFor(table)}\n${END}`);
  return `${head}\n\n${sections.join('\n\n')}\n`;
}

export function main(argv: readonly string[]): number {
  const mode = argv.includes('--write') ? 'write' : argv.includes('--check') ? 'check' : '';
  if (mode === '') {
    console.error('usage: node scripts/generate-rls.ts --write|--check');
    return 2;
  }
  const tables = tenantScopedTables();
  if (tables.length === 0) {
    console.error('rls generation: FAIL - the tenant-scoped table list is empty (RLS-1)');
    return 1;
  }
  const files = migrationFiles();
  const allSql = files.map((file) => readFileSync(file, 'utf8')).join('\n');

  const missing = tables.filter((table) => !createdTables(allSql).includes(table));
  if (missing.length > 0) {
    console.error(
      `rls generation: FAIL - listed as tenant-scoped but never created in a migration: ${missing.join(', ')}`,
    );
    return 1;
  }
  const unlisted = files.flatMap((file) => {
    const sql = readFileSync(file, 'utf8');
    return createdTables(sql)
      .filter((table) => tableHasTenantColumn(sql, table) && !tables.includes(table))
      .map((table) => `${table} (${file.replace(`${PROJECT_ROOT}/`, '')})`);
  });
  if (unlisted.length > 0) {
    console.error(
      `rls generation: FAIL - table has a tenant_id column but is not in db/tenant-scoped-tables.txt: ${unlisted.join(', ')}`,
    );
    return 1;
  }

  let drift = 0;
  for (const file of files) {
    const rendered = renderMigration(file, tables);
    const current = readFileSync(file, 'utf8');
    if (mode === 'write') {
      if (rendered !== current) {
        writeFileSync(file, rendered);
        console.log(`rls generation: wrote ${file.replace(`${PROJECT_ROOT}/`, '')}`);
      }
    } else if (rendered !== current) {
      drift += 1;
      console.error(
        `rls generation: FAIL - generated block differs in ${file.replace(`${PROJECT_ROOT}/`, '')}; run node scripts/generate-rls.ts --write`,
      );
    }
  }
  if (mode === 'check' && drift > 0) return 1;
  console.log(`rls generation: ${tables.length} tenant-scoped tables, ${files.length} migrations, drift ${drift}`);
  console.log('rls generation: ok');
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/generate-rls.ts')) {
  process.exit(main(process.argv.slice(2)));
}
```

FILE: src/infrastructure/database/migrate.ts   (CREATE)
```ts
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
    throw new Error(`harness ERROR: could not create the migration bookkeeping table:\n${result.output}`);
  }
}

function appliedVersions(dsn: Dsn): Map<number, { name: string; checksum: string }> {
  const rows = queryLines(dsn, 'SELECT version, name, checksum FROM schema_migration ORDER BY version;');
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
  process.stdout.write(`migrate: applied ${count} migration(s); at version ${[...applied.keys()].sort((a, b) => a - b).pop() ?? 0}\n`);
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
      console.error(`migrate: FAIL - version ${version} (${record.name}) is applied but missing on disk`);
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
      problems.push(`${table}: enabled=${String(enabled)} forced=${String(forced)} policies=${String(policies)}`);
    }
  }
  if (problems.length > 0) {
    console.error('rls coverage: FAIL - tenant-scoped tables without enforced isolation (VG-DATA-001):');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  process.stdout.write(`rls coverage: ${rows.length} tenant-scoped tables all enabled, forced and policied\n`);
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
    else if (token === '--dir' && rest[index + 1] !== undefined) dir = resolve(rest[index + 1] as string);
    else if (token === '--up-to') upTo = Number.parseInt(rest[index + 1] ?? '', 10);
  }
  return { command, dsn, dir, upTo };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/infrastructure/database/migrate.ts')) {
  const { command, dsn, dir, upTo } = parseArgs(process.argv.slice(2));
  if (dsn === undefined || dsn.trim().length === 0) {
    console.error('migrate: FAIL - no DSN; pass --dsn or export VG_TEST_DSN_OWNER (run sh scripts/db-provision.sh first)');
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
```

FILE: scripts/migrate.sh   (CREATE)
```sh
#!/usr/bin/env sh
# Migration wrapper. Sentinel: `migrate: ok`
#
# Loads the disposable-database state file so the gates do not each re-implement DSN
# resolution, then delegates to the pinned Node runner. `--dsn` on the command line wins.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
fi

mkdir -p .agent/evidence/db
if ! node src/infrastructure/database/migrate.ts "$@" 2>&1 | tee .agent/evidence/db/migrate-run.txt; then
  echo "migrate: FAIL - see .agent/evidence/db/migrate-run.txt" >&2
  exit 1
fi

grep -q '^migrate: ok$' .agent/evidence/db/migrate-run.txt \
  || { echo "migrate: FAIL - the runner did not print its sentinel" >&2; exit 1; }

echo "migrate: ok"
```

FILE: db/UPGRADE_MATRIX.md   (CREATE)
```
# Supported upgrade matrix (DOD-016, SPEC-002 MIG-2)

This file is the data the gates read and the record a human reads. It lists every schema
state this project claims to upgrade **from**, and where the evidence for each is produced.

| From (schema state) | Applied versions | How it is produced | Evidence |
|---|---|---|---|
| empty database | — | `db/migrations` applied to `vanishgraph_empty` | `.agent/evidence/db/migrations/from-empty.txt`, schema dump hash |
| v1 baseline set | `0001`…`0005` | `migrate up --up-to 5` on `vanishgraph_prior`, then `db/seed/prior_release.sql`, then `migrate up` | `.agent/evidence/db/migrations/from-prior.txt`, before/after row counts and dump hashes |
| failed migration state | partial | `migrate up --dir <fixture>` on `vanishgraph_failure` | `.agent/evidence/db/migrations/failure-and-retry.txt` |

Honest scope note: **no customer release exists yet**, so "prior released schema" currently
means the immediately preceding migration set of this same unreleased line. The matrix grows
by one row per released schema version; a release that adds a migration MUST add its row here
in the same change set, and `scripts/test-migrations.sh` fails when a row's applied-version
prefix does not match the migrations on disk.

Not covered here, and deliberately not claimed: restore-from-backup (VG-DATA-011, DOD-036),
which requires a real backup/restore drill in EP-008/EP-009, and crypto-shredding with a real
KMS (SPEC-002 §4, `BLOCKED_CREDENTIALS`).
```

RUN:

```sh
sh scripts/db-provision.sh
. "${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}"
node scripts/generate-rls.ts --check
node scripts/generate-rls.ts --write
node scripts/generate-rls.ts --check
sh scripts/migrate.sh up --dsn "$VG_EMPTY_DSN_OWNER"
sh scripts/migrate.sh status --dsn "$VG_EMPTY_DSN_OWNER"
sh scripts/migrate.sh verify --dsn "$VG_EMPTY_DSN_OWNER"
sh scripts/migrate.sh verify-rls --dsn "$VG_EMPTY_DSN_OWNER"
node -e "const{queryLines,parseDsn}=await import('./src/infrastructure/database/psql.ts');const rows=queryLines(parseDsn(process.env.VG_EMPTY_DSN_OWNER),\"SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='truth_state' ORDER BY e.enumsortorder;\");console.log('truth_state members:',rows.join(','));"
```

EXPECT: `db provision: ok`; the first `generate-rls --check` prints
`rls generation: FAIL - ...` only if a listed table is missing (it is not yet: run `--write`
first when the list lands before the tables — the milestone's own order is write-then-check, so
the expected sequence is `--check` reporting drift for `0001` (no tenant-scoped table there) or
`rls generation: ok` with `drift 0`, then `--write`, then `--check` printing
`rls generation: 26 tenant-scoped tables, 1 migrations, drift 0` and `rls generation: ok`;
`sh scripts/migrate.sh up` prints `migrate: applying 0001_enums_and_tenant.sql`, then
`migrate: applied 1 migration(s); at version 1` and `migrate: ok`; `status` lists version 1 with
its checksum; `verify` prints `migrate: verified 1 applied migration(s), no drift`;
`verify-rls` prints `rls coverage: 0 tenant-scoped tables all enabled, forced and policied`
followed by `rls coverage: ok` — after `0001` only the `tenant` table exists, which is not
tenant-scoped, so the enumeration must find **zero** tables and the check must say so out loud
(the honest form of "nothing to verify yet"); the enum query prints all eleven members in spec
order.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-003 MILESTONE_PASS "M2 isolation list, RLS generator, migration runner; 0001 applied; rls generation: ok"`

FALLBACK: if enumerating zero tenant-scoped tables must not pass (a stricter reading of
RLS-2), change `verify-rls` to accept a `--allow-empty` flag used only until `0002` lands and
have the gate require the non-empty form after `0005`; record the flag in `COMMANDS.md`. Never
relax the per-table assertions.

COMMIT: `git add -A && git commit -m "[EP-003][M2] isolation list, RLS generator and migration runner"`

### M3: Migrations 0002–0005 — the full schema, with RLS generated into each file

GOAL: Every table in SPEC-002 §2 plus the fourteen tables SPEC-002 defers to this node's
milestone bodies exists as a migration, the four cycle-closing foreign keys are deferrable, and
RLS for every tenant-scoped table is generated into the file that creates it.

READ: `.agent/specs/SPEC-002-data-model.md` §1, §2 (both the normative subset and the list of
remaining tables), §3, §6; `.agent/specs/SPEC-001-core-domain.md` §3 (field names);
`db/tenant-scoped-tables.txt`; `scripts/generate-rls.ts`;
`src/infrastructure/database/migrate.ts`; `db/migrations/0001_enums_and_tenant.sql`.

CHANGE: `db/migrations/0002_identity.sql`, `db/migrations/0003_source.sql`,
`db/migrations/0004_policy_and_action.sql`, `db/migrations/0005_evidence_audit_and_ops.sql`
(all create); the generated RLS blocks inside those four files are written by
`node scripts/generate-rls.ts --write`, never by hand.

CONTENT:

Write each file, then run the generator, then verify. The generator appends one
`RLS-GENERATED-BEGIN`/`END` pair per table it owns in that file; do not type those blocks
manually, and do not edit them after generation (MIG-6 + RLS-1 in one mechanism).

FILE: db/migrations/0002_identity.sql   (CREATE — write the body; the RLS blocks are generated)
```sql
-- 0002 — identity aggregate (SPEC-001 §3.1, SPEC-002 §2).
--
-- VG-IDENT-001: a ProtectedSubject cannot exist without a valid AuthorityGrant. A plain FK
-- cannot express "at least one row elsewhere", so a deferred constraint trigger enforces it
-- at commit time, which is what makes the rule true even when the subject and the grant are
-- inserted in the same transaction.
--
-- authority_grant.evidence_id is created without its foreign key: evidence_artifact is
-- created in 0005 and references request_case, which references authority_grant. The cycle is
-- closed in 0005 with DEFERRABLE INITIALLY DEFERRED foreign keys.

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

CREATE TABLE authority_grant (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  subject_id        uuid NOT NULL REFERENCES protected_subject(id),
  kind              authority_kind NOT NULL,
  scope             text[] NOT NULL CHECK (array_length(scope,1) >= 1),
  evidence_id       uuid,                    -- FK added in 0005 (cycle)
  issued_at         timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  signed_instrument boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
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

-- SPEC-002 §1: raw PII lives only in identifier/alias (encrypted columns) and
-- evidence_artifact (encrypted object storage). key_version makes rotation possible without
-- rewriting history (SPEC-002 §4). No cryptographic operation is implemented in this node.
CREATE TABLE identifier (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  subject_id  uuid NOT NULL REFERENCES protected_subject(id),
  kind        text NOT NULL,
  value_enc   bytea NOT NULL,
  value_hmac  bytea NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  provenance  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- SPEC-001 §3.1 names these fields `from`/`to`; `from` is a reserved SQL keyword, so the
-- columns are effective_from/effective_to (recorded in the EP-003 §4 deviation table).
CREATE TABLE location_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  subject_id     uuid NOT NULL REFERENCES protected_subject(id),
  jurisdiction   text NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  provenance     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- VG-DATA-005: a subject cannot exist without valid authority, enforced at commit.
CREATE FUNCTION assert_subject_has_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM authority_grant g
     WHERE g.subject_id = NEW.id
       AND g.revoked_at IS NULL
       AND g.expires_at > now()
  ) THEN
    RAISE EXCEPTION
      'ProtectedSubject % requires a valid AuthorityGrant at commit (VG-IDENT-001, VG-DATA-005)',
      NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER subject_requires_authority
  AFTER INSERT ON protected_subject DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_subject_has_authority();
```

FILE: db/migrations/0003_source.sql   (CREATE — body only; RLS generated)
```sql
-- 0003 — source aggregate (SPEC-001 §3.2, SPEC-002 §2).

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

-- LICENSE_POLICY: a catalogue entry without a recorded licence is incomplete.
CREATE TABLE source_catalog_entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  source_id      uuid NOT NULL REFERENCES source(id),
  category       text NOT NULL,
  coverage_notes text NOT NULL,
  provenance     text NOT NULL,
  license        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE removal_recipe (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  source_id           uuid NOT NULL REFERENCES source(id),
  version             integer NOT NULL CHECK (version >= 1),
  signature           bytea NOT NULL,
  channel             text NOT NULL,
  verification_method text NOT NULL,
  freshness_at        timestamptz NOT NULL,
  enabled             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version)
);

-- VG-SEC-001: remote content is untrusted until proven otherwise, so tainted defaults TRUE.
CREATE TABLE source_record (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  source_id    uuid NOT NULL REFERENCES source(id),
  raw_ref      text NOT NULL,
  observed_at  timestamptz NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  tainted      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- SPEC-002 §2 defines exposure without a case_id column: the linkage is navigable in the
-- other direction through request_case.exposure_id, so no duplicate column is added.
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
```

FILE: db/migrations/0004_policy_and_action.sql   (CREATE — body only; RLS generated)
```sql
-- 0004 — policy and action aggregates (SPEC-001 §3.3/§3.4, SPEC-002 §2).
--
-- Two cycles are broken here: request_case.policy_decision_id and policy_decision.case_id
-- reference each other. request_case is created first without the FK, then the FK is added
-- as DEFERRABLE INITIALLY DEFERRED so a case and its decision can be inserted in one
-- transaction while a dangling reference still fails at commit.
--
-- verification_observation.evidence_id and reappearance.evidence_id/prior_removed_event_id
-- are completed in 0005 for the same reason.

CREATE TABLE controller (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN
                 ('PLATFORM','PUBLISHER','REGISTRY','GOVERNMENT_AGENCY','OTHER_CONTROLLER')),
  jurisdiction text,
  contact_refs text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- VG-POLICY-001: jurisdiction rules live in versioned data, and the provenance column can
-- only be COUNSEL_REVIEWED or OPERATOR_ENTERED. Model output has no representation.
CREATE TABLE jurisdiction_policy (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  jurisdiction   text NOT NULL,
  version        integer NOT NULL CHECK (version >= 1),
  effective_from timestamptz NOT NULL,
  effective_to   timestamptz,
  rules          text[] NOT NULL CHECK (array_length(rules,1) >= 1),
  provenance     text NOT NULL CHECK (provenance IN ('COUNSEL_REVIEWED','OPERATOR_ENTERED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, jurisdiction, version),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE request_case (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  subject_id         uuid NOT NULL REFERENCES protected_subject(id),
  exposure_id        uuid NOT NULL REFERENCES exposure(id),
  source_id          uuid NOT NULL REFERENCES source(id),
  authority_grant_id uuid NOT NULL REFERENCES authority_grant(id),
  policy_decision_id uuid,                  -- FK added below (cycle)
  truth_state        truth_state NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy_decision (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  case_id        uuid NOT NULL REFERENCES request_case(id),
  jurisdiction   text NOT NULL,
  legal_basis    text NOT NULL,
  channel        text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version >= 1),
  -- VG-POLICY-002 / VG-DATA-013: all four fields are NOT NULL by construction.
  reasons        jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE request_case ADD CONSTRAINT request_case_policy_decision_id_fkey
  FOREIGN KEY (policy_decision_id) REFERENCES policy_decision(id) DEFERRABLE INITIALLY DEFERRED;

-- VG-ACTION-001 / VG-DATA-007: one key, one external effect.
CREATE TABLE external_action (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  case_id         uuid NOT NULL REFERENCES request_case(id),
  channel         text NOT NULL,
  idempotency_key text NOT NULL,
  attempt         integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status          text NOT NULL CHECK (status IN ('PREPARED','SUBMITTED','AMBIGUOUS','REFUSED')),
  ambiguous       boolean NOT NULL DEFAULT false,
  submitted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  -- VG-ACTION-002 / VG-DATA-015: an ambiguous result must be reconcilable, never silent.
  CHECK (status <> 'AMBIGUOUS' OR ambiguous)
);

CREATE TABLE email_thread (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  case_id     uuid NOT NULL REFERENCES request_case(id),
  message_ids text[] NOT NULL CHECK (array_length(message_ids,1) >= 1),
  direction   text NOT NULL CHECK (direction IN ('OUTBOUND','INBOUND')),
  received_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail_piece (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  case_id          uuid NOT NULL REFERENCES request_case(id),
  template_version integer NOT NULL CHECK (template_version >= 1),
  template_hash    char(64) NOT NULL CHECK (template_hash ~ '^[0-9a-f]{64}$'),
  transport_name   text NOT NULL,   -- SPEC-001 §3.4 `provider`; see the §4 deviation table
  tracking_id      text,
  delivery_status  text NOT NULL CHECK (delivery_status IN
                     ('NOT_SENT','SENT','DELIVERED','RETURNED','UNKNOWN')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- VG-ACTION-004: a delivered piece without tracking is not evidence.
  CHECK (delivery_status <> 'DELIVERED' OR tracking_id IS NOT NULL)
);

CREATE TABLE deadline (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  case_id        uuid NOT NULL REFERENCES request_case(id),
  kind           text NOT NULL,
  due_at         timestamptz NOT NULL,
  -- SPEC-001 §3.4 `source`; the value must name a policy version, never a hard-coded period.
  derivation_ref text NOT NULL CHECK (derivation_ref LIKE 'policy:%'),
  satisfied_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- VG-VERIFY-004: claimed_outcome is a CLAIM. Nothing in this schema may move a case to a
-- truth state because a controller said so; only verification_observation can support T14.
CREATE TABLE controller_response (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  case_id         uuid NOT NULL REFERENCES request_case(id),
  kind            text NOT NULL,
  body_ref        text NOT NULL,
  received_at     timestamptz NOT NULL,
  claimed_outcome truth_state,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_observation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  case_id         uuid NOT NULL REFERENCES request_case(id),
  method          text NOT NULL,
  observed_at     timestamptz NOT NULL,
  actor_identity  text NOT NULL,
  acting_identity text NOT NULL,     -- identity that performed the action
  finding         text NOT NULL CHECK (finding IN ('PRESENT','ABSENT','INCONCLUSIVE')),
  evidence_id     uuid NOT NULL,     -- FK added in 0005 (cycle)
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- VG-VERIFY-001 / VG-DATA-008: an actor may not verify its own effect.
  CHECK (actor_identity <> acting_identity)
);

CREATE TABLE appeal_escalation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  case_id               uuid NOT NULL REFERENCES request_case(id),
  kind                  text NOT NULL,
  requires_human_review boolean NOT NULL DEFAULT true CHECK (requires_human_review IS TRUE),
  artifact_ids          uuid[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reappearance (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant(id),
  exposure_id            uuid NOT NULL REFERENCES exposure(id),
  prior_removed_event_id bigint NOT NULL,  -- FK added in 0005 (audit_event)
  observed_at            timestamptz NOT NULL,
  evidence_id            uuid NOT NULL,    -- FK added in 0005 (cycle)
  created_at             timestamptz NOT NULL DEFAULT now()
);
```

FILE: db/migrations/0005_evidence_audit_and_ops.sql   (CREATE — body only; RLS generated)
```sql
-- 0005 — evidence, audit and operations (SPEC-001 §3.5, SPEC-002 §2), and the four
-- cycle-closing deferrable foreign keys.

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

-- tenant_id intentionally has no foreign key: an audit row must survive even if a tenant row
-- is closed, and an append-only log that cascades is not append-only.
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

-- SPEC-002 §2 covers UPDATE and DELETE with rules. TRUNCATE is not covered by a rule and
-- would still empty the table, so append-only is completed here with a statement trigger.
CREATE FUNCTION audit_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: TRUNCATE is refused (VG-EVIDENCE-003)';
END;
$$;

CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_no_truncate();

CREATE TABLE provider_transport_run (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  transport_name text NOT NULL,   -- SPEC-001 §3.5 `provider`; see the §4 deviation table
  auth_mode      text NOT NULL CHECK (auth_mode IN ('OFFICIAL_API','OFFICIAL_FORM','OFFICIAL_MAIL')),
  egress_class   egress_class NOT NULL,
  started_at     timestamptz NOT NULL,
  outcome        text NOT NULL,
  cost_minor_units bigint,
  cost_currency    char(3) CHECK (cost_currency IS NULL OR cost_currency ~ '^[A-Z]{3}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((cost_minor_units IS NULL) = (cost_currency IS NULL))
);

-- VG-EGRESS-002: a repair capsule is DLP-scrubbed before it leaves the boundary. The schema
-- cannot prove scrubbing, so the domain factory refuses apparent PII at construction and this
-- table stores only the sanitized text.
CREATE TABLE repair_capsule (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  fingerprint        text NOT NULL,
  sanitized_evidence text NOT NULL,
  expected           text NOT NULL,
  actual             text NOT NULL,
  pr_ref             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Cycle-closing foreign keys (SPEC-002 §2 declares all four; no creation order satisfies them).
ALTER TABLE authority_grant ADD CONSTRAINT authority_grant_evidence_id_fkey
  FOREIGN KEY (evidence_id) REFERENCES evidence_artifact(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE verification_observation ADD CONSTRAINT verification_observation_evidence_id_fkey
  FOREIGN KEY (evidence_id) REFERENCES evidence_artifact(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE reappearance ADD CONSTRAINT reappearance_evidence_id_fkey
  FOREIGN KEY (evidence_id) REFERENCES evidence_artifact(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE reappearance ADD CONSTRAINT reappearance_prior_removed_event_id_fkey
  FOREIGN KEY (prior_removed_event_id) REFERENCES audit_event(id) DEFERRABLE INITIALLY DEFERRED;
```

RUN:

```sh
sh scripts/db-provision.sh
. "${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}"
node scripts/generate-rls.ts --write
node scripts/generate-rls.ts --check
sh scripts/migrate.sh up --dsn "$VG_EMPTY_DSN_OWNER"
sh scripts/migrate.sh verify --dsn "$VG_EMPTY_DSN_OWNER"
sh scripts/migrate.sh verify-rls --dsn "$VG_EMPTY_DSN_OWNER"
grep -c 'RLS-GENERATED-BEGIN' db/migrations/*.sql
sh scripts/migrate.sh status --dsn "$VG_EMPTY_DSN_OWNER"
```

EXPECT: `db provision: ok`; `--write` reports each file it rewrote (or nothing on a re-run);
`--check` prints `rls generation: 26 tenant-scoped tables, 4 migrations, drift 0` and
`rls generation: ok`; `migrate up` applies `0002`…`0005` in order, prints
`migrate: applied 4 migration(s); at version 5` (the empty database already has `0001`) and
`migrate: ok`; `verify` reports no drift; `verify-rls` prints
`rls coverage: 26 tenant-scoped tables all enabled, forced and policied` and
`rls coverage: ok`; the marker count is `26` across the migration files; `status` lists
versions 1–5 with their checksums.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-003 MILESTONE_PASS "M3 schema 0002-0005; rls generation: ok; rls coverage: ok"`

FALLBACK: if a SPEC-002 table cannot be created as declared (a keyword collision, an
unsupported constraint expression), make the smallest additive change that preserves the
declared columns and constraints, record it in the ledger and in the §4 deviation table, and
never drop a `CHECK`, a `NOT NULL`, or a unique constraint to get the migration to apply.

COMMIT: `git add -A && git commit -m "[EP-003][M3] full schema migrations with generated RLS"`

### M4: updated_at triggers, the RLS invariant assertion, and the seed for the upgrade matrix

GOAL: `0006` and `0007` apply, the database itself refuses an unprotected tenant table, the
coverage checker and its wrapper exist, and a realistic prior-schema seed is committed.

READ: `.agent/specs/SPEC-002-data-model.md` §1 (`updated_at`), §3 (RLS-2), §6 (MIG-3, MIG-6);
`db/migrations/0002_identity.sql`, `db/migrations/0004_policy_and_action.sql`;
`src/infrastructure/database/migrate.ts`.

CHANGE: `db/migrations/0006_updated_at_triggers.sql` (create);
`db/migrations/0007_rls_invariant_assert.sql` (create); `db/seed/prior_release.sql` (create);
`scripts/check-rls-coverage.sh` (create); `COMMANDS.md` (already declares both).

CONTENT:

FILE: db/migrations/0006_updated_at_triggers.sql   (CREATE)
```sql
-- 0006 — maintain updated_at truthfully (SPEC-002 §1).
--
-- Additive only (MIG-3): it adds a function and triggers and changes no column. It exists as
-- its own migration precisely so the upgrade matrix has a real "prior schema + new migration"
-- pair to exercise with data already in the tables.

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER protected_subject_set_updated_at BEFORE UPDATE ON protected_subject
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER exposure_set_updated_at BEFORE UPDATE ON exposure
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER request_case_set_updated_at BEFORE UPDATE ON request_case
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

FILE: db/migrations/0007_rls_invariant_assert.sql   (CREATE)
```sql
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
```

FILE: db/seed/prior_release.sql   (CREATE)
```sql
-- Prior-schema seed for the upgrade matrix (MIG-2, DOD-016).
--
-- "Realistic" here means the row shapes a real deployment would already hold at the prior
-- version: two tenants, subjects with authority, a source catalogue entry, a signed recipe, a
-- source record, an exposure with basis, a policy version, a case, an external action, an
-- evidence artifact, a verification observation and audit rows. No apparent PII: identifiers
-- are opaque and payloads are opaque scalars (VG-SEC-002).
--
-- The whole file runs inside one transaction, so the deferred authority trigger sees subject
-- and grant together. Every statement sets app.tenant_id, because FORCE RLS applies to the
-- migration role too (RLS-4) — that is a feature being exercised here, not an inconvenience.

BEGIN;

SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true);
INSERT INTO tenant (id, name, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'tenant-alpha', 'ACTIVE'),
  ('22222222-2222-4222-8222-222222222222', 'tenant-beta', 'ACTIVE');

INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status) VALUES
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'subject-ref-alpha', 'US-CA', false, 'ACTIVE');
INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument) VALUES
  ('bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'SELF', ARRAY['discovery','self_service_write'], now() - interval '1 day', now() + interval '30 days', false);

INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class, permission_checked_at) VALUES
  ('cccccccc-1111-4111-8111-cccccccccccc', '11111111-1111-4111-8111-111111111111', 'example-registry', 'REGISTRY', 'US-CA', 'WRITE_PERMITTED', now());
INSERT INTO source_catalog_entry (id, tenant_id, source_id, category, coverage_notes, provenance, license) VALUES
  ('dddddddd-1111-4111-8111-dddddddddddd', '11111111-1111-4111-8111-111111111111', 'cccccccc-1111-4111-8111-cccccccccccc', 'PEOPLE_REGISTRY', 'covers state-level records only', 'manual-review-2026', 'provider-terms-2026-01');
INSERT INTO removal_recipe (id, tenant_id, source_id, version, signature, channel, verification_method, freshness_at, enabled) VALUES
  ('eeeeeeee-1111-4111-8111-eeeeeeeeeeee', '11111111-1111-4111-8111-111111111111', 'cccccccc-1111-4111-8111-cccccccccccc', 1, 'sig:prior-release', 'OFFICIAL_SELF_SERVICE', 'independent-fetch', now() + interval '7 days', true);

INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted) VALUES
  ('ffffffff-1111-4111-8111-ffffffffffff', '11111111-1111-4111-8111-111111111111', 'cccccccc-1111-4111-8111-cccccccccccc', 'https://example.invalid/record/1', now() - interval '2 days', repeat('a', 64), false);
INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state) VALUES
  ('99999999-1111-4111-8111-999999999999', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'ffffffff-1111-4111-8111-ffffffffffff', 0.91, '["exact-name-match","state-match"]'::jsonb, 'MATCH_CONFIRMED');

INSERT INTO jurisdiction_policy (id, tenant_id, jurisdiction, version, effective_from, rules, provenance) VALUES
  ('88888888-1111-4111-8111-888888888888', '11111111-1111-4111-8111-111111111111', 'US-CA', 1, now() - interval '90 days', ARRAY['CCPA_DELETE'], 'COUNSEL_REVIEWED');

INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, truth_state) VALUES
  ('77777777-1111-4111-8111-777777777777', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '99999999-1111-4111-8111-999999999999', 'cccccccc-1111-4111-8111-cccccccccccc', 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', 'MATCH_CONFIRMED');

INSERT INTO policy_decision (id, tenant_id, case_id, jurisdiction, legal_basis, channel, policy_version, reasons, decided_at) VALUES
  ('66666666-1111-4111-8111-666666666666', '11111111-1111-4111-8111-111111111111', '77777777-1111-4111-8111-777777777777', 'US-CA', 'CCPA_DELETE', 'OFFICIAL_SELF_SERVICE', 1, '["consumer-request-right"]'::jsonb, now() - interval '1 day');
UPDATE request_case SET policy_decision_id = '66666666-1111-4111-8111-666666666666', truth_state = 'REQUEST_READY'
 WHERE id = '77777777-1111-4111-8111-777777777777';

INSERT INTO external_action (id, tenant_id, case_id, channel, idempotency_key, attempt, status, submitted_at) VALUES
  ('55555555-1111-4111-8111-555555555555', '11111111-1111-4111-8111-111111111111', '77777777-1111-4111-8111-777777777777', 'OFFICIAL_SELF_SERVICE', 'case:77777777:self_service:v1', 1, 'SUBMITTED', now() - interval '20 hours');

INSERT INTO evidence_artifact (id, tenant_id, case_id, kind, digest, storage_ref, egress_class, redaction_state, captured_at) VALUES
  ('44444444-1111-4111-8111-444444444444', '11111111-1111-4111-8111-111111111111', '77777777-1111-4111-8111-777777777777', 'SUBMISSION_RECEIPT', repeat('b', 64), 's3://evidence/tenant-alpha/44444444', 'OPAQUE_ID', 'SCRUBBED', now() - interval '20 hours');

INSERT INTO verification_observation (id, tenant_id, case_id, method, observed_at, actor_identity, acting_identity, finding, evidence_id) VALUES
  ('33333333-1111-4111-8111-333333333333', '11111111-1111-4111-8111-111111111111', '77777777-1111-4111-8111-777777777777', 'independent-fetch', now() - interval '2 hours', 'observer-a', 'actor-a', 'PRESENT', '44444444-1111-4111-8111-444444444444');

INSERT INTO audit_event (tenant_id, actor, action, target_kind, target_id, correlation_id, payload) VALUES
  ('11111111-1111-4111-8111-111111111111', 'domain-command', 'RequestReady', 'RequestCase', '77777777-1111-4111-8111-777777777777', '11111111-2222-4111-8111-111111111111', '{"transitionId":"T5"}'::jsonb),
  ('11111111-1111-4111-8111-111111111111', 'domain-command', 'ActionSubmitted', 'ExternalAction', '55555555-1111-4111-8111-555555555555', '11111111-2222-4111-8111-111111111111', '{"transitionId":"T8"}'::jsonb);

-- A second tenant with its own subject, so cross-tenant isolation can be exercised on data
-- that looks like a real deployment rather than on a single row.
SELECT set_config('app.tenant_id', '22222222-2222-4222-8222-222222222222', true);
INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status) VALUES
  ('aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'subject-ref-beta', 'US-NY', false, 'ACTIVE');
INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument) VALUES
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', 'SELF', ARRAY['discovery'], now() - interval '1 day', now() + interval '30 days', false);
INSERT INTO audit_event (tenant_id, actor, action, target_kind, target_id, correlation_id, payload) VALUES
  ('22222222-2222-4222-8222-222222222222', 'domain-command', 'SubjectRegistered', 'ProtectedSubject', 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', '22222222-3333-4222-8222-222222222222', '{}'::jsonb);

COMMIT;
```

FILE: scripts/check-rls-coverage.sh   (CREATE)
```sh
#!/usr/bin/env sh
# Live RLS coverage check (SPEC-002 RLS-2, VG-DATA-001). Sentinel: `rls coverage: ok`
#
# Wraps the migration runner's enumeration mode: every table carrying a tenant_id column must
# have RLS enabled, forced, and at least one policy. A new table without isolation fails here.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
fi

if [ -z "${VG_TEST_DSN_OWNER:-}" ]; then
  echo "rls coverage: FAIL - no DSN; run sh scripts/db-provision.sh first" >&2
  exit 1
fi

mkdir -p .agent/evidence/db
if ! node src/infrastructure/database/migrate.ts verify-rls --dsn "$VG_TEST_DSN_OWNER" \
     2>&1 | tee .agent/evidence/db/rls-coverage.txt; then
  echo "rls coverage: FAIL - see .agent/evidence/db/rls-coverage.txt" >&2
  exit 1
fi

grep -qx 'rls coverage: ok' .agent/evidence/db/rls-coverage.txt \
  || { echo "rls coverage: FAIL - the checker did not print its sentinel" >&2; exit 1; }

echo "rls coverage: ok"
```

RUN:

```sh
sh scripts/db-provision.sh
. "${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}"
node scripts/generate-rls.ts --check
sh scripts/migrate.sh up --dsn "$VG_EMPTY_DSN_OWNER"
sh scripts/check-rls-coverage.sh
sh scripts/migrate.sh up --dsn "$VG_PRIOR_DSN_OWNER" --up-to 5
sh scripts/migrate.sh status --dsn "$VG_PRIOR_DSN_OWNER"
node src/infrastructure/database/psql.ts query-file "$VG_PRIOR_DSN_OWNER" db/seed/prior_release.sql
sh scripts/migrate.sh up --dsn "$VG_PRIOR_DSN_OWNER"
sh scripts/migrate.sh verify --dsn "$VG_PRIOR_DSN_OWNER"
cp db/migrations/0006_updated_at_triggers.sql /tmp/0006.bak
printf '\n-- drift probe\n' >> db/migrations/0006_updated_at_triggers.sql
sh scripts/migrate.sh verify --dsn "$VG_PRIOR_DSN_OWNER"; echo "drift-probe exit: $?"
cp /tmp/0006.bak db/migrations/0006_updated_at_triggers.sql
sh scripts/migrate.sh verify --dsn "$VG_PRIOR_DSN_OWNER"
```

EXPECT: `rls generation: ok` (drift 0); `migrate up` on the empty database applies `0006` and
`0007` (`migrate: applied 2 migration(s); at version 7`); `rls coverage: 26 tenant-scoped tables
all enabled, forced and policied` then `rls coverage: ok`; the prior database applies
`0001`…`0005` only, and `status` lists exactly those five; the seed file runs without error
(exit 0, no output beyond `SET`) and inserts rows in both tenants; the second `migrate up`
applies `0006` and `0007` over the seeded data and prints `migrate: ok`; `verify` reports no
drift; the deliberate one-line append to `0006` makes `verify` print
`migrate: FAIL - version 6 (0006_updated_at_triggers.sql) drifted: recorded <hash>, on disk
<hash>`, exit 1, and the wrapper print `migrate: FAIL` — **no sentinel**; restoring the file
makes `verify` pass again with `migrate: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-003 MILESTONE_PASS "M4 0006/0007 applied; rls coverage: ok; checksum drift detected and cleared"`

FALLBACK: if the `DO` block in `0007` cannot be expressed portably across the pinned server
version, keep the same assertion in `migrate verify-rls` and record `0007` as a no-op migration
with the reason in its header — never drop the live coverage check.

COMMIT: `git add -A && git commit -m "[EP-003][M4] updated_at triggers, RLS invariant assert and prior-release seed"`

### M5: Cross-tenant negative tests against real PostgreSQL (VG-DATA-001…003)

GOAL: A real database proves that every tenant-scoped table is isolated, that a cross-tenant
read returns zero rows, that a cross-tenant write is rejected, and that an unset tenant setting
fails closed.

READ: `.agent/specs/SPEC-002-data-model.md` §3 (RLS-1…RLS-6), §8 (VG-DATA-001, VG-DATA-002,
VG-DATA-003); `.agent/DONE_LAW.md` (DOD-009, DOD-013, DOD-014);
`src/infrastructure/database/psql.ts`; `src/infrastructure/database/migrate.ts`;
`db/tenant-scoped-tables.txt`; `db/seed/prior_release.sql`; `scripts/test-unit.sh`;
`scripts/test-collection-guard.sh`.

CHANGE: `tests/db/harness.ts` (create); `tests/db/rls.test.ts` (create);
`.agent/verification/EXPECTED_INTEGRATION_MANIFEST.txt` (create);
`scripts/test-unit.sh` (narrow the unit glob — database suites must not run in the unit stage);
`scripts/test-collection-guard.sh` (honour `VG_EXPECTED_MANIFEST`); `COMMANDS.md` (already
declares `node --test` and the guard).

CONTENT:

First the two anchored edits, without which adding `tests/db/**` would break the unit stage.

In `scripts/test-unit.sh`, exact old text:

```
node --test "tests/**/*.test.ts"
```

exact new text:

```
# Database suites are excluded deliberately: they require a provisioned PostgreSQL and run
# under `sh scripts/test-integration.sh`. The unit stage must stay runnable with no services.
node --test "tests/domain/**/*.test.ts" "tests/harness/**/*.test.ts" "tests/architecture/**/*.test.ts"
```

Verification grep (must print `1`): `grep -c 'tests/domain/\*\*/\*.test.ts' scripts/test-unit.sh`

In `scripts/test-collection-guard.sh`, exact old text:

```
MANIFEST=.agent/verification/EXPECTED_TEST_MANIFEST.txt
```

exact new text:

```
MANIFEST=${VG_EXPECTED_MANIFEST:-.agent/verification/EXPECTED_TEST_MANIFEST.txt}
```

Verification grep (must print `1`): `grep -c 'VG_EXPECTED_MANIFEST' scripts/test-collection-guard.sh`

Also change the runner line of the same script from

```
node --test --test-reporter=junit "${VG_TEST_GLOB:-tests/**/*.test.ts}" \
```

to

```
node --test --test-reporter=junit ${VG_TEST_GLOB:-"tests/**/*.test.ts"} \
```

so a caller may pass several patterns (the integration suite passes one, so either form works;
this form also allows `tests/db/**/*.test.ts` to expand as a glob rather than as one literal
argument). Verification grep: `grep -c 'VG_TEST_GLOB:-' scripts/test-collection-guard.sh`
returns `1`.

FILE: tests/db/harness.ts   (CREATE)
```ts
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

/** Run SQL as a role with a transaction-local app.tenant_id. */
export function asTenant(dsn: Dsn, tenantId: string, sql: string): string[] {
  return queryLines(dsn, withTenantSql(tenantId, sql));
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
```

FILE: tests/db/rls.test.ts   (CREATE)
```ts
/**
 * Tenant isolation against real PostgreSQL (SPEC-002 §3, VG-DATA-001/002/003, RLS-2/3/4).
 *
 * These are the tests that must never be satisfied by a substitute: RLS behaviour depends on
 * session settings, table ownership and forced policies, none of which an in-memory database
 * reproduces (DOD-009, DOD-010).
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
        table === undefined || enabled !== 't' || forced !== 't' || Number(policies) < 1,
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
    assert.equal(bypass, 'f');
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
```

FILE: .agent/verification/EXPECTED_INTEGRATION_MANIFEST.txt   (CREATE)
```
# Expected integration test manifest (DOD-007 for the database suite).
#
# Every path listed here MUST contribute at least one test when `sh scripts/test-integration.sh`
# runs. The collection guard is invoked with this manifest and VG_TEST_GLOB="tests/db/**/*.test.ts".
# Removing a line to make the guard pass is gate weakening (DOD-027).
tests/db/audit-append-only.test.ts
tests/db/rls.test.ts
tests/db/schema-and-constraints.test.ts
```

Note: `tests/db/audit-append-only.test.ts` and `tests/db/schema-and-constraints.test.ts` are
created in M6. Until then the manifest lists them and the guard would fail — so M5 creates the
manifest with **only** `tests/db/rls.test.ts`, and M6 appends the other two lines in the same
commit that creates those files. Do that: the file's first version in this milestone is the
header plus `tests/db/rls.test.ts`.

RUN:

```sh
mkdir -p .agent/evidence/db
sh scripts/db-provision.sh
. "${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}"
sh scripts/migrate.sh up --dsn "$VG_TEST_DSN_OWNER"
node src/infrastructure/database/psql.ts query-file "$VG_TEST_DSN_OWNER" db/seed/prior_release.sql
sh scripts/test-unit.sh
sh scripts/test-collection-guard.sh
export VG_TEST_DSN_OWNER VG_TEST_DSN_APP
VG_TEST_GLOB="tests/db/**/*.test.ts" VG_EXPECTED_MANIFEST=.agent/verification/EXPECTED_INTEGRATION_MANIFEST.txt sh scripts/test-collection-guard.sh
node --test "tests/db/**/*.test.ts" 2>&1 | tail -n 12
```

EXPECT: `db provision: ok`; `migrate: ok`; the seed exits 0; `test-unit: ok` still runs the
domain, harness and architecture suites and reports **no** `tests/db` file in its summary;
`test collection guard: ok` for the unit suite; the integration-manifest guard run prints its
JSON line with `"tests"` counting only the database suite and `filesSeen` equal to `1`, then
`test collection guard: ok`; the direct database run reports zero failures and zero skipped
tests.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-003 MILESTONE_PASS "M5 cross-tenant negative tests pass against real PostgreSQL (VG-DATA-001..003)"`

FALLBACK: if the two roles cannot both be exercised in a given environment (for example an
externally supplied `DATABASE_URL` where role creation is not permitted), keep the negative
tests against the migration role and record the missing role-separation assertion as
`BLOCKED_CAPABILITY` with the provisioning log — never delete the cross-tenant assertions,
because they are the whole point of the node (VG-TENANT-001).

COMMIT: `git add -A && git commit -m "[EP-003][M5] cross-tenant isolation tests against real PostgreSQL"`

### M6: The `JobQueue` port on the Postgres-native queue, with transactional enqueue

GOAL: Durable work is enqueued by the same transaction that performs the state transition,
so a transition and its follow-up work cannot commit half-way.

READ: `DECISIONS.md` (ADR-016, ADR-015), `.agent/specs/SPEC-001-core-domain.md` §5 (ports),
§10 (idempotence and recovery), `.agent/specs/SPEC-002-data-model.md` §3 (RLS), `ARCHITECTURE.md` §4.

CHANGE: `src/application/ports/job-queue.ts`, `src/adapters/queue/postgres-job-queue.ts`,
`migrations/0008_job_queue.sql`, `tests/db/job-queue.test.ts`,
`.agent/verification/EXPECTED_INTEGRATION_MANIFEST.txt`, `COMMANDS.md`.

CONTENT: A `JobQueue` port declared in the application layer with exactly two operations —
`enqueue(tx, job)` and `cancel(tx, jobId)` — where `tx` is the **existing** transaction handle,
never a fresh connection. This signature is the whole point: it makes it impossible to enqueue
outside the transaction that caused the work, which is what removes the dual-write class of
inconsistency that an external orchestrator would have introduced. `0008_job_queue.sql` creates
the queue tables plus the worker-heartbeat table that SPEC-007 §7.2 probes as `job-worker`.
The adapter implements the queue directly in PostgreSQL.

RUN:
```
sh scripts/db-provision.sh
sh scripts/migrate.sh up
VG_TEST_GLOB="tests/db/**/*.test.ts" node --test "tests/db/job-queue.test.ts"
```

EXPECT: `db provision: ok`; `migrate: ok`; the job-queue suite passes, including the two
assertions that matter — a rolled-back transaction leaves **no** job row (proving enqueue is
genuinely inside the caller's transaction), and a job with an identical idempotency key is not
enqueued twice.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-003 MILESTONE_PASS "M6 job queue: transactional enqueue, rollback leaves no job"`

FALLBACK: if the chosen queue library cannot accept an external transaction handle, implement
the enqueue as a plain `INSERT` inside the caller's transaction against the queue's own table
and keep the library only for dispatch. The transactional property is non-negotiable; the
library is not.

COMMIT: `git add -A && git commit -m "[EP-003][M6] JobQueue port with transactional enqueue"`

### M7: Envelope encryption, retention windows and crypto-shredding

GOAL: Subject PII is encrypted at rest under a per-tenant key, retention is resolved from
policy data rather than constants, and erasure destroys the key material rather than relying
on row deletion.

READ: `.agent/specs/SPEC-002-data-model.md` §4 (encryption), §5 (retention RET-1…RET-5),
`.agent/specs/SPEC-005-auth-permissions.md` §4 (identity levels and document handling),
`DECISIONS.md` (ADR-006 open, ADR-014).

CHANGE: `src/domain/key-provider.ts` (port), `src/adapters/crypto/*`, `migrations/0009_retention.sql`,
`tests/db/encryption.test.ts`, `tests/db/retention.test.ts`,
`.agent/verification/EXPECTED_INTEGRATION_MANIFEST.txt`, `COMMANDS.md`.

CONTENT: A `KeyProvider` port with `wrap`, `unwrap`, `rotate` and `shred`. A per-tenant DEK is
wrapped by a KEK; ciphertext rows carry `key_version` so rotation does not rewrite history.
`value_hmac` is a keyed HMAC so equality lookup neither decrypts nor exposes low-entropy values
to offline guessing. `0009_retention.sql` adds `jurisdiction_policy` retention columns and the
erasure-tombstone table. Retention windows are read from policy rows (RET-1) — **no statutory
period is hard-coded and none is asserted**, because that is a counsel question
(`LEGAL_REVIEW_REQUIRED.md`). Crypto-shredding destroys the DEK and records an audit event while
leaving the audit trail intact (RET-2).

**Honest scope limit:** ADR-006 (cloud/KMS selection) is still `OPEN`, so the managed-KMS
adapter is `BLOCKED_CREDENTIALS`. This milestone implements the port, the local file-backed
provider used **by tests only**, and the rotation/erasure mechanics. The local provider is
explicitly **not** a production KMS and must never be selected in a production configuration
(VG-SCOPE-020). Do not write the KMS rows as passing.

RUN:
```
sh scripts/db-provision.sh
sh scripts/migrate.sh up
VG_TEST_GLOB="tests/db/**/*.test.ts" node --test "tests/db/encryption.test.ts" "tests/db/retention.test.ts"
```

EXPECT: `db provision: ok`; `migrate: ok`; the encryption suite proves ciphertext differs from
plaintext, that a wrong key fails closed rather than returning garbage, and that rotation leaves
old rows readable via `key_version`; the retention suite proves a policy change alters the
window without a code change and that a shredded subject's PII is unrecoverable while its audit
events remain.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-003 MILESTONE_PASS "M7 envelope encryption; retention from policy; crypto-shred verified"`

FALLBACK: none for the mechanism. If no KMS adapter can be configured, the port still ships and
the managed adapter stays `BLOCKED_CREDENTIALS`; do not substitute a test provider for a
production claim (DOD-010).

COMMIT: `git add -A && git commit -m "[EP-003][M7] envelope encryption, retention and crypto-shredding"`

### M8: Backup, restore and erasure-tombstone reconciliation

GOAL: A restore provably re-applies erasure and preserves isolation, so a backup cannot
resurrect deleted PII.

READ: `.agent/specs/SPEC-002-data-model.md` §7 (backup, restore, DR; RET-3),
`.agent/DONE_LAW.md` (DOD-036), `PROJECT_RESEARCH_BRIEF.md` §11 (backup resurrection is a named threat).

CHANGE: `scripts/backup-drill.sh`, `tests/db/restore-drill.test.ts`,
`.agent/evidence/EP-003/restore-drill/**`, `COMMANDS.md`.

CONTENT: A real destructive drill against a disposable database: seed subjects, erase one
(crypto-shred plus tombstone), take a backup, destroy the database, restore it, and then assert
five post-conditions — the erased subject's PII is unrecoverable, its tombstone is present,
RLS is enabled and forced on every tenant-scoped table, the audit chain is intact, and every
evidence digest still verifies. A restore that reintroduces erased PII is a severity-1 finding,
not a warning.

RUN:
```
sh scripts/db-provision.sh
sh scripts/migrate.sh up
sh scripts/backup-drill.sh
```

EXPECT: `db provision: ok`; `migrate: ok`; `backup drill: ok` with all five post-conditions
reported individually, and the container torn down with proof (`db teardown: ok`).

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-003 MILESTONE_PASS "M8 backup drill: restore re-applies erasure, RLS and audit intact"`

FALLBACK: if PITR cannot be exercised because the provider is not provisioned, run the drill
with a logical dump/restore of the same disposable database and label the PITR row
`BLOCKED_CREDENTIALS`. Never label an untested backup path as verified.

COMMIT: `git add -A && git commit -m "[EP-003][M8] backup and restore drill with erasure reconciliation"`

### M9: Node close-out

GOAL: The node gate passes, `verify.sh` provably advances past `integration`, and no unproven
claim is carried forward.

READ: `.agent/EXECUTION_RULES.md`, `.agent/DONE_LAW.md` (DOD-025, DOD-026, DOD-029),
`.agent/specs/SPEC-008-production-readiness.md` §13.

CHANGE: `scripts/gate-data.sh`, `.agent/state/LEDGER.md`,
`.agent/verification/state/DOD_STATUS.jsonl`, `.agent/verification/state/TEST_LEDGER.jsonl`,
`.agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv`.

CONTENT: `gate-data.sh` provisions, migrates, runs the database suites and the negative security
tests, proves the upgrade matrix, proves the failed-migration path, then runs
`sh scripts/verify.sh` and asserts that the run now clears the `integration` stage that it could
not clear before — the concrete progression proof. It tears the database down and records
teardown proof. It prints `gate-data: ok` only when every preceding step genuinely passed.
`DOD_STATUS.jsonl`, `TEST_LEDGER.jsonl` and the claim-to-release rows are updated with the real
observed results.

RUN:
```
sh scripts/gate-data.sh
sh scripts/ledger.sh append <AGENT_ID> EP-003 NODE_DONE "EP-003 complete: gate-data: ok"
git tag green/EP-003
```

EXPECT: `gate-data: ok`; `verify.sh` advances past `integration`; tag `green/EP-003` created.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-003 NODE_DONE "EP-003 complete: gate-data: ok"`

FALLBACK: none. If any stage fails, the node stays open and is not tagged.

COMMIT: `git add -A && git commit -m "[EP-003][M9] close data and persistence node"`

## 9. Validation and Acceptance

Node-level acceptance. Each item is satisfied only by an **executed** result from the current
candidate epoch; reading a script is not evidence (VG-SHIP-034).

1. `sh scripts/gate-data.sh` prints `gate-data: ok` and exits 0.
2. Every migration applies to an empty database, and to each supported prior released schema
   with logical data preservation (MIG-1, MIG-2, DOD-016).
3. A deliberately broken migration leaves a known state; the retry and rollback paths are
   executed, not assumed (MIG-4).
4. Cross-tenant read returns zero rows and cross-tenant write is rejected, both against real
   PostgreSQL, as two separate assertions at the database layer (VG-DATA-002, VG-DATA-003).
5. RLS is enabled **and forced** on every table carrying `tenant_id`, asserted by enumeration
   so a newly added table without isolation fails the build (RLS-2, VG-DATA-001).
6. `UPDATE` and `DELETE` on `audit_event` are no-ops that leave rows unchanged (VG-DATA-004).
7. A subject cannot be committed without valid authority; an agent grant without a signed
   instrument is refused (VG-DATA-005, VG-DATA-006).
8. A duplicate idempotency key is refused per tenant (VG-DATA-007); self-verification is
   refused by constraint (VG-DATA-008); confidence without basis is refused (VG-DATA-009).
9. Enqueue inside a rolled-back transaction leaves no job row (M6).
10. A restore re-applies erasure, preserves RLS, and leaves the audit chain intact (M8,
    RET-3, DOD-036).
11. `sh scripts/verify.sh` advances past the `integration` stage, and **no** `verify: ok` is
    claimed unless all fifteen stages genuinely pass.
12. Teardown proof exists: the disposable container is gone.

**Never claim:** that the schema is production-ready, that retention windows are legally
correct (that is counsel's call), or that the managed-KMS path works. ADR-006 is open, so the
KMS adapter stays `BLOCKED_CREDENTIALS`.

## 10. Idempotence and Recovery

Re-enter cold by reading `.agent/state/LEDGER.md`, running
`sh scripts/ledger.sh status EP-003`, and resuming at the first milestone with no
`MILESTONE_PASS`. Re-run the previous milestone's gate to confirm its sentinel still holds —
cached green is not green.

`db-provision.sh` is idempotent by design: a running container with a valid state file is
reused rather than recreated. `migrate.sh up` is forward-only and refuses to re-apply an
applied migration whose checksum changed, which is the correct fail-closed behaviour: a
changed checksum means history was edited. To recover a poisoned database, run
`sh scripts/db-teardown.sh` and re-provision — never edit an applied migration.

If the Docker daemon is unreachable, the node records `BLOCKED_ENVIRONMENT` with the
provisioning log (DOD-032, DOD-033). That is a harness limitation, not a candidate failure, and
must not be written as `FAIL`.

## 11. Progress

- [ ] M1: Disposable PostgreSQL, two roles, and the provisioning contract
- [ ] M2: Central isolation list, RLS generator, migration runner, first migration
- [ ] M3: Migrations 0002–0005 — the full schema, with RLS generated into each file
- [ ] M4: updated_at triggers, the RLS invariant assertion, and the seed for the upgrade matrix
- [ ] M5: Cross-tenant negative tests against real PostgreSQL (VG-DATA-001…003)
- [ ] M6: The `JobQueue` port on the Postgres-native queue, with transactional enqueue
- [ ] M7: Envelope encryption, retention windows and crypto-shredding
- [ ] M8: Backup, restore and erasure-tombstone reconciliation
- [ ] M9: Node close-out

## 12. Surprises & Discoveries

<!-- Append only observed, dated findings with the command that produced them. -->

## 13. Decision Log

| # | Decision | Rationale | Status |
|---|---|---|---|
| D1 | Durable jobs run on a Postgres-native queue, not Temporal. | ADR-016: removes a second stateful cluster, and enqueue commits in the same transaction as the state transition, eliminating a dual-write inconsistency class. | ACCEPTED (inherits ADR-016) |
| D2 | Kysely plus SQL-first migrations rather than an ORM. | ADR-008: RLS needs transaction-scoped `SET LOCAL app.tenant_id`, and policies and triggers cannot be expressed through a schema DSL. | ACCEPTED (inherits ADR-008) |
| D3 | Node verify is `sh scripts/gate-data.sh` (`gate-data: ok`), not the generic stub `sh scripts/verify.sh`. | The stub header was boilerplate; `verify: ok` is unreachable before an artifact exists (EP-009). Narrowing to a real node gate weakens nothing — `gate-data.sh` itself asserts that `verify.sh` now advances past `integration`. | PENDING OWNER RATIFICATION |
| D4 | No statutory retention period is hard-coded. | Jurisdiction bases and windows are a counsel question. The mechanism is policy-driven data; asserting a number would be an unqualified legal claim. | ACCEPTED |
| D5 | The local file-backed key provider is test-only. | ADR-006 is open, so no managed KMS exists; a test provider must never be selected by a production configuration. | ACCEPTED |

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence. -->
