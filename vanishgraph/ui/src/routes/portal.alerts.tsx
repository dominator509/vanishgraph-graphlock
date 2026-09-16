/**
 * /portal/alerts — Subject portal (SPEC-004 §1, §7; EP-005 M5).
 *
 * PURPOSE: Reappearance alerts for this subject
 *
 * THE SUBJECT-SCOPED ROUTES CANNOT REQUEST ANYTHING IN THIS DEPLOYMENT, AND THEY SAY SO RATHER THAN SPINNING.
 * An alert list rendered without data would read as "nothing reappeared", which is exactly the false reassurance
 * VG-UI-041/043 exist to prevent: reappearance alerts are only rendered for a true reappearance carrying a linked prior
 * `VERIFIED_REMOVED` event, and a deployment that cannot read them must say so instead of showing an empty list.
 *
 * THE RULE THE SURFACE WILL ENFORCE IS RECORDED HERE SO IT IS NOT LOST: an alert renders only with its linked prior
 * verified event, the earlier verification is never blamed, and the re-removal path preserves the prior history.
 */

import { SubjectScopedGap } from '../components/region/RegionRoute.tsx';

export function Page_portal_alerts(): React.JSX.Element {
  return (
    <SubjectScopedGap
      path="/portal/alerts"
      surface="Subject portal"
      purpose="Reappearance alerts for this subject"
      region="New activity"
      operation="loading your alerts"
    />
  );
}


