/**
 * Masking helpers for values that must be recognisable but not readable (SPEC-003 §7.1, VG-SEC-002).
 *
 * THE MASK IS BUILT, NOT CARVED OUT OF THE VALUE. Each helper constructs its output from the parts that are safe to
 * publish, so a value's tail cannot survive a projection mistake — the failure mode a regex-based redaction has,
 * where one unexpected input shape leaves the sensitive part in place.
 */

/**
 * Mask a source record's `rawRef` the way §5.4.4 shows it: `https://…/p/***`.
 *
 * The SCHEME AND HOST SURVIVE, because an operator needs to know which system a record came from to judge the
 * finding; the PATH does not, because on a search result or a registry page the path is frequently the query or the
 * subject's own identifier. Query strings and fragments are dropped with the path — they carry the same class of
 * value, and §5.4.4's example keeps neither.
 *
 * A value that is not a parseable absolute URL is replaced ENTIRELY by `***` rather than partially masked: a
 * relative reference, a bare host, or something that is not a URL at all has no part this function can vouch for.
 */
export function maskRawRef(rawRef: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawRef);
  } catch {
    return '***';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // A `file:`, `data:` or `javascript:` reference has no host worth publishing and can carry content inline.
    return '***';
  }
  // An empty path means the reference was the host itself: there is nothing to mask, and the host is the safe part.
  return parsed.pathname === '/' || parsed.pathname === ''
    ? `${parsed.protocol}//${parsed.host}`
    : `${parsed.protocol}//${parsed.host}/***`;
}
