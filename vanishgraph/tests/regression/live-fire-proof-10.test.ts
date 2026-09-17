/**
 * LIVE-FIRE-PROOF-10 — Bug-to-draft-PR loop (VG-EGRESS-002, VG-SCOPE-009, SPEC-000 §8; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE: A SANITIZED CRASH EVENT IS DEDUPLICATED INTO A REPAIR CAPSULE AND CANNOT AUTO-MERGE OR
 * AUTO-DEPLOY WHEN IT TOUCHES PRIVACY, SECURITY, AUTHORIZATION, LEGAL POLICY, BILLING OR PRODUCTION DATA PATHS.
 *
 * THE SANITIZATION HALF IS PRODUCT BEHAVIOUR AND IS ASSERTED DIRECTLY: `createRepairCapsule` REFUSES apparent personal
 * data in any of the three free-text fields, so a capsule cannot leave the boundary carrying what it exists to remove.
 * The dedup key is also structural: `fingerprint` is required and NOT NULL in the table.
 *
 * THE AUTO-MERGE HALF IS AN ABSENCE IN THIS REPOSITORY, AND IT IS RECORDED AS ONE RATHER THAN PRESENTED AS A CONTROL —
 * MEASURED: `.github/workflows/` exists and is EMPTY, there is no `CODEOWNERS` at the root or under `.github/`, and the
 * plan's own file list names `.github/workflows/ci.yml` as a file to modify, which does not exist here. So "cannot
 * auto-merge or auto-deploy" is true vacuously: there is no pipeline to do either, and equally no protected-path
 * enforcement. That distinction is the honest content of this suite's second half, and the requirement it leaves
 * unenforced is named.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { createRepairCapsule } from '../../src/domain/entities.ts';
import { TenantId } from '../../src/domain/identifiers.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TENANT = new TenantId('11111111-1111-4111-8111-111111111111');

/** The refusal an operation produced, or `undefined` when it did not refuse. */
function refusalOf(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** A clean capsule, so each case can break exactly one thing. */
function capsule(overrides: Partial<Parameters<typeof createRepairCapsule>[0]> = {}): ReturnType<typeof createRepairCapsule> {
  return createRepairCapsule({
    id: 'capsule-1',
    tenantId: TENANT,
    fingerprint: 'fp-1',
    sanitizedEvidence: 'a stack trace with no personal data',
    expected: 'the caller expected a 200',
    actual: 'the caller received a 500',
    prRef: null,
    ...overrides,
  });
}

describe('LIVE-FIRE-PROOF-10: a crash capsule is sanitized and deduplicated before any change is proposed (VG-EGRESS-002)', () => {
  test('NEGATIVE CASE: apparent personal data in ANY of the three text fields is refused', () => {
    // The boundary this protects: a capsule is derived from a crash, and crashes carry whatever the request carried.
    for (const field of ['sanitizedEvidence', 'expected', 'actual'] as const) {
      const refusal = refusalOf(() => capsule({ [field]: 'contact alice@example.invalid about case 42' }));
      assert.ok(refusal instanceof Error, `${field} carrying an email address must be refused`);
      assert.match(refusal.message, /apparent personal data/);
      assert.match(refusal.message, /VG-EGRESS-002/, 'and the refusal must name the requirement');
    }
    assert.doesNotThrow(() => capsule(), 'while a clean capsule is accepted, so the refusal is about the content');
  });

  test('the sanitized text is what is STORED, and the raw event is not a field of the entity at all', () => {
    // A shape assertion with a purpose: there is no `raw`, `body` or `payload` field for a caller to populate, so the
    // unsanitized event cannot be carried through this type even by accident.
    const clean = capsule();
    assert.equal(clean.sanitizedEvidence.length > 0, true);
    const keys = Object.keys(clean);
    for (const forbidden of ['raw', 'body', 'payload', 'stack']) {
      assert.equal(keys.includes(forbidden), false, `a capsule must have no ${forbidden} field`);
    }
  });

  test('the FINGERPRINT is the dedup key and is required, and the table does NOT constrain it unique — recorded', () => {
    // MEASURED, and it is a limitation rather than a control: `repair_capsule.fingerprint` is `text NOT NULL` with no
    // UNIQUE constraint, so two capsules for one crash can both be stored and deduplication is the caller's lookup. The
    // suite records that instead of implying the database prevents the duplicate.
    assert.throws(() => capsule({ fingerprint: '' }), /fingerprint/, 'an empty fingerprint cannot identify a crash');
    const migration = readFileSync(resolve(ROOT, 'db/migrations/0005_evidence_audit_and_ops.sql'), 'utf8');
    assert.match(migration, /fingerprint\s+text NOT NULL/, 'the column is required');
    assert.equal(
      /fingerprint[^,]*UNIQUE|UNIQUE[^,]*fingerprint/i.test(migration),
      false,
      'and it is NOT unique, so dedup is a lookup rather than a constraint',
    );
  });

  test('NO AUTO-MERGE OR AUTO-DEPLOY PATH EXISTS HERE, asserted as an absence rather than presented as a control', () => {
    const workflows = resolve(ROOT, '.github/workflows');
    const files = existsSync(workflows) ? readdirSync(workflows) : [];
    assert.deepEqual(files, [], 'MEASURED: the workflows directory is empty, so no pipeline can merge or deploy anything');
    assert.equal(existsSync(resolve(ROOT, 'CODEOWNERS')), false, 'and there is no root CODEOWNERS');
    assert.equal(existsSync(resolve(ROOT, '.github/CODEOWNERS')), false, 'nor one under .github/');
    // The consequence, stated where a reader will find it: the protected-path rule is UNENFORCED BY MACHINE here.
    assert.equal(
      existsSync(resolve(ROOT, '.github/workflows/ci.yml')),
      false,
      'the plan names .github/workflows/ci.yml; it does not exist, which is why CI has never run',
    );
  });

  test('the prohibition on autonomous deployment is in the specification, read from the spec that owns it', () => {
    // The requirement the absent pipeline would otherwise enforce is asserted to EXIST in the spec, so the gap is a
    // missing implementation rather than a missing rule.
    const spec = readFileSync(resolve(ROOT, '.agent/specs/SPEC-000-product-scope.md'), 'utf8');
    assert.match(spec, /VG-SCOPE-009/, 'the scope prohibition must be declared');
    assert.match(spec, /production deployment/i, 'and it must be about deployment');
  });

  test('the durable capsule store is exercised in a suite that exists, and is not claimed here', () => {
    for (const suite of ['tests/db/audit-sink.test.ts', 'tests/security/negative-cases.test.ts']) {
      assert.equal(existsSync(resolve(ROOT, suite)), true, `${suite} must exist: it exercises the stored half`);
    }
  });
});
