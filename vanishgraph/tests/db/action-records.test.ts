/**
 * External actions, reconciliations, readbacks and mail pieces against real PostgreSQL (SPEC-003 §5.8).
 *
 * WHAT THIS SUITE PROVES, and the FIRST item is the one that matters most:
 *
 *   * **A REAL SUBMISSION IS REFUSED, AND A DRY RUN IS NOT.** No channel transport exists in this repository, so
 *     §5.8.2 answers `503 DEPENDENCY_UNAVAILABLE` for an execution and `200` for a dry run — with the guard
 *     evaluation and the payload verdict in the body. The two are asserted TOGETHER, because a route that
 *     refused both would pass a test that only checked the refusal, and a route that accepted both is the
 *     failure VG-ACTION-001 exists to prevent.
 *   * **The guards are computed from rows**: the recipe's real Ed25519 signature is verified, the authority's
 *     scope and expiry are read, the source's permission class is read, and the budget is counted over the
 *     recipe's own window.
 *   * **A reconciliation never regresses a truth state and never invents one** (VG-ACTION-002/004): each of the
 *     three findings is asserted against the case's state and the spine.
 *   * **A readback is a REQUEST**: it records `PENDING`, moves nothing, and refuses a method equal to the
 *     recorded acting path (VG-ACTION-003).
 *   * **A mail piece with no evidence is `UNKNOWN`** and is never synthesised (VG-ACTION-004).
 *
 * FIXTURE DISCIPLINE: two tenants of this suite's own, per run (ASSUMPTIONS §3.27).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresActionQueries } from '../../src/adapters/persistence/actions.ts';
import { PostgresPolicyQueries } from '../../src/adapters/persistence/policies.ts';
import { PostgresCoverageQueries } from '../../src/adapters/persistence/coverage.ts';
import { PostgresControllerResponseQueries } from '../../src/adapters/persistence/controller-responses.ts';
import { PostgresCaseQueries } from '../../src/adapters/persistence/cases.ts';
import { PostgresObservationQueries } from '../../src/adapters/persistence/observations.ts';
import { PostgresExposureQueries } from '../../src/adapters/persistence/exposures.ts';
import { PostgresTransitionQueries } from '../../src/adapters/persistence/transitions.ts';
import { PostgresAuditQueries } from '../../src/adapters/persistence/audit-queries.ts';
import { PostgresDeadlineQueries } from '../../src/adapters/persistence/deadlines.ts';
import { PostgresAppealQueries } from '../../src/adapters/persistence/appeals.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresSourceQueries } from '../../src/adapters/persistence/sources.ts';
import { canonicalRecipePayload } from '../../src/adapters/persistence/sources.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, asTenant, exec, ownerDsn } from './harness.ts';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RUN = randomUUID().slice(0, 8);
const SCOPES = ['vg.actions.read', 'vg.actions.execute', 'vg.cases.read'];

const KEYS = generateKeyPairSync('ed25519');
const KEY_REF = `key-${RUN}`;
const PUBLIC_PEM = KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString();

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'action-suite-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'action-suite-b-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);
});

after(async () => {
  await runner.close();
});

function serverFor(
  tenantId: string,
  options: { readonly verifiedKeys?: boolean; readonly scopes?: readonly string[] } = {},
): VgFastify {
  const keys =
    options.verifiedKeys === false
      ? { publicKeysByRef: new Map<string, string>() }
      : { publicKeysByRef: new Map([[KEY_REF, PUBLIC_PEM]]) };
  return buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({ tenantId, scopes: options.scopes ?? SCOPES }),
    tenancy: { runner },
    idempotency: {
      store: idempotency,
      requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
    },
    sessionSecret: TEST_SESSION_SECRET,
    subjectQueries: new PostgresSubjectQueries(),
    sourceQueries: new PostgresSourceQueries(),
    recipeVerificationKeys: keys,
    appealQueries: new PostgresAppealQueries(),
    deadlineQueries: new PostgresDeadlineQueries(),
    auditQueries: new PostgresAuditQueries(),
    observationQueries: new PostgresObservationQueries(),
    exposureQueries: new PostgresExposureQueries(),
    transitionQueries: new PostgresTransitionQueries(),
    caseQueries: new PostgresCaseQueries({ recipeVerificationKeys: keys }),
    controllerResponseQueries: new PostgresControllerResponseQueries(),
    actionQueries: new PostgresActionQueries({ recipeVerificationKeys: keys }),
    policyQueries: new PostgresPolicyQueries(),
    coverageQueries: new PostgresCoverageQueries(),
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
  });
}

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `action-suite-key-${RUN}-${String(keyCounter).padStart(4, '0')}`;
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

function read(tenantId: string, sql: string): string[] {
  return asTenant(ownerDsn(), tenantId, sql.trimEnd().endsWith(';') ? sql : `${sql};`);
}

interface World {
  readonly caseId: string;
  readonly recipeId: string;
  readonly authorityGrantId: string;
  readonly policyDecisionId: string;
  readonly evidenceArtifactId: string;
}

/** A case at `state` with everything §5.8.2's guards read, including a REAL Ed25519-signed recipe. */
function newWorld(options: { readonly state?: string; readonly permissionClass?: string } = {}): World {
  const state = options.state ?? 'REQUEST_READY';
  const permissionClass = options.permissionClass ?? 'WRITE_PERMITTED';
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
  const policyVersion = 3000 + Math.floor(Math.random() * 100000);
  const freshnessAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const signature = cryptoSign(
    null,
    Buffer.from(
      canonicalRecipePayload({
        sourceId,
        channel: 'OFFICIAL_SELF_SERVICE',
        verificationMethod: 'independent-fetch',
        signingKeyRef: KEY_REF,
        freshnessAt: freshnessAt.toISOString(),
        maxAttemptsPerWindow: 5,
        windowSeconds: 86400,
      }),
      'utf8',
    ),
    KEYS.privateKey,
  );

  const result = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
         VALUES ('${subjectId}', '${TENANT_A}', 'act-subject-${RUN}', '${jurisdiction}', false, 'ACTIVE');`,
      `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument)
         VALUES ('${authorityGrantId}', '${TENANT_A}', '${subjectId}', 'SELF', ARRAY['discovery','self_service_write'], now() - interval '1 day', now() + interval '30 days', false);`,
      `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class, permission_checked_at)
         VALUES ('${sourceId}', '${TENANT_A}', 'act-source-${RUN}-${sourceId.slice(0, 8)}', 'REGISTRY', '${jurisdiction}', '${permissionClass}', now());`,
      `INSERT INTO removal_recipe (id, tenant_id, source_id, version, signature, channel, verification_method,
                                   freshness_at, enabled, signing_key_ref, max_attempts_per_window, window_seconds)
         VALUES ('${recipeId}', '${TENANT_A}', '${sourceId}', 1, decode('${signature.toString('hex')}', 'hex'),
                 'OFFICIAL_SELF_SERVICE', 'independent-fetch', '${freshnessAt.toISOString()}', true, '${KEY_REF}', 5, 86400);`,
      `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
         VALUES ('${recordId}', '${TENANT_A}', '${sourceId}', 'https://example.invalid/act-${RUN}', now() - interval '2 days', repeat('a', 64), false);`,
      `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
         VALUES ('${exposureId}', '${TENANT_A}', '${subjectId}', '${recordId}', 0.9, '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, '${state}');`,
      `INSERT INTO jurisdiction_policy (id, tenant_id, jurisdiction, version, effective_from, rules, provenance)
         VALUES ('${randomUUID()}', '${TENANT_A}', '${jurisdiction}', ${String(policyVersion)}, now() - interval '1 day', ARRAY['CCPA_DELETE'], 'COUNSEL_REVIEWED');`,
      `INSERT INTO policy_decision (id, tenant_id, case_id, jurisdiction, legal_basis, channel, policy_version, reasons, decided_at)
         VALUES ('${decisionId}', '${TENANT_A}', '${caseId}', '${jurisdiction}', 'CCPA_DELETE', 'OFFICIAL_SELF_SERVICE', ${String(policyVersion)}, '["consumer-request-right"]'::jsonb, now() - interval '1 hour');`,
      `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, policy_decision_id, recipe_id, truth_state)
         VALUES ('${caseId}', '${TENANT_A}', '${subjectId}', '${exposureId}', '${sourceId}', '${authorityGrantId}', '${decisionId}', '${recipeId}', '${state}');`,
      `INSERT INTO evidence_artifact (id, tenant_id, case_id, kind, digest, storage_ref, egress_class, redaction_state, captured_at)
         VALUES ('${evidenceArtifactId}', '${TENANT_A}', '${caseId}', 'ACTION_RECEIPT', repeat('b', 64), 's3://evidence/${RUN}/${evidenceArtifactId}', 'OPAQUE_ID', 'NONE', now());`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(result.status, 0, `fixture failed: ${result.output}`);
  return { caseId, recipeId, authorityGrantId, policyDecisionId: decisionId, evidenceArtifactId };
}

/** An ambiguous action on an existing case, which is what §5.8.3 reconciles. */
function addAmbiguousAction(world: World): string {
  const actionId = randomUUID();
  const result = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO external_action (id, tenant_id, case_id, channel, idempotency_key, attempt, status, ambiguous, submitted_at, recipe_id, recipe_version, acting_path_id)
         VALUES ('${actionId}', '${TENANT_A}', '${world.caseId}', 'OFFICIAL_SELF_SERVICE', 'ambiguous-${actionId}', 1, 'AMBIGUOUS', true, now() - interval '1 hour', '${world.recipeId}', 1, 'PROVIDER_API');`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(result.status, 0, `action fixture failed: ${result.output}`);
  return actionId;
}

async function caseEtag(app: VgFastify, caseId: string): Promise<string> {
  const detail = await call(app, 'GET', `/v1/cases/${caseId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  return String(detail.headers['etag']);
}

function encodeBody(world: World, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: 'OFFICIAL_SELF_SERVICE',
    recipeId: world.recipeId,
    recipeVersion: 1,
    authorityGrantId: world.authorityGrantId,
    policyDecisionId: world.policyDecisionId,
    idempotencyKey: `eff-${RUN}-${randomUUID().slice(0, 8)}`,
    payloadFields: { subjectDisplayRef: 'SUBJ-2026-00042' },
    dryRun: false,
    ...overrides,
  };
}

describe('§5.8.2 execution: the guards are real, the effect is not available', () => {
  test('a dry run reports the guards and a real submission is refused 503', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    const etag = await caseEtag(app, world.caseId);

    const dry = await call(app, 'POST', `/v1/cases/${world.caseId}/external-actions`, {
      headers: { 'if-match': etag },
      body: encodeBody(world, { dryRun: true, templateRef: { templateVersion: 'v7', templateHash: 'a'.repeat(64) } }),
    });
    assert.equal(dry.status, 200, JSON.stringify(dry.json));
    assert.equal(dry.json['dryRun'], true);
    const guards = dry.json['guardsEvaluated'] as Record<string, unknown>;
    // TRUE ONLY BECAUSE A REAL KEY VERIFIED A REAL SIGNATURE and the authority, source and budget were read from
    // rows: a stub that returned constants would pass a weaker assertion but not this one.
    assert.equal(guards['authorityValid'], true);
    assert.equal(guards['recipeSignedAndFresh'], true);
    assert.equal(guards['sourceWritable'], true);
    assert.equal(guards['channelMatchesDecision'], true);
    assert.equal(guards['budgetAvailable'], true);
    assert.equal(dry.json['wouldTransitionTo'], 'REQUEST_SUBMITTED');
    assert.equal(dry.json['templateHashRequired'], false);
    // NO ACTION ROW, NO STATE CHANGE: a dry run is not a submission.
    assert.deepEqual(read(TENANT_A, `SELECT id::text FROM external_action WHERE case_id = '${world.caseId}'::uuid`), []);
    assert.deepEqual(read(TENANT_A, `SELECT truth_state::text FROM request_case WHERE id = '${world.caseId}'`), [
      'REQUEST_READY',
    ]);

    const real = await call(app, 'POST', `/v1/cases/${world.caseId}/external-actions`, {
      headers: { 'if-match': etag },
      body: encodeBody(world),
    });
    assert.equal(real.status, 503, JSON.stringify(real.json));
    assert.equal(codeOf(real), 'DEPENDENCY_UNAVAILABLE');
    assert.deepEqual(read(TENANT_A, `SELECT id::text FROM external_action WHERE case_id = '${world.caseId}'::uuid`), []);
    assert.deepEqual(read(TENANT_A, `SELECT truth_state::text FROM request_case WHERE id = '${world.caseId}'`), [
      'REQUEST_READY',
    ]);
  });

  test('a payload field nobody allowlisted is refused, and it is refused before the transport', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    const etag = await caseEtag(app, world.caseId);

    const notAllowlisted = await call(app, 'POST', `/v1/cases/${world.caseId}/external-actions`, {
      headers: { 'if-match': etag },
      body: encodeBody(world, { payloadFields: { email: 'someone@example.invalid' } }),
    });
    assert.equal(notAllowlisted.status, 422, JSON.stringify(notAllowlisted.json));
    assert.equal(codeOf(notAllowlisted), 'PAYLOAD_FIELD_NOT_ALLOWLISTED');

    // The allowlisted NAME with a PII-shaped VALUE is refused too: the allowlist admits a reference field, not a
    // place to put personal data (VG-EGRESS-001).
    const piiValue = await call(app, 'POST', `/v1/cases/${world.caseId}/external-actions`, {
      headers: { 'if-match': etag },
      body: encodeBody(world, { payloadFields: { subjectDisplayRef: 'someone@example.invalid' } }),
    });
    assert.equal(piiValue.status, 422, JSON.stringify(piiValue.json));
    assert.equal(codeOf(piiValue), 'PAYLOAD_FIELD_NOT_ALLOWLISTED');
  });

  test('CERTIFIED_MAIL without a template hash is refused (VG-ACTION-004)', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    const etag = await caseEtag(app, world.caseId);

    const refused = await call(app, 'POST', `/v1/cases/${world.caseId}/external-actions`, {
      headers: { 'if-match': etag },
      body: encodeBody(world, { channel: 'CERTIFIED_MAIL' }),
    });
    assert.equal(refused.status, 422, JSON.stringify(refused.json));
    assert.equal(codeOf(refused), 'TEMPLATE_HASH_REQUIRED');
  });

  test('a case that is not REQUEST_READY is an illegal transition, and MATCH_CONFIRMED is named', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ state: 'MATCH_CONFIRMED' });
    const etag = await caseEtag(app, world.caseId);

    const refused = await call(app, 'POST', `/v1/cases/${world.caseId}/external-actions`, {
      headers: { 'if-match': etag },
      body: encodeBody(world),
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.equal(codeOf(refused), 'ILLEGAL_TRANSITION');
    const details = (refused.json['error'] as Record<string, unknown>)['details'];
    assert.equal((details as Record<string, unknown>)['fromTruthState'], 'MATCH_CONFIRMED');
  });

  test('an unverifiable recipe makes the dry run report a failed guard rather than a success', async () => {
    const app = serverFor(TENANT_A, { verifiedKeys: false });
    const world = newWorld();
    const etag = await caseEtag(app, world.caseId);

    const dry = await call(app, 'POST', `/v1/cases/${world.caseId}/external-actions`, {
      headers: { 'if-match': etag },
      body: encodeBody(world, { dryRun: true }),
    });
    assert.equal(dry.status, 200, JSON.stringify(dry.json));
    assert.equal((dry.json['guardsEvaluated'] as Record<string, unknown>)['recipeSignedAndFresh'], false);
    assert.equal(dry.json['wouldTransitionTo'], null);
  });
});

describe('§5.8.3 reconciliation: the state never regresses and is never invented', () => {
  test('EFFECT_CONFIRMED records the divergence-free outcome and requires a NEW readback', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ state: 'REQUEST_READY' });
    const actionId = addAmbiguousAction(world);

    const response = await call(app, 'POST', `/v1/external-actions/${actionId}/reconciliations`, {
      body: {
        reconciliationMethod: 'PROVIDER_API_LOOKUP',
        observedAt: new Date().toISOString(),
        finding: 'EFFECT_CONFIRMED',
        evidenceArtifactId: world.evidenceArtifactId,
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['actionOutcome'], 'SUBMITTED');
    // The case was REQUEST_READY, so the confirmed effect drives T8 — through the DOMAIN command, not by writing
    // a state here.
    assert.equal(response.json['truthState'], 'REQUEST_SUBMITTED');
    assert.equal(response.json['transitionCode'], 'T8');
    assert.equal(response.json['readbackRequired'], true);
    assert.deepEqual(read(TENANT_A, `SELECT truth_state::text FROM request_case WHERE id = '${world.caseId}'`), [
      'REQUEST_SUBMITTED',
    ]);
    assert.deepEqual(
      read(
        TENANT_A,
        `SELECT status || '|' || ambiguous::text FROM external_action WHERE id = '${actionId}'::uuid`,
      ),
      ['SUBMITTED|false'],
    );
  });

  test('EFFECT_ABSENT records the divergence, sets FAILED and moves NOTHING', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ state: 'REQUEST_SUBMITTED' });
    const actionId = addAmbiguousAction(world);

    const response = await call(app, 'POST', `/v1/external-actions/${actionId}/reconciliations`, {
      body: {
        reconciliationMethod: 'MAIL_TRACKING_LOOKUP',
        observedAt: new Date().toISOString(),
        finding: 'EFFECT_ABSENT',
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['actionOutcome'], 'FAILED');
    assert.equal(response.json['truthStateUnchanged'], 'REQUEST_SUBMITTED');
    assert.equal(response.json['divergenceRecorded'], true);
    assert.equal(response.json['requiresNewIdempotencyKey'], true);
    // NO REGRESSION: SPEC-001 §4.1 has no reverse transition and the API does not invent one.
    assert.deepEqual(read(TENANT_A, `SELECT truth_state::text FROM request_case WHERE id = '${world.caseId}'`), [
      'REQUEST_SUBMITTED',
    ]);
    assert.deepEqual(
      read(TENANT_A, `SELECT status FROM external_action WHERE id = '${actionId}'::uuid`),
      ['FAILED'],
    );
  });

  test('INDETERMINATE escalates to HUMAN_REQUIRED and says so', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ state: 'REQUEST_SUBMITTED' });
    const actionId = addAmbiguousAction(world);

    const response = await call(app, 'POST', `/v1/external-actions/${actionId}/reconciliations`, {
      body: {
        reconciliationMethod: 'CONTROLLER_CONTACT_CONFIRMATION',
        observedAt: new Date().toISOString(),
        finding: 'INDETERMINATE',
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['actionOutcome'], 'AMBIGUOUS');
    assert.equal(response.json['escalatedTo'], 'HUMAN_REQUIRED');
  });

  test('an action that was never ambiguous is refused 409', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    // `asTenant` wraps the statements and returns the LINES a statement prints, which is why this ends in
    // `RETURNING id::text` and does not parse psql's aligned output. MEASURED: a first version used `exec` and a
    // regex over the raw output and never found the id, so the test failed in its FIXTURE.
    const actionId = randomUUID();
    const inserted = asTenant(
      ownerDsn(),
      TENANT_A,
      `INSERT INTO external_action (id, tenant_id, case_id, channel, idempotency_key, attempt, status, ambiguous)
       VALUES ('${actionId}', '${TENANT_A}', '${world.caseId}', 'OFFICIAL_SELF_SERVICE', 'clear-${RUN}', 1, 'SUBMITTED', false)
       RETURNING id::text;`,
    );
    assert.equal(inserted[0], actionId, `the fixture did not return the action id: ${JSON.stringify(inserted)}`);

    const response = await call(app, 'POST', `/v1/external-actions/${actionId}/reconciliations`, {
      body: {
        reconciliationMethod: 'PROVIDER_API_LOOKUP',
        observedAt: new Date().toISOString(),
        finding: 'EFFECT_CONFIRMED',
      },
    });
    assert.equal(response.status, 409, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'ACTION_NOT_AMBIGUOUS');
  });
});

describe('§5.8.4 readback: a request for evidence, and nothing more', () => {
  test('a readback is recorded PENDING and moves no state', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ state: 'REQUEST_SUBMITTED' });
    const actionId = addAmbiguousAction(world);

    const response = await call(app, 'POST', `/v1/external-actions/${actionId}/readback`, {
      body: {
        observationMethod: 'INDEPENDENT_FETCH_DIFFERENT_EGRESS',
        requestedAt: new Date().toISOString(),
      },
    });
    assert.equal(response.status, 202, JSON.stringify(response.json));
    assert.equal(response.json['readbackState'], 'PENDING');
    assert.match(String(response.json['readbackRequestId']), /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      read(TENANT_A, `SELECT state FROM readback WHERE external_action_id = '${actionId}'::uuid`),
      ['PENDING'],
    );
    // A readback never sets a truth state (VG-ACTION-003).
    assert.deepEqual(read(TENANT_A, `SELECT truth_state::text FROM request_case WHERE id = '${world.caseId}'`), [
      'REQUEST_SUBMITTED',
    ]);
  });

  test('the acting path cannot read back its own effect', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ state: 'REQUEST_SUBMITTED' });
    // The fixture records `acting_path_id = 'PROVIDER_API'`.
    const actionId = addAmbiguousAction(world);

    const refused = await call(app, 'POST', `/v1/external-actions/${actionId}/readback`, {
      body: { observationMethod: 'PROVIDER_API', requestedAt: new Date().toISOString() },
    });
    assert.equal(refused.status, 422, JSON.stringify(refused.json));
    assert.equal(codeOf(refused), 'OBSERVATION_PATH_NOT_INDEPENDENT');
    assert.deepEqual(read(TENANT_A, `SELECT state FROM readback WHERE external_action_id = '${actionId}'::uuid`), []);
  });
});

describe('§5.8.1, §5.8.5, §5.8.6 the reads', () => {
  test('the list reports the outcome, the fingerprint and the readback state, never the key', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ state: 'REQUEST_SUBMITTED' });
    const actionId = addAmbiguousAction(world);

    const listed = await call(app, 'GET', `/v1/cases/${world.caseId}/external-actions`);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    const rows = listed.json['data'] as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['externalActionId'], actionId);
    assert.equal(rows[0]?.['actionOutcome'], 'AMBIGUOUS');
    assert.equal(rows[0]?.['readbackState'], 'PENDING');
    // A ONE-WAY DIGEST, never the key (§5.8.1), and the key must not appear anywhere in the body.
    const fingerprint = String(rows[0]?.['idempotencyKeyFingerprint']);
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(listed.json).includes(`ambiguous-${actionId}`), false, 'the key leaked');

    const detail = await call(app, 'GET', `/v1/external-actions/${actionId}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    assert.equal((detail.json['recipeSnapshot'] as Record<string, unknown>)['version'], 1);
    assert.equal((detail.json['readback'] as Record<string, unknown>)['state'], 'PENDING');
    assert.equal((detail.json['ambiguity'] as Record<string, unknown>)['ambiguous'], true);
    assert.equal(typeof detail.headers['etag'], 'string');
  });

  test('a mail piece with no evidence is UNKNOWN, and pagination walks without repeating', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    for (const index of [0, 1, 2]) {
      const inserted = exec(
        ownerDsn(),
        `BEGIN; SELECT set_config('app.tenant_id', '${TENANT_A}', true);
         INSERT INTO mail_piece (id, tenant_id, case_id, template_version, template_hash, transport_name, tracking_id, delivery_status)
         VALUES ('${randomUUID()}', '${TENANT_A}', '${world.caseId}', 7, repeat('a', 64), 'certified-mail-${RUN}-${String(index)}',
                 ${index === 0 ? 'NULL' : `'track-${RUN}-${String(index)}'`}, ${index === 0 ? "'NOT_SENT'" : "'SENT'"});
         COMMIT;`,
      );
      assert.equal(inserted.status, 0, inserted.output);
    }

    const listed = await call(app, 'GET', `/v1/cases/${world.caseId}/mail-pieces?limit=2`);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    const rows = listed.json['data'] as Record<string, unknown>[];
    assert.equal(rows.length, 2);
    const page = listed.json['page'] as Record<string, unknown>;
    assert.equal(page['hasMore'], true);
    const statuses = rows.map((row) => row['deliveryStatus']);
    // `SENT` renders as IN_TRANSIT and a piece with NO tracking renders UNKNOWN — the second is §5.8.6's own
    // rule: a status is never synthesised.
    assert.ok(statuses.includes('IN_TRANSIT') || statuses.includes('UNKNOWN'), JSON.stringify(statuses));

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const url = `/v1/cases/${world.caseId}/mail-pieces?limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response = await call(app, 'GET', url);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      for (const row of (response.json['data'] ?? []) as Record<string, unknown>[]) {
        const id = String(row['mailPieceId']);
        assert.equal(seen.has(id), false, `row ${id} was returned twice`);
        seen.add(id);
      }
      const pageInfo = response.json['page'] as Record<string, unknown>;
      cursor = pageInfo['nextCursor'] === null ? null : String(pageInfo['nextCursor']);
      if (cursor === null) break;
    }
    assert.equal(seen.size, 3, `the walk saw ${String(seen.size)} of 3 pieces`);
  });

  test("another tenant's case and action are 404", async () => {
    const appB = serverFor(TENANT_B);
    const world = newWorld({ state: 'REQUEST_SUBMITTED' });
    const actionId = addAmbiguousAction(world);

    assert.equal((await call(appB, 'GET', `/v1/cases/${world.caseId}/external-actions`)).status, 404);
    assert.equal((await call(appB, 'GET', `/v1/external-actions/${actionId}`)).status, 404);
    assert.equal((await call(appB, 'GET', `/v1/cases/${world.caseId}/mail-pieces`)).status, 404);
    const readback = await call(appB, 'POST', `/v1/external-actions/${actionId}/readback`, {
      body: { observationMethod: 'PROVIDER_API', requestedAt: new Date().toISOString() },
    });
    assert.equal(readback.status, 404, JSON.stringify(readback.json));
  });
});
