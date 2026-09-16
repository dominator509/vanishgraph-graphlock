/**
 * /admin/metrics — Tenant admin console (SPEC-004 §1, VG-UI-004).
 *
 * PURPOSE: Metric configuration and denominators
 * NON-GOALS, from the surface's own row: No case work, no subject PII browsing beyond administration needs, no alteration of recorded evidence, no truth-state change.
 *
 * EP-005 M1 creates this module so the route tree and the manifest are complete and comparable to the specification;
 * the surface's behaviour arrives in the milestones that own it (M5 portal, M6 console/admin/auditor). Until then the
 * page renders its declared purpose and NO control — an empty shell with a control would be a worse lie than an
 * explicit one, because a rendered control is a promise this node has not kept.
 */

import { SubjectScopedGap } from '../components/region/RegionRoute.tsx';

export function Page_admin_metrics(): React.JSX.Element {
  return (
    <SubjectScopedGap
      path="/admin/metrics"
      surface="Tenant admin console"
      purpose="Metric configuration and denominators"
      region="Removal-effectiveness metric"
      operation="loading the removal-effectiveness metric"
    />
  );
}




