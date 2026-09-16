#!/usr/bin/env node
/**
 * Handler scan: no route may accept a truth state as INPUT (SPEC-001 §4.3 SM-6, SPEC-003 §5.0).
 *
 * SPEC-003 §5.0 is explicit: "**No route accepts a truth state as input.** Where a response
 * carries `truthState`, it is read-only output produced by a domain command." SM-6 says the same
 * from the domain side. This script is the build-time expression of that rule, because a
 * code-review convention cannot hold the product's central safety property (EP-004 decision D5).
 *
 * WHAT IT CHECKS, over the scanned root:
 *   1. No JSON-schema property named `truthState` inside a REQUEST-side schema block — a `body:`,
 *      `querystring:`, `params:` or `headers:` object, including a `properties:` block inside one.
 *      That would let a caller assert a state.
 *   2. No route path segment naming a truth state.
 *   3. The number of input-schema blocks is reported, so the gate has evidence the rule had
 *      something to look at rather than passing over an empty match.
 *
 * RULE 1 IS POSITIONAL, AND IT WAS NOT BEFORE. MEASURED DEFECT this corrects: the rule was
 * `if (/truthState\s*:/ .test(line))` — a bare line match that flagged ANY occurrence anywhere in
 * `src/http/**`, including the RESPONSE literals the rule's own doc comment says are legitimate
 * (`truthState: outcome.truthState`), a helper's parameter type, and a function signature. Six such
 * hits kept `gate-api.sh` red for several milestone commits, and since every hit was in a file this
 * repository had already accepted, the gate could not be told apart from a broken one. The rule now
 * tracks REQUEST-side blocks by brace depth and flags a `truthState` property only inside one, which
 * is what the doc comment above always claimed. It is a REPAIR, not a relaxation: a `truthState`
 * property in a body/querystring/params/headers schema is still a violation, and
 * `tests/harness/truth-state-scan.test.ts` proves both directions against fixture trees.
 *
 * COMMENTS ARE STRIPPED FIRST, and correctly: the previous implementation used a line-based
 * `sed`, which cannot remove a multi-line block comment, so the scan matched the words "schema"
 * and "truthState" sitting in the same doc comment and failed on the file that documents the rule.
 *
 * Exits 0 when clean, 1 with the offending locations otherwise. Prints a one-line summary on
 * success so the gate has evidence it actually ran over files.
 *
 * Usage: `node scripts/scan-truth-state-input.ts [--root <dir>]`. The optional root exists so a
 * test can point the scan at a FIXTURE tree and assert that a real violation still fails — the
 * property that a scan with no way to demonstrate a failure cannot be trusted to have one.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const HTTP_ROOT = join(PROJECT_ROOT, 'src', 'http');

/** Remove block and line comments, preserving newlines so line numbers stay accurate. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let inString: string | null = null;

  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';

    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }

    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    if (inString !== null) {
      out += ch;
      if (ch === '\\') {
        out += next;
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlock = true;
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** The eleven canonical truth states plus the state-shaped names a caller might try to pass. */
const TRUTH_STATES = [
  'DISCOVERED_CANDIDATE', 'SEARCH_HIT', 'MATCH_CONFIRMED', 'REQUEST_READY',
  'REQUEST_SUBMITTED', 'ACKNOWLEDGED', 'HUMAN_REQUIRED', 'SEARCH_DELISTED',
  'VERIFIED_REMOVED', 'VERIFIED_NOT_PRESENT', 'NOT_REMOVABLE',
];

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  readonly excerpt: string;
}

/**
 * Count braces ACROSS A WHOLE FILE, tracking string context between lines, and report for each line whether a
 * REQUEST-side schema is open at its start.
 *
 * PER-LINE COUNTING WAS NOT ENOUGH, and MEASURED: the first positional version counted braces on each line in
 * isolation, so a line INSIDE a multi-line template literal — this repository builds SQL that way — had its `${…}`
 * interpolations and its quoted `'{}'::jsonb` literals read as structure. Depth drifted, an input block never
 * closed, and the six original false positives survived the "fix". String state, including backtick templates,
 * therefore has to persist from one line to the next, which is what this function does.
 *
 * AND A REQUEST SCHEMA IS `schema: { body: … }`, NOT ANY `body:`. MEASURED, second round: with a bare `body:` key
 * this scan still failed on `return { status: 201, body: { … truthState: outcome.truthState … } }` — the RESPONSE
 * payload this repository's idempotent-write helper returns. `body:` means a request schema only inside a
 * `schema:` option, so both are tracked and a hit needs BOTH.
 */
function analyseLines(code: string): { readonly text: string; readonly inputOpenAtStart: boolean }[] {
  const out: { text: string; inputOpenAtStart: boolean }[] = [];
  const schemaDepths: number[] = [];
  const inputDepths: number[] = [];
  let depth = 0;
  let quote: string | null = null;

  for (const text of code.split('\n')) {
    out.push({ text, inputOpenAtStart: schemaDepths.length > 0 && inputDepths.length > 0 });
    const depthAtLineStart = depth;
    const opensSchema = SCHEMA_OPTION.test(text);
    const opensInput = INPUT_SCHEMA_KEY.test(text);

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i] ?? '';
      if (quote !== null) {
        if (ch === '\\') {
          i += 1;
          continue;
        }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }

    // A block opened on this line began at the depth the line STARTED with; a block that also closed on this line is
    // popped immediately, and the one-line form is handled by the caller's explicit ordering check.
    if (opensSchema) schemaDepths.push(depthAtLineStart);
    if (opensInput) inputDepths.push(depthAtLineStart);
    while (schemaDepths.length > 0 && depth <= (schemaDepths[schemaDepths.length - 1] ?? 0)) schemaDepths.pop();
    while (inputDepths.length > 0 && depth <= (inputDepths[inputDepths.length - 1] ?? 0)) inputDepths.pop();
  }
  return out;
}

/** A Fastify `schema:` route option — the only place a request schema is declared. */
const SCHEMA_OPTION = /\bschema\s*:\s*\{/;
/** The keys that introduce a REQUEST-side schema. A `truthState` property inside one is the violation. */
const INPUT_SCHEMA_KEY = /\b(?:body|querystring|params|headers)\s*:\s*\{/;
/** A truth-state property of any spelling the contract uses. */
const TRUTH_STATE_PROPERTY = /truthState\s*:/;
/**
 * A handler READING a truth state out of request input.
 *
 * THE SECOND HALF OF THE RULE, and the half that protects THIS codebase: no route here declares a Fastify `schema:`
 * option at all (measured — `schema:` appears in `src/http` only in this script's own prose and in the query-filter
 * parser's parameter name), because bodies are parsed by hand. So a rule that only inspected `schema:` blocks would
 * pass every file while a handler could still do `body['truthState']`. This matches request-input ACCESS only:
 * `body.truthState`, `query['truthState']`, `request.params.truthState` and the like — never a response literal and
 * never a helper's parameter, which is what keeps it from repeating the defect it exists to fix.
 */
const TRUTH_STATE_INPUT_READ =
  /\b(?:body|query|querystring|params|headers)\s*(?:\.\s*truthState\b|\[\s*['"`]truthState['"`]\s*\])/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

function main(): number {
  // `--root` exists for the test that proves the rule can still FAIL. It is a path, never a pattern, so it cannot
  // widen the scan to a tree nobody reviewed.
  const rootFlag = process.argv.indexOf('--root');
  const root = rootFlag === -1 ? HTTP_ROOT : resolve(process.argv[rootFlag + 1] ?? HTTP_ROOT);
  const files = tsFiles(root);
  if (files.length === 0) {
    console.error(`scan-truth-state-input: FAIL - no TypeScript files found under ${root}`);
    return 1;
  }

  const violations: Violation[] = [];
  let inputSchemaBlocks = 0;

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const code = stripComments(raw);
    const shownPath = relative(PROJECT_ROOT, file).replace(/\\/g, '/');

    analyseLines(code).forEach(({ text: line, inputOpenAtStart }, index) => {
      const lineNo = index + 1;
      const keyMatch = INPUT_SCHEMA_KEY.exec(line);
      const propertyMatch = TRUTH_STATE_PROPERTY.exec(line);

      // 1. A truth state named as a property of a REQUEST schema.
      //
      //    INSIDE AN OPEN INPUT BLOCK, or on the same line as the keys that open one and AFTER them — the second case
      //    catches the one-line form `schema: { body: { type: 'object', properties: { truthState: … } } }`, the first
      //    catches a multi-line schema including its `properties:` block.
      const afterKeyOnSameLine =
        keyMatch !== null &&
        propertyMatch !== null &&
        (propertyMatch.index ?? 0) > (keyMatch.index ?? 0);
      if (propertyMatch !== null && (inputOpenAtStart || afterKeyOnSameLine)) {
        violations.push({
          file: shownPath,
          line: lineNo,
          reason: 'a request schema declares truthState as an input property (SM-6)',
          excerpt: line.trim().slice(0, 120),
        });
      }

      // 1b. A handler reading a truth state OUT OF request input — the form this codebase can actually commit,
      //     because it parses bodies by hand rather than declaring a schema.
      if (TRUTH_STATE_INPUT_READ.test(line)) {
        violations.push({
          file: shownPath,
          line: lineNo,
          reason: 'a handler reads truthState from request input (SM-6)',
          excerpt: line.trim().slice(0, 120),
        });
      }

      // 2. A route path carrying a truth state as a parameter — in EITHER of the two forms a path is declared here:
      //    the registry's `path: '…'` entry, and a direct `app.get('/…')` registration. MEASURED: with only the
      //    first form the rule missed `app.get('/v1/things/MATCH_CONFIRMED', handler)`, which is why the test's
      //    fixture uses a registration rather than trusting the registry to be the only place a path appears.
      for (const state of TRUTH_STATES) {
        const declared = new RegExp(`path\\s*:\\s*['"\`][^'"\`]*${state}`, 'i').test(line);
        const registered = new RegExp(
          `\\bapp\\s*\\.\\s*(?:get|post|patch|put|delete|all)\\s*\\(\\s*['"\`][^'"\`]*${state}`,
          'i',
        ).test(line);
        if (declared || registered) {
          violations.push({
            file: shownPath,
            line: lineNo,
            reason: `a route path names truth state ${state}`,
            excerpt: line.trim().slice(0, 120),
          });
        }
      }
    });

    inputSchemaBlocks += (code.match(/\b(querystring|params|headers)\s*:/g) ?? []).length;
  }

  if (violations.length > 0) {
    console.error('scan-truth-state-input: FAIL - a route accepts a truth state as input');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.reason}`);
      console.error(`    ${v.excerpt}`);
    }
    console.error('');
    console.error('SPEC-003 §5.0: "No route accepts a truth state as input." A truth state is the');
    console.error('output of a guarded domain command (SPEC-001 SM-6), never a client assertion.');
    return 1;
  }

  console.log(
    `scan-truth-state-input: ${files.length} http file(s) scanned, ${inputSchemaBlocks} input-schema block(s), 0 violations`,
  );
  return 0;
}

process.exit(main());
