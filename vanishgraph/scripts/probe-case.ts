/** Temporary probe: run one PATCH through the real server with error logging on. Delete after use. */
import { generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto';

import { buildServer } from '../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN } from '../tests/contract/server-support.ts';
import { parseDsn, runSql } from '../src/infrastructure/database/psql.ts';
import { PostgresTenantRunner } from '../src/adapters/persistence/postgres-runner.ts';
import { PostgresCaseQueries } from '../src/adapters/persistence/cases.ts';
import { PostgresTransitionQueries } from '../src/adapters/persistence/transitions.ts';
import { PostgresExposureQueries } from '../src/adapters/persistence/exposures.ts';
import { PostgresObservationQueries } from '../src/adapters/persistence/observations.ts';
import { PostgresAuditQueries } from '../src/adapters/persistence/audit-queries.ts';
import { PostgresDeadlineQueries } from '../src/adapters/persistence/deadlines.ts';
import { PostgresAppealQueries } from '../src/adapters/persistence/appeals.ts';
import { PostgresSubjectQueries } from '../src/adapters/persistence/subjects.ts';
import { PostgresSourceQueries } from '../src/adapters/persistence/sources.ts';
import { canonicalRecipePayload } from '../src/adapters/persistence/sources.ts';
import { PostgresIdempotencyStore } from '../src/adapters/idempotency/postgres-store.ts';
import { findRoute } from '../src/http/openapi/registry.ts';

const owner = parseDsn(process.env['VG_TEST_DSN_OWNER'] ?? '');
const appDsn = parseDsn(process.env['VG_TEST_DSN_APP'] ?? '');
const RUN = randomUUID().slice(0, 8);
const TENANT = randomUUID();
const KEYS = generateKeyPairSync('ed25519');
const KEY_REF = `key-${RUN}`;
const PUBLIC_PEM = KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const caseId = randomUUID();
const subjectId = randomUUID();
const grantId = randomUUID();
const sourceId = randomUUID();
const recipeId = randomUUID();
const recordId = randomUUID();
const exposureId = randomUUID();
const decisionId = randomUUID();
const jurisdiction = `US-C${RUN.slice(0, 2).toUpperCase()}`;
const freshnessAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const payload = canonicalRecipePayload({
  sourceId,
  channel: 'OFFICIAL_SELF_SERVICE',
  verificationMethod: 'independent-fetch',
  signingKeyRef: KEY_REF,
  freshnessAt: freshnessAt.toISOString(),
  maxAttemptsPerWindow: 5,
  windowSeconds: 86400,
});
const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), KEYS.privateKey);

const result = runSql(
  owner,
  [
    'BEGIN;',
    `INSERT INTO tenant (id, name, status) VALUES ('${TENANT}', 'probe-case-${RUN}', 'ACTIVE');`,
    `SELECT set_config('app.tenant_id', '${TENANT}', true);`,
    `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status) VALUES ('${subjectId}', '${TENANT}', 'probe-case-subject-${RUN}', '${jurisdiction}', false, 'ACTIVE');`,
    `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, signed_instrument) VALUES ('${grantId}', '${TENANT}', '${subjectId}', 'SELF', ARRAY['discovery','self_service_write'], now() - interval '1 day', now() + interval '30 days', false);`,
    `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class, permission_checked_at) VALUES ('${sourceId}', '${TENANT}', 'probe-case-source-${RUN}', 'REGISTRY', '${jurisdiction}', 'WRITE_PERMITTED', now());`,
    `INSERT INTO removal_recipe (id, tenant_id, source_id, version, signature, channel, verification_method, freshness_at, enabled, signing_key_ref, max_attempts_per_window, window_seconds) VALUES ('${recipeId}', '${TENANT}', '${sourceId}', 1, decode('${signature.toString('hex')}', 'hex'), 'OFFICIAL_SELF_SERVICE', 'independent-fetch', '${freshnessAt.toISOString()}', true, '${KEY_REF}', 5, 86400);`,
    `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted) VALUES ('${recordId}', '${TENANT}', '${sourceId}', 'https://example.invalid/probe-${RUN}', now(), repeat('e', 64), false);`,
    `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state) VALUES ('${exposureId}', '${TENANT}', '${subjectId}', '${recordId}', 0.91, '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, 'MATCH_CONFIRMED');`,
    `INSERT INTO jurisdiction_policy (id, tenant_id, jurisdiction, version, effective_from, rules, provenance, match_confidence_threshold) VALUES ('${randomUUID()}', '${TENANT}', '${jurisdiction}', 1, now() - interval '1 day', ARRAY['CCPA_DELETE'], 'COUNSEL_REVIEWED', 0.85);`,
    `INSERT INTO policy_decision (id, tenant_id, case_id, jurisdiction, legal_basis, channel, policy_version, reasons, decided_at) VALUES ('${decisionId}', '${TENANT}', '${caseId}', '${jurisdiction}', 'CCPA_DELETE', 'OFFICIAL_SELF_SERVICE', 1, '["consumer-request-right"]'::jsonb, now());`,
    `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, policy_decision_id, recipe_id, truth_state) VALUES ('${caseId}', '${TENANT}', '${subjectId}', '${exposureId}', '${sourceId}', '${grantId}', '${decisionId}', '${recipeId}', 'MATCH_CONFIRMED');`,
    'COMMIT;',
  ].join('\n'),
);
console.log('fixture', String(result.status), result.status === 0 ? '' : result.output.slice(-500));

const runner = new PostgresTenantRunner({ dsn: appDsn, maxConnections: 2 });
const app = buildServer({
  version: 'probe',
  commit: 'probe',
  logLevel: 'error',
  identity: testIdentity({ tenantId: TENANT, scopes: ['vg.cases.read', 'vg.cases.write'] }),
  tenancy: { runner },
  idempotency: {
    store: new PostgresIdempotencyStore({ dsn: appDsn }),
    requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
  },
  sessionSecret: TEST_SESSION_SECRET,
  subjectQueries: new PostgresSubjectQueries(),
  sourceQueries: new PostgresSourceQueries(),
  recipeVerificationKeys: { publicKeysByRef: new Map([[KEY_REF, PUBLIC_PEM]]) },
  appealQueries: new PostgresAppealQueries(),
  deadlineQueries: new PostgresDeadlineQueries(),
  auditQueries: new PostgresAuditQueries(),
  observationQueries: new PostgresObservationQueries(),
  exposureQueries: new PostgresExposureQueries(),
  transitionQueries: new PostgresTransitionQueries(),
  caseQueries: new PostgresCaseQueries({ recipeVerificationKeys: { publicKeysByRef: new Map([[KEY_REF, PUBLIC_PEM]]) } }),
  health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
});

const detail = await app.inject({
  method: 'GET',
  url: `/v1/cases/${caseId}`,
  headers: { authorization: `Bearer ${TEST_TOKEN}` },
});
console.log('detail', String(detail.statusCode), detail.body.slice(0, 400));

const patch = await app.inject({
  method: 'PATCH',
  url: `/v1/cases/${caseId}`,
  headers: {
    authorization: `Bearer ${TEST_TOKEN}`,
    'content-type': 'application/json',
    'idempotency-key': `probe-case-key-${RUN}`,
    'if-match': String(detail.headers['etag']),
  },
  payload: { requestedTruthState: 'REQUEST_READY', reason: { code: 'PREPARE', detail: 'probe' } },
});
console.log('patch', String(patch.statusCode), patch.body.slice(0, 400));

await app.close();
await runner.close();
