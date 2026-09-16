/**
 * The scope vocabulary and role bundles equal the specification (SPEC-003 §3.3, SPEC-005 §2; EP-006 M1).
 *
 * THE TABLES ARE PARSED, NOT COPIED. Both specifications are read at test time: §3.3's scope table gives each scope and
 * the roles that may carry it, and §2's role table gives each role's purpose and its prohibition. Every assertion below
 * is an equality between what the code declares and what the document says, so a scope added in one place and not the
 * other fails — which is the only way a closed vocabulary stays closed.
 *
 * TWO PLAN FACTS THAT THE SPECIFICATION CONTRADICTS ARE ASSERTED RATHER THAN SILENTLY RESOLVED: the plan says "four"
 * service-token-forbidden scopes where §3.2 item 9 names seven, and it asks for "five role bundles" from a §3.3 that
 * declares no bundles at all. The suite pins both counts to the parsed documents.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  INGEST_SCOPE,
  MACHINE_FORBIDDEN_SCOPES,
  SCOPES,
  assertBundleWithinCatalogue,
  assertNoWildcard,
  assertNotIngestScope,
  isScope,
  machineMayHold,
} from '../../src/application/security/scope-catalogue.ts';
import { ROLE_BUNDLES, isRole, scopesForRole, validatedBundles } from '../../src/application/security/role-bundles.ts';
import { SecurityConfigError, missingSecurityEnvVars, readSecurityConfig } from '../../src/adapters/config/security-config.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SPEC_003 = readFileSync(join(PROJECT_ROOT, '.agent', 'specs', 'SPEC-003-api-contracts.md'), 'utf8');
const SPEC_005 = readFileSync(join(PROJECT_ROOT, '.agent', 'specs', 'SPEC-005-auth-permissions.md'), 'utf8');

/** §3.3's scope rows: the scope, and the roles the specification says may carry it. */
function declaredScopes(): readonly { readonly scope: string; readonly roles: readonly string[] }[] {
  const out: { scope: string; roles: string[] }[] = [];
  for (const line of SPEC_003.split('\n')) {
    const match = /^\| `(vg\.[a-z_.]+)` \| [^|]+ \| (.+) \|$/.exec(line);
    if (match === null) continue;
    const cell = match[2] ?? '';
    // ONE ROW IS PROSE RATHER THAN A ROLE LIST, AND IT SAYS SO IN ITS OWN WORDS: `vg.pii.reveal`'s cell reads "No
    // standing role; granted explicitly per SPEC-005 §2 `SUPPORT` rules and never to a machine token". MEASURED: a
    // parser that took every backticked role name out of that cell derived SUPPORT → vg.pii.reveal and failed the
    // bundle equality — the specification is right and the naive parse was wrong. The exclusion is stated here rather
    // than silently applied, and the assertion below still requires that NO role carries the scope.
    if (/no standing role/i.test(cell)) {
      out.push({ scope: match[1] ?? '', roles: [] });
      continue;
    }
    const roles = [...cell.matchAll(/`(SUBJECT_USER|GUARDIAN|OPERATOR|TENANT_ADMIN|AUDITOR|SUPPORT|COUNSEL_REVIEWER)`/g)].map(
      (roleMatch) => roleMatch[1] ?? '',
    );
    out.push({ scope: match[1] ?? '', roles: [...new Set(roles)] });
  }
  return out;
}

/** §2's role rows: the role, its purpose and its prohibition. */
function declaredRoles(): readonly { readonly role: string; readonly purpose: string; readonly mayNot: string }[] {
  const out: { role: string; purpose: string; mayNot: string }[] = [];
  for (const line of SPEC_005.split('\n')) {
    const match = /^\| `(SUBJECT_USER|GUARDIAN|OPERATOR|TENANT_ADMIN|AUDITOR|SUPPORT|COUNSEL_REVIEWER)` \| ([^|]+) \| ([^|]+) \|$/.exec(line);
    if (match === null) continue;
    out.push({ role: match[1] ?? '', purpose: (match[2] ?? '').trim(), mayNot: (match[3] ?? '').trim() });
  }
  return out;
}

/** The service-token-forbidden scopes named in §3.2 item 9's sentence. */
function declaredMachineForbidden(): readonly string[] {
  const sentence = /must not hold\s+([\s\S]*?)\.\s/.exec(SPEC_003)?.[1] ?? '';
  return [...sentence.matchAll(/`(vg\.[a-z_.]+)`/g)].map((match) => match[1] ?? '');
}

describe('the scope vocabulary equals SPEC-003 §3.3 (EP-006 M1)', () => {
  test('set equality in both directions, against the parsed specification table', () => {
    const declared = declaredScopes().map((row) => row.scope);
    assert.ok(declared.length >= 20, `expected the §3.3 table to declare the vocabulary, found ${String(declared.length)}`);
    assert.deepEqual([...SCOPES].sort(), [...declared].sort(), 'the catalogue and the specification must declare the same scopes');
  });

  test('isScope accepts every declared scope and refuses anything else', () => {
    for (const scope of SCOPES) assert.equal(isScope(scope), true, `${scope} must be a scope`);
    assert.equal(isScope('vg.subjects.delete'), false);
    assert.equal(isScope('*'), false);
    assert.equal(isScope('vg.webhooks.ingest'), false, 'the ingress scope is deliberately absent from §3.3');
  });

  test('a wildcard is refused, never expanded', () => {
    assert.throws(() => assertNoWildcard('vg.*'), /contains a wildcard/);
    assert.throws(() => assertNoWildcard('*'), /contains a wildcard/);
    assert.doesNotThrow(() => assertNoWildcard('vg.subjects.read'));
  });

  test('the ingress scope is refused wherever a caller could present it', () => {
    assert.equal(SPEC_003.includes(INGEST_SCOPE), true, 'the specification names it in order to exclude it');
    assert.throws(() => assertNotIngestScope(INGEST_SCOPE), /is not a caller-issued scope/);
  });

  test('the machine-forbidden set is the SEVEN §3.2 item 9 names, not the four the plan states', () => {
    const declared = declaredMachineForbidden();
    assert.equal(declared.length, 7, `§3.2 item 9 names seven scopes, parsed ${declared.join(', ')}`);
    assert.deepEqual([...MACHINE_FORBIDDEN_SCOPES].sort(), [...declared].sort());
    assert.equal(MACHINE_FORBIDDEN_SCOPES.length, 7, 'the plan says four; the specification wins and the count is pinned here');
    for (const scope of MACHINE_FORBIDDEN_SCOPES) {
      assert.equal(machineMayHold(scope), false, `${scope} must not be held by a machine token`);
    }
    assert.equal(machineMayHold('vg.cases.read'), true);
    assert.equal(machineMayHold('*'), false);
  });
});

describe('the role bundles are derived from the specification, not invented (EP-006 M1)', () => {
  test('every role in the catalogue is one of the seven §2 declares, and every declared role is present', () => {
    const declared = declaredRoles().map((row) => row.role).sort();
    assert.deepEqual(declared.length, 7, `expected seven roles, found ${declared.join(', ')}`);
    assert.deepEqual(Object.keys(ROLE_BUNDLES).sort(), declared);
    for (const role of declared) assert.equal(isRole(role), true, `${role} must be a role`);
    assert.equal(isRole('SUPERUSER'), false);
  });

  test('each bundle equals the scopes §3.3 says that role may carry', () => {
    const rows = declaredScopes();
    for (const { role } of declaredRoles()) {
      const expected = rows.filter((row) => row.roles.includes(role)).map((row) => row.scope).sort();
      const actual = [...scopesForRole(role as Parameters<typeof scopesForRole>[0])].sort();
      assert.deepEqual(actual, expected, `${role}: the bundle must equal §3.3's role column`);
    }
  });

  test('every bundle is inside the catalogue, carries no wildcard and no ingress scope', () => {
    for (const bundle of validatedBundles()) {
      assertBundleWithinCatalogue(bundle.role, bundle.scopes);
      for (const scope of bundle.scopes) {
        assert.equal(SCOPES.includes(scope), true, `${bundle.role} carries ${scope}`);
        assert.equal(scope.includes('*'), false);
        assert.notEqual(scope, INGEST_SCOPE);
      }
    }
  });

  test('every role carries its prohibition sentence from §2, not an empty note', () => {
    for (const declared of declaredRoles()) {
      const bundle = ROLE_BUNDLES[declared.role as Parameters<typeof scopesForRole>[0]];
      assert.ok(bundle.mayNot.trim().length > 10, `${declared.role} must carry its mayNot sentence`);
      // The specification's sentence begins the same way; comparing the first clause catches a rewritten prohibition.
      const firstClause = declared.mayNot.split(';')[0]?.split('.')[0]?.trim() ?? '';
      assert.ok(
        bundle.mayNot.startsWith(firstClause.slice(0, 12)),
        `${declared.role}: mayNot must be the specification's sentence (got "${bundle.mayNot}")`,
      );
    }
  });

  test('the prohibited combinations the specification names are absent from the bundles', () => {
    // AUDITOR: "Any write; any state transition" — so no scope whose name ends in a write verb it must not hold.
    const auditor = scopesForRole('AUDITOR');
    for (const forbidden of ['vg.actions.execute', 'vg.appeal.write', 'vg.authority.write', 'vg.policy.write']) {
      assert.equal(auditor.includes(forbidden), false, `AUDITOR must not carry ${forbidden}`);
    }
    // AND THE ONE THAT LOOKS LIKE A WRITE BUT IS NOT: `vg.evidence.read_content` IS in the AUDITOR bundle, because
    // §3.3's role column grants it and the scope is step-up gated. MEASURED: the first version of the bundle omitted it
    // on the strength of §2's "Any write" prohibition and this derivation assertion failed — reading is not writing.
    assert.equal(auditor.includes('vg.evidence.read_content'), true);
    // OPERATOR: "mint AuthorityGrant" is prohibited, but §3.3 grants the scope with a condition, so the condition is
    // what must be visible rather than the scope being silently dropped.
    assert.equal(scopesForRole('OPERATOR').includes('vg.authority.write'), false);
    assert.equal(ROLE_BUNDLES.TENANT_ADMIN.conditions?.length, 2, 'TENANT_ADMIN carries both of its §3.3 conditions');
    // SUPPORT is JIT and never holds the reveal scope standing.
    assert.equal(scopesForRole('SUPPORT').includes('vg.pii.reveal'), false);
    // §3.3 grants vg.pii.reveal to no role at all.
    for (const role of Object.keys(ROLE_BUNDLES) as (keyof typeof ROLE_BUNDLES)[]) {
      assert.equal(ROLE_BUNDLES[role].scopes.includes('vg.pii.reveal'), false, `${role} must not hold vg.pii.reveal standing`);
    }
  });

  test('NEGATIVE CASE: a bundle carrying a scope outside the catalogue fails', () => {
    assert.throws(() => assertBundleWithinCatalogue('TEST', ['vg.subjects.read', 'vg.subjects.delete']), /not in the SPEC-003 §3.3 scope vocabulary/);
    assert.throws(() => assertBundleWithinCatalogue('TEST', ['*']), /contains a wildcard/);
    assert.throws(() => assertBundleWithinCatalogue('TEST', [INGEST_SCOPE]), /is not a caller-issued scope/);
  });
});

describe('the security configuration names variables and never values (EP-006 M1)', () => {
  const COMPLETE = {
    KEYCLOAK_ISSUER: 'https://id.example/realms/vg',
    KEYCLOAK_CLIENT_ID: 'vanishgraph-portal',
    KEYCLOAK_CLIENT_SECRET: 'SECRET-SENTINEL-CONFIG',
    SESSION_SECRET: 'S'.repeat(32),
    KEYCLOAK_PORTAL_AUDIENCE: 'vg-portal',
    KEYCLOAK_SERVICE_AUDIENCE: 'vg-service',
    KEYCLOAK_MCP_AUDIENCE: 'vg-mcp',
    KEYCLOAK_STEP_UP_ACR: 'urn:vg:loa:step-up',
  };

  test('a complete environment reads, and the values are returned rather than logged', () => {
    const config = readSecurityConfig(COMPLETE);
    assert.equal(config.clientSecret, 'SECRET-SENTINEL-CONFIG');
    assert.equal(config.audiences.mcp, 'vg-mcp');
    assert.equal(config.stepUpAcr, 'urn:vg:loa:step-up');
  });

  test('every absent variable aborts with its own name, and no message contains a value', () => {
    // THE SENTINEL IS THE POINT: every other variable is present and holds a sentinel, and the failure message for the
    // missing one must not contain any of them. A config error that prints its input is a credential disclosure.
    for (const name of Object.keys(COMPLETE)) {
      const env: Record<string, string> = { ...COMPLETE };
      delete env[name];
      if (name === 'KEYCLOAK_CLIENT_SECRET') {
        assert.throws(
          () => readSecurityConfig(env),
          (error: unknown) => {
            assert.ok(error instanceof SecurityConfigError);
            assert.equal(error.variable, name);
            assert.match(error.message, new RegExp(`^dependency unavailable: ${name} is unset`));
            assert.equal(error.message.includes('SENTINEL'), false, 'the message must not carry a value');
            return true;
          },
        );
        continue;
      }
      assert.throws(() => readSecurityConfig(env), new RegExp(`${name} is unset`), `${name} must be reported`);
      try {
        readSecurityConfig(env);
      } catch (error) {
        assert.equal((error as Error).message.includes('SENTINEL'), false, `${name}: the message must not carry a value`);
      }
    }
  });

  test('a short SESSION_SECRET is refused, and the message names the requirement rather than the value', () => {
    assert.throws(
      () => readSecurityConfig({ ...COMPLETE, SESSION_SECRET: 'SHORT-SENTINEL' }),
      (error: unknown) => {
        assert.match((error as Error).message, /SESSION_SECRET is shorter than the 32-character minimum/);
        assert.equal((error as Error).message.includes('SHORT-SENTINEL'), false);
        return true;
      },
    );
  });

  test('the absent-variable report lists names only, in declaration order', () => {
    const missing = missingSecurityEnvVars({});
    assert.equal(missing.length >= 8, true);
    assert.equal(missing[0], 'KEYCLOAK_ISSUER');
    assert.equal(missing.includes('SESSION_SECRET'), true);
    // On this machine the real environment has none of them, which is the state the node records as BLOCKED_CREDENTIALS.
    const real = missingSecurityEnvVars(process.env);
    assert.equal(real.includes('KEYCLOAK_ISSUER'), true, 'KEYCLOAK_ISSUER is unprovisioned in this environment');
  });
});
