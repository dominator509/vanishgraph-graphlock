/**
 * The truth-state presentation equals SPEC-004 §2.2/§2.3, from ONE mapping (VG-UI-007; EP-005 M2).
 *
 * THE SPECIFICATION IS PARSED, NOT COPIED. Both tables are read out of `.agent/specs/SPEC-004-ui-ux.md` at test time:
 * §2.2 for label, qualifier and description, §2.3 for glyph, group and CSS variable. A hand-copied expectation would
 * be a second mapping — the very thing VG-UI-007 forbids — and it would drift in the direction of whatever someone
 * typed.
 *
 * THE NEGATIVE CASE IS A TEST-LOCAL OVERRIDE. The plan requires that rendering `REQUEST_SUBMITTED` with the label
 * "Submitted for removal" FAILS this suite. That is asserted by comparing a deliberately wrong copy object against the
 * same parsed expectation, so the check is demonstrated to be capable of failing — without leaving a second mapping in
 * the source tree (which is what a fixture file under `ui/src/` would be).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  TRUTH_STATE_COPY,
  TRUTH_STATE_TOKENS,
  scopeSuffix,
  type TruthStateToken,
} from '../../ui/src/copy/truth-state.ts';
import { SERVICE_SCOPE_STATEMENT } from '../../ui/src/copy/service-scope.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SPEC = join(PROJECT_ROOT, '.agent', 'specs', 'SPEC-004-ui-ux.md');

/** Whitespace normalisation, as the plan requires: line wrapping in a table cell is not copy. */
function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** The §2.2 rows: machine value, label, qualifier, description. */
function declaredStates(): readonly {
  readonly token: string;
  readonly label: string;
  readonly qualifier: string;
  readonly description: string;
}[] {
  const rows: { token: string; label: string; qualifier: string; description: string }[] = [];
  for (const line of readFileSync(SPEC, 'utf8').split('\n')) {
    // The cells contain no pipe characters, which is what makes this parse exact rather than approximate.
    const match = /^\| \d+ \| `([A-Z_]+)` \| ([^|]+) \| "([^"]+)" \| ([^|]+) \|$/.exec(line);
    if (match === null) continue;
    rows.push({
      token: match[1] ?? '',
      label: normalise(match[2] ?? ''),
      qualifier: normalise(match[3] ?? ''),
      description: normalise(match[4] ?? ''),
    });
  }
  return rows;
}

/** The §2.3 rows: machine value, token name, glyph, group. */
function declaredTokens(): readonly {
  readonly token: string;
  readonly cssVar: string;
  readonly glyph: string;
  readonly group: string;
}[] {
  const rows: { token: string; cssVar: string; glyph: string; group: string }[] = [];
  for (const line of readFileSync(SPEC, 'utf8').split('\n')) {
    const match = /^\| `([A-Z_]+)` \| `(--vg-state-[a-z]+)` \| `#[0-9A-F]{6}` \| `#[0-9A-F]{6}` \| `([^`]+)` [^|]*\| `([a-z]+)` \|$/.exec(
      line,
    );
    if (match === null) continue;
    rows.push({
      token: match[1] ?? '',
      cssVar: match[2] ?? '',
      // The glyph cell is `◇ hollow diamond`: the glyph is its first token.
      glyph: normalise(match[3] ?? '').split(' ')[0] ?? '',
      group: match[4] ?? '',
    });
  }
  return rows;
}

describe('the eleven states render the specification copy byte-for-byte', () => {
  test('both specification tables parse to exactly eleven rows', () => {
    assert.equal(declaredStates().length, 11, 'SPEC-004 §2.2 must declare eleven states');
    assert.equal(declaredTokens().length, 11, 'SPEC-004 §2.3 must declare eleven tokens');
  });

  test('label, qualifier and description equal §2.2 for every state', () => {
    const declared = declaredStates();
    for (const row of declared) {
      const copy = TRUTH_STATE_COPY[row.token as TruthStateToken];
      assert.ok(copy !== undefined, `${row.token} is missing from TRUTH_STATE_COPY`);
      assert.equal(normalise(copy.label), row.label, `${row.token}: label`);
      assert.equal(normalise(copy.qualifier), row.qualifier, `${row.token}: qualifier`);
      assert.equal(normalise(copy.description), row.description, `${row.token}: description`);
    }
  });

  test('glyph, group and CSS variable equal §2.3 for every state', () => {
    for (const row of declaredTokens()) {
      const copy = TRUTH_STATE_COPY[row.token as TruthStateToken];
      assert.ok(copy !== undefined, `${row.token} is missing from TRUTH_STATE_COPY`);
      assert.equal(copy.glyph, row.glyph, `${row.token}: glyph`);
      assert.equal(copy.group, row.group, `${row.token}: group`);
      assert.equal(copy.cssVar, row.cssVar, `${row.token}: cssVar`);
    }
  });

  test('the mapping has exactly eleven keys, no extras and no omissions', () => {
    const keys = Object.keys(TRUTH_STATE_COPY);
    assert.equal(keys.length, 11);
    assert.deepEqual([...keys].sort(), [...TRUTH_STATE_TOKENS].sort());
  });

  test('the scope requirement matches §2.4 and the suffix renders as the specification shows', () => {
    for (const token of ['VERIFIED_REMOVED', 'VERIFIED_NOT_PRESENT', 'SEARCH_DELISTED'] as const) {
      assert.equal(TRUTH_STATE_COPY[token].requiresScope, true, `${token} requires a scope`);
      assert.match(TRUTH_STATE_COPY[token].qualifier, /window shown|checked scope|separate effects/);
    }
    for (const token of ['DISCOVERED_CANDIDATE', 'HUMAN_REQUIRED'] as const) {
      assert.equal(TRUTH_STATE_COPY[token].requiresScope, false);
    }
    assert.equal(scopeSuffix({ sourceId: 'EXAMPLE_BROKER', windowDays: 30 }), ' · Source: EXAMPLE_BROKER · window 30d');
    assert.equal(scopeSuffix({}), '', 'an absent scope renders nothing, not "undefined"');
  });

  test('the non-collapse sentences are present, and the two in-flight states are uncounted', () => {
    // VG-UI-011/012 at the copy layer: these exact sentences are what stop a reader collapsing a step into an outcome.
    assert.match(TRUTH_STATE_COPY.REQUEST_SUBMITTED.qualifier, /This is not removal\./);
    assert.match(TRUTH_STATE_COPY.ACKNOWLEDGED.qualifier, /This does not mean deletion occurred\./);
    assert.equal(TRUTH_STATE_COPY.REQUEST_SUBMITTED.group, 'uncounted');
    assert.equal(TRUTH_STATE_COPY.ACKNOWLEDGED.group, 'uncounted');
    assert.equal(TRUTH_STATE_COPY.SEARCH_DELISTED.group, 'verified');
    assert.match(TRUTH_STATE_COPY.SEARCH_DELISTED.qualifier, /Search and Source are separate effects\./);
  });

  test('NEGATIVE CASE: a screen-level override FAILS this comparison', () => {
    // The plan's required negative case, implemented as a test-local wrong copy compared against the SAME parsed
    // expectation. A fixture file under ui/src would be the permanent second mapping VG-UI-007 forbids.
    const overridden = { ...TRUTH_STATE_COPY.REQUEST_SUBMITTED, label: 'Submitted for removal' };
    const declared = declaredStates().find((row) => row.token === 'REQUEST_SUBMITTED');
    assert.ok(declared !== undefined);
    assert.notEqual(normalise(overridden.label), declared.label, 'the override must differ from the specification');
    assert.throws(
      () => assert.equal(normalise(overridden.label), declared.label),
      'the equality check must be capable of failing',
    );
  });

  test('the service-scope statement equals the §11 block quote', () => {
    const lines = readFileSync(SPEC, 'utf8').split('\n');
    const start = lines.findIndex((line) => line.startsWith('**VG-UI-070'));
    const quote: string[] = [];
    for (let index = start; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.startsWith('> ')) quote.push(line.slice(2));
      else if (quote.length > 0) break;
    }
    assert.ok(quote.length > 0, 'the VG-UI-070 block quote must be present');
    assert.equal(normalise(SERVICE_SCOPE_STATEMENT), normalise(quote.join(' ')));
  });

  test('the mapping is declared EXACTLY ONCE across the UI source tree (VG-UI-007)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        const text = readFileSync(full, 'utf8');
        // The declaration is the object literal binding the name; a second one would be a second source of truth.
        if (/export const TRUTH_STATE_COPY\b/.test(text) && !full.endsWith(join('copy', 'truth-state.ts'))) {
          offenders.push(full.replace(`${PROJECT_ROOT}\\`, '').replace(/\\/g, '/'));
        }
        // A truth-state LABEL written outside the canonical module is drift even without the object literal.
        for (const token of TRUTH_STATE_TOKENS) {
          const label = TRUTH_STATE_COPY[token].label;
          if (label.length > 12 && text.includes(label) && !full.endsWith(join('copy', 'truth-state.ts'))) {
            offenders.push(`${full.replace(`${PROJECT_ROOT}\\`, '').replace(/\\/g, '/')} (label of ${token})`);
          }
        }
      }
    };
    walk(join(PROJECT_ROOT, 'ui', 'src'));
    assert.deepEqual(offenders, [], `truth-state copy declared outside the canonical module: ${offenders.join(', ')}`);
  });
});
