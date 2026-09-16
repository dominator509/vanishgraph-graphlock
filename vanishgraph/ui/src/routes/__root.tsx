/**
 * The root layout (SPEC-004 §1; EP-005 M1/M4).
 *
 * IT RENDERS NOTHING OF ITS OWN except the outlet and the focus move. A layout that added a navigational frame here
 * would create the application's chrome BEFORE the surface milestones decide what chrome each surface may have — and
 * VG-UI-001 is exactly about a control being reachable from a surface that does not own it.
 *
 * M4 ADDS ONE BEHAVIOUR: FOCUS MOVES TO THE PAGE HEADING AFTER ROUTE-LEVEL NAVIGATION (VG-UI-059). In a single-page
 * application the browser does not move focus on a client-side navigation, so a keyboard or screen-reader user is left
 * where they were — at the link they activated, or at the top of a page whose content has been replaced. The effect
 * below moves focus to `[data-page-heading]` whenever the path changes.
 *
 * IT DELIBERATELY DOES NOT RUN ON THE FIRST RENDER. A full page load already starts the reading order at the document
 * start, and stealing focus on load would move it away from the browser's own chrome before the reader has done
 * anything. The requirement is about navigation, so only navigation triggers the move.
 */

import { Outlet, useLocation } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

export function RootLayout(): React.JSX.Element {
  // MEASURED: the first version subscribed with `useRouterState({ select: (state) => state.location.pathname })` and
  // focus never moved — the browser suite navigated and the new heading rendered while this component's effect did not
  // run for the change. `useLocation` is the router's own subscription for exactly this value, and it is what the M4
  // suite asserts against a real client-side navigation.
  const { pathname } = useLocation();
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const previous = lastPath.current;
    lastPath.current = pathname;
    if (previous === null || previous === pathname) return;
    // THE FOCUS MOVE IS DEFERRED TO THE NEXT FRAME, AND THAT IS A MEASURED FIX RATHER THAN A HABIT. Focusing inside the
    // effect itself moved focus to the OUTGOING heading: the router commits its location change and this layout's effect
    // runs while the outlet still renders the previous route, so `querySelector` returned a node that was removed a
    // moment later and focus fell back to the document body — which the M4 browser suite caught (the new heading
    // rendered, focus was `inactive`). Waiting one animation frame lands after the new route has committed, so the
    // heading that receives focus is the one the reader is now looking at.
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-page-heading]')?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [pathname]);

  return <Outlet />;
}
