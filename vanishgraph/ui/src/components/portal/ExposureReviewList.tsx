/**
 * `ExposureReviewList` — the discovered-records review surface (SPEC-004 §5 VG-UI-029…033; EP-005 M5).
 *
 * FOUR RULES THAT ARE STRUCTURAL HERE RATHER THAN REMEMBERED AT EACH CALL SITE:
 *
 *   1. PROVENANCE AND CONFIDENCE COME BEFORE ANY CONTROL (VG-UI-029). A row renders which Source, which record, when it
 *      was observed, and the confidence WITH its basis and threshold, and only then the two affordances.
 *   2. THE ONLY APPROVAL CONTROL IS `HumanApproveAffordance` (VG-UI-030). There is no second way to confirm a record in
 *      this component, and — deliberately — **no bulk control at all**: VG-UI-032 forbids bulk confirmation of
 *      ambiguous matches, and a component with no "confirm all" button cannot be misused by a surface that forgets the
 *      rule. The list states the absence in words so a reader does not go looking for it.
 *   3. REJECTION IS BOUNDED BY COVERAGE (VG-UI-031). `ExposureRejection` is given the run's coverage and refuses the
 *      control itself when the bounds are incomplete.
 *   4. A QUARANTINED ALIAS OR A TAINTED RECORD IS VISIBLE WITH ITS TAINT DISCLOSED (VG-UI-033, SPEC-003 §5.4.5). A
 *      hidden tainted record is the failure this rule names: the subject cannot judge a record they cannot see.
 */

import type { ExposureView } from '../../api/portal.ts';
import type { CoverageRun } from '../coverage/CoveragePanel.tsx';
import { CoverageSummaryInline } from '../coverage/CoveragePanel.tsx';
import { HumanApproveAffordance, ExposureProvenance, ExposureRejection } from './AuthoritySummary.tsx';

/** One reviewable record, with the review state a person has recorded about it. */
export interface ExposureReviewItem {
  readonly exposure: ExposureView;
  /** The evidence artifact a person reviewed, or `null` when none is recorded. */
  readonly evidenceArtifactId: string | null;
  /** The exposure's version, for the conditional write. */
  readonly ifMatch: string;
  readonly humanReviewed: boolean;
  /** Whether the match is ambiguous, in which case it must be reviewed on its own (VG-UI-032). */
  readonly ambiguous: boolean;
  /** A quarantined alias, with the reason it was quarantined (VG-UI-033). */
  readonly quarantine?: { readonly reason: string } | null;
  /** A taint on the record, with the disclosure text (SPEC-003 §5.4.5). */
  readonly taint?: { readonly disclosure: string } | null;
}

export interface ExposureReviewListProps {
  readonly items: readonly ExposureReviewItem[];
  readonly coverage: CoverageRun;
  readonly onApprove?: ((exposureId: string) => void) | undefined;
  readonly onReject?: ((exposureId: string) => void) | undefined;
}

export function ExposureReviewList({
  items,
  coverage,
  onApprove,
  onReject,
}: ExposureReviewListProps): React.JSX.Element {
  const ambiguous = items.filter((item) => item.ambiguous).length;
  return (
    <div className="vg-exposures" data-exposure-review-list="true" data-exposure-count={String(items.length)}>
      <CoverageSummaryInline run={coverage} />
      <p className="vg-exposures__no-bulk" data-exposure-no-bulk="true">
        Each record is confirmed or rejected on its own. There is no way to act on several records at once here: a
        confirmation is a statement about one record, and an ambiguous match has to be reviewed by a person looking at
        that record.
      </p>
      {ambiguous > 0 ? (
        <p className="vg-exposures__ambiguous" data-exposure-ambiguous-count={String(ambiguous)}>
          <span data-exposure-ambiguous-number="true">{ambiguous}</span>
          {' of these records are ambiguous matches. They are shown with the features that matched and the features that did not, and they cannot be confirmed as a group.'}
        </p>
      ) : null}
      <ul className="vg-exposures__list">
        {items.map((item) => (
          <li key={item.exposure.exposureId} data-exposure-row={item.exposure.exposureId}>
            {item.taint === null || item.taint === undefined ? null : (
              <p className="vg-exposures__taint" data-exposure-taint="true">
                {`This record carries a taint: ${item.taint.disclosure}`}
              </p>
            )}
            {item.quarantine === null || item.quarantine === undefined ? null : (
              <p className="vg-exposures__quarantine" data-exposure-quarantine="true">
                {`This record comes from a quarantined alias and is not being acted on: ${item.quarantine.reason}`}
              </p>
            )}
            <ExposureProvenance
              sourceId={item.exposure.sourceId}
              sourceRecordId={item.exposure.sourceRecordId}
              firstObservedAt={item.exposure.firstObservedAt}
              lastObservedAt={item.exposure.lastObservedAt}
              truthState={item.exposure.truthState}
            />
            <HumanApproveAffordance
              confidence={item.exposure.confidence}
              evidenceArtifactId={item.evidenceArtifactId}
              ifMatch={item.ifMatch}
              humanReviewed={item.humanReviewed && !item.ambiguous}
              {...(onApprove === undefined ? {} : { onApprove: () => onApprove(item.exposure.exposureId) })}
            />
            <ExposureRejection
              exposureId={item.exposure.exposureId}
              capability={
                coverage.sourcesAttempted < coverage.sourcesTotal
                  ? {
                      kind: 'unavailable',
                      coverage,
                      reason: 'the run did not check every Source in the declared catalogue',
                    }
                  : { kind: 'records-verified-not-present', coverage }
              }
              {...(onReject === undefined ? {} : { onReject: () => onReject(item.exposure.exposureId) })}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
