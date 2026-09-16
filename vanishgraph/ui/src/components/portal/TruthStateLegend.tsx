/**
 * `TruthStateLegend` — the eleven states, rendered from the canonical mapping (SPEC-004 §2.2/§11; EP-005 M5).
 *
 * IT ITERATES `TRUTH_STATE_TOKENS` AND READS `TRUTH_STATE_COPY`. VG-UI-007 permits exactly one mapping, and a legend is
 * the most tempting place to write a second one — a short "plain English" summary next to each state, typed by hand,
 * which then drifts from the label the badge renders. There is no summary text in this file: the label, the qualifier,
 * the glyph and the machine value all come from the canonical module, and the copy-equality suite asserts that module
 * against the specification.
 *
 * THE ORDER IS THE SPECIFICATION'S ORDER, which is why the tokens are not sorted: grouped by meaning, the eleven read
 * as a progression, and `TRUTH_STATE_TOKENS` carries that order.
 */

import { TRUTH_STATE_COPY, TRUTH_STATE_TOKENS } from '../../copy/truth-state.ts';
import { TruthStateBadge } from '../truth/TruthStateBadge.tsx';

export interface TruthStateLegendProps {
  /** The id prefix for the qualifier nodes, so a page can render two legends without id collisions. */
  readonly idPrefix: string;
}

/**
 * The scope a legend entry shows, with an EXAMPLE Source.
 *
 * THE BADGE REFUSES TO RENDER A SCOPE-REQUIRING STATE WITHOUT A SCOPE, and that refusal is not loosened for the legend:
 * a legend entry for `VERIFIED_REMOVED` genuinely needs a Source and a window on screen, because the state means
 * nothing without them. The legend therefore supplies an explicitly example scope and says so in its own text, which is
 * the difference between showing the shape of the claim and showing a claim.
 */
const EXAMPLE_SCOPE = { sourceId: 'EXAMPLE_SOURCE', windowDays: 30 } as const;

export function TruthStateLegend({ idPrefix }: TruthStateLegendProps): React.JSX.Element {
  return (
    <section className="vg-legend" data-truth-state-legend="true" aria-labelledby={`${idPrefix}-heading`}>
      <h2 id={`${idPrefix}-heading`}>What each state means</h2>
      <p className="vg-legend__intro">
        Every record in this service carries one of eleven states. The state is shown as a label, a glyph and the exact
        machine value, so it does not depend on colour. The sentence under each one is the qualification that belongs to
        it, and it is the same sentence wherever the state appears. Where a state names a Source and a window, this
        legend shows an example scope — a real record carries its own.
      </p>
      <dl className="vg-legend__list">
        {TRUTH_STATE_TOKENS.map((token) => {
          const copy = TRUTH_STATE_COPY[token];
          return (
            <div className="vg-legend__entry" key={token} data-legend-state={token}>
              <dt>
                <TruthStateBadge
                  state={token}
                  scope={copy.requiresScope ? EXAMPLE_SCOPE : undefined}
                  qualifierId={`${idPrefix}-${token}-qualifier`}
                />
              </dt>
              <dd>
                <p id={`${idPrefix}-${token}-qualifier`} data-legend-qualifier={token}>
                  {copy.qualifier}
                </p>
                <p className="vg-legend__description">{copy.description}</p>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
