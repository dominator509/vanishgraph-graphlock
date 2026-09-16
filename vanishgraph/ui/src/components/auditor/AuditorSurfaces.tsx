/**
 * The read-only auditor view (SPEC-004 §1, §10 VG-UI-002; VG-EVIDENCE-002; EP-005 M6).
 *
 * READ-ONLY IS A PROPERTY OF THE CODE, NOT A PROMISE IN A HEADER. Nothing in this module imports the API's write path,
 * nothing renders a form, and no control it produces is bound to anything but navigation and a filter — the state it
 * displays arrives as props, so the surface has no way to change anything even if a caller wanted it to. The M6 suites
 * assert both halves: that no module under `ui/src/routes/auditor/**` or `ui/src/components/auditor/**` reaches a write
 * method, and that the rendered snapshot contains zero mutation controls.
 *
 * THE CLAIM VIEW RESOLVES THE WHOLE CHAIN (VG-EVIDENCE-002): claim → requirement → case → artefact → digest. That chain
 * is what makes an evidence claim auditable, and a view that stopped at the claim would let a reader accept a
 * requirement reference nobody can resolve. `ClaimResolution` therefore renders every link, and REFUSES a claim whose
 * chain is incomplete rather than showing a partially-resolved row: a chain with a missing artefact is an unresolved
 * claim, not a claim with a blank field.
 *
 * AN EVIDENCE-BUNDLE RECORD IS A RECORD, NOT A DOWNLOAD (VG-UI-040). `EvidenceBundleList` renders what was asked for,
 * by whom, and what state it is in; there is no "download all" control and no link that returns a bundle, because a bulk
 * export of subject evidence is exactly the operation this surface must not offer.
 *
 * ITS ROW SHAPE IS THE UI'S OWN, AND THE REASON IS A RECORDED CONTRACT GAP: SPEC-004 §1 declares `/auditor/exports`
 * ("Evidence bundle requests") and SPEC-003 declares **no endpoint for it at all** — measured: the generated document
 * has no path containing "export" or "bundle". The field names below are therefore NOT taken from a contract, and they
 * avoid the forbidden synonym deliberately (`actorReference`, `recordedAt`) rather than borrowing an API spelling that
 * does not exist. When an endpoint appears, this view model is replaced by the contract's own fields.
 */

export interface ClaimResolutionRow {
  readonly claimId: string;
  readonly requirementIds: readonly string[];
  readonly caseIds: readonly string[];
  readonly evidenceArtifactIds: readonly string[];
  readonly digests: readonly string[];
}

export function ClaimResolution({ rows }: { readonly rows: readonly ClaimResolutionRow[] }): React.JSX.Element {
  for (const row of rows) {
    if (
      row.requirementIds.length === 0 ||
      row.caseIds.length === 0 ||
      row.evidenceArtifactIds.length === 0 ||
      row.digests.length === 0
    ) {
      throw new Error(
        `ClaimResolution: claim ${row.claimId} does not resolve the whole chain (requirement, case, artefact, digest), so it is an unresolved claim rather than a row with a blank field`,
      );
    }
  }
  return (
    <div className="vg-claims" data-claim-resolution="true">
      <table className="vg-claims__table">
        <caption>Claim → requirement → case → artefact → digest</caption>
        <thead>
          <tr>
            <th scope="col">Claim</th>
            <th scope="col">Requirement</th>
            <th scope="col">Case</th>
            <th scope="col">Artefact</th>
            <th scope="col">Digest</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.claimId} data-claim-row={row.claimId}>
              <td data-claim-id="true">{row.claimId}</td>
              <td data-claim-requirements="true">{row.requirementIds.join(', ')}</td>
              <td data-claim-cases="true">{row.caseIds.join(', ')}</td>
              <td data-claim-artifacts="true">{row.evidenceArtifactIds.join(', ')}</td>
              <td className="vg-claims__digest" data-claim-digests="true">
                {row.digests.join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ExportRequestRow {
  readonly evidenceBundleId: string;
  readonly actorReference: string;
  readonly recordedAt: string;
  readonly state: string;
  readonly scopeDescription: string;
}

export function EvidenceBundleList({ rows }: { readonly rows: readonly ExportRequestRow[] }): React.JSX.Element {
  return (
    <div className="vg-exports" data-export-requests="true">
      <p className="vg-exports__bound" data-export-no-bulk="true">
        An export request is a record of what was asked for. This view does not produce a bundle, and there is no control
        here that returns every artefact at once.
      </p>
      <ul className="vg-exports__list">
        {rows.map((row) => (
          <li key={row.evidenceBundleId} data-export-row={row.evidenceBundleId} data-export-state={row.state}>
            <dl>
              <dt>Record</dt>
              <dd data-export-id="true">{row.evidenceBundleId}</dd>
              <dt>Recorded by</dt>
              <dd data-export-actor="true">{row.actorReference}</dd>
              <dt>Recorded at</dt>
              <dd>
                <time dateTime={row.recordedAt}>{row.recordedAt}</time>
              </dd>
              <dt>State</dt>
              <dd data-export-state-text="true">{row.state}</dd>
              <dt>Scope</dt>
              <dd data-export-scope="true">{row.scopeDescription}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

