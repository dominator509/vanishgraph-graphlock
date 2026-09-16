/**
 * Harness self-tests: the gates must be able to fail.
 *
 * A green gate proves nothing unless the gate can go red. These tests run the real
 * gate scripts and assert on their real exit status and real output. They are the
 * regression guard for the failure mode this repository was generated with: scripts
 * that printed success sentinels unconditionally (DOD-024, DOD-027).
 *
 * Child processes are run with output redirected to a file and stdio inherited,
 * never through a pipe: that keeps the harness portable to confined environments
 * where piped stdio is unavailable, and it leaves a raw log on disk (DOD-025).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * Convert a host path into the form the POSIX shell can read.
 *
 * On this platform `node:os` `tmpdir()` returns `C:\tmp`, and the MSYS `sh` that runs
 * the gates cannot open the backslash form (it reads `C:\tmp\x` as an escape sequence).
 * Every path handed to a child `sh` must therefore use forward slashes. This is a real
 * portability requirement of the harness, not a cosmetic one: it silently made the
 * manifest unreadable and turned a passing guard into a confusing failure.
 */
function shellPath(hostPath: string): string {
  return hostPath.replace(/\\/g, '/');
}

interface RunResult {
  readonly status: number | null;
  readonly output: string;
}

/** Run a shell command line in the project root, capturing output through a file. */
function runLine(commandLine: string): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'vg-harness-'));
  const outFile = join(dir, 'output.txt');
  writeFileSync(outFile, '');
  const result = spawnSync('sh', ['-c', `${commandLine} > "${shellPath(outFile)}" 2>&1`], {
    cwd: ROOT,
    stdio: 'inherit',
    // THE CEILING IS FOR A HUNG GATE, NOT FOR A SLOW MACHINE, and it is measured rather than guessed.
    //
    // MEASURED FAILURE this corrects: at 180s, `scripts/format-check.sh` passed in ~46s when this suite ran
    // alone (the unit stage) and exceeded the ceiling when `refresh-verification-state.ts --with-db` ran every
    // root — domain, harness, architecture, contract and 22 database files — CONCURRENTLY. The spawn was killed,
    // `status` was null, the captured output was empty, and the test reported `format-check.sh failed:` with
    // nothing after the colon. A gate that was working was recorded as broken, and the failure signature (no
    // output at all, versus a formatting diff) is the only thing that distinguished the two.
    //
    // Raising the ceiling does NOT weaken the assertion: the test still requires exit 0 AND the sentinel, so a
    // gate that genuinely hangs or genuinely fails is still caught. What it stops doing is calling a slow,
    // contended but CORRECT gate a failure.
    timeout: 600_000,
  });
  const output = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, output };
}

function scriptFiles(): string[] {
  return readdirSync(join(ROOT, 'scripts'))
    .filter((name) => name.endsWith('.sh'))
    .map((name) => `scripts/${name}`)
    .sort();
}

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

describe('every shell gate is POSIX-parseable', () => {
  for (const file of scriptFiles()) {
    test(`${file} passes sh -n`, () => {
      const result = runLine(`sh -n ${file}`);
      assert.equal(result.status, 0, `${file} failed sh -n:\n${result.output}`);
    });
  }
});

describe('no script prints a success sentinel from a fake path', () => {
  // A script is hollow when it prints a "…: ok" sentinel but its only executable
  // statements are printing. That is the exact fabrication pattern this pack was
  // generated with, so it is asserted structurally as well as behaviourally.
  const controlOnly =
    /^\s*(#!|set\s|export\s|cd\s|echo\s|printf\s|fi\s*$|done\s*$|esac\s*$|else\s*$|\}\s*$|then\s*$|do\s*$|case\s|;;)/;

  for (const file of scriptFiles()) {
    const body = read(file);
    if (!/^\s*echo\s+"[^"]*: ok"/m.test(body)) continue;
    test(`${file} performs real work before its sentinel`, () => {
      const statements = body
        .split('\n')
        .filter((line) => line.trim() !== '' && !controlOnly.test(line));
      assert.ok(
        statements.length > 0,
        `${file} prints a success sentinel but executes no check (DOD-024, DOD-027)`,
      );
    });
  }
});

describe('loud-fail placeholders fail loudly (VG-SHIP-033)', () => {
  const placeholders = scriptFiles().filter((file) => read(file).includes('vg_loud_fail'));
  // While any placeholder remains in the repository this list is non-empty; a node
  // that implements a gate removes it from the list by implementing it for real.
  for (const file of placeholders) {
    test(`${file} exits non-zero with the mandated ERROR signature and no sentinel`, () => {
      const result = runLine(`sh ${file}`);
      assert.notEqual(result.status, 0, `${file} must not exit 0 while unimplemented`);
      assert.match(
        result.output,
        /ERROR: .* is an unimplemented placeholder; replaced during EP-000 discovery milestone M1/,
        `${file} must fail with the mandated message, got:\n${result.output}`,
      );
      assert.doesNotMatch(
        result.output,
        /: ok\s*$/m,
        `${file} printed a success sentinel while unimplemented:\n${result.output}`,
      );
    });
  }
});

describe('test collection guard (DOD-007)', () => {
  // WHY THE COLLECTION GUARD IS NOT SPAWNED FROM INSIDE THIS FILE.
  //
  // `scripts/test-collection-guard.sh` runs `node --test`. Spawning it from a test
  // file means invoking `node --test` recursively inside a `node --test` run, which
  // Node refuses: "node:test run() is being called recursively within a test file.
  // skipping running files." The inner run therefore collects nothing and reports
  // zero tests — a failure caused entirely by the nesting, not by the guard.
  //
  // This is the case the M4 FALLBACK anticipates. The behavioural half of the
  // zero-collection proof is exercised by `scripts/gate-foundation.sh` (M7) and by
  // `scripts/test-unit.sh` / `scripts/test-collection-guard.sh` running as top-level
  // gates in `verify.sh`, where there is no nesting. What this suite asserts instead
  // is the guard's *contract*, statically and without recursion: that it is
  // parameterised, that it delegates parsing to the summary module, and that the
  // summary module actually implements each DOD-007 rule. Those are the properties
  // that would silently regress; the spawn-based proof lives in the gate.
  const guard = read('scripts/test-collection-guard.sh');
  const summary = read('scripts/count-tests.mjs');

  test('the guard is parameterised rather than hard-coding its glob and manifest', () => {
    assert.match(guard, /VG_TEST_GLOB/, 'the guard must honour VG_TEST_GLOB');
    assert.match(guard, /VG_EXPECTED_MANIFEST/, 'the guard must honour VG_EXPECTED_MANIFEST');
    assert.match(guard, /EXPECTED_TEST_MANIFEST\.txt/, 'the guard must have a default manifest');
  });

  test('the guard uses the JUnit reporter, which carries the per-case file attribute', () => {
    // TAP does not emit the file attribute, so per-suite manifest verification is
    // impossible with it. Switching reporters would silently disable that check.
    assert.match(guard, /--test-reporter=junit/);
    assert.doesNotMatch(guard, /--test-reporter=tap/);
  });

  test('the guard fails when zero tests are collected (DOD-007)', () => {
    assert.match(summary, /zero tests were collected/);
    assert.match(summary, /if \(tests === 0\)/);
  });

  test('the guard fails when a manifest suite contributes nothing (DOD-007)', () => {
    assert.match(summary, /expected suite produced no results/);
    assert.match(summary, /contributed no real tests/);
  });

  test('the guard fails when a collected test fails (DOD-006, DOD-024)', () => {
    assert.match(summary, /test\(s\) failed/);
  });

  test('the guard reports skips rather than hiding them (DOD-006)', () => {
    assert.match(summary, /skipped/);
    assert.match(summary, /DOD-006 requires an approved/);
  });

  test('the guard does not print its sentinel when it fails', () => {
    // The sentinel must be the last statement, after the pipeline. If it were printed
    // before, a failing run would still report success.
    const sentinelIndex = guard.indexOf('echo "test collection guard: ok"');
    assert.ok(sentinelIndex > 0, 'the sentinel must exist');
    assert.ok(
      sentinelIndex > guard.indexOf('count-tests.mjs'),
      'the sentinel must come after the summary check, never before it',
    );
  });
});

describe('verify.sh stage order is the mandated fifteen stages (line 1357)', () => {
  test('stage names appear once each, in order', () => {
    const body = read('scripts/verify.sh');
    const block = body.split('STAGES="')[1]?.split('"')[0] ?? '';
    const names = block
      .split('\n')
      .map((line) => line.split(':')[0]?.trim() ?? '')
      .filter((name) => name.length > 0);
    assert.deepEqual(names, [
      'preflight',
      'lint',
      'format-check',
      'typecheck',
      'unit',
      'integration',
      'security-check',
      'dependency-audit',
      'reality-gate',
      'test-collection-guard',
      'build',
      'artifact-identity',
      'smoke',
      'e2e',
      'live-fire',
    ]);
  });

  test('no stage is exempted and no failure is masked', () => {
    const body = read('scripts/verify.sh');
    assert.doesNotMatch(body, /continue-on-error|\|\|\s*true|set\s\+e/);
    assert.match(body, /sh "scripts\/\$script"/);
  });
});

describe('PREFLIGHT contract and .env.example agree (independent parse)', () => {
  // This is a second, independent implementation of the check in
  // scripts/validate-env.sh. Two implementations disagreeing is itself a finding.
  const declared = new Set(
    read('PREFLIGHT.md')
      .split('PREFLIGHT-TABLE-BEGIN')[1]
      ?.split('PREFLIGHT-TABLE-END')[0]
      ?.split('\n')
      .map((line) => line.split('|')[0]?.trim() ?? '')
      .filter((name) => name.length > 0) ?? [],
  );
  const documented = new Set(
    read('.env.example')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => line.split('=')[0] ?? ''),
  );

  test('the table declares at least one REQUIRED credential', () => {
    assert.ok(declared.size > 0, 'PREFLIGHT.md declares no variables');
  });

  test('every declared variable is documented', () => {
    const missing = [...declared].filter((name) => !documented.has(name));
    assert.deepEqual(missing, [], `undeclared in .env.example: ${missing.join(', ')}`);
  });

  test('no stale entries in .env.example', () => {
    const stale = [...documented].filter((name) => !declared.has(name));
    assert.deepEqual(stale, [], `stale in .env.example: ${stale.join(', ')}`);
  });

  test('.env.example holds no value other than the placeholder (VG-SEC-002)', () => {
    const offending = read('.env.example')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .filter((line) => !line.endsWith('=PROVISION_ME'));
    assert.deepEqual(offending, []);
  });
});

describe('repository hygiene', () => {
  test('the lockfile is tracked by git (DOD-002)', () => {
    const result = runLine('git ls-files --error-unmatch package-lock.json');
    assert.equal(result.status, 0, 'package-lock.json is not tracked');
  });

  /**
   * The invariant is EXACT PINNING, not the absence of runtime dependencies.
   *
   * EP-001 wrote `assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [])`, which held only
   * because the project was domain-only and the domain imports nothing but the standard library.
   * EP-004 legitimately adds a service layer with runtime dependencies (HTTP framework, DB
   * driver, OIDC verification, structured logging), so an empty-dependencies assertion would
   * fail for real progress — and deleting it would drop the reproducibility property it was
   * actually protecting (DOD-002).
   *
   * What replaces it is the same property stated correctly, plus a guard that the production
   * set cannot grow silently: a new runtime dependency must be added to the allow-list below in
   * the same change that adds it, so the decision is visible in review rather than appearing in
   * a lock file.
   */
  test('every runtime and dev dependency is exact-pinned to a concrete version', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    // An allowed production dependency set. Adding to it is a deliberate act.
    const allowedRuntime = [
      '@fastify/type-provider-json-schema-to-ts',
      'fastify',
      'ioredis',
      'jose',
      'pg',
      'pino',
    ];

    for (const name of Object.keys(pkg.dependencies ?? {})) {
      assert.ok(
        allowedRuntime.includes(name),
        `${name} is a new runtime dependency; add it to allowedRuntime deliberately (EP-004 M1)`,
      );
    }

    // No range specifier anywhere: `^`, `~`, `*`, `latest`, or a bare tag makes two installs of
    // the same lock file disagree about what is installed.
    for (const [name, spec] of Object.entries({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    })) {
      assert.match(
        spec,
        /^\d+\.\d+\.\d+$/,
        `${name} is not exact-pinned: ${spec}`,
      );
    }
  });

  test('the domain layer still imports only the standard library, now that runtime deps exist', () => {
    // EP-001's original assertion (`dependencies` is empty) was a PROXY for this property, and a
    // proxy that stopped being true the moment a service layer was added. The property itself is
    // what matters: nothing in src/domain may import fastify, pg, ioredis, jose or pino, because
    // a privacy rule that can be satisfied by a network call is not a rule.
    //
    // scripts/import-boundary.sh is the enforcement; this asserts the enforcement is doing its
    // job on the real tree rather than trusting it ran.
    const violations: string[] = [];
    // `read()` resolves against ROOT, so walk relative paths and let `read` do the joining. A
    // first version passed absolute paths into `read` and produced a doubled root in the ENOENT.
    const walk = (relativeDir: string): void => {
      for (const entry of readdirSync(join(ROOT, relativeDir), { withFileTypes: true })) {
        const relative = `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(relative);
        } else if (entry.name.endsWith('.ts')) {
          const text = read(relative);
          for (const match of text.matchAll(/(?:from|import)\s*'([^']+)'/g)) {
            const spec = match[1] ?? '';
            const isRelative = spec.startsWith('./') || spec.startsWith('../');
            const isBuiltin = spec.startsWith('node:');
            if (!isRelative && !isBuiltin) {
              violations.push(`${relative}: ${spec}`);
            }
          }
        }
      }
    };
    walk('src/domain');
    assert.ok(
      readdirSync(join(ROOT, 'src', 'domain')).length > 0,
      'src/domain must exist and be non-empty, or this check proves nothing',
    );
    assert.deepEqual(violations, [], 'src/domain must import only node:* and relative paths');
  });

  test('.gitignore keeps credentials out and evidence in (DOD-025, VG-SEC-002)', () => {
    const ignore = read('.gitignore');
    for (const required of ['node_modules/', 'dist/', '.env', '.env.*', '!.env.example']) {
      assert.ok(ignore.includes(required), `.gitignore must contain ${required}`);
    }
    assert.doesNotMatch(ignore, /^\.agent\/evidence\/?$/m, '.agent/evidence/ must be committed');
  });
});

describe('gates that M4 depends on really pass', () => {
  // Only gates ALREADY implemented at this point in the node appear here. Adding a
  // gate to this list before its implementing milestone runs would make M4 red for a
  // reason M4 does not own. `reality-gate.sh` and `dependency-audit.sh` are
  // deliberately absent: they are implemented by M5, and until then they are covered
  // by the loud-fail placeholder suite above, which asserts they fail honestly.
  for (const [file, sentinel] of [
    ['scripts/format-check.sh', 'format-check: ok'],
    ['scripts/validate-env.sh', 'env validation: ok'],
    ['scripts/import-boundary.sh', 'import boundary: ok'],
    ['scripts/typecheck.sh', 'typecheck: ok'],
    ['scripts/gate-toolchain.sh', 'gate-toolchain: ok'],
  ] as const) {
    test(`${file} prints ${sentinel}`, () => {
      const result = runLine(`sh ${file}`);
      assert.equal(result.status, 0, `${file} failed:\n${result.output}`);
      assert.match(
        result.output,
        new RegExp(`${sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`),
      );
    });
  }
});
