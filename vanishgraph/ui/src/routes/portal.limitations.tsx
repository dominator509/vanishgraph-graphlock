/**
 * /portal/limitations — Subject portal (SPEC-004 §1, §11; EP-005 M5).
 *
 * PURPOSE: What the service cannot do (VG-UI-070)
 *
 * THIS ROUTE NEEDS NO REQUEST, so its region is genuinely `ready` and it is the one portal route whose content is
 * complete in this deployment: the service-scope statement renders verbatim from the §11 block quote, and the
 * truth-state legend renders all eleven states from the canonical mapping (VG-UI-007) — the legend is the second of the
 * statement's four declared consumers, and it is where a reader learns what each state means before meeting one.
 */

import { TruthStateLegend } from '../components/portal/TruthStateLegend.tsx';
import { PortalRoute } from '../components/portal/PortalRoute.tsx';
import { ServiceScopeStatement } from '../components/scope/ServiceScopeStatement.tsx';

export function Page_portal_limitations(): React.JSX.Element {
  return (
    <PortalRoute
      path="/portal/limitations"
      surface="Subject portal"
      purpose="What the service cannot do (VG-UI-070)"
      region="What this service can and cannot do"
      height="24rem"
      query={{ status: 'success', data: null }}
      options={{ name: 'What this service can and cannot do', height: '24rem', notFound: 'error' }}
      ready={() => (
        <>
          <ServiceScopeStatement context="/portal/limitations" />
          <TruthStateLegend idPrefix="limitations" />
        </>
      )}
    />
  );
}
