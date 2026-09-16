/**
 * /portal/cases/[caseId]/evidence/[evidenceId] — Subject portal (SPEC-004 §1, §6; EP-005 M5).
 *
 * PURPOSE: Evidence viewer for one artifact, with its digest and redaction disclosure
 *
 * IT REQUESTS METADATA ONLY. `GET /v1/evidence-artifacts/{evidenceArtifactId}` returns "artifact metadata (never
 * content)" (SPEC-003 §5.12.2), so this route renders the digest, its verification state, the immutability flag and the
 * redaction disclosure without a content endpoint — which is why the surface is complete here even though the content
 * route (§5.12.3) is one of the six EP-004 routes that refuse for lack of an `EvidenceStore`.
 *
 * THE DIGEST SHOWN IS THE DIGEST OF THE STORED ARTEFACT AS REDACTED (VG-UI-078), and the surface says so rather than
 * implying it covers an unredacted original. There is no bulk control and no "export all" (VG-UI-040): the only control
 * this route can render is the disclosure of one artifact.
 */

import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';

import { portalApi } from '../api/portal.ts';
import { PortalRoute } from '../components/portal/PortalRoute.tsx';

export function Page_portal_cases__caseId__evidence__evidenceId_(): React.JSX.Element {
  const params = useParams({ strict: false }) as { readonly caseId?: string; readonly evidenceId?: string };
  const evidenceId = params.evidenceId ?? '';
  const query = useQuery({
    queryKey: ['portal', 'evidence', evidenceId],
    queryFn: async () => (await portalApi.evidence(evidenceId)).evidence,
    enabled: evidenceId.length > 0,
  });

  return (
    <PortalRoute
      path="/portal/cases/[caseId]/evidence/[evidenceId]"
      surface="Subject portal"
      purpose="Evidence viewer"
      region="Evidence artifact"
      height="14rem"
      query={query}
      options={{
        name: 'Evidence artifact',
        height: '14rem',
        notFound: 'error',
        requiredRole: 'a subject who owns the case this evidence belongs to',
        backTo: { href: '/portal', label: 'Back to your portal' },
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
          <dt>Immutable</dt>
          <dd data-evidence-immutable={String(evidence.immutable)}>
            {evidence.immutable
              ? 'This artefact cannot be changed after it was recorded.'
              : 'This artefact is not marked immutable, which is a defect in the record.'}
          </dd>
          <dt>Redaction</dt>
          <dd data-evidence-redaction-state={evidence.redactionState}>
            {`The stored artefact is recorded as ${evidence.redactionState}, and the digest above covers the artefact as stored — that is, as redacted. It does not cover an unredacted original.`}
          </dd>
          <dt>Linked cases</dt>
          <dd data-evidence-linked-case-count={String(evidence.linkedCaseIds.length)}>
            {evidence.linkedCaseIds.length}
          </dd>
        </dl>
      )}
    />
  );
}
