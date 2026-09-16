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
import { AppealEscalationPanel } from '../components/portal/AlertsAndAppeals.tsx';
import { ControllerResponseList, DeadlineList, TransitionList } from '../components/portal/CaseDetail.tsx';
import { PortalRoute } from '../components/portal/PortalRoute.tsx';
import { TruthTimeline } from '../components/truth/TruthTimeline.tsx';

export function Page_portal_cases__caseId_(): React.JSX.Element {
  const params = useParams({ strict: false }) as { readonly caseId?: string };
  const caseId = params.caseId ?? '';
  const query = useQuery({
    queryKey: ['portal', 'case', caseId],
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
        <>
          {/* THE TRANSITION PAIRS ARE DERIVED, AND THE DERIVATION IS RENDERED RATHER THAN ASSUMED: this endpoint returns
              the state each event recorded, not a from/to pair or a transition code, so the list says exactly that. */}
          <TransitionList
            derivation="These steps are derived from the events recorded with this case: each pair shows the state one event recorded and the state the next event recorded. This endpoint does not return a transition code, so none is shown."
            transitions={data.timeline.slice(1).map((row, index) => {
              const previous = data.timeline[index];
              return {
                from: previous?.truthStateAfter ?? data.detail.truthState,
                to: row.truthStateAfter,
                transitionCode: null,
                // The evidence name is the event's own kind, which is what the audit recorded alongside the change.
                evidenceName: row.kind,
                at: row.at,
              };
            })}
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
          {/* THE APPEAL SURFACE IS MOUNTED ON THE CASE IT BELONGS TO: an escalation is per-case, and this is the route
              that has the case's evidence list and its version for the conditional write. The `/portal/requests` route
              remains the subject-scoped entry point and renders the configuration gap until a subject can be resolved. */}
          <AppealEscalationPanel
            caseId={caseId}
            evidenceArtifactIds={data.detail.evidenceArtifactIds}
            ifMatch={`"${data.detail.truthState}:${data.detail.updatedAt}"`}
          />
        </>
      )}
    />
  );
}
