/**
 * /console/cases/[caseId] — Operations console (SPEC-004 §1, §6; EP-005 M6).
 *
 * PURPOSE: Case work and reconciliation
 *
 * IT RENDERS THE TRUTH STATE WITH ITS QUALIFIER AND OFFERS NO STATE-EDITING CONTROL. That is the console's version of
 * the rule the portal has: an operator works the case — reading the history, the transitions, the deadlines and what a
 * controller claimed — and moving a record to another truth state is a domain command with its own guards, never a
 * button on a screen. This module imports no write path, and `tests/contract/surface-ownership.test.ts` asserts that no
 * console module reaches one.
 *
 * THE DATA IS REAL: the case identifier is in the URL, so this route requests `GET /v1/cases/{caseId}`, its timeline, its
 * deadlines and its controller responses, and the region comes from the same `regionStateOf` mapping every other data
 * region uses — a 401 renders access-denied with no case data, a 404 renders an error rather than an empty page.
 */

import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';

import { portalApi } from '../api/portal.ts';
import { ControllerResponseList, DeadlineList, TransitionList } from '../components/portal/CaseDetail.tsx';
import { RegionRoute } from '../components/region/RegionRoute.tsx';
import { StateQualifier } from '../components/truth/StateQualifier.tsx';
import { TruthStateBadge } from '../components/truth/TruthStateBadge.tsx';
import { TruthTimeline } from '../components/truth/TruthTimeline.tsx';

export function Page_console_cases__caseId_(): React.JSX.Element {
  const params = useParams({ strict: false }) as { readonly caseId?: string };
  const caseId = params.caseId ?? '';
  const query = useQuery({
    queryKey: ['console', 'case', caseId],
    queryFn: async () => {
      const { detail } = await portalApi.caseDetail(caseId);
      const [timeline, deadlines, controllerResponses] = await Promise.all([
        portalApi.timeline(caseId),
        portalApi.deadlines(caseId),
        portalApi.controllerResponses(caseId),
      ]);
      return { detail, timeline, deadlines, controllerResponses };
    },
    enabled: caseId.length > 0,
  });

  return (
    <RegionRoute
      path="/console/cases/[caseId]"
      surface="Operations console"
      purpose="Case work and reconciliation"
      region="Case"
      height="22rem"
      query={query}
      options={{
        name: 'Case',
        height: '22rem',
        notFound: 'error',
        requiredRole: 'a case worker for this tenant',
        backTo: { href: '/console/queue', label: 'Back to the case queue' },
      }}
      ready={(data) => (
        <>
          <TruthStateBadge state={data.detail.truthState} variant="block" qualifierId="console-case-qualifier" />
          <StateQualifier state={data.detail.truthState} id="console-case-qualifier" />
          <TransitionList
            derivation="Derived from the events recorded with this case; this endpoint does not return a transition code, so none is shown."
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
          <DeadlineList deadlines={data.deadlines} />
          <ControllerResponseList responses={data.controllerResponses} />
        </>
      )}
    />
  );
}


