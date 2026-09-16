/**
 * The `psql` runner's own contract: DSN parsing, credential redaction, the failure path, and the CLI (EP-007 M1).
 *
 * WHY THIS SUITE EXISTS. `src/infrastructure/database/psql.ts` is the substrate of every database gate and of
 * `tests/db/**`: each of them spawns `psql` through these functions. `scripts/coverage-gate.sh` measured the
 * `infrastructure` layer at 51.11% of branches against a target of 55, and the two files loaded by those suites are this
 * one and `migrate.ts` — so the uncovered branches were looked at rather than the target being lowered (DOD-027). What
 * was uncovered is exactly this file's REFUSAL paths and its CLI: `parseDsn`'s three rejections, `queryLines`' failure
 * path, and the entry point every gate script invokes as a subprocess.
 *
 * NO DATABASE IS REQUIRED, WHICH IS WHY THIS IS A UNIT SUITE. The failure path is exercised by pointing a DSN at a port
 * nothing listens on: `psql` cannot connect, `queryLines` must raise with the runner's own output rather than returning
 * an empty result, and that is the property that matters — a gate that treated "could not connect" as "no rows" would
 * report a clean database.
 *
 * THE REDACTION ASSERTION IS A SECURITY PROPERTY, not a formatting one: a malformed DSN is reported back to a caller,
 * and the password must not travel with it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { parseDsn, queryLines, runSql } from '../../src/infrastructure/database/psql.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SECRET = 'sup3r-s3cret-password-shape';

/** The refusal a call produced, or `undefined` when it did not refuse. */
function refusalOf(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('parseDsn accepts a well-formed DSN and refuses everything else by name (DOD-032)', () => {
  test('a postgres DSN parses into the five fields the runner needs, and defaults the port', () => {
    const parsed = parseDsn(`postgres://vg_app:${SECRET}@127.0.0.1:5433/vanishgraph_main`);
    assert.deepEqual(parsed, {
      host: '127.0.0.1',
      port: '5433',
      database: 'vanishgraph_main',
      user: 'vg_app',
      password: SECRET,
    });
    assert.equal(parseDsn('postgres://u:p@db.example/vg').port, '5432', 'an absent port is 5432, not an error');
    assert.equal(parseDsn('postgresql://u:p@db.example/vg').host, 'db.example', 'both protocol spellings are accepted');
    // A percent-encoded password is DECODED, because the DSN carries it encoded and psql needs the value.
    assert.equal(parseDsn('postgres://u:a%40b%2Fc@db.example/vg').password, 'a@b/c');
  });

  test('a DSN that is not a postgres URL is refused, and the refusal does not carry the password', () => {
    const wrongProtocol = refusalOf(() => parseDsn(`mysql://vg_app:${SECRET}@127.0.0.1:5433/vanishgraph_main`));
    assert.ok(wrongProtocol instanceof Error);
    assert.match(wrongProtocol.message, /must use postgres:\/\//);
    assert.equal(wrongProtocol.message.includes(SECRET), false, 'a refusal must never echo the password');

    const malformed = refusalOf(() => parseDsn(`not a url at all ${SECRET}`));
    assert.ok(malformed instanceof Error);
    assert.match(malformed.message, /not a valid DSN URL/);
    assert.equal(malformed.message.includes(SECRET), false, 'and the redaction applies on this path too');
  });

  test('a DSN missing host, database or user is refused rather than guessed', () => {
    // psql would fall back to libpq defaults for each of these, which is how a gate ends up querying the WRONG database
    // and reporting a green result about it.
    for (const dsn of ['postgres:///vanishgraph_main', 'postgres://vg_app:pw@localhost', 'postgres://:pw@localhost/vg']) {
      const refusal = refusalOf(() => parseDsn(dsn));
      assert.ok(refusal instanceof Error, `${dsn} must be refused`);
      assert.match(refusal.message, /must carry host, database and user/);
      assert.equal(refusal.message.includes('pw'), false, 'and no refusal carries the password');
    }
  });
});

describe('the runner reports a failure instead of an empty result (DOD-024)', () => {
  test('queryLines raises with psql’s own output when the statement cannot run', () => {
    // PORT 1 HAS NO LISTENER, so this is a connection failure — the case a gate must never read as "no rows".
    const dead = parseDsn('postgres://vg_app:not-a-real-password@127.0.0.1:1/vanishgraph_main');
    const refusal = refusalOf(() => queryLines(dead, 'SELECT 1;'));
    assert.ok(refusal instanceof Error, 'a failed query must raise');
    assert.match(refusal.message, /query failed \(exit \d+\)/);
    assert.ok(refusal.message.length > 40, 'and it must carry the runner’s output, not just a status');
  });

  test('runSql returns the status and the captured output, with no piped stdio', () => {
    const dead = parseDsn('postgres://vg_app:not-a-real-password@127.0.0.1:1/vanishgraph_main');
    const result = runSql(dead, 'SELECT 1;');
    assert.notEqual(result.status, 0, 'the connection must fail');
    assert.ok(result.output.length > 0, 'and the reason must be in the output the runner returns');
    assert.equal(result.output.includes('not-a-real-password'), false, 'the password travels in the environment, never in output');
  });
});

describe('the CLI every gate script invokes', () => {
  test('no arguments: usage on stderr and exit 2', () => {
    // The gate scripts call this file as a subprocess, so its usage path is part of the harness contract.
    const script = resolve(ROOT, 'src/infrastructure/database/psql.ts');
    const run = (args: readonly string[]): { readonly status: number; readonly stderr: string } => {
      try {
        const stdout = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { status: 0, stderr: stdout };
      } catch (error) {
        const failure = error as { readonly status?: number; readonly stderr?: string };
        return { status: failure.status ?? -1, stderr: failure.stderr ?? '' };
      }
    };

    const usage = run([]);
    assert.equal(usage.status, 2, 'an unknown invocation is a usage error, not a silent success');
    assert.match(usage.stderr, /usage: node src\/infrastructure\/database\/psql\.ts query <dsn> <sql>/);

    const oneArgument = run(['query']);
    assert.equal(oneArgument.status, 2, 'a half-given command is the same usage error');
  });
});
