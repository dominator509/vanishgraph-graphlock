/**
 * The §5.10.2/§5.10.3/§5.11.2/§5.11.3 boundary contract, without a database.
 *
 * WHAT THIS SUITE CAN AND CANNOT PROVE. It runs no PostgreSQL, so it proves nothing about the rows —
 * `tests/db/observation-reads.test.ts` does that. What it proves is the part that is structural:
 *
 *   * The four routes are declared, share `vg.observations.read`, and carry no step-up (§3.2 item 7 does not
 *     name any of them).
 *   * `REAPPEARANCES_QUERY` MATCHES §5.11.2's own query line. That declaration existed before its route did
 *     and had drifted: it declared `exposureId` where the spec says `subjectId`, declared sort fields
 *     (`detectedAt`, `createdAt`) that are not columns of the table, and refused `from`/`to` although the spec
 *     gives them. This test asserts the declared surface against the spec's tokens so the drift cannot
 *     return — a declaration nothing drives is a declaration nothing checks.
 *   * The `reEntryState` vocabulary is the three tokens SPEC-003 names, and each has a predicate, so the
 *     filter and the meaning of the tokens share one definition.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import {
  testAppealQueries,
  testAuditQueries,
  testDeadlineQueries,
  testExposureQueries,
  testIdentity,
  testRecipeVerificationKeys,
  testSourceQueries,
  testSubjectQueries,
  testTenancy,
  testCaseQueries,
  testTransitionQueries,
  TEST_SESSION_SECRET,
  TEST_TOKEN,
} from './server-support.ts';
import { ROUTES, findRoute } from '../../src/http/openapi/registry.ts';
import { isErrorCode } from '../../src/http/errors/code-registry.ts';
import { OBSERVATION_ROUTE_TEMPLATES, RE_ENTRY_STATES } from '../../src/http/routes/observations.ts';
import { REAPPEARANCES_QUERY } from '../../src/http/query/filters.ts';
import { REENTRY_RULES, RE_ENTRY_STATE_SQL } from '../../src/application/contracts/observation-queries.ts';
import type { ObservationQueries } from '../../src/application/contracts/observation-queries.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '77777777-1111-4111-8111-777777777777';
const EXPOSURE_ID = '99999999-1111-4111-8111-999999999999';

function recordingObservationQueries(): { readonly port: ObservationQueries; readonly calls: string[] } {
  const calls: string[] = [];
  const note = (name: string): void => {
    calls.push(name);
  };
  const port: ObservationQueries = {
    caseExists: async () => {
      note('caseExists');
      return false;
    },
    listVerificationObservations: async () => {
      note('listVerificationObservations');
      return [];
    },
    getVerificationObservation: async () => {
      note('getVerificationObservation');
      return undefined;
    },
    exposureExists: async () => {
      note('exposureExists');
      return false;
    },
    listReappearances: async () => {
      note('listReappearances');
      return [];
    },
    listReappearancesForExposure: async () => {
      note('listReappearancesForExposure');
      return [];
    },
  };
  return { port, calls };
}

function serverWith(
  options: { scopes?: readonly string[]; authTimeAgeSeconds?: number; port?: ObservationQueries } = {},
): { app: VgFastify; calls: string[] } {
  const recorded = recordingObservationQueries();
  const app = buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({
      tenantId: TENANT_A,
      scopes: options.scopes ?? ['vg.observations.read'],
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
    subjectQueries: testSubjectQueries(),
    sourceQueries: testSourceQueries(),
    recipeVerificationKeys: testRecipeVerificationKeys(),
    appealQueries: testAppealQueries(),
    deadlineQueries: testDeadlineQueries(),
    auditQueries: testAuditQueries(),
    observationQueries: options.port ?? recorded.port,
    exposureQueries: testExposureQueries(),
    transitionQueries: testTransitionQueries(),
    caseQueries: testCaseQueries(),
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
  });
  return { app, calls: recorded.calls };
}

async function get(app: VgFastify, url: string): Promise<{ status: number; code: unknown; json: Record<string, unknown> }> {
  const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = {};
  }
  const error = json['error'];
  return {
    status: response.statusCode,
    code: typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined,
    json,
  };
}

describe('the §5.10/§5.11 read routes are declared as the specification declares them', () => {
  test('all four routes exist, share vg.observations.read, and carry no step-up', () => {
    const declared = ROUTES.filter((route) => ['5.10.2', '5.10.3', '5.11.2', '5.11.3'].includes(route.id));
    assert.equal(declared.length, 4);
    for (const route of declared) {
      assert.equal(route.method, 'GET', `${route.id} must be a read`);
      assert.deepEqual(route.scopes, ['vg.observations.read'], `${route.id}`);
      // §3.2 item 7 enumerates the routes needing a fresh authentication and names none of these; a step-up
      // here would refuse callers the contract permits.
      assert.equal(route.stepUp, false, `${route.id} must not require a step-up`);
      assert.equal(route.idempotency, 'optional', `${route.id}`);
    }
    for (const template of OBSERVATION_ROUTE_TEMPLATES) {
      const registryForm = template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
      assert.ok(
        ROUTES.some((r) => r.path === registryForm),
        `${template} is implemented but not in the registry`,
      );
    }
  });

  test('REAPPEARANCES_QUERY matches §5.11.2’s query line, token for token', () => {
    // The spec: "Query: `subjectId`, `sourceId`, `from`, `to`, `reEntryState` ∈
    // `PENDING_REENTRY|REENTERED|NOT_REMOVABLE`, `sort` ∈ `observedAt` (default `observedAt:desc`)".
    assert.deepEqual(Object.keys(REAPPEARANCES_QUERY.parameters).sort(), [
      'cursor',
      'limit',
      'reEntryState',
      'sourceId',
      'subjectId',
    ]);
    // The drift this pins: the declaration had `exposureId`, sort fields `detectedAt`/`createdAt` (neither a
    // column of `reappearance`), and `timeFilterable: false` despite the spec giving `from`/`to`.
    assert.deepEqual([...REAPPEARANCES_QUERY.sortFields], ['observedAt']);
    assert.equal(REAPPEARANCES_QUERY.defaultSort, 'observedAt:desc');
    assert.equal(REAPPEARANCES_QUERY.timeFilterable, true, 'the spec gives from/to, so the range is accepted');
    assert.equal(REAPPEARANCES_QUERY.parameters['reEntryState']?.type, 'enum');
    assert.deepEqual(
      [...(REAPPEARANCES_QUERY.parameters['reEntryState']?.values ?? [])],
      ['PENDING_REENTRY', 'REENTERED', 'NOT_REMOVABLE'],
    );
  });

  test('every reEntryState token has a predicate, so the filter and the vocabulary share one definition', () => {
    assert.deepEqual([...RE_ENTRY_STATES].sort(), ['NOT_REMOVABLE', 'PENDING_REENTRY', 'REENTERED']);
    for (const token of RE_ENTRY_STATES) {
      assert.equal(typeof RE_ENTRY_STATE_SQL[token], 'string', `${token} must have a predicate`);
      assert.ok((RE_ENTRY_STATE_SQL[token] ?? '').length > 0);
    }
    // The three predicates partition the states: each names a different condition, and none is the constant
    // `true` (which would make the filter silently match everything).
    assert.equal(new Set(Object.values(RE_ENTRY_STATE_SQL)).size, 3);
    for (const predicate of Object.values(RE_ENTRY_STATE_SQL)) {
      assert.notEqual(predicate.trim(), 'true');
    }
  });

  test('the re-entry rules are the T18 guards, and are constants of the contract', () => {
    // SPEC-001 T18 (`REAPPEARED` → `REQUEST_READY`) guards on fresh authority, policy and recipe; the fourth
    // field is a statement about the schema (nothing removes prior evidence), which is why T18's guard list
    // does not contain it. All four are reported per row because §5.11.2 requires `reentry` on every row.
    assert.deepEqual(REENTRY_RULES, {
      requiresFreshAuthority: true,
      requiresFreshPolicyDecision: true,
      requiresFreshRecipe: true,
      preservesPriorEvidence: true,
    });
    assert.equal(Object.isFrozen(REENTRY_RULES), true, 'the rules are the contract’s, not a row’s');
  });
});

describe('§5.10 lists the observations a case’s sub-resource routes are scoped to', () => {
  test('an absent case is 404 and the observation list is not attempted', async () => {
    const { app, calls } = serverWith();
    const res = await get(app, `/v1/cases/${CASE_ID}/verification-observations`);
    // The stub reports the case absent, so this is the 404 path — asserted with the call log, because a route
    // that listed first and checked afterwards would answer an empty list to a caller who cannot see the case.
    assert.equal(res.status, 404, JSON.stringify(res.json));
    assert.deepEqual(calls, ['caseExists']);
    await app.close();
  });

  test('an absent observation id is 404, and a malformed one too', async () => {
    const { app } = serverWith();
    const absent = await get(app, `/v1/verification-observations/${CASE_ID}`);
    assert.equal(absent.status, 404);
    assert.equal(absent.code, 'RESOURCE_NOT_FOUND');
    // A malformed id is NOT FOUND rather than a validation error, so a prober learns nothing about the shape
    // (SPEC-006 H-9) — the same rule every other path parameter follows.
    const malformed = await get(app, '/v1/verification-observations/not-a-uuid');
    assert.equal(malformed.status, 404);
    await app.close();
  });

  test('an absent exposure is 404 on the reappearance-history route', async () => {
    const { app, calls } = serverWith();
    const res = await get(app, `/v1/exposures/${EXPOSURE_ID}/reappearances`);
    assert.equal(res.status, 404);
    assert.deepEqual(calls, ['exposureExists']);
    await app.close();
  });

  test('a caller without the observations scope is refused before the port', async () => {
    const { app, calls } = serverWith({ scopes: ['vg.cases.read'] });
    const res = await get(app, `/v1/cases/${CASE_ID}/verification-observations`);
    assert.equal(res.status, 403);
    assert.equal(res.code, 'INSUFFICIENT_SCOPE');
    assert.deepEqual(calls, []);
    await app.close();
  });

  test('a stale authentication is accepted on these reads: no step-up was declared', async () => {
    const { app } = serverWith({ authTimeAgeSeconds: 7200 });
    const res = await get(app, `/v1/cases/${CASE_ID}/verification-observations`);
    // Not a 403: §5.10.2/§5.10.3/§5.11.2/§5.11.3 have no step-up, and a 403 here would mean a read inherited a
    // write's control — which is the failure this assertion exists to catch.
    assert.equal(res.status, 404, 'the stub reports the case absent; the point is that it is not 403');
    await app.close();
  });

  test('every code these routes emit is registered (H-7)', () => {
    for (const code of ['RESOURCE_NOT_FOUND', 'INSUFFICIENT_SCOPE', 'INVALID_CURSOR', 'UNKNOWN_QUERY_PARAMETER']) {
      assert.equal(isErrorCode(code), true, `${code} must be in the registry`);
    }
  });
});
