# External sign-off request: EXT-GATE-03 - legal and compliance review of jurisdictions, agent evidence, templates and claims

THIS IS A REQUEST FOR A NAMED HUMAN TO ACT. No agent may sign it, no automated check may sign it, and nothing in
this repository treats it as satisfied until a sign-off record exists that names a person and the artifact digest
below (DOD-039, SPEC-008 section 9).

## What is being attested

- artifact digest (the bytes this signature covers): `sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57`
- artifact file: `dist/vanishgraph-0.1.0.tgz`
- candidate commit: `7751571791ed7cf6ba1b375b875b6b1350571353`
- candidate epoch: `FORGE-SPEC-12`
- evidence bundle: `dist/vanishgraph-0.1.0.cdx.json`, `dist/provenance.json`, `dist/SHA256SUMS`
- request record: `.agent/evidence/EP-010/V-021/external-gates.jsonl`
- requested at: 2026-09-21T18:32:44Z
- sent at: NOT SENT - a human records this when the request is actually sent

## The party who must act

- role: Qualified counsel
- owner contact: LEGAL_REVIEW_REQUIRED.md

## What they are asked to do

The scope is declared in the gate definition this request names.

## What must be returned, in the exact shape the validator accepts

Append ONE line to `.agent/evidence/EP-010/V-021/signoffs.jsonl` with these fields:

```json
{
  "gate_id": "EXT-GATE-03",
  "status": "SIGNED",
  "artifactDigest": "sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57",
  "role": "Qualified counsel",
  "signerRef": "<who signed: a name, a registry entry or a ticket reference>",
  "signatureMethod": "<how: wet signature scanned, DocuSign envelope id, GPG key id, ...>",
  "signedAt": "<ISO-8601 UTC>",
  "scope": "<what was actually reviewed, in the signer own words>",
  "unresolvedFindings": "<what they found and did not resolve, or the literal token none>",
  "evidencePath": "<a file in this repository holding their signed statement>",
  "evidenceDigest": "<sha256 of that file bytes>"
}
```

THE RULES, STATED PLAINLY SO THAT A SIGNATURE IS NOT WASTED:

1. `artifactDigest` MUST equal the digest above. A signature over a different artifact is REFUSED by name.
2. `evidencePath` must name a file that EXISTS and `evidenceDigest` must be its sha256. A signature whose evidence
   is missing is refused.
3. The five fields DOD-039 requires - signerRef, signatureMethod, signedAt, scope, unresolvedFindings - must be
   non-blank.
4. NO CHECK IN THIS REPOSITORY PROVES A SIGNATURE IS AUTHENTIC. The validator verifies SHAPE: status, digest, role,
   the five fields, and that the evidence file exists and hashes to what the record claims. A fabricated record would
   have to fabricate a stored artifact and its hash as well, which is why the shape check is worth having and is not
   the same thing as proof of authorship.

## If the artifact changes before this is signed

This request becomes STALE and will be re-issued against the new digest with the digest chain preserved. Re-issue
the request rather than asking the participant to sign the old one: a signature over bytes that no longer exist
costs a real person an attempt and is refused by name.
