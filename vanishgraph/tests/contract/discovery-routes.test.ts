/**
 * The §5.4 declarations and boundary rules, credential-free (SPEC-003 §5.4).
 *
 * WHAT BELONGS HERE: the five registry rows, the scope separation between RUNNING a discovery and READING one, the
 * strict query surface of §5.4.4, and the coverage block the listing must carry. The assessment derivation, the
 * VG-IDENT-004 search-engine rule and the cursor walk need a database and live in `tests/db/candidate-records.test.ts`.
 *
 * THE COVERAGE ASSERTION IS SMALL AND LOAD-BEARING. §5.4.4 makes `coverage` mandatory "whenever the listing is a
 * discovery-derived result set … a partial run cannot present as 'no exposure found' unqualified" (VG-DISC-002). An
 * empty page from the stub still has to carry it, with `applies: false` and null counts — an omitted block or a
 * zeroed one would both say something the data does not support.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, testServerDependencies, testSubjectQueries, TEST_TOKEN } from './server-support.ts';
import type { DiscoveryQueries } from '../../src/application/contracts/discovery-queries.ts';
import { ROUTES } from '../../src/http/openapi/registry.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const SUBJECT_ID = '44444444-1111-4111-8111-444444444444';

function app(scopes: readonly string[], queries?: Partial<DiscoveryQueries>): VgFastify {
  return buildServer(
    testServerDependencies({
      identity: testIdentity({ tenantId: TENANT_A, scopes }),
      ...(queries === undefined
        ? {}
        : {
            discoveryQueries: {
              listCandidateRecords: async () => ({
                rows: [],
                coverage: { applies: false, sourcesAttempted: null, sourcesTotal: null, complete: null },
              }),
              getSourceRecord: async () => undefined,
              ...queries,
            },
          }),
    }),
  );
}

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function call(server: VgFastify, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Injected> {
  const headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST') headers['idempotency-key'] = `discovery-contract-${randomUUID().slice(0, 8)}`;
  const response = await server.inject({
    method,
    url,
    headers,
    ...(body === undefined ? {} : { payload: body as object }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.statusCode, json };
}

function codeOf(response: Injected): unknown {
  const error = response.json['error'];
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined;
}

describe('§5.4 is declared as the registry says it is', () => {
  test('the five routes carry their specified methods and scopes', () => {
    const expected: readonly [string, string, string, readonly string[], string][] = [
      ['5.4.1', 'POST', '/v1/discovery-runs', ['vg.discovery.run'], 'required'],
      ['5.4.2', 'GET', '/v1/discovery-runs', ['vg.discovery.read'], 'optional'],
      ['5.4.3', 'GET', '/v1/discovery-runs/{discoveryRunId}', ['vg.discovery.read'], 'optional'],
      [
        '5.4.4',
        'GET',
        '/v1/subjects/{subjectId}/candidate-records',
        ['vg.exposures.read'],
        'optional',
      ],
      ['5.4.5', 'GET', '/v1/source-records/{sourceRecordId}', ['vg.discovery.read'], 'optional'],
    ];
    for (const [id, method, path, scopes, idempotency] of expected) {
      const route = ROUTES.find((candidate) => candidate.id === id);
      assert.ok(route !== undefined, `${id} is not in the registry`);
      assert.equal(route.method, method, id);
      assert.equal(route.path, path, id);
      assert.deepEqual(route.scopes, scopes, id);
      assert.equal(route.idempotency, idempotency, id);
    }
  });

  test('running a discovery and reading one are different capabilities', async () => {
    const server = app(['vg.discovery.read']);
    const started = await call(server, 'POST', '/v1/discovery-runs', {});
    assert.equal(started.status, 403, JSON.stringify(started.json));
    assert.equal(codeOf(started), 'INSUFFICIENT_SCOPE');
    await server.close();
  });

  test('a caller without vg.exposures.read cannot list candidate records', async () => {
    const server = app(['vg.discovery.read']);
    const response = await call(server, 'GET', `/v1/subjects/${SUBJECT_ID}/candidate-records`);
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'INSUFFICIENT_SCOPE');
    await server.close();
  });
});

describe('§5.4.4 request rules decided before the port', () => {
  const SCOPES = ['vg.exposures.read'];

  test('an unknown parameter, an unknown sort field and an unknown state are each refused', async () => {
    const server = app(SCOPES);
    const unknown = await call(server, 'GET', `/v1/subjects/${SUBJECT_ID}/candidate-records?runState=ACCEPTED`);
    assert.equal(unknown.status, 400, JSON.stringify(unknown.json));
    assert.equal(codeOf(unknown), 'UNKNOWN_QUERY_PARAMETER');

    const badSort = await call(server, 'GET', `/v1/subjects/${SUBJECT_ID}/candidate-records?sort=observedAt`);
    assert.equal(badSort.status, 400, JSON.stringify(badSort.json));
    assert.equal(codeOf(badSort), 'INVALID_SORT_FIELD');

    const badState = await call(
      server,
      'GET',
      `/v1/subjects/${SUBJECT_ID}/candidate-records?assessmentState=REMOVED`,
    );
    assert.equal(badState.status, 400, JSON.stringify(badState.json));
    assert.equal(codeOf(badState), 'SCHEMA_VALIDATION_FAILED');
    await server.close();
  });

  test('an empty page still carries the coverage bounds, with nulls rather than zeros', async () => {
    const server = app(SCOPES);
    const response = await call(server, 'GET', `/v1/subjects/${SUBJECT_ID}/candidate-records`);
    // The stub's subject does not exist, so this is the 404 path — a case the route answers before the port. To
    // assert the coverage block the stub must resolve the subject, which is what this suite does next.
    assert.equal(response.status, 404, JSON.stringify(response.json));
    await server.close();

    const withSubject = buildServer(
      testServerDependencies({
        identity: testIdentity({ tenantId: TENANT_A, scopes: SCOPES }),
        // Only `subjectExists` is overridden: the default stub answers false, which is the 404 path this suite has
        // just exercised, and the coverage assertion needs the listing to be REACHED.
        subjectQueries: { ...testSubjectQueries(), subjectExists: async () => true },
      }),
    );
    const listed = await call(withSubject, 'GET', `/v1/subjects/${SUBJECT_ID}/candidate-records`);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    assert.deepEqual(listed.json['data'], []);
    assert.deepEqual(listed.json['coverage'], {
      applies: false,
      sourcesAttempted: null,
      sourcesTotal: null,
      complete: null,
    });
    await withSubject.close();
  });
});

describe('§5.4.5 and the run routes', () => {
  test('an unknown source record is 404, never a dependency error', async () => {
    const server = app(['vg.discovery.read']);
    const response = await call(server, 'GET', `/v1/source-records/${randomUUID()}`);
    assert.equal(response.status, 404, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'RESOURCE_NOT_FOUND');
    await server.close();
  });

  test('the three run routes refuse and the reason names the SPECIFICATION gap', async () => {
    const server = app(['vg.discovery.run', 'vg.discovery.read']);
    for (const [method, url] of [
      ['POST', '/v1/discovery-runs'],
      ['GET', '/v1/discovery-runs'],
      ['GET', `/v1/discovery-runs/${randomUUID()}`],
    ] as const) {
      const response = await call(server, method, url, method === 'POST' ? {} : undefined);
      assert.equal(response.status, 503, `${method} ${url}: ${JSON.stringify(response.json)}`);
      const details = (response.json['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
      // Not "not implemented": the honest reason is that no specification defines the aggregate.
      assert.match(String(details['reason']), /no specification defines a DiscoveryRun/);
      assert.match(String(details['reason']), /SPEC-001/);
    }
    await server.close();
  });
});

/** A subject read model whose subject EXISTS, so the listing is reached rather than the 404. */

