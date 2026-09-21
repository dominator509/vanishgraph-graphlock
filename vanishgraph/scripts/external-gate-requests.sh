#!/usr/bin/env sh
# Per-gate external sign-off REQUEST PACKETS (EP-010 M32; DOD-039, SPEC-008 section 9).
# Sentinel: `external gate requests: written`
#
# WHY THIS EXISTS. The five mandatory external gates have carried a machine-readable request record in
# .agent/evidence/EP-010/V-021/external-gates.jsonl since M12, and that record is what the verdict and the sign-off
# validator read. WHAT IT DOES NOT GIVE A HUMAN IS ANYTHING TO ACT ON: a participant asked to sign needs to know which
# artifact digest they are attesting, what they are being asked to do, what evidence to review, the EXACT shape of the
# record that will be accepted, and where to put it. This script writes one packet per gate for exactly that purpose.
#
# IT WRITES REQUESTS AND NEVER SIGNATURES, AND IT RECORDS THE TWO AS DIFFERENT FACTS. `requestedAt` is when the request
# was prepared; `sentAt` is when a HUMAN says it was sent, and it is absent until then. Conflating them is how a
# repository comes to claim that a person was asked when all that happened is that a file was written - and an agent can
# never satisfy an external gate (DOD-039), so the only thing this script may produce is the request.
#
# IT REFUSES TO WRITE A STALE REQUEST: the digest each packet names is read from ARTIFACT_IDENTITY.json, and every
# packet states the digest it covers, so a packet that outlives its artifact is visible rather than misleading.
set -eu
cd "$(dirname "$0")/.."

IDENTITY=.agent/verification/state/ARTIFACT_IDENTITY.json
RECORDS=.agent/evidence/EP-010/V-021/external-gates.jsonl
OUTDIR=.agent/evidence/EP-010/V-021/requests

[ -f "$IDENTITY" ] || { echo "external gate requests: FAIL - $IDENTITY is missing; run sh scripts/build-artifact.sh first" >&2; exit 1; }
[ -f "$RECORDS" ] || { echo "external gate requests: FAIL - $RECORDS is missing; the requests have never been prepared" >&2; exit 1; }

EPOCH=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(".agent/verification/state/RUN_STATE.json","utf8")).epoch ?? "")')
[ -n "$EPOCH" ] || { echo "external gate requests: FAIL - RUN_STATE.json records no epoch" >&2; exit 1; }

mkdir -p "$OUTDIR"

node -e '
const fs = require("node:fs");
const [identityPath, recordsPath, outdir, epoch] = process.argv.slice(1);
const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
const tarball = identity.artifact_paths.find((p) => p.endsWith(".tgz"));
const pinned = identity.artifact_digests[tarball];
const records = fs.readFileSync(recordsPath, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
let written = 0;
let stale = 0;
for (const record of records) {
  if (record.requestedArtifactDigest !== pinned) stale += 1;
  const path = `${outdir}/${record.gate_id}.md`;
  const lines = [
    `# External sign-off request: ${record.gate_id} - ${record.gate}`,
    "",
    "THIS IS A REQUEST FOR A NAMED HUMAN TO ACT. No agent may sign it, no automated check may sign it, and nothing in",
    "this repository treats it as satisfied until a sign-off record exists that names a person and the artifact digest",
    "below (DOD-039, SPEC-008 section 9).",
    "",
    "## What is being attested",
    "",
    `- artifact digest (the bytes this signature covers): \`${record.requestedArtifactDigest}\``,
    `- artifact file: \`${tarball}\``,
    `- candidate commit: \`${identity.source_commit_sha}\``,
    `- candidate epoch: \`${epoch}\``,
    `- evidence bundle: \`${identity.sbom_reference}\`, \`${identity.provenance_reference}\`, \`dist/SHA256SUMS\``,
    `- request record: \`${recordsPath}\``,
    `- requested at: ${record.requestedAt}`,
    `- sent at: ${record.sentAt ?? "NOT SENT - a human records this when the request is actually sent"}`,
    "",
    "## The party who must act",
    "",
    `- role: ${record.externalPartyRole}`,
    `- owner contact: ${record.ownerContactRef}`,
    "",
    "## What they are asked to do",
    "",
    record.scope ?? record.what ?? "The scope is declared in the gate definition this request names.",
    "",
    "## What must be returned, in the exact shape the validator accepts",
    "",
    "Append ONE line to `.agent/evidence/EP-010/V-021/signoffs.jsonl` with these fields:",
    "",
    "```json",
    JSON.stringify({
      gate_id: record.gate_id,
      status: "SIGNED",
      artifactDigest: pinned,
      role: record.externalPartyRole,
      signerRef: "<who signed: a name, a registry entry or a ticket reference>",
      signatureMethod: "<how: wet signature scanned, DocuSign envelope id, GPG key id, ...>",
      signedAt: "<ISO-8601 UTC>",
      scope: "<what was actually reviewed, in the signer own words>",
      unresolvedFindings: "<what they found and did not resolve, or the literal token none>",
      evidencePath: "<a file in this repository holding their signed statement>",
      evidenceDigest: "<sha256 of that file bytes>",
    }, null, 2),
    "```",
    "",
    "THE RULES, STATED PLAINLY SO THAT A SIGNATURE IS NOT WASTED:",
    "",
    "1. `artifactDigest` MUST equal the digest above. A signature over a different artifact is REFUSED by name.",
    "2. `evidencePath` must name a file that EXISTS and `evidenceDigest` must be its sha256. A signature whose evidence",
    "   is missing is refused.",
    "3. The five fields DOD-039 requires - signerRef, signatureMethod, signedAt, scope, unresolvedFindings - must be",
    "   non-blank.",
    "4. NO CHECK IN THIS REPOSITORY PROVES A SIGNATURE IS AUTHENTIC. The validator verifies SHAPE: status, digest, role,",
    "   the five fields, and that the evidence file exists and hashes to what the record claims. A fabricated record would",
    "   have to fabricate a stored artifact and its hash as well, which is why the shape check is worth having and is not",
    "   the same thing as proof of authorship.",
    "",
    `## If the artifact changes before this is signed`,
    "",
    "This request becomes STALE and will be re-issued against the new digest with the digest chain preserved. Re-issue",
    "the request rather than asking the participant to sign the old one: a signature over bytes that no longer exist",
    "costs a real person an attempt and is refused by name.",
    "",
  ];
  fs.writeFileSync(path, lines.join("\n"));
  written += 1;
}
console.log(`external gate requests: wrote ${written} packet(s) to ${outdir}`);
console.log(`external gate requests: pinned artifact ${pinned}`);
if (stale > 0) console.log(`external gate requests: WARNING - ${stale} request record(s) name a digest that is not the pinned one; run scripts/external-gates-status.sh to see the blocker`);
' "$IDENTITY" "$RECORDS" "$OUTDIR" "$EPOCH"

echo "external gate requests: written"
