/**
 * Deadlines against real PostgreSQL (SPEC-003 §5.13, VG-POLICY-001).
 *
 * EVERY assertion runs through the real HTTP boundary and the real `PostgresDeadlineQueries`. The
 * credential-free half (`tests/contract/deadline-routes.test.ts`) proves the boundary rules — closed
 * vocabularies, `DEADLINE_SOURCE_REQUIRED`, `DEADLINE_IN_PAST`, the unreachability of `WAIVED` — and can prove
 * nothing about the PROVENANCE JOIN, which is what this file exists for:
 *
 *   * Every created deadline reports `derivedFrom{policyVersion, ruleCode}` taken from the case's own
 *     `PolicyDecision`, so §5.13.1's "Every deadline names the policy version and rule code it was derived
 *     from" holds — and it holds from real data, not from a code constant.
 *   * `derivation_ref` keeps its `policy:%` form (the CHECK requires it) while §5.13.2's out-of-band `source`
 *     lands in `derivation_input`, so the two facts stay distinguishable: the deadline derives from the policy
 *     version AND was dated by the controller.
 *   * `state` is derived on every read: a deadline whose due instant has passed reports BREACHED, and
 *     satisfying it reports SATISFIED — asserted by inserting the past row directly, because no route can
 *     create one (`DEADLINE_IN_PAST`) and waiting is not a test.
 *   * `DEADLINE_ALREADY_SATISFIED`, `EVIDENCE_NOT_FOUND` and cross-tenant 404s are all exercised.
 *
 * THE FIXTURE. `db/seed/prior_release.sql` gives tenant A case `77777777-…` with a `PolicyDecision`
 * (`policy_version = 1`, `legal_basis = 'CCPA_DELETE'`) and one `evidence_artifact`
 * `44444444-…`. Tenant B has neither, which is what makes the cross-tenant assertions real rather than
 * artefacts. `deadline` has no natural key, so each created row is distinct across runs.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN, testWebhookDependencies } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresDeadlineQueries } from '../../src/adapters/persistence/deadlines.ts';
import { PostgresAuditQueries } from '../../src/adapters/persistence/audit-queries.ts';
import { PostgresObservationQueries } from '../../src/adapters/persistence/observations.ts';
import { PostgresExposureQueries } from '../../src/adapters/persistence/exposures.ts';
import { PostgresTransitionQueries } from '../../src/adapters/persistence/transitions.ts';
import { PostgresCaseQueries } from '../../src/adapters/persistence/cases.ts';
import { PostgresControllerResponseQueries } from '../../src/adapters/persistence/controller-responses.ts';
import { PostgresActionQueries } from '../../src/adapters/persistence/actions.ts';
import { PostgresPolicyQueries } from '../../src/adapters/persistence/policies.ts';
import { PostgresCoverageQueries } from '../../src/adapters/persistence/coverage.ts';
import { PostgresEvidenceQueries } from '../../src/adapters/persistence/evidence.ts';
import { PostgresDiscoveryQueries } from '../../src/adapters/persistence/discovery.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresSubjectCommands } from '../../src/adapters/persistence/subject-commands.ts';
import { PostgresSourceQueries } from '../../src/adapters/persistence/sources.ts';
import { PostgresAppealQueries } from '../../src/adapters/persistence/appeals.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, asTenant, exec, ownerDsn } from './harness.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CASE_A = '77777777-1111-4111-8111-777777777777';
const ARTIFACT_A = '44444444-1111-4111-8111-444444444444';
const ABSENT = '00000000-0000-4000-8000-000000000000';

/** The provenance the seeded case's decision supplies — asserted, not assumed. */
const EXPECTED_PROVENANCE = { policyVersion: '1', ruleCode: 'CCPA_DELETE' };

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
});

after(async () => {
  await runner.close();
});

function serverFor(tenantId: string, scopes: readonly string[]): VgFastify {
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
    recipeVerificationKeys: { publicKeysByRef: new Map<string, string>() },
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
    evidenceQueries: new PostgresEvidenceQueries(),
    discoveryQueries: new PostgresDiscoveryQueries(),
    ...testWebhookDependencies(),
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
  });
}

const READ = ['vg.cases.read'];
const WRITE = ['vg.cases.write'];

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

/** A per-run unique key suffix: a counter alone makes a suite pass exactly once (ASSUMPTIONS §3.22). */
const RUN = randomUUID().slice(0, 8);
let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `deadline-db-key-${RUN}-${String(keyCounter).padStart(4, '0')}`;
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

/**
 * The case's CURRENT ETag, obtained the way §2.7 tells a client to: send a deliberately stale `If-Match` and
 * take `currentEtag` from the 412. §5.13.1 does not return a case token, so this is the only implemented
 * source — and it keeps the helper on implemented behaviour rather than on the database's own arithmetic.
 */
async function caseEtag(app: VgFastify, caseId: string): Promise<string> {
  const probe = await call(app, 'POST', `/v1/cases/${caseId}/deadlines`, {
    body: validBody(),
    headers: { 'if-match': '"REQUEST_READY:0"' },
  });
  assert.equal(probe.status, 412, `expected a stale-token refusal, got: ${JSON.stringify(probe.json)}`);
  const error = probe.json['error'] as Record<string, unknown>;
  const details = error['details'] as Record<string, unknown>;
  const current = String(details['currentEtag']);
  assert.match(current, /^"REQUEST_READY:\d+"$/, `unexpected case ETag: ${current}`);
  return current;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // `MAIL_RESPONSE` and NOT `APPEAL_WINDOW`, DELIBERATELY. MEASURED COLLISION: `appeal-escalations.test.ts`
    // scopes its fixture surgery to `kind = 'APPEAL_WINDOW'` on this same seeded case — it must be able to
    // assert "this case has no appeal window" for its own `APPEAL_WINDOW_CLOSED` tests — while
    // `node --test` runs these two files in parallel. Creating `APPEAL_WINDOW` deadlines here meant the
    // appeal suite deleted them mid-test, and three of §5.13.3's tests failed with a lookup that returned no
    // row. The kind is not what this suite is testing (it tests provenance, derivation and satisfaction), so
    // it uses a kind the other file does not touch. A suite that needs a shared table must pick the part of
    // it nobody else owns.
    kind: 'MAIL_RESPONSE',
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    source: 'CONTROLLER_STATED_DATE',
    evidenceArtifactId: ARTIFACT_A,
    ...overrides,
  };
}

/** Create a deadline through the API and return the created DTO. */
async function createDeadline(app: VgFastify, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await call(app, 'POST', `/v1/cases/${CASE_A}/deadlines`, {
    body: validBody(overrides),
    headers: { 'if-match': await caseEtag(app, CASE_A) },
  });
  assert.equal(res.status, 201, `create failed: ${JSON.stringify(res.json)}`);
  return res.json;
}

/** Insert a deadline directly, so a due instant in the PAST can be tested without waiting. */
function insertPastDeadline(id: string): void {
  const inserted = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO deadline (id, tenant_id, case_id, kind, due_at, derivation_ref, derivation_input, evidence_artifact_id)
       VALUES ('${id}', '${TENANT_A}', '${CASE_A}', 'MAIL_RESPONSE', now() - interval '2 hours',
               'policy:1', 'CONTROLLER_STATED_DATE', '${ARTIFACT_A}');`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(inserted.status, 0, `could not insert the past deadline:\n${inserted.output}`);
}

describe('§5.13.2 creates a real deadline with its policy provenance', () => {
  test('the seeded case’s decision supplies derivedFrom, and derivation_ref keeps its policy: form', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const created = await createDeadline(app);

    assert.equal(created['caseId'], CASE_A);
    assert.equal(created['kind'], 'MAIL_RESPONSE');
    // §5.13.1's rule, satisfied from the case's own decision rather than from a code constant.
    assert.deepEqual(created['derivedFrom'], EXPECTED_PROVENANCE, 'derivedFrom must come from the PolicyDecision');
    assert.equal(created['state'], 'OPEN');
    assert.equal(created['satisfiedAt'], null);
    assert.equal(created['overdueSeconds'], 0);

    // The DATABASE holds BOTH facts distinctly: `derivation_ref` names the policy version (SPEC-001 §3.4's
    // `Deadline.source`), and `derivation_input` names the out-of-band input §5.13.2's `source` records.
    // Collapsing them into one column is what a first design would do, and it would lose the answer to
    // "which policy version" the moment a controller supplied the date.
    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT derivation_ref || '|' || coalesce(derivation_input, '-') || '|' || evidence_artifact_id::text
         FROM deadline WHERE id = '${String(created['deadlineId'])}';`,
    );
    assert.equal(rows[0], `policy:1|CONTROLLER_STATED_DATE|${ARTIFACT_A}`);
    await app.close();
  });

  test('the provenance really comes from the decision: changing it changes derivedFrom', async () => {
    // The control for the assertion above. Without it, `derivedFrom` could be a constant that happens to
    // match the seed — and "every deadline names the policy version it derived from" would be satisfied by
    // hard-coding the wrong version. The decision is mutated and RESTORED, with both asserted.
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const original = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT policy_version::text || '|' || legal_basis FROM policy_decision WHERE case_id = '${CASE_A}';`,
    );
    assert.equal(original[0], '1|CCPA_DELETE', 'the fixture must start as this test assumes');

    const mutated = exec(
      ownerDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
        `UPDATE policy_decision SET policy_version = 7, legal_basis = 'GDPR_ERASURE' WHERE case_id = '${CASE_A}';`,
        'COMMIT;',
      ].join('\n'),
    );
    assert.equal(mutated.status, 0, `could not mutate the decision:\n${mutated.output}`);

    try {
      const created = await createDeadline(app);
      assert.deepEqual(created['derivedFrom'], { policyVersion: '7', ruleCode: 'GDPR_ERASURE' });
      const rows = asTenant(
        appDsn(),
        TENANT_A,
        `SELECT derivation_ref FROM deadline WHERE id = '${String(created['deadlineId'])}';`,
      );
      assert.equal(rows[0], 'policy:7', 'derivation_ref must follow the version actually used');
    } finally {
      const restored = exec(
        ownerDsn(),
        [
          'BEGIN;',
          `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
          `UPDATE policy_decision SET policy_version = 1, legal_basis = 'CCPA_DELETE' WHERE case_id = '${CASE_A}';`,
          'COMMIT;',
        ].join('\n'),
      );
      assert.equal(restored.status, 0, `could not restore the decision:\n${restored.output}`);
      const after = asTenant(
        ownerDsn(),
        TENANT_A,
        `SELECT policy_version::text || '|' || legal_basis FROM policy_decision WHERE case_id = '${CASE_A}';`,
      );
      assert.equal(after[0], '1|CCPA_DELETE', 'the fixture must be restored, or later runs fail');
    }
    await app.close();
  });

  test('an absent evidence artifact is 422 EVIDENCE_NOT_FOUND, and no row is written', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const before = asTenant(appDsn(), TENANT_A, 'SELECT count(*)::text FROM deadline;');

    const res = await call(app, 'POST', `/v1/cases/${CASE_A}/deadlines`, {
      body: validBody({ evidenceArtifactId: ABSENT }),
      headers: { 'if-match': await caseEtag(app, CASE_A) },
    });
    assert.equal(res.status, 422, JSON.stringify(res.json));
    assert.equal(codeOf(res), 'EVIDENCE_NOT_FOUND');

    const after = asTenant(appDsn(), TENANT_A, 'SELECT count(*)::text FROM deadline;');
    assert.equal(after[0], before[0], 'a refused create must write nothing');
    await app.close();
  });

  test('a stale If-Match is 412 with the CURRENT token', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const res = await call(app, 'POST', `/v1/cases/${CASE_A}/deadlines`, {
      body: validBody(),
      headers: { 'if-match': '"REQUEST_READY:1"' },
    });
    assert.equal(res.status, 412, JSON.stringify(res.json));
    assert.equal(codeOf(res), 'PRECONDITION_FAILED');
    const details = (res.json['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
    assert.equal(String(details['currentEtag']), await caseEtag(app, CASE_A));
    await app.close();
  });
});

describe('§5.13.1 lists deadlines with their derived state', () => {
  test('a past-due deadline reports BREACHED with its overdue seconds', async () => {
    const id = randomUUID();
    insertPastDeadline(id);

    const app = serverFor(TENANT_A, READ);
    const res = await call(app, 'GET', `/v1/cases/${CASE_A}/deadlines`);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const data = res.json['data'] as Record<string, unknown>[];
    const row = data.find((r) => r['deadlineId'] === id);
    assert.ok(row !== undefined, 'the inserted deadline must be listed');

    // `state` and `overdueSeconds` are derived on READ, so nothing wrote BREACHED anywhere: the row was
    // created 2 hours overdue and the clock decides. That is why there is no `state` column.
    assert.equal(row['state'], 'BREACHED');
    assert.ok(Number(row['overdueSeconds']) >= 7200, `expected at least 7200s overdue, got ${String(row['overdueSeconds'])}`);
    assert.equal(row['satisfiedAt'], null);
    assert.deepEqual(row['derivedFrom'], EXPECTED_PROVENANCE);
    await app.close();
  });

  test('the list is ordered soonest first, so the next deadline is the first row', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    // Two deadlines, the sooner created second, so creation order and due order disagree.
    await createDeadline(app, { dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    await createDeadline(app, { dueAt: new Date(Date.now() + 86_400_000).toISOString(), kind: 'VERIFICATION_WINDOW' });

    const listed = await call(app, 'GET', `/v1/cases/${CASE_A}/deadlines`);
    const data = listed.json['data'] as Record<string, unknown>[];
    const dueAt = data.map((row) => Date.parse(String(row['dueAt'])));
    for (let i = 1; i < dueAt.length; i += 1) {
      assert.ok(
        (dueAt[i] ?? 0) >= (dueAt[i - 1] ?? 0),
        `the list must be soonest-first; position ${String(i)} is out of order`,
      );
    }
    await app.close();
  });

  test('another tenant’s case is 404 on the list, not an empty list', async () => {
    const appB = serverFor(TENANT_B, READ);
    const res = await call(appB, 'GET', `/v1/cases/${CASE_A}/deadlines`);
    assert.equal(res.status, 404, JSON.stringify(res.json));
    await appB.close();
  });
});

describe('§5.13.3 satisfaction', () => {
  test('satisfying a deadline reports SATISFIED and the row reflects it afterwards', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const created = await createDeadline(app);
    const id = String(created['deadlineId']);
    const satisfiedAt = new Date().toISOString();

    const satisfied = await call(app, 'POST', `/v1/deadlines/${id}/satisfaction`, {
      body: { satisfiedAt, satisfiedBy: 'operator-0001', evidenceArtifactId: ARTIFACT_A },
    });
    assert.equal(satisfied.status, 200, JSON.stringify(satisfied.json));
    assert.deepEqual(satisfied.json, {
      deadlineId: id,
      state: 'SATISFIED',
      satisfiedAt: new Date(satisfiedAt).toISOString(),
    });

    // The DATABASE holds the satisfier, and §5.13.1's read now derives SATISFIED from it.
    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT coalesce(satisfied_by, '-') || '|' || (satisfied_at IS NOT NULL)::text FROM deadline WHERE id = '${id}';`,
    );
    assert.equal(rows[0], 'operator-0001|true');

    const listed = await call(app, 'GET', `/v1/cases/${CASE_A}/deadlines`);
    const row = (listed.json['data'] as Record<string, unknown>[]).find((r) => r['deadlineId'] === id);
    assert.equal(row?.['state'], 'SATISFIED');
    assert.equal(row?.['overdueSeconds'], 0, 'a satisfied deadline is not overdue');
    await app.close();
  });

  test('satisfying twice is 409 DEADLINE_ALREADY_SATISFIED, and the first satisfier survives', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const created = await createDeadline(app);
    const id = String(created['deadlineId']);

    const first = await call(app, 'POST', `/v1/deadlines/${id}/satisfaction`, {
      body: { satisfiedAt: new Date().toISOString(), satisfiedBy: 'first-operator', evidenceArtifactId: ARTIFACT_A },
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));

    const second = await call(app, 'POST', `/v1/deadlines/${id}/satisfaction`, {
      body: { satisfiedAt: new Date().toISOString(), satisfiedBy: 'second-operator', evidenceArtifactId: ARTIFACT_A },
    });
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.equal(codeOf(second), 'DEADLINE_ALREADY_SATISFIED');

    // The SECOND satisfier must not have overwritten the first: "who satisfied this" is the fact the
    // already-satisfied refusal exists to protect.
    const rows = asTenant(appDsn(), TENANT_A, `SELECT coalesce(satisfied_by, '-') FROM deadline WHERE id = '${id}';`);
    assert.equal(rows[0], 'first-operator');
    await app.close();
  });

  test('an absent artifact or deadline is refused with the right code', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const created = await createDeadline(app);
    const id = String(created['deadlineId']);

    const badArtifact = await call(app, 'POST', `/v1/deadlines/${id}/satisfaction`, {
      body: { satisfiedAt: new Date().toISOString(), satisfiedBy: 'operator-0001', evidenceArtifactId: ABSENT },
    });
    assert.equal(badArtifact.status, 422, JSON.stringify(badArtifact.json));
    assert.equal(codeOf(badArtifact), 'EVIDENCE_NOT_FOUND');

    const badDeadline = await call(app, 'POST', `/v1/deadlines/${ABSENT}/satisfaction`, {
      body: { satisfiedAt: new Date().toISOString(), satisfiedBy: 'operator-0001', evidenceArtifactId: ARTIFACT_A },
    });
    assert.equal(badDeadline.status, 404, JSON.stringify(badDeadline.json));
    await app.close();
  });

  test('another tenant cannot satisfy tenant A’s deadline', async () => {
    const appA = serverFor(TENANT_A, [...WRITE, ...READ]);
    const created = await createDeadline(appA);
    await appA.close();

    const appB = serverFor(TENANT_B, WRITE);
    const res = await call(appB, 'POST', `/v1/deadlines/${String(created['deadlineId'])}/satisfaction`, {
      body: { satisfiedAt: new Date().toISOString(), satisfiedBy: 'operator-b', evidenceArtifactId: ARTIFACT_A },
    });
    // 404 and not 403: another tenant's deadline must be indistinguishable from an absent one (SPEC-006 H-9).
    assert.equal(res.status, 404, JSON.stringify(res.json));

    const rows = asTenant(appDsn(), TENANT_A, `SELECT (satisfied_at IS NULL)::text FROM deadline WHERE id = '${String(created['deadlineId'])}';`);
    assert.equal(rows[0], 'true', 'the cross-tenant attempt must not have satisfied it');
    await appB.close();
  });
});
