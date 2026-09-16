/**
 * /console/exposures/[exposureId] — Operations console (SPEC-004 §1, §5; EP-005 M6).
 *
 * PURPOSE: Match review inside the HumanGate
 *
 * THE ONLY APPROVAL CONTROL IS `HumanApproveAffordance` (VG-UI-030), AND A GATE RENDERS ITS NOTICE (VG-UI-053). Both
 * facts are structural here: the affordance refuses to render its control without a recorded confidence basis, a named
 * evidence artifact and an explicit human review, and `HumanGateNotice` accepts no callback at all — so this route cannot
 * grow a way past a gate even by accident.
 *
 * THE REVIEW IS ATTRIBUTED. `humanReviewed` is `false` until a person has actually reviewed this record, and the
 * component then states what is still missing instead of offering the control. That is the difference between a console
 * that records reviews and one that encourages clicks.
 */

import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';

import { portalApi } from '../api/portal.ts';
import { HumanApproveAffordance, ExposureProvenance, ExposureRejection } from '../components/portal/AuthoritySummary.tsx';
import { RegionRoute } from '../components/region/RegionRoute.tsx';

export function Page_console_exposures__exposureId_(): React.JSX.Element {
  const params = useParams({ strict: false }) as { readonly exposureId?: string };
  const exposureId = params.exposureId ?? '';
  const query = useQuery({
    queryKey: ['console', 'exposure', exposureId],
    queryFn: async () => (await portalApi.exposure(exposureId)).exposure,
    enabled: exposureId.length > 0,
  });

  return (
    <RegionRoute
      path="/console/exposures/[exposureId]"
      surface="Operations console"
      purpose="Match review inside the HumanGate"
      region="Record under review"
      height="18rem"
      query={query}
      options={{
        name: 'Record under review',
        height: '18rem',
        notFound: 'error',
        requiredRole: 'a case worker for this tenant',
        backTo: { href: '/console/queue', label: 'Back to the case queue' },
        // A HUMAN_REQUIRED record puts the region in the gate state, so the notice replaces the review controls: a gate
        // that renders alongside the control it gates is not a gate.
        humanGate: (exposure) =>
          exposure.truthState === 'HUMAN_REQUIRED'
            ? {
                gateKind: 'identity verification',
                mustAct: 'a person, by confirming the identity document supplied for this subject',
                afterAction: 'the review continues and the recorded decision is written to the case',
                recorded: `the candidate record at ${exposure.sourceId} and the confidence recorded with it`,
              }
            : null,
      }}
      ready={(exposure) => (
        <>
          <ExposureProvenance
            sourceId={exposure.sourceId}
            sourceRecordId={exposure.sourceRecordId}
            firstObservedAt={exposure.firstObservedAt}
            lastObservedAt={exposure.lastObservedAt}
            truthState={exposure.truthState}
          />
          <HumanApproveAffordance
            confidence={exposure.confidence}
            evidenceArtifactId={null}
            ifMatch={`"${exposure.truthState}:${exposure.lastObservedAt}"`}
            humanReviewed={false}
          />
          {/* The rejection path needs a run whose coverage bounds are complete; without the run's coverage this route
              cannot offer it, and the component says which coverage it would need rather than offering the control. */}
          <ExposureRejection
            exposureId={exposure.exposureId}
            capability={{
              kind: 'unavailable',
              coverage: {
                sourcesAttempted: 0,
                sourcesTotal: 0,
                catalogueVersion: null,
                runWindow: { from: exposure.firstObservedAt, to: exposure.lastObservedAt },
                skippedSources: [],
              },
              reason: 'this view does not have the discovery run for this record, so its coverage bounds are unknown',
            }}
          />
        </>
      )}
    />
  );
}


