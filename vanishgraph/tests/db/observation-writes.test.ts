/**
 * The §5.10.1 and §5.11.1 writes against real PostgreSQL (SPEC-003 §5.10.1, §5.11.1).
 *
 * WHAT THIS SUITE PROVES, and why each item needs a database:
 *
 *   * **T14 only when EVERY guard holds**, and the guards are evaluated against facts the database holds: the
 *     acting identity and the action's instant are read from the case's `T8` audit row, and the required
 *     verification method from the case's recipe. A stub cannot produce those facts, and a handler that
 *     fabricated them would pass a stubbed test.
 *   * **A failed verification is a 200 that RECORDS the observation and moves nothing.** VG-VERIFY-004: it must
 *     not regress into a success state and must not invent one. The test re-reads the case's state, the
 *     observation row and the audit row.
 *   * **A refusal writes NOTHING** — no observation row, no transition, no state change — asserted for the
 *     window, the independence and the method refusals.
 *   * **T17/T20 move the EXPOSURE** and link the row to the audit row that recorded the prior removal; a first
 *     sighting is refused `REAPPEARANCE_WITHOUT_PRIOR_REMOVAL` with the observed state named.
 *   * **Cross-tenant reads and writes are 404**, and the database layer returns zero rows independently.
 *
 * FIXTURE DISCIPLINE. Two tenants of this suite's own, per run — `postgres-runner.test.ts`, `rls.test.ts` and
 * `route-catalogue.test.ts` assert that tenant A holds exactly one seeded subject, and `ASSUMPTIONS.md` §3.27
 * records what happened the first time a suite ignored that. The case's prior transitions are written DIRECTLY
 * as audit rows: they are the facts this route reads, and driving three earlier routes to produce them would
 * make this suite's failures ambiguous between the route under test and the ones that set it up.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresObservationQueries } from '../../src/adapters/persistence/observations.ts';
import { PostgresExposureQueries } from '../../src/adapters/persistence/exposures.ts';
import { PostgresTransitionQueries } from '../../src/adapters/persistence/transitions.ts';
import { PostgresCaseQueries } from '../../src/adapters/persistence/cases.ts';
import { PostgresControllerResponseQueries } from '../../src/adapters/persistence/controller-responses.ts';
import { PostgresAuditQueries } from '../../src/adapters/persistence/audit-queries.ts';
import { PostgresDeadlineQueries } from '../../src/adapters/persistence/deadlines.ts';
import { PostgresAppealQueries } from '../../src/adapters/persistence/appeals.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresSourceQueries } from '../../src/adapters/persistence/sources.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, asTenant, exec, ownerDsn } from './harness.ts';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RUN = randomUUID().slice(0, 8);
// The writes need g.observations.write; the ETag helpers read §5.7.3/§5.5.2, which need the read scopes on the
// same token because they are the same caller doing what a real client does — read the resource, then write it.
const SCOPES = ['vg.observations.read', 'vg.observations.write', 'vg.cases.read', 'vg.exposures.read'];

/** The identity that performed the external action, recorded on the case's T8 audit row. */
const ACTING_IDENTITY = `acting-svc-${RUN}`;
/** The observer: a different identity, on a different path. */
const OBSERVER_IDENTITY = `observer-svc-${RUN}`;
const REQUIRED_WINDOW_SECONDS = 604800;

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'observation-writes-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'observation-writes-b-${RUN}', 'ACTIVE');`,
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
    recipeVerificationKeys: { publicKeysByRef: new Map() },
    appealQueries: new PostgresAppealQueries(),
    deadlineQueries: new PostgresDeadlineQueries(),
    auditQueries: new PostgresAuditQueries(),
    observationQueries: new PostgresObservationQueries(),
    exposureQueries: new PostgresExposureQueries(),
    transitionQueries: new PostgresTransitionQueries(),
    caseQueries: new PostgresCaseQueries({ recipeVerificationKeys: { publicKeysByRef: new Map() } }),
    controllerResponseQueries: new PostgresControllerResponseQueries(),
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
  });
}

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

let keyCounter = 0;

/** A per-RUN unique idempotency key (ASSUMPTIONS §3.22: a counter alone makes a suite pass exactly once). */
function nextKey(): string {
  keyCounter += 1;
  return `observation-write-${RUN}-${String(keyCounter).padStart(4, '0')}`;
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

function read(tenantId: string, sql: string): string[] {
  return asTenant(ownerDsn(), tenantId, sql.trimEnd().endsWith(';') ? sql : `${sql};`);
}

interface AckWorld {
  readonly caseId: string;
  readonly exposureId: string;
  readonly evidenceArtifactId: string;
  /** The instant the external action was recorded, epoch milliseconds. */
  readonly actionAtMs: number;
}

/**
 * A case at `ACKNOWLEDGED` with everything §5.10.1's guards read: an effect recorded by `ACTING_IDENTITY` more
 * than a window ago, a recipe declaring the verification method, and an evidence artifact.
 */
function newAckWorld(options: { readonly method?: string; readonly actionAgeSeconds?: number } = {}): AckWorld {
  const tenantId = TENANT_A;
  const subjectId = randomUUID();
  const authorityGrantId = randomUUID();
  const sourceId = randomUUID();
  const recipeId = randomUUID();
  const recordId = randomUUID();
  const exposureId = randomUUID();
  const decisionId = randomUUID();
  const caseId = randomUUID();
  const evidenceArtifactId = randomUUID();
  const jurisdiction = 'US-CA';
  const policyVersion = 2000 + Math.floor(Math.random() * 100000);
  const method = options.method ?? 'INDEPENDENT_FETCH_DIFFERENT_EGRESS';
  const actionAgeSeconds = options.actionAgeSeconds ?? REQUIRED_WINDOW_SECONDS + 86400;
  const actionAtMs = Date.now() - actionAgeSeconds * 1000;

  const result = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${tenantId}', true);`,
      `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
         VALUES ('${subjectId}', '${tenantId}', 'obs-subject-${RUN}', '${jurisdiction}', false, 'ACTIVE');`,
      `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument)
         VALUES ('${authorityGrantId}', '${tenantId}', '${subjectId}', 'SELF', ARRAY['discovery','self_service_write'], now() - interval '1 day', now() + interval '30 days', false);`,
      `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class, permission_checked_at)
         VALUES ('${sourceId}', '${tenantId}', 'obs-source-${RUN}-${sourceId.slice(0, 8)}', 'REGISTRY', '${jurisdiction}', 'WRITE_PERMITTED', now());`,
      `INSERT INTO removal_recipe (id, tenant_id, source_id, version, signature, channel, verification_method, freshness_at, enabled)
         VALUES ('${recipeId}', '${tenantId}', '${sourceId}', 1, 'sig:test', 'OFFICIAL_SELF_SERVICE', '${method}', now() + interval '7 days', true);`,
      `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
         VALUES ('${recordId}', '${tenantId}', '${sourceId}', 'https://example.invalid/obs-${RUN}', now() - interval '3 days', repeat('f', 64), false);`,
      `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
         VALUES ('${exposureId}', '${tenantId}', '${subjectId}', '${recordId}', 0.91, '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, 'ACKNOWLEDGED');`,
      `INSERT INTO jurisdiction_policy (id, tenant_id, jurisdiction, version, effective_from, rules, provenance)
         VALUES ('${randomUUID()}', '${tenantId}', '${jurisdiction}', ${String(policyVersion)}, now() - interval '1 day', ARRAY['CCPA_DELETE'], 'COUNSEL_REVIEWED');`,
      `INSERT INTO policy_decision (id, tenant_id, case_id, jurisdiction, legal_basis, channel, policy_version, reasons, decided_at)
         VALUES ('${decisionId}', '${tenantId}', '${caseId}', '${jurisdiction}', 'CCPA_DELETE', 'OFFICIAL_SELF_SERVICE', ${String(policyVersion)}, '["consumer-request-right"]'::jsonb, now() - interval '2 days');`,
      `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, policy_decision_id, recipe_id, truth_state)
         VALUES ('${caseId}', '${tenantId}', '${subjectId}', '${exposureId}', '${sourceId}', '${authorityGrantId}', '${decisionId}', '${recipeId}', 'ACKNOWLEDGED');`,
      `INSERT INTO evidence_artifact (id, tenant_id, case_id, kind, digest, storage_ref, egress_class, redaction_state, captured_at)
         VALUES ('${evidenceArtifactId}', '${tenantId}', '${caseId}', 'RE_OBSERVATION', repeat('a', 64), 's3://evidence/${RUN}/${evidenceArtifactId}', 'OPAQUE_ID', 'NONE', now());`,
      // THE FACTS THE GUARDS READ: the external effect (T8) — its actor is the acting identity and its instant is
      // what the verification window is measured from.
      `INSERT INTO audit_event (tenant_id, actor, action, target_kind, target_id, correlation_id, payload, at, transition_code, from_truth_state, to_truth_state, case_id)
         VALUES ('${tenantId}', '${ACTING_IDENTITY}', 'ExecuteAction', 'RequestCase', '${caseId}', '${randomUUID()}',
                 '{}'::jsonb, to_timestamp(${String(Math.trunc(actionAtMs))}::bigint / 1000.0),
                 'T8', 'REQUEST_READY', 'REQUEST_SUBMITTED', '${caseId}');`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(result.status, 0, `fixture failed: ${result.output}`);
  return { caseId, exposureId, evidenceArtifactId, actionAtMs };
}

interface RemovedWorld {
  readonly exposureId: string;
  readonly caseId: string;
  readonly priorEventId: string;
  readonly evidenceArtifactId: string;
}

/** An exposure in `state` whose case carries the audit row a reappearance must link to. */
function newRemovedWorld(state: 'VERIFIED_REMOVED' | 'SEARCH_DELISTED' | 'MATCH_CONFIRMED' = 'VERIFIED_REMOVED'): RemovedWorld {
  const tenantId = TENANT_A;
  const subjectId = randomUUID();
  const sourceId = randomUUID();
  const recordId = randomUUID();
  const exposureId = randomUUID();
  const caseId = randomUUID();
  const evidenceArtifactId = randomUUID();
  const authorityGrantId = randomUUID();
  const priorEventId =
    // `asTenant` wraps this in BEGIN / set_config / … / COMMIT and returns the LINES a statement prints, which
    // is why the fixture ends in `RETURNING id::text` and does not parse psql's aligned output itself. MEASURED:
    // a first version used `exec` (raw output) and a regex over it and never found the id, so every reappearance
    // test failed in its FIXTURE rather than in the route.
    asTenant(
      ownerDsn(),
      tenantId,
      [
        `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
           VALUES ('${subjectId}', '${tenantId}', 'reap-subject-${RUN}', 'US-CA', false, 'ACTIVE');`,
        `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument)
           VALUES ('${authorityGrantId}', '${tenantId}', '${subjectId}', 'SELF', ARRAY['discovery'], now() - interval '1 day', now() + interval '30 days', false);`,
        `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class)
           VALUES ('${sourceId}', '${tenantId}', 'reap-source-${RUN}-${sourceId.slice(0, 8)}', 'REGISTRY', 'US-CA', 'WRITE_PERMITTED');`,
        `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
           VALUES ('${recordId}', '${tenantId}', '${sourceId}', 'https://example.invalid/reap-${RUN}', now() - interval '10 days', repeat('b', 64), false);`,
        `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
           VALUES ('${exposureId}', '${tenantId}', '${subjectId}', '${recordId}', 0.9, '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, '${state}');`,
        `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, truth_state)
           VALUES ('${caseId}', '${tenantId}', '${subjectId}', '${exposureId}', '${sourceId}', '${authorityGrantId}', '${state}');`,
        `INSERT INTO evidence_artifact (id, tenant_id, case_id, kind, digest, storage_ref, egress_class, redaction_state, captured_at)
           VALUES ('${evidenceArtifactId}', '${tenantId}', '${caseId}', 'REAPPEARANCE', repeat('c', 64), 's3://evidence/${RUN}/${evidenceArtifactId}', 'OPAQUE_ID', 'NONE', now());`,
        `INSERT INTO audit_event (tenant_id, actor, action, target_kind, target_id, correlation_id, payload, at, transition_code, from_truth_state, to_truth_state, case_id)
           VALUES ('${tenantId}', 'domain-command', 'RecordVerification', 'RequestCase', '${caseId}', '${randomUUID()}',
                   '{}'::jsonb, now() - interval '2 days',
                   '${state === 'VERIFIED_REMOVED' ? 'T14' : 'T21'}', 'ACKNOWLEDGED', '${state}', '${caseId}')
         RETURNING id::text;`,
      ].join('\n'),
    )[0] ?? '';
  assert.notEqual(priorEventId, '', 'the fixture did not return the prior event id');
  return { exposureId, caseId, priorEventId, evidenceArtifactId };
}

async function caseEtag(app: VgFastify, caseId: string): Promise<string> {
  const detail = await call(app, 'GET', `/v1/cases/${caseId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  return String(detail.headers['etag']);
}

async function exposureEtag(app: VgFastify, exposureId: string): Promise<string> {
  const detail = await call(app, 'GET', `/v1/exposures/${exposureId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  return String(detail.headers['etag']);
}

function observation(request: {
  readonly method?: string;
  readonly finding?: string;
  readonly observationPathId?: string;
  readonly actorIdentity?: string;
  readonly observedAt?: string;
  readonly requiredSeconds?: number;
  readonly evidenceArtifactId?: string | null;
} = {}): Record<string, unknown> {
  return {
    observationMethod: request.method ?? 'INDEPENDENT_FETCH_DIFFERENT_EGRESS',
    actorIdentity: request.actorIdentity ?? OBSERVER_IDENTITY,
    observationPathId: request.observationPathId ?? 'path-observer-02',
    actingPathId: 'path-acting-01',
    observedAt: request.observedAt ?? new Date().toISOString(),
    finding: request.finding ?? 'RECORD_ABSENT',
    evidenceArtifactId: request.evidenceArtifactId ?? undefined,
    windowSatisfied: {
      requiredSeconds: request.requiredSeconds ?? REQUIRED_WINDOW_SECONDS,
      elapsedSeconds: REQUIRED_WINDOW_SECONDS + 86400,
      met: true,
    },
  };
}

describe('§5.10.1 verification writes', () => {
  test('T14 when every guard holds: the case moves, the observation is recorded, the spine says T14', async () => {
    const app = serverFor(TENANT_A);
    const world = newAckWorld();
    const etag = await caseEtag(app, world.caseId);

    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/verification-observations`, {
      headers: { 'if-match': etag },
      body: observation({ evidenceArtifactId: world.evidenceArtifactId }),
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['truthState'], 'VERIFIED_REMOVED');
    assert.equal(response.json['transitionCode'], 'T14');
    assert.equal(response.json['verificationFailed'], false);
    assert.match(String(response.json['verificationObservationId']), /^[0-9a-f-]{36}$/);
    const lag = response.json['verificationLagSeconds'];
    assert.ok(typeof lag === 'number' && lag >= REQUIRED_WINDOW_SECONDS, `lag ${String(lag)} is below the window`);

    // THE DATABASE, NOT THE RESPONSE.
    assert.deepEqual(read(TENANT_A, `SELECT truth_state::text FROM request_case WHERE id = '${world.caseId}'`), [
      'VERIFIED_REMOVED',
    ]);
    assert.deepEqual(
      read(
        TENANT_A,
        `SELECT finding || '|' || actor_identity || '|' || acting_identity || '|' || coalesce(acting_path_id,'-') || '|' || coalesce(observation_path_id,'-')
           FROM verification_observation WHERE case_id = '${world.caseId}'::uuid`,
      ),
      [`ABSENT|${OBSERVER_IDENTITY}|${ACTING_IDENTITY}|path-acting-01|path-observer-02`],
    );
    assert.deepEqual(
      read(
        TENANT_A,
        `SELECT transition_code FROM audit_event WHERE case_id = '${world.caseId}'::uuid AND transition_code IS NOT NULL ORDER BY at DESC LIMIT 1`,
      ),
      ['T14'],
    );
  });

  test('a record still present is a 200 that records the observation and moves NOTHING', async () => {
    const app = serverFor(TENANT_A);
    const world = newAckWorld();
    const etag = await caseEtag(app, world.caseId);

    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/verification-observations`, {
      headers: { 'if-match': etag },
      body: observation({ finding: 'RECORD_PRESENT', evidenceArtifactId: world.evidenceArtifactId }),
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['verificationFailed'], true);
    assert.equal(response.json['transitionCode'], null);
    assert.equal(response.json['truthState'], 'ACKNOWLEDGED');
    assert.equal(response.json['reappearanceSuspected'], false);
    // VG-VERIFY-004: no regression, no invented state — and the observation IS recorded, because it happened.
    assert.deepEqual(read(TENANT_A, `SELECT truth_state::text FROM request_case WHERE id = '${world.caseId}'`), [
      'ACKNOWLEDGED',
    ]);
    assert.deepEqual(
      read(TENANT_A, `SELECT finding FROM verification_observation WHERE case_id = '${world.caseId}'::uuid`),
      ['PRESENT'],
    );
    assert.deepEqual(
      read(
        TENANT_A,
        // FOUND BY TARGET, NOT BY `case_id`. A refusal is not a transition, so the spine's all-or-nothing CHECK
        // requires `case_id IS NULL` on that row and the case it is about is named by `target_kind`/`target_id` —
        // the same convention the seed uses. A query that looked only at `case_id` would report the fixture's own
        // T8 row as the newest event and miss the refusal entirely (MEASURED: it did).
        `SELECT coalesce(transition_code,'null') || '|' || action FROM audit_event
          WHERE (target_kind = 'RequestCase' AND target_id = '${world.caseId}'::uuid)
          ORDER BY at DESC, id DESC LIMIT 1`,
      ),
      ['null|RecordVerification'],
    );
  });

  test('absence before the window elapsed is refused, and NOTHING is written', async () => {
    const app = serverFor(TENANT_A);
    // The action happened one hour ago; the window is seven days.
    const world = newAckWorld({ actionAgeSeconds: 3600 });
    const etag = await caseEtag(app, world.caseId);

    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/verification-observations`, {
      headers: { 'if-match': etag },
      body: observation({ evidenceArtifactId: world.evidenceArtifactId }),
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'OBSERVATION_WINDOW_NOT_MET');
    assert.equal(detailsOf(response)['requiredSeconds'], REQUIRED_WINDOW_SECONDS);
    // VG-VERIFY-002: a premature absence claim leaves no observation behind.
    assert.deepEqual(
      read(TENANT_A, `SELECT id::text FROM verification_observation WHERE case_id = '${world.caseId}'::uuid`),
      [],
    );
    assert.deepEqual(read(TENANT_A, `SELECT truth_state::text FROM request_case WHERE id = '${world.caseId}'`), [
      'ACKNOWLEDGED',
    ]);
  });

  test('the acting path cannot verify itself — same path, and same identity, are both refused', async () => {
    const app = serverFor(TENANT_A);
    const world = newAckWorld();
    const etag = await caseEtag(app, world.caseId);

    const samePath = await call(app, 'POST', `/v1/cases/${world.caseId}/verification-observations`, {
      headers: { 'if-match': etag },
      body: observation({ observationPathId: 'path-acting-01', evidenceArtifactId: world.evidenceArtifactId }),
    });
    assert.equal(samePath.status, 422, JSON.stringify(samePath.json));
    assert.equal(codeOf(samePath), 'OBSERVATION_PATH_NOT_INDEPENDENT');

    const sameIdentity = await call(app, 'POST', `/v1/cases/${world.caseId}/verification-observations`, {
      headers: { 'if-match': etag },
      body: observation({ actorIdentity: ACTING_IDENTITY, evidenceArtifactId: world.evidenceArtifactId }),
    });
    assert.equal(sameIdentity.status, 422, JSON.stringify(sameIdentity.json));
    assert.equal(codeOf(sameIdentity), 'OBSERVATION_PATH_NOT_INDEPENDENT');

    assert.deepEqual(
      read(TENANT_A, `SELECT id::text FROM verification_observation WHERE case_id = '${world.caseId}'::uuid`),
      [],
    );
  });

  test('a method the recipe does not declare is refused with both tokens named', async () => {
    const app = serverFor(TENANT_A);
    const world = newAckWorld({ method: 'SECOND_CONTROLLER_CHANNEL' });
    const etag = await caseEtag(app, world.caseId);

    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/verification-observations`, {
      headers: { 'if-match': etag },
      body: observation({ method: 'PROVIDER_API', evidenceArtifactId: world.evidenceArtifactId }),
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'OBSERVATION_METHOD_MISMATCH');
    assert.equal(detailsOf(response)['required'], 'SECOND_CONTROLLER_CHANNEL');
    assert.equal(detailsOf(response)['supplied'], 'PROVIDER_API');
  });

  test('the preconditions and the closed finding vocabulary are enforced', async () => {
    const app = serverFor(TENANT_A);
    const world = newAckWorld();

    const missing = await call(app, 'POST', `/v1/cases/${world.caseId}/verification-observations`, {
      body: observation(),
    });
    assert.equal(missing.status, 428, JSON.stringify(missing.json));
    assert.equal(codeOf(missing), 'PRECONDITION_REQUIRED');

    const stale = await call(app, 'POST', `/v1/cases/${world.caseId}/verification-observations`, {
      headers: { 'if-match': '"ACKNOWLEDGED:1"' },
      body: observation(),
    });
    assert.equal(stale.status, 412, JSON.stringify(stale.json));
    assert.equal(codeOf(stale), 'PRECONDITION_FAILED');

    // `PRESENT` is the COLUMN's token, not the wire's: accepting it would put a value on the wire that this
    // same API refuses on the way back in.
    const wrongVocabulary = await call(app, 'POST', `/v1/cases/${world.caseId}/verification-observations`, {
      headers: { 'if-match': await caseEtag(app, world.caseId) },
      body: observation({ finding: 'PRESENT' }),
    });
    assert.equal(wrongVocabulary.status, 400, JSON.stringify(wrongVocabulary.json));
    assert.equal(codeOf(wrongVocabulary), 'SCHEMA_VALIDATION_FAILED');
  });

  test("another tenant's case is 404 and its observations are invisible at the database layer", async () => {
    const appA = serverFor(TENANT_A);
    const appB = serverFor(TENANT_B);
    const world = newAckWorld();
    const etag = await caseEtag(appA, world.caseId);

    const write = await call(appB, 'POST', `/v1/cases/${world.caseId}/verification-observations`, {
      headers: { 'if-match': etag },
      body: observation(),
    });
    assert.equal(write.status, 404, JSON.stringify(write.json));
    assert.deepEqual(read(TENANT_B, `SELECT id::text FROM verification_observation WHERE case_id = '${world.caseId}'::uuid`), []);
  });
});

describe('§5.11.1 reappearance writes', () => {
  test('T17 moves the exposure, links the prior removal event, and states the re-entry rules', async () => {
    const app = serverFor(TENANT_A);
    const world = newRemovedWorld('VERIFIED_REMOVED');
    const etag = await exposureEtag(app, world.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${world.exposureId}/reappearances`, {
      headers: { 'if-match': etag },
      body: {
        priorRemovedEventId: world.priorEventId,
        observedAt: new Date().toISOString(),
        observationMethod: 'SCHEDULED_RE_OBSERVATION',
        contentHash: 'd'.repeat(64),
        evidenceArtifactId: world.evidenceArtifactId,
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    assert.equal(response.json['truthState'], 'REAPPEARED');
    assert.equal(response.json['priorTruthState'], 'VERIFIED_REMOVED');
    assert.equal(response.json['transitionCode'], 'T17');
    assert.equal(response.json['priorRemovedEventId'], world.priorEventId);
    assert.deepEqual(response.json['reentry'], {
      requiresFreshAuthority: true,
      requiresFreshPolicyDecision: true,
      requiresFreshRecipe: true,
      preservesPriorEvidence: true,
    });

    assert.deepEqual(read(TENANT_A, `SELECT truth_state::text FROM exposure WHERE id = '${world.exposureId}'`), [
      'REAPPEARED',
    ]);
    assert.deepEqual(
      read(
        TENANT_A,
        `SELECT r.prior_removed_event_id::text || '|' || r.observation_method || '|' || r.content_hash
           FROM reappearance r WHERE r.exposure_id = '${world.exposureId}'::uuid`,
      ),
      [`${world.priorEventId}|SCHEDULED_RE_OBSERVATION|${'d'.repeat(64)}`],
    );
    // The spine records T17 against the EXPOSURE, which is what was observed again.
    assert.deepEqual(
      read(
        TENANT_A,
        `SELECT a.transition_code || '|' || a.target_kind FROM audit_event a
          WHERE a.target_id = '${world.exposureId}'::uuid AND a.transition_code IS NOT NULL
          ORDER BY a.at DESC LIMIT 1`,
      ),
      ['T17|Exposure'],
    );
  });

  test('T20 from SEARCH_DELISTED, linked to the delisting event rather than a removal', async () => {
    const app = serverFor(TENANT_A);
    const world = newRemovedWorld('SEARCH_DELISTED');
    const etag = await exposureEtag(app, world.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${world.exposureId}/reappearances`, {
      headers: { 'if-match': etag },
      body: {
        priorRemovedEventId: `TR-${world.priorEventId}`,
        observedAt: new Date().toISOString(),
        observationMethod: 'SCHEDULED_RE_OBSERVATION',
        contentHash: 'e'.repeat(64),
        evidenceArtifactId: world.evidenceArtifactId,
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    assert.equal(response.json['transitionCode'], 'T20');
    assert.equal(response.json['priorTruthState'], 'SEARCH_DELISTED');
    // The wire form `TR-<id>` is accepted and normalised, so the stored bigint and the response agree.
    assert.equal(response.json['priorRemovedEventId'], world.priorEventId);
  });

  test('a first-ever sighting is refused with the state the exposure is actually in', async () => {
    const app = serverFor(TENANT_A);
    // An exposure that never claimed a removal: VG-REAPPEAR-001 forbids labelling its first sighting a
    // reappearance, and the refusal names the state so the caller learns the truth rather than the label.
    const fresh = newRemovedWorld('MATCH_CONFIRMED');
    const etag = await exposureEtag(app, fresh.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${fresh.exposureId}/reappearances`, {
      headers: { 'if-match': etag },
      body: {
        priorRemovedEventId: fresh.priorEventId,
        observedAt: new Date().toISOString(),
        observationMethod: 'SCHEDULED_RE_OBSERVATION',
        contentHash: 'f'.repeat(64),
        evidenceArtifactId: fresh.evidenceArtifactId,
      },
    });
    assert.equal(response.status, 409, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'REAPPEARANCE_WITHOUT_PRIOR_REMOVAL');
    assert.equal(detailsOf(response)['fromTruthState'], 'MATCH_CONFIRMED');
    // Nothing was written: no reappearance row and no state change.
    assert.deepEqual(
      read(TENANT_A, `SELECT id::text FROM reappearance WHERE exposure_id = '${fresh.exposureId}'::uuid`),
      [],
    );
    assert.deepEqual(read(TENANT_A, `SELECT truth_state::text FROM exposure WHERE id = '${fresh.exposureId}'`), [
      'MATCH_CONFIRMED',
    ]);
  });

  test('a prior event that recorded something else does not resolve', async () => {
    const app = serverFor(TENANT_A);
    const removed = newRemovedWorld('VERIFIED_REMOVED');
    const other = newRemovedWorld('SEARCH_DELISTED');
    const etag = await exposureEtag(app, removed.exposureId);

    const response = await call(app, 'POST', `/v1/exposures/${removed.exposureId}/reappearances`, {
      headers: { 'if-match': etag },
      body: {
        // A real transition row, but not THIS exposure's removal — linking to it would make the history say the
        // wrong thing.
        priorRemovedEventId: other.priorEventId,
        observedAt: new Date().toISOString(),
        observationMethod: 'SCHEDULED_RE_OBSERVATION',
        contentHash: 'a'.repeat(64),
        evidenceArtifactId: removed.evidenceArtifactId,
      },
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'PRIOR_REMOVED_EVENT_NOT_FOUND');
    assert.deepEqual(
      read(TENANT_A, `SELECT id::text FROM reappearance WHERE exposure_id = '${removed.exposureId}'::uuid`),
      [],
    );
  });
});
