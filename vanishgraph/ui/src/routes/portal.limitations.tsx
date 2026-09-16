/**
 * /portal/limitations — Subject portal (SPEC-004 §1, VG-UI-004).
 *
 * PURPOSE: What the service cannot do (VG-UI-070)
 * NON-GOALS, from the surface's own row: No bulk campaign tooling, no queue operations, no tenant configuration, no audit export, no control that advances a truth state.
 *
 * EP-005 M1 creates this module so the route tree and the manifest are complete and comparable to the specification;
 * the surface's behaviour arrives in the milestones that own it (M5 portal, M6 console/admin/auditor). Until then the
 * page renders its declared purpose and NO control — an empty shell with a control would be a worse lie than an
 * explicit one, because a rendered control is a promise this node has not kept.
 */

import { PageShell } from '../components/PageShell.tsx';

export function Page_portal_limitations(): React.JSX.Element {
  return (
    <PageShell
      surface="Subject portal"
      path="/portal/limitations"
      purpose="What the service cannot do (VG-UI-070)"
    />
  );
}
