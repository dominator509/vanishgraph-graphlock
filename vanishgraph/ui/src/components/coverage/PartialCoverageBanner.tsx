/**
 * `PartialCoverageBanner` and `PartialCoverageMarker` — partial coverage is stated above what it affects
 * (SPEC-004 §3 VG-UI-022, §9 VG-UI-050; EP-005 M3).
 *
 * THE RULE THIS COMPONENT EXISTS FOR. An absence statement is the most dangerous sentence this product can render,
 * because "no record was found" is true of a query and false as a claim about a person's data. VG-DISC-002 therefore
 * forbids an unqualified absence, and VG-UI-050 requires the qualified form in three places at once: the banner, a
 * marker on each affected row, and the skipped-Source list with reasons. All three are here, and a caller cannot render
 * the banner without the figures — `sourcesAttempted`, `sourcesTotal`, the catalogue version, the run window and the
 * skipped count are required props, not options, so a banner claiming partial coverage without saying HOW partial does
 * not compile.
 *
 * THE BANNER CARRIES A `MetricFigure` RATHER THAN A SENTENCE. Writing "12 of 30 Sources were checked" by hand would put
 * a ratio outside the one unit VG-UI-018 permits, which is exactly how a denominator gets dropped later by someone
 * editing prose. It also inherits the partial label from the figure, so an aggregate over partial coverage can never be
 * rendered as complete.
 *
 * IT STATES THE BOUND, NOT THE ABSENCE. The closing sentence says what the coverage does NOT cover. It deliberately does
 * not restate the result: a banner that repeated the findings would be read as the finding.
 */

import { MetricFigure } from './MetricFigure.tsx';

export interface CoverageWindow {
  /** ISO 8601, as returned by the API — never reformatted here (the timeline owns timezone presentation). */
  readonly from: string;
  readonly to: string;
}

export interface PartialCoverageProps {
  readonly sourcesAttempted: number;
  readonly sourcesTotal: number;
  readonly skippedCount: number;
  /** The declared catalogue version, or null when the response did not declare one (see CoverageRun). */
  readonly catalogueVersion: string | null;
  readonly runWindow: CoverageWindow;
}

/**
 * The banner. `variant` is `block` for the top of a region and `inline` for the header of a list or table, and BOTH
 * render the same figures: an inline variant is a smaller layout, never a weaker statement.
 */
export function PartialCoverageBanner({
  sourcesAttempted,
  sourcesTotal,
  skippedCount,
  catalogueVersion,
  runWindow,
  variant = 'block',
}: PartialCoverageProps & { readonly variant?: 'block' | 'inline' }): React.JSX.Element {
  return (
    <div
      className={`vg-partial-banner vg-partial-banner--${variant}`}
      data-partial-coverage="true"
      data-partial-coverage-skipped={String(skippedCount)}
      role="note"
    >
      <p className="vg-partial-banner__headline">Coverage was partial for this run.</p>
      <MetricFigure
        label="Sources checked of the declared catalogue"
        numerator={sourcesAttempted}
        denominator={sourcesTotal}
        partial
      />
      <p className="vg-partial-banner__facts">
        {'Catalogue version '}
        {catalogueVersion === null ? (
          <span data-partial-coverage-catalogue-version="true" data-coverage-catalogue-absent="true">
            not declared in this response
          </span>
        ) : (
          <span data-partial-coverage-catalogue-version="true">{catalogueVersion}</span>
        )}
        {'. Run window '}
        <span data-partial-coverage-window="true">
          {runWindow.from}
          {' to '}
          {runWindow.to}
        </span>
        {'. '}
        <span data-partial-coverage-skipped-count="true">{skippedCount}</span>
        {' Sources were skipped; each one and its reason are listed with this run.'}
      </p>
      <p className="vg-partial-banner__bound">
        This does not cover the Sources that were not checked, and it does not cover copies held elsewhere such as
        backups or downstream republishing. A record not being listed here is not evidence that it does not exist
        outside the checked scope.
      </p>
    </div>
  );
}

/**
 * The affected-row marker. PLAIN TEXT, NOT A GLYPH OR A COLOUR: VG-UI-022 requires a "partial coverage" marker that a
 * reader and a screen reader both get, and a marker carried only by colour is one VG-UI-057 forbids for state.
 */
export function PartialCoverageMarker(): React.JSX.Element {
  return (
    <span className="vg-partial-marker" data-partial-coverage-marker="true">
      partial coverage
    </span>
  );
}

