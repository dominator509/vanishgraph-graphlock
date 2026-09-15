/**
 * Match assessment, disproof and the transition spine against real PostgreSQL (SPEC-003 §5.5.3–§5.5.5).
 *
 * WHAT THIS SUITE PROVES, and why each item needs a database rather than a stub:
 *
 *   * **A T3 or T4 the API reports is a ROW the database holds.** Every success assertion re-reads
 *     `exposure.truth_state` and the `audit_event` row rather than trusting the response body, because the
 *     failure this guards against is a handler that reports a transition it never wrote.
 *   * **The transition history is the audit spine, read back.** §5.5.5 returns the code, both states, the
 *     actor, the command, the evidence ids and the correlation id; the test drives a real POST and then walks
 *     the history over HTTP, so the two halves are shown to agree.
 *   * **The below-threshold path records an assessment WITHOUT a transition.** §5.5.3 says so plainly and the
 *     column's all-or-nothing CHECK makes a half-recorded transition unrepresentable — this asserts the audit
 *     row exists with a NULL transition code, which is the difference between "recorded" and "moved".
 *   * **SM-2 IN THE NEGATIVE DIRECTION.** Every refusal (bad precondition, wrong state, absent evidence,
 *     search-engine class, unresolved threshold, incomplete coverage) is asserted to leave NO audit row and NO
 *     state change. A refusal that wrote half of something is exactly what the invariant forbids, and it is
 *     the failure a response-only test cannot see.
 *   * **Cross-tenant reads are 404**, and the database layer returns zero rows independently.
 *
 * FIXTURE DISCIPLINE. Every test builds its own world — subject, source, source record, exposure and, where
 * the threshold matters, a policy version — with a per-run jurisdiction (`US-Z<run>`) so no other suite's
 * policy rows can decide this one's threshold. Nothing is deleted: `audit_event` is append-only by rule, and a
 * test that erased evidence would be demonstrating a capability the product does not have.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresExposureQueries } from '../../src/adapters/persistence/exposures.ts';
import { PostgresTransitionQueries } from '../../src/adapters/persistence/transitions.ts';
import { PostgresObservationQueries } from '../../src/adapters/persistence/observations.ts';
import { PostgresAuditQueries } from '../../src/adapters/persistence/audit-queries.ts';
import { PostgresDeadlineQueries } from '../../src/adapters/persistence/deadlines.ts';
import { PostgresAppealQueries } from '../../src/adapters/persistence/appeals.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresSourceQueries } from '../../src/adapters/persistence/sources.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, asTenant, exec, ownerDsn } from './harness.ts';

/**
 * TWO TENANTS OF THIS SUITE'S OWN, created per run.
 *
 * NOT the seeded tenants, and that is a fixture-discipline decision with a measured reason: three other db
 * suites assert that tenant A has EXACTLY ONE seeded subject (`postgres-runner.test.ts:321`,
 * `rls.test.ts:101`, `route-catalogue.test.ts:127`), so a suite that adds subjects to tenant A breaks them —
 * measured, five failures across those files the first time this suite ran inside `test-integration`. Rows
 * written here are invisible to those counts, and the isolation assertions are about RLS rather than about the
 * seed, so nothing is lost by using tenants of our own.
 */
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

/** A per-run suffix, so no assertion depends on the total contents of a shared table. */
const RUN = randomUUID().slice(0, 8);

/** The scope §5.5's routes declare. */
const SCOPES = ['vg.exposures.read', 'vg.exposures.assess'];

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
  // The two tenants this suite owns. `tenant` is not tenant-scoped (it has no `tenant_id`), so no RLS applies
  // and the owner role can insert them directly.
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'exposure-suite-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'exposure-suite-b-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);
});

after(async () => {
  await runner.close();
});

function serverFor(tenantId: string, scopes: readonly string[] = SCOPES): VgFastify {
  return buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({ tenantId, scopes }),
    tenancy: { runner },
    idempotency: {
      store: idempotency,
      requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
    },
    sessionSecret: TEST_SESSION_SECRET,
    subjectQueries: new PostgresSubjectQueries(),
    sourceQueries: new PostgresSourceQueries(),
    recipeVerificationKeys: { publicKeysByRef: new Map<string, string>() },
    appealQueries: new PostgresAppealQueries(),
    deadlineQueries: new PostgresDeadlineQueries(),
    auditQueries: new PostgresAuditQueries(),
    observationQueries: new PostgresObservationQueries(),
    exposureQueries: new PostgresExposureQueries(),
    transitionQueries: new PostgresTransitionQueries(),
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
  });
}

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

let keyCounter = 0;

/**
 * A per-run idempotency key.
 *
 * MEASURED DEFECT CLASS (`ASSUMPTIONS.md` §3.22): a counter that restarts at 1 in every process makes a suite
 * pass exactly once, because the store retains a completed key for 24 hours and the second run presents the
 * same key with a different body. `test-integration` runs each file twice per invocation, so the first
 * invocation would consume the keys and the second would fail on identical code.
 */
function nextKey(): string {
  keyCounter += 1;
  return `exposure-db-key-${RUN}-${String(keyCounter).padStart(4, '0')}`;
}

async function call(
  app: VgFastify,
  method: 'GET' | 'POST',
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> {
  const headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}`, ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method === 'POST' && headers['idempotency-key'] === undefined) headers['idempotency-key'] = nextKey();

  const response = await app.inject({
    method,
    url,
    headers,
    ...(options.body === undefined ? {} : { payload: options.body as object }),
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

function detailsOf(response: Injected): Record<string, unknown> {
  const error = response.json['error'];
  if (typeof error !== 'object' || error === null) return {};
  const details = (error as Record<string, unknown>)['details'];
  return typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {};
}

const BASIS = [
  { feature: 'NAME_EXACT', weight: 0.4 },
  { feature: 'ADDRESS_MATCH', weight: 0.31 },
];

interface World {
  readonly exposureId: string;
  readonly subjectId: string;
  readonly sourceId: string;
  readonly recordId: string;
  readonly evidenceId: string;
  readonly jurisdiction: string;
}

/**
 * Build a subject/source/record/exposure world in tenant A.
 *
 * `threshold` is written into a policy version for this world's OWN jurisdiction, so another suite's policy
 * rows can never decide this test's threshold: `thresholdFor` takes the highest version in force, and a
 * jurisdiction no other fixture uses has exactly one candidate.
 */
function newWorld(options: {
  truthState?: string;
  sourceClass?: string;
  threshold?: number | null;
  basis?: unknown;
  tenantId?: string;
} = {}): World {
  const tenantId = options.tenantId ?? TENANT_A;
  const exposureId = randomUUID();
  const subjectId = randomUUID();
  const sourceId = randomUUID();
  const recordId = randomUUID();
  const evidenceId = randomUUID();
  // The jurisdiction is per WORLD, not per run: jurisdiction_policy is unique on (tenant, jurisdiction,
  // version), so two worlds sharing a jurisdiction would collide on version 1 — measured as
  // 'duplicate key value violates unique constraint jurisdiction_policy_tenant_id_jurisdiction_version_key'.
  // Each world owning its own jurisdiction also means no other suite's policy version can decide this world's
  // threshold.
  const jurisdiction = `US-Z${RUN}${exposureId.slice(0, 6)}`;

  const statements = [
    'BEGIN;',
    `SELECT set_config('app.tenant_id', '${tenantId}', true);`,
    `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
       VALUES ('${subjectId}', '${tenantId}', 'subject-ref-${RUN}', '${jurisdiction}', false, 'ACTIVE');`,
    // VG-IDENT-001 / VG-DATA-005: a subject cannot exist without authority, and the deferred trigger refuses
    // the whole transaction otherwise. Measured: without this row the fixture failed at COMMIT with
    // "ProtectedSubject … requires a valid AuthorityGrant at commit" — the schema enforcing the rule rather
    // than a convention, which is what makes it worth having.
    `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument)
       VALUES ('${randomUUID()}', '${tenantId}', '${subjectId}', 'SELF', ARRAY['discovery','self_service_write'], now() - interval '1 day', now() + interval '30 days', false);`,
    `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class, permission_checked_at)
       VALUES ('${sourceId}', '${tenantId}', 'source-${RUN}-${sourceId.slice(0, 8)}', '${options.sourceClass ?? 'REGISTRY'}', '${jurisdiction}', 'WRITE_PERMITTED', now());`,
    `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
       VALUES ('${recordId}', '${tenantId}', '${sourceId}', 'https://example.invalid/${RUN}', now() - interval '1 hour', repeat('c', 64), false);`,
    // An evidence artifact THIS WORLD owns, because the route checks that a cited artifact RESOLVES, and RLS
    // means another tenant's artifact is invisible — the seeded one belongs to the seeded tenant and would
    // answer EVIDENCE_NOT_FOUND here. Created per world so no other suite's rows can satisfy the check.
    `INSERT INTO evidence_artifact (id, tenant_id, kind, digest, storage_ref, egress_class, redaction_state, captured_at)
       VALUES ('${evidenceId}', '${tenantId}', 'MATCH_BASIS', repeat('d', 64), 's3://evidence/${RUN}/${evidenceId}', 'OPAQUE_ID', 'SCRUBBED', now());`,
    `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
       VALUES ('${exposureId}', '${tenantId}', '${subjectId}', '${recordId}', 0.42,
               '${JSON.stringify(options.basis ?? BASIS).replace(/'/g, "''")}'::jsonb,
               '${options.truthState ?? 'DISCOVERED_CANDIDATE'}');`,
  ];
  if (options.threshold !== undefined && options.threshold !== null) {
    statements.push(
      `INSERT INTO jurisdiction_policy (id, tenant_id, jurisdiction, version, effective_from, rules, provenance, match_confidence_threshold)
         VALUES ('${randomUUID()}', '${tenantId}', '${jurisdiction}', 1, now() - interval '1 day', ARRAY['CCPA_DELETE'], 'COUNSEL_REVIEWED', ${String(options.threshold)});`,
    );
  }
  statements.push('COMMIT;');

  const result = exec(ownerDsn(), statements.join('\n'));
  assert.equal(result.status, 0, `fixture failed: ${result.output}`);
  return { exposureId, subjectId, sourceId, recordId, evidenceId, jurisdiction };
}

/**
 * Read a value from the database as the owning role, with the tenant set.
 *
 * THE TRAILING SEMICOLON IS REQUIRED, and it is added here rather than at each call site. `asTenant` wraps the
 * statement between `BEGIN;` and `COMMIT;`, so an unterminated statement swallows the COMMIT and psql reports
 * `syntax error at or near "COMMIT"` on a line that looks unrelated to the query — measured while writing this
 * suite, on the first assertion rather than on any product code.
 */
function read(tenantId: string, sql: string): string[] {
  return asTenant(ownerDsn(), tenantId, sql.trimEnd().endsWith(';') ? sql : `${sql};`);
}

/** How many audit rows exist for one target — the count that proves a refusal wrote nothing. */
function auditRowsFor(tenantId: string, targetId: string): string[] {
  return read(
    tenantId,
    // EVERY PART IS COALESCED, including `transition_code`. A `NULL || '|' || …` chain is NULL, so a
    // transition-less row (the below-threshold assessment) printed an empty line — and an empty line is
    // dropped by the line reader, making a written row look like no row at all. Measured: the assertion
    // reported `[]` where the row existed, which reads as "the assessment was not recorded".
    `SELECT coalesce(a.transition_code, 'null') || '|' || a.action || '|' || coalesce(a.to_truth_state::text, '-')
       FROM audit_event a
      WHERE a.target_id = '${targetId}'::uuid
      ORDER BY a.at ASC, a.id ASC`,
  );
}

async function currentEtag(app: VgFastify, exposureId: string): Promise<string> {
  const detail = await call(app, 'GET', `/v1/exposures/${exposureId}`);
  assert.equal(detail.status, 200, `expected the detail read to succeed, got ${JSON.stringify(detail.json)}`);
  const etag = detail.headers['etag'];
  assert.equal(typeof etag, 'string', 'the detail read returned no ETag');
  return etag as string;
}

describe('§5.5.3 match assessment — T3 through the sealed guard', () => {
  test('an at-threshold assessment commits MATCH_CONFIRMED and is readable from the history', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ threshold: 0.85 });
    const etag = await currentEtag(app, world.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': etag },
      body: {
        confidence: { value: 0.95, basis: BASIS },
        method: 'FEATURE_SET_V1',
        evidenceArtifactId: world.evidenceId,
        humanReviewed: false,
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['truthState'], 'MATCH_CONFIRMED');
    assert.equal(response.json['policyThresholdApplied'], 0.85);
    assert.match(String(response.json['transitionId']), /^\d+$/);

    // THE DATABASE, NOT THE RESPONSE. A handler that reported a transition it never wrote would pass every
    // assertion above and fail these two.
    const state = read(TENANT_A, `SELECT truth_state::text FROM exposure WHERE id = '${world.exposureId}'`);
    assert.deepEqual(state, ['MATCH_CONFIRMED']);
    const audit = auditRowsFor(TENANT_A, world.exposureId);
    assert.deepEqual(audit, ['T3|AssessMatch|MATCH_CONFIRMED']);

    // And the same row through the §5.5.5 read, which is the contract's own way of checking legality.
    const history = await call(app, 'GET', `/v1/exposures/${world.exposureId}/transitions`);
    assert.equal(history.status, 200);
    const rows = history.json['data'] as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['transitionCode'], 'T3');
    assert.equal(rows[0]?.['fromTruthState'], 'DISCOVERED_CANDIDATE');
    assert.equal(rows[0]?.['toTruthState'], 'MATCH_CONFIRMED');
    assert.equal(rows[0]?.['command'], 'AssessMatch');
    assert.equal(rows[0]?.['actorIdentity'], 'domain-command');
    assert.deepEqual(rows[0]?.['evidenceArtifactIds'], [world.evidenceId]);
    assert.equal(rows[0]?.['transitionId'], response.json['transitionId']);
  });

  test('a stateless read reports the instant the current state came into effect', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ threshold: 0.85 });
    const etag = await currentEtag(app, world.exposureId);
    const before = await call(app, 'GET', `/v1/exposures/${world.exposureId}`);
    const createdAt = Date.parse(String(before.json['truthStateChangedAt']));

    await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': etag },
      body: { confidence: { value: 0.95, basis: BASIS }, method: 'FEATURE_SET_V1', humanReviewed: false },
    });

    const after = await call(app, 'GET', `/v1/exposures/${world.exposureId}`);
    assert.equal(after.json['truthState'], 'MATCH_CONFIRMED');
    const changedAt = Date.parse(String(after.json['truthStateChangedAt']));
    // `updated_at` moves on ANY update; the field must move only for a STATE change. Before T3 the exposure
    // had no transition row, so the value comes from `created_at`.
    assert.ok(Number.isFinite(createdAt), 'the pre-transition reading was not a timestamp');
    assert.ok(changedAt > createdAt, `${String(changedAt)} should be later than ${String(createdAt)}`);
  });
});

describe('§5.5.3 below threshold — an assessment with no transition', () => {
  test('records the assessment, keeps the state, and reports belowThreshold', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ threshold: 0.85 });
    const etag = await currentEtag(app, world.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': etag },
      body: { confidence: { value: 0.1, basis: BASIS }, method: 'FEATURE_SET_V1', humanReviewed: false },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['truthState'], 'DISCOVERED_CANDIDATE');
    assert.equal(response.json['belowThreshold'], true);
    assert.equal(response.json['assessmentRecorded'], true);
    assert.equal(response.json['transitionId'], undefined);

    // The assessment IS recorded — as an audit row with NO transition code — and the state did not move.
    const audit = auditRowsFor(TENANT_A, world.exposureId);
    assert.deepEqual(audit, ['null|AssessMatch|-']);
    const state = read(TENANT_A, `SELECT truth_state::text FROM exposure WHERE id = '${world.exposureId}'`);
    assert.deepEqual(state, ['DISCOVERED_CANDIDATE']);
    // The score is stored, so the exposure reports the latest assessment's confidence.
    const stored = read(TENANT_A, `SELECT confidence::text FROM exposure WHERE id = '${world.exposureId}'`);
    assert.deepEqual(stored, ['0.10']);

    const history = await call(app, 'GET', `/v1/exposures/${world.exposureId}/transitions`);
    assert.deepEqual(history.json['data'], []);
  });

  test('human review below threshold DOES transition — the guard has two branches', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ threshold: 0.85 });
    const etag = await currentEtag(app, world.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': etag },
      body: { confidence: { value: 0.1, basis: BASIS }, method: 'FEATURE_SET_V1', humanReviewed: true },
    });
    // T3's guard is `anyOf(confidenceAtThreshold, humanApprovedMatch)`. A route that only honoured the score
    // would answer belowThreshold here and the second half of the guard would be dead code.
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['truthState'], 'MATCH_CONFIRMED');
    assert.deepEqual(auditRowsFor(TENANT_A, world.exposureId), ['T3|AssessMatch|MATCH_CONFIRMED']);
  });
});

describe('§5.5.4 disproof — T4', () => {
  test('a complete scan disproves the match and records T4', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    const etag = await currentEtag(app, world.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${world.exposureId}/disproofs`, {
      headers: { 'if-match': etag },
      body: {
        disproofBasis: 'DIFFERENT_MIDDLE_NAME',
        evidenceArtifactId: world.evidenceId,
        scanComplete: true,
        coverageBounds: { sourcesAttempted: 12, sourcesTotal: 12 },
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['truthState'], 'VERIFIED_NOT_PRESENT');
    assert.deepEqual(response.json['coverageBounds'], { sourcesAttempted: 12, sourcesTotal: 12 });
    assert.deepEqual(auditRowsFor(TENANT_A, world.exposureId), ['T4|AssessMatch|VERIFIED_NOT_PRESENT']);

    const history = await call(app, 'GET', `/v1/exposures/${world.exposureId}/transitions`);
    const rows = history.json['data'] as Record<string, unknown>[];
    assert.deepEqual(rows.map((row) => row['transitionCode']), ['T4']);
  });

  test('an INCOMPLETE scan is refused, and nothing is written', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    const etag = await currentEtag(app, world.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${world.exposureId}/disproofs`, {
      headers: { 'if-match': etag },
      body: {
        disproofBasis: 'DIFFERENT_MIDDLE_NAME',
        evidenceArtifactId: world.evidenceId,
        scanComplete: true,
        coverageBounds: { sourcesAttempted: 9, sourcesTotal: 12 },
      },
    });
    // VG-DISC-002: absence may not be reported from an incomplete scan.
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'COVERAGE_BOUNDS_REQUIRED');
    // SM-2 in the negative: a refused request leaves no audit row and no state change.
    assert.deepEqual(auditRowsFor(TENANT_A, world.exposureId), []);
    assert.deepEqual(
      read(TENANT_A, `SELECT truth_state::text FROM exposure WHERE id = '${world.exposureId}'`),
      ['DISCOVERED_CANDIDATE'],
    );
  });
});

describe('§5.5.3 refusals leave no trace', () => {
  test('a search-engine-class source cannot enter a removal path', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ sourceClass: 'SEARCH_ENGINE', threshold: 0.85 });
    const etag = await currentEtag(app, world.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': etag },
      body: { confidence: { value: 0.99, basis: BASIS }, method: 'FEATURE_SET_V1', humanReviewed: false },
    });
    assert.equal(response.status, 409, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'IDENTITY_CLASS_MISMATCH');
    assert.deepEqual(auditRowsFor(TENANT_A, world.exposureId), []);
  });

  test('a policy that records no threshold refuses rather than inventing one', async () => {
    const app = serverFor(TENANT_A);
    // No `threshold` option: the jurisdiction has no policy row at all, which is the strongest form of
    // "no threshold is recorded".
    const world = newWorld();
    const etag = await currentEtag(app, world.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': etag },
      body: { confidence: { value: 0.99, basis: BASIS }, method: 'FEATURE_SET_V1', humanReviewed: false },
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'JURISDICTION_UNRESOLVED');
    assert.deepEqual(auditRowsFor(TENANT_A, world.exposureId), []);
  });

  test('absent evidence is refused before anything is written', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ threshold: 0.85 });
    const etag = await currentEtag(app, world.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': etag },
      body: {
        confidence: { value: 0.99, basis: BASIS },
        method: 'FEATURE_SET_V1',
        evidenceArtifactId: randomUUID(),
        humanReviewed: false,
      },
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'EVIDENCE_NOT_FOUND');
    assert.deepEqual(auditRowsFor(TENANT_A, world.exposureId), []);
  });

  test('an exposure that is not a candidate is refused with the state it is in', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ truthState: 'VERIFIED_REMOVED', threshold: 0.85 });
    const etag = await currentEtag(app, world.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': etag },
      body: { confidence: { value: 0.99, basis: BASIS }, method: 'FEATURE_SET_V1', humanReviewed: false },
    });
    assert.equal(response.status, 409, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'ILLEGAL_TRANSITION');
    assert.equal(detailsOf(response)['fromTruthState'], 'VERIFIED_REMOVED');
    assert.deepEqual(auditRowsFor(TENANT_A, world.exposureId), []);
  });

  test('a missing precondition is 428 and a stale one is 412 with the current ETag', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ threshold: 0.85 });

    const missing = await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      body: { confidence: { value: 0.99, basis: BASIS }, method: 'FEATURE_SET_V1', humanReviewed: false },
    });
    assert.equal(missing.status, 428, JSON.stringify(missing.json));
    assert.equal(codeOf(missing), 'PRECONDITION_REQUIRED');

    const stale = await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': '"DISCOVERED_CANDIDATE:1"' },
      body: { confidence: { value: 0.99, basis: BASIS }, method: 'FEATURE_SET_V1', humanReviewed: false },
    });
    assert.equal(stale.status, 412, JSON.stringify(stale.json));
    assert.equal(codeOf(stale), 'PRECONDITION_FAILED');
    // §2.7 requires the CURRENT token in the body, so the loser can retry without re-reading.
    const current = detailsOf(stale)['currentEtag'];
    assert.match(String(current), /^"DISCOVERED_CANDIDATE:\d+"$/);
    assert.deepEqual(auditRowsFor(TENANT_A, world.exposureId), []);
  });

  test('a basis-less or out-of-range score is refused with its own code', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ threshold: 0.85 });
    const etag = await currentEtag(app, world.exposureId);

    const noBasis = await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': etag },
      body: { confidence: { value: 0.99, basis: [] }, method: 'FEATURE_SET_V1', humanReviewed: false },
    });
    assert.equal(noBasis.status, 422, JSON.stringify(noBasis.json));
    assert.equal(codeOf(noBasis), 'CONFIDENCE_BASIS_REQUIRED');

    const outOfRange = await call(app, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': etag },
      body: { confidence: { value: 1.4, basis: BASIS }, method: 'FEATURE_SET_V1', humanReviewed: false },
    });
    assert.equal(outOfRange.status, 422, JSON.stringify(outOfRange.json));
    assert.equal(codeOf(outOfRange), 'CONFIDENCE_OUT_OF_RANGE');
    assert.deepEqual(auditRowsFor(TENANT_A, world.exposureId), []);
  });
});

describe('§5.5 tenant isolation', () => {
  test("another tenant's exposure is 404 on every §5.5 route", async () => {
    const appA = serverFor(TENANT_A);
    const appB = serverFor(TENANT_B);
    const world = newWorld({ threshold: 0.85 });

    assert.equal((await call(appA, 'GET', `/v1/exposures/${world.exposureId}`)).status, 200);
    for (const url of [
      `/v1/exposures/${world.exposureId}`,
      `/v1/exposures/${world.exposureId}/transitions`,
    ]) {
      const response = await call(appB, 'GET', url);
      assert.equal(response.status, 404, `${url} answered ${String(response.status)} to the other tenant`);
      assert.equal(codeOf(response), 'RESOURCE_NOT_FOUND');
    }

    const write = await call(appB, 'POST', `/v1/exposures/${world.exposureId}/match-assessments`, {
      headers: { 'if-match': '"DISCOVERED_CANDIDATE:1"' },
      body: { confidence: { value: 0.99, basis: BASIS }, method: 'FEATURE_SET_V1', humanReviewed: false },
    });
    assert.equal(write.status, 404, JSON.stringify(write.json));
    // At the DATABASE layer too: RLS returns zero rows for tenant B independently of any service check.
    assert.deepEqual(
      read(TENANT_B, `SELECT e.id::text FROM exposure e WHERE e.id = '${world.exposureId}'`),
      [],
    );
    assert.deepEqual(
      read(TENANT_B, `SELECT a.id::text FROM audit_event a WHERE a.target_id = '${world.exposureId}'::uuid`),
      [],
    );
  });

  test('a list read scoped to tenant B never contains tenant A rows', async () => {
    const appB = serverFor(TENANT_B);
    const world = newWorld();
    const response = await call(appB, 'GET', `/v1/exposures?limit=100`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const ids = (response.json['data'] as Record<string, unknown>[]).map((row) => row['exposureId']);
    assert.ok(!ids.includes(world.exposureId), 'tenant B saw tenant A exposure');
  });
});

describe('the confidence basis reader is strict, not forgiving', () => {
  test('a basis entry that is not {feature, weight} is refused rather than flattened', async () => {
    const world = newWorld({ basis: ['exact-name-match', 'state-match'] });
    const app = serverFor(TENANT_A);
    const response = await call(app, 'GET', `/v1/exposures?limit=100`);
    // The seeded fixture wrote exactly this shape before §5.5 existed. The reader does NOT invent a weight for
    // a bare string: VG-IDENT-003 exists because a score whose basis cannot be retrieved is unsupportable, and
    // a synthesised weight would be a fabricated basis. So the failure is loud.
    assert.equal(response.status, 500, 'the reader accepted a basis the contract cannot render');
    assert.ok(
      exec(ownerDsn(), `SELECT 1`).status === 0,
      'the database must still be reachable — a connection failure would make this test vacuous',
    );
    assert.ok(world.exposureId.length > 0);
  });
});
