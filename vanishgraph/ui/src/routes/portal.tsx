/**
 * /portal — Subject portal (SPEC-004 §1; EP-005 M5).
 *
 * PURPOSE: Landing and case list for the session's subject
 *
 * THE SUBJECT-SCOPED ROUTES CANNOT REQUEST ANYTHING IN THIS DEPLOYMENT, AND THEY SAY SO RATHER THAN SPINNING.
 * `/v1` is subject-scoped and the subject comes from the session, which needs an identity provider: `KEYCLOAK_ISSUER`
 * is one of the three provisioning actions in NEXT_ACTION.md and has not been performed. The region therefore renders a
 * system error naming that configuration gap — not an empty list, which would read as "nothing was found about you",
 * and not a spinner, which would claim a request is in flight when none was sent.
 */

import { SubjectScopedGap } from '../components/portal/PortalRoute.tsx';

export function Page_portal(): React.JSX.Element {
  return (
    <SubjectScopedGap
      path="/portal"
      surface="Subject portal"
      purpose="Landing and case list for the session's subject"
      region="Your records and requests"
      operation="loading your portal"
    />
  );
}
