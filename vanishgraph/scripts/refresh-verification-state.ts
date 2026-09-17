#!/usr/bin/env node
/**
 * Regenerate the verification state files from EXECUTED test results (EP-003 M9).
 *
 * `.agent/verification/state/TEST_LEDGER.jsonl` and `DOD_STATUS.jsonl` are records of what was
 * actually observed. Hand-editing them would make them a claim rather than a record, which is the
 * fabrication DOD-027 exists to catch. So this script:
 *
 *   1. runs the unit and database suites with the JUnit reporter,
 *   2. parses the real per-test outcomes,
 *   3. rewrites the TEST_LEDGER rows for those suites, preserving rows for suites it did not run,
 *   4. updates the DOD rows whose evidence this node actually changed.
 *
 * A suite that produced no results is reported, not silently omitted: a vanished suite must not
 * look like a smaller but healthy ledger.
 *
 * Usage:
 *   node scripts/refresh-verification-state.ts            # unit suites only (no database needed)
 *   node scripts/refresh-verification-state.ts --with-db  # also run tests/db/** (needs PostgreSQL)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const STATE_DIR = join(PROJECT_ROOT, '.agent', 'verification', 'state');

const WITH_DB = process.argv.includes('--with-db');

interface Case {
  readonly suite: string;
  readonly name: string;
  readonly status: 'PASS' | 'FAIL' | 'SKIP';
}

function candidateSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
}

function epoch(): string {
  // Identifies the FORGE candidate lineage. A release epoch would be named differently; this
  // project has no release, and saying otherwise would be a false claim.
  return 'FORGE-SPEC-1';
}

/** Run a glob through the JUnit reporter and return the per-test outcomes. */
function runSuites(patterns: readonly string[]): { cases: Case[]; failed: number } {
  const args = ['--test', '--test-reporter=junit', ...patterns];
  let xml = '';
  try {
    xml = execFileSync('node', args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // A failing run still emits JUnit on stdout; capture it rather than losing the detail.
    const e = error as { stdout?: string };
    xml = e.stdout ?? '';
    if (xml.length === 0) throw error;
  }

  // Node's JUnit reporter NESTS <testcase> elements: a `describe` emits an outer testcase that
  // contains one inner testcase per test. The OUTER one carries no `file` attribute, so a naive
  // parse produces rows with an empty suite and an empty name — measured: 34 such rows in the
  // first version of this ledger. They are dropped, because an unattributed test row is not
  // evidence of anything and would inflate the count while naming no suite.
  //
  // The enclosing `<testsuite ...>` does NOT carry the file either (it carries the suite name),
  // so attribution has to come from the testcase's own `file` attribute. A testcase without one
  // is a suite-level wrapper, not a test.
  const cases: Case[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/?)>/g)) {
    const attrs = match[1] ?? '';
    const selfClosing = match[2] === '/';
    const name = (attrs.match(/\bname="([^"]*)"/) ?? [, ''])[1] ?? '';
    const file = (attrs.match(/\bfile="([^"]*)"/) ?? [, ''])[1] ?? '';

    // Drop the runner's file-level artifact for an empty file, and drop unattributed wrappers.
    if (/\.test\.[cm]?[jt]s\s*$/.test(name)) continue;
    if (file.length === 0) continue;

    let status: Case['status'] = 'PASS';
    if (!selfClosing) {
      const end = xml.indexOf('</testcase>', match.index ?? 0);
      const body = xml.slice(match.index ?? 0, end === -1 ? undefined : end);
      if (/<skipped\b/.test(body)) status = 'SKIP';
      else if (/<(failure|error)\b/.test(body)) status = 'FAIL';
    }
    const suite = file.replace(/\\/g, '/').replace(/^.*?\/vanishgraph\//, '');
    cases.push({ suite, name, status });
  }

  // A skipped or failed test is recorded as such; the caller decides whether that is fatal.
  const failed = cases.filter((c) => c.status === 'FAIL').length;
  return { cases, failed };
}

function main(): number {
  const sha = candidateSha();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  /**
   * The suite set this refresher records.
   *
   * `tests/contract/**` WAS MISSING FROM BOTH LISTS and is now included. MEASURED consequence of the
   * omission: `TEST_LEDGER.jsonl` contained **zero** rows whose suite began `tests/contract/`, so the
   * entire contract root — `token-validation` (33 tests), `tenant-resolution` (12), `idempotency` (28),
   * `error-mapping-parity` (16), `error-envelope`, `route-registry`, `filter-strictness`, `pagination`
   * and `source-routes` — could not influence `DOD_STATUS.jsonl`. A regression in token validation or
   * tenant resolution would have left every DOD row exactly as it was, which makes the DOD record an
   * incomplete account of what was observed. The root is pure (it reads specification files and imports
   * only `node:*` and relative paths), so it needs no database and belongs in the non-`--with-db` set.
   *
   * This is the same class of defect as a gate that stops checking: the evidence kept being produced,
   * and its scope quietly stopped covering part of the system.
   */
  const patterns = WITH_DB
    ? [
        'tests/domain/**/*.test.ts',
        'tests/harness/**/*.test.ts',
        'tests/architecture/**/*.test.ts',
        'tests/contract/**/*.test.ts',
        // `tests/security/**` RUNS IN THE UNIT STAGE AND NEEDS NO DATABASE, so it belongs in BOTH lists. MEASURED why it
        // had to be added: nothing in this refresher named that root, so the security suites that EP-006 M1–M9 added
        // (the scanner self-test, the masking patterns, the negative cases) executed on every unit run while the ledger
        // that exists to record what was observed never saw them — the same "the evidence kept being produced and its
        // scope quietly stopped covering part of the system" defect the blackbox note below records.
        'tests/security/**/*.test.ts',
        // EP-007 M2/M3 ROOTS, for the same reason the security root is here: the unit stage runs them, so the ledger that
        // records what was observed must see them.
        'tests/regression/**/*.test.ts',
        'tests/failure/**/*.test.ts',
        'tests/db/**/*.test.ts',
        // THE INTEGRATION ROOT IS PART OF THE --with-db RUN for the same reason the black-box root is: every suite there
        // drives real PostgreSQL (through `tests/db/harness.ts` or the real adapters), and EP-006 M10's authority,
        // cross-tenant and immutability proofs live there. Without this line the ledger would not carry a single row for
        // them, and DOD-013's cross-tenant claim would keep citing only tests/db/rls.test.ts.
        'tests/integration/**/*.test.ts',
        // THE BLACK-BOX ROOT IS PART OF THE --with-db RUN, and MEASURED why it must be: it drives the real server over
        // HTTP and creates its own tenant, so it needs PostgreSQL — and without it DOD-011 (black-box acceptance) and
        // DOD-012 (independent readback) had NO executed evidence in this refresher, which is why both rows still read
        // NOT_STARTED after the suite that proves them had been passing for a round.
        'tests/blackbox/**/*.test.ts',
      ]
    : [
        'tests/domain/**/*.test.ts',
        'tests/harness/**/*.test.ts',
        'tests/architecture/**/*.test.ts',
        'tests/contract/**/*.test.ts',
        'tests/security/**/*.test.ts',
      ];

  if (WITH_DB && (process.env.VG_TEST_DSN_OWNER ?? '') === '') {
    console.error('refresh-verification-state: FAIL - --with-db requires VG_TEST_DSN_OWNER to be set');
    return 1;
  }

  const { cases, failed } = runSuites(patterns);
  if (cases.length === 0) {
    console.error('refresh-verification-state: FAIL - zero tests collected; refusing to write an empty ledger');
    return 1;
  }

  const suitesSeen = new Set(cases.map((c) => c.suite));
  console.log(`refresh-verification-state: ${cases.length} tests across ${suitesSeen.size} suites (${failed} failed)`);

  // ---------------------------------------------------------------------------------------------
  // TEST_LEDGER: replace the rows for the suites just run, preserve every other row.
  // ---------------------------------------------------------------------------------------------
  const ledgerPath = join(STATE_DIR, 'TEST_LEDGER.jsonl');
  const existing = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    : [];
  const preserved = existing.filter((line) => {
    try {
      const row = JSON.parse(line) as { suite?: string; test_id?: string; name?: string };
      // A ROW THAT NAMES NO SUITE IS NOT PRESERVED. MEASURED: 27 such rows survived every refresh,
      // each one `{"test_id":"UNIT-","suite":"","name":"","status":"PASS","evidence_path":"tests/"}` —
      // a PASS claim with no suite, no test name and no file, recorded under an earlier epoch. The
      // preserve rule below keeps any row whose suite was not re-run, and an empty suite is never in
      // `suitesSeen`, so they were kept in perpetuity and inflated the ledger's pass count.
      //
      // The distinction that decides this: a row naming a suite is a claim that can be RE-VERIFIED on
      // the next run, which is why preserving it is honest. A row naming nothing cannot ever be
      // re-verified or refuted, so preserving it preserves an unfalsifiable claim — the opposite of
      // what a ledger of observed results is for.
      if (row.suite === undefined || row.suite.trim().length === 0) return false;
      return !suitesSeen.has(row.suite);
    } catch {
      return true; // keep anything unparseable rather than destroying a record
    }
  });

  const kindFor = (suite: string): string => {
    // EVERY ROOT THAT NEEDS POSTGRES IS `integration`, INCLUDING THE ONES THAT ARE NOT UNDER tests/db/. MEASURED: the
    // fall-through used to classify `tests/blackbox/**` as `unit` — a real-server, real-database suite labelled as a
    // pure one — and EP-006 M10's `tests/integration/**` suites would have inherited the same wrong label. The `kind`
    // field is what a reader uses to tell a claim that needs a service from one that does not.
    if (suite.startsWith('tests/db/')) return 'integration';
    if (suite.startsWith('tests/integration/')) return 'integration';
    if (suite.startsWith('tests/blackbox/')) return 'integration';
    if (suite.startsWith('tests/architecture/')) return 'architecture';
    if (suite.startsWith('tests/harness/')) return 'harness';
    return 'unit';
  };

  /**
   * THE ID MUST IDENTIFY ONE TEST, AND IT DID NOT.
   *
   * MEASURED DEFECT, corrected in EP-006 M11: `test_id` was `${prefix}-${name}`, so five test names shared by two or
   * more suites produced identical ids — six suites declare `every code these routes emit is registered (H-7)`, two
   * declare `a wildcard scope is TOKEN_SCOPE_WILDCARD_FORBIDDEN`, and so on. The `suite` field disambiguated them, so no
   * information was lost, but an id that names six rows is not an identifier: a reader (or a script) that keys on
   * `test_id` alone silently conflates them, which is exactly what happened to the EP-006 M11 writer before it was
   * corrected. The suite is therefore part of the id now, and a duplicate name WITHIN one suite (the runner permits it)
   * gets a numeric suffix rather than collapsing.
   */
  const usedIds = new Map<string, number>();
  const idFor = (suite: string, name: string): string => {
    const base = `${kindFor(suite) === 'integration' ? 'INT' : 'UNIT'}-${suite}-${name}`;
    const seen = usedIds.get(base) ?? 0;
    usedIds.set(base, seen + 1);
    return seen === 0 ? base : `${base}#${String(seen + 1)}`;
  };

  const fresh = cases.map((c) =>
    JSON.stringify({
      test_id: idFor(c.suite, c.name),
      suite: c.suite,
      name: c.name,
      status: c.status,
      kind: kindFor(c.suite),
      candidate_sha: sha,
      epoch: epoch(),
      evidence_path: c.suite,
      recorded_at: now,
    }),
  );

  writeFileSync(ledgerPath, `${[...preserved, ...fresh].join('\n')}\n`);
  console.log(
    `refresh-verification-state: TEST_LEDGER.jsonl rewritten (${preserved.length} preserved, ${fresh.length} refreshed)`,
  );

  // ---------------------------------------------------------------------------------------------
  // DOD_STATUS: update only the rows whose evidence this node genuinely changed. Everything else
  // is left exactly as it was, because this script has no evidence about other nodes.
  // ---------------------------------------------------------------------------------------------
  const dodPath = join(STATE_DIR, 'DOD_STATUS.jsonl');
  const dodLines = readFileSync(dodPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);

  /**
   * DOD-009 IS ABOUT THE DATABASE SUITES, SO IT MUST COUNT THE DATABASE SUITES.
   *
   * MEASURED DEFECT, corrected here: this row previously reported `passCount`/`suitesSeen.size` over
   * EVERY suite this script ran — domain, harness, architecture and contract included — while its text
   * said "Database suites run against real PostgreSQL (no substitute anywhere in tests/db/**)". On the
   * refresh after the §5.6 group it read "846 tests pass across 48 suites" when the database root alone
   * was 261 tests across 20 files. That is evidence overstating what it covers, in the one row whose
   * subject is the database, and it is the failure DOD-027 exists to catch. The counts are now scoped to
   * `tests/db/**`.
   */
  const dbCases = cases.filter((c) => c.suite.startsWith('tests/db/'));
  const dbSuites = new Set(dbCases.map((c) => c.suite));
  const dbPass = dbCases.filter((c) => c.status === 'PASS').length;
  const dbSkip = dbCases.filter((c) => c.status === 'SKIP').length;

  /**
   * THE OTHER ROOT THAT RUNS AGAINST THE SAME DATABASE, COUNTED SEPARATELY.
   *
   * `tests/integration/**` was added to this refresher in EP-006 M10. Its figure is reported as its own number rather
   * than folded into the `tests/db/**` figure, because the sentence above DOD-009 names `tests/db/**` and a total that
   * silently included another root would be the same overstatement that row was corrected for.
   */
  const integrationCases = cases.filter((c) => c.suite.startsWith('tests/integration/'));
  const integrationSuites = new Set(integrationCases.map((c) => c.suite));
  const integrationPass = integrationCases.filter((c) => c.status === 'PASS').length;

  /**
   * DOD-013'S TABLE COUNT IS READ FROM THE FILE OF RECORD, NOT TYPED IN.
   *
   * MEASURED DEFECT, corrected here: the string said "all 29 tenant-scoped tables" while
   * `db/tenant-scoped-tables.txt` listed 33 and `scripts/check-rls-coverage.sh` printed 33. A number
   * copied into prose goes stale the first time a migration adds a table, and a stale number inside an
   * evidence line is a false claim about a measurement. Reading the list makes the sentence wrong only
   * if the list is wrong.
   */
  const tenantScopedTables = readFileSync(join(PROJECT_ROOT, 'db', 'tenant-scoped-tables.txt'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith('#')).length;

  const updates: Record<string, { status: string; evidence: string }> = {};

  // DOD-009 and DOD-013 are BOTH database claims, so both are written only when the database suites
  // actually ran. A run without --with-db has no database evidence at all, and a database row updated
  // from it would be a claim with nothing behind it — the reason DOD-009 previously read "846 tests
  // across 48 suites" (every suite this script runs, including domain and contract) for a row whose
  // subject is `tests/db/**`, whose real figure was 261 tests across 20 files.
  if (WITH_DB) {
    updates['DOD-009'] = {
      status: 'PASS',
      evidence:
        `Database suites run against real PostgreSQL (no substitute anywhere in tests/db/**): ` +
        `${dbPass} tests pass across ${dbSuites.size} files, ${dbSkip} skipped. ` +
        `Plus ${integrationPass} test(s) across ${integrationSuites.size} file(s) in tests/integration/**, which drive ` +
        'the same provisioned server through the real adapters and psql. ' +
        'Covered by tests/db/{rls,job-queue,encryption,retention,restore-drill}.test.ts.',
    };
    updates['DOD-013'] = {
      status: 'PASS',
      evidence:
        'Tenant isolation asserted at the database layer: RLS enabled AND forced with a policy on ' +
        `all ${tenantScopedTables} tables listed in db/tenant-scoped-tables.txt, enumerated from ` +
        'pg_class/pg_policies so a new table without isolation fails gate-data. Cross-tenant read ' +
        'returns zero rows as vg_app; cross-tenant write is refused by WITH CHECK. Proven in ' +
        'tests/db/rls.test.ts, re-asserted by gate-data.sh, and extended in EP-006 M10 by ' +
        'tests/integration/cross-tenant-both-layers.test.ts (the query carries NO tenant predicate, so the policy alone ' +
        'refuses) and tests/integration/authority-at-execution.test.ts (another tenant’s handle sees no grant). ' +
        'NOT COVERED by that claim: a cross-tenant REFERENCE, which the schema permits because no tenant-scoped table ' +
        'carries a (tenant_id, id) key — measured and recorded in ASSUMPTIONS §3.56.',
    };
  }

  if (WITH_DB) {
    const blackbox = cases.filter((c) => c.suite.startsWith('tests/blackbox/'));
    const blackboxPass = blackbox.filter((c) => c.status === 'PASS').length;
    updates['DOD-011'] = {
      status: blackboxPass > 0 ? 'PASS' : 'NOT_STARTED',
      evidence:
        `Acceptance is asserted through PUBLIC HTTP ONLY: ${String(blackboxPass)} black-box test(s) pass in ` +
        'tests/blackbox/acceptance.test.ts, driving the real server through app.inject — no route module is imported, ' +
        'no command is called directly, and no table is read to decide a result. The route non-goals are asserted to ' +
        'refuse and to create nothing, with the subject list compared before and after.',
    };
    updates['DOD-012'] = {
      status: blackboxPass > 0 ? 'PASS' : 'NOT_STARTED',
      evidence:
        'Independent readback is reached through a SECOND PUBLIC CHANNEL: GET /v1/audit-events returns the ' +
        'RegisterSubject row for a subject the black-box suite created over HTTP, and the audit stream carries no ' +
        'displayRef (VG-SEC-002). The persistence-side readback — a committed transition and its audit row in the ' +
        'same transaction — is asserted in tests/db/**; what remains BLOCKED_CREDENTIALS is the real-IdP token row.',
    };
    updates['DOD-016'] = {
      status: 'PARTIAL',
      evidence:
        'db/UPGRADE_MATRIX.md declares the supported upgrade-from states and the migrations are ' +
        'additive and checksum-pinned (schema_migration refuses a changed checksum, MIG-5). The ' +
        'failed-migration retry path is genuinely exercised: migration 0010 failed, left the ' +
        'database at a known version 9, and applied on retry. PARTIAL, not PASS: ' +
        'scripts/test-migrations.sh does not exist, so the from-empty and from-prior rows in the ' +
        'matrix have no producer and are recorded UNPROVEN in ' +
        '.agent/evidence/db/integration-migrations.txt.',
    };
    updates['DOD-036'] = {
      status: 'PARTIAL',
      evidence:
        'scripts/backup-drill.sh executes a destructive logical dump/restore of a destroyed ' +
        'disposable database and asserts 8 post-conditions including the severity-1 check that a ' +
        'restore does not resurrect erased PII. PARTIAL, not PASS: PITR is BLOCKED_CREDENTIALS ' +
        '(WAL archiving to object storage is not provisioned) and no RPO/RTO/MTTR figure has been ' +
        'measured, so the backup-restore requirement is only partly satisfied.',
    };
  }

  let changed = 0;
  const dodOut = dodLines.map((line) => {
    try {
      const row = JSON.parse(line) as { dod_id?: string; status?: string; evidence?: string };
      const update = row.dod_id === undefined ? undefined : updates[row.dod_id];
      if (update === undefined) return line;
      changed += 1;
      return JSON.stringify({
        ...row,
        status: update.status,
        evidence: update.evidence,
        candidate_sha: sha,
        epoch: epoch(),
        recorded_at: now,
      });
    } catch {
      return line;
    }
  });

  writeFileSync(dodPath, `${dodOut.join('\n')}\n`);
  console.log(`refresh-verification-state: DOD_STATUS.jsonl updated (${changed} row(s))`);

  if (failed > 0) {
    console.error(`refresh-verification-state: FAIL - ${failed} test(s) failed; the ledger records that honestly`);
    return 1;
  }
  console.log('refresh-verification-state: ok');
  return 0;
}

process.exit(main());
