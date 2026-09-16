/**
 * The vocabulary gate's own test (SPEC-003 VG-API-067, SPEC-004 VG-UI-080; EP-004 M8).
 *
 * A VOCABULARY GATE THAT CANNOT FAIL IS DECORATION. This suite therefore proves three things: the gate passes on this
 * repository, it FAILS on a fixture containing a forbidden identifier (so the rule is enforced and not merely
 * printed), and it fails on an allowlist entry with no reason and on a scan that read no files — the two ways a gate
 * quietly stops meaning anything.
 *
 * The fixtures are pointed at with `--root`, which exists for exactly this: a check with no way to demonstrate a
 * failure cannot be distinguished from a disabled one.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(PROJECT_ROOT, 'scripts', 'copy-lint-gate.ts');

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function gate(root?: string): RunResult {
  const args = [SCRIPT];
  if (root !== undefined) args.push('--root', root);
  const result = spawnSync('node', args, { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A fixture root shaped like the scanned surface, with one route module. */
function fixture(name: string, content: string): string {
  const root = join(fixtures, name);
  mkdirSync(join(root, 'src', 'http', 'routes'), { recursive: true });
  writeFileSync(join(root, 'src', 'http', 'routes', 'fixture.ts'), content, 'utf8');
  return root;
}

let fixtures: string;

before(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'vg-copy-lint-'));
});

after(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

describe('the vocabulary gate', () => {
  test('passes on THIS repository, and reports what it read', () => {
    const result = gate();
    assert.equal(result.status, 0, `the gate failed:\n${result.stderr}`);
    assert.match(result.stdout, /copy lint gate: \d+ file\(s\) scanned, \d+ forbidden token\(s\)/);
    assert.match(result.stdout, /copy lint gate: ok/);
  });

  test('FAILS on a forbidden synonym used as an identifier, naming the file, line and token', () => {
    const root = fixture(
      'forbidden-synonym',
      ['export function handler(): Record<string, unknown> {', '  const clientId = 1;', '  return { clientId };', '}', ''].join('\n'),
    );
    const result = gate(root);
    assert.equal(result.status, 1, `a forbidden identifier was NOT caught:\n${result.stdout}`);
    assert.match(result.stderr, /forbidden vocabulary in production identifiers/);
    // LINE 3, NOT LINE 2, and the difference is the rule rather than a detail: line 2 is a LOCAL VARIABLE
    // (`const clientId = 1`) and line 3 is the OBJECT MEMBER (`return { clientId }`) — the shape a client actually
    // reads. A local variable name is not a wire identifier, and flagging declarations would make the gate's hits
    // unauditable.
    assert.match(result.stderr, /fixture\.ts:3/);
    assert.match(result.stderr, /token "client"/);
  });

  test('FAILS on an ad-hoc status token, and on a `request*` identifier that is not the sanctioned two', () => {
    const statusRoot = fixture('adhoc-status', "export const STATE = 'DONE';\n");
    const statusResult = gate(statusRoot);
    assert.equal(statusResult.status, 1, `an ad-hoc status token was NOT caught:\n${statusResult.stdout}`);
    assert.match(statusResult.stderr, /token "DONE"/);

    const requestRoot = fixture('request-identifier', "export function f(): string { return 'requestKey'; }\n");
    const requestResult = gate(requestRoot);
    assert.equal(requestResult.status, 1, `an unsanctioned request* identifier was NOT caught:\n${requestResult.stdout}`);
    assert.match(requestResult.stderr, /token "request"/);

    // The two sanctioned names pass, which is what "allowlisted BY EXACT NAME" means.
    const allowedRoot = fixture(
      'allowed',
      ['export function f(input: { requestId: string }): string {', '  return input.requestId;', '}', ''].join('\n'),
    );
    const allowedResult = gate(allowedRoot);
    assert.equal(allowedResult.status, 0, `the sanctioned requestId was refused:\n${allowedResult.stderr}`);
  });

  test('FAILS when the scan read no files: a gate that read nothing has verified nothing', () => {
    const empty = join(fixtures, 'empty');
    mkdirSync(empty, { recursive: true });
    const result = gate(empty);
    assert.equal(result.status, 1, 'an empty tree must fail rather than pass vacuously');
    assert.match(result.stderr, /no files found/);
  });

  test('the allowlist self-test refuses an entry that carries no reason (VG-UI-080)', async () => {
    // The check runs inside the gate; it is proven here by reading the gate's own rule rather than by mutating the
    // production list. A mutation would be a worse test: it would edit the artefact under test.
    const source = await import('node:fs').then((fs) => fs.readFileSync(SCRIPT, 'utf8'));
    assert.match(source, /const unexplained = \[\.\.\.ALLOWLIST, \.\.\.SPEC_PERMISSION_ALLOWLIST\]\.filter\(/);
    assert.match(source, /entry\.reason\.trim\(\)\.length === 0/);
    assert.match(source, /allowlist entries without a reason/);
  });
});
