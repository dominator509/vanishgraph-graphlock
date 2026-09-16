/**
 * /console/recipes — Operations console (SPEC-004 §1, VG-UI-004).
 *
 * PURPOSE: `RemovalRecipe` and `Source` freshness
 * NON-GOALS, from the surface's own row: No tenant-wide policy authoring, no authority issuance, no truth-state editing, no case deletion, no "mark as removed" control.
 *
 * EP-005 M1 creates this module so the route tree and the manifest are complete and comparable to the specification;
 * the surface's behaviour arrives in the milestones that own it (M5 portal, M6 console/admin/auditor). Until then the
 * page renders its declared purpose and NO control — an empty shell with a control would be a worse lie than an
 * explicit one, because a rendered control is a promise this node has not kept.
 */

import { SubjectScopedGap } from '../components/region/RegionRoute.tsx';

export function Page_console_recipes(): React.JSX.Element {
  return (
    <SubjectScopedGap
      path="/console/recipes"
      surface="Operations console"
      purpose="`RemovalRecipe` and `Source` freshness"
      region="Recipes and source permissions"
      operation="loading recipe freshness"
    />
  );
}




