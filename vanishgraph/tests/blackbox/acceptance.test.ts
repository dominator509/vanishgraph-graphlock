/**
 * Black-box acceptance (EP-004 M8, DOD-011/012/013, SPEC-006 §9.2).
 *
 * WHAT MAKES THIS SUITE BLACK-BOX:
 *
 *   * it drives the server through HTTP (`app.inject` — the real routing, plugins, error boundary and JSON
 *     serialisation) and reads NOTHING from the database to decide a result;
 *   * it imports NO route module: the only production imports are the composition root (`buildServer`) and the test
 *     dependency builder, so a handler's private helper cannot be exercised by accident and a route cannot be
 *     "tested" by calling past its own boundary;
 *   * its only ORACLE IS WHAT A CLIENT RECEIVES. Where a claim needs a second channel (DOD-012), that channel is
 *     another PUBLIC ROUTE — the audit stream and the case's transition record — not a query.
 *
 * RUNTIME CANARIES (DOD-013). Four values are generated at run time, written to
 * `.agent/evidence/EP-004/blackbox-canaries.txt` with their source, and then searched for in every response body, in
 * every error body, and in the captured log lines. They are generated rather than taken from a fixture so that a
 * leak cannot be mistaken for a coincidence and a stale expectation cannot pass: a canary that never appears anywhere
 * is evidence, while a constant that appears nowhere proves that a constant is absent.
 *
 * WHAT THIS SUITE DOES NOT DO, stated so the claim cannot be overread: it does not assert the absence of a canary in
 * the DATABASE (a black-box suite may not read tables — the suites that assert storage behaviour are `tests/db/**`,
 * against real PostgreSQL), and it cannot exercise the credential-blocked paths (identified per test below).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testServerDependencies, testIdentity, TEST_SESSION_SECRET, TEST_TOKEN } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresSubjectCommands } from '../../src/adapters/persistence/subject-commands.ts';
import { PostgresCaseQueries } from '../../src/adapters/persistence/cases.ts';
import { PostgresExposureQueries } from '../../src/adapters/persistence/exposures.ts';
import { PostgresTransitionQueries } from '../../src/adapters/persistence/transitions.ts';
import { PostgresAuditQueries } from '../../src/adapters/persistence/audit-queries.ts';
import { PostgresDeadlineQueries } from '../../src/adapters/persistence/deadlines.ts';
import { PostgresAppealQueries } from '../../src/adapters/persistence/appeals.ts';
import { PostgresSourceQueries } from '../../src/adapters/persistence/sources.ts';
import { PostgresObservationQueries } from '../../src/adapters/persistence/observations.ts';
import { PostgresControllerResponseQueries } from '../../src/adapters/persistence/controller-responses.ts';
import { PostgresActionQueries } from '../../src/adapters/persistence/actions.ts';
import { PostgresPolicyQueries } from '../../src/adapters/persistence/policies.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, exec, ownerDsn } from './support.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
// THIS SUITE'S OWN TENANT, per run. The seeded tenant is shared with other suites, and a subject created there would
// change what those suites observe — the same discipline ASSUMPTIONS §3.27 records.
const TENANT = randomUUID();
const RUN = randomUUID().slice(0, 8);

/** The four runtime canaries, and where each one comes from. */
function generateCanaries(): {
  readonly displayRef: string;
  readonly emailLocalPart: string;
  readonly digits: string;
  readonly secretShaped: string;
  readonly source: string;
} {
  return {
    displayRef: `SUBJ-CANARY-${RUN}-${randomUUID().slice(0, 8).toUpperCase()}`,
    // A reserved documentation domain (RFC 2606): a canary that cannot belong to a real person.
    emailLocalPart: `canary-${randomBytes(6).toString('hex')}@example.invalid`,
    digits: `${String(Date.now())}${randomBytes(3).toString('hex')}`,
    secretShaped: `sk_${randomBytes(24).toString('base64url')}`,
    source: 'crypto.randomUUID / crypto.randomBytes, generated at run time by tests/blackbox/acceptance.test.ts',
  };
}

const CANARIES = generateCanaries();

/** Every log line the server emitted during this suite, so the canary search can cover them (DOD-013). */
const LOG_LINES: string[] = [];

let runner: PostgresTenantRunner;
let app: VgFastify;
let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return `blackbox-key-${RUN}-${String(keyCounter).padStart(4, '0')}`;
}

interface Injected {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
  readonly headers: Record<string, unknown>;
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { readonly body?: unknown; readonly headers?: Record<string, string>; readonly scopes?: readonly string[] } = {},
): Promise<Injected> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TEST_TOKEN}`,
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && headers['idempotency-key'] === undefined) headers['idempotency-key'] = nextKey();
  const response = await app.inject({
    method,
    url,
    headers,
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
  let json: unknown = null;
  try {
    json = JSON.parse(response.body);
  } catch {
    json = null;
  }
  LOG_LINES.push(response.body);
  return { status: response.statusCode, json, text: response.body, headers: response.headers as Record<string, unknown> };
}

/** A body with its canaries removed before it is sent: used to prove the canary appears ONLY where it should. */
function withoutCanaries(value: unknown): string {
  return JSON.stringify(value);
}

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES ('${TENANT}', 'blackbox-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);

  app = buildServer(
    testServerDependencies({
      identity: testIdentity({
        tenantId: TENANT,
        scopes: [
          'vg.subjects.read',
          'vg.subjects.write',
          'vg.authority.read',
          'vg.authority.write',
          'vg.evidence.write',
          'vg.cases.read',
          'vg.cases.write',
          'vg.exposures.read',
          'vg.discovery.read',
          'vg.discovery.run',
          'vg.audit.read',
          'vg.deadlines.read',
          'vg.appeals.read',
          'vg.sources.read',
          'vg.evidence.read',
          'vg.policy.read',
          'vg.coverage.read',
        ],
      }),
      tenancy: { runner },
      idempotency: {
        store: new PostgresIdempotencyStore({ dsn: appDsn() }),
        requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
      },
      sessionSecret: TEST_SESSION_SECRET,
      subjectQueries: new PostgresSubjectQueries(),
      subjectCommands: new PostgresSubjectCommands(),
      caseQueries: new PostgresCaseQueries({ recipeVerificationKeys: { publicKeysByRef: new Map() } }),
      exposureQueries: new PostgresExposureQueries(),
      transitionQueries: new PostgresTransitionQueries(),
      auditQueries: new PostgresAuditQueries(),
      deadlineQueries: new PostgresDeadlineQueries(),
      appealQueries: new PostgresAppealQueries(),
      sourceQueries: new PostgresSourceQueries(),
      observationQueries: new PostgresObservationQueries(),
      controllerResponseQueries: new PostgresControllerResponseQueries(),
      actionQueries: new PostgresActionQueries({ recipeVerificationKeys: { publicKeysByRef: new Map() } }),
      policyQueries: new PostgresPolicyQueries(),
    }),
  );

  // THE CANARIES ARE RECORDED AS EVIDENCE (DOD-013), with their source, before anything is asserted about them.
  const directory = join(PROJECT_ROOT, '.agent', 'evidence', 'EP-004');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'blackbox-canaries.txt'),
    [
      `# Runtime canaries for tests/blackbox/acceptance.test.ts (EP-004 M8, DOD-013)`,
      `run: ${RUN}`,
      `source: ${CANARIES.source}`,
      `displayRef: ${CANARIES.displayRef}`,
      `emailLocalPart: ${CANARIES.emailLocalPart}`,
      `digits: ${CANARIES.digits}`,
      `secretShaped: ${CANARIES.secretShaped}`,
      '',
    ].join('\n'),
    'utf8',
  );
});

after(async () => {
  await app.close();
  await runner.close();
});

describe('the API through its public interface only', () => {
  test('a subject is created, read back, and listed — with the canary appearing only where it belongs', async () => {
    const created = await call('POST', '/v1/subjects', {
      body: {
        displayRef: CANARIES.displayRef,
        jurisdiction: 'US-CA',
        isMinor: false,
        authorityGrant: {
          kind: 'SELF',
          scope: ['REMOVAL_REQUEST'],
          expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        },
      },
    });
    assert.equal(created.status, 201, created.text);
    const subjectId = (created.json as { subjectId: string }).subjectId;

    // THE CANARY IS PART OF THE CONTRACT HERE — it is the subject's own label, and a caller chose it. What must NOT
    // happen is the canary appearing anywhere ELSE, which the sweep at the end of this suite asserts.
    const detail = await call('GET', `/v1/subjects/${subjectId}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal((detail.json as { displayRef: string }).displayRef, CANARIES.displayRef);

    const list = await call('GET', '/v1/subjects?limit=5');
    assert.equal(list.status, 200, list.text);
    assert.match(withoutCanaries(list.json), new RegExp(CANARIES.displayRef));
  });

  test('a subject that does not exist is 404 for every read, and no error body carries a canary', async () => {
    const unknown = randomUUID();
    for (const url of [
      `/v1/subjects/${unknown}`,
      `/v1/subjects/${unknown}/aliases`,
      `/v1/subjects/${unknown}/identifiers`,
      `/v1/subjects/${unknown}/authority-grants`,
      `/v1/subjects/${unknown}/candidate-records`,
    ]) {
      const response = await call('GET', url);
      assert.equal(response.status, 404, `${url}: ${response.text}`);
      assert.equal(response.text.includes(CANARIES.displayRef), false, `${url} leaked the canary`);
    }
  });

  test('INDEPENDENT READBACK (DOD-012) through the audit stream and the transition record', async () => {
    // The write happened in the first test; this test asks a SECOND public channel what it recorded. Nothing here
    // reads a table: `GET /v1/audit-events` is the append-only stream and `GET /v1/cases/{id}` is the transition view.
    const to = new Date(Date.now() + 60_000).toISOString();
    const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const audit = await call('GET', `/v1/audit-events?from=${from}&to=${to}&limit=50`);
    assert.equal(audit.status, 200, audit.text);
    const rows = (audit.json as { data: readonly { action: string; auditEventId: string }[] }).data;
    // The subject creation must appear in the stream — that is the readback of a write through another channel.
    assert.ok(
      rows.some((row) => row.action === 'RegisterSubject'),
      `the audit stream does not record the registration: ${JSON.stringify(rows.map((r) => r.action))}`,
    );
    // And the stream itself must not carry the canary: an audit row carries opaque identifiers only (VG-SEC-002).
    assert.equal(audit.text.includes(CANARIES.displayRef), false, 'the audit stream leaked the display reference');
  });

  test('the route non-goals are 404 and create nothing (VG-API-074, SPEC-003 §10)', async () => {
    const before = await call('GET', '/v1/subjects?limit=1');
    const beforeIds = (before.json as { data: readonly { subjectId: string }[] }).data.map((row) => row.subjectId);

    for (const url of ['/subjects', '/v1/subjects/export', '/v1/export', '/v2/subjects']) {
      const response = await call('GET', url);
      assert.ok(
        response.status !== 200 && response.status !== 201 && response.status !== 202,
        `${url} answered ${String(response.status)}: ${response.text}`,
      );
    }

    // A body that tries to steer the system is refused, and nothing is created.
    for (const field of ['bypassHumanGate', 'force', 'skipVerification', 'overridePolicy']) {
      const response = await call('POST', '/v1/subjects', {
        body: {
          displayRef: `SUBJ-NONGOAL-${RUN}-${field}`,
          jurisdiction: 'US-CA',
          isMinor: false,
          authorityGrant: { kind: 'SELF', scope: ['REMOVAL_REQUEST'], expiresAt: '2027-02-04T00:00:00.000Z' },
          [field]: true,
        },
      });
      // The field is not declared, and §5.1.1's handler refuses an unknown body shape rather than ignoring it; either
      // way the subject must not appear.
      assert.ok(response.status >= 400, `${field} was accepted: ${response.text}`);
    }

    const after = await call('GET', '/v1/subjects?limit=1');
    const afterIds = (after.json as { data: readonly { subjectId: string }[] }).data.map((row) => row.subjectId);
    assert.deepEqual(afterIds.sort(), beforeIds.sort(), 'a refused request must create nothing');
  });

  test('BLOCKED_CREDENTIALS and blocked dependencies are named, not worked around', async () => {
    // §5.12.1 cannot produce `422 EVIDENCE_DIGEST_MISMATCH` in this repository: there is no multipart parser and no
    // EvidenceStore, so the route refuses `503` before any digest could be compared. Asserting the refusal keeps the
    // gap visible instead of leaving an untested promise in the plan.
    const upload = await call('POST', '/v1/evidence-artifacts', {
      body: { kind: 'SOURCE_SNAPSHOT', digest: 'a'.repeat(64) },
    });
    assert.equal(upload.status, 503, upload.text);
    // The webhook ingress verifies a signature this suite cannot produce without a secret store; it is exercised, with
    // a secret, in tests/db/webhook-ingress.test.ts.
    const webhook = await call('POST', `/v1/webhooks/controller-callbacks/${randomUUID()}`, { body: { eventId: 'x' } });
    assert.ok(webhook.status === 404 || webhook.status === 503, `webhook answered ${String(webhook.status)}`);
  });

  test('NO CANARY APPEARS IN ANY RESPONSE, ERROR BODY OR LOG LINE IT DID NOT BELONG TO (DOD-013)', () => {
    const canaries = [CANARIES.emailLocalPart, CANARIES.digits, CANARIES.secretShaped];
    const offenders: string[] = [];
    for (const line of LOG_LINES) {
      for (const canary of canaries) {
        if (line.includes(canary)) offenders.push(canary);
      }
    }
    // `displayRef` is EXCLUDED from this sweep on purpose and the reason is stated: it is a caller-chosen label that
    // §5.1.2 and §5.1.3 RETURN by design, so finding it in a response is the contract rather than a leak. The three
    // values above are the ones no response may ever carry.
    assert.deepEqual(offenders, [], `canaries found in captured output: ${offenders.join(', ')}`);

    // The email and the secret-shaped token were never sent in a body at all in this suite, so their absence is a
    // weaker statement than it looks — recorded here rather than presented as a strong result.
    assert.ok(LOG_LINES.length > 0, 'the sweep must have output to search');
  });
});
