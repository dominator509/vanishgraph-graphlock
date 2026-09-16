/**
 * SPEC-003 §5.4.4 and §5.4.5 against real PostgreSQL (EP-004 M6).
 *
 * WHAT THIS SUITE PROVES:
 *
 *   * **The candidate-record listing derives its assessment state from the exposure** and ENFORCES VG-IDENT-004: a
 *     record from a `SEARCH_ENGINE` class source is `UNASSESSED` and carries no `exposureId`, whatever exposure
 *     exists for it.
 *   * **The coverage block reports what is known**: a subject with a coverage report gets that report's counts; a
 *     subject with none gets `applies: false` and THREE NULLS, not zeros — "nothing was attempted" is a measurement
 *     and no report is the absence of one (VG-DISC-002).
 *   * **`rawRefMasked` is masked by construction**: scheme and host survive, path and query do not.
 *   * **Pagination is a real walk**: a filtered walk returns every matching row exactly once, which is the property
 *     that would break if the assessment filter were applied after the fetch instead of in SQL.
 *   * **§5.4.1/§5.4.2/§5.4.3 refuse, and say the model is undefined** rather than "not implemented".
 *
 * WHAT IT DOES NOT PROVE: that a discovery run exists, that anything produces these records, or that
 * `discoveryRunId` can ever be non-null. The rows are FIXTURES — see ASSUMPTIONS §3.39.
 *
 * FIXTURE DISCIPLINE: this suite's own tenants, per run (ASSUMPTIONS §3.27).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN, testServerDependencies } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresDiscoveryQueries } from '../../src/adapters/persistence/discovery.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, exec, ownerDsn } from './harness.ts';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RUN = randomUUID().slice(0, 8);
const SCOPES = ['vg.discovery.read', 'vg.discovery.run', 'vg.exposures.read', 'vg.coverage.read'];

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
      discoveryQueries: new PostgresDiscoveryQueries(),
      subjectQueries: new PostgresSubjectQueries(),
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
  if (method === 'POST') headers['idempotency-key'] = `discovery-suite-${RUN}-${randomUUID().slice(0, 8)}`;
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
  return { status: response.statusCode, json };
}

function codeOf(response: Injected): unknown {
  const error = response.json['error'];
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined;
}

interface World {
  readonly subjectId: string;
  readonly registrySourceId: string;
  readonly engineSourceId: string;
  readonly grantId: string;
}

function newSubject(label: string): World {
  const subjectId = randomUUID();
  const grantId = randomUUID();
  const registrySourceId = randomUUID();
  const engineSourceId = randomUUID();
  const created = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
         VALUES ('${subjectId}', '${TENANT_A}', 'disc-${label}-${RUN}', 'US-CA', false, 'ACTIVE');`,
      `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, revoked_at, signed_instrument)
         VALUES ('${grantId}', '${TENANT_A}', '${subjectId}', 'SELF', ARRAY['discovery'], now() - interval '1 day',
                 now() + interval '30 days', NULL, false);`,
      `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class)
         VALUES ('${registrySourceId}', '${TENANT_A}', 'disc-registry-${RUN}-${registrySourceId.slice(0, 8)}',
                 'REGISTRY', 'US-CA', 'WRITE_PERMITTED'),
                ('${engineSourceId}', '${TENANT_A}', 'disc-engine-${RUN}-${engineSourceId.slice(0, 8)}',
                 'SEARCH_ENGINE', 'US-CA', 'READ_ONLY');`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(created.status, 0, `subject fixture failed: ${created.output}`);
  return { subjectId, registrySourceId, engineSourceId, grantId };
}

/** A record plus, optionally, an exposure for this subject at the given truth state. */
function newRecord(
  world: World,
  options: {
    readonly sourceId: string;
    readonly seed: string;
    readonly tainted?: boolean;
    readonly rawRef?: string;
    readonly observedAgo?: string;
    readonly truthState?: string | null;
  },
): { recordId: string; exposureId: string | null } {
  const recordId = randomUUID();
  const exposureId = options.truthState === null ? null : randomUUID();
  const lines = [
    'BEGIN;',
    `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
    `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
       VALUES ('${recordId}', '${TENANT_A}', '${options.sourceId}',
               '${options.rawRef ?? `https://example.invalid/subject/${options.seed}?q=${RUN}`}',
               now() - interval '${options.observedAgo ?? '3 hours'}', '${hashOf(options.seed)}',
               ${options.tainted === true ? 'true' : 'false'});`,
  ];
  if (exposureId !== null) {
    lines.push(
      `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
         VALUES ('${exposureId}', '${TENANT_A}', '${world.subjectId}', '${recordId}', 0.9,
                 '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, '${options.truthState ?? 'DISCOVERED_CANDIDATE'}');`,
    );
  }
  lines.push('COMMIT;');
  const created = exec(ownerDsn(), lines.join('\n'));
  assert.equal(created.status, 0, `record fixture failed: ${created.output}`);
  return { recordId, exposureId };
}

function hashOf(seed: string): string {
  // A deterministic 64-hex value per seed, so a test can name the record it expects without reading it back.
  const hex = Buffer.from(`record:${seed}:${RUN}`, 'utf8').toString('hex');
  return (hex + hex).slice(0, 64);
}

function newCoverageReport(subjectId: string, total: number, attempted: number, complete: boolean): void {
  const created = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO coverage_report (tenant_id, subject_id, catalogue_id, generated_at, sources_total,
                                    sources_attempted, sources_succeeded, sources_skipped, unchecked_remainder,
                                    complete, caveats)
         VALUES ('${TENANT_A}', '${subjectId}', 'catalog-${RUN}', now() - interval '10 minutes', ${String(total)},
                 ${String(attempted)}, ${String(attempted)}, '[]'::jsonb,
                 ${complete ? `'[]'::jsonb` : `'[{"sourceId":"${randomUUID()}","sourceName":"never-reached"}]'::jsonb`},
                 ${complete ? 'true' : 'false'},
                 ARRAY['PARTIAL_COVERAGE_ABSENCE_NOT_ESTABLISHED']);`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(created.status, 0, `coverage fixture failed: ${created.output}`);
}

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'discovery-suite-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'discovery-suite-b-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);
  app = buildApp(TENANT_A);
});

after(async () => {
  await app.close();
  await runner.close();
});

describe('§5.4.4 candidate records', () => {
  test('a search-engine record is UNASSESSED with no exposureId, whatever its exposure says', async () => {
    const world = newSubject('engine');
    // The exposure EXISTS and is past DISCOVERED_CANDIDATE: the rule is about the SOURCE class, so a search hit is
    // still not a subject match (VG-IDENT-004) even when a naive join would call it one.
    const engine = newRecord(world, {
      sourceId: world.engineSourceId,
      seed: 'engine',
      truthState: 'MATCH_CONFIRMED',
    });
    const registry = newRecord(world, {
      sourceId: world.registrySourceId,
      seed: 'registry',
      truthState: 'MATCH_CONFIRMED',
    });

    const response = await call(app, 'GET', `/v1/subjects/${world.subjectId}/candidate-records`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const data = response.json['data'] as Record<string, unknown>[];
    assert.equal(data.length, 2, JSON.stringify(data));

    const engineRow = data.find((row) => row['sourceRecordId'] === engine.recordId);
    const registryRow = data.find((row) => row['sourceRecordId'] === registry.recordId);
    assert.ok(engineRow !== undefined && registryRow !== undefined);
    assert.equal(engineRow['assessmentState'], 'UNASSESSED');
    assert.equal(engineRow['exposureId'], null, 'a search hit must not carry an exposure id');
    assert.equal(registryRow['assessmentState'], 'MATCH_CONFIRMED');
    assert.equal(registryRow['exposureId'], registry.exposureId);
  });

  test('a record with no exposure is NOT this subject’s candidate, and an UNASSESSED record is masked', async () => {
    const world = newSubject('unassessed');
    // NO EXPOSURE means nothing in this schema attributes the record to a subject — the run link that would is
    // exactly what §5.4.1 lacks — so it must not appear in the subject's list.
    newRecord(world, { sourceId: world.registrySourceId, seed: 'bare', truthState: null });
    const attributed = newRecord(world, {
      sourceId: world.registrySourceId,
      seed: 'attributed',
      truthState: 'DISCOVERED_CANDIDATE',
    });

    const response = await call(app, 'GET', `/v1/subjects/${world.subjectId}/candidate-records`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const data = response.json['data'] as Record<string, unknown>[];
    assert.equal(data.length, 1, JSON.stringify(data));
    const row = data[0];
    assert.equal(row?.['sourceRecordId'], attributed.recordId);
    assert.equal(row?.['assessmentState'], 'UNASSESSED');
    assert.equal(row?.['exposureId'], attributed.exposureId);
    assert.equal(row?.['rawRefMasked'], 'https://example.invalid/***');
    // The mask must not carry the subject's query string or path.
    assert.equal(JSON.stringify(row).includes('/subject/'), false);
    assert.equal(JSON.stringify(row).includes(RUN), false, 'no part of the query may survive the mask');
  });

  test('the coverage block reports a real report, and NULLS when there is none', async () => {
    const withReport = newSubject('covered');
    newRecord(withReport, { sourceId: withReport.registrySourceId, seed: 'covered', truthState: 'DISCOVERED_CANDIDATE' });
    newCoverageReport(withReport.subjectId, 12, 9, false);

    const covered = await call(app, 'GET', `/v1/subjects/${withReport.subjectId}/candidate-records`);
    assert.deepEqual(covered.json['coverage'], {
      applies: true,
      sourcesAttempted: 9,
      sourcesTotal: 12,
      complete: false,
    });

    const uncovered = newSubject('uncovered');
    newRecord(uncovered, { sourceId: uncovered.registrySourceId, seed: 'uncovered', truthState: null });
    const bare = await call(app, 'GET', `/v1/subjects/${uncovered.subjectId}/candidate-records`);
    // THREE NULLS, NOT ZEROS: no report is not a report of zero coverage.
    assert.deepEqual(bare.json['coverage'], {
      applies: false,
      sourcesAttempted: null,
      sourcesTotal: null,
      complete: null,
    });
  });

  test('the assessment filter is applied in SQL, so a filtered walk is still a complete walk', async () => {
    const world = newSubject('paging');
    for (let index = 0; index < 5; index += 1) {
      newRecord(world, {
        sourceId: world.registrySourceId,
        seed: `paging-${String(index)}`,
        observedAgo: `${String(index + 1)} hours`,
        truthState: index % 2 === 0 ? 'MATCH_CONFIRMED' : 'DISCOVERED_CANDIDATE',
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url =
        `/v1/subjects/${world.subjectId}/candidate-records?limit=2&assessmentState=UNASSESSED` +
        (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
      const response = await call(app, 'GET', url);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      for (const row of response.json['data'] as Record<string, unknown>[]) {
        seen.push(String(row['sourceRecordId']));
        assert.equal(row['assessmentState'], 'UNASSESSED');
      }
      cursor = (response.json['page'] as Record<string, unknown>)['nextCursor'] as string | null;
      if (cursor === null) break;
    }
    // Two UNASSESSED records exist (indexes 1 and 3); a filtered walk must find BOTH and nothing else.
    assert.equal(seen.length, 2, `saw ${String(seen.length)} rows: ${JSON.stringify(seen)}`);
    assert.equal(new Set(seen).size, 2, 'no row may be returned twice');
  });

  test('a subject that does not resolve is 404, and another tenant’s records are invisible', async () => {
    const missing = await call(app, 'GET', `/v1/subjects/${randomUUID()}/candidate-records`);
    assert.equal(missing.status, 404, JSON.stringify(missing.json));
    assert.equal(codeOf(missing), 'RESOURCE_NOT_FOUND');

    const world = newSubject('cross');
    newRecord(world, { sourceId: world.registrySourceId, seed: 'cross', truthState: 'DISCOVERED_CANDIDATE' });
    const other = buildApp(TENANT_B);
    const crossTenant = await call(other, 'GET', `/v1/subjects/${world.subjectId}/candidate-records`);
    assert.equal(crossTenant.status, 404, JSON.stringify(crossTenant.json));
    await other.close();
  });
});

describe('§5.4.5 one source record', () => {
  test('the detail reports taint with its reason, the raw reference, and a null discoveryRunId', async () => {
    const world = newSubject('detail');
    const tainted = newRecord(world, {
      sourceId: world.registrySourceId,
      seed: 'tainted',
      tainted: true,
      rawRef: `https://example.invalid/page/${RUN}/x`,
      truthState: 'DISCOVERED_CANDIDATE',
    });

    const response = await call(app, 'GET', `/v1/source-records/${tainted.recordId}`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['taint'], 'TAINTED');
    // §5.4.5's own token for a tainted record; the boolean is the only storage there is.
    assert.equal(response.json['taintReason'], 'UNTRUSTED_REMOTE_CONTENT');
    // §5.4.5 returns the RAW reference (the masking rule is §5.4.4's, for a listing): an operator reading one record
    // needs the address it came from.
    assert.equal(response.json['rawRef'], `https://example.invalid/page/${RUN}/x`);
    assert.equal(response.json['contentHash'], hashOf('tainted'));
    // NOTHING RECORDS A RUN: no specification defines one, so the honest value is null.
    assert.equal(response.json['discoveryRunId'], null);
    assert.equal(response.json['assessmentState'], 'UNASSESSED');
  });

  test('an untainted record has no taint reason, and an unknown record is 404 for every tenant', async () => {
    const world = newSubject('clean');
    const clean = newRecord(world, {
      sourceId: world.registrySourceId,
      seed: 'clean',
      tainted: false,
      truthState: 'MATCH_CONFIRMED',
    });
    const response = await call(app, 'GET', `/v1/source-records/${clean.recordId}`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['taint'], 'UNTAINTED');
    assert.equal(response.json['taintReason'], null);
    assert.equal(response.json['assessmentState'], 'MATCH_CONFIRMED');

    const unknown = await call(app, 'GET', `/v1/source-records/${randomUUID()}`);
    assert.equal(unknown.status, 404, JSON.stringify(unknown.json));

    const other = buildApp(TENANT_B);
    const crossTenant = await call(other, 'GET', `/v1/source-records/${clean.recordId}`);
    assert.equal(crossTenant.status, 404, JSON.stringify(crossTenant.json));
    await other.close();
  });
});

describe('§5.4.1–§5.4.3 name the model no specification defines', () => {
  test('all three refuse 503 with the SAME reason, and the reason names the gap rather than a missing build step', async () => {
    for (const [method, url] of [
      ['POST', '/v1/discovery-runs'],
      ['GET', '/v1/discovery-runs'],
      ['GET', `/v1/discovery-runs/${randomUUID()}`],
    ] as const) {
      const response = await call(app, method, url, method === 'POST' ? {} : undefined);
      assert.equal(response.status, 503, `${method} ${url}: ${JSON.stringify(response.json)}`);
      assert.equal(codeOf(response), 'DEPENDENCY_UNAVAILABLE');
      const details = (response.json['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
      assert.match(String(details['reason']), /no specification defines a DiscoveryRun/);
    }
  });
});
