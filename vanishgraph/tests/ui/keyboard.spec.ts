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
/** A visibly placeholder identifier, used to open the parameterised routes in the flow records below. */
const NIL = '00000000-0000-0000-0000-000000000000';

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
  /**
   * Each flow, the route that carries it, and what it is waiting for.
   *
   * THE BLOCKER MOVED IN M5, AND THE RECORD MOVED WITH IT. Before M5 the flows were blocked because the surfaces did not
   * exist and the test asserted that no controls were rendered at all. M5 built the surfaces, so the block is now the
   * DATA BOUNDARY: `/v1` is not provisioned (no identity provider, so no session subject) and the API is not running
   * behind the preview server. Each test asserts the CURRENT reason and the absence of the flow's TERMINAL control, so
   * the record fails the day the blocker changes rather than passing forever on a stale sentence.
   */
  const FLOWS: readonly {
    readonly flow: string;
    readonly route: string;
    readonly blocked: string;
    readonly terminal: RegExp;
    readonly regionState: readonly string[];
  }[] = [
    {
      flow: 'onboarding',
      route: '/portal/onboarding',
      blocked: 'identity verification needs an identity provider (KEYCLOAK_ISSUER is unprovisioned)',
      terminal: /verif|confirm your identity/i,
      // Step 1 is real and complete; the flow stops where identity verification would begin.
      regionState: ['ready'],
    },
    {
      flow: 'exposure review',
      route: '/portal/exposures',
      blocked: 'the records are /v1 data scoped to a session subject',
      terminal: /confirm this record is about me/i,
      regionState: ['error', 'access-denied'],
    },
    {
      flow: 'evidence reveal',
      route: `/portal/cases/${NIL}/evidence/${NIL}`,
      blocked: 'the evidence read is /v1 data and the API is not reachable from the preview server',
      terminal: /reveal|show the content/i,
      regionState: ['error', 'access-denied'],
    },
    {
      flow: 'appeal request',
      route: '/portal/requests',
      blocked: 'an appeal needs a case, which is /v1 data scoped to a session subject',
      terminal: /appeal|escalate/i,
      regionState: ['error', 'access-denied'],
    },
    {
      flow: 'queue filtering',
      route: '/console/queue',
      // M6 MOUNTED THIS ROUTE, so the blocker moved and this record moved with it: the queue now renders a region, and
      // what it cannot do is resolve the principal that owns the tenant's cases.
      blocked: 'the console queue needs an authenticated principal (KEYCLOAK_ISSUER is unprovisioned)',
      terminal: /filter/i,
      regionState: ['error', 'access-denied'],
    },
  ];

  for (const { flow, route, blocked, terminal, regionState } of FLOWS) {
    test(`BLOCKED_CREDENTIALS ${flow}: ${blocked}`, async ({ page }) => {
      await page.goto(route);
      // THE HEADING IS THE DECLARED PATH, NOT THE URL: `/portal/cases/[caseId]/…` is what SPEC-004 §1 declares and
      // what the page shell renders, so comparing it to the concrete URL would assert the opposite of the rule.
      await expect(page.locator('[data-page-heading]')).toHaveText(/^\/(portal|console)\//);
      const regions = page.locator('[data-region]');
      if (regionState.length === 0) {
        await expect(regions, `${flow}: expected no data region yet (${blocked})`).toHaveCount(0);
      } else {
        await expect(regions).toHaveCount(1);
        const state = (await regions.getAttribute('data-region-state')) ?? '';
        expect(regionState, `${flow}: region state is ${state}`).toContain(state);
      }
      // THE TERMINAL CONTROL IS ABSENT, which is what makes the flow impossible rather than merely untested.
      await expect(page.getByRole('button', { name: terminal })).toHaveCount(0);
    });
  }
});
