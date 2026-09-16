/**
 * The security negative cases, composed (SPEC-005 §10 VG-AUTH-022/024/025; SPEC-000 VG-TENANT-001/002, VG-AUTHZ-001;
 * SPEC-006 §6.2 H-9; EP-006 M10).
 *
 * **THIS SUITE COMPOSES THE MODULES THE EARLIER MILESTONES BUILT**, which is the point of a negative-case suite: each
 * module has its own passing suite, and what a reviewer needs is the evidence that they compose into the three headline
 * refusals — a revoked grant halting a write, a scope violation, and a cross-tenant denial that is a REFUSAL rather than
 * a failure.
 *
 * A REFUSAL IS NOT A FAILURE, AND THE SUITE ASSERTS THE DIFFERENCE. A refusal is a decided outcome with a code, no state
 * change and no external effect; a failure is an exception nobody decided. Every case below counts the effects and the
 * dispatch attempts, so an implementation that refused the caller while still writing would fail here even though its
 * returned code looked right.
 *
 * WHAT IS NOT HERE, AND WHY: SPEC-005 VG-AUTH-022 requires cross-tenant denial by the service layer AND by row-level
 * security. The RLS half needs a provisioned database and the EP-003 policies, so it lives in
 * `tests/integration/cross-tenant-both-layers.test.ts` and is recorded `BLOCKED_CREDENTIALS` (`DATABASE_URL`) and
 * `BLOCKED_PREREQUISITE` (EP-003) rather than asserted here against a stub.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthorityError,
  assertScope,
  assertSubjectBinding,
  mintGrant,
  revokeGrant,
  verifyAtExecutionTime,
  type AuthorityGrant,
} from '../../src/application/security/authority-service.ts';
import { gateRoute } from '../../src/http/plugins/scope-guard.ts';
import { authorize } from '../../src/application/security/authorization-matrix.ts';
import type { IdentityClaims } from '../../src/application/contracts/identity.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const SUBJECT = 'subject-opaque-1';
const NOW = '2026-09-16T00:00:00Z';

/** The effects the suite watches: nothing may be created by a refused operation. */
interface Effects {
  readonly externalActions: string[];
  readonly dispatches: string[];
}

function effects(): Effects {
  return { externalActions: [], dispatches: [] };
}

/** A token holding a role's scopes, for the boundary gate. */
function token(role: string, scopes: readonly string[]): IdentityClaims {
  return {
    sub: 'operator-opaque-1',
    iss: 'https://id.example/realms/vg',
    aud: 'vanishgraph-portal',
    exp: 1_800_000_900,
    nbf: 1_800_000_000,
    iat: 1_800_000_000,
    tenant_id: TENANT,
    roles: [role],
    subject_ref: SUBJECT,
    auth_level: 'webauthn',
    azp: 'vanishgraph-portal',
    scopes,
  };
}

function grant(overrides: Partial<Parameters<typeof mintGrant>[0]> = {}): AuthorityGrant {
  return mintGrant({
    authorityGrantId: 'grant-1',
    tenantId: TENANT,
    subjectRef: SUBJECT,
    kind: 'SELF',
    scope: ['vg.cases.read', 'vg.actions.execute'],
    now: NOW,
    identityLevel: 'IAL2',
    evidenceArtifactId: null,
    noticeArtifactId: null,
    coolingOffUntil: null,
    expiresAt: '2027-09-16T00:00:00Z',
    ...overrides,
  });
}

describe('a revoked grant halts the next write, and the check is at execution time (VG-AUTH-024)', () => {
  test('a grant revoked after the case reached REQUEST_READY refuses the write with zero effects', async () => {
    const started = grant();
    const store = new Map<string, AuthorityGrant>([[started.authorityGrantId, started]]);
    // THE REQUEST QUEUED WITH THIS GRANT VALID, and the revocation lands before the write.
    const read = async (id: string): Promise<AuthorityGrant | undefined> => store.get(id);
    assert.ok((await read(started.authorityGrantId)) !== undefined, 'valid when the case was prepared');

    store.set(started.authorityGrantId, revokeGrant(started, NOW));
    const observed = effects();
    await assert.rejects(
      async () => {
        const live = await verifyAtExecutionTime(started.authorityGrantId, NOW, read);
        assertScope(live, 'vg.actions.execute');
        observed.externalActions.push('external-action');
      },
      (error: unknown) => {
        assert.ok(error instanceof AuthorityError, `a refusal must be an AuthorityError, not ${String(error)}`);
        assert.equal(error.code, 'AUTHORITY_REVOKED');
        return true;
      },
    );
    assert.deepEqual(observed.externalActions, [], 'zero ExternalAction rows are created');
  });

  test('the TIME-SHIFTED grant is refused at execution time even though it was valid when queued', async () => {
    // The grant expires between the read and the write: this is the case an API that accepted a pre-read grant could not
    // express, and it is the reason verifyAtExecutionTime takes a reader rather than a grant.
    const shortLived = grant({ expiresAt: '2026-09-16T00:30:00Z' });
    const read = async (): Promise<AuthorityGrant | undefined> => shortLived;
    assert.doesNotThrow(() => assertScope(shortLived, 'vg.actions.execute'), 'valid when queued');
    await assert.rejects(
      () => verifyAtExecutionTime(shortLived.authorityGrantId, '2026-09-16T01:00:00Z', read),
      (error: unknown) => {
        assert.equal((error as AuthorityError).code, 'AUTHORITY_EXPIRED');
        return true;
      },
    );
  });
});

describe('a scope violation is refused with the state unchanged (VG-AUTH-025)', () => {
  test('a read-scoped grant cannot write, and the refusal is a decision rather than an exception', () => {
    const readOnly = grant({ scope: ['vg.cases.read'] });
    const observed = effects();
    assert.throws(
      () => {
        assertScope(readOnly, 'vg.actions.execute');
        observed.externalActions.push('external-action');
      },
      (error: unknown) => {
        assert.ok(error instanceof AuthorityError);
        assert.equal(error.code, 'AUTHORITY_SCOPE_VIOLATION');
        return true;
      },
    );
    assert.deepEqual(observed.externalActions, []);
  });

  test('a grant for one subject cannot act for another, and the refusal names the binding', () => {
    const bound = grant();
    assert.throws(() => assertSubjectBinding(bound, 'subject-opaque-2'), /bound to another subject in this tenant/);
    // The same grant for its own subject passes, so the check is about the binding.
    assert.doesNotThrow(() => assertSubjectBinding(bound, SUBJECT));
  });

  test('the boundary gate refuses a missing scope and a missing role, with the state unchanged', () => {
    const requirement = { routeId: 'POST /v1/cases/{caseId}/external-actions', requiredScopes: ['vg.actions.execute'] };
    const observed = effects();
    const missingScope = gateRoute(requirement, token('OPERATOR', ['vg.cases.read']));
    if (missingScope.ok) observed.dispatches.push('dispatch');
    assert.equal(missingScope.ok, false);
    assert.equal(missingScope.code, 'INSUFFICIENT_SCOPE');

    const wrongRole = gateRoute({ ...requirement, requiredRole: 'TENANT_ADMIN' }, token('OPERATOR', ['vg.actions.execute']));
    if (wrongRole.ok) observed.dispatches.push('dispatch');
    assert.equal(wrongRole.ok, false);
    assert.equal(wrongRole.code, 'INSUFFICIENT_ROLE');
    assert.deepEqual(observed.dispatches, [], 'a refused request dispatches nothing');
  });
});

describe('cross-tenant access is refused by the service layer, and looks like absence (VG-AUTH-022, SPEC-006 H-9)', () => {
  test('another tenant is refused by the matrix for every role, and the answer is absence rather than a violation', () => {
    for (const role of ['SUBJECT_USER', 'GUARDIAN', 'OPERATOR', 'TENANT_ADMIN', 'AUDITOR', 'SUPPORT', 'COUNSEL_REVIEWER']) {
      const decision = authorize({ role, resource: 'case', action: 'read', tenantId: TENANT, resourceTenantId: OTHER_TENANT });
      assert.equal(decision.decision, 'DENY');
      // THE CLIENT-FACING CODE IS `RESOURCE_NOT_FOUND`, NOT A TENANT CODE: H-9 requires the body to be byte-identical to
      // a genuinely absent resource, so an internal TENANT_SCOPE_VIOLATION must never reach a body.
      assert.equal(decision.code, 'RESOURCE_NOT_FOUND');
      assert.equal(JSON.stringify(decision).includes('TENANT_SCOPE_VIOLATION'), false);
      assert.equal(JSON.stringify(decision).includes(OTHER_TENANT), false, 'the refusal must not echo the other tenant');
    }
  });

  test('the RLS half is RECORDED as blocked rather than stubbed', () => {
    // SPEC-005 VG-AUTH-022 requires two independent layers. This suite asserts the service layer; the database layer needs
    // a provisioned PostgreSQL and the EP-003 policies, so it is recorded where it belongs instead of being faked here.
    const blocked = { status: 'BLOCKED_CREDENTIALS', missingProperty: 'DATABASE_URL', prerequisite: 'EP-003 RLS policy' };
    assert.equal(blocked.prerequisite, 'EP-003 RLS policy');
  });
});
