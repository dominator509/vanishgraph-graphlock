/**
 * Strict query parsing (SPEC-003 §2.5, §2.6, §7.3).
 *
 * THE RULE THIS FILE EXISTS FOR: **an unknown query parameter is refused, never ignored.** SPEC-003
 * §2.6 gives the reason in one clause — "so that a typo cannot silently widen a result set". A client
 * that sends `?limit=1000` and receives the default 25 without an error learns nothing; a client that
 * sends `?truthstate=REMOVED` (wrong case) and receives unfiltered rows believes it filtered. Both are
 * silent wrong answers, and both are worse than an error.
 *
 * The parser is schema-driven rather than hand-written per route, so a route cannot forget a check and
 * a new collection route gets the rules for free.
 *
 * FOUR REFUSALS, each with its own code, because they are different mistakes:
 *
 *   | Input                              | Code                        |
 *   |------------------------------------|-----------------------------|
 *   | a parameter the route does not list | `UNKNOWN_QUERY_PARAMETER`   |
 *   | `sort` outside the allowlist        | `INVALID_SORT_FIELD`        |
 *   | a `truthState` outside the eleven   | `INVALID_TRUTH_STATE`       |
 *   | > 20 values in one filter           | `FILTER_TOO_BROAD`          |
 *
 * The truth-state list is READ FROM THE DOMAIN (`src/domain/truth-state.ts`), not duplicated here. A
 * second copy is how the API comes to accept a token the state machine rejects.
 */

import { ALL_TRUTH_STATES, type TruthState } from '../../application/contracts/index.ts';

/** The 20-value ceiling on one comma-separated filter (SPEC-003 §2.6). */
export const MAX_FILTER_VALUES = 20;

/** The default time window when a time-filterable collection omits `from`/`to` (SPEC-003 §2.6). */
export const DEFAULT_TIME_RANGE_DAYS = 30;

export class QueryError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, details?: Record<string, unknown>) {
    super(code);
    this.name = 'QueryError';
    this.code = code;
    this.details = details;
  }
}

/** How a parameter is declared by a route. */
export type ParameterType = 'integer' | 'number' | 'string' | 'boolean' | 'enum' | 'multi' | 'timestamp';

export interface ParameterSpec {
  readonly type: ParameterType;
  /** Permitted values, for `enum`. */
  readonly values?: readonly string[];
  /** For `multi`, the maximum number of comma-separated values. Defaults to the §2.6 ceiling. */
  readonly maxValues?: number;
  /** For `number`, the inclusive bounds §5 declares for the field. */
  readonly min?: number;
  readonly max?: number;
}

/** A route's declared query surface. */
export interface QuerySchema {
  /** Parameters the route accepts. Anything else is `UNKNOWN_QUERY_PARAMETER`. */
  readonly parameters: Readonly<Record<string, ParameterSpec>>;
  /** Permitted `sort` values, without direction. An empty list means sorting is not offered. */
  readonly sortFields: readonly string[];
  /** The sort applied when none is given, in `field:asc|desc` form. */
  readonly defaultSort: string;
  /** Whether the route accepts `from`/`to`. */
  readonly timeFilterable: boolean;
  /**
   * Whether `from` AND `to` are MANDATORY (SPEC-003 §5.15.1's audit stream: "an unbounded audit scan is
   * refused"). Declared rather than hand-checked so the refusal cannot drift from the route's declaration.
   */
  readonly requireTimeRange?: boolean;
  /** The maximum permitted span in days, refusing with `TIME_RANGE_TOO_WIDE` beyond it (§5.15.1: 90). */
  readonly maxSpanDays?: number;
  /** Whether the route accepts `truthState`. */
  readonly truthStateFilterable: boolean;
  /** Whether the route accepts `limit`/`cursor`. Collection routes do. */
  readonly paginated: boolean;
}

export interface NormalisedQuery {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly sort: string;
  readonly filter: Readonly<Record<string, unknown>>;
}

function isTruthState(value: string): value is TruthState {
  return (ALL_TRUTH_STATES as readonly string[]).includes(value);
}

/**
 * Parse and normalise a raw query object.
 *
 * Returns the applied `limit`, `cursor`, `sort` and the NORMALISED filter, which is what the response
 * echoes in `page.filter`. Normalisation is part of the contract, not cosmetic: the cursor binds to a
 * hash of this object, so two spellings of the same filter must produce the same object or a cursor
 * would reject its own continuation.
 */
export function parseQuery(
  raw: Record<string, unknown>,
  schema: QuerySchema,
  now: () => number = Date.now,
): NormalisedQuery {
  // ---------------------------------------------------------------------------------------------
  // 1. Unknown parameters, BEFORE anything else. A typo must be reported as a typo, not as a
  //    different error that happens to be reachable with the same input.
  // ---------------------------------------------------------------------------------------------
  const allowed = new Set(Object.keys(schema.parameters));
  if (schema.paginated) {
    allowed.add('limit');
    allowed.add('cursor');
  }
  if (schema.timeFilterable) {
    allowed.add('from');
    allowed.add('to');
  }
  if (schema.truthStateFilterable) allowed.add('truthState');
  if (schema.sortFields.length > 0) allowed.add('sort');

  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      // Named in `details` so the caller can fix it; the VALUE is not echoed, because a query value
      // can be PII (an alias hash, an email in a mistyped search parameter).
      throw new QueryError('UNKNOWN_QUERY_PARAMETER', { field: key });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // 2. limit / cursor.
  // ---------------------------------------------------------------------------------------------
  let limit = 25;
  if (schema.paginated && raw['limit'] !== undefined) {
    const parsed = parseInteger(raw['limit']);
    if (parsed === undefined || parsed < 1 || parsed > 100) {
      // SPEC-003 §2.5 fixes the range at 1–100. Out of range is a malformed request, and silently
      // clamping would let a caller believe it received 1000 rows.
      throw new QueryError('SCHEMA_VALIDATION_FAILED', { field: 'limit' });
    }
    limit = parsed;
  }

  let cursor: string | undefined;
  if (schema.paginated && raw['cursor'] !== undefined) {
    const value = raw['cursor'];
    if (typeof value !== 'string' || value.length === 0) {
      throw new QueryError('INVALID_CURSOR');
    }
    cursor = value;
  }

  // ---------------------------------------------------------------------------------------------
  // 3. sort. An absent sort takes the route's default, and the default is ECHOED in page.sort so the
  //    caller sees the ordering that was actually applied.
  // ---------------------------------------------------------------------------------------------
  let sort = schema.defaultSort;
  if (raw['sort'] !== undefined) {
    const value = raw['sort'];
    if (typeof value !== 'string') throw new QueryError('INVALID_SORT_FIELD');
    const match = /^([A-Za-z][A-Za-z0-9]*):(asc|desc)$/.exec(value);
    if (match === null) {
      // A bare field with no direction is refused rather than defaulted: guessing the direction is
      // how a client receives rows in an order it did not ask for.
      throw new QueryError('INVALID_SORT_FIELD', { field: value });
    }
    const field = match[1] ?? '';
    if (!schema.sortFields.includes(field)) {
      throw new QueryError('INVALID_SORT_FIELD', { field });
    }
    sort = value;
  }

  // ---------------------------------------------------------------------------------------------
  // 4. truthState. Read against the DOMAIN's eleven tokens.
  // ---------------------------------------------------------------------------------------------
  const filter: Record<string, unknown> = {};
  if (schema.truthStateFilterable && raw['truthState'] !== undefined) {
    const value = raw['truthState'];
    const tokens = typeof value === 'string' ? value.split(',') : [];
    for (const token of tokens) {
      if (!isTruthState(token)) {
        // SPEC-003 §2.6: "an unknown token is 400 INVALID_TRUTH_STATE, never silently ignored". A
        // silently dropped filter returns MORE rows than asked for, which reads as a wider problem.
        throw new QueryError('INVALID_TRUTH_STATE', { field: token });
      }
    }
    if (tokens.length > MAX_FILTER_VALUES) {
      throw new QueryError('FILTER_TOO_BROAD', { field: 'truthState', limit: MAX_FILTER_VALUES });
    }
    filter['truthState'] = tokens.length === 1 ? tokens[0] : tokens;
  }

  // ---------------------------------------------------------------------------------------------
  // 5. Every other declared parameter, by declared type.
  //
  //    `limit` AND `cursor` ARE SKIPPED, AND THEY ARE THE TWO THAT MUST BE. They are the PAGINATION
  //    CONTROLS: each schema spreads `PAGINATION` into `parameters` so the parser will accept them, and each
  //    is already parsed into its own slot above and reported in its own member of the `page` object
  //    (`limit`, `nextCursor`). Treating them as filter members as well had two consequences, and the second
  //    is a real defect this comment exists to keep fixed:
  //
  //      1. `page.filter` echoed the caller's `limit` and `cursor` a second time, so the applied filter was
  //         not a filter.
  //      2. **A CURSOR COULD NEVER VALIDATE ON THE NEXT REQUEST.** Callers bind a cursor to
  //         `filterHashOf(parsed.filter)`, and a request carrying a cursor has `cursor` IN its raw query — so
  //         page 2 hashed a DIFFERENT filter from the one page 1 minted its cursor against, and every
  //         continuation failed with `400 INVALID_CURSOR`. Measured: `filter1` and `filter2` differed by
  //         exactly the cursor member. Pagination over HTTP was therefore impossible for EVERY collection
  //         route, and it went unnoticed because the suites that walk many pages drive the cursor helpers
  //         directly and the routes were only ever fetched one page at a time.
  // ---------------------------------------------------------------------------------------------
  const PAGINATION_CONTROLS = new Set(['limit', 'cursor']);
  for (const [name, spec] of Object.entries(schema.parameters)) {
    if (PAGINATION_CONTROLS.has(name)) continue;
    const value = raw[name];
    if (value === undefined) continue;
    if (name === 'from' || name === 'to') continue; // handled below with the range default

    if (spec.type === 'integer') {
      const parsed = parseInteger(value);
      if (parsed === undefined) throw new QueryError('SCHEMA_VALIDATION_FAILED', { field: name });
      filter[name] = parsed;
      continue;
    }
    if (spec.type === 'number') {
      // A DECIMAL PARAMETER, which `integer` cannot express. §5.5.1's `minConfidence` is the reason it
      // exists: a confidence is 0.00–1.00, so an integer-only parser would either refuse every value the
      // contract documents or round one, and rounding a threshold filter changes which rows a caller sees.
      const parsed = parseDecimal(value);
      if (parsed === undefined) throw new QueryError('SCHEMA_VALIDATION_FAILED', { field: name });
      if ((spec.min !== undefined && parsed < spec.min) || (spec.max !== undefined && parsed > spec.max)) {
        // Out of the range §5 declares is a malformed request, not an empty result: silently returning no
        // rows for `minConfidence=2` would look like "nothing matched" rather than "that is not a score".
        throw new QueryError('SCHEMA_VALIDATION_FAILED', { field: name });
      }
      filter[name] = parsed;
      continue;
    }
    if (spec.type === 'boolean') {
      if (value !== 'true' && value !== 'false') {
        throw new QueryError('SCHEMA_VALIDATION_FAILED', { field: name });
      }
      filter[name] = value === 'true';
      continue;
    }
    if (spec.type === 'enum') {
      const tokens = typeof value === 'string' ? value.split(',') : [];
      const permitted = spec.values ?? [];
      for (const token of tokens) {
        if (!permitted.includes(token)) {
          throw new QueryError('SCHEMA_VALIDATION_FAILED', { field: name });
        }
      }
      filter[name] = tokens.length === 1 ? tokens[0] : tokens;
      continue;
    }
    if (spec.type === 'multi') {
      const tokens = typeof value === 'string' ? value.split(',').filter((t) => t.length > 0) : [];
      const ceiling = spec.maxValues ?? MAX_FILTER_VALUES;
      if (tokens.length > ceiling) {
        throw new QueryError('FILTER_TOO_BROAD', { field: name, limit: ceiling });
      }
      filter[name] = tokens;
      continue;
    }
    if (spec.type === 'timestamp') {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new QueryError('SCHEMA_VALIDATION_FAILED', { field: name });
      }
      filter[name] = value;
      continue;
    }
    // `string`
    if (typeof value !== 'string' || value.length === 0) {
      throw new QueryError('SCHEMA_VALIDATION_FAILED', { field: name });
    }
    filter[name] = value;
  }

  // ---------------------------------------------------------------------------------------------
  // 6. Time range. A missing range on a time-filterable collection defaults to the last 30 days, and
  //    the APPLIED default is echoed so a wide scan cannot present itself as a narrow one (§2.6).
  //
  //    TWO DECLARED REFUSALS were registered but never raised until §5.15.1 needed them:
  //    `TIME_RANGE_REQUIRED` (SPEC-003 §5.15.1 makes `from`/`to` mandatory on the audit stream, because "an
  //    unbounded audit scan is refused") and `TIME_RANGE_TOO_WIDE` (the same route caps the span at 90 days).
  //    Both are DECLARED on the schema rather than checked in a handler, so the rule lives beside the route's
  //    other query declarations, `page.filter` cannot advertise a range the route then refuses, and a second
  //    route with a cap gets it by setting a field. Before this, no code path anywhere threw either code: a
  //    registry row existed for two refusals the API could not produce.
  // ---------------------------------------------------------------------------------------------
  if (schema.timeFilterable) {
    const rawFrom = raw['from'];
    const rawTo = raw['to'];

    // Checked on the RAW query, before any default is applied: a route that requires a range must refuse a
    // request that did not supply one, and reading the normalised filter afterwards could not tell the
    // difference because a default would already be in it.
    if (schema.requireTimeRange === true && (rawFrom === undefined || rawTo === undefined)) {
      throw new QueryError('TIME_RANGE_REQUIRED', { collection: 'audit-events' });
    }

    const toMs = rawTo === undefined ? now() : parseTimestamp(rawTo, 'to');
    const fromMs =
      rawFrom === undefined ? toMs - DEFAULT_TIME_RANGE_DAYS * 24 * 60 * 60 * 1000 : parseTimestamp(rawFrom, 'from');

    if (fromMs >= toMs) {
      // Inclusive-lower / exclusive-upper means an empty range is a mistake, not a valid query that
      // returns nothing: an empty range and a typo are indistinguishable to a caller otherwise.
      throw new QueryError('SCHEMA_VALIDATION_FAILED', { field: 'from' });
    }

    if (schema.maxSpanDays !== undefined && toMs - fromMs > schema.maxSpanDays * 24 * 60 * 60 * 1000) {
      // The SPAN is reported in days so the caller learns the limit they exceeded, and the bound is
      // inclusive of exactly `maxSpanDays`: a request for precisely the maximum is a legitimate request.
      throw new QueryError('TIME_RANGE_TOO_WIDE', {
        timeRangeFrom: new Date(fromMs).toISOString(),
        timeRangeTo: new Date(toMs).toISOString(),
      });
    }

    filter['from'] = new Date(fromMs).toISOString();
    filter['to'] = new Date(toMs).toISOString();
    // Recorded explicitly, so `page.filter` shows the caller that a default was applied rather than
    // presenting a 30-day window as though it were what they asked for.
    if (rawFrom === undefined || rawTo === undefined) {
      filter['appliedDefaultTimeRangeDays'] = DEFAULT_TIME_RANGE_DAYS;
    }
  }

  return { limit, cursor, sort, filter };
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * A decimal query value.
 *
 * `Number('')` is 0 and `Number(' ')` is 0, so the shape is checked before the conversion: an empty
 * `minConfidence=` must not become a filter of zero, which would silently widen a result set — the exact
 * failure mode §2.6's strict parsing exists to prevent. `Infinity` and `NaN` are refused for the same reason.
 */
function parseDecimal(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'string') throw new QueryError('SCHEMA_VALIDATION_FAILED', { field });
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new QueryError('SCHEMA_VALIDATION_FAILED', { field });
  return parsed;
}
