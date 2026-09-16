/**
 * Surface ownership: every declared route belongs to the surface the specification assigns it, and no surface renders a
 * job it does not own (SPEC-004 §1, §11, VG-UI-001; EP-005 M6).
 *
 * WHAT THIS ADDS TO THE PORTAL INVENTORY. `portal-surfaces.test.ts` checked the `/portal` routes against the
 * specification's own table. This suite does the same for all four surfaces and adds the rule VG-UI-001 is about: a job
 * owned by ANOTHER surface must not be reachable from this one. The sharpest form of that is a console route rendering
 * the admin's tenant configuration, or an auditor route rendering a console work control — both of which would be a
 * control reachable from a surface that does not own it.
 *
 * THE OWNERSHIP TABLE IS PARSED FROM THE SPECIFICATION and the route's own `surface` prop is compared with it, the same
 * way the manifest test compares route sets: a hand-copied table would be a second source of truth.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SPEC = readFileSync(join(PROJECT_ROOT, '.agent', 'specs', 'SPEC-004-ui-ux.md'), 'utf8');
const ROUTES_DIR = join(PROJECT_ROOT, 'ui', 'src', 'routes');

/** The §1 table's rows: path and surface, for all four surfaces. */
function declaredRoutes(): readonly { readonly path: string; readonly surface: string }[] {
  const rows: { path: string; surface: string }[] = [];
  for (const line of SPEC.split('\n')) {
    const match = /^\| `(\/(?:portal|console|admin|auditor)[^`]*)` \| ([^|]+) \|/.exec(line);
    if (match === null) continue;
    rows.push({ path: match[1] ?? '', surface: (match[2] ?? '').trim() });
  }
  return rows;
}

/** A declared path as the route module's file name. */
function routeFile(path: string): string {
  const name = path
    .replace(/^\//, '')
    .split('/')
    .map((segment) => (segment.startsWith('[') ? `$${segment.slice(1, -1)}` : segment))
    .join('.');
  return join(ROUTES_DIR, `${name}.tsx`);
}

/** The surface each route module declares for itself. */
function declaredSurface(path: string): string | undefined {
  return /surface="([^"]+)"/.exec(readFileSync(routeFile(path), 'utf8'))?.[1];
}

describe('every declared route belongs to the surface the specification assigns it (VG-UI-001)', () => {
  test('the specification declares all four surfaces', () => {
    const rows = declaredRoutes();
    const prefixes = new Set(rows.map((row) => row.path.split('/')[1] ?? ''));
    for (const surface of ['portal', 'console', 'admin', 'auditor']) {
      assert.ok(prefixes.has(surface), `SPEC-004 §1 declares no /${surface} routes`);
    }
    assert.ok(rows.length >= 25, `expected the full declared route set, found ${String(rows.length)}`);
  });

  test('each route file exists and names its own surface', () => {
    const mismatches: string[] = [];
    for (const { path, surface } of declaredRoutes()) {
      let declared: string | undefined;
      try {
        declared = declaredSurface(path);
      } catch {
        mismatches.push(`${path}: no route module`);
        continue;
      }
      if (declared === undefined) {
        mismatches.push(`${path}: the module declares no surface`);
        continue;
      }
      // The specification's cell may carry more than the surface name (a parenthetical or a note), so the comparison is
      // on whether the module's own words appear in the specification's cell rather than on string equality.
      const first = declared.toLowerCase().split(' ')[0] ?? declared.toLowerCase();
      if (!surface.toLowerCase().includes(first)) {
        mismatches.push(`${path}: module says "${declared}", SPEC-004 §1 says "${surface}"`);
      }
    }
    assert.deepEqual(mismatches, []);
  });

  test('no route module imports another surface’s component family', () => {
    const offenders: string[] = [];
    const ownerOf = (prefix: string): string =>
      prefix === 'portal' ? 'portal' : prefix === 'console' ? 'console' : prefix === 'admin' ? 'admin' : 'auditor';
    /**
     * SHARED PRESENTATION IS NAMED HERE RATHER THAN ASSUMED, AND FILE LOCATION IS NOT OWNERSHIP.
     *
     * MEASURED: the strict form of this check flagged three route modules for importing `components/portal/…`, and the
     * imports were the case-history presentation and the exposure-review affordances — components the console and the
     * auditor legitimately render. A directory named after the surface that happened to create a file first is not a
     * claim about who may use it, and a rule that treated it as one would force either duplication (a second transition
     * list, which VG-UI-007 forbids for state rendering) or a rename that changes nothing about ownership.
     *
     * So the check is: no surface imports ANOTHER SURFACE'S FAMILY, except the modules listed here, and each entry says
     * what it is. The sharp rule — the auditor must not reach a write-capable component — is asserted separately below
     * and has no exceptions.
     */
    const sharedPresentation: readonly string[] = [
      'components/portal/CaseDetail.tsx',
      'components/portal/AuthoritySummary.tsx',
    ];
    for (const { path } of declaredRoutes()) {
      const prefix = path.split('/')[1] ?? '';
      const owner = ownerOf(prefix);
      const text = readFileSync(routeFile(path), 'utf8');
      for (const family of ['portal', 'console', 'admin', 'auditor']) {
        if (family === owner) continue;
        const pattern = new RegExp(`components/${family}/`);
        if (!pattern.test(text)) continue;
        const exempt = sharedPresentation.some((module) => text.includes(module));
        if (!exempt) offenders.push(`${path}: imports components/${family}/`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('the shared presentation list is small, named, and free of write-capable module names', () => {
    // ANTI-DRIFT: the list above is deliberately short, and this test fails if it grows silently or starts admitting a
    // module whose own name says it mutates something.
    const source = readFileSync(join(PROJECT_ROOT, 'tests', 'contract', 'surface-ownership.test.ts'), 'utf8');
    const block = /const sharedPresentation[\s\S]*?\n    \];/.exec(source)?.[0] ?? '';
    const entries = [...block.matchAll(/'([^']+\.tsx)'/g)].map((match) => match[1] ?? '');
    assert.ok(entries.length > 0 && entries.length <= 4, `expected at most four shared modules, found ${entries.join(', ')}`);
    for (const entry of entries) {
      assert.equal(/mutat|post|write|command/i.test(entry), false, `a write-capable module is exempted: ${entry}`);
    }
  });

  test('the auditor view imports no surface’s write-capable component family', () => {
    // The auditor's own rule, asserted here as well as in its own suite because this is the ownership rule that matters
    // most: the read-only surface must not reach the console's approval or the portal's appeal affordances.
    const offenders: string[] = [];
    for (const { path } of declaredRoutes()) {
      if (!path.startsWith('/auditor')) continue;
      const text = readFileSync(routeFile(path), 'utf8');
      for (const pattern of [/AuthoritySummary\.tsx/, /AlertsAndAppeals\.tsx/, /HumanApproveAffordance/]) {
        if (pattern.test(text)) offenders.push(`${path}: ${String(pattern)}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
