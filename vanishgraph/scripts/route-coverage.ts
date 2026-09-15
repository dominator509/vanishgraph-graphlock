#!/usr/bin/env node
/**
 * Route coverage: which SPEC-003 §5 registry routes actually have a handler?
 *
 * WHY THIS EXISTS. `gate-api.sh` used to infer progress from a FILE COUNT — "are there more than one
 * file under src/http/routes?" That became a false negative the moment a second file existed, and it
 * reported "nothing missing" while 78 of 78 registry routes had no handler. A gate that under-reports
 * missing work is worse than no gate, because its output reads as coverage.
 *
 * This asks the SERVER which paths it registered and compares that set against the registry, so the
 * number is measured rather than assumed.
 *
 * IT PRINTS A COUNT AND THE MISSING ROUTES. It does not FAIL on an incomplete catalogue: this node's
 * remaining handlers are legitimately unfinished work, and a gate that fails until the last route
 * lands would block every intermediate commit (DOD-031). What it must never do is claim coverage it
 * does not have, which is why the count is printed on every run.
 *
 * Exit codes: 0 when the measurement succeeded, 1 when it could not be taken. A measurement failure
 * is NOT the same as low coverage and must not be reported as such.
 */

import { buildServer } from '../src/http/server.ts';
import { ROUTES } from '../src/http/openapi/registry.ts';

/** Minimal dependencies: this only enumerates routes, so nothing should touch a service. */
const app = buildServer({
  version: 'coverage',
  commit: 'coverage',
  logLevel: 'silent',
  identity: { verify: async () => ({ ok: false, code: 'TOKEN_MISSING', detail: 'coverage probe' }) },
  tenancy: {
    runner: {
      withTenantTransaction: async () => {
        throw new Error('the coverage probe performs no database work');
      },
    },
  },
  idempotency: {
    store: {
      begin: async () => ({ state: 'NEW' as const }),
      complete: async () => {},
      abandon: async () => {},
    },
    requirementFor: () => undefined,
  },
  sessionSecret: 'coverage-probe-not-a-real-secret',
  subjectQueries: {
    listSubjects: async () => [],
    getSubjectDetail: async () => undefined,
    subjectExists: async () => false,
    listAliases: async () => [],
    listIdentifiers: async () => [],
    listLocationHistory: async () => [],
    listAuthorityGrants: async () => [],
    jurisdictionResolves: async () => false,
    appendLocationHistory: async () => ({ locationHistoryId: 'coverage' }),
    appendAlias: async () => ({
      aliasId: 'coverage',
      addedAt: new Date(0).toISOString(),
      quarantined: false,
      candidateSubjectIds: [],
    }),
  },
  health: {
    startedAt: new Date(),
    now: () => new Date(),
    probes: [async () => ({ name: 'coverage', ok: true })],
  },
});

/**
 * Registered routes as `METHOD /path`, with Fastify's `:param` form normalised to `{param}`.
 *
 * `printRoutes({ commonPrefix: false })` returns a TREE, not a flat list. Measured output:
 *
 *     ├── /v1/subjects (GET, HEAD, POST)
 *     │   └── /:subjectId (GET, HEAD, PATCH)
 *     │       └── /aliases (GET, HEAD, POST)
 *     └── /v1/health (GET, HEAD)
 *
 * Two properties of that format broke a first, naive parser:
 *
 *   1. **Nesting.** A child line carries only the path SEGMENT (`/:subjectId`), so the full path has
 *      to be accumulated from the tree's indentation depth.
 *   2. **Several methods per line**, comma-separated, including Fastify's automatic `HEAD`. A parser
 *      expecting one method per line matched nothing and reported 0 of 78 — a false negative that
 *      looks exactly like "nothing is implemented".
 *
 * `HEAD` is dropped: it is added automatically for every `GET` and is not a route the contract lists.
 * A handler count that included it would overstate coverage by ~40%.
 *
 * The TREE ROOT sits at depth 1, not 0 (`├── /v1/subjects`), which is why the parent lookup below
 * indexes `depth - 1` rather than `depth`. An off-by-one there produced a first version that reported
 * `0 of 78` — the same false negative it exists to prevent.
 */
await app.ready();

function registered(): Set<string> {
  const out = new Set<string>();
  const printed = app.printRoutes({ commonPrefix: false });
  // Depth is the count of leading tree glyphs, so a child's segment can be appended to its parent's.
  const stack: string[] = [];

  for (const line of printed.split('\n')) {
    if (line.trim().length === 0) continue;
    const match = /^([\s│├└─]*)(\/\S*)\s*\(([^)]*)\)\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;

    // Each level of the tree contributes four columns (a glyph plus three spaces, or four spaces).
    const depth = Math.floor(match[1].length / 4);
    const segment = match[2];
    stack.length = depth;
    // A segment that has no leading slash after the root is still a path continuation.
    const parent = depth === 0 ? '' : (stack[depth - 1] ?? '');
    const full = segment.startsWith('/v1') ? segment : `${parent}${segment}`;
    stack[depth] = full;

    for (const method of match[3].split(',').map((m) => m.trim())) {
      if (method.length === 0 || method === 'HEAD') continue;
      out.add(`${method} ${full.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')}`);
    }
  }
  return out;
}

const have = registered();
const want = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));

const missing = [...want].filter((key) => !have.has(key)).sort();
const extra = [...have].filter((key) => !want.has(key) && key.startsWith('/v1')).sort();

console.log(
  `route coverage: ${String(ROUTES.length - missing.length)} of ${String(ROUTES.length)} registry routes have a handler`,
);
if (extra.length > 0) {
  // An unregistered /v1 route is a DEFECT, not a gap: it exists but the registry does not know its
  // scopes, so it cannot be authorized against the contract.
  console.log(`route coverage: ${String(extra.length)} /v1 route(s) exist but are NOT in the registry:`);
  for (const key of extra) console.log(`  - ${key}`);
}
if (missing.length > 0) {
  console.log(`route coverage: ${String(missing.length)} registry route(s) not yet implemented:`);
  // Grouped by §5 group so the output shows WHICH area is unfinished rather than a flat list of 70.
  const byGroup = new Map<string, string[]>();
  for (const key of missing) {
    const path = key.split(' ')[1] ?? '';
    const route = ROUTES.find((r) => r.method === key.split(' ')[0] && r.path === path);
    const group = route?.group ?? 'unknown';
    const list = byGroup.get(group) ?? [];
    list.push(key);
    byGroup.set(group, list);
  }
  for (const [group, keys] of [...byGroup].sort((a, b) => Number(a[0].split('.')[1]) - Number(b[0].split('.')[1]))) {
    console.log(`  §${group}: ${String(keys.length)} route(s)`);
  }
}

await app.close();
process.exit(0);
