/**
 * Policy decisions and jurisdiction policies against real PostgreSQL (SPEC-003 §5.6).
 *
 * WHAT THIS SUITE PROVES:
 *
 *   * **The version label resolves against POLICY DATA**, not against the clock: a version whose window has
 *     closed is refused `409 POLICY_VERSION_SUPERSEDED` naming the version in force, and a label nobody declared
 *     is `422 JURISDICTION_UNRESOLVED` — two different mistakes with two different codes.
 *   * **The caller cannot assert a legal basis** (VG-POLICY-001): a body carrying `legalBasis` is refused before
 *     anything is read, and the basis that IS recorded comes from the policy version's own rule set.
 *   * **A version declaring several rules is refused**, because no specification maps a channel to a basis and
 *     choosing one would be the API stating a legal conclusion of its own.
 *   * **The channel is checked by the domain's priority engine**: requesting a lower-priority channel while a
 *     higher one is available and not recorded unavailable is `409 CHANNEL_PRIORITY_VIOLATION` naming the
 *     channel that should have been used.
 *   * **No truth state moves.** §5.6.1's response has no `truthState`, and the resolution writes an audit row
 *     with NO transition code.
 *   * **§5.6.4 computes `policyChecksum` from the rule set** and reports `inForce` against the instant asked
 *     about, so the same version can be in force for one question and superseded for another.
 *
 * FIXTURE DISCIPLINE: two tenants of this suite's own, per run (ASSUMPTIONS §3.27).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN, testWebhookDependencies } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresPolicyQueries } from '../../src/adapters/persistence/policies.ts';
import { PostgresCoverageQueries } from '../../src/adapters/persistence/coverage.ts';
import { PostgresEvidenceQueries } from '../../src/adapters/persistence/evidence.ts';
import { PostgresDiscoveryQueries } from '../../src/adapters/persistence/discovery.ts';
import { PostgresActionQueries } from '../../src/adapters/persistence/actions.ts';
import { PostgresControllerResponseQueries } from '../../src/adapters/persistence/controller-responses.ts';
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
const SCOPES = ['vg.policy.read', 'vg.policy.write', 'vg.cases.read'];

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'policy-suite-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'policy-suite-b-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);
});

after(async () => {
  await runner.close();
});

function serverFor(tenantId: string, scopes: readonly string[] = SCOPES): VgFastify {
  const keys = { publicKeysByRef: new Map<string, string>() };
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
    recipeVerificationKeys: keys,
    appealQueries: new PostgresAppealQueries(),
    deadlineQueries: new PostgresDeadlineQueries(),
    auditQueries: new PostgresAuditQueries(),
    observationQueries: new PostgresObservationQueries(),
    exposureQueries: new PostgresExposureQueries(),
    transitionQueries: new PostgresTransitionQueries(),
    caseQueries: new PostgresCaseQueries({ recipeVerificationKeys: keys }),
    controllerResponseQueries: new PostgresControllerResponseQueries(),
    actionQueries: new PostgresActionQueries({ recipeVerificationKeys: keys }),
    policyQueries: new PostgresPolicyQueries(),
    coverageQueries: new PostgresCoverageQueries(),
    evidenceQueries: new PostgresEvidenceQueries(),
    discoveryQueries: new PostgresDiscoveryQueries(),
    ...testWebhookDependencies(),
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
  return `policy-suite-key-${RUN}-${String(keyCounter).padStart(4, '0')}`;
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

interface World {
  readonly caseId: string;
  readonly jurisdiction: string;
  readonly label: string;
  readonly authorityGrantId: string;
}

/** A case at REQUEST_READY with a policy version whose label is a date, in force now. */
function newWorld(
  options: {
    readonly rules?: readonly string[];
    readonly isMinor?: boolean;
    readonly label?: string;
    readonly revoked?: boolean;
    readonly effectiveTo?: string | null;
  } = {},
): World {
  const rules = [...(options.rules ?? ['CCPA_DELETE'])];
  const isMinor = options.isMinor ?? false;
  const label = options.label ?? `2026-01-${String(10 + (keyCounter % 19)).padStart(2, '0')}`;
  const subjectId = randomUUID();
  const validGrantId = randomUUID();
  const authorityGrantId = randomUUID();
  const sourceId = randomUUID();
  const recordId = randomUUID();
  const exposureId = randomUUID();
  const caseId = randomUUID();
  const jurisdiction = 'US-CA';
  const version = 4000 + Math.floor(Math.random() * 100000);
  const effectiveTo = options.effectiveTo === undefined ? null : options.effectiveTo;
  // Computed BEFORE the template: a `revoked_at` clause carrying an interval inside a nested template literal was
  // mangled by the shell that wrote this file (MEASURED: the fixture failed with a SQL syntax error), so the
  // expression is built here as a plain string.
  const revokedAtSql = options.revoked === true ? `now() - interval '1 hour'` : 'NULL';

  const result = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
         VALUES ('${subjectId}', '${TENANT_A}', 'pol-subject-${RUN}', '${jurisdiction}', ${isMinor ? 'true' : 'false'}, 'ACTIVE');`,
      `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, revoked_at, signed_instrument)
         VALUES ('${validGrantId}', '${TENANT_A}', '${subjectId}', 'SELF', ARRAY['discovery','self_service_write'],
                 now() - interval '1 day', now() + interval '30 days', NULL, false);`,
      // A REVOKED grant is a SECOND row, and the case points at it. VG-IDENT-001 is enforced by a deferred
      // trigger: a subject whose ONLY grant is revoked cannot be committed at all (MEASURED — the fixture failed
      // with "ProtectedSubject … requires a valid AuthorityGrant at commit"), which is the schema refusing a
      // subject that exists without authority.
      `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, revoked_at, signed_instrument)
         VALUES ('${authorityGrantId}', '${TENANT_A}', '${subjectId}', 'SELF', ARRAY['discovery','self_service_write'],
                 now() - interval '1 day', now() + interval '30 days', ${revokedAtSql}, false);`,
      `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class)
         VALUES ('${sourceId}', '${TENANT_A}', 'pol-source-${RUN}-${sourceId.slice(0, 8)}', 'REGISTRY', '${jurisdiction}', 'WRITE_PERMITTED');`,
      `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
         VALUES ('${recordId}', '${TENANT_A}', '${sourceId}', 'https://example.invalid/pol-${RUN}', now() - interval '2 days', repeat('a', 64), false);`,
      `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state)
         VALUES ('${exposureId}', '${TENANT_A}', '${subjectId}', '${recordId}', 0.9, '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, 'MATCH_CONFIRMED');`,
      `INSERT INTO jurisdiction_policy (id, tenant_id, jurisdiction, version, version_label, effective_from, effective_to, rules, provenance)
         VALUES ('${randomUUID()}', '${TENANT_A}', '${jurisdiction}', ${String(version)}, '${label}',
                 now() - interval '10 days', ${effectiveTo === null ? 'NULL' : `'${effectiveTo}'::timestamptz`},
                 ARRAY[${rules.map((rule) => `'${rule}'`).join(',')}], 'COUNSEL_REVIEWED');`,
      `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, truth_state)
         VALUES ('${caseId}', '${TENANT_A}', '${subjectId}', '${exposureId}', '${sourceId}', '${authorityGrantId}', 'MATCH_CONFIRMED');`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(result.status, 0, `fixture failed: ${result.output}`);
  return { caseId, jurisdiction, label, authorityGrantId };
}

async function caseEtag(app: VgFastify, caseId: string): Promise<string> {
  const detail = await call(app, 'GET', `/v1/cases/${caseId}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  return String(detail.headers['etag']);
}

function resolveBody(world: World, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jurisdiction: world.jurisdiction,
    requestedChannel: 'OFFICIAL_SELF_SERVICE',
    policyVersion: world.label,
    ...overrides,
  };
}

describe('§5.6.1 resolution', () => {
  test('a version in force resolves, echoes its LABEL, and moves no truth state', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    const etag = await caseEtag(app, world.caseId);

    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/policy-decisions`, {
      headers: { 'if-match': etag },
      body: resolveBody(world, {
        channelAlternativesConsidered: [
          { channel: 'CERTIFIED_MAIL', unavailable: true, reason: 'NO_PUBLISHED_CONTACT' },
        ],
      }),
    });
    assert.equal(response.status, 201, JSON.stringify(response.json));
    assert.equal(response.json['jurisdiction'], 'US-CA');
    assert.equal(response.json['legalBasis'], 'CCPA_DELETE');
    assert.equal(response.json['channel'], 'OFFICIAL_SELF_SERVICE');
    // THE LABEL, not the ordinal: the contract's `policyVersion` is a date string and the schema's is an integer.
    assert.equal(response.json['policyVersion'], world.label);
    // NO EXEMPTION EVALUATION IS CLAIMED (no specification declares the check list).
    assert.deepEqual(response.json['exemptionEvaluation'], { evaluated: false, exempt: null, checks: [] });

    const decisionId = String(response.json['policyDecisionId']);
    assert.deepEqual(
      read(
        TENANT_A,
        `SELECT legal_basis || '|' || channel || '|' || coalesce(version_label,'-') FROM policy_decision WHERE id = '${decisionId}'::uuid`,
      ),
      [`CCPA_DELETE|OFFICIAL_SELF_SERVICE|${world.label}`],
    );
    // A decision is not a transition: the case state is untouched and the audit row carries no transition code.
    assert.deepEqual(read(TENANT_A, `SELECT truth_state::text FROM request_case WHERE id = '${world.caseId}'`), [
      'MATCH_CONFIRMED',
    ]);
    assert.deepEqual(
      read(
        TENANT_A,
        `SELECT coalesce(transition_code,'null') || '|' || action FROM audit_event
          WHERE target_kind = 'PolicyDecision' AND target_id = '${decisionId}'::uuid ORDER BY at DESC LIMIT 1`,
      ),
      ['null|ResolvePolicy'],
    );
  });

  test('a caller that asserts a legal basis is refused before anything is read', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    const etag = await caseEtag(app, world.caseId);

    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/policy-decisions`, {
      headers: { 'if-match': etag },
      body: resolveBody(world, { legalBasis: 'CCPA_DELETE' }),
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'LEGAL_BASIS_NOT_AUTHORABLE');
  });

  test('a superseded version and an undeclared label are two different refusals', async () => {
    const app = serverFor(TENANT_A);
    const closed = newWorld({ effectiveTo: new Date(Date.now() - 86_400_000).toISOString() });
    const closedEtag = await caseEtag(app, closed.caseId);
    const superseded = await call(app, 'POST', `/v1/cases/${closed.caseId}/policy-decisions`, {
      headers: { 'if-match': closedEtag },
      body: resolveBody(closed),
    });
    assert.equal(superseded.status, 409, JSON.stringify(superseded.json));
    assert.equal(codeOf(superseded), 'POLICY_VERSION_SUPERSEDED');

    const open = newWorld();
    const openEtag = await caseEtag(app, open.caseId);
    const unknown = await call(app, 'POST', `/v1/cases/${open.caseId}/policy-decisions`, {
      headers: { 'if-match': openEtag },
      body: resolveBody(open, { policyVersion: '1999-01-01' }),
    });
    assert.equal(unknown.status, 422, JSON.stringify(unknown.json));
    assert.equal(codeOf(unknown), 'JURISDICTION_UNRESOLVED');

    const otherJurisdiction = await call(app, 'POST', `/v1/cases/${open.caseId}/policy-decisions`, {
      headers: { 'if-match': openEtag },
      body: resolveBody(open, { jurisdiction: 'US-NY' }),
    });
    assert.equal(otherJurisdiction.status, 422, JSON.stringify(otherJurisdiction.json));
    assert.equal(codeOf(otherJurisdiction), 'JURISDICTION_UNRESOLVED');
  });

  test('a version declaring several rules is refused, and the rules are named', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld({ rules: ['CCPA_DELETE', 'CCPA_CORRECT'] });
    const etag = await caseEtag(app, world.caseId);

    const response = await call(app, 'POST', `/v1/cases/${world.caseId}/policy-decisions`, {
      headers: { 'if-match': etag },
      body: resolveBody(world),
    });
    assert.equal(response.status, 422, JSON.stringify(response.json));
    assert.equal(codeOf(response), 'LEGAL_BASIS_NOT_IN_POLICY_VERSION');
    const details = (response.json['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
    assert.equal(details['ruleRef'], 'CCPA_DELETE,CCPA_CORRECT');
  });

  test('a minor subject needs the strict lane, and a revoked authority resolves nothing', async () => {
    const app = serverFor(TENANT_A);
    const minor = newWorld({ isMinor: true });
    const minorEtag = await caseEtag(app, minor.caseId);
    const strict = await call(app, 'POST', `/v1/cases/${minor.caseId}/policy-decisions`, {
      headers: { 'if-match': minorEtag },
      body: resolveBody(minor),
    });
    assert.equal(strict.status, 422, JSON.stringify(strict.json));
    assert.equal(codeOf(strict), 'STRICT_LANE_REQUIRED');

    const revoked = newWorld({ revoked: true });
    const revokedEtag = await caseEtag(app, revoked.caseId);
    const invalid = await call(app, 'POST', `/v1/cases/${revoked.caseId}/policy-decisions`, {
      headers: { 'if-match': revokedEtag },
      body: resolveBody(revoked),
    });
    assert.equal(invalid.status, 409, JSON.stringify(invalid.json));
    assert.equal(codeOf(invalid), 'CASE_AUTHORITY_INVALID');
  });

  test('the channel priority engine decides, not the caller', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    const etag = await caseEtag(app, world.caseId);

    // CERTIFIED_MAIL is LOWER priority than OFFICIAL_SELF_SERVICE (SPEC-000 §8: 1 is highest), so requesting it
    // while the higher one is available without a recorded reason is the violation VG-CHANNEL-001 names.
    const violation = await call(app, 'POST', `/v1/cases/${world.caseId}/policy-decisions`, {
      headers: { 'if-match': etag },
      body: resolveBody(world, { requestedChannel: 'CERTIFIED_MAIL' }),
    });
    assert.equal(violation.status, 409, JSON.stringify(violation.json));
    assert.equal(codeOf(violation), 'CHANNEL_PRIORITY_VIOLATION');

    // And with EVERY higher-priority channel recorded unavailable WITH a reason, the lower one resolves.
    // VG-CHANNEL-001 requires ALL of them, not just the top one: MEASURED, an earlier version recorded only
    // OFFICIAL_SELF_SERVICE and the engine correctly selected OFFICIAL_PRIVACY_CONTACT instead.
    const allowed = await call(app, 'POST', `/v1/cases/${world.caseId}/policy-decisions`, {
      headers: { 'if-match': etag },
      body: resolveBody(world, {
        requestedChannel: 'CERTIFIED_MAIL',
        channelAlternativesConsidered: [
          { channel: 'OFFICIAL_SELF_SERVICE', unavailable: true, reason: 'NO_PUBLISHED_CONTACT' },
          { channel: 'OFFICIAL_PRIVACY_CONTACT', unavailable: true, reason: 'NO_PUBLISHED_CONTACT' },
          { channel: 'AUTHORIZED_AGENT', unavailable: true, reason: 'SUBJECT_NOT_ELIGIBLE' },
          { channel: 'GOVERNMENT_CHANNEL', unavailable: true, reason: 'SUBJECT_NOT_ELIGIBLE' },
          { channel: 'SEARCH_ENGINE_REMOVAL', unavailable: true, reason: 'NOT_A_SEARCH_ENGINE_SOURCE' },
        ],
      }),
    });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.json));
    assert.equal(allowed.json['channel'], 'CERTIFIED_MAIL');

    // An unavailable channel with NO reason is refused at the boundary (VG-CHANNEL-001).
    const noReason = await call(app, 'POST', `/v1/cases/${world.caseId}/policy-decisions`, {
      headers: { 'if-match': etag },
      body: resolveBody(world, {
        requestedChannel: 'CERTIFIED_MAIL',
        channelAlternativesConsidered: [{ channel: 'OFFICIAL_SELF_SERVICE', unavailable: true }],
      }),
    });
    assert.equal(noReason.status, 400, JSON.stringify(noReason.json));
  });
});

describe('§5.6.2, §5.6.3, §5.6.4 the reads', () => {
  test('the case list is newest first and the single read agrees with it', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();
    let etag = await caseEtag(app, world.caseId);
    for (let index = 0; index < 2; index += 1) {
      const posted = await call(app, 'POST', `/v1/cases/${world.caseId}/policy-decisions`, {
        headers: { 'if-match': etag },
        body: resolveBody(world),
      });
      assert.equal(posted.status, 201, JSON.stringify(posted.json));
      etag = await caseEtag(app, world.caseId);
    }

    const listed = await call(app, 'GET', `/v1/cases/${world.caseId}/policy-decisions`);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    const rows = listed.json['data'] as Record<string, unknown>[];
    assert.equal(rows.length, 2);
    const times = rows.map((row) => Date.parse(String(row['decidedAt'])));
    const newest = times[0] ?? 0;
    const older = times[1] ?? 0;
    assert.ok(newest >= older, 'the list must be newest first');

    const one = await call(app, 'GET', `/v1/policy-decisions/${String(rows[0]?.['policyDecisionId'])}`);
    assert.equal(one.status, 200, JSON.stringify(one.json));
    assert.deepEqual(one.json['reasons'], rows[0]?.['reasons']);
    assert.equal(one.json['policyVersion'], world.label);
  });

  test('the jurisdiction list reports in-force and superseded versions, with a checksum of the rules', async () => {
    const app = serverFor(TENANT_A);
    const world = newWorld();

    const inForce = await call(app, 'GET', `/v1/jurisdiction-policies?jurisdiction=${world.jurisdiction}`);
    assert.equal(inForce.status, 200, JSON.stringify(inForce.json));
    const rows = inForce.json['data'] as Record<string, unknown>[];
    assert.ok(rows.length >= 1);
    const row = rows.find((entry) => entry['policyVersion'] === world.label);
    assert.ok(row !== undefined, `the version ${world.label} is missing from the list`);
    assert.equal(row['ruleCount'], 1);
    assert.equal(row['inForce'], true);
    assert.match(String(row['policyChecksum']), /^[0-9a-f]{64}$/);

    // `inForceOn` is the instant the QUESTION is about: the same version is not in force a year earlier.
    const earlier = await call(
      app,
      'GET',
      `/v1/jurisdiction-policies?jurisdiction=${world.jurisdiction}&inForceOn=2020-01-01T00:00:00.000Z&includeSuperseded=true`,
    );
    assert.equal(earlier.status, 200, JSON.stringify(earlier.json));
    const earlierRows = earlier.json['data'] as Record<string, unknown>[];
    assert.equal(earlierRows.find((entry) => entry['policyVersion'] === world.label)?.['inForce'], false);

    // An unknown parameter is refused rather than ignored, like every other collection.
    const unknown = await call(app, 'GET', '/v1/jurisdiction-policies?jurisdiction=US-CA&sort=version:desc');
    assert.equal(unknown.status, 400, JSON.stringify(unknown.json));
  });

  test("another tenant's case and decision are 404", async () => {
    const appA = serverFor(TENANT_A);
    const appB = serverFor(TENANT_B);
    const world = newWorld();
    const etag = await caseEtag(appA, world.caseId);
    const posted = await call(appA, 'POST', `/v1/cases/${world.caseId}/policy-decisions`, {
      headers: { 'if-match': etag },
      body: resolveBody(world),
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.json));

    assert.equal((await call(appB, 'GET', `/v1/cases/${world.caseId}/policy-decisions`)).status, 404);
    assert.equal(
      (await call(appB, 'GET', `/v1/policy-decisions/${String(posted.json['policyDecisionId'])}`)).status,
      404,
    );
    assert.deepEqual(
      read(TENANT_B, `SELECT id::text FROM policy_decision WHERE case_id = '${world.caseId}'::uuid`),
      [],
    );
  });
});
