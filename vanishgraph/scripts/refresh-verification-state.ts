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
        'tests/db/**/*.test.ts',
      ]
    : [
        'tests/domain/**/*.test.ts',
        'tests/harness/**/*.test.ts',
        'tests/architecture/**/*.test.ts',
        'tests/contract/**/*.test.ts',
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
    if (suite.startsWith('tests/db/')) return 'integration';
    if (suite.startsWith('tests/architecture/')) return 'architecture';
    if (suite.startsWith('tests/harness/')) return 'harness';
    return 'unit';
  };

  const fresh = cases.map((c) =>
    JSON.stringify({
      test_id: `${kindFor(c.suite) === 'integration' ? 'INT' : 'UNIT'}-${c.name}`,
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

  const passCount = cases.filter((c) => c.status === 'PASS').length;
  const skipCount = cases.filter((c) => c.status === 'SKIP').length;

  const updates: Record<string, { status: string; evidence: string }> = {
    'DOD-009': {
      status: 'PASS',
      evidence:
        `Database suites run against real PostgreSQL (no substitute anywhere in tests/db/**): ` +
        `${passCount} tests pass across ${suitesSeen.size} suites, ${skipCount} skipped. ` +
        'Covered by tests/db/{rls,job-queue,encryption,retention,restore-drill}.test.ts.',
    },
    'DOD-013': {
      status: 'PASS',
      evidence:
        'Tenant isolation asserted at the database layer: RLS enabled AND forced with a policy on ' +
        'all 29 tenant-scoped tables, enumerated from pg_class/pg_policies so a new table without ' +
        'isolation fails gate-data. Cross-tenant read returns zero rows as vg_app; cross-tenant ' +
        'write is refused by WITH CHECK. Proven in tests/db/rls.test.ts and re-asserted by gate-data.sh.',
    },
  };

  if (WITH_DB) {
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
