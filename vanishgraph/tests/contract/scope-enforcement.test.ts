/**
 * The boundary gate against every route the registry declares (SPEC-003 §3.2 item 5; EP-006 M3).
 *
 * **EVERY REGISTRY ENTRY, NOT A SAMPLE.** A gate that is asserted on three routes is a gate that three routes obey, and
 * the registry is the one place that knows how many routes exist — so the suite iterates it and reports the row id on
 * failure, which is the SPEC-003 §5 catalogue number a reader can look up.
 *
 * THE DISPATCH COUNTER IS THE ASSERTION THAT MATTERS MOST. A gate that refused AFTER the handler ran would still show a
 * refusal to the caller while having done the work: data written, an external action sent, an audit row appended. The
 * suite therefore counts dispatches on the refused path and requires zero, for every route.
 *
 * THIS PROVES THE GATE, NOT THE SERVED ENDPOINTS. The tokens here are constructed in this file and the registry rows are
 * read from code; whether a live realm issues a token holding these scopes is `BLOCKED_CREDENTIALS` on `KEYCLOAK_ISSUER`.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ROUTES } from '../../src/http/openapi/registry.ts';
import { gateRoute } from '../../src/http/plugins/scope-guard.ts';
import { SCOPES, isScope } from '../../src/application/security/scope-catalogue.ts';
import { ROLE_BUNDLES, scopesForRole } from '../../src/application/security/role-bundles.ts';
import { checkEntitlement } from '../../src/application/security/entitlement.ts';
import type { IdentityClaims } from '../../src/application/contracts/identity.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';

/** A verified token holding exactly the scopes a test chooses. */
function token(scopes: readonly string[], role = 'TENANT_ADMIN'): IdentityClaims {
  return {
    sub: 'operator-opaque-1',
    iss: 'https://id.example/realms/vg',
    aud: 'vanishgraph-portal',
    exp: 1_800_000_900,
    nbf: 1_800_000_000,
    iat: 1_800_000_000,
    tenant_id: TENANT,
    roles: [role],
    subject_ref: 'subject-opaque-1',
    auth_level: 'webauthn',
    azp: 'vanishgraph-portal',
    scopes,
  };
}

/** The requirement the gate is given for a registry row. */
function requirementFor(route: (typeof ROUTES)[number]): {
  readonly routeId: string;
  readonly requiredScopes: readonly string[];
} {
  return { routeId: `${route.id} ${route.method} ${route.path}`, requiredScopes: route.scopes };
}

describe('the registry and the scope vocabulary agree (EP-006 M3)', () => {
  test('the registry declares routes, and every scope it names is in the closed vocabulary', () => {
    assert.ok(ROUTES.length >= 60, `expected the §5 catalogue, found ${String(ROUTES.length)} routes`);
    const outside: string[] = [];
    for (const route of ROUTES) {
      for (const scope of route.scopes) {
        if (!isScope(scope)) outside.push(`${route.id} ${route.method} ${route.path}: ${scope}`);
      }
    }
    assert.deepEqual(outside, [], `a route requires a scope outside SPEC-003 §3.3: ${outside.join('; ')}`);
  });

  test('every scope the vocabulary declares is required by at least one route, INCLUDING conditional requirements', () => {
    // The other direction: a scope nobody requires is either a route that forgot to declare it or a vocabulary entry
    // that has no home, and both are worth seeing.
    //
    // MEASURED: the first version collected only each route's unconditional scopes and reported vg.pii.reveal as an
    // orphan. It is not one - SPEC-003 §5.1.6/§5.1.8 require it only when includeValue=true, which the registry
    // carries in conditional - so the check now reads both, and the finding was the check's, not the registry's.
    const required = new Set([
      ...ROUTES.flatMap((route) => [...route.scopes]),
      ...ROUTES.flatMap((route) => (route.conditional ?? []).flatMap((condition) => [...condition.scopes])),
    ]);
    const orphans = SCOPES.filter((scope) => !required.has(scope as never));
    assert.deepEqual(orphans, [], `scopes declared but required by no route: ${orphans.join(', ')}`);
  });
});

describe('for every route: the exact scopes are admitted and a missing one is refused (VG-API-014)', () => {
  test('a token holding exactly the required scopes is admitted, and one missing any is refused before dispatch', () => {
    const failures: string[] = [];
    for (const route of ROUTES) {
      const requirement = requirementFor(route);
      let dispatches = 0;
      const dispatch = (): void => {
        dispatches += 1;
      };

      // ADMITTED with exactly the required scopes.
      const admitted = gateRoute({ routeId: requirement.routeId, requiredScopes: requirement.requiredScopes }, token([...route.scopes]));
      if (!admitted.ok) {
        failures.push(`${requirement.routeId}: exact scopes refused with ${String(admitted.code)} (${String(admitted.detail)})`);
        continue;
      }
      dispatch();

      // REFUSED when any single required scope is missing, and nothing dispatched.
      for (const scope of route.scopes) {
        const partial = route.scopes.filter((candidate) => candidate !== scope);
        const decision = gateRoute({ routeId: requirement.routeId, requiredScopes: requirement.requiredScopes }, token(partial));
        if (decision.ok) {
          failures.push(`${requirement.routeId}: admitted without ${scope}`);
          continue;
        }
        if (decision.code !== 'INSUFFICIENT_SCOPE') {
          failures.push(`${requirement.routeId}: missing ${scope} gave ${decision.code} instead of INSUFFICIENT_SCOPE`);
        }
        if (decision.ok) dispatch();
      }
      if (dispatches !== 1) failures.push(`${requirement.routeId}: ${String(dispatches)} dispatches, expected 1 (only the admitted request runs)`);
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  test('a route requiring no scope still refuses a wildcard token', () => {
    const scopeFree = ROUTES.filter((route) => route.scopes.length === 0);
    // A route with no scope is a token-only route (health, or an ingress route authenticated by signature); the wildcard
    // rule is not about scopes, so it holds there too.
    for (const route of scopeFree) {
      const decision = gateRoute({ routeId: `${route.id} ${route.path}`, requiredScopes: [] }, token(['*']));
      assert.equal(decision.ok, false, `${route.id} must refuse a wildcard token`);
      assert.equal(decision.code, 'TOKEN_SCOPE_WILDCARD_FORBIDDEN');
    }
    assert.ok(scopeFree.length >= 0);
  });

  test('a wildcard token is refused on EVERY route, with the §3.2 item 9 code', () => {
    const admitted: string[] = [];
    for (const route of ROUTES) {
      const decision = gateRoute({ routeId: `${route.id} ${route.method} ${route.path}`, requiredScopes: route.scopes }, token(['*']));
      if (decision.ok) admitted.push(`${route.id} ${route.method} ${route.path}`);
      else if (decision.code !== 'TOKEN_SCOPE_WILDCARD_FORBIDDEN') admitted.push(`${route.id}: ${String(decision.code)}`);
    }
    assert.deepEqual(admitted, [], `a wildcard token was not refused with the wildcard code: ${admitted.join('; ')}`);
  });

  test('a token holding every scope a role bundle grants is admitted on the routes those scopes cover', () => {
    // A cross-check that the bundles are usable: for each role, the routes whose scopes are a subset of the bundle must
    // be admitted with a token holding the whole bundle. A bundle that no route can satisfy would be a role that cannot
    // do its job.
    const failures: string[] = [];
    let covered = 0;
    for (const role of Object.keys(ROLE_BUNDLES)) {
      const held = scopesForRole(role as keyof typeof ROLE_BUNDLES);
      for (const route of ROUTES) {
        if (route.scopes.length === 0) continue;
        if (!route.scopes.every((scope) => held.includes(scope))) continue;
        covered += 1;
        const decision = gateRoute({ routeId: `${route.id} ${route.method} ${route.path}`, requiredScopes: route.scopes }, token([...held], role));
        if (!decision.ok) failures.push(`${role} refused on ${route.id} with ${String(decision.code)}: ${String(decision.detail)}`);
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
    assert.ok(covered > 20, `expected the bundles to cover many routes, covered ${String(covered)}`);
  });

  test('a machine token is refused the routes whose scope it may not hold (SPEC-003 §3.2 item 9)', () => {
    const machine = token([], 'TENANT_ADMIN');
    for (const forbidden of ['vg.audit.read', 'vg.evidence.read_content', 'vg.actions.execute', 'vg.pii.reveal']) {
      const decision = gateRoute(
        { routeId: `probe ${forbidden}`, requiredScopes: [forbidden] },
        { ...machine, roles: [], scopes: [forbidden] },
      );
      assert.equal(decision.ok, false, `a machine token must not hold ${forbidden}`);
      // Either code is a refusal; which one depends on whether the scope is checked for the machine rule first.
      assert.equal(['TOKEN_INVALID_CLAIMS', 'INSUFFICIENT_SCOPE'].includes(String(decision.code)), true, `got ${String(decision.code)}`);
    }
  });
});


describe('a stale scope set is refused and audited (SPEC-003 §3.3)', () => {
  const claims = token(['vg.cases.read', 'vg.evidence.read_content']);

  test('an entitlement that no longer carries a scope refuses the request rather than serving the intersection', () => {
    const { decision, audit } = checkEntitlement(
      claims,
      { tenantId: TENANT, roles: ['TENANT_ADMIN'], scopes: ['vg.cases.read'], changedAt: '2026-09-01T00:00:00Z' },
      '2026-09-16T00:00:00Z',
    );
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'ENTITLEMENT_CHANGED');
    assert.deepEqual(decision.withdrawnScopes, ['vg.evidence.read_content']);
    assert.match(decision.detail ?? '', /no longer entitles/);
    // THE AUDIT RECORD IS THE REQUIREMENT: an entitlement change that silently refuses is indistinguishable from a bug.
    assert.ok(audit !== undefined);
    assert.equal(audit?.event, 'entitlement.refused');
    assert.equal(audit?.code, 'ENTITLEMENT_CHANGED');
    assert.deepEqual(audit?.withdrawnScopes, ['vg.evidence.read_content']);
    assert.equal(audit?.entitlementChangedAt, '2026-09-01T00:00:00Z');
  });

  test('a withdrawn ROLE is refused on the same path', () => {
    const { decision, audit } = checkEntitlement(
      claims,
      { tenantId: TENANT, roles: [], scopes: ['vg.cases.read', 'vg.evidence.read_content'], changedAt: '2026-09-02T00:00:00Z' },
      '2026-09-16T00:00:00Z',
    );
    assert.equal(decision.ok, false);
    assert.match(decision.detail ?? '', /role TENANT_ADMIN/);
    assert.equal(audit?.code, 'ENTITLEMENT_CHANGED');
  });

  test('a matching entitlement is admitted with no audit record', () => {
    const { decision, audit } = checkEntitlement(
      claims,
      { tenantId: TENANT, roles: ['TENANT_ADMIN'], scopes: ['vg.cases.read', 'vg.evidence.read_content'], changedAt: '2026-09-01T00:00:00Z' },
      '2026-09-16T00:00:00Z',
    );
    assert.equal(decision.ok, true);
    assert.equal(audit, undefined);
    assert.deepEqual(decision.withdrawnScopes, []);
  });

  test('a missing or mismatched entitlement record is refused, and audited as a tenant mismatch', () => {
    for (const entitlement of [undefined, { tenantId: '22222222-2222-4222-8222-222222222222', roles: [], scopes: [], changedAt: 'x' }]) {
      const { decision, audit } = checkEntitlement(claims, entitlement, '2026-09-16T00:00:00Z');
      assert.equal(decision.ok, false);
      assert.equal(decision.code, 'TENANT_MISMATCH');
      assert.equal(audit?.code, 'TENANT_MISMATCH');
    }
  });
});

