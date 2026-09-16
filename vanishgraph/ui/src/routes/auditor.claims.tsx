/**
 * /auditor/claims — Auditor view (SPEC-004 §1, VG-UI-004).
 *
 * PURPOSE: Claim → requirement → case → artifact → digest
 * NON-GOALS, from the surface's own row: Strictly read-only: no control on any /auditor route mutates state, no PII reveal, no unredacted identity document download, no metric authoring.
 *
 * EP-005 M1 creates this module so the route tree and the manifest are complete and comparable to the specification;
 * the surface's behaviour arrives in the milestones that own it (M5 portal, M6 console/admin/auditor). Until then the
 * page renders its declared purpose and NO control — an empty shell with a control would be a worse lie than an
 * explicit one, because a rendered control is a promise this node has not kept.
 */

import { SubjectScopedGap } from '../components/region/RegionRoute.tsx';

export function Page_auditor_claims(): React.JSX.Element {
  return (
    <SubjectScopedGap
      path="/auditor/claims"
      surface="Auditor view"
      purpose="Claim → requirement → case → artifact → digest"
      region="Claim resolution"
      operation="loading the claims"
    />
  );
}




