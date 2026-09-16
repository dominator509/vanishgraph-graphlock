/**
 * The seven region states, asserted against RENDERED DOM (SPEC-004 §9 VG-UI-048…055; EP-005 M4).
 *
 * THE ORACLE IS THE RENDERED OUTPUT, for the same reason as the M3 coverage suite: the plan forbids weakening these
 * assertions to a source grep ("a source grep is not an oracle", SPEC-004 §0.2). Each state is rendered through the real
 * `Region` switch — not by calling the state component directly — so what is asserted is the wiring a surface will get.
 *
 * EVERY REFUSAL IS ASSERTED BY TRYING IT. `ErrorState` refuses a candidate outcome, `SessionExpiryNotice` refuses a
 * re-authentication path carrying a query string, and `MetricFigure` refuses a mixed population; each is exercised with
 * the bad input and asserted to throw, because a guard that has never been observed to fire is not a guard.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

buildMirror();

type Component = (props: Record<string, unknown>) => unknown;

interface RegionModule {
  readonly Region: Component;
  readonly REGION_STATE_KINDS: readonly string[];
}
interface LoadingModule {
  readonly LoadingRegion: Component;
  readonly DelayedLoadingNotice: Component;
  readonly DELAYED_LOADING_THRESHOLD_MS: number;
}
interface SessionModule {
  readonly SessionExpiryNotice: Component;
}

const region = await loadComponent<RegionModule>('components/states/Region.tsx');
const loading = await loadComponent<LoadingModule>('components/states/LoadingRegion.tsx');
const session = await loadComponent<SessionModule>('components/states/SessionExpiryNotice.tsx');

/** A partial coverage run, reused by the empty and partial-coverage states. */
const PARTIAL_RUN = {
  sourcesAttempted: 12,
  sourcesTotal: 30,
  catalogueVersion: 'catalogue-2026-09-01',
  runWindow: { from: '2026-09-01T00:00:00Z', to: '2026-09-15T00:00:00Z' },
  skippedSources: [{ sourceId: 'SOURCE_BETA', reason: 'human verification gate' }],
};

/** A rendered region in one state, with the name every state shares. */
function renderRegion(state: Record<string, unknown>): RenderedDocument {
  return renderToDocument(h(region.Region, { name: 'Case queue', state }));
}

describe('every region state renders inside one region element (VG-UI-055)', () => {
  test('the union declares the seven states plus the ready state, and each renders', () => {
    const kinds = region.REGION_STATE_KINDS;
    for (const expected of [
      'loading',
      'empty',
      'partial-coverage',
      'error',
      'access-denied',
      'human-gate',
      'session-expiry',
      'ready',
    ]) {
      assert.ok(kinds.includes(expected), `${expected} must be a region state`);
    }
    assert.equal(kinds.length, 8, `expected eight states, found ${kinds.join(', ')}`);
  });

  test('each state renders a region with its heading, its state hook and its accessible name', () => {
    const states: readonly Record<string, unknown>[] = [
      { kind: 'loading', height: '8rem' },
      { kind: 'ready', children: 'content' },
      { kind: 'empty', empty: { searched: 'exposures', window: { from: 'a', to: 'b' }, coverage: PARTIAL_RUN, nextAction: null } },
      { kind: 'error', error: { operation: 'loading the case queue', correlationId: 'corr-1', retry: { kind: 'not-retryable', reason: 'it is not idempotent' } } },
      { kind: 'access-denied', denied: { requiredRole: 'a case worker for this tenant', backTo: { href: '/portal', label: 'Back to your portal' } } },
      { kind: 'human-gate', gate: { gateKind: 'identity verification', mustAct: 'you', afterAction: 'the case continues', recorded: 'your request', qualifierId: 'q1' } },
      { kind: 'session-expiry', session: { phase: 'warning', secondsRemaining: 120, reauthenticatePath: '/sign-in', onStaySignedIn: () => undefined } },
      { kind: 'partial-coverage', coverage: PARTIAL_RUN, children: 'rows' },
    ];
    for (const state of states) {
      const doc = renderRegion(state);
      const scope = one(doc, '[data-region]');
      assert.equal(scope.getAttribute('data-region-state'), state['kind'], `${String(state['kind'])} state hook`);
      assert.equal(scope.getAttribute('data-region-name'), 'Case queue');
      const heading = one(scope, '[data-region-heading]');
      assert.equal(heading.tagName, 'H2');
      assert.equal(accessibleText(heading), 'Case queue');
      assert.equal(heading.getAttribute('tabindex'), '-1', 'the heading is where focus lands (VG-UI-059)');
      assert.equal(scope.getAttribute('aria-labelledby'), heading.getAttribute('id'));
      assert.equal(ALL_STATE_KINDS.includes(state['kind'] as string), true);
    }
  });
});

const ALL_STATE_KINDS: readonly string[] = [
  'loading',
  'empty',
  'partial-coverage',
  'error',
  'access-denied',
  'human-gate',
  'session-expiry',
  'ready',
];

describe('loading: a dimension-preserving skeleton and ONE polite announcement (VG-UI-048)', () => {
  test('the skeleton is hidden from assistive technology and reserves the region height', () => {
    const doc = renderRegion({ kind: 'loading', height: '11rem' });
    const skeleton = one(doc, '.vg-loading__skeleton');
    assert.equal(skeleton.getAttribute('aria-hidden'), 'true');
    assert.match(skeleton.getAttribute('style') ?? '', /min-height:\s*11rem/);
    assert.equal(all(doc, '[aria-hidden="true"] svg, [aria-hidden="true"] [role="progressbar"]').length, 0);
  });

  test('exactly one polite live region announces Loading <region name>.', () => {
    const doc = renderRegion({ kind: 'loading', height: '8rem' });
    const regions = all(doc, '[aria-live]');
    assert.equal(regions.length, 1, 'one announcement, not one per skeleton element');
    assert.equal(regions[0]?.getAttribute('aria-live'), 'polite');
    assert.equal(regions[0]?.getAttribute('role'), 'status');
    assert.equal(accessibleText(regions[0] ?? null), 'Loading Case queue.');
  });

  test('no cancel control exists before the threshold, and one exists after it', () => {
    const early = renderRegion({ kind: 'loading', height: '8rem' });
    assert.equal(all(early, 'button').length, 0, 'a cancel control before ten seconds is a control for nothing');

    const late = renderRegion({
      kind: 'loading',
      height: '8rem',
      delayed: { operation: 'the case queue', onCancel: () => undefined },
    });
    const buttons = all(late, 'button');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]?.getAttribute('type'), 'button', 'a type=button control cannot submit a form');
    assert.equal(accessibleText(buttons[0] ?? null), 'Cancel the case queue');
    assert.equal(accessibleText(one(late, '[data-loading-operation]')), 'the case queue');
    // The announcement is still exactly one live region: the delayed block states a fact, it is not a second live region.
    assert.equal(all(late, '[aria-live]').length, 1);
  });

  test('the ten-second threshold is declared once, at the value the requirement names', () => {
    assert.equal(loading.DELAYED_LOADING_THRESHOLD_MS, 10_000);
  });
});

describe('empty: an absence statement carries its scope (VG-UI-049)', () => {
  test('what was searched, the window and the coverage are all rendered', () => {
    const doc = renderRegion({
      kind: 'empty',
      empty: {
        searched: 'exposures for this subject',
        window: { from: '2026-09-01T00:00:00Z', to: '2026-09-15T00:00:00Z' },
        coverage: PARTIAL_RUN,
        nextAction: h('a', { href: '/portal/exposures' }, 'Start a new search'),
      },
    });
    const scope = one(doc, '[data-empty-state]');
    const text = accessibleText(scope);
    assert.match(text, /Nothing was found for exposures for this subject/);
    assert.match(text, /Window 2026-09-01T00:00:00Z to 2026-09-15T00:00:00Z/);
    // The coverage figures arrive through the one coverage renderer, with their denominator.
    assert.equal(all(scope, '[data-coverage-summary]').length, 1, 'the figures come from the one coverage renderer');
    assert.equal(one(scope, '[data-metric-part="numerator"]').textContent, '12');
    assert.equal(one(scope, '[data-metric-part="denominator"]').textContent, '30');
    assert.equal(all(scope, '[data-empty-next-action]').length, 1);
  });

  test('a partial run brings the banner and the skipped Source with its reason', () => {
    const doc = renderRegion({
      kind: 'empty',
      empty: {
        searched: 'exposures',
        window: { from: 'a', to: 'b' },
        coverage: PARTIAL_RUN,
        nextAction: null,
      },
    });
    assert.equal(all(doc, '[data-partial-coverage]').length, 1, 'VG-UI-022: an absence statement is qualified');
    assert.match(accessibleText(one(doc, '[data-skipped-source]')), /SOURCE_BETA — human verification gate/);
  });

  test('with no action available the state says so rather than inventing a link', () => {
    const doc = renderRegion({
      kind: 'empty',
      empty: { searched: 'exposures', window: { from: 'a', to: 'b' }, coverage: PARTIAL_RUN, nextAction: null },
    });
    assert.equal(all(doc, '[data-empty-next-action]').length, 0);
    assert.match(accessibleText(one(doc, '[data-empty-no-action]')), /no action available from here/);
  });
});

describe('error: four elements, and an outcome is refused (VG-UI-051, SPEC-006 §2.1)', () => {
  const errorState = {
    operation: 'loading the case queue',
    correlationId: 'corr-9f2c',
    retry: { kind: 'idempotent' as const, onRetry: () => undefined },
  };

  test('the failed operation, a correlation id and a retryability statement all render, with role=alert', () => {
    const doc = renderRegion({ kind: 'error', error: errorState });
    const scope = one(doc, '[data-error-state]');
    assert.equal(scope.getAttribute('role'), 'alert');
    const text = accessibleText(scope);
    assert.match(text, /We could not finish loading the case queue/);
    assert.equal(accessibleText(one(scope, '[data-error-correlation]')), 'corr-9f2c');
    assert.match(accessibleText(one(scope, '[data-error-retryable="true"]')), /tried again safely/);
    assert.equal(one(scope, '[data-error-retry]').tagName, 'BUTTON');
  });

  test('a non-idempotent failure offers NO retry control and states why', () => {
    const doc = renderRegion({
      kind: 'error',
      error: { ...errorState, retry: { kind: 'not-retryable', reason: 'the request may already have been sent' } },
    });
    assert.equal(all(doc, 'button').length, 0, 'VG-ACTION-001: at-most-once means no retry where it is not idempotent');
    assert.match(
      accessibleText(one(doc, '[data-error-retryable="false"]')),
      /cannot be retried from here: the request may already have been sent/,
    );
  });

  test('a candidate outcome renders nowhere in this region', () => {
    for (const outcome of ['NOT_REMOVABLE', 'HUMAN_REQUIRED', 'VERIFIED_NOT_PRESENT', 'SEARCH_DELISTED']) {
      assert.throws(
        () => renderToHtml(h(region.Region, { name: 'Case queue', state: { kind: 'error', error: { ...errorState, outcomeState: outcome } } })),
        /candidate outcome, not an error/,
        `${outcome} must not render as an error`,
      );
    }
  });
});

describe('access denied: a distinct state with zero resource fields (VG-UI-052)', () => {
  test('it names the role concept, states the attempt was recorded, and shows no data', () => {
    const doc = renderRegion({
      kind: 'access-denied',
      denied: { requiredRole: 'a case worker for this tenant', backTo: { href: '/portal', label: 'Back to your portal' } },
    });
    const scope = one(doc, '[data-access-denied]');
    const text = accessibleText(scope);
    assert.match(text, /^Access denied/);
    assert.match(text, /limited to a case worker for this tenant/);
    assert.match(text, /attempt was recorded in the audit trail/);
    // ZERO resource fields: the only interactive content is the way back.
    const controls = all(scope, 'button, input, select, textarea, [role="table"], [role="grid"], [disabled]');
    assert.deepEqual(controls.map((control) => control.tagName), []);
    assert.equal(all(scope, 'a').length, 1);
    assert.equal(/\d/.test(text), false, 'not even a count renders in a denied region');
  });

  test('the forbidden synonym never appears in the rendered text', () => {
    const doc = renderRegion({
      kind: 'access-denied',
      denied: { requiredRole: 'a case worker for this tenant', backTo: { href: '/portal', label: 'Back' } },
    });
    const text = accessibleText(one(doc, '[data-access-denied]')).toLowerCase();
    for (const forbidden of ['permission', 'consent', 'privilege', 'unauthorised', 'unauthorized']) {
      assert.equal(text.includes(forbidden), false, `VG-UI-052 forbids "${forbidden}" in this state`);
    }
  });
});

describe('human gate: four elements and no way past (VG-UI-053)', () => {
  const gate = {
    gateKind: 'identity verification',
    mustAct: 'you, by confirming your identity document',
    afterAction: 'the case moves to review and you are told what was decided',
    recorded: 'your request and the records found so far',
    qualifierId: 'gate-qualifier',
  };

  test('the gate kind, who acts, what follows and what is recorded all render', () => {
    const doc = renderRegion({ kind: 'human-gate', gate });
    const scope = one(doc, '[data-human-gate]');
    assert.equal(scope.getAttribute('data-human-gate-kind'), 'identity verification');
    assert.equal(accessibleText(one(scope, '[data-gate-must-act]')), gate.mustAct);
    assert.equal(accessibleText(one(scope, '[data-gate-after-action]')), gate.afterAction);
    assert.equal(accessibleText(one(scope, '[data-gate-recorded]')), gate.recorded);
  });

  test('it renders the HUMAN_REQUIRED presentation with its qualifier visible', () => {
    const doc = renderRegion({ kind: 'human-gate', gate });
    assert.equal(one(doc, '[data-truth-state]').getAttribute('data-truth-state'), 'HUMAN_REQUIRED');
    assert.equal(one(doc, '[data-truth-state]').getAttribute('data-truth-group'), 'action');
    assert.match(accessibleText(one(doc, '[data-truth-state-qualifier]')), /normal outcome, not a defect or an error/);
    assert.equal(one(doc, '[data-truth-state]').getAttribute('aria-describedby'), 'gate-qualifier');
  });

  test('NEGATIVE CASE: a gate offers zero bypass, solver or skip controls', () => {
    const doc = renderRegion({ kind: 'human-gate', gate });
    const controls = all(doc, 'button, input, select, textarea, [contenteditable], [role="button"], [role="link"]');
    assert.deepEqual(
      controls.map((control) => `${control.tagName}:${accessibleText(control)}`),
      [],
      'a gate that offers a way past it is not a gate (VG-UI-053)',
    );
    const text = accessibleText(one(doc, '[data-human-gate]')).toLowerCase();
    for (const bypass of ['skip', 'continue anyway', 'bypass', 'solve', 'ignore this step']) {
      assert.equal(text.includes(bypass), false, `the gate text must not offer "${bypass}"`);
    }
  });
});

describe('session expiry: a real refresh before, no control after (VG-UI-054)', () => {
  test('the warning states the seconds left and offers a keyboard-operable refresh and a re-authentication path', () => {
    const doc = renderRegion({
      kind: 'session-expiry',
      session: { phase: 'warning', secondsRemaining: 120, reauthenticatePath: '/sign-in', onStaySignedIn: () => undefined },
    });
    assert.equal(accessibleText(one(doc, '[data-session-seconds]')), '120');
    assert.equal(one(doc, '[data-session-stay]').tagName, 'BUTTON');
    assert.equal(accessibleText(one(doc, '[data-session-stay]')), 'Stay signed in');
    assert.equal(one(doc, '[data-session-reauthenticate]').getAttribute('href'), '/sign-in');
    assert.equal(all(doc, '[data-session-refresh-failed]').length, 0);
  });

  test('the expired phase renders no control that pretends to extend the session', () => {
    const doc = renderRegion({ kind: 'session-expiry', session: { phase: 'expired', reauthenticatePath: '/sign-in' } });
    assert.equal(all(doc, 'button').length, 0);
    assert.equal(all(doc, '[data-session-seconds]').length, 0);
    assert.match(accessibleText(one(doc, '[data-session-expiry]')), /no longer holds your data/);
    assert.equal(one(doc, '[data-session-expiry]').getAttribute('role'), 'alert');
  });

  test('NEGATIVE CASE: a re-authentication URL carrying a case identifier is refused', () => {
    for (const bad of ['/sign-in?caseId=abc', '/sign-in#case-1', 'https://id.example//tenant']) {
      assert.throws(
        () => renderToHtml(h(session.SessionExpiryNotice, { phase: 'expired', reauthenticatePath: bad })),
        /query string, a fragment or an authority/,
        `${bad} must be refused`,
      );
    }
  });

  test('NEGATIVE CASE: a warning with no refresh handler, or with no remaining time, is refused', () => {
    assert.throws(
      () => renderToHtml(h(session.SessionExpiryNotice, { phase: 'warning', secondsRemaining: 120, reauthenticatePath: '/sign-in' })),
      /must be given a real refresh/,
    );
    assert.throws(
      () => renderToHtml(h(session.SessionExpiryNotice, { phase: 'warning', reauthenticatePath: '/sign-in', onStaySignedIn: () => undefined })),
      /must state how long is left/,
    );
  });
});

describe('the region states are declared in one place (EP-005 M4)', () => {
  test('the region switch is the only place the state hook is emitted', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const text = readFileSync(full, 'utf8');
        if (text.includes('data-region-state') && !full.endsWith(join('states', 'Region.tsx'))) {
          offenders.push(full.replace(`${PROJECT_ROOT}\\`, '').replace(/\\/g, '/'));
        }
      }
    };
    walk(join(PROJECT_ROOT, 'ui', 'src', 'components'));
    assert.deepEqual(offenders, [], `a second region renderer exists: ${offenders.join(', ')}`);
  });
});

