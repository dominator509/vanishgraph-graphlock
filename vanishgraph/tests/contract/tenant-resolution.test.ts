/**
 * Tenant resolution (SPEC-003 §2.4, §3.2 item 4; SPEC-002 RLS-1…RLS-4; SPEC-006 §7.1 row 13).
 *
 * The property under test: **`tenantId` comes from the verified token and nowhere else**, and a
 * request with no tenant binding REFUSES rather than running an unscoped query.
 *
 * WHAT THIS SUITE DOES AND DOES NOT PROVE:
 *
 *   * It proves the BINDING LOGIC — that the tenant is taken from the token, that a body/query/path
 *     tenant is not authoritative, and that an absent tenant refuses.
 *   * It does NOT prove that PostgreSQL RLS isolates tenants. That claim needs a real database and is
 *     made by `tests/db/rls.test.ts` under `gate-data`. The runner here is an in-memory recorder, and
 *     it must never be cited as evidence that isolation works.
 *
 * That distinction is the whole reason the M3 plan puts the RLS assertion in EP-003's suite: an
 * in-memory stub can be made to "pass" an isolation test by returning the right rows, which proves
 * nothing about the policy the database actually enforces.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer, type ServerDependencies } from '../../src/http/server.ts';
import { ApiError } from '../../src/http/plugins/error-handler.ts';
import { requireTenantContext, withRequestTenant, type RequestContext } from '../../src/http/plugins/tenancy.ts';
import type { FastifyRequest } from 'fastify';
import {
  testIdempotency,
  testIdentity,
  testTenancy,
  testSubjectQueries,
  testSourceQueries,
  testRecipeVerificationKeys,
  TEST_SESSION_SECRET,
  TEST_TOKEN,
} from './server-support.ts';
import { TenantId } from '../../src/domain/identifiers.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function serverWith(options: {
  tenantId?: string;
  tenancy?: ReturnType<typeof testTenancy>;
} = {}) {
  const tenancy = options.tenancy ?? testTenancy();
  const app = buildServer({
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity({ tenantId: options.tenantId ?? TENANT_A }),
    tenancy: tenancy.runner,
    idempotency: testIdempotency(),
    sessionSecret: TEST_SESSION_SECRET,
    subjectQueries: testSubjectQueries(),
    sourceQueries: testSourceQueries(),
    recipeVerificationKeys: testRecipeVerificationKeys(),
    health: {
      startedAt: new Date(),
      now: () => new Date(),
      probes: [async () => ({ name: 'stub', ok: true })],
    },
  });
  return { app, tenancy };
}

describe('the tenant comes from the token and nowhere else (VG-API-004)', () => {
  test('the handler sees the tenant the token carried', async () => {
    const { app, tenancy } = serverWith({ tenantId: TENANT_A });
    app.get('/__test/tenant', async (request) => {
      const context = requireTenantContext(request);
      const rows = await withRequestTenant(request, { runner: tenancy.runner.runner }, async (tx) =>
        tx.query('SELECT 1'),
      );
      return { tenantId: context.tenantId, rows };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/__test/tenant',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
    // The context carries the BRANDED TenantId, which serialises to {kind, value}. The assertion is on
    // the value, because that is the tenant the database sees.
    assert.equal((JSON.parse(res.body) as { tenantId: { value: string } }).tenantId.value, TENANT_A);
    // The transaction was opened for exactly the token's tenant, once.
    assert.equal(tenancy.recorded.length, 1);
    assert.equal(tenancy.recorded[0]?.tenantId, TENANT_A);
    await app.close();
  });

  test('a body, query and path tenant are IGNORED, not authoritative', async () => {
    const { app, tenancy } = serverWith({ tenantId: TENANT_A });
    app.post('/__test/ignore/:tenantId', async (request) => {
      // The handler deliberately receives a hostile tenant in all three places and must still bind
      // the token's tenant. A route that read any of these would be an isolation bypass.
      const context = requireTenantContext(request);
      await withRequestTenant(request, { runner: tenancy.runner.runner }, async (tx) => tx.query('SELECT 1'));
      return {
        boundTenant: context.tenantId,
        sawPath: (request.params as Record<string, string>)['tenantId'],
        sawQuery: (request.query as Record<string, string>)['tenantId'],
        sawBody: (request.body as Record<string, string> | undefined)?.['tenantId'],
      };
    });

    const res = await app.inject({
      method: 'POST',
      url: `/__test/ignore/${TENANT_B}?tenantId=${TENANT_B}`,
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ tenantId: TENANT_B }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { boundTenant: { value: string }; sawPath: string };
    assert.equal(body.boundTenant.value, TENANT_A, 'the token tenant must win');
    assert.equal(body['sawPath'], TENANT_B, 'the path value is visible but not authoritative');
    assert.equal(tenancy.recorded[0]?.tenantId, TENANT_A, 'the transaction must bind the token tenant');
    await app.close();
  });
});

describe('no tenant binding means REFUSE, never an unscoped query (SPEC-006 §7.1 row 13)', () => {
  test('requireTenantContext throws TOKEN_MISSING when no context exists', () => {
    // A request object with no vgContext is exactly what an unauthenticated path produces.
    const request = { vgContext: undefined } as unknown as FastifyRequest;
    assert.throws(
      () => requireTenantContext(request),
      (error: unknown) => error instanceof ApiError && error.code === 'TOKEN_MISSING',
    );
  });

  test('an empty tenant in the context is TOKEN_INVALID_CLAIMS', () => {
    // An empty tenant cannot be built as a branded TenantId (the domain refuses it), so the case is
    // simulated by removing the field: this is exactly what a context built by something other than
    // the identity plugin would look like.
    const request = {
      vgContext: { tenantId: { value: '   ' } } as unknown as RequestContext,
    } as unknown as FastifyRequest;
    assert.throws(
      () => requireTenantContext(request),
      (error: unknown) => error instanceof ApiError && error.code === 'TOKEN_INVALID_CLAIMS',
    );
  });

  test('a non-UUID tenant is refused before it can reach the database', () => {
    // `tenant(id)` is `uuid`, so a non-UUID would fail as a cast error deep inside a query. Refusing
    // at the boundary names the problem where it can be acted on.
    for (const bad of ['not-a-uuid', '11111111-1111-4111-8111', '../../etc/passwd', "'; DROP TABLE tenant; --"]) {
      const request = {
        vgContext: { tenantId: { value: bad } } as unknown as RequestContext,
      } as unknown as FastifyRequest;
      assert.throws(
        () => requireTenantContext(request),
        (error: unknown) => error instanceof ApiError && error.code === 'TOKEN_INVALID_CLAIMS',
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  test('the server refuses a data route when no token is presented', async () => {
    const { app, tenancy } = serverWith();
    app.get('/__test/needs-tenant', async (request) => {
      const context = requireTenantContext(request);
      await withRequestTenant(request, { runner: tenancy.runner.runner }, async (tx) => tx.query('SELECT 1'));
      return { tenantId: context.tenantId };
    });

    const res = await app.inject({ method: 'GET', url: '/__test/needs-tenant' });
    assert.equal(res.statusCode, 401);
    const envelope = JSON.parse(res.body) as { error: { code: string } };
    assert.equal(envelope.error.code, 'TOKEN_MISSING');
    // The decisive assertion: no transaction was opened at all.
    assert.equal(tenancy.recorded.length, 0, 'no unscoped transaction may be opened');
    await app.close();
  });
});

describe('withRequestTenant opens the transaction for the token tenant', () => {
  const tenantA = (): RequestContext =>
    ({
      // The context carries the BRANDED value, so a test builds it the same way the identity plugin
      // does rather than passing a bare string that would bypass the constructor's validation.
      tenantId: new TenantId(TENANT_A),
      actorIdentity: 'op',
      roles: ['OPERATOR'],
      scopes: [],
      authLevel: 'IAL2',
      authTimeSeconds: undefined,
      correlationId: 'corr',
      requestId: 'req',
      subjectRef: 'sref',
      clock: { nowMs: () => 0 },
    }) satisfies RequestContext;

  test('the runner receives the context tenant', async () => {
    const tenancy = testTenancy();
    const request = { vgContext: tenantA() } as unknown as FastifyRequest;
    const result = await withRequestTenant(request, { runner: tenancy.runner.runner }, async (tx) => {
      await tx.query('SELECT 1');
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(tenancy.recorded[0]?.tenantId, TENANT_A);
    assert.deepEqual([...((tenancy.recorded[0]?.queries ?? []) as readonly string[])], ['SELECT 1']);
  });

  test('a throw inside the transaction propagates rather than being swallowed', async () => {
    // The adapter owns the ROLLBACK; this asserts the boundary does not catch-and-continue, which
    // would commit a partial write.
    const tenancy = testTenancy();
    const request = { vgContext: tenantA() } as unknown as FastifyRequest;
    await assert.rejects(
      () =>
        withRequestTenant(request, { runner: tenancy.runner.runner }, async () => {
          throw new Error('handler failed');
        }),
      /handler failed/,
    );
  });
});

describe('tenancy is required by the server type, so it cannot be forgotten', () => {
  test('ServerDependencies requires both identity and tenancy at compile time', () => {
    // A runtime assertion cannot check a compile-time property, so this asserts the SHAPE that makes
    // the property true: the keys are present in the object a caller must build. If either were made
    // optional, the assignment below would still compile and this test would not notice — which is
    // why the enforcement is the type itself, and this test documents the intent.
    const deps: Omit<ServerDependencies, 'health' | 'version' | 'commit'> = {
      identity: testIdentity(),
      tenancy: testTenancy().runner,
      idempotency: testIdempotency(),
      sessionSecret: TEST_SESSION_SECRET,
      subjectQueries: testSubjectQueries(),
    sourceQueries: testSourceQueries(),
    recipeVerificationKeys: testRecipeVerificationKeys(),
    };
    assert.ok(deps.identity !== undefined);
    assert.ok(deps.tenancy !== undefined);
    // A server built with them starts; one without them does not compile. That is the guarantee.
    const app = buildServer({
      version: 't',
      commit: 't',
      logLevel: 'silent',
      health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 's', ok: true })] },
      ...deps,
    });
    assert.ok(app !== undefined);
    void app.close();
  });
});

describe('the public health routes remain reachable without a token (SPEC-003 §5.17)', () => {
  test('health, ready, live and startup do not require identity', async () => {
    const { app } = serverWith();
    for (const path of ['/v1/health', '/v1/live']) {
      const res = await app.inject({ method: 'GET', url: path });
      assert.equal(res.statusCode, 200, `${path} must be reachable without a token`);
    }
    // /ready and /startup answer 200 or 503 depending on the probes, never 401.
    for (const path of ['/v1/ready', '/v1/startup']) {
      const res = await app.inject({ method: 'GET', url: path });
      assert.notEqual(res.statusCode, 401, `${path} must not require a token`);
      assert.ok([200, 503].includes(res.statusCode), `${path} returned ${res.statusCode}`);
    }
    await app.close();
  });

  test('every OTHER path still requires a token', async () => {
    // The exemption list is exact, not prefix-based, so a wildcard route cannot inherit it. Note
    // `/v1/health/extra` in the list: a prefix match would have exempted it.
    const { app } = serverWith();
    for (const path of ['/v1/subjects', '/v1/cases', '/v1/health/extra', '/v1']) {
      const res = await app.inject({ method: 'GET', url: path });
      assert.equal(res.statusCode, 401, `${path} must require a token`);
      const envelope = JSON.parse(res.body) as { error: { code: string } };
      assert.equal(envelope.error.code, 'TOKEN_MISSING', `${path} must report TOKEN_MISSING`);
    }
    await app.close();
  });

  test('an unauthenticated path with a query string is still exempt', async () => {
    const { app } = serverWith();
    const res = await app.inject({ method: 'GET', url: '/v1/health?verbose=1' });
    assert.equal(res.statusCode, 200);
    await app.close();
  });
});
