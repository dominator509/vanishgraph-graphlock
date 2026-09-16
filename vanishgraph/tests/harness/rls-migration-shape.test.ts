/**
 * The RLS generator's file shape, pinned because it silently deleted hand-written SQL (EP-004 M7).
 *
 * WHAT HAPPENED, MEASURED. `scripts/generate-rls.ts` renders a migration that creates a tenant-scoped table as
 * `head = original.split('-- RLS-GENERATED-BEGIN')[0]` followed by REGENERATED blocks. Everything after the first
 * marker is therefore discarded on `--write` — and `--check` reports zero drift either way, because drift is computed
 * between the rendered result and the file it just rendered. A capability policy written below the marker in
 * migration `0032` did not survive, `0032` had already been applied without it, and every webhook capability
 * resolution returned `undefined` until the database was inspected directly.
 *
 * THE RULE THIS TEST ENFORCES: no migration may carry SQL after its final marker, because that SQL is invisible to
 * the generator and is destroyed the next time someone regenerates. Hand-written policy belongs in a migration that
 * creates no table — the generator returns those UNCHANGED — which is where migration `0033` puts it.
 *
 * WHAT IT DOES NOT DO: it does not test that the generator is correct. It tests the property a developer depends on,
 * which is that a file in the repository means what it says after `--write` has run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const MIGRATIONS = join(PROJECT_ROOT, 'db', 'migrations');
const END_MARKER = '-- RLS-GENERATED-END';

/** Every migration file, sorted, as `[name, content]`. */
function migrations(): readonly (readonly [string, string])[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => [name, readFileSync(join(MIGRATIONS, name), 'utf8')] as const);
}

describe('migrations that create a tenant-scoped table', () => {
  test('carry NO SQL after their final generated marker', () => {
    const offenders: string[] = [];
    for (const [name, content] of migrations()) {
      const lastMarker = content.lastIndexOf(END_MARKER);
      if (lastMarker === -1) continue;
      const tail = content.slice(lastMarker + END_MARKER.length);
      // A trailing newline is not SQL. Anything else would be dropped by the next `--write`.
      if (tail.trim().length > 0) offenders.push(`${name}: ${tail.trim().split('\n')[0] ?? ''}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `these migrations would lose their trailing SQL on the next generate-rls --write:\n${offenders.join('\n')}`,
    );
  });

  test('are idempotent under the generator: --check passes on the committed tree', async () => {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('node', [join(PROJECT_ROOT, 'scripts', 'generate-rls.ts'), '--check'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `generate-rls --check failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /rls generation: \d+ tenant-scoped tables, \d+ migrations, drift 0/);
  });

  test('every tenant-scoped table in the list is created by some migration that also isolates it', () => {
    const all = migrations()
      .map(([, content]) => content)
      .join('\n');
    const listed = readFileSync(join(PROJECT_ROOT, 'db', 'tenant-scoped-tables.txt'), 'utf8')
      .split('\n')
      .map((line) => line.split('#')[0]?.trim() ?? '')
      .filter((line) => line.length > 0);
    assert.ok(listed.length > 0, 'the tenant-scoped table list must not be empty');
    for (const table of listed) {
      assert.match(all, new RegExp(`CREATE TABLE\\s+${table}\\s*\\(`, 'i'), `${table} is listed but never created`);
      assert.match(
        all,
        new RegExp(`ALTER TABLE\\s+${table}\\s+FORCE\\s+ROW LEVEL SECURITY`, 'i'),
        `${table} is listed but its FORCE RLS block is missing`,
      );
    }
  });
});
