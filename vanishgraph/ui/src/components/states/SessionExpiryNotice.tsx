/**
 * `SessionExpiryNotice` — the warning 120 seconds before expiry, and the expiry itself (SPEC-004 §9 VG-UI-054; M4).
 *
 * THE WARNING AND THE EXPIRY ARE TWO PRESENTATIONS OF ONE COMPONENT, and the difference matters: before expiry a reader
 * can act, and after it they cannot. `phase: 'warning'` renders the countdown and a "Stay signed in" control; `phase:
 * 'expired'` renders no control at all and states what was cleared.
 *
 * THE REFRESH CONTROL IS WIRED TO A REAL REFRESH OR IT DOES NOT RENDER. `phase: 'warning'` requires `onStaySignedIn`,
 * and the component says what happened if it fails (`refreshFailed`) rather than leaving the reader guessing — VG-UI-054
 * requires a visible re-authentication path when the refresh fails.
 *
 * NO CASE IDENTIFIER REACHES THE RE-AUTHENTICATION LINK. The requirement is that the re-authentication route carries no
 * case identifier and no PII (VG-UI-073/077), so this component takes a SINGLE path with no parameters and turns the
 * query string into a refusal rather than rendering it: a link built by string concatenation somewhere else is how a
 * case id ends up in a URL that a log, a referrer header or a bookmark will keep.
 *
 * WHAT WAS CLEARED IS STATED AS A FACT, not as reassurance: on expiry the browser-held copy is cleared (VG-UI-054), and
 * the sentence says which stores, because "your data is safe" is a claim this component cannot make.
 */

export type SessionPhase = 'warning' | 'expired';

export interface SessionExpiryNoticeProps {
  readonly phase: SessionPhase;
  /** Seconds until expiry, as the session manager measured it. Required in the warning phase. */
  readonly secondsRemaining?: number | undefined;
  /** The re-authentication path: a bare path, with no case identifier (VG-UI-054). */
  readonly reauthenticatePath: string;
  /** The real refresh. Required in the warning phase: a control that cannot refresh is not a control. */
  readonly onStaySignedIn?: (() => void) | undefined;
  /** Whether the last refresh attempt failed, so the reader is told to sign in again rather than left waiting. */
  readonly refreshFailed?: boolean | undefined;
}

/** A path with no query string and no fragment; anything else is a refusal, not a rendered link. */
function assertPathOnly(path: string): void {
  if (path.includes('?') || path.includes('#') || path.includes('//')) {
    throw new Error(
      `SessionExpiryNotice: the re-authentication path "${path}" carries a query string, a fragment or an authority; VG-UI-054 requires no case identifier and no PII in that URL`,
    );
  }
}

export function SessionExpiryNotice({
  phase,
  secondsRemaining,
  reauthenticatePath,
  onStaySignedIn,
  refreshFailed,
}: SessionExpiryNoticeProps): React.JSX.Element {
  assertPathOnly(reauthenticatePath);
  if (phase === 'warning' && onStaySignedIn === undefined) {
    throw new Error(
      'SessionExpiryNotice: the warning phase must be given a real refresh (VG-UI-054): a "Stay signed in" control that cannot refresh is a control that lies',
    );
  }
  if (phase === 'warning' && secondsRemaining === undefined) {
    throw new Error('SessionExpiryNotice: the warning phase must state how long is left (VG-UI-054)');
  }

  return (
    <div className="vg-session" data-session-expiry={phase} role={phase === 'warning' ? 'status' : 'alert'}>
      {phase === 'warning' ? (
        <>
          <p className="vg-session__warning">
            {'Your session ends in '}
            <span data-session-seconds="true">{secondsRemaining}</span>
            {' seconds. Anything you have typed on this page is still here; signing in again keeps it.'}
          </p>
          <p className="vg-session__action">
            <button type="button" onClick={onStaySignedIn} data-session-stay="true">
              Stay signed in
            </button>
            <a href={reauthenticatePath} data-session-reauthenticate="true">
              Sign in again instead
            </a>
          </p>
          {refreshFailed === true ? (
            <p className="vg-session__failed" data-session-refresh-failed="true">
              We could not extend this session. Sign in again to continue; nothing you have done here was lost.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="vg-session__expired">
            Your session has ended. This page no longer holds your data: the copy kept in browser storage and in memory
            has been cleared, and any page you had open will ask you to sign in again.
          </p>
          <p className="vg-session__action">
            <a href={reauthenticatePath} data-session-reauthenticate="true">
              Sign in again
            </a>
          </p>
        </>
      )}
    </div>
  );
}
