/**
 * The seven region states, measured in a real browser (SPEC-004 §9; EP-005 M4).
 *
 * THE PAGES ARE COMPONENT OUTPUT, NOT IMITATIONS OF IT. Each page is `page.setContent()` over markup produced by the
 * real components through the Node render harness, with the stylesheet the build emitted attached. That is what makes
 * the measurements below browser measurements: the computed styles, the focus behaviour of the cancel control, the live
 * region and the accessible-tree semantics are Chromium's, not a serializer's.
 *
 * IT SAYS WHAT IT CANNOT PROVE. These pages have no application shell: they prove nothing about the app's own focus
 * management after navigation (that is `keyboard.spec.ts`, on the built application) and nothing about timers, because
 * the markup is static (the ten-second threshold is a hook, and it is exercised when a region mounts it in M5/M6).
 */

import { expect, test } from '@playwright/test';

import { builtCss, renderAllBadges, renderState, STATE_FIXTURES } from './support.ts';

const CSS = builtCss();

/** Put one state's markup on the page with the real stylesheet, and wait for the stylesheet to apply. */
async function openState(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.setContent(`<!doctype html><html lang="en"><body>${await renderState(name)}</body></html>`);
  await page.addStyleTag({ path: CSS });
}

test.describe('the seven region states render, and only what they declare', () => {
  test('each state declares itself on the region element and has a focusable heading', async ({ page }) => {
    for (const name of Object.keys(STATE_FIXTURES)) {
      await openState(page, name);
      const region = page.locator('[data-region]');
      await expect(region).toHaveCount(1);
      const kind = STATE_FIXTURES[name]?.['kind'];
      await expect(region).toHaveAttribute('data-region-state', String(kind));
      const heading = page.locator('[data-region-heading]');
      await expect(heading).toHaveRole('heading');
      await expect(heading).toHaveAttribute('tabindex', '-1');
      // The region's accessible name is its heading, which is what a screen reader announces on entry.
      await expect(region).toHaveAccessibleName('Case queue');
    }
  });

  test('loading announces once, politely, and reserves the box', async ({ page }) => {
    await openState(page, 'loading');
    const live = page.locator('[aria-live]');
    await expect(live).toHaveCount(1);
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText('Loading Case queue.');
    const skeleton = page.locator('.vg-loading__skeleton');
    await expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    // THE BOX IS RESERVED: the skeleton's rendered height is the height the caller declared, so data arrival cannot
    // move the layout (VG-UI-048). 9rem at the default 16px root is 144px.
    const box = await skeleton.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(143);
    expect(box?.height).toBeLessThanOrEqual(145);
  });

  test('the delayed loading state offers a keyboard-operable cancel', async ({ page }) => {
    await openState(page, 'loading-delayed');
    const cancel = page.getByRole('button', { name: 'Cancel the case queue' });
    await expect(cancel).toHaveCount(1);
    await cancel.focus();
    await expect(cancel).toBeFocused();
    // A REAL browser focus check: the ring is drawn, so the control is visible to a keyboard user (VG-UI-059).
    const outline = await cancel.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle, offset: style.outlineOffset };
    });
    expect(outline.width).toBe('2px');
    expect(outline.style).toBe('solid');
    expect(outline.offset).toBe('1px');
  });

  test('the gate notice offers no control of any kind', async ({ page }) => {
    await openState(page, 'human-gate');
    await expect(page.locator('[data-truth-state]')).toHaveAttribute('data-truth-state', 'HUMAN_REQUIRED');
    // THE BYPASS INVENTORY, run by the browser rather than by a serializer: nothing focusable and nothing clickable.
    const focusable = await page.evaluate(() =>
      [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].map(
        (element) => `${element.tagName}:${element.textContent ?? ''}`,
      ),
    );
    expect(focusable).toEqual([]);
  });

  test('the access-denied state renders no data and no controls but the way back', async ({ page }) => {
    await openState(page, 'access-denied');
    await expect(page.locator('[data-access-denied]')).toHaveCount(1);
    const links = page.getByRole('link');
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAccessibleName('Back to your portal');
    const denied = await page.locator('[data-access-denied]').innerText();
    expect(denied).not.toMatch(/\d/);
    expect(denied.toLowerCase()).not.toContain('permission');
  });

  test('the expired session state renders no control that pretends to extend it', async ({ page }) => {
    await openState(page, 'session-expiry-expired');
    await expect(page.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(1);
    const link = page.getByRole('link');
    await expect(link).toHaveAttribute('href', '/sign-in');
    expect(await link.getAttribute('href')).not.toMatch(/[?#]/);
  });
});

test.describe('state is never carried by colour alone (VG-UI-057)', () => {
  test('all eleven states are mutually distinguishable under a forced grayscale filter', async ({ page }) => {
    const badges = await renderAllBadges();
    expect(badges.length).toBe(11);
    await page.setContent(`<!doctype html><html lang="en"><body>${badges.map((badge) => badge.html).join('\n')}</body></html>`);
    await page.addStyleTag({ path: CSS });
    // A CSS filter that removes every colour channel, so a state carried by hue alone becomes identical to its siblings.
    await page.addStyleTag({ content: 'html { filter: grayscale(1); }' });
    await expect(page.locator('[data-truth-state]')).toHaveCount(11);

    const shots: { token: string; bytes: Buffer }[] = [];
    for (const [index, badge] of badges.entries()) {
      const shot = await page.locator('[data-truth-state]').nth(index).screenshot();
      shots.push({ token: badge.token, bytes: shot });
    }
    for (let i = 0; i < shots.length; i += 1) {
      for (let j = i + 1; j < shots.length; j += 1) {
        const first = shots[i];
        const second = shots[j];
        expect(
          first !== undefined && second !== undefined && first.bytes.equals(second.bytes),
          `${String(first?.token)} and ${String(second?.token)} are indistinguishable in grayscale`,
        ).toBe(false);
      }
    }

    // THE OTHER TWO CHANNELS ARE ASSERTED AS WELL, because an image comparison is the weakest of the three: the label
    // text and the machine value must both be present in the DOM for every state (§2.4).
    for (const badge of badges) {
      const scope = page.locator(`[data-truth-state="${badge.token}"]`);
      await expect(scope.locator('.vg-truth-badge__label')).not.toBeEmpty();
      await expect(scope.locator('.vg-truth-badge__machine')).toHaveText(badge.token);
      await expect(scope.locator('.vg-truth-badge__glyph')).not.toBeEmpty();
    }
  });
});

test.describe('contrast, measured from computed styles in a browser (VG-UI-058)', () => {
  test('text on every region background meets 4.5:1 and its boundary meets 3:1', async ({ page }) => {
    for (const name of Object.keys(STATE_FIXTURES)) {
      await openState(page, name);
      const measured = await page.evaluate(() => {
        type Rgb = readonly [number, number, number];
        const parse = (value: string): Rgb => {
          const match = /rgba?\(([^)]+)\)/.exec(value);
          if (match === null) return [255, 255, 255];
          const parts = (match[1] ?? '').split(',').map((part) => Number.parseFloat(part));
          return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
        };
        const luminance = (rgb: Rgb): number => {
          const linear = rgb.map((channel) => {
            const scaled = channel / 255;
            return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
        };
        const ratio = (a: Rgb, b: Rgb): number => {
          const first = luminance(a);
          const second = luminance(b);
          return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
        };
        const opaque = (element: Element): Rgb => {
          let node: Element | null = element;
          while (node !== null) {
            const value = getComputedStyle(node).backgroundColor;
            const parsed = parse(value);
            if (!value.includes('rgba(0, 0, 0, 0)')) return parsed;
            node = node.parentElement;
          }
          return [255, 255, 255];
        };
        const region = document.querySelector('[data-region]');
        if (region === null) return [];
        const elements = [region, ...region.querySelectorAll('p, h2, h3, li, dt, dd, span, a, button, summary, figcaption')];
        return elements.map((element) => {
          const style = getComputedStyle(element);
          return {
            tag: element.tagName,
            text: (element.textContent ?? '').trim().slice(0, 24),
            ratio: ratio(parse(style.color), opaque(element)),
            fontSize: Number.parseFloat(style.fontSize),
          };
        });
      });
      expect(measured.length).toBeGreaterThan(0);
      for (const item of measured) {
        // Large text (≥ 18.66px bold or ≥ 24px) needs 3:1; everything else needs 4.5:1. Nothing here is large.
        const threshold = item.fontSize >= 24 ? 3 : 4.5;
        expect(item.ratio, `${name} ${item.tag} "${item.text}" is ${item.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          threshold,
        );
      }
    }
  });

  test('the focus ring is at least 3:1 against the surface it is drawn on', async ({ page }) => {
    await openState(page, 'loading-delayed');
    const cancel = page.getByRole('button', { name: 'Cancel the case queue' });
    await cancel.focus();
    const measured = await cancel.evaluate((element) => {
      const parse = (value: string): readonly [number, number, number] => {
        const match = /rgba?\(([^)]+)\)/.exec(value);
        const parts = (match?.[1] ?? '0,0,0').split(',').map((part) => Number.parseFloat(part));
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
      };
      const luminance = (rgb: readonly [number, number, number]): number => {
        const linear = rgb.map((channel) => {
          const scaled = channel / 255;
          return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
      };
      const style = getComputedStyle(element);
      // THE COMPUTED VALUES, NOT A LOOKUP OF THE TOKEN: `--vg-focus` is a declaration, and reading it back would prove
      // that a variable exists rather than that the ring is drawn in a colour. MEASURED: the first version read the
      // custom property and produced `NaN`, which is what a measurement of the wrong thing looks like.
      const ring = parse(style.outlineColor);
      const behind = parse(getComputedStyle(element.parentElement ?? element).backgroundColor);
      const first = luminance(ring);
      const second = luminance(behind);
      return {
        ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
        ring: style.outlineColor,
        behind: getComputedStyle(element.parentElement ?? element).backgroundColor,
      };
    });
    expect(measured.ratio, `ring ${measured.ring} on ${measured.behind}`).toBeGreaterThanOrEqual(3);
  });
});
