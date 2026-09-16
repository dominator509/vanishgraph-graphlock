/**
 * `LoadingRegion` — the loading state every data-bearing region renders (SPEC-004 §9 VG-UI-048; EP-005 M4).
 *
 * THREE THINGS ARE MANDATORY AND ALL THREE ARE HERE: a skeleton that preserves the final layout's box dimensions, a
 * skeleton that is HIDDEN FROM ASSISTIVE TECHNOLOGY (`aria-hidden="true"` — a screen reader gains nothing from three
 * grey bars, and an unmarked placeholder announces as empty content), and EXACTLY ONE polite live region announcing
 * `Loading <region name>.` The live region is a sibling paragraph rather than a wrapper, because a live region around
 * the skeleton would announce the skeleton's own text nodes as they changed.
 *
 * THE DELAYED STATE CANNOT BE RENDERED WITHOUT A CANCEL HANDLER, and that is a deliberate constraint rather than
 * strictness for its own sake: VG-UI-048 requires a cancel control after ten seconds, and VG-UI-051's rule about retry
 * applies here too — a control that cannot act is worse than no control, because a reader will press it. So `delayed`
 * is a `{ operation, onCancel }` object, not a boolean, and the region that owns the request supplies a real cancel.
 *
 * THE TEN-SECOND THRESHOLD LIVES IN `useDelayedLoading` and nowhere else. It is a hook rather than an internal timer
 * because the region that owns the request is the only thing that knows when the request starts and stops; a timer
 * inside this component would restart on every re-render, which is exactly the bug VG-UI-048's "no indefinite spinner"
 * rule is about.
 */

import { useEffect, useState } from 'react';

/** The canonical threshold: VG-UI-048's ten seconds, in one place. */
export const DELAYED_LOADING_THRESHOLD_MS = 10_000;

/**
 * Whether a request has been in flight long enough to render the delayed state.
 *
 * `active` is the region's own knowledge ("there is a request in flight"); this hook only measures how long that has
 * been true. Returning to `active === false` resets the measurement, so a second request gets its own ten seconds.
 */
export function useDelayedLoading(active: boolean, thresholdMs: number = DELAYED_LOADING_THRESHOLD_MS): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setElapsed(true);
    }, thresholdMs);
    return () => {
      clearTimeout(timer);
    };
  }, [active, thresholdMs]);
  return active && elapsed;
}

export interface DelayedLoadingNoticeProps {
  /** The operation in plain language, named so a reader knows what is slow (VG-UI-048). */
  readonly operation: string;
  /** A REAL cancel. Required: see the header. */
  readonly onCancel: () => void;
}

/** The delayed presentation on its own, so a region can render it without re-rendering the skeleton. */
export function DelayedLoadingNotice({ operation, onCancel }: DelayedLoadingNoticeProps): React.JSX.Element {
  return (
    <div className="vg-loading__delayed" data-loading-delayed="true">
      <p>
        {'Still waiting for '}
        <span data-loading-operation="true">{operation}</span>
        {' after ten seconds. It may not finish; you can stop waiting without losing this page.'}
      </p>
      <button type="button" onClick={onCancel} data-loading-cancel="true">
        Cancel {operation}
      </button>
    </div>
  );
}

export interface LoadingRegionProps {
  /** The region's name, as the live region announces it: `Loading <region name>.` */
  readonly regionName: string;
  /** The final region's box height, so the skeleton reserves it and the layout does not move when data arrives. */
  readonly height: string;
  /** Present only when the request has passed the ten-second threshold; requires a real cancel. */
  readonly delayed?: DelayedLoadingNoticeProps | undefined;
}

export function LoadingRegion({ regionName, height, delayed }: LoadingRegionProps): React.JSX.Element {
  return (
    <div className="vg-loading" data-loading-region="true" data-loading-region-name={regionName}>
      <div className="vg-loading__skeleton" aria-hidden="true" style={{ minHeight: height }}>
        <span className="vg-loading__line" />
        <span className="vg-loading__line" />
        <span className="vg-loading__line" />
      </div>
      <p className="vg-loading__announcement" role="status" aria-live="polite" data-loading-announcement="true">
        {`Loading ${regionName}.`}
      </p>
      {delayed === undefined ? null : <DelayedLoadingNotice {...delayed} />}
    </div>
  );
}
