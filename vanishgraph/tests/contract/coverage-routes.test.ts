/**
 * The §5.16 declarations, credential-free (SPEC-003 §5.16, §3.2).
 *
 * WHAT BELONGS HERE: the registry rows, the refusals the parser produces before any port is reached, and the
 * FORBIDDEN-VOCABULARY walk. The metric's arithmetic, the report read path and the cursor walk all need a database
 * and live in `tests/db/coverage-reports.test.ts`.
 *
 * THE WALK IS THE POINT. §5.16.3 and SPEC-000 §7.3 forbid a field named `removed`, `permanentDeletion`,
 * `successRate` or `requestsSent` on `/v1`, and a rule that nothing checks is a rule a later milestone adds a field
 * through. Asserting it over a real response body — from a stub port, at the boundary — catches the field where it
 * would be introduced.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testCoverageQueries, testIdentity, testServerDependencies, TEST_TOKEN } from './server-support.ts';
import { ROUTES } from '../../src/http/openapi/registry.ts';
import { isErrorCode } from '../../src/http/errors/code-registry.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const REPORT_ID = '55555555-1111-4111-8111-555555555555';
const SCOPES = ['vg.coverage.read'];

function app(scopes: readonly string[] = SCOPES): VgFastify {
  return buildServer(
    testServerDependencies({
      identity: testIdentity({ tenantId: TENANT_A, scopes }),
      coverageQueries: testCoverageQueries(),
    }),
  );
}

async function get(server: VgFastify, url: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await server.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.statusCode, json };
}

function codeOf(response: { json: Record<string, unknown> }): unknown {
  const error = response.json['error'];
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined;
}

const FROM = '2026-08-01T00:00:00.000Z';
const TO = '2026-08-08T00:00:00.000Z';

describe('§5.16 is declared as the registry says it is', () => {
  test('the three routes carry the specified scopes, methods and idempotency', () => {
    const expected: readonly [string, string, string, string][] = [
      ['5.16.1', '/v1/coverage-reports', 'vg.coverage.read', 'optional'],
      ['5.16.2', '/v1/coverage-reports/{coverageReportId}', 'vg.coverage.read', 'optional'],
      ['5.16.3', '/v1/metrics/removal-effectiveness', 'vg.coverage.read', 'optional'],
    ];
    for (const [id, path, scope, idempotency] of expected) {
      const route = ROUTES.find((candidate) => candidate.id === id);
      assert.ok(route !== undefined, `${id} is not in the registry`);
      assert.equal(route.method, 'GET', id);
      assert.equal(route.path, path, id);
      assert.deepEqual(route.scopes, [scope], id);
      assert.equal(route.idempotency, idempotency, id);
    }
  });

  test('nothing in §5.16 mutates: no POST, PATCH, PUT or DELETE exists on these paths', () => {
    for (const path of ['/v1/coverage-reports', '/v1/coverage-reports/{coverageReportId}', '/v1/metrics/removal-effectiveness']) {
      const writers = ROUTES.filter((route) => route.path === path && route.method !== 'GET');
      assert.deepEqual(writers, [], `${path} has a write route`);
    }
    // And the boundary refuses one that is attempted anyway.
    return (async () => {
      const server = app();
      for (const [method, url] of [
        ['POST', '/v1/coverage-reports'],
        ['PATCH', `/v1/coverage-reports/${REPORT_ID}`],
        ['DELETE', `/v1/coverage-reports/${REPORT_ID}`],
      ] as const) {
        const response = await server.inject({ method, url, headers: { authorization: `Bearer ${TEST_TOKEN}` } });
        assert.ok(
          response.statusCode === 404 || response.statusCode === 405,
          `${method} ${url} answered ${String(response.statusCode)}`,
        );
      }
      await server.close();
    })();
  });

  test('every code these routes emit is registered (H-7)', () => {
    for (const code of ['INVALID_GROUP_BY', 'TIME_RANGE_REQUIRED', 'TIME_RANGE_TOO_WIDE', 'INVALID_CURSOR', 'RESOURCE_NOT_FOUND']) {
      assert.equal(isErrorCode(code), true, `${code} must be in the registry`);
    }
  });
});

describe('§5.16.3 refuses what the contract says it refuses', () => {
  test('a request without a time range is refused, naming THIS collection', async () => {
    const server = app();
    const response = await get(server, `/v1/metrics/removal-effectiveness?to=${encodeURIComponent(TO)}`);
    assert.equal(response.status, 400, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'TIME_RANGE_REQUIRED');
    const details = (response.json['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
    // MEASURED DEFECT this pins: the parser hard-coded `audit-events` in this refusal, and the error boundary
    // DROPPED `details` for every non-ApiError thrower — so a metric request without a range was told nothing
    // about which parameter was missing. Both are fixed, and this asserts the pair.
    assert.equal(details['collection'], 'metrics/removal-effectiveness');
    await server.close();
  });

  test('an unknown groupBy is its own code, and an unknown parameter is not ignored', async () => {
    const server = app();
    const bad = await get(
      server,
      `/v1/metrics/removal-effectiveness?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&groupBy=jurisdiction,source`,
    );
    assert.equal(bad.status, 400, JSON.stringify(bad.json));
    assert.equal(codeOf(bad), 'INVALID_GROUP_BY');

    const unknown = await get(
      server,
      `/v1/metrics/removal-effectiveness?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=5`,
    );
    assert.equal(unknown.status, 400, JSON.stringify(unknown.json));
    assert.equal(codeOf(unknown), 'UNKNOWN_QUERY_PARAMETER');
    await server.close();
  });

  test('the response is a metric, never a removal claim: the forbidden field names are absent', async () => {
    const server = app();
    const response = await get(
      server,
      `/v1/metrics/removal-effectiveness?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
    );
    assert.equal(response.status, 200, JSON.stringify(response.json));

    const seen = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, entry] of Object.entries(value)) {
        seen.add(key);
        walk(entry);
      }
    };
    walk(response.json);
    for (const forbidden of ['removed', 'permanentDeletion', 'successRate', 'requestsSent', 'requestsSubmitted']) {
      assert.equal(seen.has(forbidden), false, `the metric response carries a field named ${forbidden}`);
    }
    // The disclosures that MUST be present, asserted from the other side so neither list can be satisfied alone.
    for (const required of [
      'interval',
      'overall',
      'excludedFromNumerator',
      'caveats',
      'verifiedRemovedNumerator',
      'eligibleConfirmedMatchDenominator',
      'ratio',
      'confidenceInterval',
      'denominatorDefinedAs',
      'acknowledged',
      'requestSubmitted',
      'searchDelisted',
      'notRemovable',
      'humanRequired',
    ]) {
      assert.equal(seen.has(required), true, `the metric response must carry ${required}`);
    }
    await server.close();
  });

  test('a stub with no data reports a null ratio rather than a zero rate', async () => {
    const server = app();
    const response = await get(
      server,
      `/v1/metrics/removal-effectiveness?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
    );
    const overall = response.json['overall'] as Record<string, unknown>;
    assert.equal(overall['eligibleConfirmedMatchDenominator'], 0);
    assert.equal(overall['ratio'], null);
    await server.close();
  });
});

describe('§5.16.1 and §5.16.2 request rules', () => {
  test('§5.16.1 offers generatedAt as its only sort field', async () => {
    const server = app();
    const bad = await get(server, '/v1/coverage-reports?sort=subjectId:desc');
    assert.equal(bad.status, 400, JSON.stringify(bad.json));
    assert.equal(codeOf(bad), 'INVALID_SORT_FIELD');

    const ok = await get(server, '/v1/coverage-reports?sort=generatedAt:asc&limit=1');
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const page = ok.json['page'] as Record<string, unknown>;
    assert.equal(page['sort'], 'generatedAt:asc');
    // The default window is applied and ECHOED, so a wide scan cannot present itself as a narrow one (§2.6).
    const filter = page['filter'] as Record<string, unknown>;
    assert.equal(filter['appliedDefaultTimeRangeDays'], 30);
    await server.close();
  });

  test('§5.16.2 answers 404 for a malformed id, because "malformed" and "not yours" are one answer', async () => {
    const server = app();
    // MEASURED, and my first expectation was wrong: I asserted 400 for `not-a-uuid` and the boundary answered 404.
    // The code is right and the expectation was not — `uuidParam` reports a malformed id as NOT FOUND on purpose,
    // because SPEC-006 H-9 requires an absent resource and another tenant's resource to be indistinguishable, and
    // a distinct "malformed id" response would tell a prober which shapes exist. The test now pins that rule.
    const malformed = await get(server, '/v1/coverage-reports/not-a-uuid');
    assert.equal(malformed.status, 404, JSON.stringify(malformed.json));
    assert.equal(codeOf(malformed), 'RESOURCE_NOT_FOUND');

    const missing = await get(server, `/v1/coverage-reports/${REPORT_ID}`);
    assert.equal(missing.status, 404, JSON.stringify(missing.json));
    await server.close();
  });

  test('the coverage reads need vg.coverage.read', async () => {
    const server = app(['vg.cases.read']);
    const response = await get(server, '/v1/coverage-reports');
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'INSUFFICIENT_SCOPE');
    await server.close();
  });
});
