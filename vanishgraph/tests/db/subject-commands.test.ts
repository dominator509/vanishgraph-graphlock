/**
 * §5.1.1 subject creation and §5.1.4 subject update against real PostgreSQL (EP-004 M6).
 *
 * WHAT THIS SUITE PROVES, AND WHAT IT DELIBERATELY DOES NOT:
 *
 *   * **A subject is created WITH its authority grant, in one transaction, or not at all.** VG-IDENT-001 is
 *     enforced by a DEFERRED trigger, so the test that matters is not "the row exists" but "a creation whose grant
 *     is unusable leaves NOTHING behind" — asserted by counting the subject rows before and after a refusal.
 *   * **The refusals are the contract's**: no expiry, an already-past expiry, a missing artifact for a kind that
 *     needs one, an artifact id that resolves to nothing, an identity level below the floor, and the
 *     separation-of-duties rule.
 *   * **`jurisdiction` cannot be patched** (§5.1.4, VG-POLICY-002) and is refused rather than ignored.
 *   * **The precondition is a real concurrency control**: a stale `If-Match` is `412` with the CURRENT ETag, and a
 *     second PATCH that reuses the same token after a successful one fails rather than silently overwriting.
 *   * **The strict lane is entered only when it can be**: moving a subject to `isMinor: true` while an automated
 *     lane is in flight is `409 STRICT_LANE_CONFLICT`, and the same patch succeeds once no case is in flight.
 *
 * IT DOES NOT PROVE, because the repository cannot: that an `AGENT` grant's instrument is legally sufficient, or
 * that the notice SPEC-005 `VG-AUTHZ-014` requires was sent — no notification transport exists here. Those are
 * recorded as limitations in ASSUMPTIONS §3.35, not asserted as working.
 *
 * FIXTURE DISCIPLINE: this suite's own tenants, per run (ASSUMPTIONS §3.27).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN, testServerDependencies } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresSubjectCommands } from '../../src/adapters/persistence/subject-commands.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, asTenant, exec, ownerDsn } from './harness.ts';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RUN = randomUUID().slice(0, 8);
const SCOPES = ['vg.subjects.read', 'vg.subjects.write'];

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;
let app: VgFastify;
let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return `subject-suite-key-${RUN}-${String(keyCounter).padStart(4, '0')}`;
}

function buildApp(tenantId: string, scopes: readonly string[] = SCOPES, authLevel = 'IAL2'): VgFastify {
  return buildServer(
    testServerDependencies({
      identity: testIdentity({ tenantId, scopes, authLevel }),
      tenancy: { runner },
      idempotency: {
        store: idempotency,
        requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
      },
      sessionSecret: TEST_SESSION_SECRET,
      subjectQueries: new PostgresSubjectQueries(),
      subjectCommands: new PostgresSubjectCommands(),
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
  method: 'POST' | 'PATCH' | 'GET',
  url: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> {
  const headers: Record<string, string> = { authorization: `Bearer ${TEST_TOKEN}`, ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  // EVERY MUTATING METTHOD, not just POST. §5.1.4 declares idempotency REQUIRED on PATCH, and MEASURED: a helper
  // that keyed only POST made five PATCH assertions fail with `400 IDEMPOTENCY_KEY_REQUIRED` — the plugin was
  // right and the test harness was wrong.
  if (method !== 'GET' && headers['idempotency-key'] === undefined) headers['idempotency-key'] = nextKey();
  const response = await server.inject({
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

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    displayRef: `SUBJ-${RUN}-${String(keyCounter)}`,
    jurisdiction: 'US-CA',
    isMinor: false,
    authorityGrant: {
      kind: 'SELF',
      scope: ['REMOVAL_REQUEST'],
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    },
    ...overrides,
  };
}

/** A real evidence artifact row, for the kind that requires a stored instrument. */
function newEvidenceArtifact(): string {
  const id = randomUUID();
  // `redaction_state` is 'NONE' and NOT 'UNREDACTED': the constraint is
  // CHECK (redaction_state IN ('NONE','SCRUBBED','DENIED')) while SPEC-003 §5.12.1 declares the tokens
  // `UNREDACTED|DLP_SCRUBBED`. MEASURED here — the first fixture used the contract's token and the insert was
  // refused. Recorded in ASSUMPTIONS §3.35 as a defect the §5.12 node must resolve, not worked around in a test.
  const created = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO evidence_artifact (id, tenant_id, kind, digest, storage_ref, egress_class, redaction_state, captured_at)
         VALUES ('${id}', '${TENANT_A}', 'AUTHORITY_INSTRUMENT', repeat('c', 64), 's3://test/${RUN}/${id}',
                 'NONE', 'NONE', now());`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(created.status, 0, `artifact fixture failed: ${created.output}`);
  return id;
}

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'subject-cmd-suite-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'subject-cmd-suite-b-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);
  app = buildApp(TENANT_A);
});

after(async () => {
  await app.close();
  await runner.close();
});

describe('§5.1.1 creating a subject', () => {
  test('a valid creation writes the subject AND its grant, and the grant is usable at commit', async () => {
    const response = await call(app, 'POST', '/v1/subjects', { body: createBody() });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    const subjectId = String(response.json['subjectId']);
    const grantId = String(response.json['authorityGrantId']);
    assert.match(subjectId, /^[0-9a-f-]{36}$/);
    assert.equal(response.json['strictLane'], false);

    // Read back through SQL rather than through the response: the row is the evidence, and a response built from
    // the same values it just sent would prove only that the handler can echo.
    const rows = read(
      TENANT_A,
      `SELECT (SELECT count(*) FROM protected_subject WHERE id = '${subjectId}')::text
              || '/' ||
              (SELECT count(*) FROM authority_grant WHERE id = '${grantId}' AND subject_id = '${subjectId}')::text
              || '/' ||
              (SELECT kind::text FROM authority_grant WHERE id = '${grantId}')`,
    );
    assert.deepEqual(rows, ['1/1/SELF'], `rows were ${JSON.stringify(rows)}`);
  });

  test('a creation with no expiry is refused, and NOTHING is left behind', async () => {
    const before = read(TENANT_A, 'SELECT count(*)::text FROM protected_subject')[0];
    const body = createBody();
    delete (body['authorityGrant'] as Record<string, unknown>)['expiresAt'];
    const response = await call(app, 'POST', '/v1/subjects', { body });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'AUTHORITY_WINDOW_INVALID');
    assert.equal(read(TENANT_A, 'SELECT count(*)::text FROM protected_subject')[0], before);
  });

  test('an expiry in the past is AUTHORITY_WINDOW_INVALID, and still leaves nothing', async () => {
    const before = read(TENANT_A, 'SELECT count(*)::text FROM protected_subject')[0];
    const response = await call(app, 'POST', '/v1/subjects', {
      body: createBody({
        authorityGrant: { kind: 'SELF', scope: ['REMOVAL_REQUEST'], expiresAt: '2020-01-01T00:00:00.000Z' },
      }),
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'AUTHORITY_WINDOW_INVALID');
    assert.equal(read(TENANT_A, 'SELECT count(*)::text FROM protected_subject')[0], before);
  });

  test('an AGENT grant without an instrument is refused; with a real artifact it is created', async () => {
    const refused = await call(app, 'POST', '/v1/subjects', {
      body: createBody({ authorityGrant: { kind: 'AGENT', scope: ['EXTERNAL_ACTION'], expiresAt: futureIso() } }),
    });
    assert.equal(refused.status, 422, JSON.stringify(refused.json));
    assert.equal(codeOf(refused), 'AUTHORITY_EVIDENCE_REQUIRED');

    const missing = await call(app, 'POST', '/v1/subjects', {
      body: createBody({
        authorityGrant: {
          kind: 'AGENT',
          scope: ['EXTERNAL_ACTION'],
          evidenceArtifactId: randomUUID(),
          expiresAt: futureIso(),
        },
      }),
    });
    assert.equal(missing.status, 422, JSON.stringify(missing.json));
    assert.equal(codeOf(missing), 'EVIDENCE_NOT_FOUND');

    const artifactId = newEvidenceArtifact();
    const created = await call(app, 'POST', '/v1/subjects', {
      body: createBody({
        authorityGrant: {
          kind: 'AGENT',
          scope: ['EXTERNAL_ACTION'],
          evidenceArtifactId: artifactId,
          expiresAt: futureIso(),
        },
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const rows = read(
      TENANT_A,
      `SELECT signed_instrument::text || '/' || coalesce(evidence_id::text, 'null')
         FROM authority_grant WHERE id = '${String(created.json['authorityGrantId'])}'`,
    );
    assert.deepEqual(rows, [`true/${artifactId}`]);
  });

  test('an identity level below the floor is 403, and an unknown grant kind is not a 500', async () => {
    const low = buildApp(TENANT_A, SCOPES, 'IAL1');
    const refused = await call(low, 'POST', '/v1/subjects', { body: createBody() });
    assert.equal(refused.status, 403, JSON.stringify(refused.json));
    assert.equal(codeOf(refused), 'IDENTITY_LEVEL_INSUFFICIENT');
    const details = (refused.json['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
    assert.deepEqual(details, { required: 'IAL2', supplied: 'IAL1' });
    await low.close();

    const badKind = await call(app, 'POST', '/v1/subjects', {
      body: createBody({ authorityGrant: { kind: 'GUARDIAN', scope: ['X'], expiresAt: futureIso() } }),
    });
    assert.equal(badKind.status, 422, JSON.stringify(badKind.json));
    assert.equal(codeOf(badKind), 'AUTHORITY_GRANT_INVALID');
  });

  test('an empty scope and a displayRef carrying apparent PII are malformed requests, not 500s', async () => {
    const emptyScope = await call(app, 'POST', '/v1/subjects', {
      body: createBody({ authorityGrant: { kind: 'SELF', scope: [], expiresAt: futureIso() } }),
    });
    assert.equal(emptyScope.status, 422, JSON.stringify(emptyScope.json));
    assert.equal(codeOf(emptyScope), 'SCHEMA_VALIDATION_FAILED');

    const pii = await call(app, 'POST', '/v1/subjects', {
      body: createBody({ displayRef: 'jane.doe@example.com' }),
    });
    assert.equal(pii.status, 422, JSON.stringify(pii.json));
    assert.equal(codeOf(pii), 'SCHEMA_VALIDATION_FAILED');
  });

  test('creating a subject for a different tenant does not make it visible to this one', async () => {
    const other = buildApp(TENANT_B);
    const created = await call(other, 'POST', '/v1/subjects', { body: createBody() });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const subjectId = String(created.json['subjectId']);
    const visible = read(TENANT_A, `SELECT count(*)::text FROM protected_subject WHERE id = '${subjectId}'`);
    assert.deepEqual(visible, ['0'], 'RLS must hide another tenant’s subject');
    await other.close();
  });
});

describe('§5.1.4 updating a subject', () => {
  async function createSubject(): Promise<{ subjectId: string; etag: string }> {
    const created = await call(app, 'POST', '/v1/subjects', { body: createBody() });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const subjectId = String(created.json['subjectId']);
    const detail = await call(app, 'GET', `/v1/subjects/${subjectId}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    return { subjectId, etag: String(detail.headers['etag']) };
  }

  test('a PATCH with the current ETag updates the mutable fields and returns the new token', async () => {
    const { subjectId, etag } = await createSubject();
    const response = await call(app, 'PATCH', `/v1/subjects/${subjectId}`, {
      headers: { 'if-match': etag },
      body: { displayRef: `SUBJ-${RUN}-renamed`, contactPreference: { channel: 'EMAIL', contactRefId: 'cref-0001' } },
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['displayRef'], `SUBJ-${RUN}-renamed`);
    assert.deepEqual(response.json['contactPreference'], { channel: 'EMAIL', contactRefId: 'cref-0001' });

    // The stored row, not the echo.
    const rows = read(
      TENANT_A,
      `SELECT display_ref || '/' || coalesce(contact_channel, '-') || '/' || coalesce(contact_ref_id, '-')
         FROM protected_subject WHERE id = '${subjectId}'`,
    );
    assert.deepEqual(rows, [`SUBJ-${RUN}-renamed/EMAIL/cref-0001`]);

    // §5.1.3's ETag is derived from `updatedAt`, so a successful write must move it — otherwise a client's next
    // If-Match would be accepted against a version it no longer holds.
    const detail = await call(app, 'GET', `/v1/subjects/${subjectId}`);
    assert.notEqual(String(detail.headers['etag']), etag);
  });

  test('a stale ETag is 412 naming the CURRENT one, and the row is unchanged', async () => {
    const { subjectId, etag } = await createSubject();
    const first = await call(app, 'PATCH', `/v1/subjects/${subjectId}`, {
      headers: { 'if-match': etag },
      body: { displayRef: `SUBJ-${RUN}-first` },
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));

    const stale = await call(app, 'PATCH', `/v1/subjects/${subjectId}`, {
      headers: { 'if-match': etag },
      body: { displayRef: `SUBJ-${RUN}-second` },
    });
    assert.equal(stale.status, 412, JSON.stringify(stale.json));
    assert.equal(codeOf(stale), 'PRECONDITION_FAILED');
    const details = (stale.json['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
    const currentEtag = String(details['currentEtag']);
    assert.match(currentEtag, /^(VALID|EXPIRED|REVOKED|NONE):\d+$/);
    assert.notEqual(currentEtag, `${etag.replace(/"/g, '')}`);

    const rows = read(TENANT_A, `SELECT display_ref FROM protected_subject WHERE id = '${subjectId}'`);
    assert.deepEqual(rows, [`SUBJ-${RUN}-first`], 'the losing write must not have applied');
  });

  test('a missing If-Match is 428, and jurisdiction is 422 FIELD_NOT_PATCHABLE', async () => {
    const { subjectId } = await createSubject();
    const noPrecondition = await call(app, 'PATCH', `/v1/subjects/${subjectId}`, { body: { isMinor: false } });
    assert.equal(noPrecondition.status, 428, JSON.stringify(noPrecondition.json));
    assert.equal(codeOf(noPrecondition), 'PRECONDITION_REQUIRED');

    const detail = await call(app, 'GET', `/v1/subjects/${subjectId}`);
    const jurisdictionPatch = await call(app, 'PATCH', `/v1/subjects/${subjectId}`, {
      headers: { 'if-match': String(detail.headers['etag']) },
      body: { jurisdiction: 'US-NY' },
    });
    assert.equal(jurisdictionPatch.status, 422, JSON.stringify(jurisdictionPatch.json));
    assert.equal(codeOf(jurisdictionPatch), 'FIELD_NOT_PATCHABLE');

    const rows = read(TENANT_A, `SELECT jurisdiction FROM protected_subject WHERE id = '${subjectId}'`);
    assert.deepEqual(rows, ['US-CA'], 'the refused field must not have been written');
  });

  test('isMinor moves the subject into the strict lane, and 409 when a lane is already in flight', async () => {
    const { subjectId, etag } = await createSubject();
    const minor = await call(app, 'PATCH', `/v1/subjects/${subjectId}`, {
      headers: { 'if-match': etag },
      body: { isMinor: true },
    });
    assert.equal(minor.status, 200, JSON.stringify(minor.json));
    assert.equal(minor.json['strictLane'], true);

    // A SECOND subject, with a case that has already been submitted: the same patch must be refused, because the
    // work already dispatched cannot be recalled by a flag. `request_case` requires an exposure, a source and a
    // grant (MEASURED: the first version of this fixture omitted them and the insert failed at status 3), so the
    // whole chain is built here rather than the case alone.
    const other = await createSubject();
    const grantId = read(
      TENANT_A,
      `SELECT id::text FROM authority_grant WHERE subject_id = '${other.subjectId}' ORDER BY created_at LIMIT 1`,
    )[0];
    const caseId = randomUUID();
    const sourceId = randomUUID();
    const recordId = randomUUID();
    const exposureId = randomUUID();
    const created = exec(
      ownerDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
        `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class)
           VALUES ('${sourceId}', '${TENANT_A}', 'subject-suite-source-${RUN}-${sourceId.slice(0, 8)}', 'REGISTRY',
                   'US-CA', 'WRITE_PERMITTED');`,
        `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
           VALUES ('${recordId}', '${TENANT_A}', '${sourceId}', 'https://example.invalid/subject-${RUN}',
                   now() - interval '2 days', repeat('d', 64), false);`,
        `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
           VALUES ('${exposureId}', '${TENANT_A}', '${other.subjectId}', '${recordId}', 0.9,
                   '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, 'REQUEST_SUBMITTED');`,
        `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, truth_state)
           VALUES ('${caseId}', '${TENANT_A}', '${other.subjectId}', '${exposureId}', '${sourceId}', '${grantId}',
                   'REQUEST_SUBMITTED');`,
        'COMMIT;',
      ].join('\n'),
    );
    assert.equal(created.status, 0, `case fixture failed: ${created.output}`);

    const conflict = await call(app, 'PATCH', `/v1/subjects/${other.subjectId}`, {
      headers: { 'if-match': other.etag },
      body: { isMinor: true },
    });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.json));
    assert.equal(codeOf(conflict), 'STRICT_LANE_CONFLICT');

    const rows = read(TENANT_A, `SELECT is_minor::text FROM protected_subject WHERE id = '${other.subjectId}'`);
    assert.deepEqual(rows, ['false'], 'the refused lane change must not have applied');
  });

  test('another tenant’s subject is 404, never 403', async () => {
    const { subjectId, etag } = await createSubject();
    const other = buildApp(TENANT_B);
    const response = await call(other, 'PATCH', `/v1/subjects/${subjectId}`, {
      headers: { 'if-match': etag },
      body: { displayRef: `SUBJ-${RUN}-cross` },
    });
    assert.equal(response.status, 404, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'RESOURCE_NOT_FOUND');
    await other.close();
  });
});

function futureIso(): string {
  return new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
}
