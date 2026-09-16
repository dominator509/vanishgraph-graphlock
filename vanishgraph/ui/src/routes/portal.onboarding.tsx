/**
 * /portal/onboarding — Subject portal (SPEC-004 §1, §4; EP-005 M5).
 *
 * PURPOSE: Getting started: scope, identity, authority, review, coverage
 *
 * STEP 1 IS RENDERED AND THE REST ARE NOT, AND THAT IS THE HONEST BOUNDARY RATHER THAN AN OMISSION. Steps 2 to 5 need
 * things this deployment does not have: identity verification needs the identity provider (`KEYCLOAK_ISSUER`), step 3
 * needs the authority read, and steps 4 and 5 need a discovery run. Rendering placeholder controls for them would put
 * controls on screen that cannot act — and the stepper itself refuses to render steps 4 or 5 without a VALID authority
 * grant, so the refusal is structural rather than a promise in a comment.
 *
 * THE DISCLOSURE STEP IS REAL AND COMPLETE: the service-scope statement is rendered verbatim from the §11 block quote,
 * and neither choice is pre-selected (VG-UI-024). The exit is present on every step and states what is kept (VG-UI-071).
 */

import { useState } from 'react';

import { OnboardingStepper } from '../components/portal/OnboardingStepper.tsx';
import { PortalRoute } from '../components/portal/PortalRoute.tsx';

export function Page_portal_onboarding(): React.JSX.Element {
  const [answer, setAnswer] = useState<'CONTINUE' | 'LEAVE' | null>(null);
  return (
    <PortalRoute
      path="/portal/onboarding"
      surface="Subject portal"
      purpose="Getting started: scope, identity, authority, review, coverage"
      region="Getting started"
      height="16rem"
      // The stepper needs no request: step 1 is the disclosure, answered from copy the application already holds. A
      // query result is still passed so the region's state machinery is exactly the same as every other route's.
      query={{ status: 'success', data: null }}
      options={{ name: 'Getting started', height: '16rem', notFound: 'error' }}
      ready={() => (
        <OnboardingStepper
          step={1}
          exit={{
            href: '/portal',
            keeps: 'Nothing is kept if you leave now: no request has been made and no record has been read.',
          }}
          disclosureAnswer={answer}
          onDisclosureAnswer={setAnswer}
        />
      )}
    />
  );
}
