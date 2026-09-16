/**
 * /portal/cases/[caseId] — Subject portal (SPEC-004 §1, §6; EP-005 M5).
 *
 * PURPOSE: Case detail and append-only timeline
 *
 * THIS ROUTE REQUESTS REAL DATA, because the case identifier is in the URL rather than in the session: `useQuery` calls
 * `GET /v1/cases/{caseId}`, and the region's state comes from `regionStateOf` — so a 401 or 403 renders the
 * access-denied state with no case data at all, a 404 renders the error state rather than an empty page, and a
 * transport failure renders an error whose correlation identifier says that none was returned.
 *
 * WHAT THE SURFACE WILL ADD WHEN THE DATA ARRIVES is built and asserted already: `TruthTimeline` renders the audit
 * history with no mutation affordance, the timeline rows carry `<from> → <to>` transitions with their guard evidence,
 * deadlines render as policy-derived dates rather than urgency, and a controller response renders its `claimedOutcome`
 * labelled as a claim. Those rules are asserted on rendered output in `tests/contract/portal-surfaces.test.ts`, not
 * promised in this comment.
 *
 * THE GATE MAPPING USES THE TIMELINE'S OWN ROWS: a `HUMAN_GATE` event in the history is what puts the region in the
 * human-gate state, so the notice cannot appear without an event that records it.
 */

import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';

import { portalApi } from '../api/portal.ts';
import { PortalRoute } from '../components/portal/PortalRoute.tsx';

export function Page_portal_cases__caseId_(): React.JSX.Element {
  const params = useParams({ strict: false }) as { readonly caseId?: string };
  const caseId = params.caseId ?? '';
  const query = useQuery({
    queryKey: ['portal', 'case', caseId],
    queryFn: async () => {
      const { detail } = await portalApi.caseDetail(caseId);
      const [timeline, deadlines] = await Promise.all([portalApi.timeline(caseId), portalApi.deadlines(caseId)]);
      return { detail, timeline, deadlines };
    },
    enabled: caseId.length > 0,
  });

  return (
    <PortalRoute
      path="/portal/cases/[caseId]"
      surface="Subject portal"
      purpose="Case detail and append-only timeline"
      region="Case history"
      height="20rem"
      query={query}
      options={{
        name: 'Case history',
        height: '20rem',
        notFound: 'error',
        requiredRole: 'a subject who owns this case',
        backTo: { href: '/portal', label: 'Back to your portal' },
        humanGate: (data) =>
          data.timeline.some((row) => row.kind === 'HUMAN_GATE')
            ? {
                gateKind: 'identity verification',
                mustAct: 'you, by confirming your identity document',
                afterAction: 'the case continues and you are told what was decided',
                recorded: 'your request and the events listed with this case',
              }
            : null,
      }}
      ready={(data) => (
        <dl>
          <dt>State</dt>
          <dd data-case-state={data.detail.truthState}>{data.detail.truthState}</dd>
          <dt>Timeline events</dt>
          <dd data-case-timeline-count={String(data.timeline.length)}>{data.timeline.length}</dd>
          <dt>Deadlines</dt>
          <dd data-case-deadline-count={String(data.deadlines.length)}>{data.deadlines.length}</dd>
        </dl>
      )}
    />
  );
}
