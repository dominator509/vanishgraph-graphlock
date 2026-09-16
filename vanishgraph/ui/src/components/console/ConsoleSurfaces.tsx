/**
 * Operations console surfaces (SPEC-004 §1, §9 VG-UI-055; EP-005 M6).
 *
 * THE QUEUE IS THE ONE SURFACE WITH A REQUIREMENT THAT IS EASY TO SATISFY BADLY. VG-UI-055 asks for the seven region
 * states AND for `HUMAN_REQUIRED` and `NOT_REMOVABLE` counts rendered BY DEFAULT as first-class columns — the second
 * half exists because the tempting dashboard drops the outcomes that make the success rate look worse (SPEC-000 §7.6,
 * VG-UI-068). So `CaseQueue` takes the outcome counts as REQUIRED props and renders both columns unconditionally: a
 * caller cannot build a queue that omits them, and the suite's negative case is exactly that.
 *
 * RECIPE FRESHNESS IS RENDERED WITH ITS DISABLED REASON. `writesEnabled: false` without `disabledReason` would leave an
 * operator to guess why a channel is closed, and the guess would usually be "the product is broken" rather than "the
 * source's terms changed".
 */

import { MetricFigure } from '../coverage/MetricFigure.tsx';

export interface CaseQueueCounts {
  /** Required: VG-UI-016/068 make this a first-class column, never a footnote. */
  readonly humanRequired: number;
  /** Required, for the same reason. */
  readonly notRemovable: number;
  readonly open: number;
  readonly inFlight: number;
}

export interface CaseQueueRow {
  readonly caseId: string;
  readonly sourceId: string;
  readonly truthState: string;
  readonly channel: string;
  readonly nextDeadline: string | null;
}

export function CaseQueue({
  counts,
  rows,
  total,
}: {
  readonly counts: CaseQueueCounts;
  readonly rows: readonly CaseQueueRow[];
  /** The denominator for the queue's figures: how many cases the query matched before paging. */
  readonly total: number;
}): React.JSX.Element {
  return (
    <div className="vg-queue" data-case-queue="true" data-queue-total={String(total)}>
      <div className="vg-queue__columns" data-queue-outcome-columns="true">
        {/* BOTH OUTCOME COLUMNS ARE UNCONDITIONAL. The counts are required props, and they are rendered even at zero,
            because a column that disappears at zero is a column a reader learns not to look for. */}
        <MetricFigure label="Cases needing a person (HUMAN_REQUIRED)" numerator={counts.humanRequired} denominator={total} />
        <MetricFigure label="Cases that are not removable (NOT_REMOVABLE)" numerator={counts.notRemovable} denominator={total} />
        <MetricFigure label="Open cases" numerator={counts.open} denominator={total} />
        <MetricFigure label="Cases with work in flight" numerator={counts.inFlight} denominator={total} />
      </div>
      <table className="vg-queue__table">
        <caption>{`${String(rows.length)} of ${String(total)} cases`}</caption>
        <thead>
          <tr>
            <th scope="col">Case</th>
            <th scope="col">Source</th>
            <th scope="col">State</th>
            <th scope="col">Channel</th>
            <th scope="col">Next deadline</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.caseId} data-queue-row={row.caseId}>
              <td>
                <a href={`/console/cases/${row.caseId}`}>{row.caseId}</a>
              </td>
              <td data-queue-row-source="true">{row.sourceId}</td>
              <td data-queue-row-state={row.truthState}>{row.truthState}</td>
              <td data-queue-row-channel="true">{row.channel}</td>
              <td>{row.nextDeadline === null ? 'none recorded' : <time dateTime={row.nextDeadline}>{row.nextDeadline}</time>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface RecipeFreshnessRow {
  readonly recipeId: string;
  readonly sourceId: string;
  readonly freshnessState: string;
  readonly writesEnabled: boolean;
  /** Required when `writesEnabled` is false: the named reason the channel is closed. */
  readonly disabledReason?: string | null;
}

export function RecipeFreshness({ rows }: { readonly rows: readonly RecipeFreshnessRow[] }): React.JSX.Element {
  for (const row of rows) {
    if (!row.writesEnabled && (row.disabledReason === undefined || row.disabledReason === null || row.disabledReason.length === 0)) {
      throw new Error(
        `RecipeFreshness: source ${row.sourceId} has writes disabled with no named reason; an operator cannot act on a closed channel whose closure is unexplained`,
      );
    }
  }
  return (
    <div className="vg-recipes" data-recipe-freshness="true">
      <ul className="vg-recipes__list">
        {rows.map((row) => (
          <li key={row.recipeId} data-recipe-row={row.recipeId} data-recipe-writes-enabled={String(row.writesEnabled)}>
            <dl>
              <dt>Source</dt>
              <dd data-recipe-source="true">{row.sourceId}</dd>
              <dt>Freshness</dt>
              <dd data-recipe-freshness-state="true">{row.freshnessState}</dd>
              <dt>Writes</dt>
              <dd data-recipe-writes="true">
                {row.writesEnabled ? 'enabled for this source' : `disabled: ${row.disabledReason ?? ''}`}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
