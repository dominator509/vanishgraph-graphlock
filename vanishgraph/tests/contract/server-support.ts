/**
 * Test support for building a server with a working identity and tenancy.
 *
 * `ServerDependencies.identity` and `.tenancy` are REQUIRED (EP-004 M3), because an optional
 * authentication plugin is a configuration in which every route is unauthenticated. That decision
 * means every test that builds a server must supply both — this module supplies the smallest honest
 * pair.
 *
 * The identity here is a `verify` function that accepts a fixed, obviously-fake token and refuses
 * everything else. It is NOT a mock of the verification logic: the real verification logic lives in
 * `src/adapters/oidc/verify.ts` and is tested directly by `tests/contract/token-validation.test.ts`
 * against a locally signed token. What this helper avoids is every ENVELOPE and ROUTE test having to
 * mint a JWT to exercise a concern unrelated to authentication.
 *
 * The tenancy runner is an in-memory recorder, because a test that asserts "the tenant was bound"
 * does not need PostgreSQL; the test that asserts RLS ACTUALLY isolates belongs in `tests/db/`
 * against a real database, where EP-003 already puts it.
 */

import type { ServerDependencies } from '../../src/http/server.ts';
import type { IdentityPluginOptions } from '../../src/http/plugins/identity.ts';
import type { TenancyPluginOptions, TenantTransaction } from '../../src/http/plugins/tenancy.ts';
import type { VerifyResult } from '../../src/adapters/oidc/verify.ts';
import type { IdempotencyPluginOptions } from '../../src/http/plugins/idempotency.ts';
import type { SubjectQueries } from '../../src/application/contracts/subject-queries.ts';
import type { SubjectCommands } from '../../src/application/contracts/subject-commands.ts';
import type {
  RecipeVerificationKeys,
  SourceQueries,
} from '../../src/application/contracts/source-queries.ts';
import type { AppealQueries } from '../../src/application/contracts/appeal-queries.ts';
import type { DeadlineQueries } from '../../src/application/contracts/deadline-queries.ts';
import type { AuditQueries } from '../../src/application/contracts/audit-queries.ts';
import type { ObservationQueries } from '../../src/application/contracts/observation-queries.ts';
import type { ExposureQueries } from '../../src/application/contracts/exposure-queries.ts';
import type { TransitionQueries } from '../../src/application/contracts/transition-queries.ts';
import type { CaseQueries } from '../../src/application/contracts/case-queries.ts';
import type { ControllerResponseQueries } from '../../src/application/contracts/controller-response-queries.ts';
import type { ActionQueries } from '../../src/application/contracts/action-queries.ts';
import type { PolicyQueries } from '../../src/application/contracts/policy-queries.ts';
import type { CoverageQueries } from '../../src/application/contracts/coverage-queries.ts';
import { EFFECTIVENESS_CAVEATS } from '../../src/application/contracts/coverage-queries.ts';

/**
 * The cursor signing secret used by tests.
 *
 * A fixed value so cursor assertions are deterministic. It is obviously a test fixture and must never
 * appear in production configuration — `loadConfig` supplies the real one from SESSION_SECRET.
 */
export const TEST_SESSION_SECRET = 'test-session-secret-not-a-real-credential';

/** A token value that is obviously a test fixture and cannot be mistaken for a real credential. */
export const TEST_TOKEN = 'test-token-not-a-real-credential';

export interface TestIdentityOptions {
  readonly tenantId?: string;
  readonly roles?: readonly string[];
  readonly scopes?: readonly string[];
  readonly authLevel?: string;
  /** Seconds ago that authentication happened. Defaults to 0 (fresh). */
  readonly authTimeAgeSeconds?: number;
  readonly subjectRef?: string;
  /** When set, every verification returns this refusal instead of succeeding. */
  readonly refuseWith?: VerifyResult & { ok: false };
}

/**
 * An idempotency plugin for tests that do not exercise idempotency.
 *
 * Routes the test registers are not in any registry, so every requirement resolves to `undefined`,
 * which the plugin treats as `optional` — the key is ignored and echoed. That keeps envelope and
 * route tests focused on their own concern instead of every one of them having to thread a key.
 *
 * `tests/contract/idempotency.test.ts` builds its own server with a recording store and a real
 * `requirementFor`, because THAT suite is the one asserting the semantics.
 */
export function testIdempotency(): IdempotencyPluginOptions {
  return {
    store: {
      begin: async () => ({ state: 'NEW' as const }),
      complete: async () => {},
      abandon: async () => {},
    },
    requirementFor: () => undefined,
  };
}

/**
 * A `verify` function for tests.
 *
 * Refuses a missing or unknown token with `TOKEN_MISSING`, which keeps the default posture
 * fail-closed: a test that forgets to send a token gets a 401 rather than a silent success.
 */
export function testIdentity(options: TestIdentityOptions = {}): IdentityPluginOptions {
  const tenantId = options.tenantId ?? '11111111-1111-4111-8111-111111111111';
  return {
    verify: async (token: string | undefined): Promise<VerifyResult> => {
      if (options.refuseWith !== undefined) return options.refuseWith;
      if (token === undefined) return { ok: false, code: 'TOKEN_MISSING', detail: 'no token' };
      if (token !== TEST_TOKEN) return { ok: false, code: 'TOKEN_INVALID', detail: 'unknown test token' };
      const nowSeconds = Math.floor(Date.now() / 1000);
      return {
        ok: true,
        claims: {
          sub: 'operator-0001',
          iss: 'https://idp.test/realms/vg',
          aud: 'vanishgraph-portal',
          exp: nowSeconds + 3600,
          nbf: undefined,
          iat: nowSeconds - (options.authTimeAgeSeconds ?? 0),
          tenant_id: tenantId,
          roles: options.roles ?? ['OPERATOR'],
          subject_ref: options.subjectRef ?? 'subject-ref-0001',
          auth_level: options.authLevel ?? 'IAL2',
          azp: undefined,
          scopes: options.scopes ?? ['vg.subjects.read'],
        },
      };
    },
  };
}

/** Records every transaction a handler opened, so a test can assert the tenant was bound. */
export interface RecordedTransaction {
  readonly tenantId: string;
  readonly queries: readonly string[];
}

export interface TestTenancy {
  readonly runner: TenancyPluginOptions;
  readonly recorded: RecordedTransaction[];
  /** Rows a handler's `query` should return. */
  readonly result: { rows: unknown[] };
}

/**
 * An in-memory tenancy runner.
 *
 * It does NOT pretend to be RLS. It records which tenant a transaction was opened for and returns a
 * canned result, which is what a route-level or envelope-level test needs. The claim that RLS
 * isolates tenants is made and tested in `tests/db/rls.test.ts` against real PostgreSQL, and this
 * helper must never be cited as evidence for it.
 */
export function testTenancy(): TestTenancy {
  const recorded: RecordedTransaction[] = [];
  const result: { rows: unknown[] } = { rows: [] };
  const runner: TenancyPluginOptions = {
    runner: {
      withTenantTransaction: async <T,>(
        tenantId: string,
        fn: (tx: TenantTransaction) => Promise<T>,
      ): Promise<T> => {
        const queries: string[] = [];
        recorded.push({ tenantId, queries });
        const tx: TenantTransaction = {
          query: async <R = unknown>(text: string): Promise<{ rows: R[] }> => {
            queries.push(text);
            return { rows: result.rows as R[] };
          },
        };
        return fn(tx);
      },
    },
  };
  return { runner, recorded, result };
}
/**
 * A subject read model for tests that do not exercise subjects.
 *
 * Returns EMPTY results rather than throwing, because a route test that never touches a subject
 * should not have to care that one exists. It is NOT evidence about persistence: the suites that
 * assert subject behaviour run the real adapter against real PostgreSQL in `tests/db/`.
 *
 * `listSubjects` returning `[]` and `getSubjectDetail` returning `undefined` is exactly what an
 * empty tenant looks like, which is the honest behaviour for a stub — a stub that fabricated a row
 * would make a route test assert against data the database never held.
 */
/**
 * The §5.1.1/§5.1.4 default: every command refused.
 *
 * A creation stub that SUCCEEDED would let a contract test assert a 201 for a request whose authority rules were
 * never evaluated; refusing is the honest default for a suite that is not about subject creation.
 */
export function testSubjectCommands(): SubjectCommands {
  return {
    createSubject: async () => ({ ok: false, reason: 'EVIDENCE_NOT_FOUND' }),
    updateSubject: async () => ({ ok: false, reason: 'NOT_FOUND' }),
  };
}

export function testSubjectQueries(): SubjectQueries {
  return {
    listSubjects: async () => [],
    getSubjectDetail: async () => undefined,
    subjectExists: async () => false,
    listAliases: async () => [],
    listIdentifiers: async () => [],
    listLocationHistory: async () => [],
    listAuthorityGrants: async () => [],
    jurisdictionResolves: async () => false,
    appendLocationHistory: async () => ({ locationHistoryId: 'test-location-0001' }),
    appendAlias: async () => ({
      aliasId: 'test-alias-0001',
      addedAt: new Date(0).toISOString(),
      quarantined: false,
      candidateSubjectIds: [],
    }),
  };
}

/**
 * A source/recipe model for tests that do not exercise §5.3.
 *
 * EMPTY and NOT-FOUND are the honest answers for a stub: they are exactly what a tenant with no
 * declared sources looks like, and a stub that fabricated a source would make a route test assert
 * against data the database never held. It is NOT evidence about persistence — the suites that assert
 * §5.3 behaviour run the real adapter against real PostgreSQL in `tests/db/`.
 *
 * The WRITE methods refuse rather than fabricate. A stub that returned a created id would let a route
 * test pass while the real adapter wrote nothing, which is the failure mode `scripts/reality-gate.sh`
 * exists to catch.
 */
export function testSourceQueries(): SourceQueries {
  return {
    listSources: async () => [],
    getSourceDetail: async () => undefined,
    sourceExists: async () => false,
    declareSource: async () => ({ ok: false, reason: 'CONTROLLER_NOT_FOUND' }),
    setPermissionClass: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    listCatalogEntries: async () => [],
    appendCatalogEntry: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    createRecipe: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    listRecipes: async () => [],
    getRecipe: async () => undefined,
    setRecipeEnablement: async () => ({ ok: false, reason: 'NOT_FOUND' }),
  };
}

/**
 * No recipe verification keys.
 *
 * The EMPTY map is the honest default for a test: it is the state of every deployment while ADR-006 is
 * open, and it makes `POST /v1/sources/{sourceId}/recipes` refuse with `503 DEPENDENCY_UNAVAILABLE`
 * rather than accept a recipe no test can verify. A suite that wants the accepting path supplies its own
 * key pair through `tests/db/`, where a real signature can be produced.
 */
export function testRecipeVerificationKeys(): RecipeVerificationKeys {
  return { publicKeysByRef: new Map<string, string>() };
}

/**
 * An appeal-escalation model for tests that do not exercise §5.14.
 *
 * The READ methods return empty and the write refuses, for the same reason as the §5.3 stub: they are the
 * honest answers for a tenant with no escalations, and a stub that FABRICATED a created id would let a
 * route test pass while the real adapter wrote nothing — the failure mode `scripts/reality-gate.sh`
 * exists to catch. The behaviour that matters for §5.14 (which refusals happen before the port, and that
 * `requiresHumanReview: false` is refused) is asserted in `tests/contract/appeal-routes.test.ts` without
 * needing a database at all, because those rules are boundary rules.
 */
export function testAppealQueries(): AppealQueries {
  return {
    casePrecondition: async () => undefined,
    appealWindowClosed: async () => false,
    listAppealEscalations: async () => [],
    getAppealEscalation: async () => undefined,
    createAppealEscalation: async () => ({ ok: false, reason: 'CASE_NOT_FOUND' }),
  };
}

/**
 * A deadline model for tests that do not exercise §5.13.
 *
 * The reads return empty and the writes refuse, for the same reason as the other stubs. `deriveState` is
 * the REAL derivation rather than a stub: it is a pure function of three numbers, so reproducing it in a
 * stub would create a second definition of when a deadline is BREACHED — and the two would drift. The
 * adapter's version delegates to the same logic, and `tests/contract/deadline-routes.test.ts` asserts the
 * reachable values.
 */
export function testDeadlineQueries(): DeadlineQueries {
  return {
    caseDeadlineContext: async () => undefined,
    evidenceExists: async () => false,
    listDeadlines: async () => [],
    createDeadline: async () => ({ ok: false, reason: 'CASE_NOT_FOUND' }),
    satisfyDeadline: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    deriveState: (satisfiedAtMs, dueAtMs, nowMs) => {
      if (satisfiedAtMs !== null) return 'SATISFIED';
      return dueAtMs < nowMs ? 'BREACHED' : 'OPEN';
    },
  };
}

/**
 * An audit read model for tests that do not exercise §5.15.
 *
 * Empty results, because an audit stream with no rows is exactly what a tenant that has done nothing looks
 * like — and a stub that fabricated an event would let a route test assert against a trail the database never
 * held. The behaviour that matters for §5.15 (the two time-range refusals, and that no mutating audit route
 * exists) is asserted without a database in `tests/contract/audit-routes.test.ts`, because those are boundary
 * rules.
 */
export function testAuditQueries(): AuditQueries {
  return {
    listAuditEvents: async () => [],
    getAuditEvent: async () => undefined,
  };
}

/**
 * An observation/reappearance read model for tests that do not exercise §5.10/§5.11.
 *
 * Empty and not-found results, for the same reason as the other stubs. `REENTRY_RULES` is NOT stubbed: it is a
 * frozen constant of the contract (SPEC-001 T18's guards), so reproducing it here would create a second
 * definition of the re-entry rules that could drift from the one the routes report.
 */
export function testObservationQueries(): ObservationQueries {
  return {
    caseExists: async () => false,
    listVerificationObservations: async () => [],
    getVerificationObservation: async () => undefined,
    exposureExists: async () => false,
    caseRowVersion: async () => undefined,
    exposureRowVersion: async () => undefined,
    listReappearances: async () => [],
    listReappearancesForExposure: async () => [],
    recordVerificationObservation: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    recordReappearance: async () => ({ ok: false, reason: 'NOT_FOUND' }),
  };
}

/**
 * An exposure model for tests that do not exercise §5.5.
 *
 * Empty and not-found reads, refusing writes — the honest shape of a tenant with no exposures, and the same
 * rule as the other stubs: a write that FABRICATED a created id would let a route test pass while the real
 * adapter wrote nothing. The behaviour that matters for §5.5 without a database (the precondition codes, the
 * body validation, the `COVERAGE_BOUNDS_REQUIRED` rule) is asserted in `tests/contract/exposure-routes.test.ts`;
 * everything about the transition spine needs real PostgreSQL, because it is a property of the schema.
 */
export function testExposureQueries(): ExposureQueries {
  return {
    listExposures: async () => [],
    getExposureDetail: async () => undefined,
    exposureRowVersion: async () => undefined,
    recordMatchAssessment: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    recordDisproof: async () => ({ ok: false, reason: 'NOT_FOUND' }),
  };
}

/**
 * A transition spine for tests that do not exercise §5.5.5/§5.7.3/§5.7.6.
 *
 * An empty history is exactly what a resource that has never moved looks like. It is NOT evidence that the
 * spine works: `tests/db/exposure-transitions.test.ts` walks a real T3/T4 through the domain command and
 * reads the history back from `audit_event`.
 */
export function testControllerResponseQueries(): ControllerResponseQueries {
  return {
    recordControllerResponse: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    listControllerResponses: async () => [],
    createEmailThread: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    caseRowVersion: async () => undefined,
  };
}

export function testCaseQueries(): CaseQueries {
  return {
    listCases: async () => [],
    getCaseDetail: async () => undefined,
    caseRowVersion: async () => undefined,
    listTimeline: async () => [],
    createCase: async () => ({ ok: false, reason: 'EXPOSURE_NOT_FOUND' }),
    guardedUpdate: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    recordHumanGate: async () => ({ ok: false, reason: 'NOT_FOUND' }),
  };
}

/**
 * A transition spine for tests that do not exercise §5.5.5/§5.7.3/§5.7.6.
 *
 * An empty history is exactly what a resource that has never moved looks like. It is NOT evidence that the
 * spine works:   ests/db/exposure-transitions.test.ts walks a real T3/T4 through the domain command and
 * reads the history back from udit_event.
 */
export function testTransitionQueries(): TransitionQueries {
  return {
    listTransitionsForExposure: async () => [],
    listTransitionsForCase: async () => [],
    lastTransitionForCase: async () => undefined,
  };
}

/**
 * A COMPLETE set of server dependencies, with every port defaulted to the honest stub above.
 *
 * WHY THIS EXISTS, WITH A NUMBER. `ServerDependencies` requires every port, deliberately - an optional port is a
 * configuration in which a route crashes at runtime, which is EP-004 M3's decision and is not weakened here. The
 * cost of that decision has been paid at every port addition: adding ONE required port forced edits at 12-16 call
 * sites in EIGHT consecutive rounds (5.3, 5.14, 5.13, 5.15, 5.10/5.11, 5.5, 5.7, 5.9), because each suite listed
 * every port it did not care about. With this builder a suite names only what it is ABOUT, and a new port costs
 * ONE edit - here.
 *
 * WHAT IT DOES NOT DO: it does not weaken the contract, and it does not pretend a stub is persistence. Every
 * default is the same empty/not-found answer the suites used to pass by hand, so a suite converted to this builder
 * asserts exactly what it asserted before. `tests/db/**` keeps its explicit real adapters, because asserting
 * persistence has no honest default.
 */
export function testActionQueries(): ActionQueries {
  return {
    caseExists: async () => false,
    listActions: async () => [],
    getActionDetail: async () => undefined,
    actionRowVersion: async () => undefined,
    listMailPieces: async () => [],
    executeAction: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    recordReconciliation: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    requestReadback: async () => ({ ok: false, reason: 'NOT_FOUND' }),
  };
}

export function testPolicyQueries(): PolicyQueries {
  return {
    resolvePolicyDecision: async () => ({ ok: false, reason: 'NOT_FOUND' }),
    listPolicyDecisions: async () => [],
    getPolicyDecision: async () => undefined,
    listJurisdictionPolicies: async () => [],
    caseRowVersion: async () => undefined,
  };
}

/**
 * The §5.16 default: no reports, and a metric with a ZERO denominator.
 *
 * The metric stub returns `ratio: null`, not `0`, and that is the honest empty answer — "no confirmed match was
 * eligible" is what zero rows mean, and a stub reporting `ratio: 0` would let a suite assert a rate that no data
 * produced.
 */
export function testCoverageQueries(): CoverageQueries {
  return {
    listCoverageReports: async () => [],
    getCoverageReport: async () => undefined,
    removalEffectiveness: async () => ({
      interval: { from: new Date(0).toISOString(), to: new Date(0).toISOString() },
      overall: {
        eligibleConfirmedMatchDenominator: 0,
        verifiedRemovedNumerator: 0,
        ratio: null,
        confidenceInterval: null,
        denominatorDefinedAs: 'stub',
      },
      excludedFromNumerator: {
        acknowledged: 0,
        requestSubmitted: 0,
        searchDelisted: 0,
        notRemovable: 0,
        humanRequired: 0,
        ambiguous: 0,
      },
      groups: [],
      caveats: [...EFFECTIVENESS_CAVEATS],
    }),
  };
}

export function testServerDependencies(overrides: Partial<ServerDependencies> = {}): ServerDependencies {
  return {
    version: '0.0.0-test',
    commit: 'test',
    logLevel: 'silent',
    identity: testIdentity(),
    tenancy: testTenancy().runner,
    idempotency: testIdempotency(),
    sessionSecret: TEST_SESSION_SECRET,
    subjectQueries: testSubjectQueries(),
    subjectCommands: testSubjectCommands(),
    sourceQueries: testSourceQueries(),
    recipeVerificationKeys: testRecipeVerificationKeys(),
    appealQueries: testAppealQueries(),
    deadlineQueries: testDeadlineQueries(),
    auditQueries: testAuditQueries(),
    observationQueries: testObservationQueries(),
    exposureQueries: testExposureQueries(),
    transitionQueries: testTransitionQueries(),
    caseQueries: testCaseQueries(),
    controllerResponseQueries: testControllerResponseQueries(),
    actionQueries: testActionQueries(),
    policyQueries: testPolicyQueries(),
    coverageQueries: testCoverageQueries(),
    health: { startedAt: new Date(), now: () => new Date(), probes: [async () => ({ name: 'stub', ok: true })] },
    ...overrides,
  };
}
