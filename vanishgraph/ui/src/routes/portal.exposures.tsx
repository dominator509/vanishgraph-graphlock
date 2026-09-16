/**
 * /portal/exposures — Subject portal (SPEC-004 §1, §5; EP-005 M5).
 *
 * PURPOSE: Review each discovered record and confirm or reject the match
 *
 * THE SUBJECT-SCOPED ROUTES CANNOT REQUEST ANYTHING IN THIS DEPLOYMENT, AND THEY SAY SO RATHER THAN SPINNING.
 * The records are `/v1` data scoped to the session's subject, and the identity provider that would establish that
 * subject is unprovisioned (`KEYCLOAK_ISSUER`). Rendering the review list against nothing would be worse than an
 * error: an empty review list reads as "no records were found about you", which is a claim this deployment cannot make.
 *
 * THE SURFACE IS BUILT: `ExposureReviewList` renders provenance, the confidence with its basis and threshold, the one
 * approval affordance, the bounded rejection, and the taint disclosures, and the inventory suite asserts each rule on
 * rendered output. M6's counterpart (`/console/exposures/[exposureId]`) has the same boundary.
 */

import { SubjectScopedGap } from '../components/region/RegionRoute.tsx';

export function Page_portal_exposures(): React.JSX.Element {
  return (
    <SubjectScopedGap
      path="/portal/exposures"
      surface="Subject portal"
      purpose="Review each discovered record and confirm or reject the match"
      region="Records found"
      operation="loading the records found about you"
    />
  );
}


