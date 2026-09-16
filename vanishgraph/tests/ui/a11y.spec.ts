/**
 * Automated accessibility input, measured on the BUILT application (SPEC-004 §10 VG-UI-056…058; EP-005 M4).
 *
 * AUTOMATED OUTPUT IS A NECESSARY AND INSUFFICIENT INPUT, and VG-UI-056 forbids reporting a requirement as passing on
 * tool output alone. So this suite does two things and refuses to do a third:
 *
 *   1. it runs axe-core over every route SPEC-004 §1 declares, on the artefact the build emitted;
 *   2. it records, per route, the tool version, the rule set and the full violation list — or the fact that there were
 *      none — into `.agent/evidence/EP-005/accessibility/axe-results.json`;
 *   3. it does NOT claim conformance, and it asserts that the human-gate artefacts beside it do not either. The
 *      per-criterion report is checked for the words a conformance claim would use, because the defect this guards
 *      against is a report that quietly turns automated passes into a claim.
 *
 * ROUTES WITH A PATH PARAMETER ARE VISITED WITH A NIL IDENTIFIER. The five parameterised routes are part of the
 * declared surface set, so leaving them unscanned would be a gap; the identifier used is the all-zero UUID, which is
 * visibly a placeholder and is not PII.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { declaredRoutes, PROJECT_ROOT } from './support.ts';

const EVIDENCE_DIR = join(PROJECT_ROOT, '.agent', 'evidence', 'EP-005', 'accessibility');
const RULE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const NIL_ID = '00000000-0000-0000-0000-000000000000';

/** Every declared route as a URL a browser can open, with parameters filled by the nil identifier. */
function routeUrls(): readonly { readonly declared: string; readonly url: string }[] {
  return declaredRoutes().map((declared) => ({
    declared,
    url: declared.replace(/\[[a-zA-Z]+\]/g, NIL_ID),
  }));
}

const AXE_VERSION = (
  JSON.parse(readFileSync(join(PROJECT_ROOT, 'node_modules', 'axe-core', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;
const HARNESS_VERSION = (
  JSON.parse(readFileSync(join(PROJECT_ROOT, 'node_modules', '@axe-core', 'playwright', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

interface RouteResult {
  readonly declared: string;
  readonly url: string;
  readonly violations: readonly { readonly id: string; readonly impact: string | null; readonly nodes: number }[];
  readonly passes: number;
  readonly incomplete: number;
  readonly inapplicable: number;
}

const results: RouteResult[] = [];

test.describe('axe-core over every declared route', () => {
  test('every route is scanned and the artefact digest is recorded', async ({ page }) => {
    for (const { declared, url } of routeUrls()) {
      await page.goto(url);
      const analysis = await new AxeBuilder({ page }).withTags([...RULE_TAGS]).analyze();
      results.push({
        declared,
        url,
        violations: analysis.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact ?? null,
          nodes: violation.nodes.length,
        })),
        passes: analysis.passes.length,
        incomplete: analysis.incomplete.length,
        inapplicable: analysis.inapplicable.length,
      });
    }

    expect(results.length, 'every declared route must be scanned').toBe(declaredRoutes().length);

    // THE EVIDENCE IS WRITTEN BEFORE THE ASSERTION, so a failing run leaves the measurement behind rather than only a
    // red mark: an accessibility failure that cannot be inspected is a failure nobody can fix.
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const indexHtml = readFileSync(join(PROJECT_ROOT, 'ui', 'dist', 'index.html'));
    writeFileSync(
      join(EVIDENCE_DIR, 'axe-results.json'),
      `${JSON.stringify(
        {
          tool: {
            name: '@axe-core/playwright',
            version: HARNESS_VERSION,
            engine: 'axe-core',
            engineVersion: AXE_VERSION,
            ruleTags: RULE_TAGS,
          },
          target: {
            artefact: 'ui/dist (vite build output, served by vite preview)',
            indexHtmlSha256: createHash('sha256').update(indexHtml).digest('hex'),
          },
          routes: results,
          totals: {
            routes: results.length,
            routesWithViolations: results.filter((result) => result.violations.length > 0).length,
            violations: results.reduce((sum, result) => sum + result.violations.length, 0),
          },
          conformanceClaim: 'NONE - automated input only (VG-UI-056)',
        },
        null,
        2,
      )}\n`,
    );

    const withViolations = results.filter((result) => result.violations.length > 0);
    expect(
      withViolations.map((result) => `${result.declared}: ${result.violations.map((v) => v.id).join(', ')}`),
      'axe must report no violation of the selected WCAG 2.2 A/AA rules',
    ).toEqual([]);
  });

  test('the per-criterion report exists and makes no conformance claim', () => {
    const report = join(EVIDENCE_DIR, 'per-criterion-report.md');
    expect(existsSync(report), 'the per-criterion report is required by VG-UI-056').toBe(true);
    const text = readFileSync(report, 'utf8');
    // EACH CRITERION CARRIES ONE OF THE FOUR STATUSES the specification names, and the report is checked to contain
    // all four: a report that only says PASS is the defect VG-UI-056's negative case describes.
    for (const status of ['PASS', 'FAIL', 'PARTIAL', 'EXTERNAL_REQUIRED']) {
      expect(text.includes(status), `the report must use the status ${status}`).toBe(true);
    }
    for (const forbidden of [/\bconforms to\b/i, /\bWCAG 2\.2 AA compliant\b/i, /\bfull conformance\b/i, /\bcertified\b/i]) {
      expect(forbidden.test(text), `the report must not make a conformance claim (${String(forbidden)})`).toBe(false);
    }
    expect(text).toContain('EXTERNAL_REQUIRED');
  });

  test('the human gate is recorded as EXTERNAL_REQUIRED with a party role and an artefact digest', () => {
    const request = join(EVIDENCE_DIR, 'human-gate-request.json');
    expect(existsSync(request), 'VG-UI-064 must be recorded as a request, not as a pass').toBe(true);
    const parsed = JSON.parse(readFileSync(request, 'utf8')) as {
      verdict: string;
      externalPartyRole: string;
      requestedArtifactDigest: string;
      requestEvidencePath: string;
      criteria: readonly string[];
      signOff: { signed: boolean; signedBy: string | null };
    };
    expect(parsed.verdict).toBe('EXTERNAL_REQUIRED');
    expect(parsed.externalPartyRole).toBe('accessibility practitioner');
    expect(parsed.requestedArtifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parsed.requestEvidencePath.length).toBeGreaterThan(0);
    expect(parsed.criteria.length).toBeGreaterThan(0);
    // THE REQUEST MUST POINT AT THE ARTEFACT UNDER REVIEW: a digest that no longer matches the build is a request for
    // something else, and it would let a stale sign-off be attached to a changed interface.
    const actual = `sha256:${createHash('sha256')
      .update(readFileSync(join(PROJECT_ROOT, 'ui', 'dist', 'index.html')))
      .digest('hex')}`;
    expect(parsed.requestedArtifactDigest).toBe(actual);
    // AND IT MUST NOT CARRY A SIGN-OFF: only a named human participant can produce one.
    expect(parsed.signOff.signed).toBe(false);
    expect(parsed.signOff.signedBy).toBeNull();
  });
});
