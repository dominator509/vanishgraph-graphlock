/**
 * LIVE-FIRE-PROOF-11 — Coverage honesty (VG-DISC-002, SPEC-000 §7, SPEC-003 §5.16.3; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE: THE REPORT STATES EXACTLY WHAT WAS CHECKED AND WHAT WAS NOT, EVERY PERCENTAGE CARRIES ITS
 * DENOMINATOR, AND NO PARTIAL SCAN BECOMES "THE ENTIRE INTERNET WAS SCANNED".
 *
 * WHAT THIS SUITE ASSERTS, AND A FIRST VERSION THAT ASSERTED NOTHING IS RECORDED RATHER THAN ERASED: my first attempt
 * computed ratios from objects it had built itself — `figure(0, 0)` and a locally-invented coverage block — which would
 * have passed on any tree, including one whose report dropped its denominator, because it tested arithmetic in the test
 * file rather than anything the product does. That is the false-green this node exists to remove, so it was replaced.
 * What remains asserts the product's OWN exports (the caveat list and the skip-reason vocabulary), and it points at the
 * suites that own the numeric rendering instead of restating it:
 *
 *   * `tests/contract/coverage-presentation.test.ts` — one coverage renderer, the required elements, and the rule that
 *     no unpaired percentage is rendered (EP-005 M4);
 *   * `tests/db/coverage-reports.test.ts` — the report and its bounds against real PostgreSQL (EP-003);
 *   * `src/application/contracts/coverage-queries.ts` — where `ratio: number | null` is documented as null when the
 *     denominator is zero, which is what makes "no confirmed match was eligible" distinguishable from "nothing was
 *     removed" for every adapter at once.
 *
 * The pointer is checked to exist, so it cannot rot silently; the numeric claims are left where they are proven.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { COVERAGE_SKIP_REASONS, EFFECTIVENESS_CAVEATS } from '../../src/application/contracts/coverage-queries.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('LIVE-FIRE-PROOF-11: coverage honesty is a property of the report, not of a summary line (VG-DISC-002)', () => {
  test('the effectiveness figure states its own caveats, and they are sentences rather than placeholders', () => {
    assert.ok(EFFECTIVENESS_CAVEATS.length > 0, 'a report with no caveats is a claim of completeness');
    for (const caveat of EFFECTIVENESS_CAVEATS) {
      assert.ok(caveat.trim().length > 20, `a caveat must say something a reader can act on: ${caveat}`);
    }
  });

  test('the skip reasons are a CLOSED vocabulary, and none of them is a synonym for a completed outcome', () => {
    // The defect this forbids: reporting a source as "VERIFIED_REMOVED" or "DELISTED" when it was never checked, which
    // turns a gap in coverage into a result.
    assert.ok(COVERAGE_SKIP_REASONS.length > 0, 'skipping a source must have a declared reason');
    assert.equal(new Set(COVERAGE_SKIP_REASONS).size, COVERAGE_SKIP_REASONS.length, 'the reasons are distinct');
    for (const reason of COVERAGE_SKIP_REASONS) {
      assert.notEqual(reason.trim(), '', 'an empty reason is not a reason');
      for (const outcome of ['REMOVED', 'DELISTED', 'VERIFIED_REMOVED', 'NOT_PRESENT_VERIFIED']) {
        assert.equal(
          reason === outcome,
          false,
          `${reason} would report a skipped source as an outcome rather than as a gap`,
        );
      }
    }
  });

  test('the denominator rule is stated IN THE CONTRACT, and the suites that render it exist', () => {
    // The rule lives in the type: `ratio: number | null`, documented as null when the denominator is zero. Asserted by
    // reading the contract text, which is where the rule is enforced for every adapter at once; the rendering is
    // asserted by the UI contract suite and the numbers by the database suite, both of which are checked to exist.
    const contract = readFileSync(resolve(ROOT, 'src/application/contracts/coverage-queries.ts'), 'utf8');
    assert.match(contract, /ratio: number \| null/, 'the ratio must be nullable, so an undefined rate is representable');
    assert.match(contract, /null` when the denominator is zero, never `0`/, 'and the rule must be documented where it lives');
    assert.match(contract, /denominatorDefinedAs/, 'the report must say what the denominator means');

    for (const suite of ['tests/contract/coverage-presentation.test.ts', 'tests/db/coverage-reports.test.ts']) {
      assert.equal(existsSync(resolve(ROOT, suite)), true, `${suite} must exist: it owns a numeric half of this outcome`);
    }
  });
});
