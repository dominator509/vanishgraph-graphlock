/**
 * Contrast, computed from the stylesheets that actually ship (SPEC-004 §10 VG-UI-058; EP-005 M4).
 *
 * WHY THE NUMBERS ARE COMPUTED FROM THE CSS FILES RATHER THAN LISTED HERE. A hand-written table of expected ratios is a
 * second copy of the palette, and it passes on the day someone changes a token while the table still holds the old
 * value. This suite parses `ui/src/tokens/*.css`, reads the declarations the browser will read, and computes the WCAG
 * 2.x contrast ratio for every pair the stylesheet actually creates:
 *
 *   * TEXT ON TINT — `--vg-ink-900` against each of the eleven declared state tints, ≥ 4.5:1 (body text);
 *   * NON-TEXT BOUNDARY — each state hue against its own tint, ≥ 3:1 (VG-UI-058: "non-text state borders … meet 3:1
 *     against their adjacent colours"), which is what makes the state border visible;
 *   * APPLICATION SURFACES — text on each region background, the focus ring, the border and the two accent colours.
 *
 * THE PAIRING IS ALSO CHECKED FOR COMPLETENESS, which is the part a hand-written table always loses: every
 * `--vg-state-*-tint` declared in the token file must be measured, and every `background: var(--vg-state-*-tint)` rule
 * must reference a token that exists. A tint nobody measured is a tint nobody can claim anything about.
 *
 * THE CALCULATOR IS PROVEN ABLE TO FAIL: known values are asserted (black on white is 21:1, a pair below threshold is
 * rejected at the threshold it is below), so a broken formula cannot report every pair as passing.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const TOKENS_DIR = join(PROJECT_ROOT, 'ui', 'src', 'tokens');
const STATE_TOKENS = readFileSync(join(TOKENS_DIR, 'truth-state.css'), 'utf8');
const APP_STYLES = readFileSync(join(TOKENS_DIR, 'app.css'), 'utf8');

/** Hex colours per unit interval, `#RRGGBB` only — the palette declares no other form. */
function channels(hex: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(match !== null, `not a #RRGGBB colour: ${hex}`);
  const value = match[1] ?? '';
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ];
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const linear = channels(hex).map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

/** WCAG 2.x contrast ratio, 1:1 to 21:1. */
export function contrastRatio(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Every `--name: #RRGGBB` declaration in a stylesheet. */
function declaredColours(css: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const match of css.matchAll(/(--vg-[a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    out.set(match[1] ?? '', (match[2] ?? '').toUpperCase());
  }
  return out;
}

const STATE_COLOURS = declaredColours(STATE_TOKENS);
const APP_COLOURS = declaredColours(APP_STYLES);
const ALL_COLOURS = new Map([...STATE_COLOURS, ...APP_COLOURS]);

function colour(name: string): string {
  const value = ALL_COLOURS.get(name);
  assert.ok(value !== undefined, `the palette declares no ${name}`);
  return value;
}

/** The eleven state tints §2.3 declares, as `--vg-state-<name>-tint`. */
function stateTints(): readonly string[] {
  return [...STATE_COLOURS.keys()].filter((name) => name.endsWith('-tint') && !name.includes('error'));
}

describe('the contrast calculator is correct and can fail', () => {
  test('known values', () => {
    assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF')), 21);
    assert.equal(Math.round(contrastRatio('#FFFFFF', '#FFFFFF')), 1);
    // A mid-grey pair: below 4.5 for text and below 3 for a boundary, which is exactly what the thresholds reject.
    assert.ok(contrastRatio('#777777', '#888888') < 1.5);
  });

  test('NEGATIVE CASE: a pair below the body-text threshold fails the same helper', () => {
    assert.equal(contrastRatio('#8A8A8A', '#FFFFFF') >= 4.5, false, 'this pair must not pass as body text');
    assert.equal(contrastRatio('#8A8A8A', '#FFFFFF') >= 3, true, 'and it must pass as a non-text boundary');
  });
});

describe('every declared pair meets its threshold (VG-UI-058)', () => {
  test('body text on every state tint is at least 4.5:1', () => {
    const ink = colour('--vg-ink-900');
    const tints = stateTints();
    // ELEVEN TINTS MUST BE MEASURED, and the count is asserted so a renamed token cannot silently drop a pair.
    assert.equal(tints.length, 11, `expected eleven state tints, found ${tints.join(', ')}`);
    const measured: string[] = [];
    for (const tint of tints) {
      const ratio = contrastRatio(ink, colour(tint));
      measured.push(`${tint} ${ratio.toFixed(2)}:1`);
      assert.ok(
        ratio >= 4.5,
        `text on ${tint} is ${ratio.toFixed(2)}:1, below the 4.5:1 body-text threshold: ${measured.join(' ')}`,
      );
    }
    assert.equal(measured.length, 11);
  });

  test('each state hue is at least 3:1 against its own tint (non-text boundary)', () => {
    const hues = [...STATE_COLOURS.keys()].filter((name) => name.startsWith('--vg-state-') && !name.endsWith('-tint'));
    assert.equal(hues.length, 11, `expected eleven state hues, found ${hues.join(', ')}`);
    for (const hue of hues) {
      const tint = `${hue}-tint`;
      const ratio = contrastRatio(colour(hue), colour(tint));
      assert.ok(ratio >= 3, `${hue} against ${tint} is ${ratio.toFixed(2)}:1, below the 3:1 non-text threshold`);
    }
  });

  test('text on every region background is at least 4.5:1', () => {
    const ink = colour('--vg-ink-900');
    const surfaces = ['--vg-surface', '--vg-surface-muted', '--vg-error-tint', '--vg-gate-tint', '--vg-denied-tint'];
    for (const surface of surfaces) {
      const ratio = contrastRatio(ink, colour(surface));
      assert.ok(ratio >= 4.5, `text on ${surface} is ${ratio.toFixed(2)}:1, below 4.5:1`);
    }
  });

  test('the focus ring, the border and the two accents are at least 3:1 against the surface', () => {
    const surface = colour('--vg-surface');
    for (const name of ['--vg-focus', '--vg-border', '--vg-error', '--vg-gate', '--vg-denied']) {
      const ratio = contrastRatio(colour(name), surface);
      assert.ok(ratio >= 3, `${name} against the surface is ${ratio.toFixed(2)}:1, below the 3:1 non-text threshold`);
    }
  });
});

describe('the pairing is complete and the stylesheet matches the component', () => {
  test('every tint a rule references is a declared token, and every declared tint is measured', () => {
    const referenced = [...`${STATE_TOKENS}\n${APP_STYLES}`.matchAll(/background:\s*var\((--vg-[a-z0-9-]+)\)/g)].map(
      (match) => match[1] ?? '',
    );
    assert.ok(referenced.length >= 5, `expected the stylesheets to reference tokens, found ${String(referenced.length)}`);
    for (const name of referenced) {
      assert.ok(ALL_COLOURS.has(name), `${name} is referenced but never declared`);
    }
    const measured = new Set(stateTints());
    for (const name of STATE_COLOURS.keys()) {
      if (name.endsWith('-tint')) assert.ok(measured.has(name) || name.includes('error'), `${name} is never measured`);
    }
  });

  test('the badge group rules are the five groups the component emits, and nothing else', () => {
    // MEASURED DEFECT THIS ASSERTS AGAINST: the first version of truth-state.css styled eleven per-STATE class names
    // that TruthStateBadge never emits, so three states fell through to the candidate tint and nine rules matched
    // nothing. The badge emits `vg-truth-badge--${group}` and §2.3 declares exactly five groups.
    const groups = [...STATE_TOKENS.matchAll(/\.vg-truth-badge--([a-z]+)\s*\{/g)].map((match) => match[1] ?? '');
    assert.deepEqual([...new Set(groups)].sort(), ['action', 'forbidden', 'reopened', 'uncounted', 'verified']);
  });

  test('the state hue is never the text colour of a badge', () => {
    // VG-UI-058: "State text uses --vg-ink-900 on every state tint so contrast does not depend on a per-state pairing."
    const badgeStart = STATE_TOKENS.indexOf('.vg-truth-badge {');
    const badgeBlock = STATE_TOKENS.slice(badgeStart, STATE_TOKENS.indexOf('}', badgeStart));
    assert.match(badgeBlock, /color:\s*var\(--vg-ink-900\)/);
    assert.equal(/color:\s*var\(--vg-state-/.test(badgeBlock), false);
  });
});
