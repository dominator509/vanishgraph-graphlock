/**
 * Cross-tenant denial asserted at BOTH layers over ONE fixture set (EP-006 M10; SPEC-005 VG-AUTH-022, SPEC-002 RLS-2/3/4,
 * SPEC-000 VG-TENANT-001).
 *
 * WHY THIS SUITE EXISTS WHEN TWO OTHERS ALREADY TOUCH TENANCY. `tests/db/evidence-reads.test.ts` asserts the HTTP half for
 * an artifact (another tenant's is `404`, indistinguishable from absent) and `tests/db/rls.test.ts` asserts the row-level
 * half against the SEED for `protected_subject`/`audit_event`. Neither joins the two halves over the same rows, and
 * neither covers the two database cases that matter for the tables EP-006 writes:
 *
 *   * a cross-tenant **write** to `evidence_artifact` refused by `WITH CHECK`, and
 *   * an **unset** `app.tenant_id` seeing nothing rather than everything — the mis-wired-pool case.
 *
 * WHAT IS NEW HERE IS THEREFORE THE JOIN, NOT THE INDIVIDUAL ASSERTIONS: one fixture set, read twice by two means that
 * cannot both be satisfied by the same defect. The service half runs a real `PostgresTenantRunner` and the real
 * `PostgresEvidenceQueries` through Fastify; the database half runs `psql` directly as `vg_app` with `app.tenant_id`
 * set, so the service layer is not in the path at all. A service-layer-only fix (a `WHERE tenant_id = $1` bug that
 * happened to be correct) would leave the second half failing, and an RLS-only fix would leave the first failing.
 *
 * WHAT IT DOES NOT PROVE: that any route mints or executes an authority grant (that is `authority-at-execution.test.ts`)
 * and that the migration runner cannot re-write an artifact (that is `evidence-immutability.test.ts`). The rows here are
 * FIXTURES written by this suite as the owner; nothing in the running system creates an evidence artifact yet, and
 * reading this as evidence of an evidence pipeline would be the mistake the honesty rules exist to prevent.
 *
 * THE DB HALF ASSERTS ITS OWN PRIVILEGE FIRST (`current_user` is `vg_app`), because a `psql` run that had accidentally
 * connected as the owner would satisfy an isolation assertion while proving nothing about the runtime role.
 *
 * FIXTURE DISCIPLINE: this suite's own tenants, per run (ASSUMPTIONS §3.27) — never the seeded tenants.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import {
  TEST_SESSION_SECRET,
  TEST_TOKEN,
  testIdentity,
  testServerDependencies,
} from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresEvidenceQueries } from '../../src/adapters/persistence/evidence.ts';
import { appDsn, asTenant, exec, ownerDsn, withoutTenant } from '../db/harness.ts';

/** This run's own tenants. Never the seeded ones: a suite that writes into a shared tenant is not isolated from itself. */
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RUN = randomUUID().slice(0, 8);

/** One scope, deliberately identical on both servers: the only difference between them is the tenant in the token. */
const SCOPES = ['vg.evidence.read'];

/** The error-envelope keys that necessarily differ between two requests. Excluded from the indistinguishability compare. */
const VOLATILE_ERROR_KEYS = ['requestId', 'correlationId', 'occurredAt'];

let runner: PostgresTenantRunner;
let appA: VgFastify;
let appB: VgFastify;

/** Tenant A's artifact and tenant B's, so each server can be shown to work on its OWN row before being shown to refuse. */
let artifactA: string;
let artifactB: string;
let digestA: string;

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly body: string;
  readonly headers: Record<string, unknown>;
}

async function call(server: VgFastify, artifactId: string): Promise<Injected> {
  const response = await server.inject({
    method: 'GET',
    url: `/v1/evidence-artifacts/${artifactId}`,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = { __raw: response.body };
  }
  return { status: response.statusCode, json, body: response.body, headers: response.headers as Record<string, unknown> };
}

function errorOf(response: Injected): Record<string, unknown> {
  const error = response.json['error'];
  assert.ok(typeof error === 'object' && error !== null, `no error envelope: ${response.body}`);
  return error as Record<string, unknown>;
}

/** The `vg_count=` marker in a `SELECT 'vg_count=' || count(*)::text` result — a MARKER, not a positional guess. */
function countOf(lines: readonly string[]): string {
  const marker = /vg_count=(\d+)/.exec(lines.join('\n'));
  assert.ok(marker !== null, `no vg_count marker in: ${lines.join(' | ')}`);
  return marker[1] ?? '';
}

/**
 * The rows visible for one artifact id, as a labelled count.
 *
 * The label exists because a `psql` tenant session also prints the `set_config` echo, so "the first number in the
 * output" is the tenant id on some queries and a count on others — a positional read here would have been a defect that
 * passed.
 */
function rowsVisible(dsn: ReturnType<typeof appDsn>, tenantId: string, artifactId: string): string {
  return countOf(
    asTenant(dsn, tenantId, `SELECT 'vg_count=' || count(*)::text FROM evidence_artifact WHERE id = '${artifactId}';`),
  );
}

/** A tenant with one subject and one grant, written as the owner under FORCE RLS (the migrator's pattern in 0020). */
function newSubjectAndGrant(tenantId: string): { subjectId: string; grantId: string } {
  const subjectId = randomUUID();
  const grantId = randomUUID();
  const created = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${tenantId}', true);`,
      `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
         VALUES ('${subjectId}', '${tenantId}', 'xt-${RUN}-${subjectId.slice(0, 8)}', 'US-CA', false, 'ACTIVE');`,
      `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, revoked_at, signed_instrument)
         VALUES ('${grantId}', '${tenantId}', '${subjectId}', 'SELF', ARRAY['discovery'], now() - interval '1 day',
                 now() + interval '30 days', NULL, false);`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(created.status, 0, `subject/grant fixture failed: ${created.output}`);
  return { subjectId, grantId };
}

/** One artifact row for a tenant. The digest is a REAL SHA-256 of the bytes this fixture names, never a placeholder. */
function newArtifact(tenantId: string, seed: string): { id: string; digest: string } {
  const id = randomUUID();
  const digest = createHash('sha256').update(`cross-tenant-bytes:${seed}:${RUN}`, 'utf8').digest('hex');
  const created = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${tenantId}', true);`,
      `INSERT INTO evidence_artifact (id, tenant_id, case_id, kind, digest, storage_ref, egress_class,
                                      redaction_state, captured_at)
         VALUES ('${id}', '${tenantId}', NULL, 'SOURCE_SNAPSHOT', '${digest}', 's3://evidence/${RUN}/${id}',
                 'NONE', 'NONE', now() - interval '1 hour');`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(created.status, 0, `artifact fixture failed: ${created.output}`);
  return { id, digest };
}

function buildApp(tenantId: string): VgFastify {
  return buildServer(
    testServerDependencies({
      identity: testIdentity({ tenantId, scopes: SCOPES }),
      tenancy: { runner },
      sessionSecret: TEST_SESSION_SECRET,
      evidenceQueries: new PostgresEvidenceQueries(),
    }),
  );
}

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'cross-tenant-suite-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'cross-tenant-suite-b-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);
  newSubjectAndGrant(TENANT_A);
  newSubjectAndGrant(TENANT_B);
  const a = newArtifact(TENANT_A, 'a');
  const b = newArtifact(TENANT_B, 'b');
  artifactA = a.id;
  artifactB = b.id;
  digestA = a.digest;
  appA = buildApp(TENANT_A);
  appB = buildApp(TENANT_B);
});

after(async () => {
  await appA.close();
  await appB.close();
  await runner.close();
});

describe('the SERVICE layer refuses a cross-tenant artifact read (VG-AUTH-022)', () => {
  test('each tenant reads its own artifact with 200, so the refusal below is tenancy and not a broken server', async () => {
    // THE NON-VACUITY CONTROL FOR THIS WHOLE SUITE: identical servers, identical scope, identical token, different
    // tenant claim. If the 200s below did not hold, the 404s that follow would prove nothing about tenancy.
    const ownA = await call(appA, artifactA);
    assert.equal(ownA.status, 200, `tenant A must read its own artifact: ${ownA.body}`);
    assert.equal(ownA.json['digest'], digestA, 'the digest is the artifact identity the route reports');
    assert.equal(ownA.headers['etag'], `"${digestA}"`, 'the entity tag is the digest');

    const ownB = await call(appB, artifactB);
    assert.equal(ownB.status, 200, `tenant B must read its own artifact: ${ownB.body}`);
  });

  test('the other tenant’s artifact is 404 RESOURCE_NOT_FOUND, in both directions', async () => {
    const bReadsA = await call(appB, artifactA);
    assert.equal(bReadsA.status, 404, JSON.stringify(bReadsA.json));
    assert.equal(errorOf(bReadsA)['code'], 'RESOURCE_NOT_FOUND');

    const aReadsB = await call(appA, artifactB);
    assert.equal(aReadsB.status, 404, JSON.stringify(aReadsB.json));
    assert.equal(errorOf(aReadsB)['code'], 'RESOURCE_NOT_FOUND');
  });

  test('that 404 is indistinguishable from an id that never existed, and leaks neither digest nor tenant', async () => {
    const crossTenant = await call(appB, artifactA);
    const neverExisted = await call(appB, randomUUID());
    assert.equal(neverExisted.status, 404, JSON.stringify(neverExisted.json));

    const cross = errorOf(crossTenant);
    const absent = errorOf(neverExisted);
    const differing = [...new Set([...Object.keys(cross), ...Object.keys(absent)])].filter(
      (key) => JSON.stringify(cross[key]) !== JSON.stringify(absent[key]),
    );
    // A DIFFERENCE OUTSIDE THIS LIST IS THE DEFECT: an extra detail key on the cross-tenant refusal ("exists, but not
    // yours") would be an existence oracle even with an identical status and code.
    assert.deepEqual(
      differing.filter((key) => !VOLATILE_ERROR_KEYS.includes(key)),
      [],
      `only ${VOLATILE_ERROR_KEYS.join('/')} may differ, saw: ${JSON.stringify(differing)}`,
    );
    assert.equal(cross['code'], absent['code']);
    assert.equal(cross['message'], absent['message']);
    assert.equal(crossTenant.body.includes(digestA), false, 'a refusal must not carry the artifact digest');
    assert.equal(crossTenant.body.includes(TENANT_A), false, 'a refusal must not carry the owner tenant id');
  });
});

describe('the DATABASE refuses the same read with no service in the path (RLS-2, RLS-3)', () => {
  test('the database half runs as the runtime role, so these assertions are about `vg_app`', () => {
    // A MEASURED PREMISE, not a formality: `psql` as the owner would still return the row (FORCE RLS applies to the
    // owner too, but the owner could disable it), and an isolation claim made from the wrong role is worthless.
    assert.equal(asTenant(appDsn(), TENANT_A, 'SELECT current_user;')[0], 'vg_app');
    assert.equal(asTenant(ownerDsn(), TENANT_A, 'SELECT current_user;')[0], 'vg_owner');
  });

  test('each tenant sees its own row and ZERO rows for the other tenant’s id', () => {
    assert.equal(rowsVisible(appDsn(), TENANT_A, artifactA), '1', 'tenant A must see its own artifact');
    assert.equal(rowsVisible(appDsn(), TENANT_B, artifactB), '1', 'tenant B must see its own artifact');
    assert.equal(rowsVisible(appDsn(), TENANT_B, artifactA), '0', 'tenant B must see nothing for tenant A’s id');
    assert.equal(rowsVisible(appDsn(), TENANT_A, artifactB), '0', 'tenant A must see nothing for tenant B’s id');
  });

  test('the owner sees the very row the runtime role refuses, so the zero above is a refusal not an empty table', () => {
    // THE ROW EXISTS. `vg_owner` reads it through the same FORCE RLS policy with the same transaction-local setting, so
    // a policy that had simply hidden everything from every role would fail here rather than pass quietly.
    assert.equal(rowsVisible(ownerDsn(), TENANT_A, artifactA), '1');
    assert.equal(rowsVisible(ownerDsn(), TENANT_B, artifactA), '0');
  });

  test('an UNSET app.tenant_id sees nothing rather than every tenant (RLS-3)', () => {
    // The mis-wired-pool case: a policy treating an absent setting as "no filter" would return both artifacts here.
    const artifacts = withoutTenant(appDsn(), "SELECT 'vg_count=' || count(*)::text FROM evidence_artifact;");
    assert.equal(countOf(artifacts), '0', `no app.tenant_id must return no rows: ${artifacts.join(' | ')}`);
    const grants = withoutTenant(appDsn(), "SELECT 'vg_count=' || count(*)::text FROM authority_grant;");
    assert.equal(countOf(grants), '0', `no app.tenant_id must return no grants: ${grants.join(' | ')}`);
  });

  test('a cross-tenant WRITE is refused by WITH CHECK, not merely hidden from reads', () => {
    const id = randomUUID();
    const digest = createHash('sha256').update(`evil-write:${RUN}`, 'utf8').digest('hex');
    const attempt = exec(
      appDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT_B}', true);`,
        `INSERT INTO evidence_artifact (id, tenant_id, case_id, kind, digest, storage_ref, egress_class,
                                        redaction_state, captured_at)
           VALUES ('${id}', '${TENANT_A}', NULL, 'SOURCE_SNAPSHOT', '${digest}', 's3://evidence/${RUN}/${id}',
                   'NONE', 'NONE', now());`,
        'COMMIT;',
      ].join('\n'),
    );
    assert.notEqual(attempt.status, 0, 'the cross-tenant insert must fail');
    assert.match(attempt.output, /row-level security/i, `expected an RLS refusal, got:\n${attempt.output}`);
    // AND IT LEFT NOTHING BEHIND: the refused row is not visible to the tenant it named either.
    assert.equal(rowsVisible(ownerDsn(), TENANT_A, id), '0');
  });

  test('the authority_grant table is in the same posture, since that is the table the grant routes write', () => {
    // THE ID IS READ INSIDE A TENANT-SCOPED TRANSACTION, AND THE FIRST VERSION OF THIS TEST DID NOT — it used
    // `exec(ownerDsn(), …)` with no `app.tenant_id`, which returns zero rows because FORCE RLS applies to the owner
    // too. Measured: `no grant id in the fixture output: (0 rows)`. The lookup is therefore evidence FOR the property
    // this suite asserts rather than an exception to it.
    const grantRows = asTenant(
      ownerDsn(),
      TENANT_A,
      `SELECT 'vg_id=' || id::text FROM authority_grant WHERE tenant_id = '${TENANT_A}' ORDER BY issued_at DESC LIMIT 1;`,
    );
    const marker = /vg_id=([0-9a-f-]{36})/.exec(grantRows.join('\n'));
    assert.ok(marker !== null, `no grant id in the fixture output: ${grantRows.join(' | ')}`);
    const grantId = marker[1] ?? '';

    const scopeOf = (tenantId: string): string =>
      countOf(
        asTenant(
          appDsn(),
          tenantId,
          `SELECT 'vg_count=' || count(*)::text FROM authority_grant WHERE id = '${grantId}';`,
        ),
      );
    assert.equal(scopeOf(TENANT_A), '1', 'tenant A must see its own grant');
    assert.equal(scopeOf(TENANT_B), '0', 'tenant B must see nothing for tenant A’s grant');
    assert.equal(
      countOf(asTenant(ownerDsn(), TENANT_A, `SELECT 'vg_count=' || count(*)::text FROM authority_grant WHERE id = '${grantId}';`)),
      '1',
      'the grant exists: the zero above is the policy, not an absent row',
    );
  });
});
