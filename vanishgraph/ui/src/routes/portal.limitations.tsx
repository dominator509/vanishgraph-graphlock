/**
 * /portal/limitations — Subject portal (SPEC-004 §1, VG-UI-004; EP-005 M2).
 *
 * PURPOSE: What the service cannot do (VG-UI-070)
 * NON-GOALS, from the surface's own row: No bulk campaign tooling, no queue operations, no tenant configuration, no
 * audit export, no control that advances a truth state.
 *
 * THE SERVICE-SCOPE STATEMENT IS RENDERED HERE, and this is the first of its four declared consumers (§11 requires it
 * on this route, in every /portal footer, on /admin/metrics and in the removal-effectiveness dashboard header). One
 * constant, four consumers: the remaining three arrive with the surfaces that own them (M5 portal chrome, M6 admin).
 */

import { PageShell } from '../components/PageShell.tsx';
import { ServiceScopeStatement } from '../components/scope/ServiceScopeStatement.tsx';

export function Page_portal_limitations(): React.JSX.Element {
  return (
    <>
      <PageShell
        surface="Subject portal"
        path="/portal/limitations"
        purpose="What the service cannot do (VG-UI-070)"
      />
      <ServiceScopeStatement context="/portal/limitations" />
    </>
  );
}
