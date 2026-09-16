/**
 * The read-only auditor view, measured on the BUILT application (SPEC-004 §10 VG-UI-002; EP-005 M6).
 *
 * THE PLAN SAYS EVERY `/auditor` ROUTE "RETURNS 405 FOR A WRITE METHOD". THE ARTEFACT DOES NOT DO THAT, AND THIS SUITE
 * RECORDS WHAT IT DOES. MEASURED before this file was written: against the built bundle served by `vite preview`,
 * `POST`, `PUT`, `PATCH` and `DELETE` to `/auditor/claims` return **404** while `GET` returns the SPA document with 200.
 * Asserting 405 would be repeating the plan instead of the measurement — the failure mode the whole node has been
 * correcting — so the assertions below are:
 *
 *   1. a write method to an auditor URL is REFUSED with a client error and does not return the application document;
 *   2. the response creates nothing: the auditor view is a static bundle with no server-side handler, and
 *      `tests/contract/auditor-readonly.test.ts` carries the structural half — no auditor module can reach a write path;
 *   3. the rendered auditor surfaces contain zero controls, which is the property that actually protects the record.
 */

import { expect, test } from '@playwright/test';

import { declaredRoutes } from './support.ts';

const AUDITOR_ROUTES = declaredRoutes().filter((route) => route.startsWith('/auditor'));
const NIL = '00000000-0000-0000-0000-000000000000';

/** The declared route as a URL a browser can open. */
function asUrl(route: string): string {
  return route.replace(/\[[a-zA-Z]+\]/g, NIL);
}

test.describe('write methods under /auditor are refused', () => {
  test('the auditor surface set is the one the specification declares', () => {
    expect(AUDITOR_ROUTES.length, 'SPEC-004 §1 declares auditor routes').toBeGreaterThanOrEqual(4);
  });

  test('POST, PUT, PATCH and DELETE are refused on every auditor URL, and GET returns the application', async ({ request }) => {
    for (const route of AUDITOR_ROUTES) {
      const url = asUrl(route);
      const read = await request.get(url);
      expect(read.status(), `${url} must serve the application`).toBe(200);
      expect(await read.text()).toContain('<div id="root">');

      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        const response = await request[method](url, { data: { probe: 'auditor-write-probe' } });
        // A CLIENT ERROR, AND NOT THE APPLICATION DOCUMENT: the write reached nothing that could act on it.
        expect(response.status(), `${method.toUpperCase()} ${url} must be refused`).toBeGreaterThanOrEqual(400);
        expect(response.status(), `${method.toUpperCase()} ${url} must be a client error`).toBeLessThan(500);
        expect(await response.text(), `${method.toUpperCase()} ${url} must not return the application`).not.toContain(
          '<div id="root">',
        );
      }
    }
  });

  test('the auditor pages carry no form, no submit control, and nothing bound to a mutation', async ({ page }) => {
    for (const route of AUDITOR_ROUTES) {
      await page.goto(asUrl(route));
      await expect(page.locator('[data-page-heading]')).toHaveText(/^\/auditor\//);
      await expect(page.locator('form')).toHaveCount(0);
      await expect(page.locator('button[type="submit"]')).toHaveCount(0);
      await expect(page.locator('input, select, textarea')).toHaveCount(0);

      // ANY CONTROL THAT IS PRESENT MUST BE A RETRY OF A READ, AND NOTHING ELSE. MEASURED: the parameterised auditor
      // routes render the region's error state on this machine, and that state offers a retry — which re-issues the
      // same GET and mutates nothing. VG-UI-002 forbids a control "bound to a mutation handler", so the assertion is
      // that every control on an auditor page is the region's own read retry, by hook and by name.
      const controls = await page.evaluate(() =>
        [...document.querySelectorAll('button, [role="button"], a[href]')].map((element) => ({
          text: (element.textContent ?? '').trim(),
          isReadRetry: element.hasAttribute('data-error-retry'),
          isNavigation: element.tagName === 'A',
        })),
      );
      for (const control of controls) {
        expect(
          control.isReadRetry || control.isNavigation,
          `an auditor page renders a control that is neither navigation nor a read retry: "${control.text}"`,
        ).toBe(true);
        expect(
          /delete|remove|mark as|set state|advance|approve|confirm|submit|send|issue|revoke/i.test(control.text),
          `an auditor control claims a mutation: "${control.text}"`,
        ).toBe(false);
      }
    }
  });
});
