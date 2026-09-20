/**
 * `MetricFigure` — the ONLY unit in which a percentage or ratio renders (SPEC-004 §3 VG-UI-018; EP-005 M3).
 *
 * WHY THIS IS A COMPONENT RATHER THAN A FORMATTING HELPER. SPEC-000 §7.4 says a percentage without its denominator is a
 * defect, and the failure mode it names is not a wrong number: it is a RIGHT number rendered alone, which reads as a
 * complete measurement. A helper function can be bypassed by writing the string directly; a single component that
 * renders the numerator, the denominator and the label as THREE SEPARATE TEXT NODES inside one `<figure>` gives a DOM
 * scan something to prove — the percentage cannot exist without its pair in the same unit, because this is the only
 * place that renders one (asserted by `tests/contract/coverage-presentation.test.ts`).
 *
 * A ZERO DENOMINATOR RENDERS THE LITERAL `0 / 0 — not computable`. It must not render `0%` and it must not render
 * `NaN`: a metric with nothing to divide by has no value, and "0%" is a value. That is the difference between "we found
 * nothing to count" and "we counted nothing found".
 *
 * IT REFUSES IMPOSSIBLE INPUT RATHER THAN PRINTING IT. A negative count, a non-finite count, or a numerator larger than
 * its denominator is a conflated metric (VG-UI-046: a figure that mixes in-flight work into a removal count shows up
 * exactly this way), so the figure throws instead of rendering a number nobody can trust.
 */

/** The literal a zero denominator renders, exactly as SPEC-004 §3 VG-UI-018 spells it. */
export const NOT_COMPUTABLE = '0 / 0 — not computable';

export interface MetricFigureProps {
  /** The DENOMINATOR LABEL: what the denominator counts. Without it the pair has no meaning. */
  readonly label: string;
  readonly numerator: number;
  readonly denominator: number;
  /** Rendered when the denominator is zero, so "no value" comes with its reason (VG-UI-045). */
  readonly notComputableReason?: string;
  /** Marks the figure as computed over partial coverage (VG-UI-050): a partial total is never rendered as complete. */
  readonly partial?: boolean;
}

/** One decimal place, so two figures for the same pair never disagree about rounding. */
function percentageOf(numerator: number, denominator: number): string {
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/** Throws when `violation` holds. The argument is the VIOLATION, not the acceptable value — MEASURED: the first version
 * passed `Number.isFinite(numerator)`, so a valid figure threw and the defect was invisible until a render ran. */
function refuse(violation: boolean, message: string): void {
  if (violation) throw new Error(`MetricFigure: ${message}`);
}

export function MetricFigure({
  label,
  numerator,
  denominator,
  notComputableReason,
  partial = false,
}: MetricFigureProps): React.JSX.Element {
  refuse(!Number.isFinite(numerator), `numerator ${String(numerator)} is not a finite number`);
  refuse(!Number.isFinite(denominator), `denominator ${String(denominator)} is not a finite number`);
  refuse(numerator < 0 || denominator < 0, 'a count cannot be negative');
  refuse(
    denominator === 0 && numerator !== 0,
    `a zero denominator with numerator ${String(numerator)} has no value, and the literal this component renders for an uncomputable figure is "0 / 0", which would misstate the numerator`,
  );
  refuse(
    denominator !== 0 && numerator > denominator,
    `numerator ${String(numerator)} exceeds denominator ${String(denominator)}: a part cannot be larger than its whole, so this figure mixes two populations`,
  );

  const computable = denominator !== 0;
  return (
    <figure
      className={`vg-metric${partial ? ' vg-metric--partial' : ''}`}
      data-metric-figure="true"
      data-metric-numerator={String(numerator)}
      data-metric-denominator={String(denominator)}
      data-metric-computable={computable ? 'true' : 'false'}
      data-metric-partial={partial ? 'true' : 'false'}
    >
      <figcaption className="vg-metric__label">{label}</figcaption>
      {computable ? (
        <p className="vg-metric__value">
          <span data-metric-part="numerator">{numerator}</span>
          {' / '}
          <span data-metric-part="denominator">{denominator}</span>
          {' ('}
          <span data-metric-part="percent">{percentageOf(numerator, denominator)}</span>
          {')'}
        </p>
      ) : (
        <>
          <p className="vg-metric__value" data-metric-part="not-computable">
            {NOT_COMPUTABLE}
          </p>
          {notComputableReason !== undefined ? (
            <p className="vg-metric__reason">{notComputableReason}</p>
          ) : null}
        </>
      )}
      {partial ? (
        <p className="vg-metric__partial-note" data-metric-partial-note="true">
          partial coverage: this figure is computed over the Sources that were checked, not over the whole catalogue
        </p>
      ) : null}
    </figure>
  );
}
