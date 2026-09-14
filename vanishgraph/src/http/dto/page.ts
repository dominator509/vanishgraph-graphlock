/**
 * The `/v1` page object (SPEC-003 §2.5).
 *
 * The exact shape, from the specification:
 *
 *     {"limit": 25, "nextCursor": "…", "hasMore": true, "sort": "observedAt:desc", "filter": {…}}
 *
 * THE INVARIANT THAT MATTERS: `hasMore` and `nextCursor` must agree. `hasMore: true` with a null
 * cursor is a client that stops paginating while rows remain — silent data loss in a report about
 * whether someone's data was removed. `hasMore: false` with a non-null cursor is a client that keeps
 * asking for pages that will be empty. They are derived from ONE value here, so they cannot disagree
 * by construction, and a test asserts the derivation rather than the outcome.
 */

/** The default and permitted `limit` bounds (SPEC-003 §2.5). */
export const DEFAULT_LIMIT = 25;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 100;

export interface PageObject {
  readonly limit: number;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** `field:asc|desc`, always the sort actually applied — including an applied default. */
  readonly sort: string;
  /**
   * The normalised filter ACTUALLY applied.
   *
   * SPEC-003 §2.6 requires the applied default to be echoed "so an accidental wide scan cannot
   * present itself as a narrow one". A caller who omits a time range receives the defaulted range
   * back and can see it.
   */
  readonly filter: Readonly<Record<string, unknown>>;
}

export interface BuildPageParams {
  readonly limit: number;
  readonly sort: string;
  readonly filter: Readonly<Record<string, unknown>>;
  /** The cursor for the NEXT page, or null when this is the last page. */
  readonly nextCursor: string | null;
}

/**
 * Build the page object.
 *
 * `hasMore` is DERIVED from `nextCursor`, not passed alongside it, so the two cannot disagree.
 */
export function buildPage(params: BuildPageParams): PageObject {
  return {
    limit: params.limit,
    nextCursor: params.nextCursor,
    hasMore: params.nextCursor !== null,
    sort: params.sort,
    filter: params.filter,
  };
}

/**
 * The `{ data, page }` envelope every collection route returns (SPEC-003 §2.5).
 *
 * A shared builder rather than each route assembling the object: a route that returned `{items, page}`
 * would be a contract break a client discovers at runtime, and the collection suites assert this
 * shape for every collection route.
 */
export interface CollectionResponse<T> {
  readonly data: readonly T[];
  readonly page: PageObject;
}

export function buildCollection<T>(
  rows: readonly T[],
  params: { limit: number; sort: string; filter: Readonly<Record<string, unknown>> },
  cursorForLastRow: ((lastRow: T) => string) | null,
): CollectionResponse<T> {
  // The caller fetches limit+1 rows to learn whether another page exists. The extra row is REMOVED
  // here so a route cannot accidentally return it, and `hasMore` comes from its presence.
  const hasExtra = rows.length > params.limit;
  const data = hasExtra ? rows.slice(0, params.limit) : rows;
  const last = data[data.length - 1];

  // A cursor is minted only when there IS a next page and the caller supplied a minter. With no
  // minter, `nextCursor` is null and `hasMore` is false: a route that cannot paginate must not
  // report that more rows exist.
  const nextCursor =
    hasExtra && last !== undefined && cursorForLastRow !== null ? cursorForLastRow(last) : null;

  return { data, page: buildPage({ limit: params.limit, sort: params.sort, filter: params.filter, nextCursor }) };
}
