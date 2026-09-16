/**
 * `AccessDenied` — a distinct state that renders NO data from the denied resource (SPEC-004 §9 VG-UI-052; EP-005 M4).
 *
 * ZERO FIELDS, NOT EVEN COUNTS. The requirement is unusually specific and the reason is that the usual pattern is worse
 * than a blank page: a disabled form showing the record's fields, or a "3 records hidden" count, tells the reader
 * something about a resource they are not authorized to see. So this component has NO props that could carry a record,
 * a count or a preview — the only inputs are the role concept, the recorded-attempt statement and a link back — and the
 * M4 DOM suite asserts that a denied region's accessible text contains none of the field names it was denied.
 *
 * IT NEVER USES THE FORBIDDEN SYNONYM. VG-UI-052 says the state renders as "access denied" and never as *permission*;
 * `tests/contract/region-states.test.ts` asserts the rendered text against the forbidden-vocabulary list, so the rule is
 * enforced on the output rather than on this comment.
 *
 * IT SAYS THE ATTEMPT WAS RECORDED, because that is true and because a reader who is refused deserves to know the
 * refusal is auditable. It does not say who decided, because this component is not told.
 */

export interface AccessDeniedProps {
  /** The role or scope concept required, named conceptually — never the internal role identifier. */
  readonly requiredRole: string;
  /** Where the reader can go instead: a route this surface actually owns. */
  readonly backTo: { readonly href: string; readonly label: string };
}

export function AccessDenied({ requiredRole, backTo }: AccessDeniedProps): React.JSX.Element {
  return (
    <div className="vg-denied" data-access-denied="true" data-denied-required-role={requiredRole}>
      <h3 className="vg-denied__heading">Access denied</h3>
      <p className="vg-denied__reason">
        {'This part of the service is limited to '}
        <span data-denied-role="true">{requiredRole}</span>
        {'. Your account does not have that role for this tenant.'}
      </p>
      <p className="vg-denied__recorded">
        This attempt was recorded in the audit trail, including that no content was shown.
      </p>
      <p className="vg-denied__next">
        <a href={backTo.href} data-denied-back="true">
          {backTo.label}
        </a>
      </p>
    </div>
  );
}
