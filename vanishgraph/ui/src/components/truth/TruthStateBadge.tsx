/**
 * The truth-state badge — the ONLY implementation of state rendering (SPEC-004 §2.4; VG-UI-057).
 *
 * THREE CHANNELS ARE MANDATORY on every rendering: the label text, a unique glyph, and the exact machine value. The
 * machine value is rendered VISUALLY in a monospace face rather than hidden in a `data-` attribute, so a reader can
 * always cross-check the token: paraphrase drift is a defect, not a style choice.
 *
 * `state` IS THE ELEVEN-MEMBER UNION WITH NO `string` OVERLOAD. A mistyped token therefore cannot compile, which is a
 * stronger guarantee than a runtime check and the reason the type is imported from the canonical copy module rather
 * than accepted as a string.
 *
 * A SCOPE-REQUIRING STATE WITHOUT A SCOPE IS REFUSED. §2.4 makes `scope` required for `VERIFIED_REMOVED`,
 * `VERIFIED_NOT_PRESENT` and `SEARCH_DELISTED`; rendering one of those without saying WHICH Source and WHICH window was
 * observed would present a bounded, qualified fact as an unqualified one — the collapse this section exists to prevent.
 * The refusal is a thrown error rather than a silent omission, because a badge that quietly dropped the qualification
 * would look correct in every screenshot.
 *
 * IT READS NOTHING BUT `TRUTH_STATE_COPY`: no per-screen wording, no local label, no override prop.
 */

import type { TruthStateToken } from '../../copy/truth-state.ts';
import { TRUTH_STATE_COPY, scopeSuffix } from '../../copy/truth-state.ts';

export interface TruthStateScope {
  readonly sourceId?: string;
  readonly windowDays?: number;
  readonly checkedAt?: string;
}

export interface TruthStateBadgeProps {
  readonly state: TruthStateToken;
  /**
   * `| undefined` IS DELIBERATE, and it is required by `exactOptionalPropertyTypes`: without it a caller holding an
   * optional scope cannot pass it through (`<TruthStateBadge scope={maybeScope} />` is a type error), which would push
   * every call site into a spread workaround. The rule that matters is unchanged and enforced below: a state that
   * REQUIRES a scope throws without one.
   */
  readonly scope?: TruthStateScope | undefined;
  readonly variant?: 'badge' | 'block';
  /** `false` is permitted only where a `StateQualifier` is rendered immediately adjacent (§2.4). */
  readonly showQualifier?: boolean;
  /** The id of the adjacent qualifier node, for `aria-describedby` when the qualifier is visible (§2.4). */
  readonly qualifierId?: string;
}

export function TruthStateBadge({
  state,
  scope,
  variant = 'badge',
  showQualifier = true,
  qualifierId,
}: TruthStateBadgeProps): React.JSX.Element {
  const copy = TRUTH_STATE_COPY[state];
  if (copy.requiresScope && scope === undefined) {
    throw new Error(
      `${state} requires a scope: §2.4 makes the Source and window part of the claim, and rendering it without them would state an unqualified fact`,
    );
  }
  const suffix = scope === undefined ? '' : scopeSuffix(scope);
  return (
    <span
      data-truth-state={copy.token}
      data-truth-group={copy.group}
      className={`vg-truth-badge vg-truth-badge--${copy.group} vg-truth-badge--${variant}`}
      style={{ borderInlineStartColor: `var(${copy.cssVar})` }}
      {...(showQualifier && qualifierId !== undefined ? { 'aria-describedby': qualifierId } : {})}
    >
      <span className="vg-truth-badge__glyph" aria-hidden="true">
        {copy.glyph}
      </span>
      <span className="vg-truth-badge__label">
        {copy.label}
        {suffix}
      </span>
      <span className="vg-truth-badge__machine">{copy.token}</span>
    </span>
  );
}
