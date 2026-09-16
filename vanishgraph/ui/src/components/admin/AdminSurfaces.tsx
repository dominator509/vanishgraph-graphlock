/**
 * Tenant admin surfaces (SPEC-004 §1, §8 VG-UI-045/046/047; SPEC-005 VG-AUTHZ-016; EP-005 M6).
 *
 * THE METRIC IS THE PART WITH TEETH. VG-UI-045 requires the removal-effectiveness figure as
 * `externally verified removals / eligible confirmed matches` with the numerator, the denominator, the confidence
 * interval, the observation interval and the population definition; VG-UI-046 forbids a figure that adds
 * `SEARCH_DELISTED` to `VERIFIED_REMOVED`, counts `REQUEST_SUBMITTED` or `ACKNOWLEDGED` as a removal, or shows a
 * permanent-deletion figure; VG-UI-047 requires the service-scope statement, a coverage line and tenant scoping.
 *
 * SO THE FIGURE'S INPUTS ARE DECLARED AND ASSERTED RATHER THAN IMPLIED. `RemovalEffectiveness` takes `inputs` — the
 * exact truth states feeding the numerator — and REFUSES any set that is not exactly `{VERIFIED_REMOVED}`, and refuses
 * a numerator larger than the denominator. `NOT_REMOVABLE` and `HUMAN_REQUIRED` are reported in the denominator's
 * COMPOSITION, which is where §7.6 puts them: they are legitimate outcomes, not failures to hide.
 *
 * THE AUTHORITY SURFACE MUST NOT OFFER SELF-APPROVAL (SPEC-005 VG-AUTHZ-016). `AuthorityAdmin` requires the acting
 * principal and the grant's subject, and refuses to render the issue control when they are the same person — the one
 * place where a missing check would let an operator grant themselves authority over someone else's records.
 *
 * THE POLICY SURFACE MUST NOT AUTHOR A LEGAL BASIS (SPEC-003 §5.6.4). `PolicyAssignment` renders jurisdiction policy
 * selection from a declared set; it has no free-text field for a legal basis and no control that creates one, because a
 * legal basis is a legal judgement rather than a form field.
 */

import { MetricFigure } from '../coverage/MetricFigure.tsx';
import { ServiceScopeStatement } from '../scope/ServiceScopeStatement.tsx';

export interface MetricComposition {
  /** The denominator broken into its parts, so the outcomes are visible rather than netted out. */
  readonly eligibleConfirmedMatches: number;
  readonly humanRequired: number;
  readonly notRemovable: number;
  readonly searchDelisted: number;
  readonly requestSubmitted: number;
  readonly acknowledged: number;
}

export interface RemovalEffectivenessProps {
  /** The exact truth states feeding the numerator. REFUSED unless it is exactly `VERIFIED_REMOVED`. */
  readonly inputs: readonly string[];
  readonly verifiedRemovals: number;
  readonly composition: MetricComposition;
  /** The confidence interval for the ratio, as recorded. */
  readonly interval: { readonly low: number; readonly high: number };
  /** The window the figures describe, and the population they were drawn from. */
  readonly observationWindow: string;
  readonly populationDefinition: string;
  readonly catalogueVersion: string | null;
  readonly uncheckedRemainderCount: number;
}

export function RemovalEffectiveness({
  inputs,
  verifiedRemovals,
  composition,
  interval,
  observationWindow,
  populationDefinition,
  catalogueVersion,
  uncheckedRemainderCount,
}: RemovalEffectivenessProps): React.JSX.Element {
  const declared = [...inputs].sort().join(',');
  if (declared !== 'VERIFIED_REMOVED') {
    throw new Error(
      `RemovalEffectiveness: the removal figure's inputs are ${declared || '(none)'}; VG-UI-046 requires exactly VERIFIED_REMOVED, and a figure that counts in-flight work as a removal is a conflated metric`,
    );
  }
  return (
    <div className="vg-metric-dashboard" data-removal-effectiveness="true">
      <ServiceScopeStatement context="/admin/metrics" />
      <MetricFigure
        label="Externally verified removals of eligible confirmed matches"
        numerator={verifiedRemovals}
        denominator={composition.eligibleConfirmedMatches}
        notComputableReason="no eligible confirmed match exists for this period, so the ratio has no denominator"
      />
      <p className="vg-metric-dashboard__interval" data-metric-interval="true">
        {`Confidence interval ${interval.low.toFixed(2)} to ${interval.high.toFixed(2)}, over ${observationWindow}, for ${populationDefinition}.`}
      </p>
      <dl className="vg-metric-dashboard__composition" data-metric-composition="true">
        <dt>Denominator composition</dt>
        <dd>
          {`eligible confirmed matches ${String(composition.eligibleConfirmedMatches)}, of which human required ${String(composition.humanRequired)}, not removable ${String(composition.notRemovable)}, delisted from search ${String(composition.searchDelisted)}, submitted and awaiting a response ${String(composition.requestSubmitted)}, acknowledged ${String(composition.acknowledged)}.`}
        </dd>
        <dt>Coverage for this period</dt>
        <dd data-metric-coverage-line="true">
          {`Catalogue version ${catalogueVersion ?? 'not declared in this response'}; ${String(uncheckedRemainderCount)} Sources in the catalogue were not checked.`}
        </dd>
        <dt>Scope</dt>
        <dd data-metric-scope="true">Tenant-scoped figures for this tenant only, over the window shown above.</dd>
      </dl>
      <p className="vg-metric-dashboard__note" data-metric-note="true">
        Submitted requests, acknowledgements and search delistings are counted in the composition above and never in the
        numerator: they are work in flight or a different effect, not a verified removal.
      </p>
    </div>
  );
}

export interface AuthorityAdminProps {
  /** The principal performing the action. */
  readonly actingPrincipal: string;
  /** The person the grant would be issued to or revoked from. */
  readonly subjectRef: string;
  readonly grants: readonly { readonly authorityGrantId: string; readonly kind: string; readonly state: string; readonly expiresAt: string }[];
  readonly onIssue?: (() => void) | undefined;
  readonly onRevoke?: ((authorityGrantId: string) => void) | undefined;
}

export function AuthorityAdmin({
  actingPrincipal,
  subjectRef,
  grants,
  onIssue,
  onRevoke,
}: AuthorityAdminProps): React.JSX.Element {
  const selfApproval = actingPrincipal === subjectRef;
  return (
    <div className="vg-authority-admin" data-authority-admin="true" data-self-approval-refused={String(selfApproval)}>
      {selfApproval ? (
        <p className="vg-authority-admin__refused" data-authority-self-approval="true">
          You cannot issue or revoke authority for yourself. SPEC-005 VG-AUTHZ-016 requires a second person for this
          action, so the controls are not rendered here.
        </p>
      ) : (
        <p className="vg-authority-admin__issue">
          <button type="button" onClick={onIssue} data-authority-issue="true">
            Issue an authority grant
          </button>
        </p>
      )}
      <ul className="vg-authority-admin__list">
        {grants.map((grant) => (
          <li key={grant.authorityGrantId} data-authority-admin-row={grant.authorityGrantId}>
            <dl>
              <dt>Kind</dt>
              <dd>{grant.kind}</dd>
              <dt>State</dt>
              <dd data-authority-admin-state={grant.state}>{grant.state}</dd>
              <dt>Expires</dt>
              <dd>
                <time dateTime={grant.expiresAt}>{grant.expiresAt}</time>
              </dd>
            </dl>
            {grant.state !== 'REVOKED' && onRevoke !== undefined ? (
              <button
                type="button"
                onClick={() => onRevoke(grant.authorityGrantId)}
                data-authority-admin-revoke={grant.authorityGrantId}
              >
                {`Revoke ${grant.authorityGrantId}`}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface PolicyAssignmentProps {
  readonly jurisdictions: readonly string[];
  readonly policyVersions: readonly { readonly policyVersion: string; readonly jurisdiction: string; readonly effectiveFrom: string }[];
  readonly onAssign?: ((jurisdiction: string, policyVersion: string) => void) | undefined;
}

export function PolicyAssignment({ jurisdictions, policyVersions, onAssign }: PolicyAssignmentProps): React.JSX.Element {
  return (
    <div className="vg-policy" data-policy-assignment="true">
      <p className="vg-policy__bound" data-policy-no-authoring="true">
        This surface assigns the policy version that applies in a jurisdiction. It does not author a legal basis: the
        policy versions below are the ones the service was built with, and there is no control here that creates or edits
        one.
      </p>
      <table className="vg-policy__table">
        <caption>Declared policy versions by jurisdiction</caption>
        <thead>
          <tr>
            <th scope="col">Jurisdiction</th>
            <th scope="col">Policy version</th>
            <th scope="col">Effective from</th>
          </tr>
        </thead>
        <tbody>
          {policyVersions.map((policy) => (
            <tr key={`${policy.jurisdiction}-${policy.policyVersion}`} data-policy-row={policy.jurisdiction}>
              <td data-policy-jurisdiction="true">{policy.jurisdiction}</td>
              <td data-policy-version="true">{policy.policyVersion}</td>
              <td>
                <time dateTime={policy.effectiveFrom}>{policy.effectiveFrom}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="vg-policy__assignment" data-policy-assignable-count={String(jurisdictions.length)}>
        {onAssign === undefined
          ? 'Assignment is not available from this view.'
          : `Assignment is available for ${String(jurisdictions.length)} declared jurisdictions.`}
      </p>
    </div>
  );
}
