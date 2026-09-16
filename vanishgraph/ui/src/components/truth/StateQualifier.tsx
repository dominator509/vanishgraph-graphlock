/**
 * The mandatory qualifier (SPEC-004 §2.1, §2.4; VG-UI-010).
 *
 * IT IS VISIBLE, UNTRUNCATED PROSE. The rule names the four ways this sentence is normally hidden, and every one of
 * them is a way to show a label without its qualification: inside `[hidden]`, behind `aria-hidden="true"`, inside a
 * closed `<details>`, or in a tooltip-only surface (a `title` attribute or a `role="tooltip"` subtree that appears on
 * hover or focus). This component renders a `<p>` — no disclosure control, no truncation, no title attribute — and
 * `tests/contract/vocabulary-ui.test.ts` asserts those four shapes appear nowhere in the component's source.
 *
 * IT CARRIES AN ID so the adjacent badge can point `aria-describedby` at the visible node: the qualifier is then
 * announced once, as part of the badge's description, rather than twice or not at all.
 */

import type { TruthStateToken } from '../../copy/truth-state.ts';
import { TRUTH_STATE_COPY } from '../../copy/truth-state.ts';

export interface StateQualifierProps {
  readonly state: TruthStateToken;
  /** The id the badge's `aria-describedby` points at. Required: an unaddressable qualifier cannot be described. */
  readonly id: string;
}

export function StateQualifier({ state, id }: StateQualifierProps): React.JSX.Element {
  return (
    <p id={id} className="vg-state-qualifier" data-truth-state-qualifier={state}>
      {TRUTH_STATE_COPY[state].qualifier}
    </p>
  );
}
