/**
 * The root layout (SPEC-004 §1; EP-005 M1).
 *
 * IT RENDERS NOTHING OF ITS OWN except the outlet. A layout that added a navigational frame here would create the
 * application's chrome BEFORE the surface milestones decide what chrome each surface may have — and VG-UI-001 is
 * exactly about a control being reachable from a surface that does not own it.
 */

import { Outlet } from '@tanstack/react-router';

export function RootLayout(): React.JSX.Element {
  return <Outlet />;
}
