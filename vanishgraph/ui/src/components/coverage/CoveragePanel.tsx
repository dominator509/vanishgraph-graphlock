/**
 * `CoveragePanel` and `CoverageSummaryInline` — the only coverage presentation in the application
 * (SPEC-004 §3 VG-UI-017, §9 VG-UI-050; EP-005 M3).
 *
 * ONE RENDERER, TWO LAYOUTS. VG-UI-017 permits exactly one coverage renderer "or its CoverageSummaryInline variant",
 * so both layouts here render the SAME `CoverageFacts` node: a second renderer would be a second place for the
 * attempted/total pair to be dropped, and the requirement's own negative case is a hand-written coverage sentence
 * without the pair. `tests/contract/coverage-presentation.test.ts` scans the UI source tree for a second renderer and
 * for a ratio outside a `MetricFigure`.
 *
 * ALL FIVE ELEMENTS ARE UNCONDITIONAL: the attempted count, the total, the declared catalogue version, the run window,
 * and the skipped-Source count with a control that reveals each skipped Source and its reason. They are required props,
 * so a caller cannot render "coverage complete" by omitting them — the failure VG-UI-017 exists to prevent is not a
 * wrong figure, it is a missing qualifier that makes a bounded answer read as a complete one.
 *
 * THE SKIPPED-SOURCE CONTROL IS A NATIVE `<details>`. It is keyboard-operable and announced without a script, which is
 * the honest form at this milestone: a custom button would need a handler and state that M5/M6 own when they mount these
 * components against the API. When nothing was skipped the control still renders, and says so — a disclosure that
 * revealed nothing would be a control a reader cannot explain.
 *
 * THE BANNER IS RENDERED BEFORE THE CHILDREN, which is VG-UI-022's ordering rule: the qualification must be read before
 * the thing it qualifies, in DOM order and in reading order alike.
 */

import type { ReactNode } from 'react';

import { MetricFigure } from './MetricFigure.tsx';
import { PartialCoverageBanner, type CoverageWindow } from './PartialCoverageBanner.tsx';

/** A Source the run did not check, with the reason it was skipped (VG-DISC-002). */
export interface SkippedSource {
  readonly sourceId: string;
  readonly reason: string;
}

export interface CoverageRun {
  readonly sourcesAttempted: number;
  readonly sourcesTotal: number;
  /**
   * The declared catalogue version, or `null` when the response did not declare one.
   *
   * `null` IS A MEASURED CASE (EP-005 M5): SPEC-003 §5.4.3's discovery-run coverage block declares no catalogue field,
   * while SPEC-004 §3 requires the declared catalogue version beside every coverage figure. The element is ALWAYS
   * rendered — omitting it would drop a mandatory part of VG-UI-017 — and when the response declared nothing, it says
   * so. A plausible-looking default would be a fabricated provenance for a coverage claim.
   */
  readonly catalogueVersion: string | null;
  readonly runWindow: CoverageWindow;
  readonly skippedSources: readonly SkippedSource[];
}

/** Whether the run is partial: attempted below total. DERIVED, so a caller cannot label a partial run as complete. */
export function isPartialCoverage(run: CoverageRun): boolean {
  return run.sourcesAttempted < run.sourcesTotal;
}

/**
 * The five required elements. Exported because both layouts render it and because a later surface that needs the facts
 * without a panel must reuse THIS node rather than restate the elements.
 */
export function CoverageFacts({ run }: { readonly run: CoverageRun }): React.JSX.Element {
  const partial = isPartialCoverage(run);
  return (
    <div className="vg-coverage__facts" data-coverage-facts="true">
      <MetricFigure
        label="Sources attempted of the declared catalogue"
        numerator={run.sourcesAttempted}
        denominator={run.sourcesTotal}
        partial={partial}
      />
      <p className="vg-coverage__catalogue">
        {'Declared catalogue version '}
        {run.catalogueVersion === null ? (
          <span data-coverage-catalogue-version="true" data-coverage-catalogue-absent="true">
            not declared in this response
          </span>
        ) : (
          <span data-coverage-catalogue-version="true">{run.catalogueVersion}</span>
        )}
      </p>
      <p className="vg-coverage__window">
        {'Run window '}
        <time data-coverage-window-from="true" dateTime={run.runWindow.from}>
          {run.runWindow.from}
        </time>
        {' to '}
        <time data-coverage-window-to="true" dateTime={run.runWindow.to}>
          {run.runWindow.to}
        </time>
      </p>
      <p className="vg-coverage__skipped-count">
        <span data-coverage-skipped-count="true">{run.skippedSources.length}</span>
        {' Sources were skipped in this run.'}
      </p>
      <details className="vg-coverage__skipped" data-coverage-skipped-list="true">
        <summary>
          {run.skippedSources.length === 0
            ? 'Skipped Sources: show the reason list'
            : `Skipped Sources: show all ${String(run.skippedSources.length)} and the reason for each`}
        </summary>
        {run.skippedSources.length === 0 ? (
          <p>No Source was skipped in this run: every Source in the declared catalogue was attempted.</p>
        ) : (
          <ul>
            {run.skippedSources.map((skipped) => (
              <li key={skipped.sourceId} data-skipped-source={skipped.sourceId}>
                <span className="vg-coverage__skipped-source">{skipped.sourceId}</span>
                {' — '}
                <span className="vg-coverage__skipped-reason">{skipped.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}

export interface CoveragePanelProps {
  readonly run: CoverageRun;
  /** The panel's heading, so the region has an accessible name. */
  readonly heading: string;
  readonly children?: ReactNode;
}

/** The block renderer: a named region containing the facts, the banner when the run is partial, and the content. */
export function CoveragePanel({ run, heading, children }: CoveragePanelProps): React.JSX.Element {
  return (
    <section className="vg-coverage" data-coverage-panel="true" aria-label={heading}>
      <h2 className="vg-coverage__heading">{heading}</h2>
      <CoverageFacts run={run} />
      {isPartialCoverage(run) ? (
        <PartialCoverageBanner
          sourcesAttempted={run.sourcesAttempted}
          sourcesTotal={run.sourcesTotal}
          skippedCount={run.skippedSources.length}
          catalogueVersion={run.catalogueVersion}
          runWindow={run.runWindow}
        />
      ) : null}
      <div className="vg-coverage__content" data-coverage-content="true">
        {children}
      </div>
    </section>
  );
}

export interface CoverageSummaryInlineProps {
  readonly run: CoverageRun;
}

/**
 * The compact variant: the same facts without a heading, for the header of a list or a table that already has one. It
 * renders NO content of its own, so a caller cannot accidentally nest a second region inside it.
 */
export function CoverageSummaryInline({ run }: CoverageSummaryInlineProps): React.JSX.Element {
  return (
    <div className="vg-coverage vg-coverage--inline" data-coverage-summary="true">
      <CoverageFacts run={run} />
      {isPartialCoverage(run) ? (
        <PartialCoverageBanner
          sourcesAttempted={run.sourcesAttempted}
          sourcesTotal={run.sourcesTotal}
          skippedCount={run.skippedSources.length}
          catalogueVersion={run.catalogueVersion}
          runWindow={run.runWindow}
          variant="inline"
        />
      ) : null}
    </div>
  );
}
