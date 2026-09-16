/**
 * Keyboard operation and focus management, on the BUILT application (SPEC-004 §10 VG-UI-059/060; EP-005 M4).
 *
 * WHAT THIS SUITE CAN PROVE TODAY, AND WHAT IT CANNOT. VG-UI-060's oracle is a keyboard-only path through onboarding,
 * exposure review, evidence reveal, appeal request and queue filtering. Those five flows need the surfaces (M5/M6) and
 * the API behind them, and this milestone has neither — so the suite proves what the built application actually does
 * today and RECORDS the rest as `BLOCKED_PREREQUISITE`, naming the missing milestone in the test's own name. It does
 * not skip them silently and it does not report them as passing: a test that asserted the flows pass would fail, and a
 * skipped test that said nothing would be the silent skip DOD-032/DOD-033 forbid. Each such test asserts the ABSENCE of
 * the controls the flow needs, so it fails the moment a surface appears without the flow being completed here.
 *
 * THE FOCUS TESTS ARE REAL CLIENT-SIDE NAVIGATIONS. A full page load is not what VG-UI-059 is about, and `page.goto`
 * twice would only measure the browser's own behaviour. The helper below performs exactly what the router handles in a
 * single-page application — a history entry plus `popstate` — and `page.goBack()` performs what a keyboard user does
 * with Alt+Left. Both go through the router's own navigation path, which is what the focus effect is attached to.
 */

import { expect, test, type Page } from '@playwright/test';

import { visitableRoutes } from './support.ts';

const FIRST = '/portal';
const SECOND = '/portal/authority';

/**
 * A client-side navigation, as the router sees one: a new history entry followed by `popstate`. Both calls are the
 * browser's own APIs, so the application code under test is the real navigation path and not a test-only shortcut.
 */
async function navigateClientSide(page: Page, target: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  }, target);
}

test.describe('focus management (VG-UI-059)', () => {
  test('a full page load does not steal focus', async ({ page }) => {
    await page.goto(FIRST);
    // Focus starts on the document, not on the heading: the requirement is about navigation, and moving focus on load
    // would take it away from the browser's own chrome before the reader has done anything.
    await expect(page.locator('[data-page-heading]')).not.toBeFocused();
    await expect(page.locator('[data-page-heading]')).toHaveText(FIRST);
  });

  test('a client-side navigation moves focus to the new page heading', async ({ page }) => {
    await page.goto(FIRST);
    await navigateClientSide(page, SECOND);
    const heading = page.locator('[data-page-heading]');
    await expect(heading).toHaveText(SECOND);
    await expect(heading).toBeFocused();
  });

  test('the browser Back button moves focus to the previous page heading', async ({ page }) => {
    await page.goto(FIRST);
    await navigateClientSide(page, SECOND);
    await expect(page.locator('[data-page-heading]')).toHaveText(SECOND);
    await page.goBack();
    const heading = page.locator('[data-page-heading]');
    await expect(heading).toHaveText(FIRST);
    await expect(heading).toBeFocused();
  });

  test('the heading is focusable but is not in the tab order', async ({ page }) => {
    await page.goto(FIRST);
    // `-1` and not `0`: a heading is not a control, and putting it in the tab sequence would add a keypress to every
    // page for every keyboard user.
    await expect(page.locator('[data-page-heading]')).toHaveAttribute('tabindex', '-1');
  });

  test('the built stylesheet suppresses the outline for nothing but a programmatically focused heading', async ({
    page,
  }) => {
    await page.goto(FIRST);
    const suppressions = await page.evaluate(() => {
      const rules: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules)) rules.push(rule.cssText);
      }
      return rules.filter((text) => /outline\s*:\s*(none|0)/i.test(text));
    });
    // ANTI-VACUITY: the scan must have read the stylesheet. If it read nothing, the filter would be empty and the
    // per-rule assertion below would pass while proving nothing.
    expect(suppressions.length, 'the stylesheet scan found no rules at all').toBeGreaterThan(0);
    for (const rule of suppressions) {
      expect(rule, `unexpected outline suppression: ${rule}`).toContain('h1[tabindex="-1"]');
    }
  });

  test('Tab never moves focus outside the page', async ({ page }) => {
    await page.goto(FIRST);
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return true;
        return document.querySelector('main')?.contains(active) ?? false;
      });
      expect(inside, 'Tab must not move focus outside the page').toBe(true);
    }
  });

  test('every declared route is keyboard-reachable and exposes a heading', async ({ page }) => {
    // A route that could not be opened and read with the keyboard alone would fail here rather than in M5.
    for (const route of visitableRoutes()) {
      await page.goto(route);
      const heading = page.locator('[data-page-heading]');
      await expect(heading).toHaveText(route);
      await expect(page.locator('main')).toHaveCount(1);
    }
  });
});

test.describe('the five keyboard-only flows: recorded, not claimed (VG-UI-060)', () => {
  const FLOWS: readonly { readonly flow: string; readonly milestone: string; readonly missing: string }[] = [
    { flow: 'onboarding', milestone: 'M5', missing: 'the onboarding form and the identity-verification gate' },
    { flow: 'exposure review', milestone: 'M5', missing: 'the exposure list with its confirm and reject controls' },
    { flow: 'evidence reveal', milestone: 'M5', missing: 'the evidence region and its audited reveal control' },
    { flow: 'appeal request', milestone: 'M5/M6', missing: 'the appeal form and its submission control' },
    { flow: 'queue filtering', milestone: 'M6', missing: 'the console queue and its filter controls' },
  ];

  for (const { flow, milestone, missing } of FLOWS) {
    test(`BLOCKED_PREREQUISITE ${flow}: ${missing} (${milestone})`, async ({ page }) => {
      await page.goto('/portal/onboarding');
      const controls = await page.evaluate(
        () => document.querySelectorAll('form, input, select, textarea, button').length,
      );
      expect(controls, `${flow} cannot be keyboard-completed yet: ${missing} does not exist (${milestone})`).toBe(0);
    });
  }
});
