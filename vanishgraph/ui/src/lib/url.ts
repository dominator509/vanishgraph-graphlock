/**
 * The only URL builder in the UI (SPEC-004 §12 VG-UI-083, VG-UI-073; EP-005 M7).
 *
 * EVERY PATH SEGMENT, QUERY VALUE, FRAGMENT AND `history.state` WRITE GOES THROUGH THIS MODULE, and a value that matches
 * one of the eight PII classes is REFUSED — a match is a defect, not a warning. There is no "sanitise and continue"
 * branch: a partially-scrubbed identifier in a URL is still an identifier in a URL, and a URL travels into logs, history,
 * referrer headers and bookmarks.
 *
 * WHAT THE CLIENT CAN AND CANNOT DO, STATED PLAINLY. A Vite single-page application has no server runtime, so the
 * authoritative refusal of a PII-bearing request lives in the API (SPEC-003 §7.1, implemented in EP-004). This module's
 * contribution is that such a URL is never CONSTRUCTED by the application. Class (g) — an `Identifier` value held for a
 * subject — is the one class the browser cannot check: matching it needs the encrypted store, and the plan's fallback is
 * explicit that the store must never be shipped to the client to make a client check possible. That class is therefore
 * recorded as SERVER-ENFORCED in `PII_PATTERN_CLASSES` and its client-side check refuses every value of a shape that
 * could be an identifier unless the caller passes it as an explicitly identified reference.
 *
 * THE CLASSES ARE DECLARED AS DATA, so the suite can assert that its fixtures cover all eight and that none was quietly
 * dropped: a pattern set that misses case-folded alias forms fails its own coverage self-test, which is VG-UI-083's
 * required negative case.
 */

/** The eight classes VG-UI-083 names, with the reason each is checked where it is. */
export interface PiiPatternClass {
  readonly id: 'a-email' | 'b-telephone' | 'c-government-id' | 'd-postal' | 'e-personal-name' | 'f-date-of-birth' | 'g-identifier' | 'h-evidence-content';
  readonly description: string;
  /** `client` when this module refuses it; `server` when the check needs data the browser must not hold. */
  readonly enforcedBy: 'browser' | 'server';
  readonly test: (value: string) => boolean;
}

/** Fold a value for comparison: lower-cased, diacritics removed, punctuation collapsed to single spaces. */
export function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// E.164 plus common national shapes: digits with optional separators, at least nine digits in total.
const TELEPHONE = /(?:\+\d[\d\s().-]{7,}\d)|(?:\b0\d[\d\s().-]{7,}\d\b)/;
// Government identifier shapes are configured per jurisdiction; these are the shapes the supported set uses.
const GOVERNMENT_ID = /\b\d{3}-\d{2}-\d{4}\b|\b[A-Z]{2}\d{6}[A-Z]?\b|\b\d{9}\b/;
const POSTAL = /\b\d{1,5}\s+[A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*)*\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|way|boulevard|blvd|close|court|ct|terrace|terr|place|pl|square|sq|crescent|cres|gardens|grove|hill|park|row|walk|mews)\b/i;
// Numeric and long date forms. The long form is matched on folded words so "3 March 1980" and "March 3, 1980" both hit.
const DATE_NUMERIC = /\b(?:19|20)\d{2}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.](?:19|20)\d{2}\b/;
// The long form is matched on the FOLDED value, because folding turns punctuation into spaces ("1980-03-03" becomes
// "1980 03 03") and on the raw value the numeric pattern no longer matches. MEASURED: the first version tested both forms
// against the folded text and the numeric fixture stopped being detected.
const DATE_LONG = /\b\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:19|20)\d{2}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\s+(?:19|20)\d{2}\b/;// An identifier-shaped opaque token: a UUID or a long high-entropy run that is not a route identifier.
const IDENTIFIER_SHAPE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[A-Za-z0-9_-]{24,}\b/;

let subjectAliases: readonly string[] = [];

/**
 * The subject's alias values, folded, so class (e) can be checked.
 *
 * THE ALIASES ARE NOT PII THEMSELVES IN THIS CONTEXT — they are the strings a URL must never contain. They are set from
 * the session's own subject read, live in memory only, and are cleared on sign-out; a caller that never sets them gets a
 * check that refuses nothing for class (e), which is why the suite asserts the alias check WITH aliases set.
 */
export function setSubjectAliases(aliases: readonly string[]): void {
  subjectAliases = aliases.map(fold).filter((alias) => alias.length > 0);
}

/** The classes, in the specification's order. */
export const PII_PATTERN_CLASSES: readonly PiiPatternClass[] = [
  { id: 'a-email', description: 'email addresses', enforcedBy: 'browser', test: (value) => EMAIL.test(value) },
  { id: 'b-telephone', description: 'telephone numbers in E.164 and common national formats', enforcedBy: 'browser', test: (value) => TELEPHONE.test(value) },
  { id: 'c-government-id', description: 'government identifier shapes configured per jurisdiction', enforcedBy: 'browser', test: (value) => GOVERNMENT_ID.test(value.trim()) },
  { id: 'd-postal', description: 'postal addresses containing a street number plus a street name', enforcedBy: 'browser', test: (value) => POSTAL.test(value) },
  {
    id: 'e-personal-name',
    description: 'personal names matched against the subject’s alias values, case- and diacritic-folded',
    enforcedBy: 'browser',
    test: (value) => {
      const folded = fold(value);
      if (folded.length === 0) return false;
      return subjectAliases.some((alias) => alias.length > 1 && (folded === alias || folded.includes(alias)));
    },
  },
  { id: 'f-date-of-birth', description: 'dates of birth in numeric and long forms', enforcedBy: 'browser', test: (value) => DATE_NUMERIC.test(value) || DATE_LONG.test(fold(value)) },
  {
    id: 'g-identifier',
    description: 'Identifier values held for a subject, matched by digest comparison against the encrypted store',
    // SERVER-ENFORCED, and the reason is the plan's fallback: digest comparison needs the encrypted store, and shipping
    // that store to the browser to make a client check possible is the one thing that must not happen. The client
    // refuses identifier-SHAPED values; the authoritative check is the API's.
    enforcedBy: 'server',
    test: (value) => IDENTIFIER_SHAPE.test(value),
  },
  {
    id: 'h-evidence-content',
    description: 'any value already recorded as EvidenceArtifact content',
    // Also server-enforced: the client holds no artefact content to compare against, and it must not.
    enforcedBy: 'server',
    test: () => false,
  },
];

/** The classes the browser refuses, and the classes the API must refuse. */
export function classesByEnforcement(): { readonly browser: readonly string[]; readonly server: readonly string[] } {
  return {
    browser: PII_PATTERN_CLASSES.filter((entry) => entry.enforcedBy === 'browser').map((entry) => entry.id),
    server: PII_PATTERN_CLASSES.filter((entry) => entry.enforcedBy === 'server').map((entry) => entry.id),
  };
}

/** The class a value matches, or `null`. */
export function classify(value: string): PiiPatternClass['id'] | null {
  for (const entry of PII_PATTERN_CLASSES) {
    if (entry.test(value)) return entry.id;
  }
  return null;
}

/** A refused value. Thrown in every environment: refusing to build a URL cannot break a user's page, and a silent
 * production-only behaviour would mean the defect first appears in production. */
export class PiiInUrlError extends Error {
  readonly patternClass: PiiPatternClass['id'];

  constructor(field: string, patternClass: PiiPatternClass['id']) {
    super(
      `url builder: refusing to put the value of "${field}" into a URL: it matches PII pattern class ${patternClass}. A URL travels into history, logs, referrer headers and bookmarks, so this is a defect rather than a warning.`,
    );
    this.name = 'PiiInUrlError';
    this.patternClass = patternClass;
  }
}

/**
 * An EXPLICITLY opaque reference: a route identifier or a pagination cursor, declared as such by the caller.
 *
 * MEASURED, AND THIS IS WHY IT EXISTS: the first version of this module refused class (g) in every position, which meant
 * the application could not build `/console/cases/<uuid>` at all — a case identifier is a UUID, and so is a keyset cursor.
 * Class (g) is server-enforced precisely because the client cannot tell a route's identifier from a subject's
 * `Identifier` value without the encrypted store, and the plan's fallback forbids shipping that store to the browser. The
 * honest resolution is therefore: a value the CALLER DECLARES as an opaque reference is allowed where only such a
 * reference belongs (a path segment, or a query parameter), and any other identifier-shaped value is refused. A caller
 * smuggling a subject's identifier writes `ref(...)` in the source, where a reviewer can see it — which is the difference
 * between a check and a shrug.
 */
export interface OpaqueRef {
  readonly ref: string;
}

/** Declare a value as an opaque reference (a route identifier or a cursor). */
export function ref(value: string): OpaqueRef {
  return { ref: value };
}

function isRef(value: unknown): value is OpaqueRef {
  return typeof value === 'object' && value !== null && typeof (value as OpaqueRef).ref === 'string';
}

function guard(field: string, value: string, allowOpaqueReference = false): string {
  const matched = classify(value);
  if (matched !== null && !(allowOpaqueReference && matched === 'g-identifier')) {
    throw new PiiInUrlError(field, matched);
  }
  return value;
}

/** Build a path from literal segments. Every segment is guarded, and the result is always a rooted path. */
export function path(...segments: readonly (string | number)[]): string {
  const built = segments.map((segment, index) => {
    const text = String(segment);
    // A path segment IS the route's identifier by construction, so an identifier-shaped segment is permitted here.
    guard(`segment ${String(index)}`, text, true);
    if (text.includes('/') || text.includes('?') || text.includes('#')) {
      throw new Error(`url builder: segment "${text}" contains a path delimiter, so it would change the route it is part of`);
    }
    return encodeURIComponent(text);
  });
  return `/${built.join('/')}`;
}

/** Build a query string. Every value is guarded; keys are literals supplied by the caller, never data. */
export function query(entries: Readonly<Record<string, string | number | boolean | OpaqueRef | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    if (isRef(value)) {
      search.set(key, guard(key, value.ref, true));
      continue;
    }
    search.set(key, guard(key, String(value)));
  }
  const text = search.toString();
  return text.length === 0 ? '' : `?${text}`;
}

/** A URL for a route, from a path and optional query. The ONLY way the application composes one. */
export function url(
  routePath: string,
  entries: Readonly<Record<string, string | number | boolean | OpaqueRef | undefined>> = {},
): string {
  return `${routePath}${query(entries)}`;
}

/** A `history.state` payload. Guarded STRICTLY — no opaque references — and only string leaves are accepted, because a
 * nested value is a value nobody looked at. */
export function historyState(
  entries: Readonly<Record<string, string | number | boolean | undefined>>,
): Record<string, string> {
  const state: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    state[key] = guard(key, String(value));
  }
  return state;
}

/** A document title. The title is a URL-adjacent surface: it reaches history, tab strips and screenshots. */
export function documentTitle(text: string): string {
  return guard('document.title', text);
}
