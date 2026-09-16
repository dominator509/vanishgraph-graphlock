/**
 * /portal/authority — Subject portal (SPEC-004 §1; EP-005 M5).
 *
 * PURPOSE: Authority grants and their scope
 *
 * THE SUBJECT-SCOPED ROUTES CANNOT REQUEST ANYTHING IN THIS DEPLOYMENT, AND THEY SAY SO RATHER THAN SPINNING.
 * `/v1` is subject-scoped and the subject comes from the session, which needs an identity provider: `KEYCLOAK_ISSUER`
 * is one of the three provisioning actions in NEXT_ACTION.md and has not been performed. The region therefore renders a
 * system error naming that configuration gap — not an empty list, which would read as "you have granted nobody
 * anything", and not a spinner, which would claim a request is in flight when none was sent.
 *
 * THE AUTHORITY SURFACE ITSELF IS BUILT AND ASSERTED: `AuthoritySummary` renders the five facts, the missing-evidence
 * statement and the revocation effect, and `tests/contract/portal-surfaces.test.ts` asserts each of them on rendered
 * output. What is missing here is the data, not the surface.
 */

import { SubjectScopedGap } from '../components/region/RegionRoute.tsx';

export function Page_portal_authority(): React.JSX.Element {
  return (
    <SubjectScopedGap
      path="/portal/authority"
      surface="Subject portal"
      purpose="Authority grants and their scope"
      region="Authority"
      operation="loading your authority grants"
    />
  );
}


