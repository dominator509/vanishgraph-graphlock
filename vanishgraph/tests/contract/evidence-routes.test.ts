/**
 * The §5.12 declarations and boundary rules, credential-free (SPEC-003 §5.12).
 *
 * WHAT BELONGS HERE: the five registry rows, the scope separation between reading metadata and reading CONTENT, and
 * the refusals the three unperformable routes produce. The metadata row, the traceability join and the case list's
 * 404-versus-empty distinction need a database and live in `tests/db/evidence-reads.test.ts`.
 *
 * THE SCOPE SEPARATION IS THE POINT OF THE THIRD TEST. §5.12.3 requires `vg.evidence.read_content` **and** a
 * step-up, while §5.12.2 and §5.12.5 require only `vg.evidence.read`: a token that may see an artifact's digest and
 * kind must not thereby be able to fetch the document itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, testServerDependencies, TEST_TOKEN } from './server-support.ts';
import type { EvidenceQueries } from '../../src/application/contracts/evidence-queries.ts';
import { ROUTES } from '../../src/http/openapi/registry.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const ARTIFACT_ID = '99999999-1111-4111-8111-999999999999';
const CASE_ID = '88888888-1111-4111-8111-888888888888';

const READ_ROW = {
  evidenceArtifactId: ARTIFACT_ID,
  kind: 'SOURCE_SNAPSHOT',
  digest: 'a'.repeat(64),
  storageRef: 's3://evidence/test',
  redactionState: 'NONE',
  capturedAt: new Date(0).toISOString(),
  createdAt: new Date(0).toISOString(),
  linkedCaseIds: [CASE_ID],
  sizeBytes: null,
  mediaType: null,
  immutable: true as const,
};

function app(scopes: readonly string[], queries?: Partial<EvidenceQueries>): VgFastify {
  return buildServer(
    testServerDependencies({
      identity: testIdentity({ tenantId: TENANT_A, scopes }),
      ...(queries === undefined ? {} : { evidenceQueries: { ...defaultQueries(), ...queries } }),
    }),
  );
}

function defaultQueries(): EvidenceQueries {
  return {
    getEvidenceArtifact: async () => undefined,
    listCaseEvidenceArtifacts: async () => undefined,
  };
}

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

async function call(
  server: VgFastify,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<Injected> {
  const headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST') headers['idempotency-key'] = `evidence-contract-${randomUUID().slice(0, 8)}`;
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
  return { status: response.statusCode, json, headers: response.headers as Record<string, unknown> };
}

function codeOf(response: Injected): unknown {
  const error = response.json['error'];
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined;
}

describe('§5.12 is declared as the registry says it is', () => {
  test('the five routes carry their specified methods, scopes, step-up and idempotency', () => {
    const expected: readonly [string, string, string, readonly string[], boolean, string, number][] = [
      ['5.12.1', 'POST', '/v1/evidence-artifacts', ['vg.evidence.write'], false, 'required', 201],
      ['5.12.2', 'GET', '/v1/evidence-artifacts/{evidenceArtifactId}', ['vg.evidence.read'], false, 'optional', 200],
      [
        '5.12.3',
        'GET',
        '/v1/evidence-artifacts/{evidenceArtifactId}/content',
        ['vg.evidence.read_content'],
        true,
        'optional',
        200,
      ],
      [
        '5.12.4',
        'POST',
        '/v1/evidence-artifacts/{evidenceArtifactId}/integrity-checks',
        ['vg.evidence.read'],
        false,
        'required',
        200,
      ],
      ['5.12.5', 'GET', '/v1/cases/{caseId}/evidence-artifacts', ['vg.evidence.read'], false, 'optional', 200],
    ];
    for (const [id, method, path, scopes, stepUp, idempotency, successStatus] of expected) {
      const route = ROUTES.find((candidate) => candidate.id === id);
      assert.ok(route !== undefined, `${id} is not in the registry`);
      assert.equal(route.method, method, id);
      assert.equal(route.path, path, id);
      assert.deepEqual(route.scopes, scopes, id);
      assert.equal(route.stepUp ?? false, stepUp, id);
      assert.equal(route.idempotency, idempotency, id);
      assert.equal(route.successStatus, successStatus, id);
    }
  });

  test('NO route replaces or deletes artifact content: VG-EVIDENCE-001 has no update path', () => {
    // The artifact read reports `immutable: true` on the strength of this absence, so the absence is asserted rather
    // than described: a PATCH or DELETE on these paths would make the field a false claim.
    for (const path of [
      '/v1/evidence-artifacts/{evidenceArtifactId}',
      '/v1/evidence-artifacts/{evidenceArtifactId}/content',
    ]) {
      const writers = ROUTES.filter(
        (route) => route.path === path && (route.method === 'PATCH' || route.method === 'PUT' || route.method === 'DELETE'),
      );
      assert.deepEqual(writers, [], `${path} has a mutation route`);
    }
  });

  test('reading metadata and reading CONTENT are different capabilities', async () => {
    const server = app(['vg.evidence.read']);
    const metadata = await call(server, 'GET', `/v1/evidence-artifacts/${ARTIFACT_ID}`);
    // 404 because the stub holds no artifact — the point is that it is NOT 403: the metadata read is permitted with
    // `vg.evidence.read` alone.
    assert.equal(metadata.status, 404, JSON.stringify(metadata.json));

    const content = await call(server, 'GET', `/v1/evidence-artifacts/${ARTIFACT_ID}/content`);
    assert.equal(content.status, 403, JSON.stringify(content.json));
    assert.equal(codeOf(content), 'INSUFFICIENT_SCOPE');
    await server.close();
  });
});

describe('§5.12 refusals and reads at the boundary', () => {
  test('the metadata read maps a missing artifact to 404 and returns the row with the digest as its ETag', async () => {
    const server = app(['vg.evidence.read'], {
      getEvidenceArtifact: async () => ({
        ...READ_ROW,
        linkedTraceability: { requirementIds: [], caseIds: [CASE_ID], transitionIds: ['42'] },
      }),
    });
    const response = await call(server, 'GET', `/v1/evidence-artifacts/${ARTIFACT_ID}`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.headers['etag'], `"${'a'.repeat(64)}"`);
    assert.deepEqual((response.json['linkedTraceability'] as Record<string, unknown>)['transitionIds'], ['42']);
    await server.close();
  });

  test('the case list distinguishes a case with no artifacts from a case that does not resolve', async () => {
    const emptyCase = app(['vg.evidence.read'], { listCaseEvidenceArtifacts: async () => [] });
    const empty = await call(emptyCase, 'GET', `/v1/cases/${CASE_ID}/evidence-artifacts`);
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.deepEqual(empty.json['data'], []);
    await emptyCase.close();

    const missingCase = app(['vg.evidence.read'], { listCaseEvidenceArtifacts: async () => undefined });
    const missing = await call(missingCase, 'GET', `/v1/cases/${CASE_ID}/evidence-artifacts`);
    assert.equal(missing.status, 404, JSON.stringify(missing.json));
    await missingCase.close();
  });

  test('the three unperformable routes refuse 503 and never answer with a body that looks like content', async () => {
    const server = app(['vg.evidence.write', 'vg.evidence.read', 'vg.evidence.read_content'], {
      getEvidenceArtifact: async () => ({
        ...READ_ROW,
        linkedTraceability: { requirementIds: [], caseIds: [], transitionIds: [] },
      }),
    });

    const upload = await call(server, 'POST', '/v1/evidence-artifacts', {});
    assert.equal(upload.status, 503, JSON.stringify(upload.json));
    assert.equal(codeOf(upload), 'DEPENDENCY_UNAVAILABLE');

    const download = await call(server, 'GET', `/v1/evidence-artifacts/${ARTIFACT_ID}/content`);
    assert.equal(download.status, 503, JSON.stringify(download.json));
    assert.equal(Object.prototype.hasOwnProperty.call(download.json, 'content'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(download.json, 'data'), false);

    const integrity = await call(server, 'POST', `/v1/evidence-artifacts/${ARTIFACT_ID}/integrity-checks`, {});
    assert.equal(integrity.status, 503, JSON.stringify(integrity.json));
    // The refusal must not report a verification: a body carrying `integrityState` here would be a claim that
    // nothing verified anything.
    assert.equal(Object.prototype.hasOwnProperty.call(integrity.json, 'integrityState'), false);
    await server.close();
  });

  test('a malformed artifact id is 404 by the boundary’s own rule, not a validation error', async () => {
    const server = app(['vg.evidence.read']);
    const response = await call(server, 'GET', '/v1/evidence-artifacts/not-a-uuid');
    assert.equal(response.status, 404, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'RESOURCE_NOT_FOUND');
    await server.close();
  });
});
