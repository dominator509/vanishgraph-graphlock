/**
 * Case detail surfaces: transitions, deadlines and controller responses (SPEC-004 §6, §7; EP-005 M5).
 *
 * THREE RULES, EACH OF WHICH HAS A WAY OF BEING QUIETLY BROKEN:
 *
 *   1. A STATE CHANGE IS LEGIBLE AS A TRANSITION (VG-UI-036). `<from> → <to>` is rendered with two `TruthStateBadge`
 *      instances and the guard evidence name, so a reader sees which transition occurred and what accompanied it. The
 *      component takes EXPLICIT pairs; where an endpoint does not report a transition code the row says so rather than
 *      inventing `T14` from the state it landed in.
 *   2. A DEADLINE IS A POLICY-DERIVED DATE, NOT URGENCY (VG-UI-037, VG-UI-065). The date, its kind and the policy
 *      version and rule it was derived from are rendered; there is NO countdown, no "days left", no colour that means
 *      "late", and no ordering by threat. `overdueSeconds` is rendered as a fact about the record rather than as a
 *      prompt, because a countdown turns a legal window into pressure.
 *   3. A CONTROLLER RESPONSE IS A CLAIM (VG-UI-012). `claimedOutcome` is labelled as what the controller asserted,
 *      `claimedOutcomeIsObservation` is rendered — and it is `false` on every row by contract — and nothing here says a
 *      case was satisfied, completed or resolved, because those words would accept a claim as an observation.
 */

import type { TruthStateToken } from '../../copy/truth-state.ts';
import { TruthStateBadge } from '../truth/TruthStateBadge.tsx';

/** One recorded state change, as SPEC-003 §5.5.5's rows declare it in substance. */
export interface TransitionPair {
  readonly from: TruthStateToken;
  readonly to: TruthStateToken;
  /** The transition code (`T11`, `T14`, …) when the endpoint reports one, or `null` when it does not. */
  readonly transitionCode: string | null;
  /** The guard evidence name that accompanied the change, e.g. `VerificationObservation`. */
  readonly evidenceName: string;
  readonly at: string;
  /** The scope the new state is qualified by, where the state requires one. */
  readonly scope?: { readonly sourceId?: string; readonly windowDays?: number } | undefined;
}

export interface TransitionListProps {
  readonly transitions: readonly TransitionPair[];
  /** How the pairs were obtained, when they were derived rather than returned. Rendered, not buried in a comment. */
  readonly derivation?: string | undefined;
}

export function TransitionList({ transitions, derivation }: TransitionListProps): React.JSX.Element {
  return (
    <div className="vg-transitions" data-transition-list="true" data-transition-count={String(transitions.length)}>
      {derivation === undefined ? null : (
        <p className="vg-transitions__derivation" data-transition-derivation="true">
          {derivation}
        </p>
      )}
      <ol className="vg-transitions__list">
        {transitions.map((transition) => (
          <li
            key={`${transition.at}-${transition.from}-${transition.to}`}
            data-transition-row="true"
            data-transition-from={transition.from}
            data-transition-to={transition.to}
          >
            {/* BOTH BADGES CARRY THE SCOPE. §2.4 makes the Source and window part of the claim, so a `from` state of
                `VERIFIED_REMOVED` needs one too — MEASURED: the first version scoped only the `to` badge and the badge
                refused to render the `from` one, which is exactly the refusal it exists for. */}
            <TruthStateBadge state={transition.from} scope={transition.scope} />
            <span className="vg-transitions__arrow" aria-hidden="true">
              {' → '}
            </span>
            <span className="vg-transitions__sentence">{`changed to`}</span>
            <TruthStateBadge state={transition.to} scope={transition.scope} />
            <span className="vg-transitions__evidence" data-transition-evidence="true">
              {`Evidence: ${transition.evidenceName}`}
            </span>
            <span className="vg-transitions__code" data-transition-code={transition.transitionCode ?? 'not-reported'}>
              {transition.transitionCode === null
                ? 'This endpoint did not report a transition code for this change.'
                : `Transition ${transition.transitionCode}`}
            </span>
            <time className="vg-transitions__at" dateTime={transition.at}>
              {transition.at}
            </time>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A deadline, with the policy it was derived from (SPEC-003 §5.13.1). */
export interface DeadlineViewProps {
  readonly deadlineId: string;
  readonly kind: string;
  readonly dueAt: string;
  readonly policyVersion: string;
  readonly ruleCode: string;
  readonly state: string;
  readonly overdueSeconds: number;
}

export function DeadlineList({ deadlines }: { readonly deadlines: readonly DeadlineViewProps[] }): React.JSX.Element {
  return (
    <div className="vg-deadlines" data-deadline-list="true">
      <p className="vg-deadlines__intro">
        These dates come from the policy version recorded with each one. They are dates, not prompts: this service does
        not show a countdown, and nothing here changes colour to mean that a date has passed.
      </p>
      <ul className="vg-deadlines__list">
        {deadlines.map((deadline) => (
          <li key={deadline.deadlineId} data-deadline-row={deadline.deadlineId} data-deadline-state={deadline.state}>
            <dl>
              <dt>Kind</dt>
              <dd data-deadline-kind="true">{deadline.kind}</dd>
              <dt>Due</dt>
              <dd>
                <time data-deadline-due-at="true" dateTime={deadline.dueAt}>
                  {deadline.dueAt}
                </time>
              </dd>
              <dt>Derived from</dt>
              <dd data-deadline-policy="true">
                {`policy version ${deadline.policyVersion}, rule ${deadline.ruleCode}`}
              </dd>
              <dt>State</dt>
              <dd data-deadline-state-text="true">{deadline.state}</dd>
              {deadline.overdueSeconds > 0 ? (
                <dd data-deadline-overdue-seconds={String(deadline.overdueSeconds)}>
                  {`Recorded as ${String(deadline.overdueSeconds)} seconds past the due date. This is a fact about the record, not a request for you to act sooner.`}
                </dd>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A controller response, rendered as a claim about what the controller said. */
export interface ControllerResponseView {
  readonly controllerResponseId?: string | undefined;
  readonly claimedOutcome?: string | undefined;
  /** Contractually `false` on every row: the claim is not an observation (SPEC-003 §5.9.2). */
  readonly claimedOutcomeIsObservation: boolean;
}

export function ControllerResponseList({
  responses,
}: {
  readonly responses: readonly ControllerResponseView[];
}): React.JSX.Element {
  return (
    <div className="vg-controller-responses" data-controller-response-list="true">
      <p className="vg-controller-responses__intro">
        A response from a controller is what the controller said. It is recorded here as a claim, and it does not by
        itself mean that anything was deleted or that a case is finished.
      </p>
      <ul className="vg-controller-responses__list">
        {responses.map((response, index) => (
          <li
            key={response.controllerResponseId ?? `response-${String(index)}`}
            data-controller-response-row="true"
            data-claimed-outcome-is-observation={String(response.claimedOutcomeIsObservation)}
          >
            <p data-controller-claim-label="true">
              {'The controller claimed: '}
              <span data-claimed-outcome="true">
                {response.claimedOutcome ?? 'no outcome text was recorded with this response'}
              </span>
            </p>
            {response.claimedOutcomeIsObservation ? (
              // THIS BRANCH SHOULD BE UNREACHABLE, and saying so is the point: the contract fixes the flag to `false`, so
              // a row asserting otherwise would be presented as an observation only by contradicting the contract.
              <p data-controller-claim-is-observation="true">
                This row is marked as an observation rather than a claim, which contradicts the contract for this
                endpoint and is a defect in the record.
              </p>
            ) : (
              <p data-controller-claim-not-observation="true">
                This is a claim: it has not been verified by an independent observation of the Source.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
