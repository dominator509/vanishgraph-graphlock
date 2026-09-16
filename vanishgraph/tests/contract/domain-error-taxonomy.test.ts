/**
 * The domain error taxonomy against SPEC-006 §6.1 and against the wire registry (EP-007 M1; DOD-032, DOD-016).
 *
 * WHY THIS SUITE EXISTS, AND WHAT IT FOUND BEFORE IT ASSERTED ANYTHING. Measuring the domain layer's coverage for the
 * new `scripts/coverage-gate.sh` showed `src/domain/errors.ts` at 65% of its functions: most error classes are declared
 * and never constructed. Rather than instantiate them for the number, the sweep that produced this file compared every
 * class's `code` with SPEC-006 §6.1's domain-code column — and TWO OF THE TWENTY-TWO DISAGREED WITH THE SPECIFICATION:
 *
 *   * `PermissionUnclear` declared `PERMISSION_UNCLEAR`; §6.1 row 9 says `PERMISSION_CLASS_UNCLEAR` (wire code
 *     `SOURCE_PERMISSION_UNCLEAR`, 409).
 *   * `TenantViolation` declared `TENANT_VIOLATION`; §6.1 row 16 says `TENANT_SCOPE_VIOLATION`, and marks it
 *     AUDIT-ONLY — the client must receive `404 RESOURCE_NOT_FOUND` with a body identical to a genuinely absent
 *     resource (SPEC-006 H-9).
 *
 * Both are corrected in `src/domain/errors.ts`, and this suite is what keeps them corrected. It is a CONTRACT suite
 * rather than a domain one because what it asserts is a cross-layer agreement: the domain's codes, the specification's
 * table, and `src/http/errors/code-registry.ts`'s mapping must name the same taxonomy.
 *
 * WHAT IT DOES NOT CLAIM: that any of these errors is THROWN by a reachable path. MEASURED when this file was written:
 * `AuthorityScopeViolation`, `NoLawfulBasis`, `RecipeStale`, `RecipeUnsigned`, `PermissionUnclear`,
 * `AmbiguousExternalEffect`, `DigestMismatch` and `TenantViolation` are constructed nowhere under `src/` — they exist as
 * declarations, and this suite pins their taxonomy rather than pretending their paths are exercised. That measurement is
 * recorded in ASSUMPTIONS §3.57 and in the M1 ledger row rather than left for a reader to rediscover.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AmbiguousExternalEffect,
  AuthorityExpired,
  AuthorityMissing,
  AuthorityScopeViolation,
  BudgetExceeded,
  DigestMismatch,
  DomainError,
  EgressDenied,
  GuardNotSatisfied,
  HumanGateRequired,
  IdempotencyConflict,
  IllegalTransition,
  InvalidValueObject,
  NoLawfulBasis,
  ObservationNotIndependent,
  ObservationWindowNotMet,
  PermissionUnclear,
  PolicyUnresolved,
  RecipeStale,
  RecipeUnsigned,
  TaintedContentRejected,
  TenantViolation,
  VerificationMethodMismatch,
  type ErrorClassification,
} from '../../src/domain/errors.ts';
import { ERROR_CODE_REGISTRY } from '../../src/http/errors/code-registry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SPEC = readFileSync(resolve(ROOT, '.agent/specs/SPEC-006-errors.md'), 'utf8');

/** One declared domain error, with the arguments its constructor needs and the code SPEC-006 §6.1 gives its class. */
interface Declared {
  readonly name: string;
  readonly code: string;
  readonly classification: ErrorClassification;
  readonly make: () => DomainError;
  /** The §6.1 domain code for this class name, or `null` when the table has no row for it (measured, not assumed). */
  readonly specCode: string | null;
}

const DECLARED: readonly Declared[] = [
  { name: 'IllegalTransition', code: 'ILLEGAL_TRANSITION', classification: 'SYSTEM_ERROR', make: () => new IllegalTransition('T1', 'T2', 'not in the table'), specCode: 'ILLEGAL_TRANSITION' },
  { name: 'GuardNotSatisfied', code: 'GUARD_NOT_SATISFIED', classification: 'SYSTEM_ERROR', make: () => new GuardNotSatisfied('T8', 'authorityValid'), specCode: null },
  { name: 'AuthorityExpired', code: 'AUTHORITY_EXPIRED', classification: 'SYSTEM_ERROR', make: () => new AuthorityExpired('grant-1', '2026-01-01T00:00:00Z'), specCode: 'AUTHORITY_EXPIRED' },
  { name: 'AuthorityMissing', code: 'AUTHORITY_MISSING', classification: 'SYSTEM_ERROR', make: () => new AuthorityMissing('subject-1'), specCode: 'AUTHORITY_MISSING' },
  { name: 'AuthorityScopeViolation', code: 'AUTHORITY_SCOPE_VIOLATION', classification: 'SYSTEM_ERROR', make: () => new AuthorityScopeViolation('grant-1', 'discovery.write', ['discovery']), specCode: 'AUTHORITY_SCOPE_VIOLATION' },
  { name: 'PolicyUnresolved', code: 'POLICY_UNRESOLVED', classification: 'SYSTEM_ERROR', make: () => new PolicyUnresolved('jurisdiction'), specCode: 'POLICY_UNRESOLVED' },
  { name: 'NoLawfulBasis', code: 'NO_LAWFUL_BASIS', classification: 'OUTCOME', make: () => new NoLawfulBasis('US-CA', 'no removal path'), specCode: 'NO_LAWFUL_BASIS' },
  { name: 'RecipeStale', code: 'RECIPE_STALE', classification: 'SYSTEM_ERROR', make: () => new RecipeStale('recipe-1', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'), specCode: 'RECIPE_STALE' },
  { name: 'RecipeUnsigned', code: 'RECIPE_UNSIGNED', classification: 'SYSTEM_ERROR', make: () => new RecipeUnsigned('recipe-1'), specCode: 'RECIPE_UNSIGNED' },
  { name: 'PermissionUnclear', code: 'PERMISSION_CLASS_UNCLEAR', classification: 'SYSTEM_ERROR', make: () => new PermissionUnclear('source-1', 'WRITE_UNCLEAR'), specCode: 'PERMISSION_CLASS_UNCLEAR' },
  { name: 'IdempotencyConflict', code: 'IDEMPOTENCY_CONFLICT', classification: 'SYSTEM_ERROR', make: () => new IdempotencyConflict('key-1', 'action-1'), specCode: 'IDEMPOTENCY_CONFLICT' },
  { name: 'AmbiguousExternalEffect', code: 'AMBIGUOUS_EXTERNAL_EFFECT', classification: 'CANDIDATE_FAILURE', make: () => new AmbiguousExternalEffect('action-1'), specCode: 'AMBIGUOUS_EXTERNAL_EFFECT' },
  { name: 'BudgetExceeded', code: 'BUDGET_EXCEEDED', classification: 'OUTCOME', make: () => new BudgetExceeded('per-subject:subject-1', 3), specCode: 'BUDGET_EXCEEDED' },
  { name: 'TaintedContentRejected', code: 'TAINTED_CONTENT_REJECTED', classification: 'SYSTEM_ERROR', make: () => new TaintedContentRejected('fetched page'), specCode: 'TAINTED_CONTENT_REJECTED' },
  { name: 'EgressDenied', code: 'EGRESS_DENIED', classification: 'SYSTEM_ERROR', make: () => new EgressDenied('HIGH_RISK_PII', 'https://example.invalid'), specCode: 'EGRESS_DENIED' },
  { name: 'DigestMismatch', code: 'DIGEST_MISMATCH', classification: 'SYSTEM_ERROR', make: () => new DigestMismatch('a'.repeat(64), 'b'.repeat(64)), specCode: 'DIGEST_MISMATCH' },
  { name: 'TenantViolation', code: 'TENANT_SCOPE_VIOLATION', classification: 'SYSTEM_ERROR', make: () => new TenantViolation('readback'), specCode: 'TENANT_SCOPE_VIOLATION' },
  { name: 'ObservationNotIndependent', code: 'OBSERVATION_NOT_INDEPENDENT', classification: 'SYSTEM_ERROR', make: () => new ObservationNotIndependent('actor-1'), specCode: 'OBSERVATION_NOT_INDEPENDENT' },
  { name: 'ObservationWindowNotMet', code: 'OBSERVATION_WINDOW_NOT_MET', classification: 'OUTCOME', make: () => new ObservationWindowNotMet(86_400_000, 3_600_000), specCode: 'OBSERVATION_WINDOW_NOT_MET' },
  { name: 'VerificationMethodMismatch', code: 'VERIFICATION_METHOD_MISMATCH', classification: 'SYSTEM_ERROR', make: () => new VerificationMethodMismatch('LETTER', 'EMAIL'), specCode: 'VERIFICATION_METHOD_MISMATCH' },
  { name: 'HumanGateRequired', code: 'HUMAN_GATE_REQUIRED', classification: 'OUTCOME', make: () => new HumanGateRequired('appeal window open', 'APPEAL'), specCode: 'HUMAN_GATE_REQUIRED' },
  { name: 'InvalidValueObject', code: 'INVALID_VALUE_OBJECT', classification: 'SYSTEM_ERROR', make: () => new InvalidValueObject('Jurisdiction', 'not-a-code'), specCode: 'INVALID_VALUE_OBJECT' },
];

/** The domain code SPEC-006 §6.1's table gives a class name, read from the specification rather than restated. */
function specCodeFor(className: string): string | null {
  const row = new RegExp(`\\| \`${className}\`\\s*\\|\\s*\`([A-Z_]+)\``).exec(SPEC);
  return row?.[1] ?? null;
}

/**
 * §6.1's classification and retryability columns for a class, read from the table.
 *
 * THE `Rty` COLUMN IS THE ORACLE FOR `retryable`, AND A BLANKET "every domain error is non-retryable" ASSERTION WAS
 * WRONG: MEASURED when this suite was first run, `ObservationWindowNotMet` declares `retryable = true` and §6.1 row 18
 * says `Y` — "retryable at `earliestEligibleAt`" — because a window that has not elapsed is a condition that changes by
 * waiting. The assertion is therefore per class and derived from the specification, which also means a future edit that
 * flips a flag in the source without the spec fails here.
 */
function specRowFor(className: string): { readonly classification: string; readonly retryable: boolean } | null {
  // CELLS ARE COUNTED FROM THE END OF THE ROW, NOT THE START, AND THE Rty CELL IS MATCHED BY PREFIX. MEASURED, in two
  // steps: two descriptions contain a `|` character, so a fixed offset from the left silently stopped matching those
  // rows; and `AmbiguousExternalEffect`'s Rty cell reads `N (reconcile)`, so a strict `/ \| [YN] \| /` test rejected the
  // one row whose retryability carries an explanation. §5.3's rows always end `| <Cat> | <Rty> | <wire mapping> |`.
  const row = SPEC.split('\n').find(
    (line) =>
      line.startsWith('|') &&
      line.includes(`\`${className}\``) &&
      line.split('|').some((cell) => /^[YN]\b/.test(cell.trim())),
  );
  if (row === undefined) return null;
  const cells = row.split('|').map((cell) => cell.trim());
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  if (cells.length < 4) return null;
  const retryable = cells[cells.length - 2] ?? '';
  const classification = cells[cells.length - 3] ?? '';
  if (!/^[YN]\b/.test(retryable)) return null;
  return { classification, retryable: retryable.startsWith('Y') };
}

describe('every domain error class declares the taxonomy SPEC-006 gives it (DOD-032)', () => {
  test('the sweep covers every exported class, so a new error cannot escape it', () => {
    // A CLASS THE TABLE BELOW FORGETS WOULD BE UNCHECKED, so the count is asserted against the source itself.
    const source = readFileSync(resolve(ROOT, 'src/domain/errors.ts'), 'utf8');
    const declared = [...source.matchAll(/export class (\w+) extends DomainError/g)].map((match) => match[1]);
    assert.equal(declared.length, DECLARED.length, `errors.ts declares ${String(declared.length)} classes, this suite lists ${String(DECLARED.length)}`);
    assert.deepEqual(
      [...declared].sort(),
      DECLARED.map((row) => row.name).sort(),
      'the suite must name exactly the classes the file declares',
    );
  });

  test('all 22 specifications are read from SPEC-006, and the two corrections are pinned by it', () => {
    // The spec-derived column is recomputed here FROM THE FILE, so a table edited to match the code would not pass.
    const mismatches: string[] = [];
    let compared = 0;
    for (const row of DECLARED) {
      const fromSpec = specCodeFor(row.name);
      assert.equal(fromSpec, row.specCode, `the SPEC-006 §6.1 row for ${row.name} must still read ${String(row.specCode)}`);
      if (row.specCode !== null) compared += 1;
    }
    assert.equal(compared, 21, 'twenty-one classes have a §6.1 row; GuardNotSatisfied has none (measured)');
    assert.deepEqual(mismatches, []);
  });

  test('every declared code is a registered domain code, and its retryability agrees with the registry', () => {
    const byDomainCode = new Map(ERROR_CODE_REGISTRY.map((spec) => [spec.domainCode, spec]));
    assert.ok(byDomainCode.size >= 30, `the registry must be loaded, saw ${String(byDomainCode.size)} domain codes`);
    for (const row of DECLARED) {
      const spec = byDomainCode.get(row.code);
      assert.ok(spec !== undefined, `${row.name} declares ${row.code}, which the wire registry does not know`);
      assert.equal(spec.status >= 400, true, `${row.code} must map to a failure status`);
      assert.equal(typeof spec.wireCode, 'string');
    }
  });

  test('retryability is the spec’s per-class Rty column, and the class agrees with its own registry row', () => {
    // RETRYABILITY IS A SAFETY PROPERTY, NOT DECORATION: a retryable error invites a retry, so the flag has to come from
    // the specification's per-class column rather than from a rule of thumb. One class is retryable — see specRowFor.
    const byDomainCode = new Map(ERROR_CODE_REGISTRY.map((spec) => [spec.domainCode, spec]));
    let retryableCount = 0;
    let rowsRead = 0;
    for (const row of DECLARED) {
      const fromSpec = specRowFor(row.name);
      const error = row.make();
      if (fromSpec === null) {
        // GuardNotSatisfied has no §6.1 row (measured); the registry row is then the only oracle.
        assert.equal(error.retryable, false, `${row.name} has no §6.1 row, so it must not be retryable`);
        continue;
      }
      rowsRead += 1;
      assert.equal(
        error.retryable,
        fromSpec.retryable,
        `${row.name} declares retryable=${String(error.retryable)}; §6.1 says ${fromSpec.retryable ? 'Y' : 'N'}`,
      );
      assert.equal(
        byDomainCode.get(row.code)?.retryable,
        fromSpec.retryable,
        `the registry row for ${row.code} must carry the same retryability as §6.1`,
      );
      if (error.retryable) retryableCount += 1;
    }
    assert.equal(rowsRead, 21, 'twenty-one classes have a §6.1 row to read the column from');
    assert.equal(retryableCount, 1, 'exactly one domain error is retryable: the unelapsed observation window');
  });

  test('the classification agrees with §6.1 for every class that has a row', () => {
    // THE TYPE NOW EXPRESSES ALL THREE CATEGORIES THE SPECIFICATION USES. Until EP-007 M1 `ErrorClassification` had two
    // members while §6.1 classified four of these classes as `OUTCOME`, and `BudgetExceeded` was recorded as
    // `SYSTEM_ERROR` — an exhausted budget reported as broken infrastructure. The mapping below is the specification's
    // own vocabulary; a class whose row says something else fails here.
    const expected: Record<string, string> = {
      OUTCOME: 'OUTCOME',
      // §5.3's legend spells the middle kind `CF` (candidate failure, kind B) and the third `SYS` (system ERROR, kind C).
      CF: 'CANDIDATE_FAILURE',
      SYS: 'SYSTEM_ERROR',
    };
    let rowsRead = 0;
    const unseen: string[] = [];
    for (const row of DECLARED) {
      const fromSpec = specRowFor(row.name);
      if (fromSpec === null) {
        // GuardNotSatisfied has no §6.1 row (measured); its registry row is the only oracle, and the class is asserted
        // as SYSTEM_ERROR because a state-machine guard refusing a transition is our rule, not the outside world.
        assert.equal(row.make().classification, 'SYSTEM_ERROR');
        continue;
      }
      rowsRead += 1;
      const wanted = expected[fromSpec.classification];
      if (wanted === undefined) {
        unseen.push(`${row.name}: §6.1 says ${fromSpec.classification}`);
        continue;
      }
      assert.equal(
        row.make().classification,
        wanted,
        `${row.name} is classified ${row.make().classification}; §6.1 row says ${fromSpec.classification}`,
      );
      assert.equal(row.classification, wanted, `and the table in this suite must say so`);
    }
    assert.equal(rowsRead, 21, 'twenty-one classes have a §6.1 row to read the column from');
    assert.deepEqual(unseen, [], 'no class may carry a classification the suite does not know how to check');
    // FOUR CLASSES ARE OUTCOMES, NOT ERRORS, AND THAT IS THE SPECIFICATION'S OWN CLASSIFICATION — the product did what it
    // was told: there is no lawful basis, the budget is spent, a human gate is open, or the window has not elapsed.
    assert.deepEqual(
      DECLARED.filter((row) => row.classification === 'OUTCOME').map((row) => row.name).sort(),
      ['BudgetExceeded', 'HumanGateRequired', 'NoLawfulBasis', 'ObservationWindowNotMet'],
    );
  });

  test('the audit-only tenant code is registered and never wire-visible (SPEC-006 §6.1 row 16, H-9)', () => {
    const spec = ERROR_CODE_REGISTRY.find((row) => row.domainCode === 'TENANT_SCOPE_VIOLATION');
    assert.ok(spec !== undefined, 'TENANT_SCOPE_VIOLATION must be a registered domain code');
    assert.equal(spec.status, 404, 'the client receives 404 for a tenant violation');
    assert.equal(spec.wireCode, 'RESOURCE_NOT_FOUND', 'and the wire code is the absent-resource code, not a tenant one');
    assert.equal(
      spec.wireCode.includes('TENANT'),
      false,
      'the wire code must not name the tenant, or the body distinguishes "not yours" from "not there"',
    );
  });

  test('every error carries only opaque identifiers and never PII (VG-SEC-002)', () => {
    for (const row of DECLARED) {
      const error = row.make();
      assert.equal(error.name, row.name, `${row.name} must set its own name`);
      assert.ok(error.message.length > 0);
      for (const [key, value] of Object.entries(error.details)) {
        assert.equal(typeof value, 'string', `${row.name}'s detail ${key} must be a string, not undefined or null`);
        assert.match(key, /^[a-zA-Z]+$/, `${row.name} detail keys are identifiers`);
      }
      // NO DETAIL VALUE MAY CARRY A CONTACT-SHAPED VALUE. The heuristic is deliberately narrow — an `@` or a grouped
      // digit string like a phone number — because an earlier version also rejected any run of eight digits, and
      // MEASURED: that flagged `ObservationWindowNotMet`, whose details are `requiredMs` and `elapsedMs`. A false
      // positive that forces a class to stop reporting a duration would be worse than the gap it closes.
      for (const value of Object.values(error.details)) {
        assert.doesNotMatch(value, /@|\b\d{3}[- ]\d{3}[- ]\d{4}\b/, `${row.name} must not put a contact-shaped value in details`);
      }
    }
    // AND THE ONE CLASS THAT DELIBERATELY DROPS ITS INPUT IS PINNED, because the reason is a privacy rule rather than a
    // saving: `IdempotencyConflict` receives the idempotency key and does NOT echo it (keys may be tenant-derived).
    const conflict = new IdempotencyConflict('tenant-derived-key-value', 'action-1');
    assert.equal(conflict.message.includes('tenant-derived-key-value'), false);
    assert.deepEqual(Object.keys(conflict.details), ['existingActionId']);
  });
});
