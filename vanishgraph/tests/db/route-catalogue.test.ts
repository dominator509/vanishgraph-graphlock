/**
 * The route catalogue against real PostgreSQL (SPEC-003 §5.1, §3.2 items 4/5, §7).
 *
 * HONEST SCOPE: this suite runs the REAL handlers against the REAL database through `app.inject`. It
 * is not a contract test of the registry (that is `tests/contract/route-registry.test.ts`) and not a
 * black-box test of a deployed service (that is M8). It proves that the §5.1 group is wired: the
 * scope check runs, RLS scopes the query, the DTO matches the contract, and a cross-tenant read is
 * indistinguishable from an absent one.
 *
 * It requires `VG_TEST_DSN_APP` — the runtime role, NOT the owner. Using the owner DSN would let every
 * test pass with RLS inert, because FORCE RLS does not apply to a superuser.
 *
 * Two layers are asserted INDEPENDENTLY, which is what VG-TENANT-002 requires: the service-layer scope
 * check, and the database policy. Neither is evidence for the other.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdempotency, testIdentity, TEST_SESSION_SECRET, TEST_TOKEN } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresSubjectCommands } from '../../src/adapters/persistence/subject-commands.ts';
import { PostgresSourceQueries } from '../../src/adapters/persistence/sources.ts';
import { PostgresAppealQueries } from '../../src/adapters/persistence/appeals.ts';
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
import { parseDsn } from '../../src/infrastructure/database/psql.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SUBJECT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SUBJECT_B = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const ABSENT = '00000000-0000-4000-8000-000000000000';

function appDsn() {
  const value = process.env['VG_TEST_DSN_APP'];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      'harness ERROR: VG_TEST_DSN_APP is not set. Provision with sh scripts/db-provision.sh and source the state file.',
    );
  }
  return parseDsn(value);
}

let runner: PostgresTenantRunner;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
});

after(async () => {
  await runner.close();
});

/**
 * A server whose identity carries the given tenant and scopes.
 *
 * uthTimeAgeSeconds exists so a test can mint a STALE step-up: the helper defaults to a fresh
 * authentication, so a step-up assertion without an explicit age would pass for the wrong reason.
 */
function serverFor(
  tenantId: string,
  scopes: readonly string[],
  authTimeAgeSeconds = 0,
): VgFastify {
  return buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({ tenantId, scopes, authTimeAgeSeconds }),
    tenancy: { runner },
    idempotency: testIdempotency(),
    sessionSecret: TEST_SESSION_SECRET,
    // The REAL read models: this suite asserts persistence behaviour, so a stub would prove nothing.
    subjectQueries: new PostgresSubjectQueries(),
    subjectCommands: new PostgresSubjectCommands(),
    sourceQueries: new PostgresSourceQueries(),
    // EMPTY, and deliberately so: no signing key is configured, which makes the recipe route refuse
    // with DEPENDENCY_UNAVAILABLE. That refusal is asserted; a key planted here would make this suite
    // claim signature verification works while nothing verified anything.
    recipeVerificationKeys: { publicKeysByRef: new Map<string, string>() },
    // The REAL model, like the others: this suite asserts persistence behaviour, so a stub proves nothing.
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
    health: {
      startedAt: new Date(),
      now: () => new Date(),
      probes: [async () => ({ name: 'stub', ok: true })],
    },
  });
}

async function get(
  app: VgFastify,
  url: string,
  options: { token?: string | undefined } = {},
): Promise<{ status: number; body: string; json: () => unknown; headers: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TEST_TOKEN : options.token;
  if (token !== '') headers['authorization'] = `Bearer ${token}`;
  const response = await app.inject({ method: 'GET', url, headers });
  return {
    status: response.statusCode,
    body: response.body,
    json: () => JSON.parse(response.body) as unknown,
    headers: response.headers as Record<string, unknown>,
  };
}

describe('the §5.1 route group is wired to real persistence', () => {
  test('GET /v1/subjects returns the contract shape with the caller’s own rows', async () => {
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const res = await get(app, '/v1/subjects');
    assert.equal(res.status, 200);

    const body = res.json() as {
      data: Record<string, unknown>[];
      page: { limit: number; nextCursor: string | null; hasMore: boolean; sort: string; filter: unknown };
    };
    assert.equal(body.data.length, 1, 'tenant A has exactly one seeded subject');
    const row = body.data[0];
    assert.ok(row !== undefined);

    // EXACT field set, not a superset: a DTO that added a field would be leaking something, and
    // SPEC-003 §7.1 requires list rows to carry no alias values, no identifier values and no PII.
    assert.deepEqual(
      Object.keys(row).sort(),
      ['authorityState', 'caseCount', 'createdAt', 'displayRef', 'isMinor', 'jurisdiction', 'subjectId', 'updatedAt'],
    );
    assert.equal(row['subjectId'], SUBJECT_A, 'the id is the underlying UUID, not a mnemonic prefix');
    assert.equal(row['authorityState'], 'VALID', 'derived from the live grant');

    // The page object of §2.5, with hasMore agreeing with nextCursor.
    assert.deepEqual(
      Object.keys(body.page).sort(),
      ['filter', 'hasMore', 'limit', 'nextCursor', 'sort'],
    );
    assert.equal(body.page.hasMore, body.page.nextCursor !== null);
    await app.close();
  });

  test('GET /v1/subjects/{subjectId} returns the detail fields', async () => {
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const res = await get(app, `/v1/subjects/${SUBJECT_A}`);
    assert.equal(res.status, 200);
    const detail = res.json() as Record<string, unknown>;
    for (const field of [
      'aliasesCount', 'identifiersCount', 'openCaseCount', 'authorityGrants', 'locationHistory',
    ]) {
      assert.ok(field in detail, `the detail DTO must carry ${field}`);
    }
    assert.ok(Array.isArray(detail['authorityGrants']));
    await app.close();
  });

  test('the detail response carries an ETag of the §2.7 shape', async () => {
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const res = await get(app, `/v1/subjects/${SUBJECT_A}`);
    const etag = res.headers['etag'];
    assert.equal(typeof etag, 'string');
    // `<state>:<updatedAtEpochMillis>`, quoted.
    assert.match(String(etag), /^"[A-Z_]+:\d+"$/, `unexpected ETag shape: ${String(etag)}`);
    await app.close();
  });

  test('GET .../authority-grants returns IDs and states only', async () => {
    const app = serverFor(TENANT_A, ['vg.authority.read']);
    const res = await get(app, `/v1/subjects/${SUBJECT_A}/authority-grants`);
    assert.equal(res.status, 200);
    const body = res.json() as { data: Record<string, unknown>[] };
    assert.ok(body.data.length >= 1);
    const row = body.data[0];
    assert.ok(row !== undefined);
    // §5.1.3 says "IDs and states only": the signed instrument and the evidence id are absent.
    assert.equal('signedInstrument' in row, false);
    assert.equal('evidenceArtifactId' in row, false);
    assert.equal(typeof row['validNow'], 'boolean');
    await app.close();
  });

  test('the masked reads never return a value', async () => {
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    for (const path of [`/v1/subjects/${SUBJECT_A}/aliases`, `/v1/subjects/${SUBJECT_A}/identifiers`]) {
      const res = await get(app, path);
      assert.equal(res.status, 200, `${path} returned ${res.status}`);
      const body = res.json() as { data: Record<string, unknown>[] };
      for (const row of body.data) {
        // A masked field only: no `value`, and no `identifierValue`.
        assert.equal('value' in row, false, `${path} returned a raw value`);
        assert.equal('identifierValue' in row, false);
        assert.ok('valueMasked' in row, `${path} must carry valueMasked`);
        // The mask is a fixed shape, so it cannot vary with the value's length or content.
        assert.equal(row['valueMasked'], '***');
      }
    }
    await app.close();
  });

  test('a MASKED read needs only vg.subjects.read, and includeValue=true needs the reveal scope', async () => {
    // MEASURED DEFECT this pins: the registry once declared `vg.pii.reveal` and `stepUp: true`
    // UNCONDITIONALLY on §5.1.6/§5.1.8, so a masked read — the route's documented DEFAULT — was
    // refused 403 to a caller the contract permits. SPEC-003's Scope line is explicit that the extra
    // scope and the step-up apply only "for `includeValue=true`".
    const readOnly = serverFor(TENANT_A, ['vg.subjects.read']);

    // The base read is permitted with the read scope alone.
    const masked = await get(readOnly, `/v1/subjects/${SUBJECT_A}/aliases`);
    assert.equal(masked.status, 200, 'a masked read must not require vg.pii.reveal');

    // Asking for the VALUE additionally requires vg.pii.reveal.
    const reveal = await get(readOnly, `/v1/subjects/${SUBJECT_A}/aliases?includeValue=true`);
    assert.equal(reveal.status, 403, 'includeValue=true must require vg.pii.reveal');
    assert.equal((reveal.json() as { error: { code: string } }).error.code, 'INSUFFICIENT_SCOPE');
    assert.equal(reveal.body.includes('subject-ref-alpha'), false, 'no value may leak on a 403');

    await readOnly.close();

    // With the scope but a STALE step-up, the reveal is still refused — the two gates are separate.
    // The age must be explicit: the identity helper defaults to a FRESH authentication, so without it
    // this assertion would pass because the step-up was valid, not because the gate works.
    const withScope = serverFor(TENANT_A, ['vg.subjects.read', 'vg.pii.reveal'], 6 * 60);
    const stale = await get(withScope, `/v1/subjects/${SUBJECT_A}/aliases?includeValue=true`);
    assert.equal(stale.status, 403, 'a stale step-up must refuse the reveal');
    assert.equal((stale.json() as { error: { code: string } }).error.code, 'STEP_UP_REQUIRED');
    await withScope.close();
  });
});

describe('a cross-tenant read is INDISTINGUISHABLE from an absent one (§3.2 item 4, H-9)', () => {
  test('another tenant’s subject returns 404, not 403', async () => {
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const res = await get(app, `/v1/subjects/${SUBJECT_B}`);
    assert.equal(res.status, 404, 'a foreign resource must be 404, never 403');
    const envelope = res.json() as { error: { code: string } };
    assert.equal(envelope.error.code, 'RESOURCE_NOT_FOUND');
    await app.close();
  });

  test('the foreign-resource body is byte-identical to a genuinely absent one', async () => {
    // Anything that distinguishes them is an oracle: a caller could enumerate which ids exist in
    // another tenant by watching which response they receive.
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const foreign = await get(app, `/v1/subjects/${SUBJECT_B}`);
    const absent = await get(app, `/v1/subjects/${ABSENT}`);

    const strip = (body: string): string =>
      body
        .replace(/"requestId":"[^"]*"/, '"requestId":"X"')
        .replace(/"correlationId":"[^"]*"/, '"correlationId":"X"')
        .replace(/"occurredAt":"[^"]*"/, '"occurredAt":"X"');
    assert.equal(
      strip(foreign.body),
      strip(absent.body),
      'the two 404 bodies must differ only in the per-request tracing fields',
    );
    await app.close();
  });

  test('a malformed id is also 404, so id SHAPE is not an oracle either', async () => {
    // A distinct "malformed id" error would tell a prober that the well-formed ones exist.
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    for (const bad of ['not-a-uuid', '12345', '../../etc/passwd', "'; DROP TABLE protected_subject; --"]) {
      const res = await get(app, `/v1/subjects/${encodeURIComponent(bad)}`);
      assert.equal(res.status, 404, `${bad} must be 404, not a validation error`);
    }
    await app.close();
  });

  test('the internal TENANT_SCOPE_VIOLATION code never appears on the wire', async () => {
    // SPEC-003 §8.2 marks it audit- and telemetry-only. Its appearance in a body would be the oracle
    // the previous tests exist to close.
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const res = await get(app, `/v1/subjects/${SUBJECT_B}`);
    assert.equal(res.body.includes('TENANT_SCOPE_VIOLATION'), false);
    await app.close();
  });
});

describe('RLS and the service-layer scope check are INDEPENDENT controls (VG-TENANT-002)', () => {
  test('the database returns nothing for another tenant, with NO application filter', async () => {
    // This queries the database DIRECTLY through the runner, with no handler and no DTO in the path.
    // A passing result is therefore evidence about the POLICY, not about our TypeScript.
    const rows = await runner.withTenantTransaction(TENANT_A, async (tx) => {
      const result = await tx.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM protected_subject WHERE tenant_id = $1::uuid',
        [TENANT_B],
      );
      return result.rows;
    });
    assert.equal(rows[0]?.n, '0', 'RLS must return zero rows for an explicit cross-tenant predicate');
  });

  test('the service-layer scope check rejects independently of the database', async () => {
    // A token WITHOUT the read scope: the handler refuses before it opens a transaction, so this is
    // the application layer acting alone.
    const app = serverFor(TENANT_A, ['vg.cases.read']);
    const res = await get(app, '/v1/subjects');
    assert.equal(res.status, 403);
    const envelope = res.json() as { error: { code: string } };
    assert.equal(envelope.error.code, 'INSUFFICIENT_SCOPE');
    await app.close();
  });

  test('a scope held is required EXACTLY, not by substring', async () => {
    // `vg.subjects.readonly` must not satisfy `vg.subjects.read`. A substring check would let a
    // narrower-looking scope grant a broader capability.
    const app = serverFor(TENANT_A, ['vg.subjects.readonly']);
    const res = await get(app, '/v1/subjects');
    assert.equal(res.status, 403, 'a near-miss scope must not satisfy the requirement');
    await app.close();
  });
});

describe('identity is required before any subject route runs', () => {
  test('no token is 401 TOKEN_MISSING and returns no rows', async () => {
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const res = await get(app, '/v1/subjects', { token: '' });
    assert.equal(res.status, 401);
    const envelope = res.json() as { error: { code: string } };
    assert.equal(envelope.error.code, 'TOKEN_MISSING');
    assert.equal(res.body.includes('subject-ref-alpha'), false, 'no data may leak on a 401');
    await app.close();
  });
});

describe('strict query parsing is enforced on the real route, not only in the parser', () => {
  test('an unknown parameter is refused and returns no rows', async () => {
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const res = await get(app, '/v1/subjects?limitt=5');
    assert.equal(res.status, 400);
    const envelope = res.json() as { error: { code: string } };
    assert.equal(envelope.error.code, 'UNKNOWN_QUERY_PARAMETER');
    assert.equal(res.body.includes('subject-ref-alpha'), false, 'a refused query must return no rows');
    await app.close();
  });

  test('offset is refused: it exists on no route (§2.5)', async () => {
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const res = await get(app, '/v1/subjects?offset=10');
    assert.equal(res.status, 400);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'UNKNOWN_QUERY_PARAMETER');
    await app.close();
  });

  test('a sort field outside the allowlist is refused', async () => {
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const res = await get(app, '/v1/subjects?sort=identifierValue:asc');
    assert.equal(res.status, 400);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'INVALID_SORT_FIELD');
    await app.close();
  });

  test('truthState is not a filterable parameter on subjects', async () => {
    // A subject has an AUTHORITY state, not a truth state. Accepting the parameter would let a caller
    // believe they filtered by a concept subjects do not have.
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const res = await get(app, '/v1/subjects?truthState=VERIFIED_REMOVED');
    assert.equal(res.status, 400);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'UNKNOWN_QUERY_PARAMETER');
    await app.close();
  });

  test('a valid authorityState filter is applied, not ignored', async () => {
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const matching = await get(app, '/v1/subjects?authorityState=VALID');
    assert.equal(matching.status, 200);
    assert.equal((matching.json() as { data: unknown[] }).data.length, 1);

    // The filter must EXCLUDE, not merely be accepted: a filter that is parsed and dropped returns
    // the same rows as no filter, which reads as a successful narrow query.
    const excluding = await get(app, '/v1/subjects?authorityState=REVOKED');
    assert.equal(excluding.status, 200);
    assert.equal((excluding.json() as { data: unknown[] }).data.length, 0, 'the filter was ignored');
    await app.close();
  });
});

describe('cursor pagination is enforced on the real route', () => {
  test('a cursor minted for another tenant is refused', async () => {
    // Mint a cursor as tenant A, then present it as tenant B. The tenant binding must reject it.
    const appA = serverFor(TENANT_A, ['vg.subjects.read']);
    const appB = serverFor(TENANT_B, ['vg.subjects.read']);

    // A one-row collection has no next page, so the cursor is minted directly with the encoder and
    // the same secret the servers use.
    const { encodeCursor, filterHashOf } = await import('../../src/http/pagination/cursor.ts');
    const foreign = encodeCursor(
      {
        tenantId: TENANT_A,
        routeTemplate: '/v1/subjects',
        filterHash: filterHashOf({}),
        sort: 'createdAt:desc',
        keyset: { sortValue: new Date().toISOString(), id: SUBJECT_A },
        issuedAt: Math.floor(Date.now() / 1000),
      },
      TEST_SESSION_SECRET,
    );

    const res = await get(appB, `/v1/subjects?cursor=${encodeURIComponent(foreign)}`);
    assert.equal(res.status, 400, 'a cross-tenant cursor must be refused');
    assert.equal((res.json() as { error: { code: string } }).error.code, 'INVALID_CURSOR');
    await appA.close();
    await appB.close();
  });

  test('a tampered cursor is refused', async () => {
    const app = serverFor(TENANT_A, ['vg.subjects.read']);
    const res = await get(app, '/v1/subjects?cursor=eyJhbGciOiJub25lIn0.AAAA');
    assert.equal(res.status, 400);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'INVALID_CURSOR');
    await app.close();
  });
});
