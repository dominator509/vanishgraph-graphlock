/**
 * The case aggregate against real PostgreSQL (SPEC-003 §5.7.1–§5.7.6).
 *
 * WHAT THIS SUITE PROVES, and why each item needs a database:
 *
 *   * **A guarded transition that the API reports is a ROW the database holds**, with a transition code the
 *     spine carries. Every success assertion re-reads `request_case.truth_state` and the `audit_event` row
 *     instead of trusting the response, because the failure that guards against is a handler reporting a
 *     transition it never wrote.
 *   * **The requested state is the state that was produced.** §5.7.4 hands a *request* to the guard list; a
 *     caller asking for `NOT_REMOVABLE` from a source that may lawfully be written to must NOT receive
 *     `REQUEST_READY`, and this asserts the refusal and the unchanged row.
 *   * **An unverified recipe cannot authorise a request.** The suite configures a REAL Ed25519 key for one
 *     server and none for another, so `guardsEvaluated.recipeSigned` is shown to be the outcome of a
 *     verification rather than the presence of bytes — the negative case is the one that matters.
 *   * **The timeline is a union of rows that exist**, ordered, with `truthStateAfter` filled only by the
 *     TRANSITION branch: a deadline that reported a truth state would claim a transition nobody performed.
 *   * **SM-2 holds in the negative direction**: a refused write leaves no audit row and no state change.
 *   * **Cross-tenant reads are 404**, and the database layer returns zero rows independently.
 *
 * FIXTURE DISCIPLINE. Every world is built in TWO TENANTS OF THIS SUITE'S OWN, per run. Not the seeded tenants:
 * `postgres-runner.test.ts`, `rls.test.ts` and `route-catalogue.test.ts` all assert that tenant A holds exactly
 * one seeded subject, and `ASSUMPTIONS.md` §3.27 records what happened the first time a suite ignored that.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresCaseQueries } from '../../src/adapters/persistence/cases.ts';
import { PostgresControllerResponseQueries } from '../../src/adapters/persistence/controller-responses.ts';
import { PostgresActionQueries } from '../../src/adapters/persistence/actions.ts';
import { PostgresPolicyQueries } from '../../src/adapters/persistence/policies.ts';
import { PostgresCoverageQueries } from '../../src/adapters/persistence/coverage.ts';
import { PostgresEvidenceQueries } from '../../src/adapters/persistence/evidence.ts';
import { PostgresDiscoveryQueries } from '../../src/adapters/persistence/discovery.ts';
import { PostgresTransitionQueries } from '../../src/adapters/persistence/transitions.ts';
import { PostgresExposureQueries } from '../../src/adapters/persistence/exposures.ts';
import { PostgresObservationQueries } from '../../src/adapters/persistence/observations.ts';
import { PostgresAuditQueries } from '../../src/adapters/persistence/audit-queries.ts';
import { PostgresDeadlineQueries } from '../../src/adapters/persistence/deadlines.ts';
import { PostgresAppealQueries } from '../../src/adapters/persistence/appeals.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresSubjectCommands } from '../../src/adapters/persistence/subject-commands.ts';
import { PostgresSourceQueries } from '../../src/adapters/persistence/sources.ts';
import { canonicalRecipePayload } from '../../src/adapters/persistence/sources.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, asTenant, exec, ownerDsn } from './harness.ts';

/** Two tenants of this suite's own, created per run. See the header. */
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RUN = randomUUID().slice(0, 8);

const SCOPES = ['vg.cases.read', 'vg.cases.write'];

/** A real Ed25519 key pair, generated per run. The PUBLIC half is what the service verifies against. */
const RECIPE_KEYS = generateKeyPairSync('ed25519');
const KEY_REF = `key-${RUN}`;
const PUBLIC_PEM = RECIPE_KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString();

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'case-suite-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'case-suite-b-${RUN}', 'ACTIVE');`,
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
    subjectCommands: new PostgresSubjectCommands(),
    sourceQueries: new PostgresSourceQueries(),
    recipeVerificationKeys: { publicKeysByRef: new Map<string, string>() },
    appealQueries: new PostgresAppealQueries(),
    deadlineQueries: new PostgresDeadlineQueries(),
    auditQueries: new PostgresAuditQueries(),
    observationQueries: new PostgresObservationQueries(),
    exposureQueries: new PostgresExposureQueries(),
    transitionQueries: new PostgresTransitionQueries(),
    // THE KEY MAP IS THE VARIABLE UNDER TEST for `guardsEvaluated.recipeSigned`: with it the signature
    // verifies, without it the same recipe reports false and the transition is refused.
    caseQueries: new PostgresCaseQueries({
      recipeVerificationKeys:
        options.verifiedKeys === false
          ? { publicKeysByRef: new Map() }
          : { publicKeysByRef: new Map([[KEY_REF, PUBLIC_PEM]]) },
    }),
    controllerResponseQueries: new PostgresControllerResponseQueries(),
    actionQueries: new PostgresActionQueries({ recipeVerificationKeys: { publicKeysByRef: new Map() } }),
    policyQueries: new PostgresPolicyQueries(),
    coverageQueries: new PostgresCoverageQueries(),
    evidenceQueries: new PostgresEvidenceQueries(),
    discoveryQueries: new PostgresDiscoveryQueries(),
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
 * A per-RUN unique idempotency key. MEASURED DEFECT CLASS (ASSUMPTIONS §3.22): a counter that restarts at 1 in
 * every process makes a suite pass exactly once, because the store retains a completed key for 24 hours and
 * `test-integration` runs each file twice per invocation.
 */
function nextKey(): string {
  keyCounter += 1;
  return `case-db-key-${RUN}-${String(keyCounter).padStart(4, '0')}`;
}

async function call(
  app: VgFastify,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> {
  const headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}`, ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && headers['idempotency-key'] === undefined) headers['idempotency-key'] = nextKey();
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
  // The trailing semicolon is required: `asTenant` wraps the statement between `BEGIN;` and `COMMIT;`, so an
  // unterminated statement swallows the COMMIT and psql reports a syntax error on an unrelated line.
  return asTenant(ownerDsn(), tenantId, sql.trimEnd().endsWith(';') ? sql : `${sql};`);
}

interface CaseWorld {
  readonly caseId: string | null;
  readonly subjectId: string;
  readonly authorityGrantId: string;
  readonly sourceId: string;
  readonly recipeId: string;
  readonly exposureId: string;
  readonly policyDecisionId: string;
}

/** A per-world policy version, so worlds can share one jurisdiction without colliding on its unique key. */
let worldCounter = 0;

/**
 * Build a subject → grant → source → recipe → record → exposure → policy → decision world, optionally with a
 * case already created at `caseState`.
 *
 * The recipe's signature is a REAL Ed25519 signature over the canonical payload, so the server configured with
 * the public key verifies it and the one without does not. Inserting a signature nobody could verify would make
 * the `recipeSigned` assertions vacuous in the direction that matters.
 */
function newWorld(options: {
  readonly exposureState?: string;
  readonly caseState?: string | null;
  readonly permissionClass?: string;
  readonly recipeEnabled?: boolean;
  readonly grantScope?: readonly string[];
  readonly tenantId?: string;
} = {}): CaseWorld {
  const tenantId = options.tenantId ?? TENANT_A;
  const subjectId = randomUUID();
  const authorityGrantId = randomUUID();
  const sourceId = randomUUID();
  const recipeId = randomUUID();
  const recordId = randomUUID();
  const exposureId = randomUUID();
  const decisionId = randomUUID();
  const caseId = randomUUID();
  // A VALID ISO 3166-2 code: the domain's `Jurisdiction` pattern is `^[A-Z]{2}(-[A-Z0-9]{1,3})?$`, and an
  // over-long code is refused by `new Jurisdiction(...)` INSIDE the command — measured as an INTERNAL_ERROR on
  // the first PATCH, because the fixture's jurisdiction was fourteen characters. Worlds share the code and
  // differ by policy VERSION instead, which is what `(tenant_id, jurisdiction, version)` is unique on.
  const jurisdiction = 'US-CA';
  const policyVersion = 1000 + (worldCounter += 1);
  const permissionClass = options.permissionClass ?? 'WRITE_PERMITTED';
  const freshnessAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const maxAttempts = 5;
  const windowSeconds = 86400;

  const payload = canonicalRecipePayload({
    sourceId,
    channel: 'OFFICIAL_SELF_SERVICE',
    verificationMethod: 'independent-fetch',
    signingKeyRef: KEY_REF,
    freshnessAt: freshnessAt.toISOString(),
    maxAttemptsPerWindow: maxAttempts,
    windowSeconds,
  });
  const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), RECIPE_KEYS.privateKey);

  const statements = [
    'BEGIN;',
    `SELECT set_config('app.tenant_id', '${tenantId}', true);`,
    `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
       VALUES ('${subjectId}', '${tenantId}', 'case-subject-${RUN}', '${jurisdiction}', false, 'ACTIVE');`,
    `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument)
       VALUES ('${authorityGrantId}', '${tenantId}', '${subjectId}', 'SELF',
               ARRAY[${(options.grantScope ?? ['discovery', 'self_service_write']).map((s) => `'${s}'`).join(',')}],
               now() - interval '1 day', now() + interval '30 days', false);`,
    `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class, permission_checked_at)
       VALUES ('${sourceId}', '${tenantId}', 'case-source-${RUN}-${sourceId.slice(0, 8)}', 'REGISTRY', '${jurisdiction}',
               '${permissionClass}', now());`,
    `INSERT INTO removal_recipe (id, tenant_id, source_id, version, signature, channel, verification_method,
                                 freshness_at, enabled, signing_key_ref, max_attempts_per_window, window_seconds)
       VALUES ('${recipeId}', '${tenantId}', '${sourceId}', 1, decode('${signature.toString('hex')}', 'hex'),
               'OFFICIAL_SELF_SERVICE', 'independent-fetch', '${freshnessAt.toISOString()}',
               ${options.recipeEnabled === false ? 'false' : 'true'}, '${KEY_REF}', ${String(maxAttempts)}, ${String(windowSeconds)});`,
    `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
       VALUES ('${recordId}', '${tenantId}', '${sourceId}', 'https://example.invalid/case-${RUN}', now() - interval '2 hours', repeat('e', 64), false);`,
    `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
       VALUES ('${exposureId}', '${tenantId}', '${subjectId}', '${recordId}', 0.91,
               '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, '${options.exposureState ?? 'MATCH_CONFIRMED'}');`,
    `INSERT INTO jurisdiction_policy (id, tenant_id, jurisdiction, version, effective_from, rules, provenance, match_confidence_threshold)
       VALUES ('${randomUUID()}', '${tenantId}', '${jurisdiction}', ${String(policyVersion)}, now() - interval '1 day', ARRAY['CCPA_DELETE'], 'COUNSEL_REVIEWED', 0.85);`,
    `INSERT INTO policy_decision (id, tenant_id, case_id, jurisdiction, legal_basis, channel, policy_version, reasons, decided_at)
       VALUES ('${decisionId}', '${tenantId}', ${options.caseState === undefined || options.caseState === null ? 'NULL' : `'${caseId}'`},
               '${jurisdiction}', 'CCPA_DELETE', 'OFFICIAL_SELF_SERVICE', ${String(policyVersion)}, '["consumer-request-right"]'::jsonb, now() - interval '1 hour');`,
  ];
  if (options.caseState !== undefined && options.caseState !== null) {
    statements.push(
      `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, policy_decision_id, recipe_id, truth_state)
         VALUES ('${caseId}', '${tenantId}', '${subjectId}', '${exposureId}', '${sourceId}', '${authorityGrantId}',
                 '${decisionId}', '${recipeId}', '${options.caseState}');`,
    );
  }
  statements.push('COMMIT;');

  const result = exec(ownerDsn(), statements.join('\n'));
  assert.equal(result.status, 0, `fixture failed: ${result.output}`);
  return {
    caseId: options.caseState === undefined || options.caseState === null ? null : caseId,
    subjectId,
    authorityGrantId,
    sourceId,
    recipeId,
    exposureId,
    policyDecisionId: decisionId,
  };
}

function stateOf(tenantId: string, caseId: string): string[] {
  return read(tenantId, `SELECT truth_state::text FROM request_case WHERE id = '${caseId}'`);
}

function transitionsFor(tenantId: string, caseId: string): string[] {
  return read(
    tenantId,
    // THE CREATION ROW IS FOUND BY TARGET, NOT BY `case_id`. Creation is not a transition, so the spine's
    // all-or-nothing CHECK requires `case_id IS NULL` on that row; the case it created is named by
    // `target_kind`/`target_id`, exactly as the seed records a T5 against `RequestCase`. A query that looked
    // only at `case_id` would report a created case as having no audit trail at all.
    `SELECT coalesce(a.transition_code, 'null') || '|' || a.action || '|' || coalesce(a.to_truth_state::text, '-')
       FROM audit_event a
      WHERE a.case_id = '${caseId}'::uuid
         OR (a.target_kind = 'RequestCase' AND a.target_id = '${caseId}'::uuid)
      ORDER BY a.at ASC, a.id ASC`,
  );
}

async function etagOf(app: VgFastify, caseId: string): Promise<string> {
  const detail = await call(app, 'GET', `/v1/cases/${caseId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  const etag = detail.headers['etag'];
  assert.equal(typeof etag, 'string', 'the detail read returned no ETag');
  return etag as string;
}

describe('§5.7.1 creation', () => {
  test('a case is created at the exposure’s state and audited without a transition', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();

    const response = await call(app, 'POST', '/v1/cases', {
      body: {
        subjectId: world.subjectId,
        exposureId: world.exposureId,
        sourceId: world.sourceId,
        authorityGrantId: world.authorityGrantId,
        policyDecisionId: world.policyDecisionId,
        recipeId: world.recipeId,
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    assert.equal(response.json['truthState'], 'MATCH_CONFIRMED');
    const caseId = String(response.json['caseId']);
    assert.match(caseId, /^[0-9a-f-]{36}$/);
    assert.equal(response.headers['location'], `/v1/cases/${caseId}`);
    assert.equal(typeof response.headers['etag'], 'string');

    // THE DATABASE, NOT THE RESPONSE: the row exists at the exposure's state, and the audit row records the
    // creation with NO transition code — creation advances no truth state (§5.7.1).
    assert.deepEqual(stateOf(TENANT_A, caseId), ['MATCH_CONFIRMED']);
    assert.deepEqual(transitionsFor(TENANT_A, caseId), ['null|CreateRequestCase|-']);
    // The decision is now bound to the case, which is what makes the case readable as a complete decision.
    assert.deepEqual(
      read(TENANT_A, `SELECT case_id::text FROM policy_decision WHERE id = '${world.policyDecisionId}'`),
      [caseId],
    );
  });

  test('the same subject × source × exposure cannot have two live cases', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    const body = {
      subjectId: world.subjectId,
      exposureId: world.exposureId,
      sourceId: world.sourceId,
      authorityGrantId: world.authorityGrantId,
      policyDecisionId: world.policyDecisionId,
      recipeId: world.recipeId,
    };
    const first = await call(app, 'POST', '/v1/cases', { body });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    const second = await call(app, 'POST', '/v1/cases', { body });
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.equal(codeOf(second), 'CASE_ALREADY_EXISTS');
  });

  test('an unassessed candidate, a disabled recipe, a foreign decision and a narrow grant are each refused', async () => {
    const app = serverFor(TENANT_A);

    const candidate = newWorld({ exposureState: 'DISCOVERED_CANDIDATE' });
    const candidateResponse = await call(app, 'POST', '/v1/cases', {
      body: {
        subjectId: candidate.subjectId,
        exposureId: candidate.exposureId,
        sourceId: candidate.sourceId,
        authorityGrantId: candidate.authorityGrantId,
        policyDecisionId: candidate.policyDecisionId,
        recipeId: candidate.recipeId,
      },
    });
    assert.equal(candidateResponse.status, 409, JSON.stringify(candidateResponse.json));
    assert.equal(codeOf(candidateResponse), 'CASE_EXPOSURE_STATE_MISMATCH');

    const disabled = newWorld({ recipeEnabled: false });
    const disabledResponse = await call(app, 'POST', '/v1/cases', {
      body: {
        subjectId: disabled.subjectId,
        exposureId: disabled.exposureId,
        sourceId: disabled.sourceId,
        authorityGrantId: disabled.authorityGrantId,
        policyDecisionId: disabled.policyDecisionId,
        recipeId: disabled.recipeId,
      },
    });
    assert.equal(disabledResponse.status, 422, JSON.stringify(disabledResponse.json));
    assert.equal(codeOf(disabledResponse), 'RECIPE_NOT_ENABLED');

    const narrow = newWorld({ grantScope: ['discovery'] });
    const narrowResponse = await call(app, 'POST', '/v1/cases', {
      body: {
        subjectId: narrow.subjectId,
        exposureId: narrow.exposureId,
        sourceId: narrow.sourceId,
        authorityGrantId: narrow.authorityGrantId,
        policyDecisionId: narrow.policyDecisionId,
        recipeId: narrow.recipeId,
      },
    });
    assert.equal(narrowResponse.status, 422, JSON.stringify(narrowResponse.json));
    assert.equal(codeOf(narrowResponse), 'AUTHORITY_GRANT_SCOPE_INSUFFICIENT');

    const bound = newWorld({ caseState: 'MATCH_CONFIRMED' });
    // A SEPARATE world with NO case, offered the decision that the world above already bound. Checking the live
    // case first means the "two live cases" conflict is reported as such; a bound decision offered for a
    // different exposure is the case that reaches this branch.
    const fresh = newWorld();
    const boundResponse = await call(app, 'POST', '/v1/cases', {
      body: {
        subjectId: fresh.subjectId,
        exposureId: fresh.exposureId,
        sourceId: fresh.sourceId,
        authorityGrantId: fresh.authorityGrantId,
        policyDecisionId: bound.policyDecisionId,
        recipeId: fresh.recipeId,
      },
    });
    assert.equal(boundResponse.status, 422, JSON.stringify(boundResponse.json));
    assert.equal(codeOf(boundResponse), 'POLICY_DECISION_INCOMPLETE');
  });
});

describe('§5.7.4 the guarded transition', () => {
  test('T5 to REQUEST_READY: the row moves, the guards are reported, the spine records T5', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ caseState: 'MATCH_CONFIRMED' });
    const caseId = world.caseId as string;
    const etag = await etagOf(app, caseId);

    const response = await call(app, 'PATCH', `/v1/cases/${caseId}`, {
      headers: { 'if-match': etag },
      body: {
        requestedTruthState: 'REQUEST_READY',
        reason: { code: 'PREPARE', detail: 'all guards evaluated' },
        evidenceArtifactIds: [],
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['truthState'], 'REQUEST_READY');
    assert.equal(response.json['transitionCode'], 'T5');
    assert.match(String(response.json['transitionId']), /^\d+$/);
    assert.deepEqual(response.json['guardsEvaluated'], {
      authorityValid: true,
      policyDecisionComplete: true,
      // TRUE ONLY BECAUSE A REAL KEY VERIFIED A REAL SIGNATURE — see the negative case below.
      recipeSigned: true,
      recipeFresh: true,
      channelPermitted: true,
      budgetAvailable: true,
    });

    assert.deepEqual(stateOf(TENANT_A, caseId), ['REQUEST_READY']);
    assert.deepEqual(transitionsFor(TENANT_A, caseId), ['T5|PrepareRequest|REQUEST_READY']);
  });

  test('the same request without a verification key is refused, and nothing moves', async () => {
    const app = serverFor(TENANT_A, { verifiedKeys: false });
    const world = newWorld({ caseState: 'MATCH_CONFIRMED' });
    const caseId = world.caseId as string;
    const etag = await etagOf(app, caseId);

    const response = await call(app, 'PATCH', `/v1/cases/${caseId}`, {
      headers: { 'if-match': etag },
      body: { requestedTruthState: 'REQUEST_READY', reason: { code: 'PREPARE', detail: 'x' } },
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'GUARD_FAILED');
    // VG-CHANNEL-003: an unverified recipe may not authorise a write — and a refusal writes NOTHING.
    assert.deepEqual(stateOf(TENANT_A, caseId), ['MATCH_CONFIRMED']);
    assert.deepEqual(transitionsFor(TENANT_A, caseId), []);
  });

  test('a source that may not be written to produces NOT_REMOVABLE (T6), not REQUEST_READY', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ caseState: 'MATCH_CONFIRMED', permissionClass: 'WRITE_UNCLEAR' });
    const caseId = world.caseId as string;
    const etag = await etagOf(app, caseId);

    const requested = await call(app, 'PATCH', `/v1/cases/${caseId}`, {
      headers: { 'if-match': etag },
      body: { requestedTruthState: 'REQUEST_READY', reason: { code: 'PREPARE', detail: 'x' } },
    });
    // The caller asked for REQUEST_READY and the guard list says no: the command produces NOT_REMOVABLE, and the
    // port refuses rather than handing back a state nobody requested.
    assert.equal(requested.status, 422, JSON.stringify(requested.json));
    assert.equal(codeOf(requested), 'GUARD_FAILED');
    assert.deepEqual(stateOf(TENANT_A, caseId), ['MATCH_CONFIRMED']);

    const asNotRemovable = await call(app, 'PATCH', `/v1/cases/${caseId}`, {
      headers: { 'if-match': etag },
      body: {
        requestedTruthState: 'NOT_REMOVABLE',
        reason: { code: 'NO_LAWFUL_CHANNEL', detail: 'permission class is WRITE_UNCLEAR' },
      },
    });
    assert.equal(asNotRemovable.status, 200, JSON.stringify(asNotRemovable.json));
    assert.equal(asNotRemovable.json['truthState'], 'NOT_REMOVABLE');
    assert.equal(asNotRemovable.json['transitionCode'], 'T6');
    assert.equal((asNotRemovable.json['guardsEvaluated'] as Record<string, unknown>)['channelPermitted'], false);
    assert.deepEqual(stateOf(TENANT_A, caseId), ['NOT_REMOVABLE']);
  });

  test('a non-routeable target and an illegal pair are refused with different codes', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ caseState: 'MATCH_CONFIRMED' });
    const caseId = world.caseId as string;
    const etag = await etagOf(app, caseId);

    const notRouteable = await call(app, 'PATCH', `/v1/cases/${caseId}`, {
      headers: { 'if-match': etag },
      body: { requestedTruthState: 'REQUEST_SUBMITTED', reason: { code: 'X', detail: 'x' } },
    });
    assert.equal(notRouteable.status, 422, JSON.stringify(notRouteable.json));
    assert.equal(codeOf(notRouteable), 'TRANSITION_NOT_ROUTEABLE');

    // HUMAN_REQUIRED from MATCH_CONFIRMED is T7 and IS legal; the illegal pair is REQUEST_READY from a state
    // that has no such row — reached here by asking twice.
    const first = await call(app, 'PATCH', `/v1/cases/${caseId}`, {
      headers: { 'if-match': etag },
      body: { requestedTruthState: 'REQUEST_READY', reason: { code: 'PREPARE', detail: 'x' } },
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const second = await call(app, 'PATCH', `/v1/cases/${caseId}`, {
      headers: { 'if-match': String(first.headers['etag']) },
      body: { requestedTruthState: 'REQUEST_READY', reason: { code: 'PREPARE', detail: 'again' } },
    });
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.equal(codeOf(second), 'ILLEGAL_TRANSITION');
    assert.equal(detailsOf(second)['fromTruthState'], 'REQUEST_READY');
    assert.equal(detailsOf(second)['toTruthState'], 'REQUEST_READY');
  });

  test('a stale precondition is 412 with the current ETag, and nothing is written', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ caseState: 'MATCH_CONFIRMED' });
    const caseId = world.caseId as string;

    const missing = await call(app, 'PATCH', `/v1/cases/${caseId}`, {
      body: { requestedTruthState: 'REQUEST_READY', reason: { code: 'PREPARE', detail: 'x' } },
    });
    assert.equal(missing.status, 428, JSON.stringify(missing.json));
    assert.equal(codeOf(missing), 'PRECONDITION_REQUIRED');

    const stale = await call(app, 'PATCH', `/v1/cases/${caseId}`, {
      headers: { 'if-match': '"MATCH_CONFIRMED:1"' },
      body: { requestedTruthState: 'REQUEST_READY', reason: { code: 'PREPARE', detail: 'x' } },
    });
    assert.equal(stale.status, 412, JSON.stringify(stale.json));
    assert.equal(codeOf(stale), 'PRECONDITION_FAILED');
    assert.match(String(detailsOf(stale)['currentEtag']), /^"MATCH_CONFIRMED:\d+"$/);
    assert.deepEqual(transitionsFor(TENANT_A, caseId), []);
  });
});

describe('§5.7.5 human gates', () => {
  test('a gate is recorded, routed, and drives T7 from MATCH_CONFIRMED', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ caseState: 'MATCH_CONFIRMED' });
    const caseId = world.caseId as string;
    const etag = await etagOf(app, caseId);
    const detectedAt = new Date().toISOString();

    const response = await call(app, 'POST', `/v1/cases/${caseId}/human-gates`, {
      headers: { 'if-match': etag },
      body: { gateKind: 'CAPTCHA', detectedAt, attemptedBypass: false },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['truthState'], 'HUMAN_REQUIRED');
    assert.equal(response.json['transitionCode'], 'T7');
    assert.equal(response.json['humanQueue'], 'IDENTITY_VERIFICATION');
    const gateId = String(response.json['gateId']);
    // The service level is `detectedAt` plus the declared window for this kind, stored on the row.
    assert.equal(
      new Date(String(response.json['serviceLevelDueAt'])).getTime() - Date.parse(detectedAt),
      4 * 60 * 60 * 1000,
    );

    assert.deepEqual(stateOf(TENANT_A, caseId), ['HUMAN_REQUIRED']);
    assert.deepEqual(transitionsFor(TENANT_A, caseId), ['T7|PrepareRequest|HUMAN_REQUIRED']);
    assert.deepEqual(
      read(TENANT_A, `SELECT gate_kind || '|' || human_queue FROM human_gate WHERE id = '${gateId}'`),
      ['CAPTCHA|IDENTITY_VERIFICATION'],
    );

    // HUMAN_REQUIRED is a first-class outcome: §5.7.6's timeline carries the gate, and the transition entry is
    // the only one that reports a truth state.
    const timeline = await call(app, 'GET', `/v1/cases/${caseId}/timeline`);
    assert.equal(timeline.status, 200);
    const entries = timeline.json['data'] as Record<string, unknown>[];
    const gateEntry = entries.find((entry) => entry['kind'] === 'HUMAN_GATE');
    assert.ok(gateEntry !== undefined, 'the timeline has no HUMAN_GATE entry');
    assert.equal(gateEntry['refId'], gateId);
    assert.equal(gateEntry['truthStateAfter'], null);
    const transitionEntry = entries.find((entry) => entry['kind'] === 'TRANSITION');
    assert.equal(transitionEntry?.['truthStateAfter'], 'HUMAN_REQUIRED');
    assert.ok(
      entries.every((entry, index) => index === 0 || Date.parse(String(entries[index - 1]?.['at'])) <= Date.parse(String(entry['at']))),
      'the timeline is not in chronological order',
    );
  });

  test('a bypass attempt is refused, and neither a gate nor a transition is written', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ caseState: 'MATCH_CONFIRMED' });
    const caseId = world.caseId as string;
    const etag = await etagOf(app, caseId);

    const response = await call(app, 'POST', `/v1/cases/${caseId}/human-gates`, {
      headers: { 'if-match': etag },
      body: { gateKind: 'CAPTCHA', detectedAt: new Date().toISOString(), attemptedBypass: true },
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'BYPASS_ATTEMPT_REFUSED');
    assert.deepEqual(stateOf(TENANT_A, caseId), ['MATCH_CONFIRMED']);
    assert.deepEqual(read(TENANT_A, `SELECT id::text FROM human_gate WHERE case_id = '${caseId}'::uuid`), []);
    assert.deepEqual(transitionsFor(TENANT_A, caseId), []);
  });

  test('a gate kind nobody can be routed to is refused rather than stored', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ caseState: 'MATCH_CONFIRMED' });
    const caseId = world.caseId as string;
    const etag = await etagOf(app, caseId);

    const response = await call(app, 'POST', `/v1/cases/${caseId}/human-gates`, {
      headers: { 'if-match': etag },
      body: { gateKind: 'SOMETHING_ELSE', detectedAt: new Date().toISOString() },
    });
    assert.equal(response.status, 409, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'ILLEGAL_TRANSITION');
    assert.deepEqual(read(TENANT_A, `SELECT id::text FROM human_gate WHERE case_id = '${caseId}'::uuid`), []);
  });
});

describe('§5.7.2 and §5.7.3 the reads', () => {
  test('the list filters by subject, state and channel, and paginates without repeating a row', async () => {
    const app = serverFor(TENANT_A);
    // Three cases in one world is impossible (one live case per triple), so three separate worlds are created;
    // the filter that isolates them is the subject.
    const worlds = [
      newWorld({ caseState: 'MATCH_CONFIRMED' }),
      newWorld({ caseState: 'REQUEST_READY' }),
      newWorld({ caseState: 'HUMAN_REQUIRED' }),
    ];

    for (const world of worlds) {
      const listed = await call(app, 'GET', `/v1/cases?subjectId=${world.subjectId}`);
      assert.equal(listed.status, 200, JSON.stringify(listed.json));
      const rows = listed.json['data'] as Record<string, unknown>[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.['caseId'], world.caseId);
      assert.equal(rows[0]?.['channel'], 'OFFICIAL_SELF_SERVICE');
      assert.equal(typeof rows[0]?.['actionCount'], 'number');
      assert.equal(typeof rows[0]?.['verificationCount'], 'number');
    }

    const byState = await call(app, 'GET', '/v1/cases?truthState=HUMAN_REQUIRED&limit=100');
    assert.equal(byState.status, 200);
    const ids = (byState.json['data'] as Record<string, unknown>[]).map((row) => row['caseId']);
    assert.ok(ids.includes(worlds[2]?.caseId), 'the state filter lost the HUMAN_REQUIRED case');
    assert.ok(!ids.includes(worlds[0]?.caseId), 'the state filter returned a MATCH_CONFIRMED case');

    // The walk: page size 1 over the tenant's cases, each seen EXACTLY once. This is the assertion that caught
    // the µs/ms keyset defect on §5.11 (ASSUMPTIONS §3.26), re-exercised here.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      const url = `/v1/cases?limit=1${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response = await call(app, 'GET', url);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      const rows = response.json['data'] as Record<string, unknown>[];
      for (const row of rows) seen.push(String(row['caseId']));
      const pageInfo = response.json['page'] as { nextCursor?: unknown } | undefined;
      if (typeof pageInfo?.nextCursor !== 'string') break;
      cursor = pageInfo.nextCursor;
    }
    assert.equal(new Set(seen).size, seen.length, `a case was returned twice: ${JSON.stringify(seen)}`);
  });

  test('the detail reports the last transition, the counts and the evidence, and hides the row version', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ caseState: 'MATCH_CONFIRMED' });
    const caseId = world.caseId as string;

    const before = await call(app, 'GET', `/v1/cases/${caseId}`);
    assert.equal(before.status, 200, JSON.stringify(before.json));
    assert.equal(before.json['lastTransition'], null);
    assert.equal(Object.hasOwn(before.json, 'rowVersionMs'), false, 'the row version must not reach the body');
    assert.deepEqual(before.json['evidenceArtifactIds'], []);
    assert.equal((before.json['policyDecision'] as Record<string, unknown>)['legalBasis'], 'CCPA_DELETE');
    assert.equal((before.json['recipe'] as Record<string, unknown>)['signaturePresent'], true);

    const etag = await etagOf(app, caseId);
    const moved = await call(app, 'PATCH', `/v1/cases/${caseId}`, {
      headers: { 'if-match': etag },
      body: { requestedTruthState: 'REQUEST_READY', reason: { code: 'PREPARE', detail: 'x' } },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));

    const after = await call(app, 'GET', `/v1/cases/${caseId}`);
    assert.equal(after.json['truthState'], 'REQUEST_READY');
    const last = after.json['lastTransition'] as Record<string, unknown>;
    assert.equal(last['transitionCode'], 'T5');
    assert.equal(last['fromTruthState'], 'MATCH_CONFIRMED');
    assert.equal(last['toTruthState'], 'REQUEST_READY');
    assert.equal(last['command'], 'PrepareRequest');
    assert.ok(Date.parse(String(after.json['truthStateChangedAt'])) >= Date.parse(String(before.json['truthStateChangedAt'])));
  });

  test("another tenant sees 404 on every §5.7 route, and zero rows at the database layer", async () => {
    const appA = serverFor(TENANT_A);
    const appB = serverFor(TENANT_B);
    const world = newWorld({ caseState: 'MATCH_CONFIRMED' });
    const caseId = world.caseId as string;

    assert.equal((await call(appA, 'GET', `/v1/cases/${caseId}`)).status, 200);
    for (const url of [`/v1/cases/${caseId}`, `/v1/cases/${caseId}/timeline`]) {
      const response = await call(appB, 'GET', url);
      assert.equal(response.status, 404, `${url} answered ${String(response.status)} to the other tenant`);
      assert.equal(codeOf(response), 'RESOURCE_NOT_FOUND');
    }
    const write = await call(appB, 'PATCH', `/v1/cases/${caseId}`, {
      headers: { 'if-match': '"MATCH_CONFIRMED:1"' },
      body: { requestedTruthState: 'REQUEST_READY', reason: { code: 'PREPARE', detail: 'x' } },
    });
    assert.equal(write.status, 404, JSON.stringify(write.json));

    assert.deepEqual(read(TENANT_B, `SELECT c.id::text FROM request_case c WHERE c.id = '${caseId}'::uuid`), []);
    assert.deepEqual(read(TENANT_B, `SELECT a.id::text FROM audit_event a WHERE a.case_id = '${caseId}'::uuid`), []);
    const listed = await call(appB, 'GET', '/v1/cases?limit=100');
    const ids = (listed.json['data'] as Record<string, unknown>[]).map((row) => row['caseId']);
    assert.ok(!ids.includes(caseId), 'tenant B listed tenant A’s case');
  });
});
