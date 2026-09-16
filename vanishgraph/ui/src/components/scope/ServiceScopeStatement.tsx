/**
 * The service-scope statement as a component (SPEC-004 §11 VG-UI-070; EP-005 M2).
 *
 * FOUR CONSUMERS, ONE STRING. `/portal/limitations`, every `/portal` footer, `/admin/metrics` and the
 * removal-effectiveness dashboard header render THIS component, so the statement cannot differ between them — which is
 * what the specification's "rendered verbatim … on every route where it appears" requires and what a per-page copy of
 * the sentence would break.
 *
 * IT IS VISIBLE PROSE with no disclosure control: the sentence "it cannot guarantee that a record is removed" is the
 * one line a product would most like to hide behind a "learn more", and hiding it is what VG-UI-010 and VG-UI-070
 * forbid.
 */

import { SERVICE_SCOPE_STATEMENT } from '../../copy/service-scope.ts';

export interface ServiceScopeStatementProps {
  /** Where it is rendered, so the element is identifiable in a route inventory. */
  readonly context: string;
}

export function ServiceScopeStatement({ context }: ServiceScopeStatementProps): React.JSX.Element {
  return (
    <section aria-label="What this service does and cannot do" data-service-scope={context}>
      <p className="vg-service-scope">{SERVICE_SCOPE_STATEMENT}</p>
    </section>
  );
}
