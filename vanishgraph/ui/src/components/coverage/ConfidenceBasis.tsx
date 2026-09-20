/**
 * `ConfidenceBasis` — a confidence value is never rendered without its basis (SPEC-004 §3 VG-UI-019; EP-005 M3).
 *
 * THE RULE AND WHY IT IS A REFUSAL RATHER THAN A WARNING. SPEC-000 §7.5 says uncertainty is reported, not smoothed.
 * A bare `0.92` reads as a fact; the same number with `basis: [name-match +0.42, address-match +0.30, …]` and the
 * policy threshold reads as a judgement, which is what it is. So a score with an empty or absent basis THROWS here —
 * the plan's required negative case is "92% match with no basis entries must fail", and a component that rendered the
 * score with an empty list would make that case pass by omission.
 *
 * THE VALUE IS A DECIMAL, NEVER A PERCENTAGE. VG-UI-019 fixes the 0.00–1.00 form; a percentage would also have to be
 * rendered through `MetricFigure` to carry a denominator, which a model score does not have. Rendering no `%` here is
 * enforced by the coverage suite's DOM scan, which finds percentages only inside a metric figure.
 *
 * EVERY BASIS ENTRY IS SHOWN WITH ITS CONTRIBUTION, in the order the API returned: sorting by contribution would
 * present the largest factor as the reason, and the reason is the policy's to state, not this component's to infer.
 */

export interface ConfidenceBasisEntry {
  /** The feature the model used, as the API names it. */
  readonly feature: string;
  /**
   * Its signed contribution to the score, under THE CONTRACT'S OWN FIELD NAME.
   *
   * MEASURED (EP-005 M5): this component first called the field contribution while SPEC-003 §5.5.3 calls it weight,
   * which meant the API mapper needed a rename and a reader comparing the screen to the response saw two words for one
   * number. A second vocabulary for the same value is drift, so the field name is the contract's.
   */
  readonly weight: number;
}

export interface ConfidenceBasisProps {
  /** The 0.00–1.00 decimal as recorded by the API. */
  readonly value: number;
  /** The recorded basis entries. Empty is a refusal, not an empty list (VG-UI-019). */
  readonly basis: readonly ConfidenceBasisEntry[];
  /**
   * The policy threshold applied, or `null` when the response did not state one.
   *
   * `null` IS A MEASURED CASE, NOT A LOOSENING (EP-005 M5): SPEC-003 carries the threshold as
   * `policyThresholdApplied` on the §5.5.3 assessment response ONLY, so a row read from the §5.5.1 list has no
   * threshold. Rendering a number there would be inventing one, and omitting the element would drop a mandatory part of
   * VG-UI-019 — so the component renders the absence in words.
   */
  readonly threshold: number | null;
  /** The policy version the threshold came from, or `null` when the response did not state one. */
  readonly policyVersion: string | null;
}

function inUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Two decimals, so a displayed score never appears more precise than the recorded one. */
function decimal(value: number): string {
  return value.toFixed(2);
}

/** Signed contributions: `+0.42` and `−0.18` are different facts and must not render identically. */
function signed(value: number): string {
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
}

export function ConfidenceBasis({
  value,
  basis,
  threshold,
  policyVersion,
}: ConfidenceBasisProps): React.JSX.Element {
  if (basis.length === 0) {
    throw new Error(
      'ConfidenceBasis: refusing to render a confidence score with no recorded basis (VG-UI-019): a bare score presents a model judgement as a fact',
    );
  }
  if (!inUnitInterval(value)) {
    throw new Error(`ConfidenceBasis: ${String(value)} is outside the 0.00–1.00 range VG-UI-019 fixes`);
  }
  if (threshold !== null && !inUnitInterval(threshold)) {
    throw new Error(`ConfidenceBasis: threshold ${String(threshold)} is outside the 0.00–1.00 range`);
  }

  return (
    <div className="vg-confidence" data-confidence-basis="true" data-confidence-value={decimal(value)}>
      <p className="vg-confidence__score">
        {'Confidence '}
        <span data-confidence-decimal="true">{decimal(value)}</span>
        {threshold === null ? (
          <span data-confidence-threshold="true" data-confidence-threshold-absent="true">
            {' against a policy threshold this response did not state'}
          </span>
        ) : (
          <span data-confidence-threshold="true">
            {' against the policy threshold '}
            {decimal(threshold)}
          </span>
        )}
        {policyVersion === null ? (
          <span data-confidence-policy-version="true" data-confidence-policy-absent="true">
            {', and no policy version was stated in this response.'}
          </span>
        ) : (
          <span data-confidence-policy-version="true">{` set by policy version ${policyVersion}.`}</span>
        )}
      </p>
      <ul className="vg-confidence__entries" aria-label="Confidence basis, feature by feature">
        {basis.map((entry) => (
          <li key={entry.feature} data-confidence-entry={entry.feature}>
            <span className="vg-confidence__feature">{entry.feature}</span>
            {' '}
            <span className="vg-confidence__weight" data-confidence-weight={signed(entry.weight)}>
              {signed(entry.weight)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}


