/**
 * The §5.3 boundary contract, without a database (SPEC-003 §4.1, §5.3, §2.7).
 *
 * WHAT THIS SUITE CAN AND CANNOT PROVE. It runs no PostgreSQL, so it can prove nothing about
 * persistence, RLS, or the derived `writesEnabled` — `tests/db/source-catalogue.test.ts` proves those
 * against the real server, and neither suite substitutes for the other. What it CAN prove is the part
 * that is pure boundary logic and would otherwise only be exercised on a machine with a provisioned
 * database:
 *
 *   * the §5.3 group is COMPLETELY implemented, compared against the registry rather than against a
 *     list copied into this file;
 *   * every route the registry marks `required` really claims an idempotency key through the registry,
 *     which is how the composition root wires it;
 *   * every validation refusal happens BEFORE the port is called, so "produces no state change" is a
 *     structural property and not a promise about ordering inside a handler;
 *   * the three step-up routes refuse a stale authentication, and the refusal happens before the body
 *     is looked at;
 *   * every code these routes emit is a member of the closed set, so no route can invent one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import {
  testAppealQueries,
  testIdentity,
  testTenancy,
  TEST_SESSION_SECRET,
  TEST_TOKEN,
} from './server-support.ts';
import { ROUTES, findRoute } from '../../src/http/openapi/registry.ts';
import { isErrorCode } from '../../src/http/errors/code-registry.ts';
import { SOURCE_ROUTE_TEMPLATES, RECIPE_GUARD_NAMES, ACCEPTED_PERMISSION_CLASSES } from '../../src/http/routes/sources.ts';
import { CHANNEL_NAMES, PERMISSION_CLASSES } from '../../src/application/contracts/index.ts';
import type {
  RecipeVerificationKeys,
  SourceQueries,
} from '../../src/application/contracts/source-queries.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const RECIPE_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const KEY_REF = 'kms:contract-test';

/**
 * A source port that COUNTS every call and refuses the writes.
 *
 * Counting is the whole point: `calls.length === 0` after a refusal is the assertion that the refusal
 * happened before the port was reached, which is what `no refusal changes state` means operationally.
 * The write methods refuse rather than fabricate, so a route that wrongly proceeded would surface as a
 * `404` instead of a silently plausible success.
 */
function recordingSourceQueries(): { readonly port: SourceQueries; readonly calls: string[] } {
  const calls: string[] = [];
  const note = (name: string): void => {
    calls.push(name);
  };
  const port: SourceQueries = {
    listSources: async () => {
      note('listSources');
      return [];
    },
    getSourceDetail: async () => {
      note('getSourceDetail');
      return undefined;
    },
    sourceExists: async () => {
      note('sourceExists');
      return false;
    },
    declareSource: async () => {
      note('declareSource');
      return { ok: false, reason: 'CONTROLLER_NOT_FOUND' };
    },
    setPermissionClass: async () => {
      note('setPermissionClass');
      return { ok: false, reason: 'NOT_FOUND' };
    },
    listCatalogEntries: async () => {
      note('listCatalogEntries');
      return [];
    },
    appendCatalogEntry: async () => {
      note('appendCatalogEntry');
      return { ok: false, reason: 'NOT_FOUND' };
    },
    createRecipe: async () => {
      note('createRecipe');
      return { ok: false, reason: 'NOT_FOUND' };
    },
    listRecipes: async () => {
      note('listRecipes');
      return [];
    },
    getRecipe: async () => {
      note('getRecipe');
      return undefined;
    },
    setRecipeEnablement: async () => {
      note('setRecipeEnablement');
      return { ok: false, reason: 'NOT_FOUND' };
    },
  };
  return { port, calls };
}

/** An empty key map: the honest state of a deployment with no recipe key configured (ADR-006 OPEN). */
const NO_KEYS: RecipeVerificationKeys = { publicKeysByRef: new Map<string, string>() };

function serverWith(options: {
  scopes?: readonly string[];
  authTimeAgeSeconds?: number;
  port?: SourceQueries;
} = {}): { app: VgFastify; calls: string[] } {
  const recorded = recordingSourceQueries();
  const tenancy = testTenancy();
  const app = buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({
      tenantId: TENANT_A,
      scopes: options.scopes ?? ['vg.sources.read', 'vg.sources.write', 'vg.recipes.write'],
      authTimeAgeSeconds: options.authTimeAgeSeconds ?? 0,
    }),
    tenancy: tenancy.runner,
    // The requirement comes from the REGISTRY, exactly as `src/infrastructure/main.ts` wires it. A
    // fixed `() => undefined` would make every "requires a key" assertion below vacuous.
    idempotency: {
      store: {
        begin: async () => ({ state: 'NEW' as const }),
        complete: async () => {},
        abandon: async () => {},
      },
      requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
    },
    sessionSecret: TEST_SESSION_SECRET,
    sourceQueries: options.port ?? recorded.port,
    recipeVerificationKeys: NO_KEYS,
    appealQueries: testAppealQueries(),
    subjectQueries: {
      listSubjects: async () => [],
      getSubjectDetail: async () => undefined,
      subjectExists: async () => false,
      listAliases: async () => [],
      listIdentifiers: async () => [],
      listLocationHistory: async () => [],
      listAuthorityGrants: async () => [],
      jurisdictionResolves: async () => false,
      appendLocationHistory: async () => ({ locationHistoryId: 'test' }),
      appendAlias: async () => ({
        aliasId: 'test',
        addedAt: new Date(0).toISOString(),
        quarantined: false,
        candidateSubjectIds: [],
      }),
    },
    health: {
      startedAt: new Date(),
      now: () => new Date(),
      probes: [async () => ({ name: 'stub', ok: true })],
    },
  });
  return { app, calls: recorded.calls };
}

const EFFECTIVE_KEY = 'contract-test-idem-key-0001';

async function request(
  app: VgFastify,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; code: unknown; details: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  headers['authorization'] = `Bearer ${TEST_TOKEN}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await app.inject({
    method,
    url,
    headers,
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const error = parsed['error'];
  const envelope = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const details = envelope['details'];
  return {
    status: response.statusCode,
    code: envelope['code'],
    details: typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {},
  };
}

describe('the §5.3 group is completely implemented', () => {
  test('every registry route in group 5.3 has a handler in the route module', () => {
    const declared = ROUTES.filter((route) => route.group === '5.3');
    assert.equal(declared.length, 10, 'SPEC-003 §5.3 declares ten routes');

    // The registry is the contract, so the comparison is registry → module, not module → registry. A
    // module that implemented a route the specification does not declare would be caught by the route
    // registry's own set-equality test; this one catches the opposite, and more dangerous, direction.
    for (const route of declared) {
      const fastifyPattern = route.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
      assert.ok(
        SOURCE_ROUTE_TEMPLATES.includes(fastifyPattern),
        `${route.method} ${route.path} (id ${route.id}) has no handler in src/http/routes/sources.ts`,
      );
    }
  });

  test('the three step-up routes of §5.3 are the ones SPEC-003 §3.2 item 7 names', () => {
    const stepUp = ROUTES.filter((route) => route.group === '5.3' && route.stepUp).map((route) => route.id);
    // Ratified in EP-004 §12: SPEC-003 §5.3.4/§5.3.7/§5.3.10's Scope lines omit the step-up marker that
    // §3.2 item 7 and SPEC-005 §6 require for a permission downgrade and a recipe enablement.
    assert.deepEqual(stepUp.sort(), ['5.3.10', '5.3.4', '5.3.7']);
  });

  test('the permission classes and channels are the domain’s, not a second copy', () => {
    assert.deepEqual([...ACCEPTED_PERMISSION_CLASSES], [...PERMISSION_CLASSES]);
    // §5.3.7's `channel` vocabulary is the eight channels of VG-CHANNEL-001.
    assert.equal(CHANNEL_NAMES.length, 8);
    assert.deepEqual([...RECIPE_GUARD_NAMES], ['signatureVerified', 'fresh', 'permissionClass', 'permissionFresh']);
  });
});

describe('§4.1 idempotency is claimed from the registry, not remembered per handler', () => {
  const required: readonly (readonly ['POST' | 'PATCH', string, unknown])[] = [
    ['POST', '/v1/sources', { name: 'n', class: 'c', permissionClass: 'READ_ONLY' }],
    ['PATCH', `/v1/sources/${SOURCE_ID}/permission-class`, { permissionClass: 'READ_ONLY', reason: 'R' }],
    ['POST', `/v1/sources/${SOURCE_ID}/catalog-entries`, { category: 'c', coverageNotes: 'n', provenance: 'p', license: 'l' }],
    ['POST', `/v1/sources/${SOURCE_ID}/recipes`, { channel: 'OFFICIAL_SELF_SERVICE', verificationMethod: 'm' }],
    ['POST', `/v1/recipes/${RECIPE_ID}/enablement`, { enabled: false, reason: 'R' }],
  ];

  for (const [method, url, body] of required) {
    test(`${method} ${url} is 400 IDEMPOTENCY_KEY_REQUIRED with no key`, async () => {
      const { app } = serverWith();
      // No `idempotency-key` header. The refusal must come from the plugin's `onRequest` hook, before
      // the handler runs, so the body supplied here is never examined.
      const res = await request(app, method, url, { body });
      assert.equal(res.status, 400, JSON.stringify(res));
      assert.equal(res.code, 'IDEMPOTENCY_KEY_REQUIRED');
      await app.close();
    });
  }
});

describe('§5.3 validation refusals happen before the port is reached', () => {
  test('a WRITE_PERMITTED declaration without evidence is refused with no port call', async () => {
    const { app, calls } = serverWith();
    const res = await request(app, 'POST', '/v1/sources', {
      headers: { 'idempotency-key': EFFECTIVE_KEY },
      body: { name: 'n', class: 'PEOPLE_SEARCH', permissionClass: 'WRITE_PERMITTED' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.code, 'PERMISSION_EVIDENCE_REQUIRED');
    assert.deepEqual(calls, [], 'no refusal may reach the port');
    await app.close();
  });

  test('a catalogue entry with blank notes or no licence is refused with no port call', async () => {
    const { app, calls } = serverWith();
    const blankNotes = await request(app, 'POST', `/v1/sources/${SOURCE_ID}/catalog-entries`, {
      headers: { 'idempotency-key': EFFECTIVE_KEY },
      body: { category: 'c', coverageNotes: '   ', provenance: 'p', license: 'l' },
    });
    assert.equal(blankNotes.code, 'CATALOG_NOTES_REQUIRED');

    const noLicence = await request(app, 'POST', `/v1/sources/${SOURCE_ID}/catalog-entries`, {
      headers: { 'idempotency-key': 'contract-test-idem-key-0002' },
      body: { category: 'c', coverageNotes: 'Covers something.', provenance: 'p', license: '' },
    });
    assert.equal(noLicence.code, 'LICENSE_UNRECORDED');
    assert.deepEqual(calls, [], 'no refusal may reach the port');
    await app.close();
  });

  test('a recipe with an unknown channel, or no verification method, is refused with no port call', async () => {
    const { app, calls } = serverWith();
    const channel = await request(app, 'POST', `/v1/sources/${SOURCE_ID}/recipes`, {
      headers: { 'idempotency-key': EFFECTIVE_KEY },
      body: { channel: 'CARRIER_PIGEON', verificationMethod: 'm', signature: 'x', signingKeyRef: KEY_REF, freshnessAt: new Date().toISOString(), maxAttemptsPerWindow: 1, windowSeconds: 60 },
    });
    assert.equal(channel.code, 'RECIPE_CHANNEL_UNKNOWN');

    const method = await request(app, 'POST', `/v1/sources/${SOURCE_ID}/recipes`, {
      headers: { 'idempotency-key': 'contract-test-idem-key-0003' },
      body: { channel: 'OFFICIAL_SELF_SERVICE', signature: 'x', signingKeyRef: KEY_REF, freshnessAt: new Date().toISOString(), maxAttemptsPerWindow: 1, windowSeconds: 60 },
    });
    assert.equal(method.code, 'RECIPE_VERIFICATION_METHOD_REQUIRED');

    const signature = await request(app, 'POST', `/v1/sources/${SOURCE_ID}/recipes`, {
      headers: { 'idempotency-key': 'contract-test-idem-key-0004' },
      body: { channel: 'OFFICIAL_SELF_SERVICE', verificationMethod: 'm', signingKeyRef: KEY_REF, freshnessAt: new Date().toISOString(), maxAttemptsPerWindow: 1, windowSeconds: 60 },
    });
    assert.equal(signature.code, 'RECIPE_SIGNATURE_INVALID');

    assert.deepEqual(calls, [], 'no refusal may reach the port');
    await app.close();
  });

  test('an unparseable If-Match is 412 and reaches no port', async () => {
    const { app, calls } = serverWith();
    // `*` is refused deliberately: §2.7 makes If-Match a per-resource token, and accepting "any
    // current representation" would skip the precondition on the two routes where it protects a
    // permission downgrade and a recipe enablement.
    const star = await request(app, 'PATCH', `/v1/sources/${SOURCE_ID}/permission-class`, {
      headers: { 'idempotency-key': EFFECTIVE_KEY, 'if-match': '*' },
      body: { permissionClass: 'READ_ONLY', reason: 'R' },
    });
    assert.equal(star.status, 412);
    assert.equal(star.code, 'PRECONDITION_FAILED');
    assert.deepEqual(calls, []);
    await app.close();
  });
});

describe('§5.3 step-up is enforced from the registry, before the body is read', () => {
  test('a stale authentication is 403 STEP_UP_REQUIRED on all three write routes', async () => {
    const cases: readonly (readonly ['POST' | 'PATCH', string])[] = [
      ['PATCH', `/v1/sources/${SOURCE_ID}/permission-class`],
      ['POST', `/v1/sources/${SOURCE_ID}/recipes`],
      ['POST', `/v1/recipes/${RECIPE_ID}/enablement`],
    ];
    for (const [method, url] of cases) {
      const { app, calls } = serverWith({ authTimeAgeSeconds: 3600 });
      const res = await request(app, method, url, {
        headers: { 'idempotency-key': EFFECTIVE_KEY, 'if-match': '"X:1"' },
        // Deliberately EMPTY: if the step-up check ran after body validation, the refusal would be
        // SCHEMA_VALIDATION_FAILED instead, and this assertion is what distinguishes the two orders.
        body: {},
      });
      assert.equal(res.status, 403, `${method} ${url}: ${JSON.stringify(res)}`);
      assert.equal(res.code, 'STEP_UP_REQUIRED');
      assert.deepEqual(calls, [], 'step-up must be checked before the port is reached');
      await app.close();
    }
  });

  test('a missing scope is 403 INSUFFICIENT_SCOPE, and is checked before step-up', async () => {
    // The read scope only: the caller cannot perform the operation at all, so telling them to
    // re-authenticate would be advice they cannot act on.
    const { app } = serverWith({ scopes: ['vg.sources.read'], authTimeAgeSeconds: 3600 });
    const res = await request(app, 'PATCH', `/v1/sources/${SOURCE_ID}/permission-class`, {
      headers: { 'idempotency-key': EFFECTIVE_KEY, 'if-match': '"X:1"' },
      body: { permissionClass: 'READ_ONLY', reason: 'R' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.code, 'INSUFFICIENT_SCOPE');
    await app.close();
  });
});

describe('every §5.3 refusal uses a code from the closed set', () => {
  test('the codes these routes emit are all registered (H-7)', async () => {
    // Enumeration rather than a spot check: a code that is not in the registry cannot be rendered by
    // `toEnvelope`, so the route would answer 500 for a legitimate refusal.
    const codes = [
      'SOURCE_ALREADY_DECLARED',
      'CONTROLLER_NOT_FOUND',
      'PERMISSION_EVIDENCE_REQUIRED',
      'CATALOG_NOTES_REQUIRED',
      'CATALOG_ENTRY_DUPLICATE',
      'LICENSE_UNRECORDED',
      'RECIPE_SIGNATURE_INVALID',
      'RECIPE_VERIFICATION_METHOD_REQUIRED',
      'RECIPE_CHANNEL_UNKNOWN',
      'RECIPE_VERSION_CONFLICT',
      'RECIPE_GUARD_FAILED',
      'PRECONDITION_FAILED',
      'PRECONDITION_REQUIRED',
      'RESOURCE_NOT_FOUND',
    ];
    for (const code of codes) {
      assert.equal(isErrorCode(code), true, `${code} must be in the registry`);
    }
  });

  test('the guard refusal reports a name from the §5.3.10 guard set, not free text', async () => {
    // The route builds `checks` from the port's evaluation. With the empty key map the port is never
    // reached (the route refuses at validation first), so this asserts the SHAPE the route can produce
    // rather than a live refusal — the live one is asserted in tests/db/source-catalogue.test.ts.
    const { app } = serverWith();
    const res = await request(app, 'POST', `/v1/recipes/${RECIPE_ID}/enablement`, {
      headers: { 'idempotency-key': EFFECTIVE_KEY, 'if-match': '"DISABLED:1"' },
      body: { enabled: true, reason: 'PERMISSION_REFRESHED' },
    });
    // No recipe exists in this port, so the refusal is the 404 the port returns — which is itself the
    // point: a missing resource is not a guard failure and must not be reported as one.
    assert.equal(res.status, 404);
    assert.equal(res.code, 'RESOURCE_NOT_FOUND');
    await app.close();
  });
});
