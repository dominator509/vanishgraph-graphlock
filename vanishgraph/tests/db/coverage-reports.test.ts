/**
 * SPEC-003 §5.16 against real PostgreSQL (EP-004 M6).
 *
 * WHAT THIS SUITE PROVES, and what it deliberately does not.
 *
 * IT PROVES THE READ PATHS AND THE METRIC ARITHMETIC. Every row the routes return is read from real tables through
 * the real adapter, against a real database with RLS forced; the metric's cohort, exclusions and ratio are computed
 * by real SQL over rows this suite inserted, and the numbers are asserted against a world whose composition is
 * known by construction.
 *
 * IT DOES NOT PROVE A DISCOVERY PIPELINE, BECAUSE THERE ISN'T ONE. `coverage_report` has NO PRODUCER in this
 * repository: §5.16.2's rows are produced by a discovery run (§5.4), and §5.4's `DiscoveryRun` aggregate is defined
 * by no specification (ASSUMPTIONS §3.34). The `INSERT` statements below are FIXTURES standing in for that
 * producer — a test writing its own rows proves the read path and nothing more. Reading this suite as evidence that
 * coverage reports are generated would be exactly the mistake the repository's honesty rules exist to prevent.
 *
 * THE TESTS USE THE SEEDED TENANTS' IDS BUT NEVER THEIR ROWS. Every fixture row is created by this suite with a
 * fresh UUID and a `RUN` marker, because other suites assert "exactly one seeded subject" and a world built inside
 * the seed would break them.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { PostgresCoverageQueries } from '../../src/adapters/persistence/coverage.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import {
  TEST_SESSION_SECRET,
  TEST_TOKEN,
  testIdentity,
  testServerDependencies,
} from '../contract/server-support.ts';
import { appDsn, exec, ownerDsn } from './harness.ts';

const SCOPES = ['vg.coverage.read'];
const RUN = randomUUID().slice(0, 8);
// THIS SUITE'S OWN TENANTS, per run. A world built inside the seeded tenants would break every suite that asserts
// "exactly one seeded subject" — the fixture discipline recorded in ASSUMPTIONS §3.27.
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

function buildApp(tenantId: string, scopes: readonly string[] = SCOPES): VgFastify {
  // `testServerDependencies` supplies the ports this suite does not exercise — with the honest empty defaults its
  // documentation describes, not with fake persistence. The two that matter here are OVERRIDDEN with the real
  // ones: the tenancy runner (so RLS is genuinely applied) and the coverage adapter.
  return buildServer(
    testServerDependencies({
      identity: testIdentity({ tenantId, scopes }),
      tenancy: { runner },
      idempotency: {
        store: idempotency,
        requirementFor: (method, routeTemplate) => findRoute(method, routeTemplate)?.idempotency,
      },
      sessionSecret: TEST_SESSION_SECRET,
      coverageQueries: new PostgresCoverageQueries(),
    }),
  );
}

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function get(app: VgFastify, url: string): Promise<Injected> {
  const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = { __raw: response.body };
  }
  return { status: response.statusCode, json };
}

function codeOf(response: Injected): unknown {
  const error = response.json['error'];
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)['code'] : undefined;
}

// ---------------------------------------------------------------------------------------------
// The world: one subject per fixture, so nothing this suite creates can be mistaken for a seeded row.
// ---------------------------------------------------------------------------------------------

interface SubjectWorld {
  readonly subjectId: string;
  readonly sourceId: string;
  readonly recordId: string;
}

/** A subject with a source and one record: the minimum a case can hang off. */
function newSubject(label: string): SubjectWorld {
  const subjectId = randomUUID();
  const grantId = randomUUID();
  const sourceId = randomUUID();
  const recordId = randomUUID();
  const result = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO protected_subject (id, tenant_id, display_ref, jurisdiction, is_minor, status)
         VALUES ('${subjectId}', '${TENANT_A}', 'cov-${label}-${RUN}', 'US-CA', false, 'ACTIVE');`,
      `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, revoked_at, signed_instrument)
         VALUES ('${grantId}', '${TENANT_A}', '${subjectId}', 'SELF', ARRAY['discovery','self_service_write'],
                 now() - interval '1 day', now() + interval '30 days', NULL, false);`,
      `INSERT INTO source (id, tenant_id, name, class, jurisdiction, permission_class)
         VALUES ('${sourceId}', '${TENANT_A}', 'cov-source-${label}-${RUN}-${sourceId.slice(0, 8)}', 'REGISTRY', 'US-CA', 'WRITE_PERMITTED');`,
      `INSERT INTO source_record (id, tenant_id, source_id, raw_ref, observed_at, content_hash, tainted)
         VALUES ('${recordId}', '${TENANT_A}', '${sourceId}', 'https://example.invalid/cov-${label}-${RUN}',
                 now() - interval '2 days', repeat('b', 64), false);`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(result.status, 0, `subject fixture failed: ${result.output}`);
  return { subjectId, sourceId, recordId };
}

interface ExposureWorld extends SubjectWorld {
  readonly exposureId: string;
  readonly caseId: string;
  readonly outcome: string;
}

/**
 * A confirmed match with a case, optionally eligible for a lawful channel, plus its transitions.
 *
 * `confirmedAt` and `removedAt` are SQL INTERVALS relative to now, so the interval under test is expressed in the
 * same units the metric is: "confirmed two hours ago, removed one hour ago" is a window the test can name.
 */
function newExposure(
  world: SubjectWorld,
  options: {
    readonly label: string;
    readonly confirmedAgo: string;
    readonly removedAgo?: string;
    readonly finalState: string;
    readonly eligible?: boolean;
    readonly ambiguous?: boolean;
  },
): ExposureWorld {
  const exposureId = randomUUID();
  const caseId = randomUUID();
  const grantId = randomUUID();
  const eligible = options.eligible ?? true;
  const decisionId = randomUUID();
  const lines = [
    'BEGIN;',
    `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
    `INSERT INTO authority_grant (id, tenant_id, subject_id, kind, scope, issued_at, expires_at, revoked_at, signed_instrument)
       VALUES ('${grantId}', '${TENANT_A}', '${world.subjectId}', 'SELF', ARRAY['discovery','self_service_write'],
               now() - interval '1 day', now() + interval '30 days', NULL, false);`,
    `INSERT INTO exposure (id, tenant_id, subject_id, source_record_id, confidence, confidence_basis, truth_state,
                           first_observed_at, last_observed_at)
       VALUES ('${exposureId}', '${TENANT_A}', '${world.subjectId}', '${world.recordId}', 0.9,
               '[{"feature":"NAME_EXACT","weight":0.4}]'::jsonb, '${options.finalState}',
               now() - interval '3 days', now() - interval '3 days');`,
    `INSERT INTO request_case (id, tenant_id, subject_id, exposure_id, source_id, authority_grant_id, truth_state)
       VALUES ('${caseId}', '${TENANT_A}', '${world.subjectId}', '${exposureId}', '${world.sourceId}', '${grantId}',
               '${options.finalState}');`,
    // The transition INTO MATCH_CONFIRMED is what makes an exposure part of the metric's cohort, and it is recorded
    // on the spine exactly as the domain command records it: target_kind 'Exposure', the from/to states, the case.
    `INSERT INTO audit_event (tenant_id, actor, actor_kind, action, target_kind, target_id, case_id,
                              correlation_id, payload, outcome, transition_code, from_truth_state, to_truth_state, at)
       VALUES ('${TENANT_A}', 'test', 'SERVICE', 'exposure.transition', 'Exposure', '${exposureId}', '${caseId}',
               gen_random_uuid(), '{}'::jsonb, 'SUCCEEDED', 'T3', 'DISCOVERED_CANDIDATE', 'MATCH_CONFIRMED',
               now() - interval '${options.confirmedAgo}');`,
  ];
  if (options.removedAgo !== undefined) {
    lines.push(
      `INSERT INTO audit_event (tenant_id, actor, actor_kind, action, target_kind, target_id, case_id,
                                correlation_id, payload, outcome, transition_code, from_truth_state, to_truth_state, at)
         VALUES ('${TENANT_A}', 'test', 'SERVICE', 'exposure.transition', 'Exposure', '${exposureId}', '${caseId}',
                 gen_random_uuid(), '{}'::jsonb, 'SUCCEEDED', 'T9', 'ACKNOWLEDGED', 'VERIFIED_REMOVED',
                 now() - interval '${options.removedAgo}');`,
    );
  }
  if (eligible) {
    // ELIGIBILITY: a resolved policy decision on the case — a legal basis and a channel. This is the only evidence
    // of "eligible for a lawful channel" the schema holds, and it is what the adapter's INNER JOIN requires.
    lines.push(
      `INSERT INTO policy_decision (id, tenant_id, case_id, jurisdiction, legal_basis, channel, policy_version,
                                    version_label, reasons, decided_at)
         VALUES ('${decisionId}', '${TENANT_A}', '${caseId}', 'US-CA', 'CCPA_DELETE', 'OFFICIAL_SELF_SERVICE', 9001,
                 '2026-01-15', '[]'::jsonb, now() - interval '2 hours');`,
      `UPDATE request_case SET policy_decision_id = '${decisionId}' WHERE id = '${caseId}';`,
    );
  }
  if (options.ambiguous === true) {
    lines.push(
      `INSERT INTO external_action (tenant_id, case_id, channel, idempotency_key, attempt, status, ambiguous, submitted_at)
         VALUES ('${TENANT_A}', '${caseId}', 'OFFICIAL_SELF_SERVICE', 'cov-amb-${RUN}-${caseId.slice(0, 8)}', 1,
                 'AMBIGUOUS', true, now() - interval '90 minutes');`,
    );
  }
  lines.push('COMMIT;');
  const result = exec(ownerDsn(), lines.join('\n'));
  assert.equal(result.status, 0, `exposure fixture failed: ${result.output}`);
  return { ...world, exposureId, caseId, outcome: options.finalState };
}

/** One §5.16.1/§5.16.2 report row, inserted directly because no producer exists (see the file header). */
function newReport(options: {
  readonly subjectId: string | null;
  readonly generatedAgo: string;
  readonly total: number;
  readonly attempted: number;
  readonly succeeded: number;
  readonly skipped?: unknown;
  readonly unchecked?: unknown;
  readonly complete?: boolean;
}): string {
  const reportId = randomUUID();
  const result = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
      `INSERT INTO coverage_report (id, tenant_id, subject_id, catalogue_id, generated_at,
                                    sources_total, sources_attempted, sources_succeeded,
                                    sources_skipped, unchecked_remainder, complete, caveats)
         VALUES ('${reportId}', '${TENANT_A}', ${options.subjectId === null ? 'NULL' : `'${options.subjectId}'`},
                 'catalog-${RUN}', now() - interval '${options.generatedAgo}',
                 ${String(options.total)}, ${String(options.attempted)}, ${String(options.succeeded)},
                 '${JSON.stringify(options.skipped ?? [])}'::jsonb,
                 '${JSON.stringify(options.unchecked ?? [])}'::jsonb,
                 ${options.complete === true ? 'true' : 'false'},
                 ARRAY['PARTIAL_COVERAGE_ABSENCE_NOT_ESTABLISHED']);`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(result.status, 0, `report fixture failed: ${result.output}`);
  return reportId;
}

let app: VgFastify;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
  const created = exec(
    ownerDsn(),
    `INSERT INTO tenant (id, name, status) VALUES
       ('${TENANT_A}', 'coverage-suite-a-${RUN}', 'ACTIVE'),
       ('${TENANT_B}', 'coverage-suite-b-${RUN}', 'ACTIVE');`,
  );
  assert.equal(created.status, 0, `tenant fixture failed: ${created.output}`);
  app = buildApp(TENANT_A);
});

after(async () => {
  await app.close();
  await runner.close();
});

describe('§5.16.1 the coverage-report list', () => {
  test('a partial report is listed with its unchecked remainder counted, and walked by cursor', async () => {
    const subject = newSubject('list');
    const first = newReport({
      subjectId: subject.subjectId,
      generatedAgo: '3 hours',
      total: 12,
      attempted: 9,
      succeeded: 8,
      skipped: [{ sourceId: randomUUID(), sourceName: 'rate-limited', reason: 'RATE_LIMITED' }],
      unchecked: [{ sourceId: randomUUID(), sourceName: 'never-reached' }],
    });
    const second = newReport({
      subjectId: subject.subjectId,
      generatedAgo: '2 hours',
      total: 10,
      attempted: 10,
      succeeded: 10,
      complete: true,
    });

    const page1 = await get(app, `/v1/coverage-reports?subjectId=${subject.subjectId}&limit=1`);
    assert.equal(page1.status, 200, JSON.stringify(page1.json));
    const data1 = page1.json['data'] as Record<string, unknown>[];
    assert.equal(data1.length, 1);
    assert.equal(data1[0]?.['coverageReportId'], second, 'newest first by default');
    assert.equal(data1[0]?.['uncheckedRemainderCount'], 0);
    const page = page1.json['page'] as Record<string, unknown>;
    assert.equal(page['hasMore'], true);
    assert.equal(page['sort'], 'generatedAt:desc');
    // THE ROUTE-ONLY KEY MUST NOT LEAK: `cursorValue` is the keyset input, not part of §5.16.1's row.
    assert.equal(Object.prototype.hasOwnProperty.call(data1[0] ?? {}, 'cursorValue'), false);

    const cursor = page['nextCursor'] as string;
    const page2 = await get(
      app,
      `/v1/coverage-reports?subjectId=${subject.subjectId}&limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(page2.status, 200, JSON.stringify(page2.json));
    const data2 = page2.json['data'] as Record<string, unknown>[];
    assert.equal(data2[0]?.['coverageReportId'], first);
    assert.equal(data2[0]?.['uncheckedRemainderCount'], 1);
    assert.equal((page2.json['page'] as Record<string, unknown>)['hasMore'], false);
  });

  test('a cursor from another route or tenant is refused, never silently replayed', async () => {
    const subject = newSubject('cursor');
    newReport({ subjectId: subject.subjectId, generatedAgo: '1 hour', total: 3, attempted: 3, succeeded: 3, complete: true });
    const page1 = await get(app, `/v1/coverage-reports?subjectId=${subject.subjectId}&limit=1`);
    const cursor = (page1.json['page'] as Record<string, unknown>)['nextCursor'] as string;

    // The same cursor against a DIFFERENT filter set: a cursor is a continuation of one query, not a token.
    const foreign = await get(app, '/v1/coverage-reports?limit=1&cursor=' + encodeURIComponent(cursor));
    assert.equal(foreign.status, 400, JSON.stringify(foreign.json));
    assert.equal(codeOf(foreign), 'INVALID_CURSOR');
  });

  test('another tenant cannot see these reports', async () => {
    const subject = newSubject('cross');
    const reportId = newReport({
      subjectId: subject.subjectId,
      generatedAgo: '30 minutes',
      total: 4,
      attempted: 4,
      succeeded: 4,
      complete: true,
    });
    const other = buildApp(TENANT_B);
    const list = await get(other, '/v1/coverage-reports');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json['data'], []);
    const detail = await get(other, `/v1/coverage-reports/${reportId}`);
    assert.equal(detail.status, 404, JSON.stringify(detail.json));
    await other.close();
  });
});

describe('§5.16.2 one report names what was NOT checked', () => {
  test('the detail carries the skip reasons, the unchecked remainder and a derived fraction', async () => {
    const subject = newSubject('detail');
    const skippedSource = randomUUID();
    const uncheckedSource = randomUUID();
    const reportId = newReport({
      subjectId: subject.subjectId,
      generatedAgo: '20 minutes',
      total: 118,
      attempted: 74,
      succeeded: 69,
      skipped: [
        { sourceId: skippedSource, sourceName: 'slow-registry', reason: 'RATE_LIMITED' },
        { sourceId: randomUUID(), sourceName: 'robots', reason: 'ROBOTS_DISALLOWED' },
      ],
      unchecked: [{ sourceId: uncheckedSource, sourceName: 'never-reached' }],
    });

    const response = await get(app, `/v1/coverage-reports/${reportId}`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json['sourcesTotal'], 118);
    assert.equal(response.json['sourcesAttempted'], 74);
    assert.equal(response.json['sourcesSucceeded'], 69);
    assert.equal(response.json['checkedFraction'], Number((74 / 118).toFixed(4)));
    assert.equal(response.json['complete'], false);
    const skipped = response.json['sourcesSkipped'] as Record<string, unknown>[];
    assert.equal(skipped.length, 2);
    assert.equal(skipped[0]?.['sourceId'], skippedSource);
    assert.equal(skipped[0]?.['reason'], 'RATE_LIMITED');
    const unchecked = response.json['uncheckedRemainder'] as Record<string, unknown>[];
    assert.deepEqual(unchecked, [{ sourceId: uncheckedSource, sourceName: 'never-reached' }]);
    assert.deepEqual(response.json['caveats'], ['PARTIAL_COVERAGE_ABSENCE_NOT_ESTABLISHED']);
    assert.deepEqual(response.json['scope'], { subjectId: subject.subjectId, catalogueId: `catalog-${RUN}` });
  });

  test('the DATABASE refuses a partial report that names no unchecked remainder', () => {
    // VG-DISC-002 in the place it cannot be bypassed: a partial report with nothing unchecked is the shape that
    // lets "we did not look" present as "we found nothing". The route cannot produce one because the table
    // cannot store one, and this asserts the table rather than the route.
    const result = exec(
      ownerDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
        `INSERT INTO coverage_report (tenant_id, catalogue_id, generated_at, sources_total, sources_attempted,
                                      sources_succeeded, sources_skipped, unchecked_remainder, complete)
           VALUES ('${TENANT_A}', 'bad-${RUN}', now(), 10, 4, 4, '[]'::jsonb, '[]'::jsonb, false);`,
        'COMMIT;',
      ].join('\n'),
    );
    assert.notEqual(result.status, 0, 'a partial report with no unchecked remainder was accepted');
    assert.match(result.output, /coverage_report_check/i);
  });
});

describe('§5.16.3 the removal-effectiveness metric', () => {
  test('the cohort, the numerator and the six exclusions are computed from the transition spine', async () => {
    const subject = newSubject('metric');
    // One removed (inside the window), one acknowledged, one submitted, one delisted, one not-removable, one
    // human-required, one ambiguous action, and one INELIGIBLE match with no policy decision at all.
    newExposure(subject, { label: 'removed', confirmedAgo: '5 hours', removedAgo: '1 hour', finalState: 'VERIFIED_REMOVED' });
    newExposure(subject, { label: 'ack', confirmedAgo: '5 hours', finalState: 'ACKNOWLEDGED' });
    newExposure(subject, { label: 'submitted', confirmedAgo: '5 hours', finalState: 'REQUEST_SUBMITTED' });
    newExposure(subject, { label: 'delisted', confirmedAgo: '5 hours', finalState: 'SEARCH_DELISTED' });
    newExposure(subject, { label: 'notremovable', confirmedAgo: '5 hours', finalState: 'NOT_REMOVABLE' });
    newExposure(subject, { label: 'human', confirmedAgo: '5 hours', finalState: 'HUMAN_REQUIRED' });
    newExposure(subject, { label: 'amb', confirmedAgo: '5 hours', finalState: 'REQUEST_READY', ambiguous: true });
    // Confirmed OUTSIDE the window: the cohort is bounded by the interval, so this one must not be counted at all.
    const old = newSubject('metric-old');
    newExposure(old, { label: 'old', confirmedAgo: '40 days', finalState: 'ACKNOWLEDGED' });
    // Confirmed inside the window but INELIGIBLE: no policy decision, so no lawful channel was resolved.
    const ineligibleSubject = newSubject('metric-ineligible');
    newExposure(ineligibleSubject, { label: 'ineligible', confirmedAgo: '4 hours', finalState: 'MATCH_CONFIRMED', eligible: false });

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 1000).toISOString();
    const response = await get(
      app,
      `/v1/metrics/removal-effectiveness?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&subjectId=${subject.subjectId}`,
    );
    assert.equal(response.status, 200, JSON.stringify(response.json));

    const overall = response.json['overall'] as Record<string, unknown>;
    // SEVEN eligible members: the six with a final state plus the ambiguous one. The 40-day-old match and the
    // ineligible one are in the same tenant and the same source class, so a denominator of 7 is the assertion that
    // BOTH the interval and the eligibility rule are applied.
    assert.equal(overall['eligibleConfirmedMatchDenominator'], 7);
    assert.equal(overall['verifiedRemovedNumerator'], 1);
    assert.equal(overall['ratio'], Number((1 / 7).toFixed(4)));
    assert.match(String(overall['denominatorDefinedAs']), /MATCH_CONFIRMED/);
    const interval = overall['confidenceInterval'] as Record<string, number>;
    assert.equal(interval['level'], 0.95);
    // The Wilson bounds for 1/7 at 95%: asserted as a RANGE with the properties that matter (inside [0,1], low <
    // ratio < high) rather than as literals, so a legitimate re-derivation is not a failure but a broken interval is.
    assert.ok(interval['low']! >= 0 && interval['high']! <= 1, JSON.stringify(interval));
    assert.ok(interval['low']! < (overall['ratio'] as number), JSON.stringify(interval));
    assert.ok(interval['high']! > (overall['ratio'] as number), JSON.stringify(interval));

    const excluded = response.json['excludedFromNumerator'] as Record<string, number>;
    assert.equal(excluded['acknowledged'], 1);
    assert.equal(excluded['requestSubmitted'], 1);
    assert.equal(excluded['searchDelisted'], 1);
    assert.equal(excluded['notRemovable'], 1);
    assert.equal(excluded['humanRequired'], 1);
    assert.equal(excluded['ambiguous'], 1);
    assert.deepEqual(response.json['caveats'], [
      'ACKNOWLEDGED_IS_NOT_REMOVAL',
      'SEARCH_DELISTED_IS_NOT_SOURCE_DELETION',
      'HUMAN_REQUIRED_IS_NOT_FAILURE',
    ]);
    // Asserted FIELD BY FIELD rather than with a structural comparison: the values here are the interval the
    // caller sent, echoed back, and naming both members says which one drifted.
    const returnedInterval = response.json['interval'] as Record<string, unknown>;
    assert.equal(returnedInterval['from'], from);
    assert.equal(returnedInterval['to'], to);

    // THE FORBIDDEN VOCABULARY. §5.16.3 and SPEC-000 §7.3 forbid a field named `removed`, `permanentDeletion`,
    // `successRate` or `requestsSent` anywhere in this response, and a WALK of the whole body is the only form of
    // that rule a later milestone cannot quietly break by adding a field.
    const forbidden = ['removed', 'permanentDeletion', 'successRate', 'requestsSent'];
    const seen: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, entry] of Object.entries(value)) {
        seen.push(key);
        walk(entry);
      }
    };
    walk(response.json);
    for (const name of forbidden) {
      assert.equal(seen.includes(name), false, `the response carries a field named ${name}`);
    }
  });

  test('a window with no eligible match reports a null ratio, never zero', async () => {
    const subject = newSubject('empty');
    newExposure(subject, { label: 'notyet', confirmedAgo: '5 hours', finalState: 'MATCH_CONFIRMED', eligible: false });
    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 1000).toISOString();
    const response = await get(
      app,
      `/v1/metrics/removal-effectiveness?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&subjectId=${subject.subjectId}`,
    );
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const overall = response.json['overall'] as Record<string, unknown>;
    assert.equal(overall['eligibleConfirmedMatchDenominator'], 0);
    assert.equal(overall['verifiedRemovedNumerator'], 0);
    assert.equal(overall['ratio'], null, 'an undefined ratio must not be reported as 0');
    assert.equal(overall['confidenceInterval'], null);
  });

  test('groupBy breaks the same figures down, and only when it is asked for', async () => {
    const subject = newSubject('group');
    newExposure(subject, { label: 'g1', confirmedAgo: '5 hours', removedAgo: '1 hour', finalState: 'VERIFIED_REMOVED' });
    newExposure(subject, { label: 'g2', confirmedAgo: '5 hours', finalState: 'ACKNOWLEDGED' });
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 1000).toISOString();

    const plain = await get(
      app,
      `/v1/metrics/removal-effectiveness?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&subjectId=${subject.subjectId}`,
    );
    assert.equal(Object.prototype.hasOwnProperty.call(plain.json, 'groups'), false);

    const grouped = await get(
      app,
      `/v1/metrics/removal-effectiveness?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&subjectId=${subject.subjectId}&groupBy=source`,
    );
    assert.equal(grouped.status, 200, JSON.stringify(grouped.json));
    const groups = grouped.json['groups'] as Record<string, unknown>[];
    assert.equal(groups.length, 1, JSON.stringify(groups));
    assert.equal(groups[0]?.['kind'], 'source');
    assert.equal(groups[0]?.['eligibleConfirmedMatchDenominator'], 2);
    assert.equal(groups[0]?.['verifiedRemovedNumerator'], 1);
  });

  test('an unbounded metric request is refused, and an unknown groupBy names its own code', async () => {
    const to = new Date(Date.now()).toISOString();
    const unbounded = await get(app, `/v1/metrics/removal-effectiveness?to=${encodeURIComponent(to)}`);
    assert.equal(unbounded.status, 400, JSON.stringify(unbounded.json));
    assert.equal(codeOf(unbounded), 'TIME_RANGE_REQUIRED');
    const details = (unbounded.json['error'] as Record<string, unknown>)['details'] as Record<string, unknown>;
    // The refusal names THIS route's collection. MEASURED DEFECT this asserts: the parser hard-coded
    // `audit-events`, so a metric request without a range would have been told it sent a bad audit query.
    assert.equal(details['collection'], 'metrics/removal-effectiveness');

    const from = new Date(Date.now() - 3600 * 1000).toISOString();
    const badGroup = await get(
      app,
      `/v1/metrics/removal-effectiveness?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&groupBy=subject`,
    );
    assert.equal(badGroup.status, 400, JSON.stringify(badGroup.json));
    assert.equal(codeOf(badGroup), 'INVALID_GROUP_BY');

    const unknown = await get(
      app,
      `/v1/metrics/removal-effectiveness?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&sort=ratio:desc`,
    );
    assert.equal(unknown.status, 400, JSON.stringify(unknown.json));
    assert.equal(codeOf(unknown), 'UNKNOWN_QUERY_PARAMETER');
  });
});
