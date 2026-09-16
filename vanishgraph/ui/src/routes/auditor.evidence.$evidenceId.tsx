/**
 * /auditor/evidence/[evidenceId] — Read-only auditor view (SPEC-004 §1, §6; EP-005 M6).
 *
 * PURPOSE: One evidence artifact, its digest and its traceability
 *
 * METADATA ONLY, AND THE TRACEABILITY IS THE POINT: this is the endpoint a reviewer uses to check that an artefact
 * actually resolves to the requirements a claim cites. `linkedTraceability` carries the requirement ids, the case ids and
 * the transition ids, and the digest identifies the bytes as stored.
 *
 * NO REVEAL CONTROL AND NO CONTENT. The content route (§5.12.3) is one of the six EP-004 routes that refuse for lack of an
 * `EvidenceStore`, and this surface does not offer to fetch it: a control that could not act would be worse than its
 * absence, and the audited-reveal path (M7) is where content access belongs.
 */

import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';

import { portalApi } from '../api/portal.ts';
import { RegionRoute } from '../components/region/RegionRoute.tsx';

export function Page_auditor_evidence__evidenceId_(): React.JSX.Element {
  const params = useParams({ strict: false }) as { readonly evidenceId?: string };
  const evidenceId = params.evidenceId ?? '';
  const query = useQuery({
    queryKey: ['auditor', 'evidence', evidenceId],
    queryFn: async () => (await portalApi.evidence(evidenceId)).evidence,
    enabled: evidenceId.length > 0,
  });

  return (
    <RegionRoute
      path="/auditor/evidence/[evidenceId]"
      surface="Auditor view"
      purpose="One evidence artifact, its digest and its traceability"
      region="Evidence artifact"
      height="14rem"
      query={query}
      options={{
        name: 'Evidence artifact',
        height: '14rem',
        notFound: 'error',
        requiredRole: 'an auditor for this tenant',
        backTo: { href: '/auditor/claims', label: 'Back to claim resolution' },
      }}
      ready={(evidence) => (
        <dl>
          <dt>Digest</dt>
          <dd className="vg-evidence__digest" data-evidence-digest="true">
            {evidence.digest}
          </dd>
          <dt>Digest verified</dt>
          <dd data-evidence-digest-verified={String(evidence.digestVerified)}>{String(evidence.digestVerified)}</dd>
          <dt>Kind</dt>
          <dd data-evidence-kind={evidence.kind}>{evidence.kind}</dd>
          <dt>Captured</dt>
          <dd data-evidence-captured-at={evidence.capturedAt}>{evidence.capturedAt}</dd>
          <dt>Redaction as stored</dt>
          <dd data-evidence-redaction-state={evidence.redactionState}>{evidence.redactionState}</dd>
          <dt>Requirements this artefact resolves</dt>
          <dd data-evidence-requirements="true">
            {(evidence.linkedTraceability?.requirementIds ?? []).join(', ') || 'none recorded'}
          </dd>
          <dt>Transitions this artefact evidences</dt>
          <dd data-evidence-transitions="true">
            {(evidence.linkedTraceability?.transitionIds ?? []).join(', ') || 'none recorded'}
          </dd>
        </dl>
      )}
    />
  );
}


