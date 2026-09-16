/**
 * The §5.14 boundary contract, without a database (SPEC-003 §5.14, §4.1, §2.7).
 *
 * WHAT THIS SUITE CAN AND CANNOT PROVE. It runs no PostgreSQL, so it proves nothing about persistence —
 * `tests/db/appeal-escalations.test.ts` does that against the real server. What it proves is the part that
 * is pure boundary logic, and for §5.14 that part is the interesting one, because SPEC-003 §5.14.1 places
 * appeal content in "counsel-review territory, not an API decision" and makes three refusals structural:
 *
 *   * `requiresHumanReview: false` is REFUSED (`422 HUMAN_REVIEW_REQUIRED`), not honoured. A control a
 *     caller can waive with a boolean is not a control, so this is asserted for every kind.
 *   * zero artifacts is `422 ARTIFACT_REQUIRED`, and a missing template hash is
 *     `422 TEMPLATE_HASH_REQUIRED` — the two things counsel review cannot work without.
 *   * the `kind` vocabulary is CLOSED, so an unrecognised kind is refused rather than stored and returned
 *     by §5.14.2.
 *
 * Every one of those assertions carries a `calls.length === 0` check beside it: a refusal that reached the
 * port would have opened a transaction and, on the write path, could have created a row.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import {
  testAppealQueries,
  testControllerResponseQueries,
  testDeadlineQueries,
  testAuditQueries,
  testExposureQueries,
  testObservationQueries,
  testCaseQueries,
  testTransitionQueries,
  testIdentity,
  testTenancy,
  TEST_SESSION_SECRET,
  TEST_TOKEN,
} from './server-support.ts';
import { ROUTES, findRoute } from '../../src/http/openapi/registry.ts';
import { isErrorCode } from '../../src/http/errors/code-registry.ts';
import { APPEAL_ROUTE_TEMPLATES } from '../../src/http/routes/appeals.ts';
import { APPEAL_KINDS } from '../../src/application/contracts/appeal-queries.ts';
import type { AppealQueries } from '../../src/application/contracts/appeal-queries.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '77777777-1111-4111-8111-777777777777';
const ESCALATION_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
const ARTIFACT_ID = '44444444-1111-4111-8111-444444444444';

/** A port that COUNTS calls, so "the refusal happened before any work" is structural rather than a claim. */
function recordingAppealQueries(): { readonly port: AppealQueries; readonly calls: string[] } {
  const calls: string[] = [];
  const note = (name: string): void => {
    calls.push(name);
  };
  const port: AppealQueries = {
    casePrecondition: async () => {
      note('casePrecondition');
      return undefined;
    },
    appealWindowClosed: async () => {
      note('appealWindowClosed');
      return false;
    },
    listAppealEscalations: async () => {
      note('listAppealEscalations');
      return [];
    },
    getAppealEscalation: async () => {
      note('getAppealEscalation');
      return undefined;
    },
    createAppealEscalation: async () => {
      note('createAppealEscalation');
      return { ok: false, reason: 'CASE_NOT_FOUND' };
    },
  };
  return { port, calls };
}

function serverWith(
  options: { scopes?: readonly string[]; authTimeAgeSeconds?: number } = {},
): { app: VgFastify; calls: string[] } {
  const recorded = recordingAppealQueries();
  const app = buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({
      tenantId: TENANT_A,
      scopes: options.scopes ?? ['vg.cases.read', 'vg.appeal.write'],
      authTimeAgeSeconds: options.authTimeAgeSeconds ?? 0,
    }),
    tenancy: testTenancy().runner,
    // The requirement comes from the REGISTRY, exactly as the composition root wires it. A fixed
    // `() => undefined` would make every "requires a key" assertion below vacuous.
    idempotency: {
      store: {
        begin: async () => ({ state: 'NEW' as const }),
        complete: async () => {},
        abandon: async () => {},
      },
      requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
    },
    sessionSecret: TEST_SESSION_SECRET,
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
    recipeVerificationKeys: { publicKeysByRef: new Map<string, string>() },
    appealQueries: options.scopes === undefined ? recorded.port : recorded.port,
    deadlineQueries: testDeadlineQueries(),
    auditQueries: testAuditQueries(),
    observationQueries: testObservationQueries(),
    exposureQueries: testExposureQueries(),
    transitionQueries: testTransitionQueries(),
    caseQueries: testCaseQueries(),
    controllerResponseQueries: testControllerResponseQueries(),
    health: {
      startedAt: new Date(),
      now: () => new Date(),
      probes: [async () => ({ name: 'stub', ok: true })],
    },
  });
  return { app, calls: recorded.calls };
}

const KEY = 'appeal-test-idem-key-0001';

async function post(
  app: VgFastify,
  url: string,
  options: { body?: unknown; key?: string | null; ifMatch?: string | null } = {},
): Promise<{ status: number; code: unknown }> {
  const headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' };
  if (options.key !== null) headers['idempotency-key'] = options.key ?? KEY;
  if (options.ifMatch !== null) headers['if-match'] = options.ifMatch ?? '"REQUEST_READY:1"';

  const response = await app.inject({
    method: 'POST',
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
  return {
    status: response.statusCode,
    code: typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined,
  };
}

/** A body that passes every boundary check, so a test can vary exactly one field. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'REGULATOR_COMPLAINT',
    requiresHumanReview: true,
    artifactIds: [ARTIFACT_ID],
    templateVersion: 'v3',
    templateHash: 'a'.repeat(64),
    recipientControllerId: null,
    ...overrides,
  };
}

describe('the §5.14 group is completely implemented', () => {
  test('every registry route in group 5.14 has a handler in the route module', () => {
    const declared = ROUTES.filter((route) => route.group === '5.14');
    assert.equal(declared.length, 3, 'SPEC-003 §5.14 declares three routes');
    for (const route of declared) {
      const fastifyPattern = route.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
      assert.ok(
        APPEAL_ROUTE_TEMPLATES.includes(fastifyPattern),
        `${route.method} ${route.path} (id ${route.id}) has no handler in src/http/routes/appeals.ts`,
      );
    }
  });

  test('§5.14.1 carries the step-up SPEC-003 §3.3 requires for vg.appeal.write', () => {
    // §3.3: "`vg.appeal.write` | Create an `AppealEscalation` (**also requires step-up**)". The registry is
    // the control `beginHandler` enforces, so the assertion belongs on the registry entry.
    const route = ROUTES.find((r) => r.id === '5.14.1');
    assert.equal(route?.stepUp, true);
    assert.deepEqual(route?.scopes, ['vg.appeal.write']);
  });
});

describe('§5.14.1 refusals happen at the boundary, before any port call', () => {
  test('requiresHumanReview: false is REFUSED for every kind, never honoured', async () => {
    for (const kind of APPEAL_KINDS) {
      const { app, calls } = serverWith();
      const res = await post(app, `/v1/cases/${CASE_ID}/appeal-escalations`, {
        body: validBody({ kind, requiresHumanReview: false }),
      });
      assert.equal(res.status, 422, `${kind}: ${JSON.stringify(res)}`);
      assert.equal(res.code, 'HUMAN_REVIEW_REQUIRED');
      assert.deepEqual(calls, [], `${kind}: a refusal must not reach the port`);
      await app.close();
    }
  });

  test('a body WITHOUT requiresHumanReview is refused too, not defaulted', async () => {
    // Absent must not mean "false accepted" or "true assumed": §5.14.1's request body always carries it,
    // and defaulting either way decides a control on the caller's behalf.
    const { app, calls } = serverWith();
    const body = validBody();
    delete body['requiresHumanReview'];
    const res = await post(app, `/v1/cases/${CASE_ID}/appeal-escalations`, { body });
    assert.equal(res.status, 422);
    assert.equal(res.code, 'HUMAN_REVIEW_REQUIRED');
    assert.deepEqual(calls, []);
    await app.close();
  });

  test('zero artifacts is 422 ARTIFACT_REQUIRED, and a non-list is refused', async () => {
    const { app, calls } = serverWith();
    const empty = await post(app, `/v1/cases/${CASE_ID}/appeal-escalations`, { body: validBody({ artifactIds: [] }) });
    assert.equal(empty.status, 422);
    assert.equal(empty.code, 'ARTIFACT_REQUIRED');

    const notAList = await post(app, `/v1/cases/${CASE_ID}/appeal-escalations`, {
      body: validBody({ artifactIds: 'not-a-list' }),
      key: 'appeal-test-idem-key-0002',
    });
    assert.equal(notAList.status, 422, 'a string is not a list of artifacts');
    assert.deepEqual(calls, []);
    await app.close();
  });

  test('a missing or empty templateHash is 422, so the reviewed wording is always pinned', async () => {
    const { app, calls } = serverWith();
    for (const [index, value] of [undefined, '', '   '].entries()) {
      const body = validBody();
      if (value === undefined) delete body['templateHash'];
      else body['templateHash'] = value;
      const res = await post(app, `/v1/cases/${CASE_ID}/appeal-escalations`, {
        body,
        key: `appeal-test-idem-key-10${String(index)}`,
      });
      assert.equal(res.status, 422, `templateHash=${JSON.stringify(value)} must be refused`);
      assert.equal(res.code, 'TEMPLATE_HASH_REQUIRED', `templateHash=${JSON.stringify(value)}`);
    }
    assert.deepEqual(calls, []);
    await app.close();
  });

  test('an unknown kind is refused rather than stored and returned by §5.14.2', async () => {
    const { app, calls } = serverWith();
    const res = await post(app, `/v1/cases/${CASE_ID}/appeal-escalations`, {
      body: validBody({ kind: 'STRONGLY_WORDED_LETTER' }),
    });
    assert.equal(res.status, 422);
    assert.equal(res.code, 'SCHEMA_VALIDATION_FAILED');
    assert.deepEqual(calls, []);
    await app.close();
  });

  test('a missing or unparseable If-Match is 428 and 412 respectively, with no port call', async () => {
    const { app, calls } = serverWith();
    const missing = await post(app, `/v1/cases/${CASE_ID}/appeal-escalations`, {
      body: validBody(),
      ifMatch: null,
    });
    assert.equal(missing.status, 428);
    assert.equal(missing.code, 'PRECONDITION_REQUIRED');

    // `*` is refused on purpose: §2.7 makes If-Match a per-resource token, and accepting "any current
    // representation" would let a caller skip the precondition on the route that records counsel review.
    const star = await post(app, `/v1/cases/${CASE_ID}/appeal-escalations`, {
      body: validBody(),
      ifMatch: '*',
      key: 'appeal-test-idem-key-0003',
    });
    assert.equal(star.status, 412);
    assert.equal(star.code, 'PRECONDITION_FAILED');
    assert.deepEqual(calls, []);
    await app.close();
  });
});

describe('§5.14 follows §4.1 for idempotency and §3.2 for step-up, from the registry', () => {
  test('§5.14.1 is 400 IDEMPOTENCY_KEY_REQUIRED with no key', async () => {
    const { app } = serverWith();
    const res = await post(app, `/v1/cases/${CASE_ID}/appeal-escalations`, { body: validBody(), key: null });
    assert.equal(res.status, 400);
    assert.equal(res.code, 'IDEMPOTENCY_KEY_REQUIRED');
    await app.close();
  });

  test('a stale authentication is 403 STEP_UP_REQUIRED, checked before the body', async () => {
    // The body is deliberately EMPTY: if step-up ran after body validation the refusal would be
    // SCHEMA_VALIDATION_FAILED, and this assertion is what distinguishes the two orders.
    const { app, calls } = serverWith({ authTimeAgeSeconds: 3600 });
    const res = await post(app, `/v1/cases/${CASE_ID}/appeal-escalations`, { body: {} });
    assert.equal(res.status, 403);
    assert.equal(res.code, 'STEP_UP_REQUIRED');
    assert.deepEqual(calls, []);
    await app.close();
  });

  test('a caller holding only the read scope is 403 INSUFFICIENT_SCOPE', async () => {
    const { app } = serverWith({ scopes: ['vg.cases.read'], authTimeAgeSeconds: 3600 });
    const res = await post(app, `/v1/cases/${CASE_ID}/appeal-escalations`, { body: validBody() });
    assert.equal(res.status, 403);
    assert.equal(res.code, 'INSUFFICIENT_SCOPE');
    await app.close();
  });

  test('the two GET routes require only vg.cases.read and no step-up', async () => {
    for (const [method, url] of [
      ['GET', `/v1/cases/${CASE_ID}/appeal-escalations`],
      ['GET', `/v1/appeal-escalations/${ESCALATION_ID}`],
    ] as const) {
      const app = buildServer({
        version: '0.0.0-test',
        commit: 'test',
        logLevel: 'silent',
        identity: testIdentity({ tenantId: TENANT_A, scopes: ['vg.cases.read'], authTimeAgeSeconds: 3600 }),
        tenancy: testTenancy().runner,
        idempotency: {
          store: { begin: async () => ({ state: 'NEW' as const }), complete: async () => {}, abandon: async () => {} },
          requirementFor: (m, t) => findRoute(m, t)?.idempotency,
        },
        sessionSecret: TEST_SESSION_SECRET,
        subjectQueries: testAppealQueriesSubjectStub(),
        sourceQueries: testAppealQueriesSourceStub(),
        recipeVerificationKeys: { publicKeysByRef: new Map<string, string>() },
        appealQueries: testAppealQueries(),
        deadlineQueries: testDeadlineQueries(),
    auditQueries: testAuditQueries(),
    observationQueries: testObservationQueries(),
    exposureQueries: testExposureQueries(),
    transitionQueries: testTransitionQueries(),
    caseQueries: testCaseQueries(),
    controllerResponseQueries: testControllerResponseQueries(),
        health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 's', ok: true })] },
      });
      const response = await app.inject({ method, url, headers: { authorization: `Bearer ${TEST_TOKEN}` } });
      // A stale authentication must NOT be refused here: these routes are reads, and §5.14.2/§5.14.3 mark
      // them Optional with no step-up. A 403 would mean a read inherited a write's control.
      assert.notEqual(response.statusCode, 403, `${method} ${url} must not require a step-up`);
      await app.close();
    }
  });
});

describe('every §5.14 refusal uses a code from the closed set', () => {
  test('the codes these routes emit are all registered (H-7)', () => {
    for (const code of [
      'HUMAN_REVIEW_REQUIRED',
      'ARTIFACT_REQUIRED',
      'TEMPLATE_HASH_REQUIRED',
      'APPEAL_WINDOW_CLOSED',
      'PRECONDITION_FAILED',
      'PRECONDITION_REQUIRED',
      'RESOURCE_NOT_FOUND',
      'SCHEMA_VALIDATION_FAILED',
    ]) {
      assert.equal(isErrorCode(code), true, `${code} must be in the registry`);
    }
  });
});

/** Minimal subject/source stubs for the two-GET case above, where only `appealQueries` is exercised. */
function testAppealQueriesSubjectStub() {
  return {
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
  };
}

function testAppealQueriesSourceStub() {
  return {
    listSources: async () => [],
    getSourceDetail: async () => undefined,
    sourceExists: async () => false,
    declareSource: async () => ({ ok: false as const, reason: 'CONTROLLER_NOT_FOUND' as const }),
    setPermissionClass: async () => ({ ok: false as const, reason: 'NOT_FOUND' as const }),
    listCatalogEntries: async () => [],
    appendCatalogEntry: async () => ({ ok: false as const, reason: 'NOT_FOUND' as const }),
    createRecipe: async () => ({ ok: false as const, reason: 'NOT_FOUND' as const }),
    listRecipes: async () => [],
    getRecipe: async () => undefined,
    setRecipeEnablement: async () => ({ ok: false as const, reason: 'NOT_FOUND' as const }),
  };
}
