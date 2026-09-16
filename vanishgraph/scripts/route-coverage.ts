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

import { readFileSync, readdirSync } from 'node:fs';
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
  subjectCommands: {
    createSubject: async () => ({ ok: false, reason: 'EVIDENCE_NOT_FOUND' }),
    updateSubject: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    mintAuthorityGrant: async () => ({ ok: false, reason: 'SUBJECT_NOT_FOUND' }),
    revokeAuthorityGrant: async () => ({ ok: false, reason: 'NOT_FOUND' }),
  },
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
  // The §5.3 port. Empty/not-found answers, because this probe only enumerates routes and must not
  // appear to have read anything. The write methods refuse rather than fabricate a created row.
  sourceQueries: {
    listSources: async () => [],
    getSourceDetail: async () => undefined,
    sourceExists: async () => false,
    declareSource: async () => ({ ok: false, reason: 'CONTROLLER_NOT_FOUND' }),
    setPermissionClass: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    listCatalogEntries: async () => [],
    appendCatalogEntry: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    createRecipe: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    listRecipes: async () => [],
    getRecipe: async () => undefined,
    setRecipeEnablement: async () => ({ ok: false, reason: 'NOT_FOUND' }),
  },
  // No recipe verification key. This probe never submits a recipe, and an empty map is the honest
  // state of a deployment with no key (ADR-006 OPEN).
  recipeVerificationKeys: { publicKeysByRef: new Map<string, string>() },
  // The §5.14 port. Not-found answers, because this probe only enumerates routes and must not appear to
  // have read or written anything.
  appealQueries: {
    casePrecondition: async () => undefined,
    appealWindowClosed: async () => false,
    listAppealEscalations: async () => [],
    getAppealEscalation: async () => undefined,
    createAppealEscalation: async () => ({ ok: false, reason: 'CASE_NOT_FOUND' }),
  },
  // The §5.13 port. Not-found answers: this probe only enumerates routes.
  deadlineQueries: {
    caseDeadlineContext: async () => undefined,
    evidenceExists: async () => false,
    listDeadlines: async () => [],
    createDeadline: async () => ({ ok: false, reason: 'CASE_NOT_FOUND' }),
    satisfyDeadline: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    deriveState: (s, d, n) => (s !== null ? 'SATISFIED' : d < n ? 'BREACHED' : 'OPEN'),
  },
  // The §5.15 read model. Empty: this probe only enumerates routes.
  auditQueries: {
    listAuditEvents: async () => [],
    getAuditEvent: async () => undefined,
  },
  // The §5.5 exposure model and the transition spine. Not-found answers: this probe only enumerates routes.
  exposureQueries: {
    listExposures: async () => [],
    getExposureDetail: async () => undefined,
    exposureRowVersion: async () => undefined,
    recordMatchAssessment: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    recordDisproof: async () => ({ ok: false, reason: 'NOT_FOUND' }),
  },
  transitionQueries: {
    listTransitionsForExposure: async () => [],
    listTransitionsForCase: async () => [],
    lastTransitionForCase: async () => undefined,
  },
  // The §5.7 case aggregate. Not-found answers: this probe only enumerates routes.
  controllerResponseQueries: {
    recordControllerResponse: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    listControllerResponses: async () => [],
    createEmailThread: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    caseRowVersion: async () => undefined,
  },
  caseQueries: {
    listCases: async () => [],
    getCaseDetail: async () => undefined,
    caseRowVersion: async () => undefined,
    listTimeline: async () => [],
    createCase: async () => ({ ok: false, reason: 'EXPOSURE_NOT_FOUND' }),
    guardedUpdate: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    recordHumanGate: async () => ({ ok: false, reason: 'NOT_FOUND' }),
  },
  // The §5.8 action model. Not-found answers: this probe only enumerates routes.
  actionQueries: {
    caseExists: async () => false,
    listActions: async () => [],
    getActionDetail: async () => undefined,
    actionRowVersion: async () => undefined,
    listMailPieces: async () => [],
    executeAction: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    recordReconciliation: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    requestReadback: async () => ({ ok: false, reason: 'NOT_FOUND' }),
  },
  // The §5.6 policy model. Not-found answers: this probe only enumerates routes.
  policyQueries: {
    resolvePolicyDecision: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    listPolicyDecisions: async () => [],
    getPolicyDecision: async () => undefined,
    listJurisdictionPolicies: async () => [],
    caseRowVersion: async () => undefined,
  },
  // The §5.16 coverage and metric model. Zero denominator, so the stub reports `ratio: null` rather than a rate.
  evidenceQueries: {
    getEvidenceArtifact: async () => undefined,
    listCaseEvidenceArtifacts: async () => undefined,
  },
  coverageQueries: {
    listCoverageReports: async () => [],
    getCoverageReport: async () => undefined,
    removalEffectiveness: async () => ({
      interval: { from: new Date(0).toISOString(), to: new Date(0).toISOString() },
      overall: {
        eligibleConfirmedMatchDenominator: 0,
        verifiedRemovedNumerator: 0,
        ratio: null,
        confidenceInterval: null,
        denominatorDefinedAs: 'stub',
      },
      excludedFromNumerator: {
        acknowledged: 0,
        requestSubmitted: 0,
        searchDelisted: 0,
        notRemovable: 0,
        humanRequired: 0,
        ambiguous: 0,
      },
      groups: [],
      caveats: ['ACKNOWLEDGED_IS_NOT_REMOVAL'],
    }),
  },
  // The §5.10/§5.11 read model. Empty: this probe only enumerates routes.
  observationQueries: {
    caseExists: async () => false,
    listVerificationObservations: async () => [],
    getVerificationObservation: async () => undefined,
    exposureExists: async () => false,
    caseRowVersion: async () => undefined,
    exposureRowVersion: async () => undefined,
    listReappearances: async () => [],
    listReappearancesForExposure: async () => [],
    recordVerificationObservation: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    recordReappearance: async () => ({ ok: false, reason: 'NOT_FOUND' }),
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

/**
 * REGISTERED IS NOT THE SAME AS WORKING, and this file reported them as if it were.
 *
 * `printRoutes` proves a handler EXISTS; it says nothing about whether the handler can do what its route
 * documents. Five routes were registered while refusing every request with an unconditional
 * `503 DEPENDENCY_UNAVAILABLE` — §5.1.1 subject creation, §5.1.4 subject update, §5.1.7 identifier capture,
 * §5.2.1 authority minting and §5.2.3 revocation. Counting them as covered made the number this file prints
 * overstate the work by five, and a number that reads as a measurement is worse than no number
 * (`ASSUMPTIONS.md` §3.26 item 4 records the same lesson from a different direction).
 *
 * THE RULE, and its limits, stated so the number can be judged rather than trusted: a handler is counted as
 * a STUB when its body refuses with `DEPENDENCY_UNAVAILABLE` **and** contains no success path. A success path is
 * either an explicit `reply.code(2…)` or a returned `{ status: 2xx }` literal — the second was added after §5.8.2
 * was reported as a stub: its handler refuses a real submission with `DEPENDENCY_UNAVAILABLE` (no channel
 * transport exists) while its `dryRun` path is a complete success, and the route returns its status through the
 * idempotency wrapper rather than through `reply.code`. The heuristic cannot see a handler that succeeds only on
 * inputs it does not mention, so it is deliberately conservative — it never claims MORE coverage than the
 * registered count, only less — and a FALSE stub is as dishonest as a false success, which is why §5.8.2's dry
 * run is now recognised rather than silently mislabelled.
 */
function stubbedRoutes(): readonly { readonly route: string; readonly reason: string }[] {
  const out: { route: string; reason: string }[] = [];
  const dir = new URL('../src/http/routes/', import.meta.url);
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(new URL(file, dir), 'utf8');
    // Split on handler registrations; the text before the first one is module-level, not a handler.
    const parts = source.split(/app\.(get|post|patch|put|delete)\(\s*'/);
    for (let i = 1; i < parts.length; i += 2) {
      const method = (parts[i] ?? '').toUpperCase();
      const rest = parts[i + 1] ?? '';
      const template = /^([^']*)'/.exec(rest)?.[1];
      if (template === undefined) continue;
      const declaration = rest.indexOf('{');
      const body = declaration === -1 ? rest : rest.slice(declaration);
      if (!body.includes('DEPENDENCY_UNAVAILABLE')) continue;
      if (/reply\.code\(\s*2/.test(body)) continue;
      if (/status:\s*2\d\d\b/.test(body)) continue;
      const reason = /DEPENDENCY_UNAVAILABLE',\s*\{\s*reason:\s*'([^']*)'/.exec(body)?.[1] ?? 'unspecified';
      out.push({
        route: `${method} ${template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')}`,
        reason,
      });
    }
  }
  return out;
}

const stubs = stubbedRoutes();
const working = ROUTES.length - missing.length - stubs.length;

console.log(
  `route coverage: ${String(ROUTES.length - missing.length)} of ${String(ROUTES.length)} registry routes have a handler`,
);
console.log(
  `route coverage: ${String(working)} of ${String(ROUTES.length)} registry routes have a handler that is not an unconditional refusal`,
);
if (stubs.length > 0) {
  // Printed rather than subtracted silently: a route that always refuses is UNIMPLEMENTED work, and naming
  // it is what keeps the second number above honest.
  console.log(`route coverage: ${String(stubs.length)} registered route(s) refuse unconditionally:`);
  for (const stub of stubs) console.log(`  - ${stub.route} — ${stub.reason}`);
}
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
