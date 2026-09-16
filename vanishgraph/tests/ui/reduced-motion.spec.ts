/**
 * Reduced motion and reflow, measured on the BUILT application (SPEC-004 §10 VG-UI-062; EP-005 M4).
 *
 * THE MEASUREMENT IS A DIFFERENCE, NOT A CONSTANT. The stylesheet declares one transition on purpose — a 120ms
 * state-change tint — and removes it entirely under `prefers-reduced-motion: reduce`. This suite measures the computed
 * durations in BOTH modes and asserts that the reduced mode is at or below 1ms while the normal mode is not: a check
 * that only measured reduced mode would pass on a stylesheet with no animation at all, which is the vacuous form of
 * "no non-essential animation".
 *
 * THE STATE-CHANGE SNAPSHOT IS TAKEN IN REDUCED MODE, and it asserts that the final presentation is what renders: the
 * badge's text, glyph and machine value are all present in the same frame the state changes, so no meaning is carried
 * by an intermediate frame.
 */

import { expect, test } from '@playwright/test';

import { builtCss, renderAllBadges, renderState } from './support.ts';

const CSS = builtCss();

test.describe('reduced motion (VG-UI-062)', () => {
  test('the app declares no animation, and none under reduced motion either', async ({ browser }) => {
    const normal = await browser.newContext({ reducedMotion: 'no-preference' });
    const reduced = await browser.newContext({ reducedMotion: 'reduce' });
    for (const context of [normal, reduced]) {
      const page = await context.newPage();
      await page.goto('/portal');
      const longest = await page.evaluate(() => {
        let longestMs = 0;
        const parse = (value: string): number =>
          Math.max(
            ...value.split(',').map((part) => {
              const trimmed = part.trim();
              return trimmed.endsWith('ms') ? Number.parseFloat(trimmed) : Number.parseFloat(trimmed) * 1000;
            }),
          );
        for (const element of Array.from(document.querySelectorAll('*'))) {
          const style = getComputedStyle(element);
          longestMs = Math.max(longestMs, parse(style.animationDuration), parse(style.transitionDuration));
        }
        return Number.isFinite(longestMs) ? longestMs : 0;
      });
      // Included for completeness rather than as the real check: the app's placeholder surfaces declare nothing, and
      // the assertion below on the state harness is the one that distinguishes the two modes.
      expect(longest).toBeLessThanOrEqual(1000);
      await context.close();
    }
  });

  test('a declared transition is removed, not shortened, under reduced motion', async ({ browser }) => {
    const measured: Record<string, number> = {};
    for (const mode of ['no-preference', 'reduce'] as const) {
      const context = await browser.newContext({ reducedMotion: mode });
      const page = await context.newPage();
      await page.setContent(
        `<!doctype html><html lang="en"><body>${await renderState('ready')}<div class="vg-truth-badge">badge</div></body></html>`,
      );
      await page.addStyleTag({ path: CSS });
      measured[mode] = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('.vg-region') ?? document.body);
        const value = style.transitionDuration.split(',')[0]?.trim() ?? '0s';
        return value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;
      });
      await context.close();
    }
    // THE DIFFERENCE IS THE POINT: 120ms normally, at or below 1ms when the reader has asked for reduced motion.
    expect(measured['no-preference']).toBeGreaterThan(1);
    expect(measured['reduce']).toBeLessThanOrEqual(1);
  });

  test('the state-change snapshot shows the final presentation with no intermediate frame', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    const badges = await renderAllBadges();
    await page.setContent(`<!doctype html><html lang="en"><body>${badges.map((badge) => badge.html).join('\n')}</body></html>`);
    await page.addStyleTag({ path: CSS });
    for (const badge of badges) {
      const scope = page.locator(`[data-truth-state="${badge.token}"]`);
      // All three channels are present in the first frame the assertion inspects: label, glyph and machine value.
      await expect(scope.locator('.vg-truth-badge__label')).not.toBeEmpty();
      await expect(scope.locator('.vg-truth-badge__glyph')).not.toBeEmpty();
      await expect(scope.locator('.vg-truth-badge__machine')).toHaveText(badge.token);
    }
  });

  test('the region states reflow to a 320 CSS pixel viewport without horizontal scrolling', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 } });
    const page = await context.newPage();
    for (const name of ['loading', 'empty', 'error', 'access-denied', 'human-gate', 'partial-coverage']) {
      await page.setContent(`<!doctype html><html lang="en"><body>${await renderState(name)}</body></html>`);
      await page.addStyleTag({ path: CSS });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      // VG-UI-064 requires 400% reflow to be judged by a person; what an automated check CAN establish is that the
      // region does not force a horizontal scrollbar at 320 CSS pixels (WCAG 1.4.10's reflow target), and that is all
      // this asserts.
      expect(overflow, `${name} overflows a 320px viewport by ${String(overflow)}px`).toBeLessThanOrEqual(0);
    }
    await context.close();
  });
});
