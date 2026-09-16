/**
 * `ErrorState` — a system failure, named plainly (SPEC-004 §9 VG-UI-051; SPEC-006 §2; EP-005 M4).
 *
 * FOUR ELEMENTS ARE REQUIRED and all four are required props: the failed operation in plain language, a SELECTABLE
 * correlation identifier, a statement of whether the failure is retryable, and a retry control ONLY where the retry is
 * idempotent. The component is `role="alert"` so the failure is announced when it appears.
 *
 * `retry` IS A UNION RATHER THAN A BOOLEAN PAIR, and that shape is the rule. VG-ACTION-001 makes at-most-once the
 * default, so the safe state is the one that requires no decision: `{ kind: 'not-retryable', reason }` renders no
 * control at all and states why. `{ kind: 'idempotent', onRetry }` renders the control, and the caller cannot reach that
 * branch without a real handler. A boolean `canRetry` plus an optional handler would let a caller render a retry button
 * wired to nothing.
 *
 * A LEGITIMATE PRODUCT OUTCOME IS NEVER RENDERED HERE (SPEC-006 §2.1 rule 1). `NOT_REMOVABLE` and `HUMAN_REQUIRED` are
 * candidate outcomes, not errors: they render in the truth-state region with their qualifier (VG-UI-015/016), and this
 * component refuses them by name rather than trusting a caller to remember — a state passed as an error would be
 * recorded with severity ERROR and would increment an error metric, which is a misclassification and therefore a defect
 * (SPEC-006 §2.1 rule 4).
 */

export type RetryCapability =
  | { readonly kind: 'idempotent'; readonly onRetry: () => void }
  | { readonly kind: 'not-retryable'; readonly reason: string };

export interface ErrorStateProps {
  /** The failed operation in plain language, e.g. "loading the case queue". */
  readonly operation: string;
  /** The correlation identifier, selectable so a reader can copy it into a support message. */
  readonly correlationId: string;
  readonly retry: RetryCapability;
  /** A truth state that reached this component by mistake; refused rather than rendered (SPEC-006 §2.1 rule 1). */
  readonly outcomeState?: string | undefined;
}

/** The truth states that are outcomes, not errors — §2.1 rule 1, and VG-UI-015/016 at the component boundary. */
const OUTCOME_STATES: readonly string[] = ['NOT_REMOVABLE', 'HUMAN_REQUIRED', 'VERIFIED_NOT_PRESENT', 'SEARCH_DELISTED'];

export function ErrorState({
  operation,
  correlationId,
  retry,
  outcomeState,
}: ErrorStateProps): React.JSX.Element {
  if (outcomeState !== undefined && OUTCOME_STATES.includes(outcomeState)) {
    throw new Error(
      `ErrorState: ${outcomeState} is a candidate outcome, not an error (SPEC-006 §2.1 rule 1): it belongs in the truth-state region with its qualifier, not in an alert`,
    );
  }
  return (
    <div className="vg-error" role="alert" data-error-state="true" data-error-operation={operation}>
      <h3 className="vg-error__heading">{`We could not finish ${operation}`}</h3>
      <p className="vg-error__message">
        {'This is a problem on our side, not a result about your data. Reference '}
        <span className="vg-error__correlation" data-error-correlation="true">
          {correlationId}
        </span>
        {'.'}
      </p>
      {retry.kind === 'idempotent' ? (
        <p className="vg-error__retry">
          <span data-error-retryable="true">
            This step can be tried again safely: it does not send anything a second time.
          </span>
          <button type="button" onClick={retry.onRetry} data-error-retry="true">
            {`Try ${operation} again`}
          </button>
        </p>
      ) : (
        <p className="vg-error__retry">
          <span data-error-retryable="false">
            {'This step cannot be retried from here: '}
            {retry.reason}
            {'. Nothing was sent, and no partial result was recorded.'}
          </span>
        </p>
      )}
    </div>
  );
}
