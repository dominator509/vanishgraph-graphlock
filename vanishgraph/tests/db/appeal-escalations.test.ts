/**
 * The §5.14 appeal-escalation group against real PostgreSQL (SPEC-003 §5.14).
 *
 * EVERY assertion runs through the real HTTP boundary and the real `PostgresAppealQueries` against the
 * database provisioned by `sh scripts/db-provision.sh`. The credential-free half
 * (`tests/contract/appeal-routes.test.ts`) proves only that the refusals are boundary rules; it can prove
 * nothing about persistence, the review-state invariant, or isolation.
 *
 * WHAT THIS SUITE PROVES, per SPEC-003 §5.14.1/§5.14.2 and VG-CHANNEL-001:
 *
 *   * Creating an escalation STORES the review state and returns it — and the state is exactly the one
 *     SPEC-003 names, enforced by the column's CHECK so a later node cannot write another silently.
 *   * `externalEffect: false` is reported on creation because creating does not send anything.
 *   * `409 APPEAL_WINDOW_CLOSED` fires for a case whose `APPEAL_WINDOW` deadline has passed, and does NOT
 *     fire for a case with no such deadline — the second half matters, because the opposite reading would
 *     refuse every escalation on a case that never had a deadline.
 *   * The `If-Match` precondition is §2.7's case ETag, and a stale token is refused with the CURRENT token
 *     in the body.
 *   * Another tenant's case is `404` with an indistinguishable body, and the database layer returns zero
 *     rows for it independently.
 *
 * THE FIXTURE IS THE SEEDED CASE. `db/seed/prior_release.sql` creates case
 * `77777777-1111-4111-8111-777777777777` for tenant A (`REQUEST_READY`), and no case for tenant B — which
 * is what makes the cross-tenant case a real 404 rather than an artefact. Escalations created here use a
 * fresh `artifactIds` UUID per test, and `appeal_escalation` has no natural key, so repeated runs cannot
 * collide.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresAppealQueries } from '../../src/adapters/persistence/appeals.ts';
import { PostgresDeadlineQueries } from '../../src/adapters/persistence/deadlines.ts';
import { PostgresAuditQueries } from '../../src/adapters/persistence/audit-queries.ts';
import { PostgresObservationQueries } from '../../src/adapters/persistence/observations.ts';
import { PostgresExposureQueries } from '../../src/adapters/persistence/exposures.ts';
import { PostgresTransitionQueries } from '../../src/adapters/persistence/transitions.ts';
import { PostgresCaseQueries } from '../../src/adapters/persistence/cases.ts';
import { PostgresControllerResponseQueries } from '../../src/adapters/persistence/controller-responses.ts';
import { PostgresActionQueries } from '../../src/adapters/persistence/actions.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresSourceQueries } from '../../src/adapters/persistence/sources.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, asTenant, exec, ownerDsn } from './harness.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CASE_A = '77777777-1111-4111-8111-777777777777';
const ABSENT = '00000000-0000-4000-8000-000000000000';

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
});

after(async () => {
  await runner.close();
});

/** A server wired as the composition root wires it, with the REAL ports. */
function serverFor(tenantId: string, scopes: readonly string[], authTimeAgeSeconds = 0): VgFastify {
  return buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({ tenantId, scopes, authTimeAgeSeconds }),
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
    caseQueries: new PostgresCaseQueries({ recipeVerificationKeys: { publicKeysByRef: new Map() } }),
    controllerResponseQueries: new PostgresControllerResponseQueries(),
    actionQueries: new PostgresActionQueries({ recipeVerificationKeys: { publicKeysByRef: new Map() } }),
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
  });
}

const READ = ['vg.cases.read'];
const WRITE = ['vg.appeal.write'];

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

/**
 * A per-RUN unique suffix for idempotency keys.
 *
 * WITHOUT THIS THE SUITE PASSES EXACTLY ONCE, and the failure is a `409 IDEMPOTENCY_KEY_REUSE` that looks
 * like a product bug. MEASURED: keys were `appeal-db-key-000001`, `...000002`, … from a counter that
 * restarts at 1 in every process, while `http_idempotency` retains a completed key for 24 hours
 * (`IDEMPOTENCY_RETENTION_MS`). The second run therefore presented a key the first run had already used —
 * with a DIFFERENT body, because `validBody()` mints a fresh `artifactIds` UUID each time — and the store
 * refused it exactly as SPEC-003 §4.3 requires.
 *
 * This is the same defect class as `ASSUMPTIONS.md` §3.7's counter-based fixture ids, and it explains a
 * confusing symptom: `test-integration` failed 8 tests in its guard run and passed in the direct run
 * immediately after, because those are two invocations of the same file and the first one consumed the
 * keys. The suffix keeps the key inside SPEC-003 §4.2's 16–255 character `[A-Za-z0-9._:-]` charset.
 */
const RUN = randomUUID().slice(0, 8);

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `appeal-db-key-${RUN}-${String(keyCounter).padStart(4, '0')}`;
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

/**
 * The case's CURRENT ETag, obtained the way §2.7 tells a CLIENT to obtain it.
 *
 * It is deliberately NOT read from a `GET`: §5.14.2 is a list route and the specification does not make it
 * return a case token, and §5.7.3 (which does return one) is not implemented in this node yet. So the
 * helper sends a deliberately stale `If-Match`, takes the `currentEtag` out of the `412` body — which
 * §2.7 requires precisely so "the loser must re-read, re-evaluate the guard set, and re-issue" — and
 * returns it. That makes the helper use ONLY implemented behaviour, and it doubles as continuous evidence
 * that the refusal's token is actionable rather than decorative. A first version read the header off the
 * list route and failed with `unexpected case ETag: undefined`.
 *
 * The probe consumes one idempotency key, and a `412` is raised INSIDE `withIdempotency`'s work, so the
 * key is abandoned and released rather than left in flight.
 */
async function caseEtag(app: VgFastify, caseId: string): Promise<string> {
  const probe = await call(app, 'POST', `/v1/cases/${caseId}/appeal-escalations`, {
    body: validBody(),
    headers: { 'if-match': '"REQUEST_READY:0"' },
  });
  assert.equal(probe.status, 412, `expected a stale-token refusal, got: ${JSON.stringify(probe.json)}`);
  const current = String(detailsOf(probe)['currentEtag']);
  // §2.7's shape for a case-scoped resource: `<truthState>:<updatedAtEpochMillis>`.
  assert.match(current, /^"REQUEST_READY:\d+"$/, `unexpected case ETag: ${current}`);
  const instant = Number(current.replace(/[^0-9]/g, ''));
  assert.ok(Number.isInteger(instant) && instant > 0, `the token must carry a real instant: ${current}`);
  return current;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'REGULATOR_COMPLAINT',
    requiresHumanReview: true,
    artifactIds: [randomUUID()],
    templateVersion: 'v3',
    templateHash: 'b'.repeat(64),
    recipientControllerId: null,
    ...overrides,
  };
}

/** Create an escalation through the API and return its id, failing loudly on any refusal. */
async function createEscalation(app: VgFastify, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await call(app, 'POST', `/v1/cases/${CASE_A}/appeal-escalations`, {
    body: validBody(overrides),
    headers: { 'if-match': await caseEtag(app, CASE_A) },
  });
  assert.equal(res.status, 201, `create failed: ${JSON.stringify(res.json)}`);
  return res.json;
}

describe('§5.14.1 creates a real escalation row', () => {
  test('the response carries the stored review state and reports no external effect', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const created = await createEscalation(app);

    assert.equal(created['caseId'], CASE_A);
    assert.equal(created['kind'], 'REGULATOR_COMPLAINT');
    assert.equal(created['requiresHumanReview'], true);
    assert.equal(created['reviewState'], 'PENDING_COUNSEL_REVIEW');
    assert.equal(created['externalEffect'], false, 'creating the record does not send anything');
    assert.equal(typeof created['createdAt'], 'string');
    assert.equal((created['artifactIds'] as string[]).length, 1);

    // The DATABASE has the row, read as the runtime role under RLS — not merely the response echoing what
    // was sent. The review state is checked here because that is what a later reader acts on.
    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT kind || '|' || requires_human_review::text || '|' || review_state FROM appeal_escalation WHERE id = '${String(created['appealEscalationId'])}';`,
    );
    assert.equal(rows[0], 'REGULATOR_COMPLAINT|true|PENDING_COUNSEL_REVIEW');
    await app.close();
  });

  test('the review-state CHECK rejects any other value, so no route can invent a state', async () => {
    // The column admits exactly the one state SPEC-003 §5.14.1 names, and that is asserted at the DATABASE
    // rather than through the API — a route could always be added later, and the constraint is what stops
    // it from writing an unspecified state that §5.14.2 would then report to callers.
    const attempt = exec(
      appDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
        `INSERT INTO appeal_escalation (tenant_id, case_id, kind, requires_human_review, artifact_ids, review_state)
         VALUES ('${TENANT_A}', '${CASE_A}', 'CONTROLLER_APPEAL', true, '{}', 'APPROVED_BY_COUNSEL');`,
        'COMMIT;',
      ].join('\n'),
    );
    assert.notEqual(attempt.status, 0, 'a state no specification names must not be storable');
    assert.match(attempt.output, /appeal_escalation_review_state_closed/, `expected the CHECK to refuse:\n${attempt.output}`);
  });

  test('an unknown case is 404, and nothing is created', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const res = await call(app, 'POST', `/v1/cases/${ABSENT}/appeal-escalations`, {
      body: validBody(),
      headers: { 'if-match': '"REQUEST_READY:1"' },
    });
    assert.equal(res.status, 404, JSON.stringify(res.json));
    assert.equal(codeOf(res), 'RESOURCE_NOT_FOUND');
    await app.close();
  });

  test('a stale If-Match is 412 with the CURRENT token, and a fresh one succeeds', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const stale = await call(app, 'POST', `/v1/cases/${CASE_A}/appeal-escalations`, {
      body: validBody(),
      headers: { 'if-match': '"REQUEST_READY:1"' },
    });
    assert.equal(stale.status, 412, JSON.stringify(stale.json));
    assert.equal(codeOf(stale), 'PRECONDITION_FAILED');
    const current = String(detailsOf(stale)['currentEtag']);
    assert.equal(current, await caseEtag(app, CASE_A), 'the body must carry the case’s current token');
    await app.close();
  });

  test('creating an escalation does NOT move the case’s truth state', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const before = await caseEtag(app, CASE_A);
    await createEscalation(app);
    // §5.14.1: sending — and any state movement — is a separate §5.8.2 action. A route here that advanced
    // the case would be claiming a removal outcome from a letter that has not been sent.
    assert.equal(await caseEtag(app, CASE_A), before, 'the case token must be unchanged');
    const state = asTenant(appDsn(), TENANT_A, `SELECT truth_state::text FROM request_case WHERE id = '${CASE_A}';`);
    assert.equal(state[0], 'REQUEST_READY');
    await app.close();
  });
});

describe('§5.14.2/§5.14.3 read the escalations back', () => {
  test('the list returns what was created, newest first, with its review state', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const first = await createEscalation(app, { kind: 'CONTROLLER_APPEAL' });
    const second = await createEscalation(app, { kind: 'ATTORNEY_LETTER' });

    const listed = await call(app, 'GET', `/v1/cases/${CASE_A}/appeal-escalations`);
    assert.equal(listed.status, 200);
    const data = listed.json['data'] as Record<string, unknown>[];
    const ids = data.map((row) => row['appealEscalationId']);
    assert.ok(ids.includes(first['appealEscalationId']), 'the first escalation must be listed');
    assert.ok(ids.includes(second['appealEscalationId']), 'the second escalation must be listed');
    // Newest first: the second creation must not appear after the first.
    assert.ok(
      ids.indexOf(second['appealEscalationId']) < ids.indexOf(first['appealEscalationId']),
      'the list must be newest first',
    );
    for (const row of data) {
      assert.equal(row['reviewState'], 'PENDING_COUNSEL_REVIEW');
      assert.ok(Array.isArray(row['artifactIds']));
    }
    await app.close();
  });

  test('the detail route returns one escalation, and 404s for an absent id', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const created = await createEscalation(app, { kind: 'PROVIDER_ESCALATION' });
    const id = String(created['appealEscalationId']);

    const detail = await call(app, 'GET', `/v1/appeal-escalations/${id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    assert.equal(detail.json['appealEscalationId'], id);
    assert.equal(detail.json['kind'], 'PROVIDER_ESCALATION');
    assert.equal(detail.json['reviewState'], 'PENDING_COUNSEL_REVIEW');

    const absent = await call(app, 'GET', `/v1/appeal-escalations/${ABSENT}`);
    assert.equal(absent.status, 404);
    assert.equal(codeOf(absent), 'RESOURCE_NOT_FOUND');
    await app.close();
  });

  test('another tenant’s escalation is 404 with an indistinguishable outcome', async () => {
    const appA = serverFor(TENANT_A, [...WRITE, ...READ]);
    const created = await createEscalation(appA);
    await appA.close();

    const appB = serverFor(TENANT_B, READ);
    const other = await call(appB, 'GET', `/v1/appeal-escalations/${String(created['appealEscalationId'])}`);
    const absent = await call(appB, 'GET', `/v1/appeal-escalations/${ABSENT}`);
    assert.equal(other.status, 404);
    assert.equal(absent.status, 404);
    // Compared on the parts a prober can learn from. `correlationId`/`occurredAt` are per-request by
    // construction (VG-OBS-001), so no two responses are ever byte-identical; the CODE, MESSAGE and
    // RETRYABILITY are what must not distinguish the causes (SPEC-006 H-9).
    const outcome = (res: Injected): Record<string, unknown> => {
      const error = res.json['error'] as Record<string, unknown>;
      return { status: res.status, code: error['code'], message: error['message'], retryable: error['retryable'] };
    };
    assert.deepEqual(outcome(other), outcome(absent));

    // And the DATABASE returns zero rows for tenant B, independently of the service-layer check.
    const leaked = asTenant(
      appDsn(),
      TENANT_B,
      `SELECT count(*) FROM appeal_escalation WHERE id = '${String(created['appealEscalationId'])}';`,
    );
    assert.equal(leaked[0], '0', 'RLS must return zero rows for another tenant’s escalation');
    await appB.close();
  });

  test('another tenant’s CASE is 404 on the list route, not an empty list', async () => {
    const appB = serverFor(TENANT_B, READ);
    const res = await call(appB, 'GET', `/v1/cases/${CASE_A}/appeal-escalations`);
    // An empty list would be a true statement about a case that exists and has no escalations, and a
    // misleading one about a case the caller cannot see at all (SPEC-006 H-9).
    assert.equal(res.status, 404, JSON.stringify(res.json));
    await appB.close();
  });
});

/**
 * Clear any `APPEAL_WINDOW` deadline on the fixture case, and ASSERT that the table is then clean.
 *
 * WHY THIS EXISTS RATHER THAN AN `after`-STYLE CLEANUP. A first version inserted a deadline, asserted, and
 * then deleted it with an `exec` whose return value was IGNORED. Two such rows survived across runs, and
 * because one test asserted "the fixture must have no appeal window, or this test proves nothing", the
 * suite became ORDER-DEPENDENT: `test-integration`'s guard run failed 8 tests while the run immediately
 * after it passed, on identical code. Ignoring the result of a cleanup is the same defect as ignoring the
 * result of a setup — the test then asserts about state it does not control.
 *
 * Calling this at the START of each window test makes them order-independent and self-healing: leftover
 * state is cleared and the clearing is verified BEFORE the test's own premise is asserted. It runs as the
 * OWNER because deleting a fixture row is not something the runtime role should be assumed able to do, and
 * a cleanup that silently lacks the privilege is how the rows survived in the first place.
 *
 * WHY THE DELETE IS NOW SCOPED TO `derivation_ref = 'policy:test'` — A SECOND, SEPARATE DEFECT. An unscoped
 * `DELETE ... WHERE case_id = … AND kind = 'APPEAL_WINDOW'` looked correct in isolation and was not:
 * `deadline-provenance.test.ts` creates deadlines for this same seeded case, `node --test` runs the two
 * files in PARALLEL, and this cleanup therefore deleted THAT suite's rows mid-test — three of its §5.13.3
 * tests failed with a lookup that returned nothing, reproducibly. Only rows carrying this suite's own
 * `derivation_ref` marker are removed now, so the cleanup cannot reach data another file owns while still
 * clearing leftovers from earlier runs of this one. A suite that mutates a SHARED table must scope its
 * cleanup to the rows it can identify as its own.
 */
function clearAppealWindows(): void {
  const cleared = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `DELETE FROM deadline
        WHERE case_id = '${CASE_A}' AND kind = 'APPEAL_WINDOW' AND derivation_ref = 'policy:test';`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(cleared.status, 0, `could not clear the fixture's appeal windows:\n${cleared.output}`);
  const remaining = asTenant(
    ownerDsn(),
    TENANT_A,
    `SELECT count(*)::text FROM deadline
      WHERE case_id = '${CASE_A}' AND kind = 'APPEAL_WINDOW' AND derivation_ref = 'policy:test';`,
  );
  assert.equal(remaining[0], '0', 'the cleanup must be verified, not assumed');
}

/**
 * Whether the shared table currently holds ANY appeal window that would refuse an escalation.
 *
 * This answers a DIFFERENT question from the cleanup: the cleanup owns this suite's rows, while this reports
 * whether a window exists at all — which is the premise the "no deadline is not refused" test needs. Kept
 * separate so a future file that legitimately adds an `APPEAL_WINDOW` makes that test say so, rather than
 * having its premise inferred from a delete that no longer covers everything.
 */
function anyAppealWindows(): number {
  const rows = asTenant(
    ownerDsn(),
    TENANT_A,
    `SELECT count(*)::text FROM deadline WHERE case_id = '${CASE_A}' AND kind = 'APPEAL_WINDOW';`,
  );
  return Number(rows[0] ?? '0');
}

/** Add an `APPEAL_WINDOW` deadline at the given offset from now, and verify it landed. */
function addAppealWindow(interval: string): void {
  // The count is taken BEFORE the insert and asserted as a DELTA. An absolute `=== 1` was the assertion that
  // failed here: a single leftover `APPEAL_WINDOW` row from an earlier run of another file made it read 2, and
  // the message ("the fixture must carry exactly the window this test added") was true but unhelpful about
  // which row the extra one was. A delta asserts the thing this helper is responsible for — that ITS insert
  // landed — and is indifferent to rows other tests legitimately own.
  const before = anyAppealWindows();
  const inserted = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO deadline (tenant_id, case_id, kind, due_at, derivation_ref)
       VALUES ('${TENANT_A}', '${CASE_A}', 'APPEAL_WINDOW', now() ${interval}, 'policy:test');`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(inserted.status, 0, `could not add the appeal window:\n${inserted.output}`);
  assert.equal(anyAppealWindows(), before + 1, 'exactly one appeal window must have been added by this helper');
}

describe('§5.14.1 APPEAL_WINDOW_CLOSED', () => {
  test('a case whose APPEAL_WINDOW deadline has passed is refused', async () => {
    clearAppealWindows();
    addAppealWindow("- interval '1 hour'");

    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const res = await call(app, 'POST', `/v1/cases/${CASE_A}/appeal-escalations`, {
      body: validBody(),
      headers: { 'if-match': await caseEtag(app, CASE_A) },
    });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(codeOf(res), 'APPEAL_WINDOW_CLOSED');
    await app.close();
    clearAppealWindows();
  });

  test('a FUTURE deadline does not refuse, so the check is about closure and not existence', async () => {
    clearAppealWindows();
    addAppealWindow("+ interval '10 days'");

    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const created = await createEscalation(app);
    assert.equal(created['reviewState'], 'PENDING_COUNSEL_REVIEW');
    await app.close();
    clearAppealWindows();
  });

  test('a case with NO APPEAL_WINDOW deadline is NOT refused', async () => {
    // The cleanup runs FIRST, so this test asserts its own premise rather than inheriting it from whichever
    // test happened to run before — which is what made the suite order-dependent.
    clearAppealWindows();
    // And the premise is stated explicitly, from the WHOLE table rather than from this suite's rows: the test
    // is about "no window exists", so a window another file created must make this fail loudly with that
    // reason rather than surface as an unexplained APPEAL_WINDOW_CLOSED.
    assert.equal(anyAppealWindows(), 0, 'the case must have no appeal window for this test to mean anything');

    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    // The opposite reading — "no deadline means the window is closed" — would refuse every escalation on a
    // case that never had a deadline, which SPEC-003 §5.14.1's error list does not describe.
    const created = await createEscalation(app);
    assert.equal(created['reviewState'], 'PENDING_COUNSEL_REVIEW');
    await app.close();
  });
});
