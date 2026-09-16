/**
 * Reappearance alerts and the appeal/escalation surface (SPEC-004 §7 VG-UI-041…044; EP-005 M5).
 *
 * ALERTS: ONLY A TRUE REAPPEARANCE, AND NEVER A BLAME (VG-UI-041/042/043).
 *
 *   * An alert is rendered ONLY with a linked prior `VERIFIED_REMOVED` event, and `ReappearanceAlerts` REFUSES a list
 *     containing an alert without one. That refusal is the requirement: an alert without a prior verification would tell
 *     a subject that something reappeared when nothing had been found gone.
 *   * THE PRIOR HISTORY IS PRESERVED AND SHOWN (VG-UI-042). The prior event's id, the state it recorded and the window
 *     it covered are rendered beside the new one, so a reader can see that the earlier verification was scoped and
 *     accurate for its scope.
 *   * THE COPY NEVER BLAMES THE EARLIER VERIFICATION (VG-UI-043). The sentence says the appearance was observed again
 *     within a new window; it does not say the earlier check failed, was wrong, or missed anything, because a
 *     reappearance after an accurate verification is normal.
 *
 * APPEALS: HUMAN-GATED, WITH NO EXTERNAL EFFECT ON CREATION (VG-UI-044, SPEC-003 §5.14.1).
 *
 *   * `requiresHumanReview` is not a control. The endpoint refuses `false` for the kinds that mandate review, so the
 *     form renders it as a stated fact rather than an option a reader could set wrongly.
 *   * `artifactIds` MUST BE NON-EMPTY, and the form refuses to offer the submit control without one, naming what is
 *     missing instead — the same shape as the approval affordance in §5.
 *   * THE SURFACE STATES THAT CREATING IT SENDS NOTHING. `externalEffect: false` is the contract's own answer, and a
 *     reader who believes an appeal has been filed when it is waiting for counsel has been misled about the state of
 *     their case. The copy also says the review is pending, which is what `reviewState: PENDING_COUNSEL_REVIEW` means.
 */

import { useRef, useState } from 'react';

import { portalApi } from '../../api/portal.ts';
import { TruthStateBadge } from '../truth/TruthStateBadge.tsx';

/** One reappearance, with the prior verified event it links to (SPEC-003 §5.11.1/§5.11.3). */
export interface ReappearanceAlert {
  readonly reappearanceId: string;
  readonly observedAt: string;
  readonly priorRemovedEventId: string | null;
  readonly priorTruthState: 'VERIFIED_REMOVED' | null;
  readonly priorWindowDays: number | null;
  readonly sourceId: string;
  readonly reentry: {
    readonly requiresFreshAuthority: boolean;
    readonly requiresFreshPolicyDecision: boolean;
    readonly requiresFreshRecipe: boolean;
    readonly preservesPriorEvidence: boolean;
  };
}

export function ReappearanceAlerts({ alerts }: { readonly alerts: readonly ReappearanceAlert[] }): React.JSX.Element {
  for (const alert of alerts) {
    if (alert.priorRemovedEventId === null || alert.priorTruthState !== 'VERIFIED_REMOVED') {
      throw new Error(
        `ReappearanceAlerts: alert ${alert.reappearanceId} has no linked prior VERIFIED_REMOVED event, so it is not a reappearance (VG-UI-041)`,
      );
    }
  }
  return (
    <div className="vg-alerts" data-reappearance-alerts="true" data-alert-count={String(alerts.length)}>
      <ul className="vg-alerts__list">
        {alerts.map((alert) => (
          <li key={alert.reappearanceId} data-alert-row={alert.reappearanceId}>
            <TruthStateBadge state="REAPPEARED" scope={{ sourceId: alert.sourceId }} />
            <p data-alert-text="true">
              {'This record was verified as not found at this Source, and has since been observed again within a new '}
              {'observation window. The earlier verification covered the window it recorded'}
              {alert.priorWindowDays === null ? '' : ` (${String(alert.priorWindowDays)} days)`}
              {', and this alert is a new observation rather than a correction of it.'}
            </p>
            <dl className="vg-alerts__prior">
              <dt>Earlier event</dt>
              <dd data-alert-prior-event="true">{alert.priorRemovedEventId}</dd>
              <dt>Earlier state</dt>
              <dd data-alert-prior-state="true">{alert.priorTruthState}</dd>
              <dt>Observed again at</dt>
              <dd>
                <time data-alert-observed-at="true" dateTime={alert.observedAt}>
                  {alert.observedAt}
                </time>
              </dd>
              <dt>What has to be re-established</dt>
              <dd data-alert-reentry="true">
                {[
                  alert.reentry.requiresFreshAuthority ? 'current authority' : null,
                  alert.reentry.requiresFreshPolicyDecision ? 'a current policy decision' : null,
                  alert.reentry.requiresFreshRecipe ? 'a current recipe' : null,
                ]
                  .filter((part): part is string => part !== null)
                  .join(', ') || 'nothing further'}
                {alert.reentry.preservesPriorEvidence
                  ? '; the evidence recorded earlier is kept and still linked to this record.'
                  : '; the earlier evidence is not marked as preserved, which is a defect in the record.'}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface AppealEscalationPanelProps {
  readonly caseId: string;
  /** The artifacts already linked to the case, which are what an escalation may attach. */
  readonly evidenceArtifactIds: readonly string[];
  /** The case's version, for the conditional write the endpoint requires. */
  readonly ifMatch: string;
}

/**
 * The mounted escalation surface: selection state, a STABLE idempotency key, and the real API call.
 *
 * THE KEY IS HELD IN A REF, NOT REGENERATED ON SUBMIT, and that is VG-ACTION-001 rather than tidiness: a key generated
 * per attempt is a new key per attempt, which defeats the at-most-once guarantee the header exists to provide. A retry
 * after a failed response therefore carries the same key and cannot create a second escalation.
 *
 * `requiresHumanReview` IS ALWAYS `true` HERE, because the endpoint refuses `false` for the kinds that mandate review
 * and this surface only offers those. A control for it would let a reader set a value the contract forbids.
 */
export function AppealEscalationPanel({
  caseId,
  evidenceArtifactIds,
  ifMatch,
}: AppealEscalationPanelProps): React.JSX.Element {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const idempotencyKey = useRef<string>(globalThis.crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const submit = (): void => {
    setBusy(true);
    void portalApi
      .createAppealEscalation(caseId, {
        kind: 'CONTROLLER_APPEAL',
        requiresHumanReview: true,
        artifactIds: selected,
        templateVersion: templateVersionFor(caseId),
        templateHash: templateHashFor(caseId),
        ifMatch,
        idempotencyKey: idempotencyKey.current,
      })
      .then((created) => {
        // THE SERVER'S OWN ANSWER ABOUT EXTERNAL EFFECT IS WHAT IS RENDERED, never a claim this client makes.
        setOutcome(
          created.externalEffect
            ? 'The API reported that this created an external effect, which contradicts the contract for this endpoint.'
            : `Created ${created.appealEscalationId}. It is recorded as ${created.reviewState} and nothing was sent externally.`,
        );
      })
      .catch((error: unknown) => {
        setOutcome(
          error instanceof Error
            ? `This request was not created: ${error.message}`
            : 'This request was not created.',
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <AppealEscalationForm
        caseId={caseId}
        kinds={['CONTROLLER_APPEAL']}
        availableArtifactIds={evidenceArtifactIds}
        templateVersion={templateVersionFor(caseId)}
        selectedArtifactIds={selected}
        onSelect={setSelected}
        onSubmit={submit}
        busy={busy}
      />
      {outcome === null ? null : (
        <p data-appeal-outcome="true" role="status">
          {outcome}
        </p>
      )}
    </>
  );
}

/**
 * The template the escalation is filed against. IT IS DERIVED FROM THE CASE ID AND NAMED SO, rather than fetched: the
 * endpoint requires a `templateVersion` and a `templateHash`, no endpoint in SPEC-003 serves them, and inventing a
 * plausible-looking constant would look like a real template reference in the audit record. When a template service
 * exists, this function is where its lookup goes — and until then the values are visibly derived placeholders that a
 * reviewer can recognise.
 */
function templateVersionFor(caseId: string): string {
  return `appeal-template-unversioned-for-${caseId.slice(0, 8)}`;
}

function templateHashFor(caseId: string): string {
  return `unversioned-template-for-${caseId.slice(0, 8)}`;
}
export interface AppealEscalationFormProps {
  /** The case the escalation belongs to. */
  readonly caseId: string;
  /** The kinds the endpoint accepts (SPEC-003 §5.14.1). */
  readonly kinds: readonly string[];
  /** The evidence artifacts available to attach. The endpoint refuses an empty list. */
  readonly availableArtifactIds: readonly string[];
  readonly templateVersion: string;
  /** Whether the reader has selected at least one artifact. */
  readonly selectedArtifactIds: readonly string[];
  readonly onSelect?: ((artifactIds: readonly string[]) => void) | undefined;
  readonly onSubmit?: (() => void) | undefined;
  readonly busy?: boolean;
}

export function AppealEscalationForm({
  caseId,
  kinds,
  availableArtifactIds,
  templateVersion,
  selectedArtifactIds,
  onSelect,
  onSubmit,
  busy = false,
}: AppealEscalationFormProps): React.JSX.Element {
  const canSubmit = selectedArtifactIds.length > 0 && onSubmit !== undefined;
  return (
    <div className="vg-appeal" data-appeal-escalation={caseId}>
      <p className="vg-appeal__effect" data-appeal-external-effect="false">
        Creating this request sends nothing to the controller or to anyone else. It records that you are asking for a
        human review, and it stays here until a person has reviewed it. Sending anything externally is a separate,
        human-gated step.
      </p>
      <p className="vg-appeal__review" data-appeal-review-state="PENDING_COUNSEL_REVIEW">
        A counsel review is pending for anything created here. You will be told what was decided.
      </p>
      <dl className="vg-appeal__facts">
        <dt>Kind</dt>
        <dd data-appeal-kinds="true">{kinds.join(', ')}</dd>
        <dt>Template version</dt>
        <dd data-appeal-template-version="true">{templateVersion}</dd>
        <dt>Attached evidence</dt>
        <dd data-appeal-artifacts="true">
          {availableArtifactIds.length === 0
            ? 'No evidence artifact is available to attach, and the endpoint refuses an escalation with none. Attach evidence to the case first.'
            : `${String(selectedArtifactIds.length)} of ${String(availableArtifactIds.length)} selected: ${selectedArtifactIds.join(', ') || 'none yet'}`}
        </dd>
      </dl>
      {availableArtifactIds.length > 0 && onSelect !== undefined ? (
        <p className="vg-appeal__select">
          {availableArtifactIds.map((artifactId) => (
            <label key={artifactId}>
              <input
                type="checkbox"
                value={artifactId}
                checked={selectedArtifactIds.includes(artifactId)}
                onChange={() =>
                  onSelect(
                    selectedArtifactIds.includes(artifactId)
                      ? selectedArtifactIds.filter((id) => id !== artifactId)
                      : [...selectedArtifactIds, artifactId],
                  )
                }
                data-appeal-artifact={artifactId}
              />
              {artifactId}
            </label>
          ))}
        </p>
      ) : null}
      {canSubmit ? (
        <p className="vg-appeal__submit">
          <button type="button" onClick={onSubmit} disabled={busy} data-appeal-submit="true">
            Ask for a human review
          </button>
        </p>
      ) : (
        <p className="vg-appeal__blocked" data-appeal-blocked="true">
          This request cannot be created yet. Still needed: at least one attached evidence artifact.
        </p>
      )}
    </div>
  );
}
