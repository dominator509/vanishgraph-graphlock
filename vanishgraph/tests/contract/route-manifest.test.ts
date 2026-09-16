/**
 * The route manifest equals SPEC-004 §1's declared route table (VG-UI-004; EP-005 M1).
 *
 * THE SPECIFICATION IS PARSED, NOT COPIED. The 25 declared routes are read out of
 * `.agent/specs/SPEC-004-ui-ux.md` at test time, so this check cannot drift from the contract it enforces: editing the
 * specification changes the expectation, and a route that exists only in code fails.
 *
 * THE COMPARISON IS SET EQUALITY IN BOTH DIRECTIONS, which is what makes it a check rather than a count: a manifest
 * with 24 routes and a table with 25 fails on the missing one, and a route added without a specification row fails on
 * the extra one. A count comparison would pass for the wrong 25.
 *
 * THE NORMALISATION HAS ITS OWN TEST. TanStack Router names a dynamic segment `$caseId`; SPEC-004 writes `[caseId]`. If
 * the emitter's normalisation broke, this suite would fail with a diff that looks like three missing routes and three
 * extra ones — the most likely way this check could mislead — so `pathFromFileName` is asserted directly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { pathFromFileName, buildManifest } from '../../scripts/emit-route-manifest.ts';
import { surfaceOf } from '../../ui/src/routes/table.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SPEC = join(PROJECT_ROOT, '.agent', 'specs', 'SPEC-004-ui-ux.md');
const MANIFEST = join(PROJECT_ROOT, 'ui', 'src', 'route-manifest.json');

/** The §1 route table, as `{ path, surface }` rows, parsed from the specification. */
function declaredRoutes(): readonly { readonly path: string; readonly surface: string }[] {
  const spec = readFileSync(SPEC, 'utf8');
  const rows: { path: string; surface: string }[] = [];
  for (const match of spec.matchAll(/^\| `(\/[^`]+)` \| ([^|]+) \| ([^|]+) \|$/gm)) {
    rows.push({ path: match[1] ?? '', surface: (match[2] ?? '').trim() });
  }
  return rows;
}

describe('the emitted route manifest equals the declared route set', () => {
  test('the specification declares exactly the 25 routes this node expects', () => {
    const declared = declaredRoutes();
    // If this count changes, the SPECIFICATION changed: that is a contract amendment, not a test to adjust.
    assert.equal(declared.length, 25, `SPEC-004 §1 declares ${String(declared.length)} routes`);
    assert.equal(new Set(declared.map((row) => row.path)).size, 25, 'the declared paths must be distinct');
  });

  test('SET EQUALITY, BOTH DIRECTIONS: no missing route and no undeclared one', () => {
    const declared = new Set(declaredRoutes().map((row) => row.path));
    const emitted = new Set(buildManifest().routes);
    const missing = [...declared].filter((path) => !emitted.has(path));
    const undeclared = [...emitted].filter((path) => !declared.has(path));
    assert.deepEqual(missing, [], `declared but not emitted: ${missing.join(', ')}`);
    assert.deepEqual(undeclared, [], `emitted but not declared: ${undeclared.join(', ')}`);
  });

  test('the committed manifest file is the one the tree produces', () => {
    const onDisk = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { routes: readonly string[] };
    assert.deepEqual(
      [...onDisk.routes].sort(),
      [...buildManifest().routes].sort(),
      'ui/src/route-manifest.json is stale: run `npm run build:web`',
    );
  });

  test('a parameter is normalised from the framework form to the specification form', () => {
    assert.equal(pathFromFileName('portal.cases.$caseId.tsx'), '/portal/cases/[caseId]');
    assert.equal(
      pathFromFileName('portal.cases.$caseId.evidence.$evidenceId.tsx'),
      '/portal/cases/[caseId]/evidence/[evidenceId]',
    );
    // A static segment is untouched, so the normalisation cannot be "everything gets brackets".
    assert.equal(pathFromFileName('console.queue.tsx'), '/console/queue');
  });

  test('every declared route names a surface, and the surface is its first segment (VG-UI-001)', () => {
    for (const row of declaredRoutes()) {
      const surface = surfaceOf(row.path);
      assert.equal(
        row.surface.toLowerCase().startsWith(surface) ||
          // The specification spells the auditor surface "Auditor view" and the admin one "Tenant admin console", so
          // the check is that the declared surface CONTAINS the path prefix rather than that they are equal strings.
          row.surface.toLowerCase().includes(surface),
        true,
        `${row.path} declares surface "${row.surface}" but sits under /${surface}`,
      );
    }
  });

  test('the not-found state is not a route, and the layout is not either', () => {
    const emitted = buildManifest().routes;
    assert.equal(emitted.includes('/not-found'), false);
    assert.equal(emitted.includes('/__root'), false);
    assert.equal(emitted.includes('/table'), false);
  });
});
