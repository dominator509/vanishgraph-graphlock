/**
 * /portal/requests — Subject portal (SPEC-004 §1, §7; EP-005 M5).
 *
 * PURPOSE: Ask for a human review, an appeal, or an escalation
 *
 * THE SUBJECT-SCOPED ROUTES CANNOT REQUEST ANYTHING IN THIS DEPLOYMENT, AND THEY SAY SO RATHER THAN SPINNING.
 * The escalation surface needs the case it escalates, which is `/v1` data scoped to the session's subject.
 *
 * WHAT THIS SURFACE MUST DO WHEN IT IS WIRED, recorded so the rule survives the gap: appeal and escalation are
 * HUMAN-GATED (VG-UI-044) — creating one sends nothing externally, the response says so in `externalEffect: false`, and
 * the surface states that counsel review is pending. The client already requires a stable `Idempotency-Key` and an
 * `If-Match` for that POST, so a retry cannot create a second escalation.
 */

import { SubjectScopedGap } from '../components/portal/PortalRoute.tsx';

export function Page_portal_requests(): React.JSX.Element {
  return (
    <SubjectScopedGap
      path="/portal/requests"
      surface="Subject portal"
      purpose="Ask for a human review, an appeal, or an escalation"
      region="Your requests for a human review"
      operation="loading your requests"
    />
  );
}
