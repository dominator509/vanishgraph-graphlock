#!/usr/bin/env node
/**
 * Emit the UI route manifest from the route tree (SPEC-004 §1, VG-UI-004; EP-005 M1).
 *
 * THE MANIFEST IS DERIVED FROM FILES, NOT FROM A LIST. A hand-written manifest is a second copy of the route table
 * and therefore a second thing to drift; this walks `ui/src/routes/**` (the file-based route convention) and derives
 * each path, so a page that exists is a route and a route that exists has a page.
 *
 * THE NORMALISATION IS THE POINT. TanStack Router names a dynamic segment `$caseId` and generates `/portal/cases/$caseId`;
 * SPEC-004 §1 declares `/portal/cases/[caseId]`. The manifest is emitted in the SPECIFICATION's bracket form, and
 * `tests/contract/route-manifest.test.ts` asserts the normalisation on its own — because a mismatch here would make the
 * equality test fail for a reason that has nothing to do with a missing route, which is the most likely way this check
 * could mislead.
 *
 * IT FAILS LOUDLY ON AN EMPTY TREE. A manifest with no routes would compare unequal to a 25-row table and fail anyway,
 * but the error a reader needs is "the route directory was not found", not "the sets differ".
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const ROUTES_DIR = join(PROJECT_ROOT, 'ui', 'src', 'routes');
const MANIFEST = join(PROJECT_ROOT, 'ui', 'src', 'route-manifest.json');

/**
 * File names that are NOT routes.
 *
 * `__root` is the layout that wraps every route and `not-found` is the state an undeclared route renders (VG-UI-004's
 * negative case): neither is a declared path, and emitting either would put them in the manifest diff.
 */
const NON_ROUTE_FILES = new Set(['__root', 'not-found', 'table']);

/**
 * A route file name to a route path.
 *
 * `portal.cases.$caseId.tsx` → `/portal/cases/[caseId]`. Dots separate segments, `$name` becomes `[name]`, and
 * `index` is the surface's own root.
 */
export function pathFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.tsx?$/, '');
  const segments = stem
    .split('.')
    .map((segment) => (segment === 'index' ? '' : segment))
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith('$') ? `[${segment.slice(1)}]` : segment));
  return `/${segments.join('/')}`;
}

export interface RouteManifest {
  readonly generatedBy: string;
  readonly routes: readonly string[];
}

export function buildManifest(): RouteManifest {
  let entries: string[];
  try {
    entries = readdirSync(ROUTES_DIR);
  } catch (error) {
    throw new Error(
      `the route directory does not exist: ${ROUTES_DIR} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const routes = entries
    .filter((entry) => entry.endsWith('.tsx'))
    .map((entry) => entry.replace(/\.tsx$/, ''))
    .filter((stem) => !NON_ROUTE_FILES.has(stem))
    .map((stem) => pathFromFileName(`${stem}.tsx`))
    .sort();
  if (routes.length === 0) {
    throw new Error(`no route files found under ${ROUTES_DIR}; refusing to emit an empty manifest`);
  }
  return { generatedBy: 'scripts/emit-route-manifest.ts', routes };
}

if (import.meta.filename === process.argv[1]) {
  const manifest = buildManifest();
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `route-manifest: ${String(manifest.routes.length)} route(s) written to ui/src/route-manifest.json\n`,
  );
}
