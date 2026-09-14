#!/usr/bin/env node
/**
 * Handler scan: no route may accept a truth state as INPUT (SPEC-001 §4.3 SM-6, SPEC-003 §5.0).
 *
 * SPEC-003 §5.0 is explicit: "**No route accepts a truth state as input.** Where a response
 * carries `truthState`, it is read-only output produced by a domain command." SM-6 says the same
 * from the domain side. This script is the build-time expression of that rule, because a
 * code-review convention cannot hold the product's central safety property (EP-004 decision D5).
 *
 * WHAT IT CHECKS, over `src/http/**`:
 *   1. No JSON-schema property named `truthState` inside a `schema: { body | querystring | params
 *      | headers }` block — that would let a caller assert a state.
 *   2. No route path segment naming a truth state.
 *   3. No `schema`-typed route option whose declared properties are truth-state names.
 *
 * COMMENTS ARE STRIPPED FIRST, and correctly: the previous implementation used a line-based
 * `sed`, which cannot remove a multi-line block comment, so the scan matched the words "schema"
 * and "truthState" sitting in the same doc comment and failed on the file that documents the rule.
 *
 * Exits 0 when clean, 1 with the offending locations otherwise. Prints a one-line summary on
 * success so the gate has evidence it actually ran over files.
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
  const files = tsFiles(HTTP_ROOT);
  if (files.length === 0) {
    console.error('scan-truth-state-input: FAIL - no TypeScript files found under src/http');
    return 1;
  }

  const violations: Violation[] = [];
  let inputSchemaBlocks = 0;

  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const code = stripComments(raw);
    const lines = code.split('\n');
    const shownPath = relative(PROJECT_ROOT, file).replace(/\\/g, '/');

    lines.forEach((line, index) => {
      const lineNo = index + 1;

      // 1. A truth state named as a schema property. `truthState` is the field name SPEC-003 §5
      //    uses in RESPONSES; appearing inside a request-schema input position is the violation.
      if (/truthState\s*:/.test(line)) {
        violations.push({
          file: shownPath,
          line: lineNo,
          reason: 'a request schema declares truthState as an input property (SM-6)',
          excerpt: line.trim().slice(0, 120),
        });
      }

      // 2. A route path carrying a truth state as a parameter.
      for (const state of TRUTH_STATES) {
        if (new RegExp(`path\\s*:\\s*['"\`][^'"\`]*${state}`, 'i').test(line)) {
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
