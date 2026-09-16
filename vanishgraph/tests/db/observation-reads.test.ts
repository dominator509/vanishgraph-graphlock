/**
 * The §5.10/§5.11 reads against real PostgreSQL (SPEC-003 §5.10.2/§5.10.3/§5.11.2/§5.11.3, VG-VERIFY-001).
 *
 * WHAT THIS SUITE PROVES, and the first item is the reason the file exists:
 *
 *   * **The independence attestation is FAIL-CLOSED.** A row whose paths were never recorded — which is every
 *     row written before migration 0018, including the seeded one — reports `distinct: false`, while a row
 *     with two different paths reports `true`. Independence is what separates a verified removal from removal
 *     theater (VG-VERIFY-001), so reporting an unattested independence as attested is the failure this
 *     asserts against. The seeded row IS that case, so the fail-closed branch is exercised on real data
 *     rather than on a constructed stub.
 *   * `actorDistinct` is COMPUTED from the row, not asserted: the table's
 *     `CHECK (actor_identity <> acting_identity)` makes it true for every storable row, and the test asserts
 *     that the computed value agrees with the constraint rather than with a constant.
 *   * §5.11.2's filters and `reEntryState` partition actually narrow: each token is exercised, and the three
 *     are shown to select DISJOINT sets, so a mapping that matched everything would fail.
 *   * Pagination over HTTP walks the reappearance list without repeating or skipping — the walk that exposed
 *     the shared `limit`/`cursor` filter defect in the §5.15 round, now re-exercised on a second route.
 *
 * FIXTURE DISCIPLINE (`ASSUMPTIONS.md` §3.24). Observations and reappearances are appended by this suite and
 * never removed: both tables are evidence, and a test that deleted its own rows would be demonstrating a
 * capability the API deliberately does not have. Every row this suite writes carries a per-run marker
 * (`method` or `observation_method` with a `-RUN` suffix) so no assertion depends on the total contents of a
 * shared table.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildServer, type VgFastify } from '../../src/http/server.ts';
import { testIdentity, TEST_SESSION_SECRET, TEST_TOKEN } from '../contract/server-support.ts';
import { PostgresTenantRunner } from '../../src/adapters/persistence/postgres-runner.ts';
import { PostgresObservationQueries } from '../../src/adapters/persistence/observations.ts';
import { PostgresExposureQueries } from '../../src/adapters/persistence/exposures.ts';
import { PostgresTransitionQueries } from '../../src/adapters/persistence/transitions.ts';
import { PostgresCaseQueries } from '../../src/adapters/persistence/cases.ts';
import { PostgresControllerResponseQueries } from '../../src/adapters/persistence/controller-responses.ts';
import { PostgresActionQueries } from '../../src/adapters/persistence/actions.ts';
import { PostgresAuditQueries } from '../../src/adapters/persistence/audit-queries.ts';
import { PostgresDeadlineQueries } from '../../src/adapters/persistence/deadlines.ts';
import { PostgresAppealQueries } from '../../src/adapters/persistence/appeals.ts';
import { PostgresIdempotencyStore } from '../../src/adapters/idempotency/postgres-store.ts';
import { PostgresSubjectQueries } from '../../src/adapters/persistence/subjects.ts';
import { PostgresSourceQueries } from '../../src/adapters/persistence/sources.ts';
import { findRoute } from '../../src/http/openapi/registry.ts';
import { appDsn, asTenant, exec, ownerDsn } from './harness.ts';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CASE_A = '77777777-1111-4111-8111-777777777777';
const EXPOSURE_A = '99999999-1111-4111-8111-999999999999';
const EVIDENCE_A = '44444444-1111-4111-8111-444444444444';
const SEEDED_OBSERVATION = '33333333-1111-4111-8111-333333333333';
const ABSENT = '00000000-0000-4000-8000-000000000000';

/** A per-run marker, so no assertion depends on the total contents of a shared table. */
const RUN = randomUUID().slice(0, 8);

let runner: PostgresTenantRunner;
let idempotency: PostgresIdempotencyStore;

before(() => {
  runner = new PostgresTenantRunner({ dsn: appDsn(), maxConnections: 4 });
  idempotency = new PostgresIdempotencyStore({ dsn: appDsn() });
});

after(async () => {
  await runner.close();
});

function serverFor(tenantId: string, scopes: readonly string[] = ['vg.observations.read']): VgFastify {
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

interface Injected {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
}

async function get(app: VgFastify, url: string): Promise<Injected> {
  const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.statusCode, json, headers: response.headers as Record<string, unknown> };
}

function rowsOf(response: Injected): Record<string, unknown>[] {
  assert.equal(response.status, 200, `expected 200, got ${JSON.stringify(response.json)}`);
  return (response.json['data'] ?? []) as Record<string, unknown>[];
}

/** Insert a verification observation directly, with or without the independence paths. */
function insertObservation(options: {
  id: string;
  method: string;
  finding: string;
  actingPathId?: string | null;
  observationPathId?: string | null;
  observedAtSql?: string;
  tenantId?: string;
}): void {
  const tenantId = options.tenantId ?? TENANT_A;
  const inserted = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${tenantId}', true);`,
      `INSERT INTO verification_observation
         (id, tenant_id, case_id, method, observed_at, actor_identity, acting_identity, finding, evidence_id,
          acting_path_id, observation_path_id)
       VALUES ('${options.id}', '${tenantId}', '${CASE_A}', '${options.method}', ${options.observedAtSql ?? 'now()'},
               '${`observer-${RUN}`}', '${`actor-${RUN}`}', '${options.finding}', '${EVIDENCE_A}',
               ${options.actingPathId === null || options.actingPathId === undefined ? 'NULL' : `'${options.actingPathId}'`},
               ${options.observationPathId === null || options.observationPathId === undefined ? 'NULL' : `'${options.observationPathId}'`});`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(inserted.status, 0, `could not insert the observation:\n${inserted.output}`);
}

/**
 * An existing `audit_event.id` for tenant A, as a decimal string.
 *
 * `prior_removed_event_id` is a BIGINT foreign key to `audit_event(id)` — `EP-003-node.md:132` resolves it as
 * "the append-only record of the T14 transition" — and NOT a UUID, so a UUID fixture fails with
 * `invalid input syntax for type bigint`. The column is NOT NULL, so a reappearance must cite a real prior
 * removal event.
 */
function priorAuditEventId(): string {
  const rows = asTenant(ownerDsn(), TENANT_A, 'SELECT min(id)::text FROM audit_event;');
  const id = rows[0];
  assert.ok(
    id !== undefined && /^[0-9]+$/.test(id),
    `no audit event to cite as a prior removal: ${String(id)}`,
  );
  return id;
}

/**
 * Insert a reappearance for the seeded exposure.
 *
 * `priorRemovedEventId` DEFAULTS TO A REAL AUDIT EVENT rather than to NULL, because the column is NOT NULL:
 * every reappearance cites the prior removal event it is a recurrence of, which is what VG-REAPPEAR-001
 * requires ("a first-ever discovery is never labelled Reappearance"). A helper that defaulted to NULL would
 * make every call site restate that, and a null would be unstorable anyway.
 */
function insertReappearance(options: {
  id: string;
  observedAtSql?: string;
  observationMethod?: string | null;
  priorRemovedEventId?: string;
  tenantId?: string;
}): void {
  const tenantId = options.tenantId ?? TENANT_A;
  const inserted = exec(
    ownerDsn(),
    [
      'BEGIN;',
      `SELECT set_config('app.tenant_id', '${tenantId}', true);`,
      `INSERT INTO reappearance
         (id, tenant_id, exposure_id, prior_removed_event_id, observed_at, evidence_id, observation_method)
       VALUES ('${options.id}', '${tenantId}', '${EXPOSURE_A}',
               '${options.priorRemovedEventId ?? priorAuditEventId()}',
               ${options.observedAtSql ?? 'now()'}, '${EVIDENCE_A}',
               ${options.observationMethod === null || options.observationMethod === undefined ? 'NULL' : `'${options.observationMethod}'`});`,
      'COMMIT;',
    ].join('\n'),
  );
  assert.equal(inserted.status, 0, `could not insert the reappearance:\n${inserted.output}`);
}

describe('§5.10.2/§5.10.3: the independence attestation is fail-closed', () => {
  test('the SEEDED observation has no paths recorded and reports distinct: false', async () => {
    const app = serverFor(TENANT_A);
    const detail = await get(app, `/v1/verification-observations/${SEEDED_OBSERVATION}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.json));

    const independence = detail.json['independence'] as Record<string, unknown>;
    // The seeded row predates migration 0018, so it records no paths. Reporting `true` would attest an
    // independence nobody established — the removal-theater failure VG-VERIFY-001 exists to prevent.
    assert.equal(independence['actingPathId'], null);
    assert.equal(independence['observationPathId'], null);
    assert.equal(independence['distinct'], false, 'an unattested independence must not be reported as attested');
    // `actorDistinct` IS true, and it is COMPUTED: the table's CHECK makes the two identities differ.
    assert.equal(independence['actorDistinct'], true);
    assert.equal(detail.json['actorIdentity'], 'observer-a');
    assert.equal(detail.json['actingIdentity'], 'actor-a');
    await app.close();
  });

  test('an observation with two DIFFERENT paths reports distinct: true, and equal paths are unstorable', async () => {
    const id = randomUUID();
    insertObservation({ id, method: `independent-fetch-${RUN}`, finding: 'ABSENT', actingPathId: 'path-01', observationPathId: 'path-02' });

    const app = serverFor(TENANT_A);
    const detail = await get(app, `/v1/verification-observations/${id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.json));
    assert.deepEqual(detail.json['independence'], {
      actingPathId: 'path-01',
      observationPathId: 'path-02',
      distinct: true,
      actorDistinct: true,
    });
    await app.close();

    // The DATABASE refuses an observation along the acting path, which is VG-VERIFY-001 stated as a constraint
    // rather than as a route's check — the off-by-one here is `observation_path_id = acting_path_id`.
    const identical = exec(
      ownerDsn(),
      [
        'BEGIN;',
        `SELECT set_config('app.tenant_id', '${TENANT_A}', true);`,
        `INSERT INTO verification_observation
           (id, tenant_id, case_id, method, observed_at, actor_identity, acting_identity, finding, evidence_id,
            acting_path_id, observation_path_id)
         VALUES ('${randomUUID()}', '${TENANT_A}', '${CASE_A}', 'same-path', now(), 'o-${RUN}', 'a-${RUN}', 'ABSENT',
                 '${EVIDENCE_A}', 'path-same', 'path-same');`,
        'COMMIT;',
      ].join('\n'),
    );
    assert.notEqual(identical.status, 0, 'an observation along the acting path must not be storable');
    assert.match(identical.output, /verification_observation_paths_differ/, `expected the CHECK to refuse:\n${identical.output}`);
  });

  test('the case sub-resource list returns the case’s observations newest first', async () => {
    const older = randomUUID();
    const newer = randomUUID();
    insertObservation({ id: older, method: `older-${RUN}`, finding: 'ABSENT', observedAtSql: "now() - interval '3 hours'" });
    insertObservation({ id: newer, method: `newer-${RUN}`, finding: 'PRESENT', observedAtSql: "now() - interval '1 hour'" });

    const app = serverFor(TENANT_A);
    const listed = rowsOf(await get(app, `/v1/cases/${CASE_A}/verification-observations`));
    const ids = listed.map((row) => row['verificationObservationId']);
    assert.ok(ids.includes(older) && ids.includes(newer), 'both inserted observations must be listed');
    assert.ok(ids.indexOf(newer) < ids.indexOf(older), 'newest first');
    await app.close();
  });

  test('another tenant’s observation is 404 with an indistinguishable outcome, and its case too', async () => {
    const id = randomUUID();
    insertObservation({ id, method: `isolated-${RUN}`, finding: 'ABSENT' });

    const appB = serverFor(TENANT_B);
    const other = await get(appB, `/v1/verification-observations/${id}`);
    const absent = await get(appB, `/v1/verification-observations/${ABSENT}`);
    assert.equal(other.status, 404);
    assert.equal(absent.status, 404);
    const outcome = (res: Injected): Record<string, unknown> => {
      const error = res.json['error'] as Record<string, unknown>;
      return { status: res.status, code: error['code'], message: error['message'], retryable: error['retryable'] };
    };
    assert.deepEqual(outcome(other), outcome(absent));

    // And the case sub-resource route: tenant B cannot see tenant A's case, so it is a 404 rather than an
    // empty list (SPEC-006 H-9).
    const crossCase = await get(appB, `/v1/cases/${CASE_A}/verification-observations`);
    assert.equal(crossCase.status, 404, JSON.stringify(crossCase.json));
    await appB.close();
  });
});

describe('§5.11.2/§5.11.3: reappearances carry the declared re-entry rules', () => {
  test('every row reports reentry, and the history route returns oldest first', async () => {
    const older = randomUUID();
    const newer = randomUUID();
    const priorEvent = priorAuditEventId();
    insertReappearance({ id: older, observedAtSql: "now() - interval '4 hours'", observationMethod: `SCHEDULED-${RUN}`, priorRemovedEventId: priorEvent });
    insertReappearance({ id: newer, observedAtSql: "now() - interval '2 hours'", observationMethod: `SCHEDULED-${RUN}` });

    const app = serverFor(TENANT_A);
    const history = rowsOf(await get(app, `/v1/exposures/${EXPOSURE_A}/reappearances`));
    const ours = history.filter((row) => row['observationMethod'] === `SCHEDULED-${RUN}`);
    assert.equal(ours.length, 2, 'both inserted reappearances must be listed');
    // OLDEST FIRST on this route, as §5.11.3 requires: it is a history.
    assert.equal(ours[0]?.['reappearanceId'], older, 'the history must be oldest first');
    assert.equal(ours[1]?.['reappearanceId'], newer);

    // The prior removal event is linked, and the re-entry rules are the contract's.
    assert.equal(ours[0]?.['priorRemovedEventId'], priorEvent);
    for (const row of ours) {
      assert.deepEqual(row['reentry'], {
        requiresFreshAuthority: true,
        requiresFreshPolicyDecision: true,
        requiresFreshRecipe: true,
        preservesPriorEvidence: true,
      });
      // The exposure's truth state is reported verbatim; the seeded exposure is MATCH_CONFIRMED.
      assert.equal(row['exposureTruthState'], 'MATCH_CONFIRMED');
      // And the transition-derived fields are ABSENT rather than fabricated: they need the transition record
      // that ASSUMPTIONS §3.18 records as unspecified, and REAPPEARED has two inbound transitions (T17, T20)
      // so the prior state is not even inferable from the row.
      assert.equal('transitionCode' in row, false);
      assert.equal('priorTruthState' in row, false);
    }
    await app.close();
  });

  test('the tenant-wide list is the SAME ORDER RULE as the spec declares, and paginates over HTTP', async () => {
    // Three reappearances sharing one instant, which is the case the id tiebreaker exists for.
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) {
      insertReappearance({ id, observedAtSql: "now() - interval '30 minutes'", observationMethod: `PAGED-${RUN}` });
    }

    const app = serverFor(TENANT_A);
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    const from = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 1000).toISOString();

    do {
      const url = `/v1/reappearances?from=${from}&to=${to}&sort=observedAt:asc&limit=1${
        cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
      }`;
      const response = await get(app, url);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      const page = response.json['page'] as Record<string, unknown>;
      for (const row of (response.json['data'] ?? []) as Record<string, unknown>[]) {
        const id = String(row['reappearanceId']);
        assert.equal(seen.has(id), false, `row ${id} was returned twice`);
        seen.add(id);
      }
      cursor = page['nextCursor'] === null ? null : String(page['nextCursor']);
      pages += 1;
      // The cap is a SAFETY NET AGAINST NON-TERMINATION, not a bound on the fixture. A first version used 20,
      // and it aborted a walk that was behaving correctly: `reappearance` accumulates across runs (this suite
      // writes evidence and never removes it), and the window held 40 rows, so `limit=1` legitimately needed 40
      // pages. The assertion that matters is the per-row uniqueness below; this only stops an infinite loop.
      assert.ok(pages <= 500, `pagination must terminate; gave up after ${String(pages)} pages`);
    } while (cursor !== null);

    // Every row in the window was seen exactly once — the assertion is about the WALK, not about a total count,
    // so rows other tests wrote in the same window cannot make it flaky.
    for (const id of ids) assert.equal(seen.has(id), true, `${id} must be seen exactly once`);
    await app.close();
  });

  test('reEntryState partitions the list: the three tokens select DISJOINT sets', async () => {
    // The seeded exposure is MATCH_CONFIRMED, so the rows inserted here fall in REENTERED. The assertion that
    // matters is the DISJOINTNESS: a mapping that matched everything (or nothing) would fail it, which is what
    // makes this a test of the partition rather than of one token.
    const id = randomUUID();
    insertReappearance({ id, observedAtSql: "now() - interval '45 minutes'", observationMethod: `STATE-${RUN}` });

    const app = serverFor(TENANT_A);
    const from = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 1000).toISOString();
    const base = `from=${from}&to=${to}&limit=100`;
    const seen = new Set<string>();

    for (const state of ['PENDING_REENTRY', 'REENTERED', 'NOT_REMOVABLE']) {
      const listed = rowsOf(await get(app, `/v1/reappearances?${base}&reEntryState=${state}`));
      for (const row of listed) {
        const rowId = String(row['reappearanceId']);
        assert.equal(seen.has(rowId), false, `${rowId} appeared under two reEntryState tokens`);
        seen.add(rowId);
      }
      if (state === 'REENTERED') {
        assert.equal(
          listed.some((row) => row['reappearanceId'] === id),
          true,
          'a MATCH_CONFIRMED exposure is REENTERED',
        );
      } else {
        assert.equal(
          listed.some((row) => row['reappearanceId'] === id),
          false,
          `a MATCH_CONFIRMED exposure must not be ${state}`,
        );
      }
    }
    await app.close();
  });

  test('another tenant sees none of tenant A’s reappearances', async () => {
    const id = randomUUID();
    insertReappearance({ id, observedAtSql: "now() - interval '10 minutes'", observationMethod: `ISO-${RUN}` });

    const appA = serverFor(TENANT_A);
    const from = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 1000).toISOString();
    const ours = rowsOf(await get(appA, `/v1/reappearances?from=${from}&to=${to}&limit=100`));
    assert.equal(ours.some((row) => row['reappearanceId'] === id), true, 'the control');
    await appA.close();

    const appB = serverFor(TENANT_B);
    assert.equal(
      rowsOf(await get(appB, `/v1/reappearances?from=${from}&to=${to}&limit=100`)).length,
      0,
      'RLS must return zero rows for another tenant’s reappearances',
    );
    const historyB = await get(appB, `/v1/exposures/${EXPOSURE_A}/reappearances`);
    assert.equal(historyB.status, 404, 'and another tenant’s exposure is not found at all');
    await appB.close();
  });
});
