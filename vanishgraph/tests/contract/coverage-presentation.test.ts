/**
 * Coverage honesty, confidence basis, and the timeline, asserted against RENDERED DOM (SPEC-004 §3, §6, §8, §9, §10;
 * EP-005 M3).
 *
 * THE ORACLE IS THE RENDERED OUTPUT, NOT THE SOURCE. The plan's fallback is explicit about why: "a source grep is not an
 * oracle (SPEC-004 §0.2)". So every assertion below renders the real components through `react-dom/server` and queries
 * the DOM — except the two rules that are ABOUT the source tree (VG-UI-017's "no second coverage renderer" and the
 * negative case for a hand-written coverage sentence), which are source scans and are labelled as such.
 *
 * EVERY SCAN PROVES IT CAN FAIL. A DOM scan that finds no bare percentage proves nothing unless it is shown to find one
 * when a bare percentage is present, so the negative fixtures in this file render a deliberately defective tree and
 * assert the SAME scanner reports it. This is the defect class that cost the M2 copy gate its usefulness: it passed
 * because it could not fail.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  accessibleText,
  all,
  buildMirror,
  h,
  loadComponent,
  one,
  renderToDocument,
  renderToHtml,
  textNodes,
  type RenderedDocument,
  type RenderedElement,
} from './render-support.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const UI_SRC = join(PROJECT_ROOT, 'ui', 'src');

// The mirror is built once per process, before any component is loaded.
buildMirror();

type Component = (props: Record<string, unknown>) => unknown;

interface CoverageModule {
  readonly CoveragePanel: Component;
  readonly CoverageSummaryInline: Component;
  readonly CoverageFacts: Component;
  readonly isPartialCoverage: (run: unknown) => boolean;
}
interface MetricModule {
  readonly MetricFigure: Component;
  readonly NOT_COMPUTABLE: string;
}
interface ConfidenceModule {
  readonly ConfidenceBasis: Component;
}
interface TimelineModule {
  readonly TruthTimeline: Component;
}
interface BadgeModule {
  readonly TruthStateBadge: Component;
}

const coverage = await loadComponent<CoverageModule>('components/coverage/CoveragePanel.tsx');
const metric = await loadComponent<MetricModule>('components/coverage/MetricFigure.tsx');
const confidence = await loadComponent<ConfidenceModule>('components/coverage/ConfidenceBasis.tsx');
const timeline = await loadComponent<TimelineModule>('components/truth/TruthTimeline.tsx');
const badge = await loadComponent<BadgeModule>('components/truth/TruthStateBadge.tsx');

/** A partial run: 12 of 30 Sources attempted, two skipped with reasons. */
function partialRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourcesAttempted: 12,
    sourcesTotal: 30,
    catalogueVersion: 'catalogue-2026-09-01',
    runWindow: { from: '2026-09-01T00:00:00Z', to: '2026-09-15T00:00:00Z' },
    skippedSources: [
      { sourceId: 'SOURCE_ALPHA', reason: 'no permitted read path' },
      { sourceId: 'SOURCE_BETA', reason: 'human verification gate' },
    ],
    ...overrides,
  };
}

/** A complete run: every Source in the catalogue was attempted. */
function completeRun(): Record<string, unknown> {
  return partialRun({ sourcesAttempted: 30, skippedSources: [] });
}

/**
 * VG-UI-018's scan: every text node containing a percentage must sit inside a metric figure that carries a NUMERIC
 * denominator and a denominator label. Returns the violations, so the same function can be shown to fail.
 */
function percentViolations(doc: RenderedDocument): string[] {
  const violations: string[] = [];
  let seen = 0;
  for (const { text, parent } of textNodes(doc)) {
    if (!text.includes('%')) continue;
    seen += 1;
    const figure = parent.closest('[data-metric-figure]');
    if (figure === null) {
      violations.push(`a percentage outside any MetricFigure: "${text.trim()}"`);
      continue;
    }
    const denominator = figure.getAttribute('data-metric-denominator');
    if (denominator === null || !/^\d+$/.test(denominator)) {
      violations.push(`a percentage whose figure carries no numeric denominator: "${text.trim()}"`);
    }
    const label = figure.querySelector('figcaption');
    if (label === null || (label.textContent ?? '').trim().length === 0) {
      violations.push(`a percentage whose figure carries no denominator label: "${text.trim()}"`);
    }
  }
  if (seen === 0) violations.push('the scan found no percentage at all, so it proved nothing');
  return violations;
}

/** VG-UI-021/013/017's element inventory, used by more than one assertion below. */
function coverageElements(scope: RenderedElement): readonly string[] {
  const required = [
    '[data-metric-figure]',
    '[data-coverage-catalogue-version]',
    '[data-coverage-window-from]',
    '[data-coverage-window-to]',
    '[data-coverage-skipped-count]',
    '[data-coverage-skipped-list]',
  ];
  return required.filter((selector) => scope.querySelector(selector) === null);
}

describe('every percentage carries its denominator, and the scan can fail (VG-UI-018)', () => {
  test('a rendered coverage region has no percentage outside a metric figure', () => {
    const doc = renderToDocument(
      h(
        coverage.CoveragePanel,
        { run: partialRun(), heading: 'Coverage for this run' },
        h(
          'ul',
          null,
          h('li', null, h(badge.TruthStateBadge, {
            state: 'VERIFIED_NOT_PRESENT',
            scope: { sourceId: 'SOURCE_ALPHA', windowDays: 30 },
          })),
        ),
      ),
    );
    assert.deepEqual(percentViolations(doc), []);
  });

  test('NEGATIVE CASE: a hand-written "98% removed" is reported by the same scan', () => {
    const doc = renderToDocument(h('p', null, '98% removed'));
    const violations = percentViolations(doc);
    assert.equal(violations.length, 1, `expected exactly one violation, got ${JSON.stringify(violations)}`);
    assert.match(violations[0] ?? '', /outside any MetricFigure/);
  });

  test('NEGATIVE CASE: a percentage inside a figure with a non-numeric denominator is reported', () => {
    const doc = renderToDocument(
      h('figure', { 'data-metric-figure': 'true', 'data-metric-denominator': 'many' }, h('p', null, '12 / many (40.0%)')),
    );
    assert.match(percentViolations(doc)[0] ?? '', /no numeric denominator/);
  });

  test('NEGATIVE CASE: NaN never reaches the DOM, and a zero denominator renders the literal', () => {
    const doc = renderToDocument(
      h(metric.MetricFigure, { label: 'Externally verified', numerator: 0, denominator: 0 }),
    );
    const text = accessibleText(doc.body);
    assert.match(text, /0 \/ 0 — not computable/);
    assert.equal(text.includes('NaN'), false, 'NaN must not be rendered');
    assert.equal(text.includes('%'), false, 'a not-computable figure renders no percentage');
    assert.equal(one(doc, '[data-metric-figure]').getAttribute('data-metric-computable'), 'false');
  });

  test('a computed figure renders numerator, denominator and percentage as separate text', () => {
    const doc = renderToDocument(
      h(metric.MetricFigure, { label: 'Sources attempted of the declared catalogue', numerator: 12, denominator: 30 }),
    );
    assert.equal(one(doc, '[data-metric-part="numerator"]').textContent, '12');
    assert.equal(one(doc, '[data-metric-part="denominator"]').textContent, '30');
    assert.equal(one(doc, '[data-metric-part="percent"]').textContent, '40.0%');
    assert.equal(accessibleText(one(doc, 'figcaption')), 'Sources attempted of the declared catalogue');
  });

  test('a figure that mixes two populations is refused rather than rendered', () => {
    assert.throws(
      () => renderToHtml(h(metric.MetricFigure, { label: 'Removals of requests', numerator: 412, denominator: 30 })),
      /exceeds denominator/,
    );
  });
});

describe('partial coverage is labelled above what it affects (VG-UI-017/022/050)', () => {
  test('both layouts render all five required elements', () => {
    const panel = renderToDocument(
      h(coverage.CoveragePanel, { run: partialRun(), heading: 'Coverage' }, h('p', null, 'listing rows')),
    );
    const summary = renderToDocument(h(coverage.CoverageSummaryInline, { run: partialRun() }));
    assert.deepEqual(coverageElements(one(panel, '[data-coverage-panel]')), [], 'the panel is missing elements');
    assert.deepEqual(coverageElements(one(summary, '[data-coverage-summary]')), [], 'the summary is missing elements');
  });

  test('the skipped list reveals every skipped Source with its reason', () => {
    const doc = renderToDocument(h(coverage.CoveragePanel, { run: partialRun(), heading: 'Coverage' }));
    const rows = all(doc, '[data-skipped-source]');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.getAttribute('data-skipped-source'), 'SOURCE_ALPHA');
    assert.match(accessibleText(rows[0] ?? null), /SOURCE_ALPHA — no permitted read path/);
    assert.match(accessibleText(rows[1] ?? null), /SOURCE_BETA — human verification gate/);
    // The control is a native disclosure element, so it is keyboard-operable without a script.
    assert.equal(one(doc, '[data-coverage-skipped-list]').tagName, 'DETAILS');
    assert.equal(all(doc, 'details > summary').length, 1);
  });

  test('with a partial run the banner precedes the content in DOM order', () => {
    const doc = renderToDocument(
      h(coverage.CoveragePanel, { run: partialRun(), heading: 'Coverage' }, h('p', { id: 'rows' }, 'listing rows')),
    );
    const panel = one(doc, '[data-coverage-panel]');
    const order = Array.from(panel.children).map((child) =>
      child.hasAttribute('data-partial-coverage')
        ? 'banner'
        : child.hasAttribute('data-coverage-content')
          ? 'content'
          : 'other',
    );
    assert.ok(order.includes('banner'), 'a partial run must render the banner');
    assert.ok(
      order.indexOf('banner') < order.indexOf('content'),
      `the banner must precede the content, got ${JSON.stringify(order)}`,
    );
  });

  test('a complete run renders no banner at all', () => {
    const doc = renderToDocument(h(coverage.CoveragePanel, { run: completeRun(), heading: 'Coverage' }, h('p', null, 'rows')));
    assert.equal(all(doc, '[data-partial-coverage]').length, 0);
    assert.equal(one(doc, '[data-metric-computable]').getAttribute('data-metric-computable'), 'true');
    assert.equal(accessibleText(one(doc, '[data-coverage-skipped-count]')), '0');
  });

  test('a VERIFIED_NOT_PRESENT region states its coverage bounds with the state', () => {
    // VG-UI-050's oracle: the coverage figures and the skipped count are in the SAME region as the absence statement,
    // so the reader cannot take "not found" away from its bound.
    const doc = renderToDocument(
      h(
        coverage.CoveragePanel,
        { run: partialRun(), heading: 'Coverage' },
        h('p', null, 'No record was found in the Sources that were checked.'),
        h(badge.TruthStateBadge, {
          state: 'VERIFIED_NOT_PRESENT',
          scope: { sourceId: 'SOURCE_ALPHA', windowDays: 30 },
        }),
      ),
    );
    const region = one(doc, '[data-coverage-panel]');
    const text = accessibleText(region);
    // The PAIR, asserted as the pair rather than as two numbers that happen to appear in the region.
    assert.equal(one(region, '[data-metric-part="numerator"]').textContent, '12');
    assert.equal(one(region, '[data-metric-part="denominator"]').textContent, '30');
    assert.match(text, /Sources were skipped in this run/);
    assert.match(text, /catalogue-2026-09-01/);
    assert.match(text, /SOURCE_BETA/);
    assert.match(text, /Not found in the coverage checked/);
    assert.equal(one(doc, '[data-truth-state]').getAttribute('data-truth-state'), 'VERIFIED_NOT_PRESENT');
  });
});

describe('confidence is never a bare number (VG-UI-019)', () => {
  const basis = [
    { feature: 'record-name-match', contribution: 0.42 },
    { feature: 'address-match', contribution: 0.3 },
    { feature: 'record-age-decay', contribution: -0.18 },
  ];

  test('the score renders as a decimal with every basis entry and the policy threshold', () => {
    const doc = renderToDocument(
      h(confidence.ConfidenceBasis, {
        value: 0.87,
        basis,
        threshold: 0.7,
        policyVersion: 'policy-2026-08-01',
      }),
    );
    const text = accessibleText(doc.body);
    assert.match(text, /Confidence 0\.87/);
    assert.match(text, /0\.70/);
    assert.match(text, /policy-2026-08-01/);
    for (const entry of basis) assert.match(text, new RegExp(entry.feature));
    assert.match(text, /\+0\.42/);
    assert.match(text, /−0\.18/);
    assert.equal(all(doc, '[data-confidence-entry]').length, 3);
    // The percentage rule (VG-UI-018) and the decimal rule (VG-UI-019) agree: no '%' appears in this region.
    assert.equal(
      textNodes(doc).some((node) => node.text.includes('%')),
      false,
      'a confidence value is a decimal and never a percentage (VG-UI-019)',
    );
  });

  test('NEGATIVE CASE: a score with an empty basis is refused, not rendered', () => {
    assert.throws(
      () =>
        renderToHtml(
          h(confidence.ConfidenceBasis, {
            value: 0.92,
            basis: [],
            threshold: 0.7,
            policyVersion: 'policy-2026-08-01',
          }),
        ),
      /no recorded basis/,
    );
  });

  test('NEGATIVE CASE: a score outside 0.00–1.00 is refused', () => {
    assert.throws(
      () =>
        renderToHtml(
          h(confidence.ConfidenceBasis, { value: 92, basis, threshold: 0.7, policyVersion: 'policy-2026-08-01' }),
        ),
      /outside the 0\.00–1\.00 range/,
    );
  });
});

describe('the timeline renders history as an ordered, read-only list (VG-UI-034/035/036/061)', () => {
  const events = [
    {
      eventId: 'evt-1',
      occurredAt: '2026-09-02T08:15:00Z',
      actorReference: 'actor:OPAQUE-1',
      eventName: 'RegisterSubject',
      evidenceName: 'SubjectRegistration',
      evidenceHref: '/auditor/claims?subject=OPAQUE-1',
    },
    {
      eventId: 'evt-2',
      occurredAt: '2026-09-05T09:30:00Z',
      actorReference: 'actor:OPAQUE-2',
      eventName: 'VerifyRemoval',
      state: 'VERIFIED_REMOVED',
      stateScope: { sourceId: 'SOURCE_ALPHA', windowDays: 30 },
      evidenceName: 'VerificationObservation',
    },
    {
      eventId: 'evt-3',
      occurredAt: '2026-09-11T10:45:00Z',
      actorReference: 'actor:OPAQUE-3',
      eventName: 'ObserveReappearance',
      state: 'REAPPEARED',
      evidenceName: 'VerificationObservation',
    },
  ];
  const timelineProps = { label: 'Case history, oldest first', events, timeZone: 'UTC' };

  test('one list item per event, in order, with the ordering exposed', () => {
    const doc = renderToDocument(h(timeline.TruthTimeline, timelineProps));
    const list = one(doc, '[data-timeline-list]');
    assert.equal(list.tagName, 'OL');
    assert.equal(list.getAttribute('aria-label'), 'Case history, oldest first');
    const rows = all(doc, '[data-timeline-row]');
    assert.equal(rows.length, events.length, 'a row count below the event count is the failure VG-UI-034 names');
    assert.deepEqual(
      rows.map((row) => row.getAttribute('data-event-id')),
      ['evt-1', 'evt-2', 'evt-3'],
    );
    assert.equal(one(doc, '[data-truth-timeline]').getAttribute('data-timeline-order'), 'oldest-first');
  });

  test('each row name carries timestamp, actor, event, state label and its position', () => {
    const doc = renderToDocument(h(timeline.TruthTimeline, timelineProps));
    const rows = all(doc, '[data-timeline-row]');
    const second = rows[1]?.getAttribute('aria-label') ?? '';
    assert.match(second, /05 Sept 2026, 09:30:00 GMT\+00:00/);
    assert.match(second, /actor:OPAQUE-2/);
    assert.match(second, /VerifyRemoval/);
    assert.match(second, /Verified not found at this Source/);
    assert.match(second, /Source: SOURCE_ALPHA/);
    assert.match(second, /window 30d/);
    assert.match(second, /event 2 of 3/);
    // Every row carries its position, which is how the ordering reaches a screen reader.
    for (const [index, row] of rows.entries()) {
      assert.match(row.getAttribute('aria-label') ?? '', new RegExp(`event ${String(index + 1)} of 3`));
    }
  });

  test('the mandatory qualifier is visible in the row, not hidden behind a control (VG-UI-010)', () => {
    const doc = renderToDocument(h(timeline.TruthTimeline, timelineProps));
    const qualifier = one(doc, '[data-truth-state-qualifier="VERIFIED_REMOVED"]');
    assert.match(accessibleText(qualifier), /^Independent re-observation did not find this record/);
    assert.equal(qualifier.closest('details'), null, 'the qualifier must not sit inside a closed disclosure');
    assert.equal(qualifier.hasAttribute('hidden'), false);
    // The badge points its accessible description at the visible qualifier node.
    const row = one(doc, '[data-event-id="evt-2"]');
    const stateBadge = one(row, '[data-truth-state]');
    assert.equal(stateBadge.getAttribute('aria-describedby'), 'evt-2-qualifier');
  });

  test('NEGATIVE CASE: the timeline offers no edit, delete or reorder affordance', () => {
    const doc = renderToDocument(h(timeline.TruthTimeline, timelineProps));
    const controls = all(doc, 'button, input, select, textarea, [contenteditable], [draggable="true"]');
    assert.deepEqual(
      controls.map((control) => control.tagName),
      [],
      'VG-UI-035: the timeline is a read-only projection',
    );
  });

  test('newest-first reverses the DOM order and says so', () => {
    const doc = renderToDocument(h(timeline.TruthTimeline, { ...timelineProps, order: 'newest-first' }));
    assert.equal(one(doc, '[data-truth-timeline]').getAttribute('data-timeline-order'), 'newest-first');
    assert.deepEqual(
      all(doc, '[data-timeline-row]').map((row) => row.getAttribute('data-event-id')),
      ['evt-3', 'evt-2', 'evt-1'],
    );
  });

  test('a live update announces once, outside the list', () => {
    const doc = renderToDocument(
      h(timeline.TruthTimeline, { ...timelineProps, announcement: 'One new event: ObserveReappearance.' }),
    );
    const regions = all(doc, '[aria-live]');
    assert.equal(regions.length, 1, 'exactly one polite announcement per update (VG-UI-061)');
    const region = regions[0];
    assert.equal(region?.getAttribute('aria-live'), 'polite');
    assert.equal(region?.getAttribute('role'), 'status');
    assert.equal(accessibleText(region ?? null), 'One new event: ObserveReappearance.');
    // It is a SIBLING of the list: a live region wrapping the list would re-read every row on every update.
    assert.equal(region?.querySelector('[data-timeline-row]'), null);
    assert.equal(region?.closest('ol'), null);
  });

  test('NEGATIVE CASE: a future-dated event is refused when the caller states the present', () => {
    assert.throws(
      () =>
        renderToHtml(
          h(timeline.TruthTimeline, {
            ...timelineProps,
            now: '2026-09-10T00:00:00Z',
          }),
        ),
      /refusing to render 1 event\(s\) dated after/,
    );
  });
});

describe('one coverage renderer in the source tree, and no unpaired coverage sentence (VG-UI-017)', () => {
  /** Every `.ts`/`.tsx` file under `ui/src`, as `[relative path, text]`. */
  function uiFiles(): readonly (readonly [string, string])[] {
    const out: (readonly [string, string])[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        out.push([relative(PROJECT_ROOT, full).replace(/\\/g, '/'), readFileSync(full, 'utf8')]);
      }
    };
    walk(UI_SRC);
    return out;
  }

  /** The renderer declarations: the two data hooks VG-UI-017 permits, and nothing else. */
  function rendererFiles(files: readonly (readonly [string, string])[]): string[] {
    return files
      .filter(([, text]) => text.includes('data-coverage-panel=') || text.includes('data-coverage-summary='))
      .map(([path]) => path);
  }

  /**
   * A percentage written by hand outside the coverage components. The scan reads STRING LITERALS and JSX text rather
   * than the whole file, because a comment may legitimately discuss the rule.
   */
  function unpairedPercentFiles(files: readonly (readonly [string, string])[]): string[] {
    const out: string[] = [];
    for (const [path, text] of files) {
      if (path.includes('components/coverage/')) continue;
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/['"`][^'"`\n]*%/.test(code)) out.push(path);
    }
    return out;
  }

  /** A coverage sentence that claims a scope without the attempted/total pair beside it. */
  function universalClaimFiles(files: readonly (readonly [string, string])[]): string[] {
    const phrases = [/of our sources/i, /of all sources/i, /every source on the web/i, /the whole internet/i];
    const out: string[] = [];
    for (const [path, text] of files) {
      if (path.includes('components/coverage/')) continue;
      if (phrases.some((phrase) => phrase.test(text))) out.push(path);
    }
    return out;
  }

  test('exactly one file declares each coverage renderer, and it is the coverage component', () => {
    const files = uiFiles();
    assert.ok(files.length > 10, `the scan must read the tree, read ${String(files.length)} files`);
    assert.deepEqual(rendererFiles(files), ['ui/src/components/coverage/CoveragePanel.tsx']);
  });

  test('no percentage is written by hand outside the coverage components', () => {
    const files = uiFiles();
    assert.deepEqual(unpairedPercentFiles(files), []);
  });

  test('NEGATIVE CASE: a hand-written "98% of our sources" is reported by both scans', () => {
    const planted = [['ui/src/routes/planted.tsx', "export const notice = 'We checked 98% of our sources';"]] as const;
    assert.deepEqual(unpairedPercentFiles(planted), ['ui/src/routes/planted.tsx']);
    assert.deepEqual(universalClaimFiles(planted), ['ui/src/routes/planted.tsx']);
  });
});

describe('conflated metrics are rendered as separate labelled units (VG-UI-013/021)', () => {
  test('a Source effect and a search effect are two units with two denominators', () => {
    const doc = renderToDocument(
      h(
        'div',
        null,
        h(metric.MetricFigure, {
          label: 'Exposures independently verified as not found at their Source',
          numerator: 7,
          denominator: 20,
        }),
        h(metric.MetricFigure, {
          label: 'Search results delisted',
          numerator: 3,
          denominator: 9,
        }),
      ),
    );
    const figures = all(doc, '[data-metric-figure]');
    assert.equal(figures.length, 2, 'each effect is its own unit');
    assert.equal(accessibleText(figures[0] ?? null).includes('delisted'), false, 'no unit mixes the two effects');
    assert.equal(accessibleText(figures[1] ?? null).includes('not found at their Source'), false);
    assert.equal(one(figures[0] ?? doc, '[data-metric-part="denominator"]').textContent, '20');
    assert.equal(one(figures[1] ?? doc, '[data-metric-part="denominator"]').textContent, '9');
    assert.deepEqual(percentViolations(doc), []);
  });

  test('in-flight work is never rendered in the same unit as a verified count (VG-UI-021)', () => {
    // VG-UI-011/021's oracle, at the figure level: a unit whose label speaks of removal must not contain a submitted or
    // in-flight count, and the in-flight unit's own label must not speak of removal, deletion, success or completion.
    const removalLanguage = /remov|delet|success|complete/i;
    const doc = renderToDocument(
      h(
        'div',
        null,
        h(metric.MetricFigure, {
          label: 'Exposures independently verified as not found at their Source',
          numerator: 7,
          denominator: 20,
        }),
        h(metric.MetricFigure, {
          label: 'Request cases submitted and awaiting a response',
          numerator: 412,
          denominator: 500,
        }),
      ),
    );
    const figures = all(doc, '[data-metric-figure]');
    assert.equal(figures.length, 2, 'submitted work and verified effects are separate units');
    const removalFigure = accessibleText(figures[0] ?? null);
    const inFlightFigure = accessibleText(figures[1] ?? null);
    assert.match(removalFigure, /not found at their Source/);
    assert.equal(
      /submitted|awaiting|in flight/i.test(removalFigure),
      false,
      'a unit labelled with a verified effect must not carry submitted work',
    );
    assert.match(inFlightFigure, /submitted and awaiting a response/);
    assert.equal(
      removalLanguage.test(inFlightFigure),
      false,
      'a submitted count must not be labelled as a removal, a deletion, a success or a completion',
    );
    // Each unit carries its OWN denominator: 20 for the verified figure, 500 for the in-flight one.
    assert.equal(one(figures[0] ?? doc, '[data-metric-part="denominator"]').textContent, '20');
    assert.equal(one(figures[1] ?? doc, '[data-metric-part="denominator"]').textContent, '500');
  });
});
