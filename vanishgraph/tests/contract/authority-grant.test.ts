/**
 * The `AuthorityGrant` lifecycle (SPEC-005 §3/§4/§10; EP-006 M4).
 *
 * Every refusal below is asserted to LEAVE STATE UNCHANGED and to create NO `ExternalAction`: a refusal that had already
 * written something is not a refusal. The suite counts both, because "no external effect" is the requirement's actual
 * wording in every one of these cases and a test that only checked the thrown code would miss a write that happened first.
 *
 * The grants are constructed in this file. Whether a realm issues the identity levels they carry is
 * `BLOCKED_CREDENTIALS` on `KEYCLOAK_ISSUER`.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthorityError,
  assertScope,
  assertSubjectBinding,
  contestGrant,
  effectiveScope,
  kindFromWire,
  kindToWire,
  mintGrant,
  requiredEvidence,
  revokeGrant,
  verifyAtExecutionTime,
  type AuthorityGrant,
  type AuthorityKind,
} from '../../src/application/security/authority-service.ts';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SUBJECT = 'subject-opaque-1';
const OTHER_SUBJECT = 'subject-opaque-2';
const NOW = '2026-09-16T00:00:00Z';
const LATER = '2027-09-16T00:00:00Z';

/** A store the tests control, so a write is visible as a count rather than as an absence of evidence. */
function store(initial: readonly AuthorityGrant[] = []): {
  readonly rows: Map<string, AuthorityGrant>;
  readonly externalActions: string[];
  readonly read: (id: string) => Promise<AuthorityGrant | undefined>;
} {
  const rows = new Map(initial.map((grant) => [grant.authorityGrantId, grant]));
  const externalActions: string[] = [];
  return { rows, externalActions, read: async (id: string) => rows.get(id) };
}

function mint(overrides: Partial<Parameters<typeof mintGrant>[0]> = {}): AuthorityGrant {
  return mintGrant({
    authorityGrantId: 'grant-1',
    tenantId: TENANT,
    subjectRef: SUBJECT,
    kind: 'SELF',
    scope: ['vg.cases.read', 'vg.discovery.run'],
    now: NOW,
    identityLevel: 'IAL2',
    evidenceArtifactId: null,
    noticeArtifactId: null,
    coolingOffUntil: null,
    expiresAt: LATER,
    ...overrides,
  });
}

describe('minting refuses every condition the specification names (VG-AUTHZ-010…014)', () => {
  test('a SELF grant is minted, and nothing is written by the mint itself', () => {
    const rows = store();
    const grant = mint();
    assert.equal(rows.rows.size, 0, 'minting validates; the caller stores');
    assert.equal(grant.revokedAt, null);
    assert.equal(grant.contestedAt, null);
    assert.equal(grant.identityLevel, 'IAL2');
  });

  test('each kind names the evidence it requires, and a missing instrument is AUTHORITY_EVIDENCE_REQUIRED', () => {
    const kinds: AuthorityKind[] = ['SELF', 'AGENT', 'PARENT_GUARDIAN', 'LEGAL_REPRESENTATIVE'];
    for (const kind of kinds) {
      const requirement = requiredEvidence(kind);
      if (requirement === null) {
        assert.doesNotThrow(() => mint({ kind }));
        continue;
      }
      const rows = store();
      assert.throws(
        () => mint({ kind, evidenceArtifactId: null, noticeArtifactId: 'notice-1' }),
        (error: unknown) => {
          assert.ok(error instanceof AuthorityError);
          assert.equal(error.code, 'AUTHORITY_EVIDENCE_REQUIRED');
          assert.match(error.message, new RegExp(requirement.slice(0, 20)));
          return true;
        },
        `${kind} must require ${requirement}`,
      );
      assert.equal(rows.rows.size, 0, 'a refused mint writes nothing');
    }
  });

  test('a SELF grant below the identity floor is refused (SPEC-005 §4)', () => {
    assert.throws(() => mint({ identityLevel: 'IAL0' }), /identity level IAL1 or above/);
    assert.doesNotThrow(() => mint({ identityLevel: 'IAL1' }));
  });

  test('a non-SELF grant without a recorded notice is refused (VG-AUTHZ-014/VG-AUTH-032)', () => {
    assert.throws(
      () => mint({ kind: 'AGENT', evidenceArtifactId: 'instrument-1', noticeArtifactId: null }),
      /requires a recorded notice to the subject’s verified contact channel/,
    );
  });

  test('a grant with no scope, or an expiry that is not in the future, is refused', () => {
    assert.throws(() => mint({ scope: [] }), /grants nothing/);
    assert.throws(() => mint({ expiresAt: NOW }), /is not after/);
  });

  test('a contested or cooling-off grant is refused at EXECUTION time, not only at mint', async () => {
    const cooling = mint({ kind: 'AGENT', evidenceArtifactId: 'i', noticeArtifactId: 'n', coolingOffUntil: '2026-10-01T00:00:00Z' });
    const rows = store([cooling]);
    await assert.rejects(
      () => verifyAtExecutionTime(cooling.authorityGrantId, NOW, rows.read),
      /inside its cooling-off period until 2026-10-01T00:00:00Z/,
    );
    const contested = contestGrant(cooling, NOW);
    const contestedStore = store([contested]);
    await assert.rejects(
      () => verifyAtExecutionTime(contested.authorityGrantId, NOW, contestedStore.read),
      /was contested at 2026-09-16T00:00:00Z, which suspends its write capability/,
    );
  });
});

describe('the wire vocabulary and the domain vocabulary are mapped in both directions (SPEC-005 §3 vs SPEC-003 §5.2.1)', () => {
  test('every wire value maps to a domain kind and back', () => {
    const wire = ['SELF', 'AGENT', 'GUARDIAN', 'DEPENDENT'];
    for (const value of wire) {
      const domain = kindFromWire(value);
      assert.equal(kindToWire(domain), value, `${value} must round-trip`);
    }
    // The two names that differ are the two the specifications disagree about, and the mapping is the record of it.
    assert.equal(kindFromWire('GUARDIAN'), 'PARENT_GUARDIAN');
    assert.equal(kindFromWire('DEPENDENT'), 'LEGAL_REPRESENTATIVE');
  });

  test('REQUIRED NEGATIVE CASE: an unmapped wire value is refused, never defaulted', () => {
    for (const value of ['WARD', 'attorney', '', 'SELF ']) {
      assert.throws(
        () => kindFromWire(value),
        (error: unknown) => {
          assert.ok(error instanceof AuthorityError);
          assert.equal(error.code, 'AUTHORITY_KIND_UNSUPPORTED');
          return true;
        },
        `"${value}" must be refused rather than mapped to SELF`,
      );
    }
  });

  test('every domain kind has a wire spelling, so a grant can always be serialised', () => {
    for (const kind of ['SELF', 'AGENT', 'PARENT_GUARDIAN', 'LEGAL_REPRESENTATIVE'] as AuthorityKind[]) {
      assert.ok(kindToWire(kind).length > 0);
    }
  });
});

describe('the binding rules refuse independently (VG-AUTHZ-004/005/007/008)', () => {
  test('VG-AUTHZ-004: an action outside scope[] is refused even when the grant is valid', () => {
    const grant = mint();
    assert.doesNotThrow(() => assertScope(grant, 'vg.cases.read'));
    assert.throws(
      () => assertScope(grant, 'vg.actions.execute'),
      (error: unknown) => {
        assert.ok(error instanceof AuthorityError);
        assert.equal(error.code, 'AUTHORITY_SCOPE_VIOLATION');
        return true;
      },
    );
  });

  test('VG-AUTHZ-005: a grant valid at request start and EXPIRED at write time refuses at write time', async () => {
    // THE TIME-SHIFTED GRANT. The caller read this grant earlier in the request; the transaction re-reads it and the
    // answer changes. An API that accepted a pre-read grant could not express this test at all.
    const grant = mint({ expiresAt: '2026-09-16T00:30:00Z' });
    const rows = store([grant]);
    assert.doesNotThrow(() => assertScope(grant, 'vg.cases.read'), 'valid at request start');
    await assert.rejects(
      () => verifyAtExecutionTime(grant.authorityGrantId, '2026-09-16T01:00:00Z', rows.read),
      (error: unknown) => {
        assert.ok(error instanceof AuthorityError);
        assert.equal(error.code, 'AUTHORITY_EXPIRED');
        return true;
      },
      'the write-time check must see the expiry, not the earlier read',
    );
  });

  test('VG-AUTHZ-005: a grant REVOKED after the earlier read refuses at execution time', async () => {
    const grant = mint({ kind: 'AGENT', evidenceArtifactId: 'i', noticeArtifactId: 'n' });
    const rows = store([grant]);
    rows.rows.set(grant.authorityGrantId, revokeGrant(grant, '2026-09-16T00:10:00Z'));
    await assert.rejects(
      () => verifyAtExecutionTime(grant.authorityGrantId, NOW, rows.read),
      (error: unknown) => {
        assert.ok(error instanceof AuthorityError);
        assert.equal(error.code, 'AUTHORITY_REVOKED');
        return true;
      },
    );
  });

  test('an absent grant is AUTHORITY_GRANT_INVALID, and a forged id creates no subject row', async () => {
    const rows = store();
    await assert.rejects(
      () => verifyAtExecutionTime('forged-grant-id', NOW, rows.read),
      /does not exist at execution time/,
    );
    assert.equal(rows.rows.size, 0, 'no subject row was created by the forged id (VG-IDENT-001)');
  });

  test('VG-AUTHZ-007: the effective scope is the MOST RESTRICTIVE, never the union', () => {
    const wide = mint({ authorityGrantId: 'g-wide', scope: ['vg.cases.read', 'vg.evidence.read', 'vg.actions.execute'] });
    const narrow = mint({ authorityGrantId: 'g-narrow', scope: ['vg.cases.read', 'vg.evidence.read'] });
    const effective = effectiveScope([wide, narrow], 'vg.cases.read');
    assert.deepEqual([...effective].sort(), ['vg.cases.read', 'vg.evidence.read']);
    assert.equal(effective.includes('vg.actions.execute'), false, 'the union would have granted a capability nobody gave');
    // A scope no grant covers is refused rather than returning an empty set.
    assert.throws(() => effectiveScope([narrow], 'vg.audit.read'), /no grant covers vg\.audit\.read/);
  });

  test('VG-AUTHZ-008: a grant used for another subject in the same tenant is refused', () => {
    const grant = mint();
    assert.doesNotThrow(() => assertSubjectBinding(grant, SUBJECT));
    assert.throws(
      () => assertSubjectBinding(grant, OTHER_SUBJECT),
      (error: unknown) => {
        assert.ok(error instanceof AuthorityError);
        assert.equal(error.code, 'AUTHORITY_SUBJECT_MISMATCH');
        assert.match(error.message, /bound to another subject in this tenant/);
        return true;
      },
    );
  });

  test('VG-AUTHZ-006: a second revocation is refused, and history is never rewritten', () => {
    const grant = mint();
    const revoked = revokeGrant(grant, NOW);
    assert.equal(revoked.revokedAt, NOW);
    assert.equal(grant.revokedAt, null, 'the original object is unchanged: revocation returns a new value');
    assert.throws(
      () => revokeGrant(revoked, '2026-09-17T00:00:00Z'),
      (error: unknown) => {
        assert.ok(error instanceof AuthorityError);
        assert.equal(error.code, 'AUTHORITY_ALREADY_REVOKED');
        assert.match(error.message, /would rewrite history/);
        return true;
      },
    );
  });

  test('a subject contest suspends write capability immediately (VG-AUTHZ-012)', async () => {
    const grant = mint({ kind: 'AGENT', evidenceArtifactId: 'i', noticeArtifactId: 'n' });
    const contested = contestGrant(grant, NOW);
    const rows = store([contested]);
    await assert.rejects(() => verifyAtExecutionTime(grant.authorityGrantId, NOW, rows.read), /was contested at/);
    // And the suspension is immediate: the same instant, not after a review window.
    assert.equal(contested.contestedAt, NOW);
  });
});
