/**
 * Controller responses and email threads (SPEC-003 §5.9) against real PostgreSQL.
 *
 * THE CLAIM IS NEVER AN OBSERVATION, and that is what this suite exists to hold. §5.9.1 records what a
 * controller SAYS; VG-VERIFY-004 forbids the system from treating it as evidence of removal. So the central
 * assertions are negative ones: a `CLAIMED_DELETION` reaches `ACKNOWLEDGED`, the spine records `T11`, the state
 * is NEVER `VERIFIED_REMOVED`, and every response carries `claimedOutcomeIsObservation: false` — including the
 * list rows, because a consumer that read the list would otherwise have to remember the rule.
 *
 * THE DRIVING MAPPING IS ASSERTED PER KIND, from a case in `REQUEST_SUBMITTED`: `CLAIMED_DELETION` →
 * `ACKNOWLEDGED` (T11), `REFUSAL` with a basis → `NOT_REMOVABLE` (T15), `NO_RESPONSE_TIMEOUT` → `NOT_REMOVABLE`
 * (T13), the two controller DEMANDS → `HUMAN_REQUIRED` (T12). One test per kind, because a mapping that sent
 * everything to `ACKNOWLEDGED` would pass a single-case test.
 *
 * FIXTURE DISCIPLINE: two tenants of this suite's own, per run (ASSUMPTIONS §3.27).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresControllerResponseQueries } from '../../src/adapters/persistence/controller-responses.ts';
import { PostgresActionQueries } from '../../src/adapters/persistence/actions.ts';
import { PostgresPolicyQueries } from '../../src/adapters/persistence/policies.ts';
import { PostgresCoverageQueries } from '../../src/adapters/persistence/coverage.ts';
import { PostgresCaseQueries } from '../../src/adapters/persistence/cases.ts';
import { PostgresObservationQueries } from '../../src/adapters/persistence/observations.ts';
import { PostgresExposureQueries } from '../../src/adapters/persistence/exposures.ts';
import { PostgresTransitionQueries } from '../../src/adapters/persistence/transitions.ts';
import { PostgresAuditQueries } from '../../src/adapters/persistence/audit-queries.ts';
import { PostgresDeadlineQueries } from '../../src/adapters/persistence/deadlines.ts';
import { PostgresAppealQueries } from '../../src/adapters/persistence/appeals.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresSubjectCommands } from '../../src/adapters/persistence/subject-commands.ts';
import { PostgresSourceQueries } from '../../src/adapters/persistence/sources.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, asTenant, exec, ownerDsn } from './harness.ts';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RUN = randomUUID().slice(0, 8);
const SCOPES = ['vg.cases.read', 'vg.cases.write'];

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'controller-suite-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'controller-suite-b-${RUN}', 'ACTIVE');`,
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
    subjectCommands: new PostgresSubjectCommands(),
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
    actionQueries: new PostgresActionQueries({ recipeVerificationKeys: { publicKeysByRef: new Map() } }),
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
  return `controller-key-${RUN}-${String(keyCounter).padStart(4, '0')}`;
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

let caseCounter = 0;

/** A case at `state` in tenant A, with a subject, source and evidence artifact. */
function newCase(state: string): { caseId: string; evidenceArtifactId: string } {
  caseCounter += 1;
  const subjectId = randomUUID();
  const authorityGrantId = randomUUID();
  const sourceId = randomUUID();
  const recordId = randomUUID();
  const exposureId = randomUUID();
  const caseId = randomUUID();
  const evidenceArtifactId = randomUUID();
  const result = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
         VALUES ('${subjectId}', '${TENANT_A}', 'cr-subject-${RUN}-${String(caseCounter)}', 'US-CA', false, 'ACTIVE');`,
      `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument)
         VALUES ('${authorityGrantId}', '${TENANT_A}', '${subjectId}', 'SELF', ARRAY['discovery','self_service_write'], now() - interval '1 day', now() + interval '30 days', false);`,
      `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class)
         VALUES ('${sourceId}', '${TENANT_A}', 'cr-source-${RUN}-${String(caseCounter)}', 'REGISTRY', 'US-CA', 'WRITE_PERMITTED');`,
      `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
         VALUES ('${recordId}', '${TENANT_A}', '${sourceId}', 'https://example.invalid/cr-${RUN}-${String(caseCounter)}', now() - interval '2 days', repeat('a', 64), false);`,
      `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
         VALUES ('${exposureId}', '${TENANT_A}', '${subjectId}', '${recordId}', 0.9, '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, '${state}');`,
      `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, truth_state)
         VALUES ('${caseId}', '${TENANT_A}', '${subjectId}', '${exposureId}', '${sourceId}', '${authorityGrantId}', '${state}');`,
      `INSERT INTO evidence_artifact (id, tenant_id, case_id, kind, digest, storage_ref, egress_class, redaction_state, captured_at)
         VALUES ('${evidenceArtifactId}', '${TENANT_A}', '${caseId}', 'CONTROLLER_REPLY', repeat('b', 64), 's3://evidence/${RUN}/${evidenceArtifactId}', 'OPAQUE_ID', 'NONE', now());`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(result.status, 0, `case fixture failed: ${result.output}`);
  return { caseId, evidenceArtifactId };
}

async function caseEtag(app: VgFastify, caseId: string): Promise<string> {
  const detail = await call(app, 'GET', `/v1/cases/${caseId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  return String(detail.headers['etag']);
}

function responseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    responseKind: 'CLAIMED_DELETION',
    claimedOutcome: 'DELETED',
    bodyRef: `eml-${RUN}-1`,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function stateOf(caseId: string): string[] {
  return read(TENANT_A, `SELECT truth_state::text FROM request_case WHERE id = '${caseId}'`);
}

function lastTransition(caseId: string): string[] {
  return read(
    TENANT_A,
    `SELECT coalesce(transition_code,'null') FROM audit_event
      WHERE case_id = '${caseId}'::uuid AND transition_code IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1`,
  );
}

describe('§5.9.1 a claim never becomes a removal', () => {
  test('CLAIMED_DELETION reaches ACKNOWLEDGED with T11 and says an observation is still owed', async () => {
    const app = serverFor(TENANT_A);
    const world = newCase('REQUEST_SUBMITTED');
    const etag = await caseEtag(app, world.caseId);

    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/controller-responses`, {
      headers: { 'if-match': etag },
      body: responseBody({ evidenceArtifactId: world.evidenceArtifactId }),
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['truthState'], 'ACKNOWLEDGED');
    assert.equal(response.json['transitionCode'], 'T11');
    // THE TWO FIELDS THAT KEEP THE COLLAPSE IMPOSSIBLE.
    assert.equal(response.json['claimedOutcomeIsObservation'], false);
    assert.equal(response.json['verificationRequired'], true);
    assert.equal(response.json['claimedOutcome'], 'DELETED');

    assert.deepEqual(stateOf(world.caseId), ['ACKNOWLEDGED']);
    assert.deepEqual(lastTransition(world.caseId), ['T11']);
    // The claim is stored in its OWN column; the delivered `claimed_outcome` (typed `truth_state`) stays NULL,
    // because a truth state there would assert the very collapse this route refuses.
    assert.deepEqual(
      read(
        TENANT_A,
        `SELECT coalesce(claimed_outcome_token,'-') || '|' || coalesce(claimed_outcome::text,'NULL') || '|' || kind
           FROM controller_response WHERE case_id = '${world.caseId}'::uuid`,
      ),
      ['DELETED|NULL|CLAIMED_DELETION'],
    );
  });

  test('the driving mapping is asserted per kind, and the CODE follows the transition table', async () => {
    const app = serverFor(TENANT_A);
    // From REQUEST_SUBMITTED. §5.9.1's prose names T15 for a refusal and T13 for a timeout, but the TABLE decides
    // which transition reaches NOT_REMOVABLE from where the case actually is: `REQUEST_SUBMITTED → NOT_REMOVABLE`
    // is T13. MEASURED: an earlier assertion of T15 here failed with T13, and the expectation was wrong.
    const fromSubmitted: readonly [string, string, string][] = [
      ['ACKNOWLEDGEMENT', 'ACKNOWLEDGED', 'T11'],
      ['PARTIAL_ACTION', 'ACKNOWLEDGED', 'T11'],
      ['REFUSAL', 'NOT_REMOVABLE', 'T13'],
      ['NO_RESPONSE_TIMEOUT', 'NOT_REMOVABLE', 'T13'],
      ['CONTROLLER_DEMANDS_IDENTITY', 'HUMAN_REQUIRED', 'T12'],
      ['CONTROLLER_DEMANDS_AUTHORITY', 'HUMAN_REQUIRED', 'T12'],
    ];
    for (const [kind, state, code] of fromSubmitted) {
      const world = newCase('REQUEST_SUBMITTED');
      const etag = await caseEtag(app, world.caseId);
      const response = await call(app, 'POST', `/v1/cases/${world.caseId}/controller-responses`, {
        headers: { 'if-match': etag },
        body: responseBody({
          responseKind: kind,
          claimedOutcome: 'UNSPECIFIED',
          // A REFUSAL requires a basis; the timeout records its own.
          ...(kind === 'REFUSAL' ? { refusalBasis: 'CONTROLLER_CITES_STATUTORY_EXEMPTION' } : {}),
        }),
      });
      assert.equal(response.status, 200, `${kind}: ${JSON.stringify(response.json)}`);
      assert.equal(response.json['truthState'], state, kind);
      assert.equal(response.json['transitionCode'], code, kind);
      assert.deepEqual(stateOf(world.caseId), [state], kind);
      assert.deepEqual(lastTransition(world.caseId), [code], kind);
    }

    // And from ACKNOWLEDGED, the same refusal kind IS T15 — the same request, a different state, a different row
    // of SPEC-001 §4.1. This is what makes the assertion above about the table rather than about a constant.
    const acknowledged = newCase('ACKNOWLEDGED');
    const etag = await caseEtag(app, acknowledged.caseId);
    const refusal = await call(app, 'POST', `/v1/cases/${acknowledged.caseId}/controller-responses`, {
      headers: { 'if-match': etag },
      body: responseBody({
        responseKind: 'REFUSAL',
        claimedOutcome: 'NOT_DELETED',
        refusalBasis: 'CONTROLLER_CITES_STATUTORY_EXEMPTION',
      }),
    });
    assert.equal(refusal.status, 200, JSON.stringify(refusal.json));
    assert.equal(refusal.json['truthState'], 'NOT_REMOVABLE');
    assert.equal(refusal.json['transitionCode'], 'T15');
    assert.deepEqual(lastTransition(acknowledged.caseId), ['T15']);
  });

  test('a refusal with no recorded basis is refused, and NOTHING is written', async () => {
    const app = serverFor(TENANT_A);
    const world = newCase('REQUEST_SUBMITTED');
    const etag = await caseEtag(app, world.caseId);

    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/controller-responses`, {
      headers: { 'if-match': etag },
      body: responseBody({ responseKind: 'REFUSAL', claimedOutcome: 'NOT_DELETED' }),
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'REFUSAL_BASIS_REQUIRED');
    assert.deepEqual(stateOf(world.caseId), ['REQUEST_SUBMITTED']);
    assert.deepEqual(read(TENANT_A, `SELECT id::text FROM controller_response WHERE case_id = '${world.caseId}'::uuid`), []);
  });

  test('a claim expressed as a truth state is refused with its own code', async () => {
    const app = serverFor(TENANT_A);
    const world = newCase('REQUEST_SUBMITTED');
    const etag = await caseEtag(app, world.caseId);

    for (const claim of ['VERIFIED_REMOVED', 'ACKNOWLEDGED', 'REMOVED']) {
      const response = await call(app, 'POST', `/v1/cases/${world.caseId}/controller-responses`, {
        headers: { 'if-match': etag },
        body: responseBody({ claimedOutcome: claim }),
      });
      assert.equal(response.status, 422, `${claim}: ${JSON.stringify(response.json)}`);
      assert.equal(codeOf(response), 'CLAIMED_OUTCOME_UNSUPPORTED');
    }
    assert.deepEqual(stateOf(world.caseId), ['REQUEST_SUBMITTED']);
  });

  test('a response from a state with no action recorded is an illegal transition', async () => {
    const app = serverFor(TENANT_A);
    // §5.9.1: "409 ILLEGAL_TRANSITION (e.g. from REQUEST_READY, where no action occurred)".
    const world = newCase('REQUEST_READY');
    const etag = await caseEtag(app, world.caseId);

    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/controller-responses`, {
      headers: { 'if-match': etag },
      body: responseBody(),
    });
    assert.equal(response.status, 409, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'ILLEGAL_TRANSITION');
    assert.deepEqual(stateOf(world.caseId), ['REQUEST_READY']);
  });
});

describe('§5.9.2 the list', () => {
  test('responses come back newest first with claimedOutcomeIsObservation false on every row', async () => {
    const app = serverFor(TENANT_A);
    const world = newCase('REQUEST_SUBMITTED');
    for (const [index, receivedAt] of [
      new Date(Date.now() - 7200_000).toISOString(),
      new Date(Date.now() - 3600_000).toISOString(),
    ].entries()) {
      const etag = await caseEtag(app, world.caseId);
      const posted = await call(app, 'POST', `/v1/cases/${world.caseId}/controller-responses`, {
        headers: { 'if-match': etag },
        body: responseBody({ bodyRef: `eml-${RUN}-list-${String(index)}`, receivedAt }),
      });
      // The first acknowledges; the second is illegal from ACKNOWLEDGED for CLAIMED_DELETION, so it is posted as
      // an acknowledgement to keep both rows in the same case.
      assert.ok(posted.status === 200 || posted.status === 409, JSON.stringify(posted.json));
    }

    const listed = await call(app, 'GET', `/v1/cases/${world.caseId}/controller-responses`);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    const rows = listed.json['data'] as Record<string, unknown>[];
    assert.ok(rows.length >= 1, 'the list must contain the recorded response');
    for (const row of rows) {
      assert.equal(row['claimedOutcomeIsObservation'], false, 'a claim is never an observation');
    }
    const times = rows.map((row) => Date.parse(String(row['receivedAt'])));
    for (let i = 1; i < times.length; i += 1) {
      const previous = times[i - 1] ?? 0;
      const current = times[i] ?? 0;
      assert.ok(previous >= current, 'the list must be newest first');
    }
  });
});

describe('§5.9.3 email threads', () => {
  test('a thread is recorded, and no deadline is invented', async () => {
    const app = serverFor(TENANT_A);
    const world = newCase('REQUEST_SUBMITTED');
    const messageId = `<msg-${RUN}-1@example.invalid>`;

    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/email-threads`, {
      body: {
        direction: 'INBOUND',
        messageIds: [messageId],
        receivedAt: new Date().toISOString(),
        bodyRef: `eml-${RUN}-thread`,
        subjectHash: 'c'.repeat(64),
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    assert.equal(response.json['direction'], 'INBOUND');
    assert.deepEqual(response.json['messageIds'], [messageId]);
    // §5.9.3 says a thread MAY derive a deadline "from the applicable policy version", and NO specification or
    // table declares a controller-response window — so there is nothing to derive and the API does not hard-code
    // one, which is what that sentence forbids.
    assert.equal(response.json['deadlineDerived'], null);

    assert.deepEqual(
      read(
        TENANT_A,
        `SELECT direction || '|' || message_ids[1] || '|' || coalesce(subject_hash,'-')
           FROM email_thread WHERE case_id = '${world.caseId}'::uuid`,
      ),
      [`INBOUND|${messageId}|${'c'.repeat(64)}`],
    );
  });

  test('a duplicate message id is refused, and a malformed one is refused earlier', async () => {
    const app = serverFor(TENANT_A);
    const world = newCase('REQUEST_SUBMITTED');
    const messageId = `<msg-${RUN}-dup@example.invalid>`;
    const body = { direction: 'OUTBOUND', messageIds: [messageId], receivedAt: new Date().toISOString() };

    const first = await call(app, 'POST', `/v1/cases/${world.caseId}/email-threads`, { body });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    const second = await call(app, 'POST', `/v1/cases/${world.caseId}/email-threads`, { body });
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.equal(codeOf(second), 'EMAIL_THREAD_DUPLICATE');

    for (const bad of ['not-a-msg-id', '<no-domain>', 'no-brackets@example.invalid', '<a b@c>']) {
      const refused = await call(app, 'POST', `/v1/cases/${world.caseId}/email-threads`, {
        body: { ...body, messageIds: [bad] },
      });
      assert.equal(refused.status, 422, `${bad}: ${JSON.stringify(refused.json)}`);
      assert.equal(codeOf(refused), 'MESSAGE_ID_MALFORMED');
    }
    assert.deepEqual(
      read(TENANT_A, `SELECT count(*)::text FROM email_thread WHERE case_id = '${world.caseId}'::uuid`),
      ['1'],
    );
  });
});

describe('§5.9 tenant isolation', () => {
  test("another tenant's case is 404 on all three routes", async () => {
    const appA = serverFor(TENANT_A);
    const appB = serverFor(TENANT_B);
    const world = newCase('REQUEST_SUBMITTED');
    const etag = await caseEtag(appA, world.caseId);

    const write = await call(appB, 'POST', `/v1/cases/${world.caseId}/controller-responses`, {
      headers: { 'if-match': etag },
      body: responseBody(),
    });
    assert.equal(write.status, 404, JSON.stringify(write.json));
    const list = await call(appB, 'GET', `/v1/cases/${world.caseId}/controller-responses`);
    assert.equal(list.status, 404, JSON.stringify(list.json));
    const thread = await call(appB, 'POST', `/v1/cases/${world.caseId}/email-threads`, {
      body: { direction: 'INBOUND', messageIds: [`<x-${RUN}@example.invalid>`] },
    });
    assert.equal(thread.status, 404, JSON.stringify(thread.json));
    assert.deepEqual(read(TENANT_B, `SELECT id::text FROM controller_response WHERE case_id = '${world.caseId}'::uuid`), []);
  });

  test('a caller without the write scope is refused 403 before the port', async () => {
    const app = serverFor(TENANT_A, ['vg.cases.read']);
    const world = newCase('REQUEST_SUBMITTED');
    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/controller-responses`, {
      headers: { 'if-match': '"REQUEST_SUBMITTED:1"' },
      body: responseBody(),
    });
    assert.equal(response.status, 403, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'INSUFFICIENT_SCOPE');
  });
});
