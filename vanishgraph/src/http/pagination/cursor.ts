/**
 * Opaque, tenant-bound, HMAC-signed cursors (SPEC-003 §2.5).
 *
 * WHY SIGNED AND BOUND, rather than a plain offset or row id:
 *
 *   * **Signed**, so a client cannot mint a cursor. An unsigned cursor carrying `lastId` would let a
 *     caller point the next page anywhere, including at another tenant's rows — the signature is
 *     what makes the payload a statement by the server rather than by the caller.
 *   * **Bound to tenant, route, filter set and sort**, because a cursor is a CONTINUATION OF A
 *     QUERY. A cursor issued for `sort=createdAt:desc` replayed against `sort=displayRef:asc` would
 *     silently return whatever rows happen to follow in a different ordering, which reads as valid
 *     data and is not.
 *   * **Opaque**, so a client never treats it as an identifier. SPEC-003 §2.5: "Clients must not
 *     construct, decode, or persist a cursor as a stable identifier."
 *
 * THREE DEFENSIVE PROPERTIES worth naming, because each closes a real attack:
 *
 *   1. **The size bound is checked BEFORE base64 decoding.** Decoding first would let a caller
 *      allocate gigabytes from a small request body.
 *   2. **`JSON.parse` is never called on unauthenticated bytes.** The signature is verified first, so
 *      a parser bug is not reachable from the network.
 *   3. **Comparison is constant-time.** A byte-by-byte `===` on an HMAC leaks the position of the
 *      first differing byte, which is enough to forge a signature one byte at a time.
 *
 * A cursor carries NO PII and NO truth state (SPEC-003 §2.5). It is confirmation-of-nothing.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The maximum accepted cursor length in bytes.
 *
 * SPEC-003 §2.5 makes the cursor opaque, so a legitimate one is small: a keyset payload with a few
 * values. 512 bytes is generous for that and small enough that a flood cannot exhaust memory. The
 * bound is applied to the RAW input, before any decoding.
 */
export const MAX_CURSOR_BYTES = 512;

/** The keyset position: the last row's ordering values, plus an id tiebreaker. */
export interface CursorKeyset {
  /** The sort field's value in the last row of the page. */
  readonly sortValue: string | number | null;
  /**
   * The opaque row id, as a DETERMINISTIC TIEBREAKER.
   *
   * Without it, two rows sharing a `sortValue` (a common case for a timestamp at second resolution)
   * have no defined relative order, so a page boundary between them can repeat or skip one. SPEC-003
   * M4's FALLBACK names this exact fix.
   */
  readonly id: string;
}

/** The signed payload of a cursor. Every field is a BINDING, not a hint. */
export interface CursorPayload {
  /** The tenant the cursor was issued for. A cursor presented under another tenant is refused. */
  readonly tenantId: string;
  /** The route TEMPLATE, e.g. `/v1/subjects`, so a cursor cannot cross routes. */
  readonly routeTemplate: string;
  /** A canonical hash of the normalised filter set. */
  readonly filterHash: string;
  /** The sort, in `field:asc|desc` form. */
  readonly sort: string;
  /** The position to continue from. */
  readonly keyset: CursorKeyset;
  /** Issued-at, in epoch seconds. Not used for expiry today, but recorded for a future policy. */
  readonly issuedAt: number;
}

export class CursorError extends Error {
  readonly code = 'INVALID_CURSOR' as const;
  constructor(reason: string) {
    super(`invalid cursor: ${reason}`);
    this.name = 'CursorError';
  }
}

function base64urlEncode(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function sign(payloadSegment: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadSegment).digest();
}

/**
 * Canonical JSON.
 *
 * Keys are sorted so that two structurally equal payloads produce byte-identical output. Without
 * this, a re-serialised cursor could fail its own signature check for reasons that have nothing to
 * do with tampering — and the alternative, falling back to an unsigned comparison, would be worse.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Encode and sign a cursor. The only producer of a cursor value. */
export function encodeCursor(payload: CursorPayload, secret: string): string {
  if (secret.length === 0) {
    // A cursor signed with an empty secret is signed with a value an attacker also knows. Refusing
    // is the only safe behaviour; silently proceeding would produce forgeable cursors.
    throw new CursorError('the signing secret is empty');
  }
  const payloadSegment = base64urlEncode(Buffer.from(canonicalJson(payload), 'utf8'));
  const signature = base64urlEncode(sign(payloadSegment, secret));
  const cursor = `${payloadSegment}.${signature}`;
  if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) {
    // Refusing to EMIT an oversized cursor matters as much as refusing to accept one: a cursor the
    // server produces but its own decoder rejects is a pagination that stops on page one.
    throw new CursorError('the encoded cursor exceeds the maximum length');
  }
  return cursor;
}

/** The bindings a cursor must match to be accepted. */
export interface CursorBindings {
  readonly tenantId: string;
  readonly routeTemplate: string;
  readonly filterHash: string;
  readonly sort: string;
}

/**
 * Verify, decode and re-check every binding.
 *
 * Throws `CursorError` (mapped to `400 INVALID_CURSOR`) for every failure, with a reason for the LOG
 * and never for the response: telling a caller WHICH binding mismatched would let them probe for a
 * valid tenant id or route by trial.
 */
export function decodeCursor(
  cursor: string,
  secret: string,
  expected: CursorBindings,
  now: () => number = Date.now,
): CursorPayload {
  // 1. Size, BEFORE any decoding.
  if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) {
    throw new CursorError('exceeds the maximum length');
  }
  if (secret.length === 0) throw new CursorError('the signing secret is empty');

  const parts = cursor.split('.');
  if (parts.length !== 2) throw new CursorError('not a two-part cursor');
  const [payloadSegment, signatureSegment] = parts;
  if (payloadSegment === undefined || signatureSegment === undefined || payloadSegment.length === 0) {
    throw new CursorError('missing segment');
  }

  // 2. Signature, BEFORE parsing. Both sides are decoded and compared at equal length; a length
  //    mismatch is itself a failure, and `timingSafeEqual` throws on unequal lengths, so it is
  //    checked first rather than relied on to throw.
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureSegment, 'base64url');
  } catch {
    throw new CursorError('signature is not valid base64url');
  }
  const expectedSignature = sign(payloadSegment, secret);
  if (provided.length !== expectedSignature.length) {
    throw new CursorError('signature length mismatch');
  }
  if (!timingSafeEqual(provided, expectedSignature)) {
    throw new CursorError('signature mismatch');
  }

  // 3. Only now is the payload parsed.
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('payload is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CursorError('payload is not an object');
  }

  const candidate = parsed as Partial<CursorPayload>;
  const keyset = candidate.keyset as Partial<CursorKeyset> | undefined;
  if (
    typeof candidate.tenantId !== 'string' ||
    typeof candidate.routeTemplate !== 'string' ||
    typeof candidate.filterHash !== 'string' ||
    typeof candidate.sort !== 'string' ||
    typeof candidate.issuedAt !== 'number' ||
    keyset === undefined ||
    typeof keyset !== 'object' ||
    typeof keyset.id !== 'string' ||
    !('sortValue' in keyset)
  ) {
    throw new CursorError('payload is missing a required field');
  }

  // 4. Every binding. A signed cursor is authentic, not AUTHORISED: it was issued by this server, but
  //    for a particular query, and replaying it against a different query is the misuse this catches.
  if (candidate.tenantId !== expected.tenantId) throw new CursorError('tenant binding mismatch');
  if (candidate.routeTemplate !== expected.routeTemplate) throw new CursorError('route binding mismatch');
  if (candidate.filterHash !== expected.filterHash) throw new CursorError('filter binding mismatch');
  if (candidate.sort !== expected.sort) throw new CursorError('sort binding mismatch');

  void now;
  return {
    tenantId: candidate.tenantId,
    routeTemplate: candidate.routeTemplate,
    filterHash: candidate.filterHash,
    sort: candidate.sort,
    keyset: { sortValue: keyset.sortValue ?? null, id: keyset.id },
    issuedAt: candidate.issuedAt,
  };
}

/**
 * A stable hash of a normalised filter set, for the cursor's filter binding.
 *
 * Keys are sorted and undefined values dropped, so `{a:1,b:2}` and `{b:2,a:1}` bind identically —
 * otherwise the SAME logical query would produce cursors that reject each other.
 */
export function filterHashOf(normalisedFilter: Record<string, unknown>): string {
  const canonical = canonicalJson(
    Object.fromEntries(
      Object.entries(normalisedFilter).filter(([, v]) => v !== undefined && v !== null),
    ),
  );
  // A plain hash, not an HMAC: this value is inside an already-signed payload, and its only job is to
  // detect a changed filter. It carries no secret and identifies no PII.
  return createHmac('sha256', 'cursor-filter-binding').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Whether a request asked for offset pagination.
 *
 * There is no `offset` parameter on any route (SPEC-003 §2.5), and the point is that NO CODE PATH can
 * produce one. Strict query parsing already rejects the parameter as unknown; this predicate exists so
 * a test can assert the absence directly and so the intent is discoverable in one place.
 */
export function isOffsetRequested(query: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(query, 'offset');
}
