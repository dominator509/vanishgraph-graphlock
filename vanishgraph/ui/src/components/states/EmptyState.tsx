/**
 * `EmptyState` — an absence statement, always with its scope (SPEC-004 §9 VG-UI-049; EP-005 M4).
 *
 * AN EMPTY STATE IS A STATEMENT ABOUT A SEARCH, NOT ABOUT THE WORLD. "No records found" is true of a query and false as
 * a claim about a person's data, so VG-UI-049 requires four things in every empty state: what was searched, over what
 * coverage, in what window, and one next action. All four are REQUIRED PROPS here, which is the point — a caller cannot
 * render an absence statement without its scope, and the failure this prevents is not an ugly page but an unqualified
 * claim.
 *
 * THE COVERAGE PART IS A `CoverageRun`, NOT A SENTENCE. VG-UI-017 makes `CoveragePanel`/`CoverageSummaryInline` the only
 * coverage presentation, so the empty state renders `CoverageSummaryInline` rather than paraphrasing the figures — and
 * that also means a partial run brings its banner and its skipped-Source list into the empty state automatically, which
 * is exactly where VG-UI-022's "absence statement with no banner" defect would otherwise appear.
 *
 * THE NEXT ACTION IS A PROP, NOT A LINK THIS COMPONENT INVENTS. A generic "learn more" would be a control the surface
 * does not own; the surface passes the action it can actually offer, and when there is genuinely nothing to offer the
 * caller passes `nextAction: null` and the state says so rather than pretending.
 */

import type { ReactNode } from 'react';

import { CoverageSummaryInline, type CoverageRun } from '../coverage/CoveragePanel.tsx';

export interface EmptyStateProps {
  /** What was searched, in the reader's terms. */
  readonly searched: string;
  /** The window the search covered. */
  readonly window: { readonly from: string; readonly to: string };
  /** The coverage the search ran over: rendered through the one coverage renderer, with its denominators. */
  readonly coverage: CoverageRun;
  /** One next action, or `null` when the surface can offer none — stated rather than replaced by a generic link. */
  readonly nextAction: ReactNode | null;
}

export function EmptyState({ searched, window, coverage, nextAction }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="vg-empty" data-empty-state="true" data-empty-searched={searched}>
      <h3 className="vg-empty__heading">{`Nothing was found for ${searched}`}</h3>
      <p className="vg-empty__scope">
        {'Searched: '}
        <span data-empty-searched-detail="true">{searched}</span>
        {'. Window '}
        <span data-empty-window="true">
          {window.from}
          {' to '}
          {window.to}
        </span>
        {'. Coverage for this search:'}
      </p>
      <CoverageSummaryInline run={coverage} />
      <p className="vg-empty__next">
        {nextAction === null ? (
          <span data-empty-no-action="true">
            There is no action available from here for this search. Nothing was skipped silently: the coverage above
            lists what was and was not checked.
          </span>
        ) : (
          <span data-empty-next-action="true">{nextAction}</span>
        )}
      </p>
    </div>
  );
}
