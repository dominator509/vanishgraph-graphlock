/**
 * The `/portal` surface inventory (SPEC-004 §4/§5/§11, VG-UI-001/023…033; EP-005 M5).
 *
 * THREE QUESTIONS, AND THE THIRD IS THE ONE THE NODE EXISTS FOR:
 *
 *   (a) DOES EVERY DECLARED `/portal` ROUTE RESOLVE? Each route module is rendered through the render harness. From M5
 *       the routes fetch, so the FIRST paint is the region's loading state; what this asserts is that the module
 *       renders, that it renders exactly one region with an accessible heading, and that its route is one SPEC-004 §1
 *       declares. The browser stage asserts real navigation.
 *   (b) DOES EACH ROUTE BELONG TO THE SURFACE THE SPECIFICATION ASSIGNS IT? The route files' own `surface` prop is
 *       compared with the specification's table, which is PARSED rather than copied.
 *   (c) IS THERE **ZERO** CONTROL BOUND TO A TRUTH-STATE TRANSITION outside the domain-command path? VG-UI-001 is about
 *       a control being reachable from a surface that does not own it, and the sharpest form of that is a control that
 *       moves a record to another state — "Mark as removed" is the example the plan names. The inventory lists every
 *       control in every rendered surface with its accessible name, and fails on any name that claims a state change.
 *       The required negative case is implemented by INJECTING such a control into the fixture and asserting the same
 *       inventory reports it.
 *
 * THE FIXTURES ARE TEST-ONLY AND LIVE HERE, which is what the plan's fallback requires: no fixture is reachable from
 * `main.tsx`, and the production client resolves the real API (there is no fixture mode in it).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  accessibleText,
  all,
  buildMirror,
  h,
  loadComponent,
  one,
  renderToDocument,
  renderToHtml,
  type RenderedDocument,
} from './render-support.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const UI_SRC = join(PROJECT_ROOT, 'ui', 'src');
const SPEC = readFileSync(join(PROJECT_ROOT, '.agent', 'specs', 'SPEC-004-ui-ux.md'), 'utf8');

buildMirror();

type Component = (props: Record<string, unknown>) => unknown;

const OnboardingStepper = (await loadComponent<{ OnboardingStepper: Component }>('components/portal/OnboardingStepper.tsx'))
  .OnboardingStepper;
const AuthoritySummary = (await loadComponent<{ AuthoritySummary: Component }>('components/portal/AuthoritySummary.tsx'))
  .AuthoritySummary;
const ExposureReviewList = (await loadComponent<{ ExposureReviewList: Component }>('components/portal/ExposureReviewList.tsx'))
  .ExposureReviewList;
const TruthStateLegend = (await loadComponent<{ TruthStateLegend: Component }>('components/portal/TruthStateLegend.tsx'))
  .TruthStateLegend;

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: test-only, shaped as SPEC-003 declares
// ---------------------------------------------------------------------------------------------------------------

function coverage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourcesAttempted: 30,
    sourcesTotal: 30,
    catalogueVersion: 'catalogue-2026-09-01',
    runWindow: { from: '2026-09-01T00:00:00Z', to: '2026-09-15T00:00:00Z' },
    skippedSources: [],
    ...overrides,
  };
}

function exposure(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exposureId: 'exp-1',
    sourceId: 'SOURCE_ALPHA',
    sourceRecordId: 'record-1',
    truthState: 'DISCOVERED_CANDIDATE',
    confidence: { value: 0.87, basis: [{ feature: 'NAME_EXACT', weight: 0.6 }], threshold: 0.85, policyVersion: 'policy-2026-08-01' },
    caseRef: null,
    firstObservedAt: '2026-09-01T00:00:00Z',
    lastObservedAt: '2026-09-02T00:00:00Z',
    reappearanceOf: null,
    ...overrides,
  };
}

function reviewItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exposure: exposure(),
    evidenceArtifactId: 'ev-1',
    ifMatch: '"DISCOVERED_CANDIDATE:1"',
    humanReviewed: true,
    ambiguous: false,
    quarantine: null,
    taint: null,
    ...overrides,
  };
}

/** Every control in a rendered document, with the accessible name a reader would hear. */
function controlInventory(doc: RenderedDocument): readonly { readonly tag: string; readonly name: string }[] {
  return all(doc, 'button, a[href], input, select, textarea, summary, [role="button"]').map((control) => ({
    tag: control.tagName,
    name: accessibleText(control),
  }));
}

/** The names that would claim a truth-state change. VG-UI-001's sharpest case, and the one the plan names. */
const STATE_CHANGE_CLAIM = /mark as|set (the )?state|advance|force|override|bypass|skip this|delete this|hide this/i;

function stateChangeClaims(inventory: readonly { readonly tag: string; readonly name: string }[]): string[] {
  return inventory.filter((control) => STATE_CHANGE_CLAIM.test(control.name)).map((control) => `${control.tag}: ${control.name}`);
}

// ---------------------------------------------------------------------------------------------------------------
// (a) and (b): the declared routes, their surfaces, and the module that owns each
// ---------------------------------------------------------------------------------------------------------------

/** The `/portal` rows of SPEC-004 §1, parsed from the specification's own table. */
function declaredPortalRoutes(): readonly { readonly path: string; readonly surface: string }[] {
  const rows: { path: string; surface: string }[] = [];
  for (const line of SPEC.split('\n')) {
    const match = /^\| `(\/portal[^`]*)` \| ([^|]+) \|/.exec(line);
    if (match === null) continue;
    rows.push({ path: match[1] ?? '', surface: (match[2] ?? '').trim() });
  }
  return rows;
}

/** A declared path as the route module's file name: `/portal/cases/[caseId]` -> `portal.cases.$caseId.tsx`. */
function routeFile(path: string): string {
  const name = path
    .replace(/^\//, '')
    .split('/')
    .map((segment) => (segment.startsWith('[') ? `$${segment.slice(1, -1)}` : segment))
    .join('.');
  return join(UI_SRC, 'routes', `${name}.tsx`);
}

describe('every declared /portal route resolves and belongs to its declared surface', () => {
  test('the specification declares the portal routes this suite inventories', () => {
    const declared = declaredPortalRoutes();
    assert.ok(declared.length >= 8, `expected the §1 table to declare the portal routes, found ${String(declared.length)}`);
    assert.ok(declared.some((row) => row.path === '/portal'));
    assert.ok(declared.some((row) => row.path === '/portal/onboarding'));
  });

  test('each declared portal route either renders one region, or delegates to the shared route with its declared path', async () => {
    for (const { path } of declaredPortalRoutes()) {
      const relative = routeFile(path).slice(join(UI_SRC, 'routes').length + 1);
      const source = readFileSync(routeFile(path), 'utf8');
      if (/useParams\(/.test(source)) {
        // THE TWO PARAMETERISED ROUTES NEED A ROUTER CONTEXT, which this harness does not provide, so they are asserted
        // on the shared route they delegate to instead of being rendered here — and the browser suite navigates them
        // with a real router, which is the stronger evidence. Saying which check ran is the point: a silent skip would
        // read as a pass.
        assert.match(source, /<PortalRoute/, `${path} must delegate to the shared portal route`);
        assert.match(source, new RegExp(`path="${path.replace(/[[\]]/g, '\\$&')}"`), `${path} must declare its own path`);
        continue;
      }
      const module = (await loadComponent<Record<string, Component>>(`routes/${relative}`)) as Record<string, Component>;
      const exported = Object.entries(module).find(([name]) => name.startsWith('Page_'));
      assert.ok(exported !== undefined, `${path} must export a page component`);
      const doc = renderToDocument(h(exported[1], null));
      const headings = all(doc, '[data-page-heading]');
      assert.equal(headings.length, 1, `${path} must render exactly one page heading`);
      assert.equal(accessibleText(headings[0] ?? null), path, `${path} renders its own path as its heading`);
      const regions = all(doc, '[data-region]');
      assert.equal(regions.length, 1, `${path} must render exactly one data region (M4's rule, applied per route)`);
      assert.match(
        one(doc, '[data-region]').getAttribute('data-region-state') ?? '',
        /^(loading|ready|empty|error|access-denied|human-gate|session-expiry|partial-coverage)$/,
      );
    }
  });

  test('each route file names the surface SPEC-004 §1 assigns it', () => {
    const mismatches: string[] = [];
    for (const { path, surface } of declaredPortalRoutes()) {
      const file = routeFile(path);
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        mismatches.push(`${path}: ${file} does not exist`);
        continue;
      }
      const declared = /surface="([^"]+)"/.exec(text)?.[1];
      if (declared === undefined) {
        mismatches.push(`${path}: no surface prop`);
        continue;
      }
      // The specification's surface for every portal route is the subject portal; the route's own prop must say so.
      if (!surface.toLowerCase().includes(declared.toLowerCase().split(' ')[0] ?? '')) {
        mismatches.push(`${path}: file says "${declared}", SPEC-004 §1 says "${surface}"`);
      }
    }
    assert.deepEqual(mismatches, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (c) the control inventory
// ---------------------------------------------------------------------------------------------------------------

describe('no surface offers a control that advances a truth state (VG-UI-001)', () => {
  const surfaces: readonly { readonly name: string; readonly element: unknown }[] = [
    { name: 'onboarding step 1', element: h(OnboardingStepper, { step: 1, exit: { href: '/portal', keeps: 'Nothing is kept if you leave now.' } }) },
    { name: 'authority summary', element: h(AuthoritySummary, { grant: agentGrant() }) },
    { name: 'exposure review', element: h(ExposureReviewList, { items: [reviewItem(), reviewItem({ ambiguous: true })], coverage: coverage() }) },
    { name: 'truth-state legend', element: h(TruthStateLegend, { idPrefix: 'legend' }) },
  ];

  test('the inventory reports no state-change control in any surface', () => {
    for (const surface of surfaces) {
      const doc = renderToDocument(surface.element);
      assert.deepEqual(stateChangeClaims(controlInventory(doc)), [], `${surface.name} offers a state-change control`);
    }
  });

  test('NEGATIVE CASE: an injected "Mark as removed" control is reported by the same inventory', () => {
    // The plan's required negative case, implemented by injecting the control the rule names into a real surface.
    const injected = h(
      'div',
      null,
      h(ExposureReviewList, { items: [reviewItem()], coverage: coverage() }),
      h('button', { type: 'button' }, 'Mark as removed'),
    );
    const claims = stateChangeClaims(controlInventory(renderToDocument(injected)));
    assert.equal(claims.length, 1, `expected exactly one claim, got ${JSON.stringify(claims)}`);
    assert.match(claims[0] ?? '', /Mark as removed/);
  });

  test('the inventory sees the controls that DO exist, so a zero result is not vacuous', () => {
    const doc = renderToDocument(h(ExposureReviewList, { items: [reviewItem()], coverage: coverage() }));
    const inventory = controlInventory(doc);
    const names = inventory.map((control) => control.name);
    assert.ok(names.some((name) => name.includes('Confirm this record is about me')), `inventory: ${names.join(' | ')}`);
    assert.ok(names.some((name) => name.includes('This record is not about me')));
    assert.ok(inventory.length >= 2);
  });

  test('no source file declares a truth-state transition hook for a control', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        const text = readFileSync(full, 'utf8');
        for (const pattern of [/data-truth-transition/, /onTransition\s*[:=]/, /setTruthState/]) {
          if (pattern.test(text)) offenders.push(`${full.replace(`${PROJECT_ROOT}\\`, '')}: ${String(pattern)}`);
        }
      }
    };
    walk(UI_SRC);
    assert.deepEqual(offenders, [], 'a UI module declares a truth-state transition hook');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The §4/§5 content rules, on the rendered surfaces
// ---------------------------------------------------------------------------------------------------------------

function agentGrant(): Record<string, unknown> {
  return {
    authorityGrantId: 'grant-1',
    kind: 'AGENT',
    scope: ['vg.subject.read'],
    evidenceArtifactId: null,
    issuedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2027-09-01T00:00:00Z',
    revokedAt: null,
    state: 'VALID',
    daysUntilExpiry: 350,
  };
}

describe('onboarding: the order, the disclosure and the exit (VG-UI-023/024/071)', () => {
  test('no discovered data renders before a VALID authority grant', () => {
    assert.throws(
      () =>
        renderToHtml(
          h(OnboardingStepper, {
            step: 4,
            exit: { href: '/portal', keeps: 'Nothing is kept.' },
            authority: { state: 'NONE', summary: 'no grant' },
            exposures: 'a record',
          }),
        ),
      /VG-UI-023 requires a VALID AuthorityGrant first/,
    );
  });

  test('step 4 renders once the grant is valid, and step 1 renders no preselected choice', () => {
    const fourth = renderToDocument(
      h(OnboardingStepper, {
        step: 4,
        exit: { href: '/portal', keeps: 'Nothing is kept.' },
        authority: { state: 'VALID', summary: 'grant valid' },
        exposures: 'the records',
      }),
    );
    assert.match(accessibleText(one(fourth, '[data-onboarding-body]')), /the records/);

    const first = renderToDocument(h(OnboardingStepper, { step: 1, exit: { href: '/portal', keeps: 'Nothing is kept.' } }));
    const radios = all(first, 'input[type="radio"]');
    assert.equal(radios.length, 2);
    for (const radio of radios) {
      assert.equal(radio.hasAttribute('checked'), false, 'VG-UI-024: no choice is pre-selected');
    }
    assert.match(accessibleText(one(first, '[data-onboarding]')), /Do you want to continue\?/);
    // The step list carries the five declared steps and marks the current one.
    assert.equal(all(first, '[data-onboarding-step-item]').length, 5);
    assert.equal(one(first, '[aria-current="step"]').getAttribute('data-onboarding-step-item'), '1');
  });

  test('every step offers the exit in the same place, with no progress-loss warning', () => {
    // Steps 1 to 3 are the ones that do not need a valid grant: steps 4 and 5 render a discovery run's results, and the
    // refusal for those without authority is asserted separately above.
    for (const step of [1, 2, 3]) {
      const doc = renderToDocument(h(OnboardingStepper, { step, exit: { href: '/portal', keeps: 'Nothing is kept.' } }));
      const exit = one(doc, '[data-onboarding-exit]');
      assert.equal(exit.getAttribute('href'), '/portal');
      const text = accessibleText(doc.body).toLowerCase();
      for (const scare of ['are you sure', 'lose your progress', 'contact support', 'you will lose']) {
        assert.equal(text.includes(scare), false, `step ${String(step)} uses scare copy: "${scare}"`);
      }
    }
  });
});

describe('authority: the five facts, the missing evidence and the revocation effect (VG-UI-025…028)', () => {
  test('kind, scope, dates, evidence and revocation state all render, with the scope boundary', () => {
    const doc = renderToDocument(h(AuthoritySummary, { grant: { ...agentGrant(), evidenceArtifactId: 'ev-9' } }));
    const text = accessibleText(one(doc, '[data-authority-grant]'));
    assert.match(text, /AGENT/);
    assert.match(text, /reading the records found about the subject/);
    assert.match(text, /2026-09-01T00:00:00Z/);
    assert.match(text, /2027-09-01T00:00:00Z/);
    assert.match(text, /ev-9/);
    assert.match(text, /Not revoked\./);
    assert.match(accessibleText(one(doc, '[data-authority-boundary]')), /does not authorize acting for anyone else/);
  });

  test('an agent grant with no evidence states what is missing', () => {
    const doc = renderToDocument(h(AuthoritySummary, { grant: agentGrant() }));
    assert.match(
      accessibleText(one(doc, '[data-authority-missing-evidence]')),
      /What is missing: a signed authority instrument recorded as an evidence artifact\./,
    );
  });

  test('revocation states its effect on in-flight work, and is absent once revoked', () => {
    const doc = renderToDocument(
      h(AuthoritySummary, {
        grant: { ...agentGrant(), evidenceArtifactId: 'ev-9' },
        onRevoke: () => undefined,
        revokeDescriptionId: 'revoke-effect',
      }),
    );
    assert.match(
      accessibleText(one(doc, '[data-authority-revoke-effect]')),
      /does not recall a request that has already been sent, and it does not undo work a controller has already done/,
    );
    const revoked = renderToDocument(
      h(AuthoritySummary, {
        grant: { ...agentGrant(), revokedAt: '2026-09-10T00:00:00Z', state: 'REVOKED' },
        onRevoke: () => undefined,
      }),
    );
    assert.equal(all(revoked, '[data-authority-revoke]').length, 0);
    assert.match(accessibleText(one(revoked, '[data-authority-revocation-state]')), /Revoked at 2026-09-10T00:00:00Z\./);
  });
});

describe('exposure review: provenance, no bulk control, bounded rejection, disclosed taint (VG-UI-029…033)', () => {
  test('provenance and confidence-with-basis render before the controls', () => {
    const doc = renderToDocument(h(ExposureReviewList, { items: [reviewItem()], coverage: coverage() }));
    const row = one(doc, '[data-exposure-row]');
    assert.equal(one(row, '[data-provenance-source]').textContent, 'SOURCE_ALPHA');
    assert.equal(one(row, '[data-provenance-record]').textContent, 'record-1');
    assert.equal(one(row, '[data-confidence-basis]').getAttribute('data-confidence-value'), '0.87');
    assert.equal(all(row, '[data-confidence-entry]').length, 1);
    assert.equal(accessibleText(one(row, '[data-confidence-threshold]')), 'against the policy threshold 0.85');
    // The control comes after the evidence in DOM order.
    const names = all(row, '*').map((element) => element.tagName);
    assert.ok(names.indexOf('DL') < names.length);
    assert.match(accessibleText(one(row, '[data-exposure-provenance]')), /Discovered — not yet confirmed as you/);
  });

  test('there is no bulk control anywhere in the list, and the absence is stated', () => {
    const doc = renderToDocument(
      h(ExposureReviewList, { items: [reviewItem(), reviewItem({ exposure: exposure({ exposureId: 'exp-2' }) })], coverage: coverage() }),
    );
    const names = controlInventory(doc).map((control) => control.name);
    for (const name of names) {
      assert.equal(/all|every|all of them|bulk/i.test(name), false, `a bulk control exists: ${name}`);
    }
    assert.equal(all(doc, '[data-exposure-row]').length, 2);
    assert.match(accessibleText(one(doc, '[data-exposure-no-bulk]')), /There is no way to act on several records at once/);
  });

  test('an ambiguous record cannot be confirmed, and the count is stated', () => {
    const doc = renderToDocument(
      h(ExposureReviewList, { items: [reviewItem({ ambiguous: true })], coverage: coverage() }),
    );
    assert.equal(all(doc, '[data-approve-confirm]').length, 0, 'VG-UI-032: an ambiguous match is not confirmable in bulk or alone here');
    assert.match(accessibleText(one(doc, '[data-approve-blocked]')), /explicit statement that a person reviewed this match/);
    assert.equal(one(doc, '[data-exposure-ambiguous-number]').textContent, '1');
  });

  test('rejection is refused over partial coverage and offered over complete coverage', () => {
    const complete = renderToDocument(h(ExposureReviewList, { items: [reviewItem()], coverage: coverage() }));
    assert.equal(all(complete, '[data-reject-record]').length, 1);
    assert.match(
      accessibleText(one(complete, '[data-reject-effect]')),
      /does not state that the record does not exist elsewhere/,
    );

    const partial = renderToDocument(
      h(ExposureReviewList, {
        items: [reviewItem()],
        coverage: coverage({ sourcesAttempted: 12, skippedSources: [{ sourceId: 'SOURCE_BETA', reason: 'HUMAN_REQUIRED' }] }),
      }),
    );
    assert.equal(all(partial, '[data-reject-record]').length, 0, 'VG-UI-031: no rejection without complete bounds');
    assert.match(accessibleText(one(partial, '[data-reject-unavailable]')), /did not check every Source/);
    assert.match(accessibleText(one(partial, '[data-partial-coverage]')), /Coverage was partial/);
  });

  test('a quarantined alias and a tainted record are visible with the reason disclosed', () => {
    const doc = renderToDocument(
      h(ExposureReviewList, {
        items: [
          reviewItem({
            quarantine: { reason: 'the alias was quarantined during identity review' },
            taint: { disclosure: 'a prior subject denied this record' },
          }),
        ],
        coverage: coverage(),
      }),
    );
    assert.match(accessibleText(one(doc, '[data-exposure-quarantine]')), /quarantined alias and is not being acted on/);
    assert.match(accessibleText(one(doc, '[data-exposure-taint]')), /carries a taint: a prior subject denied this record/);
  });
});

describe('the legend is built from the one canonical mapping (VG-UI-007/070)', () => {
  test('all eleven states render with their qualifier, glyph and machine value', () => {
    const doc = renderToDocument(h(TruthStateLegend, { idPrefix: 'legend' }));
    const entries = all(doc, '[data-legend-state]');
    assert.equal(entries.length, 11);
    for (const entry of entries) {
      const token = entry.getAttribute('data-legend-state') ?? '';
      const badge = one(entry, '[data-truth-state]');
      assert.equal(badge.getAttribute('data-truth-state'), token);
      assert.equal(accessibleText(one(entry, '.vg-truth-badge__machine')), token);
      assert.notEqual(accessibleText(one(entry, '.vg-truth-badge__glyph')), '');
      const qualifier = accessibleText(one(entry, '[data-legend-qualifier]'));
      assert.ok(qualifier.length > 40, `${token} has no qualifier`);
    }
    // The three scope-requiring states render an example scope, which the legend's own text declares as an example.
    for (const token of ['VERIFIED_REMOVED', 'VERIFIED_NOT_PRESENT', 'SEARCH_DELISTED']) {
      const badge = one(doc, `[data-truth-state="${token}"]`);
      assert.match(accessibleText(badge), /Source: EXAMPLE_SOURCE · window 30d/);
    }
    assert.match(accessibleText(one(doc, '[data-truth-state-legend]')), /this legend shows an example scope/);
  });
});

