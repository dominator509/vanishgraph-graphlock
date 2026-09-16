/**
 * SPEC-003 §5.12.2 and §5.12.5 against real PostgreSQL (EP-004 M6).
 *
 * WHAT THIS SUITE PROVES, AND WHAT IT DOES NOT:
 *
 *   * **The metadata route reports the DIGEST as the artifact's identity** — the ETag is the digest, the row's
 *     `digest` is the stored one, and `linkedTraceability.transitionIds` names the audit rows that CITED the
 *     artifact, resolved through `audit_event.evidence_artifact_ids` rather than through a second table.
 *   * **The case list distinguishes "no artifacts" from "no case"**: an existing case with none is `200 []`, a case
 *     that does not resolve is `404`, and another tenant's is `404` by the same rule (SPEC-006 H-9).
 *   * **The three routes that cannot perform their effect say so, and resolve the artifact FIRST** — an unknown
 *     artifact is `404`, not "a dependency is missing".
 *
 * IT DOES NOT PROVE UPLOAD, DOWNLOAD OR A REAL INTEGRITY CHECK, because this repository has no `EvidenceStore` and
 * no multipart parser (ASSUMPTIONS §3.38). The rows below are FIXTURES: nothing in the running system creates an
 * evidence artifact yet, so reading this suite as evidence of an evidence pipeline would be exactly the mistake the
 * honesty rules exist to prevent.
 *
 * FIXTURE DISCIPLINE: this suite's own tenants, per run (ASSUMPTIONS §3.27).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN, testServerDependencies, testWebhookDependencies } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresEvidenceQueries } from '../../src/adapters/persistence/evidence.ts';
import { PostgresDiscoveryQueries } from '../../src/adapters/persistence/discovery.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, exec, ownerDsn } from './harness.ts';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RUN = randomUUID().slice(0, 8);
const SCOPES = ['vg.evidence.read', 'vg.evidence.write', 'vg.evidence.read_content'];

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;
let app: VgFastify;

function buildApp(tenantId: string, scopes: readonly string[] = SCOPES): VgFastify {
  return buildServer(
    testServerDependencies({
      identity: testIdentity({ tenantId, scopes }),
      tenancy: { runner },
      idempotency: {
        store: idempotency,
        requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
      },
      sessionSecret: TEST_SESSION_SECRET,
      evidenceQueries: new PostgresEvidenceQueries(),
    discoveryQueries: new PostgresDiscoveryQueries(),
    ...testWebhookDependencies(),
    }),
  );
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
  if (method === 'POST') headers['idempotency-key'] = `evidence-suite-${RUN}-${randomUUID().slice(0, 8)}`;
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
    json = { __raw: response.body };
  }
  return { status: response.statusCode, json, headers: response.headers as Record<string, unknown> };
}

function codeOf(response: Injected): unknown {
  const error = response.json['error'];
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined;
}

interface World {
  readonly subjectId: string;
  readonly caseId: string;
}

/** A subject with a case, which the artifacts can be bound to. */
function newWorld(): World {
  const subjectId = randomUUID();
  const grantId = randomUUID();
  const sourceId = randomUUID();
  const recordId = randomUUID();
  const exposureId = randomUUID();
  const caseId = randomUUID();
  const created = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
         VALUES ('${subjectId}', '${TENANT_A}', 'evd-${RUN}-${subjectId.slice(0, 8)}', 'US-CA', false, 'ACTIVE');`,
      `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, revoked_at, signed_instrument)
         VALUES ('${grantId}', '${TENANT_A}', '${subjectId}', 'SELF', ARRAY['discovery'], now() - interval '1 day',
                 now() + interval '30 days', NULL, false);`,
      `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class)
         VALUES ('${sourceId}', '${TENANT_A}', 'evd-source-${RUN}-${sourceId.slice(0, 8)}', 'REGISTRY', 'US-CA',
                 'WRITE_PERMITTED');`,
      `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
         VALUES ('${recordId}', '${TENANT_A}', '${sourceId}', 'https://example.invalid/evd-${RUN}',
                 now() - interval '2 days', repeat('f', 64), false);`,
      `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
         VALUES ('${exposureId}', '${TENANT_A}', '${subjectId}', '${recordId}', 0.9,
                 '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, 'MATCH_CONFIRMED');`,
      `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, truth_state)
         VALUES ('${caseId}', '${TENANT_A}', '${subjectId}', '${exposureId}', '${sourceId}', '${grantId}',
                 'MATCH_CONFIRMED');`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(created.status, 0, `world fixture failed: ${created.output}`);
  return { subjectId, caseId };
}

/** One artifact row. The digest is a REAL SHA-256 of the bytes this fixture names, never a placeholder. */
function newArtifact(world: World | null, seed: string, redactionState = 'NONE'): { id: string; digest: string } {
  const id = randomUUID();
  const digest = createHash('sha256').update(`artifact-bytes:${seed}:${RUN}`, 'utf8').digest('hex');
  const created = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO evidence_artifact (id, tenant_id, case_id, kind, digest, storage_ref, egress_class,
                                      redaction_state, captured_at)
         VALUES ('${id}', '${TENANT_A}', ${world === null ? 'NULL' : `'${world.caseId}'`}, 'SOURCE_SNAPSHOT',
                 '${digest}', 's3://evidence/${RUN}/${id}', 'NONE', '${redactionState}', now() - interval '1 hour');`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(created.status, 0, `artifact fixture failed: ${created.output}`);
  return { id, digest };
}

/** An audit row that CITES an artifact, which is what `linkedTraceability.transitionIds` must find. */
function newCitingTransition(world: World, artifactId: string): string {
  const created = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO audit_event (tenant_id, actor, actor_kind, action, target_kind, target_id, case_id, correlation_id,
                                payload, outcome, transition_code, from_truth_state, to_truth_state,
                                evidence_artifact_ids, at)
         VALUES ('${TENANT_A}', 'test', 'SERVICE', 'exposure.transition', 'Exposure',
                 (SELECT exposure_id FROM request_case WHERE id = '${world.caseId}'), '${world.caseId}',
                 gen_random_uuid(), '{}'::jsonb, 'SUCCEEDED', 'T3', 'DISCOVERED_CANDIDATE', 'MATCH_CONFIRMED',
                 ARRAY['${artifactId}']::uuid[], now() - interval '30 minutes')
         RETURNING 'VG_TRANSITION_ID=' || id::text;`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(created.status, 0, `transition fixture failed: ${created.output}`);
  // A MARKER, not a positional guess: the transaction also prints the `set_config` echo, and MEASURED — the first
  // version of this helper regexed the first number in the output and captured an unrelated row count.
  const marker = /VG_TRANSITION_ID=(\d+)/.exec(created.output);
  assert.ok(marker !== null, `no transition id in the fixture output: ${created.output}`);
  return marker[1] ?? '';
}

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'evidence-suite-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'evidence-suite-b-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);
  app = buildApp(TENANT_A);
});

after(async () => {
  await app.close();
  await runner.close();
});

describe('§5.12.2 artifact metadata and its traceability chain', () => {
  test('the row carries the stored digest as its identity, the ETag is that digest, and nothing is fabricated', async () => {
    const world = newWorld();
    const artifact = newArtifact(world, 'metadata', 'SCRUBBED');
    const transitionId = newCitingTransition(world, artifact.id);

    const response = await call(app, 'GET', `/v1/evidence-artifacts/${artifact.id}`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['digest'], artifact.digest);
    assert.equal(response.json['kind'], 'SOURCE_SNAPSHOT');
    assert.equal(response.headers['etag'], `"${artifact.digest}"`, 'the digest IS the entity tag');
    assert.deepEqual(response.json['linkedCaseIds'], [world.caseId]);
    // A read must never carry content, and there is no field for it: the row has no `content`/`body`/`bytes` key.
    assert.equal(Object.prototype.hasOwnProperty.call(response.json, 'content'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(response.json, 'body'), false);
    // REDACTION STATE IS REPORTED VERBATIM. The column says SCRUBBED and the contract's vocabulary says
    // DLP_SCRUBBED; the route does not translate, so the conflict stays visible (ASSUMPTIONS §3.38).
    assert.equal(response.json['redactionState'], 'SCRUBBED');
    // IMMUTABLE by construction: the registry contains no update, replace or delete route for artifact content.
    assert.equal(response.json['immutable'], true);
    // NOT RECORDED, reported as not recorded.
    assert.equal(response.json['sizeBytes'], null);
    assert.equal(response.json['mediaType'], null);

    const traceability = response.json['linkedTraceability'] as Record<string, unknown>;
    assert.deepEqual(traceability['caseIds'], [world.caseId]);
    assert.deepEqual(traceability['transitionIds'], [transitionId], 'the citing audit row must be found');
    // NO SOURCE EXISTS for the requirement third of the chain, so it is empty rather than fabricated.
    assert.deepEqual(traceability['requirementIds'], []);
  });

  test('an artifact nothing cites has an empty transition list, and an unknown id is 404', async () => {
    const world = newWorld();
    const artifact = newArtifact(world, 'uncited');
    const response = await call(app, 'GET', `/v1/evidence-artifacts/${artifact.id}`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.deepEqual((response.json['linkedTraceability'] as Record<string, unknown>)['transitionIds'], []);

    const unknown = await call(app, 'GET', `/v1/evidence-artifacts/${randomUUID()}`);
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));
  });

  test('another tenant’s artifact is 404, indistinguishable from an absent one', async () => {
    const world = newWorld();
    const artifact = newArtifact(world, 'cross-tenant');
    const other = buildApp(TENANT_B);
    const response = await call(other, 'GET', `/v1/evidence-artifacts/${artifact.id}`);
    assert.equal(response.status, 404, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'RESOURCE_NOT_FOUND');
    await other.close();
  });
});

describe('§5.12.5 a case’s artifacts', () => {
  test('the list returns the case’s artifacts, newest capture first, and never content', async () => {
    const world = newWorld();
    const first = newArtifact(world, 'list-1');
    const second = newArtifact(world, 'list-2');
    // An artifact bound to NO case must not appear in any case list.
    const orphan = newArtifact(null, 'orphan');

    const response = await call(app, 'GET', `/v1/cases/${world.caseId}/evidence-artifacts`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const data = response.json['data'] as Record<string, unknown>[];
    const ids = data.map((row) => row['evidenceArtifactId']);
    assert.equal(ids.length, 2, JSON.stringify(ids));
    assert.equal(ids.includes(first.id), true);
    assert.equal(ids.includes(second.id), true);
    assert.equal(ids.includes(orphan.id), false, 'an artifact with no case must not be listed under one');
    for (const row of data) {
      assert.equal(typeof row['digest'], 'string');
      assert.equal(typeof row['capturedAt'], 'string');
      assert.equal(Object.prototype.hasOwnProperty.call(row, 'content'), false);
    }
  });

  test('an existing case with no artifacts is 200 with an empty list, and a missing case is 404', async () => {
    const world = newWorld();
    const empty = await call(app, 'GET', `/v1/cases/${world.caseId}/evidence-artifacts`);
    // THE DISTINCTION THAT MATTERS: an empty list is a true statement about a case that EXISTS.
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.deepEqual(empty.json['data'], []);

    const missing = await call(app, 'GET', `/v1/cases/${randomUUID()}/evidence-artifacts`);
    assert.equal(missing.status, 404, JSON.stringify(missing.json));
    assert.equal(codeOf(missing), 'RESOURCE_NOT_FOUND');
  });
});

describe('§5.12.1/§5.12.3/§5.12.4 name the dependency they lack', () => {
  test('upload and download are 503 naming the missing store, and neither leaks a body', async () => {
    const world = newWorld();
    const artifact = newArtifact(world, 'refusals');

    const upload = await call(app, 'POST', '/v1/evidence-artifacts', { kind: 'SOURCE_SNAPSHOT' });
    assert.equal(upload.status, 503, JSON.stringify(upload.json));
    assert.equal(codeOf(upload), 'DEPENDENCY_UNAVAILABLE');
    const uploadReason = ((upload.json['error'] as Record<string, unknown>)['details'] as Record<string, unknown>)[
      'reason'
    ];
    assert.match(String(uploadReason), /multipart/);
    assert.match(String(uploadReason), /EvidenceStore/);

    const download = await call(app, 'GET', `/v1/evidence-artifacts/${artifact.id}/content`);
    assert.equal(download.status, 503, JSON.stringify(download.json));
    const downloadReason = ((download.json['error'] as Record<string, unknown>)['details'] as Record<string, unknown>)[
      'reason'
    ];
    assert.match(String(downloadReason), /tenant scope/);
    assert.equal(Object.prototype.hasOwnProperty.call(download.json, 'content'), false);
  });

  test('the integrity check resolves the ARTIFACT FIRST, then refuses the verification it cannot perform', async () => {
    const world = newWorld();
    const artifact = newArtifact(world, 'integrity');

    const unknown = await call(app, 'POST', `/v1/evidence-artifacts/${randomUUID()}/integrity-checks`, {});
    assert.equal(unknown.status, 404, `an unknown artifact is 404, not a 503: ${JSON.stringify(unknown.json)}`);

    const known = await call(app, 'POST', `/v1/evidence-artifacts/${artifact.id}/integrity-checks`, {});
    assert.equal(known.status, 503, JSON.stringify(known.json));
    const reason = ((known.json['error'] as Record<string, unknown>)['details'] as Record<string, unknown>)['reason'];
    // The refusal states WHY reporting the stored digest would be wrong: it would verify nothing.
    assert.match(String(reason), /recompute SHA-256/);
    assert.match(String(reason), /verified nothing/);
  });

  test('a caller without the content scope cannot even reach the download refusal', async () => {
    const world = newWorld();
    const artifact = newArtifact(world, 'scope');
    const noContent = buildApp(TENANT_A, ['vg.evidence.read']);
    const response = await call(noContent, 'GET', `/v1/evidence-artifacts/${artifact.id}/content`);
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'INSUFFICIENT_SCOPE');
    await noContent.close();
  });
});
