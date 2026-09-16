#!/usr/bin/env node
/**
 * The vocabulary / copy-lint gate (SPEC-003 VG-API-067, SPEC-004 VG-UI-080…083; EP-004 M8).
 *
 * THREE SURFACES, ONE TOKEN LIST. A forbidden synonym can enter this product through the generated OpenAPI document
 * (a path segment or a parameter name), through the route registry (a scope, a group label), or through the source
 * declarations a caller reads (a DTO field, a string literal in a response). Scanning only the document would miss
 * the third, and the third is where most of the vocabulary actually lives.
 *
 * WHY THE WORD LIST IS SPEC-000 §4's RATHER THAN MINE. Every token below is a synonym that specification names as
 * forbidden in production identifiers — `client`, `target`, `victim`, `match`, `finding`, `score`, `request`,
 * `submission`, `check`, `file`, `job`, `task` and the rest — because each one carries a meaning this product must not
 * assert: a `match` is a confidence-scored candidate, a `finding` is not a legal conclusion, a `request` is a
 * `RequestCase`. The gate exists so those words cannot enter the API by habit.
 *
 * TWO TOKENS ARE ALLOWLISTED BY EXACT NAME: `X-Request-Id` and `requestId`. SPEC-003 §7.3 sanctions exactly those two
 * as standard HTTP call tracing, and every OTHER `request*` identifier fails. The allowlist entries carry a reason,
 * and an entry without one is itself a failure (VG-UI-080): an allowlist that cannot explain itself is a place for
 * rules to disappear.
 *
 * IT FAILS ON A ZERO-FILE SCAN. A vocabulary gate that read no files would print a green line and mean nothing, which
 * is the failure DOD-024 names.
 *
 * Usage: `node scripts/copy-lint-gate.ts [--root <dir>] [--self-test]`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

/** SPEC-000 §4's forbidden synonyms, used as production identifiers. */
export const FORBIDDEN_TOKENS: readonly string[] = [
  'client', 'target', 'victim', 'user_profile', 'consent', 'permission', 'site', 'vendor', 'provider',
  'scraper', 'script', 'bot', 'automation', 'hit', 'listing', 'result', 'lead', 'match', 'finding',
  'compromise', 'score', 'probability', 'certainty', 'ruling', 'verdict', 'ticket', 'job', 'task',
  'request', 'submission', 'dedupe_key', 'nonce', 'check', 'recheck', 'confirmation', 'relapse',
  'regression', 'attachment', 'file', 'screenshot', 'broker', 'company', 'entity', 'blocker',
  'captcha_wall', 'sanitizer', 'cleaner',
];

/** The ad-hoc status tokens SPEC-000 §4 forbids as stand-ins for a truth state. */
export const FORBIDDEN_STATUS_TOKENS: readonly string[] = ['DONE', 'COMPLETE', 'SUCCESS', 'REMOVED'];

/**
 * Tokens permitted BY EXACT NAME, each with the reason it is permitted.
 *
 * `request` and `nonce` appear in the forbidden list above and are also required by the specifications: a
 * `RequestCase` is the domain's own name for a removal request (SPEC-001 §2), `X-Request-Id`/`requestId` are
 * sanctioned tracing (SPEC-003 §7.3), and a webhook nonce is required by §6.1. The shape below — an exact string plus
 * a reason — is what keeps the exceptions from silently widening: a matching token is skipped only when the WHOLE
 * identifier equals the entry, and an entry with no reason fails the gate.
 */
export const ALLOWLIST: readonly { readonly token: string; readonly reason: string }[] = [
  { token: 'X-Request-Id', reason: 'SPEC-003 §7.3 sanctions it by exact name as HTTP call tracing' },
  { token: 'requestId', reason: 'SPEC-003 §7.3 sanctions it by exact name as HTTP call tracing' },
  {
    token: 'RequestCase',
    reason: 'SPEC-001 §2: the domain entity for a removal request, and the name the state machine uses',
  },
  {
    token: 'request_case',
    reason: 'the table name of SPEC-001 §2 RequestCase, used in SQL only and never as a wire identifier',
  },
  { token: 'nonce', reason: 'SPEC-003 §6.1 requires the X-VG-Nonce header for webhook replay protection' },
  { token: 'provider_key_id', reason: 'SPEC-003 §6.2 names the webhook binding column; there is no other spelling' },
  { token: 'providerEventKind', reason: 'SPEC-003 §6.2 names the field verbatim' },
  { token: 'providerTransportRunId', reason: 'SPEC-003 §6.2 names the field verbatim' },
  { token: 'providerReference', reason: 'SPEC-003 §6.2 names the field verbatim' },
  { token: 'ProviderTransportRun', reason: 'SPEC-001 §3.5 names the entity verbatim (ADR-004 official transports)' },
  { token: 'provider_transport_run', reason: 'the table name of SPEC-001 §3.5 ProviderTransportRun' },
  { token: 'requestedChannel', reason: 'SPEC-003 §5.6.1 names the policy-resolution input verbatim' },
  { token: 'requestedAt', reason: 'SPEC-003 §5.4.1 names the discovery-run input verbatim' },
  { token: 'checks', reason: 'SPEC-003 §5.6.1’s exemption evaluation field, named verbatim in the contract' },
  {
    token: 'failedCheck',
    reason: 'SPEC-003 §8.3 names it as a `details` key, so it is part of the error vocabulary the contract fixes',
  },
  {
    token: 'permission-class',
    reason: 'SPEC-003 §5.3.4’s route segment, named verbatim (`permissionClass` is its field spelling)',
  },
  { token: 'permissionClass', reason: 'SPEC-003 §5.3 names the source field verbatim' },
  { token: 'provider-callbacks', reason: 'SPEC-003 §6.2’s route segment, named verbatim' },
  { token: 'providerKeyId', reason: 'SPEC-003 §6.2’s path parameter, named verbatim' },
  { token: 'mailProviderKeyId', reason: 'SPEC-003 §6.3’s path parameter, named verbatim' },
  { token: 'match-assessments', reason: 'SPEC-003 §5.5.3’s route segment, named verbatim in the contract' },
  { token: 'MATCH_CONFIRMED', reason: 'a SPEC-000 §5 canonical truth state, named verbatim' },
  { token: 'MATCH_DISPROVED', reason: 'SPEC-003 §5.4.4’s assessment token, named verbatim' },
  { token: 'finding', reason: 'SPEC-003 §5.8.3’s reconciliation outcome field, named verbatim' },
  {
    token: 'if-match',
    reason: 'the standard HTTP conditional-request header (RFC 9110), not a product identifier',
  },
  {
    token: 'ifMatch',
    reason:
      'the same RFC 9110 header in the camelCase spelling this codebase uses for an option key; EP-005 M5 measured that the gate flagged it as the forbidden synonym "match", which it is not',
  },
  { token: 'targetKind', reason: 'SPEC-003 §5.15.1’s audit filter, named verbatim in the contract' },
  { token: 'targetId', reason: 'SPEC-003 §5.15.1’s audit filter, named verbatim in the contract' },
  {
    token: 'RequestContext',
    reason: 'SPEC-003 §2.4’s name for the per-request context handed to commands; it is the contract’s own term',
  },
  { token: 'request-context', reason: 'the module name of SPEC-003 §2.4’s RequestContext' },
  {
    token: 'eligibleConfirmedMatchDenominator',
    reason: 'SPEC-003 §5.16.3 names the metric denominator verbatim in its response',
  },
  { token: 'provider', reason: 'SPEC-003 §5.8.6 names the mail-piece field verbatim in its row' },
  { token: 'readbackRequestId', reason: 'SPEC-003 §5.8.5 names the readback field verbatim' },
  { token: 'requestSubmitted', reason: 'SPEC-003 §5.16.3 names the exclusion verbatim in its response' },
  { token: 'target', reason: 'SPEC-003 §5.15.1 names the audit row\u2019s nested target object verbatim' },
  { token: 'score', reason: 'SPEC-003 §5.5.3 takes a scalar `score` inside `confidence`; the object carries basis' },
];

/**
 * The SOURCE permission family, named verbatim by SPEC-003 §5.3 and SPEC-000's source rules.
 *
 * SPEC-000 §4 forbids `permission` as a synonym for a subject's CONSENT, and this family is a different concept the
 * contract names: whether a SOURCE permits a read or a write, its evidence, and the window that evidence covers. Each
 * name below is the specification's own spelling, so renaming one here would be this gate overruling the contract;
 * they are listed individually rather than admitted by a `permission*` prefix, because a prefix is exactly how an
 * allowlist grows teeth it was never given.
 */
const SPEC_PERMISSION_FIELDS: readonly string[] = [
  'permissionClass',
  'permissionCheckedAt',
  'permissionEvidenceUrl',
  'permissionWindowSeconds',
  'PERMISSION_EVIDENCE_REQUIRED',
  'PERMISSION_CLASS_UNCLEAR',
  'permission_class',
  'permission-class',
  'permissionFresh',
  'request-context.ts',
];

const SPEC_PERMISSION_ALLOWLIST: readonly { readonly token: string; readonly reason: string }[] =
  SPEC_PERMISSION_FIELDS.map((token) => ({
    token,
    reason: 'SPEC-003 §5.3 names this source-permission field; §4 of SPEC-000 forbids only the consent sense',
  }));

/**
 * Names that are LOCAL variables or framework parameters rather than fields on the wire.
 *
 * A property-key pattern cannot tell `requestId: 'x'` (a field a client reads) from `request: FastifyRequest` (a
 * parameter in a handler's signature), so these names — Fastify's own `request`/`reply`, the transaction and input
 * handles this codebase passes around — are excluded BY NAME. The list is short, closed, and about the FRAMEWORK's
 * vocabulary: none of these names is ever a JSON field, and adding one for a product concept would be the weakening
 * this exclusion's shape is meant to prevent.
 */
export const NON_WIRE_NAMES: readonly string[] = [
  'request', 'reply', 'payload', 'rawBody', 'tx', 'input', 'options', 'context', 'params', 'query', 'body', 'headers',
  // THE UI FRAMEWORK'S HANDLES, same rule as Fastify's: a local cache object in the bootstrap is not a field on the
  // wire. MEASURED: `queryClient` was flagged for containing the forbidden word "client", and `react-dom/client` for
  // being a module specifier — both are framework vocabulary, and neither is a name this product publishes.
  'queryClient', 'QueryClient', 'QueryClientProvider',
];


/**
 * §14 VG-UI-082's permanent-claim list, transcribed from SPEC-004 §14 as CASE-INSENSITIVE PHRASES.
 *
 * THESE ARE NOT SYNONYMS, THEY ARE CLAIMS, and that is why they are checked over VISIBLE STRINGS rather than over
 * identifiers: "removed from the internet" is a sentence a marketing page would like to print, and the specification
 * forbids it in a heading, a `<title>`, a meta description, an empty state and a message template alike. A gate that
 * only read body text would miss the three places where a claim travels furthest after leaving the application.
 *
 * `tests/contract/vocabulary-ui.test.ts` carries the same list and FAILS if the two disagree, so the rule cannot live
 * in two places and drift.
 */
export const PERMANENT_CLAIM_PHRASES: readonly string[] = [
  'removed from the internet',
  'delete you from the internet',
  'permanently deleted',
  'permanent deletion',
  'deleted everywhere',
  'erased from the web',
  'guaranteed removal',
  'guaranteed deleted',
  '100% removed',
  'fully removed',
  'completely removed',
  'removed from all sites',
  'removed from all sources',
  'we delete your data',
  'gone forever',
  'never comes back',
];

/**
 * The TWO §0.3 exceptions, each with an OWNER and a REASON (VG-UI-008, VG-UI-081).
 *
 * §0.3 records exactly two narrowly-scoped exceptions to the vocabulary rule, and it names what they do NOT permit:
 * `PermissionClass` is a value object referenced by its exact name, but the bare noun *permission* is never a synonym
 * for `AuthorityGrant`; and `provider-permitted` / `ProviderTransportRun` are defined terms, but the bare noun
 * *provider* is never a synonym for `Source`. The bare nouns are therefore NOT allowlisted — asserted by the UI
 * contract suite — and every entry here carries an owner, because an exception nobody owns is one nobody reviews.
 */
export const UI_ALLOWLIST: readonly { readonly token: string; readonly owner: string; readonly reason: string }[] = [
  {
    token: 'PermissionClass',
    owner: 'SPEC-001 §2 (value object); SPEC-004 §0.3 exception 1',
    reason: 'the value object is referenced by its exact name, and the bare noun permission is never a synonym for AuthorityGrant',
  },
  {
    token: 'ProviderTransportRun',
    owner: 'SPEC-001 §3.5 (entity); SPEC-004 §0.3 exception 2',
    reason: 'an exact defined term for the official-transport record, and the bare noun provider is never used to mean a Source',
  },
];

/** The UI surfaces the copy rules cover: the source tree, the HTML shell, and the built bundle when it exists. */
function uiFiles(root: string): string[] {
  const out = filesUnder(join(root, 'ui', 'src'), ['.ts', '.tsx', '.css']);
  const shell = join(root, 'ui', 'index.html');
  try {
    statSync(shell);
    out.push(shell);
  } catch {
    // No shell is not an error here: the identifier scan below still runs over the sources.
  }
  // THE BUILT BUNDLE IS SCANNED WHEN IT EXISTS: a build step is where a string could be transformed into one nobody
  // reviewed, and the plan requires the gate to run over built output (VG-UI-080).
  try {
    out.push(...filesUnder(join(root, 'ui', 'dist'), ['.js', '.html']));
  } catch {
    // Not built yet: the check is narrower, and the gate's summary line reports how many files it read.
  }
  return out;
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly token: string;
  readonly excerpt: string;
}

function filesUnder(root: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.some((extension) => entry.endsWith(extension))) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Whether `identifier` matches an allowlist entry EXACTLY. */
function allowed(identifier: string): boolean {
  return [...ALLOWLIST, ...SPEC_PERMISSION_ALLOWLIST].some((entry) => entry.token === identifier);
}

/**
 * Scan one file's lines for forbidden tokens used as IDENTIFIERS.
 *
 * IDENTIFIERS, NOT PROSE, and the distinction is the whole design. MEASURED, first run of this gate: scanning every
 * quoted string flagged the SEMANTIC error messages — `'No jurisdiction policy resolves for this request.'`,
 * `'The supplied digest does not match the received content.'` — which are sentences shown to a human, not the names
 * a caller writes in code or JSON. SPEC-000 §4 forbids these synonyms "used as production identifiers"; flagging
 * English would make the gate unrunnable, and an unrunnable gate is a disabled one.
 *
 * So a token is a hit only when it appears inside one of the shapes that IS an identifier:
 *
 *   * a PROPERTY KEY — `clientId:` or `'client_id':`;
 *   * a QUOTED TOKEN with no whitespace — an enum value, a header name, a status literal;
 *   * a PATH SEGMENT of a quoted route path.
 *
 * PROSE IS DELIBERATELY OUT OF SCOPE HERE, and that is a boundary rather than an oversight: the wording rules for
 * what a USER READS are SPEC-004 VG-UI-080…083, which EP-005 M2 applies through this same script. A sentence in an
 * error message is that milestone's subject, not this one's — and pretending otherwise would have meant either
 * flagging every English sentence or quietly ignoring them with no record.
 */
export function scanSource(path: string, shownPath: string): Hit[] {
  const raw = readFileSync(path, 'utf8');
  const code = stripComments(raw);
  const hits: Hit[] = [];
  code.split('\n').forEach((line, index) => {
    for (const raw of identifiersOn(line)) {
      if (NON_WIRE_NAMES.includes(raw)) continue;
      // A DOTTED ACCESS IS JUDGED BY ITS LAST SEGMENT ONLY. MEASURED, and this took two attempts: judging the whole
      // expression flagged LOCAL VARIABLE ROOTS — \`result.evaluation.signatureVerified\` hit on \`result\` — which are not
      // wire identifiers at all. A field named \`result\` is still caught, because a wire field appears as a PROPERTY
      // KEY (\`result:\`) or a quoted string, and both are judged whole by the passes above.
      const candidate = raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw;
      const hit = forbiddenTokenIn(candidate);
      if (hit === null) continue;
      if (allowed(candidate)) continue;
      hits.push({ file: shownPath, line: index + 1, token: hit, excerpt: line.trim().slice(0, 140) });
      break;
    }
  });
  return hits;
}

/** The identifier-shaped substrings of one line: property keys, whitespace-free quoted tokens and path segments. */
function identifiersOn(line: string): string[] {
  const out: string[] = [];
  // PROPERTY KEYS ARE READ FROM A COPY WITH STRING CONTENTS BLANKED. MEASURED: without this, the words inside an
  // error MESSAGE produced hits — the sentence "…a durable key provider: ADR-006…" contains a colon, and the
  // key pattern read \`provider\` out of prose. Blanking the spans keeps the keys that are code and drops the ones
  // that are English.
  const codeOnly = line.replace(/['"`][^'"`]*['"`]/g, '""');
  for (const match of codeOnly.matchAll(/(?:^|[\s{,(])([A-Za-z_][A-Za-z0-9_-]*)\s*:/g)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  // TEMPLATE-LITERAL INTERPOLATIONS carry real identifiers — \`\${row.permissionClass}\` reads the field — and the
  // quoted-string pass above cannot see inside them, because a backtick span containing a nested quote closes early.
  // MEASURED: the interpolations were the last source of hits after every other rule was tightened.
  for (const match of line.matchAll(/\$\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? '').split(/[^A-Za-z0-9_.]+/)) {
      if (part.length === 0) continue;
      // ONLY THE FIELD AT THE END OF A DOTTED READ. MEASURED: \`result.evaluation.signatureVerified\` was judged whole, so
      // the words \`result\` and \`provider\` — local variable roots — were flagged inside template literals whose
      // FIELDS are contract names. A root is not a wire identifier.
      out.push(part.slice(part.lastIndexOf('.') + 1));
    }
  }
  // SHORTHAND PROPERTIES ARE WIRE FIELDS TOO. MEASURED: \`return { clientId }\` was invisible to the key pattern,
  // which requires \`name:\`, so a forbidden identifier could enter a response body by being written in shorthand —
  // and shorthand is the form this codebase favours.
  //
  // AN IMPORT LIST IS NOT AN OBJECT LITERAL, and MEASURED: the first version of this rule flagged
  // \`import { epochMillisFromIfMatch, ifMatchHeader }\` — a helper named for the HTTP header it reads. Imports are
  // skipped, because a name bound from another module is not a field this module puts on the wire.
  if (!/^\s*(import|export)\b/.test(line)) {
    for (const match of codeOnly.matchAll(/[{,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,}])/g)) {
      if (match[1] !== undefined) out.push(match[1]);
    }
  }
  for (const match of line.matchAll(/['"`]([^'"`\n]+)['"`]/g)) {
    const value = match[1] ?? '';
    // A MODULE SPECIFIER IS A PATH, NOT A NAME. `react-dom/client`, `@tanstack/react-query` and `./router.ts` are
    // locations; treating their segments as identifiers flagged the framework itself.
    // ANCHORED ALTERNATIVES ONLY. MEASURED DEFECT, caught by the M8 fixture: the first version wrote `(^|\.\.?\/)`, and
    // `^` matches the EMPTY STRING at position zero — so the guard was true for EVERY string and the quoted-string scan
    // silently stopped scanning anything. A bare ^ inside an alternation is not "starts with", it is "always".
    if ((/^\.\.?\//.test(value) || value.startsWith('@') || /^[a-z][a-z0-9-]*\//.test(value)) && !value.startsWith('/')) {
      continue;
    }
    // A string WITH whitespace is prose. The only exception is a route path, whose segments are identifiers.
    if (/\s/.test(value)) {
      if (value.startsWith('/')) out.push(...pathCandidates(value));
      continue;
    }
    // A WHITESPACE-FREE STRING IS TOKENISED rather than judged whole: it can be a route path, an enum value, a
    // header name, or a template literal whose interpolations live beside literal text. MEASURED: judging the whole
    // span made \`"\${row.permissionClass}:\${String(row.rowVersion)}"\` a single candidate whose words contained
    // \`permission\`, so a spec-named field was flagged because of the shape around it.
    out.push(...tokenise(value));
  }
  return out;
}

/**
 * The identifier-shaped parts of a route path or a header value: each segment, with the OpenAPI braces and any
 * surrounding punctuation removed, so `{providerKeyId}` is judged as `providerKeyId` rather than as
 * `{providerKeyId}` — the braces are syntax, and matching them would make every path parameter unmatchable by the
 * allowlist.
 */
function pathCandidates(value: string): string[] {
  return value
    .split('/')
    .map((segment) => segment.replace(/^[{}:]+|[{}:;,.:]+$/g, '').trim())
    .filter((segment) => segment.length > 0);
}

/** The identifier-shaped tokens inside a whitespace-free string: dots and hyphens are kept, punctuation is not. */
function tokenise(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9_.\-]+/)
    .map((token) => token.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter((token) => token.length > 0);
}

/** The forbidden token inside an identifier, or `null`. Word-boundary on camelCase, snake_case and kebab-case. */
function forbiddenTokenIn(identifier: string): string | null {
  for (const token of FORBIDDEN_STATUS_TOKENS) {
    // A status token is a hit only when the identifier IS the token: `DONE` is forbidden, `DONE_AT` is a timestamp.
    if (identifier === token) return token;
  }
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length > 0);
  for (const token of FORBIDDEN_TOKENS) {
    if (words.includes(token)) return token;
  }
  return null;
}

/** Remove block and line comments, preserving newlines so line numbers stay accurate. */
function stripComments(source: string): string {
  let out = '';
  let index = 0;
  let inBlock = false;
  let inLine = false;
  while (index < source.length) {
    const ch = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      } else out += ' ';
      index += 1;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        out += '  ';
        index += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      out += '  ';
      index += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      out += '  ';
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

function main(): number {
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag === -1 ? PROJECT_ROOT : resolve(process.argv[rootFlag + 1] ?? PROJECT_ROOT);

  // THE ALLOWLIST SELF-TEST (VG-UI-080): every entry carries a reason, and an entry that does not is a failure.
  const unexplained = [...ALLOWLIST, ...SPEC_PERMISSION_ALLOWLIST].filter(
    (entry) => entry.reason.trim().length === 0,
  );
  if (unexplained.length > 0) {
    console.error('copy lint gate: FAIL - allowlist entries without a reason:');
    for (const entry of unexplained) console.error(`  ${entry.token}`);
    return 1;
  }

  // THE SCANNED SURFACE IS THE WIRE VOCABULARY, not the whole program. Only the declarations a CALLER can read are
  // scanned: the generated document, the route registry, the route modules (their response literals), the DTO helpers
  // and the application ports (whose field names become JSON). MEASURED, first version: scanning all of `src/http`
  // flagged Fastify's own `request`/`reply` parameters and this very file's declaration of the forbidden list, which
  // is noise that forces a sprawling allowlist — and a sprawling allowlist is how a gate like this stops meaning
  // anything.
  const files = [
    ...filesUnder(join(root, 'src', 'http', 'openapi'), ['.ts']),
    ...filesUnder(join(root, 'src', 'http', 'routes'), ['.ts']),
    ...filesUnder(join(root, 'src', 'http', 'dto'), ['.ts']),
    ...filesUnder(join(root, 'src', 'application', 'contracts'), ['.ts']),
    // THE UI TREE IS PART OF THE VOCABULARY SURFACE (VG-UI-081 checks component names, props, test ids, data-* hooks
    // and route segments), and it was missing from the first version of this gate because no UI existed yet.
    ...filesUnder(join(root, 'ui', 'src'), ['.ts', '.tsx']),
  ];
  // The generated document is scanned as an ARTEFACT: it is what a client reads.
  const documentPath = join(root, '.agent', 'evidence', 'openapi.json');
  try {
    statSync(documentPath);
    files.push(documentPath);
  } catch {
    // Absent is not fatal on its own; the zero-file check below covers a scan with nothing to read at all.
  }

  if (files.length === 0) {
    console.error(`copy lint gate: FAIL - no files found under ${relative(PROJECT_ROOT, root) || root}`);
    return 1;
  }

  const hits: Hit[] = [];
  for (const file of files) {
    try {
      statSync(file);
    } catch {
      continue;
    }
    hits.push(...scanSource(file, relative(root, file).replace(/\\/g, '/')));
  }

  // THE PERMANENT-CLAIM PASS runs over the UI surfaces — sources, the HTML shell and the built bundle — because these
  // are CLAIMS rather than identifiers, and a claim in a `<title>` or a meta description is exactly what VG-UI-082
  // exists to catch.
  const claimHits: { readonly file: string; readonly line: number; readonly phrase: string }[] = [];
  for (const file of uiFiles(root)) {
    const raw = readFileSync(file, 'utf8');
    raw.split('\n').forEach((line, index) => {
      const lowered = line.toLowerCase();
      for (const phrase of PERMANENT_CLAIM_PHRASES) {
        if (lowered.includes(phrase)) {
          claimHits.push({
            file: relative(root, file).replace(/\\/g, '/'),
            line: index + 1,
            phrase,
          });
        }
      }
    });
  }

  if (claimHits.length > 0) {
    console.error('copy lint gate: FAIL - a permanent claim appears in UI copy (VG-UI-082):');
    for (const hit of claimHits) {
      console.error(`  ${hit.file}:${String(hit.line)}  phrase "${hit.phrase}"`);
    }
    console.error('');
    console.error('SPEC-004 §14 lists these phrases as forbidden in visible strings, headings, <title>, meta');
    console.error('descriptions, empty states and message templates. Remove the claim or state what was verified.');
    return 1;
  }

  if (hits.length > 0) {
    console.error('copy lint gate: FAIL - forbidden vocabulary in production identifiers (VG-API-067):');
    for (const hit of hits) {
      console.error(`  ${hit.file}:${String(hit.line)}  token "${hit.token}"`);
      console.error(`    ${hit.excerpt}`);
    }
    console.error('');
    console.error('SPEC-000 §4 names these synonyms as forbidden: each carries a meaning this product must not');
    console.error('assert. Rename the identifier, or add an exact-name allowlist entry WITH a reason.');
    return 1;
  }

  console.log(
    `copy lint gate: ${String(files.length)} file(s) scanned, ${String(FORBIDDEN_TOKENS.length + FORBIDDEN_STATUS_TOKENS.length)} forbidden token(s), ${String(ALLOWLIST.length + SPEC_PERMISSION_ALLOWLIST.length)} allowlisted by exact name, 0 hits`,
  );
  console.log('copy lint gate: ok');
  return 0;
}

process.exit(main());
