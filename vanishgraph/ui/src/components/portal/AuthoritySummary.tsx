/**
 * `AuthoritySummary` and `HumanApproveAffordance` (SPEC-004 §4 VG-UI-025…028, §5 VG-UI-030; EP-005 M5).
 *
 * AUTHORITY: FIVE FACTS AND A BOUNDARY. VG-UI-025/026 require kind, scope, issue and expiry dates, evidence presence
 * and revocation state; the authorized-agent path requires SIGNED EVIDENCE and must state what is missing when it is
 * absent, so the notice names the missing instrument rather than disabling a control silently. VG-UI-028 requires the
 * scope boundary to be stated in the interface as well as enforced on the server: the component renders which actions
 * the grant does and does not reach, and `tests/contract/portal-surfaces.test.ts` asserts the statement is present for
 * every grant kind.
 *
 * REVOCATION IS THE SUBJECT'S, AND ITS EFFECT IS STATED (VG-UI-027): the control says what revocation stops (future
 * external actions) and what it does not undo (records already requested, and work already sent). A revocation button
 * that said only "revoke" would leave the reader to guess whether it retracts a request already in flight.
 *
 * THE APPROVE AFFORDANCE IS THE ONLY APPROVAL CONTROL (VG-UI-030), and its shape enforces the rest of §5: it REQUIRES
 * a recorded confidence basis, a named evidence artifact, and an explicit statement that a human reviewed the match.
 * There is no bulk variant and no "approve all": VG-UI-032 forbids bulk confirmation of ambiguous matches, and the
 * cheapest way to forbid it is to have no such component to call.
 */

import type { ConfidenceView } from '../../api/portal.ts';
import { ConfidenceBasis } from '../coverage/ConfidenceBasis.tsx';
import type { CoverageRun } from '../coverage/CoveragePanel.tsx';
import { PartialCoverageBanner } from '../coverage/PartialCoverageBanner.tsx';
import { TruthStateBadge } from '../truth/TruthStateBadge.tsx';

export interface AuthorityGrantView {
  readonly authorityGrantId: string;
  readonly kind: 'SELF' | 'AGENT' | 'PARENT_GUARDIAN' | 'LEGAL_REPRESENTATIVE';
  readonly scope: readonly string[];
  readonly evidenceArtifactId: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly state: 'VALID' | 'EXPIRED' | 'REVOKED';
  readonly daysUntilExpiry: number;
}

/** The kinds that may only exist with signed evidence (SPEC-005 §3, VG-UI-026). */
const EVIDENCE_REQUIRED_KINDS: readonly AuthorityGrantView['kind'][] = [
  'AGENT',
  'PARENT_GUARDIAN',
  'LEGAL_REPRESENTATIVE',
];

/** What each scope token reaches, in the reader's terms. A token with no declared meaning renders as itself. */
const SCOPE_MEANING: Readonly<Record<string, string>> = {
  'vg.subject.read': 'reading the records found about the subject',
  'vg.authority.write': 'granting or revoking authority',
  'vg.appeal.write': 'asking for an appeal or an escalation',
  'vg.export.read': 'requesting an evidence bundle',
};

export interface AuthoritySummaryProps {
  readonly grant: AuthorityGrantView;
  readonly onRevoke?: (() => void) | undefined;
  /** The id of the control that opens the revocation confirmation, so the boundary text can be read first. */
  readonly revokeDescriptionId?: string;
}

export function AuthoritySummary({
  grant,
  onRevoke,
  revokeDescriptionId,
}: AuthoritySummaryProps): React.JSX.Element {
  const missingEvidence = EVIDENCE_REQUIRED_KINDS.includes(grant.kind) && grant.evidenceArtifactId === null;
  return (
    <div className="vg-authority" data-authority-grant={grant.authorityGrantId} data-authority-state={grant.state}>
      <dl className="vg-authority__facts">
        <dt>Kind</dt>
        <dd data-authority-kind="true">{grant.kind}</dd>
        <dt>Scope</dt>
        <dd data-authority-scope="true">
          <ul>
            {grant.scope.map((token) => (
              <li key={token} data-authority-scope-token={token}>
                {SCOPE_MEANING[token] ?? token}
              </li>
            ))}
          </ul>
          <p data-authority-boundary="true">
            This grant reaches only the actions listed above: it does not authorize acting for anyone else, and it does
            not extend to records outside this tenant.
          </p>
        </dd>
        <dt>Issued</dt>
        <dd data-authority-issued-at="true">{grant.issuedAt}</dd>
        <dt>Expires</dt>
        <dd data-authority-expires-at="true">
          {grant.expiresAt}
          {grant.state === 'VALID' ? ` (${String(grant.daysUntilExpiry)} days)` : ''}
        </dd>
        <dt>Evidence</dt>
        <dd data-authority-evidence="true">
          {grant.evidenceArtifactId === null ? 'No evidence artifact is recorded with this grant.' : grant.evidenceArtifactId}
        </dd>
        <dt>Revocation</dt>
        <dd data-authority-revocation-state="true">
          {grant.revokedAt === null ? 'Not revoked.' : `Revoked at ${grant.revokedAt}.`}
        </dd>
      </dl>

      {missingEvidence ? (
        <p className="vg-authority__missing" data-authority-missing-evidence="true" role="status">
          {`This grant is of kind ${grant.kind}, which requires a signed instrument. What is missing: a signed authority instrument recorded as an evidence artifact. Until it is recorded, no external action may be taken under this grant.`}
        </p>
      ) : null}

      {grant.revokedAt === null && onRevoke !== undefined ? (
        <p className="vg-authority__revoke">
          <button
            type="button"
            onClick={onRevoke}
            data-authority-revoke="true"
            {...(revokeDescriptionId === undefined ? {} : { 'aria-describedby': revokeDescriptionId })}
          >
            Revoke this authority
          </button>
          {revokeDescriptionId === undefined ? null : (
            <span id={revokeDescriptionId} data-authority-revoke-effect="true">
              Revoking stops future external actions taken under this grant. It does not recall a request that has
              already been sent, and it does not undo work a controller has already done.
            </span>
          )}
        </p>
      ) : null}
    </div>
  );
}

export interface HumanApproveAffordanceProps {
  /** The recorded confidence, with its basis. Required: §5.5.3 refuses an assessment without one. */
  readonly confidence: ConfidenceView;
  /** The evidence artifact the human reviewed. Required: an approval with no artifact is an assertion, not a review. */
  readonly evidenceArtifactId: string | null;
  /** The exposure's current state and version, for the conditional write (`If-Match`). */
  readonly ifMatch: string;
  /** Whether a human has in fact reviewed this specific match. */
  readonly humanReviewed: boolean;
  readonly onApprove?: (() => void) | undefined;
  readonly busy?: boolean;
}

export function HumanApproveAffordance({
  confidence,
  evidenceArtifactId,
  ifMatch,
  humanReviewed,
  onApprove,
  busy = false,
}: HumanApproveAffordanceProps): React.JSX.Element {
  const blocked: string[] = [];
  if (confidence.basis.length === 0) blocked.push('a recorded confidence basis');
  if (evidenceArtifactId === null) blocked.push('an evidence artifact that a person has reviewed');
  if (!humanReviewed) blocked.push('an explicit statement that a person reviewed this match');

  return (
    <div className="vg-approve" data-human-approve="true" data-approve-if-match={ifMatch}>
      {/* THE CONFIDENCE IS SHOWN WITH ITS BASIS AND THRESHOLD BEFORE THE CONTROL (VG-UI-029, VG-UI-019). */}
      <ConfidenceBasis
        value={confidence.value}
        basis={confidence.basis}
        threshold={confidence.threshold}
        policyVersion={confidence.policyVersion}
      />
      {blocked.length > 0 ? (
        <p className="vg-approve__blocked" data-approve-blocked="true">
          {`Confirming this record as yours is not available yet. Still needed: ${blocked.join(', ')}.`}
        </p>
      ) : (
        <p className="vg-approve__action">
          <button type="button" onClick={onApprove} disabled={busy} data-approve-confirm="true" data-approve-if-match={ifMatch}>
            Confirm this record is about me
          </button>
        </p>
      )}
    </div>
  );
}

export interface RejectionCapability {
  readonly kind: 'records-verified-not-present' | 'unavailable';
  readonly coverage: CoverageRun;
  readonly reason?: string;
}

/**
 * The rejection path (VG-UI-031). It is available ONLY where the coverage bounds are complete, and it always renders
 * those bounds beside the control: a rejection records `VERIFIED_NOT_PRESENT`, and an absence claim over partial
 * coverage would be a claim the run cannot support. When the bounds are incomplete the control is not rendered at all
 * and the reason is stated — the same refusal the server makes.
 */
export function ExposureRejection({
  exposureId,
  capability,
  onReject,
}: {
  readonly exposureId: string;
  readonly capability: RejectionCapability;
  readonly onReject?: (() => void) | undefined;
}): React.JSX.Element {
  const banner = (
    <PartialCoverageBanner
      sourcesAttempted={capability.coverage.sourcesAttempted}
      sourcesTotal={capability.coverage.sourcesTotal}
      skippedCount={capability.coverage.skippedSources.length}
      catalogueVersion={capability.coverage.catalogueVersion}
      runWindow={capability.coverage.runWindow}
      variant="inline"
    />
  );
  return (
    <div className="vg-reject" data-exposure-rejection={exposureId}>
      {banner}
      {capability.kind === 'records-verified-not-present' ? (
        <p className="vg-reject__action">
          <button type="button" onClick={onReject} data-reject-record="true">
            This record is not about me
          </button>
          <span data-reject-effect="true">
            This records the result “not found in the coverage checked” for this record, for the Sources and window
            shown above. It does not state that the record does not exist elsewhere.
          </span>
        </p>
      ) : (
        <p className="vg-reject__unavailable" data-reject-unavailable="true">
          {`This record cannot be rejected from here: ${capability.reason ?? 'coverage for this run is not complete'}. The coverage above shows what was and was not checked.`}
        </p>
      )}
    </div>
  );
}

/** The provenance block VG-UI-029 requires: which Source, which record, and when it was observed. */
export function ExposureProvenance({
  sourceId,
  sourceRecordId,
  firstObservedAt,
  lastObservedAt,
  truthState,
}: {
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly truthState: Parameters<typeof TruthStateBadge>[0]['state'];
}): React.JSX.Element {
  return (
    <div className="vg-provenance" data-exposure-provenance="true">
      <TruthStateBadge state={truthState} />
      <dl>
        <dt>Source</dt>
        <dd data-provenance-source="true">{sourceId}</dd>
        <dt>Source record</dt>
        <dd data-provenance-record="true">{sourceRecordId}</dd>
        <dt>First observed</dt>
        <dd data-provenance-first="true">{firstObservedAt}</dd>
        <dt>Last observed</dt>
        <dd data-provenance-last="true">{lastObservedAt}</dd>
      </dl>
    </div>
  );
}
