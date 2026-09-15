/**
 * Cursor pagination (SPEC-003 §2.5, §2.6).
 *
 * The suite walks a seeded collection PAGE BY PAGE and asserts each row appears exactly once — no
 * duplicates, no gaps. That is the property that matters: a cursor implementation that is internally
 * consistent but skips a row silently loses a subject's exposure from a report about whether their
 * data was removed.
 *
 * Two sort orders are walked, because a keyset that works for `createdAt:desc` can still be wrong for
 * a different field, and TIES are included deliberately: two rows sharing a sort value are exactly
 * where an id-less keyset repeats or skips one.
 *
 * THE FALLBACK THE PLAN NAMES is implemented and tested: the keyset carries the opaque row id as a
 * deterministic tiebreaker. Offset pagination appears NOWHERE, and a test asserts a request for it is
 * refused rather than silently honoured.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  MAX_CURSOR_BYTES,
  CursorError,
  decodeCursor,
  encodeCursor,
  filterHashOf,
  isOffsetRequested,
  peekCursor,
  type CursorPayload,
} from '../../src/http/pagination/cursor.ts';
import { buildCollection, buildPage, DEFAULT_LIMIT, MAX_LIMIT } from '../../src/http/dto/page.ts';
import { parseQuery } from '../../src/http/query/strict.ts';
import { REAPPEARANCES_QUERY } from '../../src/http/query/filters.ts';

const SECRET = 'test-session-secret-value';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** A row shaped like one a collection route returns. */
interface Row {
  readonly id: string;
  readonly createdAt: string;
  readonly displayRef: string;
}

/**
 * Seed rows with DELIBERATE TIES.
 *
 * 250 rows whose `createdAt` takes only 5 distinct values means ~50 rows share a sort value, which is
 * the case that breaks a keyset with no tiebreaker. A seed of 250 unique timestamps would pass while
 * the real bug sat undetected.
 */
function seed(count = 250): Row[] {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  return Array.from({ length: count }, (_, i) => ({
    // Ids are NOT ordered like createdAt, so a keyset that fell back to id order would be caught.
    id: `row-${String((i * 7919) % count).padStart(4, '0')}`,
    createdAt: new Date(base + (i % 5) * 60_000).toISOString(),
    displayRef: `SUBJ-${String(i).padStart(5, '0')}`,
  }));
}

type Comparator = (a: Row, b: Row) => number;

/** Compare by the sort field, then by id — the tiebreaker that makes the ordering total. */
function comparatorFor(sort: string): Comparator {
  const [field = 'createdAt', direction = 'desc'] = sort.split(':');
  const sign = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    const av = a[field as keyof Row];
    const bv = b[field as keyof Row];
    if (av !== bv) return av < bv ? -sign : sign;
    // The id tiebreaker is ALWAYS ascending and independent of the direction, so the ordering is
    // total and stable regardless of sort direction.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** Page through a collection exactly as a route would, using only the public cursor API. */
function walk(
  rows: readonly Row[],
  sort: string,
  filter: Record<string, unknown>,
  limit: number,
  tenantId = TENANT_A,
  routeTemplate = '/v1/subjects',
): { ids: string[]; pages: number; pageObjects: unknown[] } {
  const sorted = [...rows].sort(comparatorFor(sort));
  const filterHash = filterHashOf(filter);
  const ids: string[] = [];
  const pageObjects: unknown[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    pages += 1;
    if (pages > 1000) throw new Error('pagination did not terminate');

    let startIndex = 0;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor, SECRET, { tenantId, routeTemplate, filterHash, sort });
      // Find the row the cursor points at, then continue AFTER it. The id makes the position exact
      // even when several rows share `sortValue`.
      startIndex = sorted.findIndex(
        (r) => r.id === decoded.keyset.id && r[sort.split(':')[0] as keyof Row] === decoded.keyset.sortValue,
      );
      if (startIndex < 0) throw new Error('cursor position not found in the collection');
      startIndex += 1;
    }

    // The route fetches limit+1 to learn whether a next page exists.
    const window = sorted.slice(startIndex, startIndex + limit + 1);
    const response = buildCollection(
      window,
      { limit, sort, filter },
      (last) =>
        encodeCursor(
          {
            tenantId,
            routeTemplate,
            filterHash,
            sort,
            keyset: { sortValue: last[sort.split(':')[0] as keyof Row] ?? null, id: last.id },
            issuedAt: 1_770_000_000,
          },
          SECRET,
        ),
    );

    ids.push(...response.data.map((r) => r.id));
    pageObjects.push(response.page);
    if (response.page.nextCursor === null) break;
    cursor = response.page.nextCursor;
  }

  return { ids, pages, pageObjects };
}

describe('a time-filterable collection can be walked without an explicit range (MEASURED DEFECT)', () => {
  /**
   * THE DEFECT THIS PINS. A time-filterable route applies a DEFAULT window (the last 30 days) when the caller
   * omits `from`/`to`, and the window is resolved against the clock. The cursor is bound to a hash of the
   * normalised filter, so page 1 and page 2 normalised to filters a few milliseconds apart, hashed
   * differently, and EVERY continuation failed `400 INVALID_CURSOR`. Pagination over HTTP was therefore
   * impossible for §5.5.1, §5.7.2, §5.11.2 and §5.4.2 unless the caller supplied a range by hand — which is
   * exactly what every existing walk test did, which is why no suite caught it.
   *
   * The fix: the window is carried IN the cursor and a continuation inherits it. This test drives the parser
   * and the cursor together with two DIFFERENT clocks, which is what makes it deterministic — the real route
   * resolves `now()` twice within microseconds, and a test that did the same would be flaky in the direction
   * of passing.
   */
  test('a continuation inherits the window its first page used, so the filter hash matches', () => {
    const first = 1_800_000_000_000;
    const later = first + 5_000;
    const page1 = parseQuery({ limit: '1' }, REAPPEARANCES_QUERY, () => first);

    const cursor = encodeCursor(
      {
        tenantId: TENANT_A,
        routeTemplate: '/v1/reappearances',
        filterHash: filterHashOf(page1.filter),
        sort: page1.sort,
        timeRange: {
          fromMs: Date.parse(String(page1.filter['from'])),
          toMs: Date.parse(String(page1.filter['to'])),
        },
        keyset: { sortValue: '2026-01-01T00:00:00.000Z', id: 'row-1' },
        issuedAt: 1,
      },
      SECRET,
    );

    // THE CURSOR THE SERVER MINTS MUST FIT THE BOUND THE SERVER ENFORCES. Measured: with the window stored as
    // ISO strings, a real `/v1/reappearances` cursor encoded to just over 512 bytes and `encodeCursor` refused to
    // emit it — so the FIRST page of a walk answered `400 INVALID_CURSOR` with no cursor in the request. The
    // window is epoch milliseconds now and the bound is doubled, and this assertion is what keeps the two from
    // drifting apart again.
    assert.ok(
      Buffer.byteLength(cursor, 'utf8') <= MAX_CURSOR_BYTES,
      `a minted cursor must fit the decoder's bound: ${String(Buffer.byteLength(cursor, 'utf8'))} > ${String(MAX_CURSOR_BYTES)}`,
    );
    const peeked = peekCursor(cursor, SECRET);
    const page2 = parseQuery({ limit: '1', cursor }, REAPPEARANCES_QUERY, () => later, peeked.timeRange);

    assert.equal(
      filterHashOf(page2.filter),
      filterHashOf(page1.filter),
      'the inherited window must normalise to the same filter, or every continuation is refused',
    );
    // And the binding check agrees, which is the assertion the route actually performs.
    assert.doesNotThrow(() =>
      decodeCursor(cursor, SECRET, {
        tenantId: TENANT_A,
        routeTemplate: '/v1/reappearances',
        filterHash: filterHashOf(page2.filter),
        sort: page2.sort,
      }),
    );
    // The window is the FIRST page's, not the later clock's — otherwise rows that aged out mid-walk vanish.
    assert.equal(page2.filter['to'], page1.filter['to']);
  });

  test('an explicit range still wins, and a wrong cursor is still refused', () => {
    const first = 1_800_000_000_000;
    const page1 = parseQuery({ limit: '1' }, REAPPEARANCES_QUERY, () => first);
    const cursor = encodeCursor(
      {
        tenantId: TENANT_A,
        routeTemplate: '/v1/reappearances',
        filterHash: filterHashOf(page1.filter),
        sort: page1.sort,
        timeRange: {
          fromMs: Date.parse(String(page1.filter['from'])),
          toMs: Date.parse(String(page1.filter['to'])),
        },
        keyset: { sortValue: '2026-01-01T00:00:00.000Z', id: 'row-1' },
        issuedAt: 1,
      },
      SECRET,
    );

    // A caller that supplies its own `from` keeps it; only the omitted side is inherited.
    const explicit = parseQuery(
      { from: '2026-01-01T00:00:00.000Z' },
      REAPPEARANCES_QUERY,
      () => first,
      peekCursor(cursor, SECRET).timeRange,
    );
    assert.equal(explicit.filter['from'], '2026-01-01T00:00:00.000Z');

    // And a cursor minted for one range is still refused against a query with another: inheritance must not
    // turn the filter binding into a formality.
    const other = parseQuery(
      { from: '2025-01-01T00:00:00.000Z', to: '2025-02-01T00:00:00.000Z' },
      REAPPEARANCES_QUERY,
      () => first,
    );
    assert.throws(
      () =>
        decodeCursor(cursor, SECRET, {
          tenantId: TENANT_A,
          routeTemplate: '/v1/reappearances',
          filterHash: filterHashOf(other.filter),
          sort: other.sort,
        }),
      (error: unknown) => error instanceof CursorError,
    );
  });
});

describe('a full walk returns every row exactly once', () => {  test('250 rows over createdAt:desc, no duplicates and no gaps', () => {
    const rows = seed();
    const { ids, pageObjects } = walk(rows, 'createdAt:desc', {}, 25);

    assert.equal(ids.length, rows.length, 'every row must be returned');
    assert.equal(new Set(ids).size, ids.length, 'no row may appear twice');
    const expected = new Set(rows.map((r) => r.id));
    for (const id of ids) assert.ok(expected.has(id), `${id} is not a seeded row`);

    // Every page object has the §2.5 shape and agrees with itself.
    for (const page of pageObjects as { hasMore: boolean; nextCursor: string | null; limit: number }[]) {
      assert.equal(page.hasMore, page.nextCursor !== null, 'hasMore and nextCursor must agree');
      assert.equal(page.limit, 25);
    }
    const last = pageObjects[pageObjects.length - 1] as { nextCursor: string | null; hasMore: boolean };
    assert.equal(last.nextCursor, null, 'the last page must have a null nextCursor');
    assert.equal(last.hasMore, false);
  });

  test('250 rows over displayRef:asc — a different sort order', () => {
    const rows = seed();
    const { ids } = walk(rows, 'displayRef:asc', {}, 25);
    assert.equal(ids.length, rows.length);
    assert.equal(new Set(ids).size, ids.length);

    const sorted = [...rows].sort(comparatorFor('displayRef:asc'));
    assert.deepEqual(ids, sorted.map((r) => r.id), 'the walk must follow the declared order');
  });

  test('a page size of 1 still covers every row exactly once', () => {
    // The boundary case most likely to double-count: every page boundary falls inside a tie group.
    const rows = seed(50);
    const { ids, pages } = walk(rows, 'createdAt:desc', {}, 1);
    assert.equal(ids.length, rows.length);
    assert.equal(new Set(ids).size, ids.length);
    // MEASURED: exactly one page per row, with NO trailing empty page. The loop stops when a page
    // returns a null nextCursor, and the final page has no lookahead row to mint one from — so the
    // walk ends on the last row rather than fetching an empty page after it. An earlier assertion of
    // `rows.length + 1` was wrong about the implementation, not the other way round.
    assert.equal(pages, rows.length, 'one page per row, no trailing empty page');
  });

  test('the maximum page size is honoured', () => {
    const rows = seed();
    const { ids } = walk(rows, 'createdAt:desc', {}, MAX_LIMIT);
    assert.equal(ids.length, rows.length);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('a cursor is bound to its tenant, route, filter and sort (SPEC-003 §2.5)', () => {
  const filter = { jurisdiction: 'US-CA' };
  const payload: CursorPayload = {
    tenantId: TENANT_A,
    routeTemplate: '/v1/subjects',
    filterHash: filterHashOf(filter),
    sort: 'createdAt:desc',
    keyset: { sortValue: '2026-01-01T00:00:00.000Z', id: 'row-0001' },
    issuedAt: 1_770_000_000,
  };
  const bindings = { tenantId: TENANT_A, routeTemplate: '/v1/subjects', filterHash: filterHashOf(filter), sort: 'createdAt:desc' };

  test('a cursor minted for tenant A is rejected under tenant B', () => {
    const cursor = encodeCursor(payload, SECRET);
    assert.throws(
      () => decodeCursor(cursor, SECRET, { ...bindings, tenantId: TENANT_B }),
      CursorError,
      'a cross-tenant cursor must be refused',
    );
  });

  test('a cursor minted for one route is rejected on another', () => {
    const cursor = encodeCursor(payload, SECRET);
    assert.throws(() =>
      decodeCursor(cursor, SECRET, { ...bindings, routeTemplate: '/v1/cases' }),
    );
  });

  test('a cursor minted for one filter set is rejected under a different one', () => {
    const cursor = encodeCursor(payload, SECRET);
    assert.throws(() =>
      decodeCursor(cursor, SECRET, { ...bindings, filterHash: filterHashOf({ jurisdiction: 'US-NY' }) }),
    );
  });

  test('a cursor minted for one sort is rejected under another', () => {
    // This is the subtle one: the rows are all still there, just in a different order, so the page
    // would look like valid data while skipping and repeating rows.
    const cursor = encodeCursor(payload, SECRET);
    assert.throws(() =>
      decodeCursor(cursor, SECRET, { ...bindings, sort: 'displayRef:asc' }),
    );
  });

  test('the filter hash ignores key order and nulls, so a query binds stably', () => {
    // Otherwise the SAME logical query would produce cursors that reject their own continuation.
    assert.equal(
      filterHashOf({ a: 1, b: 2 }),
      filterHashOf({ b: 2, a: 1 }),
    );
    assert.equal(filterHashOf({ a: 1, b: null }), filterHashOf({ a: 1 }));
  });

  test('a valid cursor round-trips with every binding intact', () => {
    const decoded = decodeCursor(encodeCursor(payload, SECRET), SECRET, bindings);
    assert.equal(decoded.tenantId, TENANT_A);
    assert.equal(decoded.routeTemplate, '/v1/subjects');
    assert.equal(decoded.sort, 'createdAt:desc');
    assert.deepEqual(decoded.keyset, payload.keyset);
  });
});

describe('tampered and malformed cursors are refused', () => {
  const payload: CursorPayload = {
    tenantId: TENANT_A,
    routeTemplate: '/v1/subjects',
    filterHash: filterHashOf({}),
    sort: 'createdAt:desc',
    keyset: { sortValue: 'x', id: 'row-0001' },
    issuedAt: 1_770_000_000,
  };
  const bindings = { tenantId: TENANT_A, routeTemplate: '/v1/subjects', filterHash: filterHashOf({}), sort: 'createdAt:desc' };

  test('a flipped signature byte is rejected', () => {
    const cursor = encodeCursor(payload, SECRET);
    const [body, signature] = cursor.split('.');
    const bytes = Buffer.from(signature ?? '', 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    assert.throws(() => decodeCursor(`${body}.${bytes.toString('base64url')}`, SECRET, bindings), CursorError);
  });

  test('a re-encoded payload with the ORIGINAL signature is rejected', () => {
    // The forgery a signature exists to stop: change the tenant in the payload, keep the signature.
    const cursor = encodeCursor(payload, SECRET);
    const signature = cursor.split('.')[1] ?? '';
    const forged = Buffer.from(
      JSON.stringify({ ...payload, tenantId: TENANT_B }),
      'utf8',
    ).toString('base64url');
    assert.throws(() => decodeCursor(`${forged}.${signature}`, SECRET, bindings), CursorError);
  });

  test('a truncated cursor is rejected', () => {
    const cursor = encodeCursor(payload, SECRET);
    // Cut inside the payload segment so it is still two parts but the signature cannot match.
    const [body, signature] = cursor.split('.');
    const truncated = (body ?? '').slice(0, Math.floor((body ?? '').length / 2));
    assert.throws(() => decodeCursor(`${truncated}.${signature}`, SECRET, bindings), CursorError);
  });

  test('one-part, three-part and empty cursors are rejected', () => {
    for (const bad of ['', 'abc', 'a.b.c', '.', '..', 'abc.']) {
      assert.throws(
        () => decodeCursor(bad, SECRET, bindings),
        CursorError,
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  test('an oversized cursor is rejected BEFORE it is decoded', () => {
    // The bound exists so a small request cannot allocate a large buffer. It is applied to the raw
    // input, so a 1 MB string never reaches base64 decoding.
    const huge = 'A'.repeat(MAX_CURSOR_BYTES + 1);
    assert.throws(
      () => decodeCursor(huge, SECRET, bindings),
      (error: unknown) => error instanceof CursorError && /maximum length/.test(error.message),
    );
  });

  test('a cursor signed with a different secret is rejected', () => {
    const cursor = encodeCursor(payload, SECRET);
    assert.throws(() => decodeCursor(cursor, 'a-different-secret', bindings), CursorError);
  });

  test('an empty signing secret is refused on both encode and decode', () => {
    // A cursor signed with an empty secret is signed with a value an attacker also knows.
    assert.throws(() => encodeCursor(payload, ''), CursorError);
    assert.throws(() => decodeCursor(encodeCursor(payload, SECRET), '', bindings), CursorError);
  });

  test('a payload missing a required field is rejected even when correctly signed', () => {
    // Proves the field validation runs: an authentic cursor with a malformed payload is still refused.
    const incomplete = { tenantId: TENANT_A, routeTemplate: '/v1/subjects' };
    const segment = Buffer.from(JSON.stringify(incomplete), 'utf8').toString('base64url');
    const signature = createHmac('sha256', SECRET).update(segment).digest('base64url');
    assert.throws(() => decodeCursor(`${segment}.${signature}`, SECRET, bindings), CursorError);
  });
});

describe('the page object cannot contradict itself (SPEC-003 §2.5)', () => {
  test('hasMore is derived from nextCursor, so they cannot disagree', () => {
    const withMore = buildPage({ limit: 25, sort: 'a:asc', filter: {}, nextCursor: 'c' });
    assert.equal(withMore.hasMore, true);
    const withoutMore = buildPage({ limit: 25, sort: 'a:asc', filter: {}, nextCursor: null });
    assert.equal(withoutMore.hasMore, false);
    // There is no parameter that could set them independently, which is the point.
    assert.deepEqual(Object.keys(withoutMore).sort(), ['filter', 'hasMore', 'limit', 'nextCursor', 'sort']);
  });

  test('the collection builder removes the lookahead row', () => {
    const rows = Array.from({ length: 26 }, (_, i) => ({ id: `r${i}` }));
    const response = buildCollection(rows, { limit: 25, sort: 'id:asc', filter: {} }, (last) => `cursor-${last.id}`);
    assert.equal(response.data.length, 25, 'the extra row must not be returned');
    assert.equal(response.page.hasMore, true);
    assert.equal(response.page.nextCursor, 'cursor-r24');
  });

  test('an exact-fit page reports no more rows', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}` }));
    const response = buildCollection(rows, { limit: 25, sort: 'id:asc', filter: {} }, (last) => `cursor-${last.id}`);
    assert.equal(response.data.length, 25);
    assert.equal(response.page.hasMore, false);
    assert.equal(response.page.nextCursor, null);
  });

  test('a route with no cursor minter cannot claim more rows', () => {
    // A route that cannot paginate must not report that more rows exist.
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}` }));
    const response = buildCollection(rows, { limit: 25, sort: 'id:asc', filter: {} }, null);
    assert.equal(response.page.nextCursor, null);
    assert.equal(response.page.hasMore, false);
  });

  test('the applied default filter is echoed, not omitted', () => {
    // §2.6: an accidental wide scan must not present itself as a narrow one.
    const page = buildPage({
      limit: 25,
      sort: 'at:desc',
      filter: { from: '2026-08-15T00:00:00.000Z', to: '2026-09-14T00:00:00.000Z', appliedDefaultTimeRangeDays: 30 },
      nextCursor: null,
    });
    assert.equal(page.filter['appliedDefaultTimeRangeDays'], 30);
  });

  test('the defaults match the specification', () => {
    assert.equal(DEFAULT_LIMIT, 25);
    assert.equal(MAX_LIMIT, 100);
  });
});

describe('there is no offset pagination anywhere (SPEC-003 §2.5)', () => {
  test('isOffsetRequested detects the parameter', () => {
    assert.equal(isOffsetRequested({ offset: '10' }), true);
    assert.equal(isOffsetRequested({ limit: '10' }), false);
    assert.equal(isOffsetRequested({}), false);
  });

  test('no source file in src/http mentions an offset parameter', () => {
    // A code path that could produce an offset is what the rule forbids, so the check reads the
    // sources rather than trusting the parser alone. A comment explaining the rule is allowed; a
    // query-parameter DECLARATION is not.
    const root = join(process.cwd(), 'src', 'http');

    const walkDir = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...walkDir(full));
        else if (entry.endsWith('.ts')) out.push(full);
      }
      return out;
    };

    const offenders: string[] = [];
    for (const file of walkDir(root)) {
      const source = readFileSync(file, 'utf8');
      // Strip comments so the explanation of the rule is not read as a violation of it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/\boffset\b\s*[:=]/.test(code)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'no /v1 code may declare or assign an offset');
  });
});
