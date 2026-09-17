/**
 * LIVE-FIRE-PROOF-12 — Enterprise authorization (VG-IDENT-001, VG-TENANT-002, SPEC-000 §5; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE: A `ProtectedSubject` IS ENROLLED ONLY THROUGH AN EXPLICIT `AuthorityGrant` OR DOCUMENTED
 * LAWFUL AUTHORITY, AND ONE TENANT CANNOT REACH ANOTHER'S EVIDENCE.
 *
 * THREE OF ITS FOUR HALVES ARE PROVEN ELSEWHERE AND THIS SUITE POINTS AT THEM INSTEAD OF RESTATING THEM:
 *   * the enrolment constraint is a DEFERRED TRIGGER in `db/migrations/0002_identity.sql` and is proven against real
 *     PostgreSQL in `tests/db/subject-commands.test.ts`;
 *   * the two-layer tenant denial is proven in `tests/integration/cross-tenant-both-layers.test.ts` and
 *     `tests/integration/authority-at-execution.test.ts`.
 * Both are read here — the migration TEXT is asserted to carry the constraint, and the suites are asserted to exist — so
 * the pointers cannot rot while no database property is claimed from a unit suite.
 *
 * THE FOURTH HALF IS ASSERTED DIRECTLY because it is pure domain: an EXPIRED grant and an INSUFFICIENT grant are refused
 * by the real factory, which is the same rule that keeps a forged grant from enrolling anyone.
 *
 * AND THE HUMAN SIGN-OFF IS LEFT WHERE IT BELONGS: this outcome carries an enterprise sign-off that stays
 * `EXTERNAL_REQUIRED`. That is asserted by reading the accounting, so a future edit cannot quietly promote it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AuthorityError, mintGrant } from '../../src/application/security/authority-service.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

const TENANT = '11111111-1111-4111-8111-111111111111';
const SUBJECT = 'subject-opaque-1';
const NOW = '2026-09-16T00:00:00Z';
const LATER = '2026-09-17T00:00:00Z';

/** The refusal an operation produced, or `undefined` when it did not refuse. */
function refusalOf(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** A well-formed enrolment request, so each case can break exactly one thing. */
function enrolment(overrides: Partial<Parameters<typeof mintGrant>[0]> = {}): ReturnType<typeof mintGrant> {
  return mintGrant({
    tenantId: TENANT,
    subjectRef: SUBJECT,
    kind: 'SELF',
    scope: ['discovery'],
    now: NOW,
    identityLevel: 'IAL2',
    evidenceArtifactId: null,
    noticeArtifactId: null,
    coolingOffUntil: null,
    authorityGrantId: 'grant-1',
    expiresAt: LATER,
    ...overrides,
  });
}

describe('LIVE-FIRE-PROOF-12: enrolment needs an explicit grant, and the human gate stays open (VG-IDENT-001)', () => {
  test('NEGATIVE CASE: an EXPIRED grant cannot enrol anyone, and no grant object is produced', () => {
    const refusal = refusalOf(() => enrolment({ expiresAt: NOW }));
    assert.ok(refusal instanceof AuthorityError, `expected an AuthorityError, got: ${String(refusal)}`);
    assert.equal(refusal.code, 'AUTHORITY_GRANT_INVALID');
    assert.match(refusal.message, /is not after/, 'the refusal must name the window, not merely fail');
  });

  test('NEGATIVE CASE: an AGENT enrolment with NO instrument is refused, which is the forged-grant shape', () => {
    // `mintGrant` is the only way a grant is built here, so a grant without the evidence its kind requires cannot exist
    // to be stored — which is what makes "no subject row created" true by construction rather than by a check later.
    const refusal = refusalOf(() => enrolment({ kind: 'AGENT', evidenceArtifactId: null, noticeArtifactId: 'notice-1' }));
    assert.ok(refusal instanceof AuthorityError);
    assert.equal(refusal.code, 'AUTHORITY_EVIDENCE_REQUIRED');
  });

  test('the ENROLMENT CONSTRAINT is in the migration that owns it, read from the migration text', () => {
    // A unit suite cannot prove a deferred trigger fires; it CAN assert that the constraint exists in the artifact that
    // creates it, and that the database suite which proves it is present.
    const migration = readFileSync(resolve(ROOT, 'db/migrations/0002_identity.sql'), 'utf8');
    assert.match(migration, /VG-IDENT-001/, 'the migration must name the requirement it enforces');
    assert.match(migration, /DEFERRED|deferred/, 'the constraint must be deferred, so subject and grant may be written together');
    assert.match(migration, /TRIGGER|FUNCTION/i, 'and it must be enforced by a trigger rather than by convention');
    assert.equal(
      existsSync(resolve(ROOT, 'tests/db/subject-commands.test.ts')),
      true,
      'the suite that proves it against PostgreSQL must exist',
    );
  });

  test('the TWO-LAYER tenant denial is proven by suites that exist, and is not claimed here', () => {
    for (const suite of [
      'tests/integration/cross-tenant-both-layers.test.ts',
      'tests/integration/authority-at-execution.test.ts',
    ]) {
      assert.equal(existsSync(resolve(ROOT, suite)), true, `${suite} must exist: it is where the second layer is proven`);
    }
  });

  test('NEGATIVE CASE: the enterprise human sign-off is EXTERNAL_REQUIRED in the accounting, not implied away', () => {
    // The outcome carries a human gate; this asserts the ACCOUNTING says so, so a later edit cannot promote it to PASS
    // by narrative. Both rows are read from the ledger rather than restated.
    const ledgerPath = resolve(ROOT, '.agent/verification/state/TEST_LEDGER.jsonl');
    assert.equal(existsSync(ledgerPath), true, 'the accounting must exist');
    const rows = readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { test_id?: string; status?: string });
    for (const id of ['EP-006/counsel-review', 'EP-006/human-uat-accessibility']) {
      const row = rows.find((candidate) => candidate.test_id === id);
      assert.ok(row !== undefined, `${id} must be accounted`);
      assert.equal(row.status, 'EXTERNAL_REQUIRED', `${id} must remain EXTERNAL_REQUIRED until a human signs it`);
    }
  });
});
