/**
 * Preconditions and ETags — the `If-Match` half of SPEC-003 §2.7.
 *
 * WHY THIS MODULE EXISTS. Four route modules had grown their own copy of the same two functions: one to read
 * the row version out of an `If-Match` header and one to build the `ETag` the header is compared against. Two
 * of those copies were byte-identical (`appeals.ts`, `deadlines.ts`), one bounded the version at nine digits
 * (`sources.ts`, where the version is a small monotonic counter) and one at fifteen (`epoch` milliseconds).
 * Copies drift: the nine-digit bound and the fifteen-digit bound are both correct FOR THEIR OWN ROUTE, and the
 * only way a reader can tell is by reading each copy. Stating the two cases once, named for what they carry,
 * is what stops a fifth copy from being written from whichever one its author happened to open first.
 *
 * `*` IS REFUSED, deliberately, in both. RFC 9110 gives it the meaning "any current representation", and §2.7
 * makes `If-Match` a PER-RESOURCE optimistic concurrency control. Accepting `*` would let a caller skip the
 * precondition entirely on exactly the routes where it protects a permission downgrade, a recipe enablement or
 * a truth-state change. A malformed value is `412 PRECONDITION_FAILED`, never a silent accept, and a MISSING
 * header is `428 PRECONDITION_REQUIRED` — two different failures with two different codes (§8.2).
 */

import type { FastifyRequest } from 'fastify';

import { apiError } from '../plugins/error-handler.ts';

/** The `If-Match` header value, or `undefined` when the request carried none. */
export function ifMatchHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers['if-match'];
  // Fastify types a repeated header as an array; a caller that sent two `If-Match` values sent a request
  // this contract has no meaning for, and using the first is the only reading that does not invent one.
  return Array.isArray(raw) ? raw[0] : raw;
}

/** A §2.7 ETag: the resource's truth state plus the instant it was last written. */
export function etagFor(truthState: string, epochMillis: number): string {
  return `"${truthState}:${String(epochMillis)}"`;
}

function versionFromIfMatch(header: string | undefined, digits: number): number {
  if (header === undefined) throw apiError('PRECONDITION_REQUIRED');
  const match = new RegExp(`^"?[A-Z_]*:(\\d{1,${String(digits)}})"?$`).exec(header.trim());
  const version = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(version)) {
    // The header was UNPARSEABLE rather than merely stale, so there is no current token to echo. §2.7
    // requires the current ETag on a STALE value, which the comparison after this call produces.
    throw apiError('PRECONDITION_FAILED');
  }
  return version;
}

/**
 * The version of a row whose `row_version` is a small monotonic counter (SPEC-003 §5.3).
 *
 * Nine digits, which is what `integer`-backed row versions in this schema can be: a ten-digit value would not
 * be a row version at all, and accepting one would hide a caller sending epoch milliseconds to a route that
 * compares counters — a mismatch whose symptom is every write failing `412` for reasons nothing explains.
 */
export function integerVersionFromIfMatch(header: string | undefined): number {
  return versionFromIfMatch(header, 9);
}

/**
 * The version of a row whose concurrency token is `updated_at` in epoch milliseconds (§5.13, §5.14, §5.5).
 *
 * Fifteen digits, because a millisecond instant is thirteen today and will stay under fifteen for the
 * lifetime of the format.
 */
export function epochMillisFromIfMatch(header: string | undefined): number {
  return versionFromIfMatch(header, 15);
}
