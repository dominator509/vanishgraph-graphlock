/**
 * /auditor/cases/[caseId] — Read-only auditor view (SPEC-004 §1, §6, §10 VG-UI-002; EP-005 M6).
 *
 * PURPOSE: Read-only case and evidence inspection
 *
 * READ-ONLY MEANS THE MODULE CANNOT MUTATE, NOT THAT IT PROMISES NOT TO. This route imports the two read functions it
 * needs, renders the history and the transitions, and has no write path in scope; `tests/contract/auditor-readonly.test.ts`
 * asserts that property over the module's own source as well as over the rendered snapshot. The auditor's view is what a
 * regulator or an internal reviewer reads when they need to check the record without being able to change it.
 *
 * IT RENDERS THE SAME COMPONENTS AS THE CONSOLE AND THE PORTAL. One `TruthTimeline`, one `TransitionList`, one set of
 * status presentations: a second, auditor-specific rendering of the truth states would be a second place for a label to
 * drift, which is what VG-UI-007 forbids.
 */

import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';

import { portalApi } from '../api/portal.ts';
import { TransitionList } from '../components/portal/CaseDetail.tsx';
import { RegionRoute } from '../components/region/RegionRoute.tsx';
import { TruthTimeline } from '../components/truth/TruthTimeline.tsx';

export function Page_auditor_cases__caseId_(): React.JSX.Element {
  const params = useParams({ strict: false }) as { readonly caseId?: string };
  const caseId = params.caseId ?? '';
  const query = useQuery({
    queryKey: ['auditor', 'case', caseId],
    queryFn: async () => {
      const { detail } = await portalApi.caseDetail(caseId);
      const timeline = await portalApi.timeline(caseId);
      return { detail, timeline };
    },
    enabled: caseId.length > 0,
  });

  return (
    <RegionRoute
      path="/auditor/cases/[caseId]"
      surface="Auditor view"
      purpose="Read-only case and evidence inspection"
      region="Case record"
      height="20rem"
      query={query}
      options={{
        name: 'Case record',
        height: '20rem',
        notFound: 'error',
        requiredRole: 'an auditor for this tenant',
        backTo: { href: '/auditor/claims', label: 'Back to claim resolution' },
      }}
      ready={(data) => (
        <>
          <TransitionList
            derivation="Derived from the recorded events. This endpoint does not return a transition code, so none is shown."
            transitions={data.timeline.slice(1).map((row, index) => ({
              from: data.timeline[index]?.truthStateAfter ?? data.detail.truthState,
              to: row.truthStateAfter,
              transitionCode: null,
              evidenceName: row.kind,
              at: row.at,
            }))}
          />
          <TruthTimeline
            label="Case history, oldest first"
            timeZone="UTC"
            events={data.timeline.map((row) => ({
              eventId: row.refId,
              occurredAt: row.at,
              actorReference: row.correlationId,
              eventName: row.summary,
              state: row.truthStateAfter,
            }))}
          />
          <dl>
            <dt>Evidence artifacts linked to this case</dt>
            <dd data-auditor-evidence-count={String(data.detail.evidenceArtifactIds.length)}>
              {data.detail.evidenceArtifactIds.length}
            </dd>
          </dl>
        </>
      )}
    />
  );
}


