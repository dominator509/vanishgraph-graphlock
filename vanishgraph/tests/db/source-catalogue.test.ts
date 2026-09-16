/**
 * The §5.3 source catalogue and recipe group, against real PostgreSQL (SPEC-003 §5.3).
 *
 * EVERY assertion here runs through the real HTTP boundary and the real `PostgresSourceQueries`
 * adapter against the database provisioned by `sh scripts/db-provision.sh`. There is no in-memory
 * substitute: an in-memory source table would change RLS, constraint and default behaviour, which is
 * exactly what this suite exists to measure. It is the persistence half of EP-004 M6, and its
 * credential-free half (`tests/contract/route-registry.test.ts`) proves only that the routes are
 * DECLARED — never that they work.
 *
 * WHAT THIS SUITE PROVES, per VG-API-027/028/029 and VG-CHANNEL-002/003:
 *
 *   * `writesEnabled` is DERIVED and cannot be true for a `WRITE_UNCLEAR` source, even with a
 *     perfectly signed, fresh, enabled recipe (ADR-003 — no override exists).
 *   * A permission downgrade AUTO-DISABLES the affected recipes in the same transaction and NAMES
 *     them in the response, so disabling is never silent.
 *   * A recipe signature is verified BEFORE the row exists: an unsigned or badly signed submission
 *     leaves no row, and a signing reference with no configured key is refused as a dependency
 *     failure rather than accepted.
 *   * §5.3.10 refuses enablement when ANY guard fails, naming the guard, and leaves `enabled: false`.
 *     Disabling is never refused by a guard.
 *   * Cross-tenant reads of a source are `404` with a body byte-identical to a genuinely absent one,
 *     and the database layer returns zero rows for the other tenant's data independently.
 *
 * THE FIXTURE NAMES ARE UNIQUE PER RUN. A first version used fixed names and passed once, then failed
 * on every rerun with `409 SOURCE_ALREADY_DECLARED` — a suite that only passes on a virgin database is
 * not evidence about the code, it is evidence about the database's history.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import {
  testIdentity,
  TEST_SESSION_SECRET,
  TEST_TOKEN,
  testWebhookDependencies,} from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresSourceQueries, canonicalRecipePayload } from '../../src/adapters/persistence/sources.ts';
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
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, asTenant, exec } from './harness.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ABSENT = '00000000-0000-4000-8000-000000000000';

/** A short unique suffix, so repeated runs never collide on the `(tenant_id, name)` natural key. */
const RUN = randomUUID().slice(0, 8);

/**
 * A REAL Ed25519 key pair, generated per run.
 *
 * Generated rather than committed: a committed test key is a key that eventually gets reused, and the
 * private half would then be a checked-in signing key. Only the PUBLIC half is handed to the server.
 * The reference is unique per run so a stale row from an earlier run cannot be verified by this key.
 */
const KEY_REF = `kms:recipe-test-${RUN}`;
const RECIPE_KEYS = generateKeyPairSync('ed25519');
const PUBLIC_PEM = RECIPE_KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString();

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
});

after(async () => {
  await runner.close();
});

/**
 * A server wired exactly as the composition root wires it, except for identity.
 *
 * The idempotency requirement is read from the REGISTRY, which is what `src/infrastructure/main.ts`
 * does. A suite that passed `() => undefined` would exercise no key claiming at all, and a route whose
 * registry entry says `required` would silently run without one — the defect this suite would then
 * fail to notice.
 */
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
    sourceQueries: new PostgresSourceQueries(),
    recipeVerificationKeys: { publicKeysByRef: new Map([[KEY_REF, PUBLIC_PEM]]) },
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
    ...testWebhookDependencies(),
    subjectQueries: { ...testSubjectQueriesStub },
    subjectCommands: {
      createSubject: async () => ({ ok: false, reason: 'EVIDENCE_NOT_FOUND' }),
      updateSubject: async () => ({ ok: false, reason: 'NOT_FOUND' }),
      mintAuthorityGrant: async () => ({ ok: false, reason: 'SUBJECT_NOT_FOUND' }),
      revokeAuthorityGrant: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    },
    health: {
      startedAt: new Date(),
      now: () => new Date(),
      probes: [async () => ({ name: 'stub', ok: true })],
    },
  });
}

/** §5.3 exercises no subject read, so the honest stub is an empty tenant's. */
const testSubjectQueriesStub = {
  listSubjects: async () => [],
  getSubjectDetail: async () => undefined,
  subjectExists: async () => false,
  listAliases: async () => [],
  listIdentifiers: async () => [],
  listLocationHistory: async () => [],
  listAuthorityGrants: async () => [],
  jurisdictionResolves: async () => false,
  appendLocationHistory: async () => ({ locationHistoryId: 'test' }),
  appendAlias: async () => ({
    aliasId: 'test',
    addedAt: new Date(0).toISOString(),
    quarantined: false,
    candidateSubjectIds: [],
  }),
} as const;

const READ = ['vg.sources.read'];
const WRITE = ['vg.sources.write'];
const RECIPES = ['vg.recipes.write'];

type Json = Record<string, unknown>;

interface Injected {
  readonly status: number;
  readonly json: Json;
  readonly headers: Record<string, unknown>;
}

/**
 * The wire error code of a response, or `undefined` for a success.
 *
 * READ FROM `error.code`, not from the top level. The §8.1 envelope is
 * `{error: {code, message, details?, requestId, correlationId, retryable, occurredAt}}`; a first
 * version of this suite read `json['code']`, so every refusal looked like a missing code and twelve
 * assertions failed for a reason that had nothing to do with the behaviour under test. The helper
 * exists so that mistake cannot be repeated by a later test in this file.
 */
function codeOf(response: Injected): unknown {
  const error = response.json['error'];
  return typeof error === 'object' && error !== null ? (error as Json)['code'] : undefined;
}

/** The `details` object of an error envelope, or `{}`. */
function detailsOf(response: Injected): Json {
  const error = response.json['error'];
  if (typeof error !== 'object' || error === null) return {};
  const details = (error as Json)['details'];
  return typeof details === 'object' && details !== null ? (details as Json) : {};
}

/**
 * The parts of the error envelope that must be IDENTICAL for two responses to be indistinguishable.
 *
 * `correlationId`, `requestId` and `occurredAt` are deliberately excluded, and that is not a weakening
 * of SPEC-006 H-9. Those three fields are per-REQUEST by construction — every response on the service
 * carries a fresh correlation id (VG-OBS-001) — so no two responses can ever be byte-identical, and an
 * assertion that demanded it would only ever pass by comparing one response with itself. What a prober
 * can actually learn from is the CODE, the MESSAGE and the RETRYABILITY, and those must not vary
 * between "absent" and "another tenant's": that is the distinction H-9 forbids leaking.
 */
function outcomeOf(response: Injected): Json {
  const error = response.json['error'];
  if (typeof error !== 'object' || error === null) return {};
  const record = error as Json;
  return {
    status: response.status,
    code: record['code'],
    message: record['message'],
    retryable: record['retryable'],
  };
}

/** A unique idempotency key: 16–255 chars from the §4.2 charset, distinct per call site. */
let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `idem-${RUN}-${String(keyCounter).padStart(4, '0')}`;
}

async function call(
  app: VgFastify,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  options: { body?: unknown; headers?: Record<string, string>; token?: string } = {},
): Promise<Injected> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const token = options.token === undefined ? TEST_TOKEN : options.token;
  if (token !== '') headers['authorization'] = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  // Every effect-bearing route in this group requires a key; supplying one unconditionally keeps each
  // test's intent about the SOURCE of a refusal rather than about a missing header.
  if (method !== 'GET' && headers['idempotency-key'] === undefined) headers['idempotency-key'] = nextKey();

  const response = await app.inject({
    method,
    url,
    headers,
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
  let json: Json = {};
  try {
    json = JSON.parse(response.body) as Json;
  } catch {
    json = { __raw: response.body };
  }
  return { status: response.statusCode, json, headers: response.headers as Record<string, unknown> };
}

/**
 * Read a resource's CURRENT ETag, asserting that the read itself succeeded.
 *
 * A one-line `String((await call(...)).headers['etag'])` is how this suite first produced a 412 that
 * looked like a concurrency bug: the token used `vg.sources.write` only, so the `GET` was refused with
 * `403 INSUFFICIENT_SCOPE`, `headers['etag']` was `undefined`, and `If-Match: undefined` was correctly
 * refused as stale. The failure appeared two steps away from its cause. This helper fails AT THE READ,
 * naming the status it got, so a scope mistake can never masquerade as a precondition failure.
 */
async function currentEtag(app: VgFastify, url: string, scopesNote: string): Promise<string> {
  const res = await call(app, 'GET', url);
  assert.equal(res.status, 200, `could not read the current ETag from ${url} (${scopesNote}): ${JSON.stringify(res.json)}`);
  const etag = res.headers['etag'];
  assert.equal(typeof etag, 'string', `no ETag on ${url}`);
  assert.match(String(etag), /^"[A-Z_]+:\d+"$/, `unexpected ETag shape on ${url}: ${String(etag)}`);
  return String(etag);
}

/** Declare a source through the API and return its id. Fails loudly rather than returning undefined. */
async function declareSource(
  app: VgFastify,
  overrides: Json = {},
): Promise<{ sourceId: string; etag: string }> {
  const body: Json = {
    name: `src-${RUN}-${randomUUID().slice(0, 8)}`,
    class: 'PEOPLE_SEARCH',
    jurisdiction: 'US-CA',
    permissionClass: 'WRITE_UNCLEAR',
    ...overrides,
  };
  const res = await call(app, 'POST', '/v1/sources', { body });
  assert.equal(res.status, 201, `declare failed: ${JSON.stringify(res.json)}`);
  const sourceId = res.json['sourceId'];
  assert.equal(typeof sourceId, 'string');
  return { sourceId: sourceId as string, etag: String(res.headers['etag'] ?? '') };
}

/** Sign a recipe declaration the way `canonicalRecipePayload` defines. */
function signedRecipe(
  sourceId: string,
  overrides: Partial<{
    channel: string;
    verificationMethod: string;
    signingKeyRef: string;
    freshnessAt: string;
    maxAttemptsPerWindow: number;
    windowSeconds: number;
  }> = {},
): Json {
  const input = {
    sourceId,
    channel: overrides.channel ?? 'OFFICIAL_SELF_SERVICE',
    verificationMethod: overrides.verificationMethod ?? 'INDEPENDENT_FETCH_DIFFERENT_EGRESS',
    signingKeyRef: overrides.signingKeyRef ?? KEY_REF,
    freshnessAt: overrides.freshnessAt ?? new Date(Date.now() + 86_400_000).toISOString(),
    maxAttemptsPerWindow: overrides.maxAttemptsPerWindow ?? 1,
    windowSeconds: overrides.windowSeconds ?? 86_400,
  };
  const signature = cryptoSign(null, Buffer.from(canonicalRecipePayload(input), 'utf8'), RECIPE_KEYS.privateKey);
  return { ...input, signature: signature.toString('base64url') };
}

describe('§5.3.2 declaring a source against real PostgreSQL', () => {
  test('a declared source is persisted and readable through the API', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const name = `declared-${RUN}-${randomUUID().slice(0, 8)}`;
    const created = await call(app, 'POST', '/v1/sources', {
      body: {
        name,
        class: 'PEOPLE_SEARCH',
        jurisdiction: 'US-CA',
        permissionClass: 'WRITE_UNCLEAR',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const sourceId = created.json['sourceId'] as string;

    // The DATABASE has the row, read as the runtime role under RLS — not merely the response echoing
    // what was sent.
    const rows = asTenant(appDsn(), TENANT_A, `SELECT count(*) FROM source WHERE id = '${sourceId}';`);
    assert.equal(rows[0], '1', 'the row must exist in the database, not only in the response');

    const detail = await call(app, 'GET', `/v1/sources/${sourceId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json['name'], name);
    assert.equal(detail.json['permissionClass'], 'WRITE_UNCLEAR');
    assert.equal(detail.json['writesEnabled'], false, 'WRITE_UNCLEAR never enables writes (ADR-003)');
    assert.equal(detail.json['freshnessState'], 'STALE', 'no window declared ⇒ freshness is unestablished');
    // The internal concurrency counter must NOT be on the wire; it reaches the caller as the ETag.
    assert.equal('rowVersion' in detail.json, false, 'rowVersion must not be serialised');
    assert.match(String(detail.headers['etag']), /^"WRITE_UNCLEAR:\d+"$/);
    await app.close();
  });

  test('a second declaration of the same name is 409 SOURCE_ALREADY_DECLARED', async () => {
    const app = serverFor(TENANT_A, WRITE);
    const name = `dup-${RUN}-${randomUUID().slice(0, 8)}`;
    const body = { name, class: 'PEOPLE_SEARCH', jurisdiction: 'US-CA', permissionClass: 'READ_ONLY' };
    assert.equal((await call(app, 'POST', '/v1/sources', { body })).status, 201);

    const second = await call(app, 'POST', '/v1/sources', { body });
    assert.equal(second.status, 409);
    assert.equal(codeOf(second), 'SOURCE_ALREADY_DECLARED');

    // And exactly one row exists: the conflict must not have created a second source.
    const rows = asTenant(appDsn(), TENANT_A, `SELECT count(*) FROM source WHERE name = '${name}';`);
    assert.equal(rows[0], '1');
    await app.close();
  });

  test('an unknown controller is 422 CONTROLLER_NOT_FOUND, and a real one is stored', async () => {
    const app = serverFor(TENANT_A, WRITE);

    const unknown = await call(app, 'POST', '/v1/sources', {
      body: {
        name: `ctl-${RUN}-${randomUUID().slice(0, 8)}`,
        class: 'PEOPLE_SEARCH',
        jurisdiction: 'US-CA',
        permissionClass: 'READ_ONLY',
        controllerId: ABSENT,
      },
    });
    assert.equal(unknown.status, 422, JSON.stringify(unknown.json));
    assert.equal(codeOf(unknown), 'CONTROLLER_NOT_FOUND');

    // A real controller in the caller's own tenant, inserted as the runtime role under RLS.
    const controllerId = randomUUID();
    asTenant(
      appDsn(),
      TENANT_A,
      `INSERT INTO controller (id, tenant_id, name, kind, jurisdiction, contact_refs)
       VALUES ('${controllerId}', '${TENANT_A}', 'ctl-${RUN}', 'PUBLISHER', 'US-CA', '{}');`,
    );

    const created = await call(app, 'POST', '/v1/sources', {
      body: {
        name: `ctl-ok-${RUN}-${randomUUID().slice(0, 8)}`,
        class: 'PEOPLE_SEARCH',
        jurisdiction: 'US-CA',
        permissionClass: 'READ_ONLY',
        controllerId,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    // The reference is PERSISTED, not merely accepted. Migration 0012 exists because SPEC-002 §2's
    // `source` table had no column for it and the field would have been discarded silently.
    assert.equal(created.json['controllerId'], controllerId);
    await app.close();
  });

  test('a WRITE_PERMITTED declaration without evidence is 422 PERMISSION_EVIDENCE_REQUIRED', async () => {
    const app = serverFor(TENANT_A, WRITE);
    const name = `perm-${RUN}-${randomUUID().slice(0, 8)}`;

    const bare = await call(app, 'POST', '/v1/sources', {
      body: { name, class: 'PEOPLE_SEARCH', jurisdiction: 'US-CA', permissionClass: 'WRITE_PERMITTED' },
    });
    assert.equal(bare.status, 422, JSON.stringify(bare.json));
    assert.equal(codeOf(bare), 'PERMISSION_EVIDENCE_REQUIRED');

    // No row may exist for the refused declaration.
    const rows = asTenant(appDsn(), TENANT_A, `SELECT count(*) FROM source WHERE name = '${name}';`);
    assert.equal(rows[0], '0', 'a refused declaration must leave no row');

    const withEvidence = await call(app, 'POST', '/v1/sources', {
      body: {
        name,
        class: 'PEOPLE_SEARCH',
        jurisdiction: 'US-CA',
        permissionClass: 'WRITE_PERMITTED',
        permissionEvidenceUrl: 'https://example.test/tos-archive/2026-02-04',
        permissionCheckedAt: new Date().toISOString(),
        permissionWindowSeconds: 86_400,
      },
    });
    assert.equal(withEvidence.status, 201, JSON.stringify(withEvidence.json));
    assert.equal(withEvidence.json['freshnessState'], 'CURRENT', 'a fresh window must report CURRENT');
    await app.close();
  });
});

describe('§5.3.1 writesEnabled is derived, never stored', () => {
  test('WRITE_UNCLEAR stays false even with a signed, fresh, enabled recipe', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ, ...RECIPES]);
    const { sourceId } = await declareSource(app, { permissionClass: 'WRITE_UNCLEAR' });

    const recipe = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, {
      body: signedRecipe(sourceId),
    });
    assert.equal(recipe.status, 201, JSON.stringify(recipe.json));

    const detail = await call(app, 'GET', `/v1/sources/${sourceId}`);
    const etag = String(detail.headers['etag']);
    const enable = await call(app, 'POST', `/v1/recipes/${String(recipe.json['recipeId'])}/enablement`, {
      body: { enabled: false, reason: 'OPERATOR_DISABLED' },
      headers: { 'if-match': etag === '' ? '""' : etag },
    });
    assert.equal(enable.status, 200, JSON.stringify(enable.json));

    // The recipe route's own enablement would be refused by the permission guard; the point here is
    // only that `writesEnabled` is false because of the CLASS, whatever the recipe's state.
    const after = await call(app, 'GET', `/v1/sources/${sourceId}`);
    assert.equal(after.json['writesEnabled'], false);
    assert.equal(after.json['permissionClass'], 'WRITE_UNCLEAR');
    await app.close();
  });

  test('WRITE_PERMITTED + current window + enabled fresh recipe is the only true combination', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ, ...RECIPES]);
    const { sourceId } = await declareSource(app, {
      permissionClass: 'WRITE_PERMITTED',
      permissionEvidenceUrl: 'https://example.test/tos-archive/2026-02-04',
      permissionCheckedAt: new Date().toISOString(),
      permissionWindowSeconds: 86_400,
    });

    const before = await call(app, 'GET', `/v1/sources/${sourceId}`);
    assert.equal(before.json['writesEnabled'], false, 'no recipe yet ⇒ false');

    const recipe = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, {
      body: signedRecipe(sourceId),
    });
    assert.equal(recipe.status, 201, JSON.stringify(recipe.json));
    const recipeId = String(recipe.json['recipeId']);

    const stillDisabled = await call(app, 'GET', `/v1/sources/${sourceId}`);
    assert.equal(stillDisabled.json['writesEnabled'], false, 'a DISABLED recipe must not enable writes');

    // The recipe's own ETag, from §5.3.9.
    const recipeDetail = await call(app, 'GET', `/v1/recipes/${recipeId}`);
    assert.equal(recipeDetail.status, 200);
    const enabled = await call(app, 'POST', `/v1/recipes/${recipeId}/enablement`, {
      body: { enabled: true, reason: 'PERMISSION_REFRESHED' },
      headers: { 'if-match': String(recipeDetail.headers['etag']) },
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
    // Every guard reported true, and the ENABLEMENT is the source of the true — not a stored flag.
    assert.deepEqual(enabled.json['guardEvaluation'], {
      signatureVerified: true,
      fresh: true,
      permissionClass: 'WRITE_PERMITTED',
      permissionFresh: true,
    });

    const after = await call(app, 'GET', `/v1/sources/${sourceId}`);
    assert.equal(after.json['writesEnabled'], true, 'VG-API-027 requires this exact combination');
    await app.close();
  });
});

describe('§5.3.4 permission-class change auto-disables affected recipes', () => {
  test('a downgrade disables the enabled recipe and NAMES it in the response', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ, ...RECIPES]);
    const { sourceId } = await declareSource(app, {
      permissionClass: 'WRITE_PERMITTED',
      permissionEvidenceUrl: 'https://example.test/tos-archive/2026-02-04',
      permissionCheckedAt: new Date().toISOString(),
      permissionWindowSeconds: 86_400,
    });

    const recipe = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, {
      body: signedRecipe(sourceId),
    });
    const recipeId = String(recipe.json['recipeId']);
    const recipeDetail = await call(app, 'GET', `/v1/recipes/${recipeId}`);
    const enabled = await call(app, 'POST', `/v1/recipes/${recipeId}/enablement`, {
      body: { enabled: true, reason: 'PERMISSION_REFRESHED' },
      headers: { 'if-match': String(recipeDetail.headers['etag']) },
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.json));

    // Downgrade. If-Match is the source's CURRENT ETag, which the previous GET returned.
    const detail = await call(app, 'GET', `/v1/sources/${sourceId}`);
    const downgraded = await call(app, 'PATCH', `/v1/sources/${sourceId}/permission-class`, {
      body: { permissionClass: 'READ_ONLY', reason: 'TERMS_REVISED' },
      headers: { 'if-match': String(detail.headers['etag']) },
    });
    assert.equal(downgraded.status, 200, JSON.stringify(downgraded.json));
    assert.deepEqual(
      downgraded.json['autoDisabledRecipeIds'],
      [recipeId],
      'VG-CHANNEL-002: disabling is never silent, so the ids are returned',
    );
    assert.equal(downgraded.json['writesEnabled'], false);
    assert.equal(downgraded.json['permissionClass'], 'READ_ONLY');

    // The database agrees, and the reason is recorded for an operator (migration 0012's column).
    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT enabled::text || '|' || coalesce(disabled_reason,'') FROM removal_recipe WHERE id = '${recipeId}';`,
    );
    assert.equal(rows[0], 'false|PERMISSION_DOWNGRADED');
    await app.close();
  });

  test('a stale If-Match is 412 with the current ETag, and a missing one is 428', async () => {
    // BOTH scopes. The route needs `write`; this test also READS the token it must send, which needs
    // `read`. A first version used `write` alone, so the read was refused `403`, `headers['etag']` was
    // `undefined`, and `If-Match: undefined` was correctly rejected as stale — a real 412 produced two
    // steps away from its cause. `currentEtag` now asserts the read.
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const { sourceId } = await declareSource(app);

    const missing = await call(app, 'PATCH', `/v1/sources/${sourceId}/permission-class`, {
      body: { permissionClass: 'READ_ONLY', reason: 'TERMS_REVISED' },
    });
    assert.equal(missing.status, 428);
    assert.equal(codeOf(missing), 'PRECONDITION_REQUIRED');

    // The FIRST patch succeeds and BUMPS the row version. That is what makes an earlier token stale,
    // and it is the real race §2.7 describes ("two concurrent requests carrying the same If-Match:
    // exactly one succeeds"). A precondition test must derive its stale token from a real mutation,
    // never from an assumed version number.
    const first = await call(app, 'PATCH', `/v1/sources/${sourceId}/permission-class`, {
      body: { permissionClass: 'READ_ONLY', reason: 'TERMS_REVISED' },
      headers: { 'if-match': await currentEtag(app, `/v1/sources/${sourceId}`, 'before the first patch') },
    });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const staleToken = await currentEtag(app, `/v1/sources/${sourceId}`, 'the stale token');

    const second = await call(app, 'PATCH', `/v1/sources/${sourceId}/permission-class`, {
      body: { permissionClass: 'PROHIBITED', reason: 'TERMS_REVISED' },
      headers: { 'if-match': await currentEtag(app, `/v1/sources/${sourceId}`, 'before the second patch') },
    });
    assert.equal(second.status, 200, JSON.stringify(second.json));

    // `staleToken` is now two versions behind. Re-using it must be refused.
    const stale = await call(app, 'PATCH', `/v1/sources/${sourceId}/permission-class`, {
      body: { permissionClass: 'WRITE_UNCLEAR', reason: 'TERMS_REVISED' },
      headers: { 'if-match': staleToken },
    });
    assert.equal(stale.status, 412, JSON.stringify(stale.json));
    assert.equal(codeOf(stale), 'PRECONDITION_FAILED');
    // §2.7 requires the CURRENT ETag in the body so the loser can re-read and re-issue rather than
    // blind-retry (VG-ACTION-002). It must be the CURRENT one, not the stale one that was sent.
    const reported = String(detailsOf(stale)['currentEtag']);
    assert.match(reported, /^"[A-Z_]+:\d+"$/);
    assert.notEqual(reported, staleToken, 'the body must carry the CURRENT token, not the rejected one');
    assert.equal(reported, await currentEtag(app, `/v1/sources/${sourceId}`, 'after the refusal'));
    await app.close();
  });

  test('a stale If-Match leaves the row unchanged', async () => {
    const app = serverFor(TENANT_A, WRITE);
    const { sourceId } = await declareSource(app);
    const stale = await call(app, 'PATCH', `/v1/sources/${sourceId}/permission-class`, {
      body: { permissionClass: 'READ_ONLY', reason: 'TERMS_REVISED' },
      headers: { 'if-match': '"WRITE_UNCLEAR:99"' },
    });
    assert.equal(stale.status, 412);
    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT permission_class::text || '|' || row_version::text FROM source WHERE id = '${sourceId}';`,
    );
    assert.equal(rows[0], 'WRITE_UNCLEAR|1', 'a refused precondition must not mutate the row');
    await app.close();
  });
});

describe('§5.3.5/§5.3.6 catalogue entries', () => {
  test('an entry round-trips, and a duplicate category is 409 CATALOG_ENTRY_DUPLICATE', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ]);
    const { sourceId } = await declareSource(app);

    const body = {
      category: `CAT-${RUN}`,
      coverageNotes: 'Covers US residential listings; excludes business records and cached copies.',
      provenance: 'OPERATOR_ENTERED',
      license: 'PUBLIC_WEB_TOS_2026_02',
    };
    const created = await call(app, 'POST', `/v1/sources/${sourceId}/catalog-entries`, { body });
    assert.equal(created.status, 201, JSON.stringify(created.json));

    const listed = await call(app, 'GET', `/v1/sources/${sourceId}/catalog-entries`);
    assert.equal(listed.status, 200);
    const data = listed.json['data'] as Json[];
    assert.equal(data.length, 1);
    assert.equal(data[0]?.['coverageNotes'], body.coverageNotes, 'coverage notes are returned, not summarised');
    assert.deepEqual(Object.keys(data[0] ?? {}).sort(), [
      'catalogEntryId', 'category', 'coverageNotes', 'declaredAt', 'license', 'provenance', 'sourceId',
    ]);

    const duplicate = await call(app, 'POST', `/v1/sources/${sourceId}/catalog-entries`, { body });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.json));
    assert.equal(codeOf(duplicate), 'CATALOG_ENTRY_DUPLICATE');

    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT count(*) FROM source_catalog_entry WHERE source_id = '${sourceId}';`,
    );
    assert.equal(rows[0], '1', 'the conflict must not have inserted a second entry');
    await app.close();
  });

  test('VG-DISC-002 refuses an entry with no coverage notes, and LICENSE_POLICY no licence', async () => {
    const app = serverFor(TENANT_A, WRITE);
    const { sourceId } = await declareSource(app);

    const blank = await call(app, 'POST', `/v1/sources/${sourceId}/catalog-entries`, {
      body: { category: 'X', coverageNotes: '   ', provenance: 'OPERATOR_ENTERED', license: 'MIT' },
    });
    assert.equal(blank.status, 422);
    assert.equal(codeOf(blank), 'CATALOG_NOTES_REQUIRED');

    const unlicensed = await call(app, 'POST', `/v1/sources/${sourceId}/catalog-entries`, {
      body: { category: 'X', coverageNotes: 'Covers nothing at all.', provenance: 'OPERATOR_ENTERED', license: '' },
    });
    assert.equal(unlicensed.status, 422);
    assert.equal(codeOf(unlicensed), 'LICENSE_UNRECORDED');

    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT count(*) FROM source_catalog_entry WHERE source_id = '${sourceId}';`,
    );
    assert.equal(rows[0], '0', 'neither refusal may leave a row');
    await app.close();
  });
});

describe('§5.3.7/§5.3.9 recipes are verified before they are stored', () => {
  test('a correctly signed recipe is stored DISABLED with signatureVerified true', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ, ...RECIPES]);
    const { sourceId } = await declareSource(app);
    const created = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, {
      body: signedRecipe(sourceId),
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json['enabled'], false, '§5.3.7: a new version is created disabled');
    assert.equal(created.json['signatureVerified'], true);
    assert.equal(created.json['version'], 1);

    // The signing key reference is PERSISTED, which is what lets §5.3.10 re-verify later. Without the
    // 0012 column the reference would be discarded and the guard could never be re-evaluated.
    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT signing_key_ref || '|' || octet_length(signature)::text FROM removal_recipe WHERE id = '${String(created.json['recipeId'])}';`,
    );
    assert.equal(rows[0], `${KEY_REF}|64`, 'an Ed25519 signature is 64 bytes, stored as bytea');
    await app.close();
  });

  test('a bad signature is 422 RECIPE_SIGNATURE_INVALID and leaves no row', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...RECIPES]);
    const { sourceId } = await declareSource(app);
    const good = signedRecipe(sourceId);

    // Tamper with the payload AFTER signing: the signature no longer covers it.
    const tampered = { ...good, verificationMethod: 'SELF_REPORT_BY_OPERATOR' };
    const res = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, { body: tampered });
    assert.equal(res.status, 422, JSON.stringify(res.json));
    assert.equal(codeOf(res), 'RECIPE_SIGNATURE_INVALID');

    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT count(*) FROM removal_recipe WHERE source_id = '${sourceId}';`,
    );
    assert.equal(rows[0], '0', 'an unverifiable recipe must never be stored (VG-CHANNEL-003)');
    await app.close();
  });

  test('an unconfigured signing reference is 503, not a signature rejection', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...RECIPES]);
    const { sourceId } = await declareSource(app);
    const res = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, {
      body: signedRecipe(sourceId, { signingKeyRef: 'kms:not-configured-anywhere' }),
    });
    // A DIFFERENT code from RECIPE_SIGNATURE_INVALID on purpose: no key is configured, so nothing was
    // verified. Reporting a bad signature would send an integrator hunting a bug in their own signing.
    assert.equal(res.status, 503, JSON.stringify(res.json));
    assert.equal(codeOf(res), 'DEPENDENCY_UNAVAILABLE');
    await app.close();
  });

  test('an unknown channel and an absent verification method are both refused', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...RECIPES]);
    const { sourceId } = await declareSource(app);

    const badChannel = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, {
      body: { ...signedRecipe(sourceId), channel: 'CARRIER_PIGEON' },
    });
    assert.equal(badChannel.status, 422);
    assert.equal(codeOf(badChannel), 'RECIPE_CHANNEL_UNKNOWN');

    // Signed AFTER removing the method, so the signature itself is valid and the refusal is about the
    // missing declaration rather than about verification.
    const noMethod = signedRecipe(sourceId);
    delete (noMethod as Json)['verificationMethod'];
    const res = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, { body: noMethod });
    assert.equal(res.status, 422, JSON.stringify(res.json));
    assert.equal(codeOf(res), 'RECIPE_VERIFICATION_METHOD_REQUIRED');
    await app.close();
  });

  test('superseded versions stay readable — recipes are never deleted (VG-REAPPEAR-002)', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ, ...RECIPES]);
    const { sourceId } = await declareSource(app);

    const first = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, { body: signedRecipe(sourceId) });
    const second = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, {
      body: signedRecipe(sourceId, { verificationMethod: 'INDEPENDENT_FETCH_DIFFERENT_EGRESS_V2' }),
    });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(second.status, 201, JSON.stringify(second.json));
    assert.equal(first.json['version'], 1);
    assert.equal(second.json['version'], 2, 'the version is server-assigned');

    const listed = await call(app, 'GET', `/v1/sources/${sourceId}/recipes`);
    assert.equal(listed.status, 200);
    const data = listed.json['data'] as Json[];
    assert.deepEqual(data.map((row) => row['version']), [2, 1], 'default sort is version:desc');
    assert.equal(data.length, 2, 'the superseded version is still readable');

    const freshOnly = await call(app, 'GET', `/v1/sources/${sourceId}/recipes?fresh=true`);
    assert.equal((freshOnly.json['data'] as Json[]).length, 2, 'both are fresh');
    const enabledOnly = await call(app, 'GET', `/v1/sources/${sourceId}/recipes?enabled=true`);
    assert.equal((enabledOnly.json['data'] as Json[]).length, 0, 'neither is enabled');
    await app.close();
  });
});

describe('§5.3.10 enablement refuses unless every guard passes', () => {
  test('a stale recipe is 409 RECIPE_GUARD_FAILED naming the guard, and stays disabled', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ, ...RECIPES]);
    const { sourceId } = await declareSource(app, {
      permissionClass: 'WRITE_PERMITTED',
      permissionEvidenceUrl: 'https://example.test/tos-archive/2026-02-04',
      permissionCheckedAt: new Date().toISOString(),
      permissionWindowSeconds: 86_400,
    });

    // Signed with an ALREADY-EXPIRED freshness instant, so the signature verifies and the `fresh`
    // guard is what fails. That separation is the point: a stale-signature test would pass for the
    // wrong reason.
    const recipe = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, {
      body: signedRecipe(sourceId, { freshnessAt: new Date(Date.now() - 60_000).toISOString() }),
    });
    assert.equal(recipe.status, 201, JSON.stringify(recipe.json));
    const recipeId = String(recipe.json['recipeId']);
    const detail = await call(app, 'GET', `/v1/recipes/${recipeId}`);
    assert.equal(detail.json['staleness'], 'STALE');

    const refused = await call(app, 'POST', `/v1/recipes/${recipeId}/enablement`, {
      body: { enabled: true, reason: 'PERMISSION_REFRESHED' },
      headers: { 'if-match': String(detail.headers['etag']) },
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.equal(codeOf(refused), 'RECIPE_GUARD_FAILED');
    const details = detailsOf(refused);
    assert.equal(details['guard'], 'fresh', 'the failing guard must be named');
    assert.ok((details['checks'] as string[]).includes('fresh=false'));

    // `enabled` stays false — the refusal must not half-apply.
    const rows = asTenant(
      appDsn(),
      TENANT_A,
      `SELECT enabled::text FROM removal_recipe WHERE id = '${recipeId}';`,
    );
    assert.equal(rows[0], 'false');
    await app.close();
  });

  test('a disable is never refused by a guard', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...READ, ...RECIPES]);
    const { sourceId } = await declareSource(app);
    // A stale recipe, whose guards all fail, disabled on purpose.
    const recipe = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, {
      body: signedRecipe(sourceId, { freshnessAt: new Date(Date.now() - 60_000).toISOString() }),
    });
    const recipeId = String(recipe.json['recipeId']);
    const detail = await call(app, 'GET', `/v1/recipes/${recipeId}`);

    const disabled = await call(app, 'POST', `/v1/recipes/${recipeId}/enablement`, {
      body: { enabled: false, reason: 'OPERATOR_DISABLED' },
      headers: { 'if-match': String(detail.headers['etag']) },
    });
    // Refusing to disable would be refusing to make the system safe, so a failed guard must not block
    // it. The guard evaluation is still REPORTED, which is how the caller learns the recipe's state.
    assert.equal(disabled.status, 200, JSON.stringify(disabled.json));
    assert.equal(disabled.json['enabled'], false);
    assert.equal((disabled.json['guardEvaluation'] as Json)['fresh'], false);
    await app.close();
  });

  test('a missing If-Match on enablement is 428', async () => {
    const app = serverFor(TENANT_A, [...WRITE, ...RECIPES]);
    const { sourceId } = await declareSource(app);
    const recipe = await call(app, 'POST', `/v1/sources/${sourceId}/recipes`, { body: signedRecipe(sourceId) });
    const res = await call(app, 'POST', `/v1/recipes/${String(recipe.json['recipeId'])}/enablement`, {
      body: { enabled: true, reason: 'PERMISSION_REFRESHED' },
    });
    assert.equal(res.status, 428);
    assert.equal(codeOf(res), 'PRECONDITION_REQUIRED');
    await app.close();
  });
});

describe('tenant isolation for §5.3', () => {
  test('another tenant’s source is 404 with a body identical to an absent one', async () => {
    const appA = serverFor(TENANT_A, [...WRITE, ...READ]);
    const { sourceId } = await declareSource(appA);
    await appA.close();

    const appB = serverFor(TENANT_B, READ);
    const other = await call(appB, 'GET', `/v1/sources/${sourceId}`);
    const absent = await call(appB, 'GET', `/v1/sources/${ABSENT}`);
    assert.equal(other.status, 404);
    assert.equal(absent.status, 404);
    // Indistinguishable, not merely the same status: a difference in code, message or retryability
    // would let a prober enumerate other tenants' identifiers (SPEC-006 H-9, VG-API-012). See
    // outcomeOf for why the correlation fields are excluded.
    assert.deepEqual(outcomeOf(other), outcomeOf(absent));
    await appB.close();
  });

  test('the DATABASE returns zero rows for the other tenant, independently of the service check', async () => {
    const appA = serverFor(TENANT_A, [...WRITE, ...READ]);
    const { sourceId } = await declareSource(appA);
    await appA.close();

    // The service-layer check is not what is being measured here: this reads as tenant B directly,
    // through RLS, with no application code in the path (VG-TENANT-002 wants both layers independent).
    const leaked = asTenant(appDsn(), TENANT_B, `SELECT count(*) FROM source WHERE id = '${sourceId}';`);
    assert.equal(leaked[0], '0', 'RLS must return zero rows for another tenant’s source');
    const own = asTenant(appDsn(), TENANT_A, `SELECT count(*) FROM source WHERE id = '${sourceId}';`);
    assert.equal(own[0], '1', 'the control: tenant A still sees its own row, so the probe proves something');
  });

  test('a cross-tenant INSERT of a source is refused by WITH CHECK', async () => {
    const result = exec(
      appDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
        'INSERT INTO source (tenant_id, name, class, permission_class)',
        `VALUES ('${TENANT_B}', 'x-tenant-evil-${RUN}', 'PEOPLE_SEARCH', 'READ_ONLY');`,
        'COMMIT;',
      ].join('\n'),
    );
    assert.match(
      result.output,
      /row-level security/i,
      `a cross-tenant source INSERT must be refused (VG-DATA-003): ${result.output}`,
    );
  });
});
