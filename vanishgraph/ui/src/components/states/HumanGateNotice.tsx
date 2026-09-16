/**
 * `HumanGateNotice` — a legitimate gate, not a failure (SPEC-004 §9 VG-UI-053, §2 VG-UI-015/016; EP-005 M4).
 *
 * FOUR ELEMENTS ARE REQUIRED: the gate kind, who must act, what happens after the human acts, and what has been recorded
 * so far. Each is a required prop, so a gate notice cannot be rendered while omitting the sentence that tells a person
 * what to do next.
 *
 * IT OFFERS NO WAY PAST THE GATE, and that is structural rather than a rule written in a comment: this component accepts
 * no callback at all. There is no `onSkip`, no `onBypass`, no `onContinue`, and no child slot for a caller to smuggle
 * one in — the only interactive content is the `HUMAN_REQUIRED` presentation itself, which is not a control. The M4
 * suites assert a zero-bypass control inventory in two places: the DOM suite scans this component's rendered output for
 * any control, and the browser suite scans every declared route for a bypass affordance by name.
 *
 * IT RENDERS THE `HUMAN_REQUIRED` STATE AT THE TOP, because the state is the reader's summary of the situation and the
 * qualifier is what stops "human required" reading as "something went wrong" (VG-UI-016, SPEC-006 §2.1 rule 7).
 */

import { StateQualifier } from '../truth/StateQualifier.tsx';
import { TruthStateBadge } from '../truth/TruthStateBadge.tsx';

export interface HumanGateNoticeProps {
  /** The gate kind, as the product names it: identity verification, authorized-agent instrument review, appeal review. */
  readonly gateKind: string;
  /** Who must act, in conceptual terms — a person, with the role the gate requires. */
  readonly mustAct: string;
  /** What happens after the person acts. */
  readonly afterAction: string;
  /** What has been recorded so far, so the reader knows the work up to the gate is not lost. */
  readonly recorded: string;
  /** The qualifier node id; the badge points its accessible description at it (VG-UI-010). */
  readonly qualifierId: string;
}

export function HumanGateNotice({
  gateKind,
  mustAct,
  afterAction,
  recorded,
  qualifierId,
}: HumanGateNoticeProps): React.JSX.Element {
  return (
    <div className="vg-gate" data-human-gate="true" data-human-gate-kind={gateKind}>
      <TruthStateBadge state="HUMAN_REQUIRED" qualifierId={qualifierId} />
      <StateQualifier state="HUMAN_REQUIRED" id={qualifierId} />
      <h3 className="vg-gate__heading">{`Waiting for a person: ${gateKind}`}</h3>
      <dl className="vg-gate__facts">
        <dt>Who must act</dt>
        <dd data-gate-must-act="true">{mustAct}</dd>
        <dt>What happens next</dt>
        <dd data-gate-after-action="true">{afterAction}</dd>
        <dt>Recorded so far</dt>
        <dd data-gate-recorded="true">{recorded}</dd>
      </dl>
    </div>
  );
}
