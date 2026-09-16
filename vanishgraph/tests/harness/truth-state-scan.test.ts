/**
 * The handler scan's own test: it must still FAIL on a real violation, and it must pass on the shapes that are not
 * violations (EP-004 M6, SPEC-001 SM-6).
 *
 * WHY THIS FILE EXISTS AT ALL. `scripts/scan-truth-state-input.ts` kept `gate-api.sh` red for several milestone
 * commits with six hits, every one of them a false positive of a bare `truthState\s*:` line match — response object
 * literals, a helper's parameter type, a function signature. A scan that reports failures on correct code is as
 * useless as one that reports nothing, and NEITHER can be told apart from a working scan without a fixture that
 * demonstrates both directions. The fixture trees below are that demonstration: each one is written to a temporary
 * directory and the scan is pointed at it with `--root`, which exists for exactly this purpose.
 *
 * WHAT IT DOES NOT CLAIM: that the scan proves no route accepts a truth state. It proves the RULE it implements is
 * enforced, over the files it reads.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SCANNER = join(PROJECT_ROOT, 'scripts', 'scan-truth-state-input.ts');

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run the scan over `root`, returning its exit status and both streams. */
function scan(root?: string): RunResult {
  const args = [SCANNER];
  if (root !== undefined) args.push('--root', root);
  const result = spawnSync('node', args, { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

let fixtures: string;

/** Write a fixture tree and return its root. */
function fixture(name: string, content: string): string {
  const dir = join(fixtures, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'route.ts'), content, 'utf8');
  return dir;
}

before(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'vg-truth-state-scan-'));
});

after(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

describe('the handler scan', () => {
  test('passes over the REAL tree, and reports what it looked at', () => {
    const result = scan();
    assert.equal(result.status, 0, `scan failed:\n${result.stderr}`);
    // The summary is the evidence that the scan actually read files rather than exiting early on an empty glob.
    assert.match(result.stdout, /scan-truth-state-input: \d+ http file\(s\) scanned, \d+ input-schema block\(s\), 0 violations/);
  });

  test('FAILS when a request schema declares truthState as an input property', () => {
    const root = fixture(
      'schema-violation',
      [
        'app.post("/v1/thing", {',
        "  schema: {",
        "    body: {",
        "      type: 'object',",
        "      properties: {",
        "        truthState: { type: 'string' },",
        '      },',
        '    },',
        '  },',
        '}, handler);',
        '',
      ].join('\n'),
    );
    const result = scan(root);
    assert.equal(result.status, 1, `a genuine violation was NOT caught:\n${result.stdout}`);
    assert.match(result.stderr, /a request schema declares truthState as an input property/);
    assert.match(result.stderr, /route\.ts:/);
  });

  test('FAILS when a handler READS a truth state out of request input', () => {
    // The form this codebase can actually commit: no route here declares a Fastify `schema:` option, because bodies
    // are parsed by hand. Both spellings are covered.
    for (const [name, line] of [
      ['read-dot', "const wanted = body.truthState;"],
      ['read-index', "const wanted = body['truthState'];"],
      ['read-query', "const wanted = request.query['truthState'];"],
    ] as const) {
      const root = fixture(name, ['function handler(request, body) {', `  ${line}`, '  return wanted;', '}', ''].join('\n'));
      const result = scan(root);
      assert.equal(result.status, 1, `${name} was NOT caught:\n${result.stdout}`);
      assert.match(result.stderr, /a handler reads truthState from request input/);
    }
  });

  test('PASSES on a RESPONSE literal, a helper parameter and a function signature', () => {
    // This is the exact shape that produced the false positives: `truthState` as OUTPUT, plus a helper that takes a
    // state as an argument. None of it lets a caller assert a state, so none of it may fail the scan.
    const root = fixture(
      'response-only',
      [
        'function etagFor(truthState: string, epochMillis: number): string {',
        '  return `${truthState}:${String(epochMillis)}`;',
        '}',
        '',
        'function caseEtag(precondition: { readonly truthState: string; readonly updatedAtMs: number }): string {',
        '  return etagFor(precondition.truthState, precondition.updatedAtMs);',
        '}',
        '',
        'async function handler(outcome) {',
        '  return {',
        '    status: 201,',
        '    body: {',
        '      caseId: outcome.caseId,',
        '      truthState: outcome.truthState,',
        '      truthStateChangedAt: outcome.changedAt,',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
    const result = scan(root);
    assert.equal(result.status, 0, `a response-only file failed the scan:\n${result.stderr}`);
  });

  test('STILL fails on a route path that names a state, and on a tree with no files at all', () => {
    // BOTH forms a path is declared in: a registry entry, and a direct registration. MEASURED: with only the
    // registry form the rule missed `app.get('/v1/things/MATCH_CONFIRMED', handler)`, which is why this test uses a
    // registration for the first assertion and the registry form for the second.
    const registered = fixture('path-violation', "app.get('/v1/things/MATCH_CONFIRMED', handler);\n");
    const registeredResult = scan(registered);
    assert.equal(registeredResult.status, 1, `a registered path naming a state was NOT caught:\n${registeredResult.stdout}`);
    assert.match(registeredResult.stderr, /a route path names truth state MATCH_CONFIRMED/);

    const declared = fixture('path-declared', "const route = { path: '/v1/things/HUMAN_REQUIRED', method: 'GET' };\n");
    const declaredResult = scan(declared);
    assert.equal(declaredResult.status, 1, `a declared path naming a state was NOT caught:\n${declaredResult.stdout}`);
    assert.match(declaredResult.stderr, /a route path names truth state HUMAN_REQUIRED/);

    // A root with nothing in it is a FAILURE, not a pass: a scan that reads no files has verified nothing.
    mkdirSync(join(fixtures, 'empty'), { recursive: true });
    const empty = scan(join(fixtures, 'empty'));
    assert.equal(empty.status, 1, 'an empty tree must fail rather than pass vacuously');
    assert.match(empty.stderr, /no TypeScript files found/);
  });
});
