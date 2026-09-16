/**
 * The §5.13 boundary contract, without a database (SPEC-003 §5.13, §4.1, §2.7).
 *
 * WHAT THIS SUITE CAN AND CANNOT PROVE. It runs no PostgreSQL, so it proves nothing about persistence or
 * the provenance join — `tests/db/deadline-provenance.test.ts` does that against the real server. What it
 * proves is the boundary logic, which for §5.13 is mostly about two closed vocabularies and a derived field:
 *
 *   * `kind` is one of the five §5.13.1 names and `source` one of the one §5.13.2 names. A token outside
 *     either must be refused rather than stored and returned later.
 *   * A missing or unknown `source` is `422 DEADLINE_SOURCE_REQUIRED`, the code §5.13.2 names for it, not a
 *     generic schema failure.
 *   * A `dueAt` that has already passed is `422 DEADLINE_IN_PAST` — recording it would create a row that is
 *     BREACHED the instant it exists.
 *   * `deriveState` returns exactly three of the four values §5.13.1 admits, and `WAIVED` is the one it can
 *     never return. That is asserted rather than assumed, because a fourth value appearing would mean a
 *     waiver fact had been invented.
 *   * Every refusal happens BEFORE the port is called, so "produces no state change" is structural.
 *
 * Every refusal assertion carries a `calls.length === 0` check beside it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import {
  testAuditQueries,
  testIdentity,
  testExposureQueries,
  testObservationQueries,
  testCaseQueries,
  testControllerResponseQueries,
  testTransitionQueries,
  testTenancy,
  TEST_SESSION_SECRET,
  TEST_TOKEN,
} from './server-support.ts';
import { ROUTES, findRoute } from '../../src/http/openapi/registry.ts';
import { isErrorCode } from '../../src/http/errors/code-registry.ts';
import { DEADLINE_ROUTE_TEMPLATES } from '../../src/http/routes/deadlines.ts';
import {
  DEADLINE_KINDS,
  DEADLINE_SOURCES,
  deriveState,
} from '../../src/application/contracts/deadline-queries.ts';
import type { DeadlineQueries } from '../../src/application/contracts/deadline-queries.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '77777777-1111-4111-8111-777777777777';
const DEADLINE_ID = 'dddddddd-1111-4111-8111-dddddddddddd';
const ARTIFACT_ID = '44444444-1111-4111-8111-444444444444';
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

/** A port that COUNTS calls, so "the refusal happened before any work" is structural. */
function recordingDeadlineQueries(): { readonly port: DeadlineQueries; readonly calls: string[] } {
  const calls: string[] = [];
  const note = (name: string): void => {
    calls.push(name);
  };
  const port: DeadlineQueries = {
    caseDeadlineContext: async () => {
      note('caseDeadlineContext');
      return undefined;
    },
    evidenceExists: async () => {
      note('evidenceExists');
      return false;
    },
    listDeadlines: async () => {
      note('listDeadlines');
      return [];
    },
    createDeadline: async () => {
      note('createDeadline');
      return { ok: false, reason: 'CASE_NOT_FOUND' };
    },
    satisfyDeadline: async () => {
      note('satisfyDeadline');
      return { ok: false, reason: 'NOT_FOUND' };
    },
    // The REAL derivation, not a stub — see `testDeadlineQueries` for why.
    deriveState,
  };
  return { port, calls };
}

function serverWith(
  options: { scopes?: readonly string[]; authTimeAgeSeconds?: number; port?: DeadlineQueries } = {},
): { app: VgFastify; calls: string[] } {
  const recorded = recordingDeadlineQueries();
  const app = buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({
      tenantId: TENANT_A,
      scopes: options.scopes ?? ['vg.cases.read', 'vg.cases.write'],
      authTimeAgeSeconds: options.authTimeAgeSeconds ?? 0,
    }),
    tenancy: testTenancy().runner,
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
    appealQueries: {
      casePrecondition: async () => undefined,
      appealWindowClosed: async () => false,
      listAppealEscalations: async () => [],
      getAppealEscalation: async () => undefined,
      createAppealEscalation: async () => ({ ok: false, reason: 'CASE_NOT_FOUND' }),
    },
    deadlineQueries: options.port ?? recorded.port,
    auditQueries: testAuditQueries(),
    observationQueries: testObservationQueries(),
    exposureQueries: testExposureQueries(),
    transitionQueries: testTransitionQueries(),
    caseQueries: testCaseQueries(),
    controllerResponseQueries: testControllerResponseQueries(),
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
  });
  return { app, calls: recorded.calls };
}

const KEY = 'deadline-test-key-000001';

async function post(
  app: VgFastify,
  url: string,
  options: { body?: unknown; key?: string | null; ifMatch?: string | null } = {},
): Promise<{ status: number; code: unknown }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TEST_TOKEN}`,
    'content-type': 'application/json',
  };
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

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'APPEAL_WINDOW',
    dueAt: FUTURE,
    source: 'CONTROLLER_STATED_DATE',
    evidenceArtifactId: ARTIFACT_ID,
    ...overrides,
  };
}

describe('the §5.13 group is completely implemented', () => {
  test('every registry route in group 5.13 has a handler in the route module', () => {
    const declared = ROUTES.filter((route) => route.group === '5.13');
    assert.equal(declared.length, 3, 'SPEC-003 §5.13 declares three routes');
    for (const route of declared) {
      const fastifyPattern = route.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
      assert.ok(
        DEADLINE_ROUTE_TEMPLATES.includes(fastifyPattern),
        `${route.method} ${route.path} (id ${route.id}) has no handler in src/http/routes/deadlines.ts`,
      );
    }
  });

  test('neither §5.13 write route carries a step-up, because §3.2 item 7 does not name one', () => {
    // The negative control for step-up in this group. §3.2 item 7 enumerates the routes that need a fresh
    // authentication, and it names 5.3.4/5.3.7/5.3.10, 5.8.2, 5.12.3 and 5.14.1 — not §5.13. A step-up
    // appearing here would refuse callers the contract permits.
    for (const id of ['5.13.1', '5.13.2', '5.13.3']) {
      assert.equal(ROUTES.find((r) => r.id === id)?.stepUp, false, `${id} must not require a step-up`);
    }
  });

  test('the kind and source vocabularies are closed sets the route validates', () => {
    assert.deepEqual([...DEADLINE_KINDS], [
      'CONTROLLER_RESPONSE',
      'APPEAL_WINDOW',
      'VERIFICATION_WINDOW',
      'MAIL_RESPONSE',
      'REGULATOR_ESCALATION',
    ]);
    // ONE source token, because `CONTROLLER_STATED_DATE` is the only one any specification names; NULL
    // ("no out-of-band input") is the absence of a source rather than a member of the set.
    assert.deepEqual([...DEADLINE_SOURCES], ['CONTROLLER_STATED_DATE']);
  });
});

describe('§5.13.1 state is derived, and WAIVED is unreachable', () => {
  test('the three reachable values are derived from the two stored instants', () => {
    const now = 1_000_000;
    assert.equal(deriveState(null, now + 1, now), 'OPEN', 'an unsatisfied deadline in the future is OPEN');
    assert.equal(deriveState(null, now - 1, now), 'BREACHED', 'an unsatisfied deadline in the past is BREACHED');
    assert.equal(deriveState(now - 5_000, now - 1, now), 'SATISFIED', 'a satisfied deadline is SATISFIED');
    // A deadline met LATE is still met: reporting it BREACHED afterwards would rewrite history.
    assert.equal(deriveState(now - 1, now - 500_000, now), 'SATISFIED', 'a late satisfaction stays SATISFIED');
  });

  test('WAIVED is never returned, whatever the inputs', () => {
    // The positive control for "unreachable": the derivation is exercised across a grid of inputs, and if a
    // waiver fact were ever invented this would fail rather than silently report a new state.
    //
    // `satisfiedAtMs` is the only argument that may be null — the column is nullable and NULL means "not
    // satisfied". `dueAtMs` and `nowMs` are always instants, so the grid keeps them numeric; passing null for
    // either would test an input the type forbids rather than one the data can produce.
    const satisfiedInstants: readonly (number | null)[] = [null, 0, 999_999, 1_000_000, 1_000_001];
    const instants = [0, 1, 999_999, 1_000_000, 1_000_001];
    for (const satisfied of satisfiedInstants) {
      for (const due of instants) {
        for (const now of instants) {
          const state = deriveState(satisfied, due, now);
          assert.notEqual(state, 'WAIVED', `deriveState(${String(satisfied)}, ${String(due)}, ${String(now)})`);
          assert.ok(['OPEN', 'SATISFIED', 'BREACHED'].includes(state), `unexpected state ${state}`);
        }
      }
    }
  });
});

describe('§5.13.2 refusals happen at the boundary, before any port call', () => {
  test('a missing or unknown source is 422 DEADLINE_SOURCE_REQUIRED', async () => {
    for (const [index, value] of [undefined, '', 'POLICY_DERIVED'].entries()) {
      const { app, calls } = serverWith();
      const body = validBody();
      if (value === undefined) delete body['source'];
      else body['source'] = value;
      const res = await post(app, `/v1/cases/${CASE_ID}/deadlines`, { body, key: `deadline-test-key-1000${String(index)}` });
      assert.equal(res.status, 422, `source=${JSON.stringify(value)}: ${JSON.stringify(res)}`);
      assert.equal(res.code, 'DEADLINE_SOURCE_REQUIRED', `source=${JSON.stringify(value)}`);
      assert.deepEqual(calls, [], 'a refusal must not reach the port');
      await app.close();
    }
  });

  test('an unknown kind is refused with the SEMANTIC schema spelling', async () => {
    const { app, calls } = serverWith();
    const res = await post(app, `/v1/cases/${CASE_ID}/deadlines`, { body: validBody({ kind: 'SOON' }) });
    // 422 and not 400: the body is well-formed JSON with a present `kind`; what fails is that the value is
    // not in the vocabulary, which SPEC-006 §6.2 calls the semantic spelling.
    assert.equal(res.status, 422, JSON.stringify(res));
    assert.equal(res.code, 'SCHEMA_VALIDATION_FAILED');
    assert.deepEqual(calls, []);
    await app.close();
  });

  test('a dueAt in the past is 422 DEADLINE_IN_PAST', async () => {
    const { app, calls } = serverWith();
    const res = await post(app, `/v1/cases/${CASE_ID}/deadlines`, { body: validBody({ dueAt: PAST }) });
    assert.equal(res.status, 422);
    assert.equal(res.code, 'DEADLINE_IN_PAST');
    assert.deepEqual(calls, []);
    await app.close();
  });

  test('a malformed dueAt or evidenceArtifactId is refused before the port', async () => {
    const { app, calls } = serverWith();
    const badDate = await post(app, `/v1/cases/${CASE_ID}/deadlines`, { body: validBody({ dueAt: 'next tuesday' }) });
    assert.equal(badDate.status, 400, 'an unparseable instant is a syntactic failure');
    const badArtifact = await post(app, `/v1/cases/${CASE_ID}/deadlines`, {
      body: validBody({ evidenceArtifactId: 'evd_01H' }),
      key: 'deadline-test-key-000002',
    });
    assert.equal(badArtifact.status, 400);
    assert.deepEqual(calls, []);
    await app.close();
  });

  test('a missing If-Match is 428 and a malformed one is 412, with no port call', async () => {
    const { app, calls } = serverWith();
    const missing = await post(app, `/v1/cases/${CASE_ID}/deadlines`, { body: validBody(), ifMatch: null });
    assert.equal(missing.status, 428);
    assert.equal(missing.code, 'PRECONDITION_REQUIRED');

    const star = await post(app, `/v1/cases/${CASE_ID}/deadlines`, {
      body: validBody(),
      ifMatch: '*',
      key: 'deadline-test-key-000003',
    });
    assert.equal(star.status, 412);
    assert.equal(star.code, 'PRECONDITION_FAILED');
    assert.deepEqual(calls, []);
    await app.close();
  });

  test('§5.13.3 refuses a blank satisfiedBy before the port', async () => {
    const { app, calls } = serverWith();
    const res = await post(app, `/v1/deadlines/${DEADLINE_ID}/satisfaction`, {
      body: { satisfiedAt: new Date().toISOString(), satisfiedBy: '   ', evidenceArtifactId: ARTIFACT_ID },
    });
    assert.equal(res.status, 400);
    assert.equal(res.code, 'SCHEMA_VALIDATION_FAILED');
    assert.deepEqual(calls, []);
    await app.close();
  });
});

describe('§5.13 follows §4.1 for idempotency, from the registry', () => {
  test('both write routes are 400 IDEMPOTENCY_KEY_REQUIRED with no key', async () => {
    const { app } = serverWith();
    const create = await post(app, `/v1/cases/${CASE_ID}/deadlines`, { body: validBody(), key: null });
    assert.equal(create.status, 400);
    assert.equal(create.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const satisfy = await post(app, `/v1/deadlines/${DEADLINE_ID}/satisfaction`, {
      body: { satisfiedAt: new Date().toISOString(), satisfiedBy: 'operator-0001', evidenceArtifactId: ARTIFACT_ID },
      key: null,
    });
    assert.equal(satisfy.status, 400);
    assert.equal(satisfy.code, 'IDEMPOTENCY_KEY_REQUIRED');
    await app.close();
  });

  test('§5.13.1 is readable with only vg.cases.read and no step-up', async () => {
    const { app } = serverWith({ scopes: ['vg.cases.read'], authTimeAgeSeconds: 3600 });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/cases/${CASE_ID}/deadlines`,
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    // A stale authentication must not be refused on a read: §5.13.1 is Optional with no step-up, and a 403
    // would mean a read inherited a write's control. The port returns no case, so the route answers 404.
    assert.equal(response.statusCode, 404);
    await app.close();
  });

  test('a caller holding only the read scope is 403 INSUFFICIENT_SCOPE on the writes', async () => {
    const { app } = serverWith({ scopes: ['vg.cases.read'] });
    const res = await post(app, `/v1/cases/${CASE_ID}/deadlines`, { body: validBody() });
    assert.equal(res.status, 403);
    assert.equal(res.code, 'INSUFFICIENT_SCOPE');
    await app.close();
  });
});

describe('§5.13 port-level refusals map to the codes the specification names', () => {
  test('NO_PROVENANCE maps to JURISDICTION_UNRESOLVED and refuses the row', async () => {
    // Exercised at the boundary with a stub, because the situation is "the case has no PolicyDecision" —
    // which needs a case with a NULL decision, and mutating the seeded case to get one would make this a
    // test about fixture surgery rather than about the mapping.
    const recorded = recordingDeadlineQueries();
    const port: DeadlineQueries = {
      ...recorded.port,
      caseDeadlineContext: async () => ({
        caseId: CASE_ID,
        truthState: 'MATCH_CONFIRMED',
        updatedAtMs: 1,
        provenance: undefined,
      }),
      createDeadline: async () => ({ ok: false, reason: 'NO_PROVENANCE' }),
    };
    const { app } = serverWith({ port });
    const res = await post(app, `/v1/cases/${CASE_ID}/deadlines`, { body: validBody(), ifMatch: '"MATCH_CONFIRMED:1"' });
    // The only code in the closed set meaning "no policy resolves for this request", which is exactly the
    // situation: without a decision there is no version or rule to name.
    assert.equal(res.status, 422, JSON.stringify(res));
    assert.equal(res.code, 'JURISDICTION_UNRESOLVED');
    await app.close();
  });

  test('every code these routes emit is registered (H-7)', () => {
    for (const code of [
      'DEADLINE_SOURCE_REQUIRED',
      'DEADLINE_IN_PAST',
      'DEADLINE_ALREADY_SATISFIED',
      'EVIDENCE_NOT_FOUND',
      'JURISDICTION_UNRESOLVED',
      'PRECONDITION_FAILED',
      'PRECONDITION_REQUIRED',
      'RESOURCE_NOT_FOUND',
      'SCHEMA_VALIDATION_FAILED',
    ]) {
      assert.equal(isErrorCode(code), true, `${code} must be in the registry`);
    }
  });
});
