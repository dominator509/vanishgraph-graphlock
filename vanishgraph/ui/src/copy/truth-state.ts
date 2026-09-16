/**
 * The single canonical truth-state presentation mapping (SPEC-004 §2.2/§2.3).
 *
 * This is the only place in the application where a truth-state label, qualifier, description, glyph, group, or token
 * is declared. A second mapping, a per-screen override, or a locale string that rewrites a qualifier is a defect
 * (VG-UI-007), and `tests/contract/truth-state-copy.test.ts` asserts both the equality with the specification AND that
 * the mapping is declared exactly once in `ui/src/**`.
 *
 * The labels, qualifiers and descriptions below are normative copy from SPEC-004 §2.2, transcribed byte-for-byte, and
 * the glyphs, CSS variables and groups come from §2.3. Do not paraphrase, shorten, or "improve" them: the qualifier is
 * the sentence that stops a reader collapsing "submitted" into "removed", and the specification's wording is the
 * product decision (VG-UI-009, VG-UI-010).
 */

export type TruthStateToken =
  | 'DISCOVERED_CANDIDATE'
  | 'MATCH_CONFIRMED'
  | 'REQUEST_READY'
  | 'REQUEST_SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'VERIFIED_REMOVED'
  | 'SEARCH_DELISTED'
  | 'VERIFIED_NOT_PRESENT'
  | 'NOT_REMOVABLE'
  | 'HUMAN_REQUIRED'
  | 'REAPPEARED';

/** §2.3's `data-truth-group` values: the sets that must never be conflated. */
export type TruthGroup = 'verified' | 'uncounted' | 'reopened' | 'forbidden' | 'action';

export interface TruthStateCopy {
  readonly token: TruthStateToken;
  readonly label: string;
  readonly qualifier: string;
  readonly description: string;
  readonly glyph: string;
  readonly group: TruthGroup;
  readonly cssVar: string;
  /** §2.4: the scope suffix is REQUIRED for these states, and the badge cannot be rendered without one. */
  readonly requiresScope: boolean;
}

export const TRUTH_STATE_COPY: Readonly<Record<TruthStateToken, TruthStateCopy>> = Object.freeze({
  DISCOVERED_CANDIDATE: {
    token: 'DISCOVERED_CANDIDATE',
    label: 'Discovered — not yet confirmed as you',
    qualifier:
      'A record was found that may relate to you. Subject identity is not confirmed, and removal has not been assessed.',
    description: 'A candidate record retrieved from a permitted read path.',
    glyph: '◇',
    group: 'uncounted',
    cssVar: '--vg-state-candidate',
    requiresScope: false,
  },
  MATCH_CONFIRMED: {
    token: 'MATCH_CONFIRMED',
    label: 'Confirmed as you',
    qualifier:
      'Recorded evidence supports that this record is about you. This does not mean removal is possible or lawful.',
    description: 'Identity match above the policy threshold, with a recorded basis.',
    glyph: '◆',
    group: 'uncounted',
    cssVar: '--vg-state-confirmed',
    requiresScope: false,
  },
  REQUEST_READY: {
    token: 'REQUEST_READY',
    label: 'Ready to submit',
    qualifier:
      'Authority, a policy decision, and a current RemovalRecipe all exist. No external action has occurred yet.',
    description: 'Prepared to act; nothing has been sent.',
    glyph: '◐',
    group: 'uncounted',
    cssVar: '--vg-state-ready',
    requiresScope: false,
  },
  REQUEST_SUBMITTED: {
    token: 'REQUEST_SUBMITTED',
    label: 'Submitted — outcome unknown',
    qualifier:
      'A channel accepted the action. This does not mean the Controller received it, read it, or will act. This is not removal.',
    description: 'An ExternalAction was accepted by a channel.',
    glyph: '↑',
    group: 'uncounted',
    cssVar: '--vg-state-submitted',
    requiresScope: false,
  },
  ACKNOWLEDGED: {
    token: 'ACKNOWLEDGED',
    label: 'Acknowledged — not deleted',
    qualifier:
      'The Controller or Source responded acknowledging the request. This does not mean deletion occurred.',
    description: 'A response was received; it is a claim, not an observation.',
    glyph: '✓',
    group: 'uncounted',
    cssVar: '--vg-state-acknowledged',
    requiresScope: false,
  },
  VERIFIED_REMOVED: {
    token: 'VERIFIED_REMOVED',
    label: 'Verified not found at this Source',
    qualifier:
      'Independent re-observation did not find this record at this Source, by the method the RemovalRecipe requires, within the observation window shown. This does not cover backups, downstream copies, or other Sources.',
    description: 'Independently verified absence at one Source, for one observation window.',
    glyph: '~',
    group: 'verified',
    cssVar: '--vg-state-verified',
    requiresScope: true,
  },
  SEARCH_DELISTED: {
    token: 'SEARCH_DELISTED',
    label: 'Delisted from search results',
    qualifier:
      'A search engine no longer returns this result. The page at the Source has not been shown to be removed. Search and Source are separate effects.',
    description: 'Search-result removal only; the Source page is a separate case.',
    glyph: '≁',
    group: 'verified',
    cssVar: '--vg-state-delisted',
    requiresScope: true,
  },
  VERIFIED_NOT_PRESENT: {
    token: 'VERIFIED_NOT_PRESENT',
    label: 'Not found in the coverage checked',
    qualifier:
      'A valid scan observed no confirmed listing. Coverage was partial: what was and was not checked is shown with this result. This does not mean the record never existed or does not exist outside the checked scope.',
    description: 'No confirmed listing observed in a bounded scan.',
    glyph: '∅',
    group: 'verified',
    cssVar: '--vg-state-absent',
    requiresScope: true,
  },
  NOT_REMOVABLE: {
    token: 'NOT_REMOVABLE',
    label: 'Not removable — lawful limit',
    qualifier:
      'A lawful, public-interest, or technical limit prevents removal, with the recorded basis shown. This is a final outcome, not a failure, and not an unfinished attempt.',
    description: 'A recorded basis states why no lawful path exists.',
    glyph: '⊘',
    group: 'forbidden',
    cssVar: '--vg-state-notremovable',
    requiresScope: false,
  },
  HUMAN_REQUIRED: {
    token: 'HUMAN_REQUIRED',
    label: 'Human step required',
    qualifier:
      'A legitimate human, identity, legal, or provider-permitted gate blocks automation. This is a normal outcome, not a defect or an error.',
    description: 'A HumanGate must be completed by a person.',
    glyph: '☖',
    group: 'action',
    cssVar: '--vg-state-human',
    requiresScope: false,
  },
  REAPPEARED: {
    token: 'REAPPEARED',
    label: 'Appeared again',
    qualifier:
      'This exposure was independently verified as not found and has since been observed again. The earlier verification was not necessarily wrong; it was accurate for its scope and window.',
    description: 'A previously VERIFIED_REMOVED exposure observed again.',
    glyph: '↻',
    group: 'reopened',
    cssVar: '--vg-state-reappeared',
    requiresScope: false,
  },
});

/** The eleven tokens, in the specification's own order — the legend and any enumeration use THIS list. */
export const TRUTH_STATE_TOKENS: readonly TruthStateToken[] = [
  'DISCOVERED_CANDIDATE',
  'MATCH_CONFIRMED',
  'REQUEST_READY',
  'REQUEST_SUBMITTED',
  'ACKNOWLEDGED',
  'VERIFIED_REMOVED',
  'SEARCH_DELISTED',
  'VERIFIED_NOT_PRESENT',
  'NOT_REMOVABLE',
  'HUMAN_REQUIRED',
  'REAPPEARED',
];

/**
 * The scope suffix §2.4 renders INSIDE the label, e.g. `· Source: EXAMPLE_BROKER · window 30d`.
 *
 * EVERY PART IS OPTIONAL AND OMITTED WHEN ABSENT, rather than rendered as "undefined": a suffix saying
 * "window undefinedd" would be a defect a reader could mistake for data. A state that REQUIRES a scope is refused by
 * the badge when none is supplied, which is the fail-closed direction — the alternative is a verified-removal badge
 * with no Source name, which is the claim the suffix exists to qualify.
 */
export function scopeSuffix(scope: { readonly sourceId?: string; readonly windowDays?: number }): string {
  const parts: string[] = [];
  if (scope.sourceId !== undefined && scope.sourceId.length > 0) parts.push(`Source: ${scope.sourceId}`);
  if (scope.windowDays !== undefined) parts.push(`window ${String(scope.windowDays)}d`);
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`;
}
