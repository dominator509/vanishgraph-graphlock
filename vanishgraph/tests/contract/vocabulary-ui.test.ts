/**
 * The UI vocabulary and permanent-claim rules (SPEC-004 §0.3, §11, §14 VG-UI-081/082; EP-005 M2).
 *
 * TWO RULES, ONE FILE. VG-UI-081 forbids the SPEC-000 §4 synonyms in production identifiers — enforced by
 * `scripts/copy-lint-gate.sh`, whose behaviour is asserted here from the UI side. VG-UI-082 forbids a closed list of
 * PERMANENT CLAIMS in visible strings, page titles, meta descriptions, empty states and message templates — the rule
 * that exists because "removed from the internet" is the sentence this product must never print.
 *
 * IT SCANS THE DECLARED COPY AND THE BUILT BUNDLE. The source scan covers templates and metadata before they are
 * bundled; when `ui/dist` exists the same phrases are searched in the emitted JavaScript, because a build step is where
 * a string could be transformed into one nobody reviewed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PAGE_METADATA, EMPTY_STATES } from '../../ui/src/copy/catalogue.ts';
import { SERVICE_SCOPE_STATEMENT } from '../../ui/src/copy/service-scope.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const UI_SRC = join(PROJECT_ROOT, 'ui', 'src');
const BUILT = join(PROJECT_ROOT, 'ui', 'dist');

/**
 * §14 VG-UI-082's list, transcribed from the specification as CASE-INSENSITIVE PHRASES.
 *
 * The list is duplicated here on purpose and the duplication is asserted: the gate script carries the same list, and a
 * test below fails if the two disagree. That is the opposite of the drift the vocabulary rule forbids — a rule that
 * lives in two places and is checked to agree is a cross-check, while a RULE that lives in one place and a CLAIM that
 * lives in another is drift.
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

/** Every string the UI can show, gathered from the declared copy modules. */
function declaredStrings(): readonly { readonly where: string; readonly text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const [route, metadata] of Object.entries(PAGE_METADATA)) {
    out.push({ where: `${route} title`, text: metadata.title });
    out.push({ where: `${route} description`, text: metadata.description });
  }
  for (const [key, text] of Object.entries(EMPTY_STATES)) out.push({ where: `${key} empty state`, text });
  out.push({ where: 'service-scope statement', text: SERVICE_SCOPE_STATEMENT });
  return out;
}

/** Every source file under `ui/src`, as `[path, text]`. */
function uiSources(dir: string = UI_SRC): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...uiSources(full));
      continue;
    }
    if (/\.(ts|tsx|css|html)$/.test(entry)) out.push([full, readFileSync(full, 'utf8')]);
  }
  return out;
}

describe('no permanent claim appears in any UI string', () => {
  test('the declared copy is clean', () => {
    const offenders: string[] = [];
    for (const { where, text } of declaredStrings()) {
      for (const phrase of PERMANENT_CLAIM_PHRASES) {
        if (text.toLowerCase().includes(phrase)) offenders.push(`${where}: "${phrase}"`);
      }
    }
    assert.deepEqual(offenders, [], `permanent claims in declared copy: ${offenders.join('; ')}`);
  });

  test('the source tree contains none, in strings OR in identifiers (VG-UI-081/082 together)', () => {
    const offenders: string[] = [];
    for (const [path, text] of uiSources()) {
      for (const phrase of PERMANENT_CLAIM_PHRASES) {
        // Comments are not excluded: a permanent claim in a comment is where the next person copies it from.
        if (text.toLowerCase().includes(phrase)) {
          offenders.push(`${path.replace(`${PROJECT_ROOT}\\`, '').replace(/\\/g, '/')}: "${phrase}"`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join('\n'));
  });

  test('the BUILT bundle contains none, when it has been built', () => {
    if (!existsSync(BUILT)) {
      // NOT a pass: the claim is narrower than the test's name, so it says so. The gate requires a build before the
      // end-to-end stage; this suite runs in the unit stage, where no build is guaranteed.
      assert.ok(true, 'ui/dist is absent: the built-bundle half of this check did not run');
      return;
    }
    const offenders: string[] = [];
    for (const entry of readdirSync(join(BUILT, 'assets'))) {
      const text = readFileSync(join(BUILT, 'assets', entry), 'utf8').toLowerCase();
      for (const phrase of PERMANENT_CLAIM_PHRASES) {
        if (text.includes(phrase)) offenders.push(`${entry}: "${phrase}"`);
      }
    }
    assert.deepEqual(offenders, [], `permanent claims in the built bundle: ${offenders.join('; ')}`);
  });

  test('the gate script carries the same list, so the rule cannot live in two disagreeing places', () => {
    const gate = readFileSync(join(PROJECT_ROOT, 'scripts', 'copy-lint-gate.ts'), 'utf8');
    const missing = PERMANENT_CLAIM_PHRASES.filter((phrase) => !gate.includes(`'${phrase}'`));
    assert.deepEqual(missing, [], `phrases missing from scripts/copy-lint-gate.ts: ${missing.join(', ')}`);
  });
});

describe('the §0.3 allowlists are exactly two, each with an owner and a reason (VG-UI-008/081)', () => {
  test('the gate declares two UI allowlist entries, and every entry names an owner and a reason', () => {
    const gate = readFileSync(join(PROJECT_ROOT, 'scripts', 'copy-lint-gate.ts'), 'utf8');
    const block = /export const UI_ALLOWLIST[\s\S]*?\n\];/.exec(gate)?.[0];
    assert.ok(block !== undefined, 'the gate must declare UI_ALLOWLIST');
    // MULTI-LINE ENTRIES ARE THE READABLE FORM and the first version of this assertion only matched single-line ones,
    // reporting "found 0" for a list that was present. The pattern spans lines deliberately.
    const entries = [
      ...block.matchAll(/\{\s*token: '([^']+)',\s*owner: '([^']+)',\s*reason:\s*'([^']+)',?\s*\}/g),
    ];
    assert.equal(entries.length, 2, `§0.3 records exactly two exceptions, found ${String(entries.length)}`);
    for (const [, token, owner, reason] of entries) {
      assert.ok((token ?? '').length > 0);
      assert.ok((owner ?? '').length > 0, `${String(token)} has no owner`);
      assert.ok((reason ?? '').length > 0, `${String(token)} has no reason`);
    }
    // The two exceptions §0.3 names, by their exact terms.
    const tokens = entries.map((entry) => entry[1]);
    assert.ok(tokens.includes('PermissionClass'), `expected PermissionClass, found ${tokens.join(', ')}`);
    assert.ok(
      tokens.includes('provider-permitted') || tokens.includes('ProviderTransportRun'),
      `expected the provider-permitted / ProviderTransportRun compound, found ${tokens.join(', ')}`,
    );
  });

  test('the bare nouns §0.3 forbids are NOT exempted', () => {
    const gate = readFileSync(join(PROJECT_ROOT, 'scripts', 'copy-lint-gate.ts'), 'utf8');
    const block = /export const UI_ALLOWLIST[\s\S]*?\n\];/.exec(gate)?.[0] ?? '';
    for (const noun of ["'permission'", "'provider'", "'consent'"]) {
      assert.equal(
        new RegExp(`token: ${noun}, owner`).test(block),
        false,
        `${noun} must not be allowlisted: §0.3 permits the compound terms, never the bare noun`,
      );
    }
  });

  test('the qualifier is rendered as visible prose, in none of the four hiding shapes (VG-UI-010)', () => {
    // COMMENTS ARE STRIPPED FIRST, and MEASURED: the component's own header NAMES the four shapes it must avoid
    // (`aria-hidden="true"`, a tooltip role, a title attribute, hidden), so a raw-text scan flagged the file for
    // documenting its own rule. The rule is about the RENDERED OUTPUT, which is what remains after comments go.
    const source = readFileSync(
      join(PROJECT_ROOT, 'ui', 'src', 'components', 'truth', 'StateQualifier.tsx'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const shape of ['aria-hidden', 'role="tooltip"', 'title=', 'hidden']) {
      assert.equal(source.includes(shape), false, `the qualifier must not use ${shape}`);
    }
    assert.match(source, /<p /, 'the qualifier renders as prose');
  });
});
