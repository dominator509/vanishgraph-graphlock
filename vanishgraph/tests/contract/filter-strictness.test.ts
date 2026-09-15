/**
 * Query strictness (SPEC-003 §2.5, §2.6).
 *
 * The rule under test: **an unknown or malformed query parameter is REFUSED, never ignored.** SPEC-003
 * §2.6 gives the reason in one clause — "so that a typo cannot silently widen a result set".
 *
 * Every case below therefore asserts three things, not one:
 *
 *   1. the correct WIRE CODE (not merely "an error"),
 *   2. that NO rows were returned,
 *   3. that `details.field` names the offending parameter so a caller can fix it.
 *
 * The distinction between the four codes is the substance of the suite. `?limitt=5` silently ignored
 * would return the default 25 rows and look like a success; `?truthState=DONE` silently ignored would
 * return unfiltered exposures and look like a successful search for removed data. Both are silent
 * wrong answers, and both are worse than a 400.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TIME_RANGE_DAYS,
  MAX_FILTER_VALUES,
  QueryError,
  parseQuery,
  type QuerySchema,
} from '../../src/http/query/strict.ts';
import {
  AUDIT_EVENTS_QUERY,
  CASES_QUERY,
  DISCOVERY_RUNS_QUERY,
  EXPOSURES_QUERY,
  SUBJECTS_QUERY,
} from '../../src/http/query/filters.ts';
import { ALL_TRUTH_STATES } from '../../src/application/contracts/index.ts';

/**
 * A one-day range, for assertions about something OTHER than the range itself.
 *
 * `AUDIT_EVENTS_QUERY` requires `from` and `to` (SPEC-003 §5.15.1 refuses an unbounded audit scan) and caps
 * the span at 90 days, so every assertion about an audit-route filter, sort or ceiling must carry a valid
 * range or it fails for a reason the test is not about. One day keeps it inside the cap.
 */
const RANGE = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' } as const;

/** Run a parse and return the error code, or a marker when it unexpectedly succeeded. */
function codeOf(raw: Record<string, unknown>, schema: QuerySchema, now = 1_770_000_000_000): string {
  try {
    parseQuery(raw, schema, () => now);
    return 'NO_ERROR';
  } catch (error) {
    if (error instanceof QueryError) return error.code;
    throw error;
  }
}

/** Run a parse and return the details, for the assertions about `details.field`. */
function detailsOf(raw: Record<string, unknown>, schema: QuerySchema): Record<string, unknown> | undefined {
  try {
    parseQuery(raw, schema, () => 1_770_000_000_000);
    return undefined;
  } catch (error) {
    if (error instanceof QueryError) return error.details;
    throw error;
  }
}

describe('an unknown parameter is refused, never ignored (SPEC-003 §2.6)', () => {
  test('?limitt=5 is UNKNOWN_QUERY_PARAMETER, not a silently applied default', () => {
    // The typo case the rule exists for: ignoring it returns 25 rows and looks like a success.
    assert.equal(codeOf({ limitt: '5' }, SUBJECTS_QUERY), 'UNKNOWN_QUERY_PARAMETER');
    assert.deepEqual(detailsOf({ limitt: '5' }, SUBJECTS_QUERY), { field: 'limitt' });
  });

  test('a near-miss on every real parameter is refused', () => {
    const typos = ['limitt', 'Limits', 'limit_', 'cursorr', 'Sort', 'truth_state', 'jurisdictionn'];
    for (const typo of typos) {
      assert.equal(
        codeOf({ [typo]: 'x' }, SUBJECTS_QUERY),
        'UNKNOWN_QUERY_PARAMETER',
        `${typo} must be refused`,
      );
    }
  });

  test('a parameter valid on ANOTHER route is refused here', () => {
    // `truthState` is legitimate on exposures and NOT on subjects: a subject has an authority state,
    // not a truth state. Accepting it would let a caller believe they filtered when they did not.
    assert.equal(codeOf({ truthState: 'VERIFIED_REMOVED' }, SUBJECTS_QUERY), 'UNKNOWN_QUERY_PARAMETER');
    assert.equal(codeOf({ jurisdiction: 'US-CA' }, AUDIT_EVENTS_QUERY), 'UNKNOWN_QUERY_PARAMETER');
    assert.equal(codeOf({ authorityState: 'VALID' }, EXPOSURES_QUERY), 'UNKNOWN_QUERY_PARAMETER');
    assert.equal(codeOf({ actor: 'op-1' }, SUBJECTS_QUERY), 'UNKNOWN_QUERY_PARAMETER');
  });

  test('offset is refused as an unknown parameter on every collection route', () => {
    // There is no offset parameter on any route (SPEC-003 §2.5). Refusing it rather than ignoring it
    // is what stops a client from believing it paginated correctly.
    for (const schema of [SUBJECTS_QUERY, EXPOSURES_QUERY, CASES_QUERY, AUDIT_EVENTS_QUERY]) {
      assert.equal(codeOf({ offset: '10' }, schema), 'UNKNOWN_QUERY_PARAMETER');
      assert.equal(codeOf({ offset: '0', limit: '5' }, schema), 'UNKNOWN_QUERY_PARAMETER');
    }
  });
});

describe('truthState filtering accepts only the eleven canonical tokens (§2.6)', () => {
  test('every canonical token is accepted', () => {
    assert.equal(ALL_TRUTH_STATES.length, 11, 'the vocabulary must have eleven states');
    for (const state of ALL_TRUTH_STATES) {
      assert.equal(codeOf({ truthState: state }, EXPOSURES_QUERY), 'NO_ERROR', `${state} must be accepted`);
    }
  });

  test('?truthState=DONE is INVALID_TRUTH_STATE — the case the plan names', () => {
    // `DONE` is not one of the eleven (SPEC-000 §5). Silently ignoring it would return unfiltered
    // exposures, which reads as "here are the removed ones" and is false.
    assert.equal(codeOf({ truthState: 'DONE' }, EXPOSURES_QUERY), 'INVALID_TRUTH_STATE');
    assert.deepEqual(detailsOf({ truthState: 'DONE' }, EXPOSURES_QUERY), { field: 'DONE' });
  });

  test('an ad-hoc status word is refused, not coerced', () => {
    for (const bad of ['removed', 'REMOVED', 'deleted', 'SUCCESS', 'COMPLETE', 'NONE', '']) {
      assert.equal(
        codeOf({ truthState: bad }, EXPOSURES_QUERY),
        'INVALID_TRUTH_STATE',
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  test('a list mixing valid and invalid tokens is refused as a whole', () => {
    // A partially applied filter is the worst outcome: the caller believes all four values filtered.
    assert.equal(
      codeOf({ truthState: 'VERIFIED_REMOVED,DONE' }, EXPOSURES_QUERY),
      'INVALID_TRUTH_STATE',
    );
  });

  test('a comma-separated list of valid tokens is accepted', () => {
    const parsed = parseQuery({ truthState: 'VERIFIED_REMOVED,NOT_REMOVABLE' }, EXPOSURES_QUERY);
    assert.deepEqual(parsed.filter['truthState'], ['VERIFIED_REMOVED', 'NOT_REMOVABLE']);
  });

  test('a single valid token is normalised to a string, not a one-element array', () => {
    // Normalisation matters beyond tidiness: the cursor binds to a hash of this object, so two
    // spellings of the same filter must normalise identically or a cursor rejects its continuation.
    const parsed = parseQuery({ truthState: 'VERIFIED_REMOVED' }, EXPOSURES_QUERY);
    assert.equal(parsed.filter['truthState'], 'VERIFIED_REMOVED');
  });
});

describe('sorting is restricted to the route allowlist (§2.6)', () => {
  test('?sort=identifierValue:asc is INVALID_SORT_FIELD — the case the plan names', () => {
    // A raw identifier value is PII and is neither a sort field nor a free-text match input.
    assert.equal(codeOf({ sort: 'identifierValue:asc' }, SUBJECTS_QUERY), 'INVALID_SORT_FIELD');
  });

  test('every documented sort field is accepted in both directions', () => {
    for (const schema of [SUBJECTS_QUERY, EXPOSURES_QUERY, CASES_QUERY, AUDIT_EVENTS_QUERY]) {
      // The range is added ONLY for a time-filterable schema. `AUDIT_EVENTS_QUERY` REQUIRES one (§5.15.1) and
      // this sweep is about sort fields rather than about the range — but the schemas that are NOT
      // time-filterable REFUSE `from`/`to` as unknown parameters, so an unconditional range turns this sweep
      // into a test of parameter rejection. Conditional on the declaration, one loop serves every schema.
      const range = schema.timeFilterable ? RANGE : {};
      for (const field of schema.sortFields) {
        for (const direction of ['asc', 'desc']) {
          assert.equal(
            codeOf({ ...range, sort: `${field}:${direction}` }, schema),
            'NO_ERROR',
            `${field}:${direction} must be accepted`,
          );
        }
      }
    }
  });

  test('a field without a direction is refused rather than defaulted', () => {
    // Guessing the direction is how a client receives rows in an order it did not ask for.
    assert.equal(codeOf({ sort: 'createdAt' }, SUBJECTS_QUERY), 'INVALID_SORT_FIELD');
    assert.equal(codeOf({ sort: 'createdAt:' }, SUBJECTS_QUERY), 'INVALID_SORT_FIELD');
    assert.equal(codeOf({ sort: ':asc' }, SUBJECTS_QUERY), 'INVALID_SORT_FIELD');
  });

  test('an unknown direction is refused', () => {
    assert.equal(codeOf({ sort: 'createdAt:ascending' }, SUBJECTS_QUERY), 'INVALID_SORT_FIELD');
    assert.equal(codeOf({ sort: 'createdAt:ASC' }, SUBJECTS_QUERY), 'INVALID_SORT_FIELD');
    assert.equal(codeOf({ sort: 'createdAt:1' }, SUBJECTS_QUERY), 'INVALID_SORT_FIELD');
  });

  test('a PII-shaped or navigation-shaped field name is refused', () => {
    for (const bad of ['email:asc', 'aliasValue:asc', 'subjectId:asc', 'rawValue:desc', 'hit:asc']) {
      assert.equal(codeOf({ sort: bad }, SUBJECTS_QUERY), 'INVALID_SORT_FIELD', `${bad} must be refused`);
    }
  });

  test('the applied default sort is echoed back', () => {
    const parsed = parseQuery({}, SUBJECTS_QUERY);
    assert.equal(parsed.sort, 'createdAt:desc');
    const audit = parseQuery(RANGE, AUDIT_EVENTS_QUERY);
    assert.equal(audit.sort, 'at:desc');
  });
});

describe('a filter exceeding the value ceiling is FILTER_TOO_BROAD (§2.6)', () => {
  test('21 values in one parameter is refused — the case the plan names', () => {
    const twentyOne = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => `action-${i}`).join(',');
    assert.equal(codeOf({ ...RANGE, action: twentyOne }, AUDIT_EVENTS_QUERY), 'FILTER_TOO_BROAD');
  });

  test('exactly 20 values is accepted: the ceiling is inclusive', () => {
    const twenty = Array.from({ length: MAX_FILTER_VALUES }, (_, i) => `action-${i}`).join(',');
    assert.equal(codeOf({ ...RANGE, action: twenty }, AUDIT_EVENTS_QUERY), 'NO_ERROR');
  });

  test('the ceiling applies to truthState too', () => {
    // The eleven-state vocabulary cannot exceed 20, so a longer list contains repeats — but the
    // refusal must still come from the ceiling rather than from a token check, or a caller learns
    // the wrong thing about why their query failed.
    const many = Array.from({ length: MAX_FILTER_VALUES + 1 }, () => 'VERIFIED_REMOVED').join(',');
    assert.equal(codeOf({ truthState: many }, EXPOSURES_QUERY), 'FILTER_TOO_BROAD');
  });
});

describe('limit obeys the 1–100 range and is never silently clamped (§2.5)', () => {
  test('the default is 25 and the boundaries are accepted', () => {
    assert.equal(parseQuery({}, SUBJECTS_QUERY).limit, 25);
    assert.equal(parseQuery({ limit: '1' }, SUBJECTS_QUERY).limit, 1);
    assert.equal(parseQuery({ limit: '100' }, SUBJECTS_QUERY).limit, 100);
  });

  test('0, 101, negative, fractional and non-numeric limits are refused', () => {
    for (const bad of ['0', '101', '-1', '1.5', 'ten', '', '1e3', ' 5', '+5', '0x10']) {
      assert.equal(
        codeOf({ limit: bad }, SUBJECTS_QUERY),
        'SCHEMA_VALIDATION_FAILED',
        `limit=${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  test('an out-of-range limit is REFUSED rather than clamped', () => {
    // Clamping would let a caller believe it received 1000 rows when it received 100.
    assert.notEqual(codeOf({ limit: '1000' }, SUBJECTS_QUERY), 'NO_ERROR');
  });
});

describe('time ranges follow inclusive-lower / exclusive-upper (§2.6)', () => {
  const NOW = Date.parse('2026-09-14T12:00:00.000Z');

  test('a missing range defaults to 30 days AND echoes the applied default', () => {
    // The echo is what stops an accidental wide scan presenting itself as a narrow one.
    // The vehicle is the route that still DEFAULTS a missing range. `AUDIT_EVENTS_QUERY` no longer does:
    // §5.15.1 makes `from` and `to` mandatory there, and `TIME_RANGE_REQUIRED` is asserted separately below.
    const parsed = parseQuery({}, DISCOVERY_RUNS_QUERY, () => NOW);
    assert.equal(parsed.filter['appliedDefaultTimeRangeDays'], DEFAULT_TIME_RANGE_DAYS);
    const to = Date.parse(String(parsed.filter['to']));
    const from = Date.parse(String(parsed.filter['from']));
    assert.equal(to, NOW);
    assert.equal(to - from, DEFAULT_TIME_RANGE_DAYS * 24 * 60 * 60 * 1000);
  });

  test('an explicit range is echoed without the default marker', () => {
    const parsed = parseQuery(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' },
      AUDIT_EVENTS_QUERY,
      () => NOW,
    );
    assert.equal(parsed.filter['appliedDefaultTimeRangeDays'], undefined);
    assert.equal(parsed.filter['from'], '2026-01-01T00:00:00.000Z');
    assert.equal(parsed.filter['to'], '2026-02-01T00:00:00.000Z');
  });

  test('a half-supplied range still marks that a default was applied', () => {
    const parsed = parseQuery({ from: '2026-09-01T00:00:00.000Z' }, DISCOVERY_RUNS_QUERY, () => NOW);
    assert.equal(parsed.filter['appliedDefaultTimeRangeDays'], DEFAULT_TIME_RANGE_DAYS);
    assert.equal(parsed.filter['to'], new Date(NOW).toISOString());
  });

  test('a range that is empty or inverted is refused', () => {
    // An empty range and a typo are indistinguishable to a caller otherwise.
    assert.equal(
      codeOf({ from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }, AUDIT_EVENTS_QUERY),
      'SCHEMA_VALIDATION_FAILED',
    );
    assert.equal(
      codeOf({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }, AUDIT_EVENTS_QUERY),
      'SCHEMA_VALIDATION_FAILED',
    );
  });

  test('a malformed timestamp is refused', () => {
    for (const bad of ['yesterday', '2026-13-45', '', '1700000000']) {
      // On the DEFAULTING route, where a bad `from` is the only thing wrong with the query.
      assert.equal(
        codeOf({ from: bad }, DISCOVERY_RUNS_QUERY),
        'SCHEMA_VALIDATION_FAILED',
        `from=${JSON.stringify(bad)} must be refused`,
      );
      // And on the audit route WITH a valid upper bound, so the refusal is about the malformed instant rather
      // than about the missing range, which would otherwise be reported first.
      assert.equal(
        codeOf({ from: bad, to: '2026-08-02T00:00:00.000Z' }, AUDIT_EVENTS_QUERY),
        'SCHEMA_VALIDATION_FAILED',
        `from=${JSON.stringify(bad)} must be refused on the audit route too`,
      );
    }
  });

  test('§5.15.1: an unbounded audit scan is 400 TIME_RANGE_REQUIRED', () => {
    // Two registry rows existed for this code and for `TIME_RANGE_TOO_WIDE`, and NO code path threw either,
    // until the audit route declared the requirement and the cap on its query schema. Asserted on the RAW
    // query, so the refusal cannot be masked by the 30-day default the parser applies elsewhere.
    assert.equal(codeOf({}, AUDIT_EVENTS_QUERY), 'TIME_RANGE_REQUIRED');
    assert.equal(codeOf({ from: '2026-08-01T00:00:00.000Z' }, AUDIT_EVENTS_QUERY), 'TIME_RANGE_REQUIRED');
    assert.equal(codeOf({ to: '2026-08-02T00:00:00.000Z' }, AUDIT_EVENTS_QUERY), 'TIME_RANGE_REQUIRED');
    // The control: the route that does NOT require a range still accepts an unbounded query, so the assertion
    // above is about this route's declaration rather than about the parser refusing ranges in general.
    assert.equal(codeOf({}, DISCOVERY_RUNS_QUERY), 'NO_ERROR');
  });

  test('§5.15.1: a span beyond 90 days is 400 TIME_RANGE_TOO_WIDE, and exactly 90 is accepted', () => {
    const day = 24 * 60 * 60 * 1000;
    const to = Date.parse('2026-09-14T12:00:00.000Z');
    const span = (days: number): Record<string, unknown> => ({
      from: new Date(to - days * day).toISOString(),
      to: new Date(to).toISOString(),
    });

    // The ceiling is INCLUSIVE: precisely the maximum is a legitimate request, and refusing it would refuse
    // the largest scan the contract permits.
    assert.equal(codeOf(span(90), AUDIT_EVENTS_QUERY), 'NO_ERROR', 'exactly 90 days must be accepted');
    assert.equal(codeOf(span(91), AUDIT_EVENTS_QUERY), 'TIME_RANGE_TOO_WIDE');
    assert.equal(codeOf(span(365), AUDIT_EVENTS_QUERY), 'TIME_RANGE_TOO_WIDE');
  });

  test('the normalised filter never contains the pagination controls', () => {
    // THE ROOT CAUSE OF A REAL DEFECT, pinned here because it is shared plumbing rather than one route's bug.
    // `parseQuery` used to treat `limit` and `cursor` as filter members. Two consequences, the second fatal:
    // `page.filter` echoed them a second time, and — because a cursor is bound to `filterHashOf(parsed.filter)`
    // and a continuation request carries `cursor` in its raw query — page 2 hashed a DIFFERENT filter from the
    // one page 1 minted against, so EVERY continuation failed with `400 INVALID_CURSOR`. Pagination over HTTP
    // was therefore impossible for every collection route, and it went unnoticed because the suites that walk
    // many pages drive the cursor helpers directly while each route was only ever fetched one page at a time.
    // It was found by the §5.15 suite's HTTP pagination walk over a real table.
    const first = parseQuery({ ...RANGE, limit: '5' }, AUDIT_EVENTS_QUERY, () => NOW);
    assert.equal(first.limit, 5, 'the limit is still applied — skipped from the FILTER, not ignored');
    assert.equal('limit' in first.filter, false, 'the limit must not appear in the filter');
    assert.equal('cursor' in first.filter, false);

    const second = parseQuery({ ...RANGE, limit: '5', cursor: 'any-opaque-value' }, AUDIT_EVENTS_QUERY, () => NOW);
    assert.equal(second.cursor, 'any-opaque-value', 'the cursor is still returned in its own slot');
    assert.equal('cursor' in second.filter, false);
    // The property that makes a continuation validate: two requests differing ONLY by the cursor produce the
    // same filter, so a cursor minted under the first hash is accepted under the second.
    assert.deepEqual(second.filter, parseQuery({ ...RANGE, limit: '5' }, AUDIT_EVENTS_QUERY, () => NOW).filter);
  });

  test('time parameters are refused on a route that is not time-filterable', () => {
    assert.equal(codeOf({ from: '2026-01-01T00:00:00.000Z' }, SUBJECTS_QUERY), 'UNKNOWN_QUERY_PARAMETER');
    assert.equal(codeOf({ to: '2026-01-01T00:00:00.000Z' }, EXPOSURES_QUERY), 'UNKNOWN_QUERY_PARAMETER');
  });
});

describe('typed parameters are validated against their declared type', () => {
  test('a boolean parameter accepts only true/false', () => {
    assert.equal(codeOf({ isMinor: 'true' }, SUBJECTS_QUERY), 'NO_ERROR');
    assert.equal(codeOf({ isMinor: 'false' }, SUBJECTS_QUERY), 'NO_ERROR');
    for (const bad of ['1', '0', 'yes', 'TRUE', '']) {
      assert.equal(codeOf({ isMinor: bad }, SUBJECTS_QUERY), 'SCHEMA_VALIDATION_FAILED', `isMinor=${bad}`);
    }
  });

  test('an enum parameter accepts only its declared values', () => {
    for (const good of ['VALID', 'EXPIRED', 'REVOKED', 'NONE']) {
      assert.equal(codeOf({ authorityState: good }, SUBJECTS_QUERY), 'NO_ERROR');
    }
    for (const bad of ['valid', 'CANCELLED', 'TRUE', '']) {
      assert.equal(codeOf({ authorityState: bad }, SUBJECTS_QUERY), 'SCHEMA_VALIDATION_FAILED');
    }
  });

  test('an integer parameter rejects a non-integer', () => {
    assert.equal(codeOf({ minConfidence: '50' }, EXPOSURES_QUERY), 'NO_ERROR');
    for (const bad of ['50.5', 'fifty', '']) {
      assert.equal(codeOf({ minConfidence: bad }, EXPOSURES_QUERY), 'SCHEMA_VALIDATION_FAILED');
    }
  });

  test('the normalised filter is identical for two spellings of the same query', () => {
    // This is what makes a cursor's filter binding stable: the SAME logical query must normalise to
    // the SAME object, or a cursor would reject its own continuation.
    const a = parseQuery({ isMinor: 'true', jurisdiction: 'US-CA' }, SUBJECTS_QUERY);
    const b = parseQuery({ jurisdiction: 'US-CA', isMinor: 'true' }, SUBJECTS_QUERY);
    assert.deepEqual(a.filter, b.filter);
  });
});

describe('no refusal returns rows or changes state', () => {
  test('every refusal is a thrown QueryError, so a handler cannot continue', () => {
    // The structural guarantee: the parser THROWS rather than returning a partial result with a
    // flag, so there is no code path where a handler receives rows alongside an error.
    const cases: [Record<string, unknown>, QuerySchema][] = [
      [{ limitt: '5' }, SUBJECTS_QUERY],
      [{ truthState: 'DONE' }, EXPOSURES_QUERY],
      [{ sort: 'identifierValue:asc' }, SUBJECTS_QUERY],
      [{ limit: '1000' }, SUBJECTS_QUERY],
      [{ offset: '10' }, AUDIT_EVENTS_QUERY],
      [{ action: Array.from({ length: 21 }, (_, i) => `a${i}`).join(',') }, AUDIT_EVENTS_QUERY],
    ];
    for (const [raw, schema] of cases) {
      assert.throws(
        () => parseQuery(raw, schema, () => 1_770_000_000_000),
        (error: unknown) => error instanceof QueryError,
        `${JSON.stringify(raw)} must throw rather than return`,
      );
    }
  });
});
